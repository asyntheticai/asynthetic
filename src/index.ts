#!/usr/bin/env node
/**
 * Asynthetic — MCP server entry point with dual transport.
 *
 * Transport is chosen by environment:
 * - PORT set (Railway/cloud): Express HTTP server exposing the modern
 *   Streamable HTTP endpoint (POST/GET/DELETE /mcp) plus the legacy
 *   HTTP+SSE endpoints (GET /sse + POST /messages) for older clients.
 * - No PORT: stdio, so local use in Claude Code / Cursor / MCP Inspector
 *   is completely unaffected.
 *
 * In stdio mode stdout is the protocol channel — all logging goes to stderr.
 */
import { randomUUID } from 'node:crypto';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { buildServer, SERVER_NAME, SERVER_VERSION } from './server.js';
import { createStore } from './store/create-store.js';

// Load .env when present (dev convenience, no dotenv dependency).
try {
  process.loadEnvFile();
} catch {
  // no .env file — fine, env vars may come from the MCP client config
}

const store = createStore();

async function startStdio(): Promise<void> {
  await buildServer(store).connect(new StdioServerTransport());
  console.error('[asynthetic] Ready on stdio');
}

async function startHttp(port: number): Promise<void> {
  const app = express();
  app.use(express.json());

  // --- Modern Streamable HTTP transport (one session per client) ---
  const streamableTransports: Record<string, StreamableHTTPServerTransport> = {};

  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const existing = sessionId ? streamableTransports[sessionId] : undefined;
      if (existing) {
        await existing.handleRequest(req, res, req.body);
        return;
      }
      if (sessionId || !isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: no valid session. Send an initialize request first.' },
          id: null,
        });
        return;
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          streamableTransports[sid] = transport;
        },
      });
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) delete streamableTransports[sid];
      };
      await buildServer(store).connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[asynthetic] /mcp error:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // GET /mcp = server->client notification stream; DELETE /mcp = session end.
  const handleSessionRequest = async (req: express.Request, res: express.Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? streamableTransports[sessionId] : undefined;
    if (!transport) {
      res.status(400).send('Invalid or missing Mcp-Session-Id');
      return;
    }
    await transport.handleRequest(req, res);
  };
  app.get('/mcp', handleSessionRequest);
  app.delete('/mcp', handleSessionRequest);

  // --- Legacy HTTP+SSE transport (protocol 2024-11-05) for older clients ---
  const sseTransports: Record<string, SSEServerTransport> = {};

  app.get('/sse', async (_req, res) => {
    try {
      const transport = new SSEServerTransport('/messages', res);
      sseTransports[transport.sessionId] = transport;
      res.on('close', () => {
        delete sseTransports[transport.sessionId];
      });
      await buildServer(store).connect(transport);
    } catch (err) {
      console.error('[asynthetic] /sse error:', err);
      if (!res.headersSent) res.status(500).send('Internal server error');
    }
  });

  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId as string | undefined;
    const transport = sessionId ? sseTransports[sessionId] : undefined;
    if (!transport) {
      res.status(400).send('No transport found for sessionId');
      return;
    }
    try {
      await transport.handlePostMessage(req, res, req.body);
    } catch (err) {
      console.error('[asynthetic] /messages error:', err);
      if (!res.headersSent) res.status(500).send('Internal server error');
    }
  });

  // Health/info endpoint for platform checks and humans.
  app.get('/', (_req, res) => {
    res.json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      store: store.describe(),
      transports: { streamable_http: '/mcp', sse_legacy: '/sse' },
    });
  });

  const httpServer = app.listen(port, () => {
    console.error(`[asynthetic] Ready on HTTP :${port} (Streamable HTTP at /mcp, legacy SSE at /sse)`);
  });

  // Railway sends SIGTERM on redeploy/scale-down — close cleanly.
  const shutdown = () => {
    console.error('[asynthetic] Shutting down');
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function main() {
  console.error(`[asynthetic] Starting (store: ${store.describe()})`);
  const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : Number.NaN;
  if (Number.isFinite(port)) {
    await startHttp(port);
  } else {
    await startStdio();
  }
}

main().catch((err) => {
  console.error('[asynthetic] Fatal:', err);
  process.exit(1);
});
