import { Target as TargetIcon } from 'lucide-react';
import { Link } from 'react-router';
import { fmtNum } from '../lib/format';
import type { RunDetail, TargetResult } from '../lib/types';
import { Panel, cx } from './ui';

/** Small on/off-target marker for run lists; nothing when the run has no measurable target. */
export function TargetMark({ target }: { target: 'on' | 'off' | 'none' | undefined }) {
  if (target !== 'on' && target !== 'off') return null;
  const on = target === 'on';
  return (
    <span
      className={cx(
        'inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-1.5 py-px text-[11px] font-medium',
        on ? 'border-pass/40 text-pass' : 'border-fail/40 text-fail',
      )}
      title={on ? 'Meets every measurable target' : 'Misses at least one target (informational)'}
    >
      <TargetIcon className="size-3" aria-hidden />
      {on ? 'on target' : 'off target'}
    </span>
  );
}

function fmtZone(z: TargetResult['zone'], unit: string): string {
  const u = unit ? ` ${unit}` : '';
  if (z.min !== null && z.max !== null) return `${fmtNum(z.min)} – ${fmtNum(z.max)}${u}`;
  if (z.min !== null) return `≥ ${fmtNum(z.min)}${u}`;
  if (z.max !== null) return `≤ ${fmtNum(z.max)}${u}`;
  return '–';
}

function Verdict({ t }: { t: TargetResult }) {
  if (t.verdict === 'unknown')
    return (
      <span
        className="text-xs text-ink-3"
        title={t.value === null ? 'No value' : 'Nothing to measure against'}
      >
        – unknown
      </span>
    );
  if (t.verdict === 'on')
    return <span className="whitespace-nowrap text-xs font-medium text-pass">▲ on target</span>;
  const above = t.value !== null && t.zone.max !== null && t.value > t.zone.max;
  return (
    <span className="whitespace-nowrap text-xs font-medium text-fail">
      ▼ {above ? 'above' : 'below'} target
    </span>
  );
}

/** RunDetail: every target of the current definition, graded for this run. */
export function TargetResults({ run }: { run: RunDetail }) {
  if (!run.targets?.length) return null;
  const dpOf = (key: string) => run.definition.dataPoints.find((d) => d.key === key);
  return (
    <Panel
      title="Targets"
      subtitle="Graded with the current schema; informational only, a missed target never fails a run"
      bodyClass="p-0"
    >
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-rule text-left text-xs text-ink-3">
              <th className="px-4 py-2 font-medium">Data point</th>
              <th className="py-2 pr-3 font-medium">Target</th>
              <th className="py-2 pr-3 text-right font-medium">Value</th>
              <th className="py-2 pr-3 text-right font-medium">Zone</th>
              <th className="py-2 pr-3 font-medium">Reference</th>
              <th className="py-2 pr-4 font-medium">Verdict</th>
            </tr>
          </thead>
          <tbody>
            {run.targets.map((t) => {
              const dp = dpOf(t.key);
              const unit = dp?.unit ?? '';
              return (
                <tr key={`${t.key}:${t.index}`} className="border-b border-rule/70 last:border-0">
                  <td className="px-4 py-2 text-ink">{dp?.label ?? t.key}</td>
                  <td className="py-2 pr-3 text-ink-2">{t.label}</td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums text-ink">
                    {t.value === null ? '–' : `${fmtNum(t.value)}${unit ? ` ${unit}` : ''}`}
                  </td>
                  <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums text-ink-2">
                    {fmtZone(t.zone, unit)}
                  </td>
                  <td className="py-2 pr-3 text-xs text-ink-2">
                    {t.ref === 'absolute' ? (
                      <span className="text-ink-3">fixed</span>
                    ) : t.referenceRunId ? (
                      <Link to={`/runs/${t.referenceRunId}`} className="text-accent hover:underline">
                        {t.ref === 'best' ? 'best earlier run' : 'baseline member'}
                        {t.reference !== null && ` · ${fmtNum(t.reference)}`}
                      </Link>
                    ) : (
                      <span className="text-ink-3">
                        {t.ref === 'best' ? 'no earlier comparable run' : 'no matching member'}
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    <Verdict t={t} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
