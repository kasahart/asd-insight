'use client';

// Canvas needs image semantics; replacing it with img would require a bitmap URL.
/* oxlint-disable jsx-a11y/prefer-tag-over-role */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  SPECTROGRAM_DEFAULT_MIN_DB,
  SPECTROGRAM_DEFAULT_MAX_DB,
  SPECTROGRAM_CALCULATION_FLOOR_DB,
  type SpectrogramData,
} from '@/lib/spectrogram';
import type { SpectrogramRange } from '@/components/view-preferences';

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

function formatTick(value: number): string {
  return Number(value.toPrecision(5)).toString();
}

const COLORBAR = `linear-gradient(to right, ${Array.from(
  { length: 21 },
  (_, index) => {
    const rgb = spectrogramColor(
      DEFAULT_COLOR.min +
        (index / 20) * (DEFAULT_COLOR.max - DEFAULT_COLOR.min),
    );
    return `rgb(${rgb.join(' ')}) ${(index / 20) * 100}%`;
  },
).join(', ')})`;

type SpectrogramAxis = keyof SpectrogramDisplayOptions;

function SpectrogramAxisControl({
  axis,
  label,
  className,
  settingsId,
  settingsOpen,
  helpId,
  onEditAxis,
  children,
}: {
  axis: SpectrogramAxis;
  label: string;
  className: string;
  settingsId?: string;
  settingsOpen: boolean;
  helpId: string;
  onEditAxis?: (axis: SpectrogramAxis) => void;
  children: ReactNode;
}) {
  if (!onEditAxis) return <div className={className}>{children}</div>;
  return (
    <button
      type="button"
      className={className}
      data-spectrogram-axis={axis}
      aria-label={`${label}の範囲設定を開く`}
      aria-controls={settingsId}
      aria-expanded={settingsOpen}
      aria-describedby={helpId}
      onDoubleClick={(event) => {
        event.preventDefault();
        onEditAxis(axis);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (!event.repeat) onEditAxis(axis);
      }}
      onClick={(event) => {
        // A pointer click only focuses the axis. Detail 0 is the native
        // activation used by assistive technology (and keyboard buttons).
        if (event.detail === 0) onEditAxis(axis);
      }}
    >
      {children}
    </button>
  );
}

export function SpectrogramChart({
  data,
  label,
  currentTime,
  ranges,
  onEditAxis,
  settingsId,
  settingsOpen = false,
}: {
  data: SpectrogramData;
  label: string;
  currentTime: number;
  ranges?: SpectrogramDisplayOptions;
  onEditAxis?: (axis: SpectrogramAxis) => void;
  settingsId?: string;
  settingsOpen?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const descriptionId = useId();
  const axisHelpId = `${descriptionId}-axis-help`;
  const [renderFailed, setRenderFailed] = useState(false);
  const view = spectrogramDisplayRanges(data, ranges);
  const { time, frequency, color } = view;
  const fixedTime = !!ranges?.time;
  const fixedFrequency = !!ranges?.frequency;
  const visiblePlayhead =
    Number.isFinite(currentTime) &&
    currentTime >= time.min &&
    currentTime <= time.max &&
    currentTime >= 0 &&
    currentTime <= data.duration;
  const progress = (currentTime - time.min) / (time.max - time.min);
  const description = `${label} のch1スペクトログラム。横軸は時間${formatTick(time.min)}〜${formatTick(time.max)}秒、縦軸は周波数${formatTick(frequency.min)}〜${formatTick(frequency.max)}kHz。明るい色ほど強い成分、振幅の固定範囲は${formatTick(color.min)}〜${formatTick(color.max)}dBFS。白い線は表示範囲内の再生位置。音声の時間・周波数範囲外は空白。`;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let previousSize = '';
    function draw() {
      if (!canvas) return;
      // Pool into actual CSS pixels so downscaling cannot silently drop short
      // transients. Playback/draft edits never redraw or recompute the spectrum.
      const displayWidth = Math.floor(canvas.clientWidth) || data.columns;
      const displayHeight = Math.floor(canvas.clientHeight) || 155;
      const size = `${displayWidth}/${displayHeight}`;
      if (size === previousSize) return;
      try {
        const context = canvas.getContext('2d');
        if (!context) {
          setRenderFailed(true);
          return;
        }
        const { width, height, pixels } = spectrogramPixels(
          data,
          displayWidth,
          displayHeight,
          {
            time: fixedTime ? { min: time.min, max: time.max } : null,
            frequency: fixedFrequency
              ? { min: frequency.min, max: frequency.max }
              : null,
            color: { min: color.min, max: color.max },
          },
        );
        canvas.width = width;
        canvas.height = height;
        const image = context.createImageData(width, height);
        image.data.set(pixels);
        context.putImageData(image, 0, 0);
        previousSize = size;
        setRenderFailed(false);
      } catch {
        setRenderFailed(true);
      }
    }
    draw();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [
    data,
    time.min,
    time.max,
    frequency.min,
    frequency.max,
    color.min,
    color.max,
    fixedTime,
    fixedFrequency,
  ]);

  return (
    <figure className="spectrogram-chart">
      <figcaption className="spectrogram-caption">
        <span>ch1 · dBFS</span>
      </figcaption>
      <div className="spectrogram-axes">
        <SpectrogramAxisControl
          axis="frequency"
          label="周波数軸 (kHz)"
          className="spectrogram-frequency-axis"
          settingsId={settingsId}
          settingsOpen={settingsOpen}
          helpId={axisHelpId}
          onEditAxis={onEditAxis}
        >
          <span className="spectrogram-frequency-label" aria-hidden="true">
            周波数 (kHz)
          </span>
          <span className="spectrogram-frequency-ticks" aria-hidden="true">
            <span>{formatTick(frequency.max)}</span>
            <span>
              {formatTick(frequency.min + (frequency.max - frequency.min) / 2)}
            </span>
            <span>{formatTick(frequency.min)}</span>
          </span>
        </SpectrogramAxisControl>
        <div className="spectrogram-plot">
          <canvas
            ref={canvasRef}
            className="spectrogram-canvas"
            role="img"
            aria-label={label + ' のスペクトログラム'}
            aria-describedby={descriptionId}
            hidden={renderFailed}
          >
            スペクトログラムを表示するにはCanvas対応ブラウザーが必要です。
          </canvas>
          {renderFailed ? (
            <output className="spectrogram-unavailable">
              スペクトログラムを描画できません。音声は再生できます。
            </output>
          ) : visiblePlayhead ? (
            <span
              className="spectrogram-playhead"
              style={{ left: `${progress * 100}%` }}
              aria-hidden="true"
            />
          ) : null}
        </div>
        <SpectrogramAxisControl
          axis="time"
          label="時間軸 (s)"
          className="spectrogram-time-axis"
          settingsId={settingsId}
          settingsOpen={settingsOpen}
          helpId={axisHelpId}
          onEditAxis={onEditAxis}
        >
          <span className="spectrogram-time-ticks" aria-hidden="true">
            <span>{formatTick(time.min)}</span>
            <span>{formatTick(time.min + (time.max - time.min) / 2)}</span>
            <span>{formatTick(time.max)}</span>
          </span>
          <span className="spectrogram-time-unit" aria-hidden="true">
            時間 (s)
          </span>
        </SpectrogramAxisControl>
      </div>
      <figure
        className="spectrogram-color-key"
        aria-label={`振幅の色目盛り。暗い青から明るい青へ、${formatTick(color.min)}〜${formatTick(color.max)}dBFS。全サンプル共通。`}
      >
        <SpectrogramAxisControl
          axis="color"
          label="色目盛り (dBFS)"
          className="spectrogram-color-axis"
          settingsId={settingsId}
          settingsOpen={settingsOpen}
          helpId={axisHelpId}
          onEditAxis={onEditAxis}
        >
          <span
            className="spectrogram-colorbar"
            style={{ background: COLORBAR }}
            aria-hidden="true"
          />
          <span className="spectrogram-color-ticks" aria-hidden="true">
            <span>{formatTick(color.min)}</span>
            <span>{formatTick(color.min + (color.max - color.min) / 2)}</span>
            <span>{formatTick(color.max)} dBFS</span>
          </span>
        </SpectrogramAxisControl>
      </figure>
      <p id={descriptionId} className="sr-only">
        {description}
      </p>
      {onEditAxis && (
        <p id={axisHelpId} className="sr-only">
          ダブルクリック、またはEnter・Spaceで軸の範囲設定を開きます。
        </p>
      )}
    </figure>
  );
}
