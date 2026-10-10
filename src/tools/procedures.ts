import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "../ai/tools.js";
import { tokenize } from "./knowledge.js";

interface Procedure {
  /** File name without extension. */
  slug: string;
  title: string;
  /** The situation that triggers it, in the author's words. */
  when: string;
  steps: string;
  /** True when it comes from a shared, read-only folder and cannot be changed from chat. */
  shared: boolean;
}

/** Above this total size, only titles go in the prompt and the model reads steps on demand. */
const INLINE_BUDGET_CHARS = 8000;
const WHEN_PREFIX = /^khi nào dùng\s*:\s*/i;

/**
 * Playbooks the bot must follow for recurring situations ("when a customer asks for a quote,
 * do 1, 2, 3"). Unlike knowledge documents, which are found by search, procedures are put in
 * front of the model on every message, so it cannot miss them.
 *
 * Each procedure is a Markdown file the admin can also edit by hand:
 *
 *     # Title
 *     Khi nào dùng: the situation
 *
 *     1. first step...
 */
export class Procedures {
  private procedures: Procedure[] = [];

  constructor(
    /** Where procedures taught in chat are written. */
    private readonly dir: string,
    /** Extra read-only folders (e.g. synced from Google Drive). They win over `dir` on a name clash. */
    private readonly sharedDirs: string[] = [],
  ) {}

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const bySlug = new Map<string, Procedure>();
    for (const dir of [this.dir, ...this.sharedDirs]) {
      const names = (await readdir(dir).catch(() => [])).filter((name) => /\.(md|txt)$/i.test(name)).sort();
      for (const name of names) {
        const procedure = parse(name.replace(/\.(md|txt)$/i, ""), await readFile(join(dir, name), "utf8"), dir !== this.dir);
        // A shared copy replaces a local one of the same name: the shared folder is the team's source.
        if (procedure.steps) bySlug.set(slugify(procedure.title), procedure);
      }
    }
    this.procedures = [...bySlug.values()];
  }

  get count(): number {
    return this.procedures.length;
  }

  /** Text for `/procedures`. */
  list(): string {
    if (this.procedures.length === 0) return "Chưa có quy trình nào. Nhắn cho bot kiểu: \"Dạy quy trình: khi khách ... thì làm 1..., 2..., 3...\"";
    return this.procedures
      .map((procedure, index) => `${index + 1}. ${procedure.title}${procedure.shared ? " (từ Drive)" : ""}\n   Khi nào dùng: ${procedure.when || "(chưa ghi)"}`)
      .join("\n");
  }

  /** Section for the system prompt; empty when nothing has been taught. */
  describe(): string {
    if (this.procedures.length === 0) return "";
    const full = this.procedures.map((procedure) => `### ${procedure.title}\nKhi nào dùng: ${procedure.when || "(xem tiêu đề)"}\n${procedure.steps}`).join("\n\n");
    if (full.length <= INLINE_BUDGET_CHARS) return full;
    const index = this.procedures.map((procedure) => `- ${procedure.title}: ${procedure.when || "(xem tiêu đề)"}`).join("\n");
    return `${index}\n(Đọc đầy đủ các bước bằng read_procedure trước khi làm.)`;
  }

  tools(): Tool[] {
    const tools: Tool[] = [
      {
        name: "save_procedure",
        description:
          "Lưu (hoặc ghi đè) một quy trình xử lý cho một loại tình huống, để từ nay bot luôn làm theo. Chỉ dùng khi quản trị viên dạy cách xử lý: 'khi gặp X thì làm các bước...'. Nếu trùng tiêu đề với quy trình đã có thì thay thế nó. Thông tin, số liệu đơn lẻ không phải quy trình: dùng add_knowledge_note.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Tên ngắn của quy trình, ví dụ 'Báo giá phần mềm'." },
            when: { type: "string", description: "Tình huống áp dụng, ví dụ 'Khách hỏi giá hoặc xin báo giá làm phần mềm'." },
            steps: {
              type: "string",
              description:
                "Các bước, đánh số, mỗi bước một dòng, giữ đủ ý quản trị viên đã nói: cần hỏi gì, tra gì, trả lời thế nào, khi nào chuyển cho người thật. Không tự thêm bước, điều kiện hay con số mà quản trị viên không nói.",
            },
          },
          required: ["title", "when", "steps"],
        },
        audience: "admin",
        run: async (args) => {
          const title = clean(args.title);
          const when = clean(args.when);
          const steps = String(args.steps ?? "").trim();
          if (!title || !when || !steps) throw new Error("Cần đủ tiêu đề, tình huống áp dụng và các bước");
          const slug = slugify(title);
          const existing = this.find(title);
          if (existing?.shared) throw new Error(`Quy trình "${existing.title}" được quản lý trong thư mục dùng chung (Google Drive); hãy sửa file ở đó`);
          const replaced = Boolean(existing);
          await mkdir(this.dir, { recursive: true });
          await writeFile(join(this.dir, `${slug}.md`), `# ${title}\nKhi nào dùng: ${when}\n\n${steps}\n`);
          await this.load();
          return `Đã ${replaced ? "cập nhật" : "lưu"} quy trình "${title}". Từ giờ bot sẽ làm theo khi gặp tình huống này.`;
        },
      },
      {
        name: "delete_procedure",
        description: "Xoá một quy trình đã dạy, theo tiêu đề. Chỉ dùng khi quản trị viên yêu cầu bỏ quy trình đó.",
        parameters: {
          type: "object",
          properties: { title: { type: "string", description: "Tiêu đề quy trình cần xoá." } },
          required: ["title"],
        },
        audience: "admin",
        run: async (args) => {
          const procedure = this.find(String(args.title ?? ""));
          if (!procedure) throw new Error(`Không có quy trình "${args.title}". Hiện có: ${this.procedures.map((p) => p.title).join(", ") || "(không có)"}`);
          if (procedure.shared) throw new Error(`Quy trình "${procedure.title}" được quản lý trong thư mục dùng chung (Google Drive); hãy xoá file ở đó`);
          await rm(join(this.dir, `${procedure.slug}.md`), { force: true });
          await this.load();
          return `Đã xoá quy trình "${procedure.title}".`;
        },
      },
    ];
    // Only needed when the procedures no longer fit in the prompt.
    if (this.describe().includes("read_procedure")) {
      tools.push({
        name: "read_procedure",
        description: "Đọc đầy đủ các bước của một quy trình theo tiêu đề. Bắt buộc gọi trước khi xử lý tình huống khớp với quy trình đó.",
        parameters: {
          type: "object",
          properties: { title: { type: "string", description: "Tiêu đề quy trình, như trong danh sách." } },
          required: ["title"],
        },
        audience: "all",
        run: async (args) => {
          const procedure = this.find(String(args.title ?? ""));
          if (!procedure) throw new Error(`Không có quy trình "${args.title}"`);
          return `${procedure.title}\nKhi nào dùng: ${procedure.when}\n${procedure.steps}`;
        },
      });
    }
    return tools;
  }

  private find(title: string): Procedure | undefined {
    const slug = slugify(title);
    return this.procedures.find((procedure) => procedure.slug === slug || slugify(procedure.title) === slug);
  }
}

function parse(slug: string, text: string, shared: boolean): Procedure {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const titleIndex = lines.findIndex((line) => line.startsWith("#"));
  const whenIndex = lines.findIndex((line) => WHEN_PREFIX.test(line.trim()));
  const steps = lines.filter((_, index) => index !== titleIndex && index !== whenIndex).join("\n").trim();
  return {
    slug,
    // A Google Doc exported as text has no "#" heading; its file name is the title.
    title: titleIndex >= 0 ? lines[titleIndex]!.replace(/^#+\s*/, "").trim() : slug,
    when: whenIndex >= 0 ? lines[whenIndex]!.trim().replace(WHEN_PREFIX, "") : "",
    steps,
    shared,
  };
}

const clean = (value: unknown) => String(value ?? "").replace(/\s+/g, " ").trim();

/** "Báo giá phần mềm" -> "bao-gia-phan-mem": a stable, Windows-safe file name. */
function slugify(title: string): string {
  return tokenize(title).filter((token) => !token.includes("_")).join("-").slice(0, 80) || "quy-trinh";
}
