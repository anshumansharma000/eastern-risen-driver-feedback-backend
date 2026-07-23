# Production deployment

The initial production topology is deliberately small: one API container, one
Next.js frontend deployment, and the DigitalOcean Managed PostgreSQL cluster.
Add shared rate limiting or additional API instances only when traffic requires
horizontal scaling.

## Required secrets and configuration

- `NODE_ENV=production`
- `DATABASE_URL` from DigitalOcean
- `DATABASE_SSL_MODE=require` or `verify-full`
- `DATABASE_CA_CERT_PATH` or `DATABASE_CA_CERT_BASE64` when using `verify-full`
- `DATA_ENCRYPTION_KEY_BASE64`, containing 32 random bytes encoded as base64
- `FRONTEND_ORIGINS`, containing the exact deployed frontend origin
- `TRUST_PROXY_HOPS`, set to the verified number of reverse-proxy hops
- A production `LOG_LEVEL`, normally `info`

Keep the data-encryption key in the deployment secret store and in a separate,
access-controlled backup. Losing it makes encrypted passenger contact data and
active handoff tokens unrecoverable. Changing it requires a planned data
migration.

## Build and release

Build the application image:

```bash
docker build --target runtime -t driver-feedback-api:VERSION .
```

Before routing traffic to a new application version, run every pending migration
once using the same image revision:

```bash
docker build --target migrator -t driver-feedback-migrator:VERSION .
docker run --rm --env-file /secure/path/production.env driver-feedback-migrator:VERSION
```

Then deploy the runtime image. Do not run migrations concurrently from every API
instance.

## DigitalOcean checks

1. Restrict database trusted sources to the deployed application and explicitly
   approved operator addresses.
2. Confirm TLS is required and certificate verification is enabled where the
   database edition supports it.
3. Enable automated backups and point-in-time recovery.
4. Test one restore before accepting passenger data.
5. Apply migrations before starting the first production API container.

## Health and monitoring

- Liveness: `GET /health/live`
- Readiness: `GET /health/ready`
- All responses include `x-request-id`; application logs use the same ID.
- Logs are structured JSON outside development and redact authentication and
  passenger fields.

Configure an external uptime check for liveness and alerts for:

- readiness failures lasting more than five minutes;
- elevated HTTP 5xx responses;
- repeated `INTERNAL_SERVER_ERROR`, encryption, or database connection errors;
- container restarts;
- database storage or connection-pool pressure.

## Rollback

Application rollback means redeploying the prior runtime image. Database
migrations are forward-only: prepare a corrective migration instead of manually
reversing a schema after it has accepted data. Restore from a managed backup only
for a confirmed data-loss incident.
