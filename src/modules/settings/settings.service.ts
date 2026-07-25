import { eq, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import { agencySettings, auditEvents } from '../../database/schema/index.js';
import { AppError } from '../../shared/errors/app-error.js';

export interface UpdateAgencySettingsInput {
  readonly agencyName?: string;
  readonly timezone?: string;
  readonly defaultThankYouMessage?: string;
  readonly negativeFeedbackThreshold?: number | null;
}

const defaultSettings = {
  singletonKey: true,
  agencyName: 'Eastern Risen',
  timezone: 'Asia/Kolkata',
  defaultThankYouMessage: 'Thank you for your feedback.',
} as const;

export class SettingsService {
  constructor(private readonly db: AppDatabase) {}

  async get() {
    const [existing] = await this.db.select().from(agencySettings).limit(1);
    if (existing) return existing;

    const [created] = await this.db
      .insert(agencySettings)
      .values(defaultSettings)
      .onConflictDoNothing()
      .returning();
    if (created) return created;

    const [concurrent] = await this.db.select().from(agencySettings).limit(1);
    if (!concurrent) throw new Error('Agency settings could not be initialized');
    return concurrent;
  }

  async update(input: UpdateAgencySettingsInput, actorAccountId: string) {
    if (input.timezone !== undefined) validateTimeZone(input.timezone);

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('agency_settings'))`);
      let [current] = await tx.select().from(agencySettings).limit(1);
      if (!current) {
        [current] = await tx.insert(agencySettings).values(defaultSettings).returning();
      }
      if (!current) throw new Error('Agency settings could not be initialized');

      const changedFields = Object.keys(input).sort();
      const [updated] = await tx
        .update(agencySettings)
        .set({
          ...(input.agencyName !== undefined ? { agencyName: input.agencyName.trim() } : {}),
          ...(input.timezone !== undefined ? { timezone: input.timezone.trim() } : {}),
          ...(input.defaultThankYouMessage !== undefined
            ? { defaultThankYouMessage: input.defaultThankYouMessage.trim() }
            : {}),
          ...(input.negativeFeedbackThreshold !== undefined
            ? { negativeFeedbackThreshold: input.negativeFeedbackThreshold }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(agencySettings.id, current.id))
        .returning();
      if (!updated) throw new Error('Agency settings update did not return a row');

      await tx.insert(auditEvents).values({
        actorAccountId,
        action: 'AGENCY_SETTINGS_UPDATED',
        entityType: 'AGENCY_SETTINGS',
        entityId: updated.id,
        metadata: { changedFields: changedFields.join(',') },
      });
      return updated;
    });
  }
}

function validateTimeZone(value: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
  } catch {
    throw new AppError({
      code: 'TIMEZONE_INVALID',
      message: 'The timezone must be a valid IANA timezone name',
      statusCode: 400,
    });
  }
}
