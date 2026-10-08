import 'dotenv/config';
import { loadConfig } from '../config/env.js';
import { createDatabaseClient } from '../database/client.js';
import { createFieldEncryptor } from '../shared/security/field-encryption.js';
import {
  createCustomerMailSender,
  deliverCustomerMail,
} from '../modules/customer/customer-mail.js';

const config = loadConfig();
if (!config.customerMail) throw new Error('Customer email delivery is not configured');
const database = createDatabaseClient(config);
try {
  const result = await deliverCustomerMail(
    database.db,
    createFieldEncryptor(config.dataEncryptionKey),
    createCustomerMailSender(config.customerMail),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.failed) process.exitCode = 1;
} finally {
  await database.close();
}
