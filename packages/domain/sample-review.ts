import type { Sample } from './data.ts';
import { isDetected, type ThresholdRule } from './threshold.ts';

export type ReviewFilter =
  | 'all'
  | 'false-positive'
  | 'false-negative'
  | 'ignored';

export type ReviewReference = {
  okGroup: 'A' | 'B';
  rule: ThresholdRule;
};

export type ReviewCounts = {
  all: number;
  falsePositive: number | null;
  falseNegative: number | null;
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
    (filter !== 'false-positive' && filter !== 'false-negative')
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

function validateReference(reference: ReviewReference): void {
  if (reference.okGroup !== 'A' && reference.okGroup !== 'B') {
    throw new Error('基準OK群はAまたはBで指定してください。');
  }
}

function candidateKind(
  sample: Sample,
  reference: ReviewReference,
): Exclude<ReviewFilter, 'all' | 'ignored'> | null {
  // A missing score is neither a false positive nor a false negative.
  if (!Number.isFinite(sample.score)) return null;
  const detected = isDetected(sample.score, reference.rule);
  if (sample.group === reference.okGroup && detected) return 'false-positive';
  const otherGroup = reference.okGroup === 'A' ? 'B' : 'A';
  if (sample.group === otherGroup && !detected) return 'false-negative';
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
    return { all: samples.length, falsePositive: null, falseNegative: null };
  }
  validateReference(reference);
  let falsePositive = 0;
  let falseNegative = 0;
  for (const sample of samples) {
    const kind = candidateKind(sample, reference);
    if (kind === 'false-positive') falsePositive++;
    else if (kind === 'false-negative') falseNegative++;
  }
  return { all: samples.length, falsePositive, falseNegative };
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
