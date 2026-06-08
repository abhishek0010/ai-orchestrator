import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { KNOWN_ROLES } from '../types/index.js';

const PORT = Number(process.env['MCP_PORT'] ?? 3456);
const CLAUDE_DIR = join(homedir(), '.claude');
const STATS_FILE = join(CLAUDE_DIR, 'token_stats.json');
const CONTEXT_DIR = join(CLAUDE_DIR, 'context');
const OLLAMA_SCRIPT = join(CLAUDE_DIR, 'call_ollama.sh');
const MAX_BODY_BYTES = 1_048_576; // 1 MB

const TOOLS = [
  {
    name: 'get_stats',
    description: 'Return summary of token usage and savings from token_stats.json',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'triage_task',
    description: 'Run triage role on a task description and return the analysis',
    inputSchema: {
      type: 'object',
      properties: { task: { type: 'string', description: 'Task description to triage' } },
      required: ['task'],
    },
  },
  {
    name: 'get_agent_status',
    description: 'List context files with names and last-modified timestamps',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'run_pipeline',
    description: 'Trigger the coder role with a task prompt (non-blocking)',
    inputSchema: {
      type: 'object',
      properties: { prompt: { type: 'string', description: 'Prompt to send to coder role' } },
      required: ['prompt'],
    },
  },
];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on('data', (c: Buffer) => {
      totalBytes += c.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function handleGetStats(): unknown {
  if (!existsSync(STATS_FILE)) return { runs: 0, totalInputTokens: 0, totalOutputTokens: 0, totalSavedUsd: 0 };
  const data = JSON.parse(readFileSync(STATS_FILE, 'utf8')) as { runs: Array<Record<string, number>> };
  const runs = data.runs ?? [];
  return {
    runs: runs.length,
    totalInputTokens: runs.reduce((s, r) => s + (r['input_tokens_est'] ?? 0), 0),
    totalOutputTokens: runs.reduce((s, r) => s + (r['output_tokens_est'] ?? 0), 0),
    totalCacheReadTokens: runs.reduce((s, r) => s + (r['cache_read_tokens'] ?? 0), 0),
    totalSavedUsd: runs.reduce((s, r) => s + (r['saved_usd_est'] ?? 0), 0).toFixed(4),
  };
}

function handleTriageTask(task: string): unknown {
  if (!existsSync(OLLAMA_SCRIPT)) return { error: 'call_ollama.sh not found' };
  const tmp = join(tmpdir(), `mcp-triage-${Date.now()}.txt`);
  writeFileSync(tmp, task, 'utf8');
  const result = spawnSync('bash', [OLLAMA_SCRIPT, '--role', KNOWN_ROLES.triage, '--prompt-file', tmp], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  try { unlinkSync(tmp); } catch { /* ignore */ }
  return { output: result.stdout.trim(), stderr: result.stderr.trim(), exitCode: result.status };
}

function handleGetAgentStatus(): unknown {
  if (!existsSync(CONTEXT_DIR)) return { files: [] };
  const files = readdirSync(CONTEXT_DIR).map(name => {
    const fullPath = join(CONTEXT_DIR, name);
    const st = statSync(fullPath);
    return { name, modifiedAt: st.mtime.toISOString(), bytes: st.size };
  });
  return { files };
}

function handleRunPipeline(prompt: string): unknown {
  if (!existsSync(OLLAMA_SCRIPT)) return { started: false, message: 'call_ollama.sh not found' };
  const tmp = join(tmpdir(), `mcp-pipeline-${Date.now()}.txt`);
  writeFileSync(tmp, prompt, 'utf8');
  const child = spawn('bash', [OLLAMA_SCRIPT, '--role', KNOWN_ROLES.coder, '--prompt-file', tmp], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return { started: true, message: 'Pipeline started (non-blocking)' };
}

const server = createServer(async (req, res) => {
  const url = req.url ?? '/';

  if (req.method === 'GET' && url === '/health') {
    return json(res, 200, { status: 'ok', version: '1.0.0' });
  }

  if (req.method === 'GET' && url === '/tools/list') {
    return json(res, 200, { tools: TOOLS });
  }

  if (req.method === 'POST' && url === '/tools/call') {
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      return json(res, 413, { error: 'request body too large' });
    }
    let body: { name?: string; arguments?: Record<string, string> };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }

    const args = body.arguments ?? {};
    switch (body.name) {
      case 'get_stats':
        return json(res, 200, { result: handleGetStats() });
      case 'triage_task':
        return json(res, 200, { result: handleTriageTask(args['task'] ?? '') });
      case 'get_agent_status':
        return json(res, 200, { result: handleGetAgentStatus() });
      case 'run_pipeline':
        return json(res, 200, { result: handleRunPipeline(args['prompt'] ?? '') });
      default:
        return json(res, 404, { error: `unknown tool: ${body.name ?? ''}` });
    }
  }

  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  process.stderr.write(`[mcp-server] listening on port ${PORT}\n`);
});
