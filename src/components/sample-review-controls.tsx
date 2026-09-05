'use client';
import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PersistentDetails } from '@/components/view-preferences';
import { useWorkspace } from '@/state/workspace-context';
import type { Dataset } from '@/lib/demo';
import type { Sample } from '@/lib/data';
import type { ReviewFilter } from '@/lib/sample-review';
import type {
  IgnoredSample,
  SampleReviewState,
} from '@/components/sample-review-workspace';

export function SampleReviewControls({
  review,
  dataset,
  idColumn,
  searchControl,
  secondaryControl,
  onClearRange,
  onClearSearch,
}: {
  review: SampleReviewState;
  dataset: Dataset;
  idColumn: string;
  searchControl: ReactNode;
  secondaryControl?: ReactNode;
  onClearRange: () => void;
  onClearSearch: () => void;
}) {
  const { controller, status, conflict } = useWorkspace();
  const mode = controller.repository.mode;
  const listedIgnoredIndices = new Set(
    review.ignoredInList.map((sample) => sample.index),
  );
  const unlistedIgnored = review.ignored.filter(
    (entry) =>
      !listedIgnoredIndices.has(entry.rowIndex) &&
      entry.rowIndex !== review.selectedSample?.index,
  );
  const exclusionPersistenceNote = conflict
    ? '別のタブで更新されています。この画面の編集は未保存です。編集を残すには別の分析として保存してください。'
    : mode === 'memory'
      ? '一時利用中です。除外理由と履歴はこのタブに保持されますが、タブを閉じると失われます。'
      : status === 'error'
        ? '保存できていません。除外理由と履歴はこの画面に残っています。保存を再試行してください。'
        : status === 'saving'
          ? '保存中です。除外理由と履歴はこの分析に自動保存されます。'
          : status === 'unsaved'
            ? '未保存の変更があります。除外理由と履歴はこの分析に自動保存されます。'
            : '除外理由と履歴はこの分析に自動保存されます。';

  function chooseFilter(next: ReviewFilter) {
    review.setFilter(next === review.filter ? 'all' : next);
  }
  return (
    <div className="sample-review-controls">
      <div className="review-filter-toolbar">
        <fieldset
          className="review-filter-buttons"
          aria-label="候補・除外によるサンプルフィルタ"
        >
          <Button
            variant={review.filter === 'all' ? 'secondary' : 'outline'}
            aria-pressed={review.filter === 'all'}
            onClick={() => chooseFilter('all')}
          >
            すべて{' '}
            <b>
              {review.pending
                ? '計算中'
                : (
                    review.counts.all + review.ignoredInList.length
                  ).toLocaleString()}
              {review.pending ? '' : '件'}
            </b>
          </Button>
          <Button
            variant={
              review.filter === 'false-positive' ? 'secondary' : 'outline'
            }
            aria-pressed={review.filter === 'false-positive'}
            aria-describedby="candidate-semantics-note"
            onClick={() => chooseFilter('false-positive')}
          >
            <span>OK基準群のNG候補</span>
            {review.counts.falsePositive !== null && (
              <b>{review.counts.falsePositive.toLocaleString()}件</b>
            )}
            {review.counts.falsePositive === null && !review.pending && (
              <small>未設定時は1%で仮設定</small>
            )}
          </Button>
          <Button
            variant={
              review.filter === 'false-negative' ? 'secondary' : 'outline'
            }
            aria-pressed={review.filter === 'false-negative'}
            aria-describedby="candidate-semantics-note"
            onClick={() => chooseFilter('false-negative')}
          >
            <span>反対群のOK候補</span>
            {review.counts.falseNegative !== null && (
              <b>{review.counts.falseNegative.toLocaleString()}件</b>
            )}
            {review.counts.falseNegative === null && !review.pending && (
              <small>未設定時は1%で仮設定</small>
            )}
          </Button>
          <Button
            variant={review.filter === 'ignored' ? 'secondary' : 'outline'}
            aria-pressed={review.filter === 'ignored'}
            onClick={() => chooseFilter('ignored')}
          >
            除外のみ{' '}
            <b>
              {review.pending
                ? '計算中'
                : String((review.listingIgnoredTotal ?? 0).toLocaleString()) +
                  '件'}
            </b>
          </Button>
        </fieldset>
        {searchControl}
      </div>
      <p
        id="candidate-semantics-note"
        className="review-filter-help candidate-semantics-note"
        role="note"
      >
        候補はOK基準との不一致を示す参考分類で、真の誤判定とは確定しません。
      </p>
      {review.filterError && (
        <p className="inline-error" role="alert">
          {review.filterError}
        </p>
      )}
      {review.pending &&
        (review.filter === 'false-positive' ||
          review.filter === 'false-negative') && (
          <div className="candidate-scope" aria-live="polite">
            <p>候補件数を再計算中です。前の件数は確定値ではありません。</p>
          </div>
        )}
      {review.candidateScope && review.candidateScope.current > 0 && (
        <div className="candidate-scope" aria-live="polite">
          <p>
            候補全体 <b>{review.candidateScope.total}</b>件中、現在の表示条件で{' '}
            <b>{review.candidateScope.current}</b>件表示。
          </p>
        </div>
      )}
      {review.candidateScope?.current === 0 && (
        <div className="candidate-scope" aria-live="polite">
          <p>
            候補全体 <b>{review.candidateScope.total}</b>件中、現在の表示条件で{' '}
            <b>0</b>件表示。{' '}
            {review.candidateScope.total === 0
              ? '比較対象全体にも候補がありません。'
              : `全体の候補${review.candidateScope.total}件が、${
                  review.candidateScope.recovery === 'range'
                    ? '選択範囲の外にあります。'
                    : review.candidateScope.recovery === 'search'
                      ? '名前検索で隠れています。'
                      : '範囲と名前検索で隠れています。'
                }`}
          </p>
          {review.candidateScope.recovery && (
            <Button
              variant="outline"
              onClick={() => {
                if (review.candidateScope?.recovery !== 'search')
                  onClearRange();
                if (review.candidateScope?.recovery !== 'range')
                  onClearSearch();
              }}
            >
              {review.candidateScope.recovery === 'range'
                ? '範囲を解除して候補を見る'
                : review.candidateScope.recovery === 'search'
                  ? '名前検索を解除して候補を見る'
                  : '範囲と名前検索を解除して候補を見る'}
            </Button>
          )}
        </div>
      )}
      {review.filter === 'ignored' ? (
        <p className="review-filter-help" aria-live="polite">
          {review.ignoredInList.length
            ? '「戻す」で集計に復元できます。'
            : 'この条件に合う除外行はありません。'}
          {unlistedIgnored.length > 0 &&
            ' 一覧外の除外行は下の復元欄にあります。'}
        </p>
      ) : review.ignoredInList.length > 0 ? (
        <p className="review-filter-help">
          除外中{review.ignoredInList.length.toLocaleString()}
          件を併記・候補件数には含みません。
        </p>
      ) : null}
      <div className="review-secondary-controls">
        <PersistentDetails
          preferenceKey="samples.filter-help"
          className="review-filter-details"
        >
          <summary>フィルタの説明</summary>
          {review.counts.falsePositive === null && !review.pending && (
            <p>
              未設定時に候補ボタンを押すと、現在のOK基準群とスコア方向を使って1%で仮設定して候補を表示します。
              実際の率は同点や件数で1%を下回る場合があります。
            </p>
          )}
          {review.candidateScope && (
            <p>
              候補件数：比較対象全体 {review.candidateScope.total}件 →
              分布範囲内 {review.candidateScope.inRange}件 → 名前検索後{' '}
              {review.candidateScope.current}件
            </p>
          )}
          <p>
            OK基準群のNG候補（従来の「偽陽性候補」）＝OK基準群なのにNG候補、反対群のOK候補（従来の「偽陰性候補」）＝反対群なのにOK候補です。
            選んだ基準との不一致であり、真の誤判定と確定したものではありません。
          </p>
          <p>
            範囲・名前検索とANDで適用し、ボタンの件数もその範囲内です。「すべて」で候補による絞り込みを解除できます。
            分布・PR-AUC・しきい値の算定対象は変わりません。
          </p>
          <p>
            除外行は候補の条件では隠さず、比較条件・範囲・名前検索に従って併記します。
            候補件数・分布・PR-AUC・しきい値・行CSVには含めません。
            「除外のみ」は仮しきい値がなくても使えます。
          </p>
        </PersistentDetails>
        {secondaryControl}
        {unlistedIgnored.length > 0 && (
          <PersistentDetails
            preferenceKey="samples.unlisted-exclusions"
            className="ignored-samples"
          >
            <summary>
              一覧に出ていない除外データ{' '}
              <b>{unlistedIgnored.length.toLocaleString()}件</b>
            </summary>
            <p>
              比較条件・範囲・名前検索の対象外、またはスコア欠測で一覧に出ていない行を復元できます。
              復元は分布・PR-AUCを再計算し、仮しきい値を解除します。
              候補の絞り込みは解除され、「除外のみ」は維持されます。
            </p>
            <p>
              元データは削除しません。{exclusionPersistenceNote}
            </p>
            <div className="ignored-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">サンプル</th>
                    <th scope="col">除外理由</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {unlistedIgnored.map((entry) => {
                    const label = idColumn
                      ? dataset.rows[entry.rowIndex]?.[idColumn]
                      : `row-${entry.rowIndex + 1}`;
                    return (
                      <tr key={entry.rowIndex}>
                        <td title={label}>
                          {label}
                          <small>
                            {entry.groupColumn}: {entry.groupValue}
                          </small>
                        </td>
                        <td>
                          {entry.reason}
                          <small>
                            {new Date(entry.at).toLocaleString('ja-JP')}
                          </small>
                        </td>
                        <td>
                          <Button
                            variant="outline"
                            onClick={() => review.restore(entry.rowIndex)}
                            aria-label={`${label} を集計に戻す`}
                          >
                            集計に戻す
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </PersistentDetails>
        )}
      </div>
    </div>
  );
}

export function IgnoreSampleAction({
  sample,
  onIgnore,
  ignored,
}: {
  sample: Sample;
  onIgnore: SampleReviewState['ignore'];
  ignored?: IgnoredSample;
}) {
  const [reason, setReason] = useState('');
  if (ignored)
    return (
      <output className="excluded-sample-notice" aria-live="polite">
        <strong>集計から除外中</strong>
        <p>理由：{ignored.reason}</p>
        <p>
          一覧の「戻す」で復元できます。復元時は再集計し、しきい値を解除します。
        </p>
      </output>
    );
  return (
    <PersistentDetails
      preferenceKey="sample.exclusion"
      className="ignore-sample-action"
    >
      <summary>集計から除外</summary>
      <label htmlFor="ignore-reason">除外理由</label>
      <Input
        id="ignore-reason"
        value={reason}
        maxLength={200}
        placeholder="確認した事実・除外する理由"
        aria-describedby="ignore-reason-help"
        onChange={(e) => setReason(e.target.value)}
      />
      <p className="review-action-impact">
        除外すると再集計し、仮しきい値を解除します。
      </p>
      <Button variant="outline" onClick={() => onIgnore(sample, reason)}>
        このサンプルを集計から除外
      </Button>
      <div className="exclusion-help">
        <p id="ignore-reason-help">
          空欄は「理由未記入（原因未確定）」として記録します。
        </p>
        <p>
          元データは残ります。一覧の「戻す」で復元できます。除外行は分布・PR-AUC・しきい値・行CSVに含めません。
        </p>
      </div>
    </PersistentDetails>
  );
}
