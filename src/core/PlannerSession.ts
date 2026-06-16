import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { callLlmWithTools } from './LlmHttpClient.js';
import { ToolRunner, PLANNER_TOOLS } from './ToolRunner.js';
import type { ConversationMessage } from './LlmHttpClient.js';
import type { ToolCall } from './ToolRunner.js';

const MAX_TURNS = 20;
const TIMEOUT_MS = 5 * 60 * 1000;

type Candidate = {
  readonly url: string;
  readonly model: string;
  readonly label: string;
  readonly authToken?: string;
};

export type PlannerResult =
  | { readonly ok: true; readonly taskContextWritten: true }
  | { readonly ok: false; readonly error: string };

/**
 * Runs the planner agent loop with real tool access.
 * The planner can read files, list dirs, grep, and write task_context.md.
 * Mirrors what the /implement flow does when the planner Claude Code subagent runs.
 */
export class PlannerSession {
  private readonly projectRoot: string;
  private readonly contextDir: string;
  private readonly systemPrompt: string;

  constructor(projectRoot: string, contextDir: string, systemPrompt: string) {
    this.projectRoot = projectRoot;
    this.contextDir = contextDir;
    this.systemPrompt = systemPrompt;
  }

  async run(userMessage: string): Promise<PlannerResult> {
    const candidates = this.resolveCandidates();
    if (candidates.length === 0) {
      return { ok: false, error: 'no LLM endpoint configured for planner role' };
    }

    for (const candidate of candidates) {
      const result = await this.tryCandidate(candidate, userMessage);
      if (result.ok) return result;
      process.stderr.write(`[planner-session] ${candidate.label} failed: ${result.error} — trying next\n`);
    }

    return { ok: false, error: 'all planner candidates failed' };
  }

  private async tryCandidate(candidate: Candidate, userMessage: string): Promise<PlannerResult> {
    const runner = new ToolRunner(this.projectRoot, this.contextDir);
    const messages: ConversationMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: userMessage },
    ];

    process.stderr.write(
      `[planner-session] ${candidate.label} model=${candidate.model} — starting (max ${MAX_TURNS} turns)\n`,
    );

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const result = await callLlmWithTools({
        url: candidate.url,
        model: candidate.model,
        messages,
        tools: PLANNER_TOOLS,
        timeoutMs: TIMEOUT_MS,
        label: candidate.label,
        ...(candidate.authToken !== undefined ? { authToken: candidate.authToken } : {}),
      });

      if (!result.ok) {
        return { ok: false, error: result.error };
      }

      if (result.type === 'text') {
        // Model responded with text instead of using write_task_context — treat as done
        // if task_context.md was already written in a previous turn
        if (runner.getTaskContext() !== undefined) {
          process.stderr.write(`[planner-session] done (text response after context written, turn ${turn + 1})\n`);
          return { ok: true, taskContextWritten: true };
        }
        process.stderr.write(`[planner-session] model returned text without calling write_task_context\n`);
        return { ok: false, error: 'planner did not call write_task_context' };
      }

      // Execute all tool calls
      messages.push(result.message);
      const toolResults = this.executeToolCalls(result.tool_calls, runner);
      for (const tr of toolResults) {
        messages.push(tr);
      }

      // Check if write_task_context was called
      if (runner.getTaskContext() !== undefined) {
        process.stderr.write(`[planner-session] done (write_task_context called, turn ${turn + 1})\n`);
        return { ok: true, taskContextWritten: true };
      }

      process.stderr.write(`[planner-session] turn ${turn + 1}: executed ${result.tool_calls.length} tool call(s)\n`);
    }

    return { ok: false, error: `planner exceeded ${MAX_TURNS} turns without writing task_context.md` };
  }

  private executeToolCalls(
    calls: readonly ToolCall[],
    runner: ToolRunner,
  ): ConversationMessage[] {
    return calls.map(call => {
      const output = runner.execute(call);
      const toolResult: ConversationMessage = {
        role: 'tool',
        tool_call_id: call.id,
        content: output,
      };
      return toolResult;
    });
  }

  /**
   * Resolves LLM candidates for the 'planner' role in priority order:
   * Cerebras → FreeLLM → localhost:11434
   */
  private resolveCandidates(): Candidate[] {
    const cfg = this.readLlmConfig();
    const candidates: Candidate[] = [];

    const cerebrasKey = process.env['CEREBRAS_API_KEY'] ?? '';
    if (cerebrasKey.length > 0 && cfg !== null) {
      const model = (cfg['cerebras_api'] as Record<string, unknown> | undefined)?.['planner'];
      if (typeof model === 'string' && model.length > 0) {
        candidates.push({
          url: 'https://api.cerebras.ai/v1/chat/completions',
          model,
          label: 'Cerebras',
          authToken: cerebrasKey,
        });
      }
    }

    const freellmKey = process.env['FREELLM_API_KEY'] ?? process.env['FREE_API_KEY'] ?? '';
    if (freellmKey.length > 0 && cfg !== null) {
      const freeUrl = cfg['free_api_url'];
      const model = (cfg['free_api'] as Record<string, unknown> | undefined)?.['planner'];
      if (typeof freeUrl === 'string' && typeof model === 'string') {
        candidates.push({
          url: freeUrl,
          model,
          label: 'FreeLLM',
          authToken: freellmKey,
        });
      }
    }

    const fallbackModel = this.readFallbackModel(cfg);
    if (fallbackModel !== null) {
      candidates.push({
        url: 'http://localhost:11434/v1/chat/completions',
        model: fallbackModel,
        label: 'localhost:11434',
      });
    }

    return candidates;
  }

  private readLlmConfig(): Record<string, unknown> | null {
    const paths = [
      join(this.projectRoot, 'llm-config.json'),
      join(homedir(), '.claude', 'llm-config.json'),
    ];
    for (const p of paths) {
      if (!existsSync(p)) continue;
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
        if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
          return raw as Record<string, unknown>;
        }
      } catch { /* try next */ }
    }
    return null;
  }

  private readFallbackModel(cfg: Record<string, unknown> | null): string | null {
    if (cfg === null) return null;
    const models = cfg['models'];
    if (typeof models !== 'object' || models === null) return null;
    const model = (models as Record<string, unknown>)['planner'];
    return typeof model === 'string' && model.trim().length > 0 ? model.trim() : null;
  }
}
