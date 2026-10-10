import type { Content, GenerateContentParameters, GenerateContentResponse, GoogleGenAI, Part } from "@google/genai";

/** A model call in Gemini's request shape, minus the model; every provider accepts this. */
export type GenerateRequest = Omit<GenerateContentParameters, "model">;

export interface Provider {
  /** Seconds before a call is abandoned and the next model is tried. */
  timeoutSeconds: number;
  generate(model: string, request: GenerateRequest, signal: AbortSignal): Promise<GenerateContentResponse>;
  /** Models this key can use; absent when the provider has a fixed default instead. */
  listModels?(): Promise<ModelInfo[]>;
}

export interface ModelInfo {
  id: string;
  /** Release time in epoch seconds, when the service reports it. */
  created?: number;
}

/** Base URLs of the OpenAI-compatible services known by name. Others need `<NAME>_BASE_URL`. */
const KNOWN_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  ollama: "http://localhost:11434/v1",
};

export const GEMINI = "gemini";
/** Hosted models answer a chat turn in a few seconds; past this, the next model is tried. */
const HOSTED_TIMEOUT_SECONDS = 15;

/**
 * Builds the provider for one name used in the model list, from `<NAME>_API_KEY`,
 * `<NAME>_BASE_URL` and `<NAME>_TIMEOUT_SECONDS`. Returns null when it is not configured.
 */
export function createProvider(name: string, env: NodeJS.ProcessEnv, gemini?: GoogleGenAI): Provider | null {
  if (name === GEMINI) {
    return gemini ? new GeminiProvider(gemini, Number(env.GEMINI_TIMEOUT_SECONDS) || HOSTED_TIMEOUT_SECONDS) : null;
  }

  const prefix = envPrefix(name);
  const apiKey = env[`${prefix}_API_KEY`];
  const baseUrl = env[`${prefix}_BASE_URL`] || KNOWN_BASE_URLS[name];
  // A local Ollama needs no key; every hosted service does.
  if (!baseUrl || (!apiKey && name !== "ollama")) return null;
  // Local models on modest hardware answer far more slowly than hosted ones.
  const timeoutSeconds = Number(env[`${prefix}_TIMEOUT_SECONDS`]) || (name === "ollama" ? 180 : HOSTED_TIMEOUT_SECONDS);
  return new OpenAICompatibleProvider(baseUrl.replace(/\/+$/, ""), apiKey, timeoutSeconds);
}

/** `openrouter` -> `OPENROUTER`, the prefix of that provider's environment variables. */
const envPrefix = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "_");

class GeminiProvider implements Provider {
  constructor(
    private readonly ai: GoogleGenAI,
    readonly timeoutSeconds: number,
  ) {}

  generate(model: string, request: GenerateRequest, abortSignal: AbortSignal): Promise<GenerateContentResponse> {
    return this.ai.models.generateContent({ ...request, model, config: { ...request.config, abortSignal } });
  }
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/** Any service speaking the OpenAI Chat Completions API: OpenAI, DeepSeek, Qwen, Ollama, OpenRouter... */
class OpenAICompatibleProvider implements Provider {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
    readonly timeoutSeconds: number,
  ) {}

  async generate(model: string, request: GenerateRequest, signal: AbortSignal): Promise<GenerateContentResponse> {
    const declarations = (request.config?.tools ?? []).flatMap((tool) =>
      "functionDeclarations" in tool ? (tool.functionDeclarations ?? []) : [],
    );
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({
        model,
        messages: toMessages(request),
        tools: declarations.length
          ? declarations.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parametersJsonSchema ?? { type: "object", properties: {} },
              },
            }))
          : undefined,
      }),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw Object.assign(new Error(`HTTP ${response.status} ${detail}`), { status: response.status });
    }

    const body = (await response.json()) as { choices?: { message?: ChatMessage }[] };
    const message = body.choices?.[0]?.message;
    const parts: Part[] = (message?.tool_calls ?? []).map((call) => ({
      functionCall: { id: call.id, name: call.function.name, args: parseArguments(call.function.arguments) },
    }));
    if (message?.content?.trim()) parts.unshift({ text: message.content });
    const content: Content = { role: "model", parts };
    if (message) rawAssistantMessages.set(content, message);
    return { candidates: [{ content }] } as GenerateContentResponse;
  }

  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/models`, {
      signal: AbortSignal.timeout(10_000),
      headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { data?: ModelInfo[] };
    return (body.data ?? []).filter((model) => typeof model.id === "string");
  }
}

// --- Choosing a default model -------------------------------------------------------------------

/** Providers used, in this order, when MODELS is left empty. Local Ollama is the last resort. */
const AUTO_ORDER = [GEMINI, "deepseek", "qwen", "openai", "ollama"];
const GEMINI_CHEAPEST = "gemini-flash-lite-latest";

/**
 * Name fragments of each service's cheapest chat tier, most preferred first. Model line-ups
 * change every few months, so the default is picked from what the key can actually use
 * (the service's own model list) rather than from a hard-coded model id.
 */
const CHEAP_TIERS: Record<string, RegExp[]> = {
  openai: [/nano/, /(^|[-./])mini/],
  deepseek: [/flash/, /chat/],
  qwen: [/^qwen-turbo/, /turbo/, /flash/],
};
const GENERIC_CHEAP_TIERS = [/nano/, /lite/, /turbo/, /flash/, /(^|[-./])mini/, /small/, /chat/];
/** Ids that are not text chat models. */
const NOT_CHAT =
  /embed|audio|tts|speech|image|imagen|banana|veo|lyria|realtime|transcri|whisper|moderation|rerank|ocr|asr|search|codex|dall|sora|video|-vl|omni|live|guard|translate|-mt-|robotics|computer-use/i;
const DATED = /\d{4}-\d{2}-\d{2}|\d{8}|-\d{4}$|preview|latest|exp/i;

/** Cheapest suitable chat model among those listed, or undefined when nothing looks right. */
export function pickCheapest(provider: string, models: ModelInfo[]): string | undefined {
  const chat = models.filter((model) => !NOT_CHAT.test(model.id));
  // Ollama models are all free and local: whichever is installed will do.
  if (provider === "ollama") return chat[0]?.id;
  for (const tier of CHEAP_TIERS[provider] ?? GENERIC_CHEAP_TIERS) {
    const matches = chat.filter((model) => tier.test(model.id.toLowerCase()));
    if (matches.length === 0) continue;
    // Within a tier: a stable alias over dated snapshots, then the newest, then the plainest name.
    matches.sort(
      (a, b) =>
        Number(DATED.test(a.id)) - Number(DATED.test(b.id)) || (b.created ?? 0) - (a.created ?? 0) || a.id.length - b.id.length,
    );
    return matches[0]!.id;
  }
  return undefined;
}

/**
 * Turns the MODELS setting into concrete `provider:model` entries plus the providers behind them.
 * An entry may be a full `provider:model`, a bare Gemini model id, or just a provider name, in
 * which case that provider's cheapest model is chosen. With no entries at all, every provider
 * that has a key configured is used, each on its cheapest model.
 */
export async function resolveModels(
  entries: string[],
  env: NodeJS.ProcessEnv,
  gemini?: GoogleGenAI,
): Promise<{ providers: Map<string, Provider>; models: string[] }> {
  const providers = new Map<string, Provider>();
  const provider = (name: string) => {
    if (!providers.has(name)) {
      const created = createProvider(name, env, gemini);
      if (created) providers.set(name, created);
    }
    return providers.get(name);
  };
  const isProviderName = (token: string) => token === GEMINI || token in KNOWN_BASE_URLS || Boolean(env[`${envPrefix(token)}_BASE_URL`]);

  const automatic = entries.length === 0;
  const models: string[] = [];
  for (const entry of automatic ? AUTO_ORDER : entries) {
    if (entry.includes(":") || !isProviderName(entry.toLowerCase())) {
      // Explicit model: leave it to the pool, which reports providers that are not configured.
      const name = entry.includes(":") ? entry.slice(0, entry.indexOf(":")).toLowerCase() : GEMINI;
      provider(name);
      models.push(entry);
      continue;
    }

    const name = entry.toLowerCase();
    const instance = provider(name);
    if (!instance) {
      if (!automatic) console.warn(`[models] skipping "${entry}": no API key configured for it`);
      continue;
    }
    if (name === GEMINI) {
      models.push(GEMINI_CHEAPEST);
      continue;
    }
    try {
      const model = pickCheapest(name, await instance.listModels!());
      if (!model) throw new Error("no suitable chat model in its model list");
      models.push(`${name}:${model}`);
    } catch (error) {
      // An Ollama that simply is not running is normal in automatic mode; stay quiet about it.
      if (!(automatic && name === "ollama")) {
        console.warn(`[models] cannot pick a default model for "${name}" (${(error as Error).message}); name one in MODELS, e.g. ${name}:<model>`);
      }
    }
  }
  return { providers, models };
}

/**
 * The provider's own assistant message for each model turn we returned. During a tool loop it is
 * sent back verbatim, because services attach fields they insist on seeing again (DeepSeek's
 * `reasoning_content`, Gemini's thought signatures in `extra_content`).
 */
const rawAssistantMessages = new WeakMap<Content, ChatMessage>();

function toMessages(request: GenerateRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const system = request.config?.systemInstruction;
  if (typeof system === "string" && system) messages.push({ role: "system", content: system });

  // Tool results must name the call they answer. Calls made by another provider may lack ids,
  // so ids are assigned here and matched to results by tool name, in order.
  const unanswered: { id: string; name?: string }[] = [];
  let counter = 0;

  // Simple callers pass a bare prompt string instead of a turn list.
  const contents: Content[] =
    typeof request.contents === "string" ? [{ role: "user", parts: [{ text: request.contents }] }] : (request.contents as Content[]);

  for (const content of contents) {
    const parts = content.parts ?? [];
    const text = parts
      .filter((part) => part.text && !part.thought)
      .map((part) => part.text)
      .join("");

    if (content.role === "model") {
      const raw = rawAssistantMessages.get(content);
      if (raw) {
        for (const call of raw.tool_calls ?? []) unanswered.push({ id: call.id, name: call.function.name });
        messages.push(raw);
        continue;
      }
      const calls = parts.flatMap((part) => (part.functionCall ? [part.functionCall] : []));
      const toolCalls = calls.map((call) => {
        const id = call.id ?? `call_${++counter}`;
        unanswered.push({ id, name: call.name });
        return { id, type: "function" as const, function: { name: call.name ?? "", arguments: JSON.stringify(call.args ?? {}) } };
      });
      messages.push({ role: "assistant", content: text || null, tool_calls: toolCalls.length ? toolCalls : undefined });
      continue;
    }

    for (const part of parts) {
      const result = part.functionResponse;
      if (!result) continue;
      const index = unanswered.findIndex((call) => (result.id ? call.id === result.id : call.name === result.name));
      const id = index >= 0 ? unanswered.splice(index, 1)[0]!.id : (result.id ?? `call_${++counter}`);
      messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(result.response ?? {}) });
    }
    if (text) messages.push({ role: "user", content: text });
  }
  return messages;
}

function parseArguments(json: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(json || "{}");
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
