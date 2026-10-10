import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  LoginQRCallbackEventType,
  ThreadType,
  Zalo,
  type API,
  type Credentials,
  type Message,
} from "zca-js";
import { chunkText, sleep } from "./text.js";
import type {
  ChannelCapabilities,
  IncomingMessage,
  MessageHandler,
  MessageKind,
  Target,
  ZaloChannel,
} from "./types.js";

export interface PersonalChannelOptions {
  /** Where the logged-in session (cookie, imei, user agent) is kept. Treat as a secret. */
  sessionFile?: string;
  /** Where the login QR image is written when a scan is needed. */
  qrFile?: string;
  /** Random pause before each outgoing message, to avoid machine-like bursts. */
  sendDelayMs?: [min: number, max: number];
}

/**
 * Personal Zalo account channel via zca-js (unofficial, reverse-engineered Zalo Web).
 * Zalo may lock accounts that automate: use a secondary account.
 * Only one Zalo Web session can listen at a time; opening Zalo Web elsewhere disconnects this one.
 */
export class ZaloPersonalChannel implements ZaloChannel {
  readonly id = "personal" as const;
  readonly capabilities: ChannelCapabilities = { maxTextLength: 2000, official: false };

  private readonly sessionFile: string;
  private readonly qrFile: string;
  private readonly sendDelayMs: [number, number];
  private api?: API;
  private ownId = "";
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(options: PersonalChannelOptions = {}) {
    this.sessionFile = options.sessionFile ?? join("data", "zalo-personal-session.json");
    this.qrFile = options.qrFile ?? join("data", "zalo-qr.png");
    this.sendDelayMs = options.sendDelayMs ?? [800, 2500];
  }

  async start(onMessage: MessageHandler): Promise<void> {
    this.api = await this.login();
    this.ownId = this.api.getOwnId();

    const listener = this.api.listener;
    listener.on("message", (message) => {
      const normalized = this.normalize(message);
      if (normalized) void Promise.resolve(onMessage(normalized)).catch((e) => console.error("[personal] handler error:", e));
    });
    listener.on("error", (error) => console.error("[personal] listener error:", error));
    listener.on("closed", (code, reason) => console.error(`[personal] listener closed (${code}) ${reason}`));
    listener.start({ retryOnClose: true });
  }

  async stop(): Promise<void> {
    this.api?.listener.stop();
    await this.sendQueue;
  }

  sendText(target: Target, text: string): Promise<void> {
    const api = this.requireApi();
    const type = threadType(target);
    // Serialise sends so replies to different threads never go out in a burst.
    const job = this.sendQueue.then(async () => {
      for (const chunk of chunkText(text, this.capabilities.maxTextLength)) {
        const [min, max] = this.sendDelayMs;
        await sleep(min + Math.random() * (max - min));
        await api.sendMessage({ msg: chunk }, target.threadId, type);
      }
    });
    this.sendQueue = job.catch(() => {});
    return job;
  }

  async sendTyping(target: Target): Promise<void> {
    await this.api?.sendTypingEvent(target.threadId, threadType(target)).catch(() => {});
  }

  private async login(): Promise<API> {
    const zalo = new Zalo({ selfListen: false, logging: false });

    const saved = await readFile(this.sessionFile, "utf8").then(
      (json) => JSON.parse(json) as Credentials,
      () => null,
    );
    if (saved) {
      try {
        return await zalo.login(saved);
      } catch (error) {
        console.error("[personal] saved session rejected, falling back to QR login:", error);
      }
    }

    await mkdir(dirname(this.qrFile), { recursive: true });
    return zalo.loginQR({ qrPath: this.qrFile }, (event) => {
      switch (event.type) {
        case LoginQRCallbackEventType.QRCodeGenerated:
          void event.actions.saveToFile(this.qrFile);
          console.log(`[personal] Scan the QR code with the Zalo app: ${this.qrFile}`);
          break;
        case LoginQRCallbackEventType.QRCodeExpired:
          console.log("[personal] QR code expired, generating a new one...");
          event.actions.retry();
          break;
        case LoginQRCallbackEventType.QRCodeScanned:
          console.log(`[personal] Scanned by ${event.data.display_name}; confirm on the phone.`);
          break;
        case LoginQRCallbackEventType.QRCodeDeclined:
          console.log("[personal] Login declined on the phone, generating a new QR code...");
          event.actions.retry();
          break;
        case LoginQRCallbackEventType.GotLoginInfo:
          void this.saveSession(event.data);
          break;
      }
    });
  }

  private async saveSession(credentials: Credentials): Promise<void> {
    await mkdir(dirname(this.sessionFile), { recursive: true });
    await writeFile(this.sessionFile, JSON.stringify(credentials), { mode: 0o600 });
  }

  private normalize(message: Message): IncomingMessage | null {
    if (message.isSelf) return null;
    const { data } = message;
    const isGroup = message.type === ThreadType.Group;
    const kind = KIND_BY_MSG_TYPE[data.msgType] ?? (typeof data.content === "string" ? "text" : "other");
    const mentions = message.type === ThreadType.Group ? message.data.mentions : undefined;

    return {
      channel: this.id,
      threadId: message.threadId,
      isGroup,
      messageId: data.msgId,
      senderId: data.uidFrom,
      senderName: data.dName,
      kind,
      text: kind === "text" && typeof data.content === "string" ? data.content : "",
      addressed: !isGroup || (mentions?.some((mention) => mention.uid === this.ownId) ?? false),
      timestamp: Number(data.ts) || Date.now(),
      raw: message,
    };
  }

  private requireApi(): API {
    if (!this.api) throw new Error("ZaloPersonalChannel is not started");
    return this.api;
  }
}

const KIND_BY_MSG_TYPE: Record<string, MessageKind> = {
  webchat: "text",
  "chat.photo": "image",
  "chat.sticker": "sticker",
  "chat.voice": "voice",
};

function threadType(target: Target): ThreadType {
  return target.isGroup ? ThreadType.Group : ThreadType.User;
}
