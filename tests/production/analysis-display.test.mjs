import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import {
  calibrateOkRate,
  manualThreshold,
  summarizeThreshold,
} from '../../packages/domain/threshold.ts';

const root = new URL('../../', import.meta.url).pathname;
const bundle = await build({
  entryPoints: ['src/lib/analysis-display.ts'],
  absWorkingDir: root,
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
});
const directory = await mkdtemp(`${tmpdir()}/overlap-analysis-display-`);
const modulePath = `${directory}/analysis-display.mjs`;
await writeFile(modulePath, bundle.outputFiles[0].text);
const display = await import(pathToFileURL(modulePath).href);
await rm(directory, { recursive: true, force: true });

test('provenance formatters preserve real group boundaries and threshold operators', () => {
  assert.match(
    display.formatGroupSpec({
      kind: 'numeric',
      column: 'rating',
      upperA: 2.5,
      lowerB: 3.5,
    }),
    /群A ≤ 2\.5.*群B ≥ 3\.5/,
  );
  assert.match(
    display.formatGroupSpec({
      kind: 'category',
      column: 'label',
      a: 'OK',
      b: 'NG',
    }),
    /群A「OK」.*群B「NG」/,
  );
  const scores = [0.1, 0.2, 0.4, 0.8];
  assert.equal(display.formatThresholdCondition(null), '仮しきい値は未設定');
  const thresholdReports = [
    { operator: 'gt', calibration: calibrateOkRate(scores, 25, 'high'), detected: 1, percent: 25 },
    { operator: 'gte', calibration: calibrateOkRate(scores, 100, 'high'), detected: 4, percent: 100 },
    { operator: 'lt', calibration: calibrateOkRate(scores, 25, 'low'), detected: 1, percent: 25 },
    { operator: 'lte', calibration: calibrateOkRate(scores, 100, 'low'), detected: 4, percent: 100 },
  ];
  for (const { operator, calibration, detected, percent } of thresholdReports) {
    const report = {
      okGroup: 'A',
      scope: 'population',
      calibration,
      groupA: summarizeThreshold(scores, calibration.rule),
      groupB: summarizeThreshold([0.3, 0.5], calibration.rule),
    };
    assert.equal(calibration.referenceCount, scores.length);
    assert.equal(calibration.detectedCount, detected);
    assert.equal(calibration.actualPercent, percent);
    const text = display.formatThresholdCondition(report);
    assert.match(
      text,
      new RegExp(`OK基準群のNG候補：${detected} / ${scores.length}件（${percent}%）`),
      `formatter should preserve the calibrated count for ${operator}`,
    );
    assert.match(
      text,
      new RegExp(`スコア ${operator === 'gt' ? '>' : operator === 'gte' ? '≥' : operator === 'lt' ? '<' : '≤'}`),
      `formatter should preserve ${operator} from real calibration`,
    );
  }
  const manual = manualThreshold(scores, {
    threshold: 0.4,
    operator: 'lte',
    direction: 'low',
  });
  assert.match(
    display.formatThresholdCondition({
      okGroup: 'B',
      scope: 'population',
      calibration: manual,
      groupA: summarizeThreshold(scores, manual.rule),
      groupB: summarizeThreshold(scores, manual.rule),
    }),
    /手動調整・率の上限なし.*OK基準群のNG候補：3 \/ 4件（75%）.*スコア ≤ 0\.4（低いスコア側）/,
  );
});

test('provenance display states search mode, range boundary, and review history in Japanese', () => {
  const conditions = display.formatInspectionConditions({
    range: { lo: 0.2, hi: 0.8, includeHi: false },
    overlapBinsOnly: true,
    query: 'Normal-01',
    queryMode: 'exact',
    decisionFilter: 'false-negative',
    excludedOnly: false,
  });
  assert.match(conditions, /完全一致/);
  assert.match(conditions, /0\.2 ≤ スコア < 0\.8/);
  assert.match(conditions, /反対群のOK候補/);
  assert.match(conditions, /共通範囲のみ/);
  const inclusiveRange = display.formatInspectionConditions({
    range: { lo: 0.2, hi: 0.8, includeHi: true },
    overlapBinsOnly: false,
    query: '',
    queryMode: 'partial',
    decisionFilter: 'all',
    excludedOnly: false,
  });
  assert.match(inclusiveRange, /0\.2 ≤ スコア ≤ 0\.8/);

  const history = display.formatReviewHistoryEntry({
    sampleId: 'normal-01',
    reason: '背景音あり',
    action: 'restore',
    at: '2026-09-05T00:00:00.000Z',
  });
  assert.match(history, /normal-01.*復元.*背景音あり/);
  assert.match(
    display.formatEvaluationCondition({
      scoreColumn: 'score',
      group: { kind: 'category', column: 'label', a: 'OK', b: 'NG' },
      okGroup: 'A',
      scoreDirection: 'low',
      filter: null,
    }),
    /OK基準：群A.*NG候補：低いスコア側.*集計条件：すべて/,
  );
  assert.match(
    display.formatEvaluationCondition({
      scoreColumn: 'score',
      group: { kind: 'category', column: 'label', a: 'OK', b: 'NG' },
      okGroup: 'B',
      scoreDirection: 'high',
      filter: { column: 'condition', value: 'stress' },
    }),
    /OK基準：群B.*NG候補：高いスコア側.*集計条件：condition = stress/,
  );
  assert.match(
    display.formatAnalysisMethod(),
    /PR-AUCを.*台形積分/,
  );
});
