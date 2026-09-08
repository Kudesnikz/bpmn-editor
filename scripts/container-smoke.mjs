// Run inside a disposable production container. Uses its test-only credentials.
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:3000';
const basic = 'Basic ' + Buffer.from(`${process.env.WEB_USERNAME}:${process.env.WEB_PASSWORD}`).toString('base64');
const bearer = `Bearer ${process.env.MCP_API_KEY}`;
let sequence = 0;
async function rpc(method, params) {
  const id = ++sequence;
  const response = await fetch(`${base}/mcp-json`, { method: 'POST', headers: { Authorization: bearer, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  assert.equal(response.status, 200, 'MCP HTTP request failed');
  const body = await response.text();
  const messages = response.headers.get('content-type')?.includes('text/event-stream') ? body.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5))) : [JSON.parse(body)];
  const result = messages.find(message => message.id === id);
  assert.ok(result && !result.error, 'JSON-RPC request failed');
  return result.result;
}
async function tool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args });
  assert.ok(!result.isError, result.structuredContent?.error?.code || 'Tool failed');
  return result.structuredContent;
}
const health = await (await fetch(`${base}/healthz`)).json();
assert.deepEqual(Object.keys(health).sort(), ['status', 'version']);
assert.equal(health.status, 'ok');
assert.equal((await fetch(`${base}/api/config`)).status, 401);
assert.equal((await fetch(`${base}/mcp-json`, { method: 'POST' })).status, 401);
const configResponse = await fetch(`${base}/api/config`, { headers: { Authorization: basic } });
assert.equal(configResponse.headers.get('cache-control'), 'private, no-store');
const config = await configResponse.json();
assert.ok(config.jsonMcp.codexConfig.includes('[mcp_servers.bpmn_json]'));
assert.ok(config.jsonMcp.skillMarkdown.includes('name: bpmn-json-modeler'));
await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'container-smoke', version: '1' } });
const tools = await rpc('tools/list', {});
assert.equal(tools.tools.length, 11);
assert.ok(!tools.tools.some(tool => tool.name.includes('delete')));
const catalog = await tool('list_diagrams', {});
if (process.argv.includes('--verify-restart')) {
  assert.ok(catalog.diagrams.some(diagram => diagram.id === 'container-json'));
  const saved = await tool('get_diagram', { id: 'container-json', scope: 'semantic' });
  assert.equal(saved.document.elements.Start.properties.name, 'Saved through JSON');
  console.log('Container restart preserved JSON-created XML and catalog.');
} else {
  assert.deepEqual(catalog.diagrams.map(diagram => diagram.id).sort(), ['return', 'shop']);
  const document = { format: 'bpmn-json', version: 1, rootId: 'Definitions', namespaces: { bpmn: 'http://www.omg.org/spec/BPMN/20100524/MODEL' }, elements: {
    Definitions: { type: 'bpmn:Definitions', properties: { targetNamespace: 'urn:smoke', rootElements: ['Process'] } },
    Process: { type: 'bpmn:Process', properties: { flowElements: ['Start'] } },
    Start: { type: 'bpmn:StartEvent', properties: { name: 'Start' } }
  } };
  const created = await tool('create_diagram', { id: 'container-json', name: 'Container JSON', document });
  assert.equal(created.validation.valid, true);
  const args = { id: 'container-json', expected_revision: created.diagram.revision, mode: 'operations', operations: [{ op: 'update_properties', element_id: 'Start', set: { name: 'Saved through JSON' } }] };
  const saved = await tool('update_diagram', args);
  assert.notEqual(saved.diagram.revision, created.diagram.revision);
  const conflict = await rpc('tools/call', { name: 'update_diagram', arguments: args });
  assert.equal(conflict.structuredContent.error.code, 'REVISION_CONFLICT');
  const rest = await (await fetch(`${base}/api/diagrams/container-json`, { headers: { Authorization: basic } })).json();
  assert.ok(rest.diagram.xml.includes('BPMNPlane'));
  assert.ok(rest.diagram.xml.includes('Saved through JSON'));
  console.log('Production container passed health, auth, config/skill, MCP initialize/list/create/update, DI and conflict checks.');
}
