import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod/v4';
import type { AppConfig } from './config.js';
import { BPMN_SKILL_CREATOR_PROMPT, BPMN_SKILL_MARKDOWN, buildCodexConfig } from './connection.js';
import { AppError } from './errors.js';
import { logError, logEvent } from './logger.js';
import type { DiagramStorage } from './storage.js';

const metadataFields = {
  name: z.string().min(1).max(120),
  folderId: z.string().nullable().optional(),
  description: z.string().max(500).optional()
};

const createSchema = z.object({ id: z.string().min(1), ...metadataFields, xml: z.string().optional() }).strict();
const updateSchema = z.object({
  expectedRevision: z.string().min(1),
  name: metadataFields.name.optional(),
  folderId: metadataFields.folderId,
  description: metadataFields.description,
  xml: z.string().optional()
}).strict().refine(value => value.xml !== undefined || value.name !== undefined || value.folderId !== undefined || value.description !== undefined, {
  message: 'At least one of xml, name, folderId, or description is required'
});
const duplicateSchema = createSchema.omit({ xml: true }).extend({ expectedRevision: z.string().min(1) }).strict();
const deleteSchema = z.object({ expectedRevision: z.string().min(1), confirmId: z.string().min(1) }).strict();
const createFolderSchema = z.object({
  name: z.string().min(1).max(80),
  parentId: z.string().nullable().optional(),
  expectedCatalogRevision: z.string().min(1)
}).strict();
const updateFolderSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  parentId: z.string().nullable().optional(),
  expectedCatalogRevision: z.string().min(1)
}).strict().refine(value => value.name !== undefined || value.parentId !== undefined, {
  message: 'At least one of name or parentId is required'
});
const deleteFolderSchema = z.object({ expectedCatalogRevision: z.string().min(1), confirmName: z.string().min(1) }).strict();

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(400, 'INVALID_REQUEST', 'Request body is invalid', result.error.flatten());
  return result.data;
}

function mutation(action: string, handler: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const startedAt = Date.now();
    try {
      await handler(req, res);
      logEvent('catalog_mutation', {
        action,
        entityId: req.params.id || req.body?.id,
        result: 'success',
        status: res.statusCode,
        durationMs: Date.now() - startedAt
      });
    } catch (error) {
      logError('catalog_mutation_failed', error, {
        action,
        entityId: req.params.id || req.body?.id,
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

  router.get('/catalog', async (_req, res) => {
    res.json(await storage.getCatalog());
  });

  router.get('/diagrams', async (req, res) => {
    const query = typeof req.query.query === 'string' ? req.query.query : '';
    const folderId = typeof req.query.folderId === 'string' ? req.query.folderId : '';
    const includeDescendants = req.query.includeDescendants !== 'false';
    res.json({ diagrams: await storage.list(query, folderId, includeDescendants) });
  });

  router.get('/diagrams/:id', async (req, res) => {
    res.json({ diagram: await storage.get(String(req.params.id)) });
  });

  router.post('/diagrams', mutation('create_diagram', async (req, res) => {
    res.status(201).json(await storage.create(parse(createSchema, req.body)));
  }));

  router.put('/diagrams/:id', mutation('update_diagram', async (req, res) => {
    res.json(await storage.update(String(req.params.id), parse(updateSchema, req.body)));
  }));

  router.post('/diagrams/:id/duplicate', mutation('duplicate_diagram', async (req, res) => {
    res.status(201).json(await storage.duplicate(String(req.params.id), parse(duplicateSchema, req.body)));
  }));

  router.delete('/diagrams/:id', mutation('delete_diagram', async (req, res) => {
    const input = parse(deleteSchema, req.body);
    await storage.delete(String(req.params.id), input.expectedRevision, input.confirmId);
    res.status(204).end();
  }));

  router.post('/folders', mutation('create_folder', async (req, res) => {
    res.status(201).json(await storage.createFolder(parse(createFolderSchema, req.body)));
  }));

  router.put('/folders/:id', mutation('update_folder', async (req, res) => {
    res.json(await storage.updateFolder(String(req.params.id), parse(updateFolderSchema, req.body)));
  }));

  router.delete('/folders/:id', mutation('delete_folder', async (req, res) => {
    const input = parse(deleteFolderSchema, req.body);
    await storage.deleteFolder(String(req.params.id), input.expectedCatalogRevision, input.confirmName);
    res.status(204).end();
  }));

  return router;
}
