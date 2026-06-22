import { spawnSync, exec } from 'node:child_process';

let _available: boolean | undefined = undefined;
let _loggedUnavailable = false;

const COMPRESS_TIMEOUT_MS = 5_000;
const STATS_TIMEOUT_MS = 3_000;
const CHECK_TIMEOUT_MS = 2_000;

export function isHeadroomAvailable(): boolean {
  if (_available !== undefined) return _available;
  const r = spawnSync('headroom', ['--version'], { stdio: 'ignore', timeout: CHECK_TIMEOUT_MS });
  _available = r.status === 0 && r.error === undefined;
  return _available;
}

export async function compressWithHeadroom(content: string): Promise<string> {
  if (!isHeadroomAvailable()) {
    if (!_loggedUnavailable) {
      _loggedUnavailable = true;
      process.stderr.write('[HeadroomBridge] headroom not found — using fallback\n');
    }
    return content;
  }

  return new Promise<string>((resolve) => {
    const child = exec(
      'headroom compress --stdin',
      { timeout: COMPRESS_TIMEOUT_MS },
      (err: Error | null, stdout: string) => {
        if (err !== null || stdout.trim().length === 0) {
          resolve(content);
          return;
        }
        resolve(stdout.trim());
      },
    );

    if (child.stdin === null) {
      child.kill();
      resolve(content);
      return;
    }

    child.stdin.write(content);
    child.stdin.end();
  });
}

export async function getHeadroomStats(): Promise<Record<string, unknown> | null> {
  if (!isHeadroomAvailable()) return null;

  return new Promise<Record<string, unknown> | null>((resolve) => {
    exec(
      'headroom stats --json',
      { timeout: STATS_TIMEOUT_MS },
      (err: Error | null, stdout: string) => {
        if (err !== null) {
          resolve(null);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            resolve(null);
            return;
          }
          resolve(parsed as Record<string, unknown>);
        } catch {
          resolve(null);
        }
      },
    );
  });
}
