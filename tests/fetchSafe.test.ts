import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSafeText, htmlToText } from '../src/net/fetchSafe.js';
import { ValidationError } from '../src/domain/errors.js';

const baseOpts = { timeoutMs: 500, maxBytes: 10_000 };

function fakeFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request) => handler(String(input))) as typeof fetch;
}

function fakeDns(mapping: Record<string, string[]>): typeof import('node:dns/promises').lookup {
  return (async (hostname: string, _opts: unknown) => {
    const addrs = mapping[hostname];
    if (!addrs) throw new Error('ENOTFOUND');
    return addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  }) as never;
}

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

describe('fetchSafe', () => {
  test('blocks non-http schemes', async () => {
    await assert.rejects(() => fetchSafeText('file:///etc/passwd', baseOpts), ValidationError);
    await assert.rejects(() => fetchSafeText('ftp://example.com', baseOpts), ValidationError);
  });

  test('blocks localhost and private literal IPs', async () => {
    await assert.rejects(() => fetchSafeText('http://localhost/secret', baseOpts), /blocked hostname/);
    await assert.rejects(() => fetchSafeText('http://127.0.0.1/admin', baseOpts), ValidationError);
    await assert.rejects(() => fetchSafeText('http://169.254.169.254/latest/meta-data', baseOpts), ValidationError);
    await assert.rejects(() => fetchSafeText('http://10.0.0.5/', baseOpts), ValidationError);
    await assert.rejects(() => fetchSafeText('http://192.168.1.1/', baseOpts), ValidationError);
    await assert.rejects(() => fetchSafeText('http://[::1]/', baseOpts), ValidationError);
    await assert.rejects(() => fetchSafeText('http://0.0.0.0/', baseOpts), ValidationError);
  });

  test('blocks hostnames resolving to private addresses', async () => {
    const fetchImpl = fakeFetch(() => htmlResponse('internal'));
    await assert.rejects(
      () => fetchSafeText('http://intranet.example.com/', { ...baseOpts, fetchImpl, dnsLookup: fakeDns({ 'intranet.example.com': ['192.168.0.10'] }) }),
      /private address/,
    );
    await assert.rejects(
      () => fetchSafeText('http://rebind.example.com/', { ...baseOpts, fetchImpl, dnsLookup: fakeDns({ 'rebind.example.com': ['8.8.8.8', '127.0.0.1'] }) }),
      ValidationError,
    );
  });

  test('fetches public sites and extracts text', async () => {
    const fetchImpl = fakeFetch(() => htmlResponse('<html><head><style>x{}</style></head><body><h1>Hello</h1><script>alert(1)</script><p>World &amp; more</p></body></html>'));
    const res = await fetchSafeText('https://public.example.com/', { ...baseOpts, fetchImpl, dnsLookup: fakeDns({ 'public.example.com': ['93.184.216.34'] }) });
    assert.equal(res.status, 200);
    assert.ok(res.text.includes('<h1>'), 'fetchSafe returns raw text; HTML processing is separate');
    assert.ok(res.text.includes('World &amp; more'), 'raw HTML entities are preserved by fetch; decoding is htmlToText’s job');
  });

  test('validates each redirect hop', async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(() => {
      calls++;
      if (calls === 1) return new Response(null, { status: 302, headers: { location: 'http://metadata.internal/' } });
      return htmlResponse('nope');
    });
    await assert.rejects(
      () =>
        fetchSafeText('http://public.example.com/', {
          ...baseOpts,
          fetchImpl,
          dnsLookup: fakeDns({ 'public.example.com': ['93.184.216.34'], 'metadata.internal': ['169.254.169.254'] }),
        }),
      ValidationError,
    );
    assert.equal(calls, 1, 'second hop must never be requested');
  });

  test('redirect hops are bounded', async () => {
    let hops = 0;
    const fetchImpl = fakeFetch(() => {
      hops++;
      return new Response(null, { status: 302, headers: { location: `http://public.example.com/?hop=${hops}` } });
    });
    await assert.rejects(
      () =>
        fetchSafeText('http://public.example.com/', { ...baseOpts, fetchImpl, dnsLookup: fakeDns({ 'public.example.com': ['93.184.216.34'] }) }),
      /too many redirects/,
    );
    assert.ok(hops <= 5);
  });

  test('rejects non-text content types and oversized declared bodies', async () => {
    const fetchImpl = fakeFetch((url) => {
      if (url.endsWith('.exe')) return new Response('MZ...', { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      return new Response('x'.repeat(20_000), { status: 200, headers: { 'content-type': 'text/html', 'content-length': '20000' } });
    });
    const opts = { ...baseOpts, fetchImpl, dnsLookup: fakeDns({ 'public.example.com': ['93.184.216.34'] }) };
    await assert.rejects(() => fetchSafeText('https://public.example.com/a.exe', opts), /content type/);
    await assert.rejects(() => fetchSafeText('https://public.example.com/big', opts), /too large/);
  });

  test('streams and truncates oversized undeclared bodies', async () => {
    const big = 'y'.repeat(25_000);
    const fetchImpl = fakeFetch(() => new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const res = await fetchSafeText('https://public.example.com/stream', { ...baseOpts, maxBytes: 1000, fetchImpl, dnsLookup: fakeDns({ 'public.example.com': ['93.184.216.34'] }) });
    assert.equal(res.truncated, true);
    assert.ok(res.text.length <= 1000);
  });
});

describe('htmlToText', () => {
  test('strips tags, scripts, comments and collapses whitespace', () => {
    const text = htmlToText('<div><h1>A &amp; B</h1><!-- hidden --><p>Line one</p><p>Line two</p></div>');
    assert.equal(text, 'A & B Line one Line two');
  });
});
