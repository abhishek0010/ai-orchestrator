import { spawn, spawnSync } from 'node:child_process';

export type PipelineResult = {
  readonly ok: boolean;
  readonly output: string;
  readonly changedFiles: readonly string[];
};

const DEFAULT_PIPELINE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export async function triggerPipeline(
  task: string,
  projectRoot: string,
  timeoutMs: number = DEFAULT_PIPELINE_TIMEOUT_MS,
): Promise<PipelineResult> {
  return new Promise(resolve => {
    const proc = spawn('bash', ['scripts/run_pipeline.sh', task], { cwd: projectRoot });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const settle = (result: PipelineResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      settle({ ok: false, output: combineOutput(stdout, stderr), changedFiles: [] });
    }, timeoutMs);

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      const output = combineOutput(stdout, stderr);
      if (code !== 0) {
        settle({ ok: false, output, changedFiles: [] });
        return;
      }
      settle({ ok: true, output, changedFiles: getChangedFiles(projectRoot) });
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      settle({ ok: false, output: err.message, changedFiles: [] });
    });
  });
}

function combineOutput(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim().length > 0) parts.push(stdout.trim());
  if (stderr.trim().length > 0) parts.push(stderr.trim());
  return parts.join('\n');
}

function getChangedFiles(projectRoot: string): readonly string[] {
  try {
    const result = spawnSync('git', ['diff', '--name-only', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    if (result.status !== 0) return [];
    return (result.stdout ?? '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);
  } catch {
    return [];
  }
}
