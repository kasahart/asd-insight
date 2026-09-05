'use client';
import { useSessionState } from '@/state/workspace-context';
import type { EvaluationResult } from '@contracts/evaluation';
import { PersistentDetails } from '@/components/view-preferences';
import type { ReactNode } from 'react';
import { NativeSelect } from '@/components/ui/native-select';
import { finiteNumber, formatScore } from '@/lib/distribution';
import type { Dataset } from '@/lib/demo';

export function ScoreValue({
  value,
}: {
  value: string | number | null | undefined;
}) {
  const number = finiteNumber(value);
  return (
    <span
      className={number === null ? 'score-missing' : 'number-cell'}
      title={
        number === null
          ? '欠測・非数値（元の値：' +
            (String(value ?? '').trim() || '空欄') +
            '）'
          : String(value)
      }
    >
      {number === null ? '欠測' : formatScore(number, 6)}
    </span>
  );
}

// Keep this display preference separate from the distribution and sample state.
export function ScoreComparison({
  dataset,
  columns,
  scoreColumn,
  descriptions,
  result,
  children,
}: {
  dataset: Dataset;
  columns: string[];
  scoreColumn: string;
  descriptions?: Record<string, string>;
  result: EvaluationResult | null;
  children: (comparison: { column: string; control: ReactNode }) => ReactNode;
}) {
  const [choice, setChoice] = useSessionState('comparisonColumn', '');
  const column =
    dataset.columns.includes(choice) && choice !== scoreColumn ? choice : '';
  const [sorting, setSorting] = useSessionState<
    Array<{ id: string; desc: boolean }>
  >('tableSorting', [{ id: 'score', desc: false }]);
  const coverage = column ? (result?.scoreCoverage ?? null) : null;
  return children({
    column,
    control: (
      <div className="comparison-score-control">
        <PersistentDetails
          preferenceKey="samples.comparison-settings"
          className="comparison-score-settings"
        >
          <summary>
            補助スコアを併記 <span>{column || '未使用'}</span>
          </summary>
          <div className="comparison-score-selection">
            <label htmlFor="comparison-score">比較スコア（表示のみ）</label>
            <NativeSelect
              id="comparison-score"
              value={column}
              disabled={!columns.length}
              onChange={(event) => {
                const value = event.target.value;
                setChoice(value);
                if (!value && sorting[0]?.id.startsWith('comparison-score:'))
                  setSorting([{ id: 'score', desc: false }]);
              }}
              aria-describedby={
                column
                  ? 'comparison-score-help comparison-score-cohort-coverage'
                  : 'comparison-score-help'
              }
            >
              <option value="">表示しない</option>
              {columns.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </NativeSelect>
          </div>
          <p id="comparison-score-help">
            {columns.length
              ? '表と試聴欄に補助スコアを併記します。分布・判定は変わりません。'
              : '併記できる別の数値列がありません。'}
          </p>
        </PersistentDetails>
        {coverage && (
          <>
            <output
              id="comparison-score-cohort-coverage"
              className="comparison-score-coverage"
              aria-live="polite"
            >
              共通有効 {coverage.bothValid.toLocaleString()}/
              {coverage.total.toLocaleString()}件（一覧絞込前）
            </output>
            {(coverage.primaryOnly > 0 || coverage.comparisonOnly > 0) && (
              <span className="comparison-score-warning">欠測で対象差あり</span>
            )}
            <PersistentDetails
              preferenceKey="samples.comparison-coverage"
              className="comparison-score-details"
            >
              <summary>欠測の内訳・スコアの説明</summary>
              {(coverage.primaryOnly > 0 || coverage.comparisonOnly > 0) && (
                <p className="notice">
                  欠測により対象が異なります。PR-AUCの差を判定器の差と断定できません。
                </p>
              )}
              <p>
                集計条件内・手動除外後（範囲・ID・候補フィルタ前）の全
                {coverage.total.toLocaleString()}件：主列有効{' '}
                {coverage.primaryValid.toLocaleString()}件・比較列有効{' '}
                {coverage.comparisonValid.toLocaleString()}件。 主列のみ
                {coverage.primaryOnly.toLocaleString()}件・比較列のみ
                {coverage.comparisonOnly.toLocaleString()}件・両列欠測
                {coverage.bothMissing.toLocaleString()}件。
              </p>
              <p>
                補助スコアの欠測だけで一覧から行を除きません。
                尺度の異なる値の差や優劣は判定しません。
              </p>
              {descriptions?.[column] && <p>{descriptions[column]}</p>}
            </PersistentDetails>
          </>
        )}
      </div>
    ),
  });
}
