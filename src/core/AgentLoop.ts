import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { GoalQueue } from './GoalQueue.js';
import { Orchestrator } from './Orchestrator.js';
import { runBuildCheck } from './BuildChecker.js';
import { TriageAgent } from '../agents/TriageAgent.js';
import { AgentRunner } from '../agents/AgentRunner.js';
import { KNOWN_DOMAINS, KNOWN_ROLES } from '../types/index.js';
import type { AgentDomain, Goal } from '../types/index.js';

const DEFAULT_POLL_MS = 10_000;
const DEFAULT_CONFIG = 'llm-config.json';

const CONTEXT_MARKER_BEGIN = '---BEGIN TASK_CONTEXT---';
const CONTEXT_MARKER_END = '---END TASK_CONTEXT---';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class AgentLoop {
  private readonly queue: GoalQueue;
  private readonly runner: AgentRunner;
  private readonly projectRoot: string;
  private readonly contextDir: string;
  private readonly pollMs: number;
  private active = false;

  constructor(projectRoot: string, pollMs = DEFAULT_POLL_MS) {
    this.projectRoot = resolve(projectRoot);
    this.contextDir = join(this.projectRoot, '.claude/context');
    this.pollMs = pollMs;
    this.queue = new GoalQueue(this.projectRoot);
    this.runner = new AgentRunner();
    mkdirSync(this.contextDir, { recursive: true });
  }

  start(): void {
    const stale = this.queue.resetStale();
    if (stale > 0) {
      process.stderr.write(`[agent-loop] reset ${stale} stale goal(s) to pending\n`);
    }

    this.active = true;
    process.on('SIGINT', () => { this.active = false; });
    process.on('SIGTERM', () => { this.active = false; });

    process.stderr.write(
      `[agent-loop] started — polling every ${this.pollMs / 1000}s (Ctrl+C to stop)\n`,
    );

    void this.loop();
  }

  private async loop(): Promise<void> {
    while (this.active) {
      const goal = this.queue.nextPending();
      if (goal !== undefined) {
        const claimed = this.queue.claim(goal.id);
        if (claimed !== undefined) {
          await this.processGoal(claimed);
        }
      } else {
        process.stderr.write('[agent-loop] no pending goals — waiting\n');
        await sleep(this.pollMs);
      }
    }
    process.stderr.write('[agent-loop] stopped\n');
  }

  private async processGoal(goal: Goal): Promise<void> {
    process.stderr.write(`[agent-loop] goal ${goal.id.slice(0, 8)}: ${goal.description}\n`);

    try {
      // Step 1: triage — determine which domains this task touches
      const domains = await this.resolveDomains(goal);
      if (domains.length === 0) {
        this.queue.fail(goal.id, 'triage returned no valid domains');
        return;
      }
      process.stderr.write(`[agent-loop] domains: ${domains.join(', ')}\n`);

      // Step 2: planner — build rich task_context.md (same as /implement flow)
      const planOk = await this.runPlanner(goal.description, domains);
      if (!planOk) {
        this.queue.fail(goal.id, 'planner failed to produce task_context.md');
        return;
      }

      // Step 3: build check before code generation
      const buildResult = await runBuildCheck(this.projectRoot);
      if (!buildResult.passed) {
        this.queue.fail(goal.id, `build check failed:\n${buildResult.stderr}`);
        return;
      }

      // Step 4: coder + reviewer (standard orchestrator pipeline)
      const configPath = join(this.projectRoot, DEFAULT_CONFIG);
      const orchestrator = new Orchestrator(configPath, this.contextDir, this.projectRoot);
      const { agentResults, reviewOutcome } = await orchestrator.run(domains);

      const summary = agentResults
        .map(r => `${r.domain}[${r.status}]: ${r.changedFiles.join(', ') || '(no files)'}`)
        .join('\n');

      if (reviewOutcome.passed) {
        this.queue.complete(goal.id, summary);
        process.stderr.write(`[agent-loop] goal ${goal.id.slice(0, 8)} — done\n`);
      } else {
        const failed = reviewOutcome.failedDomains.join(', ');
        this.queue.fail(goal.id, `review failed for: ${failed}\n${summary}`);
        process.stderr.write(`[agent-loop] goal ${goal.id.slice(0, 8)} — review failed\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.queue.fail(goal.id, msg);
      process.stderr.write(`[agent-loop] goal ${goal.id.slice(0, 8)} error: ${msg}\n`);
    }
  }

  /**
   * Runs the planner role via local LLM with embedded project context
   * (project_overview.md + file tree + coding standards).
   * This mirrors the /implement flow planner step, adapted for tool-less execution.
   * The LLM must output task_context.md content between CONTEXT_MARKER_BEGIN/END.
   * Returns true if a non-empty task_context.md was written.
   */
  private async runPlanner(description: string, domains: AgentDomain[]): Promise<boolean> {
    process.stderr.write('[agent-loop] running planner\n');

    const prompt = this.buildPlannerPrompt(description, domains);
    const tmpDir = mkdtempSync(join(tmpdir(), 'agent-loop-planner-'));

    try {
      const promptFile = join(tmpDir, 'planner_prompt.txt');
      writeFileSync(promptFile, prompt, 'utf8');

      const result = await this.runner.run(KNOWN_ROLES.planner, promptFile);
      if (!result.ok) {
        process.stderr.write(`[agent-loop] planner LLM error: ${result.error}\n`);
        return false;
      }

      const taskContext = this.extractTaskContext(result.output);
      if (taskContext.trim().length === 0) {
        process.stderr.write('[agent-loop] planner output did not contain task_context markers\n');
        return false;
      }

      writeFileSync(join(this.contextDir, 'task_context.md'), taskContext, 'utf8');
      process.stderr.write('[agent-loop] planner wrote task_context.md\n');
      return true;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /** Extracts content between CONTEXT_MARKER_BEGIN and CONTEXT_MARKER_END from planner output. */
  private extractTaskContext(output: string): string {
    const begin = output.indexOf(CONTEXT_MARKER_BEGIN);
    const end = output.indexOf(CONTEXT_MARKER_END);
    if (begin === -1 || end === -1 || end <= begin) return '';
    return output.slice(begin + CONTEXT_MARKER_BEGIN.length, end).trim() + '\n';
  }

  /**
   * Builds a rich planning prompt that embeds project context so the planner LLM
   * can produce a proper task_context.md without live tool access.
   */
  private buildPlannerPrompt(description: string, domains: AgentDomain[]): string {
    const overview = this.readFileOrEmpty(join(this.contextDir, 'project_overview.md'));
    const fileTree = this.getFileTree();
    const standards = this.readCodingStandards();

    return [
      '## Goal',
      description,
      '',
      '## Target Domains',
      domains.map(d => `- ${d}`).join('\n'),
      '',
      '## Project Overview',
      overview || '(project_overview.md not found)',
      '',
      '## Source Tree',
      '```',
      fileTree,
      '```',
      '',
      ...(standards.length > 0 ? ['## Coding Standards (excerpt)', standards, ''] : []),
      '## Instructions',
      'You do NOT have live tool access. Use ONLY the context above to write the plan.',
      'Follow the task_context.md format from your system prompt exactly.',
      `Output the complete task_context.md content between these exact markers (no extra text outside):`,
      CONTEXT_MARKER_BEGIN,
      '# Task Context',
      '...',
      CONTEXT_MARKER_END,
    ].join('\n');
  }

  private readFileOrEmpty(filePath: string): string {
    if (!existsSync(filePath)) return '';
    try {
      return readFileSync(filePath, 'utf8');
    } catch {
      return '';
    }
  }

  private getFileTree(): string {
    const result = spawnSync('find', ['src', '-type', 'f', '-name', '*.ts'], {
      cwd: this.projectRoot,
      encoding: 'utf8',
    });
    return result.stdout?.trim() ?? '';
  }

  private readCodingStandards(): string {
    const standardsPath = join(this.projectRoot, '.claude/skills/ts-code-standarts.md');
    if (!existsSync(standardsPath)) return '';
    try {
      const content = readFileSync(standardsPath, 'utf8');
      return content.slice(0, 3000);
    } catch {
      return '';
    }
  }

  private async resolveDomains(goal: Goal): Promise<AgentDomain[]> {
    if (goal.domains !== undefined && goal.domains.length > 0) {
      return goal.domains.filter(
        (d): d is AgentDomain => (KNOWN_DOMAINS as readonly string[]).includes(d),
      );
    }

    const agent = new TriageAgent(this.runner, this.contextDir, this.projectRoot);
    const result = await agent.analyze(goal.description);
    return [...result.domains];
  }
}
