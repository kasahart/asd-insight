import { useEffect, useMemo, useRef, useState } from 'react';
import { Database, FileUp, FlaskConical, X, Trash2 } from 'lucide-react';
import { audioPopulation } from '@domain/audio-population';
import { MAX_FOLDER_LEVELS, folderAttributeCandidates } from '@domain/audio-import';
import { addAudioAttachments } from '@/lib/audio-attachments';
import { readWavDirectory } from '@/lib/read-wav-directory';
import { AudioPopulationNotice } from './audio-population-notice';
import { NativeSelect } from './ui/native-select';
import { EvaluationWorkerClient } from '@domain/evaluation-client';
import { useWorkspace } from '@/state/workspace-context';
import { createDatasetCandidate, initialWorkspaceState, readCSVCandidate, type DatasetCandidate } from '@/lib/dataset-import';
import { demoDataset } from '@/lib/demo';
import { Button } from './ui/button';
import { CsvFormatGuide } from './csv-format-guide';
import { CsvImportError } from './csv-import-error';
import { useDatasetImport } from './use-dataset-import';
import { downloadBlob } from './production-app';

export function SessionManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { controller, policy, active, sessions, status, conflict, error, pendingResume } = useWorkspace();
  const dialog = useRef<HTMLDialogElement>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const bundleInput = useRef<HTMLInputElement>(null);
  const [tab, setTab] = useState<'saved'|'audio'|'csv'|'demo'>(sessions.length ? 'saved' : 'audio');
  const [busy, setBusy] = useState('');
  const locked = useRef(false);
  const [message, setMessage] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [reference, setReference] = useState(false);
  const importer = useDatasetImport();
  const initialFolderInput = useRef<HTMLInputElement>(null);
  const [initialAudio, setInitialAudio] = useState(new Map<string, File>());
  const initialAudioBytes = useMemo(() => [...initialAudio.values()].reduce((total, file) => total + file.size, 0), [initialAudio]);
  const [showAudioReview, setShowAudioReview] = useState(false);
  const [readingFolder, setReadingFolder] = useState(false);
  const folderRequest = useRef<AbortController | null>(null);
  const [mapping, setMapping] = useState<{ candidate: DatasetCandidate; idColumn: string; audioColumn: string } | null>(null);
  const candidate = importer.csvCandidate;
  const mappedCandidate = useMemo(() => candidate && mapping?.candidate === candidate ? { ...candidate, setup: { ...candidate.setup, idColumn: mapping.idColumn, audioColumn: mapping.audioColumn } } : candidate, [candidate, mapping]);
  const joined = useMemo(() => mappedCandidate ? audioPopulation(mappedCandidate.dataset, mappedCandidate.setup.idColumn, mappedCandidate.setup.audioColumn, initialAudio) : null, [mappedCandidate, initialAudio]);
  function cancelFolder() { folderRequest.current?.abort(); folderRequest.current = null; setReadingFolder(false); }
  useEffect(() => () => folderRequest.current?.abort(), []);
  function acceptInitialAudio(files: Iterable<File>) {
    const selected = addAudioAttachments(new Map<string, File>(), Array.from(files).filter(file => /\.wav$/i.test(file.name)));
    if (!selected.size) throw new Error('選択したフォルダにWAVがありません。');
    if (folderAttributeCandidates(selected).length > MAX_FOLDER_LEVELS) throw new Error(`WAVフォルダ階層は${MAX_FOLDER_LEVELS}階層までです。`);
    setInitialAudio(selected); setShowAudioReview(false); setMessage('');
  }
  async function chooseInitialFolder() {
    cancelFolder();
    const picker = (window as Window & { showDirectoryPicker?: (options: { mode: 'read' }) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (!picker) { initialFolderInput.current?.click(); return; }
    const request = new AbortController(); folderRequest.current = request;
    try {
      const directory = await picker.call(window, { mode: 'read' });
      request.signal.throwIfAborted(); setReadingFolder(true);
      const files = await readWavDirectory(directory, request.signal);
      if (folderRequest.current === request) acceptInitialAudio(files);
    } catch (error) {
      if (folderRequest.current === request && !request.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) setMessage(error instanceof Error ? error.message : '音源を選択できませんでした。');
    } finally { if (folderRequest.current === request) { folderRequest.current = null; setReadingFolder(false); } }
  }
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open && dialog.current?.open) dialog.current.close();
  }, [open]);
  function close() { if (locked.current) return; cancelFolder(); importer.reset(); setInitialAudio(new Map()); setShowAudioReview(false); setMapping(null); dialog.current?.close(); onClose(); }
  async function run(label: string, action: () => Promise<void>, finish = false) {
    if (locked.current) return;
    locked.current = true; setBusy(label); setMessage('');
    try { await action(); if (finish && !controller.getSnapshot().pendingResume) { dialog.current?.close(); onClose(); } }
    catch (error) { setMessage(error instanceof Error ? error.message : '操作を完了できませんでした。'); }
    finally { locked.current = false; setBusy(''); }
  }
  async function create(candidate: DatasetCandidate, audioFiles?: Map<string, File>) {
    // A new dataset always gets a new workspace identity, even for the same filename/content.
    const view = active?.record.state ?? {};
    const state = initialWorkspaceState(candidate);
    for (const key of ['disclosures','audioPreferences','inspectorWidth','spectrogramPreferences']) if (view[key] !== undefined) state[key] = view[key];
    await controller.create({ title: candidate.dataset.name, dataset: candidate.dataset, source: candidate.source, state, ...(audioFiles ? { audioFiles } : {}) }, reference && !candidate.dataset.demo);
  }
  const disabled = !!busy || !!importer.busy || readingFolder;
  return <dialog ref={dialog} className="data-source-dialog" aria-labelledby="data-source-title" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="data-source-frame">
      <header className="data-source-header"><div><h2 id="data-source-title">データと保存した分析</h2><p className="data-source-current">{active?.record.title ?? 'データを選んで開始'}</p></div><Button variant="ghost" size="icon" disabled={!!busy} aria-label="データ選択を閉じる" onClick={close}><X/></Button></header>
      <fieldset className="data-source-switch" aria-label="データの読み込み元">
        <Button disabled={!!busy} variant="ghost" aria-pressed={tab === 'audio'} onClick={() => { importer.cancel(); cancelFolder(); setTab('audio'); }}><FileUp/>音源から開始</Button>
        <Button disabled={!!busy} variant="ghost" aria-pressed={tab === 'saved'} onClick={() => { importer.cancel(); cancelFolder(); setTab('saved'); }}><Database/>保存した分析</Button>
        <Button variant="ghost" disabled={!!busy} aria-pressed={tab === 'csv'} onClick={() => { cancelFolder(); setTab('csv'); }}><FileUp/>CSV・TSV</Button>
        <Button variant="ghost" disabled={!!busy} aria-pressed={tab === 'demo'} onClick={() => { importer.cancel(); cancelFolder(); setTab('demo'); }}><FlaskConical/>合成デモ</Button>
      </fieldset>
      <div className="data-source-body">
        {controller.repository.mode === 'memory' && <p className="data-source-warning">一時利用中です。{policy.downloads ? 'タブを閉じる前にバックアップしてください。' : '管理者設定により保存・ダウンロードは無効です。タブを閉じると消去します。'}</p>}
        {(busy || importer.busy) && <div className="data-source-progress"><output>{busy || `${importer.busy?.label} を読み込み中…`}</output>{importer.busy && <Button variant="ghost" onClick={importer.cancel}>キャンセル</Button>}</div>}
        {error && !conflict && <div className="data-source-error"><output>{error}</output>{status === 'error' ? <Button variant="outline" size="sm" disabled={disabled} onClick={() => void run('保存を再試行中…', () => controller.flush())}>保存を再試行</Button> : <Button variant="outline" size="sm" disabled={disabled} onClick={() => void run('一覧を更新中…', async () => { await controller.refreshForManager(); })}>一覧を再読み込み</Button>}</div>}
        {message && <output className="data-source-error">{message}</output>}
        {pendingResume && <section aria-label="軽量保存の再開" className="data-source-preview">
          <h3>{pendingResume.record.title}を再開</h3>
          <p>元CSV「{pendingResume.dataset.name}」を選び直してください。保存時の内容と一致することを確認して、解析設定・メモ・除外履歴を復元します。</p>
          <p>音声{pendingResume.record.audioReferences?.length.toLocaleString()}件は保存に含まれません。CSVを確認した後、音声フォルダを選び直してください。対応した音源だけが解析対象です。欠けた音声や非採用のCSV行も、元データ・メモ・除外履歴は保持されます。</p>
          <Button disabled={disabled} onClick={() => csvInput.current?.click()}>元CSVを選んで再開</Button>
          <Button variant="outline" disabled={disabled} onClick={() => controller.cancelResume()}>再開を取り消す</Button>
        </section>}
        {conflict && <div className="data-source-warning"><p>別のタブで更新されています。この画面の編集は未保存です。編集を残すには別の分析として保存してください。</p><Button disabled={disabled} onClick={() => void run('編集を保存中…', () => controller.saveAsCopy())}>編集を別の分析に保存</Button><Button variant="outline" disabled={disabled} onClick={() => setDeleteId('discard-draft')}>保存済みを開き直す</Button></div>}
        {deleteId === 'discard-draft' && <div className="delete-confirm" role="alert"><p>このタブの未保存の編集を破棄して、保存済みの分析を開きます。</p><Button variant="outline" onClick={() => setDeleteId(null)}>戻る</Button><Button onClick={() => void run('読み込み中…', async () => { await controller.reloadSaved(); setDeleteId(null); })}>未保存の編集を破棄</Button></div>}
        <section hidden={tab !== 'saved'} aria-label="保存した分析">
          <p className="storage-note">このブラウザープロファイル内の保存領域です。同じプロファイルの利用者は保存した分析を開けます。利用者ごとの暗号化はありません。</p>
          <p className="storage-note">全量保存はCSV・音声も含みます。軽量保存は解析設定・調査状態と入力の照合情報を保存し、CSV・音声本体は含みません。ブラウザーデータを消去すると両方式の保存内容が失われるため、バックアップを保管してください。軽量保存のバックアップからの再開にも元CSV・音声が必要です。</p>
          {active?.source && active.record.audioReferences === undefined && <Button variant="outline" disabled={disabled} onClick={() => void run('軽量保存を作成中…', () => controller.saveAsReference())}>現在の調査を軽量保存にコピー</Button>}
          {sessions.length ? <ul className="session-list">{sessions.map(record => <li key={record.id}>
            <div>
              <strong>{record.title}</strong>
              <small>
                分析ID: <code className="session-record-id">{record.id}</code>
                <br />
                作成: {new Date(record.createdAt).toLocaleString()} · 更新:{' '}
                {new Date(record.updatedAt).toLocaleString()} ·{' '}
                {(record.bundleBytes / 1024 ** 2).toFixed(1)} MB
                {record.audioReferences !== undefined ? ' · 軽量保存（元CSV・音声を再選択）' : ' · 全量保存'}
                {record.source?.name ? <> · 元ファイル: {record.source.name}</> : null}
                {record.id === active?.record.id ? ' · 表示中' : ''}
              </small>
            </div>
            <Button variant="outline" disabled={disabled || record.id === active?.record.id} onClick={() => void run('分析を開いています…', () => controller.open(record.id), true)}>開く</Button>
            <Button variant="ghost" size="icon" disabled={disabled} aria-label={`${record.title}を削除`} onClick={() => setDeleteId(record.id)}><Trash2 size={15}/></Button>
            {deleteId === record.id && <div className="delete-confirm" role="alert"><p>この分析と、ほかの分析が参照していない元データ・音声を端末から削除します。</p><Button variant="outline" onClick={() => setDeleteId(null)}>戻る</Button><Button disabled={disabled} onClick={() => void run('削除しています…', async () => { await controller.remove(record.id, record.revision); setDeleteId(null); })}>削除する</Button></div>}
          </li>)}</ul> : <p className="data-source-empty">保存した分析はありません。</p>}
          <div className="session-actions"><Button variant="outline" disabled={disabled} onClick={() => bundleInput.current?.click()}><FileUp/>バックアップを開く</Button>{controller.repository.mode === 'persistent' && <Button variant="ghost" disabled={disabled} onClick={() => void run('保存領域を確認中…', async () => { const granted = await controller.repository.requestPersistence(); setMessage(granted ? 'ブラウザーに保存領域の維持が認められました。バックアップは引き続き必要です。' : '保存領域の維持はブラウザーに認められませんでした。バックアップを保管してください。'); })}>保存領域の維持をリクエスト</Button>}</div>
        </section>
        {tab === 'audio' && !showAudioReview && <section aria-label="新しい解析の入力手順" className="data-source-preview">
          <h3>1. 音源を選ぶ</h3>
          <p>WAVフォルダ → CSV属性付加 → 対応確認 → 解析開始の順に進みます。確認が終わるまで新しい解析は作成しません。</p>
          <Button disabled={disabled} variant="outline" onClick={() => void chooseInitialFolder()}>WAVフォルダを選ぶ</Button>
          <output>{initialAudio.size ? `WAV ${initialAudio.size.toLocaleString()}音源を選択済み。次にCSVを選んで属性を付けます。` : '次の操作：解析するWAVフォルダを選んでください。'}</output>
          {initialAudio.size > 0 && <p>音源本体 {(initialAudioBytes / 1024 ** 2).toFixed(1)} MiB。{reference ? '軽量保存では音源本体を保存せず、再開時に元CSV・音源を選び直します。' : `全量保存はCSV・状態も含め${policy.maxBundleMiB} MiBまでです。大容量の音源は軽量保存を選んでください。`}</p>}
          {!reference && initialAudioBytes > policy.maxBundleMiB * 1024 ** 2 && <p role="alert">音源が全量保存の上限を超えています。下の「軽量保存」を選ぶと進めます。</p>}
          {readingFolder && <output>フォルダを確認中です。<Button onClick={cancelFolder}>フォルダ確認を取り消す</Button></output>}
          {initialAudio.size > 0 && <><Button variant="ghost" disabled={disabled} onClick={() => { importer.cancel(); setInitialAudio(new Map()); }}>音源選択に戻る</Button><p>選び直しはこの準備中の音源だけを変更します。表示中の分析・メモ・除外・設定は変更しません。</p></>}
        </section>}
        <section hidden={tab !== 'csv' && (tab !== 'audio' || showAudioReview)} aria-label="CSV・TSVの読み込み">
          {tab === 'audio' && <h3>2. CSVから属性を付ける</h3>}
          {tab === 'csv' && <p>CSVから入力準備を開く従来の入口です。解析にはWAVが必要です。表示後、画面上部のWAV選択へ進んでください。</p>}
          <fieldset disabled={disabled} aria-label="保存する内容">
            <legend>保存する内容</legend>
            <label><input type="radio" name="input-storage" checked={!reference} onChange={() => setReference(false)} />全量保存：CSV・音声も保存（1分析{policy.maxBundleMiB} MiBまで）</label>
            <label><input type="radio" name="input-storage" checked={reference} onChange={() => setReference(true)} />軽量保存：解析設定・調査状態のみ。再開時に元CSV・音声を選び直す（大容量音声向け）</label>
          </fieldset>
          <div className="data-source-file-zone" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; }} onDrop={event => { event.preventDefault(); if (!disabled && (tab !== 'audio' || initialAudio.size)) void importer.readCSV(Array.from(event.dataTransfer.files)); }}><div><Button variant="outline" disabled={disabled || (tab === 'audio' && !initialAudio.size)} onClick={() => csvInput.current?.click()}><FileUp/>CSV・TSVを選ぶ</Button><p>またはファイルをドロップ</p></div><p className="data-source-file-help">UTF-8 · 20MB · 128列まで</p></div>
          <CsvFormatGuide onDownloadTemplate={() => { if (policy.downloads) downloadBlob(new Blob(['sample_id,score,group,audio_file\nsample-001,0.12,reference,sample-001.wav\nsample-002,0.18,reference,sample-002.wav\nsample-003,0.35,comparison,sample-003.wav\nsample-004,0.64,comparison,sample-004.wav\n'], {type:'text/csv;charset=utf-8'}), 'overlap-template.csv'); else setMessage('管理者設定によりダウンロードは無効です。'); }}/>
          {importer.error?.source === 'csv' && <CsvImportError message={importer.error.message} diagnostic={importer.error.csvDiagnostic}/>}
          {candidate && <div className="data-source-preview"><div className="data-source-preview-heading"><h3>{candidate.dataset.name}</h3><span>{candidate.dataset.rows.length.toLocaleString()}件 · {candidate.dataset.columns.length}列</span></div>{candidate.warning && <p className="data-source-warning">{candidate.warning}</p>}<section className="data-source-preview-scroll" aria-label="データの先頭行プレビュー"><table><caption>先頭5件 · 6列まで表示</caption><thead><tr>{candidate.dataset.columns.slice(0,6).map(c => <th key={c} scope="col" title={c}>{c}</th>)}</tr></thead><tbody>{candidate.dataset.rows.slice(0,5).map((row, i) => <tr key={i}>{candidate.dataset.columns.slice(0,6).map(c => <td key={c} title={row[c]}>{row[c] || '—'}</td>)}</tr>)}</tbody></table></section></div>}
        </section>
        {tab === 'audio' && showAudioReview && mappedCandidate && initialAudio.size > 0 && <section aria-label="解析前の対応確認" className="data-source-preview">
          <h3>3. 音源とCSVの対応を確認する</h3>
          <p>WAV {initialAudio.size.toLocaleString()}音源 ／ CSV「{mappedCandidate.dataset.name}」{mappedCandidate.dataset.rows.length.toLocaleString()}行。まだ新しい解析は作成していません。</p>
          <p>{reference ? '軽量保存：再開時に元CSV・音源を再指定します。' : '全量保存：CSV・音源本体も保存します。'} 保存方式の変更は「入力選択に戻る」から行えます。</p>
          {!reference && initialAudioBytes > policy.maxBundleMiB * 1024 ** 2 && <p role="alert">全量保存の上限を超えています。「入力選択に戻る」で軽量保存を選んでください。</p>}
          <Button variant="outline" disabled={disabled} onClick={() => setShowAudioReview(false)}>入力選択に戻る</Button>
          <label>CSVの音声ファイル名・パス列<NativeSelect aria-label="解析前の音声対応列" value={mappedCandidate.setup.audioColumn} onChange={event => setMapping({ candidate: candidate!, idColumn: mappedCandidate.setup.idColumn, audioColumn: event.target.value })}><option value="">IDから対応</option>{mappedCandidate.dataset.columns.map(column => <option key={column} value={column}>{column}</option>)}</NativeSelect></label>
          <label>CSVのID列<NativeSelect aria-label="解析前のID列" value={mappedCandidate.setup.idColumn} onChange={event => setMapping({ candidate: candidate!, audioColumn: mappedCandidate.setup.audioColumn, idColumn: event.target.value })}><option value="">未選択</option>{mappedCandidate.dataset.columns.map(column => <option key={column} value={column}>{column}</option>)}</NativeSelect></label>
          <AudioPopulationNotice dataset={mappedCandidate.dataset} idColumn={mappedCandidate.setup.idColumn} audioColumn={mappedCandidate.setup.audioColumn} files={initialAudio} notes={{}} downloads={policy.downloads}/>
          <p>欠落・曖昧・重複で非採用のCSV行は解析に含めません。対応0件なら音源・CSV・対応列を選び直してください。確認後のボタンで解析を開始します。</p>
        </section>}
        <section hidden={tab !== 'demo'} aria-label="合成デモ"><div className="data-source-demo-card"><FlaskConical/><div><h3>操作確認用の合成データ</h3><p>分布・しきい値・音声表示の操作を試せます。実データの性能評価には使えません。</p></div></div></section>
      </div>
      <footer className="data-source-footer"><span>{tab === 'saved' ? 'バックアップの復元は別の分析として追加します。' : tab === 'audio' ? (showAudioReview ? '対応結果を確認し、問題なければ解析を開始してください。' : 'WAVとCSVを選んで、次に対応結果を確認します。') : 'CSVは入力準備です。表示後に画面上部から音源を選んでください。'}</span>{tab === 'audio' && !showAudioReview && <Button disabled={disabled || !mappedCandidate || !!importer.error || !initialAudio.size} onClick={() => setShowAudioReview(true)}>対応を確認</Button>}{tab === 'audio' && showAudioReview && <Button disabled={disabled || !mappedCandidate || !!importer.error || !joined?.adopted.size || (!reference && initialAudioBytes > policy.maxBundleMiB * 1024 ** 2)} onClick={() => mappedCandidate && void run('解析を作成しています…', () => create(mappedCandidate, initialAudio), true)}>対応を確認して解析を開始</Button>}{tab === 'csv' && <Button disabled={disabled || !candidate || !!importer.error} onClick={() => candidate && void run('分析を作成しています…', () => create(candidate), true)}>このデータを表示</Button>}{tab === 'demo' && <Button disabled={disabled} onClick={() => void run('合成データを作成しています…', async () => { const client = new EvaluationWorkerClient(); try { const data = demoDataset(); await create(createDatasetCandidate(data, await client.profile(data))); } finally { client.dispose(); } }, true)}>合成デモを表示</Button>}</footer>
      <input ref={csvInput} type="file" accept=".csv,.tsv" hidden onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value=''; if (!files.length) return; if (pendingResume) void run('元CSVの一致を確認中…', async () => { const selected = await readCSVCandidate(files, new AbortController().signal); await controller.resumeReference(selected.dataset, selected.source!); }, true); else { setShowAudioReview(false); if (tab === 'audio' && !initialAudio.size) setTab('csv'); void importer.readCSV(files); } }}/>
      {open && <input ref={node => { initialFolderInput.current = node; node?.setAttribute('webkitdirectory', ''); }} aria-label="新規解析のWAVフォルダ" type="file" multiple hidden onChange={event => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (!files.length) return; cancelFolder(); try { acceptInitialAudio(files); } catch (error) { setMessage(error instanceof Error ? error.message : '音源を選択できませんでした。'); } }}/>}
      <input ref={bundleInput} type="file" accept=".ovlab" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value=''; if (file) void run('バックアップを検証・復元しています…', () => controller.importBundle(file), true); }}/>
    </div>
  </dialog>;
}
