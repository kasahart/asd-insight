'use client';
import { useSessionState } from '@/state/workspace-context';
import { useEvaluationResult } from './sample-review-workspace';

import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PersistentDetails } from '@/components/view-preferences';
import { useThreshold } from '@/components/threshold-context';
import {
  finiteNumber,
  formatScore,
  histogram,
  type Distribution,
} from '@/lib/distribution';
import type { ScoreExtent } from '@/lib/distribution-viewport';

type Selection = {
  mode: 'full' | 'central' | 'manual';
  extent: ScoreExtent | null;
};
type ViewportState = {
  scoreColumn: string;
  selection: Selection;
  lower: string;
  upper: string;
  error: string;
};
type View = {
  distribution: Distribution;
  controls: ReactNode;
  notice: ReactNode;
};

// This owns only the chart's viewport. The comparison, threshold model and
// sample-list range stay outside it and never receive the cropped population.
export function DistributionViewport({
  scoreColumn,
  distribution,
  selectedScore,
  children,
}: {
  source: object;
  scoreColumn: string;
  distribution: Distribution;
  a: number[];
  b: number[];
  selectedScore: number | null;
  children: (view: View) => ReactNode;
}) {
  const inputId = useId();
  const result = useEvaluationResult();
  const [state, setState] = useSessionState<ViewportState | null>(
    'viewport',
    null,
  );
  const fallback: ViewportState = {
    scoreColumn,
    selection: { mode: 'full', extent: null },
    lower: '',
    upper: '',
    error: '',
  };
  const current =
    state?.scoreColumn === scoreColumn
      ? state
      : fallback;
  const { report } = useThreshold();
  const central = result?.viewport.central ?? null;
  const extent = current.selection.extent;
  const calculated = {
    value: result?.displayDistribution ?? distribution,
    error: '',
  };
  const active = extent;
  const outside = active ? (result?.viewport.outside ?? null) : null;
  const threshold = report?.calibration.rule.threshold;
  const thresholdOutside =
    active &&
    threshold !== undefined &&
    (threshold < active.min || threshold > active.max);
  const sampleOutside =
    active &&
    selectedScore !== null &&
    (selectedScore < active.min || selectedScore > active.max);
  function reset() {
    setState({
      scoreColumn,
      selection: { mode: 'full', extent: null },
      lower: '',
      upper: '',
      error: '',
    });
  }
  function apply() {
    const min = finiteNumber(current.lower);
    const max = finiteNumber(current.upper);
    if (
      min === null ||
      max === null ||
      min >= max ||
      !Number.isFinite(max - min)
    ) {
      setState({
        ...current,
        error: '下限より大きい上限を数値で入力してください。',
      });
      return;
    }
    try {
      // Validate only the bounded bin geometry; no samples are recomputed here.
      histogram([], [], distribution.bins.length || 24, { min, max });
      setState({
        ...current,
        selection: { mode: 'manual', extent: { min, max } },
        error: '',
      });
    } catch (error) {
      setState({
        ...current,
        error:
          error instanceof Error ? error.message : '横軸を設定できません。',
      });
    }
  }
  const error = current.error || calculated.error;
  const controls = (
    <PersistentDetails
      preferenceKey="distribution.viewport"
      className="distribution-viewport-controls"
    >
      <summary>
        横軸：
        {active
          ? current.selection.mode === 'central'
            ? '中心部'
            : '指定範囲'
          : '全体'}
      </summary>
      <div className="distribution-viewport-fields">
        <Button
          type="button"
          variant="outline"
          disabled={!central}
          aria-pressed={current.selection.mode === 'central' && !!active}
          onClick={() => {
            if (central)
              setState({
                ...current,
                selection: { mode: 'central', extent: central },
                lower: String(central.min),
                upper: String(central.max),
                error: '',
              });
          }}
        >
          中心部を拡大
        </Button>
        <label htmlFor={inputId + '-lower'}>
          下限
          <Input
            id={inputId + '-lower'}
            aria-label="横軸の下限"
            inputMode="decimal"
            value={current.lower}
            aria-invalid={!!current.error}
            aria-describedby={current.error ? inputId + '-error' : undefined}
            placeholder={formatScore(distribution.min)}
            onChange={(event) =>
              setState({ ...current, lower: event.target.value, error: '' })
            }
          />
        </label>
        <label htmlFor={inputId + '-upper'}>
          上限
          <Input
            id={inputId + '-upper'}
            aria-label="横軸の上限"
            inputMode="decimal"
            value={current.upper}
            aria-invalid={!!current.error}
            aria-describedby={current.error ? inputId + '-error' : undefined}
            placeholder={formatScore(distribution.max)}
            onChange={(event) =>
              setState({ ...current, upper: event.target.value, error: '' })
            }
          />
        </label>
        <Button type="button" variant="outline" onClick={apply}>
          横軸を適用
        </Button>
      </div>
      <p className="small-muted">グラフのみ変更。集計・一覧は変わりません。</p>
      {!central && (
        <p className="small-muted">
          中心部の自動拡大は対象外です。必要な横軸を数値で指定できます。
        </p>
      )}
      {error && (
        <p id={inputId + '-error'} role="alert" className="inline-error">
          {error}
        </p>
      )}
    </PersistentDetails>
  );
  const notice =
    active || calculated.error ? (
      <div className="distribution-viewport-notice">
        {calculated.error && (
          <span role="alert">
            指定した横軸では描画できないため全体を表示しています。
            {calculated.error}
          </span>
        )}
        {active && outside && (
          <span>
            {current.selection.mode === 'central'
              ? '中心部を表示'
              : '指定範囲を表示'}{' '}
            · 範囲外：群A 下{outside.belowA} / 上{outside.aboveA}
            件、群B 下{outside.belowB} / 上{outside.aboveB}件
          </span>
        )}
        {thresholdOutside && (
          <span className="viewport-outside-threshold">
            しきい値は表示範囲外
          </span>
        )}
        {sampleOutside && (
          <span className="viewport-outside-sample">
            選択サンプルは表示範囲外
          </span>
        )}
        <Button type="button" variant="ghost" onClick={reset}>
          全体へ戻す
        </Button>
      </div>
    ) : null;
  return children({ distribution: calculated.value, controls, notice });
}
