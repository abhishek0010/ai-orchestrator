# 014 — Add PolicyEngine: declarative tool-call safety gates in AgentLoop

**Source:** [omnigent-ai/omnigent](https://github.com/omnigent-ai/omnigent) ⭐4442 · Python
**Date:** 2026-06-22 | **Effort:** Medium (days) | **Risk:** Medium

## Problem

`src/core/AgentLoop.ts` has no systematic way to pause or reject risky tool calls (writing large files, invoking external commands, spend overruns). Any policy logic today is ad-hoc in agent prompts — not enforced at runtime.

## What omnigent provides

Declarative policy framework: YAML files define, enforce, and audit hard limits on agent actions before they execute. Pattern: `check(action, args) → allowed | blocked + reason`.

## Implementation

**File:** `src/core/PolicyEngine.ts` (new)

Thin TypeScript port of omnigent's `policy.py`. Loads YAML policies at startup, exposes:

```ts
export async function check(action: string, args: Record<string, unknown>): Promise<{ allowed: boolean; reason?: string }>
```

**File:** `src/core/AgentLoop.ts`

Before each `ToolRunner.execute()` call:

```ts
const { allowed, reason } = await PolicyEngine.check(toolName, toolArgs);
if (!allowed) {
    logger.warn(`Policy blocked ${toolName}: ${reason}`, toolArgs);
    continue; // skip this tool invocation
}
```

**File:** `settings.json`

```json
"policyFiles": [".claude/policies/*.yaml"]
```

**File:** `.claude/policies/default.yaml` (new example)

```yaml
rules:
  - action: Bash
    block_if: args.command matches "rm -rf"
  - action: Write
    block_if: args.file_path matches "/etc/*"
```

## Acceptance Criteria

- [ ] `PolicyEngine.ts` loads and parses YAML policies from `settings.json` path
- [ ] `AgentLoop.ts` calls `PolicyEngine.check` before every tool execution
- [ ] Blocked calls are logged with reason, not silently dropped
- [ ] Fallback "allow-all" mode active when no policy files found (dev safety)
- [ ] At least one example policy file in `.claude/policies/`
- [ ] Unit tests for allow/block decision logic

## References

- OSS Report: `knowledge/github-monitoring/2026-06-22.md`
- Source: https://github.com/omnigent-ai/omnigent
