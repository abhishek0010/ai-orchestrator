import { createServer } from 'node:http';
import type { IncomingMessage as NodeRequest, ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BotClient, IncomingMessage, MessageHandler } from './types.js';
import { splitText } from './utils.js';

const SLACK_API = 'https://slack.com/api';
const DEFAULT_PORT = 3010;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_SLACK_MESSAGE_LENGTH = 3000;

type SlackUrlVerification = {
  readonly type: 'url_verification';
  readonly challenge: string;
};

type SlackAppMentionEvent = {
  readonly type: 'app_mention';
  readonly user: string;
  readonly text: string;
  readonly ts: string;
  readonly channel: string;
};

type SlackDirectMessageEvent = {
  readonly type: 'message';
  readonly channel_type: 'im';
  readonly user: string;
  readonly text: string;
  readonly ts: string;
  readonly channel: string;
  readonly bot_id?: string;
};

type SlackEvent = SlackAppMentionEvent | SlackDirectMessageEvent;

type SlackEventCallback = {
  readonly type: 'event_callback';
  readonly event: SlackEvent;
};

type SlackBody = SlackUrlVerification | SlackEventCallback;

type SlackOptions = {
  readonly port?: number;
  readonly allowedUserIds?: readonly string[];
};

function isSlackBody(val: unknown): val is SlackBody {
  if (typeof val !== 'object' || val === null) return false;
  const v = val as Record<string, unknown>;
  return v['type'] === 'url_verification' || v['type'] === 'event_callback';
}

function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  rawBody: string,
): boolean {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;

  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const hmac = createHmac('sha256', signingSecret);
  hmac.update(sigBasestring);
  const computed = `v0=${hmac.digest('hex')}`;

  const a = Buffer.from(computed, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function stripMention(text: string): string {
  return text.replace(/^<@[A-Z0-9]+>\s*/u, '').trim();
}

async function readBody(req: NodeRequest, maxBytes: number): Promise<string | null> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let total = 0;

    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      resolve(null);
    });
  });
}

export class SlackClient implements BotClient {
  private readonly botToken: string;
  private readonly signingSecret: string;
  private readonly port: number;
  private readonly allowedUserIds: ReadonlySet<string>;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(botToken: string, signingSecret: string, options?: SlackOptions) {
    this.botToken = botToken;
    this.signingSecret = signingSecret;
    this.port = options?.port ?? DEFAULT_PORT;
    this.allowedUserIds = new Set(options?.allowedUserIds ?? []);
  }

  start(handler: MessageHandler): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req: NodeRequest, res: ServerResponse) => {
        this.handleRequest(req, res, handler).catch(err => {
          process.stderr.write(`[slack] request error: ${String(err)}\n`);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end();
          }
        });
      });

      this.server.on('error', reject);
      this.server.listen(this.port, () => {
        process.stderr.write(`[slack] listening on port ${String(this.port)}\n`);
        resolve();
      });
    });
  }

  stop(): void {
    // closeAllConnections drains keep-alive sockets so the process can exit cleanly
    this.server?.closeAllConnections?.();
    this.server?.close();
  }

  async sendMessage(channel: string, text: string): Promise<void> {
    for (const chunk of splitText(text, MAX_SLACK_MESSAGE_LENGTH)) {
      await this.postMessage(channel, chunk);
    }
  }

  private async handleRequest(
    req: NodeRequest,
    res: ServerResponse,
    handler: MessageHandler,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }

    const rawBody = await readBody(req, MAX_BODY_BYTES);
    if (rawBody === null) {
      res.writeHead(413);
      res.end();
      return;
    }

    const signature = req.headers['x-slack-signature'];
    const timestamp = req.headers['x-slack-request-timestamp'];

    if (
      typeof signature !== 'string' ||
      typeof timestamp !== 'string' ||
      !verifySlackSignature(this.signingSecret, signature, timestamp, rawBody)
    ) {
      res.writeHead(401);
      res.end();
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }

    if (!isSlackBody(body)) {
      res.writeHead(400);
      res.end();
      return;
    }

    if (body.type === 'url_verification') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ challenge: body.challenge }));
      return;
    }

    // Respond immediately — Slack requires a reply within 3 seconds
    res.writeHead(200);
    res.end();

    const event = body.event;

    if (event.type === 'message' && event.bot_id !== undefined) return;
    if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(event.user)) return;

    const text = event.type === 'app_mention' ? stripMention(event.text) : event.text;
    if (text.trim().length === 0) return;

    const incoming: IncomingMessage = {
      id: event.ts,
      chatId: event.channel,
      userId: event.user,
      text,
      platform: 'slack',
      raw: body,
    };

    handler(incoming).catch(err => {
      process.stderr.write(`[slack] handler error: ${String(err)}\n`);
    });
  }

  private async postMessage(channel: string, text: string): Promise<void> {
    try {
      const response = await fetch(`${SLACK_API}/chat.postMessage`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.botToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ channel, text }),
      });
      if (!response.ok) {
        process.stderr.write(`[slack] postMessage HTTP ${String(response.status)}\n`);
      }
    } catch (err: unknown) {
      process.stderr.write(`[slack] postMessage error: ${String(err)}\n`);
    }
  }
}
