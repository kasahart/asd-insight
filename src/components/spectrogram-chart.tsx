'use client';

// Canvas needs image semantics; replacing it with img would require a bitmap URL.
/* oxlint-disable jsx-a11y/prefer-tag-over-role */

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  SPECTROGRAM_DEFAULT_MIN_DB,
  SPECTROGRAM_DEFAULT_MAX_DB,
  type SpectrogramData,
} from '@/lib/spectrogram';

import {
  spectrogramDisplayRanges,
  spectrogramColor,
  spectrogramPixels,
  type SpectrogramDisplayOptions,
} from '@/lib/spectrogram-display';
export {
  spectrogramDisplayRanges,
  spectrogramColor,
  spectrogramPixels,
  type SpectrogramDisplayOptions,
} from '@/lib/spectrogram-display';

const DEFAULT_COLOR = {
  min: SPECTROGRAM_DEFAULT_MIN_DB,
  max: SPECTROGRAM_DEFAULT_MAX_DB,
};

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
