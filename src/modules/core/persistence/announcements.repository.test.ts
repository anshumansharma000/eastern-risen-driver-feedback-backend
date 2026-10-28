import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';
import type { CoreDatabase } from './database.js';
import { AnnouncementsRepository } from './announcements.repository.js';
import type { AnnouncementInput } from '../domain/announcements.js';
const input: AnnouncementInput = {
  name: 'Campaign',
  category: 'GENERAL',
  message: 'Visit Odisha',
  linkText: null,
  linkUrl: null,
  status: 'DRAFT',
  startsAt: '2026-10-01T00:00:00Z',
  endsAt: null,
  placement: 'HOME',
  paths: [],
  priority: 'NORMAL',
  dismissible: true,
};
describe('announcement persistence', () => {
  it('filters publication, schedule and scope and orders priority before start time', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const db = drizzle({ client: { query } as never });
    const repository = new AnnouncementsRepository(db);
    await repository.active('/tours/', new Date('2026-10-27T00:00:00Z'));
    const [config, params] = query.mock.calls[0] as unknown as [{ text: string }, string[]];
    expect(config.text).toContain('"status" = $');
    expect(config.text).toContain('"starts_at" <= $');
    expect(config.text).toContain('"ends_at" > $');
    expect(config.text).toContain('"paths" @>');
    expect(config.text).toMatch(/order by case when .*IMPORTANT.* desc, .*starts_at.* desc/);
    expect(params).toContain('PUBLISHED');
    expect(params).toContain('PUBLIC');
    expect(params).not.toContain('HOME');
    expect(params).toContain('["/tours"]');
    query.mockClear();
    await repository.active('/');
    expect((query.mock.calls[0] as unknown as [unknown, string[]])[1]).toContain('HOME');
  });
  it('rejects stale versions and missing rows without writing audit events', async () => {
    for (const exists of [true, false]) {
      const insert = vi.fn();
      const tx = {
        update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
        select: () => ({ from: () => ({ where: async () => (exists ? [{ id: 'id' }] : []) }) }),
        insert,
      };
      const db = {
        transaction: (work: (tx: unknown) => unknown) => work(tx),
      } as unknown as CoreDatabase;
      await expect(
        new AnnouncementsRepository(db).update('id', input, 1, 'actor'),
      ).rejects.toMatchObject({ statusCode: exists ? 409 : 404 });
      expect(insert).not.toHaveBeenCalled();
    }
  });
  it('audits successful writes within the same transaction', async () => {
    const values = vi.fn(async () => undefined);
    const tx = {
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [{ id: 'id', version: 2 }] }) }),
      }),
      insert: () => ({ values }),
    };
    const db = {
      transaction: (work: (tx: unknown) => unknown) => work(tx),
    } as unknown as CoreDatabase;
    expect(await new AnnouncementsRepository(db).update('id', input, 1, 'actor')).toMatchObject({
      version: 2,
    });
    expect(values).toHaveBeenCalledWith({
      actorId: 'actor',
      action: 'UPDATE',
      entityType: 'website_announcement',
      entityId: 'id',
    });
  });
});
