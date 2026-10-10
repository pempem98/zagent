export type ChannelId = "bot" | "personal";

export type MessageKind = "text" | "image" | "sticker" | "voice" | "other";

/** Where a reply goes. Thread ids are only meaningful inside their own channel. */
export interface Target {
  threadId: string;
  isGroup: boolean;
}

/** One incoming message, in the same shape whichever channel it came from. */
export interface IncomingMessage extends Target {
  channel: ChannelId;
  messageId: string;
  senderId: string;
  senderName: string;
  kind: MessageKind;
  /** Empty for non-text messages without a caption. */
  text: string;
  /** True in a 1:1 chat, or in a group when the bot/account was @mentioned. */
  addressed: boolean;
  timestamp: number;
  /** Untouched payload from the underlying API, for channel-specific needs. */
  raw: unknown;
}

export interface ChannelCapabilities {
  /** Max characters per message; longer text is split by the channel. */
  maxTextLength: number;
  /** Official API (no account-lock risk) vs. reverse-engineered Zalo Web. */
  official: boolean;
}

export type MessageHandler = (message: IncomingMessage) => void | Promise<void>;

export interface ZaloChannel {
  readonly id: ChannelId;
  readonly capabilities: ChannelCapabilities;
  /** Log in / connect and start delivering messages. Resolves once listening. */
  start(onMessage: MessageHandler): Promise<void>;
  stop(): Promise<void>;
  sendText(target: Target, text: string): Promise<void>;
  /** Best effort; never throws. */
  sendTyping(target: Target): Promise<void>;
}
