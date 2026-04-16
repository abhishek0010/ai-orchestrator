import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AgentRunner } from '../agents/AgentRunner.js';
import { PlannerAgent } from '../agents/PlannerAgent.js';
import { DependencyGraph } from './DependencyGraph.js';
import type { AgentDomain, AgentResult, AgentTask, OrchestratorConfig } from '../types/index.js';

// Keyword -> domain mapping used by triage()
const DOMAIN_KEYWORDS: Record<AgentDomain, readonly string[]> = {
  coder: ['implement', 'add', 'fix', 'refactor', 'create', 'build', 'change', 'update'],
  'unit-tester': ['test', 'spec', 'unit', 'coverage', 'mock'],
  'doc-writer': ['doc', 'readme', 'comment', 'jsdoc', 'documentation'],
  devops: ['deploy', 'ci', 'cd', 'docker', 'k8s', 'pipeline', 'release'],
};

export class Orchestrator {
  private readonly config: OrchestratorConfig;
  private readonly runner: AgentRunner;
  private readonly planner: PlannerAgent;

  constructor(configPath: string, contextDir: string) {
    const resolvedConfig = resolve(configPath);
    const resolvedContext = resolve(contextDir);

    try {
      readFileSync(resolvedConfig, 'utf8');
    } catch {
      throw new Error(`Orchestrator: configPath not found: ${resolvedConfig}`);
    }

    this.config = { configPath: resolvedConfig, contextDir: resolvedContext };
    this.runner = new AgentRunner(resolvedConfig);
    this.planner = new PlannerAgent(this.runner, resolvedContext);
  }

  /**
   * Full pipeline: triage -> planAll -> execute -> review.
   */
  async run(task: string): Promise<AgentResult[]> {
    const domains = this.triage(task);

    if (domains.length === 0) {
      process.stderr.write(`[orchestrator] warning: no domains matched for task: "${task}"\n`);

      return [];
    }

    console.log(`[orchestrator] domains: ${domains.join(', ')}`);

    const tasks = await this.planAll(task, domains);
    const results = await this.execute(tasks, task);
    await this.review(results);

    return results;
  }

  /**
   * Keyword-based domain detection. No LLM call.
   * Always includes 'coder' as the base domain.
   */
  private triage(task: string): AgentDomain[] {
    const lower = task.toLowerCase();
    const matched = new Set<AgentDomain>();

    matched.add('coder');

    for (const [domain, keywords] of Object.entries(DOMAIN_KEYWORDS) as [
      AgentDomain,
      readonly string[],
    ][]) {
      for (const keyword of keywords) {
        if (lower.includes(keyword)) {
          matched.add(domain);
          break;
        }
      }
    }

    return Array.from(matched);
  }

  /**
   * Runs PlannerAgent.plan() for all domains concurrently.
   * Uses Promise.allSettled so one failure does not abort others.
   */
  private async planAll(task: string, domains: AgentDomain[]): Promise<AgentTask[]> {
    const settled = await Promise.allSettled(
      domains.map(domain => this.planner.plan(task, domain)),
    );

    const tasks: AgentTask[] = [];

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        tasks.push(result.value);
      } else {
        process.stderr.write(`[orchestrator] plan failed: ${String(result.reason)}\n`);
      }
    }

    return tasks;
  }

  /**
   * Executes tasks level by level (dependency order).
   * Within each level, tasks run concurrently.
   */
  private async execute(tasks: AgentTask[], _task: string): Promise<AgentResult[]> {
    const graph = new DependencyGraph(tasks);
    const levels = graph.getLevels();
    const allResults: AgentResult[] = [];

    for (const level of levels) {
      console.log(`[orchestrator] executing: ${level.map(t => t.domain).join(', ')}`);

      const levelResults = await Promise.all(
        level.map(async (agentTask): Promise<AgentResult> => {
          const result = await this.runner.run(agentTask.domain, agentTask.contextFile);

          return {
            domain: agentTask.domain,
            output: result.ok ? result.output : `ERROR: ${result.error}`,
            contextFile: agentTask.contextFile,
          };
        }),
      );

      allResults.push(...levelResults);
    }

    return allResults;
  }

  /**
   * Runs reviewer role for each result's context file concurrently.
   */
  private async review(results: AgentResult[]): Promise<void> {
    await Promise.all(
      results.map(async result => {
        const reviewResult = await this.runner.run('reviewer', result.contextFile);
        if (!reviewResult.ok) {
          process.stderr.write(
            `[orchestrator] review failed for ${result.domain}: ${reviewResult.error}\n`,
          );
        } else {
          console.log(`[orchestrator] reviewed ${result.domain}: ok`);
        }
      }),
    );
  }
}
