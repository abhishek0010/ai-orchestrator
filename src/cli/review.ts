#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Run review pipeline on current git diff via call_ollama.sh reviewer role
const ollamaScript = join(homedir(), '.claude', 'call_ollama.sh');
const args = process.argv.slice(2);
const role = 'reviewer';

// Get current diff into a temp file
const tmpFile = `/tmp/ao-review-diff-${Date.now()}.md`;
const diff = spawnSync('git', ['diff', 'HEAD', '--stat'], { encoding: 'utf8' });

if (!diff.stdout.trim()) {
  console.log('No changes to review (git diff HEAD is empty).');
  process.exit(0);
}

const prompt = args.join(' ') || 'Review the current git diff for code quality, bugs, and standards compliance.';

const result = spawnSync(
  'bash',
  [ollamaScript, '--role', role, '--prompt', prompt, '--context-file', '/dev/stdin'],
  {
    input: diff.stdout,
    stdio: ['pipe', 'inherit', 'inherit'],
  },
);

process.exit(result.status ?? 1);
