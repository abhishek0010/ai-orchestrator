import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type MemoryEntry = {
  id: string;
  timestamp: string;
  goalId: string;
  goalDescription: string;
  outcome: 'success' | 'failure';
  reviewerFeedback?: string;
  constraints?: string[];
  llmMetrics?: { model: string; latencyMs: number };
};

export class MemoryStore {
  private readonly filePath: string;

  constructor(projectRoot: string) {
    this.filePath = join(projectRoot, 'knowledge', 'memory.jsonl');
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  append(entry: Omit<MemoryEntry, 'id' | 'timestamp'>): void {
    const record: MemoryEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };
    appendFileSync(this.filePath, JSON.stringify(record) + '\n', 'utf8');
  }

  recent(n: number): MemoryEntry[] {
    return this.load().slice(-n);
  }

  search(query: string): MemoryEntry[] {
    const q = query.toLowerCase();
    return this.load().filter(e =>
      e.goalDescription.toLowerCase().includes(q) ||
      e.reviewerFeedback?.toLowerCase().includes(q) ||
      e.constraints?.some(c => c.toLowerCase().includes(q)),
    );
  }

  private load(): MemoryEntry[] {
    if (!existsSync(this.filePath)) return [];
    return readFileSync(this.filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as MemoryEntry);
  }
}
