import type { Content } from "@google/genai";
import { JsonFile } from "../store.js";
import type { Tool } from "./tools.js";

// --- Conversation history ----------------------------------------------------------------------

interface Turn {
  role: "user" | "model";
  text: string;
}

interface Conversation {
  updatedAt: number;
  /** Rolling summary of turns that were dropped from `turns`. */
  summary: string;
  turns: Turn[];
}

/** Compact once a conversation holds this many messages... */
const COMPACT_ABOVE = 30;
/** ...keeping this many of the newest verbatim. */
const KEEP_RECENT = 16;
const FORGET_AFTER_DAYS = 90;

/**
 * Per-conversation history that survives restarts. Old turns are folded into a running summary
 * instead of being dropped, so the bot keeps the gist of long conversations at a fixed cost.
 */
export class ConversationStore {
  private readonly file: JsonFile<Record<string, Conversation>>;
  private readonly compacting = new Set<string>();

  constructor(
    path: string,
    /** Merges the previous summary and the turns being dropped into a new summary. */
    private readonly summarise: (previous: string, transcript: string) => Promise<string>,
  ) {
    this.file = new JsonFile(path, {});
  }

  async load(): Promise<void> {
    await this.file.load();
    const cutoff = Date.now() - FORGET_AFTER_DAYS * 86_400_000;
    for (const [key, conversation] of Object.entries(this.file.data)) {
      if (conversation.updatedAt < cutoff) delete this.file.data[key];
    }
  }

  contents(key: string): Content[] {
    return (this.file.data[key]?.turns ?? []).map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] }));
  }

  summary(key: string): string {
    return this.file.data[key]?.summary ?? "";
  }

  append(key: string, userText: string, modelText: string): void {
    const conversation = (this.file.data[key] ??= { updatedAt: 0, summary: "", turns: [] });
    conversation.turns.push({ role: "user", text: userText }, { role: "model", text: modelText });
    conversation.updatedAt = Date.now();
    void this.file.save();
    if (conversation.turns.length > COMPACT_ABOVE) void this.compact(key, conversation);
  }

  clear(key: string): void {
    delete this.file.data[key];
    void this.file.save();
  }

  private async compact(key: string, conversation: Conversation): Promise<void> {
    if (this.compacting.has(key)) return;
    this.compacting.add(key);
    try {
      const count = conversation.turns.length - KEEP_RECENT;
      const transcript = conversation.turns
        .slice(0, count)
        .map((turn) => `${turn.role === "user" ? "Người dùng" : "Trợ lý"}: ${turn.text}`)
        .join("\n");
      const summary = await this.summarise(conversation.summary, transcript);
      // Turns appended while summarising sit after `count`, so they are kept.
      conversation.turns.splice(0, count);
      conversation.summary = summary;
      await this.file.save();
    } catch (error) {
      // Keep the full turns; the next message retries.
      console.error("[memory] cannot summarise conversation:", error);
    } finally {
      this.compacting.delete(key);
    }
  }
}

// --- Long-term notes about a person --------------------------------------------------------------

interface Note {
  text: string;
  at: number;
}

const MAX_NOTES = 30;
const MAX_NOTE_CHARS = 300;

/** Durable facts about each person (name, needs, budget...), written by the model through tools. */
export class UserMemory {
  private readonly file: JsonFile<Record<string, Note[]>>;

  constructor(path: string) {
    this.file = new JsonFile(path, {});
  }

  async load(): Promise<void> {
    await this.file.load();
  }

  /** Numbered notes for the system prompt, or "" when nothing is known. */
  describe(userKey: string): string {
    return (this.file.data[userKey] ?? []).map((note, index) => `${index + 1}. ${note.text}`).join("\n");
  }

  clear(userKey: string): void {
    delete this.file.data[userKey];
    void this.file.save();
  }

  tools(): Tool[] {
    return [
      {
        name: "save_memory",
        description:
          "Ghi nhớ lâu dài một thông tin về người đang nhắn để dùng cho những lần trò chuyện sau: tên, cách xưng hô, nhu cầu, ngân sách, khu vực quan tâm, sở thích, việc đã hứa. Mỗi lần ghi một ý ngắn, độc lập. Không lưu mật khẩu, số thẻ hay giấy tờ tuỳ thân.",
        parameters: {
          type: "object",
          properties: { note: { type: "string", description: "Một câu ngắn, ví dụ: 'Tìm căn hộ 2 phòng ngủ ở Quận 7, ngân sách 3 tỷ'." } },
          required: ["note"],
        },
        audience: "all",
        run: async (args, { message }) => {
          const text = String(args.note ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NOTE_CHARS);
          if (!text) throw new Error("Thiếu nội dung cần ghi nhớ");
          const notes = (this.file.data[userKey(message)] ??= []);
          if (notes.some((note) => note.text === text)) return "Đã có ghi nhớ này rồi.";
          notes.push({ text, at: Date.now() });
          // Oldest notes make room for new ones.
          if (notes.length > MAX_NOTES) notes.splice(0, notes.length - MAX_NOTES);
          await this.file.save();
          return "Đã ghi nhớ.";
        },
      },
      {
        name: "delete_memory",
        description:
          "Xoá một ghi nhớ về người đang nhắn khi nó sai, đã cũ, hoặc người dùng yêu cầu quên. Dùng số thứ tự trong danh sách ghi nhớ ở hướng dẫn hệ thống.",
        parameters: {
          type: "object",
          properties: { number: { type: "integer", description: "Số thứ tự của ghi nhớ cần xoá." } },
          required: ["number"],
        },
        audience: "all",
        run: async (args, { message }) => {
          const notes = this.file.data[userKey(message)] ?? [];
          const index = Number(args.number) - 1;
          if (!Number.isInteger(index) || index < 0 || index >= notes.length) {
            throw new Error("Không có ghi nhớ với số thứ tự đó");
          }
          const removed = notes.splice(index, 1)[0]!;
          await this.file.save();
          return `Đã xoá: ${removed.text}`;
        },
      },
    ];
  }
}

export function userKey(message: { channel: string; senderId: string }): string {
  return `${message.channel}:${message.senderId}`;
}
