import { createEvaluationRuntime } from './evaluation-runtime.ts';
import type { EvaluationRequest } from '../contracts/evaluation.ts';

const runtime = createEvaluationRuntime();
const worker = self as unknown as DedicatedWorkerGlobalScope;
worker.addEventListener('message', (event: MessageEvent<EvaluationRequest>) => {
  worker.postMessage(runtime(event.data));
});
