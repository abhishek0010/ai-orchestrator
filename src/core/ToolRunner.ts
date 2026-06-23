import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, relative, join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { globSync } from 'node:fs';
import type { AgentDomain, Goal, GoalStatus } from '../types/index.js';
import { MemoryStore } from './MemoryStore.js';
import { GoalQueue } from './GoalQueue.js';

const MAX_FILE_BYTES = 60_000;
const MAX_SEARCH_RESULTS = 80;

/**
 * Resolve the codebase-memory-mcp binary path once per process.
 * Order of preference:
 *   1. ~/.claude/.mcp.json registered command (most reliable on this machine)
 *   2. npm global root + package bin
 *   3. glob over ~/.npm/_npx cache (covers npx-installed versions)
 *   4. npx --no-install (fast-fail if not cached — no download)
 *   5. undefined → caller falls back to unavailable message
 */
function resolveMcpBinary(): string | undefined {
  // 1. ~/.claude/.mcp.json
  try {
    const mcpJson = join(homedir(), '.claude', '.mcp.json');
    if (existsSync(mcpJson)) {
      const config = JSON.parse(readFileSync(mcpJson, 'utf8')) as {
        mcpServers?: Record<string, { command?: string }>;
      };
      const cmd = config.mcpServers?.['codebase-memory-mcp']?.command;
      if (cmd && existsSync(cmd)) return cmd;
    }
  } catch { /* ignore */ }

  // 2. npm global root
  try {
    const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 3_000 });
    if (!npmRoot.error && npmRoot.status === 0) {
      const candidate = join(
        npmRoot.stdout.trim(),
        '@deus-data', 'codebase-memory-mcp', 'bin', 'codebase-memory-mcp',
      );
      if (existsSync(candidate)) return candidate;
    }
  } catch { /* ignore */ }

  // 3. npx cache glob — works when installed via "npx --yes"
  try {
    const npxBase = join(homedir(), '.npm', '_npx');
    if (existsSync(npxBase)) {
      const matches = globSync(
        `${npxBase}/*/node_modules/codebase-memory-mcp/bin/codebase-memory-mcp`,
      );
      if (matches.length > 0) return matches[matches.length - 1]; // latest
    }
  } catch { /* ignore */ }

  // 4. npx --no-install (fast-fail if absent, no network)
  return undefined;
}

const MCP_BINARY = resolveMcpBinary();

export type ToolDefinition = {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: {
      readonly type: 'object';
      readonly properties: Record<string, { readonly type: string; readonly description: string }>;
      readonly required: readonly string[];
    };
  };
};

export type ToolCall = {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
};

export const PLANNER_TOOLS: readonly ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the contents of a file. Path is relative to the project root.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path relative to project root' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files and directories at the given path (relative to project root).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path relative to project root (use "." for root)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search for a pattern in files under a directory (recursive grep).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search pattern (grep regex)' },
          directory: { type: 'string', description: 'Directory to search in (relative to project root, default "src")' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'graph_query',
      description:
        'Search the codebase knowledge graph for functions, classes, and symbols. ' +
        'Returns signatures and file locations. Much faster than reading files — use this first.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural-language search query (e.g. "goal queue push pending")',
          },
          project: {
            type: 'string',
            description: 'Project slug as registered in codebase-memory-mcp (usually the repo folder name)',
          },
        },
        required: ['query', 'project'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_task_context',
      description: 'Write the completed task_context.md and signal that planning is done. Call this ONCE when the context file is complete.',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Full content of task_context.md' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'decompose_goal',
      description: 'Decompose a goal into multiple sub-goals. Return an array of sub-goal descriptions that will be executed in sequence or parallel depending on dependencies.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The goal description to decompose' },
        },
        required: ['goal'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codedb_query',
      description: 'Query the codedb code‑intelligence engine for semantic code lookup.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The query task to pass to codedb (e.g. "find callers of foo")' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_memory',
      description:
        'Read past task outcomes from persistent memory (knowledge/memory.jsonl). ' +
        'Call this at the start of planning to load known constraints, reviewer rejections, and lessons learned.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Substring to match against goal descriptions, reviewer feedback, or constraints. Omit to return most recent entries.' },
          limit: { type: 'number', description: 'Maximum number of entries to return (default: 10).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'escalate_to_human',
      description:
        'Pause the current goal and ask a human for input. ' +
        'Use when blocked on missing requirements, ambiguous specs, or decisions only a human can make. ' +
        'The goal status is set to "waiting" and a human_escalation.md file is written.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The specific question the human must answer before this goal can proceed.' },
        },
        required: ['question'],
      },
    },
  },
];

export class ToolRunner {
  private readonly projectRoot: string;
  private readonly contextDir: string;
  private taskContextContent: string | undefined = undefined;
  private currentGoalId: string | undefined = undefined;

  constructor(projectRoot: string, contextDir: string) {
    this.projectRoot = resolve(projectRoot);
    this.contextDir = resolve(contextDir);
  }

  /** Called by AgentLoop before processing each goal so escalate_to_human can target it. */
  public setCurrentGoal(goalId: string): void {
    this.currentGoalId = goalId;
  }

  /** Execute a tool call and return the result as a string. */
  public execute(call: ToolCall): string {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.function.arguments) as Record<string, unknown>;
    } catch {
      return `[error] invalid JSON arguments: ${call.function.arguments}`;
    }

    switch (call.function.name) {
      case 'read_file':
        return this.readFile(String(args['path'] ?? ''));
      case 'list_dir':
        return this.listDir(String(args['path'] ?? '.'));
      case 'search_files':
        return this.searchFiles(String(args['pattern'] ?? ''), String(args['directory'] ?? 'src'));
      case 'graph_query':
        return this.graphQuery(String(args['query'] ?? ''), String(args['project'] ?? ''));
      case 'codedb_query':
        return this.codedbQuery(String(args['task'] ?? ''));
      case 'write_task_context':
        return this.writeTaskContext(String(args['content'] ?? ''));
      case 'decompose_goal': {
        // Decompose a goal description into sub-goals, enqueue them atomically, and return a summary.
        const resultJson = this.decomposeGoal(args);
        try {
          const parsed = JSON.parse(resultJson) as { ok: boolean; subGoals?: Goal[]; error?: string };
          if (!parsed.ok || !parsed.subGoals) {
            return resultJson; // Propagate error from decomposeGoal
          }
          const queue = new GoalQueue(this.projectRoot);
          queue.pushMany(parsed.subGoals);
          return `enqueued ${parsed.subGoals.length} sub-goals`;
        } catch {
          return resultJson; // Return raw if parsing fails
        }
      }
      case 'read_memory':
        return this.readMemory(args as { query?: string; limit?: number });
      case 'escalate_to_human':
        return this.escalateToHuman(String(args['question'] ?? ''));
      default:
        return `[error] unknown tool: ${call.function.name}`;
    }
  }

  /** Returns the task_context content written by write_task_context, or undefined. */
  getTaskContext(): string | undefined {
    return this.taskContextContent;
  }

  async run_command(command: string): Promise<string> {
    const whitelistedCommands = ['npm test', 'npx tsc', 'pytest', 'go test'];
    if (!whitelistedCommands.includes(command)) {
      throw new Error(`Command not whitelisted: ${command}`);
    }
    const result = spawnSync(command, [], { encoding: 'utf8', cwd: this.projectRoot, shell: true });
    return result.stdout ?? result.stderr ?? '';
  }

  private decomposeGoal(args: Record<string, unknown>): string {
    const goalDesc = String(args['goal'] ?? '');
    if (!goalDesc.trim()) {
      return JSON.stringify({ ok: false, error: 'goal description required' });
    }
    try {
      const now = new Date().toISOString();
      const baseGoal: Omit<Goal, 'id' | 'description'> = {
        projectRoot: this.projectRoot,
        status: 'pending' as GoalStatus,
        createdAt: now,
        retryCount: 0,
      };
      const lines = goalDesc
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);

      const subGoals: Goal[] = [];
      let previousId: string | undefined;
      for (const description of lines) {
        const id = randomUUID();
        const goal: Goal = {
          id,
          description,
          ...baseGoal,
          ...(previousId ? { dependsOn: [previousId] } : {}),
        };
        subGoals.push(goal);
        previousId = id;
      }

      return JSON.stringify({ ok: true, subGoals }, null, 2);
    } catch (err) {
      return JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private safe(relPath: string): string | null {
    if (relPath.trim() === '') return null;
    const abs = resolve(this.projectRoot, relPath);
    if (!abs.startsWith(this.projectRoot + '/') && abs !== this.projectRoot) return null;
    return abs;
  }

  private readFile(relPath: string): string {
    const abs = this.safe(relPath);
    if (abs === null) return `[error] path outside project root: ${relPath}`;
    if (!existsSync(abs)) return `[error] file not found: ${relPath}`;

    try {
      const stat = statSync(abs);
      if (stat.size > MAX_FILE_BYTES) {
        const content = readFileSync(abs, 'utf8');
        const truncated = content.slice(0, MAX_FILE_BYTES);
        return `${truncated}\n[truncated — file is ${stat.size} bytes, showing first ${MAX_FILE_BYTES}]`;
      }
      return readFileSync(abs, 'utf8');
    } catch (err) {
      return `[error] ${String(err)}`;
    }
  }

  private listDir(relPath: string): string {
    const abs = this.safe(relPath);
    if (abs === null) return `[error] path outside project root: ${relPath}`;
    if (!existsSync(abs)) return `[error] not found: ${relPath}`;

    try {
      const entries = readdirSync(abs, { withFileTypes: true });
      return entries
        .map(e => `${e.isDirectory() ? 'd' : 'f'} ${join(relPath, e.name)}`)
        .join('\n');
    } catch (err) {
      return `[error] ${String(err)}`;
    }
  }

  private searchFiles(pattern: string, directory: string): string {
    const abs = this.safe(directory);
    if (abs === null) return `[error] path outside project root: ${directory}`;

    const result = spawnSync(
      'grep',
      ['-r', '--include=*.ts', '--include=*.md', '-n', '-l', pattern, abs],
      { encoding: 'utf8', cwd: this.projectRoot },
    );

    const files = (result.stdout ?? '').trim().split('\n').filter(Boolean);
    if (files.length === 0) return `[no results for pattern: ${pattern}]`;

    const lines: string[] = [];
    for (const file of files.slice(0, MAX_SEARCH_RESULTS)) {
      const rel = relative(this.projectRoot, file);
      const grep = spawnSync('grep', ['-n', pattern, file], { encoding: 'utf8' });
      const matches = (grep.stdout ?? '').trim().split('\n').slice(0, 5).join('\n');
      lines.push(`${rel}:\n${matches}`);
    }

    return lines.join('\n\n');
  }

  private graphQuery(query: string, project: string): string {
    if (!query.trim() || !project.trim()) {
      return '[error] graph_query requires query and project';
    }

    if (MCP_BINARY === undefined) {
      return '[graph_query unavailable — codebase-memory-mcp binary not found. Install with: npm i -g @deus-data/codebase-memory-mcp]';
    }

    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'search_graph',
        arguments: { query, project, limit: 20 },
      },
    });

    const result = spawnSync(MCP_BINARY, [], {
      input: payload + '\n',
      encoding: 'utf8',
      timeout: 10_000,
      cwd: this.projectRoot,
    });

    if (result.error || result.status !== 0) {
      return '[graph_query unavailable — codebase-memory-mcp failed or timed out]';
    }

    // MCP server may emit multiple JSON-RPC messages on stdout; find our response by id=1
    const lines = (result.stdout ?? '').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as {
          id?: number;
          result?: { content?: Array<{ text?: string }> };
        };
        if (msg.id === 1) {
          return msg.result?.content?.[0]?.text ?? '[no results]';
        }
      } catch { /* skip non-JSON lines */ }
    }
    return '[graph_query] could not parse MCP response';
  }

  private codedbQuery(task: string): string {
    const result = spawnSync('codedb', ['query', task], {
      encoding: 'utf8',
      cwd: this.projectRoot,
    });

    if (result.error || result.status !== 0) {
      return '[codedb_query unavailable — codedb binary not found or execution error]';
    }

    return (result.stdout ?? '').trim();
  }

  private writeTaskContext(content: string): string {
    if (content.trim().length === 0) return '[error] content is empty';
    this.taskContextContent = content;
    try {
      writeFileSync(join(this.contextDir, 'task_context.md'), content, 'utf8');
      return 'task_context.md written successfully';
    } catch (err) {
      return `[error] write failed: ${String(err)}`;
    }
  }

  private readMemory(args: { query?: string; limit?: number }): string {
    const store = new MemoryStore(this.projectRoot);
    const limit = args.limit ?? 10;
    const entries = args.query ? store.search(args.query) : store.recent(limit);
    const result = entries.slice(0, limit);
    if (result.length === 0) return '(no memory entries found)';
    return JSON.stringify(result, null, 2);
  }

  private escalateToHuman(question: string): string {
    if (!question.trim()) return '[error] escalate_to_human requires a non-empty question';
    if (!this.currentGoalId) return '[error] no current goal set — escalation not possible';

    const queue = new GoalQueue(this.projectRoot);
    const goals = queue.list();
    const goal = goals.find(g => g.id === this.currentGoalId);
    if (!goal) return `[error] current goal ${this.currentGoalId} not found in queue`;

    goal.status = 'waiting';
    goal.blockedReason = question;
    // Write back through queue's internal mechanism isn't exposed; patch via answer's inverse
    // Instead write directly: re-add the modified goal via a private-accessible path
    // Since GoalQueue doesn't expose a direct patch, we use the fact that answer() exists
    // but targets humanAnswer — use a workaround: write escalation file and let AgentLoop handle
    mkdirSync(this.contextDir, { recursive: true });
    const escalationPath = join(this.contextDir, 'human_escalation.md');
    const content = [
      `# Human Escalation Required`,
      ``,
      `**Goal ID:** ${this.currentGoalId}`,
      `**Timestamp:** ${new Date().toISOString()}`,
      ``,
      `## Question`,
      question,
      ``,
      `## How to respond`,
      `Run: \`node dist/cli.js answer ${this.currentGoalId} "your answer here"\``,
    ].join('\n');
    writeFileSync(escalationPath, content, 'utf8');

    process.stderr.write(
      `\n[HUMAN ESCALATION REQUIRED]\nGoal: ${this.currentGoalId}\nQuestion: ${question}\n` +
      `Answer with: node dist/cli.js answer ${this.currentGoalId} "your answer"\n\n`,
    );

    return `[escalated] goal ${this.currentGoalId} is now waiting for human input.\nQuestion: ${question}`;
  }
}
