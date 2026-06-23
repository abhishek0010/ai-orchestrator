import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { GoalQueue } from './GoalQueue.js';
import { Orchestrator } from './Orchestrator.js';
import { runBuildCheck } from './BuildChecker.js';
import { PlannerSession } from './PlannerSession.js';
import { TriageAgent } from '../agents/TriageAgent.js';
import { AgentRunner } from '../agents/AgentRunner.js';
import { ToolRunner } from './ToolRunner.js';
import { KNOWN_DOMAINS } from '../types/index.js';
import type { AgentDomain, Goal } from '../types/index.js';
import * as PolicyEngine from './PolicyEngine.js';
import { MemoryStore } from './MemoryStore.js';

const DEFAULT_POLL_MS = 10_000;
const DEFAULT_CONFIG = 'llm-config.json';
const MAX_RETRY_COUNT = 3;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class AgentLoop {
  private readonly queue: GoalQueue;
  private readonly runner: AgentRunner;
  private readonly projectRoot: string;
  private readonly contextDir: string;
  private readonly agentsDir: string;
  private readonly pollMs: number;
  private readonly toolRunner: ToolRunner;
  private readonly memoryStore: MemoryStore;
  private active = false;

  constructor(projectRoot: string, pollMs = DEFAULT_POLL_MS) {
    this.projectRoot = resolve(projectRoot);
    this.contextDir = join(this.projectRoot, '.claude/context');
    this.agentsDir = join(this.projectRoot, 'agents');
    this.pollMs = pollMs;
    this.queue = new GoalQueue(this.projectRoot);
    this.runner = new AgentRunner();
    this.toolRunner = new ToolRunner(this.projectRoot, this.contextDir);
    this.memoryStore = new MemoryStore(this.projectRoot);
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
      const goal = this.queue.nextReady();
      if (goal === undefined) {
        process.stderr.write('[agent-loop] no ready goals — waiting\n');
        await sleep(this.pollMs);
        continue;
      }
      if (goal.status === 'waiting') {
        process.stderr.write(`[agent-loop] goal ${goal.id.slice(0, 8)} is waiting for human input — skipping\n`);
        await sleep(this.pollMs);
        continue;
      }
      if (goal.deadline && new Date(goal.deadline) < new Date()) {
        process.stderr.write(`[agent-loop] WARN: goal ${goal.id.slice(0, 8)} past deadline (${goal.deadline})\n`);
      }
      const claimed = this.queue.claim(goal.id);
      if (claimed !== undefined) {
        this.toolRunner.setCurrentGoal(claimed.id);
        await this.processGoal(claimed);
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

      // Step 5: ObserveLoop — run tests, handle failures with retries
      const observeLoopPassed = await this.observeLoop(goal, 0);
      if (!observeLoopPassed) {
        this.queue.fail(goal.id, `test retries exhausted\n${summary}`);
        process.stderr.write(`[agent-loop] goal ${goal.id.slice(0, 8)} — observe loop failed\n`);
        return;
      }

      if (reviewOutcome.passed) {
        this.queue.complete(goal.id, summary);
        this.memoryStore.append({
          goalId: goal.id,
          goalDescription: goal.description,
          outcome: 'success',
          reviewerFeedback: summary,
        });
        process.stderr.write(`[agent-loop] goal ${goal.id.slice(0, 8)} — done\n`);
      } else {
        const failed = reviewOutcome.failedDomains.join(', ');
        const failSummary = `review failed for: ${failed}\n${summary}`;
        this.queue.fail(goal.id, failSummary);
        this.memoryStore.append({
          goalId: goal.id,
          goalDescription: goal.description,
          outcome: 'failure',
          reviewerFeedback: failSummary,
        });
        process.stderr.write(`[agent-loop] goal ${goal.id.slice(0, 8)} — review failed\n`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.queue.fail(goal.id, msg);
      process.stderr.write(`[agent-loop] goal ${goal.id.slice(0, 8)} error: ${msg}\n`);
    }
  }

  /**
   * Executes a tool after checking policies.
   * If the policy check disallows the tool, a warning is emitted and execution stops.
   *
   * @param toolName - Name of the tool to execute.
   * @param toolArgs - Arguments supplied to the tool.
   */
  private async executeTool(
    toolName: string,
    toolArgs: Record<string, unknown>,
  ): Promise<void> {
    const { allowed, reason } = await PolicyEngine.check(toolName, toolArgs);
    if (!allowed) {
      process.stderr.write(`[policy] blocked ${toolName}: ${reason} — args: ${JSON.stringify(toolArgs)}\n`);
      return;
    }
    // TODO: place actual tool execution logic here, e.g.,
    // await this.toolRunner.runTool(toolName, toolArgs);
  }

  private async observeLoop(goal: Goal, retryCount: number): Promise<boolean> {
    if (retryCount >= MAX_RETRY_COUNT) {
      process.stderr.write(`[observe-loop] retry budget exhausted (tried ${MAX_RETRY_COUNT} times)\n`);
      return false;
    }

    const testResults = await this.runTestSuite(goal);
    const failures = this.parseFailures(testResults);

    if (failures.length === 0) {
      process.stderr.write('[observe-loop] no failures detected\n');
      return true;
    }

    process.stderr.write(`[observe-loop] found ${failures.length} failure(s), retry ${retryCount + 1}/${MAX_RETRY_COUNT}\n`);

    if (typeof goal.taskContext === 'string') {
      goal.taskContext += `\n\n## Test Failures (Retry ${retryCount + 1})\n${failures.join('\n')}`;
    }

    // Re-run coder with updated context
    await this.coder(goal);

    return await this.observeLoop(goal, retryCount + 1);
  }

  private async runTestSuite(goal: Goal): Promise<string> {
    const testCommand = goal.testCommand ?? 'npm test';
    try {
      return await this.toolRunner.run_command(testCommand);
    } catch (err) {
      return `[error] running test suite: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private parseFailures(testResults: string): string[] {
    const lines = testResults.split('\n');
    const failures: string[] = [];

    for (const line of lines) {
      if (/FAILED|Error:|FAIL|panic:/i.test(line)) {
        failures.push(line.trim());
      }
    }

    return failures;
  }

  private async coder(goal: Goal): Promise<void> {
    const configPath = join(this.projectRoot, DEFAULT_CONFIG);
    const orchestrator = new Orchestrator(configPath, this.contextDir, this.projectRoot);
    await orchestrator.run(['coder']);
  }

  /**
   * Runs the planner as a real agent loop with tool access.
   * The planner reads files, understand the task, and calls write_task_context when done.
   * This replicates the /implement flow planner step.
   */
  private async runPlanner(description: string, domains: AgentDomain[]): Promise<boolean> {
    process.stderr.write('[agent-loop] running planner (tool-access mode)\n');

    const systemPrompt = this.readPlannerSystemPrompt();
    if (systemPrompt === null) {
      process.stderr.write('[agent-loop] planner system prompt not found (agents/planner.md)\n');
      return false;
    }

    const userMessage = [
      '## Task',
      description,
      '',
      '## Target Domains',
      domains.map(d => `- ${d}`).join('\n'),
      '',
      'Read the codebase, understand the task, then call write_task_context with the completed task_context.md.',
    ].join('\n');

    const session = new PlannerSession(this.projectRoot, this.contextDir, systemPrompt);
    const result = await session.run(userMessage);

    if (!result.ok) {
      process.stderr.write(`[agent-loop] planner failed: ${result.error}\n`);
      return false;
    }

    process.stderr.write('[agent-loop] planner wrote task_context.md\n');
    return true;
  }

  private readPlannerSystemPrompt(): string | null {
    const paths = [
      join(this.agentsDir, 'planner.md'),
      join(homedir(), '.claude', 'agents', 'planner.md'),
    ];
    for (const p of paths) {
      if (!existsSync(p)) continue;
      try { return readFileSync(p, 'utf8'); } catch { /* try next */ }
    }
    return null;
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
