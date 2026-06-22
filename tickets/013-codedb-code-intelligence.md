# 013 — Integrate codedb: native code-intelligence bridge in ToolRunner

**Source:** [justrach/codedb](https://github.com/justrach/codedb) ⭐1335 · Zig
**Date:** 2026-06-22 | **Effort:** Medium (days) | **Risk:** Low

## Problem

The planner currently finds code via filesystem tools — reading files, grepping — which produces large prompt payloads and slow turn-arounds. `src/core/ToolRunner.ts` has no semantic code-lookup capability.

## What codedb provides

Fast, language-agnostic code-intelligence engine via a native binary. Supports: tree, outline, search, callers/callees, dependency graph, and a composable `codedb query "<task>"` RPC that returns structured JSON. Zero runtime dependencies.

## Implementation

**File:** `src/core/ToolRunner.ts`

Add tool case `codedb_query` that spawns the binary as a subprocess:

```ts
case 'codedb_query': {
    const { task } = args as { task: string };
    const { stdout } = await execFilePromise('codedb', ['query', task], { maxBuffer: 10_000_000 });
    return JSON.parse(stdout);
}
```

**File:** `agents/planner.md`

Add `codedb_query` to the list of available tools for structural look-ups, so the planner prefers it over file-by-file scanning.

## Acceptance Criteria

- [ ] `ToolRunner.ts` handles `codedb_query` tool case
- [ ] Binary absence is caught gracefully — falls back to grep/read
- [ ] Planner uses `codedb_query` for symbol and caller look-ups
- [ ] Token usage for code-lookup tasks measurably reduced

## References

- OSS Report: `knowledge/github-monitoring/2026-06-22.md`
- Source: https://github.com/justrach/codedb
