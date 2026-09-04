import { and, asc, count, desc, eq, ne, sql, type SQL } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import {
  auditEvents,
  bookingDriverEngagements,
  bookings,
  engagementFeedbackSections,
  feedbackHandoffs,
} from '../../database/schema/index.js';
import { findPostgresError } from '../../shared/database/postgres-error.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { TripService } from '../trips/trip.service.js';

export type EngagementStatus = 'READY' | 'FEEDBACK_STARTED' | 'SUBMITTED' | 'ARCHIVED';
export type QuestionnairePurpose = 'ARRIVAL_EXPERIENCE' | 'DRIVER_FEEDBACK' | 'TOUR_EXPERIENCE';

export interface ListEngagementsInput {
  readonly bookingId?: string;
  readonly driverId?: string;
  readonly status?: EngagementStatus;
  readonly page: number;
  readonly pageSize: number;
}

const questionnairePurposeOrder: readonly QuestionnairePurpose[] = [
  'ARRIVAL_EXPERIENCE',
  'DRIVER_FEEDBACK',
  'TOUR_EXPERIENCE',
];

const engagementSelection = {
  id: bookingDriverEngagements.id,
  bookingId: bookingDriverEngagements.bookingId,
  bookingReference: bookings.bookingReference,
  passengerName: bookings.passengerName,
  sequenceNumber: bookingDriverEngagements.sequenceNumber,
  driverId: bookingDriverEngagements.driverId,
  driverNameSnapshot: bookingDriverEngagements.driverNameSnapshot,
  driverCodeSnapshot: bookingDriverEngagements.driverCodeSnapshot,
  driverSourceSnapshot: bookingDriverEngagements.driverSourceSnapshot,
  vendorId: bookingDriverEngagements.vendorId,
  vendorNameSnapshot: bookingDriverEngagements.vendorNameSnapshot,
  feedbackPurposes: sql<QuestionnairePurpose[]>`coalesce((
    select json_agg("engagement_sections"."purpose" order by case "engagement_sections"."purpose"
      when 'ARRIVAL_EXPERIENCE' then 0
      when 'DRIVER_FEEDBACK' then 1
      when 'TOUR_EXPERIENCE' then 2
    end)
    from "engagement_feedback_sections" as "engagement_sections"
    where "engagement_sections"."engagement_id" = "booking_driver_engagements"."id"
  ), '[]'::json)`,
  status: bookingDriverEngagements.status,
  startedFeedbackAt: bookingDriverEngagements.startedFeedbackAt,
  createdAt: bookingDriverEngagements.createdAt,
  updatedAt: bookingDriverEngagements.updatedAt,
  archivedAt: bookingDriverEngagements.archivedAt,
};

export class EngagementService {
  constructor(
    private readonly db: AppDatabase,
    private readonly trips: TripService,
  ) {}

  async get(id: string, driverId?: string) {
    const filter = driverId
      ? and(eq(bookingDriverEngagements.id, id), eq(bookingDriverEngagements.driverId, driverId))
      : eq(bookingDriverEngagements.id, id);
    const [engagement] = await this.db
      .select(engagementSelection)
      .from(bookingDriverEngagements)
      .innerJoin(bookings, eq(bookings.id, bookingDriverEngagements.bookingId))
      .where(filter)
      .limit(1);
    if (!engagement) this.notFound();
    const trips = await this.trips.listForEngagementIds([engagement.id]);
    if (!trips.length && engagement.status !== 'ARCHIVED') {
      throw new Error(`Active engagement ${engagement.id} has no trips`);
    }
    return { ...engagement, trips };
  }

  async list(input: ListEngagementsInput) {
    const conditions: SQL[] = [];
    conditions.push(
      input.status
        ? eq(bookingDriverEngagements.status, input.status)
        : ne(bookingDriverEngagements.status, 'ARCHIVED'),
    );
    if (input.bookingId) conditions.push(eq(bookingDriverEngagements.bookingId, input.bookingId));
    if (input.driverId) conditions.push(eq(bookingDriverEngagements.driverId, input.driverId));
    const filter = and(...conditions);
    const offset = (input.page - 1) * input.pageSize;
    const [engagements, [total]] = await Promise.all([
      this.db
        .select(engagementSelection)
        .from(bookingDriverEngagements)
        .innerJoin(bookings, eq(bookings.id, bookingDriverEngagements.bookingId))
        .where(filter)
        .orderBy(
          input.bookingId
            ? asc(bookingDriverEngagements.sequenceNumber)
            : desc(bookingDriverEngagements.createdAt),
          desc(bookingDriverEngagements.id),
        )
        .limit(input.pageSize)
        .offset(offset),
      this.db.select({ value: count() }).from(bookingDriverEngagements).where(filter),
    ]);
    const trips = await this.trips.listForEngagementIds(engagements.map((item) => item.id));
    const tripsByEngagement = new Map<string, typeof trips>();
    for (const trip of trips) {
      const grouped = tripsByEngagement.get(trip.engagementId!);
      if (grouped) grouped.push(trip);
      else tripsByEngagement.set(trip.engagementId!, [trip]);
    }
    return {
      items: engagements.map((engagement) => ({
        ...engagement,
        trips: tripsByEngagement.get(engagement.id) ?? [],
      })),
      total: total?.value ?? 0,
    };
  }

  async listForBooking(bookingId: string) {
    const engagements = await this.db
      .select(engagementSelection)
      .from(bookingDriverEngagements)
      .innerJoin(bookings, eq(bookings.id, bookingDriverEngagements.bookingId))
      .where(
        and(
          eq(bookingDriverEngagements.bookingId, bookingId),
          ne(bookingDriverEngagements.status, 'ARCHIVED'),
        ),
      )
      .orderBy(asc(bookingDriverEngagements.sequenceNumber), asc(bookingDriverEngagements.id));
    const trips = await this.trips.listForEngagementIds(engagements.map((item) => item.id));
    const tripsByEngagement = new Map<string, typeof trips>();
    for (const trip of trips) {
      const grouped = tripsByEngagement.get(trip.engagementId!);
      if (grouped) grouped.push(trip);
      else tripsByEngagement.set(trip.engagementId!, [trip]);
    }
    return engagements.map((engagement) => ({
      ...engagement,
      trips: tripsByEngagement.get(engagement.id) ?? [],
    }));
  }

  async updateFeedbackSections(
    id: string,
    purposes: readonly QuestionnairePurpose[],
    actorAccountId: string,
  ) {
    this.validateFeedbackPurposes(purposes);
    try {
      await this.db.transaction(async (tx) => {
        const [candidate] = await tx
          .select({ bookingId: bookingDriverEngagements.bookingId })
          .from(bookingDriverEngagements)
          .where(eq(bookingDriverEngagements.id, id))
          .limit(1);
        if (!candidate) this.notFound();

        // Match schedule mutation and feedback-start lock ordering. This prevents
        // editing a regrouped engagement or changing its sections while feedback starts.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${'booking:' + candidate.bookingId}, 0))`,
        );
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${id}, 0))`);

        const [engagement] = await tx
          .select({
            bookingId: bookingDriverEngagements.bookingId,
            status: bookingDriverEngagements.status,
          })
          .from(bookingDriverEngagements)
          .where(eq(bookingDriverEngagements.id, id))
          .limit(1);
        if (!engagement) this.notFound();
        if (engagement.status !== 'READY') {
          throw new AppError({
            code: 'ENGAGEMENT_FEEDBACK_SECTIONS_NOT_EDITABLE',
            message: 'Feedback sections can be edited only before engagement feedback starts',
            statusCode: 409,
          });
        }

        const previousSections = await tx
          .select({ purpose: engagementFeedbackSections.purpose })
          .from(engagementFeedbackSections)
          .where(eq(engagementFeedbackSections.engagementId, id));

        await tx
          .delete(engagementFeedbackSections)
          .where(eq(engagementFeedbackSections.engagementId, id));
        await tx.insert(engagementFeedbackSections).values(
          purposes.map((purpose) => ({
            engagementId: id,
            bookingId: engagement.bookingId,
            purpose,
            assignedByAccountId: actorAccountId,
          })),
        );

        // A READY engagement may already have a share link. Its handoff contains
        // a questionnaire snapshot, so revoke it rather than serving stale sections.
        await tx.delete(feedbackHandoffs).where(eq(feedbackHandoffs.engagementId, id));
        await tx
          .update(bookingDriverEngagements)
          .set({ updatedAt: new Date() })
          .where(
            and(eq(bookingDriverEngagements.id, id), eq(bookingDriverEngagements.status, 'READY')),
          );
        await tx.insert(auditEvents).values({
          actorAccountId,
          action: 'ENGAGEMENT_FEEDBACK_SECTIONS_UPDATED',
          entityType: 'BOOKING_DRIVER_ENGAGEMENT',
          entityId: id,
          metadata: {
            previousPurposes: this.sortPurposes(
              previousSections.map(({ purpose }) => purpose),
            ).join(','),
            feedbackPurposes: this.sortPurposes(purposes).join(','),
          },
        });
      });
      return await this.get(id);
    } catch (error) {
      const postgresError = findPostgresError(error, '23505');
      if (postgresError?.constraint === 'engagement_feedback_sections_booking_boundary_unique') {
        throw new AppError({
          code: 'BOOKING_FEEDBACK_PURPOSE_ALREADY_ASSIGNED',
          message:
            'Arrival and tour feedback can each be assigned to only one engagement per booking',
          statusCode: 409,
        });
      }
      throw error;
    }
  }

  private validateFeedbackPurposes(purposes: readonly QuestionnairePurpose[]): void {
    if (
      purposes.length < 1 ||
      purposes.length > questionnairePurposeOrder.length ||
      new Set(purposes).size !== purposes.length ||
      purposes.some((purpose) => !questionnairePurposeOrder.includes(purpose))
    ) {
      throw new AppError({
        code: 'ENGAGEMENT_FEEDBACK_SECTIONS_INVALID',
        message: 'Choose between one and three unique supported feedback sections',
        statusCode: 400,
      });
    }
  }

  private sortPurposes(purposes: readonly QuestionnairePurpose[]): QuestionnairePurpose[] {
    return [...purposes].sort(
      (left, right) =>
        questionnairePurposeOrder.indexOf(left) - questionnairePurposeOrder.indexOf(right),
    );
  }

  private notFound(): never {
    throw new AppError({
      code: 'ENGAGEMENT_NOT_FOUND',
      message: 'Driver engagement was not found',
      statusCode: 404,
    });
  }
}
