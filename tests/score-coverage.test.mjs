import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreCoverage } from '../lib/score-coverage.ts';

void test('coverage counts mixed missing values without discarding zero or negatives', () => {
  const rows = [
    { primary: '0', comparison: '-4' },
    { primary: ' 1.5 ', comparison: '2e-3' },
    { primary: '3', comparison: '' },
    { primary: '', comparison: '-0' },
    { primary: 'NaN', comparison: 'Infinity' },
    { primary: 'bad', comparison: '  ' },
    { primary: '-2', comparison: 'unknown' },
  ];
  assert.deepEqual(scoreCoverage(rows, 'primary', 'comparison'), {
    total: 7,
    primaryValid: 4,
    comparisonValid: 3,
    bothValid: 2,
    primaryOnly: 2,
    comparisonOnly: 1,
    bothMissing: 2,
  });
});

void test('equal valid counts do not imply that the same rows can be compared', () => {
  const coverage = scoreCoverage(
    [
      { primary: '1', comparison: '' },
      { primary: '', comparison: '9' },
    ],
    'primary',
    'comparison',
  );
  assert.equal(coverage.primaryValid, coverage.comparisonValid);
  assert.equal(coverage.bothValid, 0);
  assert.equal(coverage.primaryOnly, 1);
  assert.equal(coverage.comparisonOnly, 1);
});

void test('extreme finite scores count while overflow and non-finite values are missing', () => {
  const coverage = scoreCoverage(
    [
      {
        primary: String(Number.MAX_VALUE),
        comparison: String(-Number.MAX_VALUE),
      },
      { primary: '5e-324', comparison: '-5e-324' },
      { primary: '1e309', comparison: '-1e309' },
      { primary: NaN, comparison: Infinity },
      { primary: '0x10', comparison: '1,000' },
    ],
    'primary',
    'comparison',
  );
  assert.deepEqual(coverage, {
    total: 5,
    primaryValid: 2,
    comparisonValid: 2,
    bothValid: 2,
    primaryOnly: 0,
    comparisonOnly: 0,
    bothMissing: 3,
  });
});

void test('empty input and absent columns produce explicit zero coverage', () => {
  assert.deepEqual(scoreCoverage([], 'primary', 'comparison'), {
    total: 0,
    primaryValid: 0,
    comparisonValid: 0,
    bothValid: 0,
    primaryOnly: 0,
    comparisonOnly: 0,
    bothMissing: 0,
  });
  const coverage = scoreCoverage(
    [{ primary: '0' }, { primary: '' }, {}],
    'primary',
    'absent',
  );
  assert.equal(coverage.primaryOnly, 1);
  assert.equal(coverage.bothMissing, 2);
  assert.equal(coverage.comparisonValid, 0);
});

void test('swapping score roles preserves the common rows and exchanges one-sided counts', () => {
  const rows = [
    { primary: '2', comparison: '7' },
    { primary: '1', comparison: '' },
    { primary: '-1', comparison: '' },
    { primary: '', comparison: '0' },
    { primary: '', comparison: '' },
  ];
  const forward = scoreCoverage(rows, 'primary', 'comparison');
  const reverse = scoreCoverage(rows, 'comparison', 'primary');
  assert.equal(forward.primaryValid, reverse.comparisonValid);
  assert.equal(forward.primaryOnly, reverse.comparisonOnly);
  assert.equal(forward.comparisonOnly, reverse.primaryOnly);
  assert.equal(forward.bothValid, reverse.bothValid);
  assert.equal(forward.bothMissing, reverse.bothMissing);
  const sameColumn = scoreCoverage(rows, 'primary', 'primary');
  assert.equal(sameColumn.bothValid, forward.primaryValid);
  assert.equal(sameColumn.primaryOnly + sameColumn.comparisonOnly, 0);
});

void test('coverage does not mutate input rows, their order, or original score values', () => {
  const rows = Object.freeze([
    Object.freeze({ id: 'second', primary: ' 0 ', comparison: 'NaN' }),
    Object.freeze({ id: 'first', primary: '-3', comparison: '4e2' }),
  ]);
  const original = structuredClone(rows);
  const coverage = scoreCoverage(rows, 'primary', 'comparison');
  assert.equal(coverage.total, 2);
  assert.deepEqual(rows, original);
});
