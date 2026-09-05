'use client';
import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DistributionSymbol } from '@/components/distribution-symbol';
import { PersistentDetails } from '@/components/view-preferences';
import { formatNumber, formatScore } from '@/lib/distribution';
import { isDetected, type ScoreDirection } from '@/lib/threshold';
import {
  useThreshold,
  type ThresholdReport,
  type PrecisionRecallEvaluation,
} from '@/components/threshold-context';

const operators = { gt: '>', gte: '≥', lt: '<', lte: '≤' };
function fraction(count: number, total: number, percent: number | null) {
  return total && percent !== null
    ? `${count.toLocaleString()} / ${total.toLocaleString()}件（${formatNumber(percent, 3)}%）`
    : '算出不可（有効スコア0件）';
}

export function ThresholdPanel({
  a,
  b,
  labelA,
  labelB,
  missingA,
  missingB,
  disabled,
}: {
  a: number[];
  b: number[];
  labelA: string;
  labelB: string;
  missingA: number;
  missingB: number;
  disabled: boolean;
}) {
  const {
    report,
    applyFromInput,
    clear,
    okGroup,
    direction,
    targetPercent,
    setTargetPercent,
    pending,
    selection,
    operationRule,
    okGroupLabel,
  } = useThreshold();
  const [failure, setFailure] = useState<{
    message: string;
    targetPercent: string;
    okGroup: 'A' | 'B';
    direction: ScoreDirection;
    reference: number[];
  } | null>(null);
  const reference = okGroup === 'A' ? a : b;
  const missing = okGroup === 'A' ? missingA : missingB;
  // Shared controls can fix the input or apply a threshold outside this panel.
  const error =
    failure &&
    !report &&
    failure.targetPercent === targetPercent &&
    failure.okGroup === okGroup &&
    failure.direction === direction &&
    failure.reference === reference
      ? failure.message
      : '';
  const reset = () => {
    clear();
    setFailure(null);
  };
  const submit = () => {
    try {
      applyFromInput();
      setFailure(null);
    } catch (e) {
      clear();
      setFailure({
        message: e instanceof Error ? e.message : 'しきい値を設定できません。',
        targetPercent,
        okGroup,
        direction,
        reference,
      });
    }
  };
  const ok = report
    ? report.okGroup === 'A'
      ? report.groupA
      : report.groupB
    : null;
  const other = report
    ? report.okGroup === 'A'
      ? report.groupB
      : report.groupA
    : null;
  const manual =
    report?.calibration.method === 'manual' || selection?.kind === 'manual';
  const activeRule = report?.calibration.rule ?? operationRule;
  const selectedLabel = okGroupLabel ?? (okGroup === 'A' ? labelA : labelB);
  return (
    <section className="threshold-panel" aria-labelledby="threshold-heading">
      <div className="threshold-heading">
        <h2 id="threshold-heading">OK群から仮設定</h2>
      </div>
      <div className="threshold-controls">
        <div className="threshold-rate-field">
          <label htmlFor="threshold-target">OK群のNG候補率上限（%）</label>
          <Input
            id="threshold-target"
            inputMode="decimal"
            value={targetPercent}
            onChange={(e) => {
              setTargetPercent(e.target.value);
              reset();
            }}
            aria-invalid={!!error}
            aria-describedby="threshold-rate-help"
          />
        </div>
        <div className="threshold-actions">
          <Button
            disabled={disabled || !reference.length}
            onClick={submit}
            aria-label={
              manual ? '率から仮しきい値を再設定' : '仮しきい値を設定'
            }
          >
            {manual ? '再設定' : '適用'}
          </Button>
        </div>
      </div>
      <p id="threshold-rate-help" className="threshold-help">
        OK基準：群{okGroup}（{selectedLabel}）・
        {pending
          ? '有効スコア件数は再計算中'
          : `${reference.length.toLocaleString()}件${
              missing > 0 ? `・欠測 ${missing.toLocaleString()}件` : ''
            }`}
      </p>
      {!pending && !reference.length && (
        <p className="threshold-warning">
          基準群の有効スコアがないため設定できません。
        </p>
      )}
      {error && (
        <p className="threshold-warning" role="alert">
          {error}
        </p>
      )}
      {pending ? (
        <div className="threshold-pending" aria-live="polite">
          <strong>再計算中：結果は未確定です。</strong>
          {activeRule && (
            <code>
              探索用の仮しきい値 {operators[activeRule.operator]}{' '}
              {formatScore(activeRule.threshold, 6)}
            </code>
          )}
          <span>
            {!selection
              ? '仮しきい値は未設定'
              : manual
                ? '手動調整・率の上限なし'
                : '率から設定・指定上限 ' + selection.targetPercent + '%'}{' '}
            · OK基準：群{okGroup}（{selectedLabel}）
          </span>
        </div>
      ) : report && ok && other ? (
        <div className="threshold-result" aria-live="polite">
          <div className="threshold-result-heading">
            <h3>仮しきい値による候補分類</h3>
            <span>{manual ? '手動調整' : '率から設定'}</span>
            <Button variant="ghost" onClick={reset} aria-label="しきい値を解除">
              解除
            </Button>
          </div>
          <div className="threshold-rule">
            <DistributionSymbol kind="threshold" size={18} />
            <code>
              スコア {operators[report.calibration.rule.operator]}{' '}
              {formatScore(report.calibration.rule.threshold, 6)} → NG候補
            </code>
            <span>
              {manual
                ? '手動調整・率の上限なし'
                : `指定上限 ${report.calibration.targetPercent}%`}
            </span>
          </div>
          <dl className="threshold-summary-metrics">
            <div>
              <dt>OK基準群のNG候補率</dt>
              <dd>
                <strong>
                  {ok.detectedPercent === null
                    ? '—'
                    : `${formatNumber(ok.detectedPercent, 3)}%`}
                </strong>
                <span>
                  {ok.detected.toLocaleString()} / {ok.total.toLocaleString()}件
                </span>
              </dd>
            </div>
            <div>
              <dt>反対群の未検出率</dt>
              <dd>
                <strong>
                  {other.notDetectedPercent === null
                    ? '—'
                    : `${formatNumber(other.notDetectedPercent, 3)}%`}
                </strong>
                <span>
                  {other.notDetected.toLocaleString()} /{' '}
                  {other.total.toLocaleString()}件
                </span>
                {!other.total && <small>有効スコア0件</small>}
              </dd>
            </div>
          </dl>
          <p className="threshold-summary-scope">比較対象全体・除外後</p>
          <PersistentDetails
            preferenceKey="threshold.breakdown"
            className="threshold-breakdown"
          >
            <summary>群別の判定内訳</summary>
            <div className="threshold-table-wrap">
              <table className="threshold-table">
                <caption>
                  現在の比較群全体で集計（手動除外後・範囲/ID/候補フィルタの前）
                </caption>
                <thead>
                  <tr>
                    <th scope="col">評価の基準</th>
                    <th scope="col">NG候補</th>
                    <th scope="col">OK候補</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">
                      OK基準：群{report.okGroup}（
                      {report.okGroup === 'A' ? labelA : labelB}）
                    </th>
                    <td>
                      <strong>
                        {fraction(ok.detected, ok.total, ok.detectedPercent)}
                      </strong>
                      <small>OK基準群のNG候補率</small>
                    </td>
                    <td>
                      {fraction(
                        ok.notDetected,
                        ok.total,
                        ok.notDetectedPercent,
                      )}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">
                      反対群：群{report.okGroup === 'A' ? 'B' : 'A'}（
                      {report.okGroup === 'A' ? labelB : labelA}）
                    </th>
                    <td>
                      {fraction(
                        other.detected,
                        other.total,
                        other.detectedPercent,
                      )}
                      <small>反対群での検出率</small>
                    </td>
                    <td>
                      {fraction(
                        other.notDetected,
                        other.total,
                        other.notDetectedPercent,
                      )}
                      <small>NG基準とみなした場合の見逃し率</small>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </PersistentDetails>
        </div>
      ) : (
        <p className="threshold-help">未設定</p>
      )}
      <p className="threshold-caveat">参考値・真の誤判定率ではありません。</p>
      <PersistentDetails
        preferenceKey="threshold.method"
        className="threshold-notes"
      >
        <summary>評価条件・算定方法</summary>
        <dl
          className="threshold-evaluation-summary"
          aria-label="現在の評価条件"
        >
          <div>
            <dt>OK基準</dt>
            <dd>
              群{okGroup}：{okGroup === 'A' ? labelA : labelB}
            </dd>
          </div>
          <div>
            <dt>NG候補</dt>
            <dd>{direction === 'high' ? '高' : '低'}スコア側</dd>
          </div>
        </dl>
        <p className="threshold-help">
          率で仮設定し、分布上のハンドルで調整できます。PR-AUCは変わりません。
          同じ標本に合わせた探索的な校正で、未知データでの率は保証しません。
          率の初期値1%は操作用の仮値です。
        </p>
        <p className="threshold-help">
          OK基準群のみに合わせ、指定上限を超えない実測率で仮設定します。同点は分割せず、少数標本では指定値に一致しない場合があります。
        </p>
        <p className="threshold-help">
          分布下部の「しきい値」ハンドルを左右に動かし、離すと確定します。Escで取消。ハンドルにフォーカスして左右キーでも調整できます。手動調整は上限率を保証せず、数値の境界と比較演算子で判定します。
        </p>
        {report &&
          report.calibration.method === 'ok-rate' &&
          report.calibration.actualPercent <
            report.calibration.targetPercent && (
            <p className="threshold-warning">
              指定上限に一致する件数を作れないため、上限以下で最も近い実測率{' '}
              {formatNumber(report.calibration.actualPercent, 3)}%
              を採用しました。
            </p>
          )}
        <p className="threshold-help">
          OK基準群と方向はサイドの「評価条件」で指定し、PR-AUCと共有します。目標率を変えてもPR-AUCは変わりません。スコア・群・集計条件・除外状態を変更したら再設定してください。
        </p>
      </PersistentDetails>
    </section>
  );
}

export function ThresholdSampleStatus({ score }: { score: number }) {
  const { report } = useThreshold();
  if (!report) return null;
  return (
    <span className="threshold-sample-status">
      仮分類：{isDetected(score, report.calibration.rule) ? 'NG候補' : 'OK候補'}
    </span>
  );
}

export function ThresholdExportButton({
  disabled,
  onExport,
}: {
  disabled: boolean;
  onExport: (
    report: ThresholdReport | null,
    evaluation: PrecisionRecallEvaluation,
  ) => void;
}) {
  const { report, evaluation } = useThreshold();
  return (
    <Button
      variant="outline"
      disabled={disabled}
      onClick={() => onExport(report, evaluation)}
    >
      <Download size={12} />
      結果JSON
    </Button>
  );
}
