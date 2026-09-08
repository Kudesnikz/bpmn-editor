import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { getEncoding } from 'js-tiktoken';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApplication } from '../src/server/app.js';
import { loadConfig } from '../src/server/config.js';
import { DiagramStorage, createBlankBpmn } from '../src/server/storage.js';
import { documentToXml, xmlToDocument, type BpmnDocument } from '../src/server/json-bpmn/codec.js';
import { semanticDocument } from '../src/server/json-bpmn/graph.js';
import { autoLayout, preserveLayout } from '../src/server/json-bpmn/layout.js';
import { applyOperations } from '../src/server/json-bpmn/operations.js';

// Measures deterministic MCP artifacts, not a model's billing or hidden reasoning.
const encoding = getEncoding('o200k_base');
const measure = (value: unknown) => { const serialized = JSON.stringify(value); return { bytes: Buffer.byteLength(serialized), tokens: encoding.encode(serialized).length }; };
const directory = await mkdtemp(path.join(tmpdir(), 'bpmn-token-benchmark-'));
const config = loadConfig({ PUBLIC_BASE_URL: 'http://127.0.0.1', WEB_USERNAME: 'benchmark', WEB_PASSWORD: 'test-password', MCP_API_KEY: 'benchmark-test-key', DATA_DIR: directory, ENABLE_JSON_MCP: 'true', MCP_RATE_LIMIT_PER_MINUTE: '1000', NODE_ENV: 'test' });
const storage = new DiagramStorage(directory, path.resolve('diagrams'), config.publicBaseUrl, config.maxBpmnBytes);
await storage.initialize();
const application = await createApplication({ config, storage, serveFrontend: false });
const server = createServer(application.app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const clients = { xml: new Client({ name: 'benchmark', version: '1' }), json: new Client({ name: 'benchmark', version: '1' }) };
type Mode = keyof typeof clients;
const rows: any[] = [];
try {
  for (const mode of ['xml', 'json'] as const) await clients[mode].connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/${mode === 'xml' ? 'mcp' : 'mcp-json'}`), { requestInit: { headers: { Authorization: `Bearer ${config.mcpApiKey}` } } }));
  const discovery = {
    xml: measure({ ...(await clients.xml.listTools()), instructions: clients.xml.getInstructions() }),
    json: measure({ ...(await clients.json.listTools()), instructions: clients.json.getInstructions() })
  };
  let transcript: unknown[] = [];
  async function call(mode: Mode, name: string, args: any): Promise<any> {
    const result = await clients[mode].callTool({ name, arguments: args });
    transcript.push({ request: { name, arguments: args }, response: result });
    if (result.isError) throw new Error(`Benchmark ${name} failed: ${(result.structuredContent as any)?.error?.code}`);
    return result.structuredContent;
  }
  async function run(scenario: string, mode: Mode, operation: () => Promise<void>) {
    transcript = []; await operation();
    const measured = measure(transcript);
    rows.push({ scenario, mode, calls: transcript.length, ...measured, withToolDiscoveryTokens: measured.tokens + discovery[mode].tokens });
  }
  const fixture = async (id: string) => {
    const shop = await storage.get('shop');
    return (await storage.create({ id, name: 'Benchmark', xml: shop.xml })).diagram;
  };
  for (const mode of ['xml', 'json'] as const) {
    for (const scenario of ['rename', 'insert-task'] as const) {
      const initial = await fixture(`${mode}-${scenario}`);
      await run(scenario, mode, async () => {
        const read = await call(mode, 'get_diagram', mode === 'xml' ? { id: initial.id } : { id: initial.id, scope: 'fragment', selector: { element_ids: [scenario === 'rename' ? 'Task_Pay' : 'Flow_1'] } });
        const operations = scenario === 'rename' ? [{ op: 'update_properties', element_id: 'Task_Pay', set: { name: 'Оплатить картой' } }] : [{ op: 'insert_task_on_flow', flow_id: 'Flow_1', task: { id: 'Task_Added', type: 'bpmn:UserTask', name: 'Проверить список' }, new_flow_id: 'Flow_Added' }];
        if (mode === 'json') await call(mode, 'update_diagram', { id: initial.id, expected_revision: read.revision, mode: 'operations', operations });
        else {
          const changes = applyOperations(await xmlToDocument(read.diagram.xml), operations);
          const xml = await documentToXml(preserveLayout(changes));
          await call(mode, 'update_diagram', { id: initial.id, expected_revision: read.diagram.revision, xml });
        }
      });
    }
  }
  const semantic = semanticDocument(await xmlToDocument(createBlankBpmn('gateway', 'Gateway')));
  Object.assign(semantic.elements, {
    Gateway: { type: 'bpmn:ExclusiveGateway', properties: { name: 'Согласовано?', default: 'Flow_No' } },
    End_Yes: { type: 'bpmn:EndEvent', properties: { name: 'Да' } }, End_No: { type: 'bpmn:EndEvent', properties: { name: 'Нет' } },
    Flow_Start: { type: 'bpmn:SequenceFlow', properties: { sourceRef: 'StartEvent_gateway', targetRef: 'Gateway' } },
    Flow_Yes: { type: 'bpmn:SequenceFlow', properties: { sourceRef: 'Gateway', targetRef: 'End_Yes', conditionExpression: { type: 'bpmn:FormalExpression', properties: { body: 'approved = true' } } } },
    Flow_No: { type: 'bpmn:SequenceFlow', properties: { sourceRef: 'Gateway', targetRef: 'End_No' } }
  });
  semantic.elements.Process_gateway!.properties.flowElements.push('Gateway', 'End_Yes', 'End_No', 'Flow_Start', 'Flow_Yes', 'Flow_No');
  const complete = await documentToXml(await autoLayout(semantic));
  for (const mode of ['xml', 'json'] as const) {
    const id = `${mode}-condition`;
    await storage.create({ id, name: 'Condition', xml: complete });
    await run('condition', mode, async () => {
      const read = await call(mode, 'get_diagram', mode === 'xml' ? { id } : { id, scope: 'fragment', selector: { element_ids: ['Gateway'], neighbor_depth: 1 } });
      const operations = [{ op: 'update_properties', element_id: 'Flow_Yes', set: { conditionExpression: { type: 'bpmn:FormalExpression', properties: { body: 'approved = true and amount < 1000' } } } }];
      if (mode === 'json') {
        await call(mode, 'validate_bpmn', { id, expected_revision: read.revision, operations });
        await call(mode, 'update_diagram', { id, expected_revision: read.revision, mode: 'operations', operations });
      } else {
        const xml = await documentToXml(applyOperations(await xmlToDocument(read.diagram.xml), operations).document);
        await call(mode, 'validate_bpmn', { xml });
        await call(mode, 'update_diagram', { id, expected_revision: read.diagram.revision, xml });
      }
    });
    await run('create-process', mode, async () => {
      await call(mode, 'list_folders', {}); await call(mode, 'list_diagrams', { query: `${mode}-new-process` });
      await call(mode, 'validate_bpmn', mode === 'xml' ? { xml: complete } : { document: semantic });
      await call(mode, 'create_diagram', { id: `${mode}-new-process`, name: 'New process', ...(mode === 'xml' ? { xml: complete } : { document: semantic }) });
    });
  }
  const subprocess: BpmnDocument = structuredClone(semantic);
  subprocess.elements.Sub = { type: 'bpmn:SubProcess', properties: { name: 'Nested review', flowElements: ['NestedStart'] } };
  subprocess.elements.NestedStart = { type: 'bpmn:StartEvent', properties: { name: 'Nested start' } };
  subprocess.elements.Process_gateway!.properties.flowElements.push('Sub');
  await storage.create({ id: 'subprocess', name: 'Subprocess', xml: await documentToXml(await autoLayout(subprocess)) });
  await run('analyze-subprocess', 'xml', async () => { await call('xml', 'get_diagram', { id: 'subprocess' }); });
  await run('analyze-subprocess', 'json', async () => { await call('json', 'get_diagram', { id: 'subprocess', scope: 'fragment', selector: { container_id: 'Sub', neighbor_depth: 0 } }); });
  await run('analyze-subprocess-existing-inspect', 'xml', async () => { await call('xml', 'inspect_diagram', { id: 'subprocess' }); });
  console.log(JSON.stringify({ tokenizer: 'js-tiktoken@1.0.21/o200k_base', metric: 'UTF-8 bytes and tokens of JSON-serialized tool requests/results; discovery includes tool schemas and server instructions; not billed model usage', exclusions: 'User prompts, model reasoning, provider-specific framing/caching, optional skill text, and retries (all scenarios succeeded on first attempt). Fixture setup is excluded.', discovery, rows }, null, 2));
} finally {
  await Promise.all(Object.values(clients).map(client => client.close()));
  await application.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('bpmn-token-benchmark-')) await rm(resolved, { recursive: true, force: true });
}
