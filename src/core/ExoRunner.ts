import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { callLlmEndpoint } from './LlmHttpClient.js';
import type { ExoGateway, Role, RunResult } from '../types/index.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class ExoRunner {
  private readonly config: { readonly model: string; readonly gateway: ExoGateway };
  private readonly timeoutMs: number;
  private readonly projectRoot: string;

  constructor(
    config: { readonly model: string; readonly gateway: ExoGateway },
    projectRoot: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.config = config;
    this.projectRoot = resolve(projectRoot);
    this.timeoutMs = timeoutMs;
  }

  async run(role: Role, promptFile: string, contextFile?: string): Promise<RunResult> {
    if (!existsSync(promptFile)) {
      return { ok: false, error: `prompt file not found: ${promptFile}` };
    }

    if (contextFile !== undefined && !existsSync(contextFile)) {
      return { ok: false, error: `context file not found: ${contextFile}` };
    }

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

    const url = `http://${this.config.gateway.host}:${this.config.gateway.port}/v1/chat/completions`;

    return callLlmEndpoint({
      url,
      model: this.config.model,
      systemPrompt,
      userContent,
      timeoutMs: this.timeoutMs,
      label: `${this.config.gateway.host}:${this.config.gateway.port}`,
    });
  }

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
