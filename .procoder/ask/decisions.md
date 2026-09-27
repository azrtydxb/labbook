## Pinned baselines: what a "sub-baseline" is

- Named baseline groups: one baseline (e.g. "vLLM-ROCm 0.23.0") holds one reference run per model/GPU; each run is compared with the member whose parameters match it
- Specificity hierarchy: baselines scoped type → model → gpu; the most specific match wins
- Chronological milestones: several named baselines (Phase 2 start, Phase 2c start, vLLM) all shown side by side

## Pinned baselines: what relative bounds (relMin/relMax) check against

- Keep the previous comparable run (today's behaviour); pinned baselines are shown, not enforced
- A baseline marked "primary" per type replaces the previous run for bound checks
- Per-baseline bounds (e.g. tok_s >= 1.0x vLLM) in addition to the previous-run check

## Pinned baselines: how charts show them

- Labelled dashed horizontal lines per applicable baseline, plus "% of baseline" in tooltips
- The same, plus a toggle to plot the y-axis as % of a chosen baseline

Answered 2026-09-27: named baseline groups; bounds stay on the previous run (baselines shown, not enforced); charts get labelled lines plus a %-of-baseline toggle.

## Target zones: effect of missing a target

- Separate "target" grade (on target / below target) shown on runs and charts; pass/fail unchanged
- Missing a target fails the run (like a bound)
- Per target: each target says whether it is enforced or informational

## Target zones: where they are defined

- In the test type definition per data point (versioned with the schema)
- On the baseline (e.g. the vLLM baseline carries "tok_s >= 75%")

## Shipping OpenAPI + MCP + skill + baselines + targets

- Commit to main, push, and deploy to kw once CI has built the image
- Open a pull request instead and deploy after review
- Commit locally only; ship later
