import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApiApp } from './app.ts';

const app = createApiApp();

export default function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const rawUrl = req.url || '/';
    const parsed = new URL(rawUrl, 'http://localhost');
    const routedPath = parsed.searchParams.get('__route');
    if (routedPath !== null) {
      parsed.searchParams.delete('__route');
      const cleanRoute = routedPath.replace(/^\/+/, '');
      const qs = parsed.searchParams.toString();
      req.url = `/api/${cleanRoute}${qs ? `?${qs}` : ''}`;
    }
  } catch {
    // Keep original req.url if URL parsing fails
  }

  return app(req as unknown as Parameters<typeof app>[0], res as unknown as Parameters<typeof app>[1]);
}
