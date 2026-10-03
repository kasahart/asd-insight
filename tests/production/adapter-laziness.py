"""Run inside the pinned Pyodide runtime; no browser or network required."""
from io import BytesIO
from unittest.mock import patch

import numpy as np
import soundfile as sf
from wandas.io.readers import SoundFileReader
import wandas_adapter as adapter


def wav(rate, channels, length):
    stream = BytesIO()
    sf.write(stream, np.zeros((length, channels)), rate, format="WAV", subtype="FLOAT")
    return stream.getvalue()


with patch.object(SoundFileReader, "get_file_info", wraps=SoundFileReader.get_file_info) as header, patch.object(
    SoundFileReader, "get_data", wraps=SoundFileReader.get_data
) as pcm, patch.object(sf, "info", wraps=sf.info) as info, patch.object(adapter.wd, "read", wraps=adapter.wd.read) as read:
    adapter.analyze_wav(wav(16000, 2, 2000))
    assert header.call_count == info.call_count == 2 and pcm.call_count == read.call_count == 1
    for payload, message in [
        (wav(1000, 1, 181000), "180秒"),
        (wav(16000, 9, 100), "1〜8ch"),
        (wav(16000, 1024, 1), "1〜8ch"),
        (wav(96000, 1, 96000 * 60), "メモリ上限"),
    ]:
        before = pcm.call_count
        reads_before = read.call_count
        try:
            adapter.analyze_wav(payload)
        except ValueError as error:
            assert message in str(error)
        else:
            raise AssertionError("guard did not reject")
        assert pcm.call_count == before, "guard decoded PCM"
        assert read.call_count == reads_before, "guard constructed a Frame graph"
    assert header.call_count == info.call_count == 6
    adapter.analyze_wav(wav(16000, 1, 100))
    assert header.call_count == info.call_count == 8 and pcm.call_count == read.call_count == 2
