import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy } from '../../src/state/config.ts';

const policy = {
  version: 1,
  persistentStorage: true,
  downloads: true,
  maxBundleMiB: 128,
  maxTotalMiB: 256,
};

test('policy loading aborts a stalled same-origin request at its deadline', async () => {
  const previousFetch = globalThis.fetch;
  let requestSignal;
  globalThis.fetch = (_url, options) => {
    requestSignal = options.signal;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => reject(options.signal.reason ?? new Error('aborted')),
        { once: true },
      );
    });
  };
  try {
    await assert.rejects(loadPolicy({ timeoutMs: 15 }), /時間切れ/);
    assert.equal(requestSignal.aborted, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('policy loading clears its deadline after a successful response', async () => {
  const previousFetch = globalThis.fetch;
  let requestSignal;
  globalThis.fetch = async (_url, options) => {
    requestSignal = options.signal;
    return { ok: true, json: async () => policy };
  };
  try {
    assert.deepEqual(await loadPolicy({ timeoutMs: 15 }), policy);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(requestSignal.aborted, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('policy loading requests same-origin configuration without cache or redirects', async () => {
  const previousFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { ok: true, json: async () => policy };
  };
  try {
    assert.deepEqual(await loadPolicy(), policy);
    assert.equal(request.options.cache, 'no-store');
    assert.equal(request.options.credentials, 'same-origin');
    assert.equal(request.options.redirect, 'error');
    assert.ok(request.options.signal instanceof AbortSignal);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('invalid, missing and oversized policies fail closed instead of using permissive defaults', async () => {
  const previousFetch = globalThis.fetch;
  const invalid = [
    null,
    1,
    [],
    { ...policy, version: 2 },
    { ...policy, persistentStorage: 'true' },
    { ...policy, downloads: 1 },
    { ...policy, maxBundleMiB: undefined },
    { ...policy, maxBundleMiB: 0 },
    { ...policy, maxBundleMiB: 129 },
    { ...policy, maxBundleMiB: 1.5 },
    { ...policy, maxTotalMiB: undefined },
    { ...policy, maxTotalMiB: 0 },
    { ...policy, maxTotalMiB: 127 },
    { ...policy, maxTotalMiB: 257 },
    { ...policy, maxTotalMiB: 128.5 },
  ];
  try {
    for (const value of invalid) {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => value,
      });
      await assert.rejects(loadPolicy(), /配信設定/);
    }
    globalThis.fetch = async () => ({ ok: false, json: async () => policy });
    await assert.rejects(loadPolicy(), /配信設定を読み込めません/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
