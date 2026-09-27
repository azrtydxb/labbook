# labbook

Version 0.1.0.

A lab book for test results. Define a **test type** once (its parameters, data points and pass
bounds), then upload **runs** again and again from scripts, with notes and conclusions. Group runs
into **sets**, chart every data point over time, compare runs side by side, and keep the raw logs
attached to the run they came from.

Deployed at **https://labbook.kw.watteel.lab** (kw cluster, namespace `labbook`).

- Stack: Node 22 + TypeScript, Fastify 5, zod 4, Kysely + Postgres (CNPG), React 19 + Vite +
  Tailwind 4 + Recharts, one container image.
- API docs (OpenAPI, interactive): https://labbook.kw.watteel.lab/api/docs
  (raw spec: `/api/docs/json`).

## Concepts

| Concept       | What it holds                                                                                                                                                                                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Test type** | Name, description, tags and a versioned schema: **parameters** (e.g. model, gpu, commit; _identity_ parameters decide which runs are comparable) and **data points** (key, label, unit, number/boolean/string, better = higher/lower/none, optional bounds `min`/`max`, `relMin`/`relMax` × baseline, or `expected` for booleans/strings). |
| **Run**       | One submission: type + schema version, time, source, parameter values, data point values, status (pass/fail/error/info; computed from the bounds when omitted), markdown notes and conclusion with edit history, links (commit, branch, CI URL), attachments.                                                                              |
| **Set**       | A named group of runs (a run can be in several) with a description and a conclusion, e.g. "Phase 4 KV tiers".                                                                                                                                                                                                                              |
| **Baseline**  | For a run, the previous run of the same type with equal identity parameters. Relative bounds and deltas use it. In a set you can also pick a set baseline.                                                                                                                                                                                 |

Schema changes create a new version; old runs keep theirs. A data point may be added, removed or
relabelled, but it cannot change value type (use a new key).

`externalId` makes uploads idempotent: submitting the same `(type, externalId)` again updates the
run in place and logs every changed field. `preserveText: true` keeps notes and conclusions that
were edited in the GUI since.

Attachments are stored in Postgres (`bytea`, 25 MiB per file by default). One store means one
backup covers runs and their logs together, and they stay transactional with the run. The shared
MinIO on kw is the sccache store, with no backup and its credentials in another namespace.

## Authentication

- **Web GUI**: local users (Argon2id password hashes), httpOnly `SameSite=Lax` session cookie;
  writes also need the `x-requested-with: labbook` header (the GUI sends it).
- **Scripts and agents**: per-user API tokens, created and revoked under **Admin → API tokens**.
  Only the SHA-256 of a token is stored. Send `Authorization: Bearer lbk_…`.
- The first admin is seeded from the Kubernetes Secret `labbook-admin` (keys `username`,
  `password`) when the users table is empty; afterwards the Secret is ignored, so change the
  password in the GUI (**Admin → Your account**). Read it with:

  ```bash
  kubectl --context kw -n labbook get secret labbook-admin -o jsonpath='{.data.password}' | base64 -d; echo
  ```

## Uploading results

### TLS

The certificate is signed by the kw cluster CA. Browsers that trust it are fine; for scripts:

```bash
mkdir -p ~/.labbook
curl -sk -o ~/.labbook/cluster-ca.crt https://192.168.10.131:8443/repository/public/cluster-ca.crt
export NODE_EXTRA_CA_CERTS=~/.labbook/cluster-ca.crt   # for labbook-submit (Node)
# curl: add --cacert ~/.labbook/cluster-ca.crt
```

### labbook-submit (zero dependencies, Node ≥ 18)

`client/labbook-submit.mjs` is a single file; download it from the running instance with
`curl -fsSO --cacert ~/.labbook/cluster-ca.crt https://labbook.kw.watteel.lab/labbook-submit.mjs`.

```bash
export LABBOOK_URL=https://labbook.kw.watteel.lab
# the token: --token-file <file>, $LABBOOK_TOKEN_FILE, $LABBOOK_TOKEN, or ~/.config/labbook/token (chmod 600)

node labbook-submit.mjs run --type turbine-lab-bench \
  --external-id "lab-bench:$label-$model:$commit" \
  --param model=llama-3.2-3b-instruct --param gpu="R9700 GPU0" --param config=phase2c \
  --param engine=turbine --param commit="$commit" --param label="$label" \
  --value tok_s=761.4 --value itl_p50_ms=17.8 --value ttft_p50_ms=197 --value decode_fwd_ms=16.9 \
  --value golden_c1=true --value golden_c16=true \
  --commit "$commit" --branch "$(git branch --show-current)" \
  --set phase-4-kv-tiers --notes-file notes.md \
  --attach "$out/bench.json" --attach "$out/golden1.txt" --attach "$out/metrics.txt"
```

It prints `{"id":…,"created":true,"status":"pass","url":…}` and exits `0`, `1` when the server
refused (the reason is printed), or `2` on a usage error. Other commands: `define --type <slug>
--file type.json`, `json <file>` (a raw run payload or `{"runs":[…]}`), `attach --run <id>
<file>…`, `get <api-path>`. Run it without arguments for the full usage.

### curl

```bash
H="Authorization: Bearer $LABBOOK_TOKEN"; CA="--cacert $HOME/.labbook/cluster-ca.crt"

# Define (or update) a test type: idempotent; a changed schema becomes a new version.
curl -fsS $CA -H "$H" -H 'content-type: application/json' -X PUT \
  $LABBOOK_URL/api/v1/test-types/my-bench -d '{
    "name": "My bench", "tags": ["perf"],
    "definition": {
      "parameters": [{"key":"model"}, {"key":"commit","identity":false}],
      "dataPoints": [
        {"key":"tok_s","label":"Throughput","unit":"tok/s","better":"higher","bounds":{"relMin":0.97}},
        {"key":"golden","type":"boolean","bounds":{"expected":true}}
      ]}}'

# Submit a run (same externalId again = update, not a duplicate).
curl -fsS $CA -H "$H" -H 'content-type: application/json' $LABBOOK_URL/api/v1/runs -d '{
  "type": "my-bench", "externalId": "run-42",
  "params": {"model": "llama", "commit": "abc1234"},
  "values": {"tok_s": 770.1, "golden": true},
  "links": {"commit": "abc1234"}, "sets": ["nightly"],
  "notes": "Run on GPU 0.",
  "attachments": [{"filename": "summary.txt", "content": "ok"}]
}'

# Attach a file as the raw body (same filename replaces).
curl -fsS $CA -H "$H" -H 'content-type: application/json' -X PUT \
  --data-binary @bench.json $LABBOOK_URL/api/v1/runs/<run-id>/attachments/bench.json

# Batch: {"runs": [...]} → per-item results; export as CSV or JSON.
curl -fsS $CA -H "$H" "$LABBOOK_URL/api/v1/export?type=my-bench&param.model=llama&format=csv"
```

### API overview

| Method and path                                                                                                               | Purpose                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /api/v1/test-types`, `GET/PUT/DELETE /api/v1/test-types/{slug}`, `GET …/versions/{v}`                               | define and update test types                                                                                              |
| `POST /api/v1/runs`, `POST /api/v1/runs/batch`                                                                                | submit runs (upsert by `externalId`)                                                                                      |
| `GET /api/v1/runs?type=&set=&status=&q=&from=&to=&param.<k>=<v>`                                                              | query runs                                                                                                                |
| `GET/PATCH/DELETE /api/v1/runs/{id}`                                                                                          | run detail with evaluation, baseline, attachments and edit history; edit notes, conclusion, status, links, params, values |
| `POST /api/v1/runs/{id}/attachments` (multipart), `PUT …/attachments/{filename}` (raw), `GET/DELETE /api/v1/attachments/{id}` | attachments                                                                                                               |
| `GET/POST /api/v1/sets`, `GET/PUT/PATCH/DELETE /api/v1/sets/{slug}`, `POST …/runs`, `DELETE …/runs/{runId}`                   | sets, their conclusion and baseline, membership                                                                           |
| `GET /api/v1/export?format=csv\|json&…`                                                                                       | export with the run filters                                                                                               |
| `GET /api/v1/compare?ids=a,b,c`                                                                                               | runs with their schema versions, for side-by-side comparison                                                              |
| `GET /api/v1/dashboard`                                                                                                       | counts, latest and failing runs, regressions                                                                              |
| `POST /api/v1/auth/login\|logout\|password`, `GET /api/v1/auth/me`, `/api/v1/users`, `/api/v1/tokens`                         | sessions, users (admin), API tokens                                                                                       |

## Turbine

`importers/turbine/types.mjs` defines `turbine-lab-bench`, `turbine-golden`, `turbine-lab-test`,
`turbine-multi-turn`, `turbine-pinned-bandwidth` and `turbine-overload-soak`.
`importers/turbine/backfill.mjs` imports `.procoder/perf-log.md` and `target/lab-bench/*/`
(read-only) with stable external ids, so it can run again at any time:

```bash
LABBOOK_URL=… LABBOOK_TOKEN=… node importers/turbine/backfill.mjs --turbine ~/Development/Turbine [--dry-run]
```

## Development

Builds and tests run on the cluster, not on a laptop:

- **CI** (`.github/workflows/ci.yml`, `azrtydxb` org runners): `arc-azrtydxb` runs format check,
  ESLint, typecheck, Vitest (with a Postgres service; the API suite needs `DATABASE_URL`) and the
  build; `arc-azrtydxb-publish` builds the arm64 image and pushes
  `192.168.10.131:5000/azrtydxb/labbook:sha-<short>` (and `:main`). The run summary prints the
  digest.
- **Inner loop**: `~/Development/internal-lab/scripts/dev-build.sh` from this directory builds on
  the kw BuildKit and pushes a `dev-<user>-<sha>` tag.

Scripts: `npm run build | typecheck | lint | test | format`.

## Deploy (kw)

```bash
# once: the admin Secret (random password, never committed)
kubectl --context kw create namespace labbook
kubectl --context kw -n labbook create secret generic labbook-admin \
  --from-literal=username=admin --from-literal=password="$(openssl rand -base64 30 | tr -d '/+=\n' | cut -c1-28)"

# every release: put the digest from the CI summary into deploy/kw/kustomization.yaml, then
kubectl --context kw apply -k deploy/kw
kubectl --context kw -n labbook rollout status deploy/labbook
```

`*.kw.watteel.lab` already resolves to the ingress-nginx LoadBalancer (192.168.10.120), so no DNS
change is needed; cert-manager's `cluster-ca` issues `labbook-tls`.

## Backups

Two independent layers, both landing on the NAS:

1. **Longhorn**: the CNPG volumes (`longhorn-single`, two instances on different nodes) carry
   `recurring-job-group.longhorn.io/critical=enabled`, so kw's existing `backup-daily` recurring
   job (03:00, 7 kept) backs them up to `nfs://192.168.10.253:/mnt/Pool0/Backup/longhorn-kw`.
2. **pg_dump**: CronJob `labbook-pg-dump` writes `pg_dump -Fc` every 6 hours to the PVC
   `labbook-dumps` (TrueNAS NFS, PV reclaim policy `Retain`), 30 days kept.

Restore a dump:

```bash
kubectl --context kw -n labbook run restore --rm -it --image=ghcr.io/cloudnative-pg/postgresql:17.6 \
  --overrides='{"spec":{"volumes":[{"name":"d","persistentVolumeClaim":{"claimName":"labbook-dumps"}}],
  "containers":[{"name":"restore","image":"ghcr.io/cloudnative-pg/postgresql:17.6","stdin":true,"tty":true,
  "command":["sh"],"volumeMounts":[{"name":"d","mountPath":"/dumps"}]}]}}'
# inside: ls /dumps; PGPASSWORD=… pg_restore --clean --if-exists -h labbook-db-rw -U labbook -d labbook /dumps/<file>
```
