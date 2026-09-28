import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { authAccounts } from '../database/schema/accounts.js';
import {
  importLegacyInvoice,
  validateLegacyInvoice,
} from '../modules/core/legacy/invoice-import.js';
const [filename, mode] = process.argv.slice(2);
if (!filename || !['--validate', '--apply'].includes(mode ?? ''))
  throw new Error('Usage: npm run core:invoice:import -- <normalized.json> --validate|--apply');
const contents = await readFile(filename, 'utf8');
if (Buffer.byteLength(contents) > 2_000_000) throw new Error('Import files must not exceed 2 MB');
const input: unknown = JSON.parse(contents);
validateLegacyInvoice(input);
if (mode === '--validate')
  process.stdout.write('Invoice format and recorded totals validated. No database changes made.\n');
else {
  const actorId = process.env.CORE_IMPORT_ACTOR_ID;
  if (!actorId || !/^[0-9a-f-]{36}$/i.test(actorId))
    throw new Error('CORE_IMPORT_ACTOR_ID must identify the approving core administrator');
  const database = createDatabaseClient(loadConfig());
  try {
    const [actor] = await database.db
      .select()
      .from(authAccounts)
      .where(eq(authAccounts.id, actorId));
    if (!actor || actor.role !== 'CORE_ADMIN' || actor.status !== 'ACTIVE')
      throw new Error('An active core administrator is required');
    const result = await importLegacyInvoice(database.db, input, actorId);
    process.stdout.write(
      `${result.alreadyImported ? 'Already imported' : 'Imported'} invoice ${result.id}\n`,
    );
  } finally {
    await database.close();
  }
}
