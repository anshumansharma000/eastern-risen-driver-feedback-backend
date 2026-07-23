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
- `PATCH /api/v1/admin/drivers/:id`
- `PATCH /api/v1/admin/drivers/:id/status`
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

Authentication uses an opaque, database-backed session cookie. The cookie is
`HttpOnly`, uses `SameSite=Lax`, and is marked `Secure` in production. The raw
session token is never stored in PostgreSQL.

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
