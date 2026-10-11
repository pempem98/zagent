import type { Tool } from "./ai/tools.js";
import type { ChannelId, GroupUpdate, IncomingMessage, Target } from "./channels/types.js";
import { JsonFile } from "./store.js";

export interface UserRecord {
  channel: ChannelId;
  id: string;
  name: string;
  firstSeen: number;
  lastSeen: number;
  messages: number;
  /** True once the person has written to the bot privately: only then can the bot write to them. */
  direct: boolean;
  /** False after the person opted out of broadcasts with /stop. */
  subscribed: boolean;
}

export interface GroupRecord {
  channel: ChannelId;
  threadId: string;
  /** Absent when the platform gives none (the Bot Platform never does). */
  name?: string;
  /** Size of the group as the platform reports it; absent when it does not. */
  memberCount?: number;
  firstSeen: number;
  lastSeen: number;
  /** Zero for a group known only from a join event or the group list. */
  messages: number;
  /** People seen talking in the group: id -> last known name. */
  members: Record<string, string>;
}

export type BroadcastAudience = "users" | "groups" | "all";
export type Recipient = Target & { channel: ChannelId; label: string };

interface Store {
  users: Record<string, UserRecord>;
  groups: Record<string, GroupRecord>;
}

const BOT_GROUPS_CAVEAT =
  "Lưu ý: trên kênh bot (Zalo Bot Platform), Zalo không cho liệt kê nhóm và thường không báo khi bot được thêm vào nhóm. Nhóm trên kênh này thường chỉ hiện ở đây sau khi có người @mention bot trong nhóm đó ít nhất một lần.";
const UNNAMED_GROUPS_HINT = "Nhóm chưa có tên: đặt bằng /namegroup <ID nhóm> <tên>, hoặc bảo bot tên của nhóm.";
const MAX_GROUP_NAME_CHARS = 100;
const MAX_MEMBERS_PER_GROUP = 2000;
const SAVE_DELAY_MS = 3000;

/** Everyone and every group the bot has seen, kept so the admin can reach them later. */
export class Contacts {
  private readonly file: JsonFile<Store>;
  private saveTimer?: NodeJS.Timeout;

  /** Called when a group turns up and the platform gave it no name; `by` is who wrote there, if anyone. */
  onUnnamedGroup?: (group: GroupRecord, by: string) => void;

  constructor(
    path: string,
    /** Channels in use; decides which caveats the group list carries. */
    private readonly channels: ChannelId[] = [],
  ) {
    this.file = new JsonFile<Store>(path, { users: {}, groups: {} });
  }

  async load(): Promise<void> {
    await this.file.load();
  }

  /** Call for every incoming message, whether or not the bot answers it. */
  record(message: IncomingMessage): void {
    const { users, groups } = this.file.data;
    const now = Date.now();
    const user = (users[`${message.channel}:${message.senderId}`] ??= {
      channel: message.channel,
      id: message.senderId,
      name: "",
      firstSeen: now,
      lastSeen: now,
      messages: 0,
      direct: false,
      subscribed: true,
    });
    user.name = message.senderName || user.name;
    user.lastSeen = now;
    user.messages++;
    if (!message.isGroup) user.direct = true;

    if (message.isGroup) {
      const key = `${message.channel}:${message.threadId}`;
      const isNew = !(key in groups);
      const group = (groups[key] ??= {
        channel: message.channel,
        threadId: message.threadId,
        firstSeen: now,
        lastSeen: now,
        messages: 0,
        members: {},
      });
      group.name = message.threadName || group.name;
      if (isNew && !group.name) this.onUnnamedGroup?.(group, message.senderName);
      group.lastSeen = now;
      group.messages++;
      if (message.senderId in group.members || Object.keys(group.members).length < MAX_MEMBERS_PER_GROUP) {
        group.members[message.senderId] = message.senderName || group.members[message.senderId] || "";
      }
    }
    this.saveSoon();
  }

  /** Applies what a channel learned about group membership without a message being sent there. */
  recordGroup(update: GroupUpdate): void {
    const { groups } = this.file.data;
    if (update.type === "left") {
      if (!(`${update.channel}:${update.threadId}` in groups)) return;
      delete groups[`${update.channel}:${update.threadId}`];
      console.log(`[${update.channel}] no longer in group ${update.threadId}`);
    } else {
      const seen = update.type === "list" ? update.groups : [update.group];
      const now = Date.now();
      for (const sighting of seen) {
        const key = `${sighting.channel}:${sighting.threadId}`;
        const isNew = !(key in groups);
        if (isNew) console.log(`[${sighting.channel}] new group ${sighting.name || sighting.threadId}`);
        const group = (groups[key] ??= { channel: sighting.channel, threadId: sighting.threadId, firstSeen: now, lastSeen: now, messages: 0, members: {} });
        group.name = sighting.name || group.name;
        // Not for a whole list: one failed name lookup there must not flood the admins.
        if (isNew && !group.name && update.type === "seen") this.onUnnamedGroup?.(group, "");
        group.memberCount = sighting.memberCount ?? group.memberCount;
      }
      if (update.type === "list") {
        const current = new Set(seen.map((sighting) => sighting.threadId));
        for (const [key, group] of Object.entries(groups)) {
          if (group.channel !== update.channel || current.has(group.threadId)) continue;
          delete groups[key];
          console.log(`[${update.channel}] no longer in group ${group.name || group.threadId}`);
        }
      }
    }
    this.saveSoon();
  }

  /**
   * Finds a group by its thread id, with or without the channel prefix, or by its name when
   * exactly one group carries it.
   */
  findGroup(ref: string, { byName = true } = {}): GroupRecord | undefined {
    const wanted = ref.trim();
    const byId = this.file.data.groups[wanted] ?? this.groups.find((candidate) => candidate.threadId === wanted);
    if (byId || !byName || !wanted) return byId;
    const named = this.groups.filter((candidate) => candidate.name?.toLowerCase() === wanted.toLowerCase());
    return named.length === 1 ? named[0] : undefined;
  }

  /**
   * Gives a group the name an admin chose, for platforms that tell none. `ref` is the thread id,
   * with or without its channel prefix. Returns the text to answer with.
   */
  nameGroup(ref: string, name: string): string {
    const group = this.findGroup(ref, { byName: false });
    if (!group) return `Không có nhóm nào mang ID "${ref.trim()}". Nhắn /groups để xem ID các nhóm.`;
    const label = name.replace(/\s+/g, " ").trim().slice(0, MAX_GROUP_NAME_CHARS);
    if (!label) return "Thiếu tên nhóm.";
    group.name = label;
    this.saveSoon();
    return `Đã đặt tên nhóm ${group.channel}:${group.threadId} là "${label}".`;
  }

  /** Returns false when the person is not known yet (never wrote to the bot). */
  setSubscribed(message: IncomingMessage, subscribed: boolean): boolean {
    const user = this.file.data.users[`${message.channel}:${message.senderId}`];
    if (!user) return false;
    user.subscribed = subscribed;
    this.saveSoon();
    return true;
  }

  get users(): UserRecord[] {
    return Object.values(this.file.data.users);
  }

  get groups(): GroupRecord[] {
    return Object.values(this.file.data.groups);
  }

  /** Where a broadcast would go: private chats of subscribed people, and/or every known group. */
  recipients(audience: BroadcastAudience): Recipient[] {
    const recipients: Recipient[] = [];
    if (audience !== "groups") {
      for (const user of this.users) {
        // A private thread has the person's own id on both channels.
        if (user.direct && user.subscribed) recipients.push({ channel: user.channel, threadId: user.id, isGroup: false, label: user.name || user.id });
      }
    }
    if (audience !== "users") {
      for (const group of this.groups) recipients.push({ channel: group.channel, threadId: group.threadId, isGroup: true, label: `nhóm ${group.name || group.threadId}` });
    }
    return recipients;
  }

  describeUsers(limit = 20): string {
    const users = this.users.sort((a, b) => b.lastSeen - a.lastSeen);
    const reachable = users.filter((user) => user.direct);
    const lines = users.slice(0, limit).map((user) => `- ${user.name || "(không tên)"} | ${user.channel}:${user.id} | ${user.messages} tin | ${ago(user.lastSeen)}${user.direct ? "" : " | chỉ gặp trong nhóm"}${user.subscribed ? "" : " | đã tắt nhận tin"}`);
    return [`${users.length} người dùng; ${reachable.length} người đã nhắn riêng, ${reachable.filter((user) => user.subscribed).length} người nhận thông báo.`, ...lines, users.length > limit ? `(và ${users.length - limit} người khác)` : ""].filter(Boolean).join("\n");
  }

  describeGroups(limit = 20): string {
    const groups = this.groups.sort((a, b) => b.lastSeen - a.lastSeen);
    // The Bot Platform has no group list and announces no joins, so that channel's list can lag.
    const caveat = this.channels.includes("bot") ? BOT_GROUPS_CAVEAT : "";
    if (groups.length === 0) return ["Bot chưa thấy nhóm nào.", caveat].filter(Boolean).join("\n");
    const lines = groups.slice(0, limit).map((group) =>
      [
        `- ${group.name || "(chưa có tên)"}`,
        `${group.channel}:${group.threadId}`,
        group.memberCount ? `${group.memberCount} thành viên` : "",
        group.messages ? `${Object.keys(group.members).length} người đã nhắn | ${group.messages} tin | ${ago(group.lastSeen)}` : "chưa có tin nào",
      ]
        .filter(Boolean)
        .join(" | "),
    );
    const unnamed = groups.some((group) => !group.name) ? UNNAMED_GROUPS_HINT : "";
    return [`${groups.length} nhóm.`, ...lines, groups.length > limit ? `(và ${groups.length - limit} nhóm khác)` : "", unnamed, caveat].filter(Boolean).join("\n");
  }

  tools(): Tool[] {
    return [
      {
        name: "list_contacts",
        description:
          "Đọc từ dữ liệu thật danh sách người dùng hoặc danh sách nhóm mà bot đang biết. BẮT BUỘC gọi mỗi khi quản trị viên hỏi bot đang ở những nhóm nào, đã có nhóm chưa, có bao nhiêu người dùng, hoặc ai đã nhắn cho bot; không trả lời các câu đó theo trí nhớ hay theo các tin trước trong cuộc trò chuyện, vì danh sách thay đổi liên tục.",
        parameters: {
          type: "object",
          properties: { kind: { type: "string", enum: ["users", "groups"], description: "users: người dùng; groups: các nhóm." } },
          required: ["kind"],
        },
        audience: "admin",
        run: async (args, { message }) => {
          // Same rule as /users and /groups: the list must not be shown where a whole group reads it.
          if (message.isGroup) throw new Error("Chỉ xem được danh sách này trong cuộc trò chuyện riêng với bot");
          return args.kind === "groups" ? this.describeGroups(50) : this.describeUsers(50);
        },
      },
      {
        name: "name_group",
        description:
          "Đặt hoặc đổi tên gọi của một nhóm trong danh sách của bot, để quản trị viên nhận ra nhóm (Zalo Bot Platform không cho bot biết tên nhóm). Dùng khi quản trị viên cho biết tên của một nhóm, hoặc bảo đặt tên cho nhóm. Việc này chỉ đổi tên trong sổ của bot, không đổi tên nhóm trên Zalo.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Tên nhóm, đúng như quản trị viên nói." },
            group_id: { type: "string", description: "ID nhóm lấy từ list_contacts (ví dụ zgr-...). Bỏ trống khi đang ở ngay trong nhóm cần đặt tên." },
          },
          required: ["name"],
        },
        audience: "admin",
        run: async (args, { message }) => {
          const ref = String(args.group_id ?? "").trim() || (message.isGroup ? `${message.channel}:${message.threadId}` : "");
          if (!ref) throw new Error("Thiếu group_id: gọi list_contacts để lấy ID nhóm, hoặc hỏi lại quản trị viên là nhóm nào");
          return this.nameGroup(ref, String(args.name ?? ""));
        },
      },
    ];
  }

  /** Writes any pending changes now; for shutdown. */
  async flush(): Promise<void> {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.file.save();
  }

  /** Groups can be busy; do not rewrite the file for every single message. */
  private saveSoon(): void {
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = undefined;
      void this.file.save();
    }, SAVE_DELAY_MS);
  }
}

function ago(at: number): string {
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 60) return `${minutes} phút trước`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} giờ trước`;
  return `${Math.round(minutes / 1440)} ngày trước`;
}
