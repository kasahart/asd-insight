'use client';

import {
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type Ref,
} from 'react';
import { SpectrogramChart } from '@/components/spectrogram-chart';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  PersistentDetails,
  useViewPreferences,
  type SpectrogramPreferences,
  type SpectrogramRangePreference,
} from '@/components/view-preferences';
import {
  SPECTROGRAM_DEFAULT_MIN_DB,
  SPECTROGRAM_DEFAULT_MAX_DB,
  type SpectrogramData,
} from '@/lib/spectrogram';

function SpectrogramRangeControl({
  axis,
  label,
  unit,
  value,
  automatic,
  onChange,
  minInputRef,
}: {
  axis: keyof SpectrogramPreferences;
  label: string;
  unit: string;
  value: SpectrogramRangePreference;
  automatic: { min: number; max: number };
  onChange: (value: SpectrogramRangePreference) => void;
  minInputRef: Ref<HTMLInputElement>;
}) {
  const [error, setError] = useState('');
  const errorId = `spectrogram-${axis}-error`;
  const draftStarted =
    value.draftStarted ??
    (value.range !== null || value.minInput !== '' || value.maxInput !== '');
  // Auto shows real editable bounds. The first edit captures both visible
  // ends, while a deliberately cleared draft stays empty across samples.
  const minInput = draftStarted ? value.minInput : String(automatic.min);
  const maxInput = draftStarted ? value.maxInput : String(automatic.max);
  function edit(edge: 'minInput' | 'maxInput', input: string) {
    setError('');
    onChange({
      ...value,
      minInput,
      maxInput,
      [edge]: input,
      draftStarted: true,
    });
  }
  function apply() {
    const min = Number(minInput);
    const max = Number(maxInput);
    if (
      !minInput.trim() ||
      !maxInput.trim() ||
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      !Number.isFinite(max - min) ||
      min >= max ||
      (axis !== 'color' && min < 0) ||
      (axis === 'frequency' && !Number.isFinite(max * 1000))
    ) {
      setError(
        axis === 'color'
          ? '下限と、それより大きい上限を数値で入力してください。'
          : '0以上の下限と、それより大きい上限を数値で入力してください。',
      );
      return;
    }
    setError('');
    onChange({
      ...value,
      minInput,
      maxInput,
      draftStarted: true,
      range: { min, max },
    });
  }
  return (
    <div className="spectrogram-range-setting" data-axis={axis}>
      <div className="spectrogram-range-row">
        <span className="spectrogram-range-label">
          {label} ({unit})
        </span>
        <div className="spectrogram-range-fields">
          <Input
            ref={minInputRef}
            aria-label={`${label}の下限 (${unit})`}
            inputMode="decimal"
            value={minInput}
            aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => edit('minInput', event.target.value)}
          />
          <span aria-hidden="true">–</span>
          <Input
            aria-label={`${label}の上限 (${unit})`}
            inputMode="decimal"
            value={maxInput}
            aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => edit('maxInput', event.target.value)}
          />
          <Button
            variant="outline"
            aria-label={`${label}範囲を適用`}
            onClick={apply}
          >
            適用
          </Button>
          <Button
            variant="ghost"
            aria-label={`${label}範囲をオートに戻す`}
            aria-pressed={value.range === null}
            onClick={() => {
              setError('');
              onChange({
                range: null,
                minInput: '',
                maxInput: '',
                draftStarted: false,
              });
            }}
          >
            オート
          </Button>
        </div>
      </div>
      {error && (
        <p id={errorId} className="inline-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function SampleSpectrogram({
  data,
  label,
  currentTime,
  phase,
  error,
  onRetry,
}: {
  data: SpectrogramData | null;
  label: string;
  currentTime: number;
  phase?: 'initializing' | 'analyzing';
  error?: string;
  onRetry?: () => void;
}) {
  const { disclosures, setDisclosure, spectrogram, updateSpectrogram } =
    useViewPreferences();
  const open = disclosures['sample.spectrogram'] ?? true;
  const settingsOpen = disclosures['sample.spectrogram.method'] ?? false;
  const settingsId = useId();
  const timeInput = useRef<HTMLInputElement>(null);
  const frequencyInput = useRef<HTMLInputElement>(null);
  const colorInput = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<{
    axis: keyof SpectrogramPreferences;
    data: SpectrogramData;
    label: string;
  } | null>(null);
  const [focusRequest, requestFocus] = useReducer(
    (version: number) => version + 1,
    0,
  );
  function editAxis(axis: keyof SpectrogramPreferences) {
    if (!data) return;
    pendingFocus.current = { axis, data, label };
    setDisclosure('sample.spectrogram.method', true);
    // A fresh request also focuses when the same settings are already open.
    requestFocus();
  }

  useLayoutEffect(() => {
    const request = pendingFocus.current;
    // Consume first, including requests superseded by a sample change. A later
    // decode, redraw, or return to this sample must not replay an old action.
    pendingFocus.current = null;
    if (
      !request ||
      !open ||
      !settingsOpen ||
      !data ||
      request.data !== data ||
      request.label !== label
    )
      return;
    const input =
      request.axis === 'time'
        ? timeInput.current
        : request.axis === 'frequency'
          ? frequencyInput.current
          : colorInput.current;
    input?.focus({ preventScroll: true });
    input?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [focusRequest, open, settingsOpen, data, label]);

  return (
    <PersistentDetails
      preferenceKey="sample.spectrogram"
      defaultOpen
      className="sample-spectrogram"
    >
      <summary>
        スペクトログラム <span>ch1</span>
      </summary>
      {open &&
        (error ? (
          <div role="alert">
            <p className="inline-error">{error}</p>
            {onRetry && (
              <Button variant="outline" onClick={onRetry}>
                音声解析を再試行
              </Button>
            )}
          </div>
        ) : data ? (
          <>
            <SpectrogramChart
              data={data}
              label={label}
              currentTime={currentTime}
              ranges={{
                time: spectrogram.time.range,
                frequency: spectrogram.frequency.range,
                color: spectrogram.color.range,
              }}
              onEditAxis={editAxis}
              settingsId={settingsId}
              settingsOpen={settingsOpen}
            />
            <PersistentDetails
              preferenceKey="sample.spectrogram.method"
              className="spectrogram-method"
              id={settingsId}
            >
              <summary>表示条件</summary>
              <p className="spectrogram-shared-scope">全サンプル共通</p>
              <div className="spectrogram-range-controls">
                <SpectrogramRangeControl
                  axis="time"
                  label="時間"
                  unit="s"
                  value={spectrogram.time}
                  automatic={{ min: 0, max: data.duration }}
                  onChange={(time) => updateSpectrogram({ time })}
                  minInputRef={timeInput}
                />
                <SpectrogramRangeControl
                  axis="frequency"
                  label="周波数"
                  unit="kHz"
                  value={spectrogram.frequency}
                  automatic={{ min: 0, max: data.sampleRate / 2000 }}
                  onChange={(frequency) => updateSpectrogram({ frequency })}
                  minInputRef={frequencyInput}
                />
                <SpectrogramRangeControl
                  axis="color"
                  label="色"
                  unit="dBFS"
                  value={spectrogram.color}
                  automatic={{
                    min: SPECTROGRAM_DEFAULT_MIN_DB,
                    max: SPECTROGRAM_DEFAULT_MAX_DB,
                  }}
                  onChange={(color) => updateSpectrogram({ color })}
                  minInputRef={colorInput}
                />
              </div>
              <p>
                オートは時間・周波数の全範囲、色は共通の−100〜0 dBFS。
                空白は音声の範囲外、白線は再生位置です。
              </p>
              <p>
                ch1・Hann窓{data.fftSize}点 / 移動{data.hopSize}
                点。
                縮約は最大値で、出現頻度は表しません。色は音量つまみに連動しない
                デジタル振幅です。音圧ではなく、録音ゲインの異なる強さは直接比較できません。
              </p>
            </PersistentDetails>
          </>
        ) : (
          <output className="spectrogram-status">
            {phase === 'initializing'
              ? '音声エンジンを準備中…'
              : '波形・スペクトログラムを計算中…'}
          </output>
        ))}
    </PersistentDetails>
  );
}
