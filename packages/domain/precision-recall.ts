export type PrecisionRecallDirection = 'high' | 'low';

export type PrecisionRecallPoint = {
  recall: number;
  precision: number;
  threshold: number | null;
  tp: number;
  fp: number;
};

export type PrecisionRecallResult = {
  auc: number | null;
  positiveCount: number;
  negativeCount: number;
  positiveFraction: number | null;
  distinctScores: number;
  points: PrecisionRecallPoint[];
};

/**
 * Trapezoidal PR-AUC, matching precision_recall_curve + auc rather than AP.
 * Points run from no detections to all detections, adding equal scores together.
 * Non-finite values are excluded. Both reference groups are required for a curve.
 */
export function precisionRecall(
  positive: number[],
  negative: number[],
  direction: PrecisionRecallDirection,
): PrecisionRecallResult {
  if (direction !== 'high' && direction !== 'low') {
    throw new Error(
      'PR曲線のスコア方向は high または low で指定してください。',
    );
  }
  const positiveScores = positive.filter(Number.isFinite);
  const negativeScores = negative.filter(Number.isFinite);
  const positiveCount = positiveScores.length;
  const negativeCount = negativeScores.length;
  const total = positiveCount + negativeCount;
  const frequencies = new Map<number, { positive: number; negative: number }>();
  function addScores(scores: number[], isPositive: boolean): void {
    for (const score of scores) {
      const counts = frequencies.get(score) ?? { positive: 0, negative: 0 };
      if (isPositive) counts.positive++;
      else counts.negative++;
      frequencies.set(score, counts);
    }
  }
  addScores(positiveScores, true);
  addScores(negativeScores, false);
  const counts = {
    positiveCount,
    negativeCount,
    positiveFraction: total ? positiveCount / total : null,
    distinctScores: frequencies.size,
  };
  if (!positiveCount || !negativeCount) {
    return { ...counts, auc: null, points: [] };
  }

  // Compare values directly: subtracting extreme finite scores can overflow.
  const ordered = [...frequencies.entries()].sort(([a], [b]) => {
    if (a === b) return 0;
    return direction === 'high' ? (a > b ? -1 : 1) : a < b ? -1 : 1;
  });
  const points: PrecisionRecallPoint[] = [
    { recall: 0, precision: 1, threshold: null, tp: 0, fp: 0 },
  ];
  let tp = 0;
  let fp = 0;
  let auc = 0;
  for (const [threshold, frequency] of ordered) {
    tp += frequency.positive;
    fp += frequency.negative;
    const point: PrecisionRecallPoint = {
      recall: tp / positiveCount,
      precision: tp / (tp + fp),
      threshold,
      tp,
      fp,
    };
    const previous = points[points.length - 1];
    auc +=
      ((point.recall - previous.recall) *
        (point.precision + previous.precision)) /
      2;
    points.push(point);
  }
  // Only bound accumulation round-off; scores and curve points are unrounded.
  return { ...counts, auc: Math.min(1, Math.max(0, auc)), points };
}
