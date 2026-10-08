import { createResendTransport } from '../../shared/mail/resend.js';
import type { CustomerMailConfig } from '../../shared/mail/types.js';
import { renderCustomerMail } from './customer-mail-template.js';
import { and, eq, gt, inArray, isNull, lt, lte } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import { authAccounts, outboxMessages } from '../../database/schema/index.js';
import type { FieldEncryptor } from '../../shared/security/field-encryption.js';
import { customerInvitations, customerRecoveryTokens } from './customer.schema.js';

export interface CustomerMailPayload {
  email: string;
  url: string;
  expiresAt: string;
  kind: 'INVITATION' | 'RECOVERY';
}
export type CustomerMailSender = (
  payload: CustomerMailPayload,
  idempotencyKey: string,
) => Promise<void>;

export function createCustomerMailSender(config: CustomerMailConfig): CustomerMailSender {
  switch (config.provider) {
    case 'resend': {
      const transport = createResendTransport(config);
      return (payload, key) => transport(renderCustomerMail(payload), key);
    }
    case 'relay':
      return createRelaySender(config);
  }
}

/** Relay must accept the message durably and deduplicate by Idempotency-Key. */
function createRelaySender(config: { endpoint: string; token: string }): CustomerMailSender {
  return async (payload, idempotencyKey) => {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.token}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('CUSTOMER_MAIL_DELIVERY_FAILED');
  };
}

/** Holding a row lock during a bounded send prevents concurrent workers sending the same job.
 * A crash after delivery retries with the same key; the provider must deduplicate it (Resend: within 24 hours).
 */
export async function deliverCustomerMail(
  db: AppDatabase,
  encryptor: FieldEncryptor,
  send: CustomerMailSender,
  limit = 50,
) {
  let processed = 0,
    sent = 0,
    failed = 0;
  for (let i = 0; i < limit; i++) {
    const outcome = await db.transaction(async (tx) => {
      const now = new Date();
      const [job] = await tx
        .select()
        .from(outboxMessages)
        .where(
          and(
            inArray(outboxMessages.messageType, ['CUSTOMER_INVITATION', 'CUSTOMER_RECOVERY']),
            inArray(outboxMessages.status, ['PENDING', 'FAILED']),
            lt(outboxMessages.attemptCount, 8),
            lte(outboxMessages.nextAttemptAt, now),
          ),
        )
        .orderBy(outboxMessages.createdAt)
        .limit(1)
        .for('update', { skipLocked: true });
      if (!job) return null;
      let valid: boolean;
      if (job.messageType === 'CUSTOMER_INVITATION') {
        const [invitation] = await tx
          .select({ id: customerInvitations.id })
          .from(customerInvitations)
          .where(
            and(
              eq(customerInvitations.id, job.aggregateId),
              isNull(customerInvitations.consumedAt),
              isNull(customerInvitations.revokedAt),
              gt(customerInvitations.expiresAt, now),
            ),
          );
        valid = !!invitation;
      } else {
        const [recovery] = await tx
          .select({ id: customerRecoveryTokens.id })
          .from(customerRecoveryTokens)
          .innerJoin(authAccounts, eq(authAccounts.id, customerRecoveryTokens.accountId))
          .where(
            and(
              eq(customerRecoveryTokens.id, job.aggregateId),
              isNull(customerRecoveryTokens.consumedAt),
              gt(customerRecoveryTokens.expiresAt, now),
              eq(authAccounts.status, 'ACTIVE'),
              eq(authAccounts.role, 'CUSTOMER'),
            ),
          );
        valid = !!recovery;
      }
      if (!valid) {
        await tx
          .update(outboxMessages)
          .set({
            status: 'SENT',
            payloadCiphertext: null,
            processedAt: now,
            lastErrorCode: 'LINK_NO_LONGER_VALID',
          })
          .where(eq(outboxMessages.id, job.id));
        return 'SKIPPED' as const;
      }
      try {
        if (!job.payloadCiphertext) throw new Error('MISSING_MAIL_PAYLOAD');
        const payload = JSON.parse(encryptor.decrypt(job.payloadCiphertext)) as CustomerMailPayload;
        await send(payload, job.idempotencyKey);
        await tx
          .update(outboxMessages)
          .set({
            status: 'SENT',
            payloadCiphertext: null,
            processedAt: now,
            attemptCount: job.attemptCount + 1,
            lastErrorCode: null,
          })
          .where(eq(outboxMessages.id, job.id));
        return 'SENT' as const;
      } catch {
        // Never persist relay responses, email addresses, tokens or encryption errors.
        await tx
          .update(outboxMessages)
          .set({
            status: 'FAILED',
            attemptCount: job.attemptCount + 1,
            lastErrorCode: 'CUSTOMER_MAIL_DELIVERY_FAILED',
            nextAttemptAt: new Date(
              now.getTime() + Math.min(3600000, 60000 * 2 ** job.attemptCount),
            ),
          })
          .where(eq(outboxMessages.id, job.id));
        return 'FAILED' as const;
      }
    });
    if (!outcome) break;
    processed++;
    if (outcome === 'SENT') sent++;
    if (outcome === 'FAILED') failed++;
  }
  return { processed, sent, failed };
}
