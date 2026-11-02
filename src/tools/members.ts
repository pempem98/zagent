import { readFile } from "node:fs/promises";
import type { Tool } from "../ai/tools.js";
import type { IncomingMessage } from "../channels/types.js";
import type { TokenSource } from "../google/auth.js";
import { parseCsv } from "./knowledge.js";

/** A birthday as written in the sheet; the year is often missing. */
export interface Birthday {
  day: number;
  month: number;
  year?: number;
}

export interface Member {
  name: string;
  birthday?: Birthday;
  /** False for people the sheet marks as gone (see MemberSheetOptions.activeFilter). */
  active: boolean;
  /** The columns the model may see, by header; empty cells left out. */
  fields: Record<string, string>;
}

interface LoadedSheet {
  /** Headers of the columns the model may see. */
  columns: string[];
  hidden: string[];
  nameColumn: string;
  /** Read in this order; the first cell that holds a date wins. */
  birthdayColumns: string[];
  members: Member[];
}

export interface MemberSheetOptions {
  /** A Google Sheets URL; its gid picks the tab. */
  url: string;
  /** Lets the bot read a sheet shared only with its Google identity. */
  auth?: TokenSource;
  /** What to tell the admin when the sheet cannot be read, e.g. the email to share it with. */
  accessHint?: string;
  /** Columns the model may see. Empty: every column except those that look private (PRIVATE_COLUMN). */
  columns: string[];
  /** Only rows holding this value in this column are current members; absent keeps every row. */
  activeFilter?: { column: string; value: string };
  /**
   * Columns the end-of-month message counts birthdays by, instead of naming everyone. Empty: the
   * message lists every name, day by day.
   */
  summaryBy: { label: string; column: string }[];
  /** Text file of sample wishes, one per line, `{ten}` standing for "anh Chiến"; DEFAULT_WISHES when missing. */
  wishesFile?: string;
  /** Shown under each name in the reminder, e.g. Chức vụ, Phòng, Vùng, Khối; empty cells are left out. */
  details: { label: string; column: string }[];
  /**
   * Asks a model to write the wishes; the samples then only set the tone. Without it, or when the
   * model fails, the samples are sent as they are.
   */
  generate?: (prompt: string) => Promise<string>;
}

/** Sample wishes sent under each name; `{ten}` becomes "anh Chiến", "chị Lư" or the bare name. */
export const DEFAULT_WISHES = [
  "🎂 Chúc mừng sinh nhật {ten}! Chúc {ten} tuổi mới thật nhiều sức khoẻ, niềm vui và thành công rực rỡ 🎉✨",
  "🎉 Happy birthday {ten}! Chúc {ten} tuổi mới chốt deal ầm ầm, tiền về đầy túi, luôn rạng rỡ như hôm nay 💰🥳",
  "🌸 Mừng sinh nhật {ten}! Chúc {ten} một năm mới an yên, hạnh phúc bên gia đình và gặt hái thật nhiều thành công 💐💖",
  "🥳 Sinh nhật vui vẻ {ten}! Chúc {ten} luôn tràn đầy năng lượng, công việc hanh thông, mọi điều như ý 🍀🎈",
  "🎈 Chúc mừng sinh nhật {ten}! Tuổi mới chúc {ten} vạn sự như ý, sức khoẻ dồi dào, sự nghiệp thăng hoa 🚀🌟",
  "💐 Chúc {ten} sinh nhật thật ý nghĩa! Mong {ten} luôn vui vẻ, trẻ trung và thành công hơn nữa trong năm mới 🎂🎊",
  "🎁 Happy birthday {ten}! Chúc {ten} tuổi mới nhiều may mắn, nhiều niềm vui và thật nhiều quà nhé 😍🎉",
  "🌟 Chúc mừng sinh nhật {ten}! Cảm ơn {ten} đã luôn đồng hành cùng cả nhà. Chúc {ten} tuổi mới bùng nổ thành công 💪🔥",
  "🍰 Sinh nhật vui vẻ nhé {ten}! Chúc {ten} luôn khoẻ mạnh, hạnh phúc, cười thật nhiều và đạt mọi mục tiêu đã đặt ra 🎯😄",
  "🎊 Chúc mừng sinh nhật {ten}! Chúc {ten} một tuổi mới rực rỡ, gia đình êm ấm, công việc thuận buồm xuôi gió ⛵💖",
];

/** Rows are fetched again after this long, so edits to the sheet show up without a reload. */
const CACHE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const VN_OFFSET_MS = 7 * 3_600_000;
const NAME_COLUMN = /^(họ\s*(và\s*)?tên|tên|name|full\s*name)$/i;
const BIRTHDAY_COLUMN = /ngày\s*sinh|sinh\s*nhật|birth|dob/i;
/** "NGÀY SINH THỰC" beats "NGÀY SINH (theo giấy tờ)": people celebrate the real one. */
const PREFERRED_BIRTHDAY = /thực|thuc|real|actual/i;
/** Day, month and year split into their own columns: replaced by the one "Sinh nhật" field. */
const BIRTH_PART = /^(ngày|tháng|năm)\s*sinh\b/i;
/** Never shown to the model unless named in MEMBERS_COLUMNS: identity papers, contacts, money. */
const PRIVATE_COLUMN =
  /sđt|\bsdt\b|điện\s*thoại|phone|e-?mail|cccd|cmnd|căn\s*cước|hộ\s*chiếu|passport|hộ\s*khẩu|địa\s*chỉ|address|ngày\s*cấp|nơi\s*cấp|tài\s*khoản|\bstk\b|ngân\s*hàng|lương|salary|thuế|bảo\s*hiểm/i;
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;
const WEEKDAYS = ["Chủ nhật", "Thứ Hai", "Thứ Ba", "Thứ Tư", "Thứ Năm", "Thứ Sáu", "Thứ Bảy"];
/** `group_by` value that counts birthdays per month instead of grouping by a column. */
const BY_BIRTH_MONTH = "tháng sinh";

/**
 * A member list kept in a Google Sheet: birthday reminders for a group, and a tool to answer
 * questions about the list. The sheet is read again when it is older than CACHE_MS, and always
 * before a reminder is sent.
 */
export class MemberSheet {
  private cache?: { at: number; sheet: LoadedSheet };
  private loading?: Promise<LoadedSheet>;

  constructor(
    private readonly options: MemberSheetOptions,
    /** Who may query the list: the list is not for every customer who talks to the bot. */
    private readonly canRead: (message: IncomingMessage, isAdmin: boolean) => boolean,
  ) {}

  load(fresh = false): Promise<LoadedSheet> {
    if (!fresh && this.cache && Date.now() - this.cache.at < CACHE_MS) return Promise.resolve(this.cache.sheet);
    this.loading ??= this.read()
      .then((sheet) => {
        this.cache = { at: Date.now(), sheet };
        return sheet;
      })
      .finally(() => {
        this.loading = undefined;
      });
    return this.loading;
  }

  /**
   * The messages to post today: tomorrow's birthdays, and on the last day of a month, next month's
   * overview. `preview` adds that overview on any day and says so when tomorrow has no birthday.
   */
  async reminders(now = Date.now(), { preview = false } = {}): Promise<string[]> {
    const sheet = await this.load(true);
    const members = sheet.members.filter((member) => member.active && member.birthday);
    const tomorrow = addDays(vnDay(now), 1);
    const messages: string[] = [];
    const due = members.filter((member) => sameDay(celebration(member.birthday!, tomorrow.year), tomorrow));
    if (due.length) {
      const details = this.options.details.map(({ label, column }) => ({ label, header: findColumn(sheet.columns, column) }));
      const describe = (member: Member) =>
        details
          .map(({ label, header }) => (member.fields[header] ? `${label}: ${member.fields[header]}` : ""))
          .filter(Boolean)
          .join(" | ");
      const wishes = await this.writeWishes(due, tomorrow, describe);
      messages.push(
        [
          `🎂🎉 Ngày mai, ${WEEKDAYS[weekday(tomorrow)]} ${formatDay(tomorrow)}, là sinh nhật của:`,
          ...due.flatMap((member) => {
            const about = describe(member);
            return [`🎈 ${member.name}${member.birthday!.year ? ` (${member.birthday!.year})` : ""}`, ...(about ? [`     ${about}`] : [])];
          }),
          "",
          "💌 Lời chúc mẫu, cả nhà copy gửi luôn nhé:",
          ...wishes.map((wish) => `• ${wish}`),
        ].join("\n"),
      );
    }
    else if (preview) messages.push(`(Ngày mai ${formatDay(tomorrow)} không có ai sinh nhật nên 9h sẽ không gửi tin nhắc.)`);
    if (tomorrow.day === 1 || preview) {
      const month = tomorrow.day === 1 ? tomorrow : addDays({ ...tomorrow, day: 1 }, daysInMonth(tomorrow.year, tomorrow.month));
      messages.push(
        this.options.summaryBy.length ? monthSummary(members, month.year, month.month, sheet.columns, this.options.summaryBy) : monthList(members, month.year, month.month),
      );
    }
    return messages;
  }

  /** For the admin: how the sheet was understood and what the next reminders will say. */
  async check(now = Date.now()): Promise<string> {
    const sheet = await this.load(true);
    const active = sheet.members.filter((member) => member.active);
    const dated = active.filter((member) => member.birthday);
    const today = vnDay(now);
    const next = addDays(today, 1);
    const following = today.month === 12 ? { year: today.year + 1, month: 1 } : { year: today.year, month: today.month + 1 };
    const count = (year: number, month: number) => dated.filter((member) => member.birthday!.month === month).length;
    const tomorrow = dated.filter((member) => sameDay(celebration(member.birthday!, next.year), next));
    const filter = this.options.activeFilter;
    return [
      `Sheet: ${sheet.members.length} dòng có tên; ${filter ? `${active.length} người "${filter.value}" (cột ${filter.column})` : "tính tất cả"}; ${dated.length} người có ngày sinh đọc được.`,
      `Cột họ tên: ${sheet.nameColumn}. Cột ngày sinh (theo thứ tự ưu tiên): ${sheet.birthdayColumns.join(", ") || "KHÔNG CÓ"}.`,
      `AI được xem: ${sheet.columns.join(", ")}.`,
      `Luôn ẩn: ${sheet.hidden.join(", ") || "(không có)"}.`,
      `Ngày mai (${formatDay(next)}): ${tomorrow.length ? tomorrow.map((member) => member.name).join(", ") : "không ai"}.`,
      `Tháng ${today.month}: ${count(today.year, today.month)} sinh nhật; tháng ${following.month}: ${count(following.year, following.month)}.`,
      active.length - dated.length ? `${active.length - dated.length} người không có ngày sinh hợp lệ nên sẽ không được nhắc.` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  tools(): Tool[] {
    const columns = this.cache?.sheet.columns;
    return [
      {
        name: "members_query",
        description:
          "Tra danh sách thành viên/nhân sự trong Google Sheet: sinh nhật (hôm nay, tuần này, tháng này, của một người), đếm số người, lọc hoặc thống kê theo cột (chức vụ, khối, văn phòng...). Mặc định chỉ tính người đang làm. 'total' là tổng số người khớp; 'rows' chỉ gồm tối đa 'limit' người đầu tiên, nên khi hỏi 'bao nhiêu' hãy trả lời theo 'total'." +
          (columns ? ` Các cột: ${columns.join(", ")}.` : ""),
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Một phần họ tên cần tìm, có dấu hay không dấu đều được." },
            filters: {
              type: "object",
              description: 'Lọc theo cột: {"tên cột": "giá trị cần chứa"}, ví dụ {"KHỐI": "BO", "VP LÀM VIỆC": "Gemek"}.',
              additionalProperties: { type: "string" },
            },
            birthday_month: { type: "integer", description: "Chỉ lấy người sinh trong tháng này (1-12)." },
            birthday_day: { type: "integer", description: "Chỉ lấy người sinh vào ngày này của tháng (1-31); thường đi kèm birthday_month." },
            within_days: {
              type: "integer",
              description: "Chỉ lấy người có sinh nhật trong N ngày tới, tính từ hôm nay: 0 = hôm nay, 1 = hôm nay và ngày mai, 6 = 7 ngày tới.",
            },
            group_by: { type: "string", description: `Đếm số người theo từng giá trị của một cột, hoặc "${BY_BIRTH_MONTH}" để đếm sinh nhật theo tháng.` },
            include_inactive: { type: "boolean", description: "Tính cả người đã nghỉ. Mặc định false." },
            limit: { type: "integer", description: `Số người tối đa trả về trong 'rows' (mặc định ${DEFAULT_LIMIT}, tối đa ${MAX_LIMIT}).` },
          },
        },
        audience: "all",
        run: async (args, { message, isAdmin }) => {
          if (!this.canRead(message, isAdmin)) throw new Error("Danh sách thành viên chỉ tra được trong nhóm đã bật nhắc sinh nhật, hoặc bởi quản trị viên");
          return this.query(args);
        },
      },
    ];
  }

  async query(args: Record<string, unknown>): Promise<unknown> {
    const sheet = await this.load();
    const today = vnDay(Date.now());
    let members = sheet.members.filter((member) => args.include_inactive === true || member.active);

    const name = fold(String(args.name ?? ""));
    if (name) members = members.filter((member) => fold(member.name).includes(name));
    const filters = args.filters && typeof args.filters === "object" ? Object.entries(args.filters as Record<string, unknown>) : [];
    for (const [column, value] of filters) {
      const header = findColumn(sheet.columns, column);
      const wanted = fold(String(value ?? ""));
      members = members.filter((member) => fold(member.fields[header] ?? "").includes(wanted));
    }

    const month = integer(args.birthday_month, 1, 12);
    const day = integer(args.birthday_day, 1, 31);
    const within = integer(args.within_days, 0, 366);
    const byBirthday = month !== undefined || day !== undefined || within !== undefined;
    if (byBirthday) members = members.filter((member) => member.birthday);
    if (month !== undefined) members = members.filter((member) => member.birthday!.month === month);
    if (day !== undefined) members = members.filter((member) => celebration(member.birthday!, today.year).day === day);
    const daysUntil = (member: Member) => daysBetween(today, nextCelebration(member.birthday!, today));
    if (within !== undefined) members = members.filter((member) => daysUntil(member) <= within);
    if (byBirthday) members.sort((a, b) => daysUntil(a) - daysUntil(b) || a.name.localeCompare(b.name, "vi"));

    const groupBy = String(args.group_by ?? "").trim();
    let groups: Record<string, number> | undefined;
    if (groupBy) {
      const key =
        fold(groupBy) === fold(BY_BIRTH_MONTH)
          ? (member: Member) => (member.birthday ? `Tháng ${member.birthday.month}` : "(không rõ)")
          : ((header) => (member: Member) => member.fields[header] || "(trống)")(findColumn(sheet.columns, groupBy));
      const counts = new Map<string, number>();
      for (const member of members) counts.set(key(member), (counts.get(key(member)) ?? 0) + 1);
      groups = Object.fromEntries([...counts].sort((a, b) => b[1] - a[1]).slice(0, 60));
    }

    const limit = integer(args.limit, 1, MAX_LIMIT) ?? DEFAULT_LIMIT;
    return {
      today: `${WEEKDAYS[weekday(today)]} ${formatDay(today)}/${today.year}`,
      total: members.length,
      ...(groups ? { groups } : {}),
      rows: members.slice(0, limit).map((member) => ({
        ...member.fields,
        ...(member.birthday ? { "Sinh nhật": formatBirthday(member.birthday) } : {}),
        ...(byBirthday ? { "Còn mấy ngày": daysUntil(member) } : {}),
      })),
      ...(members.length > limit ? { note: `Chỉ hiện ${limit}/${members.length} người.` } : {}),
    };
  }

  /** One wish per person, in order: written by the model when there is one, else picked from the samples. */
  private async writeWishes(people: Member[], day: Day, describe: (member: Member) => string): Promise<string[]> {
    const samples = await this.wishes();
    // A different sample for each person, and a different starting point each day.
    const start = Math.round(toUtc(day) / DAY_MS);
    const fallback = people.map((member, index) => samples[(start + index) % samples.length]!.replaceAll("{ten}", callName(member)));
    if (!this.options.generate) return fallback;
    const prompt = [
      `Viết lời chúc mừng sinh nhật cho ${people.length} đồng nghiệp trong công ty, để cả nhóm Zalo copy gửi.`,
      "Yêu cầu: tiếng Việt, ấm áp, vui, hợp môi trường công sở; 1-2 câu, dưới 40 từ; có 2-4 emoji; gọi đúng cách gọi được cho;",
      "mỗi người một lời chúc khác nhau, có thể nhắc nhẹ đến công việc của họ nhưng không nhắc đến tuổi.",
      "Phong cách tham khảo:",
      ...samples.slice(0, 5).map((sample) => `- ${sample.replaceAll("{ten}", "anh Nam")}`),
      "Người nhận:",
      ...people.map((member, index) => `${index + 1}. Cách gọi: "${callName(member)}"${describe(member) ? `; ${describe(member)}` : ""}`),
      `Chỉ trả về một mảng JSON gồm đúng ${people.length} chuỗi, theo đúng thứ tự trên, không giải thích gì thêm.`,
    ].join("\n");
    try {
      const text = await this.options.generate(prompt);
      const parsed: unknown = JSON.parse(/\[[\s\S]*\]/.exec(text)?.[0] ?? "null");
      if (Array.isArray(parsed) && parsed.length === people.length && parsed.every((wish) => typeof wish === "string" && wish.trim())) {
        return parsed.map((wish: string) => wish.trim());
      }
      throw new Error(`unexpected answer: ${text.slice(0, 200)}`);
    } catch (error) {
      console.warn(`[members] model could not write the wishes, using the samples: ${(error as Error).message}`);
      return fallback;
    }
  }

  /** Read on every reminder, so edits to the file apply the next morning without a restart. */
  private async wishes(): Promise<string[]> {
    if (!this.options.wishesFile) return DEFAULT_WISHES;
    const text = await readFile(this.options.wishesFile, "utf8").catch(() => "");
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    return lines.length ? lines : DEFAULT_WISHES;
  }

  private async read(): Promise<LoadedSheet> {
    const rows = parseCsv(await this.download());
    const header = (rows[0] ?? []).map((cell) => cell.replace(/\s+/g, " ").trim());
    const nameIndex = header.findIndex((cell) => NAME_COLUMN.test(cell));
    if (nameIndex < 0) throw new Error(`Không thấy cột họ tên trong sheet (cần cột "Họ tên"). Các cột: ${header.join(", ")}`);
    const birthdayIndexes = header
      .map((cell, index) => ({ cell, index }))
      .filter(({ cell }) => BIRTHDAY_COLUMN.test(cell))
      .sort((a, b) => Number(PREFERRED_BIRTHDAY.test(b.cell)) - Number(PREFERRED_BIRTHDAY.test(a.cell)));

    const allowed = new Set(this.options.columns.map(fold));
    const isBirthColumn = (cell: string) => BIRTHDAY_COLUMN.test(cell) || BIRTH_PART.test(cell);
    const visible: { cell: string; index: number }[] = [];
    const hidden: string[] = [];
    header.forEach((cell, index) => {
      if (!cell || isBirthColumn(cell)) return;
      if (allowed.size ? allowed.has(fold(cell)) || index === nameIndex : !PRIVATE_COLUMN.test(cell)) visible.push({ cell, index });
      else hidden.push(cell);
    });

    const filter = this.options.activeFilter;
    const activeIndex = filter ? header.findIndex((cell) => fold(cell) === fold(filter.column)) : -1;
    if (filter && activeIndex < 0) throw new Error(`Không thấy cột "${filter.column}" (MEMBERS_ACTIVE) trong sheet`);

    const members = rows.slice(1).flatMap((row): Member[] => {
      const name = (row[nameIndex] ?? "").trim();
      if (!name) return [];
      const birthday = birthdayIndexes.map(({ index }) => parseBirthday(row[index] ?? "")).find((value) => value !== undefined);
      const fields = Object.fromEntries(visible.map(({ cell, index }) => [cell, (row[index] ?? "").trim()]).filter(([, value]) => value));
      return [{ name, birthday, active: !filter || fold(row[activeIndex] ?? "") === fold(filter.value), fields }];
    });
    return {
      columns: visible.map(({ cell }) => cell),
      hidden,
      nameColumn: header[nameIndex]!,
      birthdayColumns: birthdayIndexes.map(({ cell }) => cell),
      members,
    };
  }

  /** CSV of the sheet's tab: as the bot's Google identity when there is one, else as anyone with the link. */
  private async download(): Promise<string> {
    const id = /\/spreadsheets\/d\/([\w-]+)/.exec(this.options.url)?.[1];
    if (!id) throw new Error(`MEMBERS_SHEET không phải link Google Sheets: ${this.options.url}`);
    const gid = /[?&#]gid=(\d+)/.exec(this.options.url)?.[1] ?? "0";
    const url = `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
    const attempt = async (headers: Record<string, string>) => {
      // The export redirects to googleusercontent.com, and fetch drops the Authorization header on
      // a redirect to another host; follow it by hand so a sheet shared only with the bot works.
      let response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      for (let hops = 0; hops < 5 && response.status >= 300 && response.status < 400 && response.headers.get("location"); hops++) {
        response = await fetch(new URL(response.headers.get("location")!, url), { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      }
      const type = response.headers.get("content-type") ?? "";
      // A sheet we may not read redirects to an HTML sign-in page instead of failing.
      if (response.ok && type.includes("csv")) return response.text();
      throw new Error(`HTTP ${response.status} (${type})`);
    };
    let signedIn: Error | undefined;
    if (this.options.auth) {
      try {
        return await attempt({ Authorization: `Bearer ${await this.options.auth.accessToken()}` });
      } catch (error) {
        signedIn = error as Error;
      }
    }
    try {
      return await attempt({});
    } catch (error) {
      const detail = signedIn ? `bằng tài khoản Google của bot: ${signedIn.message}; bằng link công khai: ${(error as Error).message}` : (error as Error).message;
      throw new Error(`Không đọc được sheet thành viên (${detail}). ${this.options.accessHint ?? 'Hãy chia sẻ sheet "Bất kỳ ai có đường liên kết đều xem được".'}`);
    }
  }
}

/** "20/11/1990", "20-11", "1990-11-20", "20 tháng 11 năm 1990"; a leading ' (Sheets' text marker) is ignored. */
export function parseBirthday(raw: string): Birthday | undefined {
  const text = raw.trim().replace(/^'/, "").trim();
  let day: number, month: number, year: number | undefined;
  let match: RegExpExecArray | null;
  if ((match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text))) [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  else if ((match = /^(\d{1,2})\s*[-/.]\s*(\d{1,2})(?:\s*[-/.]\s*(\d{4}|\d{2}))?$/.exec(text)))
    [day, month, year] = [Number(match[1]), Number(match[2]), match[3] ? Number(match[3]) : undefined];
  else if ((match = /^(?:ngày\s*)?(\d{1,2})\s*tháng\s*(\d{1,2})(?:\s*(?:năm|,)?\s*(\d{4}))?$/i.exec(text)))
    [day, month, year] = [Number(match[1]), Number(match[2]), match[3] ? Number(match[3]) : undefined];
  else return undefined;
  if (year !== undefined && year < 100) year += year > new Date().getUTCFullYear() % 100 ? 1900 : 2000;
  // A sheet formatted month-first; only fixable when the month cannot be a month.
  if (month > 12 && day <= 12) [day, month] = [month, day];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year ?? 2000, month)) return undefined;
  if (year !== undefined && (year < 1900 || year > 2100)) return undefined;
  return year === undefined ? { day, month } : { day, month, year };
}

// --- Calendar days in Vietnam time --------------------------------------------------------------

interface Day {
  year: number;
  month: number;
  day: number;
}

const toUtc = (day: Day) => Date.UTC(day.year, day.month - 1, day.day);
function fromUtc(ms: number): Day {
  const date = new Date(ms);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}
const vnDay = (at: number) => fromUtc(at + VN_OFFSET_MS);
const addDays = (day: Day, count: number) => fromUtc(toUtc(day) + count * DAY_MS);
const daysBetween = (from: Day, to: Day) => Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
const sameDay = (a: Day, b: Day) => a.year === b.year && a.month === b.month && a.day === b.day;
const weekday = (day: Day) => new Date(toUtc(day)).getUTCDay();
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (value: number) => String(value).padStart(2, "0");
const formatDay = (day: Day) => `${pad(day.day)}/${pad(day.month)}`;
const formatBirthday = (birthday: Birthday) => `${pad(birthday.day)}/${pad(birthday.month)}${birthday.year ? `/${birthday.year}` : ""}`;

/** The day a birthday is celebrated in a given year: 29/2 falls on 28/2 outside leap years. */
function celebration(birthday: Birthday, year: number): Day {
  return { year, month: birthday.month, day: Math.min(birthday.day, daysInMonth(year, birthday.month)) };
}

function nextCelebration(birthday: Birthday, from: Day): Day {
  const thisYear = celebration(birthday, from.year);
  return toUtc(thisYear) >= toUtc(from) ? thisYear : celebration(birthday, from.year + 1);
}

/** "📅 Tháng 12/2026 có 124 sinh nhật", then how many in each value of each summary column. */
function monthSummary(members: Member[], year: number, month: number, columns: string[], summaryBy: MemberSheetOptions["summaryBy"]): string {
  const inMonth = members.filter((member) => member.birthday!.month === month);
  if (inMonth.length === 0) return `📅 Tháng ${month}/${year} không có ai sinh nhật.`;
  const sections = summaryBy.map(({ label, column }) => {
    const header = findColumn(columns, column);
    const counts = new Map<string, number>();
    for (const member of inMonth) {
      const value = member.fields[header] || "";
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    // Largest first; people with the cell empty come last.
    const lines = [...counts]
      .sort((a, b) => Number(!a[0]) - Number(!b[0]) || b[1] - a[1] || a[0].localeCompare(b[0], "vi"))
      .map(([value, count]) => `- ${value || `Không có ${label.toLocaleLowerCase("vi")}`}: ${count}`);
    return [`Theo ${label.toLocaleLowerCase("vi")}:`, ...lines].join("\n");
  });
  return [
    `📅 Tháng ${month}/${year} có ${inMonth.length} sinh nhật.`,
    ...sections,
    `Muốn xem tên, tag bot và hỏi, ví dụ: "sinh nhật tháng ${month} khối BO".`,
  ].join("\n\n");
}

/** "📅 Sinh nhật tháng 12/2026 (3 người):" then one line per day. */
function monthList(members: Member[], year: number, month: number): string {
  const byDay = new Map<number, string[]>();
  for (const member of members) {
    if (member.birthday!.month !== month) continue;
    const day = celebration(member.birthday!, year).day;
    byDay.set(day, [...(byDay.get(day) ?? []), member.name]);
  }
  if (byDay.size === 0) return `📅 Tháng ${month}/${year} không có ai sinh nhật.`;
  const total = [...byDay.values()].reduce((sum, names) => sum + names.length, 0);
  const lines = [...byDay]
    .sort((a, b) => a[0] - b[0])
    .map(([day, names]) => `${pad(day)}/${pad(month)}: ${names.sort((a, b) => a.localeCompare(b, "vi")).join(", ")}`);
  return [`📅 Sinh nhật tháng ${month}/${year} (${total} người):`, ...lines].join("\n");
}

/** "anh Chiến", "chị Lư": the given name (last word) with a title from a gender column; the full name when there is none. */
function callName(member: Member): string {
  const gender = fold(Object.entries(member.fields).find(([column]) => /giới\s*tính|gender/i.test(column))?.[1] ?? "");
  const given = member.name.trim().split(/\s+/).at(-1) ?? member.name;
  if (/^(nam|male|m)$/.test(gender)) return `anh ${given}`;
  if (/^(nu|female|f)$/.test(gender)) return `chị ${given}`;
  return member.name;
}

/** Lower case, no accents, single spaces: "Đặng  Thị" and "dang thi" compare equal. */
function fold(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function findColumn(columns: string[], wanted: string): string {
  const exact = columns.find((column) => fold(column) === fold(wanted));
  const partial = exact ?? columns.filter((column) => fold(column).includes(fold(wanted)));
  if (typeof partial === "string") return partial;
  if (partial.length === 1) return partial[0]!;
  throw new Error(`Không có cột "${wanted}"${partial.length > 1 ? ` (trùng nhiều cột: ${partial.join(", ")})` : ""}. Các cột: ${columns.join(", ")}`);
}

function integer(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`Giá trị ${String(value)} phải từ ${min} đến ${max}`);
  return number;
}
