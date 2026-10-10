import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Audience, Tool } from "../ai/tools.js";

/** One entry of `mcpServers` in mcp.json: a local command (stdio) or a remote URL (streamable HTTP). */
interface ServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Who may use this server's tools. Defaults to "admin": MCP tools can act on real systems. */
  audience?: Audience;
}

/** Connects to the MCP servers in a config file and exposes their tools to the agent. */
export class McpHub {
  private readonly clients: Client[] = [];
  private toolList: Tool[] = [];

  /** Missing config file means "no MCP servers"; a failing server is logged and skipped. */
  async connect(configFile: string): Promise<void> {
    const config = await readFile(configFile, "utf8").then(
      (json) => JSON.parse(json) as { mcpServers?: Record<string, ServerConfig> },
      (error: NodeJS.ErrnoException) => {
        // EISDIR: Docker creates a folder when a bind-mounted file does not exist on the host.
        if (error.code !== "ENOENT" && error.code !== "EISDIR") throw error;
        return null;
      },
    );
    for (const [name, server] of Object.entries(config?.mcpServers ?? {})) {
      try {
        const tools = await this.connectServer(name, server);
        this.toolList.push(...tools);
        console.log(`[mcp] ${name}: ${tools.length} tools (${server.audience ?? "admin"})`);
      } catch (error) {
        console.error(`[mcp] ${name}: failed to connect:`, error);
      }
    }
  }

  tools(): Tool[] {
    return this.toolList;
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.clients.map((client) => client.close()));
  }

  private async connectServer(serverName: string, server: ServerConfig): Promise<Tool[]> {
    const transport = server.url
      ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.headers } })
      : new StdioClientTransport({
          command: required(server.command, `mcpServers.${serverName} needs "command" or "url"`),
          args: server.args,
          env: { ...getDefaultEnvironment(), ...server.env },
          cwd: server.cwd,
          stderr: "inherit",
        });
    const client = new Client({ name: "zalo-agent", version: "1.0.0" });
    await client.connect(transport);
    this.clients.push(client);

    const { tools } = await client.listTools();
    return tools.map((tool) => {
      // JSON Schema meta keys are not accepted in Gemini function declarations.
      const { $schema: _schema, ...parameters } = tool.inputSchema as Record<string, unknown>;
      return {
        name: `${serverName}__${tool.name}`.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 64),
        description: tool.description ?? tool.name,
        parameters,
        audience: server.audience ?? "admin",
        run: async (args) => {
          const result = await client.callTool({ name: tool.name, arguments: args });
          const text = (result.content as { type: string; text?: string }[])
            .map((item) => (item.type === "text" ? item.text : `[${item.type}]`))
            .join("\n");
          if (result.isError) throw new Error(text || "MCP tool failed");
          return text;
        },
      };
    });
  }
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
