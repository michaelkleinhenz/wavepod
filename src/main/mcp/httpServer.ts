// Serves an McpServer over MCP's Streamable HTTP transport, on the loopback interface only.
// Requests are answered with plain JSON (no SSE streams): WavePod never sends messages of its own.
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { INVALID_REQUEST, PARSE_ERROR, rpcError, type McpServer } from '../../core/mcp/protocol';

export const MCP_PATH = '/mcp';
const MAX_BODY = 4 * 1024 * 1024;

export interface McpHttpServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/** Hosts a browser may use to reach us; anything else is a DNS-rebinding attempt. */
function allowedHost(host: string | undefined, port: number): boolean {
  if (!host) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
}

/** Web pages must not be able to call the server; only native clients (no Origin) and local pages of our own port. */
function allowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`].includes(origin.toLowerCase());
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Starts listening on 127.0.0.1:`port` (0 = any free port). Rejects if the port is taken. */
export function startMcpHttpServer(server: McpServer, port: number): Promise<McpHttpServer> {
  let actualPort = port;
  const httpServer = http.createServer(async (req, res) => {
    try {
      if (!allowedHost(req.headers.host, actualPort) || !allowedOrigin(req.headers.origin, actualPort)) {
        return sendJson(res, 403, rpcError(null, INVALID_REQUEST, 'Forbidden: WavePod only accepts local clients.'));
      }
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`);
      if (url.pathname !== MCP_PATH) return sendJson(res, 404, { error: `Not found. The MCP endpoint is ${MCP_PATH}.` });
      if (req.method !== 'POST') {
        // No server-to-client stream and no sessions to end.
        res.writeHead(405, { Allow: 'POST' });
        return res.end();
      }
      let message: unknown;
      try {
        message = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, rpcError(null, PARSE_ERROR, 'Parse error'));
      }
      // JSON-RPC batches (protocol 2025-03-26) are answered as a batch.
      if (Array.isArray(message)) {
        const responses = (await Promise.all(message.map((m) => server.handle(m)))).filter((r) => r !== null);
        if (!responses.length) {
          res.writeHead(202);
          return res.end();
        }
        return sendJson(res, 200, responses);
      }
      const response = await server.handle(message);
      if (!response) {
        res.writeHead(202);
        return res.end();
      }
      sendJson(res, 200, response);
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, rpcError(null, INVALID_REQUEST, (e as Error).message));
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.off('error', reject);
      actualPort = (httpServer.address() as AddressInfo).port;
      resolve({
        port: actualPort,
        url: `http://127.0.0.1:${actualPort}${MCP_PATH}`,
        close: () =>
          new Promise<void>((done) => {
            httpServer.close(() => done());
            httpServer.closeAllConnections();
          }),
      });
    });
  });
}
