import type { Tool } from "../ai/tools.js";
import type { ChannelId, IncomingMessage } from "../channels/types.js";
import { JsonFile } from "../store.js";
import { nextCron, parseCron } from "./cron.js";

export type Repeat = "none" | "daily" | "weekly";

/** When a task first runs and how it comes back: a fixed period, or a cron expression. */
export interface Schedule {
  at: number;
  repeat: Repeat;
  /** Five-field cron expression in Vietnam time; when set it decides every run and `repeat` is "none". */
  cron?: string;
}

/** Work the bot does itself at the due time, with no model call. */
export type ScheduledJob = { type: "broadcast"; text: string; audience: "users" | "groups" | "all" } | { type: "reload" };

export interface ScheduledTask {
  id: number;
  channel: ChannelId;
  threadId: string;
  isGroup: boolean;
  /** The chat it was asked in, when the result goes to another one (an admin scheduling for a group). */
  createdIn?: string;
  /** Who asked for it; the task runs with that person's permissions. */
  senderId: string;
  senderName: string;
  /** Epoch milliseconds of the next run. */
  at: number;
  repeat: Repeat;
  /** Five-field cron expression in Vietnam time; when set, it decides the next run instead of `repeat`. */
  cron?: string;
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
/** A cron schedule may not fire more often than this: every agent run costs a model call and a message. */
const MIN_CRON_GAP_MS = 5 * 60_000;

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
    /** Looks up a group the bot is in, by id or name, for tasks whose result goes to a group. */
    private readonly findGroup: (ref: string) => { channel: ChannelId; threadId: string; name?: string } | undefined = () => undefined,
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
      const next = nextRun(task);
      if (next === undefined) this.remove(task.id);
      else task.at = next;
      await this.file.save();
      void this.run(task)
        .catch((error) => console.error(`[scheduler] task #${task.id} failed:`, error))
        .finally(() => this.running.delete(task.id));
    }
  }

  /** Schedules a system job on behalf of an admin; results are reported in the admin's own chat. */
  async addJob(admin: IncomingMessage, schedule: Schedule, job: ScheduledJob, description: string): Promise<ScheduledTask> {
    const task: ScheduledTask = {
      id: this.file.data.next++,
      channel: admin.channel,
      threadId: admin.threadId,
      isGroup: admin.isGroup,
      senderId: admin.senderId,
      senderName: admin.senderName,
      ...schedule,
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

  /** Tasks that deliver to this chat, and tasks asked for here that deliver to a group. */
  private inThread(message: IncomingMessage): ScheduledTask[] {
    const here = `${message.channel}:${message.threadId}`;
    return this.file.data.tasks.filter((task) => `${task.channel}:${task.threadId}` === here || task.createdIn === here);
  }

  /**
   * Schedules a task for the agent to carry out later; behind both the schedule_task tool and
   * the /task command. Returns the confirmation to show.
   */
  async create(message: IncomingMessage, isAdmin: boolean, request: { instruction?: unknown; time?: unknown; repeat?: unknown; cron?: unknown; group?: unknown }): Promise<string> {
    const instruction = String(request.instruction ?? "").trim();
    if (!instruction) throw new Error("Thiếu nội dung việc cần làm");
    const schedule = parseSchedule(request);
    if (this.inThread(message).length >= MAX_PER_THREAD) {
      throw new Error(`Cuộc trò chuyện này đã có ${MAX_PER_THREAD} lịch hẹn; hãy huỷ bớt trước`);
    }

    // Only an admin may have the bot write somewhere other than the chat the request came from.
    const groupRef = String(request.group ?? "").trim();
    if (groupRef && !isAdmin) throw new Error("Chỉ quản trị viên mới hẹn được việc gửi vào một nhóm khác");
    const group = groupRef ? this.findGroup(groupRef) : undefined;
    if (groupRef && !group) throw new Error(`Không tìm thấy nhóm "${groupRef}"; tên và ID các nhóm có trong list_contacts hoặc lệnh /groups`);
    const elsewhere = group && !(group.channel === message.channel && group.threadId === message.threadId);

    const task: ScheduledTask = {
      id: this.file.data.next++,
      channel: group?.channel ?? message.channel,
      threadId: group?.threadId ?? message.threadId,
      isGroup: group ? true : message.isGroup,
      ...(elsewhere ? { createdIn: `${message.channel}:${message.threadId}` } : {}),
      senderId: message.senderId,
      senderName: message.senderName,
      ...schedule,
      instruction,
    };
    this.file.data.tasks.push(task);
    await this.file.save();
    const where = group ? `, tin sẽ gửi vào nhóm ${group.name || group.threadId}` : "";
    return `Đã hẹn (mã ${task.id}) lúc ${formatTime(schedule.at)}${describeRepeat(schedule)}${where}.`;
  }

  /** Text to send for `/tasks`: the pending tasks of this chat, one per line. */
  describe(message: IncomingMessage): string {
    const tasks = this.inThread(message);
    if (tasks.length === 0) return "Không có lịch hẹn nào.";
    const lines = tasks.map((task) =>
      [
        `#${task.id}`,
        `lần tới: ${formatTime(task.at)}`,
        task.cron ? `cron ${task.cron}` : task.repeat === "none" ? "một lần" : task.repeat === "daily" ? "hằng ngày" : "hằng tuần",
        task.createdIn ? `gửi vào nhóm ${this.findGroup(task.threadId)?.name || task.threadId}` : "",
        task.instruction,
      ]
        .filter(Boolean)
        .join(" | "),
    );
    return [`${tasks.length} lịch hẹn:`, ...lines, "Huỷ bằng /deltask <mã>."].join("\n");
  }

  /** Cancels one of this chat's tasks; behind both the cancel_task tool and the /deltask command. */
  async cancel(message: IncomingMessage, id: number): Promise<string> {
    const task = this.inThread(message).find((candidate) => candidate.id === id);
    if (!task) throw new Error("Không có lịch hẹn với mã đó trong cuộc trò chuyện này");
    this.remove(task.id);
    await this.file.save();
    return `Đã huỷ lịch hẹn ${task.id}.`;
  }

  tools(): Tool[] {
    return [
      {
        name: "schedule_task",
        description:
          "Hẹn một việc để tự làm vào thời điểm sau: nhắc lịch, hỏi thăm lại khách, gửi thông tin định kỳ. Đến giờ, bạn sẽ được gọi lại với phần 'instruction' và tự soạn tin gửi đi (có thể dùng công cụ để tra cứu trước). Chạy một lần thì điền 'time'; lặp lại theo lịch chi tiết (mỗi giờ, mỗi 30 phút, chỉ ngày làm việc, trong một khung giờ...) thì điền 'cron'. Tin được gửi vào chính cuộc trò chuyện này; khi quản trị viên muốn tin được gửi vào một nhóm thì BẮT BUỘC điền 'group', nếu không tin sẽ về chat của họ chứ không vào nhóm.",
        parameters: {
          type: "object",
          properties: {
            time: {
              type: "string",
              description: "Thời điểm chạy, dạng ISO 8601 có múi giờ, ví dụ 2026-10-11T09:00:00+07:00. Tính từ thời gian hiện tại trong hướng dẫn hệ thống. Bắt buộc khi không có cron.",
            },
            instruction: {
              type: "string",
              description: "Việc cần làm khi đến giờ, viết đầy đủ để đọc riêng vẫn hiểu. Ví dụ: 'Nhắc anh Nam 15h hôm nay có lịch xem căn hộ ở Quận 7'.",
            },
            repeat: { type: "string", enum: ["none", "daily", "weekly"], description: "Lặp lại kể từ 'time'. Mặc định none." },
            cron: { type: "string", description: CRON_HELP },
            group: {
              type: "string",
              description: "Chỉ dành cho quản trị viên: ID nhóm (ví dụ zgr-..., lấy từ list_contacts) hoặc tên nhóm sẽ nhận tin khi đến giờ. Bỏ trống để gửi trong chính cuộc trò chuyện này.",
            },
          },
          required: ["instruction"],
        },
        audience: "all",
        run: async (args, { message, isAdmin, scheduled }) => {
          if (scheduled) throw new Error("Không thể tạo lịch hẹn mới từ bên trong một tác vụ hẹn giờ");
          return this.create(message, isAdmin, args);
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
          return tasks.map((task) => ({
            id: task.id,
            time: formatTime(task.at),
            repeat: task.cron ? `cron ${task.cron}` : task.repeat,
            kind: task.job?.type ?? "agent",
            instruction: task.instruction,
            ...(task.createdIn ? { sendsToGroup: this.findGroup(task.threadId)?.name || task.threadId } : {}),
          }));
        },
      },
      {
        name: "schedule_reload",
        description:
          "Hẹn giờ để bot tự nạp lại tài liệu, quy trình, công cụ và hướng dẫn hệ thống (giống lệnh /reload), một lần hoặc định kỳ. Chỉ dùng khi quản trị viên yêu cầu.",
        parameters: {
          type: "object",
          properties: {
            time: { type: "string", description: "Thời điểm chạy lần đầu, dạng ISO 8601 có múi giờ, ví dụ 2026-10-12T06:00:00+07:00. Bắt buộc khi không có cron." },
            repeat: { type: "string", enum: ["none", "daily", "weekly"], description: "Lặp lại kể từ 'time'. Mặc định none." },
            cron: { type: "string", description: CRON_HELP },
          },
        },
        audience: "admin",
        run: async (args, { message, scheduled }) => {
          if (scheduled) throw new Error("Không thể tạo lịch hẹn mới từ bên trong một tác vụ hẹn giờ");
          const schedule = parseSchedule(args);
          const task = await this.addJob(message, schedule, { type: "reload" }, "Nạp lại tài liệu và cấu hình");
          return `Đã hẹn nạp lại (mã ${task.id}) lúc ${formatTime(schedule.at)}${describeRepeat(schedule)}.`;
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
          return this.cancel(message, Number(args.id));
        },
      },
    ];
  }
}

const CRON_HELP =
  'Lịch lặp kiểu crontab, 5 trường "phút giờ ngày tháng thứ" theo giờ Việt Nam (thứ: 0 hoặc 7 là Chủ nhật; chỉ dùng số, dấu phẩy, a-b, */n). Ví dụ: "0 8-20 * * *" = đầu mỗi giờ từ 8h đến 20h hằng ngày; "*/30 9-17 * * 1-5" = mỗi 30 phút trong giờ làm việc từ thứ Hai đến thứ Sáu; "0 9 1 * *" = 9h ngày 1 hằng tháng. Khi có cron thì bỏ qua time và repeat; lịch chạy mãi cho tới khi bị huỷ. Các lần chạy phải cách nhau ít nhất 5 phút.';

export const TASK_USAGE = `Cách dùng: /task <lịch> | <việc cần làm>
Quản trị viên, để tin gửi vào một nhóm: /task <lịch> | <tên hoặc ID nhóm> | <việc cần làm>
<lịch> là một giờ để chạy một lần (15:30, hoặc 9:00 12/10, hoặc 2026-10-12 09:00), hay cron 5 trường "phút giờ ngày tháng thứ" để lặp lại; tất cả theo giờ Việt Nam.
Ví dụ:
/task 15:30 | Nhắc tôi gọi lại cho chủ nhà
/task 0 8-20 * * * | Demo Zagent | Lấy giá vàng và USD mới nhất rồi gửi cho mọi người`;

/** Splits what follows `/task` into the arguments of `Scheduler.create`. */
export function parseTaskCommand(body: string): { instruction: string; time?: string; cron?: string; group?: string } {
  const parts = body.split("|").map((part) => part.trim());
  const when = parts.shift() ?? "";
  // With three parts or more, the one after the schedule names the group; "|" may appear in the rest.
  const group = parts.length > 1 ? parts.shift() : undefined;
  const instruction = parts.join(" | ");
  if (!when || !instruction || group === "") throw new Error("Lệnh chưa đủ các phần.");
  return { ...parseWhen(when), group, instruction };
}

/** A cron expression, or a time typed by hand in Vietnam time: "15:30", "9h", "9:00 12/10", "9:00 12/10/2026", "2026-10-12 09:00". */
function parseWhen(text: string): { cron: string } | { time: string } {
  if (text.split(/\s+/).length === 5) return { cron: text };
  const pad = (value: string | number) => String(value).padStart(2, "0");
  const clock = /^(\d{1,2})(?:[:h](\d{2})|h)(?:\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?)?$/.exec(text);
  if (clock) {
    const [, hour, minute = "00", day, month, year] = clock;
    // Shifted so that the UTC getters read Vietnam wall-clock time.
    const today = new Date(Date.now() + 7 * 3_600_000);
    const on = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(hour!)}:${minute}:00+07:00`;
    if (day) return { time: `${year ?? today.getUTCFullYear()}-${pad(month!)}-${pad(day)}T${pad(hour!)}:${minute}:00+07:00` };
    // A bare time that has already passed today means tomorrow.
    return { time: Date.parse(on(today)) > Date.now() + 30_000 ? on(today) : on(new Date(today.getTime() + 86_400_000)) };
  }
  const dated = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/.exec(text);
  return { time: dated ? `${dated[1]}T${pad(dated[2]!)}:${dated[3]}:00+07:00` : text };
}

/** When the task runs again after the run that is starting now; undefined for a one-off. */
function nextRun(task: ScheduledTask): number | undefined {
  if (task.cron) return nextCron(parseCron(task.cron), Date.now());
  if (task.repeat === "none") return undefined;
  let at = task.at;
  while (at <= Date.now()) at += PERIOD_MS[task.repeat];
  return at;
}

/** Validates a schedule as given by the model: a cron expression, or an ISO 8601 time with an optional none/daily/weekly repeat. */
export function parseSchedule(args: { time?: unknown; repeat?: unknown; cron?: unknown }): Schedule {
  const expression = String(args.cron ?? "").trim().replace(/\s+/g, " ");
  if (expression) {
    const cron = parseCron(expression);
    const first = nextCron(cron, Date.now());
    if (first === undefined) throw new Error(`Lịch cron "${expression}" không bao giờ đến giờ`);
    // An hour of runs shows the tightest spacing of any expression.
    for (let run = first, count = 0; count < 60; count++) {
      const following = nextCron(cron, run);
      if (following === undefined) break;
      if (following - run < MIN_CRON_GAP_MS) throw new Error("Lịch cron quá dày: các lần chạy phải cách nhau ít nhất 5 phút");
      run = following;
    }
    return { at: first, repeat: "none", cron: expression };
  }
  const at = Date.parse(String(args.time ?? ""));
  if (Number.isNaN(at)) throw new Error("Thiếu thời gian hoặc thời gian không hợp lệ: cần một ngày giờ có thật (ISO 8601 có múi giờ), hoặc cron");
  if (at < Date.now() + 30_000) throw new Error("Thời gian phải ở tương lai (ít nhất 1 phút nữa)");
  if (at > Date.now() + MAX_AHEAD_MS) throw new Error("Chỉ hẹn được trong vòng 1 năm");
  return { at, repeat: args.repeat === "daily" || args.repeat === "weekly" ? args.repeat : "none" };
}

/** e.g. "09:00 Thứ Hai, 12 tháng 10, 2026"; callers put their own "lúc" in front. */
export function formatTime(at: number): string {
  return new Date(at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "full", timeStyle: "short" }).replace(/^lúc\s+/i, "");
}

export const describeRepeat = ({ repeat, cron }: { repeat: Repeat; cron?: string }) =>
  cron ? `, lặp theo cron "${cron}" (giờ Việt Nam)` : repeat === "none" ? "" : `, lặp ${repeat === "daily" ? "hằng ngày" : "hằng tuần"}`;
