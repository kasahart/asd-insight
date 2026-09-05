import type { DeploymentPolicy } from './workspace-context';
export const POLICY_TIMEOUT_MS = 10_000;
export type LoadPolicyOptions = {
  signal?: AbortSignal;
  /** Test-only shortening of the fixed production deadline. */
  timeoutMs?: number;
};

export async function loadPolicy({
  signal,
  timeoutMs = POLICY_TIMEOUT_MS,
}: LoadPolicyOptions = {}): Promise<DeploymentPolicy> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
    throw new Error('配信設定の待機時間が不正です。');
  const request = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    request.abort();
  }, timeoutMs);
  const abortRequest = () => request.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) abortRequest();
    else signal.addEventListener('abort', abortRequest, { once: true });
  }
  try {
    const response = await fetch(
      `${import.meta.env?.BASE_URL ?? '/'}app-config.json`,
      {
        cache: 'no-store',
        credentials: 'same-origin',
        redirect: 'error',
        signal: request.signal,
      },
    );
    if (!response.ok)
      throw new Error(
        '配信設定を読み込めません。管理者に app-config.json の配信を確認してください。',
      );
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object')
      throw new Error('配信設定が不正です。');
    const p = value as DeploymentPolicy & { version: number };
    if (
      p.version !== 1 ||
      typeof p.persistentStorage !== 'boolean' ||
      typeof p.downloads !== 'boolean' ||
      !Number.isInteger(p.maxBundleMiB) ||
      p.maxBundleMiB < 1 ||
      p.maxBundleMiB > 128 ||
      !Number.isInteger(p.maxTotalMiB) ||
      p.maxTotalMiB < p.maxBundleMiB ||
      p.maxTotalMiB > 256
    )
      throw new Error('配信設定が未対応です。管理者に確認してください。');
    return p;
  } catch (error) {
    if (timedOut)
      throw new Error(
        '配信設定の読み込みが時間切れになりました。接続を確認して再試行してください。',
        { cause: error },
      );
    if (signal?.aborted) throw signal.reason ?? error;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortRequest);
  }
}
