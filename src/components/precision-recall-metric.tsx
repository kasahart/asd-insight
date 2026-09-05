'use client';
import { Info } from 'lucide-react';
import { useThreshold } from '@/components/threshold-context';
import { formatNumber } from '@/lib/distribution';

export function PrecisionRecallMetric({
  labelA,
  labelB,
  onExplain,
}: {
  labelA: string;
  labelB: string;
  onExplain: () => void;
}) {
  const { evaluation } = useThreshold();
  const { auc, positiveFraction } = evaluation;
  return (
    <div className="metric primary-metric pr-metric">
      <span>
        PR-AUC
        <button
          className="metric-info"
          onClick={onExplain}
          aria-label="PR-AUCの意味と注意点"
          title="PR-AUCの意味と注意点"
        >
          <Info size={13} />
        </button>
      </span>
      {auc === null ? (
        <strong className="null-value">算出不可</strong>
      ) : (
        <strong title={String(auc)}>{auc.toFixed(3)}</strong>
      )}
      <p
        className="pr-metric-context"
        title={`陽性：群${evaluation.positiveGroup}（${evaluation.positiveGroup === 'A' ? labelA : labelB}）`}
      >
        陽性：群{evaluation.positiveGroup} · 構成{' '}
        {positiveFraction === null
          ? '—'
          : `${formatNumber(positiveFraction * 100, 2)}%`}
        {' · '}
        {evaluation.direction === 'high' ? '高' : '低'}スコア側
      </p>
      {auc === null && <p>両群に有効スコアが必要です。</p>}
      {evaluation.distinctScores === 1 && auc !== null && (
        <p className="pr-metric-warning">
          全スコア同点：順位による識別はできません。
        </p>
      )}
    </div>
  );
}

export function PrecisionRecallExplanation() {
  return (
    <>
      <h3>PR曲線のAUC（PR-AUC・台形積分）</h3>
      <code>Precision = TP / (TP + FP)　Recall = TP / (TP + FN)</code>
      <p>
        OK基準群を陰性、その反対群を陽性とみなします。しきい値を全スコアの境界で動かし、適合率（検出した中で陽性の割合）と再現率（陽性のうち検出した割合）の関係を求めます。現在の仮しきい値1点での率ではありません。
      </p>
      <p>
        値は0〜1で、同じ評価対象・陽性定義では大きいほど良い順位付けを表します。
      </p>
      <code>PR-AUC = Σ (Rᵢ − Rᵢ₋₁) × (Pᵢ + Pᵢ₋₁) / 2</code>
      <p>
        同点は一括で扱い、再現率0・適合率1の端点を加えて台形積分します。Average
        Precision（AP）とは別の定義です。点を直線で結ぶため、同点や少数標本では値が楽観的になる場合があります。全スコアが同点でも0にはなりません。
      </p>
      <p>
        手動除外後の両群の全有効スコアから計算し、片方が空なら算出不可です。欠測・非数値は除外します。ビン数・試聴範囲・名前検索・候補フィルタ・比較スコア・仮しきい値の目標率を変えても値は変わりません。OK基準群とスコアの方向は仮しきい値の設定と共有します。
      </p>
      <p>
        陽性率（群の件数比）に影響されるため、異なる群構成の値をそのまま比較できません。公開データの陽性率は実際の工程の不良率ではありません。群の基準が不確かなら、その基準に対する評価です。PR-AUC自体は過剰検出率・見逃し率ではなく、未知データの性能や原因を保証しません。スコアから派生した列による群分けにも注意してください。
      </p>
      <p>
        参考：{' '}
        <a
          href="https://scikit-learn.org/stable/modules/generated/sklearn.metrics.precision_recall_curve.html"
          target="_blank"
          rel="noreferrer"
        >
          PR曲線の定義
        </a>
        {' / '}
        <a
          href="https://scikit-learn.org/stable/modules/generated/sklearn.metrics.auc.html"
          target="_blank"
          rel="noreferrer"
        >
          台形積分
        </a>
        {' / '}
        <a
          href="https://scikit-learn.org/stable/modules/generated/sklearn.metrics.average_precision_score.html"
          target="_blank"
          rel="noreferrer"
        >
          APとの違い
        </a>
      </p>
    </>
  );
}
