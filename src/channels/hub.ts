import { ZaloBotChannel } from "./bot.js";
import { ZaloPersonalChannel } from "./personal.js";
import type { ChannelId, GroupHandler, IncomingMessage, MessageHandler, Target, ZaloChannel } from "./types.js";

/** Runs any number of Zalo channels behind one message handler and one reply call. */
export class ZaloHub {
  private readonly channels = new Map<ChannelId, ZaloChannel>();

  constructor(channels: ZaloChannel[]) {
    for (const channel of channels) this.channels.set(channel.id, channel);
    if (this.channels.size === 0) throw new Error("No Zalo channel configured");
  }

  get ids(): ChannelId[] {
    return [...this.channels.keys()];
  }

  /** Starts every channel; one failing to start does not stop the others. */
  async start(onMessage: MessageHandler, onGroup?: GroupHandler): Promise<void> {
    const results = await Promise.allSettled([...this.channels.values()].map((channel) => channel.start(onMessage, onGroup)));
    const failed = results.flatMap((result, i) => (result.status === "rejected" ? [[this.ids[i], result.reason]] : []));
    for (const [id, reason] of failed) {
      console.error(`[${id}] failed to start:`, reason);
      this.channels.delete(id as ChannelId);
    }
    if (this.channels.size === 0) throw new Error("No Zalo channel could be started");
  }

  async stop(): Promise<void> {
    await Promise.allSettled([...this.channels.values()].map((channel) => channel.stop()));
  }

  /** Reply in the thread and on the channel the message came from. */
  reply(message: IncomingMessage, text: string): Promise<void> {
    return this.send(message.channel, message, text);
  }

  send(channelId: ChannelId, target: Target, text: string): Promise<void> {
    return this.channel(channelId).sendText({ threadId: target.threadId, isGroup: target.isGroup }, text);
  }

  typing(message: IncomingMessage): Promise<void> {
    return this.channel(message.channel).sendTyping(message);
  }

  channel(id: ChannelId): ZaloChannel {
    const channel = this.channels.get(id);
    if (!channel) throw new Error(`Zalo channel "${id}" is not running`);
    return channel;
  }
}

/**
 * Build the hub from environment variables:
 * - ZALO_BOT_TOKEN        enables the official Bot Platform channel
 * - ZALO_PERSONAL=1       enables the personal-account channel (QR login on first run)
 */
export function createHubFromEnv(env: NodeJS.ProcessEnv = process.env): ZaloHub {
  const channels: ZaloChannel[] = [];
  // ZALO_BOT_API_URL points the bot at another server; it exists for end-to-end tests.
  if (env.ZALO_BOT_TOKEN) channels.push(new ZaloBotChannel({ token: env.ZALO_BOT_TOKEN, baseUrl: env.ZALO_BOT_API_URL || undefined }));
  if (env.ZALO_PERSONAL === "1") channels.push(new ZaloPersonalChannel());
  return new ZaloHub(channels);
}
