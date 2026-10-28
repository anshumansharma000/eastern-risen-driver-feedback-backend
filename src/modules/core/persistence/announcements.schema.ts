import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { core } from './masters.schema.js';

export const announcements = core.table(
  'website_announcements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    category: text('category', {
      enum: ['GENERAL', 'NEW_JOURNEY', 'SEASONAL', 'TRAVEL_ADVISORY', 'SERVICE_UPDATE'],
    }).notNull(),
    message: text('message').notNull(),
    linkText: text('link_text'),
    linkUrl: text('link_url'),
    status: text('status', { enum: ['DRAFT', 'PUBLISHED', 'ARCHIVED'] })
      .notNull()
      .default('DRAFT'),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    placement: text('placement', { enum: ['HOME', 'PUBLIC', 'SELECTED'] })
      .notNull()
      .default('HOME'),
    paths: jsonb('paths').$type<string[]>().notNull().default([]),
    priority: text('priority', { enum: ['NORMAL', 'IMPORTANT'] })
      .notNull()
      .default('NORMAL'),
    dismissible: boolean('dismissible').notNull().default(true),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('website_announcements_active_idx').on(t.status, t.startsAt, t.endsAt),
    check('website_announcements_dates', sql`${t.endsAt} is null or ${t.endsAt} > ${t.startsAt}`),
    check('website_announcements_status', sql`${t.status} in ('DRAFT', 'PUBLISHED', 'ARCHIVED')`),
    check(
      'website_announcements_category',
      sql`${t.category} in ('GENERAL', 'NEW_JOURNEY', 'SEASONAL', 'TRAVEL_ADVISORY', 'SERVICE_UPDATE')`,
    ),
    check('website_announcements_placement', sql`${t.placement} in ('HOME', 'PUBLIC', 'SELECTED')`),
    check('website_announcements_priority', sql`${t.priority} in ('NORMAL', 'IMPORTANT')`),
    check('website_announcements_link_pair', sql`(${t.linkText} is null) = (${t.linkUrl} is null)`),
  ],
);
