# Knowledge Index

_Update this file when you add a new repo or discover a cross-project dependency._
_Planner reads this file at the start of every task if it exists._

---

## Projects

| Repo | Path | Purpose | Branch |
|---|---|---|---|
| ai-orchestrator | ~/Projects/ai-orchestrator | Claude Code multi-agent orchestration framework | main |

_Add rows for every repo this codebase interacts with._

---

## Cross-Repo Dependencies

_List any shared libraries, shared config, or runtime dependencies between repos._

| From | To | Type | Notes |
|---|---|---|---|
| — | — | — | _none yet_ |

---

## Architectural Decisions

_Record decisions that span multiple repos or that are non-obvious from the code._

| Date | Decision | Reason | Affected Repos |
|---|---|---|---|
| 2026-05-31 | Ollama-first, Claude fallback | Minimize API spend; local models handle codegen | ai-orchestrator |
| 2026-05-31 | File-path handoff between agents | Prevent context explosion in multi-step pipelines | ai-orchestrator |

---

## Known Constraints

- Never mock Ollama in tests — all agent tests require a live local model
- README.md is managed by doc-writer agent only (enforced by PreToolUse hook)
- llm-config.json models can be changed at runtime — no restart needed

---

## How to Update

Run the update script to refresh the index:

```bash
bash scripts/update-knowledge.sh
```

Or edit this file manually. The planner reads it once per session — stale info causes wrong assumptions.
