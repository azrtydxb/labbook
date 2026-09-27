import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, ExternalLink, Eye, GitBranch, GitCommit, Trash2, Upload } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { BoundStrip } from '../components/BoundStrip';
import { MarkdownField } from '../components/Markdown';
import {
  Button,
  Delta,
  ErrorNote,
  Label,
  PageHeader,
  Panel,
  Select,
  Spinner,
  StatusBadge,
  VerdictMark,
} from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtBytes, fmtDateTime, fmtValue, shortCommit } from '../lib/format';
import type { Attachment, RunDetail, RunStatus, SetSummary } from '../lib/types';

function AttachmentViewer({ a }: { a: Attachment }) {
  const q = useQuery({
    queryKey: ['attachment', a.id, a.sha256],
    queryFn: async () => {
      const res = await fetch(`/api/v1/attachments/${a.id}?inline=1`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (a.contentType.includes('json')) {
        try {
          return JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          return text;
        }
      }
      return text;
    },
  });
  if (q.isLoading) return <Spinner label="Loading file" />;
  if (q.error) return <ErrorNote error={q.error} />;
  return (
    <pre className="max-h-[480px] overflow-auto rounded-md border border-rule bg-panel-2 p-3 font-mono text-[12px] leading-relaxed text-ink">
      {q.data}
    </pre>
  );
}

const TEXTUAL = /^(text\/|application\/(json|yaml|xml|x-ndjson))/;

export function RunDetailPage() {
  const { id = '' } = useParams();
  const { user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const run = useQuery({ queryKey: ['run', id], queryFn: () => api.get<RunDetail>(`/api/v1/runs/${id}`) });
  const sets = useQuery({
    queryKey: ['sets'],
    queryFn: () => api.get<{ sets: SetSummary[] }>('/api/v1/sets'),
  });
  const [viewing, setViewing] = useState<string | null>(null);
  const [addSet, setAddSet] = useState('');
  const [uploadErr, setUploadErr] = useState<unknown>(null);
  const [uploading, setUploading] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['run', id] });
    void qc.invalidateQueries({ queryKey: ['runs'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const patch = (body: Record<string, unknown>) => api.patch(`/api/v1/runs/${id}`, body).then(refresh);
  const statusMut = useMutation({ mutationFn: (s: RunStatus) => patch({ status: s }) });
  const addToSet = useMutation({
    mutationFn: (slug: string) => api.post(`/api/v1/sets/${slug}/runs`, { runIds: [id] }),
    onSuccess: () => {
      setAddSet('');
      refresh();
      void qc.invalidateQueries({ queryKey: ['sets'] });
    },
  });
  const delAttachment = useMutation({
    mutationFn: (aid: string) => api.del(`/api/v1/attachments/${aid}`),
    onSuccess: refresh,
  });
  const delRun = useMutation({
    mutationFn: () => api.del(`/api/v1/runs/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries();
      navigate(`/types/${run.data?.type.slug ?? ''}`);
    },
  });

  if (run.isLoading) return <Spinner />;
  if (run.error) return <ErrorNote error={run.error} />;
  const r = run.data!;
  const def = r.definition;
  const title = r.params.label ?? r.externalId ?? `Run #${r.seq}`;
  const other = r.edits.filter((e) => e.field !== 'notes' && e.field !== 'conclusion');

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append('file', f, f.name);
    setUploading(true);
    setUploadErr(null);
    try {
      await api.post(`/api/v1/runs/${id}/attachments`, fd);
      refresh();
    } catch (e) {
      setUploadErr(e);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        kicker={
          <Link to={`/types/${r.type.slug}`} className="hover:text-accent">
            {r.type.name}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-3">
            {title} <StatusBadge status={r.status} />
          </span>
        }
        actions={
          <>
            <label className="flex items-center gap-2 text-xs text-ink-3">
              Status
              <Select
                className="w-28"
                value={r.status}
                onChange={(e) => statusMut.mutate(e.target.value as RunStatus)}
                aria-label="Run status"
              >
                <option value="pass">Pass</option>
                <option value="fail">Fail</option>
                <option value="error">Error</option>
                <option value="info">Info</option>
              </Select>
            </label>
            <Link
              to={`/compare?ids=${[r.baseline?.id, r.id].filter(Boolean).join(',')}`}
              className="inline-flex h-9 items-center rounded-md border border-rule-strong bg-panel px-3 text-sm hover:bg-panel-2"
            >
              {r.baseline ? 'Compare with baseline' : 'Compare'}
            </Link>
          </>
        }
      >
        Ran {fmtDateTime(r.runAt)}
        {r.source && <> from {r.source}</>}
        {r.submittedBy && <>, submitted by {r.submittedBy}</>}. Schema v{r.typeVersion}
        {r.typeVersion < r.type.currentVersion && ` (current v${r.type.currentVersion})`}.
        {r.statusAuto && ' Status computed from the bounds.'}
        {r.externalId && (
          <span className="ml-1 font-mono text-xs text-ink-3" title="External id">
            {r.externalId}
          </span>
        )}
      </PageHeader>
      <ErrorNote error={statusMut.error} />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <Panel
            title="Data points"
            subtitle={
              r.baseline ? (
                <>
                  Compared with the previous comparable run,{' '}
                  <Link to={`/runs/${r.baseline.id}`} className="text-accent hover:underline">
                    {r.baseline.params.label ?? r.baseline.externalId ?? `#${r.baseline.seq}`}
                  </Link>{' '}
                  ({fmtDateTime(r.baseline.runAt)})
                </>
              ) : (
                'No earlier run with the same identity parameters, so relative bounds are not checked.'
              )
            }
            bodyClass="p-0"
          >
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-rule text-left text-xs text-ink-3">
                    <th className="px-4 py-2 font-medium">Data point</th>
                    <th className="py-2 pr-3 text-right font-medium">Value</th>
                    <th className="py-2 pr-3 font-medium">Against bounds</th>
                    <th className="py-2 pr-3 text-right font-medium">Baseline</th>
                    <th className="py-2 pr-3 text-right font-medium">Change</th>
                    <th className="py-2 pr-4 font-medium">Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {def.dataPoints.map((dp) => {
                    const ev = r.evaluation.points.find((p) => p.key === dp.key)!;
                    return (
                      <tr key={dp.key} className="border-b border-rule/70 align-middle last:border-0">
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-ink">{dp.label}</div>
                          <div className="text-xs text-ink-3">
                            {dp.better === 'higher'
                              ? 'higher is better'
                              : dp.better === 'lower'
                                ? 'lower is better'
                                : dp.type}
                          </div>
                        </td>
                        <td className="whitespace-nowrap py-2.5 pr-3 text-right text-[15px] font-semibold tabular-nums">
                          {fmtValue(ev.value)}
                          {dp.unit && ev.value !== undefined && (
                            <span className="ml-1 text-xs font-normal text-ink-3">{dp.unit}</span>
                          )}
                        </td>
                        <td className="w-[240px] py-2.5 pr-3">
                          <BoundStrip
                            dp={dp}
                            value={ev.value}
                            baseline={ev.baseline}
                            failed={ev.verdict === 'fail'}
                          />
                        </td>
                        <td className="whitespace-nowrap py-2.5 pr-3 text-right tabular-nums text-ink-2">
                          {fmtValue(ev.baseline)}
                        </td>
                        <td className="py-2.5 pr-3 text-right">
                          <Delta pct={ev.deltaPct} improved={ev.improved} />
                        </td>
                        <td className="py-2.5 pr-4">
                          <VerdictMark verdict={ev.verdict} />
                          {ev.reasons.length > 0 && (
                            <div className="text-xs text-fail">{ev.reasons.join('; ')}</div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {Object.keys(r.values)
                    .filter((k) => !def.dataPoints.some((d) => d.key === k))
                    .map((k) => (
                      <tr key={k} className="border-b border-rule/70 last:border-0">
                        <td className="px-4 py-2.5 text-ink-2">{k}</td>
                        <td className="py-2.5 pr-3 text-right">{fmtValue(r.values[k])}</td>
                        <td colSpan={4} className="py-2.5 pr-4 text-xs text-ink-3">
                          not in schema v{r.typeVersion}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel>
            <div className="space-y-6">
              <MarkdownField
                label="Conclusion"
                value={r.conclusion}
                edits={r.edits.filter((e) => e.field === 'conclusion')}
                placeholder="What did this run show? Add a conclusion."
                onSave={(v) => patch({ conclusion: v })}
              />
              <div className="border-t border-rule pt-5">
                <MarkdownField
                  label="Notes"
                  value={r.notes}
                  edits={r.edits.filter((e) => e.field === 'notes')}
                  placeholder="Add notes: setup, anomalies, what to try next."
                  onSave={(v) => patch({ notes: v })}
                />
              </div>
            </div>
          </Panel>

          <Panel
            title="Attachments"
            subtitle="Logs and reports stored with the run"
            actions={
              <label className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rule-strong bg-panel px-2.5 text-xs font-medium hover:bg-panel-2">
                <Upload className="size-3.5" aria-hidden />
                {uploading ? 'Uploading…' : 'Upload files'}
                <input
                  type="file"
                  multiple
                  className="sr-only"
                  onChange={(e) => void upload(e.target.files)}
                />
              </label>
            }
          >
            <ErrorNote error={uploadErr ?? delAttachment.error} />
            {r.attachments.length === 0 ? (
              <p className="text-sm text-ink-3">
                No attachments. Upload logs or JSON reports to keep them with this run.
              </p>
            ) : (
              <ul className="divide-y divide-rule">
                {r.attachments.map((a) => (
                  <li key={a.id} className="py-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="font-mono text-[13px] text-ink">{a.filename}</span>
                        <span className="ml-2 text-xs text-ink-3">
                          {fmtBytes(a.size)} · {a.contentType}
                        </span>
                      </div>
                      <div className="flex gap-1">
                        {TEXTUAL.test(a.contentType) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setViewing(viewing === a.id ? null : a.id)}
                            aria-expanded={viewing === a.id}
                          >
                            <Eye className="size-3.5" aria-hidden /> {viewing === a.id ? 'Hide' : 'View'}
                          </Button>
                        )}
                        <a
                          href={`/api/v1/attachments/${a.id}`}
                          className="inline-flex h-7 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-ink-2 hover:bg-panel-2 hover:text-ink"
                        >
                          <Download className="size-3.5" aria-hidden /> Download
                        </a>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Delete ${a.filename}`}
                          onClick={() => {
                            if (confirm(`Delete ${a.filename}?`)) delAttachment.mutate(a.id);
                          }}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      </div>
                    </div>
                    {viewing === a.id && (
                      <div className="mt-2">
                        <AttachmentViewer a={a} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel title="Parameters">
            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              {Object.entries(r.params).map(([k, v]) => {
                const p = def.parameters.find((x) => x.key === k);
                return (
                  <div key={k} className="contents">
                    <dt className="text-ink-3">
                      {p?.label ?? k}
                      {p?.identity && <span className="sr-only"> (identity)</span>}
                    </dt>
                    <dd className="break-words text-ink">
                      <Link
                        to={`/runs?type=${r.type.slug}&param.${encodeURIComponent(k)}=${encodeURIComponent(v)}`}
                        className="hover:text-accent"
                      >
                        {v}
                      </Link>
                    </dd>
                  </div>
                );
              })}
              {Object.keys(r.params).length === 0 && <dd className="text-ink-3">None</dd>}
            </dl>
          </Panel>

          <Panel title="Links">
            <ul className="space-y-1.5 text-sm">
              {r.links.commit && (
                <li className="flex items-center gap-2">
                  <GitCommit className="size-4 text-ink-3" aria-hidden />
                  <span className="font-mono">{shortCommit(r.links.commit)}</span>
                </li>
              )}
              {r.links.branch && (
                <li className="flex items-center gap-2">
                  <GitBranch className="size-4 text-ink-3" aria-hidden /> {r.links.branch}
                </li>
              )}
              {r.links.ciUrl && (
                <li>
                  <a
                    href={r.links.ciUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 text-accent hover:underline"
                  >
                    <ExternalLink className="size-4" aria-hidden /> CI run
                  </a>
                </li>
              )}
              {r.links.other?.map((l) => (
                <li key={l.url}>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-2 text-accent hover:underline"
                  >
                    <ExternalLink className="size-4" aria-hidden /> {l.label}
                  </a>
                </li>
              ))}
              {!r.links.commit && !r.links.branch && !r.links.ciUrl && !r.links.other?.length && (
                <li className="text-ink-3">No links recorded.</li>
              )}
            </ul>
          </Panel>

          <Panel title="Sets">
            <ul className="mb-3 space-y-1 text-sm">
              {r.sets.map((s) => (
                <li key={s.slug}>
                  <Link to={`/sets/${s.slug}`} className="text-accent hover:underline">
                    {s.name}
                  </Link>
                </li>
              ))}
              {r.sets.length === 0 && <li className="text-ink-3">Not in any set.</li>}
            </ul>
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (addSet) addToSet.mutate(addSet);
              }}
            >
              <label className="flex-1">
                <span className="sr-only">Set</span>
                <Select value={addSet} onChange={(e) => setAddSet(e.target.value)}>
                  <option value="">Add to set…</option>
                  {sets.data?.sets
                    .filter((s) => !r.sets.some((x) => x.slug === s.slug))
                    .map((s) => (
                      <option key={s.slug} value={s.slug}>
                        {s.name}
                      </option>
                    ))}
                </Select>
              </label>
              <Button type="submit" disabled={!addSet} loading={addToSet.isPending}>
                Add
              </Button>
            </form>
            <ErrorNote error={addToSet.error} />
          </Panel>

          <Panel title="Change history" subtitle="Every change to this run after it was submitted">
            {other.length === 0 ? (
              <p className="text-sm text-ink-3">Unchanged since submission.</p>
            ) : (
              <ol className="space-y-2 text-xs">
                {other.map((e) => (
                  <li key={e.id} className="border-l-2 border-rule pl-2">
                    <div className="text-ink-2">
                      <span className="font-medium text-ink">{e.field}</span> changed{' '}
                      {fmtDateTime(e.editedAt)}
                      {e.editedBy && ` by ${e.editedBy}`}
                    </div>
                    <details>
                      <summary className="cursor-pointer text-ink-3">Before and after</summary>
                      <div className="mt-1 break-all font-mono text-[11px] text-ink-3">
                        − {e.oldValue ?? '(none)'}
                      </div>
                      <div className="break-all font-mono text-[11px] text-ink-2">
                        + {e.newValue ?? '(none)'}
                      </div>
                    </details>
                  </li>
                ))}
              </ol>
            )}
          </Panel>

          {user?.role === 'admin' && (
            <div>
              <Label>Danger zone</Label>
              <Button
                variant="danger"
                size="sm"
                loading={delRun.isPending}
                onClick={() => {
                  if (confirm('Delete this run with its attachments? This cannot be undone.'))
                    delRun.mutate();
                }}
              >
                <Trash2 className="size-3.5" aria-hidden /> Delete run
              </Button>
              <ErrorNote error={delRun.error} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
