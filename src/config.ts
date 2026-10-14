import type { Audience } from "./ai/tools.js";
import type { ChannelId } from "./channels/types.js";

export interface AdminRef {
  channel: ChannelId;
  /** The admin's user id on that channel (shown by the /id command). */
  id: string;
}

/** A web address read into the knowledge base: a Google Sheet, a web page, or a linked file. */
export interface UrlSource {
  name: string;
  url: string;
}

export interface Config {
  /** Optional: enables Gemini models, vector search and Google Search. */
  geminiApiKey?: string;
  /**
   * Tried in order; the next one takes over when a model fails or runs out of quota.
   * Each entry is `provider:model`, a bare Gemini model id, or just a provider name (openai,
   * deepseek, qwen, ollama, gemini, or any name with `<NAME>_BASE_URL` set) to use that
   * provider's cheapest model. Empty means: every provider with a key, cheapest model each.
   */
  models: string[];
  embeddingModel: string;
  /** Free-form description of the business and tone, appended to the system prompt. */
  persona: string;
  /**
   * The one folder holding everything the operator authors, laid out as in `LAYOUT`. A Google
   * Drive folder may hold the same layout; it is mirrored locally and wins where both have a file.
   */
  workspaceDir: string;
  /** JSON file of HTTP API tools defined without code. */
  customToolsFile: string;
  knowledgeUrls: UrlSource[];
  knowledgeRefreshMinutes: number;
  /** Key file of a Google service account: the simplest way to give the bot Drive access. */
  googleServiceAccountFile?: string;
  /** Google OAuth client (browser sign-in), the alternative to a service account. */
  google?: { clientId: string; clientSecret: string; tokenFile: string };
  /** Drive folders or files (ids or URLs) mirrored into the knowledge base. */
  driveSources: string[];
  /** First entry receives escalated questions; all entries get admin-only tools and commands. */
  admins: AdminRef[];
  mcpConfigFile: string;
  /** Days that message logs and console log files are kept; 0 keeps them forever. */
  logRetentionDays: number;
  /** Most model-backed replies the bot gives in one group per hour; 0 means it only listens there. */
  groupRepliesPerHour: number;
  /** Most model-backed replies one person gets per hour, across all chats; 0 means no limit. Admins are exempt. */
  userRepliesPerHour: number;
  /** Who may trigger web search and page fetching; "off" removes both tools. */
  webAudience: Audience | "off";
}

/**
 * Names inside the workspace folder, and inside a Drive folder that mirrors it:
 *
 *     system-prompt.md   the bot's instructions (a Google Doc named "system-prompt" on Drive)
 *     procedures/        one playbook per file
 *     knowledge/         documents to search
 *     listings/          listing tables for the real-estate MCP server
 */
export const LAYOUT = { systemPrompt: "system-prompt", procedures: "procedures", knowledge: "knowledge", listings: "listings" } as const;

/** Other names accepted for the same things in a Drive folder, so Vietnamese folder names work too. */
export const DRIVE_ALIASES = {
  systemPrompt: [LAYOUT.systemPrompt, "_system-prompt"],
  procedures: [LAYOUT.procedures, "_quy-trinh", "quy-trinh"],
  listings: [LAYOUT.listings, "_bang-hang", "bang-hang"],
  /** Templates for the people editing Drive; never read by the bot. */
  templates: ["templates", "_template", "template"],
} as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    geminiApiKey: env.GEMINI_API_KEY || undefined,
    // GEMINI_MODEL is the old name of MODELS.
    models: list(env.MODELS || env.GEMINI_MODEL),
    embeddingModel: env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001",
    persona: env.BOT_PERSONA ?? "",
    workspaceDir: env.WORKSPACE_DIR || "workspace",
    customToolsFile: env.CUSTOM_TOOLS_FILE || "tools.json",
    // GOOGLE_SHEETS is the old name of KNOWLEDGE_URLS.
    knowledgeUrls: list(env.KNOWLEDGE_URLS || env.GOOGLE_SHEETS).map(parseUrlSource),
    knowledgeRefreshMinutes: Number(env.KNOWLEDGE_REFRESH_MINUTES) || 10,
    googleServiceAccountFile: env.GOOGLE_SERVICE_ACCOUNT_FILE || undefined,
    google:
      env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET
        ? {
            clientId: env.GOOGLE_OAUTH_CLIENT_ID,
            clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
            tokenFile: env.GOOGLE_TOKEN_FILE || "data/google-token.json",
          }
        : undefined,
    driveSources: list(env.GOOGLE_DRIVE_FOLDERS),
    admins: list(env.ADMINS).map(parseAdmin),
    mcpConfigFile: env.MCP_CONFIG || "mcp.json",
    logRetentionDays: env.LOG_RETENTION_DAYS?.trim() ? Math.max(0, Number(env.LOG_RETENTION_DAYS) || 0) : 30,
    groupRepliesPerHour: env.GROUP_REPLIES_PER_HOUR?.trim() ? Math.max(0, Number(env.GROUP_REPLIES_PER_HOUR) || 0) : 30,
    userRepliesPerHour: env.USER_REPLIES_PER_HOUR?.trim() ? Math.max(0, Number(env.USER_REPLIES_PER_HOUR) || 0) : 20,
    webAudience: env.WEB_AUDIENCE === "admin" ? "admin" : /^(off|none|0|false)$/i.test(env.WEB_AUDIENCE ?? "") ? "off" : "all",
  };
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/** `bot:6ede9afa...` or `personal:1234567890` */
function parseAdmin(entry: string): AdminRef {
  const [channel, id] = entry.split(":");
  if ((channel !== "bot" && channel !== "personal") || !id) {
    throw new Error(`Invalid ADMINS entry "${entry}", expected bot:<id> or personal:<id>`);
  }
  return { channel, id };
}

/** `https://example.com/gia` or `Bảng giá=https://docs.google.com/...` */
function parseUrlSource(entry: string, index: number): UrlSource {
  if (/^https?:/i.test(entry)) return { name: `Nguồn web ${index + 1}`, url: entry };
  const split = entry.indexOf("=");
  if (split < 1) throw new Error(`Invalid KNOWLEDGE_URLS entry "${entry}"`);
  return { name: entry.slice(0, split).trim(), url: entry.slice(split + 1).trim() };
}
