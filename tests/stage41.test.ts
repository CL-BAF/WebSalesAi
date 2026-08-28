import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictError } from '../src/domain/errors.js';
import { makeWorld, seedQualifiedLead, sendFirstOutreach } from './helpers/world.js';
import type { World } from './helpers/world.js';
import type { MockEmailProvider } from '../src/outreach/providers/mockEmail.js';
import type { OllamaTransport, OllamaChatRequest, OllamaChatResult } from '../src/agents/ollamaClient.js';

/** Classification transport whose failures can be toggled mid-test. */
function makeTogglingWorld(configOverrides: Record<string, string> = { OUTREACH_ENABLED: 'true' }): { world: World; setClassificationFails: (v: boolean) => void } {
  let classificationFails = false;
  const transport: OllamaTransport = async (req: OllamaChatRequest): Promise<OllamaChatResult> => {
    const isClassify = req.messages.some((m) => m.content.includes('Classify the customer reply'));
    if (isClassify && classificationFails) throw new Error('model transport down');
    if (isClassify) {
      return {
        model: req.model,
        content: JSON.stringify({
          intent: 'question',
          confidence: 0.9,
          summary: 'Customer asked about timeline.',
          extractedRequirements: [],
          suggestedReply: 'Typical timelines are 2-4 weeks once requirements are clear.',
          needsHumanReview: false,
        }),
        usage: {},
      };
    }
    return { model: req.model, content: JSON.stringify({ subject: 'S', body: 'B' }), usage: {} };
  };
  const world = makeWorld({ configOverrides, transport });
  return { world, setClassificationFails: (v) => (classificationFails = v) };
}

describe('Stage 4.1 fixes (H4-1, M4-1..3)', () => {
  test('H4-1: sync transaction interleaved with an open async transaction is refused loudly', async () => {
    const world = makeWorld();
    let releaseA: () => void = () => undefined;
    const gate = new Promise<void>((r) => (releaseA = r));
    const promiseA = world.db.transactionAsync(async () => {
      await gate;
      return 'A';
    });
    // Let A actually BEGIN (it is queued on the async chain) before B tries.
    await new Promise<void>((r) => setTimeout(r, 0));
    // Flow B must be refused, not silently joined into A's open transaction.
    assert.throws(() => world.db.transaction(() => 'B'), ConflictError);
    releaseA();
    assert.equal(await promiseA, 'A');
    // After A completes, B works again.
    assert.equal(world.db.transaction(() => 'B'), 'B');
  });

  test('H4-1: async transactions serialize with each other', async () => {
    const world = makeWorld();
    const order: string[] = [];
    let releaseA: () => void = () => undefined;
    const gate = new Promise<void>((r) => (releaseA = r));
    const a = world.db.transactionAsync(async () => {
      order.push('A-start');
      await gate;
      order.push('A-end');
      return 'A';
    });
    const b = world.db.transactionAsync(async () => {
      order.push('B-start');
      return 'B';
    });
    await Promise.resolve();
    releaseA();
    assert.deepEqual(await Promise.all([a, b]), ['A', 'B']);
    assert.deepEqual(order, ['A-start', 'A-end', 'B-start'], 'async transactions must not interleave');
  });
  test('H4-1: provider failure during outbox send cannot discard concurrent writes', async () => {
    const world = makeWorld({ configOverrides: { OUTREACH_ENABLED: 'true' } });
    const seed = seedQualifiedLead(world);
    const workingSend = world.email.send.bind(world.email) as unknown as MockEmailProvider['send'];
    (world.email as unknown as { send: () => Promise<never> }).send = async () => {
      // Concurrent flow B commits a write while A is "on the network".
      world.suppressions.add('concurrent@example.com', 'email', 'concurrent write', 'test');
      throw new Error('provider exploded');
    };
    const { draft } = await world.outreach.draftOutreach(seed.leadId, { actor: 'agent:sales', actorType: 'agent' });
    await assert.rejects(() => world.outreach.approveDraft(draft.id, 'owner'), /provider exploded/);
    // Flow B's write SURVIVED (no rollback contamination).
    assert.equal(world.suppressions.isSuppressedEmail('concurrent@example.com'), true);
    // Outbox row marked failed; key released so the action is retryable.
    const log = world.outreachRepo.tryGetLogByKey(`outreach:send:${draft.id}`);
    assert.equal(log?.status, 'failed');
    // Restore a working provider; retry completes and lands exactly one email.
    (world.email as unknown as { send: MockEmailProvider['send'] }).send = workingSend;
    const retry = await world.outreach.sendDraft(draft);
    assert.ok(retry.sent);
    assert.equal(world.email.sent.length, 1);
    assert.equal(world.jobs.requireById(seed.jobId).state, 'AWAITING_REPLY');
  });

  test('M4-1: two distinct long-prefix replies produce two provider messages', async () => {
    const world = makeWorld({ configOverrides: { OUTREACH_ENABLED: 'true', OUTREACH_MAX_PER_DOMAIN_PER_DAY: '10' } });
    const seed = seedQualifiedLead(world);
    await sendFirstOutreach(world, seed.leadId);
    const prefix = 'Thanks for your detailed reply about the website project and the requirements you shared with us earlier today.';
    const r1 = await world.outreach.sendConversationReply(seed.leadId, 'Re: A', `${prefix} Answer one about hosting.`);
    const r2 = await world.outreach.sendConversationReply(seed.leadId, 'Re: B', `${prefix} Answer two about pricing timelines.`);
    assert.ok(r1.sent);
    assert.ok(r2.sent);
    assert.equal(world.email.sent.length, 3, 'initial + two distinct replies');
  });

  test('M4-2: classification failure does not orphan the message; retry completes', async () => {
    const { world, setClassificationFails } = makeTogglingWorld();
    const seed = seedQualifiedLead(world);
    await sendFirstOutreach(world, seed.leadId);

    setClassificationFails(true);
    const failed = await world.conversationsService.recordInboundReply({
      fromEmail: 'owner@acmebakery.example.com',
      body: 'What is the timeline for a rebuild?',
      externalId: 'mail-500',
    });
    assert.equal(failed.outcome, 'failed');
    const messageRow = world.db.get<{ processed: number }>("SELECT processed FROM messages WHERE external_id = 'mail-500'");
    assert.equal(messageRow?.processed, 0, 'message must remain unprocessed');

    setClassificationFails(false);
    const retried = await world.conversationsService.recordInboundReply({
      fromEmail: 'owner@acmebakery.example.com',
      body: 'What is the timeline for a rebuild?',
      externalId: 'mail-500',
    });
    assert.equal(retried.outcome, 'processed', 'retry must re-enter the pipeline, not short-circuit as duplicate');
    if (retried.outcome === 'processed') {
      assert.equal(retried.intent, 'question');
      assert.equal(retried.autoReplySent, true);
    }
    const after = world.db.get<{ processed: number }>("SELECT processed FROM messages WHERE external_id = 'mail-500'");
    assert.equal(after?.processed, 1);
  });

  test('M4-3: subaddressed reply matches the lead and is processed', async () => {
    const { world } = makeTogglingWorld({ OUTREACH_ENABLED: 'true', OUTREACH_MAX_PER_DOMAIN_PER_DAY: '10' });
    const seed = seedQualifiedLead(world);
    await sendFirstOutreach(world, seed.leadId);
    const res = await world.conversationsService.recordInboundReply({
      fromEmail: 'owner+newsletter@acmebakery.example.com',
      body: 'Quick question about hosting options?',
      externalId: 'mail-600',
    });
    assert.equal(res.outcome, 'processed', 'subaddressed sender must resolve to the lead');
  });
});
