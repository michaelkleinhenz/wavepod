// A small Model Context Protocol server: JSON-RPC 2.0 with the lifecycle and tools methods.
// Transport-agnostic; src/main/mcp/httpServer.ts serves it over Streamable HTTP on localhost.
// Only tools are offered (no resources, prompts or server-initiated messages), which is
// all an agent needs to drive WavePod.

/** Protocol revisions this server understands, newest first. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export type JsonSchema = Record<string, unknown>;

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
  /** Returns any JSON-serialisable value (sent as text) or throws a ToolError / Error. */
  run(args: Record<string, unknown>): unknown | Promise<unknown>;
}

/** An error meant for the agent, reported as a tool result with isError so it can correct itself. */
export class ToolError extends Error {}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

export interface ServerInfo {
  name: string;
  title?: string;
  version: string;
  instructions?: string;
}

export class McpServer {
  private tools = new Map<string, McpTool>();

  constructor(private info: ServerInfo) {}

  addTool(tool: McpTool): void {
    this.tools.set(tool.name, tool);
  }

  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /** Handles one message. Returns the response, or null for notifications and responses. */
  async handle(message: unknown): Promise<JsonRpcResponse | null> {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return rpcError(null, INVALID_REQUEST, 'Invalid request');
    const msg = message as Partial<JsonRpcRequest> & { result?: unknown; error?: unknown };
    const hasId = 'id' in msg && msg.id !== undefined;
    // Responses to requests we never send, and notifications (initialized, cancelled, …): nothing to answer.
    if (typeof msg.method !== 'string') return hasId ? rpcError(msg.id ?? null, INVALID_REQUEST, 'Invalid request') : null;
    if (!hasId) return null;
    const id = msg.id as string | number | null;
    const params = (msg.params && typeof msg.params === 'object' ? msg.params : {}) as Record<string, unknown>;
    switch (msg.method) {
      case 'initialize': {
        const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: this.info.name, title: this.info.title, version: this.info.version },
            ...(this.info.instructions ? { instructions: this.info.instructions } : {}),
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })),
          },
        };
      case 'tools/call': {
        const tool = typeof params.name === 'string' ? this.tools.get(params.name) : undefined;
        if (!tool) return rpcError(id, INVALID_PARAMS, `Unknown tool: ${String(params.name)}`);
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
        try {
          const value = await tool.run(args);
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: toText(value) }], isError: false } };
        } catch (e) {
          const text = e instanceof Error ? e.message : String(e);
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
        }
      }
      // Empty lists so clients that probe these don't log errors.
      case 'resources/list':
        return { jsonrpc: '2.0', id, result: { resources: [] } };
      case 'prompts/list':
        return { jsonrpc: '2.0', id, result: { prompts: [] } };
      default:
        return rpcError(id, METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
    }
  }
}

function toText(value: unknown): string {
  if (value === undefined) return 'OK';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v), 2);
}

export function rpcError(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
