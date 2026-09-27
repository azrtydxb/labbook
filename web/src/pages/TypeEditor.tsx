import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  Button,
  ErrorNote,
  Input,
  Label,
  PageHeader,
  Panel,
  Select,
  Spinner,
  Textarea,
  cx,
} from '../components/ui';
import { api } from '../lib/api';
import type { DataPointDef, ParameterDef, TypeDefinition, TypeDetail } from '../lib/types';

interface DpRow {
  key: string;
  label: string;
  unit: string;
  type: DataPointDef['type'];
  better: DataPointDef['better'];
  description: string;
  min: string;
  max: string;
  relMin: string;
  relMax: string;
  expected: string;
}

const emptyDp = (): DpRow => ({
  key: '',
  label: '',
  unit: '',
  type: 'number',
  better: 'none',
  description: '',
  min: '',
  max: '',
  relMin: '',
  relMax: '',
  expected: '',
});

function toRows(def: TypeDefinition): { params: ParameterDef[]; dps: DpRow[] } {
  return {
    params: def.parameters.map((p) => ({ ...p })),
    dps: def.dataPoints.map((d) => ({
      key: d.key,
      label: d.label === d.key ? '' : d.label,
      unit: d.unit,
      type: d.type,
      better: d.better,
      description: d.description,
      min: d.bounds?.min?.toString() ?? '',
      max: d.bounds?.max?.toString() ?? '',
      relMin: d.bounds?.relMin?.toString() ?? '',
      relMax: d.bounds?.relMax?.toString() ?? '',
      expected: d.bounds?.expected === undefined ? '' : String(d.bounds.expected),
    })),
  };
}

function toDefinition(params: ParameterDef[], dps: DpRow[], primary: string): TypeDefinition {
  const num = (s: string) => (s.trim() === '' ? undefined : Number(s));
  return {
    parameters: params
      .filter((p) => p.key.trim())
      .map((p) => ({ ...p, key: p.key.trim(), label: p.label || p.key.trim() })),
    dataPoints: dps
      .filter((d) => d.key.trim())
      .map((d) => {
        const bounds: Record<string, unknown> = {};
        if (d.type === 'number') {
          for (const k of ['min', 'max', 'relMin', 'relMax'] as const) {
            const v = num(d[k]);
            if (v !== undefined) bounds[k] = v;
          }
        } else if (d.expected !== '') {
          bounds.expected = d.type === 'boolean' ? d.expected === 'true' : d.expected;
        }
        return {
          key: d.key.trim(),
          label: d.label || d.key.trim(),
          unit: d.unit,
          type: d.type,
          better: d.better,
          description: d.description,
          ...(Object.keys(bounds).length ? { bounds } : {}),
        } as DataPointDef;
      }),
    ...(primary ? { primary } : {}),
  };
}

export function TypeEditorPage() {
  const { slug: editSlug } = useParams();
  const isNew = !editSlug;
  const navigate = useNavigate();
  const qc = useQueryClient();
  const existing = useQuery({
    queryKey: ['type', editSlug],
    queryFn: () => api.get<TypeDetail>(`/api/v1/test-types/${editSlug}`),
    enabled: !isNew,
  });
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [note, setNote] = useState('');
  const [primary, setPrimary] = useState('');
  const [params, setParams] = useState<ParameterDef[]>([
    { key: '', label: '', description: '', identity: true },
  ]);
  const [dps, setDps] = useState<DpRow[]>([emptyDp()]);
  const [jsonMode, setJsonMode] = useState(false);
  const [json, setJson] = useState('');

  useEffect(() => {
    const t = existing.data;
    if (!t) return;
    setSlug(t.slug);
    setName(t.name);
    setDescription(t.description);
    setTags(t.tags.join(', '));
    setPrimary(t.definition.primary ?? '');
    const rows = toRows(t.definition);
    setParams(rows.params);
    setDps(rows.dps);
  }, [existing.data]);

  const save = useMutation({
    mutationFn: async () => {
      const definition = jsonMode ? (JSON.parse(json) as TypeDefinition) : toDefinition(params, dps, primary);
      const body = {
        name,
        description,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        definition,
        ...(note ? { note } : {}),
      };
      return api.put<{ slug: string; version: number; versionCreated: boolean }>(
        `/api/v1/test-types/${slug}`,
        body,
      );
    },
    onSuccess: (r) => {
      void qc.invalidateQueries();
      navigate(`/types/${r.slug}`);
    },
  });

  if (!isNew && existing.isLoading) return <Spinner />;
  if (existing.error) return <ErrorNote error={existing.error} />;

  const setDp = (i: number, patch: Partial<DpRow>) =>
    setDps((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setParam = (i: number, patch: Partial<ParameterDef>) =>
    setParams((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="space-y-6">
      <PageHeader
        kicker={
          isNew ? (
            <Link to="/types" className="hover:text-accent">
              Test types
            </Link>
          ) : (
            <Link to={`/types/${editSlug}`} className="hover:text-accent">
              {existing.data?.name}
            </Link>
          )
        }
        title={isNew ? 'New test type' : 'Edit schema'}
      >
        {isNew
          ? 'Name the parameters that identify a run and the data points it measures.'
          : `Saving a changed schema creates v${(existing.data?.version ?? 0) + 1}. Runs keep the version they were recorded under; an existing data point cannot change its value type.`}
      </PageHeader>

      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Panel title="About">
          <div className="grid gap-4 md:grid-cols-2">
            <label>
              <Label hint="lowercase, used in the API and URLs">Slug</Label>
              <Input
                value={slug}
                onChange={(e) => setSlug(e.target.value.toLowerCase())}
                disabled={!isNew}
                required
                pattern="[a-z0-9][a-z0-9._\-]*"
                placeholder="turbine-lab-bench"
              />
            </label>
            <label>
              <Label>Name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="Turbine lab bench"
              />
            </label>
            <label className="md:col-span-2">
              <Label hint="markdown">Description</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
            </label>
            <label>
              <Label hint="comma separated">Tags</Label>
              <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="perf, gpu" />
            </label>
            {!isNew && (
              <label>
                <Label hint="kept with the new version">Change note</Label>
                <Input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="added decode_fwd_ms"
                />
              </label>
            )}
          </div>
        </Panel>

        <div className="flex justify-end">
          <button
            type="button"
            className="text-sm text-accent hover:underline"
            onClick={() => {
              if (!jsonMode) setJson(JSON.stringify(toDefinition(params, dps, primary), null, 2));
              else {
                try {
                  const def = JSON.parse(json) as TypeDefinition;
                  const rows = toRows({
                    parameters: def.parameters ?? [],
                    dataPoints: def.dataPoints ?? [],
                    primary: def.primary,
                  });
                  setParams(rows.params);
                  setDps(rows.dps);
                  setPrimary(def.primary ?? '');
                } catch {
                  /* keep the form as it was */
                }
              }
              setJsonMode((m) => !m);
            }}
          >
            {jsonMode ? 'Edit with the form' : 'Edit the definition as JSON'}
          </button>
        </div>

        {jsonMode ? (
          <Panel title="Definition (JSON)">
            <Textarea
              value={json}
              onChange={(e) => setJson(e.target.value)}
              rows={24}
              aria-label="Definition JSON"
            />
          </Panel>
        ) : (
          <>
            <Panel
              title="Parameters"
              subtitle="Identity parameters decide which runs are comparable (e.g. model, gpu); the others (commit, label) may differ between comparable runs."
              actions={
                <Button
                  type="button"
                  size="sm"
                  onClick={() =>
                    setParams((p) => [...p, { key: '', label: '', description: '', identity: false }])
                  }
                >
                  <Plus className="size-3.5" aria-hidden /> Parameter
                </Button>
              }
            >
              <div className="space-y-2">
                {params.map((p, i) => (
                  <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_2fr_auto_auto]">
                    <label>
                      <Label>Key</Label>
                      <Input
                        value={p.key}
                        onChange={(e) => setParam(i, { key: e.target.value })}
                        placeholder="model"
                      />
                    </label>
                    <label>
                      <Label>Label</Label>
                      <Input
                        value={p.label}
                        onChange={(e) => setParam(i, { label: e.target.value })}
                        placeholder="Model"
                      />
                    </label>
                    <label>
                      <Label>Description</Label>
                      <Input
                        value={p.description}
                        onChange={(e) => setParam(i, { description: e.target.value })}
                      />
                    </label>
                    <label className="flex h-9 items-center gap-2 text-sm text-ink-2">
                      <input
                        type="checkbox"
                        checked={p.identity}
                        onChange={(e) => setParam(i, { identity: e.target.checked })}
                        className="size-4 accent-[var(--accent)]"
                      />
                      Identity
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={`Remove parameter ${p.key}`}
                      onClick={() => setParams((rows) => rows.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel
              title="Data points"
              subtitle="Relative bounds are fractions of the previous comparable run: relMin 0.97 fails a drop of more than 3%."
              actions={
                <Button type="button" size="sm" onClick={() => setDps((d) => [...d, emptyDp()])}>
                  <Plus className="size-3.5" aria-hidden /> Data point
                </Button>
              }
            >
              <label className="mb-4 block w-72">
                <Label hint="drives sparklines and regressions">Headline data point</Label>
                <Select value={primary} onChange={(e) => setPrimary(e.target.value)}>
                  <option value="">First number</option>
                  {dps
                    .filter((d) => d.key)
                    .map((d) => (
                      <option key={d.key} value={d.key}>
                        {d.label || d.key}
                      </option>
                    ))}
                </Select>
              </label>
              <div className="space-y-3">
                {dps.map((d, i) => (
                  <fieldset key={i} className={cx('rounded-lg border border-rule p-3')}>
                    <legend className="sr-only">Data point {d.key || i + 1}</legend>
                    <div className="grid items-end gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_110px_120px_120px_auto]">
                      <label>
                        <Label>Key</Label>
                        <Input
                          value={d.key}
                          onChange={(e) => setDp(i, { key: e.target.value })}
                          placeholder="tok_s"
                        />
                      </label>
                      <label>
                        <Label>Label</Label>
                        <Input
                          value={d.label}
                          onChange={(e) => setDp(i, { label: e.target.value })}
                          placeholder="Throughput"
                        />
                      </label>
                      <label>
                        <Label>Unit</Label>
                        <Input
                          value={d.unit}
                          onChange={(e) => setDp(i, { unit: e.target.value })}
                          placeholder="tok/s"
                        />
                      </label>
                      <label>
                        <Label>Value type</Label>
                        <Select
                          value={d.type}
                          onChange={(e) => setDp(i, { type: e.target.value as DpRow['type'] })}
                        >
                          <option value="number">Number</option>
                          <option value="boolean">Boolean</option>
                          <option value="string">Text</option>
                        </Select>
                      </label>
                      <label>
                        <Label>Better</Label>
                        <Select
                          value={d.better}
                          onChange={(e) => setDp(i, { better: e.target.value as DpRow['better'] })}
                        >
                          <option value="higher">Higher</option>
                          <option value="lower">Lower</option>
                          <option value="none">Neither</option>
                        </Select>
                      </label>
                      <Button
                        type="button"
                        variant="ghost"
                        aria-label={`Remove data point ${d.key}`}
                        onClick={() => setDps((rows) => rows.filter((_, j) => j !== i))}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </div>
                    <div className="mt-2 grid items-end gap-2 sm:grid-cols-4">
                      {d.type === 'number' ? (
                        (['min', 'max', 'relMin', 'relMax'] as const).map((k) => (
                          <label key={k}>
                            <Label hint={k.startsWith('rel') ? '× baseline' : 'absolute'}>{k}</Label>
                            <Input
                              inputMode="decimal"
                              value={d[k]}
                              onChange={(e) => setDp(i, { [k]: e.target.value })}
                            />
                          </label>
                        ))
                      ) : (
                        <label>
                          <Label>Expected value</Label>
                          {d.type === 'boolean' ? (
                            <Select
                              value={d.expected}
                              onChange={(e) => setDp(i, { expected: e.target.value })}
                            >
                              <option value="">No expectation</option>
                              <option value="true">true</option>
                              <option value="false">false</option>
                            </Select>
                          ) : (
                            <Input
                              value={d.expected}
                              onChange={(e) => setDp(i, { expected: e.target.value })}
                            />
                          )}
                        </label>
                      )}
                    </div>
                  </fieldset>
                ))}
              </div>
            </Panel>
          </>
        )}
        <ErrorNote error={save.error} />
        <div className="flex gap-2">
          <Button type="submit" variant="primary" loading={save.isPending}>
            {isNew ? 'Create test type' : 'Save schema'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => navigate(-1)}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
