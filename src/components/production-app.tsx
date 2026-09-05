import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AudioLines, BookOpen, Database, Download, ShieldCheck } from 'lucide-react';
import { createBrowserRepository, type BrowserRepository } from '@storage/index';
import { WorkspaceController } from '@/state/workspace-controller';
import { WorkspaceContext, useWorkspace, type DeploymentPolicy } from '@/state/workspace-context';
import { loadPolicy } from '@/state/config';
import { Button } from './ui/button';
import { ViewPreferencesProvider } from './view-preferences';
import { SessionManager } from './session-manager';

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function ManualLink() {
  /* oxlint-disable next/no-html-link-for-pages */
  return (
    <a className="manual-link" href="./manual/">
      <BookOpen size={14} aria-hidden="true" />
      <span>使い方</span>
    </a>
  );
  /* oxlint-enable next/no-html-link-for-pages */
}

export function ProductionApp({ children }: { children: ReactNode }) {
  const [controller, setController] = useState<WorkspaceController | null>(null);
  const [policy, setPolicy] = useState<DeploymentPolicy | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const current = useRef<WorkspaceController | null>(null);
  const generation = useRef(0);
  const pendingBoot = useRef<AbortController | null>(null);
  const disposeCurrent = useCallback(() => {
    const owned = current.current;
    current.current = null;
    owned?.dispose();
  }, []);
  const cancelBoot = useCallback(() => {
    const pending = pendingBoot.current;
    pendingBoot.current = null;
    pending?.abort();
  }, []);
  const stopBoot = useCallback(() => {
    generation.current++;
    cancelBoot();
    disposeCurrent();
  }, [cancelBoot, disposeCurrent]);
  const boot = useCallback(async (mode?: 'memory') => {
    const ticket = ++generation.current;
    cancelBoot();
    const request = new AbortController();
    pendingBoot.current = request;
    setLoading(true); setError('');
    let repository: BrowserRepository | null = null;
    try {
      const config = await loadPolicy({ signal: request.signal });
      if (ticket !== generation.current) return;
      setPolicy(config);
      // A disabled policy is explicit; an unavailable persistent store is never a silent fallback.
      repository = await createBrowserRepository({ mode: mode ?? (config.persistentStorage ? 'persistent' : 'memory'), maxBundleBytes: config.maxBundleMiB * 1024 ** 2, maxTotalBytes: config.maxTotalMiB * 1024 ** 2 });
      if (ticket !== generation.current) { repository.close(); return; }
      const next = new WorkspaceController(repository);
      await next.refresh();
      if (ticket !== generation.current) { next.dispose(); return; }
      disposeCurrent();
      current.current = next;
      setController(next);
    } catch (e) {
      repository?.close();
      if (ticket === generation.current) setError(e instanceof Error ? e.message : '初期化できません。');
    } finally {
      if (ticket === generation.current) setLoading(false);
      if (pendingBoot.current === request) pendingBoot.current = null;
    }
  }, [cancelBoot, disposeCurrent]);
  useEffect(() => {
    let mounted = true;
    queueMicrotask(() => {
      if (mounted) void boot();
    });
    return () => {
      mounted = false;
      stopBoot();
    };
  }, [boot, stopBoot]);
  if (controller && policy) return <ReadyApplication controller={controller} policy={policy}>{children}</ReadyApplication>;
  return <div className="lab-shell dark"><header className="app-header"><strong>ASD Insight</strong><div className="startup-header-actions"><ManualLink /><span>端末内で処理</span></div></header><main className="startup-state" aria-busy={loading}>
    <AudioLines size={30}/><h1>{loading ? '保存環境を確認しています' : 'この環境では開始できませんでした'}</h1>
    {error && <p role="alert">{error}</p>}
    {!loading && <div className="session-actions"><Button onClick={() => void boot()}>再試行</Button>{policy?.persistentStorage && <Button variant="outline" onClick={() => void boot('memory')}>保存せず一時利用</Button>}</div>}
    {!loading && <p>一時利用のデータはタブを閉じると消えます。HTTPSと対応ブラウザーを使用してください。</p>}
  </main></div>;
}

function ReadyApplication({ controller, policy, children }: { controller: WorkspaceController; policy: DeploymentPolicy; children: ReactNode }) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [managerOpen, setManagerOpen] = useState(false);
  const openManager = useCallback(() => {
    setManagerOpen(true);
    void controller.refreshForManager();
  }, [controller]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      const current = controller.getSnapshot();
      if ((controller.repository.mode === 'memory' && current.active) || current.status !== 'saved') event.preventDefault();
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [controller]);
  return <WorkspaceContext.Provider value={{ controller, policy, openManager }}>
    <ViewPreferencesProvider key={snapshot.active?.record.id ?? 'welcome'}>
      {snapshot.active ? children : <div className="lab-shell dark"><header className="app-header"><strong>ASD Insight</strong><div className="startup-header-actions"><ManualLink /><span><ShieldCheck size={14}/> 端末内で処理</span></div></header><main className="startup-state"><Database size={30}/><h1>分析するデータを選ぶ</h1><p>CSV・TSVを開くか、このブラウザーに保存した分析を再開できます。</p><Button onClick={openManager}>データを選ぶ</Button><p className="storage-note">データと音声を外部へ送信しません。同じブラウザープロファイルの利用者は保存した分析を開けます。</p></main></div>}
      <SessionManager open={managerOpen} onClose={() => setManagerOpen(false)}/>
    </ViewPreferencesProvider>
  </WorkspaceContext.Provider>;
}

export function WorkspaceActions() {
  const { controller, policy, status, active, error, conflict, openManager } = useWorkspace();
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const operationGate = useRef(false);
  async function backup() {
    if (!policy.downloads) {
      setMessage('管理者設定によりダウンロードは無効です。');
      return;
    }
    if (operationGate.current) return;
    operationGate.current = true;
    setWorking(true); setMessage('');
    try { const blob = await controller.exportBundle(); downloadBlob(blob, 'overlap-analysis.ovlab'); setMessage('バックアップのダウンロードを開始しました。保存先でファイルを確認してください。'); }
    catch (e) { setMessage(e instanceof Error ? e.message : 'バックアップできません。'); }
    finally { operationGate.current = false; setWorking(false); }
  }
  async function copy() {
    if (operationGate.current) return;
    operationGate.current = true; setWorking(true);
    try { await controller.saveAsCopy(); }
    catch(e) { setMessage(e instanceof Error ? e.message : 'コピーを保存できません。'); }
    finally { operationGate.current = false; setWorking(false); }
  }
  const mode = controller.repository.mode;
  const saveState = conflict
    ? '競合：未保存の編集'
    : mode === 'memory'
      ? '一時利用・タブを閉じると消去'
      : status === 'saved'
        ? '端末に保存済み'
        : status === 'saving'
          ? '保存中…'
          : status === 'error'
            ? '保存できません'
            : '未保存の変更';
  const saveStateKey = conflict ? 'conflict' : mode === 'memory' ? 'memory' : status;
  return <>
    <div className="header-actions">
      <ManualLink />
      <button type="button" className="save-status" data-status={saveStateKey} onClick={openManager} aria-label={`保存状態と分析を管理（${saveState}）`}>
        <ShieldCheck size={14}/>{saveState}
      </button>
      {policy.downloads && <Button variant="outline" disabled={!active || working} onClick={() => void backup()}><Download size={14}/>バックアップ</Button>}
      <Button variant="outline" onClick={openManager}><Database size={14}/>データを選ぶ</Button>
    </div>
    {(error || message) && <div className="save-notification" role={error ? 'alert' : 'status'}>
      <span>{error || message}</span>
      {error && !conflict && <Button variant="outline" size="sm" onClick={() => void controller.flush().catch(() => {})}>保存を再試行</Button>}
      {conflict && <Button variant="outline" size="sm" disabled={working} onClick={() => void copy()}>編集を別の分析に保存</Button>}
      <Button variant="ghost" size="sm" onClick={openManager}>管理</Button>
      {!error && <Button variant="ghost" size="sm" onClick={() => setMessage('')}>閉じる</Button>}
    </div>}
  </>;
}
