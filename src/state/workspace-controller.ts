import type {
  BrowserRepository,
  CreateSessionInput,
  LoadedSession,
  SaveSessionInput,
  SessionRecord,
} from '../../packages/contracts/storage.ts';

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error';
export type WorkspaceSnapshot = {
  active: LoadedSession | null;
  sessions: SessionRecord[];
  status: SaveStatus;
  error: string;
  conflict: boolean;
  operation: string | null;
};

type SaveAttempt = {
  sessionId: string;
  version: number;
  audioVersion: number;
  input: SaveSessionInput;
};
const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;
const errorCode = (error: unknown) =>
  error && typeof error === 'object' && 'code' in error
    ? error.code
    : undefined;

/** Drafts advance independently of committed revisions. No await may discard a newer draft. */
export class WorkspaceController {
  private snapshot: WorkspaceSnapshot = {
    active: null,
    sessions: [],
    status: 'saved',
    error: '',
    conflict: false,
    operation: null,
  };
  private listeners = new Set<() => void>();
  private version = 0;
  private savedVersion = 0;
  private audioVersion = 0;
  private savedAudioVersion = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> | null = null;
  private attempt: SaveAttempt | null = null;
  private operations: Promise<unknown> = Promise.resolve();
  private removals = new Map<string, Promise<void>>();
  private disposed = false;
  private errorKind: 'save' | 'refresh' | null = null;
  private refreshing: Promise<void> | null = null;
  readonly repository: BrowserRepository;
  private delay: number;
  constructor(repository: BrowserRepository, delay = 500) {
    this.repository = repository;
    this.delay = delay;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private alive() {
    if (this.disposed) throw new Error('この分析画面は閉じられています。');
  }
  private emit(patch: Partial<WorkspaceSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  async refresh(): Promise<void> {
    this.alive();
    if (this.refreshing) return this.refreshing;
    const work = this.performRefresh();
    this.refreshing = work;
    void work
      .finally(() => {
        if (this.refreshing === work) this.refreshing = null;
      })
      .catch(() => {});
    return work;
  }
  private async performRefresh() {
    try {
      const sessions = await this.repository.listSessions();
      this.alive();
      const clearRefreshError = this.errorKind === 'refresh';
      if (clearRefreshError) this.errorKind = null;
      this.emit({
        sessions,
        ...(clearRefreshError ? { error: '' } : {}),
      });
    } catch (error) {
      if (!this.disposed && this.errorKind !== 'save') {
        this.errorKind = 'refresh';
        this.emit({
          error: errorMessage(
            error,
            '保存した分析の一覧を読み込めません。もう一度お試しください。',
          ),
        });
      }
      throw error;
    }
  }
  /** Refreshes the manager list while keeping the failure visible in the UI. */
  async refreshForManager(): Promise<boolean> {
    try {
      await this.refresh();
      return true;
    } catch {
      return false;
    }
  }
  private async refreshAfterCommit() {
    try {
      await this.refresh();
    } catch (error) {
      // The preceding mutation already committed; a list refresh failure must
      // not invite the user to repeat it or mark that committed state unsaved.
      if (!this.snapshot.error) {
        this.errorKind = 'refresh';
        this.emit({
          error: errorMessage(
            error,
            '保存した分析の一覧を読み込めません。もう一度管理画面を開いてください。',
          ),
        });
      }
    }
  }
  setState = (key: string, update: unknown, initial?: unknown) => {
    const active = this.snapshot.active;
    if (!active || this.disposed) return;
    const previous = Object.hasOwn(active.record.state, key)
      ? active.record.state[key]
      : initial;
    const value = typeof update === 'function' ? update(previous) : update;
    if (Object.is(value, previous)) return;
    const state = { ...active.record.state, [key]: value };
    if (key === 'idColumn' || key === 'audioColumn')
      delete state.audioAnalyses;
    validateApplicationState(
      state,
      active.dataset.rows.length,
      active.dataset.columns,
    );
    this.version++;
    this.emit({
      active: { ...active, record: { ...active.record, state } },
      status: 'unsaved',
    });
    this.schedule();
  };
  updateAudio(files: Map<string, File>) {
    if (!this.snapshot.active || this.disposed) return;
    if (
      !(files instanceof Map) ||
      [...files].some(
        ([key, file]) => typeof key !== 'string' || !(file instanceof File),
      )
    )
      throw new Error('音声対応の形式が不正です。');
    const previous = this.snapshot.active.audioFiles;
    if (
      files.size === previous.size &&
      [...files].every(([key, file]) => previous.get(key) === file)
    )
      return;
    this.audioVersion++;
    this.version++;
    const state = { ...this.snapshot.active.record.state };
    delete state.audioAnalyses;
    this.emit({
      active: {
        ...this.snapshot.active,
        audioFiles: new Map(files),
        record: { ...this.snapshot.active.record, state },
      },
      status: 'unsaved',
    });
    this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    if (this.snapshot.conflict || this.snapshot.operation || this.disposed)
      return;
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, this.delay);
  }
  flush(): Promise<void> {
    try {
      this.alive();
    } catch (error) {
      return Promise.reject(error);
    }
    clearTimeout(this.timer);
    if (this.saving) return this.saving;
    const work = this.drainSaves();
    this.saving = work;
    void work
      .finally(() => {
        if (this.saving === work) this.saving = null;
      })
      .catch(() => {});
    return work;
  }
  private async drainSaves(): Promise<void> {
    while (this.snapshot.active && this.version !== this.savedVersion) {
      this.alive();
      if (this.snapshot.conflict)
        throw new Error(
          '別のタブで更新されました。編集を別の分析に保存するか、保存済みを開き直してください。',
        );
      const active = this.snapshot.active;
      if (!this.attempt)
        this.attempt = {
          sessionId: active.record.id,
          version: this.version,
          audioVersion: this.audioVersion,
          input: {
            expectedRevision: active.record.revision,
            operationId: crypto.randomUUID(),
            state: structuredClone(active.record.state),
            ...(this.audioVersion !== this.savedAudioVersion
              ? { audioFiles: new Map(active.audioFiles) }
              : {}),
          },
        };
      const attempt = this.attempt;
      this.errorKind = null;
      this.emit({ status: 'saving', error: '' });
      try {
        const record = await this.repository.saveSession(
          attempt.sessionId,
          attempt.input,
        );
        this.alive();
        const current = this.snapshot.active;
        if (!current || current.record.id !== attempt.sessionId)
          throw new Error('保存先の分析が変わりました。');
        // An idempotent retry can return a later revision from another tab.
        // That is a conflict, not proof that this displayed draft is saved.
        if (
          record.id !== attempt.sessionId ||
          record.datasetVersionId !== current.record.datasetVersionId ||
          record.revision !== attempt.input.expectedRevision + 1
        ) {
          throw Object.assign(
            new Error(
              '別のタブで保存内容が進んでいます。現在の編集は未保存のまま保持しています。編集を残すには別の分析として保存してください。',
            ),
            { code: 'CONFLICT' },
          );
        }
        validateApplicationState(
          record.state,
          current.dataset.rows.length,
          current.dataset.columns,
        );
        this.savedVersion = attempt.version;
        this.savedAudioVersion = attempt.audioVersion;
        this.attempt = null;
        this.errorKind = null;
        this.emit({
          active: {
            ...current,
            record: { ...record, state: current.record.state },
          },
          sessions: this.snapshot.sessions.map((entry) =>
            entry.id === record.id ? record : entry,
          ),
          status: this.version === attempt.version ? 'saved' : 'unsaved',
          error: '',
          conflict: false,
        });
      } catch (error) {
        this.errorKind = 'save';
        this.emit({
          status: 'error',
          error: errorMessage(
            error,
            '保存できません。編集内容はこの画面に残っています。',
          ),
          conflict: errorCode(error) === 'CONFLICT',
        });
        // Preserve this exact operation ID and payload for uncertain outcomes.
        // Any newer edits are drained only after this attempt is acknowledged.
        throw error;
      }
    }
  }
  private activate(loaded: LoadedSession) {
    this.alive();
    validateApplicationState(
      loaded.record.state,
      loaded.dataset.rows.length,
      loaded.dataset.columns,
    );
    clearTimeout(this.timer);
    this.version = this.savedVersion = 0;
    this.audioVersion = this.savedAudioVersion = 0;
    this.attempt = null;
    this.errorKind = null;
    this.emit({ active: loaded, status: 'saved', error: '', conflict: false });
  }
  private operation<T>(label: string, body: () => Promise<T>): Promise<T> {
    const run = async () => {
      this.alive();
      clearTimeout(this.timer);
      this.emit({ operation: label });
      try {
        return await body();
      } finally {
        this.emit({ operation: null });
        if (
          this.version !== this.savedVersion &&
          this.snapshot.status !== 'error'
        )
          this.schedule();
      }
    };
    const result = this.operations.then(run, run);
    this.operations = result.catch(() => undefined);
    return result;
  }
  create(input: CreateSessionInput): Promise<void> {
    return this.operation('create', async () => {
      validateApplicationState(
        input.state,
        input.dataset.rows.length,
        input.dataset.columns,
      );
      await this.flush();
      this.alive();
      const record = await this.repository.createSession(input);
      const loaded = await this.repository.loadSession(record.id);
      validateApplicationState(
        loaded.record.state,
        loaded.dataset.rows.length,
        loaded.dataset.columns,
      );
      await this.flush(); // save edits made while the new dataset was loading
      this.activate(loaded);
      await this.refreshAfterCommit();
    });
  }
  open(id: string): Promise<void> {
    return this.operation('open', async () => {
      if (this.snapshot.active?.record.id === id) return;
      await this.flush();
      this.alive();
      const loaded = await this.repository.loadSession(id);
      validateApplicationState(
        loaded.record.state,
        loaded.dataset.rows.length,
        loaded.dataset.columns,
      );
      await this.flush();
      this.activate(loaded);
      await this.refreshAfterCommit();
    });
  }
  saveAsCopy(): Promise<void> {
    return this.operation('copy', async () => {
      if (this.saving) await this.saving.catch(() => {});
      this.alive();
      const active = this.snapshot.active;
      if (!active) return;
      const version = this.version;
      const record = await this.repository.createSession({
        title: active.record.title.slice(0, 1000) + '（編集のコピー）',
        dataset: active.dataset,
        ...(active.source ? { source: active.source } : {}),
        audioFiles: active.audioFiles,
        state: active.record.state,
      });
      const loaded = await this.repository.loadSession(record.id);
      this.alive();
      if (
        this.version !== version ||
        this.snapshot.active?.record.id !== active.record.id
      ) {
        await this.refreshAfterCommit();
        throw new Error(
          'コピーを作成しましたが、その間に追加の編集がありました。元の画面に編集を残しています。',
        );
      }
      this.activate(loaded);
      await this.refreshAfterCommit();
    });
  }
  reloadSaved(): Promise<void> {
    return this.operation('reload', async () => {
      if (this.saving) await this.saving.catch(() => {});
      this.alive();
      const active = this.snapshot.active;
      if (!active) return;
      const version = this.version;
      const loaded = await this.repository.loadSession(active.record.id);
      this.alive();
      if (this.version !== version)
        throw new Error(
          '読み込み中に追加の編集がありました。編集を保持して、開き直しを中止しました。',
        );
      this.activate(loaded);
      await this.refreshAfterCommit();
    });
  }
  remove(id: string, revision: number): Promise<void> {
    const duplicate = this.removals.get(id);
    if (duplicate) return duplicate;
    const result = this.operation('delete', async () => {
      const isActive = id === this.snapshot.active?.record.id;
      if (isActive) await this.flush();
      this.alive();
      const version = this.version;
      // Own autosave can have advanced the revision since confirmation opened.
      const expected = isActive
        ? this.snapshot.active!.record.revision
        : revision;
      try {
        await this.repository.deleteSession(id, expected);
      } catch (error) {
        if (errorCode(error) !== 'NOT_FOUND') throw error;
      }
      this.alive();
      if (id === this.snapshot.active?.record.id) {
        if (this.version !== version) {
          this.emit({
            status: 'error',
            conflict: true,
            error:
              '分析は削除されましたが、操作中の追加編集をこの画面に残しています。別の分析に保存してください。',
          });
          await this.refreshAfterCommit();
          return; // keep original File objects and do not collect its assets yet
        }
        this.version = this.savedVersion = 0;
        this.audioVersion = this.savedAudioVersion = 0;
        this.attempt = null;
        this.emit({
          active: null,
          error: '',
          conflict: false,
          status: 'saved',
        });
      }
      try {
        await this.repository.collectOrphans();
      } catch (error) {
        this.emit({
          error:
            '分析を削除しましたが、不要ファイルの整理は完了していません。' +
            errorMessage(error, ''),
        });
      }
      await this.refreshAfterCommit();
    });
    this.removals.set(id, result);
    void result
      .finally(() => {
        if (this.removals.get(id) === result) this.removals.delete(id);
      })
      .catch(() => {});
    return result;
  }
  exportBundle(): Promise<Blob> {
    return this.operation('export', async () => {
      await this.flush();
      this.alive();
      if (!this.snapshot.active) throw new Error('分析を選んでください。');
      return this.repository.exportBundle(this.snapshot.active.record.id);
    });
  }
  importBundle(blob: Blob): Promise<void> {
    return this.operation('import', async () => {
      await this.flush();
      this.alive();
      const loaded = await this.repository.importBundle(blob);
      this.alive();
      try {
        validateApplicationState(
          loaded.record.state,
          loaded.dataset.rows.length,
          loaded.dataset.columns,
        );
      } catch (error) {
        try {
          await this.repository.deleteSession(
            loaded.record.id,
            loaded.record.revision,
          );
          await this.repository.collectOrphans();
        } catch {
          this.emit({
            error:
              '復元データの画面状態が不正です。追加された分析の削除を完了できませんでした。',
          });
        }
        throw error;
      }
      await this.flush();
      this.activate(loaded);
      await this.refreshAfterCommit();
    });
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.listeners.clear();
    this.repository.close();
  }
}

function invalid(field: string): never {
  throw new Error('保存状態の ' + field + ' が不正です。');
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid(field);
  return value as Record<string, unknown>;
}
function keys(
  value: Record<string, unknown>,
  fields: string[],
  field: string,
  required = fields,
) {
  if (
    Object.keys(value).some((key) => !fields.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    invalid(field);
}
function text(
  value: unknown,
  field: string,
  maximum = 100_000,
): asserts value is string {
  if (typeof value !== 'string' || value.length > maximum) invalid(field);
}
function bool(value: unknown, field: string) {
  if (typeof value !== 'boolean') invalid(field);
}
function number(
  value: unknown,
  field: string,
  min = -Number.MAX_VALUE,
  max = Number.MAX_VALUE,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    invalid(field);
}
function integer(value: unknown, field: string, min: number, max: number) {
  number(value, field, min, max);
  if (!Number.isSafeInteger(value)) invalid(field);
}
function choice(value: unknown, choices: unknown[], field: string) {
  if (!choices.includes(value)) invalid(field);
}
function extent(
  value: unknown,
  field: string,
  minAllowed = -Number.MAX_VALUE,
  scale = 1,
) {
  const range = object(value, field);
  keys(range, ['min', 'max'], field);
  number(range.min, field, minAllowed);
  number(range.max, field, minAllowed);
  if (
    range.min >= range.max ||
    !Number.isFinite(range.max - range.min) ||
    !Number.isFinite(range.min * scale) ||
    !Number.isFinite(range.max * scale)
  )
    invalid(field);
}

/** Side-effect-free validation: do not run getters or silently coerce sparse/typed values. */
export function assertFiniteJson(value: unknown): void {
  const seen = new Set<object>();
  let visited = 0;
  function visit(item: unknown, depth: number) {
    if (++visited > 250_000 || depth > 64) invalid('JSONの深さ/件数');
    if (item === null || typeof item === 'string' || typeof item === 'boolean')
      return;
    if (typeof item === 'number') {
      number(item, '数値');
      return;
    }
    if (!item || typeof item !== 'object' || seen.has(item)) invalid('JSON');
    if (!Array.isArray(item)) object(item, 'JSON');
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Reflect.ownKeys(item).some((key) => typeof key === 'symbol'))
      invalid('JSON');
    for (const descriptor of Object.values(descriptors))
      if ('get' in descriptor || 'set' in descriptor) invalid('アクセサー');
    if (
      Array.isArray(item) &&
      (Object.keys(item).length !== item.length ||
        Object.keys(item).some((key, i) => key !== String(i)))
    )
      invalid('配列');
    seen.add(item);
    for (const key of Object.keys(item))
      visit(descriptors[key].value, depth + 1);
    seen.delete(item);
  }
  visit(value, 0);
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength >
    2 * 1024 ** 2
  )
    invalid('JSONの容量');
}

export function validateApplicationState(
  state: Record<string, unknown>,
  rows: number,
  columns?: readonly string[],
) {
  assertFiniteJson(state);
  object(state, 'state');
  integer(rows, '行数', 1, 100_000);
  const strings = [
    'score',
    'idColumn',
    'audioColumn',
    'numericA',
    'numericB',
    'filterColumn',
    'filterValue',
    'rangeLo',
    'rangeHi',
    'query',
    'targetPercent',
    'comparisonColumn',
  ];
  const allowed = [
    'schemaVersion',
    'rowCount',
    ...strings,
    'queryMode',
    'group',
    'bins',
    'method',
    'range',
    'overlapOnly',
    'selected',
    'notes',
    'okGroup',
    'direction',
    'reviewRecords',
    'reviewHistory',
    'disclosures',
    'audioPreferences',
    'inspectorWidth',
    'spectrogramPreferences',
    'tableSorting',
    'pagination',
    'viewport',
    'thresholdSetting',
    'filterDecision',
    'audioAnalyses',
    'inspectorSelection',
  ];
  keys(state, allowed, '未対応の項目', ['schemaVersion']);
  if (state.schemaVersion !== 1) invalid('schemaVersion');
  if (state.rowCount !== undefined && state.rowCount !== rows)
    invalid('rowCount');
  const column = (value: unknown, field: string) => {
    text(value, field, 4096);
    if (value && columns && !columns.includes(value)) invalid(field);
  };
  for (const key of strings)
    if (Object.hasOwn(state, key)) text(state[key], key);
  for (const key of [
    'score',
    'idColumn',
    'audioColumn',
    'filterColumn',
    'comparisonColumn',
  ])
    if (Object.hasOwn(state, key)) column(state[key], key);
  for (const key of ['method', 'overlapOnly'])
    if (Object.hasOwn(state, key)) bool(state[key], key);
  if (state.bins !== undefined)
    choice(state.bins, [12, 24, 48, 96, 192], 'bins');
  if (state.okGroup !== undefined) choice(state.okGroup, ['A', 'B'], 'okGroup');
  if (state.direction !== undefined)
    choice(state.direction, ['high', 'low'], 'direction');
  if (state.queryMode !== undefined)
    choice(state.queryMode, ['partial', 'exact'], 'queryMode');
  const row = (value: unknown, field: string) =>
    integer(value, field, 0, rows - 1);
  const rowKey = (key: string, field: string) => {
    if (!/^(0|[1-9]\d*)$/.test(key)) invalid(field);
    row(Number(key), field);
  };
  if (state.selected !== undefined && state.selected !== null)
    row(state.selected, 'selected');
  if (state.notes !== undefined)
    for (const [key, value] of Object.entries(object(state.notes, 'notes'))) {
      rowKey(key, 'notes');
      text(value, 'notes');
    }
  const group = (value: unknown, field: string) => {
    const g = object(value, field);
    choice(g.kind, ['category', 'numeric'], field);
    keys(
      g,
      g.kind === 'category'
        ? ['kind', 'column', 'a', 'b']
        : ['kind', 'column', 'upperA', 'lowerB'],
      field,
    );
    column(g.column, field);
    if (g.kind === 'category') {
      text(g.a, field);
      text(g.b, field);
    } else {
      number(g.upperA, field);
      number(g.lowerB, field);
    }
  };
  if (state.group !== undefined) group(state.group, 'group');
  if (state.range !== undefined && state.range !== null) {
    const r = object(state.range, 'range');
    keys(r, ['lo', 'hi', 'includeHi'], 'range');
    number(r.lo, 'range');
    number(r.hi, 'range');
    bool(r.includeHi, 'range');
    if (r.lo > r.hi) invalid('range');
  }
  const rule = (value: unknown, field: string) => {
    const r = object(value, field);
    keys(r, ['threshold', 'operator', 'direction'], field);
    number(r.threshold, field);
    choice(r.direction, ['high', 'low'], field);
    choice(
      r.operator,
      r.direction === 'high' ? ['gt', 'gte'] : ['lt', 'lte'],
      field,
    );
  };
  const calibration = (value: unknown, field: string) => {
    const c = object(value, field);
    keys(
      c,
      [
        'method',
        'rule',
        'targetPercent',
        'referenceCount',
        'detectedCount',
        'actualPercent',
      ],
      field,
    );
    choice(c.method, ['manual', 'ok-rate'], field);
    rule(c.rule, field);
    if (c.method === 'manual') {
      if (c.targetPercent !== null) invalid(field);
    } else number(c.targetPercent, field, 0, 100);
    integer(c.referenceCount, field, 1, rows);
    integer(c.detectedCount, field, 0, c.referenceCount as number);
    number(c.actualPercent, field, 0, 100);
  };
  const summary = (value: unknown, field: string) => {
    const s = object(value, field);
    keys(
      s,
      [
        'nA',
        'nB',
        'total',
        'prAuc',
        'positiveFraction',
        'okGroup',
        'positiveGroup',
        'scoreDirection',
      ],
      field,
    );
    for (const key of ['nA', 'nB', 'total']) integer(s[key], field, 0, rows);
    if ((s.nA as number) + (s.nB as number) !== s.total) invalid(field);
    for (const key of ['prAuc', 'positiveFraction'])
      if (s[key] !== null) number(s[key], field, 0, 1);
    choice(s.okGroup, ['A', 'B'], field);
    choice(s.positiveGroup, ['A', 'B'], field);
    if (s.okGroup === s.positiveGroup) invalid(field);
    choice(s.scoreDirection, ['high', 'low'], field);
  };
  const decision = (value: unknown, field: string) => {
    const d = object(value, field);
    keys(
      d,
      [
        'scoreColumn',
        'group',
        'filter',
        'okGroup',
        'scoreDirection',
        'threshold',
        'before',
      ],
      field,
    );
    column(d.scoreColumn, field);
    group(d.group, field);
    if (d.filter !== null) {
      const f = object(d.filter, field);
      keys(f, ['column', 'value'], field);
      column(f.column, field);
      text(f.value, field);
    }
    choice(d.okGroup, ['A', 'B'], field);
    choice(d.scoreDirection, ['high', 'low'], field);
    if (d.threshold !== null) calibration(d.threshold, field);
    summary(d.before, field);
  };
  const review = (value: unknown, field: string, history: boolean) => {
    const entry = object(value, field);
    keys(
      entry,
      [
        'rowIndex',
        'reason',
        'at',
        'groupColumn',
        'groupValue',
        'decision',
        ...(history ? ['action'] : []),
      ],
      field,
    );
    row(entry.rowIndex, field);
    text(entry.reason, field);
    text(entry.at, field, 64);
    if (!Number.isFinite(Date.parse(entry.at))) invalid(field);
    column(entry.groupColumn, field);
    text(entry.groupValue, field);
    decision(entry.decision, field);
    if (history) choice(entry.action, ['ignore', 'restore'], field);
    return entry;
  };
  if (state.reviewRecords !== undefined)
    for (const [key, value] of Object.entries(
      object(state.reviewRecords, 'reviewRecords'),
    )) {
      rowKey(key, 'reviewRecords');
      if (review(value, 'reviewRecords', false).rowIndex !== Number(key))
        invalid('reviewRecords');
    }
  if (state.reviewHistory !== undefined) {
    if (
      !Array.isArray(state.reviewHistory) ||
      state.reviewHistory.length > 100_000
    )
      invalid('reviewHistory');
    for (const value of state.reviewHistory)
      review(value, 'reviewHistory', true);
  }
  if (state.disclosures !== undefined)
    for (const [key, value] of Object.entries(
      object(state.disclosures, 'disclosures'),
    )) {
      text(key, 'disclosures', 256);
      bool(value, 'disclosures');
    }
  if (state.audioPreferences !== undefined) {
    const a = object(state.audioPreferences, 'audioPreferences');
    keys(a, ['volume', 'muted', 'playbackRate', 'gainDb'], 'audioPreferences');
    number(a.volume, 'volume', 0, 1);
    bool(a.muted, 'muted');
    number(a.playbackRate, 'playbackRate', 0.0625, 16);
    integer(a.gainDb, 'gainDb', 0, 36);
  }
  if (state.inspectorWidth !== undefined)
    number(state.inspectorWidth, 'inspectorWidth', 280, 760);
  if (state.spectrogramPreferences !== undefined) {
    const p = object(state.spectrogramPreferences, 'spectrogramPreferences');
    keys(p, ['time', 'frequency', 'color'], 'spectrogramPreferences');
    for (const axis of ['time', 'frequency', 'color']) {
      const a = object(p[axis], axis);
      keys(a, ['range', 'minInput', 'maxInput', 'draftStarted'], axis, [
        'range',
        'minInput',
        'maxInput',
      ]);
      if (a.range !== null)
        extent(
          a.range,
          axis,
          axis === 'color' ? -Number.MAX_VALUE : 0,
          axis === 'frequency' ? 1000 : 1,
        );
      text(a.minInput, axis);
      text(a.maxInput, axis);
      if (a.draftStarted !== undefined) bool(a.draftStarted, axis);
    }
  }
  if (state.tableSorting !== undefined) {
    if (!Array.isArray(state.tableSorting) || state.tableSorting.length > 5)
      invalid('tableSorting');
    const used = new Set<string>();
    for (const item of state.tableSorting) {
      const s = object(item, 'tableSorting');
      keys(s, ['id', 'desc'], 'tableSorting');
      text(s.id, 'tableSorting', 8192);
      bool(s.desc, 'tableSorting');
      if (used.has(s.id)) invalid('tableSorting');
      used.add(s.id);
      if (!['sample', 'group', 'score', 'attribute'].includes(s.id)) {
        if (!s.id.startsWith('comparison-score:') || !s.id.slice(17))
          invalid('tableSorting');
        column(s.id.slice(17), 'tableSorting');
      }
    }
  }
  for (const name of ['pagination'])
    if (state[name] !== undefined) {
      const p = object(state[name], name);
      keys(p, ['pageIndex', 'pageSize'], name);
      integer(p.pageIndex, name, 0, 100_000);
      integer(p.pageSize, name, 1, 1000);
    }
  if (state.viewport !== undefined && state.viewport !== null) {
    const v = object(state.viewport, 'viewport');
    keys(
      v,
      ['scoreColumn', 'selection', 'lower', 'upper', 'error'],
      'viewport',
    );
    column(v.scoreColumn, 'viewport');
    text(v.lower, 'viewport');
    text(v.upper, 'viewport');
    text(v.error, 'viewport');
    const s = object(v.selection, 'viewport.selection');
    keys(s, ['mode', 'extent'], 'viewport.selection');
    choice(s.mode, ['full', 'central', 'manual'], 'viewport.selection');
    if (s.mode === 'full') {
      if (s.extent !== null) invalid('viewport.extent');
    } else extent(s.extent, 'viewport.extent');
  }
  if (state.thresholdSetting !== undefined && state.thresholdSetting !== null) {
    const t = object(state.thresholdSetting, 'thresholdSetting');
    keys(t, ['scope', 'selection'], 'thresholdSetting');
    text(t.scope, 'thresholdSetting');
    const s = object(t.selection, 'thresholdSetting.selection');
    choice(s.kind, ['ok-rate', 'manual'], 'thresholdSetting');
    if (s.kind === 'ok-rate') {
      keys(s, ['kind', 'targetPercent'], 'thresholdSetting');
      number(s.targetPercent, 'thresholdSetting', 0, 100);
    } else {
      keys(s, ['kind', 'rule'], 'thresholdSetting');
      rule(s.rule, 'thresholdSetting');
    }
  }
  if (state.filterDecision !== undefined) {
    const f = object(state.filterDecision, 'filterDecision');
    keys(f, ['filter', 'scope'], 'filterDecision');
    choice(
      f.filter,
      ['all', 'false-positive', 'false-negative', 'ignored'],
      'filterDecision',
    );
    text(f.scope, 'filterDecision');
  }
  if (state.inspectorSelection !== undefined) {
    const i = object(state.inspectorSelection, 'inspectorSelection');
    keys(i, ['target', 'focus'], 'inspectorSelection');
    choice(i.target, ['threshold', 'sample'], 'inspectorSelection');
    bool(i.focus, 'inspectorSelection');
  }
  if (state.audioAnalyses !== undefined)
    for (const [key, value] of Object.entries(
      object(state.audioAnalyses, 'audioAnalyses'),
    )) {
      rowKey(key, 'audioAnalyses');
      const a = object(value, 'audioAnalyses');
      keys(
        a,
        [
          'sampleRate',
          'channels',
          'duration',
          'recipe',
          'runtimeLockHash',
          'sourceName',
          'sourceHash',
        ],
        'audioAnalyses',
      );
      integer(a.sampleRate, 'audioAnalyses.sampleRate', 1, 2 ** 32 - 1);
      integer(a.channels, 'audioAnalyses.channels', 1, 65535);
      number(a.duration, 'audioAnalyses.duration', Number.MIN_VALUE);
      object(a.recipe, 'audioAnalyses.recipe');
      text(a.runtimeLockHash, 'audioAnalyses.runtimeLockHash', 256);
      text(a.sourceName, 'audioAnalyses.sourceName', 4096);
      for (const hash of ['sourceHash', 'runtimeLockHash'])
        if (
          typeof a[hash] !== 'string' ||
          !/^[a-f0-9]{64}$/.test(a[hash] as string)
        )
          invalid('audioAnalyses.' + hash);
    }
}
