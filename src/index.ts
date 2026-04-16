import { resolve } from 'node:path';
import { Orchestrator } from './core/Orchestrator.js';

const DEFAULT_CONFIG = resolve('llm-config.json');
const DEFAULT_CONTEXT_DIR = resolve('.claude/context');

async function main(): Promise<void> {
  const task = process.argv[2];

  if (task === undefined || task.trim() === '') {
    process.stderr.write('Usage: tsx src/index.ts "<task description>"\n');
    process.exit(1);
  }

  const orchestrator = new Orchestrator(DEFAULT_CONFIG, DEFAULT_CONTEXT_DIR);
  const results = await orchestrator.run(task);

  console.log(`\n[orchestrator] completed ${results.length} agent(s)`);

  for (const result of results) {
    console.log(`  ${result.domain}: ${result.contextFile}`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`[orchestrator] fatal: ${String(err)}\n`);
  process.exit(1);
});
