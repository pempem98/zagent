import { JsonFile } from "./store.js";
import type { MemberSheet, ReminderKind } from "./tools/members.js";
import { UNREACHABLE_CHAT, type ScheduledTask } from "./tools/scheduler.js";

/**
 * Runs hourly from 9h to 21h. The first run that succeeds posts the day's messages; later runs
 * find them already sent and do nothing. So a run that failed, or never happened because the
 * bot was down, is made up for within the hour.
 */
export const BIRTHDAY_CRON = "0 9-21 * * *";
const FIRST_HOUR = 9;
const LAST_HOUR = 21;

/** Per group, what has been posted today; older days are dropped as soon as a new day starts. */
type SentLog = Record<string, { day: string; kinds: ReminderKind[] }>;

/** Delivers the birthday messages of a group once a day, retrying what failed on the next hourly run. */
export class BirthdayReminders {
  private readonly sent: JsonFile<SentLog>;
  /** Groups whose admins were already told about a failure today: one warning a day, not one an hour. */
  private readonly warned = new Map<string, string>();

  constructor(
    path: string,
    private readonly members: MemberSheet | undefined,
    private readonly say: (task: ScheduledTask, text: string) => Promise<void>,
    private readonly notifyAdmins: (text: string) => void,
  ) {
    this.sent = new JsonFile<SentLog>(path, {});
  }

  load(): Promise<unknown> {
    return this.sent.load();
  }

  async run(task: ScheduledTask, now = Date.now()): Promise<void> {
    const vn = new Date(now + 7 * 3_600_000);
    const day = vn.toISOString().slice(0, 10);
    const hour = vn.getUTCHours();
    // A run caught up at start-up outside the window would post in the middle of the night.
    if (hour < FIRST_HOUR || hour > LAST_HOUR) return;
    const group = `${task.channel}:${task.threadId}`;
    if (!this.members) return this.warn(group, day, `Lịch nhắc sinh nhật #${task.id} bỏ qua: chưa đặt MEMBERS_SHEET trong .env.`);

    const record = this.sent.data[group]?.day === day ? this.sent.data[group]! : { day, kinds: [] };
    let messages: Awaited<ReturnType<MemberSheet["reminders"]>>;
    try {
      messages = await this.members.reminders(now, { skip: record.kinds });
    } catch (error) {
      return this.fail(task, group, day, hour, `không đọc được sheet: ${(error as Error).message}`);
    }
    for (const message of messages) {
      try {
        await this.say(task, message.text);
      } catch (error) {
        // A group the bot was removed from will never work: let the scheduler drop the task.
        if (UNREACHABLE_CHAT.test((error as Error).message)) throw error;
        return this.fail(task, group, day, hour, `gửi vào nhóm bị lỗi: ${(error as Error).message}`);
      }
      record.kinds.push(message.kind);
      this.sent.data[group] = record;
      await this.sent.save();
      console.log(`[birthdays] task #${task.id}: sent ${message.kind} to ${group}`);
    }
    if (this.warned.get(group) === day) {
      this.warned.delete(group);
      if (messages.length) this.notifyAdmins(`Nhắc sinh nhật #${task.id}: đã gửi lại thành công lúc ${hour}h.`);
    }
  }

  private fail(task: ScheduledTask, group: string, day: string, hour: number, reason: string): void {
    console.error(`[birthdays] task #${task.id} (${group}) at ${hour}h: ${reason}`);
    if (hour >= LAST_HOUR) {
      this.notifyAdmins(`Nhắc sinh nhật #${task.id} hôm nay KHÔNG gửi được (${reason}). Đã thử mỗi giờ đến ${LAST_HOUR}h; mai bot chạy lại bình thường.`);
      return;
    }
    this.warn(group, day, `Nhắc sinh nhật #${task.id} lúc ${hour}h chưa gửi được (${reason}). Bot sẽ tự thử lại mỗi giờ đến ${LAST_HOUR}h.`);
  }

  private warn(group: string, day: string, text: string): void {
    if (this.warned.get(group) === day) return;
    this.warned.set(group, day);
    this.notifyAdmins(text);
  }
}
