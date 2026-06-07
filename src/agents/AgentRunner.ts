import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Role, RunResult } from '../types/index.js';

const CALL_OLLAMA_SCRIPT = join(homedir(), '.claude', 'call_ollama.sh');

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

export class AgentRunner {
  private readonly callOllamaScript: string;
  private readonly timeoutMs: number;

  constructor(timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
    this.callOllamaScript = CALL_OLLAMA_SCRIPT;

    if (!existsSync(this.callOllamaScript)) {
      throw new Error(`AgentRunner: required script not found: ${this.callOllamaScript}`);
    }
  }

  /**
   * Calls call_ollama.sh with up to MAX_RETRIES retries on failure.
   * Sleeps attempt * RETRY_DELAY_MS ms between attempts.
   * Returns { ok: false } immediately if the prompt file is missing.
   */
  async run(role: Role, promptFile: string, contextFile?: string): Promise<RunResult> {
    if (!existsSync(promptFile)) {
      return { ok: false, error: `prompt file not found: ${promptFile}` };
    }

    let lastResult: RunResult = { ok: false, error: 'no attempts made' };

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        process.stderr.write(`[agent-runner] retry ${attempt}/${MAX_RETRIES} for role="${role}"\n`);
        await new Promise<void>(r => setTimeout(r, attempt * RETRY_DELAY_MS));
      }
      lastResult = await this.runOnce(role, promptFile, contextFile);
      if (lastResult.ok) return lastResult;
    }

    return lastResult;
  }

  /**
   * Single attempt: spawns call_ollama.sh and collects stdout/stderr.
   * Returns stdout on success or error message on failure.
   */
  private runOnce(role: Role, promptFile: string, contextFile?: string): Promise<RunResult> {
    const args: string[] = [this.callOllamaScript, '--role', role, '--prompt-file', promptFile];

    if (contextFile !== undefined) {
      args.push('--context-file', contextFile);
    }

    return new Promise(resolve => {
      const proc = spawn('bash', args);
      let stdout = '';
      let stderr = '';
      let settled = false;
      let stdoutTruncated = false;
      let stderrTruncated = false;

      const settle = (result: RunResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        settle({ ok: false, error: `timeout after ${this.timeoutMs / 1000}s` });
      }, this.timeoutMs);

      proc.stdout.on('data', (chunk: Buffer) => {
        if (stdoutTruncated) return;
        if (stdout.length + chunk.length > MAX_OUTPUT_BYTES) {
          stdoutTruncated = true;
          process.stderr.write(`[agent-runner] ${role} stdout truncated at 10 MB\n`);
          return;
        }
        stdout += chunk.toString();
      });
      proc.stderr.on('data', (chunk: Buffer) => {
        if (stderrTruncated) return;
        if (stderr.length + chunk.length > MAX_OUTPUT_BYTES) {
          stderrTruncated = true;
          return;
        }
        stderr += chunk.toString();
      });

      proc.on('close', code => {
        clearTimeout(timer);
        if (code === 0) {
          settle({ ok: true, output: stdout.trim() });
        } else {
          settle({
            ok: false,
            error: stderr.trim() || `call_ollama.sh exited with code ${String(code)}`,
          });
        }
      });

      proc.on('error', err => {
        clearTimeout(timer);
        settle({ ok: false, error: err.message });
      });
    });
  }
}
