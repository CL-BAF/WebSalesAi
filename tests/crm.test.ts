import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorldWithClassification, makeWorld, seedQualifiedLead, sendFirstOutreach, classificationPayload } from './helpers/world.js';
import type { World } from './helpers/world.js';

describe('crm reply pipeline', () => {
  let world: World;
  let leadId: string;
  let jobId: string;

  beforeEach(async () => {
    world = makeWorldWithClassification(classificationPayload());
    ({ leadId, jobId } = seedQualifiedLead(world));
    await sendFirstOutreach(world, leadId);
  });

  test('C1: deterministic opt-out leaves full durable evidence', async () => {
    const res = await world.conversationsService.recordInboundReply({
      fromEmail: 'owner@acmebakery.example.com',
      subject: 'Re: Quick question',
      body: 'Please unsubscribe me from your emails. Do not contact me again.',
      externalId: 'mail-001',
      provider: 'mock',
    });
    assert.equal(res.outcome, 'processed');
    if (res.outcome !== 'processed') return;
    assert.equal(res.optOut, true);
    assert.equal(res.via, 'deterministic');

    // (a) optout.recorded audit
    assert.ok(world.audit.listForLead(leadId).some((e) => e.action === 'optout.recorded'));
    // (b) suppression: email AND domain
    assert.equal(world.suppressions.isSuppressedEmail('owner@acmebakery.example.com'), true);
    assert.equal(world.suppressions.isSuppressedDomain('acmebakery.example.com'), true);
    // (c) job transitioned to OPTED_OUT (terminal)
    assert.equal(world.jobs.requireById(jobId).state, 'OPTED_OUT');
    // (d) agent_runs row for the deterministic classification
    const runs = world.runs.listByJob(jobId).filter((r) => r.model === 'deterministic-optout-detector');
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, 'succeeded');
    assert.ok(runs[0]!.outputJson?.includes('opt_out'));
    // further send attempts are guard-blocked
    const resend = await world.outreach.sendConversationReply(leadId, 'Re: hi', 'Hello again');
    assert.equal(resend.sent, false);
  });

  test('opt-out via subaddressed email still matches the suppressed contact (C3)', () => {
    world.suppressions.add('owner@acmebakery.example.com', 'email', 'opt-out', 'inbound-email');
    assert.equal(world.suppressions.isSuppressedEmail('owner+news@acmebakery.example.com'), true);
    assert.equal(world.suppressions.isSuppressedEmail('OWNER@AcmeBakery.Example.com'), true);
  });

  test('webhook replay with same externalId is deduplicated', async () => {
    const input = { fromEmail: 'owner@acmebakery.example.com', subject: 'Re: S', body: 'What is the timeline?', externalId: 'mail-100', provider: 'mock' };
    const first = await world.conversationsService.recordInboundReply(input);
    assert.equal(first.outcome, 'processed');
    const replay = await world.conversationsService.recordInboundReply(input);
    assert.equal(replay.outcome, 'duplicate');
    const conversation = world.conversations.tryGetByLeadAndChannel(leadId, 'email')!;
    assert.equal(world.conversations.listMessages(conversation.id).filter((m) => m.direction === 'inbound').length, 1);
  });

  test('question intent: auto-reply sent, conversation re-awaits reply', async () => {
    const res = await world.conversationsService.recordInboundReply({
      fromEmail: 'owner@acmebakery.example.com',
      body: 'How long would a rebuild take?',
      externalId: 'mail-200',
    });
    assert.equal(res.outcome, 'processed');
    if (res.outcome !== 'processed') return;
    assert.equal(res.intent, 'question');
    assert.equal(res.autoReplySent, true);
    assert.equal(res.transitionsApplied.includes('AWAITING_REPLY'), true);
    assert.equal(world.email.sent.length, 2, 'original + auto-reply');
  });

  test('positive intent with requirements lands in REQUIREMENTS_PENDING and persists requirements', async () => {
    const positive = makeWorldWithClassification(
      classificationPayload({
        intent: 'positive',
        summary: 'Wants a new site.',
        extractedRequirements: [
          { category: 'pages', title: 'Menu page', detail: 'A page showing the full menu' },
          { category: 'functionality', title: 'Online orders', detail: 'Ability to order for pickup' },
        ],
        suggestedReply: 'Great — I will prepare some options.',
      }),
    );
    const seed = seedQualifiedLead(positive);
    await sendFirstOutreach(positive, seed.leadId);
    const res = await positive.conversationsService.recordInboundReply({
      fromEmail: 'owner@acmebakery.example.com',
      body: 'We are interested! We need a menu page and online ordering.',
      externalId: 'mail-300',
    });
    assert.equal(res.outcome, 'processed');
    if (res.outcome !== 'processed') return;
    assert.equal(res.intent, 'positive');
    assert.equal(res.requirementsAdded, 2);
    assert.equal(res.transitionsApplied[res.transitionsApplied.length - 1], 'REQUIREMENTS_PENDING');
    assert.equal(positive.jobs.requireById(seed.jobId).state, 'REQUIREMENTS_PENDING');
    const reqs = positive.requirements.listByJob(seed.jobId);
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0]!.source, 'customer_reply');
    assert.ok(positive.audit.listForJob(seed.jobId).some((e) => e.action === 'requirements.updated'));
  });

  test('negative intent flags human review and sends nothing', async () => {
    const negative = makeWorldWithClassification(classificationPayload({ intent: 'negative', summary: 'Not interested.' }));
    const seed = seedQualifiedLead(negative);
    await sendFirstOutreach(negative, seed.leadId);
    const res = await negative.conversationsService.recordInboundReply({
      fromEmail: 'owner@acmebakery.example.com',
      body: 'Not interested, thanks.',
      externalId: 'mail-400',
    });
    assert.equal(res.outcome, 'processed');
    if (res.outcome !== 'processed') return;
    assert.equal(res.flaggedForHumanReview, true);
    assert.equal(res.autoReplySent, false);
    assert.equal(negative.jobs.requireById(seed.jobId).state, 'NEEDS_HUMAN_REVIEW');
  });

  test('unknown sender is rejected with audit', async () => {
    const res = await world.conversationsService.recordInboundReply({ fromEmail: 'stranger@nowhere.example', body: 'hi', externalId: 'x1' });
    assert.equal(res.outcome, 'unknown_sender');
    assert.ok(world.audit.listRecent(10).some((e) => e.action === 'webhook.rejected'));
  });

  test('plain makeWorld helper works for other suites', () => {
    const w = makeWorld();
    assert.equal(w.config.outreach.requireApproval, true);
  });
});
