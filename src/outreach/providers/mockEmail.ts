import { createHash } from 'node:crypto';
import type { EmailProvider, OutboundEmail, SentEmail } from '../emailProvider.js';

export interface MockEmailRecord extends OutboundEmail {
  providerMessageId: string;
  sentAt: string;
}

/**
 * Mock email provider for development and tests.
 * - Never performs network I/O.
 * - Derives providerMessageId deterministically from the idempotency key, so
 *   retries with the same key cannot duplicate messages.
 * - Keeps a queryable in-memory record of "sent" mail.
 */
export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock';
  readonly sent: MockEmailRecord[] = [];

  async send(email: OutboundEmail): Promise<SentEmail> {
    const providerMessageId = `mock-${createHash('sha256').update(email.idempotencyKey).digest('hex').slice(0, 24)}`;
    const existing = this.sent.find((m) => m.providerMessageId === providerMessageId);
    if (existing) {
      return { providerMessageId, acceptedAt: existing.sentAt };
    }
    const sentAt = new Date().toISOString();
    this.sent.push({ ...email, providerMessageId, sentAt });
    return { providerMessageId, acceptedAt: sentAt };
  }

  reset(): void {
    this.sent.length = 0;
  }

  messagesTo(address: string): MockEmailRecord[] {
    return this.sent.filter((m) => m.to.toLowerCase() === address.toLowerCase());
  }
}
