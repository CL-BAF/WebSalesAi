import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FetchOllamaTransport } from '../src/agents/ollamaClient.js';
import { ExternalActionError } from '../src/domain/errors.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const okBody = {
  model: 'glm-5.3-flash',
  message: { role: 'assistant', content: '{"ok":true}' },
  prompt_eval_count: 10,
  eval_count: 5,
};

describe('ollama fetch transport', () => {
  test('sends bearer auth when key configured and never leaks it on errors', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return jsonResponse(okBody);
    };
    const transport = new FetchOllamaTransport({ baseUrl: 'https://ollama.example', apiKey: 'sk-secret-key', timeoutMs: 1000, retries: 0, fetchImpl });
    const res = await transport.chat({ model: 'glm-5.3-flash', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.content, '{"ok":true}');
    assert.equal(res.usage.promptTokens, 10);
    assert.equal(res.usage.responseTokens, 5);
    assert.equal(capturedHeaders['authorization'], 'Bearer sk-secret-key');

    const failing: typeof fetch = async () => {
      throw new Error('connection refused to sk-secret-key');
    };
    const transport2 = new FetchOllamaTransport({ baseUrl: 'https://ollama.example', apiKey: 'sk-secret-key', timeoutMs: 1000, retries: 0, fetchImpl: failing });
    await assert.rejects(() => transport2.chat({ model: 'm', messages: [] }), (err: unknown) => {
      assert.ok(err instanceof ExternalActionError);
      const msg = (err as Error).message;
      assert.ok(!msg.includes('sk-secret-key'), 'API key must not leak through transport errors');
      return true;
    });
  });

  test('no auth header when no key configured', async () => {
    let sawAuth = false;
    const fetchImpl: typeof fetch = async (_url, init) => {
      sawAuth = new Headers(init?.headers).has('authorization');
      return jsonResponse(okBody);
    };
    const transport = new FetchOllamaTransport({ baseUrl: 'https://ollama.example', timeoutMs: 1000, retries: 0, fetchImpl });
    await transport.chat({ model: 'm', messages: [] });
    assert.equal(sawAuth, false);
  });

  test('retries bounded on 5xx and gives up with safe error', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return jsonResponse({ error: 'overloaded' }, 503);
    };
    const transport = new FetchOllamaTransport({ baseUrl: 'https://x', timeoutMs: 1000, retries: 2, fetchImpl });
    await assert.rejects(
      () => transport.chat({ model: 'm', messages: [] }),
      (err: unknown) => err instanceof ExternalActionError && /http 503/.test(err.message),
    );
    assert.equal(calls, 3, 'initial + 2 retries');
  });

  test('does not retry on 4xx client errors', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls++;
      return jsonResponse({ error: 'bad request' }, 400);
    };
    const transport = new FetchOllamaTransport({ baseUrl: 'https://x', timeoutMs: 1000, retries: 3, fetchImpl });
    await assert.rejects(() => transport.chat({ model: 'm', messages: [] }), ExternalActionError);
    assert.equal(calls, 1);
  });

  test('sends structured format schema and stream:false', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(okBody);
    };
    const transport = new FetchOllamaTransport({ baseUrl: 'https://x', timeoutMs: 1000, retries: 0, fetchImpl });
    await transport.chat({
      model: 'glm-5.3-flash',
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
      format: { type: 'object' },
      temperature: 0.2,
    });
    assert.equal(capturedBody['stream'], false);
    assert.deepEqual(capturedBody['format'], { type: 'object' });
    const messages = capturedBody['messages'] as unknown[];
    assert.equal(messages.length, 2);
    const options = capturedBody['options'] as Record<string, unknown>;
    assert.equal(options['temperature'], 0.2);
  });
});
