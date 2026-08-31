import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod/v4';
import type { AppConfig } from './config.js';
import { BPMN_SKILL_CREATOR_PROMPT, BPMN_SKILL_MARKDOWN, buildCodexConfig } from './connection.js';
import { AppError } from './errors.js';
import { logError, logEvent } from './logger.js';
import type { DiagramStorage } from './storage.js';

const metadataFields = {
  name: z.string().min(1).max(120),
  group: z.string().max(80).optional(),
  description: z.string().max(500).optional()
};

const createSchema = z.object({
  id: z.string().min(1),
  ...metadataFields,
  xml: z.string().optional()
});

const updateSchema = z.object({
  expectedRevision: z.string().min(1),
  name: metadataFields.name.optional(),
  group: metadataFields.group,
  description: metadataFields.description,
  xml: z.string().optional()
}).refine(value => value.xml !== undefined || value.name !== undefined || value.group !== undefined || value.description !== undefined, {
  message: 'At least one of xml, name, group, or description is required'
});

const duplicateSchema = createSchema.omit({ xml: true }).extend({ expectedRevision: z.string().min(1) });
const deleteSchema = z.object({ expectedRevision: z.string().min(1), confirmId: z.string().min(1) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(400, 'INVALID_REQUEST', 'Request body is invalid', result.error.flatten());
  }
  return result.data;
}

function mutation(action: string, handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    try {
      await handler(req, res);
      logEvent('diagram_mutation', {
        action,
        diagramId: req.params.id || req.body?.id,
        result: 'success',
        status: res.statusCode,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      logError('diagram_mutation_failed', error, {
        action,
        diagramId: req.params.id || req.body?.id,
        result: 'error',
        durationMs: Date.now() - startedAt
      });
      next(error);
    }
  };
}

export function createApiRouter(storage: DiagramStorage, config: AppConfig): Router {
  const router = Router();

  router.get('/config', (_req, res) => {
    const mcpUrl = `${config.publicBaseUrl}/mcp`;
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
      name: 'BPMN MCP Editor',
      version: '1.0.0',
      mcpUrl,
      maxBpmnBytes: config.maxBpmnBytes,
      codexConfig: buildCodexConfig(mcpUrl, config.mcpApiKey),
      skillCreatorPrompt: BPMN_SKILL_CREATOR_PROMPT,
      skillMarkdown: BPMN_SKILL_MARKDOWN
    });
  });

  router.get('/diagrams', async (req, res) => {
    const query = typeof req.query.query === 'string' ? req.query.query : '';
    const group = typeof req.query.group === 'string' ? req.query.group : '';
    res.json({ diagrams: await storage.list(query, group) });
  });

  router.get('/diagrams/:id', async (req, res) => {
    res.json({ diagram: await storage.get(String(req.params.id)) });
  });

  router.post('/diagrams', mutation('create', async (req, res) => {
    const result = await storage.create(parse(createSchema, req.body));
    res.status(201).json(result);
  }));

  router.put('/diagrams/:id', mutation('update', async (req, res) => {
    const result = await storage.update(String(req.params.id), parse(updateSchema, req.body));
    res.json(result);
  }));

  router.post('/diagrams/:id/duplicate', mutation('duplicate', async (req, res) => {
    const result = await storage.duplicate(String(req.params.id), parse(duplicateSchema, req.body));
    res.status(201).json(result);
  }));

  router.delete('/diagrams/:id', mutation('delete', async (req, res) => {
    const input = parse(deleteSchema, req.body);
    await storage.delete(String(req.params.id), input.expectedRevision, input.confirmId);
    res.status(204).end();
  }));

  return router;
}
