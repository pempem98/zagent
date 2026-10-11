import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import { Agent, conversationKey } from "./ai/agent.js";
import { Embedder } from "./ai/embeddings.js";
import { ConversationStore, UserMemory, userKey } from "./ai/memory.js";
import { isQuotaError, ModelPool, responseText } from "./ai/models.js";
import { buildSystemPrompt, Instructions } from "./ai/prompt.js";
import { resolveModels } from "./ai/providers.js";
import { createHubFromEnv } from "./channels/hub.js";
import type { ChannelId, IncomingMessage, Target } from "./channels/types.js";
import { Broadcaster } from "./broadcast.js";
import { DRIVE_ALIASES, LAYOUT, loadConfig } from "./config.js";
import { Contacts, type BroadcastAudience } from "./contacts.js";
import { MessageLog } from "./message-log.js";
import { installFileLogging, startRetention } from "./retention.js";
import { DRIVE_READONLY_SCOPE, GoogleAuth, ServiceAccountAuth, type TokenSource } from "./google/auth.js";
import { AdminDesk } from "./tools/admin.js";
import { DriveSync } from "./tools/drive.js";
import { HttpTools } from "./tools/http-tools.js";
import { KnowledgeBase } from "./tools/knowledge.js";
import { McpHub } from "./tools/mcp.js";
import { Procedures } from "./tools/procedures.js";
import { Scheduler } from "./tools/scheduler.js";
import { webTools } from "./tools/web.js";

try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the real environment.
}

const config = loadConfig();
// From here on, console output is also kept in data/logs/, one file per day.
installFileLogging(join("data", "logs"));
// Message logs and console logs older than the retention period are deleted, at start-up and through the day.
const retention = startRetention([join("data", "logs"), join("data", "messages")], config.logRetentionDays);
const hub = createHubFromEnv();
const gemini = config.geminiApiKey ? new GoogleGenAI({ apiKey: config.geminiApiKey }) : undefined;
const data = (name: string) => join("data", name);
/** Local mirror of the Google Drive folder; it follows the same layout as the workspace. */
const DRIVE_DIR = data("drive");
/** How many earlier group messages the model is shown when it is addressed in a group. */
const GROUP_CONTEXT_MESSAGES = 15;
const workspace = (name: string) => join(config.workspaceDir, name);

const resolved = await resolveModels(config.models, process.env, gemini);
const models = new ModelPool(resolved.providers, resolved.models, {
  blockFile: data("blocked-keys.json"),
  // A key that ran out of credit or daily quota is set aside until midnight; tell the admins once.
  onExhausted: ({ provider, reason, remaining }) =>
    notifyAdmins(
      [
        `⚠️ Khoá API "${provider}" đã hết hạn mức hoặc hết tiền.`,
        `Chi tiết: ${reason}`,
        "Bot ngừng dùng khoá này đến hết hôm nay.",
        remaining.length ? `Đang chạy tiếp bằng: ${remaining.join(", ")}` : "KHÔNG CÒN model nào dùng được: bot tạm thời không trả lời khách.",
        `Nạp thêm xong, nhắn /unblock ${provider} để dùng lại ngay.`,
      ].join("\n"),
    ),
});
await models.load();

function notifyAdmins(text: string): void {
  for (const admin of config.admins) {
    // An admin on a channel that is not running must not stop the others from being told.
    void Promise.resolve()
      .then(() => hub.send(admin.channel, { threadId: admin.id, isGroup: false }, text))
      .catch((error) => console.error(`[admin] cannot notify ${admin.channel}:${admin.id}:`, error));
  }
}

// Vector search runs on Gemini embeddings; without a Gemini key, search is keyword-only.
const embedder = gemini ? new Embedder(gemini, config.embeddingModel, data("embeddings.json")) : undefined;
if (!embedder) console.warn("[knowledge] GEMINI_API_KEY not set: searching by keyword only (no vector search)");
const knowledge = new KnowledgeBase(workspace(LAYOUT.knowledge), config.knowledgeUrls, embedder, await connectDrive());

/** Google Drive as a knowledge source, when folders are listed and a Google identity is set up. */
async function connectDrive(): Promise<{ dir: string; label: string; exclude: string[]; sync(): Promise<unknown> } | undefined> {
  if (config.driveSources.length === 0) return undefined;

  let auth: TokenSource;
  // What to check when Drive says a folder does not exist: usually it was never shared with us.
  let notFoundHint: string;
  if (config.googleServiceAccountFile) {
    try {
      const account = new ServiceAccountAuth(JSON.parse(await readFile(config.googleServiceAccountFile, "utf8")), [DRIVE_READONLY_SCOPE]);
      auth = account;
      notFoundHint = `share the folder with ${account.email} (Viewer)`;
    } catch (error) {
      console.warn(`[drive] cannot use service-account key file "${config.googleServiceAccountFile}": ${(error as Error).message}. Drive is off`);
      return undefined;
    }
  } else if (config.google) {
    const oauth = new GoogleAuth(config.google);
    if (!(await oauth.isSignedIn())) {
      console.warn("[drive] not signed in to Google yet; run `npm run google-login`, then restart. Drive is off for now");
      return undefined;
    }
    auth = oauth;
    notFoundHint = "the signed-in Google account must be able to open the folder";
  } else {
    console.warn("[drive] GOOGLE_DRIVE_FOLDERS is set but neither GOOGLE_SERVICE_ACCOUNT_FILE nor a Google OAuth client is configured; Drive is off");
    return undefined;
  }

  const drive = new DriveSync(auth, config.driveSources, DRIVE_DIR);
  return {
    dir: drive.dir,
    label: "Drive",
    // Everything on Drive is knowledge except the folders and the document that configure the bot.
    exclude: [...DRIVE_ALIASES.procedures, ...DRIVE_ALIASES.listings, ...DRIVE_ALIASES.systemPrompt],
    sync: async () => {
      await drive.sync().catch((error: Error) => {
        throw / 404 /.test(error.message) ? new Error(`${error.message} -> ${notFoundHint}`) : error;
      });
      // Procedures and the system prompt may have changed on Drive too.
      await Promise.all([procedures.load(), instructions.load()]).catch((error) => console.error("[drive] cannot apply synced configuration:", error));
    },
  };
}
// Procedures and the system prompt are read from the workspace and, when present, from the same
// places in the Drive mirror (a Google Doc arrives as .txt). The Drive copy wins.
const procedures = new Procedures(
  workspace(LAYOUT.procedures),
  DRIVE_ALIASES.procedures.map((name) => join(DRIVE_DIR, name)),
);
const instructions = new Instructions(
  workspace(`${LAYOUT.systemPrompt}.md`),
  DRIVE_ALIASES.systemPrompt.flatMap((name) => [join(DRIVE_DIR, `${name}.txt`), join(DRIVE_DIR, `${name}.md`)]),
);
const httpTools = new HttpTools(config.customToolsFile);
const mcp = new McpHub();
// WEB_AUDIENCE=off removes web search and page reading altogether.
const web = config.webAudience === "off" ? [] : webTools(config.webAudience, models);
const memory = new UserMemory(data("memories.json"));

const conversations = new ConversationStore(data("conversations.json"), async (previous, transcript) => {
  const response = await models.generate({
    contents: `Viết lại bản tóm tắt cuộc trò chuyện giữa người dùng và trợ lý, tối đa 200 từ, bằng tiếng Việt. Giữ lại: nhu cầu và hoàn cảnh của người dùng, các số liệu và quyết định đã chốt, việc còn dang dở. Bỏ lời chào và chi tiết vụn vặt.\n\nTóm tắt trước đó:\n${previous || "(chưa có)"}\n\nPhần trò chuyện cần gộp thêm:\n${transcript}`,
  });
  return responseText(response) || previous;
});

const desk = new AdminDesk(hub, config.admins, data("tickets.json"), (ticket, answer) => {
  conversations.append(conversationKey(ticket), ticket.question, `Quản trị viên đã trả lời: ${answer}`);
});

const scheduler = new Scheduler(data("tasks.json"), (task) =>
  enqueue(conversationKey(task), async () => {
    // System jobs are carried out directly, with no model call, and reported to the admin who set them.
    if (task.job) {
      console.log(`[scheduler] running ${task.job.type} job #${task.id}`);
      const report =
        task.job.type === "reload"
          ? await reloadAll()
          : await broadcaster.send(task.job.text, task.job.audience).then((result) => `Đã gửi thông báo theo lịch #${task.id}: ${result.sent} thành công${result.failed ? `, ${result.failed} lỗi` : ""}.`);
      await say(task.channel, task, report);
      return;
    }
    const message: IncomingMessage = {
      channel: task.channel,
      threadId: task.threadId,
      isGroup: task.isGroup,
      messageId: `task-${task.id}-${task.at}`,
      senderId: task.senderId,
      senderName: task.senderName,
      kind: "text",
      text: `[Lịch hẹn mã ${task.id} đã đến giờ] ${task.instruction}`,
      addressed: true,
      timestamp: Date.now(),
      raw: task,
    };
    console.log(`[scheduler] running task #${task.id} for ${conversationKey(task)}`);
    const text = await agent.reply(message, { isAdmin: desk.isAdmin(message), scheduled: true });
    await say(task.channel, task, text);
  }),
);

const contacts = new Contacts(data("contacts.json"), hub.ids);
// The Bot Platform never tells a group's name, so the admins are asked for one as the group appears.
contacts.onUnnamedGroup = (group, by) =>
  notifyAdmins(
    [
      `Bot vừa ghi nhận một nhóm mới: ${group.channel}:${group.threadId}${by ? ` (người nhắn đầu tiên: ${by})` : ""}.`,
      "Zalo không cho bot biết tên nhóm. Đặt tên để dễ nhận ra:",
      `/namegroup ${group.threadId} <tên nhóm>`,
    ].join("\n"),
  );
const messageLog = new MessageLog(data("messages"));
const broadcaster = new Broadcaster(hub, contacts, scheduler, (recipient, text) => messageLog.outgoing(recipient, text));

/** Every message the bot sends goes through here, so it is also written to the message log. */
async function say(channel: ChannelId, target: Target, text: string): Promise<void> {
  await hub.send(channel, target, text);
  messageLog.outgoing({ channel, threadId: target.threadId, isGroup: target.isGroup }, text);
}

/** Everything the operator can edit without code: prompt, procedures, custom tools, documents. */
async function reloadAll(): Promise<string> {
  // A broken prompt file is reported and the previous text stays in use.
  const promptError = await instructions.load().then(() => "", (error: Error) => `\nLỗi hướng dẫn hệ thống: ${error.message}`);
  await Promise.all([procedures.load(), httpTools.load()]);
  return `Đã nạp lại: ${await knowledge.reload()}; ${procedures.count} quy trình; ${httpTools.tools().length} công cụ tự khai báo; hướng dẫn hệ thống từ ${instructions.source}.${promptError}`;
}

const agent = new Agent({
  generate: (request) => models.generate(request),
  history: conversations,
  tools: () => [
    ...knowledge.tools(),
    ...procedures.tools(),
    ...web,
    ...memory.tools(),
    ...scheduler.tools(),
    ...broadcaster.tools(),
    ...contacts.tools(),
    ...desk.tools(),
    ...httpTools.tools(),
    ...mcp.tools(),
  ],
  systemPrompt: (context) =>
    buildSystemPrompt(
      {
        instructions: instructions.text,
        persona: config.persona,
        documents: knowledge.describe(),
        canAskAdmin: config.admins.length > 0,
        procedures: procedures.describe(),
        // Personal notes stay out of group chats, where everyone would see them used.
        userNotes: context.message.isGroup ? "" : memory.describe(userKey(context.message)),
        conversationSummary: conversations.summary(conversationKey(context.message)),
        // What others said in the group since the bot last looked; logged for free, read only now.
        groupContext: context.message.isGroup ? describeRecent(context.message) : "",
      },
      context,
    ),
});

await Promise.all([embedder?.load(), contacts.load(), instructions.load(), httpTools.load(), procedures.load(), memory.load(), conversations.load(), desk.load(), mcp.connect(config.mcpConfigFile)]);
await knowledge.start(config.knowledgeRefreshMinutes);

const HELP = `Lệnh có thể dùng:
/id - xem ID của bạn
/forget - xoá lịch sử trò chuyện và mọi ghi nhớ về bạn
/stop - ngừng nhận thông báo chung từ bot (/start để nhận lại)`;
const ADMIN_HELP = `
/reload - nạp lại tài liệu, quy trình, công cụ tự khai báo và hướng dẫn hệ thống
/procedures - xem các quy trình đã dạy cho bot
/tickets - các câu hỏi đang chờ bạn trả lời
/users, /groups - danh sách người dùng và nhóm bot đã gặp
/namegroup <ID nhóm> <tên> - đặt tên cho một nhóm (Zalo không cho bot biết tên nhóm)
/broadcast [users|groups|all] <nội dung> - soạn thông báo gửi hàng loạt (mặc định: users)
/confirm <mã>, /cancel <mã> - gửi hoặc huỷ một bản nháp thông báo
/keys - xem model đang dùng và khoá API nào đang bị chặn vì hết hạn mức
/unblock <tên> - mở lại một khoá API sau khi nạp thêm
#<mã> <nội dung> - trả lời một câu hỏi đang chờ`;

/** Commands and admin replies that are answered without the model. Null means "let the agent answer". */
async function handleCommand(message: IncomingMessage, isAdmin: boolean): Promise<string | null> {
  const text = message.text.trim();
  if (text === "/help") return HELP + (isAdmin ? ADMIN_HELP : "");
  if (text === "/id") {
    return `Kênh: ${message.channel}\nID của bạn: ${message.senderId}\nID hội thoại: ${message.threadId}\nCấu hình admin: ADMINS=${message.channel}:${message.senderId}`;
  }
  if (text === "/forget") {
    memory.clear(userKey(message));
    // In a group the shared history belongs to everyone, so only the sender's own notes go.
    if (!message.isGroup) conversations.clear(conversationKey(message));
    return "Đã xoá những gì mình ghi nhớ về bạn.";
  }
  if (text === "/stop" || text === "/start") {
    if (message.isGroup) return "Lệnh này chỉ dùng trong cuộc trò chuyện riêng với bot.";
    contacts.setSubscribed(message, text === "/start");
    return text === "/stop" ? "Đã tắt nhận thông báo chung. Bạn vẫn hỏi đáp với mình bình thường; nhắn /start để nhận lại." : "Đã bật lại nhận thông báo chung.";
  }
  // Admin commands list people and trigger mass messages: private chat only, never in a group.
  if (!isAdmin || message.isGroup) return null;
  if (text === "/reload") return reloadAll();
  if (text === "/users") return contacts.describeUsers();
  if (text === "/groups") return contacts.describeGroups();
  const naming = /^\/namegroup\s+(\S+)\s+([\s\S]+)$/.exec(text);
  if (naming) return contacts.nameGroup(naming[1]!, naming[2]!);
  if (text.startsWith("/namegroup")) return "Cách dùng: /namegroup <ID nhóm> <tên nhóm>. Nhắn /groups để xem ID.";
  const broadcast = /^\/broadcast(?:\s+(users|groups|all))?\s+([\s\S]+)$/.exec(text);
  if (broadcast) {
    try {
      return broadcaster.draft(message, broadcast[2]!, (broadcast[1] as BroadcastAudience | undefined) ?? "users");
    } catch (error) {
      return (error as Error).message;
    }
  }
  if (text === "/broadcast") return "Cách dùng: /broadcast [users|groups|all] <nội dung>";
  const decision = /^\/(confirm|cancel)\s+(\d+)$/.exec(text);
  if (decision) {
    const outcome = decision[1] === "confirm" ? await broadcaster.confirm(decision[2]!, message) : broadcaster.cancel(decision[2]!);
    // Commands bypass the model; note the outcome in its history so it does not keep asking for a confirmation.
    conversations.append(conversationKey(message), text, outcome);
    return outcome;
  }
  if (text === "/procedures") return procedures.list();
  if (text === "/tickets") return desk.listOpen();
  if (text === "/keys") {
    const time = (at: number) => new Date(at).toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", timeStyle: "short", dateStyle: "short" });
    const blocked = models.blockedProviders.map((item) => `- ${item.provider}: bị chặn đến ${time(item.until)}`);
    return [`Model đang dùng: ${models.activeLabels.join(", ") || "(không còn model nào)"}`, ...(blocked.length ? ["Khoá hết hạn mức:", ...blocked] : ["Không có khoá nào bị chặn."])].join("\n");
  }
  const unblock = /^\/unblock\s+(\S+)$/.exec(text)?.[1]?.toLowerCase();
  if (unblock) return models.unblock(unblock) ? `Đã mở lại khoá "${unblock}".` : `Khoá "${unblock}" không bị chặn.`;
  return desk.handleAnswer(message);
}

// One job at a time per conversation, so replies stay in order and share memory safely.
const queues = new Map<string, Promise<void>>();

function enqueue(key: string, job: () => Promise<void>): Promise<void> {
  const next = (queues.get(key) ?? Promise.resolve()).then(job);
  const settled = next.catch(() => {});
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return next;
}

/** Recent model-backed replies per group, to cap what a busy group can spend. */
const groupReplies = new Map<string, number[]>();

function groupBudgetLeft(message: IncomingMessage): boolean {
  const key = conversationKey(message);
  const recent = (groupReplies.get(key) ?? []).filter((at) => at > Date.now() - 3_600_000);
  if (recent.length >= config.groupRepliesPerHour) return false;
  recent.push(Date.now());
  groupReplies.set(key, recent);
  return true;
}

/** The last messages of a group, other than the one being answered, for the system prompt. */
function describeRecent(message: IncomingMessage): string {
  return messageLog
    .recent(message, GROUP_CONTEXT_MESSAGES + 1)
    .slice(0, -1)
    .map((entry) => `${entry.direction === "out" ? "Bạn (bot)" : entry.senderName || entry.senderId}: ${entry.kind === "text" ? entry.text.slice(0, 300) : `[${entry.kind}]`}`)
    .join("\n");
}

async function handle(message: IncomingMessage): Promise<void> {
  // Remember who and what, for every message. This is plain bookkeeping: no model call, no tokens.
  contacts.record(message);
  messageLog.incoming(message);
  // Group chatter that is not meant for the bot stops here.
  if (!message.addressed) return;
  // Text and emoji only; pictures, stickers, voice and files are not processed.
  if (message.kind !== "text" || !message.text.trim()) {
    if (!message.isGroup) await say(message.channel, message, "Hiện mình chỉ đọc được tin nhắn chữ. Bạn gõ câu hỏi giúp mình nhé.");
    return;
  }
  console.log(`[${message.channel}] ${message.senderName || message.senderId}: ${message.text}`);

  const isAdmin = desk.isAdmin(message);
  let typing: NodeJS.Timeout | undefined;
  try {
    const direct = await handleCommand(message, isAdmin);
    if (direct !== null) return await say(message.channel, message, direct);
    if (message.isGroup && !groupBudgetLeft(message)) {
      console.warn(`[${message.channel}] group ${message.threadId} is over its hourly reply limit; message logged, not answered`);
      return;
    }
    // Answers can take a while (tool calls, slow models), so keep the "typing" indicator alive.
    await hub.typing(message);
    typing = setInterval(() => void hub.typing(message), 6000);
    const answer = await agent.reply(message, { isAdmin });
    clearInterval(typing);
    await say(message.channel, message, answer);
  } catch (error) {
    clearInterval(typing);
    console.error(`[${message.channel}] failed to answer:`, error);
    const quota = isQuotaError(error);
    if (quota) console.error("[models] Every configured model is out of quota. Add credit or more provider keys.");
    const apology = quota
      ? `Xin lỗi, trợ lý AI đã hết lượt trả lời trong hôm nay.${isAdmin ? " (Admin: mọi khoá API đều hết hạn mức; nhắn /keys để xem.)" : " Bạn vui lòng nhắn lại sau nhé."}`
      : "Xin lỗi, hệ thống đang gặp sự cố. Bạn thử lại sau ít phút nhé.";
    await say(message.channel, message, apology).catch(() => {});
  }
}

await hub.start(
  (message) => enqueue(conversationKey(message), () => handle(message)),
  // Groups are remembered as soon as the channel learns of them, not only once someone writes there.
  (update) => contacts.recordGroup(update),
);
await scheduler.start();

console.log(`Zalo hub running on: ${hub.ids.join(", ")} | models: ${models.labels.join(" > ")} | admins: ${config.admins.length}`);
console.log(`System prompt: ${instructions.source} | procedures: ${procedures.count} | custom tools: ${httpTools.tools().length}`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    knowledge.stop();
    scheduler.stop();
    clearInterval(retention);
    void Promise.allSettled([hub.stop(), mcp.close(), contacts.flush(), messageLog.flush()]).then(() => process.exit(0));
  });
}
