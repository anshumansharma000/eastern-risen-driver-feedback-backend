import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config/env.js';
import { createDatabaseClient } from './client.js';

describe('createDatabaseClient', () => {
  it('handles errors emitted by idle pooled connections', async () => {
    const onPoolError = vi.fn();
    const database = createDatabaseClient(
      loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/app',
      }),
      onPoolError,
    );
    const error = new Error('connection interrupted');

    database.pool.emit('error', error);

    expect(onPoolError).toHaveBeenCalledOnce();
    expect(onPoolError).toHaveBeenCalledWith(error);
    await database.close();
  });
});
