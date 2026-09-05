'use client';
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  DefaultZIndexes,
  Tooltip,
  XAxis,
  YAxis,
  ZIndexLayer,
  usePlotArea,
  useXAxisInverseScale,
  useXAxisScale,
  useYAxisScale,
} from 'recharts';
import { ChartContainer } from '@/components/ui/chart';
import {
  DistributionSymbol,
  SelectedSamplePoint,
  DISTRIBUTION_DASH,
  OVERLAP_HATCH_PATH,
  OVERLAP_HATCH_OPACITY,
} from '@/components/distribution-symbol';
import { useInspector } from '@/components/context-inspector';
import {
  useThreshold,
  type ThresholdReport,
} from '@/components/threshold-context';
import {
  formatNumber,
  formatScore,
  histogramBarCenter,
  histogramRange,
  type Distribution,
  type ScoreRange,
} from '@/lib/distribution';
import type { ThresholdRule } from '@domain/threshold';

function SelectedScoreMarker({
  distribution: d,
  score,
  group,
}: {
  distribution: Distribution;
  score: number | null;
  group: 'A' | 'B' | null;
}) {
  const plot = usePlotArea();
  const scaleX = useXAxisScale();
  const scaleY = useYAxisScale();
  if (
    !plot ||
    !scaleX ||
    score === null ||
    !Number.isFinite(score) ||
    score < d.min ||
    score > d.max ||
    (group !== 'A' && group !== 'B') ||
    plot.width <= 0 ||
    plot.height <= 0
  )
    return null;

  const position = histogramBarCenter(d, score, group);
  if (!position) return null;
  const x = scaleX(position.x);
  const y = scaleY?.(position.y);
  if (
    x === undefined ||
    y === undefined ||
    !Number.isFinite(x) ||
    !Number.isFinite(y)
  )
    return null;
  const color = 'var(--selected-sample-color, #c5a3fa)';
  const labelWidth = 58;
  const labelX = Math.max(
    plot.x,
    Math.min(x - labelWidth / 2, plot.x + plot.width - labelWidth),
  );
  return (
    <ZIndexLayer zIndex={DefaultZIndexes.label}>
      <g
        className="distribution-sample-marker"
        color={color}
        pointerEvents="none"
        aria-hidden="true"
      >
        <line
          x1={x}
          x2={x}
          y1={plot.y}
          y2={plot.y + plot.height}
          stroke={color}
          strokeWidth={2}
          strokeDasharray={DISTRIBUTION_DASH.sample}
        />
        <SelectedSamplePoint x={x} y={y} />
        {plot.width >= labelWidth && plot.height >= 28 && (
          <>
            <rect
              x={labelX}
              y={plot.y + 4}
              width={labelWidth}
              height={22}
              rx={4}
              fill="var(--card, #171f28)"
              fillOpacity={0.94}
            />
            <text
              x={labelX + labelWidth / 2}
              y={plot.y + 15}
              textAnchor="middle"
              dominantBaseline="central"
              fill={color}
              fontSize={11}
              fontWeight={600}
            >
              選択中
            </text>
          </>
        )}
      </g>
    </ZIndexLayer>
  );
}

function ThresholdMarker({ distribution: d }: { distribution: Distribution }) {
  const descriptionId = useId();
  const { report, operationRule, pending, applyManualThreshold } =
    useThreshold();
  const { inspect } = useInspector();
  const plot = usePlotArea();
  const scaleX = useXAxisScale();
  const inverseX = useXAxisInverseScale();
  const drag = useRef<{
    pointerId: number;
    report: ThresholdReport;
    distribution: Distribution;
    target: SVGRectElement;
    surface: SVGSVGElement;
    startClientX: number;
    offsetX: number;
    moved: boolean;
  } | null>(null);
  const [preview, setPreview] = useState<{
    report: ThresholdReport;
    distribution: Distribution;
    value: number;
  } | null>(null);
  const releaseDrag = useCallback(() => {
    const active = drag.current;
    drag.current = null;
    if (active) {
      try {
        if (active.target.hasPointerCapture(active.pointerId))
          active.target.releasePointerCapture(active.pointerId);
      } catch {
        // The chart may already have unmounted or released the pointer.
      }
    }
  }, []);
  const cancel = useCallback(() => {
    releaseDrag();
    setPreview(null);
  }, [releaseDrag]);

  function pointerX(clientX: number, surface: SVGSVGElement): number | null {
    if (!surface.isConnected || !Number.isFinite(clientX)) return null;
    const bounds = surface.getBoundingClientRect();
    const viewBox = surface.viewBox.baseVal;
    if (bounds.width <= 0 || viewBox.width <= 0) return null;
    const x =
      viewBox.x + ((clientX - bounds.left) / bounds.width) * viewBox.width;
    return Number.isFinite(x) ? x : null;
  }

  function pointerThreshold(
    clientX: number,
    surface: SVGSVGElement,
    offsetX: number,
  ): number | null {
    if (!plot || !inverseX) return null;
    const x = pointerX(clientX, surface);
    if (x === null) return null;
    if (x <= plot.x) return d.min;
    if (x >= plot.x + plot.width) return d.max;
    const value = inverseX(
      Math.max(plot.x, Math.min(plot.x + plot.width, x - offsetX)),
    );
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(d.min, Math.min(d.max, value))
      : null;
  }

  const moveDrag = useEffectEvent((event: PointerEvent) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.report !== report || active.distribution !== d) {
      cancel();
      return;
    }
    if (Math.abs(event.clientX - active.startClientX) >= 2) active.moved = true;
    if (!active.moved) return;
    const value = pointerThreshold(
      event.clientX,
      active.surface,
      active.offsetX,
    );
    if (value !== null)
      setPreview({ report: active.report, distribution: d, value });
  });
  const finishDrag = useEffectEvent((event: PointerEvent) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const moved =
      active.moved || Math.abs(event.clientX - active.startClientX) >= 2;
    const value =
      active.report === report && active.distribution === d && moved
        ? pointerThreshold(event.clientX, active.surface, active.offsetX)
        : null;
    cancel();
    if (value !== null && value !== active.report.calibration.rule.threshold)
      applyManualThreshold(value);
  });
  const cancelPointer = useEffectEvent((event: PointerEvent) => {
    if (drag.current?.pointerId === event.pointerId) cancel();
  });

  useEffect(() => {
    window.addEventListener('pointermove', moveDrag, true);
    window.addEventListener('pointerup', finishDrag, true);
    window.addEventListener('pointercancel', cancelPointer, true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointermove', moveDrag, true);
      window.removeEventListener('pointerup', finishDrag, true);
      window.removeEventListener('pointercancel', cancelPointer, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', cancel);
    };
  }, [cancel]);
  useEffect(() => {
    // A new population or externally changed rule invalidates this gesture.
    return releaseDrag;
  }, [d, report, releaseDrag]);

  if (preview && (preview.report !== report || preview.distribution !== d))
    setPreview(null);
  const currentPreview =
    preview?.report === report && preview?.distribution === d ? preview : null;
  // During a recalculation `report` is intentionally null. Keep the current
  // operation value in the control so the focused SVG rect is reconciled in
  // place and consecutive key presses continue to target it.
  const rule: ThresholdRule | null = operationRule ?? report?.calibration.rule ?? null;
  const threshold = currentPreview?.value ?? rule?.threshold;
  const x = threshold === undefined ? undefined : scaleX?.(threshold);
  const canShow =
    rule &&
    plot &&
    inverseX &&
    threshold !== undefined &&
    Number.isFinite(threshold) &&
    threshold >= d.min &&
    threshold <= d.max &&
    Number.isFinite(d.min) &&
    Number.isFinite(d.max) &&
    d.max >= d.min &&
    x !== undefined &&
    Number.isFinite(x) &&
    plot.width > 0 &&
    plot.height > 0;
  const handleWidth = Math.min(104, plot?.width ?? 0);
  const handleHeight = 24;
  const labelX =
    plot && x !== undefined
      ? Math.max(
          plot.x,
          Math.min(x - handleWidth / 2, plot.x + plot.width - handleWidth),
        )
      : 0;
  // Reserve a control lane above the plot; neither the handle nor its value
  // may cover histogram bars or the cumulative curve.
  const labelY = plot ? plot.y - handleHeight - 6 : 0;
  const operator = rule
    ? { gt: '>', gte: '≥', lt: '<', lte: '≤' }[rule.operator]
    : '';
  return (
    // Keep this host mounted even without a rule. Only the handle intercepts
    // events above the range-selection target in the built-in label layer.
    <ZIndexLayer zIndex={DefaultZIndexes.label + 100}>
      {canShow && (
        <g
          className="distribution-threshold-marker"
          data-adjusting={!!currentPreview}
          pointerEvents="none"
        >
          <desc id={descriptionId}>
            左右にドラッグして調整し、離すと反映。左右キーで微調整、Shiftで大きく移動、Home/Endで端へ移動。Escで取消。
          </desc>
          <line
            x1={x}
            x2={x}
            y1={plot.y}
            y2={plot.y + plot.height}
            stroke="var(--threshold-color, #fb988c)"
            strokeWidth={2}
            aria-hidden="true"
          />
          {/* SVG has no native range input; the handle supplies slider semantics. */}
          {/* oxlint-disable jsx-a11y/prefer-tag-over-role */}
          <rect
            className="distribution-threshold-handle"
            x={labelX}
            y={labelY}
            width={handleWidth}
            height={handleHeight}
            rx={5}
            fill="var(--card, #171f28)"
            stroke="var(--threshold-color, #fb988c)"
            pointerEvents="all"
            role="slider"
            tabIndex={0}
            aria-label="分布上の仮しきい値"
            aria-describedby={descriptionId}
            aria-orientation="horizontal"
            aria-valuemin={d.min}
            aria-valuemax={d.max}
            aria-valuenow={threshold}
            aria-valuetext={`${pending ? '再計算中、' : ''}${currentPreview ? '調整中、' : ''}スコア ${operator} ${formatScore(threshold, 6)} をNG候補とする仮しきい値`}
            onPointerDown={(event) => {
              if (!report || !rule || !event.isPrimary || event.button !== 0)
                return;
              event.preventDefault();
              event.stopPropagation();
              const surface = event.currentTarget.ownerSVGElement;
              const startX = surface ? pointerX(event.clientX, surface) : null;
              if (!surface || startX === null) return;
              inspect('threshold');
              cancel();
              event.currentTarget.focus();
              drag.current = {
                pointerId: event.pointerId,
                report,
                distribution: d,
                target: event.currentTarget,
                surface,
                startClientX: event.clientX,
                // The handle can be clamped against either edge. Keep the
                // initial grab offset so grabbing its end never jumps the line.
                offsetX: startX - x,
                moved: false,
              };
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                // Window capture listeners finish releases outside the SVG.
              }
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              inspect('threshold');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancel();
                return;
              }
              if (
                !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
              )
                return;
              event.preventDefault();
              event.stopPropagation();
              inspect('threshold');
              cancel();
              const current = rule?.threshold;
              if (current === undefined) return;
              const step = Math.max(
                (d.max - d.min) / (event.shiftKey ? 20 : 200),
                Math.abs(current) * Number.EPSILON,
                Number.MIN_VALUE,
              );
              const next = Math.max(
                d.min,
                Math.min(
                  d.max,
                  event.key === 'Home'
                    ? d.min
                    : event.key === 'End'
                      ? d.max
                      : current + (event.key === 'ArrowLeft' ? -step : step),
                ),
              );
              if (Number.isFinite(next) && next !== current)
                applyManualThreshold(next);
            }}
          />
          {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
          {handleWidth >= 90 && (
            <>
              <DistributionSymbol
                kind="threshold"
                size={18}
                x={labelX + 6}
                y={labelY + (handleHeight - 18) / 2}
              />
              <text
                x={labelX + 29}
                y={labelY + handleHeight / 2}
                fill="var(--threshold-color, #fb988c)"
                textAnchor="start"
                dominantBaseline="central"
                fontSize={11}
                aria-hidden="true"
              >
                {formatScore(threshold, 4)}
              </text>
            </>
          )}
        </g>
      )}
    </ZIndexLayer>
  );
}

function RangeSelection({
  distribution: d,
  range,
  onSelect,
  onClearRange,
}: {
  distribution: Distribution;
  range?: ScoreRange | null;
  onSelect?: (r: ScoreRange) => void;
  onClearRange?: () => void;
}) {
  const plot = usePlotArea();
  const scaleX = useXAxisScale();
  const inverseX = useXAxisInverseScale();
  const drag = useRef<{
    pointerId: number;
    anchor: number;
    startClientX: number;
    startClientY: number;
    moved: boolean;
    range: ScoreRange | null | undefined;
    distribution: Distribution;
    target: SVGRectElement;
  } | null>(null);
  const [preview, setPreview] = useState<{
    distribution: Distribution;
    range: ScoreRange;
    sourceRange: ScoreRange | null | undefined;
  } | null>(null);
  const releaseDrag = useCallback(() => {
    const active = drag.current;
    drag.current = null;
    if (active) {
      try {
        if (active.target.hasPointerCapture(active.pointerId))
          active.target.releasePointerCapture(active.pointerId);
      } catch {
        // The chart may have unmounted or already released the pointer.
      }
    }
  }, []);
  const cancel = useCallback(() => {
    releaseDrag();
    setPreview(null);
  }, [releaseDrag]);

  function markMovement(event: PointerEvent) {
    const active = drag.current;
    if (
      active &&
      Math.hypot(
        event.clientX - active.startClientX,
        event.clientY - active.startClientY,
      ) >= 4
    )
      active.moved = true;
  }

  function pointerScore(
    clientX: number,
    target: SVGRectElement,
  ): number | null {
    if (!plot || !inverseX || !target.isConnected) return null;
    const bounds = target.getBoundingClientRect();
    if (!bounds.width) return null;
    const x = plot.x + ((clientX - bounds.left) / bounds.width) * plot.width;
    const value = inverseX(Math.max(plot.x, Math.min(plot.x + plot.width, x)));
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  const moveDrag = useEffectEvent((event: PointerEvent) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (active.distribution !== d || active.range !== range) {
      cancel();
      return;
    }
    markMovement(event);
    if (!active.moved) return;
    const end = pointerScore(event.clientX, active.target);
    const selected =
      end === null ? null : histogramRange(d.bins, active.anchor, end);
    if (selected)
      setPreview({ distribution: d, range: selected, sourceRange: range });
  });
  const finishDrag = useEffectEvent((event: PointerEvent) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    markMovement(event);
    const stillCurrent = active.distribution === d && active.range === range;
    const end = pointerScore(event.clientX, active.target);
    const clearSelected =
      stillCurrent &&
      end !== null &&
      !active.moved &&
      active.range &&
      active.anchor >= active.range.lo &&
      (active.range.includeHi
        ? active.anchor <= active.range.hi
        : active.anchor < active.range.hi);
    const selected =
      stillCurrent && end !== null
        ? histogramRange(
            d.bins,
            active.anchor,
            active.moved ? end : active.anchor,
          )
        : null;
    cancel();
    if (clearSelected && onClearRange) onClearRange();
    else if (selected) onSelect?.(selected);
  });
  const cancelPointer = useEffectEvent((event: PointerEvent) => {
    if (drag.current?.pointerId === event.pointerId) cancel();
  });

  useEffect(() => {
    // Releasing outside the SVG can reach window without reaching the captured
    // rect in an embedded browser. Finish the gesture at this stable ancestor.
    window.addEventListener('pointermove', moveDrag, true);
    window.addEventListener('pointerup', finishDrag, true);
    window.addEventListener('pointercancel', cancelPointer, true);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointermove', moveDrag, true);
      window.removeEventListener('pointerup', finishDrag, true);
      window.removeEventListener('pointercancel', cancelPointer, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', cancel);
    };
  }, [cancel]);

  useEffect(() => {
    return releaseDrag;
  }, [d, range, releaseDrag]);

  if (preview && (preview.distribution !== d || preview.sourceRange !== range))
    setPreview(null);
  const previewRange =
    preview?.distribution === d && preview.sourceRange === range
      ? preview.range
      : null;
  const shownRange = previewRange ?? range;
  // Use the same axis/plot geometry as the drag target. Built-in z-index hosts
  // stay registered across hot updates; a custom host can be left empty after
  // its previous consumer unmounts while the SVG host itself is reused.
  const left =
    shownRange && scaleX ? scaleX(Math.max(d.min, shownRange.lo)) : undefined;
  const right =
    shownRange && scaleX ? scaleX(Math.min(d.max, shownRange.hi)) : undefined;
  return (
    <>
      {plot &&
        left !== undefined &&
        right !== undefined &&
        Number.isFinite(left) &&
        Number.isFinite(right) &&
        right >= left && (
          <ZIndexLayer zIndex={DefaultZIndexes.activeBar}>
            <rect
              className="distribution-selected-range"
              x={left}
              y={plot.y}
              width={Math.max(1, right - left)}
              height={plot.height}
              pointerEvents="none"
              aria-hidden="true"
              stroke="var(--range-selection-color, #a0bfd8)"
              strokeDasharray={previewRange ? undefined : '4 3'}
              fill="var(--range-selection-color, #a0bfd8)"
              fillOpacity={previewRange ? 0.16 : 0.1}
            />
          </ZIndexLayer>
        )}
      {onSelect && plot && inverseX && (
        <ZIndexLayer zIndex={DefaultZIndexes.label}>
          <rect
            className="distribution-range-target"
            x={plot.x}
            y={plot.y}
            width={plot.width}
            height={plot.height}
            fill="transparent"
            aria-hidden="true"
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0) return;
              const anchor = pointerScore(event.clientX, event.currentTarget);
              if (anchor === null) return;
              const selected = histogramRange(d.bins, anchor, anchor);
              if (!selected) return;
              event.preventDefault();
              drag.current = {
                pointerId: event.pointerId,
                anchor,
                startClientX: event.clientX,
                startClientY: event.clientY,
                moved: false,
                range,
                distribution: d,
                target: event.currentTarget,
              };
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                // Window listeners still track and finish this gesture.
              }
              // Preserve the selected region until this becomes a drag. A
              // stationary click inside it clears that range on release.
            }}
          />
        </ZIndexLayer>
      )}
    </>
  );
}

type ReadoutPoint = {
  x: number;
  lo?: number;
  hi?: number;
  a: number;
  b: number;
  countA?: number;
  countB?: number;
};

function DistributionReadout({
  point,
  distribution,
}: {
  point: ReadoutPoint | null;
  distribution: Distribution;
}) {
  return (
    <div className="distribution-readout">
      <div className="distribution-readout-range">
        <span>参照区間</span>
        <strong>
          {!point
            ? '—'
            : formatScore(point.lo ?? point.x) +
              ' – ' +
              formatScore(point.hi ?? point.x)}
        </strong>
      </div>
      <div>
        <span className="distribution-readout-group">
          <DistributionSymbol kind="a" size={16} />
          群A
        </span>
        <strong>
          {point && distribution.nA ? formatNumber(point.a, 1) + '%' : '—'}
        </strong>
        {point && point.countA != null && (
          <span>（{point.countA.toLocaleString()}件）</span>
        )}
      </div>
      <div>
        <span className="distribution-readout-group">
          <DistributionSymbol kind="b" size={16} />
          群B
        </span>
        <strong>
          {point && distribution.nB ? formatNumber(point.b, 1) + '%' : '—'}
        </strong>
        {point && point.countB != null && (
          <span>（{point.countB.toLocaleString()}件）</span>
        )}
      </div>
    </div>
  );
}

export function DistributionChart({
  distribution: d,
  a,
  b,
  range,
  onSelect,
  onClearRange,
  selectedScore = null,
  selectedGroup = null,
}: {
  distribution: Distribution;
  a: number[];
  b: number[];
  range?: ScoreRange | null;
  onSelect?: (r: ScoreRange) => void;
  onClearRange?: () => void;
  selectedScore?: number | null;
  selectedGroup?: 'A' | 'B' | null;
}) {
  const context = useMemo(() => ({ d, a, b }), [d, a, b]);
  const [referencedContext, setReferencedContext] = useState<
    typeof context | null
  >(null);
  const [readoutHost, setReadoutHost] = useState<HTMLDivElement | null>(null);
  const data = useMemo(
    () => [
      ...d.bins.map((bin) => ({ ...bin, x: bin.lo })),
      { x: d.max, a: 0, b: 0, common: 0 },
    ],
    [d],
  );
  return (
    <div
      className="distribution-view"
      onPointerEnter={() => setReferencedContext(context)}
      onPointerMoveCapture={() => setReferencedContext(context)}
      onPointerLeave={() => setReferencedContext(null)}
      onFocusCapture={() => setReferencedContext(context)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setReferencedContext(null);
      }}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') setReferencedContext(null);
        else if (['ArrowLeft', 'ArrowRight'].includes(event.key))
          setReferencedContext(context);
      }}
    >
      <ChartContainer
        className="distribution-chart"
        config={{
          a: { label: '群A', color: 'var(--cohort-a, #64d6bf)' },
          b: { label: '群B', color: 'var(--cohort-b, #f2b76f)' },
          common: {
            label: '共通部分',
            color: 'var(--chart-common, #a1b6c3)',
          },
        }}
      >
        <ComposedChart
          data={data}
          margin={{ top: 36, right: 14, left: -10, bottom: 8 }}
          accessibilityLayer
          desc={
            '左右にドラッグして範囲を選択。選択範囲内のクリックで解除、それ以外のクリックは1区間。キーボードでは上部の「数値で指定」を使えます。' +
            '設定済みの仮しきい値は、描画域上部のハンドルを左右にドラッグ、または左右キーで調整できます。'
          }
        >
          <defs>
            <pattern
              id="overlap-hatch"
              width="7"
              height="7"
              patternUnits="userSpaceOnUse"
            >
              <path
                d={OVERLAP_HATCH_PATH}
                stroke="var(--chart-common, #a1b6c3)"
                strokeWidth="1"
                opacity={OVERLAP_HATCH_OPACITY}
              />
            </pattern>
          </defs>
          <CartesianGrid
            vertical={false}
            stroke="var(--subtle-border, #293744)"
            strokeDasharray="3 4"
          />
          <XAxis
            dataKey="x"
            type="number"
            domain={[d.min, d.max]}
            allowDataOverflow
            tick={{ fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            minTickGap={40}
            tickFormatter={(n) => formatScore(n, 3)}
            tickMargin={12}
          />
          <YAxis
            domain={[0, 'auto']}
            tick={{ fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(n) => formatNumber(n, 1) + '%'}
            width={60}
            tickMargin={6}
          />
          {readoutHost && (
            <Tooltip
              portal={readoutHost}
              active={referencedContext === context ? undefined : false}
              cursor={false}
              isAnimationActive={false}
              wrapperStyle={{
                position: 'static',
                transform: 'none',
                width: '100%',
                pointerEvents: 'none',
              }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const raw = payload[0].payload as ReadoutPoint;
                const p = raw.lo == null ? { ...d.bins.at(-1), x: d.max } : raw;
                if (p.a == null || p.b == null) return null;
                return (
                  <DistributionReadout
                    point={p as ReadoutPoint}
                    distribution={d}
                  />
                );
              }}
            />
          )}
          <Area
            dataKey="a"
            type="stepAfter"
            stroke="var(--cohort-a, #64d6bf)"
            strokeWidth={2}
            fill="var(--cohort-a, #64d6bf)"
            fillOpacity={0.16}
            isAnimationActive={false}
          />
          <Area
            dataKey="b"
            type="stepAfter"
            stroke="var(--cohort-b, #f2b76f)"
            strokeWidth={2}
            strokeDasharray={DISTRIBUTION_DASH.groupB}
            fill="var(--cohort-b, #f2b76f)"
            fillOpacity={0.15}
            isAnimationActive={false}
          />
          {
            <Area
              dataKey="common"
              type="stepAfter"
              stroke="none"
              fill="url(#overlap-hatch)"
              isAnimationActive={false}
            />
          }
          <RangeSelection
            distribution={d}
            range={range}
            onSelect={onSelect}
            onClearRange={onClearRange}
          />
          <SelectedScoreMarker
            distribution={d}
            score={selectedScore}
            group={selectedGroup}
          />
          <ThresholdMarker distribution={d} />
        </ComposedChart>
      </ChartContainer>
      <div
        className="distribution-readout-slot"
        aria-label="分布の参照値"
        aria-live="off"
      >
        <div className="distribution-readout-placeholder" aria-hidden="true">
          <DistributionReadout point={null} distribution={d} />
        </div>
        <div className="distribution-readout-portal" ref={setReadoutHost} />
      </div>
    </div>
  );
}
