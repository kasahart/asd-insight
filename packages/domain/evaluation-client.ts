import type { Dataset } from './demo.ts';
import type { Profile } from './data.ts';
import { CSVColumnCountError } from './csv-diagnostics.ts';
import type {
  EvaluationCommand,
  EvaluationInput,
  EvaluationRequest,
  EvaluationResponse,
  EvaluationResult,
  PreparedDataset,
} from '../contracts/evaluation.ts';

export interface EvaluationWorkerTransport {
  postMessage(message: EvaluationRequest): void;
  terminate(): void;
  onMessage(listener: (message: EvaluationResponse) => void): () => void;
  onError(listener: (error: unknown) => void): () => void;
}

export type EvaluationRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type EvaluationWorkerClientOptions = {
  timeoutMs?: number;
  /** A real node:worker_threads adapter can exercise this same client in tests. */
  createWorker?: () => EvaluationWorkerTransport;
};

function browserWorker(): EvaluationWorkerTransport {
  const worker = new Worker(
    new URL('./evaluation.worker.ts', import.meta.url),
    { type: 'module' },
  );
  return {
    postMessage: (message) => worker.postMessage(message),
    terminate: () => worker.terminate(),
    onMessage(listener) {
      const handler = (event: MessageEvent<EvaluationResponse>) =>
        listener(event.data);
      worker.addEventListener('message', handler);
      return () => worker.removeEventListener('message', handler);
    },
    onError(listener) {
      const handler = (event: Event) => listener(event);
      worker.addEventListener('error', handler);
      worker.addEventListener('messageerror', handler);
      return () => {
        worker.removeEventListener('error', handler);
        worker.removeEventListener('messageerror', handler);
      };
    },
  };
}

type Pending = {
  generation: number;
  requestId: number;
  kind: EvaluationCommand['kind'];
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};

/**
 * Latest request wins within this client. Use a separate client for an import
 * preview that may run independently of the current dataset's evaluation.
 * Abort/timeout terminate CPU work, rather than waiting for a busy worker to
 * read a cancellation message. The next request starts a fresh generation.
 */
export class EvaluationWorkerClient {
  private worker: EvaluationWorkerTransport | null = null;
  private releaseListeners: (() => void)[] = [];
  private workerGeneration = 0;
  private nextRequestId = 0;
  private nextDatasetId = 0;
  private registeredDataset: Dataset | null = null;
  private registeredDatasetKey = '';
  private pending: Pending | null = null;
  private disposed = false;
  private readonly defaultTimeoutMs: number;
  private readonly createWorker: () => EvaluationWorkerTransport;
  lastElapsedMs: number | null = null;

  constructor(options: EvaluationWorkerClientOptions = {}) {
    this.defaultTimeoutMs = options.timeoutMs ?? 15_000;
    this.createWorker = options.createWorker ?? browserWorker;
  }

  parseCSV(
    text: string,
    name = 'data.csv',
    options: EvaluationRequestOptions = {},
  ): Promise<PreparedDataset> {
    return this.request(() => ({ kind: 'parse-csv', text, name }), options);
  }

  profile(
    dataset: Dataset,
    options: EvaluationRequestOptions = {},
  ): Promise<Profile[]> {
    return this.request(
      () => ({ kind: 'profile', ...this.datasetCommand(dataset) }),
      options,
    );
  }

  evaluate(
    input: EvaluationInput,
    options: EvaluationRequestOptions = {},
  ): Promise<EvaluationResult> {
    const { dataset, ...spec } = input;
    return this.request(
      () => ({ kind: 'evaluate', spec, ...this.datasetCommand(dataset) }),
      options,
    );
  }

  cancel(): void {
    this.stop(
      new DOMException('新しい操作により解析を取り消しました。', 'AbortError'),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop(new DOMException('解析Workerを終了しました。', 'AbortError'));
  }

  private datasetCommand(dataset: Dataset): {
    datasetKey: string;
    dataset?: Dataset;
  } {
    // Dataset values are immutable. A new object denotes a new version, even
    // when filenames or row counts happen to match.
    if (this.registeredDataset === dataset)
      return { datasetKey: this.registeredDatasetKey };
    this.registeredDataset = dataset;
    this.registeredDatasetKey = `dataset-${++this.nextDatasetId}`;
    return { datasetKey: this.registeredDatasetKey, dataset };
  }

  private ensureWorker(): EvaluationWorkerTransport {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    const generation = ++this.workerGeneration;
    this.worker = worker;
    this.releaseListeners = [
      worker.onMessage((message) => this.receive(message, generation)),
      worker.onError(() => {
        if (this.worker === worker && this.workerGeneration === generation)
          this.stop(
            new Error(
              '解析Workerを実行できませんでした。もう一度実行してください。',
            ),
          );
      }),
    ];
    return worker;
  }

  private request<T>(
    command: () => EvaluationCommand,
    options: EvaluationRequestOptions,
  ): Promise<T> {
    if (this.disposed)
      return Promise.reject(
        new DOMException('解析Workerは終了済みです。', 'InvalidStateError'),
      );
    if (options.signal?.aborted)
      return Promise.reject(
        new DOMException('解析を取り消しました。', 'AbortError'),
      );
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 2_147_483_647
    )
      return Promise.reject(
        new Error('解析の期限は正の有限なミリ秒で指定してください。'),
      );
    if (this.pending) this.cancel();
    this.lastElapsedMs = null;
    return new Promise<T>((resolve, reject) => {
      try {
        const worker = this.ensureWorker();
        const request: EvaluationRequest = {
          workerGeneration: this.workerGeneration,
          requestId: ++this.nextRequestId,
          command: command(),
        };
        const abort = () => {
          if (this.pending?.requestId === request.requestId)
            this.stop(new DOMException('解析を取り消しました。', 'AbortError'));
        };
        const timer = setTimeout(() => {
          if (this.pending?.requestId === request.requestId)
            this.stop(
              new DOMException(
                '解析が期限を超えたため停止しました。',
                'TimeoutError',
              ),
            );
        }, timeoutMs);
        options.signal?.addEventListener('abort', abort, { once: true });
        this.pending = {
          generation: request.workerGeneration,
          requestId: request.requestId,
          kind: request.command.kind,
          resolve: (result) => resolve(result as T),
          reject,
          cleanup: () => {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', abort);
          },
        };
        // An abort triggered while constructing a transport must still win.
        if (options.signal?.aborted) abort();
        else worker.postMessage(request);
      } catch (error) {
        const failure =
          error instanceof Error
            ? error
            : new Error('解析要求を送信できませんでした。');
        this.stop(failure);
        reject(failure);
      }
    });
  }

  private receive(message: EvaluationResponse, generation: number): void {
    const pending = this.pending;
    if (
      !pending ||
      !message ||
      generation !== this.workerGeneration ||
      message.workerGeneration !== generation ||
      pending.generation !== generation ||
      message.requestId !== pending.requestId
    )
      return;
    if (message.ok && message.kind !== pending.kind) {
      this.stop(new Error('解析Workerの応答が要求と一致しません。'));
      return;
    }
    this.pending = null;
    pending.cleanup();
    this.lastElapsedMs = message.elapsedMs;
    if (message.ok) pending.resolve(message.result);
    else {
      // Registration might have failed; do not assume this dataset was stored.
      this.registeredDataset = null;
      pending.reject(
        message.error.code === 'csv-column-count' && message.error.diagnostic
          ? new CSVColumnCountError(message.error.diagnostic)
          : new Error(message.error.message),
      );
    }
  }

  private stop(reason: Error): void {
    const pending = this.pending;
    this.pending = null;
    pending?.cleanup();
    for (const release of this.releaseListeners) release();
    this.releaseListeners = [];
    const worker = this.worker;
    this.worker = null;
    this.registeredDataset = null;
    this.registeredDatasetKey = '';
    worker?.terminate();
    pending?.reject(reason);
  }
}
