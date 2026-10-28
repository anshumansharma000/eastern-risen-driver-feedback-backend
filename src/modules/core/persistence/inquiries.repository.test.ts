import { describe, expect, it, vi } from 'vitest';
import { InquiriesRepository } from './inquiries.repository.js';
import type { CoreDatabase } from './database.js';
import { inquiries } from './inquiries.schema.js';
const id = '00000000-0000-4000-8000-000000000001';
const input = {
  id,
  type: 'CONTACT' as const,
  fullName: 'Jane',
  email: 'jane@example.com',
  phone: '123',
  details: { message: 'Hello' },
};
describe('inquiry persistence receipts', () => {
  it('inserts against the unique submission ID and returns only its receipt', async () => {
    const receipt = { id, createdAt: new Date() };
    const returning = vi.fn(async () => [receipt]);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const select = vi.fn();
    const db = { insert: vi.fn(() => ({ values })), select } as unknown as CoreDatabase;
    expect(await new InquiriesRepository(db).create(input)).toEqual(receipt);
    expect(values).toHaveBeenCalledWith(input);
    expect(onConflictDoNothing).toHaveBeenCalledWith({ target: inquiries.id });
    expect(select).not.toHaveBeenCalled();
  });
  it('returns the existing receipt after a duplicate retry rather than creating another record', async () => {
    const receipt = { id, createdAt: new Date() };
    const where = vi.fn(async () => [receipt]);
    const returning = vi.fn(async () => []);
    const db = {
      insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning }) }) }),
      select: () => ({ from: () => ({ where }) }),
    } as unknown as CoreDatabase;
    expect(await new InquiriesRepository(db).create(input)).toEqual(receipt);
    expect(where).toHaveBeenCalledOnce();
  });
});
