import { and, asc, count, countDistinct, eq, isNotNull, ne, sql, type SQL } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import { feedbackAnswers, feedbackSubmissions } from '../../database/schema/index.js';
import type { SettingsService } from '../settings/settings.service.js';
import { monthCondition } from '../feedback/admin-feedback.service.js';

type DriverSource = 'AGENCY' | 'OUTSOURCED';
type Category =
  | 'OVERALL_EXPERIENCE'
  | 'DRIVING_SAFETY'
  | 'PUNCTUALITY'
  | 'CLEANLINESS'
  | 'PROFESSIONALISM'
  | 'VEHICLE_CONDITION'
  | 'ARRIVAL_EXPERIENCE'
  | 'TOUR_EXPERIENCE'
  | 'TOUR_COORDINATION'
  | 'CUSTOM';

export interface AnalyticsFilters {
  readonly month?: string;
  readonly driverId?: string;
  readonly driverSource?: DriverSource;
  readonly vendorId?: string;
  readonly category?: Category;
}

const averageScore = sql<number | null>`avg(${feedbackAnswers.numericScore})::double precision`;
const responseCount = countDistinct(feedbackSubmissions.id);
const answerCount = count(feedbackAnswers.id);

export class AnalyticsService {
  constructor(
    private readonly db: AppDatabase,
    private readonly settings: SettingsService,
  ) {}

  async getDriverPerformance(driverId: string, month?: string) {
    const result = await this.getBreakdown({ driverId, ...(month ? { month } : {}) }, false);
    return { driverId, ...result };
  }

  async getAdminAnalytics(filters: AnalyticsFilters) {
    const settings = await this.settings.get();
    const breakdown = await this.getBreakdown(filters, true, settings.timezone);
    const negativeFeedbackCount =
      settings.negativeFeedbackThreshold === null
        ? null
        : await this.countNegativeFeedback(
            filters,
            settings.timezone,
            settings.negativeFeedbackThreshold,
          );
    return {
      ...breakdown,
      negativeFeedbackCount,
      negativeFeedbackThreshold: settings.negativeFeedbackThreshold,
    };
  }

  private async getBreakdown(
    filters: AnalyticsFilters,
    includeAdminDimensions: boolean,
    knownTimezone?: string,
  ) {
    const timezone = knownTimezone ?? (await this.settings.get()).timezone;
    const filter = buildScoreFilter(filters, timezone);
    const base = this.db
      .select({
        averageScore,
        responseCount,
        answerCount,
      })
      .from(feedbackAnswers)
      .innerJoin(
        feedbackSubmissions,
        eq(feedbackAnswers.feedbackSubmissionId, feedbackSubmissions.id),
      )
      .where(filter);

    const categoriesQuery = this.db
      .select({
        category: feedbackAnswers.categorySnapshot,
        averageScore,
        responseCount,
        answerCount,
      })
      .from(feedbackAnswers)
      .innerJoin(
        feedbackSubmissions,
        eq(feedbackAnswers.feedbackSubmissionId, feedbackSubmissions.id),
      )
      .where(filter)
      .groupBy(feedbackAnswers.categorySnapshot)
      .orderBy(asc(feedbackAnswers.categorySnapshot));

    const monthExpression = sql<string>`to_char(
      ${feedbackSubmissions.submittedAt} at time zone ${timezone},
      'YYYY-MM'
    )`;
    const monthlyQuery = this.db
      .select({
        month: monthExpression,
        averageScore,
        responseCount,
        answerCount,
      })
      .from(feedbackAnswers)
      .innerJoin(
        feedbackSubmissions,
        eq(feedbackAnswers.feedbackSubmissionId, feedbackSubmissions.id),
      )
      .where(filter)
      .groupBy(sql`1`)
      .orderBy(sql`1 asc`);

    const [overallRows, categories, monthlyTrend, adminDimensions] = await Promise.all([
      base,
      categoriesQuery,
      monthlyQuery,
      includeAdminDimensions
        ? this.getAdminDimensions(filter)
        : Promise.resolve({ drivers: [], sources: [], vendors: [] }),
    ]);
    const overall = overallRows[0] ?? {
      averageScore: null,
      responseCount: 0,
      answerCount: 0,
    };
    return {
      overall,
      categories,
      monthlyTrend,
      ...adminDimensions,
      meta: {
        timezone,
        dateBasis: 'SUBMITTED_AT' as const,
        month: filters.month ?? null,
      },
    };
  }

  private async getAdminDimensions(filter: SQL | undefined) {
    const [drivers, sources, vendors] = await Promise.all([
      this.db
        .select({
          driverId: feedbackSubmissions.driverId,
          driverName: feedbackSubmissions.driverNameSnapshot,
          sourceType: feedbackSubmissions.driverSourceSnapshot,
          vendorId: feedbackSubmissions.vendorId,
          vendorName: feedbackSubmissions.vendorNameSnapshot,
          averageScore,
          responseCount,
          answerCount,
        })
        .from(feedbackAnswers)
        .innerJoin(
          feedbackSubmissions,
          eq(feedbackAnswers.feedbackSubmissionId, feedbackSubmissions.id),
        )
        .where(filter)
        .groupBy(
          feedbackSubmissions.driverId,
          feedbackSubmissions.driverNameSnapshot,
          feedbackSubmissions.driverSourceSnapshot,
          feedbackSubmissions.vendorId,
          feedbackSubmissions.vendorNameSnapshot,
        )
        .orderBy(asc(feedbackSubmissions.driverNameSnapshot), asc(feedbackSubmissions.driverId)),
      this.db
        .select({
          sourceType: feedbackSubmissions.driverSourceSnapshot,
          averageScore,
          responseCount,
          answerCount,
        })
        .from(feedbackAnswers)
        .innerJoin(
          feedbackSubmissions,
          eq(feedbackAnswers.feedbackSubmissionId, feedbackSubmissions.id),
        )
        .where(filter)
        .groupBy(feedbackSubmissions.driverSourceSnapshot)
        .orderBy(asc(feedbackSubmissions.driverSourceSnapshot)),
      this.db
        .select({
          vendorId: feedbackSubmissions.vendorId,
          vendorName: feedbackSubmissions.vendorNameSnapshot,
          averageScore,
          responseCount,
          answerCount,
        })
        .from(feedbackAnswers)
        .innerJoin(
          feedbackSubmissions,
          eq(feedbackAnswers.feedbackSubmissionId, feedbackSubmissions.id),
        )
        .where(and(filter, isNotNull(feedbackSubmissions.vendorId)))
        .groupBy(feedbackSubmissions.vendorId, feedbackSubmissions.vendorNameSnapshot)
        .orderBy(asc(feedbackSubmissions.vendorNameSnapshot), asc(feedbackSubmissions.vendorId)),
    ]);

    return {
      drivers: drivers.map((item) => ({
        driver: {
          id: item.driverId,
          displayName: item.driverName,
          sourceType: item.sourceType,
          vendorId: item.vendorId,
          vendorName: item.vendorName,
        },
        averageScore: item.averageScore,
        responseCount: item.responseCount,
        answerCount: item.answerCount,
      })),
      sources,
      vendors: vendors.map((item) => ({
        vendorId: item.vendorId!,
        vendorName: item.vendorName!,
        averageScore: item.averageScore,
        responseCount: item.responseCount,
        answerCount: item.answerCount,
      })),
    };
  }

  private async countNegativeFeedback(
    filters: AnalyticsFilters,
    timezone: string,
    threshold: number,
  ): Promise<number> {
    const scoreFilter = buildScoreFilter(filters, timezone);
    const perSubmission = this.db
      .select({
        submissionId: feedbackSubmissions.id,
        averageScore,
      })
      .from(feedbackAnswers)
      .innerJoin(
        feedbackSubmissions,
        eq(feedbackAnswers.feedbackSubmissionId, feedbackSubmissions.id),
      )
      .where(scoreFilter)
      .groupBy(feedbackSubmissions.id)
      .having(sql`${averageScore} <= ${threshold}`)
      .as('negative_feedback');
    const [result] = await this.db.select({ value: count() }).from(perSubmission);
    return result?.value ?? 0;
  }
}

function buildScoreFilter(filters: AnalyticsFilters, timezone: string): SQL | undefined {
  const conditions: SQL[] = [
    ne(feedbackSubmissions.currentReviewState, 'ARCHIVED'),
    isNotNull(feedbackAnswers.numericScore),
    eq(feedbackAnswers.questionnairePurposeSnapshot, 'DRIVER_FEEDBACK'),
  ];
  if (filters.month) conditions.push(monthCondition(filters.month, timezone));
  if (filters.driverId) conditions.push(eq(feedbackSubmissions.driverId, filters.driverId));
  if (filters.driverSource)
    conditions.push(eq(feedbackSubmissions.driverSourceSnapshot, filters.driverSource));
  if (filters.vendorId) conditions.push(eq(feedbackSubmissions.vendorId, filters.vendorId));
  if (filters.category) conditions.push(eq(feedbackAnswers.categorySnapshot, filters.category));
  return and(...conditions);
}
