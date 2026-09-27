import type { TypeDefinition } from '../../shared/types.js';
import type { RunSummary } from './runs.js';

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * One row per run. Parameter and data-point columns are the union over the runs,
 * in definition order where a definition is known.
 */
export function runsToCsv(runs: RunSummary[], defs: Map<string, TypeDefinition>): string {
  const paramKeys: string[] = [];
  const valueKeys: string[] = [];
  const add = (list: string[], k: string) => {
    if (!list.includes(k)) list.push(k);
  };
  for (const def of defs.values()) {
    def.parameters.forEach((p) => add(paramKeys, p.key));
    def.dataPoints.forEach((d) => add(valueKeys, d.key));
  }
  for (const r of runs) {
    Object.keys(r.params).forEach((k) => add(paramKeys, k));
    Object.keys(r.values).forEach((k) => add(valueKeys, k));
  }
  const header = [
    'id',
    'seq',
    'type',
    'type_version',
    'run_at',
    'status',
    'external_id',
    'source',
    'submitted_by',
    'commit',
    'branch',
    'ci_url',
    ...paramKeys.map((k) => `param.${k}`),
    ...valueKeys.map((k) => `value.${k}`),
    'sets',
    'notes',
    'conclusion',
  ];
  const lines = [header.join(',')];
  for (const r of runs) {
    const row = [
      r.id,
      r.seq,
      r.type.slug,
      r.typeVersion,
      r.runAt instanceof Date ? r.runAt.toISOString() : r.runAt,
      r.status,
      r.externalId,
      r.source,
      r.submittedBy,
      r.links.commit,
      r.links.branch,
      r.links.ciUrl,
      ...paramKeys.map((k) => r.params[k]),
      ...valueKeys.map((k) => r.values[k]),
      r.sets.map((s) => s.slug).join(' '),
      r.notes,
      r.conclusion,
    ];
    lines.push(row.map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}
