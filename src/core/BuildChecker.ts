import { execSync } from 'node:child_process';

type BuildCheckResult =
  | { readonly passed: true }
  | { readonly passed: false; readonly stderr: string };

export async function runBuildCheck(projectRoot: string): Promise<BuildCheckResult> {
  try {
    execSync('npx tsc --noEmit', {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { passed: true };
  } catch (err) {
    const stderrText =
      err instanceof Error && 'stderr' in err
        ? String((err as Error & { stderr: unknown }).stderr)
        : String(err);
    return { passed: false, stderr: stderrText };
  }
}
