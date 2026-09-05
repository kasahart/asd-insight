'use client';
import { useId } from 'react';

export const DISTRIBUTION_DASH = { groupB: '6 3', sample: '5 3' };
export const OVERLAP_HATCH_PATH = 'M-1 1L1 -1M0 7L7 0M6 8L8 6';
export const OVERLAP_HATCH_OPACITY = 0.65;

type SymbolKind = 'a' | 'b' | 'common' | 'sample' | 'threshold';
const colors: Record<SymbolKind, string> = {
  a: 'var(--cohort-a, #64d6bf)',
  b: 'var(--cohort-b, #f2b76f)',
  common: 'var(--chart-common, #a1b6c3)',
  sample: 'var(--selected-sample-color, #c5a3fa)',
  threshold: 'var(--threshold-color, #fb988c)',
};

export function SelectedSamplePoint({ x, y }: { x: number; y: number }) {
  return (
    <circle
      cx={x}
      cy={y}
      r={4.5}
      fill="currentColor"
      stroke="var(--card, #171f28)"
      strokeWidth={1.5}
    />
  );
}

// These are miniature chart marks, not additional controls. The same shape
// identifies the object in the legend, inspector tabs, and chart annotations.
export function DistributionSymbol({
  kind,
  cumulative = false,
  size = 20,
  x,
  y,
}: {
  kind: SymbolKind;
  cumulative?: boolean;
  size?: number;
  x?: number;
  y?: number;
}) {
  const hatchId = `distribution-hatch-${useId().replace(/:/g, '')}`;
  const group = kind === 'a' || kind === 'b';
  return (
    <svg
      className="distribution-symbol"
      data-kind={kind}
      width={size}
      height={size}
      x={x}
      y={y}
      viewBox="0 0 24 24"
      fill="none"
      color={colors[kind]}
      strokeWidth={2}
      aria-hidden="true"
      focusable="false"
      pointerEvents="none"
    >
      {group &&
        (cumulative ? (
          <path
            d="M2 20H8V12H15V4H22"
            stroke="currentColor"
            strokeDasharray={
              kind === 'b' ? DISTRIBUTION_DASH.groupB : undefined
            }
          />
        ) : (
          <>
            <path
              d="M2 20V12H8V4H16V9H22V20Z"
              fill="currentColor"
              fillOpacity={kind === 'a' ? 0.16 : 0.15}
            />
            <path
              d="M2 20V12H8V4H16V9H22V20"
              stroke="currentColor"
              strokeDasharray={
                kind === 'b' ? DISTRIBUTION_DASH.groupB : undefined
              }
            />
          </>
        ))}
      {kind === 'common' && (
        <>
          <defs>
            <pattern
              id={hatchId}
              width="7"
              height="7"
              patternUnits="userSpaceOnUse"
            >
              <path
                d={OVERLAP_HATCH_PATH}
                stroke="currentColor"
                strokeWidth={1}
                opacity={OVERLAP_HATCH_OPACITY}
              />
            </pattern>
          </defs>
          <rect x={3} y={4} width={18} height={16} fill={`url(#${hatchId})`} />
        </>
      )}
      {kind === 'sample' && (
        <>
          <path
            d="M12 1V23"
            stroke="currentColor"
            strokeDasharray={DISTRIBUTION_DASH.sample}
          />
          <SelectedSamplePoint x={12} y={12} />
        </>
      )}
      {kind === 'threshold' && (
        <path
          d="M12 1V23M3 15H21M7 11L3 15L7 19M17 11L21 15L17 19"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}
