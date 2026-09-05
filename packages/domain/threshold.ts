export type ScoreDirection = 'high' | 'low';

export type ThresholdRule = {
  threshold: number;
  operator: 'gt' | 'gte' | 'lt' | 'lte';
  direction: ScoreDirection;
};

type ThresholdCalibrationBase = {
  rule: ThresholdRule;
  referenceCount: number;
  detectedCount: number;
  actualPercent: number;
};

export type RateThresholdCalibration = ThresholdCalibrationBase & {
  method: 'ok-rate';
  targetPercent: number;
};

export type ManualThresholdCalibration = ThresholdCalibrationBase & {
  method: 'manual';
  targetPercent: null;
};

export type ThresholdCalibration =
  | RateThresholdCalibration
  | ManualThresholdCalibration;

export type ThresholdSummary = {
  total: number;
  detected: number;
  notDetected: number;
  detectedPercent: number | null;
  notDetectedPercent: number | null;
};

function validateDirection(direction: ScoreDirection): void {
  if (direction !== 'high' && direction !== 'low') {
    throw new Error('スコアの方向は high または low で指定してください。');
  }
}

function validateRule(rule: ThresholdRule): void {
  if (!rule || !Number.isFinite(rule.threshold)) {
    throw new Error('しきい値には有限な数値を指定してください。');
  }
  validateDirection(rule.direction);
  const validOperator =
    rule.direction === 'high'
      ? rule.operator === 'gt' || rule.operator === 'gte'
      : rule.operator === 'lt' || rule.operator === 'lte';
  if (!validOperator) {
    throw new Error('比較演算子をスコアの方向に合わせて指定してください。');
  }
}

function detectFiniteScore(score: number, rule: ThresholdRule): boolean {
  switch (rule.operator) {
    case 'gt':
      return score > rule.threshold;
    case 'gte':
      return score >= rule.threshold;
    case 'lt':
      return score < rule.threshold;
    case 'lte':
      return score <= rule.threshold;
  }
}

// Interpret the target's decimal spelling without rounding a sample allowance.
// For example, 10_000 * 0.57 / 100 is 56.99999999999999 in floating point.
// An epsilon is unsafe here because it could admit a rate above the target.
function allowedCount(total: number, targetPercent: number): number {
  const [mantissa, exponent = '0'] = targetPercent.toString().split('e');
  const [integer, fraction = ''] = mantissa.split('.');
  const coefficient = BigInt(integer + fraction);
  const scale = fraction.length - Number(exponent);
  const factor = BigInt(10) ** BigInt(Math.abs(scale));
  const numerator =
    BigInt(total) * coefficient * (scale < 0 ? factor : BigInt(1));
  const denominator = BigInt(100) * (scale >= 0 ? factor : BigInt(1));
  return Number(numerator / denominator);
}

/**
 * Fit a descriptive rule from reference OK scores only. Ties stay together.
 * This controls the observed reference rate, not the rate on unseen data.
 */
export function calibrateOkRate(
  scores: number[],
  targetPercent: number,
  direction: ScoreDirection,
): RateThresholdCalibration {
  if (
    !Number.isFinite(targetPercent) ||
    targetPercent < 0 ||
    targetPercent > 100
  ) {
    throw new Error(
      'OKデータの目標NG候補率は0〜100%の有限な数値で指定してください。',
    );
  }
  validateDirection(direction);
  const reference = scores.filter(Number.isFinite);
  if (!reference.length) {
    throw new Error(
      'しきい値の仮設定には、有限なスコアを持つOKデータが1件以上必要です。',
    );
  }
  // Comparisons preserve even extreme finite values; subtraction may overflow.
  reference.sort((a, b) => {
    if (a === b) return 0;
    return direction === 'high' ? (a > b ? -1 : 1) : a < b ? -1 : 1;
  });
  const k = allowedCount(reference.length, targetPercent);
  const all = k === reference.length;
  const rule: ThresholdRule = {
    threshold: reference[all ? reference.length - 1 : k],
    operator: direction === 'high' ? (all ? 'gte' : 'gt') : all ? 'lte' : 'lt',
    direction,
  };
  const summary = summarizeThreshold(reference, rule);
  return {
    method: 'ok-rate',
    rule,
    targetPercent,
    referenceCount: summary.total,
    detectedCount: summary.detected,
    actualPercent: (summary.detected * 100) / summary.total,
  };
}

/**
 * Evaluate an explicitly chosen boundary against finite reference OK scores.
 * The boundary is neither fitted to these scores nor snapped to histogram bins.
 */
export function manualThreshold(
  scores: number[],
  rule: ThresholdRule,
): ManualThresholdCalibration {
  validateRule(rule);
  const savedRule = { ...rule };
  const summary = summarizeThreshold(scores, savedRule);
  if (!summary.total) {
    throw new Error(
      'しきい値の仮設定には、有限なスコアを持つOKデータが1件以上必要です。',
    );
  }
  return {
    method: 'manual',
    rule: savedRule,
    targetPercent: null,
    referenceCount: summary.total,
    detectedCount: summary.detected,
    actualPercent: (summary.detected * 100) / summary.total,
  };
}

/** Non-finite scores are not detections; this does not classify them as OK. */
export function isDetected(score: number, rule: ThresholdRule): boolean {
  validateRule(rule);
  return Number.isFinite(score) && detectFiniteScore(score, rule);
}

/** Missing/non-finite scores are excluded from both counts and denominators. */
export function summarizeThreshold(
  scores: number[],
  rule: ThresholdRule,
): ThresholdSummary {
  validateRule(rule);
  let total = 0;
  let detected = 0;
  for (const score of scores) {
    if (!Number.isFinite(score)) continue;
    total++;
    if (detectFiniteScore(score, rule)) detected++;
  }
  const notDetected = total - detected;
  return {
    total,
    detected,
    notDetected,
    detectedPercent: total ? (detected * 100) / total : null,
    notDetectedPercent: total ? (notDetected * 100) / total : null,
  };
}
