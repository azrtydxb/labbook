# What a human decided

Written 2026-09-27 07:58 UTC. procoder reads this
file to avoid asking a question twice; edit an answer here to change what
it believes. Reword the question and it will be asked again.

## [decision] decisions.md

Key: 011b726c3aaf
Question: Pinned baselines: what a "sub-baseline" is

- Named baseline groups: one baseline (e.g. "vLLM-ROCm 0.23.0") holds one reference run per model/GPU; each run is compared with the member whose parameters match it
- Specificity hierarchy: baselines scoped type → model → gpu; the most specific match wins
- Chronological milestones: several named baselines (Phase 2 start, Phase 2c start, vLLM) all shown side by side

Answer: Named groups — a baseline like "vLLM-ROCm 0.23.0" holds one reference run per model/GPU; each run is compared with the member whose parameters match it; a type can have several baselines (user, 2026-09-27)

## [decision] decisions.md

Key: 41ae670b61fc
Question: Shipping OpenAPI + MCP + skill + baselines + targets

- Commit to main, push, and deploy to kw once CI has built the image
- Open a pull request instead and deploy after review
- Commit locally only; ship later

Answer: Commit to main, push, deploy to kw after CI builds the image (user, 2026-09-27)

## [decision] decisions.md

Key: 5f1d05f7a629
Question: Target zones: where they are defined

- In the test type definition per data point (versioned with the schema)
- On the baseline (e.g. the vLLM baseline carries "tok_s >= 75%")

Answer: Type definition — per data point next to the bounds, versioned with the schema; references: named baseline, previous best, or absolute (user, 2026-09-27)

## [decision] decisions.md

Key: 62a39568eb6f
Question: Kuvryn Sync image write-back credential for azrtydxb/labbook

- You create a fine-grained GitHub token (Contents: read/write on azrtydxb/labbook) and load it with a kubectl command
- I create a write-enabled deploy key with gh and store its private half only in the cluster Secret
- No write-back: Kuvryn Sync syncs Git only; image bumps stay a manual commit of the digest

Answer: Deploy key created by Claude with gh (write access, azrtydxb/labbook only); private half only in the cluster Secret (user, 2026-09-27)

## [decision] decisions.md

Key: 9882483ac5ee
Question: Pinned baselines: how charts show them

- Labelled dashed horizontal lines per applicable baseline, plus "% of baseline" in tooltips
- The same, plus a toggle to plot the y-axis as % of a chosen baseline

Answered 2026-09-27: named baseline groups; bounds stay on the previous run (baselines shown, not enforced); charts get labelled lines plus a %-of-baseline toggle.

Answer: Lines + % toggle — labelled dashed line per matching baseline, % of baseline in tooltips, and a toggle to plot the y-axis as % of a chosen baseline (user, 2026-09-27)

## [decision] decisions.md

Key: b3f787c132dd
Question: Target zones: effect of missing a target

- Separate "target" grade (on target / below target) shown on runs and charts; pass/fail unchanged
- Missing a target fails the run (like a bound)
- Per target: each target says whether it is enforced or informational

Answer: Separate target grade — on target / below target shown on runs and charts; pass/fail unchanged (user, 2026-09-27)

## [decision] decisions.md

Key: e851ffa8aeca
Question: Pinned baselines: what relative bounds (relMin/relMax) check against

- Keep the previous comparable run (today's behaviour); pinned baselines are shown, not enforced
- A baseline marked "primary" per type replaces the previous run for bound checks
- Per-baseline bounds (e.g. tok_s >= 1.0x vLLM) in addition to the previous-run check

Answer: Previous run, show baselines — pass/fail keeps comparing with the previous comparable run; pinned baselines are displayed but do not change the verdict (user, 2026-09-27)
