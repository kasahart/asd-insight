import type { Dataset } from '../domain/demo.ts';
import type { FilterSpec, GroupSpec, Profile, Sample } from '../domain/data.ts';
import type { Distribution, ScoreRange } from '../domain/distribution.ts';
import type { PrecisionRecallResult } from '../domain/precision-recall.ts';
import type { ReviewSummary } from '../domain/review-audit.ts';
import type {
  CandidateScope,
  ReviewCounts,
  ReviewFilter,
} from '../domain/sample-review.ts';
import type { ScoreCoverage } from '../domain/score-coverage.ts';
import type {
  ScoreDirection,
  ThresholdCalibration,
  ThresholdRule,
  ThresholdSummary,
} from '../domain/threshold.ts';
import type { CSVColumnCountDiagnostic } from '../domain/csv-diagnostics.ts';
import type { ScoreExtent } from '../domain/distribution-viewport.ts';

/** No rows cross back from evaluation: the UI already owns the immutable dataset. */
export type EvaluatedSample = Pick<Sample, 'index' | 'score' | 'group'>;

export type PopulationCounts = {
  outsideFilter: number;
  missingGroup: number;
  otherGroup: number;
  missingA: number;
  missingB: number;
  membersA: number;
  membersB: number;
  ignoredRows: number;
};

export type EvaluationPartition = PopulationCounts & {
  samples: EvaluatedSample[];
  /** Cohort membership before score missingness, for common-score coverage. */
  memberIndices: number[];
};

export type ThresholdSelection =
  | { kind: 'ok-rate'; targetPercent: number }
  | { kind: 'manual'; rule: ThresholdRule };

/** How an inspection query is matched against the sample identifier. */
export type QueryMode = 'partial' | 'exact';

export type EvaluationThresholdReport = {
  calibration: ThresholdCalibration;
  okGroup: 'A' | 'B';
  scope: string;
  groupA: ThresholdSummary;
  groupB: ThresholdSummary;
};

export type PrecisionRecallEvaluation = PrecisionRecallResult & {
  positiveGroup: 'A' | 'B';
  negativeGroup: 'A' | 'B';
  direction: ScoreDirection;
};

export type EvaluationListSpec = {
  range?: ScoreRange | null;
  query?: string;
  /** Older bundles omit this field and retain the original partial match. */
  queryMode?: QueryMode;
  idColumn?: string;
  decisionFilter?: ReviewFilter;
  overlapOnly?: boolean;
  sort?: EvaluationListSort;
};

export type EvaluationListSort = {
  /** Built-in __score, __group, __sample, or an original dataset column name. */
  column: string;
  desc: boolean;
  /** Explicit row source allows real CSV headers to equal a built-in name. */
  source?: 'row';
  kind?: 'number' | 'text' | 'alphanumeric';
};

export type EvaluationSpec = {
  scoreColumn: string;
  group: GroupSpec;
  conditionFilter?: FilterSpec | null;
  ignoredIndices?: readonly number[];
  okGroup: 'A' | 'B';
  direction: ScoreDirection;
  bins?: number;
  /** Display-only crop; never changes population, PR, calibration or overlap filtering. */
  histogramDomain?: { min: number; max: number } | null;
  threshold?: ThresholdSelection | null;
  list?: EvaluationListSpec;
  comparisonScoreColumn?: string;
};

export type EvaluationInput = EvaluationSpec & { dataset: Dataset };

export type EvaluationResult = {
  baseline: EvaluationPartition;
  comparison: EvaluationPartition;
  /** Full population histogram, used by metrics and overlap-only list filtering. */
  distribution: Distribution;
  /** Optional display crop; percentages retain the full population denominators. */
  displayDistribution: Distribution;
  viewport: {
    central: ScoreExtent | null;
    outside: {
      belowA: number;
      aboveA: number;
      belowB: number;
      aboveB: number;
    } | null;
  };
  a: number[];
  b: number[];
  evaluation: PrecisionRecallEvaluation;
  baselineSummary: ReviewSummary;
  summary: ReviewSummary;
  thresholdReport: EvaluationThresholdReport | null;
  scoreCoverage: ScoreCoverage | null;
  listing: {
    includedIndices: number[];
    listedIndices: number[];
    ignoredIndices: number[];
    counts: ReviewCounts;
    candidateScope: CandidateScope | null;
  };
};

export type PreparedDataset = { dataset: Dataset; profiles: Profile[] };

export type EvaluationCommand =
  | { kind: 'parse-csv'; text: string; name: string }
  | { kind: 'profile'; datasetKey: string; dataset?: Dataset }
  | {
      kind: 'evaluate';
      datasetKey: string;
      dataset?: Dataset;
      spec: EvaluationSpec;
    };

export type EvaluationRequest = {
  workerGeneration: number;
  requestId: number;
  command: EvaluationCommand;
};

export type EvaluationFailure = {
  code:
    | 'invalid-input'
    | 'csv-column-count'
    | 'dataset-unavailable'
    | 'internal';
  message: string;
  diagnostic?: CSVColumnCountDiagnostic;
};

export type EvaluationResponse = {
  workerGeneration: number;
  requestId: number;
  elapsedMs: number;
} & (
  | { ok: true; kind: 'parse-csv'; result: PreparedDataset }
  | { ok: true; kind: 'profile'; result: Profile[] }
  | { ok: true; kind: 'evaluate'; result: EvaluationResult }
  | { ok: false; error: EvaluationFailure }
);
