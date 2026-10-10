import type { Tool } from "../ai/tools.js";
import type { ChannelId, IncomingMessage } from "../channels/types.js";
import { JsonFile } from "../store.js";

export type Repeat = "none" | "daily" | "weekly";

/** Work the bot does itself at the due time, with no model call. */
export type ScheduledJob = { type: "broadcast"; text: string; audience: "users" | "groups" | "all" } | { type: "reload" };

export interface ScheduledTask {
  id: number;
  channel: ChannelId;
  threadId: string;
  isGroup: boolean;
  /** Who asked for it; the task runs with that person's permissions. */
  senderId: string;
  senderName: string;
  /** Epoch milliseconds of the next run. */
  at: number;
  repeat: Repeat;
  /** For an agent task: what to do. For a job: a human-readable description of it. */
  instruction: string;
  /** Set for system jobs created by an admin; absent for tasks the agent carries out. */
  job?: ScheduledJob;
}

interface Store {
  next: number;
  tasks: ScheduledTask[];
}

const MAX_PER_THREAD = 10;
const MAX_AHEAD_MS = 366 * 86_400_000;
const PERIOD_MS: Record<Repeat, number> = { none: 0, daily: 86_400_000, weekly: 7 * 86_400_000 };
const TICK_MS = 20_000;

/**
 * Lets the agent act later without being prompted: reminders, follow-ups, recurring reports.
 * When a task is due, `run` hands it back to the agent, which writes and sends the message.
 */
export class Scheduler {
  private readonly file: JsonFile<Store>;
  private timer?: NodeJS.Timeout;
  private readonly running = new Set<number>();

  constructor(
    path: string,
    private readonly run: (task: ScheduledTask) => Promise<void>,
  ) {
    this.file = new JsonFile<Store>(path, { next: 1, tasks: [] });
  }

  async start(): Promise<void> {
    await this.file.load();
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const due = this.file.data.tasks.filter((task) => task.at <= Date.now() && !this.running.has(task.id));
    for (const task of due) {
      this.running.add(task.id);
      // Reschedule or remove before running, so a crash mid-run cannot make a task fire in a loop.
      if (task.repeat === "none") this.remove(task.id);
      else while (task.at <= Date.now()) task.at += PERIOD_MS[task.repeat];
      await this.file.save();
      void this.run(task)
        .catch((error) => console.error(`[scheduler] task #${task.id} failed:`, error))
        .finally(() => this.running.delete(task.id));
    }
  }

  /** Schedules a system job on behalf of an admin; results are reported in the admin's own chat. */
  async addJob(admin: IncomingMessage, at: number, repeat: Repeat, job: ScheduledJob, description: string): Promise<ScheduledTask> {
    const task: ScheduledTask = {
      id: this.file.data.next++,
      channel: admin.channel,
      threadId: admin.threadId,
      isGroup: admin.isGroup,
      senderId: admin.senderId,
      senderName: admin.senderName,
      at,
      repeat,
      instruction: description,
      job,
    };
    this.file.data.tasks.push(task);
    await this.file.save();
    return task;
  }

  private remove(id: number): void {
    this.file.data.tasks = this.file.data.tasks.filter((task) => task.id !== id);
  }

  private inThread(message: IncomingMessage): ScheduledTask[] {
    return this.file.data.tasks.filter((task) => task.channel === message.channel && task.threadId === message.threadId);
  }

  tools(): Tool[] {
    return [
      {
        name: "schedule_task",
        description:
          "Hẹn một việc để tự làm vào thời điểm sau, trong chính cuộc trò chuyện này: nhắc lịch, hỏi thăm lại khách, gửi thông tin định kỳ. Đến giờ, bạn sẽ được gọi lại với phần 'instruction' và tự soạn tin gửi đi (có thể dùng công cụ để tra cứu trước).",
        parameters: {
          type: "object",
          properties: {
            time: {
              type: "string",
              description: "Thời điểm chạy, dạng ISO 8601 có múi giờ, ví dụ 2026-10-11T09:00:00+07:00. Tính từ thời gian hiện tại trong hướng dẫn hệ thống.",
            },
            instruction: {
              type: "string",
              description: "Việc cần làm khi đến giờ, viết đầy đủ để đọc riêng vẫn hiểu. Ví dụ: 'Nhắc anh Nam 15h hôm nay có lịch xem căn hộ ở Quận 7'.",
            },
            repeat: { type: "string", enum: ["none", "daily", "weekly"], description: "Lặp lại. Mặc định none." },
          },
          required: ["time", "instruction"],
        },
        audience: "all",
        run: async (args, { message, scheduled }) => {
          if (scheduled) throw new Error("Không thể tạo lịch hẹn mới từ bên trong một tác vụ hẹn giờ");
          const instruction = String(args.instruction ?? "").trim();
          if (!instruction) throw new Error("Thiếu nội dung việc cần làm");
          const { at, repeat } = parseSchedule(args.time, args.repeat);
          if (this.inThread(message).length >= MAX_PER_THREAD) {
            throw new Error(`Cuộc trò chuyện này đã có ${MAX_PER_THREAD} lịch hẹn; hãy huỷ bớt trước`);
          }

          const task: ScheduledTask = {
            id: this.file.data.next++,
            channel: message.channel,
            threadId: message.threadId,
            isGroup: message.isGroup,
            senderId: message.senderId,
            senderName: message.senderName,
            at,
            repeat,
            instruction,
          };
          this.file.data.tasks.push(task);
          await this.file.save();
          return `Đã hẹn (mã ${task.id}) lúc ${formatTime(at)}${describeRepeat(repeat)}.`;
        },
      },
      {
        name: "list_tasks",
        description: "Xem các lịch hẹn đang chờ của cuộc trò chuyện này.",
        parameters: { type: "object", properties: {} },
        audience: "all",
        run: async (_args, { message }) => {
          const tasks = this.inThread(message);
          if (tasks.length === 0) return "Không có lịch hẹn nào.";
          return tasks.map((task) => ({ id: task.id, time: formatTime(task.at), repeat: task.repeat, kind: task.job?.type ?? "agent", instruction: task.instruction }));
        },
      },
      {
        name: "schedule_reload",
        description:
          "Hẹn giờ để bot tự nạp lại tài liệu, quy trình, công cụ và hướng dẫn hệ thống (giống lệnh /reload), một lần hoặc định kỳ. Chỉ dùng khi quản trị viên yêu cầu.",
        parameters: {
          type: "object",
          properties: {
            time: { type: "string", description: "Thời điểm chạy lần đầu, dạng ISO 8601 có múi giờ, ví dụ 2026-10-12T06:00:00+07:00." },
            repeat: { type: "string", enum: ["none", "daily", "weekly"], description: "Lặp lại. Mặc định none." },
          },
          required: ["time"],
        },
        audience: "admin",
        run: async (args, { message, scheduled }) => {
          if (scheduled) throw new Error("Không thể tạo lịch hẹn mới từ bên trong một tác vụ hẹn giờ");
          const { at, repeat } = parseSchedule(args.time, args.repeat);
          const task = await this.addJob(message, at, repeat, { type: "reload" }, "Nạp lại tài liệu và cấu hình");
          return `Đã hẹn nạp lại (mã ${task.id}) lúc ${formatTime(at)}${describeRepeat(repeat)}.`;
        },
      },
      {
        name: "cancel_task",
        description: "Huỷ một lịch hẹn của cuộc trò chuyện này theo mã.",
        parameters: {
          type: "object",
          properties: { id: { type: "integer", description: "Mã lịch hẹn." } },
          required: ["id"],
        },
        audience: "all",
        run: async (args, { message }) => {
          const task = this.inThread(message).find((candidate) => candidate.id === Number(args.id));
          if (!task) throw new Error("Không có lịch hẹn với mã đó trong cuộc trò chuyện này");
          this.remove(task.id);
          await this.file.save();
          return `Đã huỷ lịch hẹn ${task.id}.`;
        },
      },
    ];
  }
}

/** Validates a time and repeat as given by the model (ISO 8601 with offset; none/daily/weekly). */
export function parseSchedule(time: unknown, repeatInput: unknown): { at: number; repeat: Repeat } {
  const at = Date.parse(String(time ?? ""));
  if (Number.isNaN(at)) throw new Error("Thời gian không hợp lệ, cần dạng ISO 8601 có múi giờ");
  if (at < Date.now() + 30_000) throw new Error("Thời gian phải ở tương lai (ít nhất 1 phút nữa)");
  if (at > Date.now() + MAX_AHEAD_MS) throw new Error("Chỉ hẹn được trong vòng 1 năm");
  return { at, repeat: repeatInput === "daily" || repeatInput === "weekly" ? repeatInput : "none" };
}

/** e.g. "09:00 Thứ Hai, 12 tháng 10, 2026"; callers put their own "lúc" in front. */
export function formatTime(at: number): string {
  return new Date(at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "full", timeStyle: "short" }).replace(/^lúc\s+/i, "");
}

export const describeRepeat = (repeat: Repeat) => (repeat === "none" ? "" : `, lặp ${repeat === "daily" ? "hằng ngày" : "hằng tuần"}`);
