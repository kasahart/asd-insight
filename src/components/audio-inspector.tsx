'use client';
import {
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { FileAudio, Volume2 } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { ScoreValue } from '@/components/score-comparison';
import { SampleSpectrogram } from '@/components/sample-spectrogram';
import { usePlaybackGain } from '@/components/use-playback-gain';
import { useInspector } from '@/components/context-inspector';
import {
  PersistentDetails,
  useViewPreferences,
} from '@/components/view-preferences';
import { demoWave, wavBuffer } from '@/lib/audio';
import type { AudioResolution, Sample } from '@/lib/data';
import { analyzeWav } from '@audio/client';
import type { AudioAnalysis, AudioPhase } from '@audio/contracts';
import {
  MAX_PLAYBACK_GAIN_DB,
  normalizePlaybackGain,
} from '@/lib/playback-gain';

type AudioInfo = { url: string; recording: Blob };
function audioResolutionMessage(
  resolution: AudioResolution<File> | undefined,
): string {
  if (!resolution) return '対応する音声ファイルがありません。';
  if (resolution.reason === 'no-files')
    return '音声ファイルが追加されていません。';
  if (resolution.reason === 'audio-column-empty')
    return `音声列「${resolution.sourceColumn}」のこの行は空欄です。`;
  if (resolution.reason === 'source-id-empty')
    return 'サンプル名の元IDが空欄で、対応するファイル名を決められません。';
  if (resolution.reason === 'name-mismatch') {
    const names = resolution.expectedNames.slice(0, 3).join('、');
    const suffix = resolution.expectedNames.length > 3 ? 'など' : '';
    return names
      ? `追加済み音声に対応するファイル名がありません（期待：${names}${suffix}）。`
      : '追加済み音声に対応するファイル名がありません。';
  }
  return '対応する音声ファイルがありません。';
}
export function AudioInspector({
  sample,
  label,
  scoreColumn,
  comparisonColumn,
  demo,
  file,
  audioResolution,
  sourceDescription,
  note,
  onNote,
  onAnalysis,
  onOpenAudioSettings,
  reviewAction,
  excluded = false,
  inCurrentList = true,
}: {
  sample: Sample;
  label: string;
  scoreColumn: string;
  comparisonColumn: string;
  demo: boolean;
  file?: File;
  audioResolution?: AudioResolution<File>;
  sourceDescription?: string;
  note: string;
  onNote: (value: string) => void;
  onAnalysis?: (
    result: Pick<
      AudioAnalysis,
      | 'sampleRate'
      | 'channels'
      | 'duration'
      | 'recipe'
      | 'runtimeLockHash'
      | 'sourceHash'
    >,
  ) => void;
  onOpenAudioSettings?: () => void;
  reviewAction?: ReactNode;
  excluded?: boolean;
  inCurrentList?: boolean;
}) {
  const { target, setPlayingLabel } = useInspector();
  const { audio: audioPreferences, updateAudio } = useViewPreferences();
  // Identity is checked during render as well as after asynchronous work. Even
  // a replacement file on the same row must never display the previous audio.
  const source = useMemo(
    () => ({ index: sample.index, row: sample.row, demo, file }),
    [sample.index, sample.row, demo, file],
  );
  const currentSource = useRef(source);
  const analysisCallback = useRef(onAnalysis);
  useLayoutEffect(() => {
    currentSource.current = source;
    analysisCallback.current = onAnalysis;
  }, [source, onAnalysis]);
  const [loaded, setLoaded] = useState<{
    source: typeof source;
    info: AudioInfo | null;
    error: string;
  } | null>(null);
  const [playback, setPlayback] = useState<{
    source: typeof source;
    time: number;
  } | null>(null);
  const current = loaded?.source === source ? loaded : null;
  const info = current?.info ?? null;
  const error = current?.error ?? '';
  const loading = Boolean((demo || file) && !current);
  const [requestedSource, setRequestedSource] = useState<typeof source | null>(
    null,
  );
  const [attempt, setAttempt] = useState(0);
  const [analysis, setAnalysis] = useState<{
    source: typeof source;
    result: AudioAnalysis | null;
    phase: AudioPhase;
    error: string;
  } | null>(null);
  const currentAnalysis = analysis?.source === source ? analysis : null;
  const result = currentAnalysis?.result ?? null;
  const currentTime = playback?.source === source ? playback.time : 0;
  const gainDb = normalizePlaybackGain(audioPreferences.gainDb);
  const audioRef = useRef<HTMLAudioElement>(null);
  const {
    ref: gainRef,
    activate: activateGain,
    status: gainStatus,
  } = usePlaybackGain(gainDb);
  const attachAudio = useCallback(
    (node: HTMLAudioElement | null) => {
      audioRef.current = node;
      gainRef(node);
    },
    [gainRef],
  );
  function changeGain(next: number) {
    const gainDb = normalizePlaybackGain(next);
    activateGain(gainDb);
    updateAudio({ gainDb });
  }
  useEffect(() => () => setPlayingLabel(null), [source, setPlayingLabel]);
  useEffect(() => {
    let live = true;
    let url = '';
    void Promise.resolve().then(() => {
      if (!live) return;
      setLoaded(null);
      setPlayback(null);
      setAnalysis(null);
      try {
        if (!demo && !file) return;
        if (file && file.size > 80 * 1024 * 1024)
          throw new Error('音声プレビューは1ファイル80MBまでです。');
        let recording: Blob;
        if (demo) {
          const { samples, rate } = demoWave(
            sample.index,
            sample.row.cohort === '比較群',
            sample.row.condition === '背景音あり',
          );
          recording = new Blob([wavBuffer(samples, rate)], {
            type: 'audio/wav',
          });
        } else recording = file!;
        url = URL.createObjectURL(recording);
        setLoaded({ source, info: { url, recording }, error: '' });
      } catch (error) {
        setLoaded({
          source,
          info: null,
          error:
            error instanceof Error
              ? error.message
              : '音声を読み込めませんでした。',
        });
      }
    });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [source, sample.index, sample.row, demo, file]);
  // Start the large runtime only after opening sample details. Once started,
  // switching to threshold controls leaves this sample's analysis intact.
  if (target === 'sample' && requestedSource !== source)
    setRequestedSource(source);
  useEffect(() => {
    if (!info || requestedSource !== source) return;
    const controller = new AbortController();
    void Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        setAnalysis({ source, result: null, phase: 'initializing', error: '' });
        return info.recording.arrayBuffer();
      })
      .then((bytes) => {
        controller.signal.throwIfAborted();
        return analyzeWav(bytes, {
          signal: controller.signal,
          onPhase: (phase) => {
            if (!controller.signal.aborted && currentSource.current === source)
              setAnalysis({ source, result: null, phase, error: '' });
          },
        });
      })
      .then((result) => {
        if (controller.signal.aborted || currentSource.current !== source)
          return;
        setAnalysis({ source, result, phase: 'analyzing', error: '' });
        const {
          sampleRate,
          channels,
          duration,
          recipe,
          runtimeLockHash,
          sourceHash,
        } = result;
        analysisCallback.current?.({
          sampleRate,
          channels,
          duration,
          recipe,
          runtimeLockHash,
          sourceHash,
        });
      })
      .catch((error) => {
        if (!controller.signal.aborted && currentSource.current === source)
          setAnalysis({
            source,
            result: null,
            phase: 'analyzing',
            error:
              error instanceof Error
                ? error.message
                : '音声解析に失敗しました。',
          });
      });
    return () => controller.abort();
  }, [source, info, requestedSource, attempt]);
  return (
    <aside
      className="audio-panel"
      id="sample-audio"
      tabIndex={-1}
      aria-labelledby="audio-heading"
    >
      <div className="audio-heading">
        <Volume2 size={15} />
        <h3 id="audio-heading">音声</h3>
      </div>
      {(!inCurrentList || excluded) && (
        <p className="audio-selection-link">
          {excluded ? '除外中・分布表示なし' : '一覧の絞り込み外'}
        </p>
      )}
      {demo && (
        <p className="small-muted">デモ合成音・実際の機械音ではありません</p>
      )}
      {sourceDescription && (
        <p className="small-muted audio-source-description">
          {sourceDescription}
        </p>
      )}
      {loading && <div className="audio-empty">音声を読み込んでいます…</div>}
      {!loading && !info && !error && (
        <div className="audio-empty">
          <FileAudio size={23} />
          <p>対応する音声がありません</p>
          <small>{audioResolutionMessage(audioResolution)}</small>
          {onOpenAudioSettings && (
            <Button
              variant="outline"
              size="sm"
              onClick={onOpenAudioSettings}
            >
              サンプル名・試聴音声の設定を開く
            </Button>
          )}
        </div>
      )}
      {error && (
        <p className="inline-error" role="alert">
          音声処理エラー：{error}
        </p>
      )}
      {info && (
        <>
          {/* Machine sounds have no spoken transcript; the sample is identified next to its controls. */}
          {/* oxlint-disable-next-line jsx-a11y/media-has-caption */}
          <audio
            ref={attachAudio}
            aria-label={label + ' の原音'}
            controls
            preload="metadata"
            src={info.url}
            onPlay={() => {
              activateGain();
              setPlayingLabel(label);
            }}
            onPointerDown={() => activateGain()}
            onKeyDown={() => activateGain()}
            onPause={() => setPlayingLabel(null)}
            onEnded={() => setPlayingLabel(null)}
            onTimeUpdate={(event) =>
              setPlayback({ source, time: event.currentTarget.currentTime })
            }
            onSeeked={(event) =>
              setPlayback({ source, time: event.currentTarget.currentTime })
            }
            onLoadedMetadata={() => {
              const player = audioRef.current;
              if (!player) return;
              player.volume = audioPreferences.volume;
              player.muted = audioPreferences.muted;
              player.playbackRate = audioPreferences.playbackRate;
            }}
            onVolumeChange={(event) =>
              updateAudio({
                volume: event.currentTarget.volume,
                muted: event.currentTarget.muted,
              })
            }
            onRateChange={(event) =>
              updateAudio({ playbackRate: event.currentTarget.playbackRate })
            }
            onError={() =>
              setLoaded((previous) =>
                previous?.source === source
                  ? {
                      ...previous,
                      error:
                        'この音声形式をブラウザーで再生できません。WAVなどで再度お試しください。',
                    }
                  : previous,
              )
            }
          />
          <div className="audio-gain-control">
            <div className="audio-gain-heading">
              <label htmlFor="sample-playback-gain">再生ゲイン</label>
              <output htmlFor="sample-playback-gain">
                {gainDb > 0 ? '+' : ''}
                {gainDb} dB
              </output>
            </div>
            <div className="audio-gain-adjustment">
              <input
                id="sample-playback-gain"
                type="range"
                min={0}
                max={MAX_PLAYBACK_GAIN_DB}
                step={1}
                value={gainDb}
                aria-valuetext={`${gainDb > 0 ? '+' : ''}${gainDb} dB`}
                aria-describedby="sample-gain-help"
                onChange={(event) => changeGain(Number(event.target.value))}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={gainDb === 0}
                onClick={() => changeGain(0)}
              >
                0 dBに戻す
              </Button>
            </div>
            <p id="sample-gain-help">再生のみ · 大音量・音割れに注意</p>
            {gainStatus?.message && (
              <p
                className={
                  gainStatus.state === 'unavailable'
                    ? 'audio-gain-warning'
                    : undefined
                }
                role={gainStatus.state === 'unavailable' ? 'alert' : 'status'}
              >
                {gainStatus.message}
              </p>
            )}
          </div>
          <SampleSpectrogram
            data={result?.spectrogram ?? null}
            phase={currentAnalysis?.phase ?? 'initializing'}
            error={currentAnalysis?.error}
            onRetry={() => setAttempt((value) => value + 1)}
            label={label}
            currentTime={currentTime}
          />
        </>
      )}
      <div className="sample-note-section">
        <label className="note-label" htmlFor="sample-note">
          調査メモ
        </label>
        <Textarea
          id="sample-note"
          value={note}
          onChange={(e) => onNote(e.target.value)}
          placeholder="気づいたこと、次に確認したいこと…"
          maxLength={4000}
        />
        <p className="small-muted note-warning">分析に保存</p>
      </div>
      <dl
        className="sample-score-pair"
        data-comparison={comparisonColumn ? 'true' : undefined}
        aria-label="同じサンプルの評価値"
      >
        <div>
          <dt>
            <small>分布のスコア</small>
            {scoreColumn}
          </dt>
          <dd>
            <ScoreValue value={sample.score} />
          </dd>
        </div>
        {comparisonColumn && (
          <div>
            <dt>
              <small>比較用・表示のみ</small>
              {comparisonColumn}
            </dt>
            <dd>
              <ScoreValue value={sample.row[comparisonColumn]} />
            </dd>
          </div>
        )}
      </dl>
      {result && (
        <PersistentDetails
          preferenceKey="sample.waveform"
          className="sample-audio-details"
        >
          <summary>波形・音声情報</summary>
          <div className="waveform">
            <svg
              viewBox="0 0 360 82"
              aria-label="原音のch1波形、振幅はマイナス1から1"
            >
              <title>原音のch1波形、振幅はマイナス1から1</title>
              <line
                x1="0"
                x2="360"
                y1="41"
                y2="41"
                stroke="var(--subtle-border, #293744)"
              />
              {result.wave.map((w, i) => (
                <line
                  key={i}
                  x1={(i * 360) / result.wave.length}
                  x2={(i * 360) / result.wave.length}
                  y1={41 - w.max * 37}
                  y2={41 - w.min * 37}
                  stroke="var(--cohort-a, #64d6bf)"
                  strokeWidth="1"
                />
              ))}
            </svg>
          </div>
          <div className="wave-caption">
            <span>波形 ch1・振幅 ±1</span>
            <span>
              {result.duration > 0 ? result.duration.toFixed(2) + ' s' : ''}
            </span>
          </div>
          <p className="small-muted">
            {result.sampleRate
              ? result.sampleRate.toLocaleString() +
                ' Hz（原音）/ ' +
                result.channels +
                ' ch ・原音を全chで再生'
              : ''}
          </p>
        </PersistentDetails>
      )}
      <PersistentDetails
        preferenceKey="sample.attributes"
        className="sample-attributes"
      >
        <summary>
          サンプルの属性 <span>{Object.keys(sample.row).length}列</span>
        </summary>
        <p>元データの列名と値です。属性からの原因推定は行いません。</p>
        <dl aria-label="サンプルの元データの列と値">
          {Object.entries(sample.row).map(([column, value], index) => (
            <div key={column}>
              <dt id={'sample-attribute-' + index}>{column}</dt>
              <dd aria-labelledby={'sample-attribute-' + index}>
                {value === '' ? (
                  <span className="attribute-empty">（空欄）</span>
                ) : value.trim() === '' ? (
                  <>
                    {value}
                    <span className="attribute-empty">
                      （空白・改行のみ：{value.length}文字）
                    </span>
                  </>
                ) : (
                  value
                )}
              </dd>
            </div>
          ))}
        </dl>
      </PersistentDetails>
      {reviewAction}
    </aside>
  );
}
