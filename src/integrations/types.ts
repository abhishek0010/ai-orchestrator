export type IncomingMessage = {
  readonly id: string;
  readonly chatId: string;
  readonly userId: string;
  readonly text: string;
  readonly platform: 'telegram' | 'slack';
  readonly raw: unknown;
};

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

export interface BotClient {
  start(handler: MessageHandler): Promise<void>;
  stop(): void;
  sendMessage(chatId: string, text: string): Promise<void>;
}
