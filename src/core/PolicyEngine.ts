import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface Policy {
  action: string;
  block_if: RegExp;
  reason: string;
}

interface PolicyFileEntry {
  action?: unknown;
  block_if?: unknown;
  reason?: unknown;
}

function loadPolicies(filePath: string): Policy[] {
  const raw = readFileSync(filePath, 'utf8');
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];

  return (data as PolicyFileEntry[]).map(item => ({
    action: String(item.action ?? ''),
    block_if: new RegExp(String(item.block_if ?? '')),
    reason: String(item.reason ?? 'blocked by policy'),
  }));
}

export async function check(
  action: string,
  args: Record<string, unknown>,
): Promise<{ allowed: boolean; reason?: string }> {
  // Resolve settings.json relative to the process cwd (project root)
  const settingsPath = join(process.cwd(), 'settings.json');
  let settings: { policyFiles?: string[] } = {};

  if (existsSync(settingsPath)) {
    try {
      const raw = readFileSync(settingsPath, 'utf8');
      settings = JSON.parse(raw);
    } catch {
      // If parsing fails we treat it as no policies
      settings = {};
    }
  }

  const policyFiles = settings.policyFiles ?? [];

  for (const policyFile of policyFiles) {
    const fullPath = join(process.cwd(), policyFile);
    if (!existsSync(fullPath)) continue;

    const policies = loadPolicies(fullPath);
    for (const policy of policies) {
      if (policy.action === action && policy.block_if.test(JSON.stringify(args))) {
        return { allowed: false, reason: policy.reason };
      }
    }
  }

  return { allowed: true };
}
