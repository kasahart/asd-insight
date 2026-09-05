'use client';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSessionState, useWorkspace } from '@/state/workspace-context';
import { EvaluationWorkerClient } from '@domain/evaluation-client';
import type {
  EvaluationInput,
  EvaluationResult,
  EvaluationPartition,
  ThresholdSelection,
  EvaluationListSpec,
  QueryMode,
} from '@contracts/evaluation';
import { finiteNumber } from '@/lib/distribution';
import { precisionRecall } from '@/lib/precision-recall';
import type { ScoreDirection } from '@/lib/threshold';
import type { Dataset } from '@/lib/demo';
import { partitionRows, type GroupSpec, type Sample } from '@/lib/data';
import {
  histogram,
  type Distribution,
  type ScoreRange,
} from '@/lib/distribution';
import {
  type CandidateScope,
  type ReviewCounts,
  type ReviewFilter,
} from '@/lib/sample-review';
import {
  normalizeReviewReason,
  type ReviewDecision,
  type ReviewSummary,
} from '@/lib/review-audit';
import {
  ThresholdScope,
  type PrecisionRecallEvaluation,
  type ThresholdReport,
} from '@/components/threshold-context';

export type ComparisonState = {
  value: ReturnType<typeof partitionRows>;
  error: string;
};
export type IgnoredSample = {
  rowIndex: number;
  reason: string;
  at: string;
  groupColumn: string;
  groupValue: string;
  decision: ReviewDecision;
};
export type ReviewEvent = IgnoredSample & { action: 'ignore' | 'restore' };
export type SampleReviewState = {
  pending: boolean;
  workerResult: EvaluationResult | null;
  comparison: ComparisonState;
  baseline: ReviewSummary;
  thresholdReport: ThresholdReport | null;
  evaluation: PrecisionRecallEvaluation;
  distribution: Distribution;
  error: string;
  a: number[];
  b: number[];
  visible: Sample[];
  listed: Sample[];
  ignoredInList: Sample[];
  /** These are null while a new worker result is pending. */
  calculationTotal: number | null;
  listingTotal: number | null;
  listingIgnoredTotal: number | null;
  ignoredIndices: ReadonlySet<number>;
  selectedSample: Sample | null;
  commonBins: Distribution['bins'];
  filter: ReviewFilter;
  filterError: string;
  setFilter: (filter: ReviewFilter) => void;
  counts: ReviewCounts;
  candidateScope: CandidateScope | null;
  ignored: IgnoredSample[];
  history: ReviewEvent[];
  ignore: (sample: Sample, reason: string) => void;
  restore: (rowIndex: number) => void;
};

const ResultContext = createContext<EvaluationResult | null>(null);
export function useEvaluationResult() {
  return useContext(ResultContext);
}
const emptyPartition = {
  samples: [] as Sample[],
  memberRows: [],
  outsideFilter: 0,
  missingGroup: 0,
  otherGroup: 0,
  missingA: 0,
  missingB: 0,
  membersA: 0,
  membersB: 0,
  ignoredRows: 0,
};
const emptyDistribution = histogram([], [], 24);
const emptyPR = {
  ...precisionRecall([], [], 'high'),
  positiveGroup: 'B' as const,
  negativeGroup: 'A' as const,
  direction: 'high' as const,
};
const emptySummary: ReviewSummary = {
  nA: 0,
  nB: 0,
  total: 0,
  prAuc: null,
  positiveFraction: null,
  okGroup: 'A',
  positiveGroup: 'B',
  scoreDirection: 'high',
};
function useEvaluation(input: EvaluationInput, populationKey: string) {
  const [completed, setCompleted] = useState<{
    input: EvaluationInput;
    populationKey: string;
    retry: number;
    result: EvaluationResult | null;
    error: string;
  } | null>(null);
  const [retry, setRetry] = useState(0);
  const activeAbort = useRef<AbortController | null>(null);
  const [client] = useState(() => new EvaluationWorkerClient());
  useEffect(() => {
    const abort = new AbortController();
    activeAbort.current = abort;
    void client
      .evaluate(input, { signal: abort.signal })
      .then((result) => {
        if (!abort.signal.aborted)
          setCompleted({ input, populationKey, retry, result, error: '' });
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setCompleted({
            input,
            populationKey,
            retry,
            result: null,
            error: error instanceof Error ? error.message : '集計できません。',
          });
      });
    return () => abort.abort();
  }, [input, populationKey, retry, client]);
  // cancel preserves the client for StrictMode effect replay; an aborted worker is terminated.
  useEffect(() => () => client.cancel(), [client]);
  const pending =
    completed?.input !== input ||
    completed?.populationKey !== populationKey ||
    completed?.retry !== retry;
  return {
    result: pending ? null : (completed?.result ?? null),
    presentation:
      completed?.input.dataset === input.dataset ? completed.result : null,
    presentationInput:
      completed?.input.dataset === input.dataset ? completed.input : null,
    presentationPopulationKey:
      completed?.input.dataset === input.dataset
        ? completed.populationKey
        : null,
    pending,
    error: pending ? '' : (completed?.error ?? ''),
    retry: () => setRetry((v) => v + 1),
    cancel: () => {
      activeAbort.current?.abort();
      client.cancel();
      setCompleted({
        input,
        populationKey,
        retry,
        result: null,
        error: '集計を停止しました。再計算できます。',
      });
    },
  };
}
export function SampleReviewWorkspace({
  dataset,
  score,
  group,
  filterColumn,
  filterValue,
  bins,
  range,
  overlapOnly,
  query,
  queryMode = 'partial',
  idColumn,
  selectedIndex,
  labelA = '群A',
  labelB = '群B',
  children,
}: {
  dataset: Dataset;
  score: string;
  group: GroupSpec;
  filterColumn: string;
  filterValue: string;
  bins: number;
  range: ScoreRange | null;
  overlapOnly: boolean;
  query: string;
  /** Omitted by old callers/bundles to preserve the original partial match. */
  queryMode?: QueryMode;
  idColumn: string;
  selectedIndex: number | null;
  labelA?: string;
  labelB?: string;
  children: (state: SampleReviewState) => ReactNode;
}) {
  const { active } = useWorkspace();
  const [records, setRecords] = useSessionState<Record<number, IgnoredSample>>(
    'reviewRecords',
    {},
  );
  const [history, setHistory] = useSessionState<ReviewEvent[]>(
    'reviewHistory',
    [],
  );
  const [okGroup, setOkGroup] = useSessionState<'A' | 'B'>('okGroup', 'A');
  const [direction, setDirection] = useSessionState<ScoreDirection>(
    'direction',
    'high',
  );
  const [targetPercent, setTargetPercent] = useSessionState(
    'targetPercent',
    '1',
  );
  const [setting, setSetting] = useSessionState<{
    scope: string;
    selection: ThresholdSelection;
  } | null>('thresholdSetting', null);
  const [decision, setDecision] = useSessionState<{
    filter: ReviewFilter;
    scope: string;
  }>('filterDecision', { filter: 'all', scope: '' });
  const [comparisonColumn] = useSessionState('comparisonColumn', '');
  const [sorting] = useSessionState<Array<{ id: string; desc: boolean }>>(
    'tableSorting',
    [{ id: 'score', desc: false }],
  );
  const [viewport] = useSessionState<{
    scoreColumn: string;
    selection: { extent: { min: number; max: number } | null };
  } | null>('viewport', null);
  const [filterError, setFilterError] = useState('');
  const ignored = useMemo(() => Object.values(records), [records]);
  const ignoredIndices = useMemo(
    () => new Set(ignored.map((s) => s.rowIndex)),
    [ignored],
  );
  const populationKey = JSON.stringify([
    active!.record.datasetHash,
    'evaluation-v1',
    score,
    group,
    filterColumn,
    filterValue,
    [...ignoredIndices],
    okGroup,
    direction,
  ]);
  const selection = setting?.scope === populationKey ? setting.selection : null;
  useEffect(() => {
    if (setting && setting.scope !== populationKey) {
      setSetting(null);
      if (decision.filter !== 'ignored')
        setDecision({ filter: 'all', scope: '' });
    }
  }, [populationKey, setting, decision.filter, setSetting, setDecision]);
  const filter =
    decision.filter === 'ignored'
      ? 'ignored'
      : selection && decision.scope === populationKey
        ? decision.filter
        : 'all';
  const histogramDomain =
    viewport?.scoreColumn === score ? viewport.selection.extent : null;
  const input = useMemo<EvaluationInput>(() => {
    const sort = sorting[0] ?? { id: 'score', desc: false };
    const displayedComparison =
      comparisonColumn !== score && dataset.columns.includes(comparisonColumn)
        ? comparisonColumn
        : '';
    const sourceColumn = sort.id.startsWith('comparison-score:')
      ? displayedComparison
      : sort.id === 'attribute'
        ? group.column
        : '';
    const mapped: NonNullable<EvaluationListSpec['sort']> = sourceColumn
      ? {
          column: sourceColumn,
          desc: sort.desc,
          source: 'row',
          kind: sort.id === 'attribute' ? 'alphanumeric' : 'number',
        }
      : {
          column:
            sort.id === 'sample'
              ? '__sample'
              : sort.id === 'group'
                ? '__group'
                : '__score',
          desc:
            sort.id.startsWith('comparison-score:') && !sourceColumn
              ? false
              : sort.desc,
        };
    return {
      dataset,
      scoreColumn: score,
      group,
      conditionFilter:
        filterColumn && filterValue
          ? { column: filterColumn, value: filterValue }
          : null,
      ignoredIndices: [...ignoredIndices],
      okGroup,
      direction,
      bins,
      threshold: selection,
      comparisonScoreColumn: displayedComparison,
      histogramDomain,
      list: {
        range,
        overlapOnly,
        query,
        queryMode,
        idColumn,
        decisionFilter: filter,
        sort: mapped,
      },
    };
  }, [
    dataset,
    score,
    group,
    filterColumn,
    filterValue,
    ignoredIndices,
    okGroup,
    direction,
    bins,
    selection,
    comparisonColumn,
    histogramDomain,
    range,
    overlapOnly,
    query,
    queryMode,
    idColumn,
    filter,
    sorting,
  ]);
  const execution = useEvaluation(input, populationKey);
  // A manual selection contains the value that the user is currently editing.
  // For a rate selection, retain the last completed rule only while the
  // selection still belongs to this population. This keeps the operation host
  // mounted during a list-only recalculation without treating its old metrics
  // as the new result.
  const presentationThreshold = execution.presentationInput?.threshold;
  const operationRule =
    selection?.kind === 'manual'
      ? selection.rule
      : selection?.kind === 'ok-rate' &&
          presentationThreshold?.kind === 'ok-rate' &&
          presentationThreshold.targetPercent === selection.targetPercent &&
          execution.presentationPopulationKey === populationKey
        ? (execution.presentation?.thresholdReport?.calibration.rule ?? null)
        : null;
  const result =
    execution.result ?? (execution.pending ? execution.presentation : null);
  const pending = execution.pending;
  const partition = useMemo(
    () => (value: EvaluationPartition | undefined) =>
      value
        ? {
            ...value,
            samples: value.samples.map((s) => ({
              ...s,
              row: dataset.rows[s.index],
            })),
            memberRows: value.memberIndices.map((i) => dataset.rows[i]),
          }
        : emptyPartition,
    [dataset],
  );
  const comparison = useMemo(
    () => ({ value: partition(result?.comparison), error: execution.error }),
    [partition, result, execution.error],
  );
  const allSamples = useMemo(
    () => partition(result?.baseline).samples,
    [partition, result],
  );
  const lookup = useMemo(
    () => new Map(allSamples.map((s) => [s.index, s])),
    [allSamples],
  );
  const listed = useMemo(
    () =>
      result?.listing.listedIndices
        .map((i) => lookup.get(i)!)
        .filter(Boolean) ?? [],
    [result, lookup],
  );
  const visible = useMemo(
    () =>
      result?.listing.includedIndices
        .map((i) => lookup.get(i)!)
        .filter(Boolean) ?? [],
    [result, lookup],
  );
  const ignoredInList = useMemo(
    () =>
      result?.listing.ignoredIndices
        .map((i) => lookup.get(i)!)
        .filter(Boolean) ?? [],
    [result, lookup],
  );
  const report = pending ? null : (result?.thresholdReport ?? null);
  const evaluation = pending
    ? {
        ...emptyPR,
        direction,
        negativeGroup: okGroup,
        positiveGroup: okGroup === 'A' ? ('B' as const) : ('A' as const),
      }
    : (result?.evaluation ?? emptyPR);
  function clear() {
    setSetting(null);
    if (filter !== 'ignored') setDecision({ filter: 'all', scope: '' });
  }
  function installRate(value: number) {
    if (pending) throw new Error('集計が完了してから設定してください。');
    if (!Number.isFinite(value) || value < 0 || value > 100)
      throw new Error('目標率は0〜100%で入力してください。');
    if (!result || !(okGroup === 'A' ? result.a.length : result.b.length))
      throw new Error('OK基準群に有効なスコアがありません。');
    setSetting({
      scope: populationKey,
      selection: { kind: 'ok-rate', targetPercent: value },
    });
  }
  const threshold = {
    okGroup,
    direction,
    targetPercent,
    okGroupLabel: okGroup === 'A' ? labelA : labelB,
    otherGroupLabel: okGroup === 'A' ? labelB : labelA,
    evaluation,
    report,
    pending,
    selection,
    operationRule,
    setOkGroup: (value: 'A' | 'B') => {
      setOkGroup(value);
      clear();
    },
    setDirection: (value: ScoreDirection) => {
      setDirection(value);
      clear();
    },
    setTargetPercent: (value: string) => {
      setTargetPercent(value);
      clear();
    },
    clear,
    applyFromInput: () => {
      const value = finiteNumber(targetPercent);
      if (value === null) {
        clear();
        throw new Error('目標率は0〜100%で入力してください。');
      }
      installRate(value);
    },
    applyManualThreshold: (value: number) => {
      const currentRule = operationRule ?? report?.calibration.rule;
      if (!currentRule || !Number.isFinite(value))
        throw new Error('有効なしきい値を設定してください。');
      setSetting({
        scope: populationKey,
        selection: {
          kind: 'manual',
          rule: { ...currentRule, threshold: value },
        },
      });
    },
  };
  function setFilter(next: ReviewFilter) {
    try {
      if (next === 'false-positive' || next === 'false-negative') {
        if (!selection) {
          installRate(1);
          setTargetPercent('1');
        }
      }
      setDecision({ filter: next, scope: populationKey });
      setFilterError('');
    } catch (error) {
      setFilterError(
        error instanceof Error ? error.message : '設定できません。',
      );
    }
  }
  function capture(): ReviewDecision {
    if (pending || !result || execution.error)
      throw new Error('集計完了後に操作してください。');
    return {
      scoreColumn: score,
      group: { ...group },
      filter:
        filterColumn && filterValue
          ? { column: filterColumn, value: filterValue }
          : null,
      okGroup,
      scoreDirection: direction,
      threshold: report
        ? { ...report.calibration, rule: { ...report.calibration.rule } }
        : null,
      before: { ...result.summary },
    };
  }
  function ignore(sample: Sample, reason: string) {
    if (
      pending ||
      execution.error ||
      dataset.rows[sample.index] !== sample.row ||
      records[sample.index]
    )
      return;
    const entry: IgnoredSample = {
      rowIndex: sample.index,
      reason: normalizeReviewReason(reason),
      at: new Date().toISOString(),
      groupColumn: group.column,
      groupValue: sample.row[group.column] ?? '',
      decision: capture(),
    };
    clear();
    setDecision({ filter: 'all', scope: '' });
    setRecords((prev) => ({ ...prev, [sample.index]: entry }));
    setHistory((prev) => [...prev, { ...entry, action: 'ignore' }]);
  }
  function restore(rowIndex: number) {
    if (pending || execution.error || !records[rowIndex]) return;
    const entry = {
      ...records[rowIndex],
      at: new Date().toISOString(),
      decision: capture(),
    };
    clear();
    setRecords((prev) => {
      const next = { ...prev };
      delete next[rowIndex];
      return next;
    });
    setHistory((prev) => [...prev, { ...entry, action: 'restore' }]);
  }
  const distribution = result?.distribution ?? emptyDistribution;
  const calculationTotal =
    !pending && execution.result ? execution.result.comparison.samples.length : null;
  const listingTotal =
    !pending && execution.result
      ? execution.result.listing.listedIndices.length
      : null;
  const listingIgnoredTotal =
    !pending && execution.result
      ? execution.result.listing.ignoredIndices.length
      : null;
  const state: SampleReviewState = {
    pending,
    workerResult: execution.result,
    comparison,
    baseline: result?.baselineSummary ?? emptySummary,
    thresholdReport: report,
    evaluation,
    distribution,
    error: execution.error,
    a: result?.a ?? [],
    b: result?.b ?? [],
    visible,
    listed,
    ignoredInList,
    calculationTotal,
    listingTotal,
    listingIgnoredTotal,
    ignoredIndices,
    selectedSample: lookup.get(selectedIndex ?? -1) ?? listed[0] ?? null,
    commonBins: distribution.bins.filter(
      (bin) => bin.countA > 0 && bin.countB > 0,
    ),
    filter,
    filterError,
    setFilter,
    counts:
      !pending && result
        ? result.listing.counts
        : {
            all: 0,
            falsePositive: null,
            falseNegative: null,
          },
    candidateScope: !pending ? (result?.listing.candidateScope ?? null) : null,
    ignored,
    history,
    ignore,
    restore,
  };
  return (
    <ResultContext.Provider value={execution.result}>
      <ThresholdScope value={threshold}>
        <div className="evaluation-status" aria-live="polite">
          {pending ? (
            <>
              <span>再計算中…</span>
              <button type="button" onClick={execution.cancel}>
                停止
              </button>
            </>
          ) : execution.error ? (
            <>
              <span role="alert">{execution.error}</span>
              <button type="button" onClick={execution.retry}>
                再計算
              </button>
            </>
          ) : null}
        </div>
        {children(state)}
      </ThresholdScope>
    </ResultContext.Provider>
  );
}
