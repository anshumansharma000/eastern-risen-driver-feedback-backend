import { and, count, desc, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type { CoreDatabase } from './database.js';
import { announcements } from './announcements.schema.js';
import { audit } from './audit.js';
import { conflict, missing } from '../domain/errors.js';
import {
  normalizeAnnouncement,
  publicPath,
  type AnnouncementInput,
} from '../domain/announcements.js';

export class AnnouncementsRepository {
  constructor(private readonly db: CoreDatabase) {}
  async list(page: number, pageSize: number) {
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(announcements)
        .orderBy(desc(announcements.updatedAt), desc(announcements.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ value: count() }).from(announcements),
    ]);
    return { items, total: total!.value };
  }
  async active(path: string, now = new Date()) {
    const page = publicPath(path);
    return this.db
      .select()
      .from(announcements)
      .where(
        and(
          eq(announcements.status, 'PUBLISHED'),
          lte(announcements.startsAt, now),
          or(isNull(announcements.endsAt), gt(announcements.endsAt, now)),
          or(
            eq(announcements.placement, 'PUBLIC'),
            page === '/' ? eq(announcements.placement, 'HOME') : undefined,
            and(
              eq(announcements.placement, 'SELECTED'),
              sql`${announcements.paths} @> ${JSON.stringify([page])}::jsonb`,
            ),
          ),
        ),
      )
      .orderBy(
        desc(sql`case when ${announcements.priority} = 'IMPORTANT' then 1 else 0 end`),
        desc(announcements.startsAt),
        desc(announcements.id),
      );
  }
  async create(input: AnnouncementInput, actorId: string) {
    const data = normalizeAnnouncement(input);
    return this.db.transaction(async (tx) => {
      const [item] = await tx
        .insert(announcements)
        .values({
          ...data,
          startsAt: new Date(data.startsAt),
          endsAt: data.endsAt ? new Date(data.endsAt) : null,
        })
        .returning();
      await audit(tx, actorId, 'CREATE', 'website_announcement', item!.id);
      return item!;
    });
  }
  async update(id: string, input: AnnouncementInput, version: number, actorId: string) {
    const data = normalizeAnnouncement(input);
    return this.db.transaction(async (tx) => {
      const [item] = await tx
        .update(announcements)
        .set({
          ...data,
          startsAt: new Date(data.startsAt),
          endsAt: data.endsAt ? new Date(data.endsAt) : null,
          version: sql`${announcements.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(announcements.id, id), eq(announcements.version, version)))
        .returning();
      if (!item) {
        const [exists] = await tx
          .select({ id: announcements.id })
          .from(announcements)
          .where(eq(announcements.id, id));
        if (!exists) throw missing('Announcement');
        throw conflict(
          'CORE_VERSION_CONFLICT',
          'This announcement changed. Reload the list before editing again.',
        );
      }
      await audit(tx, actorId, 'UPDATE', 'website_announcement', id);
      return item;
    });
  }
}
