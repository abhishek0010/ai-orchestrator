import type { BotClient, IncomingMessage, MessageHandler } from './types.js';
import { splitText } from './utils.js';

const TELEGRAM_API = 'https://api.telegram.org';
const MAX_TELEGRAM_MESSAGE_LENGTH = 4096;

type TelegramUpdate = {
  readonly update_id: number;
  readonly message?: {
    readonly message_id: number;
    readonly from?: { readonly id: number };
    readonly chat: { readonly id: number };
    readonly text?: string;
  };
};

type TelegramResponse = {
  readonly ok: boolean;
  readonly result: readonly TelegramUpdate[];
};

type TelegramOptions = {
  readonly pollingInterval?: number;
  readonly allowedUserIds?: readonly string[];
};

function isTelegramResponse(val: unknown): val is TelegramResponse {
  if (typeof val !== 'object' || val === null) return false;
  const v = val as Record<string, unknown>;
  return v['ok'] === true && Array.isArray(v['result']);
}

export class TelegramClient implements BotClient {
  private readonly token: string;
  private readonly allowedUserIds: ReadonlySet<string>;
  private readonly pollingInterval: number;
  private running = false;
  private abortController: AbortController | null = null;

  constructor(token: string, options?: TelegramOptions) {
    this.token = token;
    this.allowedUserIds = new Set(options?.allowedUserIds ?? []);
    this.pollingInterval = options?.pollingInterval ?? 0;
  }

  async start(handler: MessageHandler): Promise<void> {
    this.running = true;
    let offset = 0;

    while (this.running) {
      const updates = await this.poll(offset);

      if (updates === null) {
        this.running = false;
        break;
      }

      for (const update of updates) {
        const msg = update.message;
        if (msg === undefined || msg.text === undefined) continue;

        const userId = String(msg.from?.id ?? '');
        if (this.allowedUserIds.size > 0 && !this.allowedUserIds.has(userId)) continue;

        const incoming: IncomingMessage = {
          id: String(update.update_id),
          chatId: String(msg.chat.id),
          userId,
          text: msg.text,
          platform: 'telegram',
          raw: update,
        };

        handler(incoming).catch((err: unknown) => {
          process.stderr.write(`[telegram] handler error: ${String(err)}\n`);
        });

        offset = update.update_id + 1;
      }

      if (this.pollingInterval > 0) {
        await new Promise<void>(r => setTimeout(r, this.pollingInterval));
      }
    }
  }

  // Shutdown may take up to 30 s if called between polls (no controller exists yet).
  stop(): void {
    this.running = false;
    this.abortController?.abort();
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    for (const chunk of splitText(text, MAX_TELEGRAM_MESSAGE_LENGTH)) {
      await this.sendChunk(chatId, chunk);
    }
  }

  private async poll(offset: number): Promise<readonly TelegramUpdate[] | null> {
    const url = `${TELEGRAM_API}/bot${this.token}/getUpdates?offset=${String(offset)}&timeout=30`;
    this.abortController = new AbortController();

    let response: Response;
    try {
      response = await fetch(url, { signal: this.abortController.signal });
    } catch (err: unknown) {
      const isAbort =
        typeof err === 'object' &&
        err !== null &&
        (err as { name?: unknown }).name === 'AbortError';
      if (!isAbort) {
        process.stderr.write(`[telegram] poll error: ${String(err)}\n`);
      }
      return null;
    }

    if (!response.ok) {
      process.stderr.write(`[telegram] poll HTTP ${String(response.status)}\n`);
      this.running = false;
      return null;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err: unknown) {
      process.stderr.write(`[telegram] parse error: ${String(err)}\n`);
      return null;
    }

    if (!isTelegramResponse(json)) {
      process.stderr.write('[telegram] unexpected response shape\n');
      return null;
    }

    return json.result;
  }

  private async sendChunk(chatId: string, text: string): Promise<void> {
    const body = JSON.stringify({ chat_id: chatId, text });
    try {
      const response = await fetch(`${TELEGRAM_API}/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      if (!response.ok) {
        process.stderr.write(`[telegram] sendMessage HTTP ${String(response.status)}\n`);
      }
    } catch (err: unknown) {
      process.stderr.write(`[telegram] sendMessage error: ${String(err)}\n`);
    }
  }
}
