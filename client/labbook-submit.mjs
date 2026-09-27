#!/usr/bin/env node
// labbook-submit: upload test runs to labbook from scripts. Zero dependencies, Node >= 18.
//
//   export LABBOOK_URL=https://labbook.kw.watteel.lab
//   export LABBOOK_TOKEN=lbk_...            # Admin → API tokens
//   export NODE_EXTRA_CA_CERTS=~/.labbook/cluster-ca.crt   # the kw cluster CA
//
//   labbook-submit run --type turbine-lab-bench --external-id c3-p4land-llama \
//     --param model=llama-3.2-3b-instruct --param gpu="R9700 GPU0" --param commit=1c4f92e \
//     --value tok_s=761.4 --value ttft_p50_ms=197 --value golden_c1=true \
//     --set phase-4-kv-tiers --commit 1c4f92e --notes-file notes.md --attach target/lab-bench/x/bench.json
//
//   labbook-submit define --type turbine-lab-bench --file type.json   # {name, description, tags, definition}
//   labbook-submit json run.json                                       # a raw run payload, or {"runs": [...]}
//   labbook-submit attach --run <run-id> file...
//   labbook-submit get <api-path>                                      # e.g. /api/v1/runs?type=turbine-golden
//
// Exit codes: 0 ok, 1 the server refused or failed, 2 usage error.

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const HELP = `usage:
  labbook-submit run --type <slug> [options]
      --external-id <id>        idempotency key: re-submitting updates the same run
      --param k=v               repeatable; parameters (model, gpu, commit, ...)
      --value k=v               repeatable; numbers and true/false are typed, the rest is text
      --value-str k=v           repeatable; always text
      --values-json <file>      a JSON object of values, merged with --value
      --status pass|fail|error|info   default: computed from the type's bounds
      --notes <md> | --notes-file <file>
      --conclusion <md> | --conclusion-file <file>
      --commit <sha> --branch <name> --ci-url <url>
      --set <slug>              repeatable; the set is created if missing
      --attach <file>           repeatable; uploaded after the run (same name replaces)
      --source <text>           default: user@host
      --run-at <iso-8601>       default: now
      --type-version <n>        default: the type's current version
      --preserve-text           when the run exists, keep its notes and conclusion
  labbook-submit define --type <slug> --file <type.json>
  labbook-submit json <file.json>
  labbook-submit attach --run <run-id> <file>...
  labbook-submit get <api-path>

env: LABBOOK_URL, LABBOOK_TOKEN (required); NODE_EXTRA_CA_CERTS for the cluster CA.
     --insecure skips TLS verification (last resort).`;

function die(msg, code = 2) {
  process.stderr.write(`labbook-submit: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { _: [], multi: {} };
  const multi = new Set(['param', 'value', 'value-str', 'set', 'attach']);
  const flags = new Set(['preserve-text', 'insecure', 'help', 'quiet']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      opts._.push(a);
      continue;
    }
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq > 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (flags.has(key)) {
      opts[key] = true;
      continue;
    }
    if (val === undefined) {
      val = argv[++i];
      if (val === undefined) die(`--${key} needs a value`);
    }
    if (multi.has(key)) (opts.multi[key] ??= []).push(val);
    else opts[key] = val;
  }
  return opts;
}

function kv(s, typed) {
  const i = s.indexOf('=');
  if (i <= 0) die(`expected key=value, got '${s}'`);
  const k = s.slice(0, i);
  const raw = s.slice(i + 1);
  if (!typed) return [k, raw];
  if (raw === 'true') return [k, true];
  if (raw === 'false') return [k, false];
  if (raw === 'null' || raw === '') return [k, null];
  const n = Number(raw);
  if (raw.trim() !== '' && Number.isFinite(n)) return [k, n];
  return [k, raw];
}

function config(opts) {
  const url = (process.env.LABBOOK_URL || '').replace(/\/+$/, '');
  const token = process.env.LABBOOK_TOKEN || '';
  if (!url) die('set LABBOOK_URL (e.g. https://labbook.kw.watteel.lab)');
  if (!token) die('set LABBOOK_TOKEN (create one under Admin → API tokens)');
  if (opts.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  return { url, token };
}

async function call(cfg, method, path, body, contentType) {
  const headers = { authorization: `Bearer ${cfg.token}` };
  let payload;
  if (Buffer.isBuffer(body)) {
    payload = body;
    headers['content-type'] = contentType || 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(`${cfg.url}${path}`, { method, headers, body: payload });
  } catch (e) {
    const cause = e && e.cause ? ` (${e.cause.code || e.cause.message})` : '';
    die(`cannot reach ${cfg.url}: ${e.message}${cause}. For a certificate error set NODE_EXTRA_CA_CERTS.`, 1);
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const detail = data && typeof data === 'object' ? JSON.stringify(data) : text;
    die(`${method} ${path} → HTTP ${res.status}: ${detail}`, 1);
  }
  return data;
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    die(`cannot read ${file}: ${e.message}`);
  }
}

async function attach(cfg, runId, files, quiet) {
  for (const f of files) {
    let st;
    try {
      st = statSync(f);
    } catch {
      die(`no such file: ${f}`);
    }
    if (!st.isFile()) die(`not a file: ${f}`);
    const data = readFileSync(f);
    await call(cfg, 'PUT', `/api/v1/runs/${runId}/attachments/${encodeURIComponent(basename(f))}`, data);
    if (!quiet) process.stderr.write(`attached ${basename(f)} (${data.length} bytes)\n`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(`${HELP}\n`);
    process.exit(cmd ? 0 : 2);
  }
  const opts = parseArgs(rest);
  if (opts.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const cfg = config(opts);

  if (cmd === 'run') {
    if (!opts.type) die('run needs --type <slug>');
    const values = opts['values-json'] ? JSON.parse(readText(opts['values-json'])) : {};
    for (const s of opts.multi.value ?? []) {
      const [k, v] = kv(s, true);
      values[k] = v;
    }
    for (const s of opts.multi['value-str'] ?? []) {
      const [k, v] = kv(s, false);
      values[k] = v;
    }
    const params = {};
    for (const s of opts.multi.param ?? []) {
      const [k, v] = kv(s, false);
      params[k] = v;
    }
    const links = {};
    if (opts.commit) links.commit = opts.commit;
    if (opts.branch) links.branch = opts.branch;
    if (opts['ci-url']) links.ciUrl = opts['ci-url'];
    const user = process.env.USER || process.env.USERNAME || 'script';
    const host = process.env.HOSTNAME || (await import('node:os')).hostname();
    const body = {
      type: opts.type,
      params,
      values,
      source: opts.source ?? `${user}@${host}`,
      ...(opts['external-id'] ? { externalId: opts['external-id'] } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts['run-at'] ? { runAt: opts['run-at'] } : {}),
      ...(opts['type-version'] ? { typeVersion: Number(opts['type-version']) } : {}),
      ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
      ...(opts['notes-file'] ? { notes: readText(opts['notes-file']) } : {}),
      ...(opts.conclusion !== undefined ? { conclusion: opts.conclusion } : {}),
      ...(opts['conclusion-file'] ? { conclusion: readText(opts['conclusion-file']) } : {}),
      ...(Object.keys(links).length ? { links } : {}),
      ...(opts.multi.set ? { sets: opts.multi.set } : {}),
      ...(opts['preserve-text'] ? { preserveText: true } : {}),
    };
    const res = await call(cfg, 'POST', '/api/v1/runs', body);
    await attach(cfg, res.id, opts.multi.attach ?? [], opts.quiet);
    process.stdout.write(
      `${JSON.stringify({ id: res.id, created: res.created, status: res.status, url: `${cfg.url}/runs/${res.id}` })}\n`,
    );
    return;
  }
  if (cmd === 'define') {
    if (!opts.type || !opts.file) die('define needs --type <slug> --file <type.json>');
    const res = await call(
      cfg,
      'PUT',
      `/api/v1/test-types/${encodeURIComponent(opts.type)}`,
      JSON.parse(readText(opts.file)),
    );
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return;
  }
  if (cmd === 'json') {
    const file = opts._[0];
    if (!file) die('json needs a file');
    const body = JSON.parse(readText(file));
    const res = Array.isArray(body.runs)
      ? await call(cfg, 'POST', '/api/v1/runs/batch', body)
      : await call(cfg, 'POST', '/api/v1/runs', body);
    process.stdout.write(`${JSON.stringify(res)}\n`);
    if (res && res.failed) process.exit(1);
    return;
  }
  if (cmd === 'attach') {
    if (!opts.run || opts._.length === 0) die('attach needs --run <id> and files');
    await attach(cfg, opts.run, opts._, opts.quiet);
    return;
  }
  if (cmd === 'get') {
    const path = opts._[0];
    if (!path || !path.startsWith('/')) die('get needs an API path starting with /');
    process.stdout.write(`${JSON.stringify(await call(cfg, 'GET', path), null, 2)}\n`);
    return;
  }
  die(`unknown command '${cmd}'\n${HELP}`);
}

main().catch((e) => die(e && e.stack ? e.stack : String(e), 1));
