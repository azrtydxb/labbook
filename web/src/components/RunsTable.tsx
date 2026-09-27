import { Paperclip } from 'lucide-react';
import { Link } from 'react-router';
import { fmtDateTime, fmtValue, shortCommit } from '../lib/format';
import type { Run, TypeDefinition } from '../lib/types';
import { StatusBadge, cx } from './ui';

/** A compact, scannable run list. With `definition`, one column per data point. */
export function RunsTable({
  runs,
  definition,
  showType = true,
  selected,
  onToggle,
  maxValueCols = 6,
  extra,
}: {
  runs: Run[];
  definition?: TypeDefinition | undefined;
  showType?: boolean;
  selected?: Set<string>;
  onToggle?: (id: string) => void;
  maxValueCols?: number;
  extra?: { header: string; cell: (r: Run) => React.ReactNode };
}) {
  const dps = definition ? definition.dataPoints.slice(0, maxValueCols) : [];
  const paramKeys = definition
    ? definition.parameters
        .filter((p) => p.key !== 'commit')
        .map((p) => p.key)
        .slice(0, 4)
    : [];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-rule text-left text-xs text-ink-3">
            {onToggle && (
              <th className="w-8 py-2 pl-1 font-medium">
                <span className="sr-only">Select</span>
              </th>
            )}
            <th className="py-2 pr-3 font-medium">Status</th>
            {showType && <th className="py-2 pr-3 font-medium">Type</th>}
            <th className="py-2 pr-3 font-medium">Run</th>
            {paramKeys.map((k) => (
              <th key={k} className="py-2 pr-3 font-medium">
                {definition?.parameters.find((p) => p.key === k)?.label ?? k}
              </th>
            ))}
            {dps.map((d) => (
              <th key={d.key} className="py-2 pr-3 text-right font-medium">
                {d.label}
                {d.unit && <span className="ml-1 font-normal">({d.unit})</span>}
              </th>
            ))}
            {extra && <th className="py-2 pr-3 font-medium">{extra.header}</th>}
            <th className="py-2 pr-1 text-right font-medium">When</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const label = r.params.label ?? r.externalId ?? `#${r.seq}`;
            return (
              <tr
                key={r.id}
                className={cx(
                  'border-b border-rule/70 last:border-0 hover:bg-panel-2',
                  selected?.has(r.id) && 'bg-accent-soft/60',
                )}
              >
                {onToggle && (
                  <td className="py-2 pl-1">
                    <input
                      type="checkbox"
                      checked={selected?.has(r.id) ?? false}
                      onChange={() => onToggle(r.id)}
                      aria-label={`Select run ${label}`}
                      className="size-4 accent-[var(--accent)]"
                    />
                  </td>
                )}
                <td className="py-2 pr-3">
                  <StatusBadge status={r.status} />
                </td>
                {showType && (
                  <td className="py-2 pr-3">
                    <Link to={`/types/${r.type.slug}`} className="text-ink-2 hover:text-accent">
                      {r.type.name}
                    </Link>
                  </td>
                )}
                <td className="max-w-[280px] py-2 pr-3">
                  <Link to={`/runs/${r.id}`} className="font-medium text-ink hover:text-accent">
                    <span className="line-clamp-1">{label}</span>
                  </Link>
                  <div className="flex items-center gap-2 text-xs text-ink-3">
                    {r.links.commit && <span className="font-mono">{shortCommit(r.links.commit)}</span>}
                    {r.attachmentCount > 0 && (
                      <span
                        className="inline-flex items-center gap-0.5"
                        title={`${r.attachmentCount} attachments`}
                      >
                        <Paperclip className="size-3" aria-hidden />
                        {r.attachmentCount}
                      </span>
                    )}
                    {r.conclusion && <span className="line-clamp-1">{r.conclusion.split('\n')[0]}</span>}
                  </div>
                </td>
                {paramKeys.map((k) => (
                  <td key={k} className="py-2 pr-3 text-ink-2">
                    {r.params[k] ?? '–'}
                  </td>
                ))}
                {dps.map((d) => (
                  <td key={d.key} className="py-2 pr-3 text-right tabular-nums text-ink">
                    {fmtValue(r.values[d.key])}
                  </td>
                ))}
                {extra && <td className="py-2 pr-3">{extra.cell(r)}</td>}
                <td className="whitespace-nowrap py-2 pr-1 text-right text-xs text-ink-3">
                  {fmtDateTime(r.runAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
