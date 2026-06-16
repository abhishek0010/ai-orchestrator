import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GoalQueue } from './GoalQueue.js';
import { Orchestrator } from './Orchestrator.js';
import { runBuildCheck } from './BuildChecker.js';
import { TriageAgent } from '../agents/TriageAgent.js';
import { AgentRunner } from '../agents/AgentRunner.js';
import { KNOWN_DOMAINS } from '../types/index.js';
import type { AgentDomain, Goal } from '../types/index.js';

const DEFAULT_POLL_MS = 10_000;
const DEFAULT_CONFIG = 'llm-config.json';

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class AgentLoop {
  private readonly queue: GoalQueue;
  private readonly projectRoot: string;
  private readonly contextDir: string;
  private readonly pollMs: number;
  private active = false;

  constructor(projectRoot: string, pollMs = DEFAULT_POLL_MS) {
    this.projectRoot = resolve(projectRoot);
    this.contextDir = join(this.projectRoot, '.claude/context');
    this.pollMs = pollMs;
    this.queue = new GoalQueue(this.projectRoot);
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
      const domains = await this.resolveDomains(goal);
      if (domains.length === 0) {
        this.queue.fail(goal.id, 'triage returned no valid domains');
        return;
      }

      process.stderr.write(`[agent-loop] domains: ${domains.join(', ')}\n`);
      this.writeTaskContext(goal.description, domains);

      const buildResult = await runBuildCheck(this.projectRoot);
      if (!buildResult.passed) {
        this.queue.fail(goal.id, `build check failed:\n${buildResult.stderr}`);
        return;
      }

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

  private async resolveDomains(goal: Goal): Promise<AgentDomain[]> {
    if (goal.domains !== undefined && goal.domains.length > 0) {
      return goal.domains.filter(
        (d): d is AgentDomain => (KNOWN_DOMAINS as readonly string[]).includes(d),
      );
    }

    const runner = new AgentRunner();
    const agent = new TriageAgent(runner, this.contextDir, this.projectRoot);
    const result = await agent.analyze(goal.description);
    return [...result.domains];
  }

  private writeTaskContext(description: string, domains: AgentDomain[]): void {
    const content = [
      '# Task Context',
      '',
      '## Goal',
      description,
      '',
      '## Domains',
      ...domains.map(d => `- ${d}`),
      '',
      '## Instructions',
      'Implement the goal above. Follow project coding standards.',
      'Write complete, working code. No placeholders.',
    ].join('\n') + '\n';

    writeFileSync(join(this.contextDir, 'task_context.md'), content, 'utf8');
  }
}
