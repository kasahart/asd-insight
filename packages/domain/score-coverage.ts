import type { DataRow } from './demo.ts';
import { finiteNumber } from './distribution.ts';

export type ScoreCoverage = {
  total: number;
  primaryValid: number;
  comparisonValid: number;
  bothValid: number;
  primaryOnly: number;
  comparisonOnly: number;
  bothMissing: number;
};

// Count column availability on the same input rows, before either score column
// removes missing values. Never impute values or change the comparison cohorts.
export function scoreCoverage(
  rows: readonly DataRow[],
  primaryColumn: string,
  comparisonColumn: string,
): ScoreCoverage {
  const result: ScoreCoverage = {
    total: rows.length,
    primaryValid: 0,
    comparisonValid: 0,
    bothValid: 0,
    primaryOnly: 0,
    comparisonOnly: 0,
    bothMissing: 0,
  };
  for (const row of rows) {
    const primary = finiteNumber(row[primaryColumn]) !== null;
    const comparison = finiteNumber(row[comparisonColumn]) !== null;
    if (primary) result.primaryValid++;
    if (comparison) result.comparisonValid++;
    if (primary && comparison) result.bothValid++;
    else if (primary) result.primaryOnly++;
    else if (comparison) result.comparisonOnly++;
    else result.bothMissing++;
  }
  return result;
}
