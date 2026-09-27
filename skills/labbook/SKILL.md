---
name: labbook
description: Record, read and judge test results in labbook (the lab book at labbook.kw.watteel.lab) through the labbook MCP tools. Use when defining a kind of test, submitting a run (benchmarks, GPU/LLM serving, storage IOPS, network throughput, soak or correctness suites), attaching logs, pinning reference baselines (e.g. vLLM, the last release, the old hardware), setting target zones, grouping runs into sets, or answering "how did X do / did it regress / are we on target".
---

# labbook

labbook stores **runs** of **test types**. It is domain-neutral: a test type is just
parameters (what was tested, on what) and data points (what was measured). GPU
serving benchmarks, `fio` IOPS, `iperf3` throughput and pass/fail suites all fit.

All access goes through the `labbook` MCP server, whose tools are generated from the
live OpenAPI spec (`/api/docs/json`, browsable at `/api/docs`). Tool names are the
operationIds in snake_case: `upsert_test_type`, `submit_run`, `get_run`, `list_runs`…
If a tool you expect is missing, call `refresh_spec`. Credentials (users, API tokens,
passwords) are deliberately not exposed: people manage them in the GUI.

## Concepts

- **Test type** (`upsert_test_type`, PUT, idempotent): `definition.parameters` and
  `definition.dataPoints`. A changed definition becomes a new version; runs keep theirs.
  A data point cannot change its value type — add a new key instead.
- **Identity parameters** decide which runs are comparable (`identity: true`, the
  default): e.g. `device` + `controller` for fio, `link` for iperf, `model` + `gpu` +
  `engine` for LLM serving. Free-form ones (`commit`, `label`) set `identity: false`.
- **Bounds** on a data point decide **pass/fail**: `min`/`max` absolute, `relMin`/`relMax`
  vs the _previous comparable run_, `expected` for booleans/strings. Without a `status`,
  a run's status is computed from them.
- **Pinned baselines** (`upsert_baseline`, `add_baseline_runs`): a named reference per
  test type — "vLLM-ROCm 0.23.0", "release 1.4", "old controller" — with one member run
  per combination of its `matchKeys` (e.g. `["model"]` → one member per model;
  `["device"]` → one per device). Every run is compared with the member whose params
  match. Shown in `get_run` → `baselines[]` (ratio 1.03 = 103% of the baseline). They
  never change pass/fail. Adding a run whose match equals an existing member **replaces**
  that member (how a sub-baseline is refreshed).
- **Target zones** (`dataPoints[].targets`): what counts as _good_, graded on/below
  target (`target` on each run, `targets[]` on `get_run`), never changing pass/fail.
  - `{ "ref": "baseline", "baseline": "vllm-rocm-0-23", "min": 0.75 }` — at least 75% of vLLM
  - `{ "ref": "best", "min": 0.97 }` — within 3% of the best earlier comparable run
  - `{ "ref": "absolute", "max": 10 }` — at most 10 (in the data point's unit)
- **Sets** group runs across types (a campaign, a PR, a phase) with a written conclusion.

## Recording results

1. `get_test_type` (or `list_test_types`) first; define/extend with `upsert_test_type`
   only if the type is missing or lacks a key you need.
2. `submit_run` with a stable **`externalId`** (e.g. `<commit>:<config>:<attempt>`), so a
   retry updates instead of duplicating. Put conditions in `params`, measurements in
   `values`, prose in `notes`, and the verdict in words in `conclusion`. Many runs at
   once: `submit_runs`.
3. Attach raw output: text/binary with `put_attachment` (`content` or `contentBase64`),
   or inline in `submit_run.attachments` for small files.
4. Group with `sets: ["<slug>"]` on submit (created if missing) or `add_set_runs`.

Example — a network test:

```json
upsert_test_type { "slug": "iperf", "body": {
  "name": "iperf3 throughput",
  "definition": {
    "parameters": [{ "key": "link" }, { "key": "mtu" }, { "key": "commit", "identity": false }],
    "dataPoints": [
      { "key": "gbps", "unit": "Gbit/s", "better": "higher", "bounds": { "relMin": 0.95 },
        "targets": [{ "ref": "best", "min": 0.97 }] },
      { "key": "retransmits", "better": "lower", "targets": [{ "ref": "absolute", "max": 10 }] }
    ] } } }

submit_run { "body": { "type": "iperf", "externalId": "a1b2c3d:25g:1",
  "params": { "link": "25g", "mtu": "9000", "commit": "a1b2c3d" },
  "values": { "gbps": 23.4, "retransmits": 3 },
  "conclusion": "Within 1% of the best 25G run." } }
```

Example — pin a reference and a target for storage:

```json
upsert_baseline { "slug": "fio-randread", "baseline": "old-controller",
  "body": { "name": "Old controller", "matchKeys": ["device"],
            "externalIds": ["old-nvme", "old-sata"] } }
```

and add `"targets": [{ "ref": "baseline", "baseline": "old-controller", "min": 0.75 }]` to
the `iops` data point.

## Reading and judging

- Overview: `get_dashboard` (counts, recent, failing, regressions).
- Query: `list_runs` with `type`, `set`, `status` (`fail,error`), `from`/`to`, `q` (text
  search) and `params: {"model": "llama"}` for parameter filters. `total` is the match
  count before `limit`.
- One run: `get_run` — `evaluation` (bounds vs previous comparable run), `baselines[]`
  (vs pinned references), `targets[]` (zones), attachments, full edit history.
- Side by side: `compare_runs` with 1–12 ids. Bulk: `export_runs` (`format: csv|json`).
- Report the three judgements separately and do not blur them: **status** (pass/fail —
  correctness and regressions), **baselines** (% of each reference), **target** (on or
  below the agreed zone).

## Care

- Prefer `upsert_*`/PUT and `externalId` over create calls: everything is safe to retry.
- Edits (`update_run`, `update_set`) are logged with the old value; still, don't rewrite
  someone's notes or conclusion unless asked.
- Deletes (`delete_run`, `delete_test_type`, `delete_set`, `delete_baseline`) are admin
  only and permanent — confirm with the user first.
