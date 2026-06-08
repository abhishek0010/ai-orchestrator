import { resolve } from 'node:path';
import { Orchestrator } from './core/Orchestrator.js';
import { runBuildCheck } from './core/BuildChecker.js';
import { readTriageRoute } from './core/TriageRouter.js';
import { KNOWN_DOMAINS } from './types/index.js';
import type { AgentDomain } from './types/index.js';

const DEFAULT_PROJECT_ROOT = process.env['PROJECT_ROOT'] ?? process.cwd();
const DEFAULT_CONFIG = resolve('llm-config.json');
const DEFAULT_CONTEXT_DIR = resolve(DEFAULT_PROJECT_ROOT, '.claude/context');

async function main(): Promise<void> {
  const arg = process.argv[2];

  if (arg === undefined || arg.trim() === '') {
    process.stderr.write('Usage: tsx src/index.ts "coder,unit-tester,doc-writer"\n');
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
