import type { FilterSpec, GroupSpec, Sample } from './data.ts';
import { precisionRecall } from './precision-recall.ts';
import type {
  ScoreDirection,
  ThresholdCalibration,
  ThresholdRule,
} from './threshold.ts';

export type ReviewSummary = Readonly<{
  nA: number;
  nB: number;
  total: number;
  prAuc: number | null;
  positiveFraction: number | null;
  okGroup: 'A' | 'B';
  positiveGroup: 'A' | 'B';
  scoreDirection: ScoreDirection;
}>;

type CalibrationSnapshot = Readonly<
  Omit<ThresholdCalibration, 'rule'> & { rule: Readonly<ThresholdRule> }
>;

export type ReviewDecision = Readonly<{
  scoreColumn: string;
  group: Readonly<GroupSpec>;
  filter: Readonly<FilterSpec> | null;
  okGroup: 'A' | 'B';
  scoreDirection: ScoreDirection;
  threshold: CalibrationSnapshot | null;
  before: ReviewSummary;
}>;

export type ReviewDecisionContext = {
  scoreColumn: string;
  group: GroupSpec;
  filter: FilterSpec | null;
  okGroup: 'A' | 'B';
  scoreDirection: ScoreDirection;
  threshold: ThresholdCalibration | null;
};

export function normalizeReviewReason(reason: string): string {
  return reason.trim() || '理由未記入（原因未確定）';
}

/** Summarize the full comparison scope supplied by the caller, not its listing. */
export function summarizeReviewComparison(
  samples: readonly Sample[],
  okGroup: 'A' | 'B',
  direction: ScoreDirection,
): ReviewSummary {
  if (okGroup !== 'A' && okGroup !== 'B') {
    throw new Error('基準OK群はAまたはBで指定してください。');
  }
  const positiveGroup = okGroup === 'A' ? 'B' : 'A';
  const evaluation = precisionRecall(
    samples.filter((s) => s.group === positiveGroup).map((s) => s.score),
    samples.filter((s) => s.group === okGroup).map((s) => s.score),
    direction,
  );
  const nA =
    okGroup === 'A' ? evaluation.negativeCount : evaluation.positiveCount;
  const nB =
    okGroup === 'B' ? evaluation.negativeCount : evaluation.positiveCount;
  return Object.freeze({
    nA,
    nB,
    total: nA + nB,
    prAuc: evaluation.auc,
    positiveFraction: evaluation.positiveFraction,
    okGroup,
    positiveGroup,
    scoreDirection: direction,
  });
}

/**
 * Capture immediately before an ignore/restore operation or threshold reset.
 * Every nested settings object is copied and frozen, so later edits cannot
 * rewrite the evidence kept by an earlier review event.
 */
export function createReviewDecision(
  samples: readonly Sample[],
  context: ReviewDecisionContext,
): ReviewDecision {
  const calibration = context.threshold;
  return Object.freeze({
    scoreColumn: context.scoreColumn,
    group: Object.freeze({ ...context.group }),
    filter: context.filter ? Object.freeze({ ...context.filter }) : null,
    okGroup: context.okGroup,
    scoreDirection: context.scoreDirection,
    threshold: calibration
      ? Object.freeze({
          ...calibration,
          rule: Object.freeze({ ...calibration.rule }),
        })
      : null,
    before: summarizeReviewComparison(
      samples,
      context.okGroup,
      context.scoreDirection,
    ),
  });
}
