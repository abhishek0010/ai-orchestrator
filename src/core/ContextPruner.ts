import { readFile } from 'node:fs/promises';
import { compressWithHeadroom } from './HeadroomBridge.js';

// Total character budget for context passed to Ollama (~20k tokens at 2.5 chars/token)
const DEFAULT_BUDGET = 50_000;
// Max chars a single section can occupy when budget is tight
const SECTION_CAP = 2_000;
// Sections whose headers always get included regardless of budget
const PRIORITY_HEADERS = ['Verdict', 'Issues', 'Domains', 'Route', 'Constraints'];

export type PruneResult = {
  readonly content: string;
  readonly originalChars: number;
  readonly prunedChars: number;
  readonly wasPruned: boolean;
  readonly headroomChars?: number;  // chars after headroom compression; absent if not applied
};

/**
 * Reads a context file and trims it to fit within maxChars.
 *
 * Algorithm (adapted from Codebuff context-pruner):
 * 1. Split content into ## sections
 * 2. Walk in reverse order (recent sections = higher priority)
 * 3. Accumulate sections until budget is exhausted
 * 4. Reconstruct in original order with a truncation notice
 */
export async function pruneContextFile(
  filePath: string,
  maxChars = DEFAULT_BUDGET,
): Promise<PruneResult> {
  const content = await readFile(filePath, 'utf8');
  const originalChars = content.length;

  if (originalChars <= maxChars) {
    const base: PruneResult = { content, originalChars, prunedChars: 0, wasPruned: false };
    const compressed = await compressWithHeadroom(content);
    if (compressed === content) return base;
    process.stderr.write(
      `[ContextPruner] headroom: ${content.length}chars → ${compressed.length}chars\n`,
    );
    return { ...base, content: compressed, headroomChars: compressed.length };
  }

  const sections = splitSections(content);
  const kept: Array<{ index: number; text: string }> = [];
  let budget = maxChars;

  // Walk in reverse: newest sections survive budget cuts first
  for (let i = sections.length - 1; i >= 0; i--) {
    const section = sections[i]!;
    const isPriority = PRIORITY_HEADERS.some(h =>
      section.header.toLowerCase().includes(h.toLowerCase()),
    );

    // Under budget pressure, cap non-priority sections
    const allowedLen = budget < maxChars / 2 && !isPriority
      ? Math.min(section.text.length, SECTION_CAP)
      : section.text.length;

    const chunk = section.text.slice(0, allowedLen);
    const truncated = chunk.length < section.text.length
      ? chunk + `\n... [${section.text.length - chunk.length} chars omitted]`
      : chunk;

    kept.push({ index: i, text: truncated });
    budget -= truncated.length;

    if (budget <= 0) break;
  }

  // Restore original order
  kept.sort((a, b) => a.index - b.index);

  const prunedCount = sections.length - kept.length;
  const notice = prunedCount > 0
    ? `[CONTEXT PRUNED: ${originalChars - maxChars} chars removed, ${prunedCount} section(s) dropped]\n\n`
    : `[CONTEXT PRUNED: trimmed to ${maxChars} chars]\n\n`;

  const pruned = notice + kept.map(k => k.text).join('\n');
  const prunedChars = Math.max(0, originalChars - pruned.length);

  process.stderr.write(
    `[ContextPruner] ${originalChars}→${pruned.length} chars (${prunedCount} sections dropped)\n`,
  );

  const base: PruneResult = { content: pruned, originalChars, prunedChars, wasPruned: true };
  const compressed = await compressWithHeadroom(pruned);
  if (compressed === pruned) return base;

  process.stderr.write(
    `[ContextPruner] headroom: ${pruned.length}chars → ${compressed.length}chars\n`,
  );
  return { ...base, content: compressed, headroomChars: compressed.length };
}

type Section = { readonly header: string; readonly text: string };

function splitSections(content: string): Section[] {
  // Split on markdown ## headings, keeping the delimiter
  const parts = content.split(/(?=^## )/m);
  return parts
    .filter(p => p.trim().length > 0)
    .map(p => {
      const newline = p.indexOf('\n');
      const header = newline === -1 ? p : p.slice(0, newline);
      return { header: header.replace(/^##\s*/, ''), text: p };
    });
}
