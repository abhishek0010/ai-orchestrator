#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const scripts = [
  join(homedir(), '.claude', 'check-update.sh'),
  join(homedir(), '.claude', 'update-knowledge.sh'),
];

let allOk = true;
for (const script of scripts) {
  if (!existsSync(script)) continue;
  const result = spawnSync('bash', [script], { stdio: 'inherit' });
  if ((result.status ?? 0) !== 0) {
    allOk = false;
  }
}

process.exit(allOk ? 0 : 1);
