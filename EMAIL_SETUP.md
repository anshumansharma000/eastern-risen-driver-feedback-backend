# Customer email setup

Invitations and password resets use Resend by default when selected in configuration.
The existing API server checks the database queue every 10 seconds and sends one
message per check. No separate paid worker, scheduler, SDK or database migration is
needed for this email adapter. Existing customer-account migrations must already
be applied. Restart the API after changing configuration.

## 1. Configure Resend

1. Create a [Resend account](https://resend.com/signup).
2. In Domains, add a domain you control. A dedicated subdomain such as
   `notifications.yourdomain.com` is suitable. Add the exact DNS records Resend
   provides and wait for verification. Leave existing inbox MX records alone;
   receiving email through Resend is not required.
3. Disable click and open tracking for this sending domain. Invitation and reset
   links contain private credentials, including a URL fragment that must remain
   intact.
4. In API Keys, create a **Sending access** key restricted to this domain. Copy it
   into the backend's local `.env` or encrypted deployment environment variables.
   Do not put it in frontend configuration or source control.
5. Choose a sender on that verified domain. The sender does not require its own
   mailbox. Set Reply-To to an existing monitored mailbox if replies should reach
   your team. Do not use the `resend.dev` test sender for customer delivery.

References: [domain setup](https://resend.com/docs/dashboard/domains/introduction),
[API keys](https://resend.com/docs/dashboard/api-keys/introduction),
[email API](https://resend.com/docs/api-reference/emails/send-email).

## 2. Fill in the backend environment

Replace the example values with your actual domain, key, reply mailbox and customer
website URL. `CUSTOMER_ACCOUNT_URL` is the customer frontend account base, **not**
the backend API URL: it must serve `/activate` and `/reset-password` underneath it.
If those pages are at the site root, use just the frontend origin.

```dotenv
CUSTOMER_MAIL_PROVIDER=resend
RESEND_API_KEY=re_your_actual_key
CUSTOMER_MAIL_FROM="Eastern Risen <accounts@notifications.yourdomain.com>"
CUSTOMER_MAIL_REPLY_TO=support@yourdomain.com
CUSTOMER_ACCOUNT_URL=https://your-customer-website.com/account
CUSTOMER_MAIL_WORKER_ENABLED=true
CUSTOMER_MAIL_POLL_INTERVAL_MS=10000
```

Reply-To is optional. Leave `CUSTOMER_MAIL_ENDPOINT` and `CUSTOMER_MAIL_TOKEN` blank
when using Resend. Missing required fields fail startup instead of pretending mail
is enabled. Production customer URLs must use HTTPS. Preserve the existing
`DATA_ENCRYPTION_KEY_BASE64`: queued email payloads are encrypted with it.

Local `.env` changes do not configure DigitalOcean. Put the same values in the API
service's runtime environment, mark the API key as a secret, and restart/redeploy.
The worker starts automatically with `npm run dev` or `npm start` when mail is
configured. No extra DigitalOcean component is needed.

## 3. Verify actual delivery

1. Restart the backend after filling the values.
2. Create a fresh invitation to an email address you control from the customer
   access admin screen. Earlier manual invitations were not queued; create a fresh
   one to send automatically. Reinviting revokes the previous pending link.
3. Wait about 10 seconds when the queue is empty. Check Resend's Emails dashboard
   for accepted/delivered/bounced status and check your inbox/spam folder.
4. Open the invitation, set the password, and verify access to the selected
   customer account. Request a password reset and verify that flow too.
5. Check API logs for queue counts or `CUSTOMER_MAIL_DELIVERY_FAILED` /
   `CUSTOMER_MAIL_WORKER_FAILED`. Logs deliberately omit credentials, recipients,
   provider response bodies and access links. Use Resend's dashboard to diagnose
   domain, sender, quota or recipient problems.

For an immediate one-off queue drain, use `npm run customer:mail:deliver` locally
or `node dist/scripts/deliver-customer-mail.js` in production. This sends real
pending emails, up to 50 per run. Normally let the automatic worker handle them.

## Delivery behavior and limits

- The database queue persists across restarts, retries failures with exponential
  backoff (up to eight attempts), and skips revoked, consumed or expired links.
- The automatic worker handles one message per tick to pace low-volume delivery,
  never overlaps its own sends, and waits for its current job during shutdown.
  Database row locks prevent concurrent workers from claiming the same job.
- `SENT` means accepted by the email provider, not delivered to the inbox. Delivery
  and bounce diagnosis currently use the provider dashboard; no webhook is needed.
- Resend deduplicates the same idempotency key for **24 hours**, not indefinitely.
  A crash after provider acceptance followed by a restart more than 24 hours later
  can result in a duplicate email. The invitation/reset token remains single-use.
  See [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys).
- Keep templates and sender settings unchanged while retrying uncertain sends:
  Resend requires the same request body for the same key. After exhausted failures,
  resolve the cause and create a fresh invitation or recovery request.
- On multiple API replicas, aggregate sending rate increases. Keep it within the
  provider's limits. Rate-limit/quota failures go through the existing retry path;
  exhausted jobs require investigation, so monitor the error codes above.

## Switching providers

`CUSTOMER_MAIL_PROVIDER` selects the adapter. Available adapters are `resend` and
`relay`; switching between these requires environment changes and a restart.
Existing deployments with only `CUSTOMER_MAIL_ENDPOINT` / `CUSTOMER_MAIL_TOKEN`
continue to select the relay automatically for compatibility.

A custom relay must accept POST JSON `{email,url,expiresAt,kind}` with bearer
Authorization and `Idempotency-Key`, durably accept/deduplicate before returning
2xx, and format the email. Configure:

```dotenv
CUSTOMER_MAIL_PROVIDER=relay
CUSTOMER_MAIL_ENDPOINT=https://your-relay.example.com/customer-mail
CUSTOMER_MAIL_TOKEN=your_relay_secret
```

Other direct providers require one small adapter implementing `MailTransport`
(`src/shared/mail/types.ts`), provider configuration, and a factory case in
`createCustomerMailSender`. Templates (`customer-mail-template.ts`), invitation
rules, account linking and the queue stay independent of providers. There is no
Resend SDK dependency. A provider switch is not automatic failover: pause sending
and reconcile uncertain deliveries before switching, since idempotency keys are
not shared across providers.

Set `CUSTOMER_MAIL_WORKER_ENABLED=false` if using an external scheduled runner
instead. To return to manual invites, clear the provider and all delivery
credentials (including sender and Reply-To); password recovery then returns 503.
