import { parseCSV, profileColumns, type Profile } from './data.ts';
import type { Dataset } from './demo.ts';
import { CSVColumnCountError } from './csv-diagnostics.ts';
import {
  DATASET_LIMITS,
  evaluateDataset,
  validateDataset,
} from './evaluation.ts';
import type {
  EvaluationRequest,
  EvaluationResponse,
} from '../contracts/evaluation.ts';

/** Shared by the browser worker and the real node:worker_threads regression harness. */
export function createEvaluationRuntime() {
  // A single retained dataset bounds registry memory across repeated imports.
  let current: {
    key: string;
    dataset: Dataset;
    profiles: Profile[] | null;
  } | null = null;
  return (request: EvaluationRequest): EvaluationResponse => {
    const start = performance.now();
    const envelope = () => ({
      workerGeneration: request.workerGeneration,
      requestId: request.requestId,
      elapsedMs: performance.now() - start,
    });
    try {
      const command = request.command;
      if (command.kind === 'parse-csv') {
        if (
          typeof command.text !== 'string' ||
          new TextEncoder().encode(command.text).byteLength >
            DATASET_LIMITS.csvBytes
        )
          throw new Error('CSVは20MBまでです。');
        const dataset = parseCSV(command.text, command.name);
        const result = { dataset, profiles: profileColumns(dataset) };
        return {
          ...envelope(),
          ok: true,
          kind: 'parse-csv',
          result,
        };
      }
      if (command.dataset) {
        validateDataset(command.dataset);
        current = {
          key: command.datasetKey,
          dataset: command.dataset,
          profiles: null,
        };
      }
      if (!current || current.key !== command.datasetKey)
        return {
          ...envelope(),
          ok: false,
          error: {
            code: 'dataset-unavailable',
            message: 'データセットを読み直してください。',
          },
        };
      if (command.kind === 'profile') {
        current.profiles ??= profileColumns(current.dataset);
        return {
          ...envelope(),
          ok: true,
          kind: 'profile',
          result: current.profiles,
        };
      }
      if (command.kind === 'evaluate') {
        const result = evaluateDataset(current.dataset, command.spec);
        return {
          ...envelope(),
          ok: true,
          kind: 'evaluate',
          result,
        };
      }
      throw new Error('解析要求の種類を確認してください。');
    } catch (error) {
      return {
        ...envelope(),
        ok: false,
        error:
          error instanceof CSVColumnCountError
            ? {
                code: 'csv-column-count',
                message: error.message,
                diagnostic: error.diagnostic,
              }
            : {
                code: 'invalid-input',
                message:
                  error instanceof Error
                    ? error.message
                    : '解析に失敗しました。',
              },
      };
    }
  };
}
