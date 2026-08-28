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
  AWAITING_OUTREACH_APPROVAL: ['OUTREACH_SENT', 'LEAD_REJECTED', 'READY_FOR_OUTREACH'],
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

/** Actor types. 'agent' attribution is reserved for AI-driven transitions. */
export type ActorType = 'system' | 'agent' | 'owner' | 'provider';

/**
 * Actor allowlists for PRIVILEGED edges. Transitions not covered by these
 * rules are permitted to any actor type. Enforcement is in the engine —
 * this table is the single source of truth.
 *
 * Design intent:
 *  - money, deployment and human-review-resume gates can NEVER be driven by
 *    an 'agent' actor;
 *  - 'provider' is limited to payment/webhook-sourced truths;
 *  - the deterministic application pipeline acts as 'system'.
 */
export const EDGE_ACTOR_RULES: Readonly<Record<string, readonly ActorType[]>> = {
  'AWAITING_PAYMENT->PAYMENT_CONFIRMED': ['provider', 'owner'],
  'AWAITING_OUTREACH_APPROVAL->OUTREACH_SENT': ['owner', 'system'],
  'READY_FOR_PRODUCTION->DEPLOYING': ['system', 'owner'],
  'DEPLOYING->COMPLETED': ['system', 'owner'],
};

/** All transitions FROM these states are restricted to these actors. */
export const FROM_ACTOR_RULES: Readonly<Partial<Record<WorkflowState, readonly ActorType[]>>> = {
  NEEDS_HUMAN_REVIEW: ['owner'],
};

/** All transitions TO these states are restricted to these actors. */
export const TO_ACTOR_RULES: Readonly<Partial<Record<WorkflowState, readonly ActorType[]>>> = {
  PAYMENT_CONFIRMED: ['provider', 'owner'],
  OPTED_OUT: ['owner', 'system', 'provider'],
  NEEDS_HUMAN_REVIEW: ['owner', 'system'],
  FAILED: ['owner', 'system'],
};

export function isWorkflowState(value: unknown): value is WorkflowState {
  return typeof value === 'string' && (WORKFLOW_STATES as readonly string[]).includes(value);
}

export function isActorAllowed(from: WorkflowState, to: WorkflowState, actorType: ActorType): boolean {
  const edgeKey = `${from}->${to}`;
  const edge = EDGE_ACTOR_RULES[edgeKey];
  if (edge) return edge.includes(actorType);
  const fromRule = FROM_ACTOR_RULES[from];
  if (fromRule && !fromRule.includes(actorType)) return false;
  const toRule = TO_ACTOR_RULES[to];
  if (toRule && !toRule.includes(actorType)) return false;
  return true;
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

export function assertActorAllowed(from: WorkflowState, to: WorkflowState, actorType: ActorType): void {
  if (!isActorAllowed(from, to, actorType)) {
    throw new InvalidTransitionError(from, to, `actor type "${actorType}" is not permitted for this transition`);
  }
}
