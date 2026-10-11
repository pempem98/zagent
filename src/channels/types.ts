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
  /** Name of the group the message was sent in, when the platform includes one. */
  threadName?: string;
  messageId: string;
  senderId: string;
  senderName: string;
  kind: MessageKind;
  /** Text of the message (emoji included). Empty for media, which the bot does not process. */
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

/** A group the bot/account is in, as far as the platform tells. */
export interface GroupSighting {
  channel: ChannelId;
  threadId: string;
  /** Empty when the platform does not give one (the Bot Platform never does). */
  name: string;
  memberCount?: number;
}

/** What a channel learns about group membership without anyone writing in the group. */
export type GroupUpdate =
  | { type: "seen"; group: GroupSighting }
  | { type: "left"; channel: ChannelId; threadId: string }
  /** The complete list of groups on that channel: anything missing from it is no longer joined. */
  | { type: "list"; channel: ChannelId; groups: GroupSighting[] };

export type GroupHandler = (update: GroupUpdate) => void;

export interface ZaloChannel {
  readonly id: ChannelId;
  readonly capabilities: ChannelCapabilities;
  /** Log in / connect and start delivering messages. Resolves once listening. */
  start(onMessage: MessageHandler, onGroup?: GroupHandler): Promise<void>;
  stop(): Promise<void>;
  sendText(target: Target, text: string): Promise<void>;
  /** Best effort; never throws. */
  sendTyping(target: Target): Promise<void>;
}
