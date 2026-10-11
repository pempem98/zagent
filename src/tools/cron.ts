/** Schedules are written and read in Vietnam time, which has no daylight saving. */
const OFFSET_MS = 7 * 3_600_000;
/** How far ahead to look for the next run; covers "29 2" (leap day) expressions. */
const SEARCH_MS = 5 * 366 * 86_400_000;

const FIELDS = [
  { name: "phút", min: 0, max: 59 },
  { name: "giờ", min: 0, max: 23 },
  { name: "ngày", min: 1, max: 31 },
  { name: "tháng", min: 1, max: 12 },
  { name: "thứ", min: 0, max: 7 },
];

export interface Cron {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  /** 0 is Sunday. */
  weekdays: Set<number>;
  /** False when the day-of-month or weekday field is "*": then only the other one decides the day. */
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

/**
 * Parses a standard five-field cron expression (minute hour day month weekday). Each field takes
 * numbers, lists, ranges and steps: "0 8-20 * * *", "*\/15 9-17 * * 1-5", "30 7 1,15 * *".
 * Month and weekday names are not accepted.
 */
export function parseCron(expression: string): Cron {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('Biểu thức cron phải có đúng 5 trường "phút giờ ngày tháng thứ", ví dụ "0 8-20 * * *"');
  const [minutes, hours, days, months, weekdays] = parts.map((part, index) => parseField(part, FIELDS[index]!)) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  // Both 0 and 7 mean Sunday.
  if (weekdays.delete(7)) weekdays.add(0);
  return { minutes, hours, days, months, weekdays, dayRestricted: !parts[2]!.startsWith("*"), weekdayRestricted: !parts[4]!.startsWith("*") };
}

function parseField(text: string, field: { name: string; min: number; max: number }): Set<number> {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
    const invalid = new Error(`Trường "${field.name}" của cron không hợp lệ: "${text}" (cho phép ${field.min}-${field.max}, dùng số, dấu phẩy, a-b, */n)`);
    if (!match) throw invalid;
    const step = match[2] ? Number(match[2]) : 1;
    const [from = field.min, end] = match[1] === "*" ? [field.min, field.max] : match[1]!.split("-").map(Number);
    // "5/15" runs from 5 to the end of the field.
    const to = end ?? (match[2] ? field.max : from);
    if (step < 1 || from < field.min || to > field.max || from > to) throw invalid;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/** The first matching minute strictly after `after` (epoch ms), or undefined when there is none in sight. */
export function nextCron(cron: Cron, after: number): number | undefined {
  // Shifted so that the UTC getters read Vietnam wall-clock time.
  const date = new Date(Math.floor(after / 60_000) * 60_000 + 60_000 + OFFSET_MS);
  const limit = date.getTime() + SEARCH_MS;
  while (date.getTime() <= limit) {
    if (!cron.months.has(date.getUTCMonth() + 1) || !dayMatches(cron, date)) {
      date.setUTCDate(date.getUTCDate() + 1);
      date.setUTCHours(0, 0, 0, 0);
    } else if (!cron.hours.has(date.getUTCHours())) {
      date.setUTCHours(date.getUTCHours() + 1, 0, 0, 0);
    } else if (!cron.minutes.has(date.getUTCMinutes())) {
      date.setUTCMinutes(date.getUTCMinutes() + 1);
    } else {
      return date.getTime() - OFFSET_MS;
    }
  }
  return undefined;
}

/** As in cron itself: when both day fields are restricted, a day matching either one counts. */
function dayMatches(cron: Cron, date: Date): boolean {
  const day = cron.days.has(date.getUTCDate());
  const weekday = cron.weekdays.has(date.getUTCDay());
  if (cron.dayRestricted && cron.weekdayRestricted) return day || weekday;
  return cron.dayRestricted ? day : cron.weekdayRestricted ? weekday : true;
}
