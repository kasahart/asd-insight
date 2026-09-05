import test, { afterEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const stubs = {
  '@storage/index': `
    export async function createBrowserRepository(options) {
      const fixture = globalThis.__policyUi;
      fixture.repositoryOptions.push(options);
      return fixture.repository;
    }
  `,
  '@/state/config': `
    export async function loadPolicy() {
      return globalThis.__policyUi.policy;
    }
  `,
  '@/components/view-preferences': `
    import React from "react";
    export const PersistentDetails = ({children, ...props}) => React.createElement("details", props, children);
  `,
  '@domain/evaluation-client': `
    export class EvaluationWorkerClient {
      async parseCSV() { throw new Error('not used by this fixture'); }
      async profile() { throw new Error('not used by this fixture'); }
      dispose() {}
    }
  `,
  '@/state/workspace-controller': `
    export class WorkspaceController {
      constructor(repository) {
        this.repository = repository;
        this.snapshot = {
          active: null,
          sessions: [],
          status: 'saved',
          error: '',
          conflict: false,
          operation: null,
        };
        globalThis.__policyUi.controllers.push(this);
      }
      getSnapshot = () => this.snapshot;
      subscribe = () => () => {};
      async refresh() {}
      refreshForManager = async () => true;
      dispose() {
        this.repository.close();
      }
    }
  `,
  './session-manager': 'export const SessionManager = () => null;',
  './production-app': `
    export function downloadBlob() {
      globalThis.__policyUi.downloads.push(true);
    }
  `,
  './view-preferences':
    'export const ViewPreferencesProvider = ({children}) => children;',
  './ui/button':
    'import React from "react"; export const Button = ({children,...props}) => React.createElement("button",props,children);',
  'lucide-react':
    'export const AudioLines = () => null; export const BookOpen = AudioLines; export const Database = AudioLines; export const Download = AudioLines; export const ShieldCheck = AudioLines; export const FileUp = AudioLines; export const FlaskConical = AudioLines; export const X = AudioLines; export const Trash2 = AudioLines;',
};

let components;
before(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        export { ManualLink, ProductionApp, WorkspaceActions } from './src/components/production-app';
        export { SessionManager } from './src/components/session-manager';
        export { WorkspaceContext } from './src/state/workspace-context';
      `,
      loader: 'tsx',
      resolveDir: root,
    },
    absWorkingDir: root,
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
    jsx: 'automatic',
    logLevel: 'silent',
    plugins: [
      {
        name: 'policy-ui-fixtures',
        setup(buildContext) {
          buildContext.onResolve({ filter: /.*/ }, (args) => {
            if (Object.hasOwn(stubs, args.path))
              return { path: args.path, namespace: 'policy-ui-fixture' };
            if (/^react(?:\/jsx-runtime)?$/.test(args.path))
              return { path: require.resolve(args.path), external: true };
          });
          buildContext.onLoad(
            { filter: /.*/, namespace: 'policy-ui-fixture' },
            (args) => ({ contents: stubs[args.path], loader: 'js' }),
          );
        },
      },
    ],
  });
  const path = join(tmpdir(), `overlap-policy-ui-${crypto.randomUUID()}.mjs`);
  await writeFile(path, bundle.outputFiles[0].text);
  try {
    components = await import(pathToFileURL(path).href);
  } finally {
    await rm(path, { force: true });
  }
});

const h = React.createElement;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const mounted = new Set();

function policy(overrides = {}) {
  return {
    persistentStorage: true,
    downloads: true,
    maxBundleMiB: 128,
    maxTotalMiB: 256,
    ...overrides,
  };
}

function setup(overrides = {}) {
  const closes = [];
  const repository = {
    mode: 'memory',
    close: () => closes.push(true),
    listSessions: async () => [],
  };
  const fixture = {
    policy: policy(overrides),
    repository,
    repositoryOptions: [],
    controllers: [],
    downloads: [],
  };
  globalThis.__policyUi = fixture;
  return { fixture, closes };
}

async function settle() {
  for (let index = 0; index < 5; index++)
    await act(async () => {
      await Promise.resolve();
    });
}

afterEach(async () => {
  for (const renderer of mounted) await act(async () => renderer.unmount());
  mounted.clear();
  delete globalThis.__policyUi;
  delete globalThis.window;
});

test('ProductionApp honors persistentStorage:false by starting in memory mode', async () => {
  const { fixture, closes } = setup({ persistentStorage: false });
  const previousWindow = globalThis.window;
  globalThis.window = {
    addEventListener() {},
    removeEventListener() {},
  };
  const { ProductionApp } = components;
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(h(ProductionApp, null, 'ready'));
  });
  mounted.add(renderer);
  await settle();

  assert.deepEqual(fixture.repositoryOptions, [
    {
      mode: 'memory',
      maxBundleBytes: 128 * 1024 ** 2,
      maxTotalBytes: 256 * 1024 ** 2,
    },
  ]);
  assert.equal(fixture.controllers.length, 1);
  assert.equal(fixture.controllers[0].repository.mode, 'memory');
  assert.equal(
    renderer.root
      .findAllByType('a')
      .some((link) => link.props.href === './manual/'),
    true,
    'the user guide is reachable before a dataset is selected',
  );
  await act(async () => renderer.unmount());
  mounted.delete(renderer);
  assert.equal(closes.length, 1);
  globalThis.window = previousWindow;
});

test('WorkspaceActions does not expose backup when downloads are disabled', async () => {
  const { fixture } = setup({ downloads: false });
  const snapshot = {
    active: { record: { id: 'session-1' } },
    sessions: [],
    status: 'saved',
    error: '',
    conflict: false,
    operation: null,
  };
  let exports = 0;
  const controller = {
    repository: { mode: 'persistent' },
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    exportBundle: async () => {
      exports++;
      return new Blob();
    },
    refreshForManager: async () => true,
  };
  const { WorkspaceActions, WorkspaceContext } = components;
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      h(
        WorkspaceContext.Provider,
        {
          value: {
            controller,
            policy: fixture.policy,
            openManager() {},
          },
        },
        h(WorkspaceActions),
      ),
    );
  });
  mounted.add(renderer);

  const buttons = renderer.root.findAllByType('button');
  const saveStatus = buttons.find(
    (button) => button.props.className === 'save-status',
  );
  assert.equal(
    saveStatus?.props['aria-label'],
    '保存状態と分析を管理（端末に保存済み）',
  );
  assert.equal(
    buttons.some((button) => button.children.join('').includes('バックアップ')),
    false,
  );
  const manualLink = renderer.root
    .findAllByType('a')
    .find((link) => link.props.href === './manual/');
  assert.ok(
    manualLink,
    'the user guide remains reachable when downloads are disabled',
  );
  assert.equal(
    manualLink.findAllByType('span')[0].children.join(''),
    '使い方',
  );
  assert.equal(exports, 0);
});

test('SessionManager keeps the template download blocked by the policy', async () => {
  const { fixture } = setup({ downloads: false });
  const snapshot = {
    active: null,
    sessions: [],
    status: 'saved',
    error: '',
    conflict: false,
    operation: null,
  };
  const controller = {
    repository: { mode: 'memory' },
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  };
  const { SessionManager, WorkspaceContext } = components;
  let renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      h(
        WorkspaceContext.Provider,
        {
          value: {
            controller,
            policy: fixture.policy,
            openManager() {},
          },
        },
        h(SessionManager, { open: true, onClose() {} }),
      ),
      {
        createNodeMock: (node) =>
          node.type === 'dialog'
            ? {
                open: false,
                showModal() {
                  this.open = true;
                },
                close() {
                  this.open = false;
                },
              }
            : null,
      },
    );
  });
  mounted.add(renderer);

  const button = renderer.root
    .findAllByType('button')
    .find((item) => item.children.join('').includes('テンプレートCSV'));
  assert.ok(button);
  await act(async () => button.props.onClick());
  assert.deepEqual(fixture.downloads, []);
});
