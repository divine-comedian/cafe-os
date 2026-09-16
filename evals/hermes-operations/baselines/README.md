# Tracked benchmark baselines

This directory stores reviewed, secret-free benchmark summaries for model-tuning comparisons. Raw run reports and JSONL trajectories remain under `../results/` and are intentionally ignored because they contain transient session identifiers and verbose prompts.

Each baseline records the tested commit, model policy, scenario selection, deterministic pass count, tool trajectory, token categories, latency, and estimated OpenRouter cost. Add a new file rather than overwriting an old result when the model, policy, suite, or commit changes.
