import { index, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { core } from './masters.schema.js';
export const inquiries = core.table(
  'inquiries',
  {
    id: uuid('id').primaryKey(),
    type: text('type', { enum: ['CONTACT', 'TOUR', 'TOUR_DETAIL'] }).notNull(),
    fullName: text('full_name').notNull(),
    email: text('email').notNull(),
    phone: text('phone').notNull(),
    details: jsonb('details').$type<Record<string, string>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('inquiries_created_at_idx').on(t.createdAt, t.id)],
);
