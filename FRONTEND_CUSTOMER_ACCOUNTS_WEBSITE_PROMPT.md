# Implementation prompt: Eastern Risen website customer account area

Implement customer accounts inside the existing Eastern Risen landing-page website application. Reuse its branding, framework, routing, styling and established API conventions after inspecting the repository. Build a signed-in layout within this application; no fourth frontend/deployment. Preserve public marketing/enquiry pages and every existing shared booking-link route. Do not modify the driver feedback frontend or expose staff screens.

This is an implementation task. The backend is implemented; this prompt includes the complete contracts for the customer website and existing booking links, with no separate document required. Do not invent registration, invitation, PDF, statement-export or booking-mutation endpoints. Complete the actual UI, integration, suitable tests and build.

## Minimal experience

Add “Sign in” / “My account” in the website navigation. Signed-in navigation has Bookings, Billing and Profile. Customers are individual people linked to existing agent/corporate/leisure customer records, all with one standard access level. Their category is descriptive; do not build three separate applications.

Use routes compatible with the configured account base, normally:

- `/account/login`
- `/account/activate`
- `/account/forgot-password`
- `/account/reset-password`
- `/account/bookings` and `/account/bookings/:bookingId`
- `/account/billing` and `/account/billing/:invoiceId`
- `/account/profile`

The API carries customerId explicitly. Select the sole account automatically; if `/accounts` returns several, show a small account selector and clear cached records on switch. The user may choose a preferred account locally, but verify it against the current server response before use. Never use browser state as authorisation. For no memberships, show “You don’t currently have account access. Contact Eastern Risen,” with the existing contact channel and logout available. No empty organisation creation or automatic claims.

No open sign-up. “Need access?” links to the existing contact channel. No shared corporate credentials, permission presets, team management or customer booking edits.

## Authentication and activation

All account API paths below are relative to `/api/v1/customer`. Use `credentials:'include'` on calls; the HttpOnly customer cookie is separate from staff authentication. Do not call `/api/v1/auth/core/login` or store bearer/session tokens. Do not cache account data offline or in service-worker caches. Initialise session with `GET /me`, then `GET /accounts`; 401 means signed out. On logout clear all in-memory queries/account state. Customer logout does not log staff out.

`POST /auth/login` body `{email,password}` returns `{data:{user:{accountId,role:"CUSTOMER",displayName,driverId:null},expiresAt}}`. `POST /auth/logout` returns 204. Show normal invalid-credentials/rate-limit feedback. Validate any return path against your internal account routes and never redirect to arbitrary external URLs.

Activation emails/manual invitations point to `/account/activate#token=...` (account base may differ; deployment must align CUSTOMER_ACCOUNT_URL with actual routes). Capture token from URL fragment into memory, then remove fragment from browser history. Never copy it into query strings, analytics, logs, local/session storage, provider return URLs or persisted state. Reload after fragment removal can require reopening the original link; explain this naturally if needed. Ensure auth pages do not run tracking that captures the original URL.

- `POST /invitations/context` with `{token}` returns `{data:{email,displayName,customerName,category,expiresAt,existingUser}}`.
- Show the intended email and customer name read-only. Explain full customer booking/billing access.
- If `existingUser=false`, ask for a new password plus client-side confirmation (12–128 characters).
- If `existingUser=true`, ask for the **current customer account password**; do not offer a new-password activation form. A person can already have access to another customer. Their identity/profile is preserved.
- `POST /invitations/accept` with `{token,password}` returns `{data:{customerId}}`; it does not establish a session. On success show access activated and lead to sign-in. Do not persist/reuse passwords silently.
- Handle expired/revoked/used invitation with a contact/resend-request message. There is no public resend endpoint.

For forgotten passwords, `POST /auth/forgot-password` with `{email}` returns 202 generic message. Keep UI generic whether an account exists. If 503 CUSTOMER_RECOVERY_UNAVAILABLE, show contact assistance rather than “Email sent.” Reset route captures the fragment token and sends `POST /auth/reset-password` with `{token,newPassword}` (12–128 characters); 204 means reset succeeded and old sessions were revoked. Lead to sign-in. Handle invalid/expired/used reset links and 429. Never simulate email delivery.

## Bookings

`GET /accounts/:customerId/bookings?page=1&pageSize=25` returns `{data:[{id,reference,title,status,serviceStartsOn,serviceEndsOn}],pagination:{page,pageSize,total}}`. Build a paginated booking list with status, travel dates, reference and title. Dates may be null. Completed/cancelled records remain visible; draft commercial records do not. No server search/status filter exists yet; do not make unsupported query requests or imply client-page filters search all history.

`GET /accounts/:customerId/bookings/:bookingId` returns `{data:{reference,title,status,serviceStartsOn,serviceEndsOn,quote,invoice,paymentReviewRequired,payments,milestones}}`.

Display quote description, inclusions, exclusions, terms and decimal-string INR total. Treat content as text; do not render untrusted HTML. Quote fields: `version,description,inclusions,exclusions,terms,total,currency,expiresOn,acceptedAt`. Show missing quote, expired quote, acceptance time and confirmed/cancelled/completed states appropriately.

To accept, explicitly confirm the displayed quote/terms and send `POST /accounts/:customerId/bookings/:bookingId/accept` with `{quoteVersion:displayedQuote.version}`. Response `{data:{version,acceptedAt}}`. A 409 QUOTE_VERSION_CHANGED means reload and ask the user to review the new quote; never autoaccept a replacement. Refresh booking after success.

Invoice summary on the booking: `{number,date,total,received,due,paymentStatus}` or null. Payments: confirmed receipts `{number,date,amount,method}`. Milestones: `{id,position,label,amount,dueOn,paid,remaining}`. Use remaining amount, not original milestone amount, when displaying what checkout will collect. Hide payment actions for paid/cancelled/completed/nonpayable states and show clear review-required status.

## Payments

`POST /accounts/:customerId/bookings/:bookingId/milestones/:milestoneId/checkout` returns `{data:{provider,sessionId,orderId,amount}}`. Integrate the existing Cashfree hosted checkout approach already used by the website/link pages; inspect its actual SDK and environment configuration. Server sessionId corresponds to the Cashfree payment session. Keep provider secrets server-side. Do not add a second payment implementation if shared UI/helpers already exist.

After return/checkout completion, call `POST /accounts/:customerId/bookings/:bookingId/orders/:orderId/reconcile` → `{data:{orderId,status}}`, with PENDING, PAID or REVIEW_REQUIRED. Refresh booking/billing from server. Browser return is not proof of payment. Use bounded retries/backoff, honour rate limits, and offer Refresh/Check payment status for delays. After a page reload the booking detail provides confirmed balances/review state; do not require retaining a private booking token. If retaining order context for return, keep only account/booking/order identifiers, never bearer tokens or session credentials.

Handle PAYMENTS_UNAVAILABLE, BOOKING_NOT_PAYABLE, INVOICE_NOT_ISSUED, MILESTONE_NOT_PAYABLE, PAYMENT_REVIEW_REQUIRED, PAYMENT_ORDER_AMOUNT_CHANGED and PAYMENT_ORDER_PENDING. Staff review states should instruct contact assistance without presenting raw provider details. Disable repeated clicks while checkout starts. Existing simultaneous account/link attempts reuse backend payment orders.

## Billing

`GET /accounts/:customerId/invoices?page=1&pageSize=25` returns safe invoice records and pagination. It includes issued/cancelled invoices without a commercial booking, not just invoices from displayed bookings. `GET /accounts/:customerId/invoices/:invoiceId` returns the same safe detail shape.

The complete types and examples below document: number/year/date/status, total/received/adjusted/due/paymentStatus, subtotal/taxTotal/dueDate, guest text/label, immutable company/customer document fields, selected bank details/instructions, invoice lines with applied taxes, and confirmed receipt summaries. Display cancelled invoices as historical records and do not offer payment against them. Adjustments are not payments. Never compute an account-wide outstanding balance from one paginated page. Use exact decimal strings for money; preserve server-issued totals rather than recomputing tax.

Provide a useful invoice detail page with line/tax breakdown, selected bank payment information and confirmed receipts. The backend does not provide downloadable PDF or receipt documents. If adding browser Print for the invoice, use the supplied customer-safe immutable document data and a clean print stylesheet; do not promise a server document endpoint or fabricate financial fields. Invoice-only records have no direct gateway checkout endpoint; lead to an associated booking only when that relationship is actually known, otherwise existing contact assistance.

## Profile and access changes

`GET /me` returns `{data:{accountId,displayName,email,status}}`. `PATCH /me` accepts only `{displayName}` (nonblank, max 200). Email is read-only in this release. Personal name edits never change company/customer billing identity.

`POST /me/change-password` with `{currentPassword,newPassword}` returns 204 and revokes sessions. Clear frontend caches and return to sign-in. Handle CURRENT_PASSWORD_INVALID/PASSWORD_REUSE_NOT_ALLOWED. No customer-master edits or membership management.

On any 401, clear account data and lead to customer sign-in. On a record 404, show unavailable access and refresh accounts when appropriate; avoid displaying stale data from a removed membership. Account switch/cache keys must include customerId and booking/invoice identifiers. Render 403, 429 and service failures through useful existing error UI with request ID available for support. Never let errors fall back to privileged staff endpoints.

## Preserve private booking links

Existing `/api/v1/core/public/bookings/:token` detail/accept/checkout/reconcile APIs remain unauthenticated and independent. Preserve existing frontend URLs, route handling and provider return URLs. Do not route all booking links through an account login guard. An invitation token is not a booking token; use separate handlers.

Opening a booking link never grants membership or attaches it to a signed-in user's history. Account pages use IDs and membership APIs, never private tokens. Link-based payment must appear in account billing after backend verification. Link rotation does not remove membership; membership revocation does not invalidate the link. Keep legacy links usable even if the public-link component currently lives in another frontend; do not guess a new URL or migrate it without preserving compatibility.

## Verification and delivery

Test activation for new/existing users, expired links, credential cleanup, login/recovery/logout/password change, zero/one/multiple accounts, cache clearing on account switch/revocation, pagination, null dates, stale quote version, delayed/review-required payments and invoice-only history. Verify account data is not cached offline or leaked through tracking. Exercise existing unsigned booking-link acceptance/payment and ensure no forced login.

Use real API integration, existing accessibility/responsive conventions and focused tests; no mock production records or optimistic “paid” messages. Run repository checks/build. Document API base, required credentialed CORS origin, customer account URL alignment and mail-delivery launch prerequisites. The backend migration and account invitations are managed by staff; do not add automatic signup or historical ownership matching.

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

## Complete website request/response definitions

Customer calls use `/api/v1/customer` and the separate customer cookie. Use the full paths below or a correctly configured namespace client. All customer record routes require an active CUSTOMER identity, unrevoked membership, ACTIVE customer master and matching record ownership.

### Authentication, activation and profile types

```ts
interface CustomerPrincipal {
  accountId: UUID;
  role: 'CUSTOMER';
  displayName: string;
  driverId: null;
}
interface CustomerLoginRequest {
  email: string;
  password: string;
}
interface CustomerLoginResult {
  user: CustomerPrincipal;
  expiresAt: ISODateTime;
}
interface CustomerProfile {
  accountId: UUID;
  displayName: string;
  email: string;
  status: string; // active sessions currently return ACTIVE
}
interface CustomerAccount {
  customerId: UUID;
  name: string;
  category: string; // current values AGENT, CORPORATE, LEISURE
}
interface InvitationContext {
  email: string;
  displayName: string;
  customerName: string;
  category: string;
  expiresAt: ISODateTime;
  existingUser: boolean;
}
interface InvitationAccepted {
  customerId: UUID;
}
```

| Method | Full path                               | Request                         | Success                                                   |
| ------ | --------------------------------------- | ------------------------------- | --------------------------------------------------------- |
| POST   | `/api/v1/customer/auth/login`           | `{email,password}`              | 200 `DataResponse<CustomerLoginResult>` + customer cookie |
| POST   | `/api/v1/customer/auth/logout`          | No body                         | 204, no body                                              |
| POST   | `/api/v1/customer/invitations/context`  | `{token}`                       | 200 `DataResponse<InvitationContext>`                     |
| POST   | `/api/v1/customer/invitations/accept`   | `{token,password}`              | 200 `DataResponse<InvitationAccepted>`, no login session  |
| POST   | `/api/v1/customer/auth/forgot-password` | `{email}`                       | 202 `DataResponse<{message:string}>`                      |
| POST   | `/api/v1/customer/auth/reset-password`  | `{token,newPassword}`           | 204, no body; old sessions revoked                        |
| GET    | `/api/v1/customer/me`                   | No body                         | 200 `DataResponse<CustomerProfile>`                       |
| PATCH  | `/api/v1/customer/me`                   | `{displayName}`                 | 200 `DataResponse<CustomerProfile>`                       |
| POST   | `/api/v1/customer/me/change-password`   | `{currentPassword,newPassword}` | 204, no body; old sessions revoked                        |
| GET    | `/api/v1/customer/accounts`             | No body/query                   | 200 `DataResponse<CustomerAccount[]>`                     |

Login email is required, valid email, max 320; password is required, 1–128 characters. For invitation acceptance, the HTTP body accepts password 1–128; new-user activation additionally requires at least 12 in the service. Existing-user invitation acceptance requires the current password and does not enforce a new-password rule. Reset/new password is 12–128 characters; currentPassword is 1–128. Profile displayName is required, nonblank, 1–200. New-password forms have client-side confirmation but the confirmation is never sent as an extra API property. Do not trim passwords.

All public credential/activation endpoints except logout, and authenticated password-change, acceptance/checkout/reconciliation mutations, are limited to five requests/minute per client IP **per route**. Route rate limits are not per customer membership. Logout and ordinary reads/profile-name changes have no extra route-specific limiter in this extension; normal HTTP/deployment protections still apply.

Login example:

```json
{
  "data": {
    "user": {
      "accountId": "22222222-2222-4222-8222-222222222222",
      "role": "CUSTOMER",
      "displayName": "Example Contact",
      "driverId": null
    },
    "expiresAt": "2026-10-08T09:00:00.000Z"
  }
}
```

Profile response differs from login: `/me` has the profile directly in data, not `data.user`, and includes email/status but no expiresAt. `/accounts` example:

```json
{
  "data": [
    {
      "customerId": "44444444-4444-4444-8444-444444444444",
      "name": "Example Corporate",
      "category": "CORPORATE"
    }
  ]
}
```

Invitation context example:

```json
{
  "data": {
    "email": "contact@example.com",
    "displayName": "Example Contact",
    "customerName": "Example Corporate",
    "category": "CORPORATE",
    "expiresAt": "2026-10-08T09:00:00.000Z",
    "existingUser": false
  }
}
```

Invitation acceptance responds only `{ "data": { "customerId": "44444444-4444-4444-8444-444444444444" } }`. It does not return credentials, the email, an account list, or a session. For a fresh browser the user then signs in. If an existing user was already signed in, revalidate `/me` and `/accounts` before navigating; never silently treat the current session as proof it belongs to the invited email. The activation operation itself requires the intended identity's password.

Invitations last 72 hours and reset links last one hour. The exact expiration timestamp is authoritative when available. Forgot-password response is exactly:

```json
{
  "data": {
    "message": "If an active customer account exists, recovery instructions will be sent."
  }
}
```

Unknown/inactive/non-customer email receives the same 202 when delivery is configured. A known email's repeat request within 60 seconds does not queue another message. Every request receives 503 instead when recovery delivery is unconfigured. Profile email is read-only; sending email to PATCH /me is a validation error.

### Bookings, quotes and payment types

```ts
type CommercialBookingStatus =
  'DRAFT' | 'QUOTED' | 'INVOICED' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED';
interface BookingListItem {
  id: UUID;
  reference: string;
  title: string;
  status: string; // current CommercialBookingStatus; DRAFT excluded from account API
  serviceStartsOn: DateOnly | null;
  serviceEndsOn: DateOnly | null;
}
interface Quote {
  version: number;
  description: string;
  inclusions: string;
  exclusions: string;
  terms: string;
  total: Money;
  currency: 'INR';
  expiresOn: DateOnly | null;
  acceptedAt: ISODateTime | null;
}
interface BookingInvoiceSummary {
  number: string | null;
  date: DateOnly;
  total: Money;
  received: Money;
  due: Money;
  paymentStatus: string;
}
interface BookingPayment {
  number: string;
  date: DateOnly;
  amount: Money;
  method: string; // CASH, CHEQUE, DD, CARD, UPI, GATEWAY
}
interface PaymentMilestone {
  id: UUID;
  position: number;
  label: string;
  amount: Money;
  dueOn: DateOnly;
  paid: boolean;
  remaining: Money;
}
interface BookingDetail {
  reference: string;
  title: string;
  status: string;
  serviceStartsOn: DateOnly | null;
  serviceEndsOn: DateOnly | null;
  quote: Quote | null;
  invoice: BookingInvoiceSummary | null;
  paymentReviewRequired: boolean;
  payments: BookingPayment[];
  milestones: PaymentMilestone[];
}
interface QuoteAcceptanceRequest {
  quoteVersion: number;
}
interface QuoteAccepted {
  version: number;
  acceptedAt: ISODateTime;
}
interface CheckoutResult {
  provider: string; // currently cashfree
  sessionId: string;
  orderId: string; // ^er_[a-f0-9]{32}$
  amount: Money;
}
interface ReconciliationResult {
  orderId: string;
  status: string; // PENDING, PAID, REVIEW_REQUIRED
}
```

| Method | Full path                                                                                    | Request/query                | Success                                  |
| ------ | -------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------- |
| GET    | `/api/v1/customer/accounts/:customerId/bookings`                                             | Optional page/pageSize only  | 200 `PageResponse<BookingListItem>`      |
| GET    | `/api/v1/customer/accounts/:customerId/bookings/:bookingId`                                  | None                         | 200 `DataResponse<BookingDetail>`        |
| POST   | `/api/v1/customer/accounts/:customerId/bookings/:bookingId/accept`                           | `{quoteVersion}` integer >=1 | 200 `DataResponse<QuoteAccepted>`        |
| POST   | `/api/v1/customer/accounts/:customerId/bookings/:bookingId/milestones/:milestoneId/checkout` | No body                      | 200 `DataResponse<CheckoutResult>`       |
| POST   | `/api/v1/customer/accounts/:customerId/bookings/:bookingId/orders/:orderId/reconcile`        | No body                      | 200 `DataResponse<ReconciliationResult>` |

List query constraints: page integer >=1; pageSize integer 1–100; default page 1/pageSize 25. No q/search/status/date filters. Extra query keys are rejected. Lists are ordered by creation time descending and then booking ID; no total-outstanding aggregation endpoint. An empty page returns data `[]` and pagination, not 404.

Account booking detail deliberately has **no id, customerId, invoiceId, quoteId or access token**. Retain bookingId/customerId from routing/list context. The booking invoice summary does not contain invoiceId, so do not construct an invoice-detail URL from its number. The billing list supplies actual invoice IDs; for now navigate to Billing rather than guessing a number-to-ID association. Do not fetch staff invoice lookups to resolve this.

Booking example:

```json
{
  "data": {
    "reference": "EXAMPLE-2026-001",
    "title": "Example Odisha Tour",
    "status": "INVOICED",
    "serviceStartsOn": "2026-12-15",
    "serviceEndsOn": "2026-12-20",
    "quote": {
      "version": 1,
      "description": "Example tour itinerary",
      "inclusions": "Hotel and transport",
      "exclusions": "Flights",
      "terms": "Example agreed payment terms",
      "total": "1000.00",
      "currency": "INR",
      "expiresOn": null,
      "acceptedAt": "2026-10-05T09:00:00.000Z"
    },
    "invoice": {
      "number": "I/2627/000001",
      "date": "2026-10-05",
      "total": "1000.00",
      "received": "300.00",
      "due": "700.00",
      "paymentStatus": "PARTIALLY_PAID"
    },
    "paymentReviewRequired": false,
    "payments": [
      { "number": "R/2627/000001", "date": "2026-10-05", "amount": "300.00", "method": "GATEWAY" }
    ],
    "milestones": [
      {
        "id": "55555555-5555-4555-8555-555555555555",
        "position": 1,
        "label": "Initial payment",
        "amount": "300.00",
        "dueOn": "2026-10-05",
        "paid": true,
        "remaining": "0.00"
      },
      {
        "id": "66666666-6666-4666-8666-666666666666",
        "position": 2,
        "label": "Balance",
        "amount": "700.00",
        "dueOn": "2026-11-15",
        "paid": false,
        "remaining": "700.00"
      }
    ]
  }
}
```

A booking list envelope is `{ "data": [{"id":"77777777-7777-4777-8777-777777777777","reference":"EXAMPLE-2026-001","title":"Example Odisha Tour","status":"INVOICED","serviceStartsOn":"2026-12-15","serviceEndsOn":"2026-12-20"}], "pagination":{"page":1,"pageSize":25,"total":1} }`.

Acceptance request `{ "quoteVersion": 1 }` returns `{ "data": { "version": 1, "acceptedAt": "2026-10-05T09:00:00.000Z" } }`. Backend accepts only while booking is QUOTED; repeat acceptance may succeed while still QUOTED, but later INVOICED/CONFIRMED state returns QUOTE_NOT_ACCEPTABLE. Use acceptedAt/status to control the UI. A same-day expiresOn is not expired before the server's UTC date rolls over; the backend remains authoritative for expiry errors. Do not autoaccept after a version conflict.

Checkout example:

```json
{
  "data": {
    "provider": "cashfree",
    "sessionId": "example-payment-session",
    "orderId": "er_1234567890abcdef1234567890abcdef",
    "amount": "700.00"
  }
}
```

The backend passes `sessionId` from Cashfree's `payment_session_id`; use the website's existing hosted checkout helper/SDK mapping. Do not assume the API returns a checkout URL, success URL, paymentId or receiptId. Account reconciliation returns `{ "data": { "orderId": "er_1234567890abcdef1234567890abcdef", "status": "PENDING" } }` (or PAID/REVIEW_REQUIRED); **it has no receiptId**.

Action visibility: acceptance requires a visible unaccepted quote and QUOTED state. Checkout requires an issued linked invoice, INVOICED/CONFIRMED booking, a remaining payable milestone and no paymentReviewRequired. Treat UI visibility as preliminary; re-check error responses because staff may change state or another payment may arrive. Server may collect less than the original milestone amount when partially settled. Display confirmed receipt history separately from unverified attempts.

If the existing frontend uses provider redirect return pages, preserve them and keep only nonsensitive customerId/bookingId/orderId return context. Never put a private booking token or invitation/recovery token into a new provider return URL. For existing legacy link checkout, preserve its existing proven return behaviour rather than breaking compatibility during this feature. On return, reconcile with bounded backoff and refetch the booking; close/reject/cancel callbacks are not definitive proof of no payment. Network/provider ambiguity should lead to status checking, not optimistic duplicate collection.

### Billing types and endpoints

```ts
interface InvoiceParty {
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
  gstNumber: string | null;
}
interface InvoiceBankAccount {
  name: string;
  bankName: string | null;
  accountNumber: string;
  branch: string | null;
  ifscCode: string | null;
  swiftCode: string | null;
}
interface InvoiceTax {
  component: string;
  rate: string;
  amount: Money;
}
interface InvoiceLine {
  position: number;
  description: string;
  amount: Money;
  taxTreatment: string; // TAXABLE, NON_TAXABLE, EXEMPT, NIL_RATED
  taxAmount: Money;
  total: Money;
  taxes: InvoiceTax[];
}
interface InvoicePayment {
  number: string | null;
  date: DateOnly;
  amount: Money;
  method: string;
}
interface CustomerInvoice {
  id: UUID;
  number: string | null;
  financialYear: string | null;
  date: DateOnly;
  status: string; // ISSUED or CANCELLED; drafts excluded
  total: Money;
  received: Money;
  adjusted: Money;
  due: Money;
  paymentStatus: string; // UNPAID, PARTIALLY_PAID, PAID, NOT_APPLICABLE
  subtotal: Money;
  taxTotal: Money;
  dueDate: DateOnly | null;
  company: InvoiceParty;
  customer: InvoiceParty;
  paymentInstructions: string | null;
  footerNotes: string | null;
  bankAccounts: InvoiceBankAccount[];
  lines: InvoiceLine[];
  guestDisplayText: string;
  label: string | null;
  payments: InvoicePayment[];
}
```

- `GET /api/v1/customer/accounts/:customerId/invoices?page=1&pageSize=25` → HTTP 200 `PageResponse<CustomerInvoice>`.
- `GET /api/v1/customer/accounts/:customerId/invoices/:invoiceId` → HTTP 200 `DataResponse<CustomerInvoice>`.

Pagination has the same limits as booking lists. Billing is ordered by invoice date descending, then invoice ID. No server search/status/date filter or global statement/total endpoint. The list returns the same complete safe record shape as detail; do not expect a separate list-only projection. It includes issued and cancelled records even when there is no commercial booking. A customer only sees their own records; UUID possession is insufficient. A draft invoice request returns 404.

Example detail (the list wraps records of this shape in `data: [...]` with pagination):

```json
{
  "data": {
    "id": "88888888-8888-4888-8888-888888888888",
    "number": "I/2627/000001",
    "financialYear": "2627",
    "date": "2026-10-05",
    "status": "ISSUED",
    "total": "1000.00",
    "received": "300.00",
    "adjusted": "0.00",
    "due": "700.00",
    "paymentStatus": "PARTIALLY_PAID",
    "subtotal": "1000.00",
    "taxTotal": "0.00",
    "dueDate": "2026-11-15",
    "company": {
      "name": "Eastern Risen",
      "address": "Example address",
      "city": null,
      "state": "ODISHA",
      "country": "INDIA",
      "postalCode": null,
      "gstNumber": null
    },
    "customer": {
      "name": "Example Corporate",
      "address": null,
      "city": null,
      "state": null,
      "country": null,
      "postalCode": null,
      "gstNumber": null
    },
    "paymentInstructions": "Use the invoice reference when paying.",
    "footerNotes": null,
    "bankAccounts": [],
    "lines": [
      {
        "position": 1,
        "description": "Example tour",
        "amount": "1000.00",
        "taxTreatment": "NON_TAXABLE",
        "taxAmount": "0.00",
        "total": "1000.00",
        "taxes": []
      }
    ],
    "guestDisplayText": "Example travelling group",
    "label": "Example tour",
    "payments": [
      { "number": "R/2627/000001", "date": "2026-10-05", "amount": "300.00", "method": "GATEWAY" }
    ]
  }
}
```

A tax component can be IGST/CGST/SGST/SERVICE_TAX; render unfamiliar components safely. Preserve server subtotal/taxTotal/total; rates are display strings, not extra taxes to recalculate. Bank account numbers are strings, never numbers. Company/customer/bank document values come from invoice snapshots, not the current mutable user profile/master. Snapshot nulls and legacy values must render gracefully without inventing missing tax identifiers.

`adjusted` is active settlement adjustments, not receipt money. Cancelled invoices have due `"0.00"` and paymentStatus NOT_APPLICABLE even if they retain historical receipts; never label cancellation as proof a refund was issued. The frontend gets only confirmed receipt summaries, not pending/reversed receipts, provider identifiers, internal settlement reasons, or a separate downloadable receipt document. There is no bookingId in the invoice record, no invoice-only gateway payment endpoint, no account total, no refund/credit-note action, and no server PDF URL. Keep Billing useful with detail/confirmed receipts and optionally a clean browser Print view, rather than inventing endpoints or deriving undocumented relationships.

### Website-specific errors

All use the shared ApiErrorResponse. Use HTTP status + code, not exact message text.

| HTTP | Code                              | Required handling                                                                                                                                                                |
| ---- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | INVITATION_INVALID                | Token expired/used/revoked/unavailable. Show contact/request-new-invitation guidance.                                                                                            |
| 400  | PASSWORD_TOO_SHORT                | New-user activation password under 12 characters. Field error; existing-user current password rules differ.                                                                      |
| 400  | RECOVERY_INVALID                  | Reset token invalid, used or expired. Offer a new recovery request.                                                                                                              |
| 400  | CURRENT_PASSWORD_INVALID          | Incorrect current password on password change. Field error.                                                                                                                      |
| 400  | PASSWORD_REUSE_NOT_ALLOWED        | New password equals current password. Ask for a different password.                                                                                                              |
| 401  | AUTHENTICATION_FAILED             | Login invalid, inactive identity, or wrong intended-user password during invitation acceptance. Keep this contextual; it is not always session expiry.                           |
| 403  | CUSTOMER_ACCESS_REQUIRED          | Cookie resolves to a non-customer identity or customer profile unavailable. Route to customer login/contact assistance; never staff endpoints.                                   |
| 404  | CUSTOMER_RECORD_NOT_FOUND         | Membership/active-customer/ownership check failed or booking/invoice/order unavailable. Clear that context, refresh accounts and show unavailable record.                        |
| 404  | CUSTOMER_UNAVAILABLE              | Invitation activation customer is no longer ACTIVE. Show staff assistance.                                                                                                       |
| 404  | CORE_NOT_FOUND                    | Shared commercial/payment resource disappeared or invalid milestone/order/token. Refresh and present unavailable resource.                                                       |
| 409  | QUOTE_NOT_ACCEPTABLE              | Booking is no longer QUOTED. Refresh status/acceptance; do not repeat blindly.                                                                                                   |
| 409  | QUOTE_EXPIRED                     | Latest quote is expired/unavailable. Request staff assistance/replacement.                                                                                                       |
| 409  | QUOTE_VERSION_CHANGED             | Staff changed quote. Refetch, show the replacement and require a new acceptance decision.                                                                                        |
| 409  | BOOKING_NOT_PAYABLE               | No payable linked invoice or state changed. Refresh booking and disable checkout.                                                                                                |
| 409  | INVOICE_NOT_ISSUED                | Linked invoice cancelled/not issued. Refresh and contact staff.                                                                                                                  |
| 409  | MILESTONE_NOT_PAYABLE             | Already settled or balance changed. Refetch authoritative amounts.                                                                                                               |
| 409  | PAYMENT_REVIEW_REQUIRED           | Money requires staff review; disable further checkout and show contact instructions.                                                                                             |
| 409  | PAYMENT_ORDER_AMOUNT_CHANGED      | Existing order amount differs from current payable balance. Contact staff; never create a competing order locally.                                                               |
| 409  | PAYMENT_ORDER_PENDING             | Order creation is pending. Wait briefly and check/retry in a bounded manner.                                                                                                     |
| 409  | INVOICE_MISSING                   | Reconciliation cannot find linked invoice. Refresh/contact staff; never claim payment failure or refund.                                                                         |
| 422  | CORE_VALIDATION_FAILED            | Shared financial validation, including missing/invalid customer payment contact phone. Show message/contact assistance; customer profile cannot edit the billing customer phone. |
| 503  | CUSTOMER_RECOVERY_UNAVAILABLE     | Mail delivery unconfigured. Show contact assistance instead of email-sent success.                                                                                               |
| 503  | PAYMENTS_UNAVAILABLE              | Backend payment provider unconfigured. Hide/disable collection path and show useful contact assistance.                                                                          |
| 503  | PAYMENT_PROVIDER_UNAVAILABLE      | Provider request timed out/network unavailable. Preserve order context and offer status check/safe retry.                                                                        |
| 502  | PAYMENT_PROVIDER_ERROR            | Provider rejected request. Show temporary error/support path.                                                                                                                    |
| 502  | PAYMENT_PROVIDER_RESPONSE_INVALID | Backend rejected provider response. Show support path; do not interpret malformed provider data as payment success.                                                              |

Unexpected persistence/provider errors may still return common INTERNAL_SERVER_ERROR. Some shared provider operations catch one provider error and attempt fetching an existing order before surfacing a later error; handle the actual returned status/code rather than assuming a single error for every failure.

### Existing public booking-link API contract

These routes have **no account-login requirement**. Keep legacy frontend URLs and link route loading separate from account guards. Public booking tokens accept 40–80 URL-safe characters matching `^[A-Za-z0-9_-]+$` (generated tokens currently have length 43). This differs from the exact invitation/reset-token contract.

| Method | Full path                                                              | Request                                        | Success                                  |
| ------ | ---------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------- |
| GET    | `/api/v1/core/public/bookings/:token`                                  | No body                                        | 200 `DataResponse<BookingDetail>`        |
| POST   | `/api/v1/core/public/bookings/:token/accept`                           | No required body; **no quoteVersion** contract | 200 `DataResponse<PublicAcceptedQuote>`  |
| POST   | `/api/v1/core/public/bookings/:token/milestones/:milestoneId/checkout` | No body                                        | 200 `DataResponse<CheckoutResult>`       |
| POST   | `/api/v1/core/public/bookings/:token/orders/:orderId/reconcile`        | No body                                        | 200 `DataResponse<PublicReconciliation>` |

```ts
interface PublicAcceptedQuote {
  id: UUID;
  bookingId: UUID;
  version: number;
  description: string;
  inclusions: string;
  exclusions: string;
  terms: string;
  total: Money;
  currency: string; // INR
  expiresOn: DateOnly | null;
  acceptedAt: ISODateTime;
  createdAt: ISODateTime;
}
interface PublicReconciliation {
  status: string; // PENDING, PAID, REVIEW_REQUIRED
  receiptId: UUID | null;
}
```

Public reconciliation returns status/receiptId, not the account reconciliation's orderId/status shape. Public quote acceptance returns the quote record; account acceptance returns only version/acceptedAt. Do not interchange handlers without adapting these contracts. Public POST routes are limited to 10 requests/minute per client IP per route. Invalid/rotated public tokens return 404 CORE_NOT_FOUND, not an instruction to sign in. Public response headers also prohibit storage/referrer leakage. Read current public-link state after any accepted/paid/review response.

No link possession, payment or sign-in automatically grants membership. A valid link remains usable while a person has no membership, including after membership revocation. Rotating a link does not remove account access. If the website already has a legacy share route elsewhere, preserve it; if the link page is currently served by another existing frontend, do not remove or silently relocate it as a side effect of account implementation. The backend does not provide an account ownership claim endpoint or a public token-to-account-booking ID mapping; do not invent one to offer “Add to my account.”

### Routing, browser state and website acceptance criteria

Persist only a preferred customerId if useful and revalidate it against `/accounts`; private records, tokens and passwords remain out of persistent browser storage. Query/cache keys include identity generation/customerId/resourceId, so one person's records are never reused after login as another person. Clear/abort outstanding fetches on logout/account switch; ignore late responses from the previous context. Membership revoked on the server does not necessarily log the user out: they may still access other memberships and their profile. Refetch `/accounts` on unavailable-account errors and on appropriate focus/navigation changes; no push-notification endpoint exists.

Use a separate account shell/layout from the marketing homepage. Deep-link routes must work on hard refresh under actual hosting rewrite rules. Invitation/reset pages must be reachable signed out and must not redirect through login before reading their fragment. Disable sensitive URL capture by analytics/error reporting before those pages initialise. Escape quote/invoice text and support long descriptions, absent bank details, null dates and mobile receipts/tables.

Acceptance journeys to test:

1. New named contact opens staff invitation → reads immutable intended email/customer → chooses password → accepts once → signs in → one customer auto-selected → sees that customer's history.
2. Existing user accepts a second customer's invitation with current password → keeps their name/password → accounts selector has both customers → switching does not leak stale records.
3. Expired/used/revoked activation and reset links show correct recovery/contact paths with no accidental ownership grant.
4. Unknown and known forgot-password emails show the same accepted message; unconfigured recovery shows assistance; reset/password change causes old sessions to fail and sign-in to resume normally.
5. Displayed quote version becomes stale after staff replacement → acceptance refuses it → frontend reloads and requires review.
6. Link and account checkout are used concurrently → shared order reuse → verified payment appears consistently in both views and Billing. Do not require real payments in automated tests; use backend-approved test/provider fixtures.
7. Payment return remains PENDING → bounded status checks → later PAID or REVIEW_REQUIRED; no optimistic paid state, no unbounded polling, no automatic new collection while money is under review.
8. Invoice-only history appears in Billing; draft invoices stay hidden; cancelled invoices retain history with no implied refund; adjustments remain distinct from paid receipts.
9. Staff revoke one membership → that customer's records disappear, other memberships still work; an independently valid shared link remains functional.
10. Staff rotate private booking token → old legacy link shows unavailable, authorised account booking access continues.
11. Customer and staff browsers/sessions coexist without sign-in/logout overwriting the other cookie; credentialed requests work on deployed domains.
12. 204, validation details, 401 versus invalid credentials, 403, 404 resource versus route-not-deployed, 429, network/proxy HTML and provider failures all produce correct user states and support request IDs.

Deliver the implemented website change, route/API configuration notes and verification results. Do not deploy mock data, infer unavailable server capabilities or require another document to interpret the contract in this prompt.
