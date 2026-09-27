import { useNavigate } from 'react-router';
import {
  CartesianGrid,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { fmtDate, fmtDateTime, fmtNum, SERIES, shortCommit } from '../lib/format';
import type { DataPointDef, RunStatus } from '../lib/types';

export interface ChartPoint {
  x: number;
  y: number;
  id: string;
  runAt: string;
  status: RunStatus;
  params: Record<string, string>;
  commit?: string | undefined;
}

export interface ChartSeries {
  name: string;
  colorIndex: number;
  points: ChartPoint[];
}

/** Round the axis to 1-2-5 steps so ticks read as 0, 200, 400… rather than 37.3, 237.3. */
function niceScale(lo: number, hi: number, count = 5): { domain: [number, number]; ticks: number[] } {
  let span = hi - lo;
  if (span <= 0) span = Math.abs(hi) * 0.1 || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const start = Math.floor((lo === hi ? lo - span / 2 : lo) / step) * step;
  const end = Math.ceil((lo === hi ? hi + span / 2 : hi) / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { domain: [start, end], ticks };
}

function PointTooltip({ active, payload, dp }: { active?: boolean; payload?: any[]; dp: DataPointDef }) {
  const p = payload?.[0]?.payload as (ChartPoint & { series: string }) | undefined;
  if (!active || !p) return null;
  const params = Object.entries(p.params).filter(([k]) => k !== 'commit');
  return (
    <div className="max-w-xs rounded-lg border border-rule bg-panel px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 text-[15px] font-semibold text-ink">
        {fmtNum(p.y)} <span className="text-xs font-normal text-ink-2">{dp.unit}</span>
      </div>
      <div className="text-ink-2">{p.series}</div>
      <div className="text-ink-3">{fmtDateTime(p.runAt)}</div>
      {p.commit && <div className="font-mono text-ink-2">{shortCommit(p.commit)}</div>}
      {params.length > 0 && (
        <div className="mt-1 text-ink-3">{params.map(([k, v]) => `${k}=${v}`).join(', ')}</div>
      )}
      {(p.status === 'fail' || p.status === 'error') && (
        <div className="mt-1 font-medium text-fail">Run {p.status}ed</div>
      )}
      <div className="mt-1 text-ink-3">Click to open the run</div>
    </div>
  );
}

/**
 * One data point over time (or over run sequence), one line per group. The
 * allowed range from absolute bounds is shaded; failing runs wear a red ring.
 */
export function MetricChart({
  dp,
  series,
  xMode,
  height = 260,
}: {
  dp: DataPointDef;
  series: ChartSeries[];
  xMode: 'time' | 'sequence';
  height?: number;
}) {
  const navigate = useNavigate();
  const all = series.flatMap((s) => s.points);
  if (all.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-ink-3">
        No numeric values for {dp.label} yet.
      </div>
    );
  }
  const b = dp.bounds ?? {};
  const ys = all.map((p) => p.y);
  const lo = Math.min(
    ...ys,
    ...(b.min !== undefined ? [b.min] : []),
    ...(b.max !== undefined ? [b.max] : []),
  );
  const hi = Math.max(
    ...ys,
    ...(b.min !== undefined ? [b.min] : []),
    ...(b.max !== undefined ? [b.max] : []),
  );
  const { domain: yDomain, ticks: yTicks } = niceScale(lo, hi);
  const xs = all.map((p) => p.x);
  const xPad = xMode === 'sequence' ? 0.5 : Math.max(3600_000, (Math.max(...xs) - Math.min(...xs)) * 0.02);
  const xDomain: [number, number] = [Math.min(...xs) - xPad, Math.max(...xs) + xPad];

  return (
    <div>
      {series.length > 1 && (
        <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-label="Series">
          {series.map((s) => (
            <li key={s.name} className="flex items-center gap-1.5">
              <span
                className="inline-block h-0.5 w-4 rounded"
                style={{ background: SERIES[s.colorIndex % SERIES.length] }}
              />
              {s.name}
            </li>
          ))}
        </ul>
      )}
      <div className="graph-paper rounded-lg border border-rule">
        <ResponsiveContainer width="100%" height={height}>
          <ScatterChart margin={{ top: 14, right: 18, bottom: 6, left: 6 }}>
            <CartesianGrid stroke="var(--rule)" strokeDasharray="0" vertical={false} />
            <XAxis
              type="number"
              dataKey="x"
              domain={xDomain}
              allowDataOverflow
              tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: 'var(--rule-strong)' }}
              tickFormatter={(v: number) =>
                xMode === 'time' ? fmtDate(new Date(v).toISOString()) : `#${Math.round(v)}`
              }
              minTickGap={24}
              allowDecimals={false}
            />
            <YAxis
              type="number"
              dataKey="y"
              domain={yDomain}
              ticks={yTicks}
              allowDataOverflow
              tick={{ fill: 'var(--ink-3)', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={56}
              tickFormatter={(v: number) => fmtNum(v)}
            />
            {(b.min !== undefined || b.max !== undefined) && (
              <ReferenceArea
                y1={b.min ?? yDomain[0]}
                y2={b.max ?? yDomain[1]}
                fill="var(--band)"
                fillOpacity={1}
                stroke="none"
                ifOverflow="hidden"
              />
            )}
            {b.min !== undefined && (
              <ReferenceLine
                y={b.min}
                stroke="var(--band-edge)"
                strokeDasharray="4 3"
                label={{
                  value: `min ${fmtNum(b.min)}`,
                  position: 'insideBottomRight',
                  fill: 'var(--ink-3)',
                  fontSize: 10,
                }}
              />
            )}
            {b.max !== undefined && (
              <ReferenceLine
                y={b.max}
                stroke="var(--band-edge)"
                strokeDasharray="4 3"
                label={{
                  value: `max ${fmtNum(b.max)}`,
                  position: 'insideTopRight',
                  fill: 'var(--ink-3)',
                  fontSize: 10,
                }}
              />
            )}
            <Tooltip
              content={<PointTooltip dp={dp} />}
              cursor={{ stroke: 'var(--ink-3)', strokeDasharray: '3 3' }}
            />
            {series.map((s) => {
              const color = SERIES[s.colorIndex % SERIES.length];
              const data = [...s.points].sort((a, b2) => a.x - b2.x).map((p) => ({ ...p, series: s.name }));
              return (
                <Scatter
                  key={s.name}
                  name={s.name}
                  data={data}
                  fill={color}
                  line={{ stroke: color, strokeWidth: 2 }}
                  lineType="joint"
                  isAnimationActive={false}
                  shape={(props: any) => {
                    const pt = props.payload as ChartPoint;
                    const bad = pt.status === 'fail' || pt.status === 'error';
                    return (
                      <g
                        style={{ cursor: 'pointer' }}
                        onClick={() => navigate(`/runs/${pt.id}`)}
                        role="link"
                        aria-label={`Open run ${fmtNum(pt.y)} ${dp.unit}`}
                      >
                        <circle cx={props.cx} cy={props.cy} r={12} fill="transparent" />
                        <circle
                          cx={props.cx}
                          cy={props.cy}
                          r={bad ? 5 : 4}
                          fill={bad ? 'var(--panel)' : color}
                          stroke={bad ? 'var(--fail)' : 'var(--panel)'}
                          strokeWidth={bad ? 2.5 : 2}
                        />
                      </g>
                    );
                  }}
                />
              );
            })}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
