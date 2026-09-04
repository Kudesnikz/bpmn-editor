import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/server/app.js';
import { loadConfig, type AppConfig } from '../src/server/config.js';
import { DiagramStorage, createBlankBpmn } from '../src/server/storage.js';

const basic = { user: 'admin', password: 'test-password' };
const mcpKey = 'test-mcp-key';
const invalidWithoutDi = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL" id="Definitions_invalid" targetNamespace="http://example.test/bpmn">
  <bpmn:process id="Process_invalid" isExecutable="false">
    <bpmn:startEvent id="StartEvent_invalid" />
  </bpmn:process>
</bpmn:definitions>`;

describe('BPMN application', () => {
  let temporaryDir: string;
  let dataDir: string;
  let storage: DiagramStorage;
  let config: AppConfig;
  let app: Awaited<ReturnType<typeof createApplication>>['app'];
  let mcpHandler: Awaited<ReturnType<typeof createApplication>>['mcpHandler'];
  let httpServer: HttpServer | undefined;

  beforeEach(async () => {
    temporaryDir = await mkdtemp(path.join(tmpdir(), 'bpmn-mcp-test-'));
    dataDir = path.join(temporaryDir, 'diagrams');
    config = {
      port: 0,
      dataDir,
      seedDir: path.resolve('diagrams'),
      publicBaseUrl: 'http://127.0.0.1',
      publicOrigin: 'http://127.0.0.1',
      webUsername: basic.user,
      webPassword: basic.password,
      mcpApiKey: mcpKey,
      mcpRateLimitPerMinute: 1000,
      maxBpmnBytes: 64 * 1024,
      nodeEnv: 'test'
    };
    storage = new DiagramStorage(dataDir, config.seedDir, config.publicBaseUrl, config.maxBpmnBytes);
    await storage.initialize();
    ({ app, mcpHandler } = await createApplication({ config, storage, serveFrontend: false }));
  });

  afterEach(async () => {
    if (httpServer) await new Promise<void>(resolve => httpServer!.close(() => resolve()));
    await mcpHandler.close();
    await rm(temporaryDir, { recursive: true, force: true });
    httpServer = undefined;
  });

  it('refuses to start without required secrets and protects each boundary', async () => {
    expect(() => loadConfig({ PUBLIC_BASE_URL: 'https://bpmn.example.test', WEB_USERNAME: 'admin' })).toThrow(/WEB_PASSWORD, MCP_API_KEY/);
    await request(app).get('/api/catalog').expect(401).expect('WWW-Authenticate', /Basic/);
    await request(app).get('/api/config').expect(401).expect('WWW-Authenticate', /Basic/);
    await request(app).get('/api/catalog').auth(basic.user, basic.password).expect(200);
    await request(app).get('/api/config').auth(basic.user, basic.password).expect(200)
      .expect('Cache-Control', /private, no-store/)
      .expect(({ body }) => {
        expect(body.codexConfig).toContain(`http_headers = { Authorization = "Bearer ${mcpKey}" }`);
        expect(body).not.toHaveProperty('mcpApiKey');
        expect(body.skillCreatorPrompt).toContain('list_folders');
        expect(body.skillMarkdown).toContain('create_folder');
        expect(JSON.stringify(body)).not.toContain('list_groups');
      });
    await request(app).get('/healthz').expect(200).expect(({ body }) => expect(JSON.stringify(body)).not.toContain(mcpKey));

    const initialize = {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }
    };
    await request(app).post('/mcp').send(initialize).expect(401).expect('WWW-Authenticate', /Bearer/);
    await request(app).post('/mcp').set('Authorization', 'Bearer wrong-key').send(initialize).expect(401);
    await request(app).post('/mcp').set('Authorization', `Bearer ${mcpKey}`).set('Origin', 'https://attacker.example').send(initialize).expect(403);
  });

  it('seeds catalog v2 once with a Sales folder and keeps existing data', async () => {
    const catalog = await storage.getCatalog();
    expect(catalog.diagrams.map(diagram => diagram.id).sort()).toEqual(['return', 'shop']);
    expect(catalog.folders).toHaveLength(1);
    expect(catalog.folders[0]).toMatchObject({ name: 'Продажи', parentId: null, directDiagramCount: 2 });
    expect(catalog.catalogRevision).toMatch(/^[a-f0-9]{64}$/);

    await storage.create({ id: 'custom-flow', name: 'Custom flow' });
    const secondStorage = new DiagramStorage(dataDir, config.seedDir, config.publicBaseUrl, config.maxBpmnBytes);
    await secondStorage.initialize();
    expect((await secondStorage.list()).map(diagram => diagram.id).sort()).toEqual(['custom-flow', 'return', 'shop']);

    const raw = JSON.parse(await readFile(path.join(dataDir, 'index.json'), 'utf8'));
    expect(raw).toMatchObject({ schemaVersion: 2 });
    expect(raw.folders).toHaveLength(1);
    expect(raw.diagrams[0]).toHaveProperty('folderId');
    expect(JSON.stringify(raw)).not.toContain('"group"');
  });

  it('atomically migrates legacy groups, merging names that differ only by case', async () => {
    const legacyDir = path.join(temporaryDir, 'legacy');
    await mkdir(legacyDir, { recursive: true });
    await copyFile(path.resolve('diagrams/shop.bpmn'), path.join(legacyDir, 'shop.bpmn'));
    await copyFile(path.resolve('diagrams/return.bpmn'), path.join(legacyDir, 'return.bpmn'));
    await writeFile(path.join(legacyDir, 'index.json'), JSON.stringify({ diagrams: [
      { id: 'shop', name: 'Shop', group: 'Продажи', path: 'ignored.bpmn' },
      { id: 'return', name: 'Return', group: 'продажи', path: '../ignored.bpmn' }
    ] }));
    const legacyStorage = new DiagramStorage(legacyDir, config.seedDir, config.publicBaseUrl, config.maxBpmnBytes);
    await legacyStorage.initialize();
    const migrated = await legacyStorage.getCatalog();
    expect(migrated.folders).toHaveLength(1);
    expect(new Set(migrated.diagrams.map(diagram => diagram.folderId))).toEqual(new Set([migrated.folders[0]!.id]));
    expect(migrated.diagrams.map(diagram => diagram.path).sort()).toEqual(['return.bpmn', 'shop.bpmn']);
    const firstWrite = await readFile(path.join(legacyDir, 'index.json'), 'utf8');
    await legacyStorage.initialize();
    expect(await readFile(path.join(legacyDir, 'index.json'), 'utf8')).toBe(firstWrite);
  });

  it('creates deep folder trees, enforces sibling uniqueness, cycles, and catalog revisions', async () => {
    const initial = await storage.listFolders();
    const sales = initial.folders[0]!;
    const child = await storage.createFolder({
      name: 'Возвраты', parentId: sales.id, expectedCatalogRevision: initial.catalogRevision
    });
    await expect(storage.createFolder({
      name: 'возвраты', parentId: sales.id, expectedCatalogRevision: child.catalog.catalogRevision
    })).rejects.toMatchObject({ code: 'FOLDER_ALREADY_EXISTS' });
    await expect(storage.createFolder({
      name: 'Stale', parentId: null, expectedCatalogRevision: initial.catalogRevision
    })).rejects.toMatchObject({ code: 'CATALOG_REVISION_CONFLICT' });
    await expect(storage.updateFolder(sales.id, {
      parentId: child.folder.id, expectedCatalogRevision: child.catalog.catalogRevision
    })).rejects.toMatchObject({ code: 'FOLDER_CYCLE' });

    let parentId: string | null = child.folder.id;
    let revision = child.catalog.catalogRevision;
    for (let level = 1; level <= 9; level += 1) {
      const result = await storage.createFolder({ name: `Уровень ${level}`, parentId, expectedCatalogRevision: revision });
      parentId = result.folder.id;
      revision = result.catalog.catalogRevision;
    }
    const deep = (await storage.listFolders()).folders.find(folder => folder.id === parentId)!;
    expect(deep.path).toHaveLength(11);

    const anotherRoot = await storage.createFolder({ name: 'Другая ветка', parentId: null, expectedCatalogRevision: revision });
    await expect(storage.createFolder({
      name: 'Возвраты', parentId: anotherRoot.folder.id, expectedCatalogRevision: anotherRoot.catalog.catalogRevision
    })).resolves.toMatchObject({ folder: { name: 'Возвраты', parentId: anotherRoot.folder.id } });
  });

  it('manages folder placement and empty-folder deletion through REST', async () => {
    const api = request(app);
    const initial = await api.get('/api/catalog').auth(basic.user, basic.password).expect(200);
    const createdFolder = await api.post('/api/folders').auth(basic.user, basic.password).send({
      name: 'HR', parentId: null, expectedCatalogRevision: initial.body.catalogRevision
    }).expect(201);
    const hrId = createdFolder.body.folder.id as string;

    await api.post('/api/diagrams').auth(basic.user, basic.password).send({
      id: 'legacy-input', name: 'Legacy', group: 'HR'
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe('INVALID_REQUEST'));

    const created = await api.post('/api/diagrams').auth(basic.user, basic.password).send({
      id: 'vacation-request', name: 'Согласование отпуска', folderId: hrId
    }).expect(201);
    expect(created.body.diagram.folderPath.map((item: { name: string }) => item.name)).toEqual(['HR']);
    await api.delete(`/api/folders/${hrId}`).auth(basic.user, basic.password).send({
      expectedCatalogRevision: (await storage.listFolders()).catalogRevision, confirmName: 'HR'
    }).expect(409).expect(({ body }) => expect(body.error.code).toBe('FOLDER_NOT_EMPTY'));

    const moved = await api.put('/api/diagrams/vacation-request').auth(basic.user, basic.password).send({
      expectedRevision: created.body.diagram.revision, folderId: null
    }).expect(200);
    expect(moved.body.diagram.folderId).toBeNull();
    await api.delete(`/api/folders/${hrId}`).auth(basic.user, basic.password).send({
      expectedCatalogRevision: (await storage.listFolders()).catalogRevision, confirmName: 'HR'
    }).expect(204);

    await api.delete('/api/diagrams/vacation-request').auth(basic.user, basic.password).send({
      expectedRevision: moved.body.diagram.revision, confirmId: 'vacation-request'
    }).expect(204);
    await expect(readFile(path.join(dataDir, 'vacation-request.bpmn'), 'utf8')).rejects.toThrow();
  });

  it('filters diagrams by a folder branch and keeps revision protection', async () => {
    const initial = await storage.listFolders();
    const sales = initial.folders[0]!;
    const child = await storage.createFolder({ name: 'Child', parentId: sales.id, expectedCatalogRevision: initial.catalogRevision });
    await storage.create({ id: 'child-flow', name: 'Child flow', folderId: child.folder.id });
    expect((await storage.list('', sales.id, false)).map(item => item.id).sort()).toEqual(['return', 'shop']);
    expect((await storage.list('', sales.id, true)).map(item => item.id).sort()).toEqual(['child-flow', 'return', 'shop']);

    const shop = await storage.get('shop');
    await storage.update('shop', { expectedRevision: shop.revision, description: 'Updated' });
    await expect(storage.update('shop', { expectedRevision: shop.revision, name: 'Stale' }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  it('rejects invalid IDs, missing DI, and oversized payloads without changing files', async () => {
    const before = await readFile(path.join(dataDir, 'shop.bpmn'), 'utf8');
    await request(app).post('/api/diagrams').auth(basic.user, basic.password).send({
      id: '../escape', name: 'Escape', xml: createBlankBpmn('escape', 'Escape')
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe('INVALID_ID'));
    await request(app).put('/api/diagrams/shop').auth(basic.user, basic.password).send({
      expectedRevision: (await storage.get('shop')).revision, xml: invalidWithoutDi
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe('INVALID_BPMN'));
    expect(await readFile(path.join(dataDir, 'shop.bpmn'), 'utf8')).toBe(before);
    await request(app).post('/api/diagrams').auth(basic.user, basic.password).send({
      id: 'too-large-xml', name: 'Too large XML', xml: 'x'.repeat(config.maxBpmnBytes + 1)
    }).expect(413).expect(({ body }) => expect(body.error.code).toBe('PAYLOAD_TOO_LARGE'));
  });

  it('publishes nested folder operations through MCP without any delete or legacy group tool', async () => {
    httpServer = createServer(app);
    await new Promise<void>(resolve => httpServer!.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address() as AddressInfo;
    const client = new Client({ name: 'bpmn-test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      authProvider: { token: async () => mcpKey }
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map(tool => tool.name).sort()).toEqual([
        'create_diagram', 'create_folder', 'duplicate_diagram', 'get_diagram', 'inspect_diagram',
        'list_diagrams', 'list_folders', 'update_diagram', 'update_folder', 'validate_bpmn'
      ]);
      expect(tools.tools.some(tool => tool.name.includes('delete'))).toBe(false);
      expect(tools.tools.some(tool => tool.name === 'list_groups')).toBe(false);

      const listedFolders = await client.callTool({ name: 'list_folders', arguments: {} });
      const folderState = listedFolders.structuredContent as { catalogRevision: string; folders: Array<{ id: string }> };
      const createdFolder = await client.callTool({
        name: 'create_folder',
        arguments: { name: 'MCP', parent_id: folderState.folders[0]!.id, expected_catalog_revision: folderState.catalogRevision }
      });
      expect(createdFolder.isError).not.toBe(true);
      const folderResult = createdFolder.structuredContent as { folder: { id: string }; catalog: { catalogRevision: string } };

      const staleFolder = await client.callTool({
        name: 'create_folder',
        arguments: { name: 'Stale', expected_catalog_revision: folderState.catalogRevision }
      });
      expect(staleFolder.isError).toBe(true);
      expect((staleFolder.structuredContent as { error: { code: string } }).error.code).toBe('CATALOG_REVISION_CONFLICT');

      const renamed = await client.callTool({
        name: 'update_folder',
        arguments: {
          id: folderResult.folder.id,
          name: 'MCP renamed',
          expected_catalog_revision: folderResult.catalog.catalogRevision
        }
      });
      expect(renamed.isError).not.toBe(true);

      const created = await client.callTool({
        name: 'create_diagram',
        arguments: {
          id: 'mcp-created', name: 'Created through MCP', folder_id: folderResult.folder.id,
          xml: createBlankBpmn('mcp-created', 'Created through MCP')
        }
      });
      expect(created.isError).not.toBe(true);
      const createdDiagram = (created.structuredContent as { diagram: { folderId: string; revision: string; url: string } }).diagram;
      expect(createdDiagram).toMatchObject({ folderId: folderResult.folder.id, url: expect.stringContaining('?diagram=mcp-created') });

      const inspected = await client.callTool({ name: 'inspect_diagram', arguments: { id: 'mcp-created' } });
      const inspection = (inspected.structuredContent as { inspection: Record<string, any> }).inspection;
      expect(inspection.diagram).not.toHaveProperty('xml');
      expect(inspection.diagram).not.toHaveProperty('group');
      expect(inspection.validation).toMatchObject({ valid: true });

      const duplicated = await client.callTool({
        name: 'duplicate_diagram',
        arguments: { source_id: 'mcp-created', expected_revision: createdDiagram.revision, new_id: 'mcp-copy', name: 'MCP copy' }
      });
      expect((duplicated.structuredContent as { diagram: { folderId: string } }).diagram.folderId).toBe(folderResult.folder.id);
      expect((await storage.get('mcp-copy')).xml).toBe((await storage.get('mcp-created')).xml);

      const catalogResource = await client.readResource({ uri: 'bpmn://catalog' });
      expect(catalogResource.contents[0]).toMatchObject({ mimeType: 'application/json' });
      expect((catalogResource.contents[0] as { text: string }).text).toContain('catalogRevision');
      const resources = await client.listResources();
      expect(resources.resources.map(resource => resource.uri)).toEqual(expect.arrayContaining([
        'bpmn://catalog', 'bpmn://modeling-guide', 'bpmn://diagram/mcp-created'
      ]));
    } finally {
      await client.close();
    }
  });
});
