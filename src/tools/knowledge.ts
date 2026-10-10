import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, relative } from "node:path";
import mammoth from "mammoth";
import readXlsxFile from "read-excel-file/node";
import { extractText } from "unpdf";
import { similarity, type Embedder } from "../ai/embeddings.js";
import type { Tool } from "../ai/tools.js";
import type { UrlSource } from "../config.js";
import { fetchPublic, htmlToText } from "./web.js";

interface Chunk {
  /** Document name plus location, e.g. `bang-gia.xlsx › Sheet1 (dòng 2-21)`. */
  source: string;
  text: string;
  tokens: string[];
  /** Null until embedded (or when embedding is unavailable): the chunk is then found by keyword only. */
  vector: Float32Array | null;
}

interface Document {
  name: string;
  chunks: Chunk[];
}

type Cell = string | number | boolean | Date | null | undefined;

const CHUNK_CHARS = 1200;
const SEARCH_RESULTS = 6;
/** How many candidates each ranking contributes before they are fused. */
const CANDIDATES = 20;
const NOTES_FILE = "ghi-chu-admin.md";

/**
 * Local knowledge base: files in a folder (txt, md, csv, pdf, docx, xlsx) plus public web
 * addresses (pages, linked files, link-shared Google Sheets and Docs) and an optional mirrored
 * remote folder. The original files stay the source of truth; search runs
 * over an index derived from them: BM25 on accent-folded Vietnamese tokens (exact names, codes,
 * prices) fused with embedding similarity (meaning, and questions in another language).
 */
export class KnowledgeBase {
  private documents: Document[] = [];
  private readonly fileCache = new Map<string, { stamp: string; document: Document }>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly dir: string,
    private readonly urls: UrlSource[],
    /** Omit to search by keyword only. */
    private readonly embedder?: Embedder,
    /** A remote source mirrored into a local folder, refreshed before each reload. */
    private readonly mirror?: {
      dir: string;
      label: string;
      /** Top-level names in the mirror (extension ignored) that are not knowledge. */
      exclude?: string[];
      sync(): Promise<unknown>;
    },
  ) {}

  /** Load everything now, then refresh on an interval (picks up edited files and sheets). */
  async start(refreshMinutes: number): Promise<void> {
    await this.reload();
    this.timer = setInterval(() => void this.reload().catch((e) => console.error("[knowledge] reload failed:", e)), refreshMinutes * 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  async reload(): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    const documents: Document[] = [];

    const folders: { dir: string; prefix: string; exclude?: string[] }[] = [{ dir: this.dir, prefix: "" }];
    if (this.mirror) {
      // If the remote cannot be reached, keep answering from the last mirrored copy.
      await this.mirror.sync().catch((error) => console.error(`[knowledge] ${this.mirror!.label} sync failed, using the last copy:`, error instanceof Error ? error.message : error));
      await mkdir(this.mirror.dir, { recursive: true });
      folders.push({ dir: this.mirror.dir, prefix: `${this.mirror.label}/`, exclude: this.mirror.exclude });
    }
    const files = (
      await Promise.all(
        folders.map(async ({ dir, prefix, exclude }) =>
          (await listFiles(dir, exclude)).map((path) => ({ path, name: prefix + relative(dir, path).replaceAll("\\", "/") })),
        ),
      )
    ).flat();

    for (const { path, name } of files) {
      try {
        const info = await stat(path);
        const stamp = `${info.mtimeMs}:${info.size}`;
        let cached = this.fileCache.get(path);
        if (cached?.stamp !== stamp) {
          const sections = await readFileSections(path);
          if (!sections) continue;
          cached = { stamp, document: buildDocument(name, sections) };
          this.fileCache.set(path, cached);
        }
        documents.push(cached.document);
      } catch (error) {
        console.error(`[knowledge] cannot read ${name}:`, error);
      }
    }

    for (const source of this.urls) {
      try {
        documents.push(buildDocument(source.name, await readUrlSections(source.url)));
      } catch (error) {
        console.error(`[knowledge] cannot load "${source.name}" (${source.url}):`, error instanceof Error ? error.message : error);
        // Keep serving the last good copy rather than dropping the source.
        const previous = this.documents.find((document) => document.name === source.name);
        if (previous) documents.push(previous);
      }
    }

    const chunks = documents.flatMap((document) => document.chunks);
    if (this.embedder) {
      const vectors = await this.embedder.embedDocuments(chunks.map((chunk) => `${chunk.source}\n${chunk.text}`));
      chunks.forEach((chunk, index) => (chunk.vector = vectors[index] ?? null));
    }

    this.documents = documents;
    const embedded = chunks.filter((chunk) => chunk.vector).length;
    const summary = `${documents.length} tài liệu, ${chunks.length} đoạn (${embedded} đoạn có vector)`;
    console.log(`[knowledge] ${summary}`);
    return summary;
  }

  /** One line per document, for the system prompt. */
  describe(): string {
    if (this.documents.length === 0) return "(chưa có tài liệu nào)";
    return this.documents.map((document) => `- ${document.name} (${document.chunks.length} phần)`).join("\n");
  }

  /** Hybrid search: keyword and vector rankings merged by reciprocal rank fusion. */
  async search(query: string, limit = SEARCH_RESULTS): Promise<{ source: string; text: string }[]> {
    const chunks = this.documents.flatMap((document) => document.chunks);
    const rankings = [this.rankByKeyword(chunks, query), await this.rankByMeaning(chunks, query)];

    const scores = new Map<Chunk, number>();
    for (const ranking of rankings) {
      ranking.forEach((chunk, rank) => scores.set(chunk, (scores.get(chunk) ?? 0) + 1 / (60 + rank)));
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([chunk]) => ({ source: chunk.source, text: chunk.text }));
  }

  private async rankByMeaning(chunks: Chunk[], query: string): Promise<Chunk[]> {
    const embedded = chunks.filter((chunk) => chunk.vector);
    if (!this.embedder || embedded.length === 0 || !query.trim()) return [];
    try {
      const vector = await this.embedder.embedQuery(query);
      return embedded
        .map((chunk) => ({ chunk, score: similarity(vector, chunk.vector!) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, CANDIDATES)
        .map(({ chunk }) => chunk);
    } catch (error) {
      console.error("[knowledge] vector search unavailable, using keywords only:", error);
      return [];
    }
  }

  private rankByKeyword(chunks: Chunk[], query: string): Chunk[] {
    const terms = [...new Set(tokenize(query))];
    if (chunks.length === 0 || terms.length === 0) return [];

    const averageLength = chunks.reduce((n, chunk) => n + chunk.tokens.length, 0) / chunks.length;
    const scores = new Map<Chunk, number>();
    for (const term of terms) {
      const matches = chunks.filter((chunk) => chunk.tokens.includes(term));
      if (matches.length === 0) continue;
      const idf = Math.log(1 + (chunks.length - matches.length + 0.5) / (matches.length + 0.5));
      for (const chunk of matches) {
        const frequency = chunk.tokens.filter((token) => token === term).length;
        const norm = frequency + 1.2 * (0.25 + 0.75 * (chunk.tokens.length / averageLength));
        scores.set(chunk, (scores.get(chunk) ?? 0) + (idf * frequency * 2.2) / norm);
      }
    }
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, CANDIDATES)
      .map(([chunk]) => chunk);
  }

  /** Appends a note to the admin notes file, which is indexed like any other document. */
  private async addNote(title: string, content: string): Promise<string> {
    const date = new Date().toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, NOTES_FILE), `## ${title} (${date})\n\n${content}\n\n`);
    await this.reload();
    return `Đã lưu vào ${NOTES_FILE}. Từ giờ có thể tra cứu thông tin này.`;
  }

  tools(): Tool[] {
    return [
      {
        name: "search_knowledge",
        description:
          "Tìm trong kho tài liệu nội bộ (PDF, Word, Excel, Google Sheets, văn bản). Luôn dùng trước khi trả lời câu hỏi về sản phẩm, giá, chính sách, quy trình. Trả về các đoạn liên quan nhất kèm nguồn.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Từ khoá hoặc câu hỏi cần tìm, bằng tiếng Việt." } },
          required: ["query"],
        },
        audience: "all",
        run: async (args) => {
          const results = await this.search(String(args.query ?? ""));
          return results.length ? results : "Không tìm thấy đoạn nào phù hợp. Thử từ khoá khác hoặc đọc trực tiếp tài liệu.";
        },
      },
      {
        name: "read_document",
        description:
          "Đọc một phần của tài liệu theo tên (xem danh sách tài liệu trong hướng dẫn hệ thống). Dùng khi cần đọc nguyên văn hoặc khi tìm kiếm không ra.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Tên tài liệu chính xác như trong danh sách." },
            part: { type: "integer", description: "Số thứ tự phần, bắt đầu từ 1." },
          },
          required: ["name"],
        },
        audience: "all",
        run: async (args) => {
          const document = this.documents.find((candidate) => candidate.name === args.name);
          if (!document) throw new Error(`Không có tài liệu tên "${args.name}"`);
          const part = Math.min(Math.max(Number(args.part) || 1, 1), document.chunks.length);
          const chunk = document.chunks[part - 1];
          return { part, totalParts: document.chunks.length, source: chunk?.source, text: chunk?.text ?? "" };
        },
      },
      {
        name: "add_knowledge_note",
        description:
          "Lưu một thông tin mới vào kho tài liệu để từ nay bot trả lời được cho mọi khách (ví dụ: chính sách mới, giá mới, câu trả lời chuẩn). Chỉ dùng khi quản trị viên yêu cầu ghi nhớ, bổ sung hoặc cập nhật kiến thức chung.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "Tiêu đề ngắn của thông tin." },
            content: { type: "string", description: "Nội dung đầy đủ, viết để đọc riêng vẫn hiểu." },
          },
          required: ["title", "content"],
        },
        audience: "admin",
        run: async (args) => {
          const title = String(args.title ?? "").replace(/\s+/g, " ").trim();
          const content = String(args.content ?? "").trim();
          if (!title || !content) throw new Error("Thiếu tiêu đề hoặc nội dung");
          return this.addNote(title, content);
        },
      },
    ];
  }
}

// --- Reading sources ---------------------------------------------------------------------------

/** A document is a list of sections; each is free text or a table. */
interface Section {
  label: string;
  text?: string;
  rows?: Cell[][];
}

async function listFiles(dir: string, excludeTopLevel: string[] = []): Promise<string[]> {
  const excluded = new Set(excludeTopLevel.map((name) => name.toLowerCase()));
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && !entry.name.startsWith("~$"))
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => {
      // "procedures/x.txt" and "system-prompt.txt" both resolve to their top-level name.
      const top = relative(dir, path).split(/[\\/]/)[0]!;
      return !excluded.has(top.toLowerCase()) && !excluded.has(top.replace(/\.[^.]+$/, "").toLowerCase());
    })
    .sort();
}

/** Returns null for file types we do not index. */
async function readFileSections(path: string): Promise<Section[] | null> {
  switch (extname(path).toLowerCase()) {
    case ".txt":
    case ".md":
      return [{ label: "", text: await readFile(path, "utf8") }];
    case ".csv":
      return [{ label: "", rows: parseCsv(await readFile(path, "utf8")) }];
    case ".pdf": {
      const { text } = await extractText(new Uint8Array(await readFile(path)));
      return text.map((page, index) => ({ label: `trang ${index + 1}`, text: page }));
    }
    case ".docx": {
      const { value } = await mammoth.extractRawText({ path });
      return [{ label: "", text: value }];
    }
    case ".xlsx": {
      const sheets = await readXlsxFile(path);
      return sheets.map((sheet) => ({ label: sheet.sheet, rows: sheet.data as Cell[][] }));
    }
    default:
      console.warn(`[knowledge] skipped unsupported file: ${path}`);
      return null;
  }
}

const MAX_URL_BYTES = 20_000_000;
const TYPE_EXTENSIONS: [pattern: RegExp, extension: string][] = [
  [/pdf/, ".pdf"],
  [/wordprocessingml/, ".docx"],
  [/spreadsheetml/, ".xlsx"],
  [/csv/, ".csv"],
];

/**
 * Reads one web address as a document: a Google Sheet or Doc shared by link, a file served at the
 * URL (pdf, docx, xlsx, csv), or an ordinary web page, whose visible text is used.
 */
async function readUrlSections(url: string): Promise<Section[]> {
  if (/docs\.google\.com\/spreadsheets\//.test(url)) return [{ label: "", rows: parseCsv(await fetchSheetCsv(url)) }];
  const googleDoc = /docs\.google\.com\/document\/d\/([\w-]+)/.exec(url)?.[1];
  const target = googleDoc ? `https://docs.google.com/document/d/${googleDoc}/export?format=txt` : url;

  const { url: finalUrl, contentType, body } = await fetchPublic(target, MAX_URL_BYTES);
  // A private Google Doc answers with its sign-in page instead of an error.
  if (googleDoc && contentType.includes("html")) throw new Error('share the document as "Anyone with the link can view"');

  const fromPath = extname(new URL(finalUrl).pathname).toLowerCase();
  const extension = TYPE_EXTENSIONS.find(([pattern]) => pattern.test(contentType))?.[1] ?? ([".pdf", ".docx", ".xlsx", ".csv"].includes(fromPath) ? fromPath : "");
  if (extension) {
    // The file parsers read from disk, so park the download in a temp file.
    const path = join(tmpdir(), `zalo-agent-${randomUUID()}${extension}`);
    await writeFile(path, body);
    try {
      return (await readFileSections(path)) ?? [];
    } finally {
      await rm(path, { force: true });
    }
  }
  const text = body.toString("utf8");
  return [{ label: "", text: contentType.includes("html") ? htmlToText(text) : text }];
}

export async function fetchSheetCsv(url: string): Promise<string> {
  const id = /\/spreadsheets\/d\/([\w-]+)/.exec(url)?.[1];
  if (!id) throw new Error(`Not a Google Sheets URL: ${url}`);
  const gid = /[?&#]gid=(\d+)/.exec(url)?.[1] ?? "0";
  const response = await fetch(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`, {
    signal: AbortSignal.timeout(20_000),
  });
  const type = response.headers.get("content-type") ?? "";
  // A private sheet redirects to an HTML login page instead of failing.
  if (!response.ok || !type.includes("csv")) {
    throw new Error(`HTTP ${response.status} (${type}); share the sheet as "Anyone with the link can view"`);
  }
  return response.text();
}

export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const text = csv.replace(/^﻿/, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") (row.push(field), (field = ""));
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      (row = []), (field = "");
    } else field += char;
  }
  if (field || row.length) (row.push(field), rows.push(row));
  return rows;
}

// --- Chunking and tokenising -------------------------------------------------------------------

function buildDocument(name: string, sections: Section[]): Document {
  const chunks: Chunk[] = [];
  const add = (label: string, text: string) => {
    const source = label ? `${name} › ${label}` : name;
    chunks.push({ source, text, tokens: tokenize(`${name} ${label} ${text}`), vector: null });
  };
  for (const section of sections) {
    if (section.rows) for (const piece of chunkRows(section.rows)) add(join2(section.label, piece.label), piece.text);
    else for (const text of chunkParagraphs(section.text ?? "")) add(section.label, text);
  }
  return { name, chunks };
}

const join2 = (a: string, b: string) => [a, b].filter(Boolean).join(" ");

function chunkParagraphs(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\s*\n|\r\n\s*\r\n/).flatMap(splitLong)) {
    const clean = paragraph.trim();
    if (!clean) continue;
    if (current && current.length + clean.length > CHUNK_CHARS) (chunks.push(current), (current = ""));
    current = current ? `${current}\n\n${clean}` : clean;
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitLong(paragraph: string): string[] {
  const pieces: string[] = [];
  for (let rest = paragraph; rest; rest = rest.slice(CHUNK_CHARS)) pieces.push(rest.slice(0, CHUNK_CHARS));
  return pieces;
}

/** Each row becomes `Header: value | Header: value`, so a chunk is readable without its header row. */
function chunkRows(rows: Cell[][]): { label: string; text: string }[] {
  const filled = rows.map((row) => row.map(formatCell)).filter((row) => row.some(Boolean));
  const header = filled[0];
  if (!header) return [];
  if (filled.length === 1) return [{ label: "(dòng 1)", text: header.filter(Boolean).join(" | ") }];

  const chunks: { label: string; text: string }[] = [];
  let lines: string[] = [];
  let first = 2;
  const flush = (last: number) => {
    if (lines.length) chunks.push({ label: `(dòng ${first}-${last})`, text: lines.join("\n") });
    lines = [];
    first = last + 1;
  };
  filled.slice(1).forEach((row, index) => {
    const line = row
      .map((value, column) => (value ? `${header[column] || `Cột ${column + 1}`}: ${value}` : ""))
      .filter(Boolean)
      .join(" | ");
    if (lines.length && lines.join("\n").length + line.length > CHUNK_CHARS) flush(index + 1);
    lines.push(line);
  });
  flush(filled.length);
  return chunks;
}

function formatCell(cell: Cell): string {
  if (cell == null) return "";
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  return String(cell).replace(/\s+/g, " ").trim();
}

/** Lowercased, accent-folded words plus adjacent pairs (Vietnamese words are often two syllables). */
export function tokenize(text: string): string[] {
  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replaceAll("đ", "d")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const pairs = words.slice(1).map((word, index) => `${words[index]}_${word}`);
  return [...words, ...pairs];
}
