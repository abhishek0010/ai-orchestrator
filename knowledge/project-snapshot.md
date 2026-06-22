# ai-orchestrator — Project Snapshot

> Auto-generated reference for cloud agents. Describes the live architecture, pain points, and integration surface. Update when major structural changes land.

## Stack

- **Runtime**: Node.js + TypeScript (ESM, `src/`)
- **Local LLM**: Ollama — `qwen2.5-coder:7b` (quick), `qwen2.5-coder:14b` (full)
- **Host**: Claude Code CLI (slash commands, hooks, MCP)
- **Build**: `tsc`, no bundler

## Pipeline

```text
User goal
  → TriageRouter  (classifies: direct-edit / quick-coder / plugin-route / full-pipeline / architect-first)
  → PlannerSession (planner agent writes .claude/context/task_context.md)
  → Orchestrator  (fans out to coder, unit-tester, doc-writer, devops in parallel)
  → BuildChecker  (tsc / py_compile)
  → parallel Reviewer × changed files
  → APPROVED or fix loop (max 3 retries)

**Core source files** (`src/core/`):

| File | Role |
|------|------|
| `AgentLoop.ts` | Main event loop — polls GoalQueue, drives the pipeline |
| `Orchestrator.ts` | Fans tasks to domain agents, handles dependency order |
| `GoalQueue.ts` | SQLite-backed goal queue with stale-reset |
| `PlannerSession.ts` | Spawns planner agent, writes task_context.md |
| `TriageRouter.ts` | Reads triage_ts.md, returns one of 5 routes |
| `ToolRunner.ts` | Executes MCP tool calls on behalf of agents |
| `HeadroomBridge.ts` | Wraps `headroom compress --stdin` for token reduction |
| `ContextPruner.ts` | Removes low-priority context blocks |
| `DiffCompressor.ts` | Compresses git diffs before passing to reviewer |
| `BuildChecker.ts` | Runs tsc/py_compile, returns structured errors |
| `DependencyGraph.ts` | Tracks agent task dependencies |
| `ExoRunner.ts` | Distributed runner for multi-node setups |

## Agents (`agents/`)

| Agent | Trigger / Role |
|-------|---------------|
| `planner` | First — creates task_context.md from task description |
| `coder` | Main code generation (calls Ollama) |
| `quick-coder` | Small focused changes (qwen2.5-coder:7b) |
| `reviewer` | Reviews changed files against standards |
| `commit` | Stages, writes commit message, optional push |
| `debugger` | 5-Whys RCA + minimal fix |
| `architect` | System design, refactoring, ADRs |
| `devops` | CI/CD, Docker, K8s, AWS |
| `security-auditor` | OWASP Top 10, secrets, CVE audit |
| `context-manager` | Token budget tracking, progressive loading, compaction |
| `performance-monitor` | Token metrics, latency, workflow efficiency |
| `error-coordinator` | Multi-agent error recovery, circuit breaker |
| `triage-ts` | Classifies task → one of 5 routes |
| `doc-writer` | Markdown docs only, never code |
| `qa-orchestrator` | Test strategy, failure analysis |
| `ui-designer` | UI/UX, color, typography |
| `ui-tester` | E2E, Playwright, visual regression |
| `unit-tester` | Unit tests, mocking, edge cases |
| `api-tester` | Contract tests, schema validation |

## Skills (`skills/`)

Core language standards (auto-detected by indicator file):
`typescript`, `python`, `bash`, `frontend-design`, `flutter`, `swift`, `c`

Specialized (manual trigger):
`llm-integration`, `prompt-engineering`, `mcp-development`, `microservices-design`,
`api-design-patterns`, `authentication-patterns`, `security-hardening`,
`docker-best-practices`, `kubernetes-operations`, `aws-cloud-patterns`, `ci-cd-pipelines`,
`websocket-realtime`, `performance-optimization`, `git-advanced`, `root-cause-analysis`,
`first-principles`, `graphify`, `codebase-memory`, `ui-ux-pro-max`

Auto-generated patterns: `skills/discovered/*.md` (written by learn.sh from outcomes.jsonl)

## Plugins (`plugins/`)

`accessibility`, `ai-engineering`, `api-architect`, `committer`, `database-tools`,
`debugger`, `docker-helper`, `documentation`, `k8s-helper`, `orchestrator`,
`python-expert`, `qa-tools`, `refactor-engine`, `release-manager`, `reviewer`,
`security-guidance`

## MCP Integrations (active)

| Server | Purpose |
|--------|---------|
| `codebase-memory-mcp` | Code knowledge graph — `search_graph`, `trace_path`, `get_architecture`, `detect_changes` |
| `playwright` | Browser automation for UI testing |
| `higgsfield` | Video/image generation |

## Knowledge Base (`knowledge/`)

| File | Role |
|------|------|
| `embeddings.jsonl` | Semantic embeddings of past task outcomes |
| `outcomes.jsonl` | Raw task outcomes — input to `scripts/learn.sh` |
| `context-index.md` | Cross-project dependencies and architectural decisions |

## Token Reduction Stack

1. `HeadroomBridge` — wraps `headroom compress --stdin` (60-95% token reduction on tool output)
2. `ContextPruner` — removes low-priority blocks when budget is tight
3. `DiffCompressor` — strips noise from git diffs before reviewer sees them
4. `codebase-memory-mcp` — replaces file-by-file grep with sub-ms graph queries

## Known Pain Points (active improvement areas)

1. **No verify→retry loop** — `AgentLoop.ts` has max 3 retries but no structured FSM; `error-coordinator.md` documents strategies but they're manual
2. **Flat knowledge base** — `outcomes.jsonl` is append-only; no BM25 search, no decay weighting for stale entries
3. **TriageRouter is rule-based** — reads a markdown file, no learned routing from past outcomes
4. **HeadroomBridge is optional** — if `headroom` binary isn't installed, falls back silently to uncompressed output
5. **No cross-session memory** — each AgentLoop session starts cold; context-manager compacts within session only
