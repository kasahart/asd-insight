"""Fixed WAV analysis API. No user Python, URLs, paths, or package installation."""
from __future__ import annotations

from io import BytesIO
import json
import gc
import hashlib
import math

import dask
import numpy as np
from scipy.signal import ShortTimeFFT, get_window
import soundfile as sf
import wandas as wd

ADAPTER_VERSION = "1.0.0"
FFT_SIZE = 2048
HOP_SIZE = 512
MAX_COLUMNS = 512
FLOOR_DB = -240.0
MAX_INPUT_BYTES = 80 * 1024 * 1024
MAX_ESTIMATED_BYTES = 512 * 1024 * 1024


def _analyze_wav(value):
    """Return bounded arrays and an explicit recipe, never the source PCM."""
    payload = bytes(value)
    if not payload or len(payload) > MAX_INPUT_BYTES:
        raise ValueError("音声は空でない80MB以下のWAVを指定してください。")
    if payload[:4] not in (b"RIFF", b"RF64") or payload[8:12] != b"WAVE":
        raise ValueError("音声解析はWAVに対応しています。別形式はWAVへ変換して選び直してください。")
    # Header inspection does not materialize decoded PCM or the STFT.
    header = sf.info(BytesIO(payload))
    length, channels, rate = int(header.frames), int(header.channels), int(header.samplerate)
    if length < 1 or not 1 <= channels <= 8 or not 1000 <= rate <= 192000:
        raise ValueError("対応範囲は1〜8ch、1〜192kHz、空でない音声です。")
    duration = length / rate
    if duration > 180:
        raise ValueError("音声解析は1ファイル180秒までです。区間を分けてください。")
    analysis_length = max(length, FFT_SIZE // 2)
    estimated_frames = math.ceil(analysis_length / HOP_SIZE) + 5
    # Includes runtime reserve, both language heaps, decode copies, complex
    # STFT/materialization, levels, and the bounded transferable result.
    estimated_bytes = (
        192 * 1024 * 1024 + len(payload) * 5 + analysis_length * channels * 8 * 3
        + estimated_frames * (FFT_SIZE // 2 + 1) * 56 + 8 * 1024 * 1024
    )
    if estimated_bytes > MAX_ESTIMATED_BYTES:
        raise ValueError("音声解析の推定メモリ上限を超えます。短い区間に分けてください。")
    with dask.config.set(scheduler="synchronous"):
        frame = wd.read(payload, file_type=".wav", source_name="selected.wav")
        if frame.sampling_rate != rate or frame.n_channels != channels:
            raise ValueError("デコード後のレートまたはch数が原音と一致しません。")
        pcm = np.asarray(frame.to_numpy())
        if pcm.ndim == 1:
            pcm = pcm[np.newaxis, :]
        if pcm.shape != (channels, length) or not np.isfinite(pcm).all():
            raise ValueError("デコードされた音声の形状または数値が不正です。")
        first = pcm[0]
        wave_count = min(360, length)
        edges = np.linspace(0, length, wave_count + 1, dtype=np.int64)
        wave = np.empty((wave_count, 2), dtype="<f4")
        for index in range(wave_count):
            section = first[edges[index]:edges[index + 1]]
            wave[index] = (section.min(), section.max())

        # SciPy ShortTimeFFT requires >= half a window. This explicit padding
        # applies only to analysis; source duration, bytes, and playback stay intact.
        values = np.pad(first, (0, analysis_length - length)) if analysis_length > length else first
        mono = wd.from_numpy(values, sampling_rate=rate, ch_labels=["ch1"], ch_units="FS")
        spectrum = mono.stft(n_fft=FFT_SIZE, hop_length=HOP_SIZE, win_length=FFT_SIZE, window="hann")
        levels = np.asarray(spectrum.dB)
        if levels.ndim == 2:
            levels = levels[np.newaxis, ...]
        # Wandas 0.7.2 Frame.times is a zero-based local index; its underlying
        # ShortTimeFFT includes negative-time padding. Use that public SciPy
        # time contract, rather than stretching indices over the recording.
        clock = ShortTimeFFT(get_window("hann", FFT_SIZE), hop=HOP_SIZE, fs=rate, mfft=FFT_SIZE, scale_to="magnitude")
        source_times = clock.t(analysis_length) + float(frame.source_time_offset[0])
        frequency = np.asarray(spectrum.freqs)
        if levels.shape != (1, len(frequency), len(source_times)) or not np.isfinite(levels).all():
            raise ValueError("STFTの時間・周波数軸と数値配列が一致しません。")
        expected_local = np.arange(len(source_times)) * HOP_SIZE / rate
        if not np.allclose(spectrum.times, expected_local, rtol=0, atol=1e-12):
            raise ValueError("音声エンジンの時間軸契約が変更されています。")
        positions = np.flatnonzero((source_times >= 0) & (source_times < duration))
        if positions.size == 0:
            raise ValueError("原音の範囲内にSTFTフレームがありません。")
        columns = min(MAX_COLUMNS, len(positions))
        pooled = np.full((columns, len(frequency)), FLOOR_DB, dtype="<f4")
        counts = np.zeros(columns, dtype=np.int64)
        for index in positions:
            column = min(columns - 1, int(source_times[index] * columns / duration))
            np.maximum(pooled[column], levels[0, :, index], out=pooled[column])
            counts[column] += 1
        if not np.all(counts):
            raise ValueError("STFTの表示区間に対応するフレームがありません。")
        recipe = {
            "adapterVersion": ADAPTER_VERSION,
            "engine": "wandas", "engineVersion": wd.__version__,
            "quantity": "one-sided peak amplitude", "unit": "dBFS", "referenceFS": 1,
            "floorDb": FLOOR_DB, "channel": 0, "fftSize": FFT_SIZE, "hopSize": HOP_SIZE,
            "window": "periodic Hann", "padding": "ShortTimeFFT zeros",
            "shortInputRightPaddingSamples": analysis_length - length,
            "sourceTimeOffset": float(frame.source_time_offset[0]),
            "frameTimeOrigin": float(source_times[0]),
            "frameTimeStep": HOP_SIZE / rate,
            "retainedFirstFrameTime": float(source_times[positions[0]]),
            "retainedLastFrameTime": float(source_times[positions[-1]]),
            "aggregation": "maximum over frame centers in equal-duration source cells",
            "displayTimeEdges": np.linspace(0, duration, columns + 1).tolist(),
            "originalFrames": length, "originalChannels": channels, "originalSampleRate": rate,
            "decodedDtype": str(pcm.dtype), "resultDtype": "float32-le",
            "estimatedPeakBytes": estimated_bytes,
        }
        metadata = {
            "sampleRate": rate, "channels": channels, "duration": duration,
            "sourceHash": hashlib.sha256(payload).hexdigest(),
            "waveColumns": wave_count, "columns": columns,
            "frequencyBins": len(frequency), "fftSize": FFT_SIZE, "hopSize": HOP_SIZE,
            "frameCount": len(source_times), "retainedFrameCount": len(positions),
            "minDb": -100, "maxDb": 0, "recipe": recipe,
        }
        return {"metadata": json.dumps(metadata), "values": pooled.tobytes(), "wave": wave.tobytes()}


def analyze_wav(value):
    # The inner frame has released PCM/Dask/STFT locals before collecting any
    # reference cycles. Returned arrays are bounded byte strings, not views.
    try:
        return _analyze_wav(value)
    finally:
        gc.collect()
