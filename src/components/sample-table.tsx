'use client';
import { useSessionState } from '@/state/workspace-context';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnOrderState,
  type PaginationState,
  type Row,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table';
import {
  ArrowDown,
  ArrowDownUp,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  FileAudio,
  StickyNote,
} from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { finiteNumber, formatScore } from '@/lib/distribution';
import { ScoreValue } from '@/components/score-comparison';
import { useInspector } from '@/components/context-inspector';
import type { Sample } from '@/lib/data';

function abbreviateSampleId(label: string): string {
  const characters = Array.from(label);
  return characters.length > 48
    ? characters.slice(0, 21).join('') + '…' + characters.slice(-26).join('')
    : label;
}

function sameSample(left: Sample, right: Sample): boolean {
  return (
    left.index === right.index &&
    left.row === right.row &&
    left.score === right.score &&
    left.group === right.group
  );
}

function normalizeColumnVisibility(
  value: VisibilityState,
  availableIds: readonly string[],
): VisibilityState {
  const stored =
    value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const visibility = Object.fromEntries(
    availableIds.map((id) => [id, stored[id] !== false]),
  );
  // Keep the table usable if a malformed saved preference hid every column.
  if (availableIds.length && !Object.values(visibility).some(Boolean))
    visibility[availableIds[0]] = true;
  return visibility;
}

export function SampleTable({
  samples,
  idColumn,
  audioColumn = '',
  datasetColumns = [],
  audioDisplay,
  scoreColumn,
  comparisonColumn,
  groupColumn,
  selectedSample,
  onSelect,
  hasAudio,
  notes,
  ignoredIndices,
  onRestore,
  pending = false,
}: {
  samples: Sample[];
  idColumn: string;
  audioColumn?: string;
  datasetColumns?: readonly string[];
  audioDisplay?: readonly {
    filename: string;
    path: string;
    status: string;
    identifier?: string;
  }[];
  scoreColumn: string;
  comparisonColumn: string;
  groupColumn: string;
  selectedSample: Sample | null;
  onSelect: (sample: Sample) => void;
  hasAudio: (sample: Sample) => boolean;
  notes: Record<number, string>;
  ignoredIndices: ReadonlySet<number>;
  onRestore: (rowIndex: number) => void;
  pending?: boolean;
}) {
  const { inspect } = useInspector();
  const selected = selectedSample?.index ?? null;
  const tableRoot = useRef<HTMLDivElement>(null);
  const pendingSelectionFocus = useRef<number | null>(null);
  useLayoutEffect(() => {
    const focusIndex = pendingSelectionFocus.current;
    pendingSelectionFocus.current = null;
    if (focusIndex === null || focusIndex !== selected) return;
    // An explicitly activated row moves to the reference body. Preserve that
    // button's focus without making passive selection or filtering steal it.
    tableRoot.current
      ?.querySelector<HTMLButtonElement>(
        '.selected-sample-reference .sample-link',
      )
      ?.focus({ preventScroll: true });
  });
  const [sorting, setSorting] = useSessionState<SortingState>('tableSorting', [
    { id: 'score', desc: false },
  ]);
  const comparisonColumnId = 'comparison-score:' + comparisonColumn;
  const effectiveSorting = useMemo(() => {
    const available = sorting.flatMap((sort) => {
      if (sort.id.startsWith('comparison-score:'))
        return comparisonColumn ? [{ ...sort, id: comparisonColumnId }] : [];
      if (sort.id.startsWith('data:'))
        return datasetColumns.includes(sort.id.slice(5)) ? [sort] : [];
      return [sort];
    });
    // Removing an optional score column still leaves an explicit, stable order.
    return available.length ? available : [{ id: 'score', desc: false }];
  }, [sorting, comparisonColumn, comparisonColumnId, datasetColumns]);
  const sortingKey = JSON.stringify(effectiveSorting);
  const ignoredKey = useMemo(
    () => [...ignoredIndices].join(','),
    [ignoredIndices],
  );
  const [pagination, setPagination] = useSessionState<PaginationState>(
    'pagination',
    {
      pageIndex: 0,
      pageSize: 8,
    },
  );
  const [previousView, setPreviousView] = useState({
    samples,
    sortingKey,
    ignoredKey,
    ignoredIndices,
  });
  const lastPage = Math.max(
    0,
    Math.ceil(samples.length / pagination.pageSize) - 1,
  );
  const displayPagination = {
    ...pagination,
    pageIndex: Math.min(pagination.pageIndex, lastPage),
  };
  const pageSamples = useMemo(
    () =>
      samples.slice(
        displayPagination.pageIndex * displayPagination.pageSize,
        (displayPagination.pageIndex + 1) * displayPagination.pageSize,
      ),
    [samples, displayPagination.pageIndex, displayPagination.pageSize],
  );
  const columns = useMemo<ColumnDef<Sample>[]>(() => {
    const result: ColumnDef<Sample>[] = [
      {
        id: 'sample',
        accessorFn: (s) =>
          audioDisplay?.[s.index]?.filename ?? '行' + (s.index + 1),
        header: 'ファイル名',
        cell: (ctx) => {
          const audioAvailable = hasAudio(ctx.row.original);
          const filename = String(ctx.getValue());
          const display = audioDisplay?.[ctx.row.original.index];
          const identifier =
            !audioColumn || !display?.path.trim()
              ? (display?.identifier ?? '')
              : '';
          const identitySuffix = identifier ? `（ID: ${identifier}）` : '';
          const audioStatus = audioAvailable
            ? ''
            : audioDisplay?.[ctx.row.original.index]?.status ||
              '未対応: 対応するWAVがありません。';
          return (
            <button
              type="button"
              className="sample-link"
              onClick={(event) => {
                event.stopPropagation();
                pendingSelectionFocus.current =
                  ctx.row.original.index === selected
                    ? null
                    : ctx.row.original.index;
                onSelect(ctx.row.original);
                inspect('sample');
              }}
              title={filename + identitySuffix}
              aria-label={filename + identitySuffix + ' を選択'}
            >
              <span
                className="sample-audio-status"
                title={audioStatus || undefined}
                aria-label={
                  audioStatus ? `音声未対応: ${audioStatus}` : undefined
                }
                role={audioStatus ? 'img' : undefined}
              >
                <FileAudio
                  size={13}
                  className="sample-audio-icon"
                  opacity={audioAvailable ? 1 : 0.25}
                />
              </span>
              <span>{abbreviateSampleId(filename)}</span>
              {notes[ctx.row.original.index] && <StickyNote size={11} />}
            </button>
          );
        },
      },
      ...(audioDisplay
        ? [
            {
              id: 'relative-path',
              accessorFn: (s: Sample) => audioDisplay[s.index]?.path ?? '',
              header: '相対パス',
              cell: (ctx: { getValue: () => unknown }) => (
                <span
                  className="attribute-cell audio-path-cell"
                  title={String(ctx.getValue())}
                >
                  {String(ctx.getValue()) || '—'}
                </span>
              ),
            } satisfies ColumnDef<Sample>,
          ]
        : []),
      {
        id: 'group',
        accessorKey: 'group',
        header: '比較群',
        cell: (ctx) => (
          <span
            className={'sample-tag ' + String(ctx.getValue()).toLowerCase()}
          >
            群{String(ctx.getValue())}
          </span>
        ),
      },
      {
        id: 'score',
        accessorKey: 'score',
        header: scoreColumn,
        cell: (ctx) => (
          <span className="number-cell">
            {formatScore(ctx.getValue() as number, 6)}
          </span>
        ),
      },
      {
        id: 'attribute',
        accessorFn: (s) => s.row[groupColumn],
        header: groupColumn,
        cell: (ctx) => (
          <span className="attribute-cell" title={ctx.getValue<string>() ?? ''}>
            {ctx.getValue<string>() ?? '—'}
          </span>
        ),
      },
      {
        id: 'aggregation',
        header: '集計',
        enableSorting: false,
        cell: (ctx) => {
          const sample = ctx.row.original;
          const ignored = ignoredIndices.has(sample.index);
          const label =
            audioDisplay?.[sample.index]?.filename ??
            (idColumn ? sample.row[idColumn] : 'row-' + (sample.index + 1));
          return (
            <div className="aggregation-status">
              <span className="aggregation-status-label">
                {ignored ? '除外中' : '対象'}
              </span>
              {ignored && (
                <Button
                  className="restore-sample-button"
                  variant="outline"
                  size="sm"
                  aria-label={label + ' を一覧から集計に戻す'}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRestore(sample.index);
                  }}
                >
                  戻す
                </Button>
              )}
            </div>
          );
        },
      },
    ];
    if (comparisonColumn)
      result.splice(3, 0, {
        id: comparisonColumnId,
        accessorFn: (sample) =>
          finiteNumber(sample.row[comparisonColumn]) ?? undefined,
        header: comparisonColumn + '（比較）',
        sortingFn: 'basic',
        sortUndefined: 'last',
        cell: (ctx) => (
          <ScoreValue value={ctx.row.original.row[comparisonColumn]} />
        ),
      });
    const shown = new Set([
      scoreColumn,
      groupColumn,
      comparisonColumn,
      audioColumn,
    ]);
    for (const column of datasetColumns) {
      if (shown.has(column)) continue;
      result.splice(result.length - 1, 0, {
        id: `data:${column}`,
        accessorFn: (sample) => sample.row[column],
        header: column,
        cell: (ctx) => (
          <span className="attribute-cell" title={ctx.getValue<string>() ?? ''}>
            {ctx.getValue<string>() || '—'}
          </span>
        ),
      });
    }
    return result;
  }, [
    idColumn,
    audioColumn,
    datasetColumns,
    audioDisplay,
    scoreColumn,
    comparisonColumn,
    comparisonColumnId,
    groupColumn,
    onSelect,
    inspect,
    hasAudio,
    notes,
    ignoredIndices,
    onRestore,
    selected,
  ]);
  const availableColumnIds = useMemo(
    () => columns.map((column) => column.id ?? ''),
    [columns],
  );
  const [storedColumnVisibility, setStoredColumnVisibility] =
    useSessionState<VisibilityState>('tableColumnVisibility', {});
  const [storedColumnOrder, setStoredColumnOrder] =
    useSessionState<ColumnOrderState>('tableColumnOrder', []);
  const effectiveColumnVisibility = useMemo(
    () => normalizeColumnVisibility(storedColumnVisibility, availableColumnIds),
    [storedColumnVisibility, availableColumnIds],
  );
  const effectiveColumnOrder = useMemo(() => {
    const available = new Set(availableColumnIds);
    const saved = Array.isArray(storedColumnOrder)
      ? storedColumnOrder.filter(
          (id): id is string => typeof id === 'string' && available.has(id),
        )
      : [];
    return [...new Set([...saved, ...availableColumnIds])];
  }, [storedColumnOrder, availableColumnIds]);
  function changeColumnVisibility(
    updater: VisibilityState | ((previous: VisibilityState) => VisibilityState),
  ) {
    setStoredColumnVisibility((previous) => {
      const current = normalizeColumnVisibility(previous, availableColumnIds);
      const next = typeof updater === 'function' ? updater(current) : updater;
      const visibility = normalizeColumnVisibility(next, availableColumnIds);
      const hidden = new Set(
        availableColumnIds.filter(
          (id) => current[id] !== false && visibility[id] === false,
        ),
      );
      if (effectiveSorting.some((sort) => hidden.has(sort.id))) {
        const remaining = effectiveSorting.filter((sort) => !hidden.has(sort.id));
        if (remaining.length) setSorting(remaining);
        else {
          const fallback = columns.find(
            (column) =>
              column.id &&
              !hidden.has(column.id) &&
              visibility[column.id] !== false &&
              column.enableSorting !== false,
          );
          setSorting(
            fallback?.id ? [{ id: fallback.id, desc: false }] : [],
          );
        }
      }
      return visibility;
    });
  }
  function changeColumnOrder(
    updater: ColumnOrderState | ((previous: ColumnOrderState) => ColumnOrderState),
  ) {
    setStoredColumnOrder((previous) => {
      const available = new Set(availableColumnIds);
      const current = Array.isArray(previous)
        ? previous.filter(
            (id): id is string => typeof id === 'string' && available.has(id),
          )
        : [];
      const order = [...new Set([...current, ...availableColumnIds])];
      const next = typeof updater === 'function' ? updater(order) : updater;
      const valid = Array.isArray(next)
        ? next.filter(
            (id): id is string => typeof id === 'string' && available.has(id),
          )
        : [];
      return [...new Set([...valid, ...availableColumnIds])];
    });
  }
  const table = useReactTable({
    data: pageSamples,
    columns,
    state: {
      sorting: effectiveSorting,
      pagination: displayPagination,
      columnVisibility: effectiveColumnVisibility,
      columnOrder: effectiveColumnOrder,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: changeColumnVisibility,
    onColumnOrderChange: changeColumnOrder,
    enableSortingRemoval: false,
    enableMultiRemove: false,
    onPaginationChange: setPagination,
    autoResetPageIndex: false,
    getRowId: (sample) => String(sample.index),
    getCoreRowModel: getCoreRowModel(),
    manualSorting: true,
    manualPagination: true,
    rowCount: samples.length,
    pageCount: Math.max(1, Math.ceil(samples.length / pagination.pageSize)),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 8 } },
  });
  const selectedData = useMemo(
    () => (selectedSample ? [selectedSample] : []),
    [selectedSample],
  );
  // Reuse the table's column definitions for a reference row without adding
  // that row to filtered data, counts, sorting, pagination, or exports.
  const selectedTable = useReactTable({
    data: selectedData,
    columns,
    state: {
      columnVisibility: effectiveColumnVisibility,
      columnOrder: effectiveColumnOrder,
    },
    getRowId: (sample) => String(sample.index),
    getCoreRowModel: getCoreRowModel(),
  });
  const selectedReference = selectedTable.getRowModel().rows[0];
  const selectedPosition = useMemo(
    () => samples.findIndex((sample) => sample.index === selected),
    [samples, selected],
  );
  const initialized = useRef(samples.length > 0);
  useLayoutEffect(() => {
    // The exclusion choice changes before its worker result arrives. Retain
    // the previous coherent row/exclusion pair until that result is ready.
    if (pending) return;
    if (
      previousView.samples !== samples ||
      previousView.sortingKey !== sortingKey ||
      previousView.ignoredKey !== ignoredKey ||
      (samples.length > 0 && pagination.pageIndex > lastPage)
    ) {
      // Exclusion changes may rebuild Sample objects or remove restored rows
      // from an excluded-only list. Neither action should jump to the selected
      // reference row's original page. Other filtering or sorting still resets.
      const sameRows =
        previousView.samples.length === samples.length &&
        previousView.samples.every((sample, index) =>
          sameSample(sample, samples[index]),
        );
      let onlyExclusionRowsChanged = false;
      if (!sameRows && previousView.ignoredKey !== ignoredKey) {
        const exclusionChanged = (sample: Sample) =>
          previousView.ignoredIndices.has(sample.index) !==
          ignoredIndices.has(sample.index);
        const previousUnchanged = previousView.samples.filter(
          (sample) => !exclusionChanged(sample),
        );
        const nextUnchanged = samples.filter(
          (sample) => !exclusionChanged(sample),
        );
        const previousByIndex = new Map(
          previousView.samples.map((sample) => [sample.index, sample]),
        );
        onlyExclusionRowsChanged =
          previousUnchanged.length === nextUnchanged.length &&
          previousUnchanged.every((sample, index) =>
            sameSample(sample, nextUnchanged[index]),
          ) &&
          // A simultaneous dataset/score change must not be mistaken for an
          // exclusion change, including rows whose exclusion was also toggled.
          samples.every((sample) => {
            const previous = previousByIndex.get(sample.index);
            return !previous || sameSample(previous, sample);
          });
      }
      const pageIndex =
        previousView.sortingKey === sortingKey &&
        (sameRows || onlyExclusionRowsChanged || !initialized.current)
          ? Math.min(pagination.pageIndex, lastPage)
          : 0;
      if (samples.length) initialized.current = true;
      setPreviousView({ samples, sortingKey, ignoredKey, ignoredIndices });
      if (pageIndex !== pagination.pageIndex)
        setPagination({ ...pagination, pageIndex });
    }
  }, [
    samples,
    sortingKey,
    ignoredKey,
    ignoredIndices,
    previousView,
    pagination,
    setPagination,
    pending,
    lastPage,
  ]);
  function renderRow(row: Row<Sample>, reference = false) {
    return (
      <TableRow
        key={row.id}
        className={reference ? 'selected-sample-reference' : undefined}
        data-state={row.original.index === selected ? 'selected' : undefined}
        data-excluded={ignoredIndices.has(row.original.index)}
        aria-selected={row.original.index === selected}
        onClick={() => {
          onSelect(row.original);
          inspect('sample');
        }}
      >
        {row.getVisibleCells().map((cell) => (
          <TableCell
            key={cell.id}
            data-column={cell.column.id}
            className={
              cell.column.id === 'aggregation' ? 'aggregation-cell' : undefined
            }
          >
            {reference &&
              cell.column.id === table.getVisibleLeafColumns()[0]?.id && (
              <span className="selected-sample-status">
                選択中
                {selectedPosition < 0 && (
                  <span className="selection-outside-filter">絞り込み外</span>
                )}
              </span>
              )}
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </TableCell>
        ))}
      </TableRow>
    );
  }
  const orderedColumns = table.getAllLeafColumns();
  const visibleColumnCount = table.getVisibleLeafColumns().length;
  function moveColumn(columnId: string, direction: -1 | 1) {
    const current = orderedColumns.map((column) => column.id);
    const from = current.indexOf(columnId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= current.length) return;
    [current[from], current[to]] = [current[to], current[from]];
    changeColumnOrder(current);
  }
  return (
    <div className="samples-table" ref={tableRoot}>
      <details className="table-column-controls">
        <summary>
          列の表示・順序
          <span className="table-column-summary" aria-live="polite">
            {visibleColumnCount}列表示
          </span>
        </summary>
        <div className="table-column-settings">
          <p>
            列の表示を切り替え、上下ボタンで順序を変更できます。少なくとも1列は表示されます。ソート中の列を隠すと、表示中の列で並べ替えます。
          </p>
          <ul aria-label="一覧の列設定">
            {orderedColumns.map((column, index) => {
              const header = column.columnDef.header;
              const label = typeof header === 'string' ? header : column.id;
              const visible = column.getIsVisible();
              const lastVisible = visible && visibleColumnCount <= 1;
              return (
                <li key={column.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={visible}
                      disabled={lastVisible}
                      aria-label={`${label}列を表示`}
                      onChange={column.getToggleVisibilityHandler()}
                    />
                    <span>{label}</span>
                  </label>
                  <span className="table-column-order-actions">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`${label}列を上へ`}
                      disabled={index === 0}
                      onClick={() => moveColumn(column.id, -1)}
                    >
                      <ChevronUp size={14} />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`${label}列を下へ`}
                      disabled={index === orderedColumns.length - 1}
                      onClick={() => moveColumn(column.id, 1)}
                    >
                      <ChevronDown size={14} />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      </details>
      <Table
        containerAs="section"
        containerProps={{
          className: 'samples-table-scroll',
          role: 'region',
          'aria-label': 'サンプル一覧の横スクロール領域',
          tabIndex: 0,
        }}
      >
        <TableHeader>
          {table.getHeaderGroups().map((g) => (
            <TableRow key={g.id}>
              {g.headers.map((h) => {
                const direction = h.column.getIsSorted();
                const nextDirection = h.column.getNextSortingOrder();
                const headerLabel =
                  typeof h.column.columnDef.header === 'string'
                    ? h.column.columnDef.header
                    : h.column.id;
                const directionLabel =
                  direction === 'asc'
                    ? '昇順'
                    : direction === 'desc'
                      ? '降順'
                      : '未指定';
                const nextAction =
                  nextDirection === 'desc' ? '降順にする' : '昇順にする';
                return (
                  <TableHead
                    key={h.id}
                    data-column={h.column.id}
                    title={headerLabel}
                    aria-sort={
                      h.column.getCanSort()
                        ? direction === 'asc'
                          ? 'ascending'
                          : direction === 'desc'
                            ? 'descending'
                            : 'none'
                        : undefined
                    }
                    className={
                      h.column.getCanSort()
                        ? 'sortable-header'
                        : h.column.id === 'aggregation'
                          ? 'aggregation-cell'
                          : undefined
                    }
                  >
                    {h.column.getCanSort() ? (
                      <button
                        type="button"
                        className="table-sort"
                        data-sort={direction || 'none'}
                        aria-label={`${headerLabel}：${directionLabel}。${nextAction}`}
                        onClick={h.column.getToggleSortingHandler()}
                      >
                        <span className="table-sort-label">
                          {flexRender(
                            h.column.columnDef.header,
                            h.getContext(),
                          )}
                        </span>
                        <span
                          className="table-sort-direction"
                          aria-hidden="true"
                        >
                          {direction ? (
                            <>
                              {direction === 'asc' ? (
                                <ArrowUp size={14} />
                              ) : (
                                <ArrowDown size={14} />
                              )}
                              <span>{directionLabel}</span>
                            </>
                          ) : (
                            <ArrowDownUp size={12} />
                          )}
                        </span>
                      </button>
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        {selectedReference && (
          <TableBody aria-label="選択中のサンプル（参照）">
            {renderRow(selectedReference, true)}
          </TableBody>
        )}
        <TableBody aria-label="一覧の表示ページ">
          {table.getRowModel().rows.map((row) => renderRow(row))}
        </TableBody>
      </Table>
      {samples.length === 0 && (
        <div className="table-empty">条件に一致するサンプルはありません。</div>
      )}
      <div className="table-footer">
        <span>
          {samples.length.toLocaleString()}件中{' '}
          {samples.length
            ? table.getState().pagination.pageIndex * pagination.pageSize + 1
            : 0}
          –
          {Math.min(
            (table.getState().pagination.pageIndex + 1) * pagination.pageSize,
            samples.length,
          )}
          件
        </span>
        <div>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="前のページ"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
          >
            <ChevronLeft size={14} />
          </Button>
          <span>
            {table.getState().pagination.pageIndex + 1} /{' '}
            {Math.max(1, table.getPageCount())}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="次のページ"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
          >
            <ChevronRight size={14} />
          </Button>
        </div>
      </div>
    </div>
  );
}
