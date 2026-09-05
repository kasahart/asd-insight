export const INSPECTOR_DEFAULT_WIDTH = 320;
export const INSPECTOR_MIN_WIDTH = 280;
export const INSPECTOR_MAX_WIDTH = 760;
export const WORKBENCH_MIN_MAIN_WIDTH = 480;
export const WORKBENCH_RESIZE_HANDLE_WIDTH = 18;
export const WORKBENCH_STACKED_BREAKPOINT = 1240;

export function inspectorWidthBounds(workbenchWidth: number) {
  const available = Number.isFinite(workbenchWidth)
    ? Math.max(0, Math.floor(workbenchWidth))
    : 0;
  const remaining =
    available - WORKBENCH_MIN_MAIN_WIDTH - WORKBENCH_RESIZE_HANDLE_WIDTH;
  return {
    min: INSPECTOR_MIN_WIDTH,
    max: Math.max(
      INSPECTOR_MIN_WIDTH,
      Math.min(INSPECTOR_MAX_WIDTH, remaining),
    ),
    fits: remaining >= INSPECTOR_MIN_WIDTH,
  };
}

export function clampInspectorWidth(
  requestedWidth: number,
  bounds: { min: number; max: number },
): number {
  const requested = Number.isFinite(requestedWidth)
    ? requestedWidth
    : INSPECTOR_DEFAULT_WIDTH;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, requested)));
}

export function inspectorWidthFromDrag(
  startWidth: number,
  startX: number,
  currentX: number,
  bounds: { min: number; max: number },
): number {
  // The inspector is on the right: moving its left edge left makes it wider.
  return clampInspectorWidth(startWidth + startX - currentX, bounds);
}
