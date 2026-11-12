import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { lookup } from 'node:dns/promises';

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }));
// Model a transport which connects using its supplied lookup callback. The
// response identifies the address it reached, without making a network request.
vi.mock('node:http', () => ({ request: (_url: URL, options: any, callback: (response: any) => void) => {
  const request = new EventEmitter() as EventEmitter & { end: () => void };
  request.end = () => {
    options.lookup('calendar.example', { all: true }, (error: Error | null, addresses: { address: string }[]) => {
      if (error) { request.emit('error', error); return; }
      const response = Readable.from([Buffer.from(addresses[0].address === '8.8.8.8' ? 'calendar' : 'private data')]);
      Object.assign(response, { statusCode: 200, headers: {}, rawHeaders: [] });
      callback(response);
    });
  };
  return request;
} }));
import { blockedAddress, safeDownload } from '../src/outbound.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });
it('connects to the validated DNS addresses even when the next resolution rebinds to loopback', async () => {
  vi.mocked(lookup).mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as any)
    .mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as any);
  vi.stubGlobal('fetch', async () => {
    const addresses = await lookup('calendar.example', { all: true });
    return new Response(addresses[0].address === '8.8.8.8' ? 'calendar' : 'private data');
  });
  const result = await safeDownload('http://calendar.example/feed');
  expect(new TextDecoder().decode(result.data)).toBe('calendar');
});
it.each(['0:0:0:0:0:0:0:1', '0:0:0:0:0:0:0:0', '0:0:0:0:0:ffff:7f00:1', '0:0:0:0:0:ffff:a9fe:101'])('blocks expanded IPv6 address %s', address => {
  expect(blockedAddress(address)).toBe(true);
});
