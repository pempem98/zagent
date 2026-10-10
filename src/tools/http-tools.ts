import { readFile } from "node:fs/promises";
import type { Audience, Tool } from "../ai/tools.js";

/** One entry of `tools` in tools.json: an HTTP API call the model may make. */
interface HttpToolDefinition {
  name: string;
  description: string;
  /** Who may trigger it. Defaults to "admin", like MCP tools: an API can act on real systems. */
  audience?: Audience;
  method?: string;
  /** May contain `{parameter}` placeholders in the path or query, and `${ENV_VAR}` for secrets. */
  url: string;
  /** Values may contain `${ENV_VAR}`. */
  headers?: Record<string, string>;
  parameters?: Record<string, { type?: string; description?: string; required?: boolean; enum?: unknown[] }>;
  timeoutSeconds?: number;
}

const MAX_RESPONSE_CHARS = 12_000;
const NAME = /^[a-z][a-z0-9_]{1,40}$/;

/**
 * Tools defined in a JSON file instead of code: each one describes an HTTP API call. This is how
 * an operator connects the bot to an order system, a CRM or any internal API without programming.
 */
export class HttpTools {
  private toolList: Tool[] = [];

  constructor(
    private readonly file: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** A missing file means "no custom tools"; a broken definition is reported and skipped. */
  async load(): Promise<void> {
    const json = await readFile(this.file, "utf8").catch((error: NodeJS.ErrnoException) => {
      // EISDIR: Docker creates a folder when a bind-mounted file does not exist on the host.
      if (error.code === "ENOENT" || error.code === "EISDIR") return null;
      throw error;
    });
    const tools: Tool[] = [];
    if (json !== null) {
      let definitions: HttpToolDefinition[] = [];
      try {
        definitions = (JSON.parse(json) as { tools?: HttpToolDefinition[] }).tools ?? [];
      } catch (error) {
        console.error(`[tools] ${this.file} is not valid JSON, keeping the previous tools: ${(error as Error).message}`);
        return;
      }
      for (const definition of definitions) {
        try {
          tools.push(this.build(definition));
        } catch (error) {
          console.error(`[tools] skipping "${definition?.name}": ${(error as Error).message}`);
        }
      }
      console.log(`[tools] ${tools.length} custom tools from ${this.file}`);
    }
    this.toolList = tools;
  }

  tools(): Tool[] {
    return this.toolList;
  }

  private build(definition: HttpToolDefinition): Tool {
    if (!NAME.test(definition.name ?? "")) throw new Error("name must be lowercase letters, digits and underscores");
    if (!definition.description) throw new Error("description is required");
    const method = (definition.method ?? "GET").toUpperCase();
    const template = this.fillEnv(definition.url ?? "");
    const origin = new URL(template.replace(/\{[^}]+\}/g, "x")).origin;
    const headers = Object.fromEntries(Object.entries(definition.headers ?? {}).map(([key, value]) => [key, this.fillEnv(value)]));
    const parameters = definition.parameters ?? {};

    return {
      name: definition.name,
      description: definition.description,
      audience: definition.audience === "all" ? "all" : "admin",
      parameters: {
        type: "object",
        properties: Object.fromEntries(
          Object.entries(parameters).map(([key, { required: _required, ...schema }]) => [key, { type: "string", ...schema }]),
        ),
        required: Object.entries(parameters).flatMap(([key, schema]) => (schema.required ? [key] : [])),
      },
      run: async (args) => {
        const unknown = Object.keys(args).filter((key) => !(key in parameters));
        if (unknown.length) throw new Error(`Tham số không hợp lệ: ${unknown.join(", ")}`);

        // Arguments named in the URL are substituted there; the rest go to the query or the body.
        const rest = { ...args };
        const filled = template.replace(/\{(\w+)\}/g, (_match, key: string) => {
          if (rest[key] == null) throw new Error(`Thiếu tham số "${key}"`);
          const value = encodeURIComponent(String(rest[key]));
          delete rest[key];
          return value;
        });
        const url = new URL(filled);
        // Arguments are encoded, so this cannot trip; it guards the invariant that only the admin picks the host.
        if (url.origin !== origin) throw new Error("URL của công cụ bị thay đổi máy chủ");

        const hasBody = method !== "GET" && method !== "DELETE";
        if (!hasBody) for (const [key, value] of Object.entries(rest)) if (value != null) url.searchParams.set(key, String(value));

        const response = await fetch(url, {
          method,
          signal: AbortSignal.timeout((definition.timeoutSeconds ?? 20) * 1000),
          headers: { Accept: "application/json, text/plain;q=0.9", ...(hasBody ? { "Content-Type": "application/json" } : {}), ...headers },
          body: hasBody ? JSON.stringify(rest) : undefined,
        });
        const text = (await response.text()).slice(0, MAX_RESPONSE_CHARS);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
        return text || "(không có nội dung)";
      },
    };
  }

  /** `${NAME}` -> environment variable, so secrets stay in .env and out of tools.json. */
  private fillEnv(text: string): string {
    return text.replace(/\$\{(\w+)\}/g, (_match, name: string) => {
      const value = this.env[name];
      if (value === undefined) throw new Error(`environment variable ${name} is not set`);
      return value;
    });
  }
}
