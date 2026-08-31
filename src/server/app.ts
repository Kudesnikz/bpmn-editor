import compression from 'compression';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { AppConfig } from './config.js';
import { createApiRouter } from './api.js';
import { basicAuth, bearerAuth, validateMcpOrigin } from './auth.js';
import { isAppError } from './errors.js';
import { logError } from './logger.js';
import { createBpmnMcpHandler } from './mcp.js';
import type { DiagramStorage } from './storage.js';

export interface ApplicationOptions {
  config: AppConfig;
  storage: DiagramStorage;
  serveFrontend?: boolean;
}

export async function createApplication({ config, storage, serveFrontend = true }: ApplicationOptions) {
  const app = express();
  app.disable('x-powered-by');
  if (config.nodeEnv === 'production') app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: config.nodeEnv === 'production' ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"]
      }
    } : false,
    crossOriginEmbedderPolicy: false
  }));
  app.use(compression());

  app.get('/healthz', (_req, res) => res.json({ status: 'ok', version: '1.0.0' }));

  const mcpHandler = createBpmnMcpHandler(storage, config);
  const nodeMcpHandler = toNodeHandler(mcpHandler, { onerror: error => logError('mcp_adapter_error', error) });
  const mcpLimiter = rateLimit({
    windowMs: 60_000,
    limit: config.mcpRateLimitPerMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many MCP requests' } }
  });

  app.all(
    '/mcp',
    mcpLimiter,
    bearerAuth(config.mcpApiKey),
    validateMcpOrigin(config.publicOrigin),
    express.json({ limit: config.maxBpmnBytes + 64 * 1024 }),
    (req, res, next) => {
      void nodeMcpHandler(req, res, req.body).catch(next);
    }
  );

  const webAuth = basicAuth(config.webUsername, config.webPassword);
  app.use(
    '/api',
    webAuth,
    express.json({ limit: config.maxBpmnBytes + 64 * 1024 }),
    createApiRouter(storage, config),
    (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: `No API route for ${req.method} ${req.path}` } })
  );

  if (serveFrontend) {
    app.use(webAuth);
    if (config.nodeEnv === 'production') {
      const clientDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../client');
      app.use(express.static(clientDir, { index: false }));
      app.get('/{*splat}', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
    } else {
      const { createServer: createViteServer } = await import('vite');
      const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
      app.use(vite.middlewares);
    }
  }

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((error as { type?: string })?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' } });
      return;
    }
    if ((error as { type?: string })?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
      return;
    }
    if (isAppError(error)) {
      res.status(error.status).json({
        error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) }
      });
      return;
    }
    logError('unhandled_request_error', error);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });

  return { app, mcpHandler };
}
