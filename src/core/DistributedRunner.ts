import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { callLlmEndpoint } from './LlmHttpClient.js';
import type { ClusterConfig, Role, RunResult } from '../types/index.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const FALLBACK_HOST = 'localhost';
const FALLBACK_PORT = 11434;

// Retry delays for transient connection failures (model loading, brief busy periods)
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000] as const;

type Candidate = {
  readonly url: string;
  readonly model: string;
  readonly label: string;
  readonly authToken?: string;
  /** false = disable thinking mode for qwen3 on Ollama */
  readonly think?: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Inference runner that dispatches each role to the first matching cluster node.
 * Implements the same run() interface as AgentRunner and ExoRunner.
 * Falls back to localhost:11434 with the model from llm-config.json when no
 * node claims the requested role.
 */
export class DistributedRunner {
  private readonly config: ClusterConfig;
  private readonly timeoutMs: number;
  private readonly projectRoot: string;

  constructor(config: ClusterConfig, projectRoot: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.config = config;
    this.projectRoot = resolve(projectRoot);
    this.timeoutMs = timeoutMs;
  }

  /**
   * Routes the role to all candidate nodes in order; falls over to the next
   * candidate automatically on connection/timeout errors.
   * Returns RunResult — never throws.
   */
  async run(role: Role, promptFile: string, contextFile?: string): Promise<RunResult> {
    if (!existsSync(promptFile)) {
      return { ok: false, error: `prompt file not found: ${promptFile}` };
    }

    if (contextFile !== undefined && !existsSync(contextFile)) {
      return { ok: false, error: `context file not found: ${contextFile}` };
    }

    return this.runOnce(role, promptFile, contextFile);
  }

  /**
   * Reads prompt/context files, resolves all candidate nodes, then tries each in order.
   * On connection/timeout errors the next candidate is tried automatically.
   * Non-connection errors (API 4xx/5xx, bad JSON) stop immediately.
   */
  private async runOnce(role: Role, promptFile: string, contextFile?: string): Promise<RunResult> {
    const systemPrompt = this.readSystemPrompt(role);
    if (systemPrompt === null) {
      return { ok: false, error: `system prompt not found for role: ${role}` };
    }

    let userContent: string;
    try {
      userContent = readFileSync(promptFile, 'utf8');
    } catch (err) {
      return { ok: false, error: `failed to read prompt file: ${String(err)}` };
    }

    if (contextFile !== undefined) {
      try {
        const ctx = readFileSync(contextFile, 'utf8');
        userContent = `${userContent}\n\n---\n\n${ctx}`;
      } catch (err) {
        return { ok: false, error: `failed to read context file: ${String(err)}` };
      }
    }

    const candidates = this.resolveCandidates(role);
    if (candidates.length === 0) {
      return {
        ok: false,
        error: `no node found for role "${role}" and llm-config.json fallback unavailable`,
      };
    }

    let lastResult: RunResult = { ok: false, error: 'no attempts made' };

    for (let ci = 0; ci < candidates.length; ci++) {
      const candidate = candidates[ci];
      if (candidate === undefined) continue;

      const { label } = candidate;

      // Retry the same node on transient connection failures (model loading, brief busy period).
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        if (attempt > 0) {
          const delay = RETRY_DELAYS_MS[attempt - 1] ?? 30_000;
          process.stderr.write(
            `[distributed-runner] ${label} unreachable — retry ${attempt}/${RETRY_DELAYS_MS.length} in ${delay / 1000}s\n`,
          );
          await sleep(delay);
        }

        process.stderr.write(
          `[distributed-runner] role="${role}" -> ${label} model="${candidate.model}"${attempt > 0 ? ` (attempt ${attempt + 1})` : ''}\n`,
        );

        lastResult = await callLlmEndpoint({
          url: candidate.url,
          model: candidate.model,
          systemPrompt,
          userContent,
          timeoutMs: this.timeoutMs,
          label,
          ...(candidate.authToken !== undefined ? { authToken: candidate.authToken } : {}),
          ...(candidate.think !== undefined ? { think: candidate.think } : {}),
        });
        if (lastResult.ok) return lastResult;

        const isUnreachable = lastResult.error.includes('unreachable');
        if (isUnreachable && attempt < RETRY_DELAYS_MS.length) {
          continue; // retry same node
        }
        break; // non-connection error or retries exhausted
      }

      // Fall over on connection errors or rate limits — both mean "try next provider".
      const shouldFallover =
        lastResult.error.includes('unreachable') || lastResult.error.includes('429');
      if (shouldFallover && ci < candidates.length - 1) {
        process.stderr.write(
          `[distributed-runner] ${label} unavailable — trying next node\n`,
        );
        continue;
      }
      break;
    }

    return lastResult;
  }

  /**
   * Returns all candidates in priority order:
   * 1. Cerebras (if CEREBRAS_API_KEY set and role configured in llm-config.json)
   * 2. FreeLLM  (if FREELLM_API_KEY set and free_api_url configured)
   * 3. Cluster nodes from exo-config.json (in config order)
   * 4. llm-config.json fallback (localhost:11434)
   */
  private resolveCandidates(role: Role): Candidate[] {
    const candidates: Candidate[] = [];
    const cfg = this.readLlmConfig();

    // 1. Cerebras
    const cerebrasKey = process.env['CEREBRAS_API_KEY'] ?? '';
    if (cerebrasKey.length > 0 && cfg !== null) {
      const cerModel =
        (cfg['cerebras_api'] as Record<string, unknown> | undefined)?.[role];
      if (typeof cerModel === 'string' && cerModel.length > 0) {
        candidates.push({
          url: 'https://api.cerebras.ai/v1/chat/completions',
          model: cerModel,
          label: 'Cerebras',
          authToken: cerebrasKey,
        });
      }
    }

    // 2. FreeLLM
    const freellmKey = process.env['FREELLM_API_KEY'] ?? process.env['FREE_API_KEY'] ?? '';
    if (freellmKey.length > 0 && cfg !== null) {
      const freeUrl = cfg['free_api_url'];
      const freeModel = (cfg['free_api'] as Record<string, unknown> | undefined)?.[role];
      if (typeof freeUrl === 'string' && freeUrl.length > 0 && typeof freeModel === 'string') {
        candidates.push({
          url: freeUrl,
          model: freeModel,
          label: 'FreeLLM',
          authToken: freellmKey,
        });
      }
    }

    // 3. Cluster nodes from exo-config.json
    for (const node of this.config.nodes) {
      const model = node.roles[role];
      if (model !== undefined) {
        candidates.push({
          url: `http://${node.host}:${node.port}/v1/chat/completions`,
          model,
          label: `${node.name ?? node.host}:${node.port}`,
          // Disable thinking mode for qwen3 to avoid token waste on code tasks
          ...(model.toLowerCase().includes('qwen3') ? { think: false as const } : {}),
        });
      }
    }

    // 4. llm-config.json fallback (localhost:11434)
    const fallbackModel = this.readFallbackModel(role);
    if (fallbackModel !== null) {
      const fallbackUrl = `http://${FALLBACK_HOST}:${FALLBACK_PORT}/v1/chat/completions`;
      const alreadyPresent = candidates.some(c => c.url === fallbackUrl);
      if (!alreadyPresent) {
        candidates.push({
          url: fallbackUrl,
          model: fallbackModel,
          label: `${FALLBACK_HOST}:${FALLBACK_PORT}`,
          ...(fallbackModel.toLowerCase().includes('qwen3') ? { think: false as const } : {}),
        });
      }
    }

    if (candidates.length === 0) {
      process.stderr.write(
        `[distributed-runner] role "${role}" not found in any provider\n`,
      );
    }

    return candidates;
  }

  /**
   * Reads ~/.claude/llm-config.json as a raw object. Returns null on any error.
   */
  private readLlmConfig(): Record<string, unknown> | null {
    const configPath = join(homedir(), '.claude', 'llm-config.json');

    // Also check project root for local override
    const localConfig = join(this.projectRoot, 'llm-config.json');
    const cfgPath = existsSync(localConfig) ? localConfig : configPath;
    if (!existsSync(cfgPath)) return null;

    try {
      const raw = readFileSync(cfgPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Reads the model for a role from ~/.claude/llm-config.json.
   * Returns null if the file is absent, unreadable, or the role is not listed.
   */
  private readFallbackModel(role: Role): string | null {
    const configPath = join(homedir(), '.claude', 'llm-config.json');
    if (!existsSync(configPath)) return null;

    let raw: string;
    try {
      raw = readFileSync(configPath, 'utf8');
    } catch {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const models = (parsed as Record<string, unknown>)['models'];
    if (typeof models !== 'object' || models === null || Array.isArray(models)) return null;
    const model = (models as Record<string, unknown>)[role];
    if (typeof model !== 'string' || model.trim().length === 0) return null;
    return model.trim();
  }

  /**
   * Resolves the system prompt markdown for the given role.
   * Search order: ~/.claude/agents/{role}.md then {projectRoot}/agents/{role}.md.
   * Returns null if neither path exists or both fail to read.
   */
  private readSystemPrompt(role: Role): string | null {
    const globalPath = join(homedir(), '.claude', 'agents', `${role}.md`);
    if (existsSync(globalPath)) {
      try {
        return readFileSync(globalPath, 'utf8');
      } catch {
        // fall through to local path
      }
    }

    const localPath = join(this.projectRoot, 'agents', `${role}.md`);
    if (existsSync(localPath)) {
      try {
        return readFileSync(localPath, 'utf8');
      } catch {
        return null;
      }
    }

    return null;
  }
}

