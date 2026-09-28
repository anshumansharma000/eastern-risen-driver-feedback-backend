import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { Check } from 'typebox/value';
import type { CoreDatabase } from '../persistence/database.js';
import {
  invoices,
  invoiceLines,
  invoiceLineTaxes,
  documentCounters,
} from '../persistence/billing.schema.js';
import { legacyMappings } from '../persistence/masters.schema.js';
import { audit } from '../persistence/audit.js';
import { legacyInvoiceSchema, type LegacyInvoice } from './invoice-import.schema.js';
import { financialYear, validatePeriod } from '../domain/validation.js';
import { decimal, minor, sum } from '../domain/money.js';
import { conflict, invalid } from '../domain/errors.js';

export function validateLegacyInvoice(value: unknown): LegacyInvoice {
  if (!Check(legacyInvoiceSchema, value))
    throw invalid('Legacy invoice does not match the version 1 interchange schema');
  validatePeriod(value.invoice.invoiceDate, value.invoice.dueDate);
  value.lines.forEach((line, index) => {
    if (line.position !== index + 1) throw invalid('Historical line positions must be consecutive');
    if (new Set(line.taxes.map((t) => t.component)).size !== line.taxes.length)
      throw invalid('Historical tax components are duplicated on a line');
    if (
      sum(line.taxes.map((t) => t.amount)) !== line.taxAmount ||
      decimal(minor(line.amount) + minor(line.taxAmount)) !== line.total
    )
      throw invalid(
        'Historical line totals do not reconcile; resolve the discrepancy before importing',
      );
  });
  if (
    sum(value.lines.map((l) => l.amount)) !== value.subtotal ||
    sum(value.lines.map((l) => l.taxAmount)) !== value.taxTotal ||
    sum(value.lines.map((l) => l.total)) !== value.grandTotal
  )
    throw invalid('Historical invoice totals do not reconcile; no amounts have been recalculated');
  if (
    value.invoice.lines.length !== value.lines.length ||
    value.invoice.lines.some((line, index) => {
      const stored = value.lines[index]!;
      return (
        line.description !== stored.description ||
        line.amount !== stored.amount ||
        line.taxTreatment !== stored.taxTreatment ||
        [...line.taxComponents].sort().join(',') !==
          stored.taxes
            .map((t) => t.component)
            .sort()
            .join(',')
      );
    })
  )
    throw invalid('Historical line details must agree with the preserved invoice input');
  if (value.invoice.bankAccountIds.length !== value.snapshot.bankAccounts.length)
    throw invalid('Historical bank-account snapshots must match the selected bank accounts');
  if (Boolean(value.invoice.vehicleId) !== Boolean(value.snapshot.vehicle))
    throw invalid('Historical vehicle identity and snapshot must be supplied together');
  return value;
}
function fingerprint(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, canonical(child)]),
          )
        : item;
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
function snapshotText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function nullableSnapshotText(value: unknown): string | null {
  return value == null ? null : snapshotText(value);
}
/** Operational import only: no HTTP route, tax lookup, issued event, or number regeneration. */
export async function importLegacyInvoice(
  db: CoreDatabase,
  raw: unknown,
  actorId: string,
): Promise<{ id: string; alreadyImported: boolean }> {
  const input = validateLegacyInvoice(raw);
  return db.transaction(async (tx) => {
    const key = JSON.stringify([input.source, input.sourceTable, input.sourceId]);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const [existing] = await tx
      .select()
      .from(legacyMappings)
      .where(
        and(
          eq(legacyMappings.source, input.source),
          eq(legacyMappings.sourceTable, input.sourceTable),
          eq(legacyMappings.sourceId, input.sourceId),
        ),
      );
    if (existing) {
      if (
        existing.entityType !== 'invoice' ||
        existing.rawRecord.importFingerprint !== fingerprint(input)
      )
        throw conflict(
          'LEGACY_IMPORT_CONFLICT',
          'This source record was previously imported with different content',
        );
      return { id: existing.entityId, alreadyImported: true };
    }
    const details = input.invoice,
      year = financialYear(details.invoiceDate);
    const [invoice] = await tx
      .insert(invoices)
      .values({
        companyId: details.companyId,
        customerId: details.customerId,
        guestId: details.guestId ?? null,
        serviceCategoryId: details.serviceCategoryId,
        vehicleId: details.vehicleId ?? null,
        invoiceDate: details.invoiceDate,
        financialYear: year,
        invoiceNumber: input.invoiceNumber,
        status: 'ISSUED',
        details,
        snapshot: {
          company: {
            ...input.snapshot.company,
            id: details.companyId,
            name: snapshotText(input.snapshot.company.name),
          },
          customer: {
            ...input.snapshot.customer,
            id: details.customerId,
            name: snapshotText(input.snapshot.customer.name),
          },
          guest: null,
          serviceCategory: {
            ...input.snapshot.serviceCategory,
            id: details.serviceCategoryId,
            name: snapshotText(input.snapshot.serviceCategory.name),
            code: snapshotText(input.snapshot.serviceCategory.code),
          },
          vehicle: details.vehicleId
            ? {
                ...input.snapshot.vehicle,
                id: details.vehicleId,
                name: snapshotText(input.snapshot.vehicle?.name),
                registrationNumber: snapshotText(input.snapshot.vehicle?.registrationNumber),
                vehicleType: snapshotText(input.snapshot.vehicle?.vehicleType),
              }
            : null,
          bankAccounts: input.snapshot.bankAccounts.map((bank, index) => ({
            ...bank,
            id: details.bankAccountIds[index]!,
            name: snapshotText(bank.name),
            bankName: nullableSnapshotText(bank.bankName),
            accountNumber: snapshotText(bank.accountNumber),
            branch: nullableSnapshotText(bank.branch),
            ifscCode: nullableSnapshotText(bank.ifscCode),
          })),
          schemaVersion: 1,
          legacy: true,
          currency: 'INR',
          rounding: 'PRESERVED_LEGACY',
          issuanceTimeKnown: false,
        },
        subtotal: input.subtotal,
        taxTotal: input.taxTotal,
        grandTotal: input.grandTotal,
        createdBy: actorId,
        // Only an issue DATE is known. The marker above prevents interpreting this as a known event time.
        issuedAt: new Date(`${details.invoiceDate}T00:00:00+05:30`),
      })
      .returning({ id: invoices.id });
    for (const { taxes, ...line } of input.lines) {
      const [saved] = await tx
        .insert(invoiceLines)
        .values({ ...line, invoiceId: invoice!.id })
        .returning({ id: invoiceLines.id });
      if (taxes.length)
        await tx
          .insert(invoiceLineTaxes)
          .values(taxes.map((tax) => ({ ...tax, ruleId: tax.ruleId ?? null, lineId: saved!.id })));
    }
    await tx.insert(legacyMappings).values({
      source: input.source,
      sourceTable: input.sourceTable,
      sourceId: input.sourceId,
      entityType: 'invoice',
      entityId: invoice!.id,
      rawRecord: { original: input.rawRecord, importFingerprint: fingerprint(input) },
    });
    // If legacy happened to use the new series format, continue beyond its imported number.
    const match = /^I\/(\d{4})\/(\d{6})$/.exec(input.invoiceNumber);
    if (match) {
      if (match[1] !== year || Number(match[2]) === 0)
        throw invalid('Legacy invoice number conflicts with the new series format');
      await tx
        .insert(documentCounters)
        .values({
          companyId: details.companyId,
          financialYear: year,
          kind: 'I',
          value: Number(match[2]),
        })
        .onConflictDoUpdate({
          target: [
            documentCounters.companyId,
            documentCounters.financialYear,
            documentCounters.kind,
          ],
          set: { value: sql`greatest(${documentCounters.value}, ${Number(match[2])})` },
        });
    }
    await audit(tx, actorId, 'LEGACY_INVOICE_IMPORTED', 'invoice', invoice!.id);
    return { id: invoice!.id, alreadyImported: false };
  });
}
