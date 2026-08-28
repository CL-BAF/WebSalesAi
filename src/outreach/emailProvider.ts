export interface OutboundEmail {
  to: string;
  subject: string;
  body: string;
  leadId: string;
  jobId: string;
  /** Deterministic key — providers must not send twice for the same key. */
  idempotencyKey: string;
  inReplyToMessageId?: string;
}

export interface SentEmail {
  providerMessageId: string;
  acceptedAt: string;
}

/**
 * Outbound email transport interface. MVP ships a mock implementation;
 * SMTP/API providers implement this interface later without touching
 * business logic.
 */
export interface EmailProvider {
  readonly name: string;
  send(email: OutboundEmail): Promise<SentEmail>;
}
