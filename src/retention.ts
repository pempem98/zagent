import { appendFileSync, mkdirSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { format } from "node:util";

/** Today's date in Vietnam (UTC+7, no daylight saving), as `YYYY-MM-DD`. Log folders and files are named by it. */
export function logDay(at = Date.now()): string {
  return new Date(at + 7 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Deletes entries of `dir` whose name starts with a date (`2026-10-11`, `2026-10-11.log`) older
 * than `days` days. A month-only name (`2026-09`) counts as that month's last day, so it goes
 * once every day in it has aged out. Anything not named by a date is left alone.
 */
export async function pruneOlderThan(dir: string, days: number, now = Date.now()): Promise<string[]> {
  const cutoff = logDay(now - days * 86_400_000);
  const removed: string[] = [];
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const match = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?=\.|$)/.exec(name);
    if (!match) continue;
    const [, year, month, day] = match;
    // Day 0 of the next month is the last day of this one.
    const lastDay = day ?? String(new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate()).padStart(2, "0");
    if (`${year}-${month}-${lastDay}` >= cutoff) continue;
    await rm(join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

/** Prunes the given folders now and then every few hours. `days` of 0 keeps everything. */
export function startRetention(dirs: string[], days: number): NodeJS.Timeout | undefined {
  if (days <= 0) return undefined;
  const run = async () => {
    for (const dir of dirs) {
      const removed = await pruneOlderThan(dir, days).catch((error) => (console.error(`[retention] cannot clean ${dir}:`, error), []));
      if (removed.length) console.log(`[retention] ${dir}: removed ${removed.length} entries older than ${days} days (${removed.slice(0, 5).join(", ")}${removed.length > 5 ? ", …" : ""})`);
    }
  };
  void run();
  const timer = setInterval(() => void run(), 6 * 3_600_000);
  timer.unref();
  return timer;
}

/**
 * Also writes everything the bot prints to one file per day, `<dir>/YYYY-MM-DD.log`, so that
 * console output can be kept and cleaned by age. Docker's own log driver can only limit by size.
 */
export function installFileLogging(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      try {
        const time = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(11, 19);
        // Synchronous on purpose: lines stay in order and nothing is lost if the process dies next.
        appendFileSync(join(dir, `${logDay()}.log`), `${time} ${level.toUpperCase().padEnd(5)} ${format(...args)}\n`);
      } catch {
        // A full or read-only disk must not take the bot down with it.
      }
    };
  }
}
