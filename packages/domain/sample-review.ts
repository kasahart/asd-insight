import { datasetRows } from './dataset-rows.ts';
import type { Sample } from './data.ts';
import type { Dataset } from './demo.ts';
import type { FilterSpec, GroupSpec } from './data.ts';
import { finiteNumber } from './distribution.ts';
import { isDetected, type ThresholdRule } from './threshold.ts';

export type ReviewFilter =
  | 'all'
  | 'false-positive'
  | 'ok-group-ok'
  | 'opposite-group-ng'
  | 'false-negative'
  | 'ignored';

export type ClassificationFilter = Exclude<ReviewFilter, 'all' | 'ignored'>;

export type ReviewReference = {
  okGroup: 'A' | 'B';
  rule: ThresholdRule;
};

export type ReviewCounts = {
  all: number;
  falsePositive: number | null;
  falseNegative: number | null;
  matrix: {
    okGroupNg: number;
    okGroupOk: number;
    oppositeGroupNg: number;
    oppositeGroupOk: number;
  } | null;
};

export type ReviewListing = {
  included: Sample[];
  listed: Sample[];
  ignored: Sample[];
  counts: ReviewCounts;
};

export type CandidateScope = {
  total: number;
  inRange: number;
  current: number;
  recovery: 'range' | 'search' | 'both' | null;
};

/** Preserve saved legacy scopes unless a folder-derived membership is active. */
export function evaluationPopulationKey(
  baseParts: readonly unknown[],
  derivedPopulation: string,
): string {
  return JSON.stringify(
    derivedPopulation ? [...baseParts, derivedPopulation] : baseParts,
  );
}

/** Stored JSON may reorder object keys without changing an evaluation population.
 * Compare scopes structurally while retaining the existing persisted scope format.
 * Array order and every value (including dataset/folder signatures) still matter.
 */
export function evaluationPopulationScopesMatch(
  saved: string,
  current: string,
): boolean {
  if (saved === current) return true;
  const normalized = (scope: string) =>
    JSON.stringify(JSON.parse(scope), (_key, value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, value[key]]),
          )
        : value,
    );
  try {
    return normalized(saved) === normalized(current);
  } catch {
    return false;
  }
}

/**
 * Compactly tracks only whether derived grouping/filter values change the
 * active comparison population. Other audio or folder changes keep the same
 * threshold scope.
 */
export function derivedPopulationSignature(
  dataset: Dataset,
  group: GroupSpec,
  conditionFilter: FilterSpec | null,
  ignoredIndices: ReadonlySet<number>,
  derivedColumns: readonly string[],
): string {
  const derived = new Set(derivedColumns);
  if (
    !derived.has(group.column) &&
    !(conditionFilter && derived.has(conditionFilter.column))
  )
    return '';

  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  let included = 0;
  for (const [index, row] of datasetRows(dataset).entries()) {
    if (ignoredIndices.has(index)) continue;
    const matchesFilter =
      !conditionFilter ||
      row[conditionFilter.column]?.trim() === conditionFilter.value;
    let membership = 0;
    if (matchesFilter) {
      if (group.kind === 'category') {
        const value = row[group.column]?.trim() ?? '';
        membership =
          value === group.a ? 1 : value === group.b ? 2 : value ? 3 : 4;
      } else {
        const value = finiteNumber(row[group.column]);
        membership =
          value === null
            ? 4
            : value <= group.upperA
              ? 1
              : value >= group.lowerB
                ? 2
                : 3;
      }
    }
    const token = membership + ((index + 1) << 3);
    first = Math.imul(first ^ token, 0x01000193);
    second = Math.imul(second ^ (token + 0x7f4a7c15), 0x85ebca6b);
    included++;
  }
  return `${included}:${first >>> 0}:${second >>> 0}`;
}

/** Scope counts use the same retained comparison population as the threshold. */
export function candidateScope(
  samples: Sample[],
  filter: ReviewFilter,
  reference: ReviewReference | null,
  inRange: (sample: Sample) => boolean,
  matchesSearch: (sample: Sample) => boolean,
): CandidateScope | null {
  if (
    !reference ||
    !isClassificationFilter(filter)
  )
    return null;
  const candidates = filterReviewSamples(samples, filter, reference);
  const ranged = candidates.filter(inRange);
  const current = ranged.filter(matchesSearch).length;
  const withoutRange = candidates.filter(matchesSearch).length;
  return {
    total: candidates.length,
    inRange: ranged.length,
    current,
    recovery:
      current > 0 || candidates.length === 0
        ? null
        : withoutRange > 0
          ? 'range'
          : ranged.length > 0
            ? 'search'
            : 'both',
  };
}

export function isClassificationFilter(
  filter: ReviewFilter,
): filter is ClassificationFilter {
  return (
    filter === 'false-positive' ||
    filter === 'ok-group-ok' ||
    filter === 'opposite-group-ng' ||
    filter === 'false-negative'
  );
}

function validateReference(reference: ReviewReference): void {
  if (reference.okGroup !== 'A' && reference.okGroup !== 'B') {
    throw new Error('基準OK群はAまたはBで指定してください。');
  }
}

function candidateKind(
  sample: Sample,
  reference: ReviewReference,
): ClassificationFilter | null {
  // A missing score belongs to no threshold classification cell.
  if (!Number.isFinite(sample.score)) return null;
  const detected = isDetected(sample.score, reference.rule);
  if (sample.group === reference.okGroup)
    return detected ? 'false-positive' : 'ok-group-ok';
  const otherGroup = reference.okGroup === 'A' ? 'B' : 'A';
  if (sample.group === otherGroup)
    return detected ? 'opposite-group-ng' : 'false-negative';
  return null;
}

/** Candidates are disagreements with the chosen reference, not verified errors. */
export function filterReviewSamples(
  samples: Sample[],
  filter: ReviewFilter,
  reference: ReviewReference | null,
): Sample[] {
  if (
    filter !== 'all' &&
    filter !== 'false-positive' &&
    filter !== 'ok-group-ok' &&
    filter !== 'opposite-group-ng' &&
    filter !== 'false-negative' &&
    filter !== 'ignored'
  ) {
    throw new Error('サンプルの確認フィルタが不正です。');
  }
  if (filter === 'all') return samples.slice();
  // Ignored-only listings contain no retained/exportable rows. Their ignored
  // members are supplied separately by buildReviewListing, without a threshold.
  if (filter === 'ignored') return [];
  if (reference === null) return [];
  validateReference(reference);
  return samples.filter(
    (sample) => candidateKind(sample, reference) === filter,
  );
}

/** `all` counts the supplied list; non-finite scores never count as candidates. */
export function reviewCounts(
  samples: Sample[],
  reference: ReviewReference | null,
): ReviewCounts {
  if (reference === null) {
    return {
      all: samples.length,
      falsePositive: null,
      falseNegative: null,
      matrix: null,
    };
  }
  validateReference(reference);
  const matrix = {
    okGroupNg: 0,
    okGroupOk: 0,
    oppositeGroupNg: 0,
    oppositeGroupOk: 0,
  };
  for (const sample of samples) {
    const kind = candidateKind(sample, reference);
    if (kind === 'false-positive') matrix.okGroupNg++;
    else if (kind === 'ok-group-ok') matrix.okGroupOk++;
    else if (kind === 'opposite-group-ng') matrix.oppositeGroupNg++;
    else if (kind === 'false-negative') matrix.oppositeGroupOk++;
  }
  return {
    all: samples.length,
    falsePositive: matrix.okGroupNg,
    falseNegative: matrix.oppositeGroupOk,
    matrix,
  };
}

/**
 * Keep ignored rows visible for restoration without counting them as candidates.
 * Input is the finite, pre-exclusion list already scoped by comparison, range and
 * search. Global metrics must still use their separate, full comparison scope.
 */
export function buildReviewListing(
  samples: Sample[],
  ignored: ReadonlySet<number>,
  filter: ReviewFilter,
  reference: ReviewReference | null,
): ReviewListing {
  const retained: Sample[] = [];
  const ignoredSamples: Sample[] = [];
  for (const sample of samples) {
    if (ignored.has(sample.index)) ignoredSamples.push(sample);
    else retained.push(sample);
  }
  const included = filterReviewSamples(retained, filter, reference);
  const includedIndices = new Set(included.map((sample) => sample.index));
  const listed = samples.filter(
    (sample) => ignored.has(sample.index) || includedIndices.has(sample.index),
  );
  return {
    included,
    listed,
    ignored: ignoredSamples,
    counts: reviewCounts(retained, reference),
  };
}
