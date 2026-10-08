import type { MailTransport, ResendMailConfig } from './types.js';

/** Resend retains idempotency keys for 24 hours. Never log request/response bodies. */
export function createResendTransport(config: ResendMailConfig): MailTransport {
  return async (message, idempotencyKey) => {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({
          from: config.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
          ...(config.replyTo ? { reply_to: config.replyTo } : {}),
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('MAIL_DELIVERY_FAILED');
      const result: unknown = await response.json();
      if (
        !result ||
        typeof result !== 'object' ||
        !('id' in result) ||
        typeof result.id !== 'string' ||
        !result.id
      )
        throw new Error('MAIL_DELIVERY_FAILED');
    } catch {
      // Keep credentials, recipient addresses and access links out of errors/logs.
      throw new Error('MAIL_DELIVERY_FAILED');
    }
  };
}
