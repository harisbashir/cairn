import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

/** Loopback, link-local, unspecified and multicast addresses are never outbound targets. LAN addresses are supported. */
export function blockedAddress(address: string): boolean {
  let ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(ip) === 6) ip = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  if (ip.startsWith('::ffff:')) {
    const tail = ip.slice(7);
    if (isIP(tail) === 4) return blockedAddress(tail);
    const parts = tail.split(':');
    if (parts.length === 2) return blockedAddress(`${parseInt(parts[0],16)>>8}.${parseInt(parts[0],16)&255}.${parseInt(parts[1],16)>>8}.${parseInt(parts[1],16)&255}`);
  }
  if (isIP(ip) === 4) { const [a,b] = ip.split('.').map(Number); return a === 0 || a === 127 || (a === 169 && b === 254) || a >= 224; }
  return ip === '::' || ip === '::1' || /^fe[89ab]/.test(ip) || ip.startsWith('ff');
}
export async function validateOutboundUrl(value: string, allowPrivate = process.env.CAIRN_ALLOW_PRIVATE_ICS === '1'): Promise<URL> {
  return (await outboundTarget(value, allowPrivate)).url;
}
async function outboundTarget(value: string, allowPrivate: boolean) {
  const url = new URL(value.replace(/^webcal:/i, 'https:'));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP and HTTPS URLs without credentials are allowed.');
  if (allowPrivate) return { url, addresses: [] };
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || (!allowPrivate && addresses.some(({address}) => blockedAddress(address)))) throw new Error('Loopback and link-local URLs are not allowed.');
  return { url, addresses };
}
/** Preserve the original Host/TLS name, but connect only to the checked addresses. */
function pinnedDownload(target: Awaited<ReturnType<typeof outboundTarget>>, signal: AbortSignal): Promise<Response> {
  const pinnedLookup: LookupFunction = (_host, options, callback) => {
    if (options.all) callback(null, target.addresses);
    else callback(null, target.addresses[0].address, target.addresses[0].family);
  };
  return new Promise((resolve, reject) => {
    const request = (target.url.protocol === 'https:' ? httpsRequest : httpRequest)(target.url, { signal, lookup: pinnedLookup, agent: false }, response => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(response.headers)) if (value !== undefined) {
        if (Array.isArray(value)) for (const item of value) headers.append(name, item);
        else headers.set(name, value);
      }
      const status = response.statusCode ?? 502;
      if ([204, 205, 304].includes(status)) { response.resume(); resolve(new Response(null, { status, headers })); return; }
      const encoding = headers.get('content-encoding');
      const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null;
      if (decoder) {
        response.on('error', error => decoder.destroy(error));
        decoder.on('close', () => response.destroy());
      }
      const body = Readable.toWeb(decoder ? response.pipe(decoder) : response) as ReadableStream<Uint8Array<ArrayBuffer>>;
      resolve(new Response(body, { status, headers }));
    });
    request.on('error', reject);
    request.end();
  });
}
async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new Error('Download timed out.');
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error('Download timed out.'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
export async function safeDownload(value: string, fetchImpl: typeof fetch = fetch, limit = 5 * 1024 * 1024, allowPrivate = process.env.CAIRN_ALLOW_PRIVATE_ICS === '1'): Promise<{ data: Uint8Array; mime: string; url: string }> {
  const controller = new AbortController();
  let rejectTimeout!: (reason: Error) => void;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const timer = setTimeout(() => { controller.abort(); rejectTimeout(new Error('Download timed out.')); }, 10_000);
  const download = async () => {
    let url = value;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const resolved = await abortable(outboundTarget(url, allowPrivate), controller.signal);
      const target = resolved.url;
      controller.signal.throwIfAborted();
      const response = await abortable(fetchImpl === fetch && !allowPrivate ? pinnedDownload(resolved, controller.signal) : fetchImpl(target.href, { signal: controller.signal, redirect: 'manual' }), controller.signal);
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 5) throw new Error('Too many calendar redirects.');
        url = new URL(location, target).href; continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Download failed (${response.status}).`); }
      if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Download exceeds the size limit.'); }
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = response.body?.getReader();
      if (reader) try { while (true) { const {done,value} = await abortable(reader.read(), controller.signal); if (done) break; size += value.length; if (size > limit) throw new Error('Download exceeds the size limit.'); chunks.push(value); } } finally { await reader.cancel(); }
      const data = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { data.set(chunk,offset); offset += chunk.length; }
      return { data, mime: response.headers.get('content-type') ?? 'application/octet-stream', url: target.href };
    }
    throw new Error('Download failed.');
  };
  try { return await Promise.race([download(), timeout]); } finally { clearTimeout(timer); }
}
