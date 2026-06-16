import { resolve } from 'node:path';
import { TelegramClient } from './TelegramClient.js';
import { SlackClient } from './SlackClient.js';
import { triggerPipeline } from './PipelineTrigger.js';
import type { BotClient, IncomingMessage } from './types.js';

const PROJECT_ROOT = resolve(process.env['PROJECT_ROOT'] ?? process.cwd());
const OUTPUT_TAIL_CHARS = 500;

function findClient(
  platform: 'telegram' | 'slack',
  clients: readonly BotClient[],
): BotClient {
  const match = clients.find(
    c =>
      (platform === 'telegram' && c instanceof TelegramClient) ||
      (platform === 'slack' && c instanceof SlackClient),
  );
  if (match === undefined) {
    throw new Error(`[integrations] no client for platform: ${platform}`);
  }
  return match;
}

async function main(): Promise<void> {
  const clients: BotClient[] = [];

  const telegramToken = process.env['TELEGRAM_BOT_TOKEN'];
  if (telegramToken !== undefined && telegramToken.length > 0) {
    clients.push(new TelegramClient(telegramToken));
    process.stderr.write('[integrations] Telegram client configured\n');
  }

  const slackToken = process.env['SLACK_BOT_TOKEN'];
  const slackSecret = process.env['SLACK_SIGNING_SECRET'];
  if (
    slackToken !== undefined && slackToken.length > 0 &&
    slackSecret !== undefined && slackSecret.length > 0
  ) {
    clients.push(new SlackClient(slackToken, slackSecret));
    process.stderr.write('[integrations] Slack client configured\n');
  }

  if (clients.length === 0) {
    process.stderr.write(
      '[integrations] no clients configured — set TELEGRAM_BOT_TOKEN or ' +
      '(SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET)\n',
    );
    process.exit(1);
  }

  const handler = async (msg: IncomingMessage): Promise<void> => {
    const task = msg.text.trim();
    process.stderr.write(
      `[integrations] pipeline triggered by ${msg.platform}/${msg.userId}: ` +
      `${task.slice(0, 80)}\n`,
    );

    const result = await triggerPipeline(task, PROJECT_ROOT);

    const tail = result.output.length > OUTPUT_TAIL_CHARS
      ? `...\n${result.output.slice(-OUTPUT_TAIL_CHARS)}`
      : result.output;

    const filesLine = result.changedFiles.length > 0
      ? `\nChanged: ${result.changedFiles.join(', ')}`
      : '';

    const reply = result.ok
      ? `Done.${filesLine}\n\n${tail}`
      : `Pipeline failed.${filesLine}\n\n${tail}`;

    let client: BotClient;
    try {
      client = findClient(msg.platform, clients);
    } catch (err: unknown) {
      process.stderr.write(`[integrations] routing error: ${String(err)}\n`);
      return;
    }
    await client.sendMessage(msg.chatId, reply);
  };

  const shutdown = (): void => {
    process.stderr.write('[integrations] shutting down\n');
    for (const bot of clients) {
      bot.stop();
    }
    // process exits naturally when the event loop drains after clients stop
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await Promise.all(clients.map(c => c.start(handler)));
}

main().catch(err => {
  process.stderr.write(`[integrations] fatal: ${String(err)}\n`);
  process.exit(1);
});
