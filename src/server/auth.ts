import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

function secureEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left).digest();
  const rightHash = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftHash, rightHash);
}

export function basicAuth(username: string, password: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization || '';
    if (header.startsWith('Basic ')) {
      try {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const separator = decoded.indexOf(':');
        const suppliedUser = separator >= 0 ? decoded.slice(0, separator) : '';
        const suppliedPassword = separator >= 0 ? decoded.slice(separator + 1) : '';
        if (secureEqual(suppliedUser, username) && secureEqual(suppliedPassword, password)) {
          next();
          return;
        }
      } catch {
        // Return the same challenge for malformed and incorrect credentials.
      }
    }
    res.setHeader('WWW-Authenticate', 'Basic realm="BPMN Editor", charset="UTF-8"');
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
  };
}

export function bearerAuth(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (token && secureEqual(token, apiKey)) {
      next();
      return;
    }
    res.setHeader('WWW-Authenticate', 'Bearer realm="BPMN MCP"');
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Valid MCP API key required' } });
  };
}

export function validateMcpOrigin(allowedOrigin: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!origin || origin === allowedOrigin) {
      next();
      return;
    }
    res.status(403).json({ error: { code: 'ORIGIN_REJECTED', message: 'Origin is not allowed' } });
  };
}
