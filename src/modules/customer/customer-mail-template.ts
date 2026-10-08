import type { MailMessage } from '../../shared/mail/types.js';
import type { CustomerMailPayload } from './customer-mail.js';

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character]!,
  );
}

/** Deterministic content keeps retries compatible with provider idempotency checks. */
export function renderCustomerMail(payload: CustomerMailPayload): MailMessage {
  const url = new URL(payload.url);
  const expiresAt = new Date(payload.expiresAt);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !Number.isFinite(expiresAt.getTime()) ||
    !['INVITATION', 'RECOVERY'].includes(payload.kind)
  ) {
    throw new Error('INVALID_CUSTOMER_MAIL_PAYLOAD');
  }
  const invitation = payload.kind === 'INVITATION';
  const subject = invitation
    ? 'Your customer account invitation'
    : 'Reset your customer account password';
  const introduction = invitation
    ? 'You have been invited to access a customer account. Follow the link to accept your invitation.'
    : 'We received a request to reset your customer account password. Follow the link to choose a new password.';
  const action = invitation ? 'Accept invitation' : 'Reset password';
  const expiry = `This single-use link expires at ${expiresAt.toISOString().replace('T', ' ').replace('.000Z', ' UTC')}.`;
  const footer = invitation
    ? 'If you were not expecting this invitation, you can ignore this email. Do not forward this link.'
    : 'If you did not request this reset, you can ignore this email. Your password will stay unchanged. Do not forward this link.';
  return {
    to: payload.email,
    subject,
    text: `${introduction}\n\n${action}: ${payload.url}\n\n${expiry}\n\n${footer}`,
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${subject}</title></head><body style="font-family:Arial,sans-serif;line-height:1.6;color:#182230"><main style="max-width:560px;margin:32px auto;padding:24px"><h1 style="font-size:24px">${subject}</h1><p>${introduction}</p><p><a href="${escapeHtml(payload.url)}" style="display:inline-block;background:#175cd3;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">${action}</a></p><p>${expiry}</p><p>If the button does not work, copy this link into your browser:</p><p style="overflow-wrap:anywhere">${escapeHtml(payload.url)}</p><p>${footer}</p></main></body></html>`,
  };
}
