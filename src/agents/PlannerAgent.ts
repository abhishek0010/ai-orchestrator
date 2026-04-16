import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentDomain, AgentTask } from '../types/index.js';
import type { AgentRunner } from './AgentRunner.js';

const DOMAIN_DEPENDENCIES: Record<AgentDomain, readonly AgentDomain[]> = {
  coder: [],
  'unit-tester': ['coder'],
  'doc-writer': ['coder'],
  devops: ['coder', 'unit-tester', 'doc-writer'],
};

export class PlannerAgent {
  private readonly runner: AgentRunner;
  private readonly contextDir: string;

  constructor(runner: AgentRunner, contextDir: string) {
    this.runner = runner;
    this.contextDir = contextDir;
  }

  /**
   * Creates a planning prompt for the given domain, calls the coder model,
   * writes the result to .claude/context/task_context_<domain>.md,
   * returns an AgentTask with contextFile path and pre-wired dependencies.
   */
  async plan(task: string, domain: AgentDomain): Promise<AgentTask> {
    const contextFile = join(this.contextDir, `task_context_${domain}.md`);
    const tmpDir = mkdtempSync(join(tmpdir(), 'planner-'));
    const promptFile = join(tmpDir, 'prompt.txt');

    const prompt = [
      `## Planning Task for domain: ${domain}`,
      '',
      `Task: ${task}`,
      '',
      `Write a concise implementation plan for the ${domain} agent.`,
      `Focus only on what the ${domain} agent must do.`,
      'Output a markdown plan with: files to change, method signatures, and key logic.',
    ].join('\n');

    writeFileSync(promptFile, prompt, 'utf8');

    let result;
    try {
      result = await this.runner.run('coder', promptFile);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }

    const output = result.ok
      ? result.output
      : `# Plan generation failed for ${domain}\n\nError: ${result.error}`;

    writeFileSync(contextFile, output, 'utf8');

    return {
      domain,
      dependencies: DOMAIN_DEPENDENCIES[domain],
      contextFile,
    };
  }
}
