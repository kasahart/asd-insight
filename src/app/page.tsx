'use client';
import { useMemo, useRef, useState, useCallback, useEffect } from 'react';
import {
  AudioLines,
  Info,
  Download,
  FileAudio,
  X,
  ShieldCheck,
  ListFilter,
} from 'lucide-react';
import { NativeSelect } from '@/components/ui/native-select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DistributionChart } from '@/components/distribution-chart';
import { DistributionViewport } from '@/components/distribution-viewport';
import { DistributionSymbol } from '@/components/distribution-symbol';
import { AudioInspector } from '@/components/audio-inspector';
import { SampleTable } from '@/components/sample-table';
import { ScoreComparison } from '@/components/score-comparison';
import { PersistentDetails } from '@/components/view-preferences';
import {
  InspectorProvider,
  ContextInspector,
  InspectThresholdButton,
  InspectSelectedSampleButton,
} from '@/components/context-inspector';
import { ContextWorkbench } from '@/components/context-workbench';
import { EvaluationSettings } from '@/components/evaluation-settings';
import { addAudioAttachments } from '@/lib/audio-attachments';
import {
  type ThresholdReport,
  type PrecisionRecallEvaluation,
} from '@/components/threshold-context';
import {
  SampleReviewWorkspace,
  type SampleReviewState,
} from '@/components/sample-review-workspace';
import {
  SampleReviewControls,
  IgnoreSampleAction,
} from '@/components/sample-review-controls';
import {
  PrecisionRecallMetric,
  PrecisionRecallExplanation,
} from '@/components/precision-recall-metric';
import {
  ThresholdPanel,
  ThresholdExportButton,
} from '@/components/threshold-panel';
import { finiteNumber, formatScore, type ScoreRange } from '@/lib/distribution';
import {
  formatAnalysisMethod,
  formatEvaluationCondition,
  formatInspectionConditions,
  formatReviewHistoryEntry,
  formatThresholdCondition,
} from '@/lib/analysis-display';
import type { Dataset } from '@/lib/demo';
import {
  csvText,
  defaultGroup,
  findAudio,
  resolveAudio,
  unusedColumn,
  type AudioResolution,
  type GroupSpec,
  type Sample,
} from '@/lib/data';

import { ProductionApp, WorkspaceActions } from '@/components/production-app';
import { useWorkspace, useSessionState } from '@/state/workspace-context';
import { EvaluationWorkerClient } from '@domain/evaluation-client';
import type { QueryMode } from '@contracts/evaluation';
import type { SessionRecord } from '@contracts/storage';
import type { Profile } from '@/lib/data';

type AnalysisReportInput = {
  data: Dataset;
  record: SessionRecord;
  createdAt: string;
  comparisonScoreColumn: string;
  threshold: ThresholdReport | null;
  precisionRecall: PrecisionRecallEvaluation;
  review: SampleReviewState;
  score: string;
  group: GroupSpec;
  filterColumn: string;
  filterValue: string;
  bins: number;
  idColumn: string;
  audioColumn: string;
  range: ScoreRange | null;
  overlapOnly: boolean;
  query: string;
  queryMode: QueryMode;
  notes: Record<number, string>;
};

/**
 * Build the JSON report from one completed workspace snapshot.  The
 * provenance disclosure uses this same builder so its values cannot drift
 * from the downloaded report.
 */
export function buildAnalysisReport(input: AnalysisReportInput) {
  const {
    data,
    record,
    createdAt,
    comparisonScoreColumn,
    threshold,
    precisionRecall,
    review,
    score,
    group,
    filterColumn,
    filterValue,
    bins,
    idColumn,
    audioColumn,
    range,
    overlapOnly,
    query,
    queryMode,
    notes,
  } = input;
  const { distribution: d, comparison, visible } = review;
  const sampleId = (index: number) =>
    idColumn ? data.rows[index]?.[idColumn] : 'row-' + (index + 1);
  return {
    application: 'ASD Insight',
    version: 6,
    createdAt,
    analysis: {
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    },
    source: {
      name: data.name,
      demo: data.demo,
      rowCount: data.rows.length,
      datasetVersionId: record.datasetVersionId,
      // datasetHash is the logical parsed-dataset hash.  A source asset hash,
      // when available, is kept separately so the two identities are clear.
      datasetHash: record.datasetHash,
      logicalDatasetHash: record.datasetHash,
      ...(record.source?.name
        ? { originalFileName: record.source.name }
        : {}),
      ...(record.source?.hash
        ? { originalFileHash: record.source.hash }
        : {}),
    },
    settings: {
      scoreColumn: score,
      comparisonScoreColumn: comparisonScoreColumn || null,
      positiveGroup: precisionRecall.positiveGroup,
      okGroup: precisionRecall.negativeGroup,
      scoreDirection: precisionRecall.direction,
      group,
      filter:
        filterColumn && filterValue
          ? { column: filterColumn, value: filterValue }
          : null,
      bins,
      idColumn,
      audioColumn,
    },
    method: {
      name: 'Area under the precision-recall curve (trapezoidal)',
      formula:
        'sum((recall_i-recall_previous)*(precision_i+precision_previous)/2)',
      domain: [0, 1],
      endpoint: 'recall=0, precision=1, threshold=null',
      ties: 'Process all equal scores together; high uses >=, low uses <=',
      scope:
        'All finite, non-ignored scores in both current comparison cohorts and condition filter; independent of histogram bins, inspection range, search, decision filter, comparison score and provisional threshold',
      caveat:
        'Not Average Precision (AP). Linear interpolation can be optimistic with ties or few samples. Depends on positive prevalence and reference labels; not an error rate or deployment assessment.',
      histogram: {
        normalization: 'within each group',
        edges: 'left inclusive, right exclusive; final bin includes maximum',
      },
    },
    usage: {
      purpose: 'reference-exploration',
      boundary:
        '参考・探索分析。検査合否や運用しきい値の承認には使用しない。',
      candidateCaveat:
        '候補はOK基準との不一致を示す参考分類で、真の誤判定とは確定しない。',
      candidateLabels: {
        falsePositive: {
          machineKey: 'false-positive',
          label: 'OK基準群のNG候補',
          legacyLabel: '偽陽性候補',
        },
        falseNegative: {
          machineKey: 'false-negative',
          label: '反対群のOK候補',
          legacyLabel: '偽陰性候補',
        },
      },
    },
    summary: {
      prAuc: precisionRecall.auc,
      nA: d.nA,
      nB: d.nB,
      medianA: d.medianA,
      medianB: d.medianB,
      range: [d.min, d.max],
      excluded: {
        filter: comparison.value.outsideFilter,
        groupMissing: comparison.value.missingGroup,
        groupOther: comparison.value.otherGroup,
        scoreMissingA: comparison.value.missingA,
        scoreMissingB: comparison.value.missingB,
        manual: comparison.value.ignoredRows,
      },
    },
    histogram: d.bins,
    precisionRecall,
    threshold,
    manualReview: {
      baseline: review.baseline,
      excluded: review.ignored.map((entry) => ({
        ...entry,
        sampleId: sampleId(entry.rowIndex),
      })),
      history: review.history.map((entry) => ({
        ...entry,
        sampleId: sampleId(entry.rowIndex),
      })),
      caveat:
        'Original rows and labels are unchanged. Metrics describe only retained rows; omissions do not prove model improvement. This result is not a restorable backup; use the .ovlab bundle.',
    },
    inspection: {
      range,
      overlapBinsOnly: overlapOnly,
      query,
      queryMode,
      decisionFilter: review.filter === 'ignored' ? 'all' : review.filter,
      excludedOnly: review.filter === 'ignored',
      sampleIds: visible.map((sample) => sampleId(sample.index)),
      listedSampleIds: review.listed.map((sample) => sampleId(sample.index)),
      excludedSampleIds: review.ignoredInList.map((sample) =>
        sampleId(sample.index),
      ),
    },
    notes: Object.entries(notes)
      .filter(([, value]) => value.trim())
      .map(([index, text]) => ({
        rowIndex: Number(index),
        sampleId: sampleId(Number(index)),
        text,
      })),
  };
}

type AnalysisReport = ReturnType<typeof buildAnalysisReport>;

function AnalysisProvenance({
  pending,
  error,
  buildReport,
}: {
  pending: boolean;
  error: string;
  buildReport: () => AnalysisReport;
}) {
  const [open, setOpen] = useState(false);
  const [identifiersOpen, setIdentifiersOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const report = open && !pending && !error ? buildReport() : null;
  // Keep the potentially large report string out of the normal render path.
  // The report is still built from the same snapshot as exportJSON, but its
  // full JSON is materialized only after the reader asks for it.
  const json = report && jsonOpen ? JSON.stringify(report, null, 2) : '';
  const history = report?.manualReview.history ?? [];
  const recentHistory = history.slice(-20);
  const excluded = report?.manualReview.excluded ?? [];
  const recentExcluded = excluded.slice(-20);
  return (
    <details
      className="analysis-provenance"
      open={open}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        setOpen(nextOpen);
        if (!nextOpen) {
          setIdentifiersOpen(false);
          setJsonOpen(false);
        }
      }}
    >
      <summary>分析の来歴・条件と確認用JSON</summary>
      {pending ? (
        <p className="provenance-pending">
          再計算中です。前の条件や件数は確定値として表示しません。
        </p>
      ) : error ? (
        <p className="provenance-pending">
          集計結果を確認できません。再計算が完了してから開いてください。
        </p>
      ) : report ? (
        <div className="analysis-provenance-content">
          <dl className="provenance-readable">
            <div>
              <dt>評価条件</dt>
              <dd>
                {formatEvaluationCondition({
                  scoreColumn: report.settings.scoreColumn,
                  group: report.settings.group,
                  okGroup: report.settings.okGroup,
                  scoreDirection: report.settings.scoreDirection,
                  filter: report.settings.filter,
                })}
              </dd>
            </div>
            <div>
              <dt>探索用しきい値</dt>
              <dd>{formatThresholdCondition(report.threshold)}</dd>
            </div>
            <div>
              <dt>一覧表示条件</dt>
              <dd>
                {formatInspectionConditions({
                  range: report.inspection.range,
                  overlapBinsOnly: report.inspection.overlapBinsOnly,
                  query: report.inspection.query,
                  queryMode: report.inspection.queryMode,
                  decisionFilter: report.inspection.decisionFilter,
                  excludedOnly: report.inspection.excludedOnly,
                })}
              </dd>
            </div>
            <div>
              <dt>除外・復元履歴</dt>
              <dd>
                {recentExcluded.length ? (
                  <ul className="provenance-history-list">
                    {recentExcluded.map((entry, index) => (
                      <li key={`${entry.sampleId ?? entry.rowIndex}-excluded-${index}`}>
                        {entry.sampleId || `行${entry.rowIndex + 1}`}：{entry.reason}
                      </li>
                    ))}
                  </ul>
                ) : (
                  '現在の手動除外なし'
                )}
                <span className="provenance-exclusion-summary">
                  自動除外：条件外 {report.summary.excluded.filter.toLocaleString()}件 · 群の欠測・非該当{' '}
                  {(
                    report.summary.excluded.groupMissing +
                    report.summary.excluded.groupOther
                  ).toLocaleString()}
                  件 · スコア欠測{' '}
                  {(
                    report.summary.excluded.scoreMissingA +
                    report.summary.excluded.scoreMissingB
                  ).toLocaleString()}
                  件
                </span>
                {excluded.length > recentExcluded.length && (
                  <small className="provenance-more">
                    現在の除外20件を表示（全{excluded.length}件。全件は確認用JSONで確認できます）
                  </small>
                )}
                {recentHistory.length ? (
                  <ul className="provenance-history-list">
                    {recentHistory.map((entry, index) => (
                      <li key={`${entry.sampleId ?? entry.rowIndex}-${entry.at}-${index}`}>
                        {formatReviewHistoryEntry(entry)}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <span className="provenance-history-empty">履歴なし</span>
                )}
                {history.length > recentHistory.length && (
                  <small className="provenance-more">
                    履歴は直近20件を表示（全{history.length}件）。全履歴は確認用JSONで確認できます。
                  </small>
                )}
              </dd>
            </div>
            <div>
              <dt>算定方法</dt>
              <dd>{formatAnalysisMethod()}</dd>
            </div>
          </dl>
          <details
            className="provenance-identifiers"
            open={identifiersOpen}
            onToggle={(event) => setIdentifiersOpen(event.currentTarget.open)}
          >
            <summary>データ識別子・hash（全文）</summary>
            <dl className="provenance-grid">
            <div>
              <dt>元データ</dt>
              <dd>{report.source.name}</dd>
            </div>
            {'originalFileName' in report.source && (
              <div>
                <dt>元ファイル名</dt>
                <dd>{report.source.originalFileName}</dd>
              </div>
            )}
            <div>
              <dt>datasetVersionId</dt>
              <dd><code>{report.source.datasetVersionId}</code></dd>
            </div>
            <div>
              <dt>論理datasetHash</dt>
              <dd><code>{report.source.logicalDatasetHash}</code></dd>
            </div>
            {'originalFileHash' in report.source && (
              <div>
                <dt>元ファイルhash</dt>
                <dd><code>{report.source.originalFileHash}</code></dd>
              </div>
            )}
            <div>
              <dt>元データ件数</dt>
              <dd>{report.source.rowCount.toLocaleString()}件</dd>
            </div>
            </dl>
          </details>
          <details
            className="provenance-json-details"
            open={jsonOpen}
            onToggle={(event) => setJsonOpen(event.currentTarget.open)}
          >
            <summary>確認用JSON（全文・読み取り専用）</summary>
            {jsonOpen && (
              <div className="provenance-json-content">
                <label
                  className="provenance-json-label"
                  htmlFor="analysis-provenance-json"
                >
                  画面と同じ現在条件を含むJSON
                </label>
                <textarea
                  id="analysis-provenance-json"
                  className="provenance-json"
                  aria-label="確認用JSON"
                  readOnly
                  value={json}
                  rows={12}
                />
              </div>
            )}
          </details>
        </div>
      ) : null}
    </details>
  );
}

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export default function Home() {
  return (
    <ProductionApp>
      <DiagnosticsWorkspace />
    </ProductionApp>
  );
}

function DiagnosticsWorkspace() {
  const { active, controller, policy, operation } = useWorkspace();
  const data = active!.dataset;
  const datasetSession = active!.record.id;
  const [score, setScore] = useSessionState('score', '');
  const [group, setGroup] = useSessionState<GroupSpec>('group', {
    kind: 'category',
    column: '',
    a: '',
    b: '',
  });
  const [idColumn, setIdColumn] = useSessionState('idColumn', '');
  const [audioColumn, setAudioColumn] = useSessionState('audioColumn', '');
  const [numericA, setNumericA] = useSessionState('numericA', '');
  const [numericB, setNumericB] = useSessionState('numericB', '');
  const [filterColumn, setFilterColumn] = useSessionState('filterColumn', '');
  const [filterValue, setFilterValue] = useSessionState('filterValue', '');
  const [bins, setBins] = useSessionState('bins', 24);
  const [method, setMethod] = useSessionState('method', false);
  const [range, setRange] = useSessionState<ScoreRange | null>('range', null);
  const [overlapOnly, setOverlapOnly] = useSessionState('overlapOnly', false);
  const [rangeLo, setRangeLo] = useSessionState('rangeLo', '');
  const [rangeHi, setRangeHi] = useSessionState('rangeHi', '');
  const [selected, setSelected] = useSessionState<number | null>(
    'selected',
    null,
  );
  const [query, setQuery] = useSessionState('query', '');
  const [queryMode, setQueryMode] = useSessionState<'partial' | 'exact'>(
    'queryMode',
    'partial',
  );
  const [notes, setNotes] = useSessionState<Record<number, string>>(
    'notes',
    {},
  );
  const audioFiles = active!.audioFiles;
  const setAudioFiles = (files: Map<string, File>) =>
    controller.updateAudio(files);
  const [message, setMessage] = useState<{
    error: boolean;
    text: string;
  } | null>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  useEffect(() => {
    const client = new EvaluationWorkerClient();
    const abort = new AbortController();
    void client
      .profile(data, { signal: abort.signal })
      .then(setProfiles)
      .catch((error) => {
        if (!abort.signal.aborted)
          setMessage({ error: true, text: String(error) });
      });
    return () => {
      abort.abort();
      client.dispose();
    };
  }, [data]);
  const scores = profiles.filter(
    (p) =>
      p.numeric &&
      (p.column === score ||
        (p.column !== idColumn && p.column !== audioColumn)),
  );
  const groupProfiles = profiles.filter(
    (p) =>
      p.column !== score &&
      (p.column === group.column ||
        (p.column !== idColumn && p.column !== audioColumn)) &&
      (p.numeric || p.values.length <= 100) &&
      p.nonempty > 0,
  );
  const filterProfiles = profiles.filter(
    (p) =>
      p.column !== idColumn &&
      p.column !== audioColumn &&
      p.values.length <= 100,
  );
  const effectiveGroup = useMemo<GroupSpec>(
    () =>
      group.kind === 'numeric'
        ? {
            ...group,
            upperA: finiteNumber(numericA) ?? NaN,
            lowerB: finiteNumber(numericB) ?? NaN,
          }
        : group,
    [group, numericA, numericB],
  );
  const labelA = group.kind === 'category' ? group.a : '≤ ' + numericA,
    labelB = group.kind === 'category' ? group.b : '≥ ' + numericB;
  const sampleLabel = (s: Sample) =>
    idColumn ? s.row[idColumn] : 'row-' + (s.index + 1);
  const selectSample = useCallback(
    (s: Sample) => setSelected(s.index),
    [setSelected],
  );
  const hasAudio = useCallback(
    (s: Sample) =>
      data.demo ||
      !!findAudio(s.row, s.index, idColumn, audioColumn, audioFiles),
    [data.demo, idColumn, audioColumn, audioFiles],
  );
  const audioMatchCount = useMemo(
    () =>
      data.demo
        ? 0
        : data.rows.filter(
            (row, index) =>
              !!findAudio(row, index, idColumn, audioColumn, audioFiles),
          ).length,
    [data, idColumn, audioColumn, audioFiles],
  );
  const resetSelection = useCallback(() => {
    setRange(null);
    setOverlapOnly(false);
    setRangeLo('');
    setRangeHi('');
    setQuery('');
  }, [setRange, setOverlapOnly, setRangeLo, setRangeHi, setQuery]);
  function clearRange() {
    setRange(null);
    setOverlapOnly(false);
    setRangeLo('');
    setRangeHi('');
  }
  function setGroupColumn(column: string, kind?: 'category' | 'numeric') {
    const p = profiles.find((p) => p.column === column);
    if (!p) return;
    const g = defaultGroup(data, p, kind);
    setGroup(g);
    setNumericA(g.kind === 'numeric' ? String(g.upperA) : '');
    setNumericB(g.kind === 'numeric' ? String(g.lowerB) : '');
    resetSelection();
  }
  function changeScore(column: string) {
    setScore(column);
    resetSelection();
    if (group.column === column) {
      const p = profiles.find(
        (p) =>
          p.column !== column &&
          p.column !== idColumn &&
          p.column !== audioColumn &&
          p.values.length >= 2 &&
          (p.numeric || p.values.length <= 100),
      );
      if (p) setGroupColumn(p.column);
      else setGroup({ kind: 'category', column: '', a: '', b: '' });
    }
  }
  function attachAudio(files: FileList) {
    let map: Map<string, File>;
    try {
      map = addAudioAttachments(audioFiles, Array.from(files), {
        rows: data.rows,
        resolve: (row, index, files) =>
          findAudio(row, index, idColumn, audioColumn, files),
      });
    } catch (error) {
      setMessage({
        error: true,
        text:
          error instanceof Error
            ? error.message
            : '音声を追加できませんでした。',
      });
      return;
    }
    setAudioFiles(map);
    const matched = data.rows.filter(
      (row, index) => !!findAudio(row, index, idColumn, audioColumn, map),
    ).length;
    setMessage({
      error: false,
      text:
        map.size +
        'ファイルを追加、' +
        matched +
        '行に対応しました。' +
        (data.demo
          ? '実音声を使うときは、先にCSVを読み込んでください。'
          : 'サーバーへの送信はしていません。'),
    });
  }
  function openAudioSettings() {
    const details = document.getElementById(
      'dataset-mapping-details',
    ) as HTMLDetailsElement | null;
    const summary = document.getElementById('dataset-mapping-summary');
    if (!details || !summary) return;
    if (!details.open) summary.click();
    details.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    summary.focus({ preventScroll: true });
  }
  function chooseRange(r: ScoreRange) {
    setRange(r);
    setOverlapOnly(false);
    setRangeLo(String(r.lo));
    setRangeHi(String(r.hi));
  }
  function applyRange(bounds: { min: number; max: number }) {
    const lo = finiteNumber(rangeLo),
      hi = finiteNumber(rangeHi);
    if (lo === null || hi === null || lo > hi) {
      setMessage({
        error: true,
        text: '確認範囲の下限・上限を数値で入力してください（下限 ≤ 上限）。',
      });
      return;
    }
    if (hi < bounds.min || lo > bounds.max) {
      setMessage({ error: true, text: '確認範囲が現在のスコア範囲外です。' });
      return;
    }
    chooseRange({ lo, hi, includeHi: true });
  }
  function exportJSON(
    comparisonScoreColumn: string,
    threshold: ThresholdReport | null,
    precisionRecall: PrecisionRecallEvaluation,
    review: SampleReviewState,
  ) {
    if (!policy.downloads || review.pending || review.error) return;
    const report = buildAnalysisReport({
      data,
      record: active!.record,
      createdAt: new Date().toISOString(),
      comparisonScoreColumn,
      threshold,
      precisionRecall,
      review,
      score,
      group: effectiveGroup,
      filterColumn,
      filterValue,
      bins,
      idColumn,
      audioColumn,
      range,
      overlapOnly,
      query,
      queryMode,
      notes,
    });
    download(
      'overlap-analysis.json',
      JSON.stringify(report, null, 2),
      'application/json',
    );
  }
  function exportRows(visible: Sample[]) {
    if (!policy.downloads) return;
    const c1 = unusedColumn('comparison_group', data.columns),
      c2 = unusedColumn('analyst_note', [...data.columns, c1]);
    const rows = visible.map((s) => ({
      ...s.row,
      [c1]: s.group,
      [c2]: notes[s.index] ?? '',
    }));
    download(
      'overlap-selection.csv',
      csvText([...data.columns, c1, c2], rows),
      'text/csv;charset=utf-8',
    );
  }
  return (
    <div className="lab-shell dark">
      <input
        ref={audioInput}
        type="file"
        accept="audio/wav,.wav"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) attachAudio(e.target.files);
          e.target.value = '';
        }}
      />
      <header className="app-header">
        <div className="brand">
          <span className="brand-icon">
            <AudioLines size={21} />
          </span>
          <strong>
            ASD <span>Insight</span>
          </strong>
          <span className="version">WEB</span>
        </div>
        <WorkspaceActions />
      </header>
      {message && (
        <div
          className={message.error ? 'import-error' : 'import-success'}
          role={message.error ? 'alert' : 'status'}
        >
          {message.text}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="通知を閉じる"
            onClick={() => setMessage(null)}
          >
            <X size={13} />
          </Button>
        </div>
      )}
      <div className="workspace" inert={!!operation}>
        <SampleReviewWorkspace
          dataset={data}
          score={score}
          group={effectiveGroup}
          filterColumn={filterColumn}
          filterValue={filterValue}
          bins={bins}
          range={range}
          overlapOnly={overlapOnly}
          query={query}
          queryMode={queryMode}
          idColumn={idColumn}
          selectedIndex={selected}
          labelA={labelA}
          labelB={labelB}
        >
          {(review) => {
            const {
              distribution: d,
              a,
              b,
              error,
              visible,
              selectedSample,
            } = review;
            const coverage = review.comparison.value;
            const selectedExclusion = selectedSample
              ? review.ignored.find(
                  (entry) => entry.rowIndex === selectedSample.index,
                )
              : undefined;
            const selectedAudioResolution: AudioResolution<File> | undefined =
              selectedSample
                ? resolveAudio(
                  selectedSample.row,
                  selectedSample.index,
                  idColumn,
                  audioColumn,
                  audioFiles,
                )
                : undefined;
            const selectedAudioFile = selectedAudioResolution?.file;
            return (
              <>
                <aside
                  className="control-panel"
                  id="comparison-settings"
                  tabIndex={-1}
                >
                  <div className="panel-heading">
                    <h2>評価条件</h2>
                  </div>
                  <div className="field">
                    <label htmlFor="score">評価する異常度の列</label>
                    <NativeSelect
                      id="score"
                      value={score}
                      onChange={(e) => changeScore(e.target.value)}
                    >
                      {scores.map((p) => (
                        <option value={p.column} key={p.column}>
                          {p.column}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <div className="field">
                    <label htmlFor="group-column">群分けに使う列</label>
                    <NativeSelect
                      id="group-column"
                      value={group.column}
                      onChange={(e) => setGroupColumn(e.target.value)}
                    >
                      <option value="" disabled>
                        属性・別の評価列を選択
                      </option>
                      {groupProfiles.map((p) => (
                        <option value={p.column} key={p.column}>
                          {p.column}
                        </option>
                      ))}
                    </NativeSelect>
                    {profiles.find((p) => p.column === group.column)
                      ?.numeric && (
                      <NativeSelect
                        aria-label="群分けの方法"
                        value={group.kind}
                        onChange={(e) =>
                          setGroupColumn(
                            group.column,
                            e.target.value as 'category' | 'numeric',
                          )
                        }
                      >
                        <option value="numeric">数値の範囲で分ける</option>
                        <option
                          value="category"
                          disabled={
                            (profiles.find((p) => p.column === group.column)
                              ?.values.length ?? 0) > 100
                          }
                        >
                          値をカテゴリとして選ぶ
                        </option>
                      </NativeSelect>
                    )}
                  </div>
                  {group.kind === 'category' ? (
                    <>
                      <div className="cohort-field">
                        <label htmlFor="group-a">
                          <i className="dot a" />
                          群A
                        </label>
                        <NativeSelect
                          id="group-a"
                          value={group.a}
                          onChange={(e) => {
                            setGroup({ ...group, a: e.target.value });
                            resetSelection();
                          }}
                        >
                          {profiles
                            .find((p) => p.column === group.column)
                            ?.values.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                        </NativeSelect>
                      </div>
                      <div className="cohort-field b">
                        <label htmlFor="group-b">
                          <i className="dot b" />
                          群B
                        </label>
                        <NativeSelect
                          id="group-b"
                          value={group.b}
                          onChange={(e) => {
                            setGroup({ ...group, b: e.target.value });
                            resetSelection();
                          }}
                        >
                          {profiles
                            .find((p) => p.column === group.column)
                            ?.values.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                        </NativeSelect>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="cohort-field">
                        <label htmlFor="group-a">
                          <i className="dot a" />
                          群A：次の値以下
                        </label>
                        <Input
                          id="group-a"
                          inputMode="decimal"
                          value={numericA}
                          onChange={(e) => {
                            setNumericA(e.target.value);
                            resetSelection();
                          }}
                        />
                      </div>
                      <div className="cohort-field b">
                        <label htmlFor="group-b">
                          <i className="dot b" />
                          群B：次の値以上
                        </label>
                        <Input
                          id="group-b"
                          inputMode="decimal"
                          value={numericB}
                          onChange={(e) => {
                            setNumericB(e.target.value);
                            resetSelection();
                          }}
                        />
                        <small>2つの境界の間と欠測は比較から除外</small>
                      </div>
                    </>
                  )}
                  <EvaluationSettings labelA={labelA} labelB={labelB} />
                  <div className="field divided">
                    <label htmlFor="filter-column" className="filter-label">
                      <ListFilter size={12} />
                      評価対象の条件
                    </label>
                    <NativeSelect
                      id="filter-column"
                      value={filterColumn}
                      onChange={(e) => {
                        setFilterColumn(e.target.value);
                        setFilterValue('');
                        resetSelection();
                      }}
                    >
                      <option value="">すべての条件</option>
                      {filterProfiles.map((p) => (
                        <option value={p.column} key={p.column}>
                          {p.column}
                        </option>
                      ))}
                    </NativeSelect>
                    {filterColumn && (
                      <NativeSelect
                        aria-label="集計する属性値"
                        value={filterValue}
                        onChange={(e) => {
                          setFilterValue(e.target.value);
                          resetSelection();
                        }}
                      >
                        <option value="">すべて</option>
                        {profiles
                          .find((p) => p.column === filterColumn)
                          ?.values.map((v) => (
                            <option value={v} key={v}>
                              {v}
                            </option>
                          ))}
                      </NativeSelect>
                    )}
                  </div>
                  <PersistentDetails
                    preferenceKey="dataset.mapping"
                    className="mapping-details divided"
                    id="dataset-mapping-details"
                  >
                    <summary id="dataset-mapping-summary">
                      サンプル名・試聴音声
                    </summary>
                    <div className="field">
                      <label htmlFor="id-column">サンプル名に使う列</label>
                      <NativeSelect
                        id="id-column"
                        value={idColumn}
                        onChange={(e) => setIdColumn(e.target.value)}
                      >
                        <option value="">行番号を使う</option>
                        {data.columns.map((c) => (
                          <option value={c} key={c}>
                            {c}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    <div className="field">
                      <label htmlFor="audio-column">
                        音声のファイル名・パス列
                      </label>
                      <NativeSelect
                        id="audio-column"
                        value={audioColumn}
                        onChange={(e) => setAudioColumn(e.target.value)}
                      >
                        <option value="">サンプル名とファイル名を対応</option>
                        {data.columns.map((c) => (
                          <option value={c} key={c}>
                            {c}
                          </option>
                        ))}
                      </NativeSelect>
                    </div>
                    <div className="audio-import-control">
                      <p>
                        {data.demo
                          ? '合成音を使用中'
                          : `原音対応 ${audioMatchCount.toLocaleString()} / ${data.rows.length.toLocaleString()}件`}
                      </p>
                      {!data.demo && (
                        <Button
                          variant="outline"
                          onClick={() => audioInput.current?.click()}
                        >
                          <FileAudio size={14} />
                          試聴用の音声を追加
                        </Button>
                      )}
                    </div>
                    <p>
                      試聴・スペクトログラム用です。音声なしでも分布を比較できます。
                    </p>
                  </PersistentDetails>
                </aside>
                <main
                  className="main-panel"
                  data-calculating={review.pending}
                  aria-busy={review.pending}
                >
                  <div className="page-heading">
                    <h1 title={active!.record.title}>{active!.record.title}</h1>
                    <span className="dataset-label">
                      元データ: {data.name} · {data.rows.length.toLocaleString()}件
                    </span>
                    <div className="analysis-identity" aria-label="分析の識別情報">
                      <span>
                        分析ID: <code>{active!.record.id}</code>
                      </span>
                      <span>
                        作成日時:{' '}
                        <time dateTime={active!.record.createdAt}>
                          {new Date(active!.record.createdAt).toLocaleString()}
                        </time>
                      </span>
                    </div>
                  </div>
                  <p className="analysis-use-boundary" role="note">
                    参考・探索分析。検査合否や運用しきい値の承認には使用しません。
                  </p>
                  <InspectorProvider>
                    <ScoreComparison
                      dataset={data}
                      scoreColumn={score}
                      columns={profiles
                        .filter(
                          (p) =>
                            p.numeric &&
                            p.column !== score &&
                            p.column !== idColumn &&
                            p.column !== audioColumn,
                        )
                        .map((p) => p.column)}
                      result={review.workerResult}
                    >
                      {({
                        column: comparisonColumn,
                        control: comparisonControl,
                      }) => (
                        <ContextWorkbench>
                          <section
                            className="analysis-stage"
                            id="analysis-overview"
                            tabIndex={-1}
                            aria-labelledby="score-distribution-heading"
                          >
                            <AnalysisProvenance
                              pending={review.pending}
                              error={error}
                              buildReport={() =>
                                buildAnalysisReport({
                                  data,
                                  record: active!.record,
                                  createdAt: new Date().toISOString(),
                                  comparisonScoreColumn: comparisonColumn,
                                  threshold: review.thresholdReport,
                                  precisionRecall: review.evaluation,
                                  review,
                                  score,
                                  group: effectiveGroup,
                                  filterColumn,
                                  filterValue,
                                  bins,
                                  idColumn,
                                  audioColumn,
                                  range,
                                  overlapOnly,
                                  query,
                                  queryMode,
                                  notes,
                                })
                              }
                            />
                            <section
                              className="metric-strip"
                              aria-label="比較群全体の記述統計"
                            >
                              <PrecisionRecallMetric
                                labelA={labelA}
                                labelB={labelB}
                                onExplain={() => setMethod(!method)}
                              />
                              <div className="metric">
                                <span>
                                  <i className="dot a" />
                                  群A
                                </span>
                                <strong>
                                  {d.nA.toLocaleString()}
                                  <em>件</em>
                                </strong>
                                {coverage.missingA > 0 && (
                                  <small className="missing-hint">
                                    欠測 {coverage.missingA}件
                                  </small>
                                )}
                              </div>
                              <div className="metric">
                                <span>
                                  <i className="dot b" />
                                  群B
                                </span>
                                <strong>
                                  {d.nB.toLocaleString()}
                                  <em>件</em>
                                </strong>
                                {coverage.missingB > 0 && (
                                  <small className="missing-hint">
                                    欠測 {coverage.missingB}件
                                  </small>
                                )}
                              </div>
                            </section>
                            {review.ignored.length > 0 && (
                              <div
                                className="manual-review-notice"
                                aria-live="polite"
                              >
                                <b>{review.ignored.length}件を手動で除外中。</b>{' '}
                                手動除外なし：
                                {review.baseline.total.toLocaleString()}
                                件・PR-AUC{' '}
                                {review.baseline.prAuc === null
                                  ? '算出不可'
                                  : review.baseline.prAuc.toFixed(3)}{' '}
                                → 現在：
                                {coverage.samples.length.toLocaleString()}
                                件・PR-AUC{' '}
                                {review.evaluation.auc === null
                                  ? '算出不可'
                                  : review.evaluation.auc.toFixed(3)}
                                <PersistentDetails preferenceKey="distribution.exclusion-impact">
                                  <summary>除外の影響</summary>
                                  <p>
                                    除外・復元で再集計し、仮しきい値を解除します。除外は性能改善の証明ではありません。
                                  </p>
                                </PersistentDetails>
                              </div>
                            )}
                            {method && (
                              <section className="methodology">
                                <Button
                                  className="close-method"
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label="指標の説明を閉じる"
                                  onClick={() => setMethod(false)}
                                >
                                  <X size={12} />
                                </Button>
                                <PrecisionRecallExplanation />
                              </section>
                            )}
                            <div className="sample-exploration">
                              <div className="analysis-grid">
                                <DistributionViewport
                                  source={data}
                                  scoreColumn={score}
                                  distribution={d}
                                  a={a}
                                  b={b}
                                  selectedScore={
                                    selectedExclusion
                                      ? null
                                      : (selectedSample?.score ?? null)
                                  }
                                >
                                  {(viewport) => (
                                    <section
                                      className="chart-panel"
                                      id="score-distribution"
                                      tabIndex={-1}
                                      aria-label="全体のスコア分布"
                                    >
                                      <div className="chart-heading">
                                        <div>
                                          <h2 id="score-distribution-heading">
                                            スコア分布 <code>{score}</code>
                                          </h2>
                                          <p>各群全体に対する割合 / bin (%)</p>
                                        </div>
                                        <div className="chart-view-controls">
                                          <label
                                            className="bins-control"
                                            htmlFor="bins"
                                          >
                                            <span>区間数</span>
                                            <NativeSelect
                                              id="bins"
                                              aria-label="ヒストグラムの区間数"
                                              value={bins}
                                              onChange={(e) =>
                                                setBins(Number(e.target.value))
                                              }
                                            >
                                              {[12, 24, 48, 96].map((n) => (
                                                <option value={n} key={n}>
                                                  {n} bins
                                                </option>
                                              ))}
                                            </NativeSelect>
                                          </label>
                                          {viewport.controls}
                                        </div>
                                      </div>
                                      <div className="distribution-toolbar">
                                        <div className="chart-legend">
                                          <span title={labelA}>
                                            <DistributionSymbol kind="a" />
                                            群A：
                                            {labelA.length > 22
                                              ? labelA.slice(0, 22) + '…'
                                              : labelA}
                                          </span>
                                          <span title={labelB}>
                                            <DistributionSymbol kind="b" />
                                            群B：
                                            {labelB.length > 22
                                              ? labelB.slice(0, 22) + '…'
                                              : labelB}
                                          </span>
                                          {
                                            <span>
                                              <DistributionSymbol kind="common" />
                                              共通部分
                                            </span>
                                          }
                                          {filterColumn && filterValue && (
                                            <span className="active-population">
                                              集計条件：{filterColumn} ={' '}
                                              {filterValue}
                                            </span>
                                          )}
                                        </div>
                                        <div className="distribution-tools">
                                          <InspectThresholdButton />
                                          <div className="distribution-range-control">
                                            <div className="range-selection-status">
                                              <output
                                                className="selection-status"
                                                htmlFor="range-lo range-hi"
                                              >
                                                {range ? (
                                                  <>
                                                    一覧範囲：
                                                    {formatScore(
                                                      range.lo,
                                                      6,
                                                    )} ≤
                                                    スコア{' '}
                                                    {range.includeHi
                                                      ? '≤'
                                                      : '<'}{' '}
                                                    {formatScore(range.hi, 6)}
                                                  </>
                                                ) : (
                                                  '一覧範囲：全スコア'
                                                )}
                                              </output>
                                              <Button
                                                variant="ghost"
                                                aria-label="範囲を解除"
                                                disabled={
                                                  !range && !overlapOnly
                                                }
                                                onClick={clearRange}
                                              >
                                                解除
                                              </Button>
                                            </div>
                                            <PersistentDetails
                                              preferenceKey="distribution.range"
                                              className="range-settings"
                                            >
                                              <summary>数値で指定</summary>
                                              <div className="range-settings-content">
                                                <div className="range-inputs">
                                                  <label htmlFor="range-lo">
                                                    確認範囲
                                                  </label>
                                                  <Input
                                                    id="range-lo"
                                                    aria-label="確認範囲の下限"
                                                    inputMode="decimal"
                                                    value={rangeLo}
                                                    placeholder={formatScore(
                                                      d.min,
                                                    )}
                                                    onChange={(e) =>
                                                      setRangeLo(e.target.value)
                                                    }
                                                  />
                                                  <span>—</span>
                                                  <Input
                                                    id="range-hi"
                                                    aria-label="確認範囲の上限"
                                                    inputMode="decimal"
                                                    value={rangeHi}
                                                    placeholder={formatScore(
                                                      d.max,
                                                    )}
                                                    onChange={(e) =>
                                                      setRangeHi(e.target.value)
                                                    }
                                                  />
                                                  <Button
                                                    variant="outline"
                                                    disabled={!!error}
                                                    onClick={() =>
                                                      applyRange(d)
                                                    }
                                                  >
                                                    範囲を適用
                                                  </Button>
                                                </div>
                                                <p>
                                                  選択範囲内をクリックで解除。それ以外のクリックで1ビン、ドラッグで複数ビン。Escでドラッグを取り消します。{' '}
                                                  数値入力は両端を含みます。範囲を変えても、全体のPR-AUC・仮しきい値は変わりません。
                                                </p>
                                              </div>
                                            </PersistentDetails>
                                          </div>
                                        </div>
                                      </div>
                                      {viewport.notice}
                                      <DistributionChart
                                        distribution={viewport.distribution}
                                        a={a}
                                        b={b}
                                        range={range}
                                        selectedScore={
                                          selectedExclusion
                                            ? null
                                            : (selectedSample?.score ?? null)
                                        }
                                        selectedGroup={
                                          selectedExclusion
                                            ? null
                                            : (selectedSample?.group ?? null)
                                        }
                                        onSelect={chooseRange}
                                        onClearRange={clearRange}
                                      />
                                    </section>
                                  )}
                                </DistributionViewport>
                              </div>
                              <section
                                className="inspect-section"
                                id="sample-inspection"
                                tabIndex={-1}
                                aria-labelledby="inspection-stage-heading"
                              >
                                <div className="inspect-heading">
                                  <div>
                                    <h2 id="inspection-stage-heading">
                                      サンプル一覧{' '}
                                      <span className="notes-count">
                                        {review.pending
                                          ? '再計算中'
                                          : review.listingTotal === null
                                            ? '件数未確定'
                                            : review.listingTotal.toLocaleString() +
                                              '件'}
                                      </span>
                                    </h2>
                                  </div>
                                  <div className="inspect-heading-actions">
                                    <Button
                                      variant="outline"
                                      disabled={
                                        !policy.downloads ||
                                        !visible.length ||
                                        !!error ||
                                        review.pending
                                      }
                                      title="現在の一覧のうち、除外行を含まないサンプルを書き出す"
                                      onClick={() => exportRows(visible)}
                                    >
                                      <Download size={12} />
                                      CSV
                                    </Button>
                                    <ThresholdExportButton
                                      disabled={
                                        !policy.downloads ||
                                        !!error ||
                                        review.pending
                                      }
                                      onExport={(threshold, precisionRecall) =>
                                        exportJSON(
                                          comparisonColumn,
                                          threshold,
                                          precisionRecall,
                                          review,
                                        )
                                      }
                                    />
                                  </div>
                                </div>
                                <SampleReviewControls
                                  review={review}
                                  dataset={data}
                                  idColumn={idColumn}
                                  onClearRange={clearRange}
                                  onClearSearch={() => setQuery('')}
                                  secondaryControl={comparisonControl}
                                  searchControl={
                                    <div
                                      className="sample-query-control"
                                    >
                                      <label htmlFor="sample-id-query">
                                        <span>
                                          サンプル検索
                                          <small>英字の大小を区別しません</small>
                                        </span>
                                        <Input
                                          id="sample-id-query"
                                          className="query-input"
                                          aria-label="サンプル名で検索"
                                          placeholder="名前で絞り込み…"
                                          value={query}
                                          onChange={(e) =>
                                            setQuery(e.target.value)
                                          }
                                        />
                                      </label>
                                      <label htmlFor="sample-query-mode">
                                        <span>一致方法</span>
                                        <NativeSelect
                                          id="sample-query-mode"
                                          aria-label="検索一致方法"
                                          value={queryMode}
                                          onChange={(e) =>
                                            setQueryMode(
                                              e.target.value as
                                                | 'partial'
                                                | 'exact',
                                            )
                                          }
                                        >
                                          <option value="partial">
                                            部分一致（含む）
                                          </option>
                                          <option value="exact">
                                            完全一致
                                          </option>
                                        </NativeSelect>
                                      </label>
                                    </div>
                                  }
                                />
                                <div
                                  className="listing-scope-summary"
                                  aria-live="polite"
                                >
                                  {review.pending ? (
                                    '件数を再計算中です。計算対象全体と一覧表示は未確定です。'
                                  ) : review.calculationTotal === null ||
                                    review.listingTotal === null ? (
                                    '件数を算出できません。再計算してください。'
                                  ) : (
                                    <>
                                      計算対象全体{' '}
                                      <b>
                                        {review.calculationTotal.toLocaleString()}
                                      </b>
                                      件 / 一覧表示{' '}
                                      <b>
                                        {review.listingTotal.toLocaleString()}
                                      </b>
                                      件
                                      {!!review.listingIgnoredTotal && (
                                        <>
                                          {' '}
                                          （除外{' '}
                                          <b>
                                            {review.listingIgnoredTotal.toLocaleString()}
                                          </b>
                                          件を含む）
                                        </>
                                      )}
                                    </>
                                  )}
                                </div>
                                <div className="inspection-list-navigation">
                                  <InspectSelectedSampleButton
                                    disabled={!selectedSample}
                                  />
                                </div>
                                <div className="inspection-grid">
                                  <SampleTable
                                    pending={review.pending}
                                    samples={review.listed}
                                    idColumn={idColumn}
                                    scoreColumn={score}
                                    comparisonColumn={comparisonColumn}
                                    groupColumn={group.column}
                                    selectedSample={selectedSample}
                                    onSelect={selectSample}
                                    hasAudio={hasAudio}
                                    notes={notes}
                                    ignoredIndices={review.ignoredIndices}
                                    onRestore={review.restore}
                                  />
                                </div>
                              </section>
                            </div>
                            <PersistentDetails
                              preferenceKey="distribution.coverage"
                              className="coverage-details"
                            >
                              <summary>
                                集計対象の内訳・欠測{' '}
                                <span>
                                  {review.pending ? (
                                    '再計算中（件数未確定）'
                                  ) : (
                                    <>
                                      有効{' '}
                                      {coverage.samples.length.toLocaleString()}
                                      件 / スコア欠測{' '}
                                      {(
                                        coverage.missingA + coverage.missingB
                                      ).toLocaleString()}
                                      件 / 手動除外{' '}
                                      {coverage.ignoredRows.toLocaleString()}件
                                    </>
                                  )}
                                </span>
                              </summary>
                              {review.pending ? (
                                <p className="coverage-pending">
                                  現在の集計対象と欠測件数を再計算しています。
                                  前の結果の件数は確定値ではありません。
                                </p>
                              ) : (
                                <>
                              <div className="coverage-row">
                                <span>
                                  中央値 群A {formatScore(d.medianA)} / 群B{' '}
                                  {formatScore(d.medianB)}
                                </span>
                                <span>
                                  比較対象{' '}
                                  <b>
                                    {coverage.samples.length.toLocaleString()}
                                  </b>
                                  件
                                </span>
                                <span>
                                  群分けの欠測・非数値{' '}
                                  <b>
                                    {coverage.missingGroup.toLocaleString()}
                                  </b>
                                  件
                                </span>
                                <span>
                                  指定群以外・中間値{' '}
                                  <b>{coverage.otherGroup.toLocaleString()}</b>
                                  件
                                </span>
                                <span>
                                  絞り込みで除外{' '}
                                  <b>
                                    {coverage.outsideFilter.toLocaleString()}
                                  </b>
                                  件
                                </span>
                                <span>
                                  手動除外（全データ）{' '}
                                  <b>{coverage.ignoredRows.toLocaleString()}</b>
                                  件
                                </span>
                              </div>
                              <div className="notice">
                                <Info size={15} />
                                <p>
                                  {data.demo
                                    ? '合成データによるデモです。 '
                                    : ''}
                                  選択した2群のスコア分布を比較します。群分けの正しさや、検査の合否性能を判定するものではありません。
                                </p>
                              </div>
                                </>
                              )}
                            </PersistentDetails>
                          </section>

                          <ContextInspector
                            sampleIdentity={
                              selectedSample
                                ? {
                                    label: sampleLabel(selectedSample),
                                    group: selectedSample.group,
                                    excluded: !!selectedExclusion,
                                  }
                                : null
                            }
                            threshold={
                              <ThresholdPanel
                                a={a}
                                b={b}
                                labelA={labelA}
                                labelB={labelB}
                                missingA={coverage.missingA}
                                missingB={coverage.missingB}
                                disabled={!!error}
                              />
                            }
                            sample={
                              selectedSample ? (
                                <AudioInspector
                                  key={
                                    datasetSession + '-' + selectedSample.index
                                  }
                                  sample={selectedSample}
                                  inCurrentList={review.listed.some(
                                    (sample) =>
                                      sample.index === selectedSample.index,
                                  )}
                                  excluded={!!selectedExclusion}
                                  label={sampleLabel(selectedSample)}
                                  scoreColumn={score}
                                  comparisonColumn={comparisonColumn}
                                  demo={data.demo}
                                  file={selectedAudioFile}
                                  audioResolution={selectedAudioResolution}
                                  onOpenAudioSettings={openAudioSettings}
                                  onAnalysis={(metadata) => {
                                    const sessionId = datasetSession;
                                    if (
                                      controller.getSnapshot().active?.record
                                        .id !== sessionId
                                    )
                                      return;
                                    const entry = {
                                      ...metadata,
                                      sourceName:
                                        selectedAudioFile?.name ??
                                        `demo-${selectedSample.index}.wav`,
                                    };
                                    controller.setState(
                                      'audioAnalyses',
                                      (previous: unknown) => {
                                        const values = (previous ??
                                          {}) as Record<string, unknown>;
                                        return JSON.stringify(
                                          values[selectedSample.index],
                                        ) === JSON.stringify(entry)
                                          ? values
                                          : {
                                              ...values,
                                              [selectedSample.index]: entry,
                                            };
                                      },
                                      {},
                                    );
                                  }}
                                  reviewAction={
                                    <IgnoreSampleAction
                                      sample={selectedSample}
                                      ignored={selectedExclusion}
                                      onIgnore={(sample, reason) => {
                                        selectSample(sample);
                                        review.ignore(sample, reason);
                                      }}
                                    />
                                  }
                                  note={notes[selectedSample.index] ?? ''}
                                  onNote={(value) =>
                                    setNotes((prev) => ({
                                      ...prev,
                                      [selectedSample.index]: value,
                                    }))
                                  }
                                />
                              ) : (
                                <div className="empty-inspector">
                                  サンプルを選ぶと音声とメモが表示されます。
                                </div>
                              )
                            }
                          />
                        </ContextWorkbench>
                      )}
                    </ScoreComparison>
                  </InspectorProvider>
                  <footer className="app-footer">
                    <span>
                      <ShieldCheck size={11} />
                      端末内処理 · バックアップで再開可能
                    </span>
                    <span>ASD Insight</span>
                  </footer>
                </main>
              </>
            );
          }}
        </SampleReviewWorkspace>
      </div>
    </div>
  );
}
