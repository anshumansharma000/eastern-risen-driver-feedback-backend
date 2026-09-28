import { createHash } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNull, lte, gte, or, sql } from 'drizzle-orm';
import type { CoreDatabase, CoreTransaction } from './database.js';
import type {
  AdjustmentInput,
  InvoiceInput,
  InvoiceSnapshot,
  ReceiptInput,
} from '../application/billing.contracts.js';
import type { SharedCatalog } from '../application/ports.js';
import {
  calculateLines,
  invoiceTotals,
  outstanding,
  type CalculatedLine,
} from '../domain/billing.js';
import { conflict, invalid, missing } from '../domain/errors.js';
import { minor, sum } from '../domain/money.js';
import { financialYear, validateDate, validatePeriod } from '../domain/validation.js';
import { validateReceipt } from '../domain/payment.js';
import {
  bankAccounts,
  companies,
  coreOutbox,
  customers,
  guests,
  serviceCategories,
  taxRules,
} from './masters.schema.js';
import {
  documentCounters,
  invoiceLines,
  invoiceLineTaxes,
  invoices,
  receipts,
  settlementAdjustments,
} from './billing.schema.js';
import { audit } from './audit.js';

type Transaction = CoreTransaction;
type SnapshotSource = {
  companyId: string;
  customerId: string;
  guestId: string | null;
  serviceCategoryId: string;
  vehicleId: string | null;
  details: InvoiceInput;
  snapshot: InvoiceSnapshot | null;
};
function objectValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function textValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function nullableTextValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
/** Adds fields introduced after snapshot schema v1 without consulting mutable masters. */
export function normalizeInvoiceSnapshot(invoice: SnapshotSource): InvoiceSnapshot | null {
  if (!invoice.snapshot) return null;
  const snapshot = objectValue(invoice.snapshot);
  const company = objectValue(snapshot.company);
  const customer = objectValue(snapshot.customer);
  const guest = objectValue(snapshot.guest);
  const category = objectValue(snapshot.serviceCategory);
  const vehicle = objectValue(snapshot.vehicle);
  const banks = Array.isArray(snapshot.bankAccounts) ? snapshot.bankAccounts : [];
  return {
    ...snapshot,
    company: {
      ...company,
      id: invoice.companyId,
      name: textValue(company.name),
    },
    customer: {
      ...customer,
      id: invoice.customerId,
      name: textValue(customer.name),
    },
    guest: invoice.guestId
      ? {
          ...guest,
          id: invoice.guestId,
          name: textValue(guest.name, invoice.details.guestDisplayText),
        }
      : null,
    serviceCategory: {
      ...category,
      id: invoice.serviceCategoryId,
      name: textValue(category.name),
      code: textValue(category.code),
    },
    vehicle: invoice.vehicleId
      ? {
          ...vehicle,
          id: invoice.vehicleId,
          name: textValue(vehicle.name, textValue(vehicle.displayName)),
          registrationNumber: textValue(vehicle.registrationNumber),
          vehicleType: textValue(vehicle.vehicleType),
        }
      : null,
    bankAccounts: invoice.details.bankAccountIds.map((id, index) => {
      const bank = objectValue(banks[index]);
      return {
        ...bank,
        id,
        name: textValue(bank.name),
        bankName: nullableTextValue(bank.bankName),
        accountNumber: textValue(bank.accountNumber),
        branch: nullableTextValue(bank.branch),
        ifscCode: nullableTextValue(bank.ifscCode),
      };
    }),
  };
}
function requestHash(value: unknown): string {
  // Stable object-key ordering makes retries independent of JSON property order.
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, value]) => [key, canonical(value)]),
          )
        : item;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export class BillingRepository {
  constructor(
    private readonly db: CoreDatabase,
    private readonly catalog: SharedCatalog,
  ) {}

  async list(page: number, pageSize: number) {
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(invoices)
        .orderBy(desc(invoices.invoiceDate), asc(invoices.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ value: count() }).from(invoices),
    ]);
    return {
      items: items.map((invoice) => ({ ...invoice, snapshot: normalizeInvoiceSnapshot(invoice) })),
      total: total!.value,
    };
  }
  async get(id: string) {
    return this.db.transaction(async (tx) => {
      const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).for('share');
      if (!invoice) throw missing('Invoice');
      const lines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, id))
        .orderBy(asc(invoiceLines.position));
      const taxes = lines.length
        ? await tx
            .select()
            .from(invoiceLineTaxes)
            .where(
              inArray(
                invoiceLineTaxes.lineId,
                lines.map((line) => line.id),
              ),
            )
        : [];
      const balance = await this.balance(tx, invoice);
      const payments = await tx
        .select()
        .from(receipts)
        .where(eq(receipts.invoiceId, id))
        .orderBy(asc(receipts.createdAt), asc(receipts.id));
      const adjustments = await tx
        .select()
        .from(settlementAdjustments)
        .where(eq(settlementAdjustments.invoiceId, id))
        .orderBy(asc(settlementAdjustments.createdAt), asc(settlementAdjustments.id));
      return {
        ...invoice,
        snapshot: normalizeInvoiceSnapshot(invoice),
        ...invoice.details,
        guestId: invoice.details.guestId ?? null,
        passengerCount: invoice.details.passengerCount ?? null,
        dueDate: invoice.details.dueDate ?? null,
        label: invoice.details.label ?? null,
        lines: lines.map((line) => {
          const appliedTaxes = taxes
            .filter((tax) => tax.lineId === line.id)
            .sort((a, b) => a.component.localeCompare(b.component))
            .map((tax) => ({ ...tax, rate: this.presentRate(tax.rate) }));
          return {
            ...line,
            // Keep the original name for existing consumers while exposing the explicit API name.
            taxes: appliedTaxes,
            appliedTaxes,
          };
        }),
        ...balance,
        receipts: payments,
        adjustments,
      };
    });
  }
  async createDraft(input: InvoiceInput, actorId: string) {
    const id = await this.db.transaction(async (tx) => {
      const calculated = await this.prepare(tx, input);
      const [invoice] = await tx
        .insert(invoices)
        .values({
          companyId: input.companyId,
          customerId: input.customerId,
          guestId: input.guestId ?? null,
          serviceCategoryId: input.serviceCategoryId,
          vehicleId: input.vehicleId ?? null,
          invoiceDate: input.invoiceDate,
          details: input,
          snapshot: calculated.snapshot,
          ...invoiceTotals(calculated.lines),
          createdBy: actorId,
        })
        .returning();
      await this.replaceLines(tx, invoice!.id, calculated.lines);
      await audit(tx, actorId, 'DRAFT_CREATED', 'invoice', invoice!.id);
      return invoice!.id;
    });
    return this.get(id);
  }
  async updateDraft(id: string, input: InvoiceInput, version: number, actorId: string) {
    await this.db.transaction(async (tx) => {
      const invoice = await this.lockInvoice(tx, id);
      if (invoice.status !== 'DRAFT')
        throw conflict('INVOICE_IMMUTABLE', 'Only drafts can be edited');
      if (invoice.version !== version)
        throw conflict('STALE_VERSION', 'Reload the draft before saving');
      const calculated = await this.prepare(tx, input);
      const [updated] = await tx
        .update(invoices)
        .set({
          companyId: input.companyId,
          customerId: input.customerId,
          guestId: input.guestId ?? null,
          serviceCategoryId: input.serviceCategoryId,
          vehicleId: input.vehicleId ?? null,
          invoiceDate: input.invoiceDate,
          details: input,
          snapshot: calculated.snapshot,
          ...invoiceTotals(calculated.lines),
          version: version + 1,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, id))
        .returning();
      await this.replaceLines(tx, id, calculated.lines);
      await audit(tx, actorId, 'DRAFT_UPDATED', 'invoice', id);
      return updated!;
    });
    return this.get(id);
  }
  async issue(id: string, version: number, actorId: string) {
    await this.db.transaction(async (tx) => {
      const invoice = await this.lockInvoice(tx, id);
      if (invoice.status === 'ISSUED') return invoice;
      if (invoice.status !== 'DRAFT')
        throw conflict('INVALID_INVOICE_STATE', 'A cancelled invoice cannot be issued');
      if (invoice.version !== version)
        throw conflict('STALE_VERSION', 'Reload the draft before issuing');
      const prepared = await this.prepare(tx, invoice.details);
      if (
        !prepared.snapshot.company.address?.trim() ||
        !prepared.snapshot.company.state?.trim() ||
        !prepared.snapshot.company.country?.trim()
      )
        throw invalid(
          'Complete the issuing company address, state and country before issuing a new invoice',
        );
      const totals = invoiceTotals(prepared.lines);
      // A changed rate must be reviewed through a draft update, never silently issued.
      const oldLines = await tx
        .select()
        .from(invoiceLines)
        .where(eq(invoiceLines.invoiceId, id))
        .orderBy(asc(invoiceLines.position));
      const oldTaxes = oldLines.length
        ? await tx
            .select()
            .from(invoiceLineTaxes)
            .where(
              inArray(
                invoiceLineTaxes.lineId,
                oldLines.map((line) => line.id),
              ),
            )
        : [];
      const previous = oldLines.map((line) => ({
        amount: line.amount,
        taxes: oldTaxes
          .filter((t) => t.lineId === line.id)
          .map((t) => ({
            ruleId: t.ruleId,
            rate: t.rate,
            component: t.component,
            amount: t.amount,
          }))
          .sort((a, b) => a.component.localeCompare(b.component)),
      }));
      const next = prepared.lines.map((line) => ({
        amount: line.amount,
        taxes: line.taxes
          .map((t) => ({ ...t, rate: t.rate }))
          .sort((a, b) => a.component.localeCompare(b.component)),
      }));
      if (requestHash(previous) !== requestHash(next))
        throw conflict(
          'DRAFT_TAXES_CHANGED',
          'Applicable taxes changed; save and review the draft before issuing',
        );
      const year = financialYear(invoice.invoiceDate);
      const number = await this.nextNumber(tx, invoice.companyId, year, 'I');
      const [issued] = await tx
        .update(invoices)
        .set({
          ...totals,
          status: 'ISSUED',
          invoiceNumber: number,
          financialYear: year,
          snapshot: prepared.snapshot,
          issuedAt: new Date(),
          version: version + 1,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, id))
        .returning();
      await this.replaceLines(tx, id, prepared.lines);
      await audit(tx, actorId, 'ISSUED', 'invoice', id);
      await tx.insert(coreOutbox).values({
        eventType: 'core.invoice.issued.v1',
        aggregateId: id,
        payload: { invoiceId: id, invoiceNumber: number, companyId: invoice.companyId },
      });
      return issued!;
    });
    return this.get(id);
  }
  async cancel(id: string, reason: string, actorId: string) {
    if (!reason.trim()) throw invalid('Cancellation reason is required');
    return this.db.transaction(async (tx) => {
      const invoice = await this.lockInvoice(tx, id);
      if (invoice.status === 'CANCELLED') return invoice;
      if (invoice.status !== 'ISSUED')
        throw conflict('INVALID_INVOICE_STATE', 'Only an issued invoice can be cancelled');
      const activeReceipts = await tx
        .select({ id: receipts.id })
        .from(receipts)
        .where(and(eq(receipts.invoiceId, id), inArray(receipts.status, ['PENDING', 'CONFIRMED'])))
        .limit(1);
      const activeAdjustments = await tx
        .select({ id: settlementAdjustments.id })
        .from(settlementAdjustments)
        .where(
          and(eq(settlementAdjustments.invoiceId, id), isNull(settlementAdjustments.reversedAt)),
        )
        .limit(1);
      if (activeReceipts.length || activeAdjustments.length)
        throw conflict(
          'INVOICE_HAS_SETTLEMENTS',
          'Reverse receipts and adjustments before cancelling',
        );
      const [cancelled] = await tx
        .update(invoices)
        .set({
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason: reason,
          version: invoice.version + 1,
          updatedAt: new Date(),
        })
        .where(eq(invoices.id, id))
        .returning();
      await audit(tx, actorId, 'CANCELLED', 'invoice', id);
      await tx.insert(coreOutbox).values({
        eventType: 'core.invoice.cancelled.v1',
        aggregateId: id,
        payload: { invoiceId: id },
      });
      return cancelled!;
    });
  }
  async createReceipt(input: ReceiptInput, key: string, actorId: string) {
    validateReceipt(input);
    return this.db.transaction(async (tx) => {
      await this.lockKey(tx, key);
      const [existing] = await tx.select().from(receipts).where(eq(receipts.idempotencyKey, key));
      if (existing) {
        this.checkRetry(existing.requestHash, input);
        return existing;
      }
      const invoice = await this.lockInvoice(tx, input.invoiceId);
      this.requireIssued(invoice);
      if (input.receivedDate < invoice.invoiceDate)
        throw invalid(
          'Receipt date cannot precede the invoice date; advance payments require a separate workflow',
        );
      if (input.status === 'CONFIRMED') await this.checkSettlement(tx, invoice, input.amount);
      const year = financialYear(input.receivedDate),
        number = await this.nextNumber(tx, invoice.companyId, year, 'R');
      const [receipt] = await tx
        .insert(receipts)
        .values({
          ...input,
          companyId: invoice.companyId,
          receiptNumber: number,
          financialYear: year,
          idempotencyKey: key,
          requestHash: requestHash(input),
          createdBy: actorId,
        })
        .returning();
      await audit(tx, actorId, 'RECEIPT_CREATED', 'receipt', receipt!.id);
      await tx.insert(coreOutbox).values({
        eventType: 'core.receipt.created.v1',
        aggregateId: receipt!.id,
        payload: { receiptId: receipt!.id, invoiceId: invoice.id, status: receipt!.status },
      });
      return receipt!;
    });
  }
  async changeReceipt(
    id: string,
    status: 'CONFIRMED' | 'REVERSED',
    reason: string | undefined,
    actorId: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [candidate] = await tx.select().from(receipts).where(eq(receipts.id, id));
      if (!candidate) throw missing('Receipt');
      const invoice = await this.lockInvoice(tx, candidate.invoiceId);
      const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, id)).for('update');
      if (receipt!.status === status) return receipt!;
      if (receipt!.status === 'REVERSED')
        throw conflict('RECEIPT_REVERSED', 'A reversed receipt cannot be confirmed');
      if (status === 'CONFIRMED') {
        this.requireIssued(invoice);
        await this.checkSettlement(tx, invoice, receipt!.amount);
      }
      if (status === 'REVERSED' && !reason?.trim()) throw invalid('Reversal reason is required');
      const [updated] = await tx
        .update(receipts)
        .set({
          status,
          updatedAt: new Date(),
          reversalReason: status === 'REVERSED' ? reason! : null,
        })
        .where(eq(receipts.id, id))
        .returning();
      await audit(tx, actorId, `RECEIPT_${status}`, 'receipt', id);
      await tx.insert(coreOutbox).values({
        eventType: `core.receipt.${status.toLowerCase()}.v1`,
        aggregateId: id,
        payload: { receiptId: id, invoiceId: invoice.id },
      });
      return updated!;
    });
  }
  async createAdjustment(input: AdjustmentInput, key: string, actorId: string) {
    validateDate(input.date);
    if (minor(input.amount) === 0n || !input.reason.trim())
      throw invalid('A positive amount and reason are required');
    return this.db.transaction(async (tx) => {
      await this.lockKey(tx, key);
      const [existing] = await tx
        .select()
        .from(settlementAdjustments)
        .where(eq(settlementAdjustments.idempotencyKey, key));
      if (existing) {
        this.checkRetry(existing.requestHash, input);
        return existing;
      }
      const invoice = await this.lockInvoice(tx, input.invoiceId);
      this.requireIssued(invoice);
      if (input.date < invoice.invoiceDate)
        throw invalid('Adjustment date cannot precede the invoice date');
      await this.checkSettlement(tx, invoice, input.amount);
      const [adjustment] = await tx
        .insert(settlementAdjustments)
        .values({
          ...input,
          idempotencyKey: key,
          requestHash: requestHash(input),
          createdBy: actorId,
        })
        .returning();
      await audit(
        tx,
        actorId,
        'SETTLEMENT_DISCOUNT_RECORDED',
        'settlement_adjustment',
        adjustment!.id,
      );
      return adjustment!;
    });
  }
  async reverseAdjustment(id: string, reason: string, actorId: string) {
    if (!reason.trim()) throw invalid('A reversal reason is required');
    return this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(settlementAdjustments)
        .where(eq(settlementAdjustments.id, id));
      if (!candidate) throw missing('Adjustment');
      await this.lockInvoice(tx, candidate.invoiceId);
      const [adjustment] = await tx
        .select()
        .from(settlementAdjustments)
        .where(eq(settlementAdjustments.id, id))
        .for('update');
      if (adjustment!.reversedAt) return adjustment!;
      const [updated] = await tx
        .update(settlementAdjustments)
        .set({ reversedAt: new Date(), reversalReason: reason })
        .where(eq(settlementAdjustments.id, id))
        .returning();
      await audit(tx, actorId, 'SETTLEMENT_DISCOUNT_REVERSED', 'settlement_adjustment', id);
      return updated!;
    });
  }
  private async prepare(tx: Transaction, input: InvoiceInput) {
    validatePeriod(input.invoiceDate, input.dueDate);
    if (
      !input.guestDisplayText.trim() ||
      !input.serviceProvidedAt.trim() ||
      !input.placeOfSupplyState?.trim() ||
      !input.placeOfSupplyCountry?.trim()
    )
      throw invalid('Traveller and supply location details are required');
    const [company] = await tx
      .select()
      .from(companies)
      .where(eq(companies.id, input.companyId))
      .for('share');
    const [customer] = await tx
      .select()
      .from(customers)
      .where(eq(customers.id, input.customerId))
      .for('share');
    const [category] = await tx
      .select()
      .from(serviceCategories)
      .where(eq(serviceCategories.id, input.serviceCategoryId))
      .for('share');
    if (
      !company ||
      company.status !== 'ACTIVE' ||
      !customer ||
      customer.status !== 'ACTIVE' ||
      !category ||
      category.status !== 'ACTIVE'
    )
      throw invalid('Select an active company, customer and service category');
    const vehicleId = input.vehicleId ?? null;
    if (category.requiresVehicle && !vehicleId)
      throw invalid('Select an active vehicle for this service category');
    if (!category.requiresVehicle && vehicleId)
      throw invalid('A vehicle can only be selected for a service category that requires one');
    const vehicle = vehicleId ? await this.catalog.getVehicle(vehicleId) : null;
    if (vehicle && vehicle.status !== 'ACTIVE')
      throw invalid('Select an active vehicle for this service category');
    const guest = input.guestId
      ? ((await tx.select().from(guests).where(eq(guests.id, input.guestId)).for('share'))[0] ??
        null)
      : null;
    if (input.guestId) {
      if (!guest || guest.status !== 'ACTIVE') throw invalid('Select an active guest');
    }
    if (new Set(input.bankAccountIds).size !== input.bankAccountIds.length)
      throw invalid('Bank accounts must not be repeated');
    const banks = input.bankAccountIds.length
      ? await tx
          .select()
          .from(bankAccounts)
          .where(inArray(bankAccounts.id, input.bankAccountIds))
          .for('share')
      : [];
    if (
      banks.length !== input.bankAccountIds.length ||
      banks.some((b) => b.companyId !== company.id || b.status !== 'ACTIVE')
    )
      throw invalid('Select active bank accounts belonging to the invoice company');
    await tx.execute(sql`SELECT pg_advisory_xact_lock(81001)`);
    const rates = await tx
      .select()
      .from(taxRules)
      .where(
        and(
          eq(taxRules.status, 'ACTIVE'),
          lte(taxRules.effectiveFrom, input.invoiceDate),
          or(isNull(taxRules.effectiveTo), gte(taxRules.effectiveTo, input.invoiceDate)),
        ),
      );
    const lines = calculateLines(input.lines, rates, input.serviceCategoryId);
    return {
      lines,
      snapshot: {
        schemaVersion: 2,
        company,
        customer,
        guest,
        serviceCategory: category,
        vehicle: vehicle
          ? {
              ...vehicle,
              name: vehicle.displayName,
            }
          : null,
        bankAccounts: input.bankAccountIds.map((id) => banks.find((b) => b.id === id)!),
        currency: 'INR',
        rounding: 'HALF_UP_PER_LINE_COMPONENT',
        taxEffectiveDate: input.invoiceDate,
      },
    };
  }
  private async replaceLines(tx: Transaction, invoiceId: string, lines: CalculatedLine[]) {
    await tx.delete(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
    for (const { taxes, ...line } of lines) {
      const [saved] = await tx
        .insert(invoiceLines)
        .values({ ...line, invoiceId })
        .returning();
      if (taxes.length)
        await tx
          .insert(invoiceLineTaxes)
          .values(taxes.map((tax) => ({ ...tax, lineId: saved!.id })));
    }
  }
  private async lockInvoice(tx: Transaction, id: string) {
    const [invoice] = await tx.select().from(invoices).where(eq(invoices.id, id)).for('update');
    if (!invoice) throw missing('Invoice');
    return invoice;
  }
  private requireIssued(invoice: { status: string }) {
    if (invoice.status !== 'ISSUED')
      throw conflict('INVOICE_NOT_ISSUED', 'Only issued invoices accept settlements');
  }
  private async balance(
    tx: Transaction,
    invoice: { id: string; status: string; grandTotal: string },
  ) {
    const payments = await tx
      .select({ amount: receipts.amount })
      .from(receipts)
      .where(and(eq(receipts.invoiceId, invoice.id), eq(receipts.status, 'CONFIRMED')));
    const adjustments = await tx
      .select({ amount: settlementAdjustments.amount })
      .from(settlementAdjustments)
      .where(
        and(
          eq(settlementAdjustments.invoiceId, invoice.id),
          isNull(settlementAdjustments.reversedAt),
        ),
      );
    const received = sum(payments.map((p) => p.amount)),
      adjusted = sum(adjustments.map((a) => a.amount));
    const due =
      invoice.status === 'ISSUED' ? outstanding(invoice.grandTotal, received, adjusted) : '0.00';
    return {
      receivedAmount: received,
      adjustmentAmount: adjusted,
      dueAmount: due,
      paymentStatus:
        invoice.status !== 'ISSUED'
          ? 'NOT_APPLICABLE'
          : due === '0.00'
            ? 'PAID'
            : received === '0.00' && adjusted === '0.00'
              ? 'UNPAID'
              : 'PARTIALLY_PAID',
    };
  }
  private async checkSettlement(
    tx: Transaction,
    invoice: { id: string; status: string; grandTotal: string },
    amount: string,
  ) {
    const balance = await this.balance(tx, invoice);
    if (minor(amount) > minor(balance.dueAmount))
      throw conflict('OVERPAYMENT', 'Amount exceeds the current outstanding balance');
  }
  private async nextNumber(tx: Transaction, companyId: string, year: string, kind: string) {
    const [counter] = await tx
      .insert(documentCounters)
      .values({ companyId, financialYear: year, kind, value: 1 })
      .onConflictDoUpdate({
        target: [documentCounters.companyId, documentCounters.financialYear, documentCounters.kind],
        set: { value: sql`${documentCounters.value} + 1` },
        setWhere: sql`${documentCounters.value} < 999999`,
      })
      .returning();
    if (!counter) throw conflict('NUMBER_SERIES_EXHAUSTED', 'Document number series is exhausted');
    return `${kind}/${year}/${counter.value.toString().padStart(6, '0')}`;
  }
  private async lockKey(tx: Transaction, key: string) {
    if (!/^[A-Za-z0-9_:-]{8,128}$/.test(key))
      throw invalid(
        'Idempotency-Key must contain 8–128 letters, digits, underscores, colons or hyphens',
      );
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }
  private checkRetry(hash: string, input: unknown) {
    if (hash !== requestHash(input))
      throw conflict(
        'IDEMPOTENCY_CONFLICT',
        'This idempotency key was already used for a different request',
      );
  }
  private presentRate(rate: string): string {
    const [whole, fraction = ''] = rate.split('.');
    return `${whole}.${fraction.padEnd(2, '0').replace(/0+$/, '').padEnd(2, '0')}`;
  }
}
