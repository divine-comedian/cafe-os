# Tracked benchmark baselines

This directory stores reviewed, secret-free benchmark summaries for model-tuning comparisons. Raw run reports and JSONL trajectories remain under `../results/` and are intentionally ignored because they contain transient session identifiers and verbose prompts.

Each baseline records the tested commit, model policy, scenario selection, deterministic pass count, tool trajectory, token categories, latency, and estimated OpenRouter cost. Add a new file rather than overwriting an old result when the model, policy, suite, or commit changes.

The `*-full.json` and matching Markdown file capture the first complete 18-scenario run. Scores are strict harness results; known evaluator artifacts are retained and documented rather than silently editing historical numbers.

`2026-09-16-qwen3.8-flash-medium-hardened.md` is the first fully passing 18-scenario result after dynamic intent routing, exact pending-operation confirmation, and request-scoped tool-policy hardening. It records unmet cost and latency targets as remaining tuning work rather than weakening the acceptance criteria.

`2026-09-16-qwen3.8-flash-medium-partial-requests.md` is the first strict seven-scenario partial-request baseline. It deliberately preserves failures involving missing pending proposals, multi-reference state, invalid tool names, and optional-field provenance so subsequent tuning can be compared honestly.

`2026-09-16-glm5.3-partial-reasoning-comparison.md` compares GLM 5.3 at low and high reasoning against that Qwen partial-request baseline. It records GLM's improved canonical tool-name fidelity, the high-reasoning 6/7 score, its higher cost, and the remaining reproducible ordered-lookup failure.
