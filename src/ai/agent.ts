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
}

const MAX_TOOL_RESULT_CHARS = 20_000;
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
          .trim();
        break;
      }

      // Keep the model turn verbatim: it carries the thought signatures Gemini expects back.
      contents.push(content!);
      const results = await Promise.all(calls.map((part) => this.runTool(part, tools, context)));
      contents.push({ role: "user", parts: results });
    }

    answer ||= FALLBACK;
    this.options.history.append(key, userText, answer);
    return answer;
  }

  private async runTool(part: Part, tools: Tool[], context: ToolContext): Promise<Part> {
    const { name = "", args = {}, id } = part.functionCall!;
    const tool = tools.find((candidate) => candidate.name === name);
    let response: Record<string, unknown>;
    try {
      if (!tool) throw new Error(`Unknown or not permitted tool: ${name}`);
      console.log(`[agent] ${name}(${JSON.stringify(args).slice(0, 200)})`);
      response = { output: truncate(await tool.run(args, context)) };
    } catch (error) {
      console.error(`[agent] tool ${name} failed:`, error);
      response = { error: error instanceof Error ? error.message : String(error) };
    }
    return { functionResponse: { id, name, response } };
  }

}

export function conversationKey(target: { channel: string; threadId: string }): string {
  return `${target.channel}:${target.threadId}`;
}

function truncate(value: unknown): unknown {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined || text.length <= MAX_TOOL_RESULT_CHARS) return value;
  return `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[...truncated]`;
}
