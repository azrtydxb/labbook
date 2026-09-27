// Test type definitions for Turbine's lab runs. The backfill PUTs these (idempotent),
// and Turbine's scripts can PUT them too: `labbook-submit define --type <slug> --file <json>`.

const model = {
  key: 'model',
  label: 'Model',
  identity: true,
  description: 'Model slug, e.g. llama-3.2-3b-instruct',
};
const gpu = { key: 'gpu', label: 'GPU', identity: true, description: 'Card the run used, e.g. R9700 GPU0' };
const commit = { key: 'commit', label: 'Commit', identity: false };
const label = {
  key: 'label',
  label: 'Label',
  identity: false,
  description: 'Short name of the change or run',
};

export const TYPES = {
  'turbine-lab-bench': {
    name: 'Turbine lab bench',
    description:
      'Fixed throughput workload on one R9700 in novanas: `turbine-bench --concurrency 16 --requests 200 ' +
      '--prompt-words 512 --max-tokens 256 --ignore-eos`, plus `turbine-golden compare` at concurrency 1 and 16. ' +
      'Bounds follow the landing rule: tok/s ≥ 0.97× and TTFT p50 ≤ 1.10× the previous comparable run; golden c1 must pass.',
    tags: ['turbine', 'perf', 'gpu'],
    definition: {
      primary: 'tok_s',
      parameters: [
        model,
        gpu,
        { key: 'config', label: 'Config', identity: true, description: 'Lab config and overrides' },
        { key: 'engine', label: 'Engine', identity: true, description: 'turbine or vllm-rocm' },
        commit,
        label,
      ],
      dataPoints: [
        { key: 'tok_s', label: 'Throughput', unit: 'tok/s', better: 'higher', bounds: { relMin: 0.97 } },
        { key: 'itl_p50_ms', label: 'ITL p50', unit: 'ms', better: 'lower' },
        { key: 'ttft_p50_ms', label: 'TTFT p50', unit: 'ms', better: 'lower', bounds: { relMax: 1.1 } },
        { key: 'decode_fwd_ms', label: 'Decode forward', unit: 'ms', better: 'lower' },
        { key: 'requests_ok', label: 'Requests ok', better: 'higher' },
        { key: 'requests_failed', label: 'Requests failed', better: 'lower', bounds: { max: 0 } },
        { key: 'golden_c1', label: 'Golden c1', type: 'boolean', bounds: { expected: true } },
        { key: 'golden_c16', label: 'Golden c16', type: 'boolean' },
        { key: 'golden_summary', label: 'Golden (as logged)', type: 'string' },
        { key: 'ttft_p99_ms', label: 'TTFT p99', unit: 'ms', better: 'lower' },
        { key: 'itl_p99_ms', label: 'ITL p99', unit: 'ms', better: 'lower' },
        { key: 'host_tests_passed', label: 'Host tests passed', better: 'higher' },
        { key: 'host_tests_failed', label: 'Host tests failed', better: 'lower' },
      ],
    },
  },
  'turbine-golden': {
    name: 'Turbine golden check',
    description:
      '`turbine-golden compare` against the committed transformers reference: identical-prefix count and ' +
      'top-5 logprob deltas per prompt. Concurrency 1 uses the strict bounds, 16 the batched bounds.',
    tags: ['turbine', 'correctness'],
    definition: {
      primary: 'prompts_passing',
      parameters: [model, { key: 'concurrency', label: 'Concurrency', identity: true }, gpu, commit, label],
      dataPoints: [
        { key: 'passed', label: 'Verdict', type: 'boolean', bounds: { expected: true } },
        { key: 'prompts_passing', label: 'Prompts passing', better: 'higher' },
        { key: 'prompts_total', label: 'Prompts' },
        { key: 'prompts_needed', label: 'Prompts needed' },
        { key: 'max_likely_diff', label: 'Max |Δ logprob| likely', better: 'lower' },
        { key: 'max_tail_diff', label: 'Max |Δ logprob| tail', better: 'lower' },
        { key: 'min_identical_prefix', label: 'Shortest identical prefix', unit: 'tokens', better: 'higher' },
        { key: 'bounds', label: 'Bounds', type: 'string' },
      ],
    },
  },
  'turbine-lab-test': {
    name: 'Turbine test suite',
    description: 'A cargo test run: host gate, GPU lab suites on novanas, or tests alongside a lab bench.',
    tags: ['turbine', 'tests'],
    definition: {
      primary: 'failed',
      parameters: [
        { key: 'tier', label: 'Tier', identity: true, description: 'host, gpu-lab or lab-bench' },
        { key: 'suite', label: 'Suite', identity: false },
        commit,
        label,
      ],
      dataPoints: [
        { key: 'passed', label: 'Passed', better: 'higher' },
        { key: 'failed', label: 'Failed', better: 'lower', bounds: { max: 0 } },
        { key: 'ignored', label: 'Ignored' },
        { key: 'duration_s', label: 'Test time', unit: 's', better: 'lower' },
      ],
    },
  },
  'turbine-multi-turn': {
    name: 'Turbine multi-turn prefix sharing',
    description:
      '`turbine-bench --profile multi-turn --sessions 16 --turns 8 --shared-prefix-words 2000 --concurrency 8 ' +
      '--session-hints`. Criterion: cached ratio ≥ 0.6 and later-turn TTFT ≤ 0.5× the sharing-off run.',
    tags: ['turbine', 'perf', 'kv'],
    definition: {
      primary: 'later_ttft_p50_ms',
      parameters: [
        model,
        gpu,
        { key: 'sharing', label: 'Prefix sharing', identity: true },
        { key: 'config', label: 'Config', identity: true },
        commit,
        label,
      ],
      dataPoints: [
        { key: 'cached_ratio', label: 'Cached-token ratio', better: 'higher' },
        { key: 'later_ttft_p50_ms', label: 'TTFT p50, turns ≥ 2', unit: 'ms', better: 'lower' },
        { key: 'later_ttft_p99_ms', label: 'TTFT p99, turns ≥ 2', unit: 'ms', better: 'lower' },
        { key: 'first_ttft_p50_ms', label: 'First-turn TTFT p50', unit: 'ms', better: 'lower' },
        { key: 'tok_s', label: 'Output throughput', unit: 'tok/s', better: 'higher' },
        { key: 'requests_ok', label: 'Requests ok', better: 'higher' },
        { key: 'requests_failed', label: 'Requests failed', better: 'lower', bounds: { max: 0 } },
        { key: 'wall_s', label: 'Wall time', unit: 's', better: 'lower' },
      ],
    },
  },
  'turbine-pinned-bandwidth': {
    name: 'Turbine pinned host bandwidth',
    description: 'L1 pinned round trip: `turbine-kernels --test lab pinned_round_trip`.',
    tags: ['turbine', 'kv', 'pcie'],
    definition: {
      primary: 'h2d_gbs',
      parameters: [gpu, { key: 'link_gen', label: 'PCIe link', identity: true }, commit, label],
      dataPoints: [
        { key: 'd2h_gbs', label: 'Device → host', unit: 'GB/s', better: 'higher' },
        { key: 'h2d_gbs', label: 'Host → device', unit: 'GB/s', better: 'higher' },
      ],
    },
  },
  'turbine-overload-soak': {
    name: 'Turbine overload soak',
    description:
      '`scripts/overload-soak.sh`: calibrate, overload, cool down; the verdict requires bounded ITL, recovery to ' +
      'GREEN and no dropped streams.',
    tags: ['turbine', 'reliability'],
    definition: {
      primary: 'itl_p99_ms',
      parameters: [model, gpu, { key: 'duration', label: 'Duration', identity: true }, commit, label],
      dataPoints: [
        { key: 'verdict', label: 'Verdict', type: 'boolean', bounds: { expected: true } },
        { key: 'itl_p99_ms', label: 'ITL p99 under overload', unit: 'ms', better: 'lower' },
        { key: 'calibration_itl_p99_ms', label: 'ITL p99 at calibration', unit: 'ms' }, // gitleaks:allow (a data-point name, not a credential)
        { key: 'recovery_s', label: 'Recovery to GREEN', unit: 's', better: 'lower' },
        { key: 'ok_200', label: 'Responses 200', better: 'higher' },
        { key: 'queue_timeout', label: '503 queue_timeout' },
        { key: 'queue_full', label: '429 queue_full' },
        { key: 'overloaded', label: '503 overloaded' },
        { key: 'dropped', label: 'Dropped streams', better: 'lower', bounds: { max: 0 } },
      ],
    },
  },
};
