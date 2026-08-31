import { createServer } from 'node:http';
import { createApplication } from './app.js';
import { loadConfig } from './config.js';
import { logError, logEvent } from './logger.js';
import { DiagramStorage } from './storage.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const storage = new DiagramStorage(config.dataDir, config.seedDir, config.publicBaseUrl, config.maxBpmnBytes);
  await storage.initialize();
  const { app, mcpHandler } = await createApplication({ config, storage });
  const server = createServer(app);

  server.listen(config.port, '0.0.0.0', () => {
    logEvent('server_started', {
      port: config.port,
      environment: config.nodeEnv,
      dataDir: config.dataDir,
      publicBaseUrl: config.publicBaseUrl
    });
  });

  const shutdown = async (signal: string) => {
    logEvent('server_stopping', { signal });
    server.close(async error => {
      if (error) logError('server_close_failed', error);
      await mcpHandler.close().catch(closeError => logError('mcp_close_failed', closeError));
      process.exit(error ? 1 : 0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(error => {
  logError('server_start_failed', error);
  process.exit(1);
});
