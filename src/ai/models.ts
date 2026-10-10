import type { GenerateContentResponse } from "@google/genai";
import { sleep } from "../channels/text.js";
import { JsonFile } from "../store.js";
import { GEMINI, type GenerateRequest, type Provider } from "./providers.js";

export type { GenerateRequest } from "./providers.js";

const MAX_COOLDOWN_MS = 60 * 60_000;
/** Longest a chat user is kept waiting for a rate limit to clear. */
const MAX_WAIT_MS = 40_000;
/** Status we assign to a call we gave up on. */
const TIMEOUT = 408;

interface Entry {
  /** As written in the model list, e.g. `deepseek:deepseek-chat`; used in logs. */
  label: string;
  provider: string;
  model: string;
}

/** `provider:model`; a bare name is a Gemini model. Only the first colon splits (Ollama tags contain colons). */
export function parseModelEntry(entry: string): Entry {
  const split = entry.indexOf(":");
  if (split < 0) return { label: entry, provider: GEMINI, model: entry };
  return { label: entry, provider: entry.slice(0, split).toLowerCase(), model: entry.slice(split + 1) };
}

/**
 * Sends each request to the first usable model in the list and moves down the list when one
 * fails: out of quota, retired, unreachable, or too slow. Mixing providers this way keeps the
 * bot answering when any single service has a bad day.
 */
export class ModelPool {
  private readonly entries: Entry[];
  /** label -> time it may be tried again */
  private readonly restingUntil = new Map<string, number>();
  /** `contents` array of a tool loop in progress -> entry serving it */
  private readonly loopEntry = new WeakMap<object, Entry>();
  /** provider -> time its API key may be used again, after it ran out of credit or daily quota */
  private readonly blocked: JsonFile<Record<string, number>>;
  /** False when no block file was given: blocks then last only as long as the process. */
  private readonly persist: boolean;
  private readonly onExhausted?: ModelPoolOptions["onExhausted"];

  constructor(
    private readonly providers: Map<string, Provider>,
    models: string[],
    options: ModelPoolOptions = {},
  ) {
    this.entries = models.map(parseModelEntry).filter((entry) => {
      if (providers.has(entry.provider)) return true;
      console.warn(`[models] skipping "${entry.label}": provider "${entry.provider}" is not configured (missing API key?)`);
      return false;
    });
    if (this.entries.length === 0) throw new Error("No usable model: add at least one provider API key to .env (see .env.example)");
    this.blocked = new JsonFile<Record<string, number>>(options.blockFile ?? "", {});
    this.persist = Boolean(options.blockFile);
    this.onExhausted = options.onExhausted;
  }

  /** Restores blocks from a previous run, so a restart does not hammer an exhausted key again. */
  async load(): Promise<void> {
    if (this.persist) await this.blocked.load();
  }

  get labels(): string[] {
    return this.entries.map((entry) => entry.label);
  }

  /** Models that may be used right now (their provider's key is not blocked). */
  get activeLabels(): string[] {
    return this.entries.filter((entry) => !this.isBlocked(entry.provider)).map((entry) => entry.label);
  }

  /** Providers whose key is blocked, with the time each block ends. */
  get blockedProviders(): { provider: string; until: number }[] {
    return Object.entries(this.blocked.data)
      .filter(([, until]) => until > Date.now())
      .map(([provider, until]) => ({ provider, until }));
  }

  /** Lifts a block early, e.g. after the admin topped the account up. False if it was not blocked. */
  unblock(provider: string): boolean {
    if (!this.isBlocked(provider)) return false;
    delete this.blocked.data[provider];
    if (this.persist) void this.blocked.save();
    return true;
  }

  private isBlocked(provider: string): boolean {
    return (this.blocked.data[provider] ?? 0) > Date.now();
  }

  private block(provider: string, reason: string): void {
    if (this.isBlocked(provider)) return;
    const until = endOfDay();
    this.blocked.data[provider] = until;
    if (this.persist) void this.blocked.save();
    console.error(`[models] ${provider}: key exhausted, blocked until ${new Date(until).toISOString()} (${reason})`);
    this.onExhausted?.({ provider, reason, until, remaining: this.activeLabels });
  }

  /** Whether some entry can serve requests that need the given provider's own features. */
  has(provider: string): boolean {
    return this.entries.some((entry) => entry.provider === provider);
  }

  /**
   * @param only Restrict to one provider, for requests using a feature only it has (e.g. Gemini's
   *   Google Search grounding). A refusal then says nothing about the model, so it is not rested.
   */
  async generate(request: GenerateRequest, only?: string): Promise<GenerateContentResponse> {
    const configured = only ? this.entries.filter((entry) => entry.provider === only) : this.entries;
    if (configured.length === 0) throw new Error(`No ${only} model configured`);
    const usable = configured.filter((entry) => !this.isBlocked(entry.provider));
    if (usable.length === 0) {
      throw Object.assign(new Error("Every configured API key is exhausted for today"), { status: 429 });
    }

    const awake = () => usable.filter((entry) => (this.restingUntil.get(entry.label) ?? 0) <= Date.now());
    let candidates = awake();
    if (candidates.length === 0) {
      // Per-minute limits clear quickly: wait for the first model to come back if that is soon.
      const wait = Math.min(...usable.map((entry) => this.restingUntil.get(entry.label)!)) - Date.now();
      if (wait <= MAX_WAIT_MS) {
        await sleep(wait + 500);
        candidates = awake();
      }
    }
    // Still nothing: try the whole list rather than refusing outright.
    if (candidates.length === 0) candidates = usable;

    // A tool loop calls back with the same `contents` array. Keep it on the model that started
    // it: tool-call ids and Gemini's thought signatures do not carry over cleanly between models.
    const loop = typeof request.contents === "object" ? (request.contents as object) : undefined;
    const previous = loop && this.loopEntry.get(loop);
    if (previous && candidates.includes(previous)) candidates = [previous, ...candidates.filter((entry) => entry !== previous)];
    let lastError: unknown;

    for (const entry of candidates) {
      // The key may have been blocked a moment ago, by an earlier candidate of the same provider.
      if (this.isBlocked(entry.provider)) continue;
      const startedAt = Date.now();
      try {
        const response = await this.attempt(entry, request);
        console.log(`[models] ${entry.label} answered in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
        if (loop) this.loopEntry.set(loop, entry);
        return response;
      } catch (error) {
        lastError = error;
        const status = (error as { status?: number }).status;
        const message = String((error as Error).message);
        console.warn(`[models] ${entry.label} failed (${status ?? "network"}): ${message.slice(0, 160)}`);
        // A feature refusal (`only`) says nothing about the key or the model.
        if (only) continue;
        if (isExhausted(status, error)) {
          this.block(entry.provider, exhaustionReason(status, message));
          continue;
        }
        const rest = restFor(status, error);
        if (rest > 0) this.restingUntil.set(entry.label, Date.now() + rest);
      }
    }
    // Callers tell "out of quota" apart by status; make sure it is set when that is the whole story.
    if (usable.every((entry) => this.isBlocked(entry.provider))) {
      throw Object.assign(new Error("Every configured API key is exhausted for today"), { status: 429 });
    }
    throw lastError;
  }

  private async attempt(entry: Entry, request: GenerateRequest): Promise<GenerateContentResponse> {
    try {
      return await this.call(entry, request);
    } catch (error) {
      // One retry on the same model for transient server trouble.
      const status = (error as { status?: number }).status;
      if (status !== 500 && status !== 503) throw error;
      await sleep(2000);
      return this.call(entry, request);
    }
  }

  /** A service can leave a request hanging for minutes; a chat user must not wait on that. */
  private async call(entry: Entry, request: GenerateRequest): Promise<GenerateContentResponse> {
    const provider = this.providers.get(entry.provider)!;
    const signal = AbortSignal.timeout(provider.timeoutSeconds * 1000);
    try {
      return await provider.generate(entry.model, request, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      throw Object.assign(new Error(`no answer within ${provider.timeoutSeconds}s`), { status: TIMEOUT });
    }
  }
}

export interface ExhaustedEvent {
  provider: string;
  /** Short, human-readable cause taken from the service's error. */
  reason: string;
  /** Epoch milliseconds when the key will be tried again. */
  until: number;
  /** Models still usable after this block; empty means the bot can no longer answer. */
  remaining: string[];
}

export interface ModelPoolOptions {
  /** Where key blocks are kept across restarts. Omit to keep them in memory only. */
  blockFile?: string;
  /** Called once when a provider's key is found exhausted and gets blocked for the day. */
  onExhausted?: (event: ExhaustedEvent) => void;
}

/**
 * True when the account behind the key has no credit or daily quota left, as opposed to a
 * per-minute rate limit that clears on its own within seconds.
 */
export function isExhausted(status: number | undefined, error: unknown): boolean {
  const message = String((error as Error).message);
  // 402 Payment Required: DeepSeek's "Insufficient Balance" and similar.
  if (status === 402) return true;
  if (/insufficient[_ ]?(quota|balance|credit)|arrearage|credit balance|out of credit|free ?tier.*(exhaust|only)|quota.*exhaust/i.test(message)) {
    return true;
  }
  // Gemini words per-minute and per-day limits alike; the quota id and the retry hint differ.
  if (status === 429) return /PerDay|per day|daily (limit|quota)/i.test(message) || (retryDelayMs(error) ?? 0) > 10 * 60_000;
  return false;
}

function exhaustionReason(status: number | undefined, message: string): string {
  const quoted = /"message":\s*"([^"]{1,160})/.exec(message)?.[1];
  return `HTTP ${status ?? "?"}: ${(quoted ?? message).replace(/\\n/g, " ").replace(/\s+/g, " ").slice(0, 160)}`;
}

/** Next midnight in Vietnam (UTC+7, no daylight saving), as epoch milliseconds. */
function endOfDay(now = Date.now()): number {
  const offset = 7 * 3_600_000;
  return (Math.floor((now + offset) / 86_400_000) + 1) * 86_400_000 - offset;
}

/** How long a model sits out after a failure. Zero when the fault lies with this one request. */
function restFor(status: number | undefined, error: unknown): number {
  if (status === 429) return Math.min(retryDelayMs(error) ?? 60_000, MAX_COOLDOWN_MS);
  // Bad key, no access, retired model: it will not fix itself soon.
  if (status === 401 || status === 403 || status === 404) return MAX_COOLDOWN_MS;
  if (status === TIMEOUT) return 15 * 60_000;
  // No status at all: the service could not be reached (e.g. Ollama is not running).
  if (status === undefined || status >= 500) return 60_000;
  return 0;
}

/** Visible text of a response, whichever provider produced it. */
export function responseText(response: GenerateContentResponse): string {
  return (response.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => part.text && !part.thought)
    .map((part) => part.text)
    .join("")
    .trim();
}

/** Reads the "retry in 28644s" hint Gemini puts in quota errors. */
function retryDelayMs(error: unknown): number | undefined {
  const seconds = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(String((error as Error).message))?.[1];
  return seconds ? Number(seconds) * 1000 : undefined;
}

/** True when the failure is "out of quota", so the user can be told something useful. */
export function isQuotaError(error: unknown): boolean {
  return (error as { status?: number }).status === 429;
}
