import { paymentOrderNeedsReview } from '../persistence/payment-review-predicate.js';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { CoreDatabase, CoreTransaction } from '../persistence/database.js';
import {
  commercialBookings,
  paymentAttempts,
  paymentAttemptResolutions,
  paymentMilestones,
  paymentOrders,
} from '../persistence/commercial.schema.js';
import { invoices, receipts } from '../persistence/billing.schema.js';
import { customers } from '../persistence/masters.schema.js';
import { requestHash, type BillingRepository } from '../persistence/billing.repository.js';
import { audit } from '../persistence/audit.js';
import { conflict, invalid, missing } from '../domain/errors.js';
import { minor } from '../domain/money.js';
import {
  gatewayReceiptKey,
  type ResolutionInput,
  type ResolutionAction,
} from './payment-review.contracts.js';

type Attempt = typeof paymentAttempts.$inferSelect;
type Receipt = typeof receipts.$inferSelect;
const safeReceipt = (r: Receipt) => ({
  id: r.id,
  invoiceId: r.invoiceId,
  number: r.receiptNumber,
  status: r.status,
  amount: r.amount,
  receivedDate: r.receivedDate,
  method: r.method,
  reversalReason: r.reversalReason,
});
const safeResolution = (r: typeof paymentAttemptResolutions.$inferSelect) => ({
  id: r.id,
  attemptId: r.attemptId,
  orderId: r.orderId,
  action: r.action,
  actorId: r.actorId,
  note: r.note,
  receiptId: r.receiptId,
  amount: r.amount,
  currency: r.currency,
  provider: r.provider,
  providerRefundReference: r.providerRefundReference,
  refund: r.refund,
  before: r.before,
  after: r.after,
  createdAt: r.createdAt,
});

export class PaymentReviewService {
  constructor(
    private readonly db: CoreDatabase,
    private readonly billing: BillingRepository,
  ) {}

  private async state(tx: CoreTransaction, orderId: string) {
    // Lock order first, matching reconciliation. Then booking, invoice, and attempts.
    const [locked] = await tx
      .select({ order: paymentOrders, needsReview: paymentOrderNeedsReview(sql`${paymentOrders}`) })
      .from(paymentOrders)
      .where(eq(paymentOrders.id, orderId))
      .for('update');
    const order = locked?.order;
    if (!order) throw missing('Payment order');
    const [milestone] = await tx
      .select()
      .from(paymentMilestones)
      .where(eq(paymentMilestones.id, order.milestoneId));
    const [booking] = milestone
      ? await tx
          .select()
          .from(commercialBookings)
          .where(eq(commercialBookings.id, milestone.bookingId))
          .for('update')
      : [];
    const [invoice] = booking?.invoiceId
      ? await tx.select().from(invoices).where(eq(invoices.id, booking.invoiceId)).for('update')
      : [];
    const balance = invoice ? await this.billing.settlementBalance(tx, invoice.id) : null;
    const attempts = await tx
      .select()
      .from(paymentAttempts)
      .where(eq(paymentAttempts.orderId, order.id))
      .orderBy(asc(paymentAttempts.id))
      .for('update');
    const resolutions = await tx
      .select()
      .from(paymentAttemptResolutions)
      .where(eq(paymentAttemptResolutions.orderId, order.id))
      .orderBy(asc(paymentAttemptResolutions.createdAt));
    const receiptIds = [
      ...new Set(
        [order.receiptId, ...attempts.map((a) => a.receiptId)].filter((id): id is string => !!id),
      ),
    ];
    const receiptRows = receiptIds.length
      ? await tx.select().from(receipts).where(inArray(receipts.id, receiptIds))
      : [];
    const invoiceReceipts = invoice
      ? await tx.select().from(receipts).where(eq(receipts.invoiceId, invoice.id))
      : [];
    const identityReceipts = attempts.length
      ? await tx
          .select()
          .from(receipts)
          .where(
            inArray(
              receipts.idempotencyKey,
              attempts.map((a) => gatewayReceiptKey(a.provider, a.providerPaymentId)),
            ),
          )
      : [];
    const [customer] = booking
      ? await tx
          .select({ id: customers.id, name: customers.name })
          .from(customers)
          .where(eq(customers.id, booking.customerId))
      : [];
    const candidateIds = invoiceReceipts.map((r) => r.id);
    const attributedOrders = candidateIds.length
      ? await tx
          .select({ id: paymentOrders.id, receiptId: paymentOrders.receiptId })
          .from(paymentOrders)
          .where(inArray(paymentOrders.receiptId, candidateIds))
      : [];
    const attributedAttempts = candidateIds.length
      ? await tx
          .select({ id: paymentAttempts.id, receiptId: paymentAttempts.receiptId })
          .from(paymentAttempts)
          .where(inArray(paymentAttempts.receiptId, candidateIds))
      : [];
    const candidates = (a: Attempt) =>
      invoiceReceipts.filter(
        (r) =>
          r.status === 'CONFIRMED' &&
          r.method === 'GATEWAY' &&
          r.companyId === invoice!.companyId &&
          r.amount === a.amount &&
          r.details.reference === `${a.provider}:${a.providerPaymentId}` &&
          r.idempotencyKey === gatewayReceiptKey(a.provider, a.providerPaymentId) &&
          !attributedOrders.some((o) => o.receiptId === r.id && o.id !== order.id) &&
          !attributedAttempts.some((other) => other.receiptId === r.id && other.id !== a.id),
      );
    const receiptFor = (a: Attempt) =>
      receiptRows.find(
        (r) =>
          r.id === a.receiptId ||
          (order.providerPaymentId === a.providerPaymentId && r.id === order.receiptId),
      );
    const actions = (a: Attempt) => {
      const linked = receiptFor(a);
      const base: string[] = [];
      if (resolutions.some((r) => r.attemptId === a.id)) base.push('ALREADY_RESOLVED');
      if (a.status !== 'SUCCESS') base.push('PAYMENT_NOT_VERIFIED');
      if (minor(a.amount) === 0n) base.push('ZERO_AMOUNT');
      if (
        a.accountingStatus !== 'REVIEW_REQUIRED' &&
        !(a.accountingStatus === 'APPLIED' && linked?.status === 'REVERSED')
      )
        base.push('ATTEMPT_NOT_REVIEWABLE');
      const account = [...base];
      if (a.currency !== 'INR') account.push('CURRENCY_NOT_INR');
      if (!booking?.invoiceId || !invoice) account.push('INVOICE_MISSING');
      if (!booking || !['INVOICED', 'CONFIRMED'].includes(booking.status))
        account.push('BOOKING_INELIGIBLE');
      if (invoice && invoice.status !== 'ISSUED') account.push('INVOICE_NOT_ISSUED');
      if (
        invoice &&
        booking &&
        (invoice.companyId !== booking.companyId ||
          invoice.customerId !== booking.customerId ||
          invoice.serviceCategoryId !== booking.serviceCategoryId)
      )
        account.push('INVOICE_IDENTITY_MISMATCH');
      if (
        order.receiptId ||
        attempts.some((other) => other.accountingStatus === 'APPLIED' || other.receiptId)
      )
        account.push('ORDER_ALREADY_HAS_RECEIPT');
      if (a.reviewReasons.some((r) => r.code === 'ADDITIONAL_SUCCESS'))
        account.push('ADDITIONAL_SUCCESS');
      if (
        attempts.some(
          (other) =>
            other.id !== a.id &&
            other.status === 'SUCCESS' &&
            other.accountingStatus !== 'REFUNDED',
        )
      )
        account.push('OTHER_UNRESOLVED_SUCCESS');
      const apply = [...account];
      if (balance && minor(a.amount) > minor(balance.dueAmount)) apply.push('OVERPAYMENT');
      if (candidates(a).length) apply.push('EXISTING_MATCHING_RECEIPT_USE_LINK');
      else if (
        identityReceipts.some(
          (r) => r.idempotencyKey === gatewayReceiptKey(a.provider, a.providerPaymentId),
        )
      )
        apply.push('EXISTING_RECEIPT_CONFLICT');
      const link = [...account];
      if (!candidates(a).length) link.push('NO_MATCHING_AUTHORITATIVE_RECEIPT');
      const refund = [...base];
      if (
        (linked && linked.status !== 'REVERSED') ||
        identityReceipts.some(
          (r) =>
            r.status !== 'REVERSED' &&
            r.idempotencyKey === gatewayReceiptKey(a.provider, a.providerPaymentId),
        )
      )
        refund.push('RECEIPT_NOT_REVERSED');
      const action = (name: ResolutionAction, blockers: string[]) => ({
        action: name,
        allowed: blockers.length === 0,
        blockers: [...new Set(blockers)],
      });
      return [
        action('APPLY_TO_LINKED_INVOICE', apply),
        action('LINK_EXISTING_RECEIPT', link),
        action('RECORD_VERIFIED_EXTERNAL_REFUND', refund),
      ];
    };
    const tokenFacts = {
      order: {
        id: order.id,
        status: order.status,
        receiptId: order.receiptId,
        providerPaymentId: order.providerPaymentId,
        amount: order.amount,
      },
      booking: booking
        ? { id: booking.id, invoiceId: booking.invoiceId, status: booking.status }
        : null,
      invoice: invoice
        ? {
            id: invoice.id,
            status: invoice.status,
            companyId: invoice.companyId,
            customerId: invoice.customerId,
            serviceCategoryId: invoice.serviceCategoryId,
          }
        : null,
      balance,
      attempts: attempts.map((a) => ({
        id: a.id,
        status: a.status,
        amount: a.amount,
        currency: a.currency,
        accountingStatus: a.accountingStatus,
        receiptId: a.receiptId,
        reviewReasons: a.reviewReasons,
        initiatedAt: a.initiatedAt,
        completedAt: a.completedAt,
      })),
      receipts: invoiceReceipts.map(safeReceipt).sort((a, b) => a.id.localeCompare(b.id)),
      identityReceipts: identityReceipts.map(safeReceipt).sort((a, b) => a.id.localeCompare(b.id)),
      resolutions: resolutions.map((r) => r.id),
      candidates: attempts.map((a) => ({
        id: a.id,
        receiptIds: candidates(a)
          .map((r) => r.id)
          .sort(),
      })),
    };
    const version = requestHash(tokenFacts);
    const view = {
      version,
      order: {
        id: order.id,
        provider: order.provider,
        providerOrderId: order.providerOrderId,
        providerStatus: order.providerStatus,
        gatewayStatus: order.status,
        amount: order.amount,
        receiptId: order.receiptId,
        paidAt: order.paidAt,
      },
      booking: booking
        ? {
            id: booking.id,
            reference: booking.reference,
            status: booking.status,
            companyId: booking.companyId,
          }
        : null,
      customer: customer ?? null,
      invoice: invoice
        ? {
            id: invoice.id,
            number: invoice.invoiceNumber,
            status: invoice.status,
            invoiceDate: invoice.invoiceDate,
            grandTotal: invoice.grandTotal,
            ...balance,
          }
        : null,
      attempts: attempts.map((a) => ({
        id: a.id,
        providerPaymentId: a.providerPaymentId,
        status: a.status,
        accountingStatus: a.accountingStatus,
        amount: a.amount,
        currency: a.currency,
        initiatedAt: a.initiatedAt,
        completedAt: a.completedAt,
        reviewReasons: a.reviewReasons.length
          ? a.reviewReasons
          : a.accountingStatus === 'REVIEW_REQUIRED'
            ? [{ code: 'UNKNOWN_LEGACY_REASON' as const, details: {} }]
            : [],
        receipt: receiptFor(a) ? safeReceipt(receiptFor(a)!) : null,
        receiptAccountingState:
          receiptFor(a)?.status === 'REVERSED' && a.accountingStatus !== 'REFUNDED'
            ? 'REVERSED_WITHOUT_REFUND'
            : (receiptFor(a)?.status ?? null),
        resolution: resolutions.find((r) => r.attemptId === a.id)
          ? safeResolution(resolutions.find((r) => r.attemptId === a.id)!)
          : null,
        actions: actions(a),
        matchingReceipts: candidates(a).map((r) => ({
          ...safeReceipt(r),
          evidenceKind: 'BACKEND_GATEWAY_RECEIPT_IDENTITY' as const,
        })),
        existingPaymentReceipts: identityReceipts
          .filter((r) => r.idempotencyKey === gatewayReceiptKey(a.provider, a.providerPaymentId))
          .map(safeReceipt),
      })),
      history: resolutions.map(safeResolution),
      needsReview: locked.needsReview,
      refundVerificationPolicy: 'STAFF_ATTESTATION_ONLY' as const,
    };
    return { order, booking, invoice, attempts, version, view, actions, candidates, receiptFor };
  }

  async inspect(orderId: string) {
    return this.db.transaction(async (tx) => (await this.state(tx, orderId)).view);
  }

  async resolve(attemptId: string, input: ResolutionInput, key: string, actorId: string) {
    if (!/^[A-Za-z0-9_:-]{8,128}$/.test(key)) throw invalid('A valid Idempotency-Key is required');
    if (!input.note.trim() || input.note.length > 2000)
      throw invalid('An explicit staff note is required (maximum 2000 characters)');
    const hash = requestHash({ attemptId, input, actorId });
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`payment-resolution:${key}`},0))`,
      );
      const [retry] = await tx
        .select()
        .from(paymentAttemptResolutions)
        .where(eq(paymentAttemptResolutions.idempotencyKey, key));
      if (retry) {
        if (retry.requestHash !== hash)
          throw conflict(
            'PAYMENT_RESOLUTION_IDEMPOTENCY_CONFLICT',
            'This key was used for a different payment resolution',
          );
        return {
          resolution: safeResolution(retry),
          review: (await this.state(tx, retry.orderId)).view,
        };
      }
      const [lookup] = await tx
        .select({ orderId: paymentAttempts.orderId })
        .from(paymentAttempts)
        .where(eq(paymentAttempts.id, attemptId));
      if (!lookup) throw missing('Payment attempt');
      const state = await this.state(tx, lookup.orderId);
      const attempt = state.attempts.find((a) => a.id === attemptId)!;
      if (state.view.history.some((r) => r.attemptId === attemptId))
        throw conflict(
          'PAYMENT_ALREADY_RESOLVED',
          'This attempt already has a terminal resolution; refresh the review',
        );
      if (state.version !== input.version)
        throw conflict(
          'PAYMENT_REVIEW_STALE',
          'Payment or invoice facts changed; refresh the review before deciding',
        );
      const permitted = state.actions(attempt).find((a) => a.action === input.action);
      if (!permitted?.allowed)
        throw conflict(
          'PAYMENT_RESOLUTION_NOT_ALLOWED',
          `Action unavailable: ${permitted?.blockers.join(', ') ?? 'unsupported action'}`,
        );
      let receiptId: string | null = attempt.receiptId;
      if (input.action === 'APPLY_TO_LINKED_INVOICE') {
        const receivedAt = attempt.completedAt ?? attempt.initiatedAt;
        const receipt = await this.billing.createReceiptInTransaction(
          tx,
          {
            invoiceId: state.invoice!.id,
            amount: attempt.amount,
            receivedDate: new Date(receivedAt.getTime() + 330 * 60000).toISOString().slice(0, 10),
            method: 'GATEWAY',
            details: { reference: `${attempt.provider}:${attempt.providerPaymentId}` },
            status: 'CONFIRMED',
          },
          gatewayReceiptKey(attempt.provider, attempt.providerPaymentId),
          actorId,
        );
        if (receipt.status !== 'CONFIRMED')
          throw conflict('PAYMENT_RECEIPT_NOT_CONFIRMED', 'Gateway receipt must be confirmed');
        receiptId = receipt.id;
      } else if (input.action === 'LINK_EXISTING_RECEIPT') {
        const match = state.candidates(attempt).find((r) => r.id === input.receiptId);
        if (!match)
          throw conflict(
            'PAYMENT_RECEIPT_EVIDENCE_INVALID',
            'Select a matching unassigned backend gateway receipt for this provider payment',
          );
        receiptId = match.id;
      } else {
        const refund = input.refund;
        if (minor(refund.amount) !== minor(attempt.amount) || refund.currency !== attempt.currency)
          throw conflict(
            'PAYMENT_REFUND_MUST_BE_COMPLETE',
            'Only an exact full refund in the payment currency resolves this attempt',
          );
        const completed = Date.parse(refund.completedAt);
        if (
          !Number.isFinite(completed) ||
          completed > Date.now() ||
          completed < (attempt.completedAt ?? attempt.initiatedAt).getTime()
        )
          throw invalid('Refund completion must be between payment completion and now');
        if (
          refund.verification.kind !== 'STAFF_ATTESTATION' ||
          refund.verification.attested !== true ||
          !refund.verification.evidenceReference.trim() ||
          !refund.providerRefundReference.trim()
        )
          throw invalid(
            'A refund reference, documentary evidence and explicit staff attestation are required',
          );
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`refund:${attempt.provider}:${refund.providerRefundReference}`},0))`,
        );
        const [duplicate] = await tx
          .select()
          .from(paymentAttemptResolutions)
          .where(
            and(
              eq(paymentAttemptResolutions.provider, attempt.provider),
              eq(paymentAttemptResolutions.providerRefundReference, refund.providerRefundReference),
            ),
          );
        if (duplicate)
          throw conflict(
            'PAYMENT_REFUND_REFERENCE_USED',
            'This refund reference is already assigned to a resolved payment',
          );
      }
      const accountingStatus =
        input.action === 'RECORD_VERIFIED_EXTERNAL_REFUND' ? 'REFUNDED' : 'APPLIED';
      await tx
        .update(paymentAttempts)
        .set({
          accountingStatus,
          receiptId,
          reviewReasons: state.view.attempts.find((a) => a.id === attempt.id)!.reviewReasons,
          updatedAt: new Date(),
        })
        .where(eq(paymentAttempts.id, attempt.id));
      const otherReviews = state.attempts.some(
        (a) =>
          a.id !== attempt.id &&
          (a.accountingStatus === 'REVIEW_REQUIRED' ||
            (a.accountingStatus === 'APPLIED' && state.receiptFor(a)?.status === 'REVERSED')),
      );
      const pending = state.attempts.some((a) => ['PENDING', 'UNKNOWN'].includes(a.status));
      const applied =
        input.action !== 'RECORD_VERIFIED_EXTERNAL_REFUND' ||
        state.attempts.some((a) => a.id !== attempt.id && a.accountingStatus === 'APPLIED') ||
        (!!state.order.receiptId && state.order.providerPaymentId !== attempt.providerPaymentId);
      const nextStatus = applied ? 'PAID' : otherReviews ? 'REVIEW_REQUIRED' : 'REFUNDED';
      const [updatedOrder] = await tx
        .update(paymentOrders)
        .set({
          status: nextStatus,
          reviewRequiredAt:
            otherReviews || pending ? (state.order.reviewRequiredAt ?? new Date()) : null,
          ...(input.action !== 'RECORD_VERIFIED_EXTERNAL_REFUND'
            ? {
                receiptId,
                providerPaymentId: attempt.providerPaymentId,
                paidAt: attempt.completedAt ?? attempt.initiatedAt,
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(paymentOrders.id, state.order.id))
        .returning();
      const before = {
        providerPaymentId: attempt.providerPaymentId,
        providerOrderId: state.order.providerOrderId,
        receivedAt: attempt.completedAt ?? attempt.initiatedAt,
        accountingStatus: attempt.accountingStatus,
        receiptId: attempt.receiptId,
        gatewayStatus: state.order.status,
        reviewReasons: state.view.attempts.find((a) => a.id === attemptId)!.reviewReasons,
        invoiceBalance: state.view.invoice,
      };
      const after = {
        accountingStatus,
        receiptId,
        gatewayStatus: updatedOrder!.status,
        invoiceBalance: state.invoice
          ? await this.billing.settlementBalance(tx, state.invoice.id)
          : null,
      };
      const [resolution] = await tx
        .insert(paymentAttemptResolutions)
        .values({
          attemptId: attempt.id,
          orderId: state.order.id,
          action: input.action,
          actorId,
          note: input.note.trim(),
          idempotencyKey: key,
          requestHash: hash,
          receiptId,
          provider: attempt.provider,
          amount: attempt.amount,
          currency: attempt.currency,
          providerRefundReference:
            input.action === 'RECORD_VERIFIED_EXTERNAL_REFUND'
              ? input.refund.providerRefundReference
              : null,
          refund: input.action === 'RECORD_VERIFIED_EXTERNAL_REFUND' ? input.refund : null,
          before,
          after,
        })
        .returning();
      await audit(tx, actorId, input.action, 'payment_attempt_resolution', resolution!.id);
      return {
        resolution: safeResolution(resolution!),
        review: (await this.state(tx, state.order.id)).view,
      };
    });
  }
}
