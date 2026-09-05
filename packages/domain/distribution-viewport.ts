export type ScoreExtent = { min: number; max: number };

function validExtent(extent: ScoreExtent): boolean {
  return (
    Number.isFinite(extent.min) &&
    Number.isFinite(extent.max) &&
    extent.min < extent.max &&
    Number.isFinite(extent.max - extent.min)
  );
}

function sortedFinite(values: number[]): number[] {
  return values
    .filter(Number.isFinite)
    .sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
}

// Select observed boundaries instead of interpolating toward a distant outlier.
// Each group retains at least 98% of its finite observations, including ties;
// groups smaller than 100 observations keep their complete range. Combining
// the group extents also prevents a large group from hiding a small one.
export function centralScoreExtent(
  a: number[],
  b: number[],
): ScoreExtent | null {
  const groups = [sortedFinite(a), sortedFinite(b)].filter(
    (group) => group.length > 0,
  );
  if (!groups.length) return null;
  const full = {
    min: Math.min(...groups.map((group) => group[0])),
    max: Math.max(...groups.map((group) => group[group.length - 1])),
  };
  if (!validExtent(full)) return null;
  const extents = groups.map((group) => {
    const trim = Math.floor(group.length / 100);
    return { min: group[trim], max: group[group.length - 1 - trim] };
  });
  const extent = {
    min: Math.min(...extents.map((group) => group.min)),
    max: Math.max(...extents.map((group) => group.max)),
  };
  if (
    !validExtent(extent) ||
    (extent.min === full.min && extent.max === full.max)
  )
    return null;

  // Auto-zoom must remain representable at every supported histogram bin count.
  // Do not invent padding around tied scores or return numerically empty bins.
  const width = (extent.max - extent.min) / 128;
  if (!(width > 0)) return null;
  let previous = extent.min;
  for (let i = 1; i <= 128; i++) {
    const next = i === 128 ? extent.max : extent.min + i * width;
    if (!(next > previous)) return null;
    previous = next;
  }
  return extent;
}

// Bounds are inclusive, matching the visible histogram. Invalid values are
// missing data, not tails, and do not contribute to these counts.
export function outsideScoreExtent(
  a: number[],
  b: number[],
  extent: ScoreExtent,
): { belowA: number; aboveA: number; belowB: number; aboveB: number } {
  if (!validExtent(extent))
    throw new Error(
      '表示範囲の下限・上限は、下限 < 上限となる有限な範囲で指定してください。',
    );
  const outside = { belowA: 0, aboveA: 0, belowB: 0, aboveB: 0 };
  for (const value of a) {
    if (!Number.isFinite(value)) continue;
    if (value < extent.min) outside.belowA++;
    else if (value > extent.max) outside.aboveA++;
  }
  for (const value of b) {
    if (!Number.isFinite(value)) continue;
    if (value < extent.min) outside.belowB++;
    else if (value > extent.max) outside.aboveB++;
  }
  return outside;
}
