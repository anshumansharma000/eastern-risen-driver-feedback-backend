import { CommercialBookingListRepository } from '../persistence/booking-list.repository.js';
import type { BookingListQuery } from '../http/booking-list.schemas.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, exists, ilike, inArray, or, sql } from 'drizzle-orm';
import type { CoreDatabase, CoreTransaction } from '../persistence/database.js';
import type { PaymentProvider } from './payment-provider.js';
import type { BillingRepository } from '../persistence/billing.repository.js';
import { customers } from '../persistence/masters.schema.js';
import {
  invoiceLines,
  invoiceLineTaxes,
  invoices,
  receipts,
} from '../persistence/billing.schema.js';
import {
  commercialBookings,
  commercialQuotes,
  paymentAttempts,
  paymentReconciliationJobs,
  paymentWebhookEvents,
  paymentMilestones,
  paymentOrders,
  paymentPolicies,
} from '../persistence/commercial.schema.js';
import { conflict, invalid, missing } from '../domain/errors.js';
import { decimal, minor, sum } from '../domain/money.js';
import { allocateMilestones } from '../domain/milestones.js';
import type { InvoiceInput } from './billing.contracts.js';
import type {
  StructuredQuoteInput,
  ProposedPlan,
  InvoiceReviewDetails,
} from './commercial.contracts.js';
import { requestHash } from '../persistence/billing.repository.js';
import { validateDate } from '../domain/validation.js';
import { validateProposedMilestones } from '../domain/proposed-plan.js';
import { audit } from '../persistence/audit.js';
import { enqueuePaymentReconciliation } from './payment-reconciliation.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { ReviewReason } from './payment-review.contracts.js';

export type BookingAuthorization = (
  tx: CoreTransaction,
  booking: typeof commercialBookings.$inferSelect,
) => Promise<void>;

export interface MilestoneInput {
  label: string;
  amount: string;
  dueOn: string;
}
export interface CommercialBookingInput {
  reference: string;
  companyId: string;
  customerId: string;
  serviceCategoryId: string;
  title: string;
  serviceStartsOn?: string | null;
  serviceEndsOn?: string | null;
}
export interface QuoteInput {
  description: string;
  inclusions: string;
  exclusions: string;
  terms: string;
  total?: string;
  lines?: StructuredQuoteInput['lines'];
  taxEffectiveDate?: string;
  paymentPlan?: StructuredQuoteInput['paymentPlan'];
  expiresOn?: string | null;
}
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);

/** Business rules stay independent of the gateway; each collection uses a PaymentProvider. */
export class CommercialService {
  constructor(
    private readonly db: CoreDatabase,
    private readonly billing: BillingRepository,
    private readonly provider: PaymentProvider | null,
    private readonly pendingReviewAfterHours = 24,
  ) {}

  async create(input: CommercialBookingInput, actorId: string) {
    if (
      input.serviceStartsOn &&
      input.serviceEndsOn &&
      input.serviceEndsOn < input.serviceStartsOn
    ) {
      throw invalid('Service end date must not precede start date');
    }
    const token = randomBytes(32).toString('base64url');
    const [booking] = await this.db
      .insert(commercialBookings)
      .values({
        reference: input.reference.trim(),
        companyId: input.companyId,
        customerId: input.customerId,
        serviceCategoryId: input.serviceCategoryId,
        title: input.title.trim(),
        serviceStartsOn: input.serviceStartsOn ?? null,
        serviceEndsOn: input.serviceEndsOn ?? null,
        accessTokenHash: tokenHash(token),
        createdBy: actorId,
      })
      .returning();
    return { booking: booking!, accessToken: token };
  }

  async list(page: number, pageSize: number, filters: BookingListQuery = {}) {
    return (await this.listPage({ ...filters, page, pageSize })).items;
  }

  async listPage(input: BookingListQuery) {
    return new CommercialBookingListRepository(this.db).list(input);
  }

  private async requireBooking(id: string) {
    const [booking] = await this.db
      .select()
      .from(commercialBookings)
      .where(eq(commercialBookings.id, id));
    if (!booking) throw missing('Commercial booking');
    return booking;
  }

  async get(id: string) {
    const booking = await this.requireBooking(id);
    const [quotes, milestones] = await Promise.all([
      this.db
        .select()
        .from(commercialQuotes)
        .where(eq(commercialQuotes.bookingId, id))
        .orderBy(desc(commercialQuotes.version)),
      this.db
        .select()
        .from(paymentMilestones)
        .where(eq(paymentMilestones.bookingId, id))
        .orderBy(asc(paymentMilestones.position)),
    ]);
    const orders = milestones.length
      ? await this.db
          .select()
          .from(paymentOrders)
          .where(
            inArray(
              paymentOrders.milestoneId,
              milestones.map((m) => m.id),
            ),
          )
      : [];
    const attempts = orders.length
      ? await this.db
          .select()
          .from(paymentAttempts)
          .where(
            inArray(
              paymentAttempts.orderId,
              orders.map((order) => order.id),
            ),
          )
      : [];
    const reconciliation = orders.length
      ? await this.db
          .select()
          .from(paymentReconciliationJobs)
          .where(
            inArray(
              paymentReconciliationJobs.orderId,
              orders.map((order) => order.id),
            ),
          )
      : [];
    const invoice = booking.invoiceId ? await this.billing.get(booking.invoiceId) : null;
    return {
      booking,
      quotes: quotes.map((quote) => ({ ...quote, legacy: !quote.pricing })),
      milestones: allocateMilestones(milestones, invoice?.receivedAmount ?? '0.00'),
      orders,
      attempts,
      reconciliation,
      invoice,
    };
  }

  async availableInvoices(id: string, query = '', page = 1, pageSize = 25) {
    const booking = await this.requireBooking(id);
    const [quote] = await this.db
      .select()
      .from(commercialQuotes)
      .where(eq(commercialQuotes.bookingId, id))
      .orderBy(desc(commercialQuotes.version))
      .limit(1);
    const term = query.trim().replace(/[\\%_]/g, '\\$&');
    const pattern = `%${term}%`;
    const customerName = sql<string>`coalesce(${invoices.snapshot}->'customer'->>'name', ${customers.name})`;
    const guestName = sql<string>`coalesce(${invoices.snapshot}->'guest'->>'name', ${invoices.details}->>'guestDisplayText', '')`;
    const label = sql<string | null>`nullif(${invoices.details}->>'label', '')`;
    const lineDescription = sql<string | null>`(
      select line.description from ${invoiceLines} line
      where line.invoice_id = ${invoices.id}
      ${term ? sql`and line.description ilike ${pattern}` : sql``}
      order by line.position limit 1
    )`;
    const linked = exists(
      this.db
        .select({ id: commercialBookings.id })
        .from(commercialBookings)
        .where(eq(commercialBookings.invoiceId, invoices.id)),
    );
    const filter = term
      ? or(
          ilike(invoices.invoiceNumber, pattern),
          ilike(customerName, pattern),
          ilike(customers.name, pattern),
          ilike(guestName, pattern),
          ilike(sql<string>`coalesce(${invoices.details}->>'guestDisplayText', '')`, pattern),
          ilike(label, pattern),
          exists(
            this.db
              .select({ id: invoiceLines.id })
              .from(invoiceLines)
              .where(
                and(
                  eq(invoiceLines.invoiceId, invoices.id),
                  ilike(invoiceLines.description, pattern),
                ),
              ),
          ),
        )
      : undefined;
    const [candidates, [total]] = await Promise.all([
      this.db
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          financialYear: invoices.financialYear,
          invoiceDate: invoices.invoiceDate,
          status: invoices.status,
          companyId: invoices.companyId,
          customerId: invoices.customerId,
          serviceCategoryId: invoices.serviceCategoryId,
          grandTotal: invoices.grandTotal,
          customerName,
          guestName,
          label,
          lineDescription,
          linked,
        })
        .from(invoices)
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        .where(filter)
        .orderBy(desc(invoices.invoiceDate), desc(invoices.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db
        .select({ value: count() })
        .from(invoices)
        .innerJoin(customers, eq(customers.id, invoices.customerId))
        .where(filter),
    ]);
    return {
      items: candidates.map((invoice) => {
        const unavailableReasons: string[] = [];
        if (booking.invoiceId) unavailableReasons.push('Booking already has an invoice');
        if (!quote?.acceptedAt) unavailableReasons.push('Latest quote has not been accepted');
        if (invoice.status !== 'ISSUED') unavailableReasons.push('Invoice is not issued');
        if (invoice.linked) unavailableReasons.push('Invoice is already linked to a booking');
        if (invoice.companyId !== booking.companyId)
          unavailableReasons.push('Company does not match booking');
        if (invoice.customerId !== booking.customerId)
          unavailableReasons.push('Customer record does not match booking');
        if (invoice.serviceCategoryId !== booking.serviceCategoryId)
          unavailableReasons.push('Service category does not match booking');
        if (quote && minor(invoice.grandTotal) !== minor(quote.total))
          unavailableReasons.push('Invoice grand total does not match accepted quote');
        return {
          id: invoice.id,
          invoiceNumber: invoice.invoiceNumber,
          financialYear: invoice.financialYear,
          invoiceDate: invoice.invoiceDate,
          status: invoice.status,
          grandTotal: invoice.grandTotal,
          customerName: invoice.customerName,
          guestName: invoice.guestName,
          label: invoice.label,
          lineDescription: invoice.lineDescription,
          eligible: unavailableReasons.length === 0,
          unavailableReasons,
        };
      }),
      total: total!.value,
    };
  }

  async byToken(token: string) {
    const [booking] = await this.db
      .select()
      .from(commercialBookings)
      .where(eq(commercialBookings.accessTokenHash, tokenHash(token)));
    if (!booking) throw missing('Commercial booking');
    return booking;
  }

  async rotateAccessToken(id: string, actorId: string) {
    await this.requireBooking(id);
    const token = randomBytes(32).toString('base64url');
    await this.db.transaction(async (tx) => {
      await tx
        .update(commercialBookings)
        .set({ accessTokenHash: tokenHash(token), updatedAt: new Date() })
        .where(eq(commercialBookings.id, id));
      await audit(tx, actorId, 'COMMERCIAL_LINK_ROTATED', 'commercial_booking', id);
    });
    return { accessToken: token };
  }

  async publicDetail(token: string) {
    const booking = await this.byToken(token);
    return this.customerDetail(booking.id);
  }

  async customerDetail(id: string) {
    const detail = await this.get(id);
    const booking = detail.booking;
    return {
      reference: booking.reference,
      title: booking.title,
      status: booking.status,
      serviceStartsOn: booking.serviceStartsOn,
      serviceEndsOn: booking.serviceEndsOn,
      quote: detail.quotes[0]
        ? {
            id: detail.quotes[0].id,
            legacy: !detail.quotes[0].pricing,
            pricing: detail.quotes[0].pricing,
            proposedPlan: detail.quotes[0].proposedPlan,
            version: detail.quotes[0].version,
            description: detail.quotes[0].description,
            inclusions: detail.quotes[0].inclusions,
            exclusions: detail.quotes[0].exclusions,
            terms: detail.quotes[0].terms,
            total: detail.quotes[0].total,
            currency: 'INR' as const,
            expiresOn: detail.quotes[0].expiresOn,
            acceptedAt: detail.quotes[0].acceptedAt?.toISOString() ?? null,
          }
        : null,
      invoice: detail.invoice
        ? {
            number: detail.invoice.invoiceNumber,
            date: detail.invoice.invoiceDate,
            total: detail.invoice.grandTotal,
            received: detail.invoice.receivedAmount,
            due: detail.invoice.dueAmount,
            paymentStatus: detail.invoice.paymentStatus,
          }
        : null,
      paymentReady:
        detail.invoice?.status === 'ISSUED' &&
        detail.milestones.length > 0 &&
        ['INVOICED', 'CONFIRMED'].includes(booking.status),
      nextAction: ['CANCELLED', 'COMPLETED'].includes(booking.status)
        ? 'BOOKING_CLOSED'
        : !detail.quotes[0]
          ? 'AWAIT_QUOTE'
          : !detail.quotes[0].acceptedAt
            ? detail.quotes[0].expiresOn && detail.quotes[0].expiresOn < today()
              ? 'QUOTE_EXPIRED'
              : 'REVIEW_AND_ACCEPT'
            : detail.invoice?.status === 'ISSUED' && detail.milestones.length > 0
              ? detail.invoice.dueAmount === '0.00'
                ? 'PAYMENT_COMPLETE'
                : 'PAY'
              : 'AWAIT_ADMIN_PAYMENT_ENABLEMENT',
      paymentReviewRequired:
        detail.orders.some(
          (order) => order.status === 'REVIEW_REQUIRED' || order.reviewRequiredAt !== null,
        ) ||
        detail.attempts.some(
          (a) =>
            a.status === 'SUCCESS' &&
            a.accountingStatus !== 'REFUNDED' &&
            (a.accountingStatus === 'REVIEW_REQUIRED' ||
              detail.invoice?.receipts.some(
                (r) => r.id === a.receiptId && r.status === 'REVERSED',
              )),
        ),
      payments: (detail.invoice?.receipts ?? [])
        .filter((receipt) => receipt.status === 'CONFIRMED')
        .map((receipt) => ({
          number: receipt.receiptNumber,
          date: receipt.receivedDate,
          amount: receipt.amount,
          method: receipt.method,
        })),
      milestones: detail.milestones.map((milestone) => ({
        id: milestone.id,
        position: milestone.position,
        label: milestone.label,
        amount: milestone.amount,
        dueOn: milestone.dueOn,
        status: milestone.status,
        remainingAmount: milestone.remainingAmount,
        paid: milestone.status === 'PAID',
        remaining: milestone.remainingAmount,
      })),
    };
  }

  private async proposedQuote(
    tx: CoreTransaction,
    booking: typeof commercialBookings.$inferSelect,
    input: StructuredQuoteInput,
  ) {
    const pricing = await this.billing.calculateQuote(
      tx,
      input.lines,
      booking.serviceCategoryId,
      input.taxEffectiveDate,
    );
    if (minor(pricing.grandTotal) <= 0n) throw invalid('Quote total must be positive');
    let policy: ProposedPlan['policy'] = null;
    let milestones: MilestoneInput[];
    if (input.paymentPlan.mode === 'COMPANY_DEFAULT') {
      if (input.paymentPlan.milestones)
        throw invalid('Default payment plans cannot contain custom milestones');
      if (!booking.serviceStartsOn)
        throw conflict(
          'PAYMENT_PLAN_PREREQUISITES_MISSING',
          'Provide a service start date or a custom payment plan',
        );
      const [saved] = await tx
        .select()
        .from(paymentPolicies)
        .where(eq(paymentPolicies.companyId, booking.companyId))
        .for('share');
      policy = saved
        ? {
            initialPercent: saved.initialPercent,
            balanceDaysBefore: saved.balanceDaysBefore,
            fullPaymentWithinDays: saved.fullPaymentWithinDays,
          }
        : { initialPercent: 30, balanceDaysBefore: 30, fullPaymentWithinDays: 30 };
      milestones = this.defaultSchedule(pricing.grandTotal, booking.serviceStartsOn, policy);
    } else {
      if (!input.paymentPlan.milestones) throw invalid('Custom payment plans require milestones');
      milestones = input.paymentPlan.milestones;
    }
    validateProposedMilestones(milestones, pricing.grandTotal, today());
    const proposedPlan: ProposedPlan = {
      mode: input.paymentPlan.mode,
      milestones: milestones.map((m) => ({ ...m, label: m.label.trim() })),
      policy,
      resolvedOn: today(),
      overdueRule: 'KEEP_ACCEPTED_DATES',
    };
    return { pricing, proposedPlan };
  }

  async calculateQuote(id: string, input: StructuredQuoteInput) {
    return this.db.transaction(async (tx) => {
      const [booking] = await tx
        .select()
        .from(commercialBookings)
        .where(eq(commercialBookings.id, id))
        .for('share');
      if (!booking) throw missing('Commercial booking');
      return this.proposedQuote(tx, booking, input);
    });
  }

  private async reviewInTransaction(
    tx: CoreTransaction,
    booking: typeof commercialBookings.$inferSelect,
    details: Partial<InvoiceReviewDetails>,
  ) {
    const [quote] = await tx
      .select()
      .from(commercialQuotes)
      .where(eq(commercialQuotes.bookingId, booking.id))
      .orderBy(desc(commercialQuotes.version))
      .limit(1);
    const errors: { code: string; message: string }[] = [];
    if (booking.invoiceId || booking.status !== 'QUOTED')
      errors.push({
        code: 'LEGACY_BILLING_CONFLICT',
        message:
          'Continue existing manual billing for partially processed bookings; closed bookings cannot enable payment',
      });
    if (!quote?.acceptedAt)
      errors.push({ code: 'QUOTE_NOT_ACCEPTED', message: 'Customer must accept the latest quote' });
    if (!quote?.pricing || !quote.proposedPlan)
      errors.push({
        code: 'LEGACY_QUOTE_REQUIRES_REVISION',
        message: 'Use manual billing or prepare a structured revision and obtain fresh acceptance',
      });
    const existing = await tx
      .select({ id: paymentMilestones.id })
      .from(paymentMilestones)
      .where(eq(paymentMilestones.bookingId, booking.id));
    if (existing.length)
      errors.push({
        code: 'LEGACY_BILLING_CONFLICT',
        message: 'Continue the existing billing workflow',
      });
    const agreedDueDate = quote?.proposedPlan?.milestones
      .map((m) => m.dueOn)
      .sort()
      .at(-1);
    if (details.dueDate && details.dueDate !== agreedDueDate && quote?.proposedPlan)
      errors.push({
        code: 'AGREED_PAYMENT_TERMS_CHANGED',
        message: 'Invoice due date must match the final accepted milestone date',
      });
    const fields = {
      ...details,
      companyId: booking.companyId,
      customerId: booking.customerId,
      serviceCategoryId: booking.serviceCategoryId,
      lines:
        quote?.pricing?.lines.map((l) => ({
          description: l.description,
          amount: l.amount,
          taxTreatment: l.taxTreatment,
          taxComponents: l.taxes.map((t) => t.component),
        })) ?? [],
    };
    const required = [
      'invoiceDate',
      'guestDisplayText',
      'serviceProvidedAt',
      'placeOfSupplyState',
      'placeOfSupplyCountry',
      'bankAccountIds',
    ] as const;
    const missingFields = required.filter(
      (key) =>
        fields[key] === undefined ||
        fields[key] === null ||
        (typeof fields[key] === 'string' && !fields[key].trim()),
    );
    let calculated: Awaited<ReturnType<BillingRepository['previewInTransaction']>> | null = null;
    if (!missingFields.length && quote?.pricing) {
      try {
        calculated = await this.billing.previewInTransaction(tx, fields as InvoiceInput);
        if (
          requestHash(calculated.lines) !== requestHash(quote.pricing.lines) ||
          calculated.grandTotal !== quote.total
        )
          errors.push({
            code: 'QUOTE_PRICING_REVIEW_REQUIRED',
            message:
              'Invoice calculation differs from agreed pricing; revise quote and obtain fresh acceptance',
          });
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        errors.push({ code: error.code, message: error.message });
      }
    }
    const eligible = errors.length === 0 && missingFields.length === 0;
    const reviewToken = eligible
      ? requestHash({
          bookingId: booking.id,
          quoteId: quote!.id,
          fields,
          calculated,
          proposedPlan: quote!.proposedPlan,
        })
      : null;
    return {
      bookingId: booking.id,
      quoteId: quote?.id ?? null,
      quoteVersion: quote?.version ?? null,
      invoiceFields: fields,
      pricing: quote?.pricing ?? null,
      proposedPlan: quote?.proposedPlan ?? null,
      missingFields,
      errors,
      eligible,
      reviewToken,
    };
  }

  async billingReview(id: string, details: Partial<InvoiceReviewDetails>) {
    return this.db.transaction(async (tx) => {
      const [booking] = await tx
        .select()
        .from(commercialBookings)
        .where(eq(commercialBookings.id, id))
        .for('update');
      if (!booking) throw missing('Commercial booking');
      return this.reviewInTransaction(tx, booking, details);
    });
  }

  async enablePayment(
    id: string,
    input: { quoteId: string; reviewToken: string; invoiceDetails: InvoiceReviewDetails },
    actorId: string,
  ) {
    await this.db.transaction(async (tx) => {
      const [booking] = await tx
        .select()
        .from(commercialBookings)
        .where(eq(commercialBookings.id, id))
        .for('update');
      if (!booking) throw missing('Commercial booking');
      const hash = requestHash(input);
      if (booking.paymentActivation) {
        if (booking.paymentActivation.requestHash !== hash)
          throw conflict(
            'IDEMPOTENCY_CONFLICT',
            'Payment was enabled using a different request; reload booking',
          );
        return;
      }
      const review = await this.reviewInTransaction(tx, booking, input.invoiceDetails);
      if (review.quoteId !== input.quoteId)
        throw conflict('STALE_BILLING_REVIEW', 'Quote changed; review the latest accepted quote');
      if (review.errors.length) throw conflict(review.errors[0]!.code, review.errors[0]!.message);
      if (review.missingFields.length)
        throw invalid(`Complete invoice fields: ${review.missingFields.join(', ')}`);
      if (review.reviewToken !== input.reviewToken)
        throw conflict('STALE_BILLING_REVIEW', 'Billing data changed; review again');
      // All issuance, numbering, audit and outbox effects remain inside this transaction.
      const invoiceId = await this.billing.createDraftInTransaction(
        tx,
        review.invoiceFields as InvoiceInput,
        actorId,
      );
      await this.billing.issueInTransaction(tx, invoiceId, 1, actorId);
      await tx
        .insert(paymentMilestones)
        .values(
          review.proposedPlan!.milestones.map((m, i) => ({ ...m, bookingId: id, position: i + 1 })),
        );
      await tx
        .update(commercialBookings)
        .set({
          invoiceId,
          status: 'INVOICED',
          paymentActivation: { quoteId: input.quoteId, requestHash: hash },
          updatedAt: new Date(),
        })
        .where(eq(commercialBookings.id, id));
      await audit(tx, actorId, 'COMMERCIAL_PAYMENT_ENABLED', 'commercial_booking', id);
    });
    return this.get(id);
  }

  async addQuote(id: string, input: QuoteInput, actorId: string) {
    if (input.expiresOn) validateDate(input.expiresOn);
    const structured = input.lines !== undefined;
    if (
      structured !== (input.paymentPlan !== undefined) ||
      structured !== (input.taxEffectiveDate !== undefined)
    )
      throw invalid('Structured quotes require lines, taxEffectiveDate and paymentPlan together');
    if (!structured && (!input.total || minor(input.total) <= 0n))
      throw invalid('Quote total must be positive');
    return this.db.transaction(async (tx) => {
      const [booking] = await tx
        .select()
        .from(commercialBookings)
        .where(eq(commercialBookings.id, id))
        .for('update');
      if (!booking) throw missing('Commercial booking');
      if (booking.invoiceId || booking.status === 'CANCELLED' || booking.status === 'COMPLETED')
        throw conflict('BOOKING_NOT_QUOTABLE', 'This booking cannot be quoted');
      const [latest] = await tx
        .select()
        .from(commercialQuotes)
        .where(eq(commercialQuotes.bookingId, id))
        .orderBy(desc(commercialQuotes.version))
        .limit(1);
      const snapshot = structured
        ? await this.proposedQuote(tx, booking, input as StructuredQuoteInput)
        : null;
      if (snapshot && input.total && minor(input.total) !== minor(snapshot.pricing.grandTotal))
        throw invalid('Supplied total does not match calculated total');
      const [quote] = await tx
        .insert(commercialQuotes)
        .values({
          bookingId: id,
          version: (latest?.version ?? 0) + 1,
          description: input.description.trim(),
          inclusions: input.inclusions.trim(),
          exclusions: input.exclusions.trim(),
          terms: input.terms.trim(),
          total: snapshot?.pricing.grandTotal ?? input.total!,
          pricing: snapshot?.pricing ?? null,
          proposedPlan: snapshot?.proposedPlan ?? null,
          expiresOn: input.expiresOn ?? null,
        })
        .returning();
      await tx
        .update(commercialBookings)
        .set({ status: 'QUOTED', updatedAt: new Date() })
        .where(eq(commercialBookings.id, id));
      await audit(tx, actorId, 'COMMERCIAL_QUOTE_CREATED', 'commercial_quote', quote!.id);
      return quote!;
    });
  }

  async acceptQuote(token: string, quoteVersion?: number) {
    const booking = await this.byToken(token);
    return this.acceptForBooking(
      booking.id,
      null,
      async (_tx, current) => {
        if (current.accessTokenHash !== tokenHash(token)) throw missing('Commercial booking');
      },
      quoteVersion,
    );
  }

  async acceptForBooking(
    id: string,
    actorId: string | null,
    authorize: BookingAuthorization,
    quoteVersion?: number,
  ) {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(commercialBookings)
        .where(eq(commercialBookings.id, id))
        .for('update');
      if (!locked) throw missing('Commercial booking');
      await authorize(tx, locked);
      if (locked.status !== 'QUOTED')
        throw conflict('QUOTE_NOT_ACCEPTABLE', 'Quote cannot be accepted');
      const [quote] = await tx
        .select()
        .from(commercialQuotes)
        .where(eq(commercialQuotes.bookingId, id))
        .orderBy(desc(commercialQuotes.version))
        .limit(1);
      if (!quote || (quote.expiresOn && quote.expiresOn < today()))
        throw conflict('QUOTE_EXPIRED', 'Quote has expired');
      if (quoteVersion !== undefined && quote.version !== quoteVersion)
        throw conflict('QUOTE_VERSION_CHANGED', 'The quote has changed; review the latest version');
      if (quote.pricing && quoteVersion === undefined)
        throw conflict('QUOTE_VERSION_REQUIRED', 'Specify the quote version you reviewed');
      if (quote.acceptedAt) return quote;
      const [accepted] = await tx
        .update(commercialQuotes)
        .set({ acceptedAt: new Date() })
        .where(eq(commercialQuotes.id, quote.id))
        .returning();
      await audit(
        tx,
        actorId ?? locked.createdBy,
        actorId ? 'CUSTOMER_QUOTE_ACCEPTED' : 'LINK_QUOTE_ACCEPTED',
        'commercial_quote',
        quote.id,
      );
      return accepted!;
    });
  }

  async attachInvoice(
    id: string,
    identifier: { invoiceId: string } | { invoiceNumber: string; financialYear?: string },
    actorId: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [booking] = await tx
        .select()
        .from(commercialBookings)
        .where(eq(commercialBookings.id, id))
        .for('update');
      if (!booking) throw missing('Commercial booking');
      if (booking.invoiceId)
        throw conflict('BOOKING_ALREADY_INVOICED', 'Booking already has an invoice');
      const [quote] = await tx
        .select()
        .from(commercialQuotes)
        .where(eq(commercialQuotes.bookingId, id))
        .orderBy(desc(commercialQuotes.version))
        .limit(1);
      if (!quote?.acceptedAt)
        throw conflict('QUOTE_NOT_ACCEPTED', 'Customer must accept the latest quote first');
      if (booking.status !== 'QUOTED')
        throw conflict('BOOKING_NOT_INVOICEABLE', 'Only quoted bookings can link an invoice');
      const invoiceRows = await tx
        .select()
        .from(invoices)
        .where(
          'invoiceId' in identifier
            ? eq(invoices.id, identifier.invoiceId)
            : and(
                eq(invoices.companyId, booking.companyId),
                eq(invoices.invoiceNumber, identifier.invoiceNumber.trim()),
                identifier.financialYear
                  ? eq(invoices.financialYear, identifier.financialYear)
                  : undefined,
              ),
        )
        .limit(2)
        .for('share');
      if (!invoiceRows.length) throw missing('Invoice');
      if (invoiceRows.length > 1)
        throw conflict('INVOICE_NUMBER_AMBIGUOUS', 'Select an invoice with its financial year');
      const invoice = invoiceRows[0]!;
      if (invoice.status !== 'ISSUED')
        throw conflict('INVOICE_NOT_ISSUED', 'Issue the invoice before linking it');
      if (
        booking.customerId !== invoice.customerId ||
        booking.companyId !== invoice.companyId ||
        booking.serviceCategoryId !== invoice.serviceCategoryId ||
        minor(quote.total) !== minor(invoice.grandTotal)
      ) {
        throw invalid(
          'Invoice company, customer, category and total must match the accepted quote',
        );
      }
      if (quote.pricing) {
        const lines = await tx
          .select()
          .from(invoiceLines)
          .where(eq(invoiceLines.invoiceId, invoice.id))
          .orderBy(asc(invoiceLines.position));
        const taxes = lines.length
          ? await tx
              .select()
              .from(invoiceLineTaxes)
              .where(
                inArray(
                  invoiceLineTaxes.lineId,
                  lines.map((l) => l.id),
                ),
              )
          : [];
        const agreed = quote.pricing.lines.map((l) => ({
          ...l,
          taxes: [...l.taxes].sort((a, b) => a.component.localeCompare(b.component)),
        }));
        const actual = lines.map((l) => ({
          position: l.position,
          description: l.description,
          amount: l.amount,
          taxTreatment: l.taxTreatment,
          taxAmount: l.taxAmount,
          total: l.total,
          taxes: taxes
            .filter((t) => t.lineId === l.id)
            .map((t) => ({
              ruleId: t.ruleId,
              component: t.component,
              rate: t.rate,
              amount: t.amount,
            }))
            .sort((a, b) => a.component.localeCompare(b.component)),
        }));
        if (requestHash(agreed) !== requestHash(actual))
          throw conflict(
            'QUOTE_PRICING_REVIEW_REQUIRED',
            'Invoice line and tax details must match the accepted quote',
          );
      }
      const [updated] = await tx
        .update(commercialBookings)
        .set({ invoiceId: invoice.id, status: 'INVOICED', updatedAt: new Date() })
        .where(eq(commercialBookings.id, id))
        .returning();
      await audit(tx, actorId, 'COMMERCIAL_INVOICE_LINKED', 'commercial_booking', id);
      return updated!;
    });
  }

  async getPolicy(companyId: string) {
    const [policy] = await this.db
      .select()
      .from(paymentPolicies)
      .where(eq(paymentPolicies.companyId, companyId));
    return (
      policy ?? {
        companyId,
        initialPercent: 30,
        balanceDaysBefore: 30,
        fullPaymentWithinDays: 30,
        updatedAt: null,
      }
    );
  }

  async setPolicy(
    companyId: string,
    values: { initialPercent: number; balanceDaysBefore: number; fullPaymentWithinDays: number },
    actorId: string,
  ) {
    const [policy] = await this.db
      .insert(paymentPolicies)
      .values({ companyId, ...values })
      .onConflictDoUpdate({
        target: paymentPolicies.companyId,
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    await this.db.transaction((tx) =>
      audit(tx, actorId, 'PAYMENT_POLICY_UPDATED', 'company', companyId),
    );
    return policy!;
  }

  defaultSchedule(
    total: string,
    serviceStartsOn: string | null,
    policy = { initialPercent: 30, balanceDaysBefore: 30, fullPaymentWithinDays: 30 },
  ): MilestoneInput[] {
    const dueNow = today();
    const travelDate = serviceStartsOn ? new Date(`${serviceStartsOn}T00:00:00Z`) : null;
    if (
      !travelDate ||
      travelDate.getTime() - new Date(`${dueNow}T00:00:00Z`).getTime() <=
        policy.fullPaymentWithinDays * 86400000
    )
      return [{ label: 'Full payment', amount: total, dueOn: dueNow }];
    const advance = (minor(total) * BigInt(policy.initialPercent) + 50n) / 100n;
    const balanceDate = new Date(travelDate.getTime() - policy.balanceDaysBefore * 86400000)
      .toISOString()
      .slice(0, 10);
    if (balanceDate < dueNow || advance <= 0n || advance >= minor(total))
      return [{ label: 'Full payment', amount: total, dueOn: dueNow }];
    return [
      { label: 'Initial payment', amount: decimal(advance), dueOn: dueNow },
      { label: 'Balance', amount: decimal(minor(total) - advance), dueOn: balanceDate },
    ];
  }

  async setSchedule(id: string, input: MilestoneInput[] | undefined, actorId: string) {
    const booking = await this.requireBooking(id);
    if (!booking.invoiceId || booking.status !== 'INVOICED')
      throw conflict('BOOKING_NOT_SCHEDULABLE', 'An issued invoice is required');
    const invoice = await this.billing.get(booking.invoiceId);
    if (invoice.status !== 'ISSUED') throw conflict('INVOICE_NOT_ISSUED', 'Invoice is not issued');
    const schedule =
      input ??
      this.defaultSchedule(
        invoice.grandTotal,
        booking.serviceStartsOn,
        await this.getPolicy(booking.companyId),
      );
    if (
      !schedule.length ||
      schedule.length > 12 ||
      schedule.some((m) => !m.label.trim() || minor(m.amount) <= 0n || m.dueOn < today()) ||
      minor(sum(schedule.map((m) => m.amount))) !== minor(invoice.grandTotal)
    ) {
      throw invalid(
        'Payment schedule must contain positive INR amounts adding up to the invoice total, with valid future due dates',
      );
    }
    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(commercialBookings)
        .where(eq(commercialBookings.id, id))
        .for('update');
      if (!locked || locked.status !== 'INVOICED')
        throw conflict('BOOKING_NOT_SCHEDULABLE', 'Booking cannot be scheduled');
      const existing = await tx
        .select({ id: paymentMilestones.id })
        .from(paymentMilestones)
        .where(eq(paymentMilestones.bookingId, id));
      if (existing.length)
        throw conflict('SCHEDULE_ALREADY_SET', 'Payment schedule is already set');
      const [quote] = await tx
        .select()
        .from(commercialQuotes)
        .where(eq(commercialQuotes.bookingId, id))
        .orderBy(desc(commercialQuotes.version))
        .limit(1);
      if (
        quote?.proposedPlan &&
        requestHash(schedule) !== requestHash(quote.proposedPlan.milestones)
      )
        throw conflict(
          'AGREED_PAYMENT_TERMS_CHANGED',
          'Use the exact accepted payment plan; changed terms require a quote revision before invoice linking',
        );
      const rows = await tx
        .insert(paymentMilestones)
        .values(
          schedule.map((milestone, index) => ({
            bookingId: id,
            position: index + 1,
            ...milestone,
          })),
        )
        .returning();
      await audit(tx, actorId, 'COMMERCIAL_SCHEDULE_CREATED', 'commercial_booking', id);
      return rows;
    });
  }

  async checkout(token: string, milestoneId: string) {
    const booking = await this.byToken(token);
    return this.checkoutForBooking(
      booking.id,
      null,
      async (_tx, current) => {
        if (current.accessTokenHash !== tokenHash(token)) throw missing('Commercial booking');
      },
      milestoneId,
    );
  }

  async checkoutForBooking(
    id: string,
    actorId: string | null,
    authorize: BookingAuthorization,
    milestoneId: string,
  ) {
    if (!this.provider)
      throw new AppError({
        code: 'PAYMENTS_UNAVAILABLE',
        message: 'Online payments are not configured',
        statusCode: 503,
      });
    const booking = await this.requireBooking(id);
    await authorize(this.db, booking);
    if (!booking.invoiceId || !['INVOICED', 'CONFIRMED'].includes(booking.status))
      throw conflict('BOOKING_NOT_PAYABLE', 'Booking is not payable');
    const previous = await this.db
      .select({ providerOrderId: paymentOrders.providerOrderId, status: paymentOrders.status })
      .from(paymentOrders)
      .innerJoin(paymentMilestones, eq(paymentMilestones.id, paymentOrders.milestoneId))
      .where(
        and(
          eq(paymentMilestones.bookingId, booking.id),
          inArray(paymentOrders.status, ['CREATING', 'READY', 'EXPIRED', 'TERMINATED']),
        ),
      );
    for (const order of previous) {
      const result = await this.reconcile(order.providerOrderId);
      if (result.hasUnresolvedAttempts)
        throw conflict(
          'PAYMENT_ATTEMPT_PENDING',
          'An earlier payment is still being confirmed; wait before paying again',
        );
      if (result.orderStatus === 'READY' && !result.canRetry)
        throw conflict(
          'PAYMENT_ORDER_UNAVAILABLE',
          'The checkout session cannot be reused; wait for verification or contact staff',
        );
    }
    const invoice = await this.billing.get(booking.invoiceId);
    if (invoice.status !== 'ISSUED') throw conflict('INVOICE_NOT_ISSUED', 'Invoice is not issued');
    const [milestone] = await this.db
      .select()
      .from(paymentMilestones)
      .where(
        and(eq(paymentMilestones.id, milestoneId), eq(paymentMilestones.bookingId, booking.id)),
      );
    if (!milestone) throw missing('Payment milestone');
    const milestones = await this.db
      .select()
      .from(paymentMilestones)
      .where(eq(paymentMilestones.bookingId, booking.id))
      .orderBy(asc(paymentMilestones.position));
    const reviewOrders = await this.db
      .select({ id: paymentOrders.id })
      .from(paymentOrders)
      .where(
        and(
          inArray(
            paymentOrders.milestoneId,
            milestones.map((item) => item.id),
          ),
          or(
            eq(paymentOrders.status, 'REVIEW_REQUIRED'),
            sql`exists (select 1 from ${paymentAttempts} a join ${receipts} r on r.id = a.receipt_id where a.order_id = ${paymentOrders.id} and a.status = 'SUCCESS' and a.accounting_status <> 'REFUNDED' and r.status = 'REVERSED')`,
            exists(
              this.db
                .select({ id: paymentAttempts.id })
                .from(paymentAttempts)
                .where(
                  and(
                    eq(paymentAttempts.orderId, paymentOrders.id),
                    eq(paymentAttempts.accountingStatus, 'REVIEW_REQUIRED'),
                  ),
                ),
            ),
          ),
        ),
      );
    if (reviewOrders.length)
      throw conflict(
        'PAYMENT_REVIEW_REQUIRED',
        'A payment needs staff review before another checkout',
      );
    const remaining = minor(
      allocateMilestones(milestones, invoice.receivedAmount).find(
        (item) => item.id === milestoneId,
      )!.remainingAmount,
    );
    if (remaining === 0n || remaining > minor(invoice.dueAmount))
      throw conflict('MILESTONE_NOT_PAYABLE', 'Milestone has been paid or invoice balance changed');
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, booking.customerId));
    const phone = customer?.mobileNumber ?? customer?.phone ?? '';
    const cleanPhone = phone.replace(/\D/g, '').slice(-10);
    if (!/^\d{10}$/.test(cleanPhone))
      throw invalid('Customer must have a ten-digit contact phone before online payment');
    const order = await this.db.transaction(async (tx) => {
      const [currentBooking] = await tx
        .select()
        .from(commercialBookings)
        .where(eq(commercialBookings.id, booking.id))
        .for('share');
      if (!currentBooking) throw missing('Commercial booking');
      await authorize(tx, currentBooking);
      const blockedAttempts = await tx
        .select({
          status: paymentAttempts.status,
          accountingStatus: paymentAttempts.accountingStatus,
        })
        .from(paymentAttempts)
        .innerJoin(paymentOrders, eq(paymentOrders.id, paymentAttempts.orderId))
        .innerJoin(paymentMilestones, eq(paymentMilestones.id, paymentOrders.milestoneId))
        .where(
          and(
            eq(paymentMilestones.bookingId, booking.id),
            or(
              inArray(paymentAttempts.status, ['PENDING', 'UNKNOWN']),
              eq(paymentAttempts.accountingStatus, 'REVIEW_REQUIRED'),
              sql`(${paymentAttempts.status} = 'SUCCESS' and ${paymentAttempts.accountingStatus} <> 'REFUNDED' and exists (select 1 from ${receipts} r where r.id = ${paymentAttempts.receiptId} and r.status = 'REVERSED'))`,
            ),
          ),
        );
      if (
        blockedAttempts.some(
          (attempt) =>
            attempt.accountingStatus === 'REVIEW_REQUIRED' ||
            attempt.accountingStatus === 'APPLIED',
        )
      )
        throw conflict(
          'PAYMENT_REVIEW_REQUIRED',
          'A payment needs staff review before another checkout',
        );
      if (blockedAttempts.length)
        throw conflict(
          'PAYMENT_ATTEMPT_PENDING',
          'An earlier payment is still being confirmed; wait before paying again',
        );
      if (!['INVOICED', 'CONFIRMED'].includes(currentBooking.status))
        throw conflict('BOOKING_NOT_PAYABLE', 'Booking is not payable');
      await tx
        .select()
        .from(paymentMilestones)
        .where(eq(paymentMilestones.id, milestoneId))
        .for('update');
      const balance = await this.billing.settlementBalance(tx, booking.invoiceId!);
      if (balance.status !== 'ISSUED')
        throw conflict('INVOICE_NOT_ISSUED', 'Invoice is not issued');
      const currentRemaining = minor(
        allocateMilestones(milestones, balance.receivedAmount).find(
          (item) => item.id === milestoneId,
        )!.remainingAmount,
      );
      if (currentRemaining === 0n || currentRemaining > minor(balance.dueAmount))
        throw conflict(
          'MILESTONE_NOT_PAYABLE',
          'Milestone has been paid or invoice balance changed',
        );
      const existing = await tx
        .select()
        .from(paymentOrders)
        .where(eq(paymentOrders.milestoneId, milestoneId))
        .orderBy(desc(paymentOrders.createdAt));
      if (existing.some((item) => item.status === 'REVIEW_REQUIRED'))
        throw conflict(
          'PAYMENT_REVIEW_REQUIRED',
          'A payment needs staff review before another checkout',
        );
      const active = existing.find((item) => item.status === 'READY' || item.status === 'CREATING');
      if (active) {
        if (minor(active.amount) !== currentRemaining)
          throw conflict(
            'PAYMENT_ORDER_AMOUNT_CHANGED',
            'Payment balance changed; contact the administrator',
          );
        return active;
      }
      const id = randomUUID();
      const [created] = await tx
        .insert(paymentOrders)
        .values({
          id,
          milestoneId,
          provider: this.provider!.name,
          providerOrderId: `er_${id.replaceAll('-', '')}`,
          amount: decimal(currentRemaining),
        })
        .returning();
      await enqueuePaymentReconciliation(tx, created!.id);
      await audit(
        tx,
        actorId ?? booking.createdBy,
        actorId ? 'CUSTOMER_CHECKOUT_CREATED' : 'LINK_CHECKOUT_CREATED',
        'payment_order',
        created!.id,
      );
      return created!;
    });
    if (order.status === 'READY') {
      return {
        provider: order.provider,
        sessionId: order.sessionId!,
        orderId: order.providerOrderId,
        amount: order.amount,
      };
    }
    if (order.status !== 'CREATING')
      throw conflict('PAYMENT_ORDER_PENDING', 'Payment order is being created; retry shortly');
    const result = await this.provider.createOrder({
      orderId: order.providerOrderId,
      amount: order.amount,
      customerId: booking.customerId,
      customerName: customer!.name,
      customerPhone: cleanPhone,
      ...(customer?.email ? { customerEmail: customer.email } : {}),
    });
    await this.db
      .update(paymentOrders)
      .set({ sessionId: result.sessionId, status: 'READY', updatedAt: new Date() })
      .where(and(eq(paymentOrders.id, order.id), eq(paymentOrders.status, 'CREATING')));
    return {
      provider: this.provider.name,
      sessionId: result.sessionId,
      orderId: order.providerOrderId,
      amount: order.amount,
    };
  }

  /** Retry creation with the same gateway ID after a timeout or process restart. */
  async recoverCreatingOrder(providerOrderId: string) {
    const [order] = await this.db
      .select()
      .from(paymentOrders)
      .where(eq(paymentOrders.providerOrderId, providerOrderId));
    if (!order || order.status !== 'CREATING') return;
    const [milestone] = await this.db
      .select()
      .from(paymentMilestones)
      .where(eq(paymentMilestones.id, order.milestoneId));
    const booking = await this.requireBooking(milestone!.bookingId);
    if (!this.provider) throw missing('Payment provider');
    if (!['INVOICED', 'CONFIRMED'].includes(booking.status)) {
      await this.db
        .update(paymentOrders)
        .set({
          status: 'TERMINATED',
          providerStatus: 'NOT_CREATED',
          lastCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(paymentOrders.id, order.id), eq(paymentOrders.status, 'CREATING')));
      return;
    }
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(eq(customers.id, booking.customerId));
    const result = await this.provider.createOrder({
      orderId: providerOrderId,
      amount: order.amount,
      customerId: booking.customerId,
      customerName: customer!.name,
      customerPhone: (customer!.mobileNumber ?? customer!.phone ?? '')
        .replace(/\D/g, '')
        .slice(-10),
      ...(customer?.email ? { customerEmail: customer.email } : {}),
    });
    await this.db
      .update(paymentOrders)
      .set({ sessionId: result.sessionId, status: 'READY', updatedAt: new Date() })
      .where(and(eq(paymentOrders.id, order.id), eq(paymentOrders.status, 'CREATING')));
  }

  async receivePaymentWebhook(providerOrderId: string, eventKey: string) {
    if (!this.provider) throw missing('Payment provider');
    await this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(paymentOrders)
        .where(
          and(
            eq(paymentOrders.provider, this.provider!.name),
            eq(paymentOrders.providerOrderId, providerOrderId),
          ),
        );
      if (!order) throw missing('Payment order');
      const inserted = await tx
        .insert(paymentWebhookEvents)
        .values({ provider: this.provider!.name, eventKey, orderId: order.id })
        .onConflictDoNothing()
        .returning({ id: paymentWebhookEvents.id });
      if (inserted.length) await enqueuePaymentReconciliation(tx, order.id);
    });
  }

  async reconcile(providerOrderId: string, scheduleFollowUp = true) {
    if (!this.provider)
      throw new AppError({
        code: 'PAYMENTS_UNAVAILABLE',
        message: 'Online payments are not configured',
        statusCode: 503,
      });
    const [order] = await this.db
      .select()
      .from(paymentOrders)
      .where(
        and(
          eq(paymentOrders.provider, this.provider.name),
          eq(paymentOrders.providerOrderId, providerOrderId),
        ),
      );
    if (!order) throw missing('Payment order');
    if (scheduleFollowUp) await enqueuePaymentReconciliation(this.db, order.id);
    if (order.status === 'TERMINATED' && order.providerStatus === 'NOT_CREATED')
      return this.paymentResult(this.db, order);
    const [observation] = await this.db
      .select({ startedAt: sql<Date>`clock_timestamp()` })
      .from(paymentOrders)
      .where(eq(paymentOrders.id, order.id));
    const startedAt = new Date(observation!.startedAt);
    // Use the database clock so multiple hosts agree on observation ordering.
    // No network requests while holding database locks.
    let snapshot;
    try {
      snapshot = await this.provider.inspectOrder(providerOrderId);
    } catch (error) {
      if (
        !(error instanceof AppError) ||
        error.code !== 'PAYMENT_PROVIDER_ORDER_NOT_FOUND' ||
        order.status !== 'CREATING'
      )
        throw error;
      await this.recoverCreatingOrder(providerOrderId);
      const [recovered] = await this.db
        .select()
        .from(paymentOrders)
        .where(eq(paymentOrders.id, order.id));
      if (recovered!.status === 'TERMINATED') return this.paymentResult(this.db, recovered!);
      snapshot = await this.provider.inspectOrder(providerOrderId);
    }
    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(paymentOrders)
        .where(eq(paymentOrders.id, order.id))
        .for('update');
      if (!locked) throw missing('Payment order');
      if (locked.snapshotStartedAt && locked.snapshotStartedAt > startedAt)
        return this.paymentResult(tx, locked);
      const now = new Date();
      for (const attempt of snapshot.attempts) {
        const preserveTerminal = sql`${paymentAttempts.status} = 'SUCCESS' OR (${paymentAttempts.status} NOT IN ('PENDING','UNKNOWN','NOT_ATTEMPTED') AND ${attempt.status} IN ('PENDING','UNKNOWN','NOT_ATTEMPTED'))`;
        const [saved] = await tx
          .insert(paymentAttempts)
          .values({
            orderId: order.id,
            provider: this.provider!.name,
            providerPaymentId: attempt.paymentId,
            status: attempt.status,
            rawStatus: attempt.rawStatus,
            amount: attempt.amount,
            currency: attempt.currency,
            initiatedAt: new Date(attempt.initiatedAt),
            completedAt: attempt.completedAt ? new Date(attempt.completedAt) : null,
            failureCode: attempt.failureCode,
            failureMessage: attempt.failureMessage,
            accountingStatus:
              locked.status === 'PAID' &&
              locked.providerPaymentId === attempt.paymentId &&
              locked.receiptId
                ? 'APPLIED'
                : 'UNAPPLIED',
            receiptId:
              locked.status === 'PAID' && locked.providerPaymentId === attempt.paymentId
                ? locked.receiptId
                : null,
          })
          .onConflictDoUpdate({
            target: [paymentAttempts.provider, paymentAttempts.providerPaymentId],
            set: {
              // A stale pending/failure result cannot erase a verified success.
              status: sql`CASE WHEN ${preserveTerminal} THEN ${paymentAttempts.status} ELSE ${attempt.status} END`,
              rawStatus: sql`CASE WHEN ${preserveTerminal} THEN ${paymentAttempts.rawStatus} ELSE ${attempt.rawStatus} END`,
              amount: sql`CASE WHEN ${preserveTerminal} THEN ${paymentAttempts.amount} ELSE ${attempt.amount}::numeric END`,
              currency: sql`CASE WHEN ${preserveTerminal} THEN ${paymentAttempts.currency} ELSE ${attempt.currency} END`,
              completedAt: sql`CASE WHEN ${preserveTerminal} THEN ${paymentAttempts.completedAt} ELSE coalesce(${attempt.completedAt}::timestamptz, ${paymentAttempts.completedAt}) END`,
              failureCode: sql`CASE WHEN ${preserveTerminal} THEN ${paymentAttempts.failureCode} ELSE ${attempt.failureCode} END`,
              failureMessage: sql`CASE WHEN ${preserveTerminal} THEN ${paymentAttempts.failureMessage} ELSE ${attempt.failureMessage} END`,
              updatedAt: now,
            },
            setWhere: eq(paymentAttempts.orderId, order.id),
          })
          .returning();
        if (!saved) throw invalid('Provider payment belongs to a different order');
      }
      const attempts = await tx
        .select()
        .from(paymentAttempts)
        .where(eq(paymentAttempts.orderId, order.id));
      let status =
        locked.status === 'CREATING' && snapshot.status === 'ACTIVE' && snapshot.sessionId
          ? 'READY'
          : locked.status;
      let receiptId = locked.receiptId;
      let providerPaymentId = locked.providerPaymentId;
      let paidAt = locked.paidAt;
      let reviewRequiredAt = locked.reviewRequiredAt;
      let requiresAccountingReview =
        attempts.some((attempt) => attempt.accountingStatus === 'REVIEW_REQUIRED') ||
        status === 'REVIEW_REQUIRED';
      for (const payment of attempts.filter(
        (item) => item.status === 'SUCCESS' && item.accountingStatus === 'UNAPPLIED',
      )) {
        const receivedAt = payment.completedAt ?? payment.initiatedAt;
        const reasons: ReviewReason[] = [];
        if (status === 'REVIEW_REQUIRED')
          reasons.push({ code: 'ORDER_ALREADY_UNDER_REVIEW', details: {} });
        if (status === 'PAID' || status === 'REFUNDED' || receiptId)
          reasons.push({ code: 'ADDITIONAL_SUCCESS', details: {} });
        if (payment.currency !== 'INR')
          reasons.push({
            code: 'CURRENCY_MISMATCH',
            details: { expected: 'INR', actual: payment.currency },
          });
        if (minor(payment.amount) !== minor(locked.amount))
          reasons.push({
            code: 'AMOUNT_MISMATCH',
            details: { expected: locked.amount, actual: payment.amount },
          });
        let review = reasons.length > 0;
        let receipt:
          Awaited<ReturnType<BillingRepository['createReceiptInTransaction']>> | undefined;
        if (!review) {
          const [milestone] = await tx
            .select()
            .from(paymentMilestones)
            .where(eq(paymentMilestones.id, locked.milestoneId));
          const [booking] = await tx
            .select()
            .from(commercialBookings)
            .where(eq(commercialBookings.id, milestone!.bookingId))
            .for('update');
          if (!booking?.invoiceId || !['INVOICED', 'CONFIRMED'].includes(booking.status)) {
            review = true;
            reasons.push({
              code: !booking
                ? 'BOOKING_MISSING'
                : !booking.invoiceId
                  ? 'INVOICE_MISSING'
                  : 'BOOKING_INELIGIBLE',
              details: {},
            });
          } else {
            try {
              receipt = await this.billing.createReceiptInTransaction(
                tx,
                {
                  invoiceId: booking.invoiceId,
                  amount: payment.amount,
                  receivedDate: new Date(receivedAt.getTime() + 330 * 60000)
                    .toISOString()
                    .slice(0, 10),
                  method: 'GATEWAY',
                  details: { reference: `${this.provider!.name}:${payment.providerPaymentId}` },
                  status: 'CONFIRMED',
                },
                `gw_${createHash('sha256').update(`${this.provider!.name}:${payment.providerPaymentId}`).digest('hex')}`,
                booking.createdBy,
              );
              if (receipt.status !== 'CONFIRMED') {
                review = true;
                reasons.push({ code: 'RECEIPT_NOT_CONFIRMED', details: { receiptId: receipt.id } });
              }
            } catch (error) {
              if (
                error instanceof AppError &&
                [
                  'OVERPAYMENT',
                  'INVOICE_NOT_ISSUED',
                  'CORE_VALIDATION_FAILED',
                  'IDEMPOTENCY_CONFLICT',
                ].includes(error.code)
              ) {
                review = true;
                const code =
                  error.code === 'OVERPAYMENT'
                    ? 'OVERPAYMENT'
                    : error.code === 'INVOICE_NOT_ISSUED'
                      ? 'INVOICE_NOT_ISSUED'
                      : error.code === 'IDEMPOTENCY_CONFLICT'
                        ? 'RECEIPT_IDEMPOTENCY_CONFLICT'
                        : 'RECEIPT_VALIDATION_FAILED';
                reasons.push({ code, details: { errorCode: error.code } });
              } else throw error;
            }
          }
        }
        await tx
          .update(paymentAttempts)
          .set({
            accountingStatus: review ? 'REVIEW_REQUIRED' : 'APPLIED',
            reviewReasons: reasons,
            receiptId: review ? null : receipt!.id,
            updatedAt: now,
          })
          .where(eq(paymentAttempts.id, payment.id));
        if (review) {
          requiresAccountingReview = true;
          reviewRequiredAt ??= now;
          providerPaymentId ??= payment.providerPaymentId;
          paidAt ??= receivedAt;
          // Preserve an existing receipt; expose extra money as an attempt for review.
          if (status !== 'PAID') status = 'REVIEW_REQUIRED';
        } else {
          status = 'PAID';
          receiptId = receipt!.id;
          providerPaymentId = payment.providerPaymentId;
          paidAt = receivedAt;
        }
      }
      const unresolved =
        attempts.some((item) => ['PENDING', 'UNKNOWN'].includes(item.status)) ||
        snapshot.status === 'UNKNOWN' ||
        snapshot.status === 'TERMINATION_REQUESTED' ||
        (snapshot.status === 'PAID' && !attempts.some((item) => item.status === 'SUCCESS'));
      if (!unresolved && !requiresAccountingReview) reviewRequiredAt = null;
      if (
        unresolved &&
        now.getTime() - locked.createdAt.getTime() > this.pendingReviewAfterHours * 3600000
      )
        reviewRequiredAt ??= now;
      if (!['PAID', 'REVIEW_REQUIRED', 'REFUNDED'].includes(status)) {
        if (snapshot.status === 'EXPIRED') status = 'EXPIRED';
        else if (snapshot.status === 'TERMINATED') status = 'TERMINATED';
      }
      const [updated] = await tx
        .update(paymentOrders)
        .set({
          status,
          receiptId,
          providerPaymentId,
          paidAt,
          sessionId: snapshot.sessionId ?? locked.sessionId,
          providerStatus: snapshot.rawStatus,
          expiresAt: snapshot.expiresAt ? new Date(snapshot.expiresAt) : null,
          lastCheckedAt: now,
          snapshotStartedAt: startedAt,
          reviewRequiredAt,
          updatedAt: now,
        })
        .where(eq(paymentOrders.id, order.id))
        .returning();
      return this.paymentResult(tx, updated!);
    });
  }

  async reconcileById(id: string) {
    const [order] = await this.db
      .select({ reference: paymentOrders.providerOrderId })
      .from(paymentOrders)
      .where(eq(paymentOrders.id, id));
    if (!order) throw missing('Payment order');
    return this.reconcile(order.reference);
  }

  private async paymentResult(tx: CoreTransaction, order: typeof paymentOrders.$inferSelect) {
    const attempts = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, order.id))
      .orderBy(desc(paymentAttempts.initiatedAt), desc(paymentAttempts.providerPaymentId));
    const hasUnresolvedAttempts =
      attempts.some((item) => ['PENDING', 'UNKNOWN'].includes(item.status)) ||
      order.providerStatus === 'TERMINATION_REQUESTED' ||
      (order.providerStatus === 'PAID' && !attempts.some((item) => item.status === 'SUCCESS')) ||
      (order.providerStatus !== null &&
        !['ACTIVE', 'PAID', 'EXPIRED', 'TERMINATED', 'NOT_CREATED'].includes(order.providerStatus));
    const latest = attempts[0];
    const linkedIds = [
      ...new Set(
        [order.receiptId, ...attempts.map((a) => a.receiptId)].filter((id): id is string => !!id),
      ),
    ];
    const linkedReceipts = linkedIds.length
      ? await tx
          .select({ id: receipts.id, status: receipts.status })
          .from(receipts)
          .where(inArray(receipts.id, linkedIds))
      : [];
    const reversedWithoutRefund = attempts.some(
      (a) =>
        a.status === 'SUCCESS' &&
        a.accountingStatus !== 'REFUNDED' &&
        linkedReceipts.some(
          (r) =>
            r.status === 'REVERSED' &&
            (r.id === a.receiptId ||
              (a.providerPaymentId === order.providerPaymentId && r.id === order.receiptId)),
        ),
    );
    const accountingStatus =
      reversedWithoutRefund ||
      attempts.some((item) => item.accountingStatus === 'REVIEW_REQUIRED') ||
      order.status === 'REVIEW_REQUIRED'
        ? 'REVIEW_REQUIRED'
        : order.status === 'REFUNDED'
          ? 'REFUNDED'
          : order.receiptId
            ? 'APPLIED'
            : 'UNAPPLIED';
    const status =
      accountingStatus === 'REVIEW_REQUIRED'
        ? 'REVIEW_REQUIRED'
        : order.status === 'PAID'
          ? 'PAID'
          : order.status === 'REFUNDED'
            ? 'REFUNDED'
            : hasUnresolvedAttempts
              ? 'PENDING'
              : ['EXPIRED', 'TERMINATED'].includes(order.status)
                ? order.status
                : latest?.status === 'SUCCESS'
                  ? 'PENDING'
                  : (latest?.status ?? 'PENDING');
    return {
      status,
      receiptId: order.receiptId,
      orderStatus: order.status,
      latestAttemptStatus: latest?.status ?? 'NOT_ATTEMPTED',
      accountingStatus,
      hasUnresolvedAttempts,
      canRetry:
        ((order.status === 'READY' &&
          order.providerStatus === 'ACTIVE' &&
          (!order.expiresAt || order.expiresAt > new Date())) ||
          (['EXPIRED', 'TERMINATED'].includes(order.status) &&
            order.providerStatus !== 'NOT_CREATED')) &&
        !hasUnresolvedAttempts &&
        accountingStatus !== 'REVIEW_REQUIRED',
      lastCheckedAt: order.lastCheckedAt?.toISOString() ?? null,
    };
  }

  async reconcileForToken(token: string, providerOrderId: string) {
    const booking = await this.byToken(token);
    const milestones = await this.db
      .select({ id: paymentMilestones.id })
      .from(paymentMilestones)
      .where(eq(paymentMilestones.bookingId, booking.id));
    if (!milestones.length) throw missing('Payment order');
    const [order] = await this.db
      .select({ id: paymentOrders.id })
      .from(paymentOrders)
      .where(
        and(
          eq(paymentOrders.providerOrderId, providerOrderId),
          inArray(
            paymentOrders.milestoneId,
            milestones.map((item) => item.id),
          ),
        ),
      );
    if (!order) throw missing('Payment order');
    return this.reconcile(providerOrderId);
  }

  async changeStatus(id: string, status: 'CONFIRMED' | 'CANCELLED' | 'COMPLETED', actorId: string) {
    return this.db.transaction(async (tx) => {
      const [booking] = await tx
        .select()
        .from(commercialBookings)
        .where(eq(commercialBookings.id, id))
        .for('update');
      if (!booking) throw missing('Commercial booking');
      if (status === 'CONFIRMED') {
        if (booking.status !== 'INVOICED' || !booking.invoiceId)
          throw conflict('BOOKING_NOT_CONFIRMABLE', 'Booking must have an issued invoice');
        const milestones = await tx
          .select()
          .from(paymentMilestones)
          .where(eq(paymentMilestones.bookingId, id))
          .orderBy(asc(paymentMilestones.position));
        if (!milestones.length) throw conflict('SCHEDULE_MISSING', 'Payment schedule is missing');
        const balance = await this.billing.settlementBalance(tx, booking.invoiceId);
        if (balance.status !== 'ISSUED')
          throw conflict('BOOKING_NOT_CONFIRMABLE', 'Booking must have an issued invoice');
        const [initial] = allocateMilestones(milestones, balance.receivedAmount);
        if (initial!.remainingAmount !== '0.00')
          throw conflict(
            'INITIAL_PAYMENT_MISSING',
            'Initial payment must be received before confirmation',
          );
      } else if (status === 'COMPLETED' && booking.status !== 'CONFIRMED') {
        throw conflict('BOOKING_NOT_COMPLETABLE', 'Only confirmed bookings can be completed');
      } else if (status === 'CANCELLED' && ['CANCELLED', 'COMPLETED'].includes(booking.status)) {
        throw conflict('BOOKING_NOT_CANCELLABLE', 'Booking cannot be cancelled');
      }
      const [updated] = await tx
        .update(commercialBookings)
        .set({ status, updatedAt: new Date() })
        .where(and(eq(commercialBookings.id, id), eq(commercialBookings.status, booking.status)))
        .returning();
      if (!updated) throw conflict('BOOKING_CHANGED', 'Booking changed; reload and retry');
      await audit(tx, actorId, `COMMERCIAL_BOOKING_${status}`, 'commercial_booking', id);
      return updated;
    });
  }
}
