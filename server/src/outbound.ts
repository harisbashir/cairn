import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Loopback, link-local, unspecified and multicast addresses are never outbound targets. LAN addresses are supported. */
export function blockedAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
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
  const url = new URL(value.replace(/^webcal:/i, 'https:'));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP and HTTPS URLs without credentials are allowed.');
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!addresses.length || addresses.some(({address}) => blockedAddress(address))) throw new Error('Loopback and link-local URLs are not allowed.');
  }
  return url;
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
      const target = await abortable(validateOutboundUrl(url, allowPrivate), controller.signal);
      controller.signal.throwIfAborted();
      const response = await abortable(fetchImpl(target.href, { signal: controller.signal, redirect: 'manual' }), controller.signal);
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
