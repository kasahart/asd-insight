export type Bin = {
  lo: number;
  hi: number;
  countA: number;
  countB: number;
  a: number;
  b: number;
  common: number;
};
export type Distribution = {
  bins: Bin[];
  min: number;
  max: number;
  nA: number;
  nB: number;
  overlap: number | null;
  medianA: number | null;
  medianB: number | null;
};
export type ScoreRange = { lo: number; hi: number; includeHi: boolean };

// Select whole bins between two pointer positions, in either direction. Clamp
// outside positions so releasing beyond the plot still includes its edge bin.
export function histogramRange(
  bins: readonly Bin[],
  start: number,
  end: number,
): ScoreRange | null {
  if (!bins.length || !Number.isFinite(start) || !Number.isFinite(end))
    return null;
  const last = bins[bins.length - 1];
  const firstBin = bins.find((bin) => Math.min(start, end) < bin.hi) ?? last;
  const lastBin = bins.find((bin) => Math.max(start, end) < bin.hi) ?? last;
  return {
    lo: firstBin.lo,
    hi: lastBin.hi,
    includeHi: lastBin === last,
  };
}

export function scoreInRange(score: number, range: ScoreRange): boolean {
  return (
    score >= range.lo &&
    (score < range.hi || (range.includeHi && score === range.hi))
  );
}

// The marker identifies a histogram bar, not the exact score within that bin.
// Use the selected cohort's height even when the two distributions overlap.
export function histogramBarCenter(
  distribution: Distribution,
  score: number,
  group: 'A' | 'B',
): { x: number; y: number } | null {
  if (!Number.isFinite(score)) return null;
  const bin = distribution.bins.find((b) =>
    scoreInRange(score, {
      lo: b.lo,
      hi: b.hi,
      includeHi: b.hi === distribution.max,
    }),
  );
  if (!bin) return null;
  const height = group === 'A' ? bin.a : bin.b;
  if (!(height > 0)) return null;
  return { x: bin.lo + (bin.hi - bin.lo) / 2, y: height / 2 };
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (
    typeof value !== 'string' ||
    !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())
  )
    return null;
  const n = Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = (sorted.length - 1) * Math.max(0, Math.min(1, q));
  const lo = Math.floor(i),
    hi = Math.ceil(i),
    t = i - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

export function histogram(
  aInput: number[],
  bInput: number[],
  count = 24,
  domain?: { min: number; max: number },
): Distribution {
  if (!Number.isInteger(count) || count < 2 || count > 128)
    throw new Error('区間数は2〜128の整数で指定してください。');
  const a = aInput.filter(Number.isFinite),
    b = bInput.filter(Number.isFinite);
  let min = Infinity,
    max = -Infinity;
  for (const n of [...a, ...b]) {
    min = Math.min(min, n);
    max = Math.max(max, n);
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 1;
  }
  if (domain) {
    if (
      !Number.isFinite(domain.min) ||
      !Number.isFinite(domain.max) ||
      !(domain.min < domain.max) ||
      !Number.isFinite(domain.max - domain.min)
    )
      throw new Error(
        '表示範囲の下限・上限は、下限 < 上限となる有限な範囲で指定してください。',
      );
    min = domain.min;
    max = domain.max;
  } else if (min === max) {
    const pad = Math.max(Math.abs(min) * 0.01, 0.5);
    min -= pad;
    max += pad;
  }
  if (
    !Number.isFinite(max - min) ||
    !Number.isFinite(min) ||
    !Number.isFinite(max)
  )
    throw new Error('スコアの数値範囲が大きすぎます。単位を確認してください。');
  const width = (max - min) / count;
  if (!(width > 0))
    throw new Error(
      '数値の差が小さすぎて区間を作れません。単位を確認してください。',
    );
  const bins: Bin[] = Array.from({ length: count }, (_, i) => ({
    lo: min + i * width,
    hi: i === count - 1 ? max : min + (i + 1) * width,
    countA: 0,
    countB: 0,
    a: 0,
    b: 0,
    common: 0,
  }));
  if (bins.some((bin) => !(bin.lo < bin.hi)))
    throw new Error(
      '数値の差が小さすぎて区間を作れません。区間数を減らすか、表示範囲を広げてください。',
    );
  const index = (v: number) => {
    let lo = 0,
      hi = count - 1;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (v < bins[mid].hi) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  // A display extent changes the bin geometry, never the comparison population.
  // Keep outside scores out of the edge bins and retain each full denominator.
  for (const n of a) if (n >= min && n <= max) bins[index(n)].countA++;
  for (const n of b) if (n >= min && n <= max) bins[index(n)].countB++;
  for (const bin of bins) {
    bin.a = a.length ? (bin.countA / a.length) * 100 : 0;
    bin.b = b.length ? (bin.countB / b.length) * 100 : 0;
    bin.common = Math.min(bin.a, bin.b);
  }
  return {
    bins,
    min,
    max,
    nA: a.length,
    nB: b.length,
    overlap:
      a.length && b.length
        ? Math.min(
            100,
            bins.reduce((s, x) => s + x.common, 0),
          )
        : null,
    medianA: quantile(a, 0.5),
    medianB: quantile(b, 0.5),
  };
}

export function ecdf(a: number[], b: number[], min: number, max: number) {
  const sa = a.filter(Number.isFinite).sort((x, y) => x - y),
    sb = b.filter(Number.isFinite).sort((x, y) => x - y);
  const xs = [...new Set([...sa, ...sb])].sort((x, y) => x - y);
  let ia = 0,
    ib = 0;
  const data = [{ x: min, a: 0, b: 0 }];
  for (const x of xs) {
    while (ia < sa.length && sa[ia] <= x) ia++;
    while (ib < sb.length && sb[ib] <= x) ib++;
    data.push({
      x,
      a: sa.length ? (ia / sa.length) * 100 : 0,
      b: sb.length ? (ib / sb.length) * 100 : 0,
    });
  }
  data.push({ x: max, a: sa.length ? 100 : 0, b: sb.length ? 100 : 0 });
  return data;
}

export function formatNumber(n: number | null, digits = 3) {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n !== 0 && (Math.abs(n) < 0.001 || Math.abs(n) >= 100000))
    return n.toExponential(2);
  return new Intl.NumberFormat('ja-JP', {
    maximumFractionDigits: digits,
  }).format(n);
}

// Scores have arbitrary units and may be much smaller than percentages. Keep
// significant digits so real inputs do not all appear as zero on an axis.
export function formatScore(n: number | null, significantDigits = 4) {
  if (n === null || !Number.isFinite(n)) return '—';
  if (n !== 0 && (Math.abs(n) < 0.01 || Math.abs(n) >= 100000))
    return n.toExponential(significantDigits - 1);
  return new Intl.NumberFormat('ja-JP', {
    maximumSignificantDigits: significantDigits,
  }).format(n);
}
