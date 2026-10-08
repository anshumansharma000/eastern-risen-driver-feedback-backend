# Customer accounts: backend contract and operations

This implements the minimal customer account model agreed for Eastern Risen. The public website hosts the account UI; staff manage access in the existing admin panel. No separate customer frontend deployment is required. Driver feedback is separate. Existing `/api/v1/core/public/bookings/:token` routes and private-link semantics remain available without login.

## Model and access rules

- Existing `core.customers` owns the billing relationship and category (`AGENT`, `CORPORATE`, `LEISURE`). Issuing `core.companies` is not a customer organisation.
- `auth_accounts` adds the `CUSTOMER` role. Each named person has their own email/password and sessions.
- `customer_memberships` links a user to a customer. All active memberships have the same access: customer-visible history and future records, quote acceptance and payment initiation. No team management or permission presets.
- Multiple people may belong to a customer; one person may belong to multiple customers. Do not match records automatically by email, company name, domain, phone, guest identity or booking token.
- Only `CORE_ADMIN` may invite/revoke access. Core data-entry/report users do not gain these controls. Customer identities cannot use staff APIs, and staff identities cannot use customer APIs.
- Customer masters must be `ACTIVE` for account visibility and activation. Inactivating/archiving a master hides its account records; it does not delete history or automatically rotate existing private booking links. Use membership revocation to remove a particular person's access.
- Global email uniqueness and the existing one-role-per-user model remain: an email already used by staff/driver cannot also become a customer identity. Use a different email rather than converting staff privileges.
- No open registration, access-request queue, customer-managed memberships, booking amendments or customer-generated invoices. Existing contact channels handle new access requests.

## Sessions

Customer authentication uses a separate cookie `${SESSION_COOKIE_NAME}_customer` (default `id_customer`). Staff/driver cookies remain unchanged. Frontends use `credentials: 'include'` on every account call and must not store session tokens in browser storage. Session rotation, inactivity/absolute expiry, password hashing, origin protection and production cookie properties reuse existing authentication.

Account APIs have `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Do not cache account responses in a service worker. Configure the public website origin in `FRONTEND_ORIGINS`. Existing staff calls continue to use `/api/v1/auth/*`; customer calls use their own namespace. Password changes/recovery revoke all sessions for that customer identity but not staff sessions.

## Public activation and authentication

All paths below are relative to `/api/v1/customer`. Responses are `{ data: ... }` unless HTTP 204. Errors use the repository error contract (`error.code`, `message`, `developerMessage`, `details?`, `requestId`). Public credential endpoints are limited to five requests per minute per client IP; UI must handle HTTP 429.

| Method | Path                    | Body                  | Success                                                                                                   |
| ------ | ----------------------- | --------------------- | --------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/login`           | `{email,password}`    | 200 `{data:{user:{accountId,role:"CUSTOMER",displayName,driverId:null},expiresAt}}`; sets customer cookie |
| POST   | `/auth/logout`          | None                  | 204; clears only customer cookie                                                                          |
| POST   | `/invitations/context`  | `{token}`             | 200 `{data:{email,displayName,customerName,category,expiresAt,existingUser}}`                             |
| POST   | `/invitations/accept`   | `{token,password}`    | 200 `{data:{customerId}}`; does **not** automatically sign in                                             |
| POST   | `/auth/forgot-password` | `{email}`             | 202 `{data:{message:"If an active customer account exists, recovery instructions will be sent."}}`        |
| POST   | `/auth/reset-password`  | `{token,newPassword}` | 204; clears customer cookie and revokes old sessions                                                      |

Invitations last 72 hours, are bound to the intended email, and can be consumed once. For a new user, password length is 12–128 characters. For an existing customer user, the supplied password must be their **current password** (1–128 characters); activation adds the membership without changing their password or profile. The invitation context indicates which UI is required. An invitation is a bearer credential, not proof that the presenter has independently verified an email; staff must share it only with the verified intended contact.

Recovery tokens last one hour and are single-use. Repeated requests for a known email within 60 seconds do not queue another message. Unknown/inactive/non-customer emails receive the same 202 response when delivery is configured. If delivery is unavailable, **all** recovery requests return 503 `CUSTOMER_RECOVERY_UNAVAILABLE`; never pretend an email was sent. New recovery passwords are 12–128 characters.

Activation/reset links use URL fragments: `${CUSTOMER_ACCOUNT_URL}/activate#token=...` and `/reset-password#token=...`. Read the fragment in the browser and submit the token in a JSON body. Remove the fragment from visible browser history after capturing it in memory. Do not put it into query strings, analytics, logs, local/session storage or return URLs.

## Signed-in customer endpoints

Every route below requires the customer cookie. Membership and active customer status are checked server-side; knowing IDs cannot grant access. Missing/unauthorised records return 404 `CUSTOMER_RECORD_NOT_FOUND`. Staff sessions presented as customer cookies return 403. Expired/missing sessions return 401.

| Method | Path                                                                         | Input                               | Success                                                                   |
| ------ | ---------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------- |
| GET    | `/me`                                                                        | —                                   | `{data:{accountId,displayName,email,status}}`                             |
| PATCH  | `/me`                                                                        | `{displayName}` (nonblank, max 200) | Same profile response; email and customer master fields cannot be changed |
| POST   | `/me/change-password`                                                        | `{currentPassword,newPassword}`     | 204; new password min 12, max 128, must differ from current password      |
| GET    | `/accounts`                                                                  | —                                   | `{data:[{customerId,name,category}]}`                                     |
| GET    | `/accounts/:customerId/bookings`                                             | `page=1&pageSize=25`                | Paginated list; max pageSize 100                                          |
| GET    | `/accounts/:customerId/bookings/:bookingId`                                  | —                                   | Safe booking detail, same projection as private-link detail               |
| POST   | `/accounts/:customerId/bookings/:bookingId/accept`                           | `{quoteVersion}` integer >=1        | `{data:{version,acceptedAt}}`                                             |
| POST   | `/accounts/:customerId/bookings/:bookingId/milestones/:milestoneId/checkout` | —                                   | `{data:{provider,sessionId,orderId,amount}}`                              |
| POST   | `/accounts/:customerId/bookings/:bookingId/orders/:orderId/reconcile`        | —                                   | `{data:{orderId,status}}`, status `PENDING`, `PAID` or `REVIEW_REQUIRED`  |
| GET    | `/accounts/:customerId/invoices`                                             | `page=1&pageSize=25`                | Paginated safe invoice records; max pageSize 100                          |
| GET    | `/accounts/:customerId/invoices/:invoiceId`                                  | —                                   | Safe invoice detail                                                       |

Paginated responses: `{data:[...],pagination:{page,pageSize,total}}`. Booking list items: `{id,reference,title,status,serviceStartsOn,serviceEndsOn}`. `DRAFT` commercial bookings are hidden; quotes move bookings to `QUOTED` and are the current publication mechanism. Date-only values are `YYYY-MM-DD` or null; timestamps are ISO strings. IDs are UUIDs; payment order IDs are `er_` plus 32 lowercase hexadecimal characters.

Booking detail is `{reference,title,status,serviceStartsOn,serviceEndsOn,quote,invoice,paymentReviewRequired,payments,milestones}`. `quote` is null or `{version,description,inclusions,exclusions,terms,total,currency:"INR",expiresOn,acceptedAt}`. `invoice` is null or `{number,date,total,received,due,paymentStatus}`. `payments` are confirmed receipts only: `{number,date,amount,method}`. `milestones`: `{id,position,label,amount,dueOn,paid,remaining}`. No access token, supplier data, internal notes, staff audit details or raw provider payloads.

Invoice records include **all issued/cancelled invoices** for the customer, including those without a commercial booking. Drafts are hidden. Fields:

- `id,number,financialYear,date,status,total,received,adjusted,due,paymentStatus,subtotal,taxTotal,dueDate,guestDisplayText,label`.
- `company` and `customer`: only `name,address,city,state,country,postalCode,gstNumber`; nullable strings from immutable invoice snapshots.
- `paymentInstructions,footerNotes` (nullable); `bankAccounts`: `{name,bankName,accountNumber,branch,ifscCode,swiftCode}` from the issued invoice's selected bank snapshots.
- `lines`: `{position,description,amount,taxTreatment,taxAmount,total,taxes:[{component,rate,amount}]}`.
- `payments`: confirmed receipts only, `{number,date,amount,method}`; no bank instrument or gateway identifiers, pending/reversed receipts or internal adjustment reasons.

Money remains decimal strings; all existing commercial checkout is INR. Preserve server totals/adjustments; do not treat adjustments as payments or calculate a global balance from one paginated page. This release provides invoice data, not a server PDF endpoint, separate receipt-document endpoint or account statement export.

Account quote acceptance requires the displayed `quoteVersion`; if staff have replaced it, 409 `QUOTE_VERSION_CHANGED` requires reload/review. Existing link acceptance contract is unchanged. Both routes share acceptance, checkout, order reuse and verified reconciliation logic. An account never needs a private booking token to act. A payment return/checkout completion is not proof of payment; reconcile and refresh the booking/billing view. Invoice-only records without a commercial schedule cannot use the milestone checkout endpoint.

## Staff access endpoints

Relative to `/api/v1/core`, authenticated with the normal staff cookie; `CORE_ADMIN` only.

| Method | Path                                               | Input                 | Success                                             |
| ------ | -------------------------------------------------- | --------------------- | --------------------------------------------------- |
| GET    | `/customers/:customerId/access`                    | —                     | `{data:{memberships:[...],invitations:[...]}}`      |
| POST   | `/customers/:customerId/invitations`               | `{email,displayName}` | 201 invitation result; also used for resend/regrant |
| DELETE | `/customers/:customerId/invitations/:invitationId` | —                     | 204 revoke pending invitation                       |
| DELETE | `/customers/:customerId/memberships/:membershipId` | —                     | 204 revoke membership                               |

Membership: `{id,accountId,displayName,email,status,createdAt,revokedAt}`. Invitation history (latest 100): `{id,email,displayName,expiresAt,consumedAt,revokedAt,createdAt}`. Token hashes and credentials are never listed. Dates/timestamps are strings.

Invitation creation result: `{id,email,displayName,expiresAt,activationToken,activationUrl,delivery}`. `activationUrl` is null if no customer account URL is configured. `delivery` is `QUEUED` if mail configured, otherwise `MANUAL`. `QUEUED` means queued, **not delivered**. The raw activation credential is returned only on creation; keep it ephemeral and clear it after closing the copy-link UI.

Resend POSTs the same email/name again: it revokes every pending invitation for that customer/email and returns a fresh one. An active existing membership returns 409 `CUSTOMER_ALREADY_HAS_ACCESS`. A revoked membership is restored only after the person accepts a fresh invitation with their current password. Revoking membership also revokes pending invitations for that customer/email, preventing accidental reactivation through an older pending invitation. Wrong customer/membership IDs return 404. Staff email/disabled user collisions return 409 `CUSTOMER_EMAIL_UNAVAILABLE`.

Audit records identify the named customer for authenticated acceptance and checkout. Private-link actions use explicit `LINK_*` action names; the Core audit actor is the booking's staff creator (record custodian), **not** an identified link holder.

## Private-link compatibility

Existing public detail, acceptance, checkout, reconciliation and staff link-rotation endpoints are unchanged. Link possession never claims a customer account. Rotating a link invalidates only its old token; membership continues. Revoking membership does not invalidate independently valid links. For departing contacts, review and rotate previously shared links separately if necessary.

## Deployment and mail delivery

See [EMAIL_SETUP.md](EMAIL_SETUP.md) for Resend domain verification, API keys,
configuration, live delivery verification and provider switching.

```dotenv
CUSTOMER_ACCOUNT_URL=https://your-customer-website.example/account
CUSTOMER_MAIL_PROVIDER=resend
RESEND_API_KEY=re_your_key
CUSTOMER_MAIL_FROM="Eastern Risen <accounts@notifications.yourdomain.com>"
CUSTOMER_MAIL_REPLY_TO=support@yourdomain.com
CUSTOMER_MAIL_WORKER_ENABLED=true
CUSTOMER_MAIL_POLL_INTERVAL_MS=10000
```

The existing API process automatically delivers one queued email every 10 seconds
when mail is configured. No separate scheduler is required. The account URL is the
frontend base without query/fragment; production requires HTTPS. Missing required
mail fields fail startup. Leave provider and all mail credentials blank for manual
invitations; self-service recovery then consistently returns 503.

Resend is behind a provider-neutral transport and shared templates. A `relay`
adapter retains the previous POST `{email,url,expiresAt,kind}` contract with bearer
authentication and `Idempotency-Key`. Existing endpoint/token configurations select
that adapter automatically. Never expose mail credentials to frontend code.
Disable link tracking and preserve the full fragment URL.

The queue retains encrypted payloads, bounded sends, concurrent row locking and
exponential retries (max eight attempts). Resend deduplicates retries for 24 hours;
an uncertain delivery retried after a longer outage can duplicate an email.
`SENT` means provider acceptance, not confirmed inbox delivery. Monitor worker
errors and investigate exhausted failures before creating a fresh invitation or
recovery request. Keep the encryption key backed up.

For external scheduling, disable the built-in worker and schedule
`node dist/scripts/deliver-customer-mail.js` at least once per minute. The one-off
command handles up to 50 jobs and prints only counts. See the setup guide for
provider-switch and retry limitations.

### Payment reconciliation status

Customer order reconciliation returns `orderId`, `status`, `orderStatus`,
`latestAttemptStatus`, `accountingStatus`, `hasUnresolvedAttempts`, `canRetry`, and
`lastCheckedAt`. Handle confirmed failures (`FAILED`, `USER_DROPPED`, `CANCELLED`,
`VOID`) separately from `PENDING`. Show confirmation in progress while
`hasUnresolvedAttempts` is true. A verified `PAID` outcome means the receipt was
applied; `REVIEW_REQUIRED` means staff must resolve the accounting. When `canRetry`
is true, request checkout again; expired/terminated orders need a new checkout.
Always refresh booking details for the current amount due. Background reconciliation
updates outcomes even if the customer closes the page or no webhook is received.
