import { count, desc, eq } from 'drizzle-orm';
import type { CoreDatabase } from './database.js';
import { inquiries } from './inquiries.schema.js';
import { missing } from '../domain/errors.js';
export class InquiriesRepository {
  constructor(private readonly db: CoreDatabase) {}
  async create(input: typeof inquiries.$inferInsert) {
    // Only return the receipt, including for a retry of the same submission ID.
    const receipt = { id: inquiries.id, createdAt: inquiries.createdAt };
    const [created] = await this.db
      .insert(inquiries)
      .values(input)
      .onConflictDoNothing({ target: inquiries.id })
      .returning(receipt);
    if (created) return created;
    const [existing] = await this.db
      .select(receipt)
      .from(inquiries)
      .where(eq(inquiries.id, input.id));
    if (!existing) throw missing('Inquiry');
    return existing;
  }
  async list(page: number, pageSize: number) {
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(inquiries)
        .orderBy(desc(inquiries.createdAt), desc(inquiries.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ value: count() }).from(inquiries),
    ]);
    return { items, total: total!.value };
  }
  async get(id: string) {
    const [record] = await this.db.select().from(inquiries).where(eq(inquiries.id, id));
    if (!record) throw missing('Inquiry');
    return record;
  }
}
