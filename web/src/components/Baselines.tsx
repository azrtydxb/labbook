import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pin, Plus, Trash2, X } from 'lucide-react';
import { useId, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { BASELINE_SLUG, fmtMatch, fmtRatio, slugify } from '../lib/baselines';
import { fmtDate, fmtValue } from '../lib/format';
import type { Baseline, RunDetail, TypeDefinition } from '../lib/types';
import { Button, Delta, Empty, ErrorNote, Input, Label, Panel, Select, Spinner, Tag, cx } from './ui';

const base = (typeSlug: string) => `/api/v1/test-types/${typeSlug}/baselines`;

/** The pinned baselines of a test type. */
export function useBaselines(typeSlug: string) {
  return useQuery({
    queryKey: ['baselines', typeSlug],
    queryFn: () => api.get<{ baselines: Baseline[] }>(base(typeSlug)).then((d) => d.baselines),
    enabled: !!typeSlug,
  });
}

/** Everything that shows baseline membership or comparisons goes stale on a change. */
function useRefresh(typeSlug: string) {
  const qc = useQueryClient();
  return () => {
    for (const key of [['baselines', typeSlug], ['run'], ['runs'], ['set'], ['dashboard']])
      void qc.invalidateQueries({ queryKey: key });
  };
}

/** Small pin badge naming the pinned baselines a run belongs to. */
export function BaselineBadge({
  baselines,
  className,
}: {
  baselines: { slug: string; name: string }[] | undefined;
  className?: string;
}) {
  if (!baselines?.length) return null;
  const names = baselines.map((b) => b.name).join(', ');
  return (
    <span
      className={cx(
        'inline-flex max-w-[220px] items-center gap-1 rounded-full bg-accent-soft px-1.5 py-px text-[11px] font-medium text-accent',
        className,
      )}
      title={`Baseline member: ${names}`}
    >
      <Pin className="size-3 shrink-0" aria-hidden />
      <span className="sr-only">Baseline member: </span>
      <span className="truncate">{names}</span>
    </span>
  );
}

function primaryOf(def: TypeDefinition) {
  return def.dataPoints.find((d) => d.key === def.primary) ?? def.dataPoints.find((d) => d.type === 'number');
}

/**
 * Name, slug (derived from the name until edited) and match keys for a new
 * baseline; PUTs it, optionally with its first member runs.
 */
function NewBaselineForm({
  typeSlug,
  definition,
  runIds,
  runParams,
  onDone,
  onCancel,
  compact,
}: {
  typeSlug: string;
  definition: TypeDefinition;
  runIds?: string[];
  /** Stack the fields, for narrow side panels. */
  compact?: boolean;
  /** When adding one run, keys it lacks can't be match keys. */
  runParams?: Record<string, string>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const id = useId();
  const refresh = useRefresh(typeSlug);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [keys, setKeys] = useState<string[]>(() =>
    definition.parameters
      .filter((p) => p.identity && (!runParams || runParams[p.key] !== undefined))
      .map((p) => p.key),
  );
  const effectiveSlug = slug ?? slugify(name);
  const slugOk = BASELINE_SLUG.test(effectiveSlug);
  const create = useMutation({
    mutationFn: () =>
      api.put<{ slug: string; created: boolean }>(`${base(typeSlug)}/${effectiveSlug}`, {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        matchKeys: keys,
        ...(runIds?.length ? { runIds } : {}),
      }),
    onSuccess: () => {
      refresh();
      onDone();
    },
  });
  return (
    <form
      className="space-y-3 rounded-lg border border-rule bg-panel-2/50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && slugOk) create.mutate();
      }}
    >
      <div className={cx('grid grid-cols-1 gap-3', !compact && 'sm:grid-cols-2')}>
        <label>
          <Label>Name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Reference: previous release"
            required
            autoFocus
          />
        </label>
        <label>
          <Label hint={slug === null ? 'from the name' : undefined}>Slug</Label>
          <Input
            value={effectiveSlug}
            onChange={(e) => setSlug(e.target.value)}
            className="font-mono"
            aria-invalid={!!effectiveSlug && !slugOk}
            aria-describedby={`${id}-slug`}
          />
          <span
            id={`${id}-slug`}
            className={cx('text-xs', slugOk || !effectiveSlug ? 'sr-only' : 'text-fail')}
          >
            Lowercase letters, digits, dot, dash and underscore; starting with a letter or digit.
          </span>
        </label>
      </div>
      <label className="block">
        <Label hint="optional">Description</Label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="The numbers to beat"
        />
      </label>
      <fieldset>
        <legend className="mb-1 text-xs font-medium text-ink-2">
          Match on
          <span className="ml-1 font-normal text-ink-3">
            one member per combination; a run is compared with the member sharing these values
          </span>
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {definition.parameters.map((p) => {
            const missing = runParams !== undefined && runParams[p.key] === undefined;
            return (
              <label
                key={p.key}
                className={cx('flex items-center gap-1.5 text-sm', missing ? 'text-ink-3' : 'text-ink')}
              >
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--accent)]"
                  checked={keys.includes(p.key)}
                  disabled={missing}
                  onChange={(e) =>
                    setKeys((k) => (e.target.checked ? [...k, p.key] : k.filter((x) => x !== p.key)))
                  }
                />
                {p.label}
                {missing && <span className="text-xs">(not set on this run)</span>}
              </label>
            );
          })}
          {definition.parameters.length === 0 && (
            <span className="text-sm text-ink-3">This type has no parameters: one member only.</span>
          )}
        </div>
      </fieldset>
      <ErrorNote error={create.error} />
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          disabled={!name.trim() || !slugOk}
          loading={create.isPending}
        >
          {runIds?.length ? 'Create and add' : 'Create baseline'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function BaselineCard({
  b,
  typeSlug,
  definition,
  selected,
  isAdmin,
}: {
  b: Baseline;
  typeSlug: string;
  definition: TypeDefinition;
  selected: Set<string>;
  isAdmin: boolean;
}) {
  const refresh = useRefresh(typeSlug);
  const [note, setNote] = useState('');
  const dp = primaryOf(definition);
  const removeMember = useMutation({
    mutationFn: (runId: string) => api.del(`${base(typeSlug)}/${b.slug}/runs/${runId}`),
    onSuccess: refresh,
  });
  const addSelected = useMutation({
    mutationFn: () =>
      api.post<{ added: number; replaced: number }>(`${base(typeSlug)}/${b.slug}/runs`, {
        runIds: [...selected],
      }),
    onSuccess: (r) => {
      setNote(
        [r.added ? `${r.added} added` : '', r.replaced ? `${r.replaced} replaced an existing member` : '']
          .filter(Boolean)
          .join(', ') || 'Nothing changed',
      );
      refresh();
    },
  });
  const del = useMutation({
    mutationFn: () => api.del(`${base(typeSlug)}/${b.slug}`),
    onSuccess: refresh,
  });
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium text-ink">
            {b.name} <span className="ml-1 font-mono text-xs font-normal text-ink-3">{b.slug}</span>
          </h3>
          {b.description && <p className="text-sm text-ink-2">{b.description}</p>}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-ink-3">
            {b.matchKeys.length ? (
              <>
                matched on{' '}
                {b.matchKeys.map((k) => (
                  <Tag key={k}>{definition.parameters.find((p) => p.key === k)?.label ?? k}</Tag>
                ))}
              </>
            ) : (
              'one member for every run'
            )}
            <span>
              · {b.members.length} {b.members.length === 1 ? 'member' : 'members'}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {selected.size > 0 && (
            <Button
              size="sm"
              onClick={() => addSelected.mutate()}
              loading={addSelected.isPending}
              title="Add the runs selected below; a run replaces the member with the same match"
            >
              <Plus className="size-3.5" aria-hidden /> Add {selected.size} selected
            </Button>
          )}
          {isAdmin && (
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Delete baseline ${b.name}`}
              loading={del.isPending}
              onClick={() => {
                if (confirm(`Delete the baseline ${b.name}? Its member runs are kept.`)) del.mutate();
              }}
            >
              <Trash2 className="size-3.5" aria-hidden />
            </Button>
          )}
        </div>
      </div>
      {note && !addSelected.isPending && (
        <p className="mt-1 text-xs text-ink-2" role="status">
          {note}
        </p>
      )}
      <ErrorNote error={addSelected.error ?? removeMember.error ?? del.error} />
      {b.members.length === 0 ? (
        <p className="mt-2 text-sm text-ink-3">
          No members yet. Select runs below and add them, or use “Add to baseline” on a run.
        </p>
      ) : (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <thead>
              <tr className="border-b border-rule text-left text-xs text-ink-3">
                <th className="py-1.5 pr-3 font-medium">Member</th>
                <th className="py-1.5 pr-3 font-medium">Matches</th>
                {dp && (
                  <th className="py-1.5 pr-3 text-right font-medium">
                    {dp.label}
                    {dp.unit && <span className="ml-1 font-normal">({dp.unit})</span>}
                  </th>
                )}
                <th className="py-1.5 pr-3 text-right font-medium">Ran</th>
                <th className="py-1.5">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {b.members.map((m) => (
                <tr key={m.runId} className="border-b border-rule/70 last:border-0">
                  <td className="max-w-[240px] py-1.5 pr-3">
                    <Link to={`/runs/${m.runId}`} className="font-medium text-ink hover:text-accent">
                      <span className="line-clamp-1">{m.label}</span>
                    </Link>
                  </td>
                  <td className="py-1.5 pr-3 text-ink-2">{fmtMatch(m.match)}</td>
                  {dp && (
                    <td className="py-1.5 pr-3 text-right tabular-nums text-ink">
                      {fmtValue(m.values[dp.key])}
                    </td>
                  )}
                  <td className="whitespace-nowrap py-1.5 pr-3 text-right text-xs text-ink-3">
                    {fmtDate(m.runAt)}
                  </td>
                  <td className="py-1.5 text-right">
                    <button
                      onClick={() => {
                        if (confirm(`Remove ${m.label} from ${b.name}?`)) removeMember.mutate(m.runId);
                      }}
                      className="rounded p-1 text-ink-3 hover:bg-fail-soft hover:text-fail"
                      aria-label={`Remove ${m.label} from ${b.name}`}
                      title="Remove from baseline"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </li>
  );
}

/** TypeDetail: list, create and prune the type's pinned baselines. */
export function BaselinesPanel({
  typeSlug,
  definition,
  selected,
}: {
  typeSlug: string;
  definition: TypeDefinition;
  /** Runs selected in the runs table, offered for adding to a baseline. */
  selected: Set<string>;
}) {
  const { user } = useAuth();
  const q = useBaselines(typeSlug);
  const [creating, setCreating] = useState(false);
  return (
    <Panel
      title="Baselines"
      subtitle="Pinned reference runs, shown on the charts and runs; pass/fail still uses the previous run"
      actions={
        !creating && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" aria-hidden /> New baseline
          </Button>
        )
      }
    >
      {creating && (
        <div className="mb-4">
          <NewBaselineForm
            typeSlug={typeSlug}
            definition={definition}
            onDone={() => setCreating(false)}
            onCancel={() => setCreating(false)}
          />
        </div>
      )}
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <ErrorNote error={q.error} />
      ) : !q.data?.length ? (
        !creating && (
          <Empty title="No baselines yet">
            Pin reference runs, such as a previous release or another implementation, as the numbers to beat.
            One member per combination of match parameters keeps each run compared with its own counterpart.
          </Empty>
        )
      ) : (
        <ul className="divide-y divide-rule">
          {q.data.map((b) => (
            <BaselineCard
              key={b.slug}
              b={b}
              typeSlug={typeSlug}
              definition={definition}
              selected={selected}
              isAdmin={user?.role === 'admin'}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** RunDetail: how this run compares with each applicable pinned baseline. */
export function BaselineComparisons({ run }: { run: RunDetail }) {
  if (run.baselines.length === 0) return null;
  const def = run.definition;
  return (
    <Panel
      title="Baselines"
      subtitle="Compared with the matching member of each pinned baseline (shown, not enforced)"
      bodyClass="p-0"
    >
      {run.baselines.map((c) => {
        const rows = def.dataPoints
          .map((dp) => ({ dp, p: c.points.find((x) => x.key === dp.key) }))
          .filter(({ p }) => p && (p.value !== undefined || p.baseline !== undefined));
        return (
          <section key={c.slug} className="border-b border-rule last:border-0">
            <h3 className="px-4 pt-3 text-sm text-ink-2">
              <span className="font-medium text-ink">{c.name}</span> via{' '}
              <Link to={`/runs/${c.runId}`} className="text-accent hover:underline">
                {c.label}
              </Link>
              <span className="text-ink-3">
                {' '}
                · {fmtMatch(c.match)} · {fmtDate(c.runAt)}
              </span>
            </h3>
            <div className="overflow-x-auto px-4 pb-2">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-rule text-left text-xs text-ink-3">
                    <th className="py-2 pr-3 font-medium">Data point</th>
                    <th className="py-2 pr-3 text-right font-medium">Value</th>
                    <th className="py-2 pr-3 text-right font-medium">Baseline</th>
                    <th className="py-2 pr-3 text-right font-medium">Change</th>
                    <th className="py-2 font-medium">Relative</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ dp, p }) => (
                    <tr key={dp.key} className="border-b border-rule/70 last:border-0">
                      <td className="py-1.5 pr-3 text-ink">{dp.label}</td>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums text-ink">
                        {fmtValue(p!.value, dp.unit)}
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-right tabular-nums text-ink-2">
                        {fmtValue(p!.baseline, dp.unit)}
                      </td>
                      <td className="py-1.5 pr-3 text-right">
                        <Delta pct={p!.deltaPct} improved={p!.improved} />
                      </td>
                      <td
                        className={cx(
                          'py-1.5 text-xs font-medium',
                          p!.improved === true
                            ? 'text-pass'
                            : p!.improved === false
                              ? 'text-fail'
                              : 'text-ink-2',
                        )}
                      >
                        {p!.ratio !== null ? `${fmtRatio(p!.ratio)} of ${c.name}` : '–'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </Panel>
  );
}

const NEW = '__new__';

/** RunDetail sidebar: the baselines this run is a member of, and "Add to baseline…". */
export function RunBaselineMembership({ run }: { run: RunDetail }) {
  const typeSlug = run.type.slug;
  const q = useBaselines(typeSlug);
  const refresh = useRefresh(typeSlug);
  const [pick, setPick] = useState('');
  const [note, setNote] = useState('');
  const all = q.data ?? [];
  const memberOf = all.filter((b) => b.members.some((m) => m.runId === run.id));
  const add = useMutation({
    mutationFn: (slug: string) =>
      api.post<{ added: number; replaced: number }>(`${base(typeSlug)}/${slug}/runs`, { runIds: [run.id] }),
    onSuccess: (r, slug) => {
      const b = all.find((x) => x.slug === slug);
      const match = Object.fromEntries((b?.matchKeys ?? []).map((k) => [k, run.params[k] ?? '']));
      setNote(
        r.replaced
          ? `Replaced the previous ${b?.name ?? slug} member for ${fmtMatch(match)}.`
          : `Added to ${b?.name ?? slug}.`,
      );
      setPick('');
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (slug: string) => api.del(`${base(typeSlug)}/${slug}/runs/${run.id}`),
    onSuccess: () => {
      setNote('');
      refresh();
    },
  });
  return (
    <Panel title="Baselines">
      {q.isLoading ? (
        <Spinner />
      ) : (
        <ul className="mb-3 space-y-1 text-sm">
          {memberOf.map((b) => (
            <li key={b.slug} className="flex items-center justify-between gap-2">
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <Pin className="size-3.5 shrink-0 text-accent" aria-hidden />
                <Link to={`/types/${typeSlug}`} className="truncate text-accent hover:underline">
                  {b.name}
                </Link>
              </span>
              <button
                onClick={() => remove.mutate(b.slug)}
                className="rounded p-1 text-ink-3 hover:bg-fail-soft hover:text-fail"
                aria-label={`Remove this run from ${b.name}`}
                title="Remove from baseline"
              >
                <X className="size-3.5" aria-hidden />
              </button>
            </li>
          ))}
          {memberOf.length === 0 && <li className="text-ink-3">Not a member of any baseline.</li>}
        </ul>
      )}
      {pick === NEW ? (
        <NewBaselineForm
          typeSlug={typeSlug}
          definition={run.definition}
          runIds={[run.id]}
          runParams={run.params}
          compact
          onDone={() => {
            setPick('');
            setNote('Baseline created with this run.');
          }}
          onCancel={() => setPick('')}
        />
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (pick) add.mutate(pick);
          }}
        >
          <label className="flex-1">
            <span className="sr-only">Baseline</span>
            <Select
              value={pick}
              onChange={(e) => {
                setPick(e.target.value);
                setNote('');
                add.reset();
              }}
            >
              <option value="">Add to baseline…</option>
              {all
                .filter((b) => !memberOf.includes(b))
                .map((b) => (
                  <option key={b.slug} value={b.slug}>
                    {b.name}
                  </option>
                ))}
              <option value={NEW}>New baseline…</option>
            </Select>
          </label>
          <Button type="submit" disabled={!pick} loading={add.isPending}>
            Add
          </Button>
        </form>
      )}
      {note && (
        <p className="mt-2 text-xs text-ink-2" role="status">
          {note}
        </p>
      )}
      <div className="mt-2 space-y-2">
        <ErrorNote error={q.error ?? add.error ?? remove.error} />
      </div>
    </Panel>
  );
}
