import { useQuery } from '@tanstack/react-query';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Link } from 'react-router';
import { RunsTable } from '../components/RunsTable';
import { TargetMark } from '../components/Targets';
import { Sparkline } from '../components/Sparkline';
import { Empty, ErrorNote, PageHeader, Panel, Spinner, StatusBadge, Tag } from '../components/ui';
import { api } from '../lib/api';
import { fmtBytes, fmtNum, fmtPct, fmtValue, relTime } from '../lib/format';
import type { Dashboard, TypeSummary } from '../lib/types';

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'fail' }) {
  return (
    <div className="bg-panel px-4 py-3">
      <div className={tone === 'fail' ? 'text-xl font-semibold text-fail' : 'text-xl font-semibold text-ink'}>
        {value}
      </div>
      <div className="text-xs text-ink-3">{label}</div>
    </div>
  );
}

export function DashboardPage() {
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dashboard>('/api/v1/dashboard') });
  const types = useQuery({
    queryKey: ['types'],
    queryFn: () => api.get<{ types: TypeSummary[] }>('/api/v1/test-types?trend=30'),
  });
  if (dash.isLoading || types.isLoading) return <Spinner />;
  if (dash.error || types.error) return <ErrorNote error={dash.error ?? types.error} />;
  const d = dash.data!;
  const ts = [...types.data!.types].sort((a, b) => (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? ''));

  return (
    <div className="space-y-6">
      <PageHeader title="Overview">
        {d.counts.runs} runs across {d.counts.types} test types; {d.counts.runs7d} in the last 7 days.
      </PageHeader>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-rule bg-rule sm:grid-cols-5">
        <Stat label="runs recorded" value={fmtNum(d.counts.runs)} />
        <Stat label="in the last 7 days" value={fmtNum(d.counts.runs7d)} />
        <Stat
          label="failing or errored"
          value={fmtNum(d.counts.failing)}
          tone={d.counts.failing ? 'fail' : undefined}
        />
        <Stat label="sets" value={fmtNum(d.counts.sets)} />
        <Stat
          label={`attachments (${fmtBytes(d.counts.attachmentBytes)})`}
          value={fmtNum(d.counts.attachments)}
        />
      </div>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Panel
          title="Test types"
          subtitle="Headline data point over the last 30 runs; red dots are failing runs"
          bodyClass="p-0"
        >
          {ts.length === 0 ? (
            <div className="p-4">
              <Empty title="No test types yet">
                Define one under{' '}
                <Link className="text-accent underline" to="/new-type">
                  Admin → New test type
                </Link>
                , or with <code>PUT /api/v1/test-types/&lt;slug&gt;</code>.
              </Empty>
            </div>
          ) : (
            <ul className="divide-y divide-rule">
              {ts.map((t) => {
                const last = [...t.trend].reverse().find((x) => typeof x.value === 'number');
                return (
                  <li key={t.slug}>
                    <Link
                      to={`/types/${t.slug}`}
                      className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 px-4 py-3 hover:bg-panel-2 sm:grid-cols-[minmax(0,1fr)_170px_110px]"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-ink">{t.name}</span>
                          {t.failingCount > 0 && (
                            <span className="text-xs text-fail">{t.failingCount} failing</span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
                          <span>
                            {t.runCount} run{t.runCount === 1 ? '' : 's'} · last {relTime(t.lastRunAt)}
                          </span>
                          {t.tags.slice(0, 3).map((tag) => (
                            <Tag key={tag}>{tag}</Tag>
                          ))}
                        </div>
                      </div>
                      <div className="hidden sm:block">
                        <Sparkline points={t.trend} label={`${t.primary?.label ?? ''} trend for ${t.name}`} />
                      </div>
                      <div className="text-right">
                        <div className="font-semibold tabular-nums text-ink">
                          {last ? fmtValue(last.value) : '–'}
                        </div>
                        <div className="text-xs text-ink-3">
                          {t.primary?.label}
                          {t.primary?.unit ? ` (${t.primary.unit})` : ''}
                        </div>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        <div className="space-y-6">
          <Panel
            title="Regressions"
            subtitle="Against the previous comparable run: a relative bound failed, or the headline value got worse by more than 3%"
            bodyClass="p-0"
          >
            {d.regressions.length === 0 ? (
              <p className="p-4 text-sm text-ink-3">No regressions against the previous comparable runs.</p>
            ) : (
              <ul className="divide-y divide-rule">
                {d.regressions.map((r) => (
                  <li key={r.runId}>
                    <Link
                      to={`/runs/${r.runId}`}
                      className="flex items-start justify-between gap-3 px-4 py-2.5 hover:bg-panel-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-ink">
                          {r.params.label ?? r.params.commit ?? r.type.name}
                        </div>
                        <div className="truncate text-xs text-ink-3">
                          {r.type.name}
                          {Object.entries(r.params)
                            .filter(([k]) => k !== 'label' && k !== 'commit')
                            .slice(0, 3)
                            .map(([, v]) => ` · ${v}`)
                            .join('')}{' '}
                          · {relTime(r.runAt)}
                        </div>
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="flex items-center justify-end gap-1 text-sm font-semibold text-fail">
                          {r.deltaPct < 0 ? (
                            <TrendingDown className="size-4" aria-hidden />
                          ) : (
                            <TrendingUp className="size-4" aria-hidden />
                          )}
                          {fmtPct(r.deltaPct)}
                        </div>
                        <div className="text-xs tabular-nums text-ink-3">
                          {r.label}: {fmtNum(r.baseline)} → {fmtNum(r.value)} {r.unit}
                        </div>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Failing runs" bodyClass="p-0">
            {d.failing.length === 0 ? (
              <p className="p-4 text-sm text-ink-3">Nothing is failing.</p>
            ) : (
              <ul className="divide-y divide-rule">
                {d.failing.map((r) => (
                  <li key={r.id}>
                    <Link
                      to={`/runs/${r.id}`}
                      className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-panel-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-ink">
                          {r.params.label ?? r.externalId ?? `#${r.seq}`}
                        </div>
                        <div className="truncate text-xs text-ink-3">
                          {r.type.name} · {relTime(r.runAt)}
                        </div>
                      </div>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <TargetMark target={r.target} />
                        <StatusBadge status={r.status} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <Panel
        title="Latest runs"
        actions={
          <Link to="/runs" className="text-sm text-accent hover:underline">
            All runs
          </Link>
        }
      >
        {d.recent.length ? (
          <RunsTable runs={d.recent} />
        ) : (
          <Empty title="No runs yet">Submit one with the API or labbook-submit.</Empty>
        )}
      </Panel>
    </div>
  );
}
