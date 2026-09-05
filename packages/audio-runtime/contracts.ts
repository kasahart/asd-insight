import type { SpectrogramData } from '../../src/lib/spectrogram.ts';

export type AudioPhase = 'initializing' | 'analyzing';
export type AudioAnalysis = {
  sampleRate: number;
  channels: number;
  duration: number;
  wave: Array<{ min: number; max: number }>;
  spectrogram: SpectrogramData;
  recipe: Record<string, unknown>;
  runtimeLockHash: string;
  sourceHash: string;
};
export type AudioRequest = {
  type: 'analyze';
  requestId: number;
  generation: number;
  baseUrl: string;
  bytes: ArrayBuffer;
};
export type AudioPayload =
  | { type: 'phase'; phase: AudioPhase }
  | { type: 'result'; result: AudioAnalysis }
  | { type: 'error'; message: string };
export type AudioResponse = AudioPayload & {
  requestId: number;
  generation: number;
};
export const MAX_AUDIO_INPUT_BYTES = 80 * 1024 * 1024;
export const AUDIO_JOB_TIMEOUT_MS = 120_000;

export function validateAudioAnalysis(result: AudioAnalysis): AudioAnalysis {
  const data = result?.spectrogram;
  if (
    !data ||
    !Number.isInteger(result.sampleRate) ||
    result.sampleRate < 1000 ||
    result.sampleRate > 192000 ||
    !Number.isInteger(result.channels) ||
    result.channels < 1 ||
    result.channels > 8 ||
    !Number.isFinite(result.duration) ||
    result.duration <= 0 ||
    result.duration > 180 ||
    !Number.isInteger(data.columns) ||
    data.columns < 1 ||
    data.columns > 512 ||
    data.frequencyBins !== 1025 ||
    data.fftSize !== 2048 ||
    data.hopSize !== 512 ||
    data.sampleRate !== result.sampleRate ||
    data.duration !== result.duration ||
    !(data.values instanceof Float32Array) ||
    data.values.length !== data.columns * data.frequencyBins ||
    !Number.isInteger(data.frameCount) ||
    data.frameCount < data.columns ||
    !Array.isArray(result.wave) ||
    result.wave.length < 1 ||
    result.wave.length > 360 ||
    result.wave.some(
      (point) =>
        !Number.isFinite(point.min) ||
        !Number.isFinite(point.max) ||
        point.min > point.max,
    ) ||
    data.values.some((value) => !Number.isFinite(value)) ||
    !/^[a-f0-9]{64}$/.test(result.runtimeLockHash) ||
    !/^[a-f0-9]{64}$/.test(result.sourceHash) ||
    result.recipe?.engine !== 'wandas' ||
    result.recipe?.engineVersion !== '0.7.2' ||
    result.recipe?.unit !== 'dBFS'
  ) {
    throw new Error(
      '音声エンジンの出力が契約と一致しません。再試行してください。',
    );
  }
  return result;
}
