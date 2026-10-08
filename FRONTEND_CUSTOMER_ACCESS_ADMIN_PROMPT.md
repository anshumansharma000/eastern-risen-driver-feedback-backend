# Implementation prompt: Eastern Risen admin customer access management

Implement the minimal customer account access controls in the existing Eastern Risen admin frontend. Work within this repository's current architecture, design system, API client, staff authentication, routing and tests. Inspect the actual app before editing. This is an implementation task, not a proposal. Complete the UI, integration and relevant checks.

The backend extension is implemented. This prompt includes the complete contracts needed for this admin feature; it is self-contained. Do not infer new endpoints or change backend behaviour. Existing staff/booking/billing flows must continue. Do not create a separate frontend or modify driver feedback.

## Product model

A billing customer is an existing AGENT, CORPORATE or LEISURE record. A user is an individual with their own sign-in. A membership connects that user to the customer. Every membership has one standard access level: all customer-visible historical/future bookings and billing, quote acceptance, payment initiation. Membership is not a staff role. Multiple users per customer and multiple memberships per user are supported; no customer-managed teams or role picker.

Only CORE_ADMIN manages access. CORE_DATA_ENTRY and CORE_REPORT_VIEWER must not receive these controls. Backend enforces this; hide/disable navigation accordingly. Do not reinterpret issuing-company records as corporate customer accounts.

## Placement and staff workflow

Add an “Account access” section/tab to the existing customer detail experience. If there is no customer detail route, use the existing customer edit/detail drawer pattern. Keep the existing customer master form intact. Show customer name/category and explain that invited contacts can see this customer's full customer-visible history and act commercially.

Provide:

1. A memberships table: person's display name, email, account status, granted date, access status and Revoke access for active memberships.
2. An invitations table/list: name, email, created/expiry date and derived state. Support Resend and Revoke invitation on pending/expired invitations as applicable.
3. An “Invite contact” action with name/email fields. The selected customer is explicit; staff cannot create arbitrary accounts outside a reviewed customer relationship.
4. A creation-result UI for copying the activation URL and displaying its expiry and delivery state.

Revocation confirmation should name the person/customer and explain that previously shared booking links remain valid until rotated separately. Do not automatically rotate all booking links. Keep existing booking-link rotation controls where they already belong.

No public request queue, shared passwords, preset passwords, permission editor or team-admin role. Additional contacts use the same invitation form. To restore revoked access, send a fresh invitation; acceptance grants access again.

## Exact API integration

All staff paths below are relative to `/api/v1/core`. Use the existing staff cookie/client with credentials included; never call customer login to perform staff actions.

- `GET /customers/:customerId/access` → `{data:{memberships,invitations}}`.
- `POST /customers/:customerId/invitations` with `{email,displayName}` → HTTP 201 `{data:{id,email,displayName,expiresAt,activationToken,activationUrl,delivery}}`.
- `DELETE /customers/:customerId/invitations/:invitationId` → HTTP 204.
- `DELETE /customers/:customerId/memberships/:membershipId` → HTTP 204.

Membership fields: `id,accountId,displayName,email,status,createdAt,revokedAt`. `status` is the user's lifecycle status; `revokedAt` determines membership revocation. Distinguish these concepts. Invitation fields: `id,email,displayName,createdAt,expiresAt,consumedAt,revokedAt`. Only the latest 100 invitations are returned. Do not advertise complete invitation-history pagination.

Derive invitation state in order: consumed → accepted; revoked → revoked; expired → expired; otherwise pending. Dates are ISO timestamps. An expired invitation may still be unrevoked in storage; derive expiration using current time.

Resend uses **the same POST invitation endpoint** with that invitation's email and displayName. There is no `/resend` endpoint. It replaces pending invitations for that customer/email with a fresh link. The old link immediately stops working. Creating an invitation for an existing customer user requires their current password at acceptance; it does not reset their password or overwrite their name.

`activationUrl` can be null if deployment has not configured CUSTOMER_ACCOUNT_URL. Show a clear configuration message rather than constructing a guessed URL. `activationToken` is sensitive and returned only on creation; normally copy the supplied URL and do not display the raw token. Never put credentials in local storage, query keys, analytics, console logs, toasts or persistent UI state. Clear result data on modal close. Invitation list endpoints cannot retrieve old raw links; resend creates a fresh one.

`delivery="QUEUED"` means the backend has queued email; say “Invitation queued for email” and offer Copy link. It is not proof of inbox delivery. `MANUAL` means staff must share the link through an authorised existing channel; say “Copy and share this invitation with the verified contact.” Do not automatically send WhatsApp/email from the frontend.

## Interaction and error states

- Validate a nonblank name (max 200), email (max 320) and normalise email input visually without guessing ownership.
- Disable duplicate submissions while pending; do not blindly retry invitation POST because each success rotates the pending credential.
- Refresh access data after create/resend/revoke. Handle empty memberships/invitations and loading/error states.
- 401: existing staff sign-in recovery. 403 CORE_ACCESS_REQUIRED: no account access administration permission.
- 404 CUSTOMER_UNAVAILABLE: customer missing/inactive where applicable. INVITATION_NOT_FOUND/MEMBERSHIP_NOT_FOUND: refresh stale UI.
- 409 CUSTOMER_ALREADY_HAS_ACCESS: show existing access; no new invitation is necessary.
- 409 CUSTOMER_EMAIL_UNAVAILABLE: that email belongs to an incompatible/disabled account; ask staff to use an appropriate customer identity or investigate. Do not convert a staff account.
- 429: show rate limit and allow retry later.
- Use `error.message`, `error.details` and request ID through existing error components; never expose raw backend internals.

Customer masters must be ACTIVE for new invitations. Inactive/archived customers hide customer account data even if a membership exists. Preserve staff access-history visibility and explain why Invite is unavailable for inactive customers.

## Verification and delivery

Use meaningful frontend tests for CORE_ADMIN-only controls, API payloads, state derivation, resend replacing links, revocation messaging, 204 handling, QUEUED versus MANUAL, null activation URL and credential cleanup. Verify keyboard accessibility, mobile layout, long customer/contact names and dates. Confirm existing staff booking-link sharing/rotation and billing pages remain functional.

Do not use mock success states in production. Do not add new backend APIs or rename existing staff authentication. Deliver working changes, summarise checks, and identify any real deployment prerequisite (API base/CORS/account URL). Keep sensitive invitation links out of screenshots or committed fixtures.

## Self-contained transport, validation and error contract

The contract below is included directly in this prompt. A separate backend document is not needed to implement this feature. All example identities, URLs and identifiers are fictitious; use the frontend's actual configured API origin.

### HTTP conventions

- Compose requests using the existing API client. Full paths shown here begin with `/api/v1`; do not prepend `/api/v1` a second time if the existing base URL already includes it.
- Use HTTPS in production, `credentials: 'include'`, and `Content-Type: application/json` for requests that have JSON bodies. Never manually set Cookie, Origin or Referer headers in browser code.
- A successful ordinary response is `{ "data": ... }`. A collection may also have top-level `pagination`. HTTP 204 has **no body**: never call `response.json()` on it. HTTP 202 means the server accepted the request, not that email reached an inbox or a payment succeeded.
- Every API response carries `x-request-id`. A caller may supply an existing correlation ID using that header; it is not an authentication credential. Cross-origin browsers may not be able to read this header unless exposed by deployment; error bodies contain the request ID directly. Do not depend on reading response Set-Cookie headers; the browser manages HttpOnly cookies.
- Account/access responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Exclude them from static generation, shared CDN response caches and service-worker/offline storage. Public marketing pages may keep their existing cache policy.
- Frontend access checks improve UX; the backend independently checks session role, membership, customer status and record ownership. Never fall back to a staff endpoint if a customer request fails.
- Send only the documented body keys. Extra body keys are rejected, not silently ignored. Name/password/email validation errors should be mapped to the actual form field. Treat unknown future response fields or status strings gracefully.
- UUID parameters require UUID strings. Invitation/recovery tokens require exactly 43 URL-safe characters matching `^[A-Za-z0-9_-]{43}$`. Tokens are bearer secrets. Never use the sample token as a credential.
- Date-only values use `YYYY-MM-DD`; display them as calendar dates without shifting them through UTC conversion. Timestamps are ISO date-time strings; display them in the app/user's chosen timezone. Nullable fields really can be null.
- Currency amounts are nonnegative decimal strings with exactly two fractional digits, such as `"100.00"`. Rates are decimal strings and may have a different number of decimal places. Preserve server amounts and format for display; do not use floating-point arithmetic to reconstruct financial totals.

### Shared TypeScript shapes

```ts
type UUID = string;
type ISODateTime = string;
type DateOnly = string;
type Money = string;
type CustomerCategory = 'AGENT' | 'CORPORATE' | 'LEISURE';
type UserStatus = 'ACTIVE' | 'DEACTIVATED' | 'ARCHIVED';
type CustomerMasterStatus = 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';

interface DataResponse<T> {
  data: T;
}
interface Pagination {
  page: number;
  pageSize: number;
  total: number;
}
interface PageResponse<T> {
  data: T[];
  pagination: Pagination;
}

interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
    developerMessage: string;
    details?: unknown;
    requestId: string;
  };
}
interface ValidationDetails {
  fields: Array<{ field: string; message: string; rule: string }>;
}
```

`details` is optional and is not always a validation object. Use a runtime shape check before reading `details.fields`. Render `message` to the user; keep `developerMessage` for developer/support diagnostics rather than displaying raw technical details by default. Never log request bodies containing passwords, tokens or activation URLs.

Example authentication/access failure:

```json
{
  "error": {
    "code": "AUTHENTICATION_REQUIRED",
    "message": "A valid authenticated session is required",
    "developerMessage": "The server rejected the request with error code AUTHENTICATION_REQUIRED.",
    "requestId": "req-example-1"
  }
}
```

Example field validation failure (HTTP 400):

```json
{
  "error": {
    "code": "REQUEST_VALIDATION_FAILED",
    "message": "Please correct the highlighted fields and try again",
    "developerMessage": "One or more request fields failed schema validation. Inspect error.details.fields.",
    "details": {
      "fields": [
        { "field": "body.email", "message": "Enter a valid email address", "rule": "format" }
      ]
    },
    "requestId": "req-example-2"
  }
}
```

Field paths may also be `body.password`, `body.newPassword`, `body.displayName`, `body.quoteVersion`, `body.token`, `params.customerId`, `params.bookingId`, `params.invoiceId`, `querystring.page`, or another path determined by the invalid request. Use the returned path instead of guessing. Validation rule strings include `required`, `format`, `pattern`, `minLength`, `maxLength`, `minimum`, `maximum` and `additionalProperties`.

### Common failures and client handling

| HTTP    | Code                           | Required handling                                                                                                               |
| ------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 400     | REQUEST_VALIDATION_FAILED      | Show mapped field errors and retain nonsensitive form input; do not automatically resubmit.                                     |
| 401     | AUTHENTICATION_REQUIRED        | Session missing, expired or revoked. Clear the relevant signed-in cache and route to that frontend's sign-in.                   |
| 401     | AUTHENTICATION_FAILED          | Credentials invalid/inactive, or wrong current password for an existing-user invitation. Show the appropriate credential error. |
| 403     | ORIGIN_NOT_ALLOWED             | Frontend origin is not allowed for a mutation. Treat as deployment configuration failure; never disable backend origin checks.  |
| 404     | ROUTE_NOT_FOUND                | Wrong URL or backend code not deployed. Distinguish this from a missing business record.                                        |
| 413     | REQUEST_BODY_TOO_LARGE         | Reduce request size; do not retry unchanged.                                                                                    |
| 415     | UNSUPPORTED_MEDIA_TYPE         | Correct Content-Type/request encoding.                                                                                          |
| 429     | RATE_LIMIT_EXCEEDED            | Show a wait state, respect Retry-After if readable/present, and allow later retry.                                              |
| 500     | INTERNAL_SERVER_ERROR          | Show a recoverable error with request ID; no fabricated success.                                                                |
| 502/503 | Provider/service-specific code | Preserve the user's context, explain temporary unavailability and offer a safe retry/contact path.                              |

A proxy or network failure may produce HTML, an empty body or no response instead of the JSON error envelope. Handle JSON parsing/network failures separately, preserve the HTTP status if available, and present a generic connection/service error. Do not mistake parse failure for an empty successful result.

Illustrative transport behaviour (adapt to the existing typed API client rather than adding a competing client):

```ts
async function request<T>(
  url: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T | undefined> {
  const response = await fetch(url, {
    method,
    credentials: 'include',
    cache: 'no-store',
    ...(signal ? { signal } : {}),
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  });
  if (response.status === 204) return undefined;
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(`Unexpected API response (${response.status})`);
  }
  if (!response.ok) {
    // In the real client, create the project's typed API error from a runtime-checked
    // ApiErrorResponse, retaining status, code, message, details and requestId.
    // Do not log the original credential-bearing request body.
    throw new Error(`API request failed (${response.status})`);
  }
  return payload as T;
}
```

## Backend readiness and release instructions

The customer migration `0022_tired_wasp.sql` has been applied to the backend repository's configured managed database. Verification found 23 applied migrations, zero pending migrations, matching latest migration timestamp/hash, the CUSTOMER role, and the invitation/membership/recovery tables. This does not deploy backend application code or enable email delivery by itself. Before frontend rollout, confirm the API deployment includes the customer routes described in this prompt. A ROUTE_NOT_FOUND response for a new endpoint can mean the old backend is still running.

For another environment, backend operators apply the committed migration set through the normal migration job (`npm run db:migrate` locally or the built production migrator). Frontend code must never connect directly to PostgreSQL or run migrations. There is no automated customer backfill: staff grant access deliberately against reviewed existing customer records.

Required backend coordination:

1. Set the actual API origin/base in the frontend's existing environment convention. Never expose DATABASE_URL, the data-encryption key, email bearer secret, or Cashfree secret in client code.
2. Add the exact public website and admin HTTPS origins to the backend `FRONTEND_ORIGINS` allowlist, as appropriate. Credentialed CORS must allow those origins. Include scheme and port where applicable; do not use wildcard origins with credentials.
3. Set `CUSTOMER_ACCOUNT_URL` to the deployed website account base, for example `https://www.example.com/account`. This is a backend setting. The server appends `/activate#token=...` or `/reset-password#token=...`; the matching browser routes must exist and support direct navigation/deep links. Do not guess this base from the admin domain.
4. Customer sessions use `${SESSION_COOKIE_NAME}_customer` (default `id_customer`); existing staff sessions use `${SESSION_COOKIE_NAME}` (default `id`). Both are database-backed HttpOnly cookies. Production uses Secure, SameSite=None and Partitioned; development uses SameSite=Lax without Secure. The frontend should verify actual browser cookie/CORS behaviour in the deployment instead of implementing token storage as a workaround.
5. Default session limits are 72 hours inactivity, 30 days absolute lifetime, rotation every 24 hours and 60 seconds old-token grace. Backend configuration may override these. Follow the actual 401 response; do not predict validity from local timestamps alone.
6. Set `CUSTOMER_MAIL_ENDPOINT`, `CUSTOMER_MAIL_TOKEN` and `CUSTOMER_ACCOUNT_URL` together to enable email queueing. The backend currently has no customer URL/mail settings configured in the inspected repository environment. Treat activation URL/mail readiness as explicit deployment tasks, not assumed live features.
7. Schedule the backend worker `npm run customer:mail:deliver` (production: `node dist/scripts/deliver-customer-mail.js`) at least once per minute. No frontend should invoke it. The configured email service must durably accept authenticated POST JSON `{email,url,expiresAt,kind:"INVITATION"|"RECOVERY"}` and deduplicate by `Idempotency-Key`. The service receives a server-side Authorization bearer secret. The worker retries with backoff, up to eight attempts, skips invalid/expired links, and encrypts queued payloads. No email provider secret belongs in the frontend.
8. With no mail settings, invitations can be shared manually, but self-service recovery returns 503 CUSTOMER_RECOVERY_UNAVAILABLE. `delivery: QUEUED` means queued, not inbox delivery. The API exposes no email-delivery-status polling endpoint, email provider selector, or customer capability endpoint.
9. Online payments require existing backend Cashfree credentials/environment/webhook settings and the website's matching existing checkout environment. The customer extension does not provision provider accounts, refunds, credit notes or pre-invoice advances. Frontend callbacks do not replace server-side verification.
10. Verify deployed backend readiness and the new endpoints before inviting real contacts. Avoid automatically sending invitation/recovery requests or performing real payment smoke tests without the operator's chosen test account and explicit delivery/payment setup.

## Complete admin request/response definitions

The four new staff endpoints use the ordinary staff cookie and require **CORE_ADMIN**. Full URLs are `/api/v1/core/...`. The account-access list is not paginated. All IDs are distinct: customerId identifies the billing customer, accountId identifies the person, membership id identifies that access relationship, and invitation id identifies the invitation. Never interchange them.

```ts
interface Membership {
  id: UUID;
  accountId: UUID;
  displayName: string;
  email: string;
  status: UserStatus;
  createdAt: ISODateTime;
  revokedAt: ISODateTime | null;
}
interface Invitation {
  id: UUID;
  email: string;
  displayName: string;
  expiresAt: ISODateTime;
  consumedAt: ISODateTime | null;
  revokedAt: ISODateTime | null;
  createdAt: ISODateTime;
}
interface CustomerAccess {
  memberships: Membership[];
  invitations: Invitation[];
}
interface InviteContactRequest {
  email: string;
  displayName: string;
}
interface InviteContactResult {
  id: UUID;
  email: string;
  displayName: string;
  expiresAt: ISODateTime;
  activationToken: string;
  activationUrl: string | null;
  delivery: 'QUEUED' | 'MANUAL';
}
```

### Read access

`GET /api/v1/core/customers/:customerId/access`, no body/query parameters. HTTP 200 `DataResponse<CustomerAccess>`. It can list history for an inactive/archived customer. Memberships are not promised a server sort order; choose a stable local ordering if needed. Invitations are sorted newest first and capped at the latest 100.

```json
{
  "data": {
    "memberships": [
      {
        "id": "11111111-1111-4111-8111-111111111111",
        "accountId": "22222222-2222-4222-8222-222222222222",
        "displayName": "Example Contact",
        "email": "contact@example.com",
        "status": "ACTIVE",
        "createdAt": "2026-10-05T09:00:00.000Z",
        "revokedAt": null
      }
    ],
    "invitations": [
      {
        "id": "33333333-3333-4333-8333-333333333333",
        "email": "another@example.com",
        "displayName": "Another Contact",
        "expiresAt": "2026-10-08T09:00:00.000Z",
        "consumedAt": null,
        "revokedAt": null,
        "createdAt": "2026-10-05T09:00:00.000Z"
      }
    ]
  }
}
```

No user password/hash, invitation token/hash, billing record or private booking token is returned here. Do not attempt to retrieve an old raw activation URL from this list.

### Invite, resend and restore access

`POST /api/v1/core/customers/:customerId/invitations`, body `InviteContactRequest`.

Validation: email is required, email format, max 320 characters; displayName is required, 1–200 characters and at least one non-whitespace character. Backend trims and lowercases the email and trims the name. Invitation creation is limited to 20 requests/minute per client IP. All parameters are UUIDs.

```json
{ "email": "another@example.com", "displayName": "Another Contact" }
```

HTTP 201 `DataResponse<InviteContactResult>`:

```json
{
  "data": {
    "id": "33333333-3333-4333-8333-333333333333",
    "email": "another@example.com",
    "displayName": "Another Contact",
    "expiresAt": "2026-10-08T09:00:00.000Z",
    "activationToken": "EXAMPLE_TOKEN_ONLY_012345678901234567890123",
    "activationUrl": "https://www.example.com/account/activate#token=EXAMPLE_TOKEN_ONLY_012345678901234567890123",
    "delivery": "MANUAL"
  }
}
```

The sample token is illustrative only. An actual token is exactly 43 URL-safe characters. If customer URL is unset, activationUrl is null. If configured mail is active, delivery is QUEUED; otherwise MANUAL. This is the only response containing the raw invitation credential.

Invitations expire 72 hours after creation. POST again with the same customer/email/name to resend; the server revokes all prior unconsumed/unrevoked invitations for that customer/email and creates a new one. No idempotency key is required or supported for invitations. Do not automatically retry this mutation on a timeout: it may already have committed. Reload the list and offer an explicit resend if the creation result was lost.

A customer user who already exists receives an invitation to add membership and must enter their current customer password to accept. A revoked membership is reactivated after a fresh invitation is accepted. Existing active membership is a conflict, not a request to reset credentials. Nothing creates an active login before activation. Staff must verify the intended contact and the entire history association before sharing the bearer link.

### Revoke invitation

`DELETE /api/v1/core/customers/:customerId/invitations/:invitationId`, no body. HTTP 204, no JSON. The backend revokes an unconsumed invitation; expired invitations may also be revoked. A consumed invitation cannot be revoked through this endpoint: refresh and use membership revocation if the intended outcome is removing established access. A wrong-customer/unknown/consumed invitation returns INVITATION_NOT_FOUND. An already revoked unconsumed invitation can still return 204; do not rely on it returning 404.

### Revoke membership

`DELETE /api/v1/core/customers/:customerId/memberships/:membershipId`, no body. HTTP 204, no JSON. The backend timestamps revocation and revokes pending invitations for that customer/email. It does not delete the user, remove their other memberships, delete business history, reset their password, or invalidate independent booking links. Repeating a valid membership revocation may return 204 again; refresh state after completion. Wrong customer/membership gives MEMBERSHIP_NOT_FOUND.

No PATCH membership, direct grant-to-accountId, global user disable, email-change, or public registration endpoint is part of this feature. Use invitations/revocation and existing staff customer-master management.

### Existing staff session and customer-master contracts

Reuse the existing staff authentication. `POST /api/v1/auth/core/login` accepts `{username,password}` (username can be email; length 1–320; password length 1–128) and returns `{data:{user:{accountId,role,displayName,driverId},expiresAt}}` with the normal cookie. `GET /api/v1/auth/me` returns `{data:{user:{accountId,role,displayName,driverId}}}`. `POST /api/v1/auth/logout` returns 204. CORE_ADMIN, CORE_DATA_ENTRY and CORE_REPORT_VIEWER can sign into Core; only CORE_ADMIN can use these new access endpoints. ADMIN/DRIVER/CUSTOMER do not acquire Core access through these screens. Do not add CUSTOMER to staff user-provisioning role choices.

Use the existing customer list/detail/master editor for onboarding. Supporting endpoints:

- `GET /api/v1/core/customers?page=1&pageSize=25&status=ACTIVE&category=CORPORATE&q=example` → `PageResponse<CustomerMaster>`. Filters are optional; page integer 1–1,000,000; pageSize 1–100; status/category use their documented literals; q max 80 is a literal case-insensitive substring. Default page 1/pageSize 25.
- `GET /api/v1/core/customers/:id` → `DataResponse<CustomerMaster>`.
- `POST /api/v1/core/customers` → HTTP 201 `DataResponse<CustomerMaster>`; reuse existing editor.
- `PUT /api/v1/core/customers/:id` → HTTP 200 `DataResponse<CustomerMaster>`; includes the current integer `version` >=1 and replacement master payload. This is PUT, not PATCH. Omitting optional master fields on replacement can clear them; retain the existing editor's complete-value behaviour.

```ts
interface CustomerMaster {
  id: UUID;
  name: string;
  category: string; // current values: AGENT, LEISURE, CORPORATE
  status: CustomerMasterStatus;
  version: number;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
  phone: string | null;
  mobileNumber: string | null;
  email: string | null;
  contactPerson: string | null;
  pan: string | null;
  serviceTaxNumber: string | null;
  gstNumber: string | null;
  market: string | null; // current values: DOMESTIC, INTERNATIONAL, null
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}
interface CustomerMasterRequest {
  name: string; // nonblank, 1–2000 characters
  category: CustomerCategory;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  postalCode?: string | null;
  phone?: string | null;
  mobileNumber?: string | null;
  email?: string | null; // valid email, max 320 when present
  contactPerson?: string | null;
  pan?: string | null;
  serviceTaxNumber?: string | null;
  gstNumber?: string | null;
  market?: 'DOMESTIC' | 'INTERNATIONAL' | null;
  status?: CustomerMasterStatus; // create defaults ACTIVE
}
// Optional text master fields above accept null or text up to 4000 characters.
type CustomerMasterReplacement = CustomerMasterRequest & { version: number };
```

CORE_ADMIN/CORE_DATA_ENTRY can create/update customers; CORE_REPORT_VIEWER can read. These broader customer-master permissions do not confer invitation administration. Keep that distinction in navigation and action handlers. Customer email/contactPerson values are contact information, not proof that a user should receive access; explicit invitations grant it.

### Admin-specific errors

All errors use ApiErrorResponse from the shared section.

| HTTP | Code                                                                     | Trigger and UI handling                                                                                        |
| ---- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 403  | CORE_ACCESS_REQUIRED                                                     | Signed-in user lacks CORE_ADMIN for access controls. Remove/disable actions and show permission state.         |
| 404  | CUSTOMER_UNAVAILABLE                                                     | Customer missing; for invite, also inactive/archived. Refresh customer state and stop invitation.              |
| 404  | INVITATION_NOT_FOUND                                                     | Unknown/wrong-customer/consumed invitation. Refresh; do not claim access was revoked.                          |
| 404  | MEMBERSHIP_NOT_FOUND                                                     | Unknown/wrong-customer membership. Refresh the access list.                                                    |
| 409  | CUSTOMER_ALREADY_HAS_ACCESS                                              | This email already has unrevoked membership. Show existing access and offer appropriate management.            |
| 409  | CUSTOMER_EMAIL_UNAVAILABLE                                               | Email belongs to a staff/driver identity or non-active user. Do not change roles or reactivate users silently. |
| 404  | CORE_NOT_FOUND                                                           | Existing customer-master or booking record missing. Use existing master/detail error UI.                       |
| 409  | STALE_VERSION                                                            | Existing master changed since edit. Reload/review before PUT.                                                  |
| 409  | CORE_RECORD_CONFLICT                                                     | Existing master operation hit a unique identifier conflict. Use existing conflict feedback.                    |
| 422  | CORE_REFERENCE_INVALID / CORE_CONSTRAINT_FAILED / CORE_VALIDATION_FAILED | Existing Core master/business validation failure. Preserve user input and correct the issue.                   |
| 503  | CORE_DATABASE_ERROR                                                      | Existing Core persistence temporarily unavailable. Show support request ID.                                    |

Customer-access routes use their explicit errors and the common application handler; do not assume every persistence failure in that namespace is translated to CORE_RECORD_CONFLICT/CORE_DATABASE_ERROR. Handle unexpected 500 safely. Do not hardcode message wording as control flow; use HTTP status and code.

### Admin state, caching and acceptance criteria

Key all access queries by customerId. Cancel/ignore pending responses when the selected customer changes; an invite modal must retain its explicit customer association. An invitation for one customer must never appear in another customer's copy dialog. Clear raw activation data after dismissal and before switching customers; make sensitive mutation results nonpersistent even if your query library supports persisted caches.

Derive membership access from revokedAt and user status; a null revokedAt is not proof of effective access when the customer master is inactive/archived. Derive invitation status with consumed precedence, then revoked, then expiry, then pending. Show times in the existing app timezone and keep countdowns consistent after long-open tabs.

For the primary staff journey: select reviewed ACTIVE customer → invite named contact → show manual/queued state and copy URL → refresh → invitation becomes accepted after customer activation → membership appears → revoke access → membership becomes revoked while booking history stays intact. For restore: invite same contact again → they accept with their current password → refresh to active membership. For stale revoke/timeout, refresh and explain actual server state.

Test full response examples, request validation fields, no-body 204, permission gating, null activationUrl, QUEUED not presented as delivered, unknown future user status, two simultaneous customer views, missing API deployment, and network failure after invitation POST. Keep the existing link-generation UI functional:

- `POST /api/v1/core/commercial-bookings/:id/rotate-link` (existing staff write permission) returns `{data:{accessToken}}` and invalidates the old booking token. This token is unrelated to an invitation token.
- Preserve the existing frontend booking-link URL formatter/host. The backend returns a booking token, not a universal public website URL. Do not rebuild legacy URLs from CUSTOMER_ACCOUNT_URL.

Never add automatic outbound messaging or real customer invitations just to verify UI. Run frontend checks and document actual API/CORS/activation-route settings needed by operators.
