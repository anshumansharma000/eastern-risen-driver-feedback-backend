import { textSearch } from '../../../shared/database/search.js';
import { ensureUnambiguousTaxRule } from './tax-rule-validation.js';
import { and, asc, count, eq, ilike, sql } from 'drizzle-orm';
import type { CoreDatabase } from './database.js';
import { conflict, missing } from '../domain/errors.js';
import { validateDate, validatePeriod } from '../domain/validation.js';
import type { SharedCatalog } from '../application/ports.js';
import * as tables from './masters.schema.js';
import type * as inputs from '../http/masters.schemas.js';
import { audit } from './audit.js';
export class MastersRepository {
  constructor(
    private readonly db: CoreDatabase,
    private readonly catalog: SharedCatalog,
  ) {}

  async listCompanies(
    page: number,
    pageSize: number,
    status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED',
    q?: string,
  ) {
    const filter = and(
      status ? eq(tables.companies.status, status) : undefined,
      textSearch(q, [
        tables.companies.name,
        tables.companies.phone,
        tables.companies.mobileNumber,
        tables.companies.email,
      ]),
    );
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(tables.companies)
        .where(filter)
        .orderBy(asc(tables.companies.name), asc(tables.companies.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ value: count() }).from(tables.companies).where(filter),
    ]);
    return { items, total: total!.value };
  }
  async getCompanies(id: string) {
    const [record] = await this.db
      .select()
      .from(tables.companies)
      .where(eq(tables.companies.id, id));
    if (!record) throw missing('companies');
    return record;
  }
  async createCompanies(input: inputs.CompaniesInput, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [record] = await tx.insert(tables.companies).values(input).returning();
      await audit(tx, actorId, 'CREATED', 'companies', record!.id);
      return record!;
    });
  }
  async updateCompanies(
    id: string,
    input: inputs.CompaniesInput,
    version: number,
    actorId: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [record] = await tx
        .update(tables.companies)
        .set({
          ...input,
          address: input.address ?? null,
          state: input.state ?? null,
          country: input.country ?? null,
          status: input.status ?? 'ACTIVE',
          phone: input.phone ?? null,
          mobileNumber: input.mobileNumber ?? null,
          email: input.email ?? null,
          pan: input.pan ?? null,
          serviceTaxNumber: input.serviceTaxNumber ?? null,
          cin: input.cin ?? null,
          gstNumber: input.gstNumber ?? null,
          website: input.website ?? null,
          postalCode: input.postalCode ?? null,
          branchOffice: input.branchOffice ?? null,
          paymentInstructions: input.paymentInstructions ?? null,
          footerNotes: input.footerNotes ?? null,
          version: sql`${tables.companies.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(tables.companies.id, id), eq(tables.companies.version, version)))
        .returning();
      if (!record)
        throw conflict(
          'STALE_VERSION',
          'The record was changed or does not exist; reload before saving',
        );
      await audit(tx, actorId, 'UPDATED', 'companies', id);
      return record;
    });
  }

  async listBankAccounts(
    page: number,
    pageSize: number,
    status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED',
    q?: string,
    companyId?: string,
  ) {
    const filter = and(
      status ? eq(tables.bankAccounts.status, status) : undefined,
      textSearch(q, [
        tables.bankAccounts.name,
        tables.bankAccounts.bankName,
        tables.bankAccounts.branch,
        tables.bankAccounts.ifscCode,
        tables.bankAccounts.swiftCode,
      ]),
      companyId ? eq(tables.bankAccounts.companyId, companyId) : undefined,
    );
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(tables.bankAccounts)
        .where(filter)
        .orderBy(asc(tables.bankAccounts.name), asc(tables.bankAccounts.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ value: count() }).from(tables.bankAccounts).where(filter),
    ]);
    return { items, total: total!.value };
  }
  async getBankAccounts(id: string) {
    const [record] = await this.db
      .select()
      .from(tables.bankAccounts)
      .where(eq(tables.bankAccounts.id, id));
    if (!record) throw missing('bankAccounts');
    return record;
  }
  async createBankAccounts(input: inputs.BankAccountsInput, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [record] = await tx.insert(tables.bankAccounts).values(input).returning();
      await audit(tx, actorId, 'CREATED', 'bankAccounts', record!.id);
      return record!;
    });
  }
  async updateBankAccounts(
    id: string,
    input: inputs.BankAccountsInput,
    version: number,
    actorId: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [record] = await tx
        .update(tables.bankAccounts)
        .set({
          ...input,
          status: input.status ?? 'ACTIVE',
          bankName: input.bankName ?? null,
          branch: input.branch ?? null,
          ifscCode: input.ifscCode ?? null,
          swiftCode: input.swiftCode ?? null,
          version: sql`${tables.bankAccounts.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(tables.bankAccounts.id, id), eq(tables.bankAccounts.version, version)))
        .returning();
      if (!record)
        throw conflict(
          'STALE_VERSION',
          'The record was changed or does not exist; reload before saving',
        );
      await audit(tx, actorId, 'UPDATED', 'bankAccounts', id);
      return record;
    });
  }

  async listCustomers(
    page: number,
    pageSize: number,
    status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED',
    category?: 'AGENT' | 'LEISURE' | 'CORPORATE',
    queryText?: string,
  ) {
    const filter = and(
      status ? eq(tables.customers.status, status) : undefined,
      category ? eq(tables.customers.category, category) : undefined,
      queryText?.trim()
        ? ilike(
            tables.customers.name,
            `%${queryText.trim().replace(/[\\%_]/g, (character) => '\\' + character)}%`,
          )
        : undefined,
    );
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(tables.customers)
        .where(filter)
        .orderBy(asc(tables.customers.name), asc(tables.customers.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ value: count() }).from(tables.customers).where(filter),
    ]);
    return { items, total: total!.value };
  }
  async getCustomers(id: string) {
    const [record] = await this.db
      .select()
      .from(tables.customers)
      .where(eq(tables.customers.id, id));
    if (!record) throw missing('customers');
    return record;
  }
  async createCustomers(input: inputs.CustomersInput, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [record] = await tx.insert(tables.customers).values(input).returning();
      await audit(tx, actorId, 'CREATED', 'customers', record!.id);
      return record!;
    });
  }
  async updateCustomers(
    id: string,
    input: inputs.CustomersInput,
    version: number,
    actorId: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [record] = await tx
        .update(tables.customers)
        .set({
          ...input,
          status: input.status ?? 'ACTIVE',
          address: input.address ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          country: input.country ?? null,
          postalCode: input.postalCode ?? null,
          phone: input.phone ?? null,
          mobileNumber: input.mobileNumber ?? null,
          email: input.email ?? null,
          contactPerson: input.contactPerson ?? null,
          pan: input.pan ?? null,
          serviceTaxNumber: input.serviceTaxNumber ?? null,
          gstNumber: input.gstNumber ?? null,
          market: input.market ?? null,
          version: sql`${tables.customers.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(tables.customers.id, id), eq(tables.customers.version, version)))
        .returning();
      if (!record)
        throw conflict(
          'STALE_VERSION',
          'The record was changed or does not exist; reload before saving',
        );
      await audit(tx, actorId, 'UPDATED', 'customers', id);
      return record;
    });
  }

  async listGuests(
    page: number,
    pageSize: number,
    status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED',
    q?: string,
  ) {
    const filter = and(
      status ? eq(tables.guests.status, status) : undefined,
      textSearch(q, [
        tables.guests.name,
        tables.guests.phone,
        tables.guests.mobileNumber,
        tables.guests.email,
        tables.guests.contactPerson,
      ]),
    );
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(tables.guests)
        .where(filter)
        .orderBy(asc(tables.guests.name), asc(tables.guests.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ value: count() }).from(tables.guests).where(filter),
    ]);
    return { items, total: total!.value };
  }
  async getGuests(id: string) {
    const [record] = await this.db.select().from(tables.guests).where(eq(tables.guests.id, id));
    if (!record) throw missing('guests');
    return record;
  }
  async createGuests(input: inputs.GuestsInput, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [record] = await tx.insert(tables.guests).values(input).returning();
      await audit(tx, actorId, 'CREATED', 'guests', record!.id);
      return record!;
    });
  }
  async updateGuests(id: string, input: inputs.GuestsInput, version: number, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [record] = await tx
        .update(tables.guests)
        .set({
          ...input,
          status: input.status ?? 'ACTIVE',
          address: input.address ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          country: input.country ?? null,
          postalCode: input.postalCode ?? null,
          phone: input.phone ?? null,
          mobileNumber: input.mobileNumber ?? null,
          email: input.email ?? null,
          contactPerson: input.contactPerson ?? null,
          market: input.market ?? null,
          legacyLastServiceAvailed: input.legacyLastServiceAvailed ?? null,
          legacyLastAmountPaid: input.legacyLastAmountPaid ?? null,
          version: sql`${tables.guests.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(tables.guests.id, id), eq(tables.guests.version, version)))
        .returning();
      if (!record)
        throw conflict(
          'STALE_VERSION',
          'The record was changed or does not exist; reload before saving',
        );
      await audit(tx, actorId, 'UPDATED', 'guests', id);
      return record;
    });
  }

  async listHotels(
    page: number,
    pageSize: number,
    status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED',
    q?: string,
  ) {
    const filter = and(
      status ? eq(tables.hotels.status, status) : undefined,
      textSearch(q, [
        tables.hotels.name,
        tables.hotels.city,
        tables.hotels.phone,
        tables.hotels.mobileNumber,
        tables.hotels.email,
        tables.hotels.contactPerson,
      ]),
    );
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(tables.hotels)
        .where(filter)
        .orderBy(asc(tables.hotels.name), asc(tables.hotels.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ value: count() }).from(tables.hotels).where(filter),
    ]);
    return { items, total: total!.value };
  }
  async getHotels(id: string) {
    const [record] = await this.db.select().from(tables.hotels).where(eq(tables.hotels.id, id));
    if (!record) throw missing('hotels');
    return record;
  }
  async createHotels(input: inputs.HotelsInput, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [record] = await tx.insert(tables.hotels).values(input).returning();
      await audit(tx, actorId, 'CREATED', 'hotels', record!.id);
      return record!;
    });
  }
  async updateHotels(id: string, input: inputs.HotelsInput, version: number, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [record] = await tx
        .update(tables.hotels)
        .set({
          ...input,
          status: input.status ?? 'ACTIVE',
          address: input.address ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          country: input.country ?? null,
          postalCode: input.postalCode ?? null,
          phone: input.phone ?? null,
          mobileNumber: input.mobileNumber ?? null,
          email: input.email ?? null,
          contactPerson: input.contactPerson ?? null,
          market: input.market ?? null,
          version: sql`${tables.hotels.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(tables.hotels.id, id), eq(tables.hotels.version, version)))
        .returning();
      if (!record)
        throw conflict(
          'STALE_VERSION',
          'The record was changed or does not exist; reload before saving',
        );
      await audit(tx, actorId, 'UPDATED', 'hotels', id);
      return record;
    });
  }

  async listHotelRates(
    page: number,
    pageSize: number,
    status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED',
    q?: string,
    hotelId?: string,
  ) {
    const filter = and(
      status ? eq(tables.hotelRates.status, status) : undefined,
      textSearch(q, [tables.hotelRates.name, tables.hotelRates.plan]),
      hotelId ? eq(tables.hotelRates.hotelId, hotelId) : undefined,
    );
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(tables.hotelRates)
        .where(filter)
        .orderBy(asc(tables.hotelRates.name), asc(tables.hotelRates.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ value: count() }).from(tables.hotelRates).where(filter),
    ]);
    return { items, total: total!.value };
  }
  async getHotelRates(id: string) {
    const [record] = await this.db
      .select()
      .from(tables.hotelRates)
      .where(eq(tables.hotelRates.id, id));
    if (!record) throw missing('hotelRates');
    return record;
  }
  async createHotelRates(input: inputs.HotelRatesInput, actorId: string) {
    if (input.effectiveFrom) validatePeriod(input.effectiveFrom, input.effectiveTo);
    else if (input.effectiveTo) validateDate(input.effectiveTo);

    return this.db.transaction(async (tx) => {
      const [record] = await tx.insert(tables.hotelRates).values(input).returning();
      await audit(tx, actorId, 'CREATED', 'hotelRates', record!.id);
      return record!;
    });
  }
  async updateHotelRates(
    id: string,
    input: inputs.HotelRatesInput,
    version: number,
    actorId: string,
  ) {
    if (input.effectiveFrom) validatePeriod(input.effectiveFrom, input.effectiveTo);
    else if (input.effectiveTo) validateDate(input.effectiveTo);

    return this.db.transaction(async (tx) => {
      const [record] = await tx
        .update(tables.hotelRates)
        .set({
          ...input,
          effectiveFrom: input.effectiveFrom ?? null,
          status: input.status ?? 'ACTIVE',
          effectiveTo: input.effectiveTo ?? null,
          version: sql`${tables.hotelRates.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(tables.hotelRates.id, id), eq(tables.hotelRates.version, version)))
        .returning();
      if (!record)
        throw conflict(
          'STALE_VERSION',
          'The record was changed or does not exist; reload before saving',
        );
      await audit(tx, actorId, 'UPDATED', 'hotelRates', id);
      return record;
    });
  }

  async listServiceCategories(
    page: number,
    pageSize: number,
    status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED',
    q?: string,
  ) {
    const filter = and(
      status ? eq(tables.serviceCategories.status, status) : undefined,
      textSearch(q, [tables.serviceCategories.name, tables.serviceCategories.code]),
    );
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(tables.serviceCategories)
        .where(filter)
        .orderBy(asc(tables.serviceCategories.name), asc(tables.serviceCategories.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ value: count() }).from(tables.serviceCategories).where(filter),
    ]);
    return { items, total: total!.value };
  }
  async getServiceCategories(id: string) {
    const [record] = await this.db
      .select()
      .from(tables.serviceCategories)
      .where(eq(tables.serviceCategories.id, id));
    if (!record) throw missing('serviceCategories');
    return record;
  }
  async createServiceCategories(input: inputs.ServiceCategoriesInput, actorId: string) {
    return this.db.transaction(async (tx) => {
      const [record] = await tx.insert(tables.serviceCategories).values(input).returning();
      await audit(tx, actorId, 'CREATED', 'serviceCategories', record!.id);
      return record!;
    });
  }
  async updateServiceCategories(
    id: string,
    input: inputs.ServiceCategoriesInput,
    version: number,
    actorId: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [record] = await tx
        .update(tables.serviceCategories)
        .set({
          ...input,
          status: input.status ?? 'ACTIVE',
          version: sql`${tables.serviceCategories.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(eq(tables.serviceCategories.id, id), eq(tables.serviceCategories.version, version)),
        )
        .returning();
      if (!record)
        throw conflict(
          'STALE_VERSION',
          'The record was changed or does not exist; reload before saving',
        );
      await audit(tx, actorId, 'UPDATED', 'serviceCategories', id);
      return record;
    });
  }

  async listTaxRules(
    page: number,
    pageSize: number,
    status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED',
    q?: string,
  ) {
    const filter = and(
      status ? eq(tables.taxRules.status, status) : undefined,
      textSearch(q, [tables.taxRules.name, tables.taxRules.component]),
    );
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(tables.taxRules)
        .where(filter)
        .orderBy(asc(tables.taxRules.name), asc(tables.taxRules.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ value: count() }).from(tables.taxRules).where(filter),
    ]);
    return { items, total: total!.value };
  }
  async getTaxRules(id: string) {
    const [record] = await this.db.select().from(tables.taxRules).where(eq(tables.taxRules.id, id));
    if (!record) throw missing('taxRules');
    return record;
  }
  async createTaxRules(input: inputs.TaxRulesInput, actorId: string) {
    validatePeriod(input.effectiveFrom, input.effectiveTo);

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(81001)`);
      await ensureUnambiguousTaxRule(tx, input);
      const [record] = await tx.insert(tables.taxRules).values(input).returning();
      await audit(tx, actorId, 'CREATED', 'taxRules', record!.id);
      return record!;
    });
  }
  async updateTaxRules(id: string, input: inputs.TaxRulesInput, version: number, actorId: string) {
    validatePeriod(input.effectiveFrom, input.effectiveTo);

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(81001)`);
      await ensureUnambiguousTaxRule(tx, input, id);
      const [record] = await tx
        .update(tables.taxRules)
        .set({
          ...input,
          status: input.status ?? 'ACTIVE',
          serviceCategoryId: input.serviceCategoryId ?? null,
          effectiveTo: input.effectiveTo ?? null,
          version: sql`${tables.taxRules.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(tables.taxRules.id, id), eq(tables.taxRules.version, version)))
        .returning();
      if (!record)
        throw conflict(
          'STALE_VERSION',
          'The record was changed or does not exist; reload before saving',
        );
      await audit(tx, actorId, 'UPDATED', 'taxRules', id);
      return record;
    });
  }

  async listVendorProfiles(
    page: number,
    pageSize: number,
    status?: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED',
    q?: string,
    vendorId?: string,
  ) {
    const filter = and(
      status ? eq(tables.vendorProfiles.status, status) : undefined,
      textSearch(q, [
        tables.vendorProfiles.address,
        tables.vendorProfiles.city,
        tables.vendorProfiles.state,
        tables.vendorProfiles.country,
        tables.vendorProfiles.postalCode,
        tables.vendorProfiles.mobileNumber,
      ]),
      vendorId ? eq(tables.vendorProfiles.vendorId, vendorId) : undefined,
    );
    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(tables.vendorProfiles)
        .where(filter)
        .orderBy(asc(tables.vendorProfiles.id))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      this.db.select({ value: count() }).from(tables.vendorProfiles).where(filter),
    ]);
    return { items, total: total!.value };
  }
  async getVendorProfiles(id: string) {
    const [record] = await this.db
      .select()
      .from(tables.vendorProfiles)
      .where(eq(tables.vendorProfiles.id, id));
    if (!record) throw missing('vendorProfiles');
    return record;
  }
  async createVendorProfiles(input: inputs.VendorProfilesInput, actorId: string) {
    await this.catalog.requireVendor(input.vendorId);

    return this.db.transaction(async (tx) => {
      const [record] = await tx.insert(tables.vendorProfiles).values(input).returning();
      await audit(tx, actorId, 'CREATED', 'vendorProfiles', record!.id);
      return record!;
    });
  }
  async updateVendorProfiles(
    id: string,
    input: inputs.VendorProfilesInput,
    version: number,
    actorId: string,
  ) {
    await this.catalog.requireVendor(input.vendorId);

    return this.db.transaction(async (tx) => {
      const [record] = await tx
        .update(tables.vendorProfiles)
        .set({
          ...input,
          status: input.status ?? 'ACTIVE',
          address: input.address ?? null,
          city: input.city ?? null,
          state: input.state ?? null,
          country: input.country ?? null,
          postalCode: input.postalCode ?? null,
          mobileNumber: input.mobileNumber ?? null,
          market: input.market ?? null,
          version: sql`${tables.vendorProfiles.version} + 1`,
          updatedAt: new Date(),
        })
        .where(and(eq(tables.vendorProfiles.id, id), eq(tables.vendorProfiles.version, version)))
        .returning();
      if (!record)
        throw conflict(
          'STALE_VERSION',
          'The record was changed or does not exist; reload before saving',
        );
      await audit(tx, actorId, 'UPDATED', 'vendorProfiles', id);
      return record;
    });
  }
}
