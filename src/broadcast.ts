import type { Tool } from "./ai/tools.js";
import type { ZaloHub } from "./channels/hub.js";
import { sleep } from "./channels/text.js";
import type { IncomingMessage } from "./channels/types.js";
import type { BroadcastAudience, Contacts } from "./contacts.js";
import { describeRepeat, formatTime, parseSchedule, type Repeat, type Scheduler } from "./tools/scheduler.js";

interface Draft {
  code: string;
  text: string;
  audience: BroadcastAudience;
  /** Set for a scheduled broadcast; absent means "send as soon as it is confirmed". */
  at?: number;
  repeat: Repeat;
  author: IncomingMessage;
  expiresAt: number;
}

export interface BroadcastResult {
  sent: number;
  failed: number;
}

const DRAFT_TTL_MS = 30 * 60_000;
/** Pause between recipients, so a broadcast never looks like a burst of spam to the platform. */
const SEND_GAP_MS = 500;
const MAX_TEXT_CHARS = 4000;
const AUDIENCE_LABEL: Record<BroadcastAudience, string> = { users: "người dùng đã nhắn riêng", groups: "các nhóm", all: "người dùng đã nhắn riêng và các nhóm" };

/**
 * Messages from an admin to everyone the bot knows. Nothing goes out on a single instruction:
 * a broadcast is first a draft, shown back with its reach, and is only sent (or scheduled) when
 * an admin types the confirmation command. That keeps a misread request, or a model acting on
 * injected text, from messaging every customer.
 */
export class Broadcaster {
  private readonly drafts = new Map<string, Draft>();
  private sending = false;

  constructor(
    private readonly hub: ZaloHub,
    private readonly contacts: Contacts,
    private readonly scheduler: Scheduler,
    /** Called for every message actually delivered, so it lands in the message log. */
    private readonly onSent: (recipient: { channel: string; threadId: string; isGroup: boolean }, text: string) => void,
  ) {}

  /** Creates a draft and returns the preview to show the admin. */
  draft(author: IncomingMessage, text: string, audience: BroadcastAudience, schedule?: { at: number; repeat: Repeat }): string {
    const body = text.trim();
    if (!body) throw new Error("Thiếu nội dung thông báo");
    if (body.length > MAX_TEXT_CHARS) throw new Error(`Thông báo dài quá ${MAX_TEXT_CHARS} ký tự`);
    const reach = this.contacts.recipients(audience).length;
    if (reach === 0) throw new Error(`Chưa có ai để gửi (${AUDIENCE_LABEL[audience]})`);

    for (const [code, draft] of this.drafts) if (draft.expiresAt < Date.now()) this.drafts.delete(code);
    const code = String(Math.floor(1000 + Math.random() * 9000));
    this.drafts.set(code, { code, text: body, audience, at: schedule?.at, repeat: schedule?.repeat ?? "none", author, expiresAt: Date.now() + DRAFT_TTL_MS });

    const when = schedule ? `lúc ${formatTime(schedule.at)}${describeRepeat(schedule.repeat)}` : "ngay khi xác nhận";
    return [
      `Bản nháp thông báo #${code}`,
      `Gửi tới: ${reach} nơi (${AUDIENCE_LABEL[audience]})`,
      `Thời điểm: ${when}`,
      "Nội dung:",
      body,
      "",
      `Nhắn /confirm ${code} để ${schedule ? "đặt lịch" : "gửi"}, /cancel ${code} để huỷ. Bản nháp hết hạn sau 30 phút.`,
    ].join("\n");
  }

  /** Text to answer `/confirm <code>` with. Sending continues in the background and reports back. */
  async confirm(code: string, admin: IncomingMessage): Promise<string> {
    const draft = this.drafts.get(code);
    if (!draft || draft.expiresAt < Date.now()) return `Không có bản nháp #${code} (có thể đã hết hạn).`;
    this.drafts.delete(code);

    if (draft.at) {
      if (draft.at < Date.now() + 30_000) return "Thời điểm đã hẹn qua mất rồi; hãy tạo lại thông báo.";
      const task = await this.scheduler.addJob(admin, draft.at, draft.repeat, { type: "broadcast", text: draft.text, audience: draft.audience }, `Gửi thông báo tới ${AUDIENCE_LABEL[draft.audience]}: ${draft.text.slice(0, 80)}`);
      return `Đã đặt lịch gửi thông báo (mã ${task.id}) lúc ${formatTime(draft.at)}${describeRepeat(draft.repeat)}. Muốn huỷ thì bảo mình huỷ lịch ${task.id}.`;
    }
    if (this.sending) return "Đang có một đợt gửi khác chạy dở; thử lại sau ít phút.";

    const reach = this.contacts.recipients(draft.audience).length;
    void this.send(draft.text, draft.audience).then((result) =>
      this.hub.reply(admin, `Đã gửi xong thông báo #${code}: ${result.sent} thành công${result.failed ? `, ${result.failed} lỗi (xem log)` : ""}.`).catch(() => {}),
    );
    return `Đang gửi thông báo #${code} tới ${reach} nơi, mỗi nơi cách nhau nửa giây. Mình sẽ báo khi xong.`;
  }

  cancel(code: string): string {
    return this.drafts.delete(code) ? `Đã huỷ bản nháp #${code}.` : `Không có bản nháp #${code}.`;
  }

  /** Delivers to every current recipient, one at a time. Used by confirmed drafts and scheduled jobs. */
  async send(text: string, audience: BroadcastAudience): Promise<BroadcastResult> {
    this.sending = true;
    const result: BroadcastResult = { sent: 0, failed: 0 };
    try {
      for (const recipient of this.contacts.recipients(audience)) {
        try {
          await this.hub.send(recipient.channel, recipient, text);
          this.onSent(recipient, text);
          result.sent++;
        } catch (error) {
          result.failed++;
          console.error(`[broadcast] cannot reach ${recipient.channel}:${recipient.threadId} (${recipient.label}):`, error instanceof Error ? error.message : error);
        }
        await sleep(SEND_GAP_MS);
      }
    } finally {
      this.sending = false;
    }
    console.log(`[broadcast] done: ${result.sent} sent, ${result.failed} failed`);
    return result;
  }

  tools(): Tool[] {
    return [
      {
        name: "draft_broadcast",
        description:
          "Soạn bản nháp một thông báo gửi hàng loạt tới người dùng và/hoặc các nhóm, gửi ngay hoặc hẹn giờ (một lần, hằng ngày, hằng tuần). Công cụ này KHÔNG gửi gì: nó trả về bản xem trước kèm mã, và chỉ khi quản trị viên tự nhắn lệnh /confirm <mã> thì thông báo mới được gửi hoặc đặt lịch. Sau khi gọi, chuyển nguyên văn bản xem trước cho quản trị viên. Chỉ dùng khi quản trị viên yêu cầu gửi thông báo cho mọi người.",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "Nội dung thông báo, đúng như quản trị viên muốn gửi. Văn bản thuần, không Markdown." },
            audience: { type: "string", enum: ["users", "groups", "all"], description: "users: người đã nhắn riêng cho bot (mặc định); groups: các nhóm; all: cả hai." },
            time: { type: "string", description: "Bỏ trống để gửi ngay khi xác nhận. Hẹn giờ thì dùng ISO 8601 có múi giờ, ví dụ 2026-10-12T08:00:00+07:00." },
            repeat: { type: "string", enum: ["none", "daily", "weekly"], description: "Lặp lại; chỉ có nghĩa khi có time. Mặc định none." },
          },
          required: ["message"],
        },
        audience: "admin",
        run: async (args, { message, scheduled }) => {
          if (scheduled) throw new Error("Không thể soạn thông báo hàng loạt từ bên trong một tác vụ hẹn giờ");
          const audience: BroadcastAudience = args.audience === "groups" || args.audience === "all" ? args.audience : "users";
          const schedule = args.time ? parseSchedule(args.time, args.repeat) : undefined;
          return this.draft(message, String(args.message ?? ""), audience, schedule);
        },
      },
    ];
  }
}
