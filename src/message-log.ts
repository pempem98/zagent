import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage, Target } from "./channels/types.js";
import { logDay } from "./retention.js";

export interface LoggedMessage {
  at: number;
  direction: "in" | "out";
  senderId: string;
  senderName: string;
  kind: string;
  text: string;
}

const RECENT_PER_THREAD = 30;
const MAX_THREADS_IN_MEMORY = 500;

/**
 * Every message the bot sees or sends, appended to plain JSON-lines files:
 * `<dir>/<YYYY-MM-DD>/<channel>-<thread>.jsonl`. Writing costs no model tokens, so busy groups are
 * recorded in full even though the bot only answers when it is addressed. The last few messages
 * of each thread are also kept in memory, to give the model context when it does answer.
 */
export class MessageLog {
  private readonly recentByThread = new Map<string, LoggedMessage[]>();
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  incoming(message: IncomingMessage): void {
    this.append(message, { at: Date.now(), direction: "in", senderId: message.senderId, senderName: message.senderName, kind: message.kind, text: message.text });
  }

  outgoing(target: Target & { channel: string }, text: string): void {
    this.append(target, { at: Date.now(), direction: "out", senderId: "bot", senderName: "bot", kind: "text", text });
  }

  /** The latest messages of a thread, oldest first. Empty right after a restart. */
  recent(target: { channel: string; threadId: string }, limit: number): LoggedMessage[] {
    return (this.recentByThread.get(key(target)) ?? []).slice(-limit);
  }

  /** Resolves once everything logged so far is on disk; for shutdown and tests. */
  flush(): Promise<void> {
    return this.writing;
  }

  private append(target: { channel: string; threadId: string }, entry: LoggedMessage): void {
    const threadKey = key(target);
    const recent = this.recentByThread.get(threadKey) ?? [];
    recent.push(entry);
    if (recent.length > RECENT_PER_THREAD) recent.shift();
    // Re-insert so the map stays ordered by activity, then drop the quietest thread.
    this.recentByThread.delete(threadKey);
    this.recentByThread.set(threadKey, recent);
    if (this.recentByThread.size > MAX_THREADS_IN_MEMORY) this.recentByThread.delete(this.recentByThread.keys().next().value!);

    // One folder per day, so old days can be dropped whole (see retention.ts).
    const folder = join(this.dir, logDay(entry.at));
    const file = join(folder, `${threadKey.replace(/[^\w.-]/g, "_")}.jsonl`);
    // One write at a time keeps lines whole and in order.
    this.writing = this.writing
      .then(async () => {
        await mkdir(folder, { recursive: true });
        await appendFile(file, `${JSON.stringify(entry)}\n`);
      })
      .catch((error) => console.error("[log] cannot write message log:", error));
  }
}

const key = (target: { channel: string; threadId: string }) => `${target.channel}-${target.threadId}`;
