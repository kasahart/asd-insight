import {
  AUDIO_JOB_TIMEOUT_MS,
  MAX_AUDIO_INPUT_BYTES,
  validateAudioAnalysis,
  type AudioAnalysis,
  type AudioPhase,
  type AudioResponse,
  type AudioRequest,
} from './contracts.ts';

type WorkerPort = Pick<
  Worker,
  'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'
>;
type Job = { reject(error: unknown): void; cleanup(): void };
export type AnalyzeOptions = {
  signal?: AbortSignal;
  onPhase?: (phase: AudioPhase) => void;
};

/** One active job and one worker. Cancellation kills Python/WASM, even during synchronous FFT. */
export function createAudioRuntime({
  createWorker,
  baseUrl,
  timeoutMs = AUDIO_JOB_TIMEOUT_MS,
}: {
  createWorker: () => WorkerPort;
  baseUrl: string;
  timeoutMs?: number;
}) {
  let worker: WorkerPort | null = null,
    active: Job | null = null,
    generation = 0,
    sequence = 0;
  function terminate(error: unknown) {
    const previous = active;
    active = null;
    worker?.terminate();
    worker = null;
    generation++;
    previous?.cleanup();
    previous?.reject(error);
  }
  return {
    async analyzeWav(
      bytes: ArrayBuffer,
      options: AnalyzeOptions = {},
    ): Promise<AudioAnalysis> {
      options.signal?.throwIfAborted();
      if (bytes.byteLength < 12 || bytes.byteLength > MAX_AUDIO_INPUT_BYTES)
        throw new Error('音声解析は空でない80MB以下のWAVに対応しています。');
      if (active)
        terminate(
          new DOMException('音声の選択が変更されました。', 'AbortError'),
        );
      const port = (worker ??= createWorker());
      const requestId = ++sequence,
        requestGeneration = generation;
      return new Promise((resolve, reject) => {
        const abort = () =>
          terminate(new DOMException('音声解析を中止しました。', 'AbortError'));
        const timer = setTimeout(
          () =>
            terminate(
              new Error(
                '音声解析が時間上限を超えました。短い音声で再試行してください。',
              ),
            ),
          timeoutMs,
        );
        const job: Job = {
          reject,
          cleanup() {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
          },
        };
        active = job;
        options.signal?.addEventListener('abort', abort, { once: true });
        port.onmessage = (event: MessageEvent<AudioResponse>) => {
          const response = event.data;
          if (
            worker !== port ||
            active !== job ||
            response?.requestId !== requestId ||
            response?.generation !== requestGeneration
          )
            return;
          if (response.type === 'phase') {
            options.onPhase?.(response.phase);
            return;
          }
          if (response.type === 'error') {
            terminate(new Error(response.message));
            return;
          }
          if (response.type === 'result') {
            try {
              const result = validateAudioAnalysis(response.result);
              job.cleanup();
              active = null;
              resolve(result);
            } catch (error) {
              terminate(error);
            }
          }
        };
        port.onerror = () => {
          if (worker === port && active === job)
            terminate(
              new Error('音声エンジンが停止しました。再試行してください。'),
            );
        };
        port.onmessageerror = () => {
          if (worker === port && active === job)
            terminate(
              new Error(
                '音声エンジンの応答を受け取れません。再試行してください。',
              ),
            );
        };
        const copy = bytes.slice(0);
        try {
          port.postMessage(
            {
              type: 'analyze',
              requestId,
              generation: requestGeneration,
              baseUrl,
              bytes: copy,
            } satisfies AudioRequest,
            [copy],
          );
        } catch (error) {
          terminate(error);
        }
      });
    },
    dispose() {
      terminate(new DOMException('音声エンジンを終了しました。', 'AbortError'));
    },
  };
}

let shared: ReturnType<typeof createAudioRuntime> | null = null;
export function analyzeWav(
  bytes: ArrayBuffer,
  options?: AnalyzeOptions,
): Promise<AudioAnalysis> {
  shared ??= createAudioRuntime({
    createWorker: () =>
      new Worker(new URL('./audio.worker.ts', import.meta.url), {
        type: 'module',
      }),
    baseUrl: new URL(
      'runtime/audio/',
      new URL(import.meta.env.BASE_URL, window.location.href),
    ).href,
  });
  return shared.analyzeWav(bytes, options);
}
