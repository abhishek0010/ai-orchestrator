const LOCK_FILE_RE = /\.lock$|package-lock\.json|yarn\.lock|pnpm-lock\.yaml/;
const MAX_HUNK_LINES = 500;
const HEAD_LINES = 200;
const TAIL_LINES = 50;

export type CompressResult = {
  readonly compressed: string;
  readonly originalBytes: number;
  readonly compressedBytes: number;
  readonly ratio: number;
};

export function compressDiff(diff: string): CompressResult {
  const originalBytes = Buffer.byteLength(diff, 'utf8');

  const hunks = splitHunks(diff);
  const filtered = hunks.filter(h => !isLockFileHunk(h));
  const processed = filtered.map(h => truncateLongSection(collapseBlankLines(h)));
  const compressed = processed.join('\n');

  const compressedBytes = Buffer.byteLength(compressed, 'utf8');
  const ratio = originalBytes === 0 ? 1 : compressedBytes / originalBytes;

  process.stderr.write(
    `[DiffCompressor] ${originalBytes}→${compressedBytes} bytes (ratio: ${ratio.toFixed(1)}x)\n`,
  );

  return { compressed, originalBytes, compressedBytes, ratio };
}

function splitHunks(diff: string): string[] {
  if (diff.length === 0) return [];
  const parts = diff.split('\ndiff --git ');
  const first = parts[0] ?? '';
  const rest = parts.slice(1).map(p => `diff --git ${p}`);
  return first.length > 0 ? [first, ...rest] : rest;
}

function isLockFileHunk(hunk: string): boolean {
  const firstLine = hunk.split('\n')[0] ?? '';
  return LOCK_FILE_RE.test(firstLine);
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n');
}

function truncateLongSection(text: string): string {
  const lines = text.split('\n');
  if (lines.length <= MAX_HUNK_LINES) return text;
  const head = lines.slice(0, HEAD_LINES);
  const tail = lines.slice(lines.length - TAIL_LINES);
  const dropped = lines.length - HEAD_LINES - TAIL_LINES;
  return [...head, `... [truncated ${dropped} lines] ...`, ...tail].join('\n');
}
