import { spawnSync, execSync } from 'node:child_process';
import { createConnection } from 'node:net';

let _available: boolean | undefined = undefined;

const CHECK_TIMEOUT_MS = 2_000;
const PROXY_PORT = 8787;

export function isHeadroomAvailable(): boolean {
  if (_available !== undefined) return _available;
  const r = spawnSync('headroom', ['--version'], { stdio: 'ignore', timeout: CHECK_TIMEOUT_MS });
  _available = r.status === 0 && r.error === undefined;
  return _available;
}

export function getHeadroomVersion(): string | null {
  if (!isHeadroomAvailable()) return null;
  try {
    const out = execSync('headroom --version', { encoding: 'utf8', timeout: CHECK_TIMEOUT_MS });
    const match = /version\s+([\d.]+)/i.exec(out);
    return match ? (match[1] ?? out.trim()) : out.trim();
  } catch {
    return null;
  }
}

export function isProxyRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port: PROXY_PORT, host: '127.0.0.1' });
    socket.setTimeout(500);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

export async function getHeadroomStats(): Promise<{
  version: string | null;
  proxyRunning: boolean;
} | null> {
  if (!isHeadroomAvailable()) return null;
  const [version, proxyRunning] = await Promise.all([
    Promise.resolve(getHeadroomVersion()),
    isProxyRunning(),
  ]);
  return { version, proxyRunning };
}
