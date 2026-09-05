import { createContext, useContext, type ReactNode } from 'react';
import type { ScoreDirection } from '@/lib/threshold';
import type {
  EvaluationThresholdReport,
  PrecisionRecallEvaluation as PREvaluation,
  ThresholdSelection,
} from '@contracts/evaluation';
import type { ThresholdRule } from '@domain/threshold';
export type ThresholdReport = EvaluationThresholdReport;
export type PrecisionRecallEvaluation = PREvaluation;
export type ThresholdContextValue = {
  okGroup: 'A'|'B'; direction: ScoreDirection; targetPercent: string;
  okGroupLabel?: string; otherGroupLabel?: string;
  setOkGroup: (group: 'A'|'B') => void; setDirection: (direction: ScoreDirection) => void; setTargetPercent: (percent: string) => void;
  evaluation: PrecisionRecallEvaluation; report: ThresholdReport | null; pending: boolean;
  /** The current selection stays available while its evaluation is pending. */
  selection: ThresholdSelection | null;
  /** The operation value is UI state, never a pending evaluation result. */
  operationRule: ThresholdRule | null;
  applyFromInput: () => void; applyManualThreshold: (value: number) => void; clear: () => void;
};
const ThresholdContext = createContext<ThresholdContextValue | null>(null);
export function ThresholdScope({value, children}: {value: ThresholdContextValue;children: ReactNode}) { return <ThresholdContext.Provider value={value}>{children}</ThresholdContext.Provider>; }
export function useThreshold() { const value = useContext(ThresholdContext); if (!value) throw new Error('しきい値の設定領域がありません。'); return value; }
