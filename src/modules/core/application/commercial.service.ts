import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, exists, ilike, inArray, or, sql } from 'drizzle-orm';
import type { CoreDatabase } from '../persistence/database.js';
import type { PaymentProvider } from './payment-provider.js';
import type { BillingRepository } from '../persistence/billing.repository.js';
import { customers } from '../persistence/masters.schema.js';
import { invoiceLines, invoices } from '../persistence/billing.schema.js';
import {
  commercialBookings,
  commercialQuotes,
  paymentMilestones,
  paymentOrders,
  paymentPolicies,
} from '../persistence/commercial.schema.js';
import { conflict, invalid, missing } from '../domain/errors.js';
import { decimal, minor, sum } from '../domain/money.js';
import { allocateMilestones } from '../domain/milestones.js';
import { audit } from '../persistence/audit.js';
import { AppError } from '../../../shared/errors/app-error.js';

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
  total: string;
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

  async list(page: number, pageSize: number) {
    return this.db
      .select()
      .from(commercialBookings)
      .orderBy(desc(commercialBookings.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
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
    const invoice = booking.invoiceId ? await this.billing.get(booking.invoiceId) : null;
    return {
      booking,
      quotes,
      milestones: allocateMilestones(milestones, invoice?.receivedAmount ?? '0.00'),
      orders,
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
    const detail = await this.get(booking.id);
    return {
      reference: booking.reference,
      title: booking.title,
      status: booking.status,
      serviceStartsOn: booking.serviceStartsOn,
      serviceEndsOn: booking.serviceEndsOn,
      quote: detail.quotes[0]
        ? {
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
      paymentReviewRequired: detail.orders.some((order) => order.status === 'REVIEW_REQUIRED'),
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

  async addQuote(id: string, input: QuoteInput, actorId: string) {
    if (minor(input.total) <= 0n) throw invalid('Quote total must be positive');
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
      const [quote] = await tx
        .insert(commercialQuotes)
        .values({
          bookingId: id,
          version: (latest?.version ?? 0) + 1,
          description: input.description.trim(),
          inclusions: input.inclusions.trim(),
          exclusions: input.exclusions.trim(),
          terms: input.terms.trim(),
          total: input.total,
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

  async acceptQuote(token: string) {
    const booking = await this.byToken(token);
    return this.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(commercialBookings)
        .where(eq(commercialBookings.id, booking.id))
        .for('update');
      if (!locked || locked.status !== 'QUOTED')
        throw conflict('QUOTE_NOT_ACCEPTABLE', 'Quote cannot be accepted');
      const [quote] = await tx
        .select()
        .from(commercialQuotes)
        .where(eq(commercialQuotes.bookingId, booking.id))
        .orderBy(desc(commercialQuotes.version))
        .limit(1);
      if (!quote || (quote.expiresOn && quote.expiresOn < today()))
        throw conflict('QUOTE_EXPIRED', 'Quote has expired');
      if (quote.acceptedAt) return quote;
      const [accepted] = await tx
        .update(commercialQuotes)
        .set({ acceptedAt: new Date() })
        .where(eq(commercialQuotes.id, quote.id))
        .returning();
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
    if (!this.provider)
      throw new AppError({
        code: 'PAYMENTS_UNAVAILABLE',
        message: 'Online payments are not configured',
        statusCode: 503,
      });
    const booking = await this.byToken(token);
    if (!booking.invoiceId || !['INVOICED', 'CONFIRMED'].includes(booking.status))
      throw conflict('BOOKING_NOT_PAYABLE', 'Booking is not payable');
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
          eq(paymentOrders.status, 'REVIEW_REQUIRED'),
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
      if (!currentBooking || !['INVOICED', 'CONFIRMED'].includes(currentBooking.status))
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

  async reconcile(providerOrderId: string) {
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
    if (order.status === 'PAID') return { status: 'PAID', receiptId: order.receiptId };
    if (order.status === 'REVIEW_REQUIRED') return { status: 'REVIEW_REQUIRED', receiptId: null };
    const payment = await this.provider.successfulPayment(providerOrderId);
    if (!payment) return { status: 'PENDING', receiptId: null };
    return this.db.transaction(async (tx) => {
      // The provider call stays outside the transaction. A row lock serializes
      // callbacks/retries, and receipt creation plus order linking commit together.
      const [locked] = await tx
        .select()
        .from(paymentOrders)
        .where(eq(paymentOrders.id, order.id))
        .for('update');
      if (locked!.status === 'PAID') return { status: 'PAID', receiptId: locked!.receiptId };
      if (locked!.status === 'REVIEW_REQUIRED')
        return { status: 'REVIEW_REQUIRED', receiptId: null };
      const markReview = async () => {
        await tx
          .update(paymentOrders)
          .set({
            status: 'REVIEW_REQUIRED',
            providerPaymentId: payment.paymentId,
            paidAt: new Date(payment.receivedAt),
            updatedAt: new Date(),
          })
          .where(eq(paymentOrders.id, order.id));
        return { status: 'REVIEW_REQUIRED', receiptId: null };
      };
      if (payment.currency !== 'INR' || minor(payment.amount) !== minor(locked!.amount))
        return markReview();
      const [milestone] = await tx
        .select()
        .from(paymentMilestones)
        .where(eq(paymentMilestones.id, locked!.milestoneId));
      const [booking] = await tx
        .select()
        .from(commercialBookings)
        .where(eq(commercialBookings.id, milestone!.bookingId))
        .for('update');
      if (!booking?.invoiceId) throw conflict('INVOICE_MISSING', 'Booking has no invoice');
      if (!['INVOICED', 'CONFIRMED'].includes(booking.status)) return markReview();
      let receipt;
      try {
        receipt = await this.billing.createReceiptInTransaction(
          tx,
          {
            invoiceId: booking.invoiceId,
            amount: payment.amount,
            receivedDate: payment.receivedAt.slice(0, 10),
            method: 'GATEWAY',
            details: { reference: `${this.provider!.name}:${payment.paymentId}` },
            status: 'CONFIRMED',
          },
          `gw_${createHash('sha256').update(`${this.provider!.name}:${payment.paymentId}`).digest('hex')}`,
          booking.createdBy,
        );
      } catch (error) {
        if (
          error instanceof AppError &&
          ['OVERPAYMENT', 'INVOICE_NOT_ISSUED', 'CORE_VALIDATION_FAILED'].includes(error.code)
        )
          return markReview();
        throw error;
      }
      // An idempotency replay can return an existing receipt; only a confirmed
      // receipt is eligible to complete an order. Balances always come from billing.
      if (receipt.status !== 'CONFIRMED') return markReview();
      await tx
        .update(paymentOrders)
        .set({
          status: 'PAID',
          providerPaymentId: payment.paymentId,
          paidAt: new Date(payment.receivedAt),
          receiptId: receipt.id,
          updatedAt: new Date(),
        })
        .where(eq(paymentOrders.id, order.id));
      return { status: 'PAID', receiptId: receipt.id };
    });
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
