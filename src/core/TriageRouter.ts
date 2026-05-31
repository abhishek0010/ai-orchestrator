import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TriageRoute } from '../types/index.js';

const KNOWN_ROUTES: readonly TriageRoute[] = [
  'direct-edit',
  'quick-coder',
  'plugin-route',
  'full-pipeline',
  'architect-first',
];

export function readTriageRoute(contextDir: string): TriageRoute | undefined {
  const filePath = join(contextDir, 'triage_ts.md');
  if (!existsSync(filePath)) {
    return undefined;
  }

  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }

  const match = content.match(/^## Route\s*\n([^\n]+)/m);
  if (match === null) {
    return undefined;
  }

  const value = match[1]?.trim();
  if (value === undefined) {
    return undefined;
  }

  return (KNOWN_ROUTES as readonly string[]).includes(value)
    ? (value as TriageRoute)
    : undefined;
}
