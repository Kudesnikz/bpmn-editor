import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { DiagramStorage, createBlankBpmn } from '../src/server/storage.js';
import { xmlToDocument } from '../src/server/json-bpmn/codec.js';
import { semanticDocument } from '../src/server/json-bpmn/graph.js';

describe('experimental JSON Streamable HTTP MCP', () => {
  let directory: string, storage: DiagramStorage, application: Awaited<ReturnType<typeof createApplication>>;
  let server: Server, client: Client;
  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'bpmn-json-mcp-'));
    const config = loadConfig({ PUBLIC_BASE_URL: 'http://127.0.0.1', WEB_USERNAME: 'admin', WEB_PASSWORD: 'test-password', MCP_API_KEY: 'test-key', DATA_DIR: directory, ENABLE_JSON_MCP: 'true', NODE_ENV: 'test', MCP_RATE_LIMIT_PER_MINUTE: '1000' });
    storage = new DiagramStorage(directory, path.resolve('diagrams'), config.publicBaseUrl, config.maxBpmnBytes);
    await storage.initialize();
    application = await createApplication({ config, storage, serveFrontend: false });
    server = createServer(application.app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    client = new Client({ name: 'json-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp-json`), { requestInit: { headers: { Authorization: 'Bearer test-key' } } }));
  });
  afterEach(async () => {
    await client?.close(); await application?.close();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const data = (result: any) => { expect(result.isError, JSON.stringify(result.structuredContent?.error)).not.toBe(true); return result.structuredContent as any; };

  it('authenticates, publishes 11 tools without deletion and serves schema/guide resources', async () => {
    await request(application.app).post('/mcp-json').send({}).expect(401);
    await request(application.app).post('/mcp-json').set('Authorization', 'Bearer wrong').send({}).expect(401);
    await request(application.app).post('/mcp-json').set('Authorization', 'Bearer test-key').set('Origin', 'https://evil.test').send({}).expect(403);
    expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(['create_diagram', 'create_folder', 'describe_bpmn_types', 'duplicate_diagram', 'get_diagram', 'inspect_diagram', 'list_diagrams', 'list_folders', 'update_diagram', 'update_folder', 'validate_bpmn']);
    expect((await client.listResources()).resources.map(resource => resource.uri)).toContain('bpmn-json://schema');
    const schema = await client.readResource({ uri: 'bpmn-json://schema' });
    expect(JSON.parse((schema.contents[0] as any).text).properties.version.const).toBe(1);
    expect(data(await client.callTool({ name: 'describe_bpmn_types', arguments: { types: ['bpmn:UserTask'] } })).types).toHaveLength(1);
    expect(JSON.stringify((await request(application.app).get('/healthz')).body)).not.toContain('test-key');
    await request(application.app).get('/api/config').expect(401);
    await request(application.app).get('/api/config').auth('admin', 'test-password').expect(200).expect('Cache-Control', 'private, no-store').expect(({ body }) => {
      expect(body.jsonMcp.enabled).toBe(true);
      expect(body.jsonMcp.codexConfig).toContain('[mcp_servers.bpmn_json]');
      expect(body.jsonMcp.codexConfig).toContain('Bearer test-key');
      expect(body.jsonMcp.tools.map((tool: any) => tool.name).sort()).toEqual(['create_diagram', 'create_folder', 'describe_bpmn_types', 'duplicate_diagram', 'get_diagram', 'inspect_diagram', 'list_diagrams', 'list_folders', 'update_diagram', 'update_folder', 'validate_bpmn']);
      expect(body.jsonMcp.skillMarkdown).toContain('name: bpmn-json-modeler');
      expect(body.jsonMcp.skillCreatorPrompt).toContain(body.jsonMcp.skillMarkdown);
      expect(body).not.toHaveProperty('mcpApiKey');
    });
  });

  it('reads compact structure, edits by operations, rejects stale revisions and never returns XML', async () => {
    const summary = data(await client.callTool({ name: 'get_diagram', arguments: { id: 'shop', scope: 'summary' } }));
    expect(summary.revision).toBe(summary.diagram.revision);
    expect(summary.documentComplete).toBe(false);
    const inspect = data(await client.callTool({ name: 'inspect_diagram', arguments: { id: 'shop' } }));
    expect(inspect.inspection.processes.length).toBeGreaterThan(0);
    expect(inspect.inspection.validation.valid).toBe(true);
    const fragment = data(await client.callTool({ name: 'get_diagram', arguments: { id: 'shop', scope: 'fragment', selector: { element_ids: ['Task_Pay'] } } }));
    expect(fragment.document.elements.Task_Pay).toBeDefined();
    expect(fragment.documentComplete).toBe(false);
    const arguments_ = { id: 'shop', expected_revision: summary.revision, mode: 'operations', operations: [{ op: 'update_properties', element_id: 'Task_Pay', set: { name: 'Pay by card' } }] };
    const updated = data(await client.callTool({ name: 'update_diagram', arguments: arguments_ }));
    expect(updated.diagram.revision).not.toBe(summary.revision);
    expect(updated.diagram.xml).toBeUndefined();
    expect(updated.document).toBeUndefined();
    const conflict = await client.callTool({ name: 'update_diagram', arguments: arguments_ });
    expect(conflict.isError).toBe(true);
    expect((conflict.structuredContent as any).error.code).toBe('REVISION_CONFLICT');
    expect((await storage.get('shop')).xml).toContain('Pay by card');
  });

  it('creates semantic JSON with auto DI, validates without saving and duplicates exact XML', async () => {
    const document = semanticDocument(await xmlToDocument(createBlankBpmn('created', 'Created')));
    const before = await readFile(path.join(directory, 'index.json'), 'utf8');
    const valid = data(await client.callTool({ name: 'validate_bpmn', arguments: { document } }));
    expect(valid.validation.valid).toBe(true);
    expect(await readFile(path.join(directory, 'index.json'), 'utf8')).toBe(before);
    const created = data(await client.callTool({ name: 'create_diagram', arguments: { id: 'json-created', name: 'JSON created', document } }));
    expect(created.validation.valid).toBe(true);
    const original = await storage.get('json-created');
    expect(original.xml).toContain('BPMNPlane');
    const duplicated = data(await client.callTool({ name: 'duplicate_diagram', arguments: { source_id: 'json-created', expected_revision: original.revision, new_id: 'json-copy', name: 'Copy' } }));
    expect(duplicated.diagram.revision).not.toBe(original.revision);
    expect((await storage.get('json-copy')).xml).toBe(original.xml);
  });

  it('rejects partial replacements, incompatible modes and invalid operations without changing files', async () => {
    const original = await storage.get('shop');
    const fragment = data(await client.callTool({ name: 'get_diagram', arguments: { id: 'shop', scope: 'fragment', selector: { element_ids: ['Task_Pay'], neighbor_depth: 0 } } }));
    const partial = await client.callTool({ name: 'update_diagram', arguments: { id: 'shop', expected_revision: original.revision, mode: 'replace', document: fragment.document, layout: { mode: 'provided' } } });
    expect(partial.isError).toBe(true);
    const invalid = await client.callTool({ name: 'update_diagram', arguments: { id: 'shop', expected_revision: original.revision, mode: 'metadata', operations: [{ op: 'remove_element', element_id: 'Task_Pay' }] } });
    expect(invalid.isError).toBe(true);
    expect(await storage.get('shop')).toEqual(original);
    await request(application.app).post('/mcp-json').set('Authorization', 'Bearer test-key').send({ oversized: 'x'.repeat(4 * 1024 * 1024 + 65536) }).expect(413);
  });

  it('creates nested folders, moves metadata and rejects stale catalog revisions and traversal', async () => {
    const initial = data(await client.callTool({ name: 'list_folders', arguments: {} }));
    const root = data(await client.callTool({ name: 'create_folder', arguments: { name: 'JSON root', expected_catalog_revision: initial.catalogRevision } }));
    const child = data(await client.callTool({ name: 'create_folder', arguments: { name: 'Nested', parent_id: root.folder.id, expected_catalog_revision: root.catalog.catalogRevision } }));
    const renamed = data(await client.callTool({ name: 'update_folder', arguments: { id: child.folder.id, name: 'Renamed', expected_catalog_revision: child.catalog.catalogRevision } }));
    expect(renamed.folder.parentId).toBe(root.folder.id);
    const stale = await client.callTool({ name: 'update_folder', arguments: { id: child.folder.id, parent_id: null, expected_catalog_revision: child.catalog.catalogRevision } });
    expect((stale.structuredContent as any).error.code).toBe('CATALOG_REVISION_CONFLICT');
    const before = await storage.get('shop');
    const moved = data(await client.callTool({ name: 'update_diagram', arguments: { id: 'shop', expected_revision: before.revision, mode: 'metadata', folder_id: child.folder.id } }));
    expect(moved.diagram.folderId).toBe(child.folder.id);
    expect((await storage.get('shop')).xml).toBe(before.xml);
    expect(moved.diagram.revision).not.toBe(before.revision);
    const traversal = await client.callTool({ name: 'get_diagram', arguments: { id: '../index', scope: 'summary' } });
    expect((traversal.structuredContent as any).error.code).toBe('INVALID_ID');
  });
});
