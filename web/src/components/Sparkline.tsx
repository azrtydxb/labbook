import type { RunStatus, Scalar } from '../lib/types';

/** A tiny trend line; failing runs get a red dot so they stand out in the trend. */
export function Sparkline({
  points,
  width = 160,
  height = 40,
  label,
}: {
  points: { value: Scalar; status: RunStatus }[];
  width?: number;
  height?: number;
  label: string;
}) {
  const nums = points.filter((p): p is { value: number; status: RunStatus } => typeof p.value === 'number');
  if (nums.length < 2) {
    return (
      <div style={{ width, height }} className="flex items-center text-xs text-ink-3">
        {nums.length ? 'one run so far' : 'no numeric runs'}
      </div>
    );
  }
  const vs = nums.map((p) => p.value);
  const min = Math.min(...vs);
  const max = Math.max(...vs);
  const pad = 4;
  const x = (i: number) => pad + (i * (width - 2 * pad)) / (nums.length - 1);
  const y = (v: number) =>
    max === min ? height / 2 : pad + (1 - (v - min) / (max - min)) * (height - 2 * pad);
  const d = nums.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const last = nums[nums.length - 1]!;
  return (
    <svg width={width} height={height} role="img" aria-label={label} className="overflow-visible">
      <path
        d={d}
        fill="none"
        stroke="var(--s1)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {nums.map((p, i) =>
        p.status === 'fail' || p.status === 'error' ? (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.value)}
            r={3}
            fill="var(--fail)"
            stroke="var(--panel)"
            strokeWidth={1.5}
          />
        ) : null,
      )}
      <circle
        cx={x(nums.length - 1)}
        cy={y(last.value)}
        r={3.5}
        fill="var(--s1)"
        stroke="var(--panel)"
        strokeWidth={2}
      />
    </svg>
  );
}
