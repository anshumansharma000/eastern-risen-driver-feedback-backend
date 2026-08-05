# Production deployment

The recommended initial production topology is:

- one DigitalOcean App Platform API service;
- one DigitalOcean App Platform pre-deploy migration job;
- the existing DigitalOcean Managed PostgreSQL cluster;
- the separately deployed frontend; and
- one API custom domain, such as `api.example.com`.

The local `docker-compose.yml` PostgreSQL service is for development and
integration tests only. Never deploy it or its development credentials.

## 1. Prepare a releasable commit

1. Use Node.js 24.
2. Run `npm ci`.
3. Run `npm audit --omit=dev --audit-level=high`.
4. Start a blank PostgreSQL database and run `npm run db:migrate`.
5. Set `TEST_DATABASE_URL` to that database and run `npm run check`.
6. Build both release targets:

   ```bash
   docker build --target runtime -t driver-feedback-api:GIT_SHA .
   docker build --target migrator -t driver-feedback-migrator:GIT_SHA .
   ```

7. Commit all application and migration files. Do not deploy a dirty working
   tree. Tag or otherwise record the exact commit deployed.
8. Require the repository CI check before merging to `main`.

## 2. Prepare DigitalOcean Managed PostgreSQL

1. Place the database in the same region as the backend. The supplied App
   Platform template uses Bangalore (`blr`).
2. Create a dedicated production database and least-privilege application user.
3. Copy the connection URL from the database Connection Details panel.
4. Download the cluster CA certificate and base64-encode the certificate bytes.
5. Enable automated backups and point-in-time recovery.
6. Test a restore into a separate database before accepting passenger data.
7. After the App Platform app exists, add that app as a database trusted source.
   Explicitly add only approved operator IP addresses when direct access is
   required.
8. Keep the connection pool within the database plan's connection limit. Start
   with `DATABASE_MAX_CONNECTIONS=10` for one API instance.

## 3. Create and store production secrets

Create the data-encryption key once:

```bash
openssl rand -base64 32
```

Store it as `DATA_ENCRYPTION_KEY_BASE64` in DigitalOcean's encrypted secret
store and in a separate access-controlled backup. Losing this key makes
encrypted passenger contact data and active handoff tokens unrecoverable.
Changing it requires a planned data migration.

Configure these application values:

- `NODE_ENV=production`
- `DATABASE_URL` from DigitalOcean
- `DATABASE_SSL_MODE=verify-full`
- `DATABASE_CA_CERT_BASE64` containing the base64 cluster CA certificate
- `DATA_ENCRYPTION_KEY_BASE64` containing exactly 32 random bytes as base64
- `FRONTEND_ORIGINS` containing only the exact HTTPS frontend origin or origins
- `PASSENGER_FEEDBACK_URL` containing the public HTTPS passenger feedback form URL
- `TRUST_PROXY_HOPS=1` initially, then verify the client IP and proxy chain
- `LOG_LEVEL=info`
- `DATABASE_MAX_CONNECTIONS=10`
- `SESSION_IDLE_TTL_HOURS=72`
- `SESSION_ABSOLUTE_TTL_DAYS=30`
- `SESSION_ROTATION_INTERVAL_HOURS=24`
- `SESSION_ROTATION_GRACE_SECONDS=60`

Keep secrets out of Git, build arguments, Docker images, and log messages.

## 4. Create the App Platform backend

1. Copy `.do/app.example.yaml` to a secure temporary location.
2. Replace every `CHANGE_ME` value.
3. In DigitalOcean, create an App Platform app from the GitHub repository.
4. Select the Dockerfile build and the same region as PostgreSQL.
5. Use the runtime service settings from the example spec:
   - internal HTTP port `3000`;
   - readiness path `/health/ready`;
   - liveness path `/health/live`;
   - one 1 GB shared-CPU instance initially.
6. Add a `PRE_DEPLOY` job using the same repository and Dockerfile with:

   ```bash
   npm run db:migrate:production
   ```

7. Keep automatic deployment disabled for the first release. Enable it only
   after branch protection and CI are required on `main`.
8. Attach the existing Managed PostgreSQL database; do not create an App
   Platform development database.

Migrations must run once before the new API revision receives traffic. Never
run migrations independently from every API replica.

## 5. Create the initial administrator

There is no public administrator registration endpoint. After migrations
succeed, allow one trusted operator machine to reach PostgreSQL, configure the
production environment locally, and run:

```bash
export ADMIN_EMAIL='admin@example.com'
export ADMIN_DISPLAY_NAME='Administrator'
read -s ADMIN_PASSWORD
export ADMIN_PASSWORD
npm run admin:create
unset ADMIN_PASSWORD
```

Remove the operator IP from database trusted sources afterward. The password is
hashed with Argon2id and is never printed.

## 6. Configure domain, frontend, and cookies

1. Add the API custom domain in App Platform and create the requested DNS record.
2. Wait for the platform TLS certificate to become active.
3. Set the frontend API base URL to the final HTTPS API domain.
4. Set `FRONTEND_ORIGINS` to the frontend's exact HTTPS origin; paths and
   wildcard origins are not allowed.
5. Verify login, authenticated requests, logout, and session rotation in a real
   browser. Production cookies are `HttpOnly`, `Secure`, and `SameSite=Lax`.

## 7. Production smoke test

Verify, in order:

1. the pre-deploy migration job completed successfully;
2. `GET /health/live` returns HTTP 200;
3. `GET /health/ready` returns HTTP 200;
4. unknown browser origins are rejected;
5. administrator login and logout work;
6. a driver can log in and see only their assigned trips;
7. a feedback handoff can be created and submitted once;
8. duplicate feedback submission retry behavior is idempotent;
9. passenger contact data is encrypted in PostgreSQL; and
10. logs contain request IDs but no passwords, session tokens, passenger
    contacts, database credentials, or encryption keys.

## 8. Monitoring and launch

Configure external uptime monitoring and alerts for:

- readiness failures lasting more than five minutes;
- elevated HTTP 5xx rates;
- repeated `INTERNAL_SERVER_ERROR`, encryption, or database errors;
- container restarts;
- high memory or CPU use;
- database storage and connection-pool pressure; and
- failed deployments or migration jobs.

Launch with one API instance. App Platform high availability requires at least
two instances; add a second instance when the availability requirement or
traffic justifies it. Before horizontal scaling, confirm that platform/client
IP handling and rate limiting behave as intended.

## 9. Rollback and incident handling

Application rollback means redeploying the previous known-good commit or image.
Database migrations are forward-only: prepare a corrective migration instead
of manually reversing a schema after it has accepted data. Restore a managed
backup only for a confirmed data-loss incident.

For every release, record:

- Git commit and image digest;
- migration job result;
- deployment start and completion time;
- operator;
- smoke-test result; and
- rollback revision.
