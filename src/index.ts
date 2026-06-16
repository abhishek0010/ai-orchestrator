import { resolve } from 'node:path';
import { Orchestrator } from './core/Orchestrator.js';
import { runBuildCheck } from './core/BuildChecker.js';
import { readTriageRoute } from './core/TriageRouter.js';
import { GoalQueue } from './core/GoalQueue.js';
import { AgentLoop } from './core/AgentLoop.js';
import { KNOWN_DOMAINS } from './types/index.js';
import type { AgentDomain } from './types/index.js';

const DEFAULT_PROJECT_ROOT = process.env['PROJECT_ROOT'] ?? process.cwd();
const DEFAULT_CONFIG = resolve('llm-config.json');
const DEFAULT_CONTEXT_DIR = resolve(DEFAULT_PROJECT_ROOT, '.claude/context');

function parseArgs(argv: string[]): Map<string, string | true> {
  const map = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        map.set(key, next);
        i++;
      } else {
        map.set(key, true);
      }
    }
  }
  return map;
}

async function main(): Promise<void> {
  const arg = process.argv[2];
  const flags = parseArgs(process.argv.slice(2));

  // --goals: list all goals in the queue
  if (flags.has('goals')) {
    const queue = new GoalQueue(DEFAULT_PROJECT_ROOT);
    const goals = queue.list();
    if (goals.length === 0) {
      console.log('[goals] queue is empty');
    } else {
      for (const g of goals) {
        const ts = g.completedAt ?? g.startedAt ?? g.createdAt;
        console.log(`[${g.status.toUpperCase().padEnd(7)}] ${g.id.slice(0, 8)}  ${g.description}  (${ts})`);
        if (g.error !== undefined) console.log(`         error: ${g.error.split('\n')[0]}`);
      }
    }
    return;
  }

  // --goal "description" [--domains "coder,unit-tester"]: enqueue a goal
  if (flags.has('goal')) {
    const description = flags.get('goal');
    if (typeof description !== 'string' || description.trim() === '') {
      process.stderr.write('Usage: tsx src/index.ts --goal "description" [--domains "coder,unit-tester"]\n');
      process.exit(1);
    }
    const domainsFlag = flags.get('domains');
    const domains = typeof domainsFlag === 'string'
      ? domainsFlag.split(',').map(s => s.trim()).filter(
          (s): s is AgentDomain => (KNOWN_DOMAINS as readonly string[]).includes(s),
        )
      : undefined;

    const queue = new GoalQueue(DEFAULT_PROJECT_ROOT);
    const goal = queue.push(description, domains);
    console.log(`[goals] enqueued ${goal.id.slice(0, 8)}: ${goal.description}`);
    return;
  }

  // --daemon [--interval <seconds>]: start the autonomous agent loop
  if (flags.has('daemon')) {
    const intervalFlag = flags.get('interval');
    const pollMs = typeof intervalFlag === 'string' ? Number(intervalFlag) * 1000 : undefined;
    const loop = new AgentLoop(DEFAULT_PROJECT_ROOT, pollMs);
    loop.start();
    return;
  }

  if (arg === undefined || arg.trim() === '' || arg.startsWith('--')) {
    process.stderr.write('Usage: tsx src/index.ts "coder,unit-tester,doc-writer"\n');
    process.stderr.write('       tsx src/index.ts --goal "description" [--domains "coder"]\n');
    process.stderr.write('       tsx src/index.ts --goals\n');
    process.stderr.write('       tsx src/index.ts --daemon [--interval <seconds>]\n');
    process.exit(1);
  }

  const domains = arg
    .split(',')
    .map(s => s.trim())
    .filter((s): s is AgentDomain => (KNOWN_DOMAINS as readonly string[]).includes(s));

  if (domains.length === 0) {
    process.stderr.write(`[orchestrator] no valid domains in: "${arg}"\n`);
    process.stderr.write(`Valid domains: ${[...KNOWN_DOMAINS].join(', ')}\n`);
    process.exit(1);
  }

  // Read triage route and apply early-exit branching before running the orchestrator
  const route = readTriageRoute(DEFAULT_CONTEXT_DIR);
  if (route === 'direct-edit' || route === 'quick-coder' || route === 'plugin-route') {
    process.stdout.write(
      `[orchestrator] early-exit route detected: ${route} — skipping orchestrator\n`,
    );
    process.exit(0);
  }

  // Build check runs before code generation to catch existing errors early
  const buildResult = await runBuildCheck(DEFAULT_PROJECT_ROOT);
  if (!buildResult.passed) {
    process.stderr.write(`[orchestrator] build check failed:\n${buildResult.stderr}\n`);
    process.exit(2);
  }

  const orchestrator = new Orchestrator(DEFAULT_CONFIG, DEFAULT_CONTEXT_DIR, DEFAULT_PROJECT_ROOT);
  const { agentResults, reviewOutcome } = await orchestrator.run(domains);

  console.log(`\n[developer-agent] completed ${agentResults.length} domain(s)`);

  for (const result of agentResults) {
    const files =
      result.changedFiles.length > 0
        ? result.changedFiles.join(', ')
        : '(no files written)';
    console.log(`  ${result.domain} [${result.status}]: ${files}`);
  }

  if (!reviewOutcome.passed) {
    process.stderr.write(
      `[orchestrator] review failed for: ${reviewOutcome.failedDomains.join(', ')}\n`,
    );
    process.exit(3);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[orchestrator] fatal: ${String(err)}\n`);
  process.exit(1);
});
