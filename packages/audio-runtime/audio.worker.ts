import lock from '../../runtime/lock.json';
import adapterSource from '../../python/wandas_adapter.py?raw';
import { initializeAudioKernel } from './kernel';
import type { AudioPayload, AudioRequest, AudioResponse } from './contracts';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const nativeFetch = scope.fetch.bind(scope);
let working = false;
let kernel: Awaited<ReturnType<typeof initializeAudioKernel>> | null = null;
let initializedBase = '';
scope.onmessage = async (event: MessageEvent<AudioRequest>) => {
  const request = event.data;
  if (working || request?.type !== 'analyze') return;
  working = true;
  const reply = (payload: AudioPayload, transfer: Transferable[] = []) =>
    scope.postMessage(
      {
        ...payload,
        requestId: request.requestId,
        generation: request.generation,
      } satisfies AudioResponse,
      transfer,
    );
  try {
    const base = new URL(request.baseUrl);
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      base.origin !== scope.location.origin ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !base.pathname.endsWith('/runtime/audio/')
    )
      throw new Error(
        '音声ランタイムは同じ配布元の固定ファイルのみ利用できます。',
      );
    if (kernel && initializedBase !== base.href)
      throw new Error('音声ランタイムの配布元が変更されました。');
    const allowed = new Set(
      [
        ...lock.assets.map((asset) => asset.path),
        'manifest.json',
        'wandas_adapter.py',
      ].map((path) => new URL(path, base).href),
    );
    scope.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        input instanceof Request ? input.url : String(input),
        base,
      );
      if (!allowed.has(url.href))
        return Promise.reject(
          new Error('音声ランタイムの外部通信を拒否しました。'),
        );
      const method =
        input instanceof Request ? input.method : (init?.method ?? 'GET');
      if (method !== 'GET')
        return Promise.reject(
          new Error('音声ランタイムの送信要求を拒否しました。'),
        );
      return nativeFetch(url.href, {
        ...init,
        method: 'GET',
        redirect: 'error',
        credentials: 'same-origin',
      });
    }) as typeof fetch;
    reply({ type: 'phase', phase: 'initializing' });
    if (!kernel) {
      kernel = await initializeAudioKernel({
        lock,
        baseUrl: base.href,
        moduleUrl: new URL('pyodide.mjs', base).href,
        adapterSource,
        readAsset: async (name) => {
          const response = await scope.fetch(new URL(name, base), {
            // These two small identity files must always come from the
            // current release. A reused Vite preview URL can otherwise pair
            // a newly embedded worker with a cached previous manifest.
            cache:
              name === 'manifest.json' || name === 'wandas_adapter.py'
                ? 'no-store'
                : 'force-cache',
          });
          if (!response.ok)
            throw new Error(
              '音声ランタイムが未準備です。配布ファイルを確認してください。',
            );
          return new Uint8Array(await response.arrayBuffer());
        },
      });
      initializedBase = base.href;
    }
    reply({ type: 'phase', phase: 'analyzing' });
    const result = kernel.analyze(new Uint8Array(request.bytes));
    reply({ type: 'result', result }, [
      result.spectrogram.values.buffer as ArrayBuffer,
    ]);
  } catch (error) {
    // Python tracebacks stay out of the UI; display the final reason, bounded.
    const message =
      error instanceof Error ? error.message : '音声解析に失敗しました。';
    const reason =
      message
        .trim()
        .split('\n')
        .at(-1)
        ?.replace(/^(?:ValueError|RuntimeError|TypeError):\s*/, '') ?? message;
    reply({ type: 'error', message: reason.slice(0, 300) });
  } finally {
    working = false;
  }
};
