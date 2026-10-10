import { chunkText, sleep } from "./text.js";
import type {
  ChannelCapabilities,
  IncomingMessage,
  MessageHandler,
  MessageKind,
  Target,
  ZaloChannel,
} from "./types.js";

export interface BotChannelOptions {
  /** Token from https://bot.zaloplatforms.com, format `numeric_id:secret`. */
  token: string;
  baseUrl?: string;
  /** Long-poll timeout in seconds. */
  pollTimeoutSec?: number;
}

interface BotUpdate {
  event_name?: string;
  message?: {
    from?: { id?: string; display_name?: string; is_bot?: boolean };
    chat?: { id?: string; chat_type?: string };
    text?: string;
    message_id?: string;
    date?: number;
  };
}

const KIND_BY_EVENT: Record<string, MessageKind> = {
  "message.text.received": "text",
  "message.image.received": "image",
  "message.sticker.received": "sticker",
  "message.voice.received": "voice",
};

/** Official Zalo Bot Platform channel (long polling via getUpdates). */
export class ZaloBotChannel implements ZaloChannel {
  readonly id = "bot" as const;
  readonly capabilities: ChannelCapabilities = { maxTextLength: 2000, official: true };

  private readonly endpoint: string;
  private readonly pollTimeoutSec: number;
  private abort?: AbortController;
  private polling?: Promise<void>;
  private readonly seen = new Set<string>();

  constructor(options: BotChannelOptions) {
    const baseUrl = options.baseUrl ?? "https://bot-api.zaloplatforms.com";
    this.endpoint = `${baseUrl}/bot${options.token}`;
    this.pollTimeoutSec = options.pollTimeoutSec ?? 30;
  }

  async start(onMessage: MessageHandler): Promise<void> {
    // Fails fast on a bad token instead of looping on errors.
    await this.call("getMe", {});
    this.abort = new AbortController();
    this.polling = this.poll(onMessage, this.abort.signal);
  }

  async stop(): Promise<void> {
    this.abort?.abort();
    await this.polling;
  }

  async sendText(target: Target, text: string): Promise<void> {
    for (const chunk of chunkText(text, this.capabilities.maxTextLength)) {
      await this.call("sendMessage", { chat_id: target.threadId, text: chunk });
    }
  }

  async sendTyping(target: Target): Promise<void> {
    await this.call("sendChatAction", { chat_id: target.threadId, action: "typing" }).catch(() => {});
  }

  private async poll(onMessage: MessageHandler, signal: AbortSignal): Promise<void> {
    let backoffMs = 1000;
    while (!signal.aborted) {
      const startedAt = Date.now();
      try {
        const result = await this.call(
          "getUpdates",
          { timeout: String(this.pollTimeoutSec) },
          AbortSignal.any([signal, AbortSignal.timeout((this.pollTimeoutSec + 10) * 1000)]),
        );
        backoffMs = 1000;
        // The docs only show a single-update object; accept a list as well.
        const updates = Array.isArray(result) ? result : result ? [result] : [];
        for (const update of updates) {
          const message = this.normalize(update as BotUpdate);
          if (message) void Promise.resolve(onMessage(message)).catch((e) => console.error("[bot] handler error:", e));
        }
      } catch (error) {
        if (signal.aborted) return;
        // An empty long poll may surface as a timeout/error; only back off when it failed fast.
        if (Date.now() - startedAt < 2000) {
          console.error("[bot] getUpdates failed:", errorText(error));
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 30_000);
        }
      }
    }
  }

  private normalize(update: BotUpdate): IncomingMessage | null {
    const message = update.message;
    const threadId = message?.chat?.id;
    if (!message || !threadId || message.from?.is_bot) return null;

    // getUpdates has no offset, so guard against the same update arriving twice.
    const messageId = message.message_id ?? `${threadId}:${message.date}`;
    if (this.seen.has(messageId)) return null;
    this.seen.add(messageId);
    if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value!);

    const kind = KIND_BY_EVENT[update.event_name ?? ""] ?? "other";

    return {
      channel: this.id,
      threadId,
      isGroup: message.chat?.chat_type === "GROUP",
      messageId,
      senderId: message.from?.id ?? threadId,
      senderName: message.from?.display_name ?? "",
      kind,
      text: kind === "text" ? (message.text ?? "") : "",
      // The platform only delivers group messages that @mention the bot.
      addressed: true,
      timestamp: message.date ?? Date.now(),
      raw: update,
    };
  }

  private async call(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.endpoint}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; result?: unknown; description?: string; error_code?: number }
      | null;
    if (!payload?.ok) {
      throw new Error(`${method}: ${payload?.description ?? `HTTP ${response.status}`}`);
    }
    return payload.result;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
