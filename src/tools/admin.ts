import type { Tool } from "../ai/tools.js";
import type { ZaloHub } from "../channels/hub.js";
import type { ChannelId, IncomingMessage } from "../channels/types.js";
import type { AdminRef } from "../config.js";
import { JsonFile } from "../store.js";

interface Ticket {
  code: number;
  channel: ChannelId;
  threadId: string;
  isGroup: boolean;
  senderName: string;
  question: string;
  createdAt: number;
}

interface Store {
  next: number;
  open: Ticket[];
}

const MAX_OPEN_PER_THREAD = 3;

/**
 * Escalation to a human: the model files a question with `ask_admin`, the admin receives it on
 * Zalo and answers with `#<code> <answer>`, and the answer is relayed to the original chat.
 */
export class AdminDesk {
  private readonly file: JsonFile<Store>;

  constructor(
    private readonly hub: ZaloHub,
    private readonly admins: AdminRef[],
    path: string,
    /** Lets the conversation memory know what the admin told the user. */
    private readonly onAnswered: (ticket: Ticket, answer: string) => void,
  ) {
    this.file = new JsonFile<Store>(path, { next: 1, open: [] });
  }

  private get store(): Store {
    return this.file.data;
  }

  async load(): Promise<void> {
    await this.file.load();
  }

  isAdmin(message: IncomingMessage): boolean {
    return this.admins.some((admin) => admin.channel === message.channel && admin.id === message.senderId);
  }

  /** Text to send for `/tickets`. */
  listOpen(): string {
    if (this.store.open.length === 0) return "Không có câu hỏi nào đang chờ.";
    return this.store.open.map((ticket) => `#${ticket.code} ${ticket.senderName || ticket.threadId}: ${ticket.question}`).join("\n");
  }

  /**
   * Handles an admin message of the form `#12 answer text`.
   * Returns the confirmation to show the admin, or null if the message is not a ticket answer.
   */
  async handleAnswer(message: IncomingMessage): Promise<string | null> {
    const match = /^#(\d+)\s+([\s\S]+)$/.exec(message.text.trim());
    if (!match) return null;
    const code = Number(match[1]);
    const answer = match[2]!.trim();
    const ticket = this.store.open.find((candidate) => candidate.code === code);
    if (!ticket) return `Không tìm thấy câu hỏi #${code} (có thể đã được trả lời).`;

    await this.hub.send(ticket.channel, ticket, `Phản hồi từ quản trị viên:\n${answer}`);
    this.store.open = this.store.open.filter((candidate) => candidate !== ticket);
    await this.save();
    this.onAnswered(ticket, answer);
    return `Đã chuyển câu trả lời #${code} cho ${ticket.senderName || ticket.threadId}.`;
  }

  tools(): Tool[] {
    const recipient = this.admins[0];
    if (!recipient) return [];
    return [
      {
        name: "ask_admin",
        description:
          "Chuyển câu hỏi cho quản trị viên (người thật) khi tài liệu không có câu trả lời, khi cần quyết định của con người (khiếu nại, ngoại lệ, báo giá riêng), hoặc khi người dùng yêu cầu gặp người hỗ trợ. Câu trả lời sẽ được gửi lại cho người dùng sau, không có ngay.",
        parameters: {
          type: "object",
          properties: {
            question: { type: "string", description: "Câu hỏi cần admin trả lời, viết đầy đủ để đọc riêng vẫn hiểu." },
            context: { type: "string", description: "Tóm tắt ngắn bối cảnh hội thoại và những gì đã tra cứu được." },
          },
          required: ["question"],
        },
        audience: "all",
        run: async (args, { message }) => {
          const question = String(args.question ?? "").trim();
          if (!question) throw new Error("Thiếu nội dung câu hỏi");
          const pending = this.store.open.filter((t) => t.channel === message.channel && t.threadId === message.threadId);
          if (pending.length >= MAX_OPEN_PER_THREAD) {
            return "Hội thoại này đã có nhiều câu hỏi đang chờ admin. Hãy báo người dùng chờ phản hồi, không gửi thêm.";
          }

          const ticket: Ticket = {
            code: this.store.next++,
            channel: message.channel,
            threadId: message.threadId,
            isGroup: message.isGroup,
            senderName: message.senderName,
            question,
            createdAt: Date.now(),
          };
          const lines = [
            `[Cần hỗ trợ #${ticket.code}]`,
            `Người hỏi: ${message.senderName || message.senderId} (kênh ${message.channel}${message.isGroup ? ", trong nhóm" : ""})`,
            `Câu hỏi: ${question}`,
            args.context ? `Bối cảnh: ${String(args.context)}` : "",
            `Trả lời bằng cách nhắn: #${ticket.code} <nội dung>`,
          ];
          await this.hub.send(recipient.channel, { threadId: recipient.id, isGroup: false }, lines.filter(Boolean).join("\n"));
          this.store.open.push(ticket);
          await this.save();
          return `Đã gửi cho admin, mã #${ticket.code}. Báo người dùng rằng câu hỏi đã được chuyển và sẽ có phản hồi ngay trong cuộc trò chuyện này.`;
        },
      },
    ];
  }

  private save(): Promise<void> {
    return this.file.save();
  }
}
