import path from 'node:path';

export interface AppConfig {
  port: number;
  dataDir: string;
  seedDir: string;
  publicBaseUrl: string;
  publicOrigin: string;
  webUsername: string;
  webPassword: string;
  mcpApiKey: string;
  mcpRateLimitPerMinute: number;
  maxBpmnBytes: number;
  nodeEnv: string;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const publicBaseUrl = env.PUBLIC_BASE_URL?.trim();
  const webUsername = env.WEB_USERNAME?.trim();
  const webPassword = env.WEB_PASSWORD;
  const mcpApiKey = env.MCP_API_KEY;

  const missing = [
    ['PUBLIC_BASE_URL', publicBaseUrl],
    ['WEB_USERNAME', webUsername],
    ['WEB_PASSWORD', webPassword],
    ['MCP_API_KEY', mcpApiKey]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(publicBaseUrl!);
  } catch {
    throw new Error('PUBLIC_BASE_URL must be an absolute http(s) URL');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('PUBLIC_BASE_URL must use http or https');
  }

  return {
    port: positiveInteger(env.PORT, 3000, 'PORT'),
    dataDir: path.resolve(env.DATA_DIR || path.join(process.cwd(), '.data', 'diagrams')),
    seedDir: path.resolve(env.SEED_DIR || path.join(process.cwd(), 'diagrams')),
    publicBaseUrl: parsedUrl.toString().replace(/\/$/, ''),
    publicOrigin: parsedUrl.origin,
    webUsername: webUsername!,
    webPassword: webPassword!,
    mcpApiKey: mcpApiKey!,
    mcpRateLimitPerMinute: positiveInteger(env.MCP_RATE_LIMIT_PER_MINUTE, 60, 'MCP_RATE_LIMIT_PER_MINUTE'),
    maxBpmnBytes: positiveInteger(env.MAX_BPMN_BYTES, 2 * 1024 * 1024, 'MAX_BPMN_BYTES'),
    nodeEnv: env.NODE_ENV || 'development'
  };
}
