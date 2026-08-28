import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKFLOW_STATES,
  TRANSITIONS,
  TERMINAL_STATES,
  canTransition,
  assertTransition,
} from '../src/domain/workflow.js';
import { InvalidTransitionError } from '../src/domain/errors.js';

describe('workflow state machine', () => {
  test('every defined state has a transition entry and every target is a known state', () => {
    for (const state of WORKFLOW_STATES) {
      const targets = TRANSITIONS[state];
      assert.ok(targets !== undefined, `missing transition entry for ${state}`);
      for (const target of targets) {
        assert.ok(
          (WORKFLOW_STATES as readonly string[]).includes(target),
          `unknown target ${target} from ${state}`,
        );
      }
    }
  });

  test('golden happy path is fully connected', () => {
    const path = [
      'LEAD_DISCOVERED',
      'RESEARCHING',
      'READY_FOR_OUTREACH',
      'AWAITING_OUTREACH_APPROVAL',
      'OUTREACH_SENT',
      'AWAITING_REPLY',
      'CONVERSATION_ACTIVE',
      'INTERESTED',
      'REQUIREMENTS_PENDING',
      'READY_TO_BUILD',
      'BUILDING',
      'REVIEWING',
      'PREVIEW_READY',
      'PREVIEW_SENT',
      'AWAITING_CLIENT_APPROVAL',
      'CLIENT_APPROVED',
      'AWAITING_PAYMENT',
      'PAYMENT_CONFIRMED',
      'READY_FOR_PRODUCTION',
      'DEPLOYING',
      'COMPLETED',
    ] as const;
    for (let i = 0; i < path.length - 1; i++) {
      assert.ok(canTransition(path[i]!, path[i + 1]!), `legal path step ${path[i]} -> ${path[i + 1]} must be allowed`);
    }
  });

  test('illegal transitions are rejected', () => {
    const illegal: Array<[string, string]> = [
      ['LEAD_DISCOVERED', 'COMPLETED'],
      ['LEAD_DISCOVERED', 'OUTREACH_SENT'],
      ['LEAD_DISCOVERED', 'PAYMENT_CONFIRMED'],
      ['AWAITING_PAYMENT', 'DEPLOYING'],
      ['AWAITING_PAYMENT', 'COMPLETED'],
      ['PAYMENT_CONFIRMED', 'DEPLOYING'],
      ['REVIEWING', 'COMPLETED'],
      ['REVIEWING', 'PREVIEW_SENT'],
      ['BUILDING', 'COMPLETED'],
      ['READY_FOR_OUTREACH', 'BUILDING'],
      ['COMPLETED', 'BUILDING'],
      ['LEAD_REJECTED', 'RESEARCHING'],
      ['OPTED_OUT', 'RESEARCHING'],
      ['OPTED_OUT', 'OUTREACH_SENT'],
      ['AWAITING_OUTREACH_APPROVAL', 'CONVERSATION_ACTIVE'],
      ['REQUIREMENTS_PENDING', 'PREVIEW_READY'],
      ['NOT_A_STATE' as string, 'BUILDING'],
      ['BUILDING', 'NOT_A_STATE' as string],
    ];
    for (const [from, to] of illegal) {
      assert.throws(
        () => assertTransition(from as never, to as never),
        InvalidTransitionError,
        `${from} -> ${to} must be illegal`,
      );
      assert.equal(canTransition(from as never, to as never), false);
    }
  });

  test('revision loop and human-review exits are present', () => {
    assert.ok(canTransition('REVIEWING', 'REVISION_REQUIRED'));
    assert.ok(canTransition('REVISION_REQUIRED', 'BUILDING'));
    assert.ok(canTransition('NEEDS_HUMAN_REVIEW', 'BUILDING'));
    assert.ok(canTransition('NEEDS_HUMAN_REVIEW', 'DEPLOYING'));
    assert.ok(canTransition('FAILED', 'BUILDING'));
  });

  test('global guard targets allowed from any non-terminal state', () => {
    const nonTerminal = WORKFLOW_STATES.filter((s) => !TERMINAL_STATES.has(s));
    for (const state of nonTerminal) {
      assert.ok(canTransition(state, 'OPTED_OUT'), `${state} -> OPTED_OUT`);
      assert.ok(canTransition(state, 'NEEDS_HUMAN_REVIEW'), `${state} -> NEEDS_HUMAN_REVIEW`);
      assert.ok(canTransition(state, 'FAILED'), `${state} -> FAILED`);
    }
  });

  test('terminal states accept no transitions at all', () => {
    for (const terminal of TERMINAL_STATES) {
      for (const target of WORKFLOW_STATES) {
        assert.equal(canTransition(terminal, target), false, `${terminal} -> ${target} must be illegal`);
      }
    }
  });

  test('opt-out is possible from the outreach-critical states', () => {
    for (const state of ['AWAITING_OUTREACH_APPROVAL', 'OUTREACH_SENT', 'AWAITING_REPLY', 'CONVERSATION_ACTIVE'] as const) {
      assert.ok(canTransition(state, 'OPTED_OUT'));
    }
  });
});
