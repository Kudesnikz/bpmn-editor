// Local-only production UI smoke server, using disposable seed data and test credentials.
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApplication } from '../dist/server/app.js';
import { loadConfig } from '../dist/server/config.js';
import { DiagramStorage } from '../dist/server/storage.js';

const directory = await mkdtemp(path.join(tmpdir(), 'bpmn-ui-smoke-'));
const config = loadConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://127.0.0.1:3017', PORT: '3017', WEB_USERNAME: 'smoke', WEB_PASSWORD: 'smoke-password', MCP_API_KEY: 'local-smoke-key-not-for-production', DATA_DIR: directory, ENABLE_JSON_MCP: 'true', MCP_RATE_LIMIT_PER_MINUTE: '1000' });
const storage = new DiagramStorage(directory, path.resolve('diagrams'), config.publicBaseUrl, config.maxBpmnBytes);
await storage.initialize();
const application = await createApplication({ config, storage });
const server = createServer(application.app);
server.listen(3017, '127.0.0.1', () => process.stdout.write('Local smoke editor: http://127.0.0.1:3017 (disposable seed data)\n'));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await application.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('bpmn-ui-smoke-')) await rm(resolved, { recursive: true, force: true });
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
