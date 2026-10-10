import type { ChannelId, IncomingMessage, Target } from "./channels/types.js";
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
  firstSeen: number;
  lastSeen: number;
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

const MAX_MEMBERS_PER_GROUP = 2000;
const SAVE_DELAY_MS = 3000;

/** Everyone and every group the bot has seen, kept so the admin can reach them later. */
export class Contacts {
  private readonly file: JsonFile<Store>;
  private saveTimer?: NodeJS.Timeout;

  constructor(path: string) {
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
      const group = (groups[`${message.channel}:${message.threadId}`] ??= {
        channel: message.channel,
        threadId: message.threadId,
        firstSeen: now,
        lastSeen: now,
        messages: 0,
        members: {},
      });
      group.lastSeen = now;
      group.messages++;
      if (message.senderId in group.members || Object.keys(group.members).length < MAX_MEMBERS_PER_GROUP) {
        group.members[message.senderId] = message.senderName || group.members[message.senderId] || "";
      }
    }
    this.saveSoon();
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
      for (const group of this.groups) recipients.push({ channel: group.channel, threadId: group.threadId, isGroup: true, label: `nhóm ${group.threadId}` });
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
    if (groups.length === 0) return "Bot chưa thấy nhóm nào.";
    const lines = groups.slice(0, limit).map((group) => `- ${group.channel}:${group.threadId} | ${Object.keys(group.members).length} người đã nhắn | ${group.messages} tin | ${ago(group.lastSeen)}`);
    return [`${groups.length} nhóm.`, ...lines, groups.length > limit ? `(và ${groups.length - limit} nhóm khác)` : ""].filter(Boolean).join("\n");
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
