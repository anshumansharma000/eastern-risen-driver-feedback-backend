import { describe, expect, it } from 'vitest';
import { loadConfig } from './env.js';

describe('loadConfig', () => {
  it('loads defaults and required database configuration', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://localhost/test' });

    expect(config).toMatchObject({
      nodeEnv: 'development',
      host: '0.0.0.0',
      port: 3000,
      databaseMaxConnections: 10,
      sessionCookieName: 'id',
      sessionTtlHours: 12,
      frontendOrigins: [],
    });
  });

  it('normalizes configured frontend origins', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://localhost/test',
      FRONTEND_ORIGINS: 'https://app.example.com/, http://localhost:3001',
    });

    expect(config.frontendOrigins).toEqual([
      'https://app.example.com',
      'http://localhost:3001',
    ]);
  });

  it('rejects a missing database URL', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL is required');
  });

  it('rejects invalid positive integer settings', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://localhost/test', PORT: 'not-a-port' }),
    ).toThrow('PORT must be a positive integer');
  });
});
