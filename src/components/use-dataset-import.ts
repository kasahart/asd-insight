'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readCSVCandidate,
  type DatasetCandidate,
} from '@/lib/dataset-import';
import {
  CSVColumnCountError,
  type CSVColumnCountDiagnostic,
} from '@/lib/csv-diagnostics';

type ImportSource = 'csv' | 'local' | 'catalog';
export type DatasetImportError = {
  source: ImportSource;
  message: string;
  csvDiagnostic?: CSVColumnCountDiagnostic;
};
type ActiveRequest = {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
};

// Preparing a candidate never mutates the displayed data or investigation.
// Every completion must still own its request before updating the picker.
export function useDatasetImport() {
  const [csvCandidate, setCsvCandidate] = useState<DatasetCandidate | null>(
    null,
  );
  const [busy, setBusy] = useState<{
    source: ImportSource;
    label: string;
  } | null>(null);
  const [error, setError] = useState<DatasetImportError | null>(null);
  const active = useRef<ActiveRequest | null>(null);
  const abort = useCallback(() => {
    if (active.current) {
      clearTimeout(active.current.timer);
      active.current.controller.abort();
      active.current = null;
    }
  }, []);
  const cancel = useCallback(() => {
    abort();
    setBusy(null);
    setError(null);
  }, [abort]);
  useEffect(() => abort, [abort]);

  const run = useCallback(
    async function run<T>(
      source: ImportSource,
      label: string,
      operation: (signal: AbortSignal) => Promise<T>,
      onReady?: (value: T) => void,
    ): Promise<T | null> {
      abort();
      const controller = new AbortController();
      const request = {
        controller,
        timer: setTimeout(
          () =>
            controller.abort(
              new Error(
                '読み込みが時間切れになりました。もう一度お試しください。',
              ),
            ),
          15000,
        ),
      };
      active.current = request;
      setBusy({ source, label });
      setError(null);
      let onAbort = () => {};
      const cancellation = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      try {
        const value = await Promise.race([
          operation(controller.signal),
          cancellation,
        ]);
        if (active.current !== request) return null;
        controller.signal.throwIfAborted();
        onReady?.(value);
        return value;
      } catch (failure) {
        if (active.current === request) {
          const reason = controller.signal.aborted
            ? controller.signal.reason
            : failure;
          setError({
            source,
            message:
              reason instanceof TypeError
                ? 'データを読み込めません。ファイルとブラウザーの実行権限を確認してください。'
                : reason instanceof Error
                  ? reason.message
                  : '読み込めませんでした。もう一度お試しください。',
            ...(source === 'csv' && reason instanceof CSVColumnCountError
              ? { csvDiagnostic: reason.diagnostic }
              : {}),
          });
        }
        return null;
      } finally {
        clearTimeout(request.timer);
        controller.signal.removeEventListener('abort', onAbort);
        if (active.current === request) {
          active.current = null;
          setBusy(null);
        }
      }
    },
    [abort],
  );

  const readCSV = useCallback(
    async (files: File[]) => {
      // A failed replacement must not leave an older preview looking applicable.
      setCsvCandidate(null);
      await run(
        'csv',
        files[0]?.name ?? 'CSV・TSV',
        (signal) => readCSVCandidate(files, signal),
        setCsvCandidate,
      );
    },
    [run],
  );

  return { csvCandidate, busy, error, readCSV, cancel };
}
