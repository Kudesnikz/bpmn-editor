import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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

  it('refuses to start without required web and MCP secrets', () => {
    expect(() => loadConfig({ PUBLIC_BASE_URL: 'https://bpmn.example.test', WEB_USERNAME: 'admin' })).toThrow(/WEB_PASSWORD, MCP_API_KEY/);
  });

  it('seeds only shop and return and never re-seeds an existing catalog', async () => {
    expect((await storage.list()).map(diagram => diagram.id).sort()).toEqual(['return', 'shop']);

    await storage.create({ id: 'custom-flow', name: 'Custom flow' });
    const secondStorage = new DiagramStorage(dataDir, config.seedDir, config.publicBaseUrl, config.maxBpmnBytes);
    await secondStorage.initialize();

    expect((await secondStorage.list()).map(diagram => diagram.id).sort()).toEqual(['custom-flow', 'return', 'shop']);
  });

  it('protects REST with Basic Auth and MCP with Bearer Auth', async () => {
    await request(app).get('/api/diagrams').expect(401).expect('WWW-Authenticate', /Basic/);
    await request(app).get('/api/diagrams').auth(basic.user, basic.password).expect(200);
    await request(app).get('/api/not-a-route').auth(basic.user, basic.password)
      .expect(404).expect(({ body }) => expect(body.error.code).toBe('NOT_FOUND'));
    await request(app).post('/api/diagrams').auth(basic.user, basic.password)
      .set('Content-Type', 'application/json').send('{').expect(400)
      .expect(({ body }) => expect(body.error.code).toBe('INVALID_JSON'));

    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' } }
    };
    await request(app).post('/mcp').send(initialize).expect(401).expect('WWW-Authenticate', /Bearer/);
    await request(app).post('/mcp').set('Authorization', 'Bearer wrong-key').send(initialize).expect(401);
    await request(app).post('/mcp').set('Authorization', `Bearer ${mcpKey}`).set('Origin', 'https://attacker.example').send(initialize).expect(403);
    await request(app).post('/mcp')
      .set('Authorization', `Bearer ${mcpKey}`)
      .set('Accept', 'application/json, text/event-stream')
      .send(initialize)
      .expect(200)
      .expect('Content-Type', /application\/json|text\/event-stream/);
  });

  it('creates, validates, updates with revision protection, and deletes through REST', async () => {
    const api = request(app);
    const created = await api.post('/api/diagrams').auth(basic.user, basic.password).send({
      id: 'vacation-request',
      name: 'Согласование отпуска',
      group: 'HR'
    }).expect(201);
    expect(created.body.diagram.xml).toContain('bpmndi:BPMNDiagram');
    expect((await storage.list()).some(diagram => diagram.id === 'vacation-request')).toBe(true);

    const originalRevision = created.body.diagram.revision as string;
    const updated = await api.put('/api/diagrams/vacation-request').auth(basic.user, basic.password).send({
      expectedRevision: originalRevision,
      description: 'Процесс согласования'
    }).expect(200);
    expect(updated.body.diagram.revision).not.toBe(originalRevision);

    await api.put('/api/diagrams/vacation-request').auth(basic.user, basic.password).send({
      expectedRevision: originalRevision,
      name: 'Устаревшая запись'
    }).expect(409).expect(({ body }) => expect(body.error.code).toBe('REVISION_CONFLICT'));

    await api.delete('/api/diagrams/vacation-request').auth(basic.user, basic.password).send({
      expectedRevision: updated.body.diagram.revision,
      confirmId: 'vacation-request'
    }).expect(204);
    expect((await storage.list()).some(diagram => diagram.id === 'vacation-request')).toBe(false);
    await expect(readFile(path.join(dataDir, 'vacation-request.bpmn'), 'utf8')).rejects.toThrow();
  });

  it('rejects invalid IDs, path traversal, missing DI, and oversized payloads without changing files', async () => {
    const before = await readFile(path.join(dataDir, 'shop.bpmn'), 'utf8');
    await request(app).post('/api/diagrams').auth(basic.user, basic.password).send({
      id: '../escape', name: 'Escape', xml: createBlankBpmn('escape', 'Escape')
    }).expect(400).expect(({ body }) => expect(body.error.code).toBe('INVALID_ID'));

    await request(app).get('/api/diagrams/bad_ID').auth(basic.user, basic.password)
      .expect(400).expect(({ body }) => expect(body.error.code).toBe('INVALID_ID'));

    await request(app).put('/api/diagrams/shop').auth(basic.user, basic.password).send({
      expectedRevision: (await storage.get('shop')).revision,
      xml: invalidWithoutDi
    }).expect(422).expect(({ body }) => expect(body.error.code).toBe('INVALID_BPMN'));
    expect(await readFile(path.join(dataDir, 'shop.bpmn'), 'utf8')).toBe(before);

    await request(app).post('/api/diagrams').auth(basic.user, basic.password).send({
      id: 'too-large-xml', name: 'Too large XML', xml: 'x'.repeat(config.maxBpmnBytes + 1)
    }).expect(413).expect(({ body }) => expect(body.error.code).toBe('PAYLOAD_TOO_LARGE'));

    await request(app).post('/api/diagrams').auth(basic.user, basic.password).send({
      id: 'too-large-body', name: 'Too large body', xml: 'x'.repeat(config.maxBpmnBytes + 70 * 1024)
    }).expect(413).expect(({ body }) => expect(body.error.code).toBe('PAYLOAD_TOO_LARGE'));
  });

  it('supports MCP initialize, list/get, and revision conflicts without a delete tool', async () => {
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
        'create_diagram', 'get_diagram', 'list_diagrams', 'update_diagram', 'validate_bpmn'
      ]);
      expect(tools.tools.some(tool => tool.name.includes('delete'))).toBe(false);

      const listed = await client.callTool({ name: 'list_diagrams', arguments: {} });
      expect((listed.structuredContent as { diagrams: unknown[] }).diagrams).toHaveLength(2);

      const loaded = await client.callTool({ name: 'get_diagram', arguments: { id: 'shop' } });
      const revision = (loaded.structuredContent as { diagram: { revision: string } }).diagram.revision;
      expect(revision).toMatch(/^[a-f0-9]{64}$/);

      const created = await client.callTool({
        name: 'create_diagram',
        arguments: {
          id: 'mcp-created',
          name: 'Created through MCP',
          group: 'Tests',
          xml: createBlankBpmn('mcp-created', 'Created through MCP')
        }
      });
      expect(created.isError).not.toBe(true);
      expect((created.structuredContent as { diagram: { url: string } }).diagram.url).toContain('?diagram=mcp-created');

      const resources = await client.listResources();
      expect(resources.resources.map(resource => resource.uri)).toEqual(expect.arrayContaining([
        'bpmn://catalog', 'bpmn://modeling-guide', 'bpmn://diagram/mcp-created'
      ]));
      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates.some(template => template.uriTemplate === 'bpmn://diagram/{id}')).toBe(true);
      const modelingGuide = await client.readResource({ uri: 'bpmn://modeling-guide' });
      expect(modelingGuide.contents[0]).toMatchObject({ mimeType: 'text/plain' });

      const firstUpdate = await client.callTool({
        name: 'update_diagram',
        arguments: { id: 'shop', expected_revision: revision, description: 'Updated by MCP test' }
      });
      expect(firstUpdate.isError).not.toBe(true);

      const staleUpdate = await client.callTool({
        name: 'update_diagram',
        arguments: { id: 'shop', expected_revision: revision, description: 'Must not overwrite' }
      });
      expect(staleUpdate.isError).toBe(true);
      expect((staleUpdate.structuredContent as { error: { code: string } }).error.code).toBe('REVISION_CONFLICT');
    } finally {
      await client.close();
    }
  });
});
