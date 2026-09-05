import type { Sample } from './data.ts';
import { finiteNumber } from './distribution.ts';
import type { EvaluationListSort } from '../contracts/evaluation.ts';

type Token = string | number;

function numericTokens(value: string): Token[] {
  return value
    .split(/([0-9]+)/)
    .filter(Boolean)
    .map((token) =>
      /^[0-9]+$/.test(token) ? Number.parseInt(token, 10) : token,
    );
}

/** Same case-insensitive digit-run ordering as the existing table's natural sort. */
function naturalOrder(a: Token[], b: Token[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const left = a[index],
      right = b[index];
    if (typeof left !== typeof right) return typeof left === 'string' ? -1 : 1;
    if (left !== right) return left > right ? 1 : -1;
  }
  return a.length - b.length;
}

/** Sort once in the worker; missing numeric values stay last in either direction. */
export function sortReviewSamples(
  samples: readonly Sample[],
  sort?: EvaluationListSort,
  idColumn?: string,
): readonly Sample[] {
  if (!sort) return samples;
  const builtin = sort.source !== 'row';
  const kind =
    sort.kind ??
    (builtin && sort.column === '__score'
      ? 'number'
      : builtin && sort.column === '__group'
        ? 'text'
        : 'alphanumeric');
  const entries = samples.map((sample) => {
    const raw =
      builtin && sort.column === '__score'
        ? sample.score
        : builtin && sort.column === '__group'
          ? sample.group
          : builtin && sort.column === '__sample'
            ? idColumn
              ? sample.row[idColumn]
              : `row-${sample.index + 1}`
            : sample.row[sort.column];
    const value =
      kind === 'number' ? finiteNumber(String(raw)) : String(raw).toLowerCase();
    return {
      sample,
      value,
      tokens: kind === 'alphanumeric' ? numericTokens(String(value)) : [],
    };
  });
  entries.sort((a, b) => {
    if (a.value === null || b.value === null) {
      if (a.value !== b.value) return a.value === null ? 1 : -1;
      return a.sample.index - b.sample.index;
    }
    const order =
      kind === 'alphanumeric'
        ? naturalOrder(a.tokens, b.tokens)
        : a.value === b.value
          ? 0
          : a.value > b.value
            ? 1
            : -1;
    return order
      ? sort.desc
        ? -order
        : order
      : a.sample.index - b.sample.index;
  });
  return entries.map(({ sample }) => sample);
}
