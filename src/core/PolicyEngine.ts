import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

interface Policy {
  action: string;
  block_if: RegExp;
  reason: string;
}

/**
 * Load policies from a YAML file.
 * The YAML should define an array of objects with `action`, `block_if` (as a string
 * that will be turned into a RegExp), and `reason`.
 */
async function loadPolicies(filePath: string): Promise<Policy[]> {
  const raw = readFileSync(filePath, 'utf8');
  const data = yaml.load(raw) as any[];
  if (!Array.isArray(data)) return [];

  return data.map(item => ({
    action: String(item.action ?? ''),
    block_if: new RegExp(String(item.block_if ?? '')),
    reason: String(item.reason ?? ''),
  }));
}

/**
 * Check whether a tool action is allowed according to the configured policies.
 *
 * The function reads `settings.json` from the project root (or the current working
 * directory) to discover which policy files should be consulted. Each policy file
 * is loaded, and if any policy matches the given action and arguments, the call is
 * blocked and a reason is returned.
 *
 * @param action - The name of the tool being invoked.
 * @param args   - The arguments supplied to the tool.
 * @returns An object indicating whether execution is allowed and, if not,
 *          the reason why it was blocked.
 */
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

    const policies = await loadPolicies(fullPath);
    for (const policy of policies) {
      if (policy.action === action && policy.block_if.test(JSON.stringify(args))) {
        return { allowed: false, reason: policy.reason };
      }
    }
  }

  return { allowed: true };
}
