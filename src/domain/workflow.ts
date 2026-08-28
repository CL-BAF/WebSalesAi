import { InvalidTransitionError } from './errors.js';

export const WORKFLOW_STATES = [
  'LEAD_DISCOVERED',
  'RESEARCHING',
  'LEAD_REJECTED',
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
  'REVISION_REQUIRED',
  'PREVIEW_READY',
  'PREVIEW_SENT',
  'AWAITING_CLIENT_APPROVAL',
  'CLIENT_APPROVED',
  'AWAITING_PAYMENT',
  'PAYMENT_CONFIRMED',
  'READY_FOR_PRODUCTION',
  'DEPLOYING',
  'COMPLETED',
  'OPTED_OUT',
  'NEEDS_HUMAN_REVIEW',
  'FAILED',
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<WorkflowState> = new Set<WorkflowState>([
  'COMPLETED',
  'LEAD_REJECTED',
  'OPTED_OUT',
]);

/**
 * Explicit allowed-transition table. A transition is legal only if:
 *  - the target appears in the state's explicit list, OR
 *  - the target is a "global" target (OPTED_OUT / NEEDS_HUMAN_REVIEW / FAILED)
 *    and the source is not terminal.
 */
export const TRANSITIONS: Readonly<Record<WorkflowState, readonly WorkflowState[]>> = {
  LEAD_DISCOVERED: ['RESEARCHING', 'LEAD_REJECTED'],
  RESEARCHING: ['READY_FOR_OUTREACH', 'LEAD_REJECTED', 'FAILED'],
  LEAD_REJECTED: [],
  READY_FOR_OUTREACH: ['AWAITING_OUTREACH_APPROVAL', 'OUTREACH_SENT', 'LEAD_REJECTED'],
  AWAITING_OUTREACH_APPROVAL: ['OUTREACH_SENT', 'LEAD_REJECTED'],
  OUTREACH_SENT: ['AWAITING_REPLY'],
  AWAITING_REPLY: ['CONVERSATION_ACTIVE', 'LEAD_REJECTED'],
  CONVERSATION_ACTIVE: ['INTERESTED', 'AWAITING_REPLY', 'REQUIREMENTS_PENDING'],
  INTERESTED: ['REQUIREMENTS_PENDING'],
  REQUIREMENTS_PENDING: ['READY_TO_BUILD', 'CONVERSATION_ACTIVE'],
  READY_TO_BUILD: ['BUILDING'],
  BUILDING: ['REVIEWING', 'FAILED'],
  REVIEWING: ['PREVIEW_READY', 'REVISION_REQUIRED'],
  REVISION_REQUIRED: ['BUILDING'],
  PREVIEW_READY: ['PREVIEW_SENT'],
  PREVIEW_SENT: ['AWAITING_CLIENT_APPROVAL'],
  AWAITING_CLIENT_APPROVAL: ['CLIENT_APPROVED', 'REVISION_REQUIRED'],
  CLIENT_APPROVED: ['AWAITING_PAYMENT'],
  AWAITING_PAYMENT: ['PAYMENT_CONFIRMED'],
  PAYMENT_CONFIRMED: ['READY_FOR_PRODUCTION'],
  READY_FOR_PRODUCTION: ['DEPLOYING'],
  DEPLOYING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  OPTED_OUT: [],
  NEEDS_HUMAN_REVIEW: [
    'RESEARCHING',
    'READY_FOR_OUTREACH',
    'AWAITING_OUTREACH_APPROVAL',
    'READY_TO_BUILD',
    'BUILDING',
    'REVIEWING',
    'PREVIEW_READY',
    'READY_FOR_PRODUCTION',
    'DEPLOYING',
  ],
  FAILED: ['RESEARCHING', 'READY_TO_BUILD', 'BUILDING', 'REVIEWING', 'DEPLOYING'],
};

/** Targets permitted from ANY non-terminal state (owner / system guards). */
export const GLOBAL_TARGETS: readonly WorkflowState[] = ['OPTED_OUT', 'NEEDS_HUMAN_REVIEW', 'FAILED'];

/** Actor types allowed to use global targets. */
export type ActorType = 'system' | 'agent' | 'owner' | 'provider';

export function isWorkflowState(value: unknown): value is WorkflowState {
  return typeof value === 'string' && (WORKFLOW_STATES as readonly string[]).includes(value);
}

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  if (TERMINAL_STATES.has(from)) return false;
  if (GLOBAL_TARGETS.includes(to)) return true;
  const allowed = TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

export function assertTransition(from: WorkflowState, to: WorkflowState): void {
  if (!isWorkflowState(from) || !isWorkflowState(to)) {
    throw new InvalidTransitionError(String(from), String(to), 'unknown state');
  }
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to, TERMINAL_STATES.has(from) ? 'source state is terminal' : 'not in allowed-transition table');
  }
}
