import type { Content, GenerateContentResponse, Part } from "@google/genai";
import type { IncomingMessage } from "../channels/types.js";
import type { GenerateRequest } from "./models.js";
import { toolsFor, type Tool, type ToolContext } from "./tools.js";

/** Where conversation history lives; see ConversationStore. */
export interface History {
  contents(key: string): Content[];
  append(key: string, userText: string, modelText: string): void;
}

export interface AgentOptions {
  /** Model call, including model choice, retries and fallback; see ModelPool. */
  generate: (request: GenerateRequest) => Promise<GenerateContentResponse>;
  /** Called per message so tools added later (MCP reconnect, reload) are picked up. */
  tools: () => Tool[];
  /** Builds the system prompt for one message. */
  systemPrompt: (context: ToolContext) => string;
  history: History;
  maxSteps?: number;
  /** Result fields hidden from non-admins; see Config.adminOnlyFields. */
  adminOnlyFields?: string[];
}

const MAX_TOOL_RESULT_CHARS = 20_000;
/** How much of what the tools looked up is kept in history, so follow-ups ("căn đó thì sao?") keep their context. */
const MAX_TRACE_CHARS = 1_500;
/** A trace note copied into an answer by the model; never sent to the user. */
const TRACE_BLOCK = /\[Ghi chú nội bộ[\s\S]*?\]\s*$/;
const FALLBACK = "Xin lỗi, mình chưa xử lý được yêu cầu này. Bạn thử diễn đạt lại giúp mình nhé.";

/** Gemini tool-calling loop: the model plans, calls tools, reads results and repeats until it can answer. */
export class Agent {
  private readonly maxSteps: number;

  constructor(private readonly options: AgentOptions) {
    this.maxSteps = options.maxSteps ?? 10;
  }

  async reply(message: IncomingMessage, flags: { isAdmin: boolean; scheduled?: boolean }): Promise<string> {
    const context: ToolContext = { message, isAdmin: flags.isAdmin, scheduled: flags.scheduled ?? false };
    const tools = toolsFor(this.options.tools(), flags.isAdmin);
    const key = conversationKey(message);
    const body = message.text.trim();
    const userText = message.isGroup ? `${message.senderName || message.senderId}: ${body}` : body;

    const contents: Content[] = [...this.options.history.contents(key), { role: "user", parts: [{ text: userText }] }];
    const config = {
      // Built once: the prompt must not change between the steps of one answer.
      systemInstruction: this.options.systemPrompt(context),
      tools: tools.length
        ? [
            {
              functionDeclarations: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parametersJsonSchema: tool.parameters,
              })),
            },
          ]
        : undefined,
    };
    let answer = "";
    const trace: string[] = [];

    for (let step = 0; step < this.maxSteps; step++) {
      const response = await this.options.generate({ contents, config });
      const content = response.candidates?.[0]?.content;
      const parts = content?.parts ?? [];
      const calls = parts.filter((part) => part.functionCall);
      if (calls.length === 0) {
        answer = parts
          .filter((part) => part.text && !part.thought)
          .map((part) => part.text)
          .join("")
          .replace(TRACE_BLOCK, "")
          .trim();
        break;
      }

      // Keep the model turn verbatim: it carries the thought signatures Gemini expects back.
      contents.push(content!);
      const results = await Promise.all(calls.map((part) => this.runTool(part, tools, context)));
      contents.push({ role: "user", parts: results });
      trace.push(...results.map(describeCall));
    }

    answer ||= FALLBACK;
    // The user sees only the answer; history also keeps a short note of what was looked up.
    this.options.history.append(key, userText, withTrace(answer, trace));
    return answer;
  }

  private async runTool(part: Part, tools: Tool[], context: ToolContext): Promise<Part> {
    const { name = "", args = {}, id } = part.functionCall!;
    const tool = tools.find((candidate) => candidate.name === name);
    let response: Record<string, unknown>;
    try {
      if (!tool) throw new Error(`Unknown or not permitted tool: ${name}`);
      console.log(`[agent] ${name}(${JSON.stringify(args).slice(0, 200)})`);
      let output = await tool.run(args, context);
      if (!context.isAdmin && this.options.adminOnlyFields?.length) output = redact(output, this.options.adminOnlyFields);
      response = { output: truncate(output) };
    } catch (error) {
      console.error(`[agent] tool ${name} failed:`, error);
      response = { error: error instanceof Error ? error.message : String(error) };
    }
    return { functionResponse: { id, name, response } };
  }

}

/** Removes admin-only fields from a tool result, whether it is an object or JSON text (as MCP tools return). */
export function redact(value: unknown, fields: string[]): unknown {
  const hidden = new Set(fields.map((field) => field.toLocaleLowerCase("vi")));
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (node && typeof node === "object") {
      return Object.fromEntries(
        Object.entries(node)
          .filter(([name]) => !hidden.has(name.toLocaleLowerCase("vi")))
          .map(([name, child]) => [name, strip(child)]),
      );
    }
    return node;
  };
  if (typeof value === "string") {
    try {
      return JSON.stringify(strip(JSON.parse(value)));
    } catch {
      return value;
    }
  }
  return strip(value);
}

function describeCall(part: Part): string {
  const { name, response } = part.functionResponse!;
  const output = response?.error ? `lỗi: ${response.error}` : JSON.stringify(response?.output ?? "");
  return `${name}: ${output.length > 400 ? `${output.slice(0, 400)}…` : output}`;
}

function withTrace(answer: string, trace: string[]): string {
  if (trace.length === 0) return answer;
  const note = trace.join("\n").slice(0, MAX_TRACE_CHARS);
  return `${answer}\n\n[Ghi chú nội bộ — dữ liệu đã tra ở lượt này, không gửi cho người dùng:\n${note}]`;
}

export function conversationKey(target: { channel: string; threadId: string }): string {
  return `${target.channel}:${target.threadId}`;
}

function truncate(value: unknown): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined || text.length <= MAX_TOOL_RESULT_CHARS) return value;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[...truncated]`;
}
