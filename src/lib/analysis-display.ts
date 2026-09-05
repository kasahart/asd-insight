import type { ScoreRange } from '@/lib/distribution';
import { formatNumber, formatScore } from '@/lib/distribution';
import type { GroupSpec } from '@/lib/data';
import type { ThresholdReport } from '@/components/threshold-context';
import type { ThresholdRule } from '@domain/threshold';

const operators: Record<ThresholdRule['operator'], string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
};

export function formatGroupSpec(group: GroupSpec): string {
  if (group.kind === 'numeric') {
    return `${group.column || '列未設定'}：群A ≤ ${formatScore(
      group.upperA,
      6,
    )} / 群B ≥ ${formatScore(group.lowerB, 6)}`;
  }
  return `${group.column || '列未設定'}：群A「${group.a || '未設定'}」 / 群B「${
    group.b || '未設定'
  }」`;
}

export function formatEvaluationCondition({
  scoreColumn,
  group,
  okGroup,
  scoreDirection,
  filter,
}: {
  scoreColumn: string;
  group: GroupSpec;
  okGroup: 'A' | 'B';
  scoreDirection: 'high' | 'low';
  filter: { column: string; value: string } | null;
}): string {
  const population = filter
    ? ` · 集計条件：${filter.column} = ${filter.value}`
    : ' · 集計条件：すべて';
  return `スコア「${scoreColumn || '未設定'}」 · ${formatGroupSpec(
    group,
  )} · OK基準：群${okGroup} · NG候補：${
    scoreDirection === 'high' ? '高い' : '低い'
  }スコア側${population}`;
}

export function formatThresholdCondition(
  threshold: ThresholdReport | null,
): string {
  if (!threshold) return '仮しきい値は未設定';
  const { calibration } = threshold;
  const { rule } = calibration;
  const setup =
    calibration.method === 'ok-rate'
      ? `率から設定・指定上限 ${formatNumber(calibration.targetPercent, 3)}%`
      : '手動調整・率の上限なし';
  const actual = `${calibration.detectedCount.toLocaleString()} / ${calibration.referenceCount.toLocaleString()}件（${formatNumber(calibration.actualPercent, 3)}%）`;
  const direction = rule.direction === 'high' ? '高い' : '低い';
  return `OK基準：群${threshold.okGroup} · ${setup} · OK基準群のNG候補：${actual} · NG候補：スコア ${operators[rule.operator]} ${formatScore(rule.threshold, 6)}（${direction}スコア側）`;
}

function formatRange(range: ScoreRange | null): string {
  if (!range) return '全スコア';
  return `${formatScore(range.lo, 6)} ≤ スコア ${
    range.includeHi ? '≤' : '<'
  } ${formatScore(range.hi, 6)}`;
}

function formatDecisionFilter(
  decisionFilter: string,
  excludedOnly: boolean,
): string {
  if (excludedOnly || decisionFilter === 'ignored') return '手動除外のみ';
  if (decisionFilter === 'false-positive') return 'OK基準群のNG候補';
  if (decisionFilter === 'false-negative') return '反対群のOK候補';
  return 'すべて';
}

export function formatInspectionConditions({
  range,
  overlapBinsOnly,
  query,
  queryMode,
  decisionFilter,
  excludedOnly,
}: {
  range: ScoreRange | null;
  overlapBinsOnly: boolean;
  query: string;
  queryMode: 'partial' | 'exact';
  decisionFilter: string;
  excludedOnly: boolean;
}): string {
  const search = query
    ? `名前「${query}」・${queryMode === 'exact' ? '完全一致' : '部分一致'}（英字の大小は区別しない）`
    : '名前検索なし';
  const rangeText = overlapBinsOnly
    ? `${formatRange(range)} · 共通範囲のみ`
    : formatRange(range);
  return `一覧フィルター：${formatDecisionFilter(
    decisionFilter,
    excludedOnly,
  )} · ${search} · 表示範囲 ${rangeText}`;
}

export function formatReviewHistoryEntry(entry: {
  sampleId: string | undefined;
  reason: string;
  action: 'ignore' | 'restore';
  at: string;
}): string {
  const action = entry.action === 'ignore' ? '除外' : '復元';
  const at = new Date(entry.at).toLocaleString('ja-JP');
  return `${entry.sampleId || '行番号未設定'} · ${action} · ${entry.reason} · ${at}`;
}

export function formatAnalysisMethod(): string {
  return 'PR-AUCをPR曲線の点を直線で結ぶ台形積分で算定します。Average Precision（AP）とは別の定義です。';
}
