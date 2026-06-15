# Knowledge Context Index

This file catalogs all knowledge artifacts used by the system.

## Project Documentation

- `README.md` — Project overview, setup, and contribution guidelines

## Learning Data

- `knowledge/outcomes.jsonl` — Line-delimited JSON records of pipeline outcomes (date, task, verdict, reviewer_issues).

Run `/learn` after 10 or more pipeline runs to give the system enough data to spot real patterns.

### scripts/learn.sh

`scripts/learn.sh` is the Level 2 self-learning script. It reads `knowledge/outcomes.jsonl`, groups `reviewer_issues` by `task_type`, and surfaces issues that appear at or above a configurable threshold.

Arguments:

- `--min-count N` — minimum recurrence count to treat an issue as a pattern (default: 3)
- `--apply` — write the generated skill amendment to `skills/discovered/<task_type>-<datestamp>.md`; without this flag the script prints to stdout (dry-run)

Auto-trigger: `scripts/capture-outcome.sh` fires `learn.sh --apply` in the background (via `disown`) whenever the total outcome count reaches a non-zero multiple of 10. No manual intervention needed.

### skills/discovered/

Auto-generated skill amendments land in `skills/discovered/`. Each file is named `<task_type>-<YYYYMMDD>.md` and contains LLM-proposed additions to the relevant standarts file. The planner should scan this folder at session start and incorporate any amendments relevant to the current task domain.

---

## Cross-Repo Dependencies

- `agents/` — Agent role definitions and skill loading logic
- `scripts/` — Automation scripts (capture-outcome.sh, call_ollama.sh)

## Architectural Decisions

- **Learning Loop**: Outcomes are captured on every pipeline run; `/learn` aggregates them into skill updates.
- **Reviewer Role**: Uses a separate role config from `agents/reviewer.md` to avoid biasing planning.

## Known Constraints

- Bash scripts must use `#!/usr/bin/env bash` and `set -euo pipefail`.
- JSON manipulation must use `jq`; no manual string parsing.
- Temp files must use `mktemp` and clean up via `trap`.
