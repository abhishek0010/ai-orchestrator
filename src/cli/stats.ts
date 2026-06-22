#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getHeadroomStats, isHeadroomAvailable } from '../core/HeadroomBridge.js';

interface Run {
  date?: string;
  task?: string;
  input_tokens_est?: number;
  output_tokens_est?: number;
  cache_read_tokens?: number;
  saved_usd_est?: number;
  fallback?: boolean;
}

interface Stats {
  runs: Run[];
}

const statsFile = join(homedir(), '.claude', 'token_stats.json');

if (!existsSync(statsFile)) {
  console.log('No stats recorded yet. Run some tasks first.');
  process.exit(0);
}

const stats: Stats = JSON.parse(readFileSync(statsFile, 'utf8')) as Stats;
const runs = stats.runs ?? [];

if (runs.length === 0) {
  console.log('No runs recorded yet.');
  process.exit(0);
}

const now = Date.now();
const DAY = 86_400_000;

function summarize(filtered: Run[]): void {
  const totalInput = filtered.reduce((s, r) => s + (r.input_tokens_est ?? 0), 0);
  const totalOutput = filtered.reduce((s, r) => s + (r.output_tokens_est ?? 0), 0);
  const totalCacheRead = filtered.reduce((s, r) => s + (r.cache_read_tokens ?? 0), 0);
  const totalSaved = filtered.reduce((s, r) => s + (r.saved_usd_est ?? 0), 0);
  const fallbacks = filtered.filter(r => r.fallback).length;
  console.log(`  runs:         ${String(filtered.length)}`);
  console.log(`  input tokens: ~${String(totalInput)}`);
  console.log(`  output tokens:~${String(totalOutput)}`);
  console.log(`  cache reads:  ~${String(totalCacheRead)}`);
  console.log(`  fallbacks:    ${String(fallbacks)}`);
  console.log(`  saved (est):  $${totalSaved.toFixed(4)}`);
}

const today = runs.filter(r => r.date && now - new Date(r.date).getTime() < DAY);
const week = runs.filter(r => r.date && now - new Date(r.date).getTime() < 7 * DAY);

console.log('\n--- Today ---');
summarize(today);
console.log('\n--- This week ---');
summarize(week);
console.log('\n--- All time ---');
summarize(runs);
console.log();

void (async () => {
  if (!isHeadroomAvailable()) {
    console.log('--- Headroom ---');
    console.log('  headroom: not installed (run: pip install git+https://github.com/headroomlabs-ai/headroom.git)');
    console.log();
    return;
  }

  const headroom = await getHeadroomStats();
  if (headroom === null) return;

  const compressed = typeof headroom['compressed'] === 'number' ? headroom['compressed'] : 0;
  const avgRatio = typeof headroom['avg_ratio'] === 'number' ? headroom['avg_ratio'] : 0;
  const savedUsd = typeof headroom['saved_usd'] === 'number' ? headroom['saved_usd'] : 0;

  console.log('--- Headroom ---');
  console.log(`  compressed:  ${String(compressed)} sessions`);
  console.log(`  avg ratio:   ${(avgRatio * 100).toFixed(1)}%`);
  console.log(`  saved:       ~$${savedUsd.toFixed(2)}`);
  console.log();
})();
