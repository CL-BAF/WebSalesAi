import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { ValidationError } from '../domain/errors.js';

export interface FetchSafeOptions {
  timeoutMs: number;
  maxBytes: number;
  fetchImpl?: typeof fetch;
  maxRedirects?: number;
  dnsLookup?: typeof lookup;
}

export interface SafeFetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.azure.com',
  'instance-data',
]);

function isPrivateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v6 = ip.toLowerCase();
    if (v6 === '::1' || v6 === '::') return true;
    if (v6.startsWith('fc') || v6.startsWith('fd')) return true; // unique local fc00::/7
    if (v6.startsWith('fe8') || v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb')) return true; // link local
    const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return false;
  }
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // this-network, private, loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * SSRF-guarded text fetch:
 *  - http/https only
 *  - blocked hostnames + all resolved DNS addresses must be public
 *  - manual redirects so every hop is re-validated
 *  - bounded size and time
 * Known limitation (documented): a hostile DNS server rebinding between our
 * check and the connection could still reach a private address; acceptable
 * for public-website research, not for hostile-tenant environments.
 */
export async function fetchSafeText(rawUrl: string, opts: FetchSafeOptions): Promise<SafeFetchResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError(`invalid URL: ${rawUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError(`unsupported URL scheme: ${url.protocol}`);
  }
  await assertPublicHost(url, opts.dnsLookup ?? lookup);

  const doFetch = opts.fetchImpl ?? fetch;
  const maxRedirects = opts.maxRedirects ?? 3;
  let currentUrl = url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res: Response;
    try {
      res = await doFetch(currentUrl.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(opts.timeoutMs),
        headers: { 'user-agent': 'WebSalesAi-Research/0.1 (public website analysis)', accept: 'text/html,text/plain' },
      });
    } catch (err) {
      const isTimeout = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      throw new ValidationError(isTimeout ? `fetch timed out after ${opts.timeoutMs}ms` : 'fetch failed (connection error)');
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new ValidationError('redirect without location header');
      if (hop === maxRedirects) throw new ValidationError('too many redirects');
      const next = new URL(location, currentUrl);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        throw new ValidationError(`redirect to unsupported scheme: ${next.protocol}`);
      }
      await assertPublicHost(next, opts.dnsLookup ?? lookup);
      currentUrl = next;
      continue;
    }

    if (!res.ok) {
      throw new ValidationError(`website returned HTTP ${res.status}`);
    }

    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
    if (contentType && !contentType.startsWith('text/') && !contentType.includes('json') && !contentType.includes('xml')) {
      throw new ValidationError(`unsupported content type: ${contentType.split(';')[0]}`);
    }

    const declaredLength = Number(res.headers.get('content-length') ?? '0');
    if (declaredLength > opts.maxBytes) {
      throw new ValidationError(`content too large (${declaredLength} bytes)`);
    }

    const reader = res.body?.getReader();
    let received = 0;
    let text = '';
    if (reader) {
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        text += decoder.decode(value, { stream: true });
        if (received > opts.maxBytes) {
          await reader.cancel().catch(() => undefined);
          return { finalUrl: currentUrl.toString(), status: res.status, contentType, text: text.slice(0, opts.maxBytes), truncated: true };
        }
      }
      text += decoder.decode();
    }
    return { finalUrl: currentUrl.toString(), status: res.status, contentType, text, truncated: false };
  }
  throw new ValidationError('unreachable: redirect loop');
}

async function assertPublicHost(url: URL, dnsLookup: typeof lookup): Promise<void> {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new ValidationError(`blocked hostname: ${hostname}`);
  }
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new ValidationError(`blocked private address: ${hostname}`);
    }
    return;
  }
  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ValidationError(`hostname does not resolve: ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new ValidationError(`hostname does not resolve: ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new ValidationError(`hostname resolves to a private address`);
    }
  }
}

const HTML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/** Minimal tag-stripping text extraction for research purposes. */
export function htmlToText(html: string, maxChars = 50_000): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
  for (const [entity, char] of Object.entries(HTML_ENTITIES)) {
    text = text.replaceAll(entity, char);
  }
  return text.replace(/\s+/g, ' ').trim().slice(0, maxChars);
}
