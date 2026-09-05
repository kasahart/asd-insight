export type SpectrogramData = {
  /** Time-major: values[column * frequencyBins + bin], in dBFS. */
  values: Float32Array;
  columns: number;
  frequencyBins: number;
  sampleRate: number;
  duration: number;
  fftSize: number;
  hopSize: number;
  frameCount: number;
  /** Default display limits, not clipping limits for the measured values. */
  minDb: number;
  maxDb: number;
};

export const SPECTROGRAM_DEFAULT_MIN_DB = -100;
export const SPECTROGRAM_DEFAULT_MAX_DB = 0;
// Wandas' fixed finite floor is separate from the display scale.
export const SPECTROGRAM_CALCULATION_FLOOR_DB = -240;
