// Starts and stops the local MCP server as the user switches it on and off in Settings › AI agents.
import type { McpServer } from '../../core/mcp/protocol';
import { startMcpHttpServer, type McpHttpServer } from './httpServer';
import type { McpSettings, McpStatus } from '../../shared/types';

export const DEFAULT_MCP_PORT = 47474;

export function normalizeMcpSettings(raw: unknown): McpSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<McpSettings>;
  const port = Number(r.port);
  return { enabled: r.enabled === true, port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_MCP_PORT };
}

export class McpController {
  private http: McpHttpServer | null = null;
  private error: string | null = null;
  private settings: McpSettings = { enabled: false, port: DEFAULT_MCP_PORT };

  constructor(private server: McpServer) {}

  /** Applies settings: starts, restarts on another port, or stops the server. */
  async apply(settings: McpSettings): Promise<McpStatus> {
    this.settings = settings;
    if (this.http && (!settings.enabled || this.http.port !== settings.port)) {
      await this.http.close();
      this.http = null;
    }
    this.error = null;
    if (settings.enabled && !this.http) {
      try {
        this.http = await startMcpHttpServer(this.server, settings.port);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        this.error = err.code === 'EADDRINUSE' ? `Port ${settings.port} is already in use. Pick another port.` : err.message;
      }
    }
    return this.status();
  }

  status(): McpStatus {
    return {
      ...this.settings,
      running: !!this.http,
      url: this.http?.url ?? `http://127.0.0.1:${this.settings.port}/mcp`,
      error: this.error,
      tools: this.server.toolNames(),
    };
  }

  async dispose(): Promise<void> {
    await this.http?.close();
    this.http = null;
  }
}
