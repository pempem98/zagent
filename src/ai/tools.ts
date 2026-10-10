import type { IncomingMessage } from "../channels/types.js";

/** Who may trigger a tool: every chat user, or only configured admins. */
export type Audience = "all" | "admin";

export interface ToolContext {
  message: IncomingMessage;
  isAdmin: boolean;
  /** True when the run was started by a scheduled task, not by a message someone just sent. */
  scheduled: boolean;
}

export interface Tool {
  /** Letters, digits, underscores; unique across built-in and MCP tools. */
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
  audience: Audience;
  run(args: Record<string, unknown>, context: ToolContext): Promise<unknown>;
}

export function toolsFor(tools: Tool[], isAdmin: boolean): Tool[] {
  return tools.filter((tool) => isAdmin || tool.audience === "all");
}
