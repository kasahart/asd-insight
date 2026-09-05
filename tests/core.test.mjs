import test from 'node:test';
import assert from 'node:assert/strict';
import {
  histogram,
  finiteNumber,
  ecdf,
  quantile,
  formatScore,
  histogramRange,
  scoreInRange,
  histogramBarCenter,
} from '../lib/distribution.ts';
import {
  csvText,
  defaultGroup,
  parseCSV,
  partitionRows,
  profileColumns,
  findAudio,
  unusedColumn,
} from '../lib/data.ts';
import { demoDataset } from '../lib/demo.ts';
import { demoWave, wavBuffer, waveformEnvelope } from '../lib/audio.ts';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
test('small and negative scores retain useful precision instead of rounding to zero', () => {
  assert.equal(formatScore(0.0012, 3), '1.20e-3');
  assert.equal(formatScore(-0.00006803131, 6), '-6.80313e-5');
  assert.notEqual(formatScore(0.0012), formatScore(0.0017));
  assert.equal(formatScore(0), '0');
  assert.equal(formatScore(null), '—');
});
test('mostly missing scores remain selectable and categorical numeric codes are supported', () => {
  const d = parseCSV('score,code\n0,1\n1,3\nNA,1\nNA,2');
  const profiles = profileColumns(d);
  assert.equal(profiles.find((p) => p.column === 'score').validNumbers, 2);
  const group = defaultGroup(
    d,
    profiles.find((p) => p.column === 'code'),
    'category',
  );
  assert.equal(group.kind, 'category');
  const p = partitionRows(d.rows, 'score', {
    kind: 'category',
    column: 'code',
    a: '1',
    b: '3',
  });
  assert.deepEqual([p.samples.length, p.missingA, p.otherGroup], [2, 1, 1]);
  const skew = parseCSV(
    'score,label\n1,0\n2,0\n3,0\n4,0\n5,0\n6,0\n7,0\n8,0\n9,0\n10,1',
  );
  const range = defaultGroup(
    skew,
    profileColumns(skew).find((p) => p.column === 'label'),
  );
  assert.equal(range.upperA, 0);
  assert.equal(range.lowerB, 1);
});
test('export adds columns without overwriting original values', () => {
  assert.equal(
    unusedColumn('analyst_note', ['analyst_note', 'analyst_note_2']),
    'analyst_note_3',
  );
});
test('OVL: identical shapes ignore unequal sample counts', () => {
  close(histogram([0, 0, 1, 1], [0, 1], 2).overlap, 100);
  close(histogram([0, 0, 0, 1], [0, 1, 1, 1], 2).overlap, 50);
  close(histogram([0, 0], [1, 1], 2).overlap, 0);
});
test('empty cohorts are unavailable, not zero; equal constants are 100%', () => {
  assert.equal(histogram([], [1, 2]).overlap, null);
  assert.equal(histogram([], []).overlap, null);
  close(histogram([4, 4], [4], 24).overlap, 100);
});
test('bin width sensitivity is explicit', () => {
  close(histogram([0, 1], [0.4, 0.6], 2).overlap, 100);
  close(histogram([0, 1], [0.4, 0.6], 4).overlap, 0);
});
test('boundaries are counted once and agree with interval selection', () => {
  const seed = histogram([0, 1], [], 24);
  const values = [
    0,
    1,
    ...seed.bins.map((b) => b.lo),
    ...seed.bins.map((b) => b.hi),
  ];
  const h = histogram(values, values, 24);
  assert.equal(
    h.bins.reduce((s, b) => s + b.countA, 0),
    values.length,
  );
  h.bins.forEach((b, i) =>
    assert.equal(
      b.countA,
      values.filter(
        (v) =>
          v >= b.lo && (v < b.hi || (i === h.bins.length - 1 && v === b.hi)),
      ).length,
    ),
  );
});
test('drag selects whole bins in either direction; a click selects its containing bin', () => {
  const d = histogram([-8, -5, 0, 2], [-6, -2, 3, 8], 8);
  const range = histogramRange(d.bins, -5.9, 1.9);
  assert.deepEqual(range, { lo: -6, hi: 2, includeHi: false });
  assert.deepEqual(histogramRange(d.bins, 1.9, -5.9), range);
  assert.deepEqual(histogramRange(d.bins, 1.9, 1.9), {
    lo: 0,
    hi: 2,
    includeHi: false,
  });
  assert.ok(scoreInRange(-6, range));
  assert.ok(!scoreInRange(2, range));
  assert.ok(scoreInRange(2, { ...range, includeHi: true }));
});
test('drag release outside the plot clamps to the edges and includes the maximum', () => {
  const d = histogram([0, 2, 4], [6, 8], 4);
  assert.deepEqual(histogramRange(d.bins, 3, 100), {
    lo: 2,
    hi: 8,
    includeHi: true,
  });
  assert.deepEqual(histogramRange(d.bins, 100, -100), {
    lo: 0,
    hi: 8,
    includeHi: true,
  });
  const last = histogramRange(d.bins, 8, 8);
  assert.deepEqual(last, { lo: 6, hi: 8, includeHi: true });
  assert.ok(scoreInRange(8, last));
  assert.deepEqual(histogramRange(d.bins, 0, 0), {
    lo: 0,
    hi: 2,
    includeHi: false,
  });
});
test('multi-bin selection counts agree with displayed bins at every boundary and keep OVL unchanged', () => {
  for (const [min, max] of [
    [0, 1],
    [-0.00006803131, 0.00187291],
  ]) {
    const seed = histogram([min], [max], 24);
    const values = [min, max, ...seed.bins.flatMap((b) => [b.lo, b.hi])];
    const d = histogram(values, [...values, max], 24);
    const originalOverlap = d.overlap;
    for (let start = 0; start < d.bins.length; start++) {
      for (let end = start; end < d.bins.length; end++) {
        const range = histogramRange(d.bins, d.bins[start].lo, d.bins[end].lo);
        const included = d.bins.slice(start, end + 1);
        assert.equal(
          values.filter((v) => scoreInRange(v, range)).length,
          included.reduce((sum, b) => sum + b.countA, 0),
        );
        assert.equal(
          [...values, max].filter((v) => scoreInRange(v, range)).length,
          included.reduce((sum, b) => sum + b.countB, 0),
        );
      }
    }
    assert.equal(d.overlap, originalOverlap);
  }
});
test('invalid drag coordinates cannot produce a selection', () => {
  const d = histogram([0], [1], 4);
  assert.equal(histogramRange([], 0, 1), null);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.equal(histogramRange(d.bins, invalid, 0), null);
    assert.equal(histogramRange(d.bins, 0, invalid), null);
  }
});
test('sample marker sits at the center of its own cohort bar, including overlapping bars', () => {
  const d = histogram([-4, -4, -3, 0, 4], [-4, 1, 2, 4], 4);
  assert.deepEqual(histogramBarCenter(d, -4, 'A'), { x: -3, y: 30 });
  assert.deepEqual(histogramBarCenter(d, -3, 'A'), { x: -3, y: 30 });
  assert.deepEqual(histogramBarCenter(d, -4, 'B'), { x: -3, y: 12.5 });
  assert.deepEqual(histogramBarCenter(d, 0, 'A'), { x: 1, y: 10 });
  assert.deepEqual(histogramBarCenter(d, 2, 'B'), { x: 3, y: 25 });
  assert.deepEqual(histogramBarCenter(d, 4, 'B'), { x: 3, y: 25 });
});
test('a bar marker is absent for invalid scores, out-of-range scores and absent cohort bars', () => {
  const d = histogram([0], [4], 4);
  for (const score of [NaN, Infinity, -Infinity, -1, 5])
    assert.equal(histogramBarCenter(d, score, 'A'), null);
  assert.equal(histogramBarCenter(d, 4, 'A'), null);
  assert.equal(histogramBarCenter(d, 0, 'B'), null);
  assert.equal(histogramBarCenter(histogram([], []), 0, 'A'), null);
});
test('OVL is symmetric, permutation invariant, bounded and normalizes each cohort', () => {
  const a = [-3, -2, -1, 0, 1, 2, 4, 9],
    b = [-2, -2, 0, 4, 5];
  const h = histogram(a, b, 12);
  close(h.overlap, histogram(b, a, 12).overlap);
  close(h.overlap, histogram([...a].reverse(), b, 12).overlap);
  close(
    h.bins.reduce((s, b) => s + b.a, 0),
    100,
  );
  close(
    h.bins.reduce((s, b) => s + b.b, 0),
    100,
  );
  assert.ok(h.overlap >= 0 && h.overlap <= 100);
});
test('invalid scores do not silently become zero', () => {
  for (const v of [
    '',
    ' ',
    'NaN',
    'Infinity',
    '-Infinity',
    '0x10',
    '3e999',
    null,
    undefined,
  ])
    assert.equal(finiteNumber(v), null);
  assert.equal(finiteNumber('0'), 0);
  assert.equal(finiteNumber(' -1.2e-3 '), -0.0012);
  assert.equal(histogram([1, NaN, Infinity], [2]).nA, 1);
  assert.throws(() => histogram([-1e308], [1e308]), /範囲/);
});
test('ECDF handles tied scores, endpoints and empty cohorts', () => {
  const points = ecdf([1, 1, 2], [1, 3], 0, 4);
  close(points.find((p) => p.x === 1).a, 200 / 3);
  assert.equal(points.find((p) => p.x === 1).b, 50);
  assert.deepEqual(points.at(-1), { x: 4, a: 100, b: 100 });
  assert.equal(ecdf([], [2], 0, 3).at(-1).a, 0);
  close(quantile([1, 2, 3, 4], 0.5), 2.5);
});
test('CSV preserves BOM, quoted commas, line breaks, escaped quotes and zero', () => {
  const d = parseCSV(
    '\uFEFFid,score,group,note\r\nx,0,A,"one,two"\r\ny,2,B,"a\n""quote"""\r\n',
  );
  assert.equal(d.rows.length, 2);
  assert.equal(d.rows[0].note, 'one,two');
  assert.equal(d.rows[1].note, 'a\n"quote"');
  assert.equal(d.rows[0].score, '0');
  assert.equal(parseCSV('id\tscore\tgroup\nx\t1\tA\ny\t2\tB').rows.length, 2);
});
test('malformed CSV is rejected rather than silently shifted', () => {
  for (const s of [
    'x,x\n1,2',
    'x,\n1,2',
    'x,y\n1,2,3',
    'x,y\n1,"no',
    'x,y\n1,"a"b',
    'x,y\n1,a"b',
  ]) {
    assert.throws(() => parseCSV(s));
  }
  assert.throws(() => parseCSV('id,group\nx,A'));
});
test('CSV round trip preserves values; safe exports neutralize formulas', () => {
  const d = parseCSV('id,score,group,note\na,1,A,"a,b"\nb,-2,B,"x\ny"');
  assert.deepEqual(parseCSV(csvText(d.columns, d.rows)).rows, d.rows);
  const source = [
    {
      value: '=HYPERLINK("https://example.test")',
      negative: '-2',
      plus: '+SUM(A1:A4)',
    },
  ];
  const out = parseCSV(csvText(['value', 'negative', 'plus'], source));
  assert.ok(out.rows[0].value.startsWith("'="));
  assert.equal(out.rows[0].negative, '-2');
  assert.ok(out.rows[0].plus.startsWith("'+"));
});
test('categorical partition reports all exclusion reasons and preserves row identity', () => {
  const rows = [
    { score: '0', cohort: 'A', site: 'x' },
    { score: '', cohort: 'A', site: 'x' },
    { score: '2', cohort: 'B', site: 'x' },
    { score: '3', cohort: '', site: 'x' },
    { score: '4', cohort: 'C', site: 'x' },
    { score: '5', cohort: 'B', site: 'y' },
  ];
  const p = partitionRows(
    rows,
    'score',
    { kind: 'category', column: 'cohort', a: 'A', b: 'B' },
    { column: 'site', value: 'x' },
  );
  assert.deepEqual(
    p.samples.map((s) => [s.index, s.group, s.score]),
    [
      [0, 'A', 0],
      [2, 'B', 2],
    ],
  );
  assert.deepEqual(
    [
      p.outsideFilter,
      p.missingGroup,
      p.otherGroup,
      p.missingA,
      p.missingB,
      p.membersA,
      p.membersB,
    ],
    [1, 1, 1, 1, 0, 2, 1],
  );
  assert.equal(
    p.samples.length +
      p.outsideFilter +
      p.missingGroup +
      p.otherGroup +
      p.missingA +
      p.missingB,
    rows.length,
  );
});
test('numeric cohorts keep ties together, exclude middle and prevent circular definitions', () => {
  const rows = [1, 2, 2, 3, 4, 5].map((v, i) => ({
    rating: String(v),
    score: String(i),
  }));
  const p = partitionRows(rows, 'score', {
    kind: 'numeric',
    column: 'rating',
    upperA: 2,
    lowerB: 4,
  });
  assert.equal(p.membersA, 3);
  assert.equal(p.membersB, 2);
  assert.equal(p.otherGroup, 1);
  assert.throws(
    () =>
      partitionRows(rows, 'score', {
        kind: 'numeric',
        column: 'score',
        upperA: 2,
        lowerB: 4,
      }),
    /スコア自身/,
  );
  assert.throws(
    () =>
      partitionRows(rows, 'score', {
        kind: 'numeric',
        column: 'rating',
        upperA: 2,
        lowerB: 2,
      }),
    /小さく/,
  );
});
test('demo and arbitrary alternative source names use the same core', () => {
  const d = demoDataset(),
    profiles = profileColumns(d);
  assert.equal(d.rows.length, 420);
  assert.equal(profiles.find((p) => p.column === 'rating').validNumbers, 70);
  const g = defaultGroup(
    d,
    profiles.find((p) => p.column === 'cohort'),
  );
  const p = partitionRows(d.rows, 'score_a', g);
  assert.equal(p.samples.length, 420);
  const other = parseCSV(
    'id,model_x,operator_score,plant\nx,0.2,1,east\ny,0.9,5,east\nz,0.4,,west',
  );
  const op = partitionRows(other.rows, 'model_x', {
    kind: 'numeric',
    column: 'operator_score',
    upperA: 1,
    lowerB: 5,
  });
  assert.deepEqual(
    op.samples.map((s) => s.group),
    ['A', 'B'],
  );
  assert.equal(op.missingGroup, 1);
});
test('audio matches local files only; score aggregation does not require audio', () => {
  const wav = new File(['x'], 'clip.wav'),
    files = new Map([['clip.wav', wav]]);
  assert.equal(findAudio({ id: 'clip' }, 0, 'id', '', files), wav);
  assert.equal(
    findAudio({ audio: 'C:\\audio\\clip.wav' }, 0, '', 'audio', files),
    wav,
  );
  assert.equal(
    findAudio({ audio: 'absent.wav' }, 0, '', 'audio', files),
    undefined,
  );
});
test('demo WAV has a valid mono PCM header and bounded signal', () => {
  const a = demoWave(3, true, true),
    b = demoWave(3, true, true);
  assert.deepEqual(a.samples, b.samples);
  assert.equal(a.samples.length, 64000);
  assert.ok(a.samples.every((v) => Number.isFinite(v) && Math.abs(v) <= 1));
  const bytes = wavBuffer(a.samples, a.rate),
    v = new DataView(bytes);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), 'RIFF');
  assert.equal(v.getUint32(40, true), a.samples.length * 2);
  assert.equal(v.getUint32(24, true), 16000);
  assert.equal(v.getUint16(22, true), 1);
  assert.equal(waveformEnvelope(a.samples).length, 360);
});
