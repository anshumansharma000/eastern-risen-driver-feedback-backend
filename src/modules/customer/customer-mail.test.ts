import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomerMailSender, type CustomerMailPayload } from './customer-mail.js';
import { renderCustomerMail } from './customer-mail-template.js';

const payload: CustomerMailPayload = {
  email: 'person@example.com',
  url: 'https://portal.example.com/account/activate#token=secret&source=invite',
  expiresAt: '2026-10-09T10:00:00.000Z',
  kind: 'INVITATION',
};
const config = {
  provider: 'resend' as const,
  apiKey: 'secret-key',
  from: 'Accounts <accounts@example.com>',
  replyTo: 'support@example.com',
};
afterEach(() => vi.unstubAllGlobals());

describe('customer mail providers', () => {
  it('sends provider-neutral invitation content through Resend with a stable retry key', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({ id: 'email-id' })));
    vi.stubGlobal('fetch', request);
    const send = createCustomerMailSender(config);
    await send(payload, 'invitation-123');
    await send(payload, 'invitation-123');
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init!.headers).toMatchObject({
      Authorization: 'Bearer secret-key',
      'Idempotency-Key': 'invitation-123',
    });
    expect(init!.redirect).toBe('error');
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init!.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      from: config.from,
      reply_to: config.replyTo,
      to: [payload.email],
      subject: 'Your customer account invitation',
    });
    expect(body.text).toContain(payload.url);
    expect(body.html).toContain(
      'href="https://portal.example.com/account/activate#token=secret&amp;source=invite"',
    );
    expect(request.mock.calls[1]![1]!.body).toBe(init!.body);
  });

  it('omits an unconfigured reply address and renders recovery instructions', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify({ id: 'email-id' })));
    vi.stubGlobal('fetch', request);
    const withoutReply = { provider: config.provider, apiKey: config.apiKey, from: config.from };
    await createCustomerMailSender(withoutReply)({ ...payload, kind: 'RECOVERY' }, 'recovery-123');
    const body = JSON.parse(request.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('reply_to');
    expect(body.subject).toBe('Reset your customer account password');
    expect(body.text).toContain('Your password will stay unchanged');
  });

  it.each([401, 429, 500])('rejects HTTP %i without exposing provider details', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('secret-key person@example.com', { status })),
    );
    await expect(createCustomerMailSender(config)(payload, 'key')).rejects.toThrow(
      /^MAIL_DELIVERY_FAILED$/,
    );
  });

  it.each(['{}', '{"id":null}', 'invalid-json'])(
    'rejects malformed acceptance responses: %s',
    async (body) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
      await expect(createCustomerMailSender(config)(payload, 'key')).rejects.toThrow(
        /^MAIL_DELIVERY_FAILED$/,
      );
    },
  );

  it('sanitizes network failures, including timeouts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret-key token=secret')));
    await expect(createCustomerMailSender(config)(payload, 'key')).rejects.toThrow(
      /^MAIL_DELIVERY_FAILED$/,
    );
  });

  it('preserves the existing relay contract when switching providers', async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(null, { status: 202 }));
    vi.stubGlobal('fetch', request);
    await createCustomerMailSender({
      provider: 'relay',
      endpoint: 'https://relay.example.com/mail',
      token: 'relay-key',
    })(payload, 'same-key');
    expect(request.mock.calls[0]![0]).toBe('https://relay.example.com/mail');
    expect(
      JSON.parse(request.mock.calls[0]![1]!.body as string) as Record<string, unknown>,
    ).toEqual(payload);
    expect(new Headers(request.mock.calls[0]![1]!.headers).get('Idempotency-Key')).toBe('same-key');
  });
});

describe('customer mail templates', () => {
  it('escapes injected HTML while preserving the original plain-text link', () => {
    const url = 'https://portal.example.com/activate#token="<img src=x>\'';
    const rendered = renderCustomerMail({ ...payload, url });
    expect(rendered.html).not.toContain('<img');
    expect(rendered.html).toContain('&quot;&lt;img src=x&gt;&#39;');
    expect(rendered.text).toContain(url);
  });
  it('rejects executable links and invalid expiration dates', () => {
    expect(() => renderCustomerMail({ ...payload, url: 'javascript:alert(1)' })).toThrow();
    expect(() => renderCustomerMail({ ...payload, expiresAt: 'bad-date' })).toThrow();
  });
});
