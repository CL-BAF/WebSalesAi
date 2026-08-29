import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ResendEmailProvider } from '../src/outreach/providers/resendEmail.js';
import {
  deterministicMessageId,
  verifySvixWebhook,
  signSvixPayload,
  extractSvixHeaders,
} from '../src/outreach/providers/svixVerify.js';
import { ValidationError, ExternalActionError } from '../src/domain/errors.js';
import { makeWorld, seedQualifiedLead, sendFirstOutreach, classificationPayload } from './helpers/world.js';
import { SETTING_KEYS } from '../src/db/repositories/settings.js';
import type { OutboundEmail } from '../src/outreach/emailProvider.js';
import type { OllamaTransport } from '../src/agents/ollamaClient.js';

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type ProviderOpts = ConstructorParameters<typeof ResendEmailProvider>[0];

function makeProvider(fetchImpl: typeof fetch, overrides: Partial<ProviderOpts> = {}): ResendEmailProvider {
  return new ResendEmailProvider({
    apiKey: 're_test_key_123456789',
    from: 'WebSalesAi <replies@sender.example.com>',
    senderDomain: 'sender.example.com',
    delayImpl: async () => undefined,
    retries: 2,
    fetchImpl,
    ...overrides,
  });
}

function classificationTransport(payload: Record<string, unknown>): OllamaTransport {
  return async (req) => {
    if (req.messages.some((m) => m.content.includes('Classify the customer reply'))) {
      return { model: req.model, content: JSON.stringify(payload), usage: {} };
    }
    return { model: req.model, content: JSON.stringify({ subject: 'S', body: 'B' }), usage: {} };
  };
}

const SAMPLE: OutboundEmail = {
  to: 'owner@acmebakery.example.com',
  subject: 'Quick question',
  body: 'Hello body',
  leadId: 'lead_1',
  jobId: 'job_1',
  idempotencyKey: 'outreach:send:draft_1',
};

describe('resend outbound adapter', () => {
  test('posts bearer auth + Idempotency-Key + deterministic Message-ID; returns Message-ID as providerMessageId', async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = '';
    const provider = makeProvider(async (_url, init) => {
      capturedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      capturedBody = String(init?.body);
      return jsonRes({ id: 'resend-uuid-1' });
    });

    const sent = await provider.send(SAMPLE);

    assert.equal(capturedHeaders['authorization'], 'Bearer re_test_key_123456789');
    assert.equal(capturedHeaders['idempotency-key'], SAMPLE.idempotencyKey);
    const expectedMessageId = deterministicMessageId(SAMPLE.idempotencyKey, 'sender.example.com');
    const providerBody = JSON.parse(capturedBody) as Record<string, unknown>;
    assert.equal((providerBody['headers'] as Record<string, string>)['Message-ID'], expectedMessageId);
    assert.equal(sent.providerMessageId, expectedMessageId, 'providerMessageId = deterministic RFC Message-ID (thread identity)');
    assert.equal(providerBody['from'], 'WebSalesAi <replies@sender.example.com>');
    assert.ok(!capturedBody.includes('re_test_key'), 'API key never appears in the payload');
  });

  test('reply emails carry In-Reply-To/References threading headers', async () => {
    let captured = '';
    const provider = makeProvider(async (_url, init) => {
      captured = String(init?.body);
      return jsonRes({ id: 'resend-2' });
    });
    await provider.send({ ...SAMPLE, inReplyToMessageId: '<wsa-parent@sender.example.com>' });
    const headers = (JSON.parse(captured) as { headers: Record<string, string> }).headers;
    assert.equal(headers['In-Reply-To'], '<wsa-parent@sender.example.com>');
    assert.equal(headers['References'], '<wsa-parent@sender.example.com>');
  });

  test('retries bounded on 5xx; 4xx fails fast; API key never leaks in errors', async () => {
    let serverErrorCalls = 0;
    const serverErrorProvider = makeProvider(async () => {
      serverErrorCalls++;
      return jsonRes({ error: 'overloaded' }, 503);
    });
    await assert.rejects(() => serverErrorProvider.send(SAMPLE), /resend http 503/);
    assert.equal(serverErrorCalls, 3, 'initial + 2 retry attempts');

    let clientErrorCalls = 0;
    const clientErrorProvider = makeProvider(async () => {
      clientErrorCalls++;
      return jsonRes({ error: 'validation' }, 422);
    }, { retries: 3 });
    await assert.rejects(() => clientErrorProvider.send(SAMPLE), ExternalActionError);
    assert.equal(clientErrorCalls, 1, 'client errors are never retried');

    const leaky = makeProvider(async () => {
      throw new Error('connection refused to re_test_key_123456789');
    }, { retries: 0 });
    await assert.rejects(
      () => leaky.send(SAMPLE),
      (err: unknown) => {
        assert.ok(!(err as Error).message.includes('re_test_key'), 'API key redacted from errors');
        return true;
      },
    );
  });

  test('A4: Idempotency-Key header capped at 256 chars (24h provider expiry documented); deterministic Message-ID per key', async () => {
    const seenKeys: string[] = [];
    const provider = makeProvider(async (_url, init) => {
      seenKeys.push(Object.fromEntries(new Headers(init?.headers).entries())['idempotency-key'] ?? '');
      return jsonRes({ id: 'resend-1' });
    }, { retries: 0 });

    const first = await provider.send(SAMPLE);
    const second = await provider.send(SAMPLE);
    assert.equal(first.providerMessageId, second.providerMessageId, 'same idempotency key → same deterministic Message-ID');

    const oversized = { ...SAMPLE, idempotencyKey: 'k'.repeat(400) };
    await provider.send(oversized);
    assert.ok(seenKeys[0]!.length <= 256, 'Idempotency-Key header capped (unique per request, 24h expiry per docs)');
  });
});

describe('svix webhook verification', () => {
  const secret = 'whsec_' + Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64');
  const rotatedSecret = 'whsec_' + Buffer.from('rolled-away-0123456789abcdef0123', 'utf8').toString('base64');
  const payload = JSON.stringify({ type: 'email.received', data: { email_id: 'e1', from: 'x@y.example' } });
  const id = 'msg_test_0001';

  test('valid signature verifies', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = signSvixPayload(payload, { id, timestamp: ts, signature: '' }, secret);
    const headers = { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${signature}` };
    assert.doesNotThrow(() => verifySvixWebhook(payload, extractSvixHeaders(headers), secret));
  });

  test('tampered payload rejected', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = signSvixPayload(payload, { id, timestamp: ts, signature: '' }, secret);
    const headers = { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${signature}` };
    assert.throws(() => verifySvixWebhook('{"type":"forged"}', extractSvixHeaders(headers), secret), ValidationError);
  });

  test('expired timestamp rejected as replay', () => {
    const oldTs = String(Math.floor(Date.now() / 1000) - 3600);
    const signature = signSvixPayload(payload, { id, timestamp: oldTs, signature: '' }, secret);
    const headers = { 'svix-id': id, 'svix-timestamp': oldTs, 'svix-signature': `v1,${signature}` };
    assert.throws(() => verifySvixWebhook(payload, extractSvixHeaders(headers), secret), /tolerance/);
  });

  test('rotation: any one of multiple v1 signatures validates', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sigNew = signSvixPayload(payload, { id, timestamp: ts, signature: '' }, secret);
    const sigOld = signSvixPayload(payload, { id, timestamp: ts, signature: '' }, rotatedSecret);
    const headers = { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sigNew} v1,${sigOld}` };
    assert.doesNotThrow(() => verifySvixWebhook(payload, extractSvixHeaders(headers), secret));
  });

  test('missing headers, v0-only scheme, wrong secret — all fail closed', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = signSvixPayload(payload, { id, timestamp: ts, signature: '' }, secret);
    assert.throws(() => verifySvixWebhook(payload, extractSvixHeaders({}), secret), /missing svix/);
    assert.throws(
      () => verifySvixWebhook(payload, { id, timestamp: 'abc', signature: `v1,${signature}` }, secret),
      /malformed svix timestamp/,
    );
    // v0-only: the lib finds no matching v1 signature → fails closed.
    assert.throws(
      () => verifySvixWebhook(payload, { id, timestamp: ts, signature: `v0,${signature}` }, secret),
      /signature/i,
    );
    assert.throws(
      () => verifySvixWebhook(payload, { id, timestamp: ts, signature: `v1,${signature}` }, 'whsec_wrongwrongwrongwrongwrong'),
      /signature/i,
    );
  });

  test('missing secret and zero tolerance fail closed', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = signSvixPayload(payload, { id, timestamp: ts, signature: '' }, secret);
    assert.throws(
      () => verifySvixWebhook(payload, extractSvixHeaders({ 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${signature}` }), '', { toleranceSeconds: 60 }),
      /secret/,
    );
    assert.throws(
      () => verifySvixWebhook(payload, { id, timestamp: ts, signature: `v1,${signature}` }, secret, { toleranceSeconds: 0 }),
      /tolerance/,
    );
  });
});

describe('resend provider behind the guard stack + thread routing', () => {
  test('kill switch blocks before the provider; approved send stores the deterministic Message-ID', async () => {
    let providerCalls = 0;
    const inner = makeProvider(async () => jsonRes({ id: 'resend-uuid-1' }));
    const countedProvider = {
      name: inner.name,
      send: async (email: OutboundEmail) => {
        providerCalls++;
        return inner.send(email);
      },
    };
    const world = makeWorld({ configOverrides: { OUTREACH_ENABLED: 'true' }, emailProvider: countedProvider });
    const { leadId, jobId } = seedQualifiedLead(world);

    world.settings.setBool(SETTING_KEYS.outreachKillSwitch, true);
    const { draft } = await world.outreach.draftOutreach(leadId, { actor: 'agent:sales', actorType: 'agent' });
    const blocked = await world.outreach.approveDraft(draft.id, 'owner');
    assert.equal(blocked.sent, false);
    assert.equal(world.jobs.requireById(jobId).state, 'AWAITING_OUTREACH_APPROVAL', 'state preserved on blocked send');
    assert.equal(providerCalls, 0, 'provider must not run while the kill switch is engaged');

    world.settings.setBool(SETTING_KEYS.outreachKillSwitch, false);
    const retry = await world.outreach.sendDraft(draft);
    assert.ok(retry.sent);
    assert.equal(providerCalls, 1, 'exactly one provider call after the guard clears');

    const stored = world.db.get<{ external_id: string }>(
      "SELECT external_id FROM messages WHERE direction = 'outbound' AND external_id LIKE '<wsa-%' LIMIT 1",
    );
    assert.equal(
      stored?.external_id,
      deterministicMessageId(`outreach:send:${draft.id}`, 'sender.example.com'),
      'deterministic Message-ID stored as external_id (thread identity)',
    );
  });

  test('A5: reply from a DIFFERENT sender address routes via thread references to the right lead', async () => {
    const world = makeWorld({
      configOverrides: { OUTREACH_ENABLED: 'true' },
      transport: classificationTransport(classificationPayload()),
      emailProvider: makeProvider(async () => jsonRes({ id: 'resend-uuid-1' })),
    });
    const seed = seedQualifiedLead(world);
    await sendFirstOutreach(world, seed.leadId);
    const stored = world.db.get<{ external_id: string }>(
      "SELECT external_id FROM messages WHERE direction = 'outbound' LIMIT 1",
    );
    assert.ok(stored?.external_id?.startsWith('<wsa-'), 'outbound deterministic Message-ID stored');
    const threadMessageId = String(stored!.external_id).toLowerCase();

    const res = await world.conversationsService.recordInboundReply({
      fromEmail: 'different.alias@acmebakery.example.com',
      subject: 'Re: hello',
      body: 'How long would a rebuild take?',
      externalId: 'inbound-email-1',
      provider: 'resend',
      threadHints: [threadMessageId],
    });
    assert.equal(res.outcome, 'processed');
    if (res.outcome === 'processed') {
      assert.equal(res.leadId, seed.leadId, 'thread resolution must find the original lead');
    }
  });

  test('suppressed contact is blocked before the provider is called', async () => {
    let providerCalls = 0;
    const inner = makeProvider(async () => jsonRes({ id: 'resend-uuid-1' }));
    const countedProvider = {
      name: inner.name,
      send: async (email: OutboundEmail) => {
        providerCalls++;
        return inner.send(email);
      },
    };
    const world = makeWorld({ configOverrides: { OUTREACH_ENABLED: 'true' }, emailProvider: countedProvider });
    const seed = seedQualifiedLead(world);
    world.suppressions.add('owner@acmebakery.example.com', 'email', 'test suppression', 'manual');
    const { draft } = await world.outreach.draftOutreach(seed.leadId, { actor: 'agent:sales', actorType: 'agent' });
    const res = await world.outreach.approveDraft(draft.id, 'owner');
    assert.equal(res.sent, false);
    assert.match(res.reason ?? '', /suppression/i);
    assert.equal(providerCalls, 0, 'suppressed send must never reach the provider');
  });

  test('webhook replay of a PROCESSED message is duplicate (M4-2 carries over to the real provider flow)', async () => {
    const world = makeWorld({
      configOverrides: { OUTREACH_ENABLED: 'true' },
      transport: classificationTransport(classificationPayload()),
    });
    const seed = seedQualifiedLead(world);
    await sendFirstOutreach(world, seed.leadId);
    const input = {
      fromEmail: 'owner@acmebakery.example.com',
      subject: 'Re: hello',
      body: 'What is the timeline for a rebuild?',
      externalId: 'resend-inbound-42',
      provider: 'resend',
    };
    const first = await world.conversationsService.recordInboundReply(input);
    assert.equal(first.outcome, 'processed');
    const replay = await world.conversationsService.recordInboundReply(input);
    assert.equal(replay.outcome, 'duplicate');
  });
});