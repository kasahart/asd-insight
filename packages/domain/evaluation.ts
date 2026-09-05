import { partitionRows, type Sample } from './data.ts';
import type { Dataset } from './demo.ts';
import { histogram, scoreInRange } from './distribution.ts';
import {
  centralScoreExtent,
  outsideScoreExtent,
} from './distribution-viewport.ts';
import { precisionRecall } from './precision-recall.ts';
import { summarizeReviewComparison } from './review-audit.ts';
import { buildReviewListing, candidateScope } from './sample-review.ts';
import { scoreCoverage } from './score-coverage.ts';
import { sortReviewSamples } from './evaluation-sorting.ts';
import {
  calibrateOkRate,
  manualThreshold,
  summarizeThreshold,
} from './threshold.ts';
import type {
  EvaluatedSample,
  EvaluationResult,
  EvaluationSpec,
  EvaluationThresholdReport,
  EvaluationPartition,
  PopulationCounts,
} from '../contracts/evaluation.ts';

export const DATASET_LIMITS = {
  rows: 100_000,
  columns: 128,
  csvBytes: 20 * 1024 * 1024,
} as const;

/** Validate once when registering a structured-cloned dataset in a worker. */
export function validateDataset(dataset: Dataset): void {
  if (
    !dataset ||
    typeof dataset.name !== 'string' ||
    typeof dataset.demo !== 'boolean' ||
    !Array.isArray(dataset.columns) ||
    !Array.isArray(dataset.rows)
  )
    throw new Error('データセットの形式が不正です。');
  if (
    !dataset.columns.length ||
    dataset.columns.length > DATASET_LIMITS.columns ||
    dataset.rows.length > DATASET_LIMITS.rows
  )
    throw new Error('データセットは100,000行・128列までです。');
  if (
    dataset.columns.some(
      (column) => typeof column !== 'string' || !column.trim(),
    ) ||
    new Set(dataset.columns).size !== dataset.columns.length
  )
    throw new Error('列名は空欄にせず一意にしてください。');
  for (const row of dataset.rows) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      dataset.columns.some(
        (column) =>
          !Object.hasOwn(row, column) || typeof row[column] !== 'string',
      )
    )
      throw new Error(
        '各行に列名に対応する文字列の値が必要です。欠測は空文字で指定してください。',
      );
  }
}

function validateSpec(dataset: Dataset, spec: EvaluationSpec): void {
  const requireColumn = (column: string) => {
    if (!dataset.columns.includes(column))
      throw new Error('指定された列がデータセットにありません。');
  };
  if (
    !spec ||
    !spec.group ||
    !['category', 'numeric'].includes(spec.group.kind)
  )
    throw new Error('群分けの定義を確認してください。');
  requireColumn(spec.scoreColumn);
  requireColumn(spec.group.column);
  if (spec.conditionFilter?.column) requireColumn(spec.conditionFilter.column);
  if (spec.comparisonScoreColumn) requireColumn(spec.comparisonScoreColumn);
  if (spec.list?.idColumn) requireColumn(spec.list.idColumn);
  if (
    spec.list?.queryMode !== undefined &&
    spec.list.queryMode !== 'partial' &&
    spec.list.queryMode !== 'exact'
  )
    throw new Error('サンプル検索の一致方法を確認してください。');
  const sort = spec.list?.sort;
  if (sort) {
    if (
      typeof sort.column !== 'string' ||
      typeof sort.desc !== 'boolean' ||
      (sort.source !== undefined && sort.source !== 'row') ||
      (sort.kind !== undefined &&
        !['number', 'text', 'alphanumeric'].includes(sort.kind))
    )
      throw new Error('一覧の並び順の指定を確認してください。');
    if (
      sort.source === 'row' ||
      !['__score', '__group', '__sample'].includes(sort.column)
    )
      requireColumn(sort.column);
  }
  if (spec.okGroup !== 'A' && spec.okGroup !== 'B')
    throw new Error('基準OK群はAまたはBで指定してください。');
  if (spec.direction !== 'high' && spec.direction !== 'low')
    throw new Error('スコアの方向を指定してください。');
  if (
    spec.ignoredIndices?.some(
      (index) =>
        !Number.isInteger(index) || index < 0 || index >= dataset.rows.length,
    )
  )
    throw new Error('除外するサンプルが現在のデータセットにありません。');
  const range = spec.list?.range;
  if (
    range &&
    (!Number.isFinite(range.lo) ||
      !Number.isFinite(range.hi) ||
      range.lo > range.hi ||
      typeof range.includeHi !== 'boolean')
  )
    throw new Error('一覧の範囲は下限 ≤ 上限となる有限値で指定してください。');
  if (
    spec.threshold &&
    spec.threshold.kind !== 'ok-rate' &&
    spec.threshold.kind !== 'manual'
  )
    throw new Error('しきい値の指定方法を確認してください。');
  if (
    spec.threshold?.kind === 'manual' &&
    spec.threshold.rule.direction !== spec.direction
  )
    throw new Error('しきい値と評価のスコア方向が一致していません。');
}

function populationCounts(
  partition: ReturnType<typeof partitionRows>,
): PopulationCounts {
  const { samples: _samples, memberRows: _memberRows, ...counts } = partition;
  return counts;
}

function compact(samples: readonly Sample[]): EvaluatedSample[] {
  return samples.map(({ index, score, group }) => ({ index, score, group }));
}

function compactPartition(
  dataset: Dataset,
  partition: ReturnType<typeof partitionRows>,
  ignored: ReadonlySet<number>,
): EvaluationPartition {
  const members = new Set(partition.memberRows);
  const memberIndices: number[] = [];
  dataset.rows.forEach((row, index) => {
    if (!ignored.has(index) && members.has(row)) memberIndices.push(index);
  });
  return {
    ...populationCounts(partition),
    samples: compact(partition.samples),
    memberIndices,
  };
}

/** One calculation boundary for charts, PR, calibration, coverage and inspection. */
export function evaluateDataset(
  dataset: Dataset,
  spec: EvaluationSpec,
): EvaluationResult {
  validateSpec(dataset, spec);
  const ignored = new Set(spec.ignoredIndices ?? []);
  const base = partitionRows(
    dataset.rows,
    spec.scoreColumn,
    spec.group,
    spec.conditionFilter,
  );
  const retained = ignored.size
    ? partitionRows(
        dataset.rows,
        spec.scoreColumn,
        spec.group,
        spec.conditionFilter,
        ignored,
      )
    : base;
  const a: number[] = [],
    b: number[] = [];
  for (const sample of retained.samples)
    (sample.group === 'A' ? a : b).push(sample.score);
  const distribution = histogram(a, b, spec.bins ?? 24);
  const displayDistribution = spec.histogramDomain
    ? histogram(a, b, spec.bins ?? 24, spec.histogramDomain)
    : distribution;
  const positiveGroup: 'A' | 'B' = spec.okGroup === 'A' ? 'B' : 'A';
  const referenceScores = spec.okGroup === 'A' ? a : b;
  const positiveScores = spec.okGroup === 'A' ? b : a;
  const evaluation = {
    ...precisionRecall(positiveScores, referenceScores, spec.direction),
    positiveGroup,
    negativeGroup: spec.okGroup,
    direction: spec.direction,
  };
  const baselineSummary = summarizeReviewComparison(
    base.samples,
    spec.okGroup,
    spec.direction,
  );
  const summary = Object.freeze({
    nA: a.length,
    nB: b.length,
    total: a.length + b.length,
    prAuc: evaluation.auc,
    positiveFraction: evaluation.positiveFraction,
    okGroup: spec.okGroup,
    positiveGroup,
    scoreDirection: spec.direction,
  });
  let thresholdReport: EvaluationThresholdReport | null = null;
  if (spec.threshold) {
    const calibration =
      spec.threshold.kind === 'ok-rate'
        ? calibrateOkRate(
            referenceScores,
            spec.threshold.targetPercent,
            spec.direction,
          )
        : manualThreshold(referenceScores, spec.threshold.rule);
    thresholdReport = {
      calibration,
      okGroup: spec.okGroup,
      scope:
        'All finite, non-ignored scores in the current comparison cohorts and condition filter; independent of inspection range, search, decision filter, comparison score and histogram bins. In-sample exploratory calibration, not a population guarantee.',
      groupA: summarizeThreshold(a, calibration.rule),
      groupB: summarizeThreshold(b, calibration.rule),
    };
  }
  const reference = thresholdReport
    ? { okGroup: spec.okGroup, rule: thresholdReport.calibration.rule }
    : null;
  const list = spec.list ?? {};
  const commonBins = distribution.bins.filter(
    (bin) => bin.countA > 0 && bin.countB > 0,
  );
  const inRange = (sample: Sample) =>
    !list.range || scoreInRange(sample.score, list.range);
  const inOverlap = (sample: Sample) =>
    !list.overlapOnly ||
    commonBins.some((bin) =>
      scoreInRange(sample.score, {
        lo: bin.lo,
        hi: bin.hi,
        includeHi: bin.hi === distribution.max,
      }),
    );
  const query = (list.query ?? '').toLowerCase();
  const queryMode = list.queryMode ?? 'partial';
  const matchesSearch = (sample: Sample) =>
    !query ||
    (() => {
      const label = (
        list.idColumn ? sample.row[list.idColumn] : `row-${sample.index + 1}`
      ).toLowerCase();
      return queryMode === 'exact' ? label === query : label.includes(query);
    })();
  // Excluded recordings remain restorable even when no longer in an overlap bin.
  const beforeDecision = base.samples.filter(
    (sample) =>
      inRange(sample) &&
      (ignored.has(sample.index) || inOverlap(sample)) &&
      matchesSearch(sample),
  );
  const filter = list.decisionFilter ?? 'all';
  const listing = buildReviewListing(
    beforeDecision,
    ignored,
    filter,
    reference,
  );
  const scope = candidateScope(
    retained.samples,
    filter,
    reference,
    (sample) => inRange(sample) && inOverlap(sample),
    matchesSearch,
  );
  const sorted = sortReviewSamples(listing.listed, list.sort, list.idColumn);
  return {
    baseline: compactPartition(dataset, base, new Set()),
    comparison: compactPartition(dataset, retained, ignored),
    distribution,
    displayDistribution,
    viewport: {
      central: centralScoreExtent(a, b),
      outside: spec.histogramDomain
        ? outsideScoreExtent(a, b, spec.histogramDomain)
        : null,
    },
    a,
    b,
    evaluation,
    baselineSummary,
    summary,
    thresholdReport,
    scoreCoverage: spec.comparisonScoreColumn
      ? scoreCoverage(
          retained.memberRows,
          spec.scoreColumn,
          spec.comparisonScoreColumn,
        )
      : null,
    listing: {
      includedIndices: sorted
        .filter((sample) => !ignored.has(sample.index))
        .map((sample) => sample.index),
      listedIndices: sorted.map((sample) => sample.index),
      ignoredIndices: sorted
        .filter((sample) => ignored.has(sample.index))
        .map((sample) => sample.index),
      counts: listing.counts,
      candidateScope: scope,
    },
  };
}
