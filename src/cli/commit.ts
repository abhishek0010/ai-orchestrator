#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const script = join(homedir(), '.claude', 'local-commit.sh');
const args = process.argv.slice(2);
const result = spawnSync('bash', [script, ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
