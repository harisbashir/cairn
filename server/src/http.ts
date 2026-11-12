import type { MiddlewareHandler } from 'hono';
import { fail, type Env } from './common.ts';

/** Bound streamed bodies as well as Content-Length, before any JSON or multipart parser. */
async function limitBody(request: Request, max: number): Promise<Request> {
  if (Number(request.headers.get('Content-Length') ?? 0) > max) fail(400, 'Request body is too large.');
  const reader = request.body?.getReader();
  if (!reader) return request;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > max) {
      await reader.cancel();
      fail(400, 'Request body is too large.');
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new Request(request.url, { method: request.method, headers: request.headers, body: bytes });
}

export const hardening: MiddlewareHandler<Env> = async (c, next) => {
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  if (!c.req.path.startsWith('/s/') && !c.req.path.startsWith('/share/')) c.header('X-Frame-Options', 'DENY');
  const origin = c.req.header('Origin');
  const allowed = (process.env.CAIRN_CORS_ORIGINS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const bearer = /^Bearer \S+$/i.test(c.req.header('Authorization') ?? '');
  const preflight = c.req.method === 'OPTIONS' && c.req.header('Access-Control-Request-Headers')?.toLowerCase().split(',').some(value => value.trim() === 'authorization');
  if (origin && origin !== new URL(c.req.url).origin && allowed.includes(origin) && (bearer || preflight)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Vary', 'Origin');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Cairn-Client');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
  }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const isImport = /\/workspaces\/[^/]+\/import$/.test(c.req.path);
    const multipart = c.req.header('Content-Type')?.includes('multipart/form-data');
    // The multipart envelope gets 1 MB; each endpoint enforces its actual file limit.
    const max = (multipart ? (isImport ? 201 : 21) : 2) * 1024 * 1024;
    Object.defineProperty(c.req, 'raw', { value: await limitBody(c.req.raw, max) });
  }
  await next();
  if (c.res.headers.get('Content-Type')?.includes('text/html')) {
    c.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self'; object-src 'none'; base-uri 'self'");
  }
};
