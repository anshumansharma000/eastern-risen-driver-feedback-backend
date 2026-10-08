import 'dotenv/config';
import { loadConfig } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { createApplicationServices } from '../container.js';
import { processPaymentReconciliation } from '../modules/core/application/payment-reconciliation.js';

const config = loadConfig();
if (!config.cashfree) throw new Error('Online payments are not configured');
const database = createDatabaseClient(config);
try {
  const services = createApplicationServices(database.db, config);
  const totals = { processed: 0, failed: 0 };
  // Bounded batches work with host schedulers; database leases prevent overlap.
  for (let i = 0; i < 25; i++) {
    const result = await processPaymentReconciliation(
      database.db,
      services.core.commercial,
      config.paymentClosedRecheckDays,
    );
    totals.processed += result.processed;
    totals.failed += result.failed;
    if (!result.processed) break;
  }
  process.stdout.write(`${JSON.stringify(totals)}\n`);
  if (totals.failed) process.exitCode = 1;
} finally {
  await database.close();
}
