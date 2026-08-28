import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SETTING_KEYS } from '../src/db/repositories/settings.js';
import { evaluateSendGuards, startOfUtcDay, type SendGuardContext } from '../src/outreach/policy.js';
import { makeWorld, seedQualifiedLead } from './helpers/world.js';


describe('outreach service', () => {
  let world: ReturnType<typeof makeWorld>;
  let leadId: string;
  let jobId: string;

  beforeEach(() => {
    world = makeWorld({ configOverrides: { OUTREACH_ENABLED: 'true' } });
    ({ leadId, jobId } = seedQualifiedLead(world));
  });

  test('draft requires approval by default and moves job to AWAITING_OUTREACH_APPROVAL', async () => {
    const { draft, awaitingApproval } = await world.outreach.draftOutreach(leadId, { actor: 'agent:sales', actorType: 'agent' });
    assert.equal(awaitingApproval, true);
    assert.equal(draft.status, 'pending');
    assert.equal(world.jobs.requireById(jobId).state, 'AWAITING_OUTREACH_APPROVAL');
    assert.ok(world.audit.listForJob(jobId).some((e) => e.action === 'outreach.drafted'));
    assert.equal(world.email.sent.length, 0, 'nothing sent before approval');
  });

  test('approval sends exactly once; duplicate approve and resend are no-ops', async () => {
    const { draft } = await world.outreach.draftOutreach(leadId, { actor: 'agent:sales', actorType: 'agent' });
    const send1 = await world.outreach.approveDraft(draft.id, 'owner');
    assert.ok(send1.sent);
    assert.equal(world.email.sent.length, 1);
    assert.equal(world.jobs.requireById(jobId).state, 'AWAITING_REPLY');
    assert.ok(world.audit.listForJob(jobId).some((e) => e.action === 'outreach.sent'));

    await assert.rejects(() => world.outreach.approveDraft(draft.id, 'owner'), /not pending/);
    const send2 = await world.outreach.sendDraft(draft);
    assert.ok(send2.sent);
    assert.equal(world.email.sent.length, 1, 'idempotency prevents duplicate email');
    assert.equal(world.jobs.requireById(jobId).state, 'AWAITING_REPLY');
  });

  test('rejection returns job to READY_FOR_OUTREACH and sends nothing', async () => {
    const { draft } = await world.outreach.draftOutreach(leadId, { actor: 'agent:sales', actorType: 'agent' });
    world.outreach.rejectDraft(draft.id, 'owner');
    assert.equal(world.jobs.requireById(jobId).state, 'READY_FOR_OUTREACH');
    assert.equal(world.email.sent.length, 0);
    assert.ok(world.audit.listForJob(jobId).some((e) => e.action === 'outreach.rejected'));
  });

  test('kill switch blocks send; job stays in approval state; retry works after clearing', async () => {
    const { draft } = await world.outreach.draftOutreach(leadId, { actor: 'agent:sales', actorType: 'agent' });
    world.settings.setBool(SETTING_KEYS.outreachKillSwitch, true);
    const res = await world.outreach.approveDraft(draft.id, 'owner');
    assert.equal(res.sent, false);
    assert.equal(world.jobs.requireById(jobId).state, 'AWAITING_OUTREACH_APPROVAL', 'state must not advance on blocked send');
    assert.ok(world.audit.listForJob(jobId).some((e) => e.action === 'outreach.blocked'));

    world.settings.setBool(SETTING_KEYS.outreachKillSwitch, false);
    const retry = await world.outreach.sendDraft(draft);
    assert.ok(retry.sent);
    assert.equal(world.email.sent.length, 1);
  });

  test('automation pause blocks send', async () => {
    const { draft } = await world.outreach.draftOutreach(leadId, { actor: 'agent:sales', actorType: 'agent' });
    world.settings.setBool(SETTING_KEYS.automationPaused, true);
    const res = await world.outreach.approveDraft(draft.id, 'owner');
    assert.equal(res.sent, false);
    assert.equal(world.email.sent.length, 0);
  });

  test('OUTREACH_ENABLED=false blocks send even when approved', async () => {
    const disabled = makeWorld({ configOverrides: {} });
    const seed = seedQualifiedLead(disabled);
    const { draft } = await disabled.outreach.draftOutreach(seed.leadId, { actor: 'agent:sales', actorType: 'agent' });
    const res = await disabled.outreach.approveDraft(draft.id, 'owner');
    assert.equal(res.sent, false);
    assert.match(res.reason ?? '', /not enabled/);
  });

  test('suppression added AFTER approval blocks the send at send time (C2)', async () => {
    const { draft } = await world.outreach.draftOutreach(leadId, { actor: 'agent:sales', actorType: 'agent' });
    world.suppressions.add('owner@acmebakery.example.com', 'email', 'opted out elsewhere', 'manual');
    const res = await world.outreach.approveDraft(draft.id, 'owner');
    assert.equal(res.sent, false);
    assert.equal(world.jobs.requireById(jobId).state, 'AWAITING_OUTREACH_APPROVAL', 'no state advance on suppressed send');
    assert.equal(world.email.sent.length, 0);
  });

  test('daily limit blocks the second send', async () => {
    const limited = makeWorld({ configOverrides: { OUTREACH_ENABLED: 'true', OUTREACH_MAX_PER_DAY: '1' } });
    const a = seedQualifiedLead(limited, { websiteUrl: 'https://a.example.com', contactEmail: 'a@a.example.com' });
    const b = seedQualifiedLead(limited, { websiteUrl: 'https://b.example.com', contactEmail: 'b@b.example.com' });
    const da = await limited.outreach.draftOutreach(a.leadId, { actor: 'agent:sales', actorType: 'agent' });
    assert.ok((await limited.outreach.approveDraft(da.draft.id, 'owner')).sent);
    const db2 = await limited.outreach.draftOutreach(b.leadId, { actor: 'agent:sales', actorType: 'agent' });
    const res = await limited.outreach.approveDraft(db2.draft.id, 'owner');
    assert.equal(res.sent, false);
    assert.match(res.reason ?? '', /daily send limit/);
    assert.equal(limited.email.sent.length, 1);
  });

  test('per-contact cooldown blocks COLD outreach to the same contact (replies exempt)', async () => {
    // First cold contact to lead A establishes the cooldown window.
    const first = await world.outreach.draftOutreach(leadId, { actor: 'agent:sales', actorType: 'agent' });
    assert.ok((await world.outreach.approveDraft(first.draft.id, 'owner')).sent);

    // Same contact email, different business/website: a genuine second cold contact.
    const other = seedQualifiedLead(world, {
      businessName: 'Acme Bakery Annex',
      websiteUrl: 'https://acmebakeryshop.example.com',
      contactEmail: 'owner@acmebakery.example.com',
    });
    const { draft } = await world.outreach.draftOutreach(other.leadId, { actor: 'agent:sales', actorType: 'agent' });
    const res = await world.outreach.approveDraft(draft.id, 'owner');
    assert.equal(res.sent, false);
    assert.match(res.reason ?? '', /cooldown/);
    assert.equal(world.email.sent.length, 1, 'no second cold email sent');
  });

  test('refuses to email a lead that was never contacted', async () => {
    await assert.rejects(() => world.outreach.sendConversationReply(leadId, 'Hello', 'text'), /never contacted/);
  });

  test('outreach conversation threading: sent mail lands in messages + log', async () => {
    const { draft } = await world.outreach.draftOutreach(leadId, { actor: 'agent:sales', actorType: 'agent' });
    await world.outreach.approveDraft(draft.id, 'owner');
    const conversation = world.conversations.tryGetByLeadAndChannel(leadId, 'email');
    assert.ok(conversation);
    const messages = world.conversations.listMessages(conversation!.id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.direction, 'outbound');
    assert.ok(world.outreachRepo.hasSentToLead(leadId));
  });
});
