# Eastern Risen Driver Feedback API

Fastify and TypeScript backend for the Driver Feedback Service described in
[PRODUCT.md](PRODUCT.md). The logical persistence model is documented in
[DATA_MODEL.md](DATA_MODEL.md).

## Local setup

Requirements:

- Node.js 22.13 or newer (Node.js 24 LTS recommended)
- Docker with Docker Compose

```bash
cp .env.example .env
npm install
docker compose up -d postgres
npm run db:migrate
npm run dev
```

The API listens on `http://localhost:3000`. OpenAPI documentation is available
at `http://localhost:3000/docs` in development. Health endpoints are exposed at
`/health/live` and `/health/ready`.

Production container, migration, secret, rollback, and monitoring instructions
are documented in [DEPLOYMENT.md](DEPLOYMENT.md).

## Commands

```bash
npm run check        # lint, type-check, test, and build
npm run db:generate  # generate a migration after changing the Drizzle schema
npm run db:migrate   # apply pending migrations
npm run admin:create # provision an initial administrator from environment variables
npm run session:cleanup # remove expired and old revoked sessions
```

## Initial administrator

The product does not expose public administrator registration. After applying
migrations, provision the initial administrator operationally:

```bash
export ADMIN_EMAIL='admin@example.com'
export ADMIN_DISPLAY_NAME='Administrator'
read -s ADMIN_PASSWORD
export ADMIN_PASSWORD
npm run admin:create
unset ADMIN_PASSWORD
```

The password is hashed with Argon2id before insertion and is never printed.

## Implemented API

- `POST /api/v1/auth/admin/login`
- `POST /api/v1/auth/driver/login`
- `POST /api/v1/auth/logout`
- `GET /api/v1/auth/me`
- `GET|POST /api/v1/admin/vendors`
- `PATCH /api/v1/admin/vendors/:id`
- `PATCH /api/v1/admin/vendors/:id/status`
- `GET|POST /api/v1/admin/drivers`
- `GET /api/v1/admin/drivers/:id`
- `PATCH /api/v1/admin/drivers/:id`
- `PATCH /api/v1/admin/drivers/:id/status`
- `POST /api/v1/admin/drivers/:id/password-reset`
- `GET|POST /api/v1/admin/drivers/:id/leaves`
- `DELETE /api/v1/admin/drivers/:id/leaves/:leaveId`
- `GET|POST /api/v1/admin/vehicles`
- `GET|PATCH /api/v1/admin/vehicles/:id`
- `PATCH /api/v1/admin/vehicles/:id/status`
- `GET|POST /api/v1/admin/trips`
- `GET|PATCH /api/v1/admin/trips/:id`
- `POST /api/v1/admin/trips/:id/archive`
- `GET|POST /api/v1/driver/trips`
- `GET /api/v1/driver/trips/:id`
- `POST /api/v1/driver/trips/:id/start-feedback`
- `GET|POST /api/v1/admin/questionnaires`
- `PATCH /api/v1/admin/questionnaires/:id`
- `POST /api/v1/admin/questionnaires/:id/archive`
- `GET|POST /api/v1/admin/questionnaires/:id/versions`
- `GET /api/v1/admin/questionnaires/:id/versions/:versionId`
- `PUT /api/v1/admin/questionnaires/:id/versions/:versionId/questions`
- `POST /api/v1/admin/questionnaires/:id/versions/:versionId/publish`
- `POST /api/v1/admin/questionnaires/:id/versions/:versionId/archive`
- `GET /api/v1/admin/consent-versions/active`
- `POST /api/v1/admin/consent-versions`
- `GET /api/v1/passenger/feedback/context`
- `POST /api/v1/passenger/feedback/submissions`
- `GET|PATCH /api/v1/admin/settings`
- `GET /api/v1/admin/feedback`
- `GET /api/v1/admin/feedback/:id`
- `PATCH /api/v1/admin/feedback/:id/review-state`
- `GET /api/v1/admin/analytics`
- `GET /api/v1/driver/performance`
- `GET|PATCH /api/v1/admin/profile`
- `POST /api/v1/admin/profile/change-password`
- `GET|PATCH /api/v1/driver/profile`
- `POST /api/v1/driver/profile/change-password`

Authentication uses an opaque, database-backed session cookie. The cookie is
`HttpOnly` and uses `SameSite=None; Secure` in production so separately hosted
HTTPS frontends can make credentialed API requests. Local development uses
`SameSite=Lax` without `Secure`. The raw session token is never stored in
PostgreSQL.

Sessions have a 72-hour inactivity timeout and a 30-day absolute lifetime by
default. An active session rotates its token every 24 hours and renews the
inactivity deadline, while the prior token remains valid for 60 seconds so
concurrent browser requests are not interrupted. Configure these limits with
`SESSION_IDLE_TTL_HOURS`, `SESSION_ABSOLUTE_TTL_DAYS`,
`SESSION_ROTATION_INTERVAL_HOURS`, and `SESSION_ROTATION_GRACE_SECONDS`.

Administrators and drivers can read and update their own basic profiles.
Drivers may self-edit only display name, email, and phone; operational source,
vendor, status, assignment, shift, and duty-limit fields remain
administrator-controlled. Self-service password changes require the current
password and revoke every session for that account.

Administrators can directly set a new password for a non-archived driver.
The password is hashed immediately, never returned or written to audit
metadata, and every active session for that driver is revoked. There is no
public forgot-password or email delivery flow.

Set `FRONTEND_ORIGINS` to a comma-separated allowlist of exact frontend origins.
Credentialed CORS responses are emitted only for that allowlist, and browser
state-changing requests from any other origin are rejected.

Successful resource responses use `{ "data": ... }`; collection responses add
`pagination`. HTTP 204 responses have no body. Errors consistently use
`{ "error": { "code", "message", "details?", "requestId" } }`, and every
response includes the same request ID in the `x-request-id` header. The shared
error contract is included in OpenAPI.

Driver and vendor create, edit, and status changes append an `audit_events` row
inside the same transaction as the business mutation. The `outbox_messages`
table is available for reliable email/export processing once delivery providers
and payload-encryption key management are selected.

Vehicle and trip mutations are audited as well. An administrator can manage
vehicles, create and assign trips, edit trips while they remain `READY`, and
archive trips without deleting their history. Drivers can list only their own
assigned trips, enter a trip for themselves, and transition a ready trip to
`FEEDBACK_STARTED`.

Each trip stores immutable snapshots of the selected vehicle, driver identity,
driver source, and outsourced vendor. A trip can be created only with an active
vehicle and active driver; outsourced drivers also require an active vendor.
Assignments reject past or invalid time ranges, duplicate booking references,
same pickup/destination values, driver or vehicle overlaps, unavailable or
on-leave drivers, trips outside configured shifts, and trips that exceed a
driver's daily duty-minute limit.

Questionnaires use editable draft versions and immutable published versions.
Replacing a draft's ordered question array supports adding, editing, reordering,
activating, deactivating, and archiving questions. Publishing retires the prior
globally active version in the same transaction. Passenger consent notices are
versioned and immutable as well.

Starting feedback returns a one-time opaque `feedbackAccessToken`. Send it as
`Authorization: Bearer <token>` to the passenger context and submission APIs.
The context contains the exact questionnaire snapshot that the frontend must
persist with its offline envelope and return as `questionnaireSnapshot` during
submission.

The frontend must create `clientSubmissionId` before its first submission
attempt and reuse it for every retry. Repeating an accepted ID returns HTTP 200
with `replayed: true`. A new ID for a trip that already has feedback returns
`TRIP_FEEDBACK_ALREADY_SUBMITTED`. New submissions return HTTP 201. Use
`submissionMode: OFFLINE_SYNC` for queued responses; these receipts report
`rewardEligible: false`.

Passenger phone and email values are encrypted with AES-256-GCM before database
storage. Production requires a base64-encoded 32-byte
`DATA_ENCRYPTION_KEY_BASE64` deployment secret. Back up and rotate this key only
through an explicit data-migration procedure. `FEEDBACK_HANDOFF_TTL_HOURS`
controls the passenger token lifetime and defaults to seven days.

Agency settings control the agency name, IANA timezone, passenger thank-you
message, and an optional negative-feedback threshold. Passenger context includes
the completion copy needed by the hand-back screen. Calendar-month filters and
analytics use `submittedAt` grouped in the configured agency timezone.

Administrators can list and inspect immutable feedback, including decrypted
passenger contact values only on the protected detail endpoint. Flag, unflag,
and archive transitions append both review history and an audit event in the
same transaction. Archiving requires a reason and cannot currently be reversed.

Driver performance exposes only arithmetic aggregates and contributing counts;
it never returns individual responses, comments, or passenger information.
Admin analytics uses the same scoring rules and supports month, driver, source,
vendor, and category filters. Archived feedback is excluded from all current
aggregates.

## DigitalOcean Managed PostgreSQL

Use the connection URI from the cluster's **Connection Details** panel as
`DATABASE_URL`. Keep the credential in deployment secrets, never in Git.

All DigitalOcean managed PostgreSQL connections require TLS:

```bash
DATABASE_URL=postgresql://USER:PASSWORD@HOST:25060/DATABASE
DATABASE_SSL_MODE=require
```

For a Standard Edition cluster, prefer full server verification. Download the
cluster CA certificate and configure either its deployed path or a base64 secret:

```bash
DATABASE_SSL_MODE=verify-full
DATABASE_CA_CERT_PATH=/run/secrets/digitalocean-postgres-ca.crt
# Or: DATABASE_CA_CERT_BASE64=<base64-encoded-certificate>
```

Advanced Edition currently uses `DATABASE_SSL_MODE=require`. Restrict the
cluster's trusted sources to the deployed application and explicitly approved
developer IP addresses. The same TLS configuration is used by the API,
administrator provisioning script, and Drizzle migration commands.

## Architecture

The API is a modular monolith. HTTP schemas and routes live beside their domain
services and repositories under `src/modules`. Database-enforced invariants are
defined in `src/database/schema` and reviewed in generated SQL migrations.
