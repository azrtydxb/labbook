#!/usr/bin/env node
// Backfill labbook with Turbine's lab history. Zero dependencies, Node >= 18.
//
//   LABBOOK_URL=https://labbook.kw.watteel.lab LABBOOK_TOKEN=lbk_... \
//     node importers/turbine/backfill.mjs --turbine ~/Development/Turbine [--dry-run]
//
// Reads (never writes) <turbine>/.procoder/perf-log.md and <turbine>/target/lab-bench/*/.
// Every run carries an external id, so running it again updates instead of duplicating;
// notes and conclusions edited in labbook since are kept (preserveText).
//
// Sources and what they become:
//   perf-log tables      → turbine-lab-bench runs (one per model per row), grouped into a set per section;
//                          "Host tests" / "GPU suites" / "(N/M)" counts → turbine-lab-test runs
//   lab-bench/<dir>/     → matched to a perf-log row by model + tok/s (+ TTFT) and attached to it;
//                          unmatched dirs become their own runs in the set "lab-bench-unlogged";
//                          golden1/golden16.txt → turbine-golden runs; tests.log → turbine-lab-test runs
//   lab-bench/p4-multiturn/ + the multi-turn table → turbine-multi-turn runs
//   the pinned round-trip sentence → turbine-pinned-bandwidth runs
//   the Phase 3 soak sentence → a turbine-overload-soak run

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { TYPES } from './types.mjs';

// ---------------------------------------------------------------- arguments

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const DRY = args.includes('--dry-run');
const TURBINE = opt('turbine', process.env.TURBINE_DIR);
if (!TURBINE) {
  console.error('usage: backfill.mjs --turbine <path to the Turbine checkout> [--dry-run]');
  process.exit(2);
}
const URL_ = (process.env.LABBOOK_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.LABBOOK_TOKEN || '';
if (!DRY && (!URL_ || !TOKEN)) {
  console.error('set LABBOOK_URL and LABBOOK_TOKEN (or pass --dry-run)');
  process.exit(2);
}
const LOG = path.join(TURBINE, '.procoder/perf-log.md');
const BENCH = path.join(TURBINE, 'target/lab-bench');

// ---------------------------------------------------------------- helpers

const MODELS = {
  llama: 'llama-3.2-3b-instruct',
  olmoe: 'olmoe-1b-7b-0125-instruct',
};
const GPU0 = 'R9700 GPU0';

const num = (s) => {
  if (s === undefined || s === null) return undefined;
  const t = String(s).replace(/\*\*/g, '').replace(/,/g, '').replace(/[−–]/g, '-').trim();
  const m = t.match(/^-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : undefined;
};
const clean = (s) => (s ?? '').replace(/\*\*/g, '').replace(/`/g, '').trim();
const isDash = (s) => /^[-–—]?$/.test(clean(s));
const readIf = (f) => (existsSync(f) ? readFileSync(f, 'utf8') : undefined);
const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

function shortLabel(text, max = 70) {
  const t = clean(text)
    .replace(/\s*\(\d+\/\d+[^)]*\)\s*/g, ' ')
    .replace(/\s+—.*$/, '')
    .replace(/\s+/g, ' ')
    .replace(/ ,/g, ',')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

// ---------------------------------------------------------------- lab-bench dirs

function parseMetricsDecodeMs(text) {
  if (!text) return undefined;
  const sum = text.match(/turbine_forward_seconds_sum\{phase="decode"\}\s+([\d.e+-]+)/);
  const cnt = text.match(/turbine_forward_seconds_count\{phase="decode"\}\s+([\d.e+-]+)/);
  if (!sum || !cnt || Number(cnt[1]) === 0) return undefined;
  return (Number(sum[1]) / Number(cnt[1])) * 1000;
}

function parseGolden(text) {
  if (!text || !text.trim()) return undefined;
  const lines = text.trim().split('\n');
  const verdict = lines.find((l) => /^(PASS|FAIL):/.test(l));
  if (!verdict) return undefined;
  const m = verdict.match(/(\d+)\/(\d+) prompts passing \(need (\d+)\)/);
  const bounds = verdict.match(/(strict|batched) bounds \(concurrency (\d+)\)/);
  let likely = 0;
  let tail = 0;
  let minPrefix = Infinity;
  for (const l of lines) {
    const a = l.match(/max_abs_logprob_diff_likely=([\d.]+)/);
    const b = l.match(/max_abs_logprob_diff_tail=([\d.]+)/);
    const p = l.match(/identical_prefix=(\d+)\//);
    if (a) likely = Math.max(likely, Number(a[1]));
    if (b) tail = Math.max(tail, Number(b[1]));
    if (p) minPrefix = Math.min(minPrefix, Number(p[1]));
  }
  return {
    passed: verdict.startsWith('PASS'),
    prompts_passing: m ? Number(m[1]) : undefined,
    prompts_total: m ? Number(m[2]) : undefined,
    prompts_needed: m ? Number(m[3]) : undefined,
    max_likely_diff: likely,
    max_tail_diff: tail,
    min_identical_prefix: Number.isFinite(minPrefix) ? minPrefix : undefined,
    bounds: bounds ? bounds[1] : undefined,
    concurrency: bounds ? bounds[2] : undefined,
    verdictLine: verdict,
  };
}

function parseTests(text) {
  if (!text) return undefined;
  let passed = 0;
  let failed = 0;
  let ignored = 0;
  let dur = 0;
  let n = 0;
  for (const m of text.matchAll(
    /test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored;[^\n]*finished in ([\d.]+)s/g,
  )) {
    passed += Number(m[1]);
    failed += Number(m[2]);
    ignored += Number(m[3]);
    dur += Number(m[4]);
    n++;
  }
  return n ? { passed, failed, ignored, duration_s: Math.round(dur * 100) / 100, binaries: n } : undefined;
}

function loadBenchDirs() {
  if (!existsSync(BENCH)) return [];
  const out = [];
  for (const name of readdirSync(BENCH).sort()) {
    const dir = path.join(BENCH, name);
    if (!statSync(dir).isDirectory() || name === 'p4-multiturn') continue;
    const benchFile = path.join(dir, 'bench.json');
    if (!existsSync(benchFile)) continue;
    let bench;
    try {
      bench = JSON.parse(readFileSync(benchFile, 'utf8'));
    } catch {
      continue;
    }
    const modelKey = name.endsWith('-olmoe') ? 'olmoe' : name.endsWith('-llama') ? 'llama' : undefined;
    const files = readdirSync(dir)
      .map((f) => path.join(dir, f))
      .filter((f) => statSync(f).isFile() && statSync(f).size > 0);
    out.push({
      name,
      label: modelKey ? name.slice(0, -(modelKey.length + 1)) : name,
      modelKey,
      dir,
      bench,
      mtime: statSync(benchFile).mtime,
      decodeMs: parseMetricsDecodeMs(readIf(path.join(dir, 'metrics.txt'))),
      golden1: parseGolden(readIf(path.join(dir, 'golden1.txt'))),
      golden16: parseGolden(readIf(path.join(dir, 'golden16.txt'))),
      tests: parseTests(readIf(path.join(dir, 'tests.log'))),
      files,
      matched: [],
    });
  }
  return out;
}

// ---------------------------------------------------------------- perf-log

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

function parseLog(text) {
  const sections = [];
  const preamble = [];
  let cur = null;
  let header = null;
  for (const line of text.split('\n')) {
    const h = line.match(/^## (.+)$/);
    if (h) {
      cur = { title: h[1].trim(), prose: [], tables: [] };
      sections.push(cur);
      header = null;
      continue;
    }
    if (!cur) {
      if (line.trim() && !line.startsWith('# ')) preamble.push(line.trim());
      continue;
    }
    if (line.trim().startsWith('|')) {
      const cells = splitRow(line);
      if (cells.every((c) => /^:?-+:?$/.test(c))) continue;
      if (!header || (cells[0] && /^(Date|Prefix sharing)$/i.test(cells[0]))) {
        if (/^(Date|Prefix sharing)$/i.test(cells[0] ?? '')) {
          header = cells;
          cur.tables.push({ header, rows: [] });
          continue;
        }
      }
      if (header) cur.tables[cur.tables.length - 1].rows.push(cells);
      continue;
    }
    if (line.trim()) cur.prose.push(line.trim());
  }
  sections.preamble = preamble;
  return sections;
}

const col = (header, row, re) => {
  const i = header.findIndex((h) => re.test(h));
  return i >= 0 ? row[i] : undefined;
};

/** "c1 16/16; c16 15/16 flake" | "PASS/PASS" | "16/16" | "5/16 (known…)" → {c1, c16}. */
function parseGoldenCell(s) {
  const t = clean(s);
  if (!t || isDash(t)) return {};
  const judge = (x) => {
    if (x === undefined) return undefined;
    const v = x.trim();
    if (!v || /^[-–]$/.test(v)) return undefined;
    if (/fail|flake/i.test(v)) return false;
    if (/pass/i.test(v)) return true;
    const m = v.match(/(\d+)\/(\d+)/);
    if (m) return m[1] === m[2];
    return undefined;
  };
  const c1m = t.match(/c1\s+([^;]+)/i);
  const c16m = t.match(/c16\s+([^;]+)/i);
  if (c1m || c16m) return { c1: judge(c1m?.[1]), c16: judge(c16m?.[1]) };
  const slash = t.split('/');
  if (/^(pass|fail|retry)/i.test(t) && slash.length >= 2 && !/\d/.test(slash[0])) {
    return { c1: judge(slash[0]), c16: judge(slash.slice(1).join('/')) };
  }
  return { c1: judge(t) };
}

/**
 * "hip_ops 15/15, tiny_model 21/21" reads passed/total; "full lab 509/0" reads passed/failed.
 * A pair with total ≥ passed > 0 is passed-of-total, anything else passed/failed; summed.
 */
function suiteCounts(cell) {
  let passed = 0;
  let failed = 0;
  let n = 0;
  for (const m of clean(cell).matchAll(/(\d+)\/(\d+)/g)) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (b >= a && a > 0) {
      passed += a;
      failed += b - a;
    } else {
      passed += a;
      failed += b;
    }
    n++;
  }
  return n ? { passed, failed } : undefined;
}

function hostTests(cell, change) {
  const src = clean(cell ?? '') || '';
  const m = src.match(/(\d+)\/(\d+)/) ?? clean(change ?? '').match(/\((\d+)\/(\d+)[^)]*\)/);
  return m ? { passed: Number(m[1]), failed: Number(m[2]) } : undefined;
}

// ---------------------------------------------------------------- build the runs

const SET_FOR = (title) => {
  if (/^Llama|^OLMoE/.test(title))
    return {
      slug: 'phase-2c-perf-chain',
      name: 'Phase 2c perf chain',
    };
  const m = title.match(/Phase (\w+)/);
  return { slug: slugify(title), name: m ? title : title };
};

function buildAll() {
  const log = readFileSync(LOG, 'utf8');
  const sections = parseLog(log);
  const dirs = loadBenchDirs();
  const runs = [];
  const sets = new Map();
  const addSet = (slug, name, description, conclusion) => {
    if (!sets.has(slug))
      sets.set(slug, { slug, name, description: description ?? '', conclusion: conclusion ?? '' });
    else if (description && !sets.get(slug).description.includes(description))
      sets.get(slug).description += `\n\n${description}`;
  };

  // Match a lab-bench dir by model + tok/s (1 dp) and, when given, TTFT p50 (0 dp).
  const findDir = (modelKey, tokS, ttft) => {
    if (tokS === undefined) return undefined;
    let cands = dirs.filter(
      (d) => d.modelKey === modelKey && Math.round(d.bench.output_token_throughput * 10) / 10 === tokS,
    );
    if (ttft !== undefined) {
      const byTtft = cands.filter((d) => Math.round(d.bench.ttft_ms?.p50 ?? -1) === Math.round(ttft));
      if (byTtft.length) cands = byTtft;
    }
    // Identical numbers happen (two landings measuring 771.9 / 195): prefer a dir no other
    // row claimed, then the one that follows the section's previous row most closely.
    const rank = (d) => [
      d.matched.length ? 1 : 0,
      d.mtime.getTime() >= lastTime ? 0 : 1,
      Math.abs(d.mtime.getTime() - lastTime),
    ];
    cands.sort((a, b) => {
      const x = rank(a);
      const y = rank(b);
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
    return cands[0];
  };

  // Matched rows take the bench output's real time; the rest follow the previous row of the
  // same section by a minute, so the log order is kept within each section.
  let lastTime = 0;
  const timeFor = (date, dir) => {
    const dayStart = Date.parse(`${date}T00:00:00Z`);
    let t = dir ? dir.mtime.getTime() : Math.max(lastTime + 60_000, dayStart);
    if (!Number.isFinite(t)) t = lastTime + 60_000;
    lastTime = Math.max(lastTime, t);
    return new Date(t).toISOString();
  };

  for (const sec of sections) {
    lastTime = 0;
    const { slug: setSlug, name: setName } = SET_FOR(sec.title);
    const prose = sec.prose.filter((p) => !/^Criterion:/.test(p));
    const criterion = sec.prose.filter((p) => /^Criterion:/.test(p)).join('\n\n');
    addSet(
      setSlug,
      setName,
      sec.title.match(/^Llama|^OLMoE/)
        ? sections.preamble.join('\n\n')
        : prose.filter((p) => !/^Multi-turn/.test(p) && !/pinned_round_trip/.test(p)).join('\n\n'),
      criterion,
    );
    const occurrences = new Map();

    for (const table of sec.tables) {
      const H = table.header;
      if (/^Prefix sharing$/i.test(H[0])) {
        // Multi-turn table: handled with the p4-multiturn dir below.
        sec.multiTurn = table;
        continue;
      }
      const perModel = H.some((h) => /^Llama tok\/s/i.test(h));
      for (const row of table.rows) {
        const date = clean(col(H, row, /^Date$/i));
        const commitCell = clean(col(H, row, /^Commit$/i));
        const change = col(H, row, /^(Change|Task)$/i) ?? '';
        const vsPrev = clean(col(H, row, /^vs previous$/i) ?? '');
        const hostCell = col(H, row, /^Host tests$/i);
        const gpuSuites = clean(col(H, row, /^GPU suites$/i) ?? '');
        const goldenCell = col(H, row, /^Golden/i) ?? '';
        const vllm = /^vLLM/i.test(commitCell);
        const commit = vllm ? '' : (commitCell.match(/[0-9a-f]{7,40}/)?.[0] ?? commitCell);
        const reverted = /revert/i.test(commitCell);

        const models = perModel ? ['llama', 'olmoe'] : [/^OLMoE/.test(sec.title) ? 'olmoe' : 'llama'];
        const goldenParts = goldenCell.split(';');
        const rowRuns = [];
        for (const [mi, mk] of models.entries()) {
          const tok = perModel
            ? num(col(H, row, mk === 'llama' ? /^Llama tok\/s/i : /^OLMoE tok\/s/i))
            : num(col(H, row, /^tok\/s$/i));
          const ttft = perModel
            ? num(col(H, row, mk === 'llama' ? /^Llama TTFT/i : /^OLMoE TTFT/i))
            : num(col(H, row, /^TTFT p50/i));
          if (tok === undefined) continue;
          const itl = perModel ? undefined : num(col(H, row, /^ITL p50/i));
          const fwd = perModel ? undefined : num(col(H, row, /^decode fwd/i));
          const golden = parseGoldenCell(perModel ? (goldenParts[mi] ?? '') : goldenCell);
          const dir = vllm ? undefined : findDir(mk, tok, ttft);
          const key = `${commitCell}|${mk}`;
          const occ = (occurrences.get(key) ?? 0) + 1;
          occurrences.set(key, occ);

          // Phase 2c: rows were not pinned to a card until a Turbine row says GPU 0
          // ("From here all rows are pinned to GPU 0"); vLLM rows say it themselves.
          let gpu = GPU0;
          if (sec.title.match(/^Llama|^OLMoE/)) {
            const text = clean(`${commitCell} ${change}`);
            if (vllm) gpu = /GPU 0/.test(text) ? GPU0 : 'R9700 (unpinned)';
            else {
              if (/GPU 0/.test(text)) sec.pinned = true;
              gpu = sec.pinned ? GPU0 : 'R9700 (unpinned)';
            }
          }
          const config = /max_batch_tokens` 2,048|max_batch_tokens 2,048/.test(change)
            ? 'phase2c'
            : /kv\.cpu\.enabled=false/.test(change)
              ? 'phase2c kv.cpu.enabled=false'
              : /kv\.prefix_sharing=false/.test(change)
                ? 'phase2c kv.prefix_sharing=false'
                : sec.title.match(/^Llama|^OLMoE/)
                  ? 'phase2'
                  : 'phase2c';

          const values = {
            tok_s: dir ? round(dir.bench.output_token_throughput, 2) : tok,
            ttft_p50_ms: dir?.bench.ttft_ms?.p50 !== undefined ? round(dir.bench.ttft_ms.p50, 2) : ttft,
            itl_p50_ms: dir?.bench.itl_ms?.p50 !== undefined ? round(dir.bench.itl_ms.p50, 3) : itl,
            decode_fwd_ms: dir?.decodeMs !== undefined ? round(dir.decodeMs, 3) : fwd,
            ttft_p99_ms: dir?.bench.ttft_ms?.p99 !== undefined ? round(dir.bench.ttft_ms.p99, 2) : undefined,
            itl_p99_ms: dir?.bench.itl_ms?.p99 !== undefined ? round(dir.bench.itl_ms.p99, 3) : undefined,
            requests_ok: dir?.bench.requests_ok,
            requests_failed: dir?.bench.requests_failed,
            golden_c1: dir?.golden1 ? dir.golden1.passed : golden.c1,
            golden_c16: dir?.golden16 ? dir.golden16.passed : golden.c16,
            golden_summary: clean(perModel ? (goldenParts[mi] ?? '') : goldenCell) || undefined,
          };
          const ht = hostTests(hostCell, change);
          if (ht) {
            values.host_tests_passed = ht.passed;
            values.host_tests_failed = ht.failed;
          }
          const label = shortLabel(change) || commitCell;
          const notes = [
            `**From perf-log.md, ${sec.title}** (${date}, ${commitCell}).`,
            '',
            clean(change),
            hostCell && !isDash(hostCell) ? `\nHost tests: ${clean(hostCell)}` : '',
            gpuSuites && !isDash(gpuSuites) ? `\nGPU suites: ${gpuSuites}` : '',
            goldenCell && !isDash(goldenCell)
              ? `\nGolden (Llama c1/c16; OLMoE c1/c16): ${clean(goldenCell)}`
              : '',
            dir ? `\nRaw output: \`target/lab-bench/${dir.name}/\`` : '',
          ]
            .filter((x) => x !== '')
            .join('\n');
          const run = {
            type: 'turbine-lab-bench',
            externalId: `perflog:${slugify(sec.title)}:${commitCell ? slugify(commitCell) : 'nocommit'}:${mk}:${occ}`,
            runAt: timeFor(date, dir),
            source: 'perf-log.md backfill',
            params: {
              model: MODELS[mk],
              gpu,
              config,
              engine: vllm ? 'vllm-rocm' : 'turbine',
              ...(commit ? { commit } : {}),
              label: vllm ? commitCell : label,
            },
            values: stripUndef(values),
            notes,
            conclusion: vsPrev && !isDash(vsPrev) ? vsPrev : '',
            links: commit ? { commit } : {},
            sets: [setSlug, ...(vllm ? ['vllm-rocm-reference'] : [])],
            preserveText: true,
            _files: dir ? dir.files : [],
          };
          if (reverted) run.params.label = `${label} (reverted)`;
          if (dir) dir.matched.push(run);
          runs.push(run);
          rowRuns.push(run);

          // Goldens from the dir.
          for (const [c, g, f] of [
            ['1', dir?.golden1, 'golden1.txt'],
            ['16', dir?.golden16, 'golden16.txt'],
          ]) {
            if (!g) continue;
            runs.push(goldenRun(dir, g, c, f, mk, gpu, commit, run.params.label, [setSlug], run.runAt));
          }
          if (dir?.tests) runs.push(testsRun(dir, commit, run.params.label, [setSlug], run.runAt));
        }

        // Host and GPU suite counts become test-suite runs (once per row, not per model).
        const ht = hostTests(hostCell, change);
        const first = rowRuns[0];
        if (ht && first) {
          runs.push({
            type: 'turbine-lab-test',
            externalId: `${first.externalId}:host-tests`,
            runAt: first.runAt,
            source: 'perf-log.md backfill',
            params: {
              tier: 'host',
              suite: clean(hostCell ?? '') || 'host tests',
              ...(commit ? { commit } : {}),
              label: first.params.label,
            },
            values: { passed: ht.passed, failed: ht.failed },
            notes: `Host test count from perf-log.md, ${sec.title}: ${clean(hostCell ?? '') || clean(change)}`,
            links: commit ? { commit } : {},
            sets: [setSlug],
            preserveText: true,
          });
        }
        const gs = suiteCounts(gpuSuites);
        if (gs && first) {
          runs.push({
            type: 'turbine-lab-test',
            externalId: `${first.externalId}:gpu-suites`,
            runAt: first.runAt,
            source: 'perf-log.md backfill',
            params: {
              tier: 'gpu-lab',
              suite: gpuSuites,
              ...(commit ? { commit } : {}),
              label: first.params.label,
            },
            values: gs,
            notes: `GPU suites from perf-log.md, ${sec.title}: ${gpuSuites}`,
            links: commit ? { commit } : {},
            sets: [setSlug],
            preserveText: true,
          });
        }

        // Phase 3: the overload soak is reported in the "vs previous" cell.
        const soak = vsPrev.match(
          /(\d+)-min overload soak \(GPU (\d)\) (PASS|FAIL): ITL p99 (\d+) vs (\d+) ms calibration, GREEN (\d+) s after cool-down, ([\d,]+) × 200 \/ ([\d,]+) queue_timeout \/ ([\d,]+) queue_full \/ ([\d,]+) overloaded, (no drops|(\d+) drops?)/,
        );
        if (soak) {
          runs.push({
            type: 'turbine-overload-soak',
            externalId: `perflog:overload-soak:${commit}`,
            runAt: new Date(Date.parse(first?.runAt ?? `${date}T12:00:00Z`) + 60_000).toISOString(),
            source: 'perf-log.md backfill',
            params: {
              model: MODELS.llama,
              gpu: `R9700 GPU${soak[2]}`,
              duration: `${soak[1]} min`,
              commit,
              label: shortLabel(change),
            },
            values: {
              verdict: soak[3] === 'PASS',
              itl_p99_ms: Number(soak[4]),
              calibration_itl_p99_ms: Number(soak[5]),
              recovery_s: Number(soak[6]),
              ok_200: num(soak[7]),
              queue_timeout: num(soak[8]),
              queue_full: num(soak[9]),
              overloaded: num(soak[10]),
              dropped: soak[11] === 'no drops' ? 0 : Number(soak[12]),
            },
            notes: `From perf-log.md, ${sec.title}, row ${commit}:\n\n> ${vsPrev}`,
            links: { commit },
            sets: [setSlug],
            preserveText: true,
          });
        }
      }
    }

    // Pinned round trip, in prose.
    for (const p of sec.prose) {
      const m = p.match(
        /pinned_round_trip`?,? GPU (\d), PCIe (Gen\d x\d+)[^)]*\): d2h ([\d.]+) GB\/s, h2d ([\d.]+) GB\/s \((Gen\d): ([\d.]+) \/ ([\d.]+)\)/,
      );
      if (!m) continue;
      const commit =
        p.match(/\b([0-9a-f]{7})\b code/)?.[1] ?? sec.prose.join(' ').match(/\b([0-9a-f]{7}) code/)?.[1];
      const base = {
        type: 'turbine-pinned-bandwidth',
        source: 'perf-log.md backfill',
        notes: `From perf-log.md, ${sec.title}:\n\n> ${p}`,
        sets: [setSlug],
        preserveText: true,
      };
      const t0 = Date.parse(`${runs.at(-1)?.runAt ?? new Date().toISOString()}`);
      runs.push({
        ...base,
        externalId: `perflog:pinned-round-trip:${m[5].toLowerCase()}`,
        runAt: new Date(t0 + 60_000).toISOString(),
        params: {
          gpu: `R9700 GPU${m[1]}`,
          link_gen: m[5],
          ...(commit ? { commit } : {}),
          label: `${m[5]} (before the runtime-PM fix)`,
        },
        values: { d2h_gbs: Number(m[6]), h2d_gbs: Number(m[7]) },
        links: commit ? { commit } : {},
      });
      runs.push({
        ...base,
        externalId: `perflog:pinned-round-trip:${m[2].toLowerCase().replace(/\s+/g, '-')}`,
        runAt: new Date(t0 + 120_000).toISOString(),
        params: {
          gpu: `R9700 GPU${m[1]}`,
          link_gen: m[2],
          ...(commit ? { commit } : {}),
          label: `${m[2]} after the runtime-PM fix`,
        },
        values: { d2h_gbs: Number(m[3]), h2d_gbs: Number(m[4]) },
        links: commit ? { commit } : {},
      });
    }

    // Multi-turn table + p4-multiturn/.
    if (sec.multiTurn) {
      const mtDir = path.join(BENCH, 'p4-multiturn');
      const prose = sec.prose.find((p) => /^Multi-turn/.test(p)) ?? '';
      const commit = prose.match(/\b([0-9a-f]{7})\b code/)?.[1];
      const H = sec.multiTurn.header;
      for (const row of sec.multiTurn.rows) {
        const sharing = clean(col(H, row, /^Prefix sharing$/i)).toLowerCase();
        const jsonFile = path.join(mtDir, `sharing-${sharing}.json`);
        const j = existsSync(jsonFile) ? JSON.parse(readFileSync(jsonFile, 'utf8')) : undefined;
        const okCell = clean(col(H, row, /^Requests ok$/i));
        const files = ['json', 'err'].map((e) => path.join(mtDir, `sharing-${sharing}.${e}`));
        files.push(path.join(mtDir, `metrics-${sharing}.txt`));
        const t = j ? statSync(jsonFile).mtime.toISOString() : new Date(lastTime + 60_000).toISOString();
        runs.push({
          type: 'turbine-multi-turn',
          externalId: `p4-multiturn:sharing-${sharing}`,
          runAt: t,
          source: 'perf-log.md + target/lab-bench/p4-multiturn backfill',
          params: {
            model: MODELS.llama,
            gpu: GPU0,
            sharing,
            config: 'phase4-novanas S-16 (16 sessions × 8 turns, 2000-word prefix, c8)',
            ...(commit ? { commit } : {}),
            label: `prefix sharing ${sharing}`,
          },
          values: stripUndef({
            cached_ratio: j?.cached_tokens_ratio ?? num(col(H, row, /Cached-token ratio/i)),
            later_ttft_p50_ms:
              j?.ttft_ms_later_turns?.p50 !== undefined
                ? round(j.ttft_ms_later_turns.p50, 2)
                : num(col(H, row, /TTFT p50 turns/i)),
            later_ttft_p99_ms:
              j?.ttft_ms_later_turns?.p99 !== undefined
                ? round(j.ttft_ms_later_turns.p99, 2)
                : num(col(H, row, /TTFT p99 turns/i)),
            first_ttft_p50_ms:
              j?.ttft_ms_first_turn?.p50 !== undefined
                ? round(j.ttft_ms_first_turn.p50, 2)
                : num(col(H, row, /First-turn TTFT/i)),
            tok_s: j ? round(j.output_token_throughput, 2) : num(col(H, row, /Output tok\/s/i)),
            requests_ok: j?.requests_ok ?? num(okCell),
            requests_failed: j?.requests_failed,
            wall_s: j ? round(j.wall_seconds, 2) : num(col(H, row, /Wall s/i)),
          }),
          notes: `From perf-log.md, ${sec.title}:\n\n> ${prose}`,
          conclusion: sharing === 'on' ? sec.prose.filter((p) => /^Criterion:/.test(p)).join('\n\n') : '',
          links: commit ? { commit } : {},
          sets: [setSlug],
          preserveText: true,
          _files: files.filter((f) => existsSync(f) && statSync(f).size > 0),
        });
      }
    }
  }

  // Lab-bench dirs no perf-log row points at: keep them as their own runs.
  addSet(
    'lab-bench-unlogged',
    'Lab bench runs not in the perf log',
    'Output dirs under `target/lab-bench/` whose numbers match no perf-log row: retries, A/B probes, card and health checks. Kept so no measurement is lost.',
  );
  for (const d of dirs.filter((x) => x.matched.length === 0)) {
    const mk = d.modelKey ?? 'llama';
    const gpu = /card1|gpu1/.test(d.name) ? 'R9700 GPU1' : /card0/.test(d.name) ? GPU0 : GPU0;
    const runAt = d.mtime.toISOString();
    const run = {
      type: 'turbine-lab-bench',
      externalId: `labbench:${d.name}`,
      runAt,
      source: 'target/lab-bench backfill',
      params: { model: MODELS[mk], gpu, config: 'unknown', engine: 'turbine', label: d.label },
      values: stripUndef({
        tok_s: round(d.bench.output_token_throughput, 2),
        ttft_p50_ms: d.bench.ttft_ms ? round(d.bench.ttft_ms.p50, 2) : undefined,
        ttft_p99_ms: d.bench.ttft_ms ? round(d.bench.ttft_ms.p99, 2) : undefined,
        itl_p50_ms: d.bench.itl_ms ? round(d.bench.itl_ms.p50, 3) : undefined,
        itl_p99_ms: d.bench.itl_ms ? round(d.bench.itl_ms.p99, 3) : undefined,
        decode_fwd_ms: d.decodeMs !== undefined ? round(d.decodeMs, 3) : undefined,
        requests_ok: d.bench.requests_ok,
        requests_failed: d.bench.requests_failed,
        golden_c1: d.golden1?.passed,
        golden_c16: d.golden16?.passed,
      }),
      notes: `Imported from \`target/lab-bench/${d.name}/\`; no perf-log.md row has these numbers, so the commit is not recorded.`,
      sets: ['lab-bench-unlogged'],
      preserveText: true,
      _files: d.files,
    };
    runs.push(run);
    for (const [c, g, f] of [
      ['1', d.golden1, 'golden1.txt'],
      ['16', d.golden16, 'golden16.txt'],
    ]) {
      if (g) runs.push(goldenRun(d, g, c, f, mk, gpu, undefined, d.label, ['lab-bench-unlogged'], runAt));
    }
    if (d.tests) runs.push(testsRun(d, undefined, d.label, ['lab-bench-unlogged'], runAt));
  }
  addSet(
    'vllm-rocm-reference',
    'vLLM-ROCm reference',
    'vLLM-ROCm 0.23.0 on the same R9700 and workload: the Phase 2c target is ≥ 75% of these numbers.',
  );
  // A dir shared by two log rows (a section's baseline repeats an earlier measurement)
  // yields its golden and test runs once; their sets are merged.
  const seen = new Map();
  const unique = [];
  for (const r of runs) {
    const prev = seen.get(r.externalId);
    if (prev) {
      for (const s of r.sets) if (!prev.sets.includes(s)) prev.sets.push(s);
      continue;
    }
    seen.set(r.externalId, r);
    unique.push(r);
  }
  return { runs: unique, sets: [...sets.values()], dirs };
}

function goldenRun(dir, g, c, file, mk, gpu, commit, label, sets, runAt) {
  return {
    type: 'turbine-golden',
    externalId: `labbench:${dir.name}:golden${c}`,
    runAt,
    source: 'target/lab-bench backfill',
    params: { model: MODELS[mk], concurrency: c, gpu, ...(commit ? { commit } : {}), label },
    values: stripUndef({
      passed: g.passed,
      prompts_passing: g.prompts_passing,
      prompts_total: g.prompts_total,
      prompts_needed: g.prompts_needed,
      max_likely_diff: g.max_likely_diff,
      max_tail_diff: g.max_tail_diff,
      min_identical_prefix: g.min_identical_prefix,
      bounds: g.bounds,
    }),
    notes: `\`${g.verdictLine}\``,
    links: commit ? { commit } : {},
    sets,
    preserveText: true,
    _files: [path.join(dir.dir, file)],
  };
}

function testsRun(dir, commit, label, sets, runAt) {
  return {
    type: 'turbine-lab-test',
    externalId: `labbench:${dir.name}:tests`,
    runAt,
    source: 'target/lab-bench backfill',
    params: {
      tier: 'lab-bench',
      suite: `lab-bench --with-tests (${dir.tests.binaries} test binaries)`,
      ...(commit ? { commit } : {}),
      label,
    },
    values: {
      passed: dir.tests.passed,
      failed: dir.tests.failed,
      ignored: dir.tests.ignored,
      duration_s: dir.tests.duration_s,
    },
    links: commit ? { commit } : {},
    sets,
    preserveText: true,
    _files: [path.join(dir.dir, 'tests.log')],
  };
}

function round(v, d) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const f = 10 ** d;
  return Math.round(v * f) / f;
}
function stripUndef(o) {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined && v !== null && !Number.isNaN(v)),
  );
}

// ---------------------------------------------------------------- API

async function call(method, p, body, contentType) {
  const headers = { authorization: `Bearer ${TOKEN}` };
  let payload;
  if (Buffer.isBuffer(body)) {
    payload = body;
    headers['content-type'] = contentType ?? 'application/octet-stream';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(`${URL_}${p}`, { method, headers, body: payload });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok && res.status !== 404) throw new Error(`${method} ${p} → ${res.status} ${text}`);
  return { status: res.status, data };
}

async function main() {
  const { runs, sets, dirs } = buildAll();
  const byType = {};
  for (const r of runs) byType[r.type] = (byType[r.type] ?? 0) + 1;
  const attachments = runs.reduce((n, r) => n + (r._files?.length ?? 0), 0);
  console.log(
    `parsed: ${runs.length} runs ${JSON.stringify(byType)}, ${sets.length} sets, ${attachments} attachments`,
  );
  console.log(
    `lab-bench dirs: ${dirs.length}, matched to perf-log rows: ${dirs.filter((d) => d.matched.length).length}, unlogged: ${dirs.filter((d) => !d.matched.length).length}`,
  );
  if (DRY) {
    for (const r of runs.filter((x) => x.type === 'turbine-lab-bench'))
      console.log(
        `${r.runAt} ${r.params.model.slice(0, 5)} ${String(r.values.tok_s).padEnd(7)} ${r.params.gpu.padEnd(16)} ${r.params.config.padEnd(12)} ${(r.params.commit ?? '').padEnd(8)} ${r._files.length ? 'files' : '     '} ${r.params.label}`,
      );
    return;
  }

  for (const [slug, t] of Object.entries(TYPES)) {
    const { data } = await call('PUT', `/api/v1/test-types/${slug}`, t);
    console.log(
      `type ${slug}: ${data.created ? 'created' : data.versionCreated ? `new version v${data.version}` : 'unchanged'}`,
    );
  }
  for (const s of sets) {
    const existing = await call('GET', `/api/v1/sets/${s.slug}`);
    if (existing.status === 404) {
      await call('PUT', `/api/v1/sets/${s.slug}`, {
        name: s.name,
        description: s.description,
        conclusion: s.conclusion,
      });
      console.log(`set ${s.slug}: created`);
    } else {
      console.log(`set ${s.slug}: exists (description and conclusion left as they are)`);
    }
  }

  let created = 0;
  let updated = 0;
  let failed = 0;
  const ids = new Map();
  for (let i = 0; i < runs.length; i += 50) {
    const chunk = runs.slice(i, i + 50);
    const { data } = await call('POST', '/api/v1/runs/batch', {
      runs: chunk.map(({ _files, ...r }) => {
        void _files;
        return r;
      }),
    });
    for (const res of data.results) {
      const run = chunk[res.index];
      if (res.ok) {
        ids.set(run, res.id);
        if (res.created) created++;
        else updated++;
      } else {
        failed++;
        console.error(`FAILED ${run.externalId}: ${res.error} ${JSON.stringify(res.details ?? '')}`);
      }
    }
  }
  console.log(`runs: ${created} created, ${updated} updated or unchanged, ${failed} failed`);

  let uploaded = 0;
  for (const [run, id] of ids) {
    for (const f of run._files ?? []) {
      await call(
        'PUT',
        `/api/v1/runs/${id}/attachments/${encodeURIComponent(path.basename(f))}`,
        readFileSync(f),
      );
      uploaded++;
    }
  }
  console.log(`attachments: ${uploaded} uploaded (same name replaces)`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
