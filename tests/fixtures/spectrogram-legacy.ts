// Captured from main 8d662767bc579e0f65c1710c9f5dc48855a14d5a before shared-core adoption.
import {SPECTROGRAM_DEFAULT_MIN_DB,SPECTROGRAM_DEFAULT_MAX_DB,SPECTROGRAM_CALCULATION_FLOOR_DB,type SpectrogramData} from '@/lib/spectrogram';
import type {SpectrogramRange} from '@/components/view-preferences';
const DEFAULT_COLOR = {
  min: SPECTROGRAM_DEFAULT_MIN_DB,
  max: SPECTROGRAM_DEFAULT_MAX_DB,
};
const MAX_DISPLAY_ROWS = 256;
const MAX_DISPLAY_COLUMNS = 512;

export type SpectrogramDisplayOptions = {
  time?: SpectrogramRange | null;
  /** Both frequency limits are in kHz, matching the visible axis. */
  frequency?: SpectrogramRange | null;
  color?: SpectrogramRange | null;
};

function checkedRange(
  range: SpectrogramRange,
  nonnegative: boolean,
  scale = 1,
): SpectrogramRange {
  if (
    !Number.isFinite(range.min) ||
    !Number.isFinite(range.max) ||
    !Number.isFinite(range.max - range.min) ||
    !Number.isFinite(range.min * scale) ||
    !Number.isFinite(range.max * scale) ||
    range.min >= range.max ||
    (nonnegative && range.min < 0)
  )
    throw new Error(
      '表示範囲は下限より大きい上限を有限の数値で指定してください。',
    );
  return range;
}

export function spectrogramDisplayRanges(
  data: SpectrogramData,
  options: SpectrogramDisplayOptions = {},
) {
  if (
    !Number.isFinite(data.duration) ||
    data.duration <= 0 ||
    !Number.isFinite(data.sampleRate) ||
    data.sampleRate <= 0
  )
    throw new Error('スペクトログラムの時間・周波数を読み取れません。');
  return {
    time: checkedRange(options.time ?? { min: 0, max: data.duration }, true),
    frequency: checkedRange(
      options.frequency ?? { min: 0, max: data.sampleRate / 2000 },
      true,
      1000,
    ),
    color: checkedRange(options.color ?? DEFAULT_COLOR, false),
  };
}

// A single, increasing luminance scale. Every file uses the same dBFS mapping.
const PALETTE: readonly (readonly [number, number, number])[] = [
  [11, 20, 40],
  [18, 54, 95],
  [36, 111, 159],
  [110, 180, 212],
  [238, 248, 255],
];

export function spectrogramColor(
  db: number,
  range: SpectrogramRange = DEFAULT_COLOR,
): [number, number, number] {
  const { min, max } = checkedRange(range, false);
  const value = Number.isFinite(db) ? db : min;
  const position =
    ((Math.max(min, Math.min(max, value)) - min) / (max - min)) *
    (PALETTE.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, PALETTE.length - 1);
  const fraction = position - lower;
  return PALETTE[lower].map((channel, index) =>
    Math.round(channel + (PALETTE[upper][index] - channel) * fraction),
  ) as [number, number, number];
}

/**
 * Time pixels pool every intersecting equal-duration source cell, retaining
 * transients across cell boundaries at the original cell's time resolution.
 * Frequency centers include DC/Nyquist; narrow pixels use the nearest bin.
 * Entirely out-of-recording intervals remain transparent.
 */
function sourceIntervals(
  range: SpectrogramRange,
  maximum: number,
  count: number,
  pixels: number,
  frequency: boolean,
): ([number, number] | null)[] {
  const step = maximum / (frequency && count > 1 ? count - 1 : count);
  const centerOffset = frequency ? 0 : 0.5;
  return Array.from({ length: pixels }, (_, pixel) => {
    const start = range.min + (range.max - range.min) * (pixel / pixels);
    const end = range.min + (range.max - range.min) * ((pixel + 1) / pixels);
    const beginsAtNyquist = frequency && pixel === 0 && range.min === maximum;
    if ((start >= maximum && !beginsAtNyquist) || end <= 0) return null;
    const lo = Math.max(0, start);
    const hi = Math.min(maximum, end);
    if (!frequency) {
      const first = Math.max(0, Math.min(count - 1, Math.floor(lo / step)));
      return [
        first,
        Math.max(first + 1, Math.min(count, Math.ceil(hi / step))),
      ];
    }
    const includeEnd = frequency && (hi === maximum || pixel === pixels - 1);
    const first = Math.max(0, Math.ceil(lo / step - centerOffset - 1e-9));
    const after = Math.min(
      count,
      includeEnd
        ? Math.floor(hi / step - centerOffset + 1e-9) + 1
        : Math.ceil(hi / step - centerOffset - 1e-9),
    );
    if (after > first) return [first, after];
    const nearest = Math.max(
      0,
      Math.min(
        count - 1,
        Math.round((lo + (hi - lo) / 2) / step - centerOffset),
      ),
    );
    return [nearest, nearest + 1];
  });
}

/** Keep the strongest bin in every displayed frequency interval, including DC/Nyquist. */
export function spectrogramPixels(
  data: SpectrogramData,
  displayWidth = data.columns,
  displayHeight = MAX_DISPLAY_ROWS,
  options: SpectrogramDisplayOptions = {},
): {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
} {
  if (
    !Number.isInteger(data.columns) ||
    data.columns < 1 ||
    data.columns > 512 ||
    !Number.isInteger(data.frequencyBins) ||
    data.frequencyBins < 1 ||
    data.values.length !== data.columns * data.frequencyBins
  )
    throw new Error('スペクトログラムの表示データを読み取れません。');

  const ranges = spectrogramDisplayRanges(data, options);
  const width = Math.min(
    options.time ? MAX_DISPLAY_COLUMNS : data.columns,
    Number.isFinite(displayWidth)
      ? Math.max(1, Math.floor(displayWidth))
      : data.columns,
  );
  const height = Math.min(
    MAX_DISPLAY_ROWS,
    options.frequency ? MAX_DISPLAY_ROWS : data.frequencyBins,
    Number.isFinite(displayHeight)
      ? Math.max(1, Math.floor(displayHeight))
      : MAX_DISPLAY_ROWS,
  );
  const pixels = new Uint8ClampedArray(width * height * 4);
  const timeIntervals = sourceIntervals(
    ranges.time,
    data.duration,
    data.columns,
    width,
    false,
  );
  const frequencyIntervals = sourceIntervals(
    ranges.frequency,
    data.sampleRate / 2000,
    data.frequencyBins,
    height,
    true,
  );
  for (let column = 0; column < width; column++) {
    const time = timeIntervals[column];
    if (!time) continue;
    const [firstColumn, endColumn] = time;
    for (let row = 0; row < height; row++) {
      const frequency = frequencyIntervals[row];
      if (!frequency) continue;
      const [firstBin, endBin] = frequency;
      let peak = -Infinity;
      for (
        let sourceColumn = firstColumn;
        sourceColumn < endColumn;
        sourceColumn++
      ) {
        for (let bin = firstBin; bin < endBin; bin++) {
          const value = data.values[sourceColumn * data.frequencyBins + bin];
          if (
            Number.isFinite(value) &&
            value > SPECTROGRAM_CALCULATION_FLOOR_DB &&
            value > peak
          )
            peak = value;
        }
      }
      const offset = ((height - row - 1) * width + column) * 4;
      const [red, green, blue] = spectrogramColor(peak, ranges.color);
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = 255;
    }
  }
  return { width, height, pixels };
}

