'use client';
import { useSessionState } from '@/state/workspace-context';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DistributionSymbol } from '@/components/distribution-symbol';
import { useThreshold } from '@/components/threshold-context';
import { formatNumber, formatScore } from '@/lib/distribution';

type InspectorTarget = 'threshold' | 'sample';
type InspectorState = {
  target: InspectorTarget;
  inspect: (target: InspectorTarget, options?: { focus?: boolean }) => void;
  playingLabel: string | null;
  setPlayingLabel: (label: string | null) => void;
};
const InspectorContext = createContext<InspectorState | null>(null);

export function InspectorProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useSessionState('inspectorSelection', {
    target: 'threshold' as InspectorTarget,
    focus: false,
  });
  const [playingLabel, setPlayingLabel] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<{
    target: InspectorTarget;
  } | null>(null);
  const inspect = useCallback(
    (target: InspectorTarget, options?: { focus?: boolean }) => {
      // Only an explicit selection changes the inspector. Data recalculations
      // and changes in candidate counts must not switch panels or steal focus.
      setSelection({ target, focus: false });
      // Focus is an event, not a saved preference to replay when reopening an analysis.
      setFocusRequest(options?.focus ? { target } : null);
    },
    [setSelection],
  );
  useEffect(() => {
    if (!focusRequest) return;
    const control = document.getElementById(
      focusRequest.target === 'threshold' ? 'threshold-target' : 'sample-audio',
    );
    control?.scrollIntoView({ block: 'nearest' });
    control?.focus({ preventScroll: true });
  }, [focusRequest]);
  const value = useMemo(
    () => ({
      target: selection.target,
      inspect,
      playingLabel,
      setPlayingLabel,
    }),
    [selection.target, inspect, playingLabel],
  );
  return (
    <InspectorContext.Provider value={value}>
      {children}
    </InspectorContext.Provider>
  );
}

export function useInspector() {
  const value = useContext(InspectorContext);
  if (!value) throw new Error('詳細パネルの設定領域がありません。');
  return value;
}

export function ContextInspector({
  threshold,
  sample,
  sampleIdentity,
}: {
  threshold: ReactNode;
  sample: ReactNode;
  sampleIdentity: { label: string; group: 'A' | 'B'; excluded: boolean } | null;
}) {
  const { target, inspect, playingLabel } = useInspector();
  return (
    <aside
      className="context-inspector"
      aria-label={
        target === 'threshold' ? '分布のしきい値設定' : '選択サンプルの詳細'
      }
      data-target={target}
    >
      <div className="inspector-header">
        <div
          className="inspector-switch"
          aria-label="操作パネルに対応するビュー"
        >
          <Button
            variant="ghost"
            aria-label="分布のしきい値設定"
            aria-pressed={target === 'threshold'}
            aria-controls="threshold-inspector-content"
            data-view="threshold"
            onClick={() => inspect('threshold')}
          >
            <DistributionSymbol kind="threshold" size={16} />
            分布のしきい値
          </Button>
          <Button
            variant="ghost"
            aria-label="サンプル詳細"
            aria-pressed={target === 'sample'}
            aria-controls="sample-inspector-content"
            data-view="sample"
            onClick={() => inspect('sample')}
          >
            <DistributionSymbol kind="sample" size={16} />
            サンプル詳細
          </Button>
        </div>
        {target === 'sample' && sampleIdentity && (
          <div
            className="inspector-sample-identity"
            aria-label="選択中のサンプル名"
          >
            <div className="inspector-sample-navigation">
              <span
                className={'sample-tag ' + sampleIdentity.group.toLowerCase()}
              >
                群{sampleIdentity.group}
              </span>
              {sampleIdentity.excluded && (
                <span className="scope-badge is-warning">除外中</span>
              )}
              <a
                className="sample-distribution-link"
                href="#score-distribution"
              >
                {sampleIdentity.excluded ? '分布へ戻る ↑' : '分布上の位置へ ↑'}
              </a>
            </div>
            <strong className="audio-sample-id" title={sampleIdentity.label}>
              {sampleIdentity.label}
            </strong>
          </div>
        )}
        {playingLabel && target !== 'sample' && (
          <button
            className="inspector-playing"
            onClick={() => inspect('sample')}
            title={playingLabel}
          >
            <Volume2 size={13} />
            再生中：{playingLabel} · 音声へ
          </button>
        )}
      </div>
      {/* Keep both subtrees mounted: hiding details must not interrupt audio,
          discard an unfinished exclusion reason, or reset rate entry. */}
      <div
        id="threshold-inspector-content"
        className="inspector-content"
        hidden={target !== 'threshold'}
      >
        {threshold}
      </div>
      <div
        id="sample-inspector-content"
        className="inspector-content"
        hidden={target !== 'sample'}
      >
        {sample}
      </div>
    </aside>
  );
}

export function InspectThresholdButton() {
  const { target, inspect } = useInspector();
  const {
    report,
    pending,
    operationRule,
    selection,
    okGroup,
    okGroupLabel,
  } = useThreshold();
  const rule = report?.calibration.rule ?? operationRule;
  const operator = rule
    ? { gt: '>', gte: '≥', lt: '<', lte: '≤' }[rule.operator]
    : '';
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
  const buttonLabel = rule
    ? '分布のしきい値設定を開く（探索用の仮しきい値 ' +
      operator +
      ' ' +
      formatScore(rule.threshold, 6) +
      '）'
    : '分布のしきい値設定を開く（探索用の仮しきい値は未設定）';
  return (
    <div className="distribution-threshold-summary">
      <Button
        variant="outline"
        aria-label={buttonLabel}
        aria-pressed={target === 'threshold'}
        aria-controls="threshold-inspector-content"
        onClick={() => inspect('threshold', { focus: true })}
      >
        <DistributionSymbol kind="threshold" size={16} />
        {rule
          ? `探索用の仮しきい値 ${operator} ${formatScore(rule.threshold, 6)}`
          : '探索用の仮しきい値を設定'}
      </Button>
      <div className="distribution-threshold-context" aria-live="polite">
        <span>探索用の仮しきい値</span>
        <span>
          {pending
            ? !selection
              ? '再計算中（仮しきい値は未設定、結果未確定）'
              : selection.kind === 'manual'
                ? '再計算中（手動調整・率の上限なし、結果未確定）'
                : '再計算中（率から設定・指定上限 ' +
                  selection.targetPercent +
                  '%、結果未確定）'
            : report?.calibration.method === 'manual' ||
                selection?.kind === 'manual'
              ? '手動調整・率の上限なし'
              : report
                ? `率から設定・指定上限 ${report.calibration.targetPercent}%`
                : '未設定（候補ボタンは1%で仮設定）'}
        </span>
        <span>
          OK基準：群{okGroup}
          {okGroupLabel ? `（${okGroupLabel}）` : ''}
        </span>
      </div>
      {!pending && ok && other && (
        <div className="distribution-threshold-rates">
          <span>
            OK基準群のNG候補 <b>{formatNumber(ok.detectedPercent, 3)}%</b>{' '}
            <small>
              {ok.detected.toLocaleString()} / {ok.total.toLocaleString()}件
            </small>
          </span>
          <span>
            反対群の未検出率 <b>{formatNumber(other.notDetectedPercent, 3)}%</b>{' '}
            <small>
              {other.notDetected.toLocaleString()} /{' '}
              {other.total.toLocaleString()}件
            </small>
          </span>
        </div>
      )}
    </div>
  );
}

export function InspectSampleButton({ children }: { children: ReactNode }) {
  const { inspect } = useInspector();
  return (
    <button
      className="inspect-selected-sample"
      aria-label="選択中のサンプル詳細を開く"
      aria-controls="sample-inspector-content"
      onClick={() => inspect('sample')}
    >
      {children}
    </button>
  );
}

export function InspectSelectedSampleButton({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const { inspect } = useInspector();
  return (
    <Button
      variant="outline"
      disabled={disabled}
      aria-controls="sample-inspector-content"
      onClick={() => inspect('sample', { focus: true })}
    >
      選択サンプルの詳細へ
    </Button>
  );
}
