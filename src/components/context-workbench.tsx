'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useViewPreferences } from '@/components/view-preferences';
import {
  WORKBENCH_STACKED_BREAKPOINT,
  clampInspectorWidth,
  inspectorWidthBounds,
  inspectorWidthFromDrag,
} from '@/lib/inspector-width';

type ResizeSession = {
  pointerId: number;
  startX: number;
  startWidth: number;
  handle: HTMLDivElement;
};

function releaseCapture(session: ResizeSession | null) {
  if (!session) return;
  try {
    if (session.handle.hasPointerCapture(session.pointerId)) {
      session.handle.releasePointerCapture(session.pointerId);
    }
  } catch {
    // A detached element or a browser cancellation may already have released it.
  }
}

export function ContextWorkbench({ children }: { children: ReactNode }) {
  const { inspectorWidth, setInspectorWidth } = useViewPreferences();
  const root = useRef<HTMLDivElement>(null);
  const session = useRef<ResizeSession | null>(null);
  const [draftWidth, setDraftWidth] = useState<number | null>(null);
  const [space, setSpace] = useState({ width: 0, wideViewport: false });
  const bounds = inspectorWidthBounds(space.width);
  const split = space.wideViewport && bounds.fits;
  const width = clampInspectorWidth(draftWidth ?? inspectorWidth, bounds);

  const cancelResize = useCallback(() => {
    const previous = session.current;
    session.current = null;
    releaseCapture(previous);
    setDraftWidth(null);
  }, []);

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    const measure = () => {
      const next = {
        width: root.current?.getBoundingClientRect().width ?? 0,
        wideViewport: window.innerWidth > WORKBENCH_STACKED_BREAKPOINT,
      };
      if (
        session.current &&
        (!next.wideViewport || !inspectorWidthBounds(next.width).fits)
      )
        cancelResize();
      setSpace((previous) =>
        previous.width === next.width &&
        previous.wideViewport === next.wideViewport
          ? previous
          : next,
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    if (root.current) observer?.observe(root.current);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [cancelResize]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('blur', cancelResize);
    return () => {
      window.removeEventListener('blur', cancelResize);
      const previous = session.current;
      session.current = null;
      releaseCapture(previous);
    };
  }, [cancelResize]);

  function startResize(event: PointerEvent<HTMLDivElement>) {
    if (
      !split ||
      event.button !== 0 ||
      event.isPrimary === false ||
      session.current
    )
      return;
    const handle = event.currentTarget;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    event.preventDefault();
    handle.focus({ preventScroll: true });
    session.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: width,
      handle,
    };
    setDraftWidth(width);
  }

  function moveResize(event: PointerEvent<HTMLDivElement>) {
    const current = session.current;
    if (!current || current.pointerId !== event.pointerId) return;
    event.preventDefault();
    setDraftWidth(
      inspectorWidthFromDrag(
        current.startWidth,
        current.startX,
        event.clientX,
        bounds,
      ),
    );
  }

  function finishResize(event: PointerEvent<HTMLDivElement>) {
    const current = session.current;
    if (!current || current.pointerId !== event.pointerId) return;
    session.current = null;
    releaseCapture(current);
    setDraftWidth(null);
    if (!split) return;
    const next = inspectorWidthFromDrag(
      current.startWidth,
      current.startX,
      event.clientX,
      bounds,
    );
    if (next !== current.startWidth) setInspectorWidth(next);
  }

  function cancelPointerResize(event: PointerEvent<HTMLDivElement>) {
    if (session.current?.pointerId === event.pointerId) cancelResize();
  }

  function resizeByKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && session.current) {
      event.preventDefault();
      event.stopPropagation();
      cancelResize();
      return;
    }
    if (!split || session.current) return;
    const step = event.shiftKey ? 64 : 16;
    const next =
      event.key === 'ArrowLeft'
        ? width + step
        : event.key === 'ArrowRight'
          ? width - step
          : event.key === 'Home'
            ? bounds.min
            : event.key === 'End'
              ? bounds.max
              : null;
    if (next === null) return;
    event.preventDefault();
    setInspectorWidth(clampInspectorWidth(next, bounds));
  }

  return (
    <div
      ref={root}
      className="context-workbench resizable-workbench"
      data-layout={split ? 'columns' : 'stacked'}
      data-resizing={draftWidth !== null ? 'true' : undefined}
      style={{ '--inspector-width': width + 'px' } as CSSProperties}
    >
      {children}
      {/* This focusable window splitter is an interactive range control,
          not the thematic break represented by a native hr element. */}
      {/* oxlint-disable jsx-a11y/prefer-tag-over-role */}
      <div
        className="inspector-resize-separator"
        role="separator"
        aria-label="詳細パネルの幅"
        aria-orientation="vertical"
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuenow={width}
        aria-valuetext={width + 'ピクセル'}
        aria-disabled={!split}
        tabIndex={split ? 0 : -1}
        onPointerDown={startResize}
        onPointerMove={moveResize}
        onPointerUp={finishResize}
        onPointerCancel={cancelPointerResize}
        onLostPointerCapture={cancelPointerResize}
        onKeyDown={resizeByKeyboard}
        onBlur={cancelResize}
      />
      {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
    </div>
  );
}
