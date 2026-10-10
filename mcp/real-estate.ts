/**
 * MCP server for a real-estate desk: search the listing sheet, look one listing up, record a
 * lead, and compute loan repayments. Runs over stdio; the bot starts it from mcp.json.
 *
 * Every tool is deliberately narrow so the server is safe to expose to all chat users: the
 * listing source is read-only, and the only write is appending one row to the leads file.
 *
 * Environment:
 *   LISTINGS_SOURCE  comma-separated: .csv / .xlsx files, folders of them, or Google Sheets URLs
 *                    shared "anyone with the link". Every table needs the same kind of header row.
 *   LEADS_FILE       CSV file that leads are appended to
 */
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import readXlsxFile from "read-excel-file/node";
import { fetchSheetCsv, parseCsv, tokenize } from "../src/tools/knowledge.js";

// The workspace folder plus the Drive mirror's listings folder under each name it may have.
const LISTINGS_SOURCE =
  process.env.LISTINGS_SOURCE || "workspace/listings,data/drive/_bang-hang,data/drive/bang-hang";
const LEADS_FILE = process.env.LEADS_FILE || "data/leads.csv";
const SHEET_CACHE_MS = 5 * 60_000;
const MAX_RESULTS = 8;

// --- Listings -----------------------------------------------------------------------------------

/** One row of the sheet, keyed by its original column titles. */
type Row = Record<string, string>;

interface Listing {
  row: Row;
  /** Accent-folded listing code, for exact look-up. */
  code: string;
  /** Accent-folded status text. */
  status: string;
  /** Billions of VND, or null when the price cell is empty or not a number ("thoả thuận"). */
  price: number | null;
  area: number | null;
  bedrooms: number | null;
  /** Accent-folded property type, e.g. "can ho". */
  type: string;
  /** Accent-folded text of the whole row, for matching. */
  haystack: string;
}

/** Sheet columns are found by keyword, so titles like "Giá (tỷ)" or "Gia ban" both work. */
const COLUMNS = {
  code: ["ma"],
  type: ["loai"],
  area: ["dien tich", "dt"],
  price: ["gia"],
  bedrooms: ["phong ngu", "pn"],
  status: ["tinh trang", "trang thai"],
};

const fold = (text: string) => tokenize(text).filter((token) => !token.includes("_")).join(" ");

function findColumn(headers: string[], keywords: string[]): string | undefined {
  return headers.find((header) => keywords.some((keyword) => ` ${fold(header)} `.includes(` ${keyword} `)));
}

/** "3,2", "3.2 tỷ", "850 triệu", "3200000000" -> billions of VND. */
export function parsePrice(text: string): number | null {
  const folded = fold(text.replace(/[.,](?=\d{3}\b)/g, "").replace(",", "."));
  const value = parseFloat(text.replace(/[.,](?=\d{3}\b)/g, "").replace(",", "."));
  if (!Number.isFinite(value)) return null;
  if (folded.includes("trieu")) return value / 1000;
  if (value >= 1_000_000) return value / 1_000_000_000;
  return value;
}

const parseNumber = (text: string) => {
  const value = parseFloat(text.replace(",", "."));
  return Number.isFinite(value) ? value : null;
};

let cache: { stamp: string; at: number; listings: Listing[] } | undefined;

/** One table to read: a file on disk, or a Google Sheets URL. */
type Source = { kind: "file"; path: string; stamp: string } | { kind: "sheet"; url: string };

/** Expands LISTINGS_SOURCE: each entry is a file, a folder of files, or a sheet URL. Missing paths are skipped. */
async function resolveSources(): Promise<Source[]> {
  const sources: Source[] = [];
  for (const entry of LISTINGS_SOURCE.split(",").map((item) => item.trim()).filter(Boolean)) {
    if (/^https?:/i.test(entry)) {
      sources.push({ kind: "sheet", url: entry });
      continue;
    }
    const info = await stat(entry).catch(() => null);
    if (!info) continue;
    const paths = info.isDirectory()
      ? (await readdir(entry, { recursive: true })).map((name) => join(entry, name)).sort()
      : [entry];
    for (const path of paths) {
      const name = basename(path);
      if (!/\.(csv|xlsx)$/i.test(name) || name.startsWith(".") || name.startsWith("~$")) continue;
      const file = await stat(path);
      sources.push({ kind: "file", path, stamp: `${path}:${file.mtimeMs}:${file.size}` });
    }
  }
  return sources;
}

/** Tables of one source, each with a label saying where it came from. */
async function readTables(source: Source): Promise<{ label: string; table: string[][] }[]> {
  if (source.kind === "sheet") return [{ label: "", table: parseCsv(await fetchSheetCsv(source.url)) }];
  const file = basename(source.path).replace(/\.[^.]+$/, "");
  if (extname(source.path).toLowerCase() !== ".xlsx") return [{ label: file, table: parseCsv(await readFile(source.path, "utf8")) }];
  const sheets = await readXlsxFile(source.path);
  return sheets.map((sheet) => ({
    // A workbook with one sheet is just "the file"; with several, the sheet name matters.
    label: sheets.length > 1 ? `${file} › ${sheet.sheet}` : file,
    table: sheet.data.map((cells) => cells.map((cell) => (cell == null ? "" : String(cell)))),
  }));
}

function toListings(table: string[][], label: string): Listing[] {
  const headers = (table[0] ?? []).map((header) => header.trim());
  const column = Object.fromEntries(Object.entries(COLUMNS).map(([key, keywords]) => [key, findColumn(headers, keywords)]));
  return (
    table
      .slice(1)
      .filter((cells) => cells.some((cell) => cell.trim()))
      .map((cells): Listing => {
        const row: Row = {};
        headers.forEach((header, index) => {
          const value = (cells[index] ?? "").trim();
          if (header && value) row[header] = value;
        });
        // Files are often named after the project, so the origin is searchable like any other field.
        if (label) row["Nguồn"] = label;
        const get = (key: string) => (column[key] ? (row[column[key]!] ?? "") : "");
        return {
          row,
          code: fold(get("code")),
          status: fold(get("status")),
          price: parsePrice(get("price")),
          area: parseNumber(get("area")),
          bedrooms: parseNumber(get("bedrooms")),
          type: fold(get("type")),
          haystack: fold(Object.values(row).join(" ")),
        };
      })
      // Sold or withdrawn listings must never be offered.
      .filter((listing) => !/\b(da ban|da coc|ngung|het hang)\b/.test(listing.status))
  );
}

async function loadListings(): Promise<Listing[]> {
  const sources = await resolveSources();
  const hasSheet = sources.some((source) => source.kind === "sheet");
  const stamp = sources.map((source) => (source.kind === "file" ? source.stamp : source.url)).join("|");
  if (cache && cache.stamp === stamp && (!hasSheet || Date.now() - cache.at < SHEET_CACHE_MS)) return cache.listings;

  const listings: Listing[] = [];
  for (const source of sources) {
    try {
      for (const { label, table } of await readTables(source)) listings.push(...toListings(table, label));
    } catch (error) {
      // One unreadable file must not hide the rest of the stock.
      console.error(`[real-estate] cannot read ${source.kind === "file" ? source.path : source.url}:`, error instanceof Error ? error.message : error);
    }
  }
  cache = { stamp, at: Date.now(), listings };
  return listings;
}

interface SearchArgs {
  tu_khoa?: string;
  khu_vuc?: string;
  loai?: string;
  gia_toi_thieu?: number;
  gia_toi_da?: number;
  phong_ngu_toi_thieu?: number;
  dien_tich_toi_thieu?: number;
}

async function searchListings(args: SearchArgs): Promise<unknown> {
  const listings = await loadListings();
  // Every word of the area and keyword filters must appear somewhere in the row.
  const words = [args.tu_khoa, args.khu_vuc].flatMap((text) => fold(text ?? "").split(" ")).filter(Boolean);
  // The type is matched against its own column: without accents, "căn hộ" and "hồ bơi" share a word.
  const type = fold(args.loai ?? "");
  const matches = listings.filter(
    (listing) =>
      words.every((word) => ` ${listing.haystack} `.includes(` ${word} `)) &&
      (!type || (listing.type ? listing.type.includes(type) || type.includes(listing.type) : listing.haystack.includes(type))) &&
      (args.gia_toi_da == null || (listing.price != null && listing.price <= args.gia_toi_da)) &&
      (args.gia_toi_thieu == null || (listing.price != null && listing.price >= args.gia_toi_thieu)) &&
      (args.phong_ngu_toi_thieu == null || (listing.bedrooms != null && listing.bedrooms >= args.phong_ngu_toi_thieu)) &&
      (args.dien_tich_toi_thieu == null || (listing.area != null && listing.area >= args.dien_tich_toi_thieu)),
  );
  matches.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));

  if (matches.length === 0) {
    return { tong_so: 0, ghi_chu: `Không có căn nào khớp trong ${listings.length} căn đang mở bán. Thử nới điều kiện, hoặc báo khách là chưa có hàng phù hợp.` };
  }
  return {
    tong_so: matches.length,
    ghi_chu: matches.length > MAX_RESULTS ? `Chỉ hiện ${MAX_RESULTS} căn giá thấp nhất; thêm điều kiện để lọc kỹ hơn.` : undefined,
    ket_qua: matches.slice(0, MAX_RESULTS).map((listing) => listing.row),
  };
}

async function getListing(code: string): Promise<unknown> {
  const wanted = fold(code);
  const listing = wanted ? (await loadListings()).find((candidate) => candidate.code === wanted) : undefined;
  if (!listing) throw new Error(`Không có căn mã "${code}" đang mở bán`);
  return listing.row;
}

// --- Leads --------------------------------------------------------------------------------------

const LEAD_FIELDS = ["ten", "so_dien_thoai", "nhu_cau", "ngan_sach", "khu_vuc", "ma_can_quan_tam", "ghi_chu"] as const;

async function saveLead(args: Record<string, unknown>): Promise<string> {
  const values = LEAD_FIELDS.map((field) => String(args[field] ?? "").replace(/\s+/g, " ").trim().slice(0, 300));
  const [name, phone, need] = values;
  if (!name || !need) throw new Error("Cần ít nhất tên khách và nhu cầu");
  if (phone && !/^\+?\d[\d .-]{7,14}$/.test(phone)) throw new Error("Số điện thoại không hợp lệ; hỏi lại khách");

  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  await mkdir(dirname(LEADS_FILE), { recursive: true });
  const isNew = await stat(LEADS_FILE).then(() => false, () => true);
  const time = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" });
  // A BOM makes Excel open the Vietnamese text correctly.
  const header = isNew ? `﻿${["thoi_gian", ...LEAD_FIELDS].join(",")}\n` : "";
  await appendFile(LEADS_FILE, `${header}${[time, ...values].map(quote).join(",")}\n`);
  return "Đã ghi nhận thông tin khách vào danh sách cho nhân viên kinh doanh.";
}

// --- Loan calculator ----------------------------------------------------------------------------

interface LoanArgs {
  so_tien_vay: number;
  lai_suat_nam: number;
  so_nam: number;
}

/** Amounts in millions of VND, rounded: precise enough to quote and easy to read. */
export function calculateLoan({ so_tien_vay, lai_suat_nam, so_nam }: LoanArgs): unknown {
  if (!(so_tien_vay > 0) || !(lai_suat_nam >= 0) || !(so_nam > 0)) throw new Error("Số tiền vay, lãi suất và số năm phải là số dương");
  const principal = so_tien_vay * 1000;
  const months = Math.round(so_nam * 12);
  const rate = lai_suat_nam / 100 / 12;
  const round = (millions: number) => Math.round(millions * 10) / 10;

  const level = rate === 0 ? principal / months : (principal * rate) / (1 - (1 + rate) ** -months);
  const monthlyPrincipal = principal / months;
  return {
    don_vi: "triệu đồng",
    so_thang: months,
    tra_deu_hang_thang: { moi_thang: round(level), tong_lai: round(level * months - principal) },
    du_no_giam_dan: {
      thang_dau: round(monthlyPrincipal + principal * rate),
      thang_cuoi: round(monthlyPrincipal * (1 + rate)),
      tong_lai: round((principal * rate * (months + 1)) / 2),
    },
    luu_y: "Tính với lãi suất cố định suốt kỳ vay; thực tế lãi thường thả nổi sau thời gian ưu đãi.",
  };
}

// --- MCP wiring ---------------------------------------------------------------------------------

const number = (description: string) => ({ type: "number", description });
const text = (description: string) => ({ type: "string", description });

const TOOLS = [
  {
    name: "search_listings",
    description:
      "Tìm bất động sản đang mở bán trong bảng hàng của sàn theo khu vực, loại, giá, số phòng ngủ, diện tích. Luôn dùng khi khách hỏi tìm mua, hỏi có căn nào, hỏi giá nhà đất; không tự bịa căn nào ngoài kết quả. Giá tính bằng tỷ đồng.",
    inputSchema: {
      type: "object",
      properties: {
        khu_vuc: text("Quận/huyện, phường, thành phố hoặc tên dự án. Ví dụ: 'Quận 7', 'Thủ Đức'."),
        loai: text("Loại hình. Ví dụ: 'căn hộ', 'nhà phố', 'đất nền', 'biệt thự'."),
        gia_toi_da: number("Giá cao nhất, tỷ đồng."),
        gia_toi_thieu: number("Giá thấp nhất, tỷ đồng."),
        phong_ngu_toi_thieu: number("Số phòng ngủ tối thiểu."),
        dien_tich_toi_thieu: number("Diện tích tối thiểu, m2."),
        tu_khoa: text("Từ khoá khác cần có trong thông tin căn. Ví dụ: 'sổ hồng', 'view sông', 'hướng đông nam'."),
      },
    },
    run: (args: Record<string, unknown>) => searchListings(args as SearchArgs),
  },
  {
    name: "get_listing",
    description: "Xem đầy đủ thông tin một căn theo mã trong bảng hàng.",
    inputSchema: { type: "object", properties: { ma: text("Mã căn, ví dụ 'CH-Q7-01'.") }, required: ["ma"] },
    run: (args: Record<string, unknown>) => getListing(String(args.ma ?? "")),
  },
  {
    name: "save_lead",
    description:
      "Ghi nhận một khách hàng tiềm năng cho nhân viên kinh doanh liên hệ. Dùng khi khách cho biết nhu cầu rõ ràng và để lại số điện thoại, hoặc muốn được gọi lại, muốn đi xem nhà. Mỗi khách chỉ ghi một lần cho một nhu cầu.",
    inputSchema: {
      type: "object",
      properties: {
        ten: text("Tên khách."),
        so_dien_thoai: text("Số điện thoại khách để lại. Không tự đoán; không có thì bỏ trống."),
        nhu_cau: text("Nhu cầu, ví dụ 'mua căn hộ 2 phòng ngủ để ở'."),
        ngan_sach: text("Ngân sách, ví dụ '3 tỷ'."),
        khu_vuc: text("Khu vực quan tâm."),
        ma_can_quan_tam: text("Mã các căn khách quan tâm, nếu có."),
        ghi_chu: text("Thông tin khác: thời gian tiện liên hệ, cần vay ngân hàng..."),
      },
      required: ["ten", "nhu_cau"],
    },
    run: (args: Record<string, unknown>) => saveLead(args),
  },
  {
    name: "calculate_loan",
    description:
      "Tính tiền trả góp hằng tháng cho khoản vay mua nhà theo hai cách: trả đều hằng tháng và dư nợ giảm dần. Luôn dùng công cụ này thay vì tự nhẩm.",
    inputSchema: {
      type: "object",
      properties: {
        so_tien_vay: number("Số tiền vay, tỷ đồng (ví dụ nhà 3 tỷ vay 70% thì là 2.1)."),
        lai_suat_nam: number("Lãi suất mỗi năm, phần trăm (ví dụ 8.5)."),
        so_nam: number("Thời hạn vay, năm."),
      },
      required: ["so_tien_vay", "lai_suat_nam", "so_nam"],
    },
    run: async (args: Record<string, unknown>) => calculateLoan(args as unknown as LoanArgs),
  },
];

const server = new Server({ name: "real-estate", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const tool = TOOLS.find((candidate) => candidate.name === request.params.name);
  try {
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
    const result = await tool.run(request.params.arguments ?? {});
    return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }] };
  } catch (error) {
    return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
// stdout carries the protocol, so diagnostics go to stderr.
console.error(`[real-estate] ready; listings from ${LISTINGS_SOURCE}, leads to ${LEADS_FILE}`);
