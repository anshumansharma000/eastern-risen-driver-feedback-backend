import { randomBytes } from 'node:crypto';
import { and, count, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import {
  authAccounts,
  authSessions,
  auditEvents,
  outboxMessages,
} from '../../database/schema/index.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { FieldEncryptor } from '../../shared/security/field-encryption.js';
import { hashToken } from '../auth/auth.service.js';
import type { PasswordHasher } from '../auth/password.js';
import {
  commercialBookings,
  paymentMilestones,
  paymentOrders,
} from '../core/persistence/commercial.schema.js';
import { customers } from '../core/persistence/masters.schema.js';
import { invoices } from '../core/persistence/billing.schema.js';
import type { CoreServices } from '../core/index.js';
import type { CoreTransaction } from '../core/persistence/database.js';
import {
  customerInvitations,
  customerMemberships,
  customerRecoveryTokens,
} from './customer.schema.js';

const fail = (code: string, message: string, statusCode = 409): never => {
  throw new AppError({ code, message, statusCode });
};
const freshToken = () => randomBytes(32).toString('base64url');
const validInvitation = (row: typeof customerInvitations.$inferSelect | undefined) =>
  row && !row.consumedAt && !row.revokedAt && row.expiresAt > new Date();
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const party = (value: Record<string, unknown> | null | undefined) => ({
  name: text(value?.name),
  address: text(value?.address),
  city: text(value?.city),
  state: text(value?.state),
  country: text(value?.country),
  postalCode: text(value?.postalCode),
  gstNumber: text(value?.gstNumber),
});
const publicUser = {
  accountId: authAccounts.id,
  displayName: authAccounts.displayName,
  email: authAccounts.email,
  status: authAccounts.status,
};

export class CustomerService {
  constructor(
    private readonly db: AppDatabase,
    private readonly passwords: PasswordHasher,
    private readonly core: CoreServices,
    private readonly encryptor: FieldEncryptor,
    private readonly accountUrl: string | null,
    private readonly mailEnabled: boolean,
  ) {}

  private async log(
    tx: CoreTransaction,
    actorAccountId: string | null,
    action: string,
    entityId: string,
  ) {
    await tx
      .insert(auditEvents)
      .values({ actorAccountId, action, entityType: 'CUSTOMER_ACCESS', entityId });
  }
  private async emailLock(tx: CoreTransaction, email: string) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`customer-email:${email}`}))`);
  }
  private async activeCustomer(tx: CoreTransaction, customerId: string) {
    const [row] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.status, 'ACTIVE')))
      .for('share');
    if (!row) fail('CUSTOMER_UNAVAILABLE', 'An active customer record is required', 404);
  }
  private link(kind: 'activate' | 'reset-password', token: string) {
    // Fragment keeps bearer credentials out of server access logs and Referer headers.
    return this.accountUrl ? `${this.accountUrl}/${kind}#token=${token}` : null;
  }
  private async queue(
    tx: CoreTransaction,
    kind: 'INVITATION' | 'RECOVERY',
    id: string,
    email: string,
    url: string,
    expiresAt: Date,
  ) {
    await tx.insert(outboxMessages).values({
      idempotencyKey: `customer-${kind}-${id}`,
      messageType: `CUSTOMER_${kind}`,
      aggregateType: 'CUSTOMER_ACCESS',
      aggregateId: id,
      payloadCiphertext: this.encryptor.encrypt(
        JSON.stringify({ email, url, expiresAt: expiresAt.toISOString(), kind }),
      ),
    });
  }

  async invite(customerId: string, input: { email: string; displayName: string }, actorId: string) {
    const email = input.email.trim().toLowerCase();
    const token = freshToken(),
      expiresAt = new Date(Date.now() + 72 * 3600000);
    return this.db.transaction(async (tx) => {
      await this.emailLock(tx, email);
      await this.activeCustomer(tx, customerId);
      const [existing] = await tx
        .select()
        .from(authAccounts)
        .where(eq(sql`lower(${authAccounts.email})`, email));
      if (existing && (existing.role !== 'CUSTOMER' || existing.status !== 'ACTIVE'))
        fail('CUSTOMER_EMAIL_UNAVAILABLE', 'This email cannot be invited as a customer');
      if (existing) {
        const [membership] = await tx
          .select()
          .from(customerMemberships)
          .where(
            and(
              eq(customerMemberships.customerId, customerId),
              eq(customerMemberships.accountId, existing.id),
              isNull(customerMemberships.revokedAt),
            ),
          );
        if (membership)
          fail('CUSTOMER_ALREADY_HAS_ACCESS', 'This person already has customer access');
      }
      await tx
        .update(customerInvitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(customerInvitations.customerId, customerId),
            eq(customerInvitations.email, email),
            isNull(customerInvitations.consumedAt),
            isNull(customerInvitations.revokedAt),
          ),
        );
      const [invitation] = await tx
        .insert(customerInvitations)
        .values({
          customerId,
          email,
          displayName: input.displayName.trim(),
          tokenHash: hashToken(token),
          createdBy: actorId,
          expiresAt,
        })
        .returning();
      await this.log(tx, actorId, 'CUSTOMER_INVITED', invitation!.id);
      const activationUrl = this.link('activate', token);
      if (this.mailEnabled && activationUrl)
        await this.queue(tx, 'INVITATION', invitation!.id, email, activationUrl, expiresAt);
      return {
        id: invitation!.id,
        email,
        displayName: invitation!.displayName,
        expiresAt,
        activationToken: token,
        activationUrl,
        delivery: this.mailEnabled ? ('QUEUED' as const) : ('MANUAL' as const),
      };
    });
  }

  async accessList(customerId: string) {
    const [customer] = await this.db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, customerId));
    if (!customer) fail('CUSTOMER_UNAVAILABLE', 'Customer record was not found', 404);
    const memberships = await this.db
      .select({
        id: customerMemberships.id,
        ...publicUser,
        createdAt: customerMemberships.createdAt,
        revokedAt: customerMemberships.revokedAt,
      })
      .from(customerMemberships)
      .innerJoin(authAccounts, eq(authAccounts.id, customerMemberships.accountId))
      .where(eq(customerMemberships.customerId, customerId));
    const invitations = await this.db
      .select({
        id: customerInvitations.id,
        email: customerInvitations.email,
        displayName: customerInvitations.displayName,
        expiresAt: customerInvitations.expiresAt,
        consumedAt: customerInvitations.consumedAt,
        revokedAt: customerInvitations.revokedAt,
        createdAt: customerInvitations.createdAt,
      })
      .from(customerInvitations)
      .where(eq(customerInvitations.customerId, customerId))
      .orderBy(desc(customerInvitations.createdAt))
      .limit(100);
    return { memberships, invitations };
  }
  async revokeInvitation(customerId: string, invitationId: string, actorId: string) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(customerInvitations)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(customerInvitations.id, invitationId),
            eq(customerInvitations.customerId, customerId),
            isNull(customerInvitations.consumedAt),
          ),
        )
        .returning({ id: customerInvitations.id });
      if (!row) fail('INVITATION_NOT_FOUND', 'Pending invitation was not found', 404);
      await this.log(tx, actorId, 'CUSTOMER_INVITATION_REVOKED', row!.id);
    });
  }
  async revokeMembership(customerId: string, membershipId: string, actorId: string) {
    const [contact] = await this.db
      .select({ email: authAccounts.email })
      .from(customerMemberships)
      .innerJoin(authAccounts, eq(authAccounts.id, customerMemberships.accountId))
      .where(
        and(
          eq(customerMemberships.id, membershipId),
          eq(customerMemberships.customerId, customerId),
        ),
      );
    if (!contact) fail('MEMBERSHIP_NOT_FOUND', 'Membership was not found', 404);
    await this.db.transaction(async (tx) => {
      // Use the same per-email lock as activation before touching membership/invitation rows.
      await this.emailLock(tx, contact!.email.toLowerCase());
      const [row] = await tx
        .update(customerMemberships)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(customerMemberships.id, membershipId),
            eq(customerMemberships.customerId, customerId),
          ),
        )
        .returning();
      if (!row) fail('MEMBERSHIP_NOT_FOUND', 'Membership was not found', 404);
      const [account] = await tx
        .select({ email: authAccounts.email })
        .from(authAccounts)
        .where(eq(authAccounts.id, row!.accountId));
      if (account)
        await tx
          .update(customerInvitations)
          .set({ revokedAt: new Date() })
          .where(
            and(
              eq(customerInvitations.customerId, customerId),
              eq(customerInvitations.email, account.email.toLowerCase()),
              isNull(customerInvitations.consumedAt),
              isNull(customerInvitations.revokedAt),
            ),
          );
      await this.log(tx, actorId, 'CUSTOMER_MEMBERSHIP_REVOKED', row!.id);
    });
  }

  async invitationContext(token: string) {
    const [row] = await this.db
      .select()
      .from(customerInvitations)
      .where(eq(customerInvitations.tokenHash, hashToken(token)));
    if (!validInvitation(row))
      fail('INVITATION_INVALID', 'Invitation has expired or is no longer valid', 400);
    const [customer] = await this.db
      .select({ name: customers.name, category: customers.category })
      .from(customers)
      .where(and(eq(customers.id, row!.customerId), eq(customers.status, 'ACTIVE')));
    if (!customer) fail('INVITATION_INVALID', 'Invitation is no longer available', 400);
    const [account] = await this.db
      .select({ id: authAccounts.id })
      .from(authAccounts)
      .where(eq(sql`lower(${authAccounts.email})`, row!.email));
    return {
      email: row!.email,
      displayName: row!.displayName,
      customerName: customer!.name,
      category: customer!.category,
      expiresAt: row!.expiresAt,
      existingUser: !!account,
    };
  }

  async activate(token: string, password: string) {
    const [preview] = await this.db
      .select()
      .from(customerInvitations)
      .where(eq(customerInvitations.tokenHash, hashToken(token)));
    if (!validInvitation(preview))
      fail('INVITATION_INVALID', 'Invitation has expired or is no longer valid', 400);
    // Hash outside the transaction; existing users must prove their identity with their current password.
    const passwordHash = await this.passwords.hash(password);
    return this.db.transaction(async (tx) => {
      await this.emailLock(tx, preview!.email);
      const [invite] = await tx
        .select()
        .from(customerInvitations)
        .where(eq(customerInvitations.id, preview!.id))
        .for('update');
      if (!validInvitation(invite))
        fail('INVITATION_INVALID', 'Invitation has expired or is no longer valid', 400);
      await this.activeCustomer(tx, invite!.customerId);
      let [account] = await tx
        .select()
        .from(authAccounts)
        .where(eq(sql`lower(${authAccounts.email})`, invite!.email))
        .for('update');
      if (account) {
        if (
          account.role !== 'CUSTOMER' ||
          account.status !== 'ACTIVE' ||
          !(await this.passwords.verify(account.passwordHash, password))
        )
          fail(
            'AUTHENTICATION_FAILED',
            'Use the existing customer account password to accept this invitation',
            401,
          );
      } else {
        if (password.length < 12)
          fail('PASSWORD_TOO_SHORT', 'New passwords must contain at least 12 characters', 400);
        [account] = await tx
          .insert(authAccounts)
          .values({
            role: 'CUSTOMER',
            email: invite!.email,
            displayName: invite!.displayName,
            passwordHash,
          })
          .returning();
      }
      const [membership] = await tx
        .insert(customerMemberships)
        .values({
          customerId: invite!.customerId,
          accountId: account!.id,
          grantedBy: invite!.createdBy,
        })
        .onConflictDoUpdate({
          target: [customerMemberships.customerId, customerMemberships.accountId],
          set: { revokedAt: null, grantedBy: invite!.createdBy, createdAt: new Date() },
        })
        .returning({ id: customerMemberships.id });
      await tx
        .update(customerInvitations)
        .set({ consumedAt: new Date() })
        .where(eq(customerInvitations.id, invite!.id));
      await this.log(tx, account!.id, 'CUSTOMER_INVITATION_ACCEPTED', membership!.id);
      return { customerId: invite!.customerId };
    });
  }

  async recover(emailValue: string) {
    if (!this.mailEnabled || !this.accountUrl)
      fail('CUSTOMER_RECOVERY_UNAVAILABLE', 'Contact Eastern Risen for account assistance', 503);
    const email = emailValue.trim().toLowerCase();
    await this.db.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(authAccounts)
        .where(
          and(
            eq(sql`lower(${authAccounts.email})`, email),
            eq(authAccounts.role, 'CUSTOMER'),
            eq(authAccounts.status, 'ACTIVE'),
          ),
        )
        .for('update');
      if (!account) return;
      const [recent] = await tx
        .select({ id: customerRecoveryTokens.id })
        .from(customerRecoveryTokens)
        .where(
          and(
            eq(customerRecoveryTokens.accountId, account.id),
            gt(customerRecoveryTokens.createdAt, new Date(Date.now() - 60000)),
          ),
        );
      if (recent) return;
      await tx
        .update(customerRecoveryTokens)
        .set({ consumedAt: new Date() })
        .where(
          and(
            eq(customerRecoveryTokens.accountId, account.id),
            isNull(customerRecoveryTokens.consumedAt),
          ),
        );
      const token = freshToken(),
        expiresAt = new Date(Date.now() + 3600000);
      const [row] = await tx
        .insert(customerRecoveryTokens)
        .values({ accountId: account.id, tokenHash: hashToken(token), expiresAt })
        .returning();
      await this.queue(
        tx,
        'RECOVERY',
        row!.id,
        account.email,
        this.link('reset-password', token)!,
        expiresAt,
      );
    });
  }
  async resetPassword(token: string, password: string) {
    const [preview] = await this.db
      .select()
      .from(customerRecoveryTokens)
      .where(eq(customerRecoveryTokens.tokenHash, hashToken(token)));
    if (!preview) fail('RECOVERY_INVALID', 'Recovery link is invalid or expired', 400);
    const passwordHash = await this.passwords.hash(password);
    await this.db.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.id, preview!.accountId),
            eq(authAccounts.role, 'CUSTOMER'),
            eq(authAccounts.status, 'ACTIVE'),
          ),
        )
        .for('update');
      const [row] = await tx
        .select()
        .from(customerRecoveryTokens)
        .where(eq(customerRecoveryTokens.id, preview!.id))
        .for('update');
      if (!account || !row || row.consumedAt || row.expiresAt <= new Date())
        fail('RECOVERY_INVALID', 'Recovery link is invalid or expired', 400);
      const now = new Date();
      await tx
        .update(authAccounts)
        .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
        .where(eq(authAccounts.id, account!.id));
      await tx
        .update(authSessions)
        .set({ revokedAt: now })
        .where(eq(authSessions.accountId, account!.id));
      await tx
        .update(customerRecoveryTokens)
        .set({ consumedAt: now })
        .where(eq(customerRecoveryTokens.accountId, account!.id));
      await this.log(tx, account!.id, 'CUSTOMER_PASSWORD_RECOVERED', account!.id);
    });
  }

  async changePassword(accountId: string, currentPassword: string, newPassword: string) {
    const passwordHash = await this.passwords.hash(newPassword);
    await this.db.transaction(async (tx) => {
      const [account] = await tx
        .select()
        .from(authAccounts)
        .where(
          and(
            eq(authAccounts.id, accountId),
            eq(authAccounts.role, 'CUSTOMER'),
            eq(authAccounts.status, 'ACTIVE'),
          ),
        )
        .for('update');
      if (!account || !(await this.passwords.verify(account.passwordHash, currentPassword)))
        fail('CURRENT_PASSWORD_INVALID', 'The current password is incorrect', 400);
      if (await this.passwords.verify(account!.passwordHash, newPassword))
        fail(
          'PASSWORD_REUSE_NOT_ALLOWED',
          'The new password must differ from the current password',
          400,
        );
      const now = new Date();
      await tx
        .update(authAccounts)
        .set({ passwordHash, passwordChangedAt: now, updatedAt: now })
        .where(eq(authAccounts.id, accountId));
      await tx
        .update(authSessions)
        .set({ revokedAt: now })
        .where(eq(authSessions.accountId, accountId));
      await tx
        .update(customerRecoveryTokens)
        .set({ consumedAt: now })
        .where(eq(customerRecoveryTokens.accountId, accountId));
      await this.log(tx, accountId, 'CUSTOMER_PASSWORD_CHANGED', accountId);
    });
  }

  async profile(accountId: string) {
    const [row] = await this.db
      .select(publicUser)
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.id, accountId),
          eq(authAccounts.role, 'CUSTOMER'),
          eq(authAccounts.status, 'ACTIVE'),
        ),
      );
    if (!row) fail('CUSTOMER_ACCESS_REQUIRED', 'Customer access is required', 403);
    return row!;
  }
  async updateProfile(accountId: string, displayName: string) {
    await this.db.transaction(async (tx) => {
      await tx
        .update(authAccounts)
        .set({ displayName: displayName.trim(), updatedAt: new Date() })
        .where(
          and(
            eq(authAccounts.id, accountId),
            eq(authAccounts.role, 'CUSTOMER'),
            eq(authAccounts.status, 'ACTIVE'),
          ),
        );
      await this.log(tx, accountId, 'CUSTOMER_PROFILE_UPDATED', accountId);
    });
    return this.profile(accountId);
  }
  async accounts(accountId: string) {
    return this.db
      .select({ customerId: customers.id, name: customers.name, category: customers.category })
      .from(customerMemberships)
      .innerJoin(customers, eq(customers.id, customerMemberships.customerId))
      .where(
        and(
          eq(customerMemberships.accountId, accountId),
          isNull(customerMemberships.revokedAt),
          eq(customers.status, 'ACTIVE'),
        ),
      )
      .orderBy(customers.name, customers.id);
  }
  async authorize(
    accountId: string,
    customerId: string,
    tx: CoreTransaction = this.db,
    lock = false,
  ) {
    const accountQuery = tx
      .select({ id: authAccounts.id })
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.id, accountId),
          eq(authAccounts.role, 'CUSTOMER'),
          eq(authAccounts.status, 'ACTIVE'),
        ),
      );
    const [account] = await (lock ? accountQuery.for('share') : accountQuery);
    const query = tx
      .select({ id: customerMemberships.id })
      .from(customerMemberships)
      .innerJoin(customers, eq(customers.id, customerMemberships.customerId))
      .where(
        and(
          eq(customerMemberships.accountId, accountId),
          eq(customerMemberships.customerId, customerId),
          isNull(customerMemberships.revokedAt),
          eq(customers.status, 'ACTIVE'),
        ),
      );
    const [membership] = await (lock ? query.for('share') : query);
    if (!account || !membership)
      fail('CUSTOMER_RECORD_NOT_FOUND', 'Customer record was not found', 404);
  }
  private async booking(accountId: string, customerId: string, bookingId: string) {
    await this.authorize(accountId, customerId);
    const [row] = await this.db
      .select({ id: commercialBookings.id })
      .from(commercialBookings)
      .where(
        and(
          eq(commercialBookings.id, bookingId),
          eq(commercialBookings.customerId, customerId),
          ne(commercialBookings.status, 'DRAFT'),
        ),
      );
    if (!row) fail('CUSTOMER_RECORD_NOT_FOUND', 'Booking was not found', 404);
  }
  async bookings(accountId: string, customerId: string, page: number, pageSize: number) {
    await this.authorize(accountId, customerId);
    const condition = and(
      eq(commercialBookings.customerId, customerId),
      ne(commercialBookings.status, 'DRAFT'),
    );
    const items = await this.db
      .select({
        id: commercialBookings.id,
        reference: commercialBookings.reference,
        title: commercialBookings.title,
        status: commercialBookings.status,
        serviceStartsOn: commercialBookings.serviceStartsOn,
        serviceEndsOn: commercialBookings.serviceEndsOn,
      })
      .from(commercialBookings)
      .where(condition)
      .orderBy(desc(commercialBookings.createdAt), commercialBookings.id)
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const [total] = await this.db
      .select({ value: count() })
      .from(commercialBookings)
      .where(condition);
    return { items, total: total!.value };
  }
  async bookingDetail(accountId: string, customerId: string, bookingId: string) {
    await this.booking(accountId, customerId, bookingId);
    return this.core.commercial.customerDetail(bookingId);
  }
  async accept(accountId: string, customerId: string, bookingId: string, quoteVersion: number) {
    await this.booking(accountId, customerId, bookingId);
    return this.core.commercial.acceptForBooking(
      bookingId,
      accountId,
      (tx, booking) => this.authorize(accountId, booking.customerId, tx, true),
      quoteVersion,
    );
  }
  async checkout(accountId: string, customerId: string, bookingId: string, milestoneId: string) {
    await this.booking(accountId, customerId, bookingId);
    return this.core.commercial.checkoutForBooking(
      bookingId,
      accountId,
      (tx, booking) => this.authorize(accountId, booking.customerId, tx, true),
      milestoneId,
    );
  }
  async reconcile(accountId: string, customerId: string, bookingId: string, orderId: string) {
    await this.booking(accountId, customerId, bookingId);
    const [order] = await this.db
      .select({ id: paymentOrders.id })
      .from(paymentOrders)
      .innerJoin(paymentMilestones, eq(paymentMilestones.id, paymentOrders.milestoneId))
      .where(
        and(eq(paymentOrders.providerOrderId, orderId), eq(paymentMilestones.bookingId, bookingId)),
      );
    if (!order) fail('CUSTOMER_RECORD_NOT_FOUND', 'Payment order was not found', 404);
    // Reconciliation verifies money already received; it does not expose provider or staff records.
    const result = await this.core.commercial.reconcile(orderId);
    return {
      orderId,
      status: result.status,
      orderStatus: result.orderStatus,
      latestAttemptStatus: result.latestAttemptStatus,
      accountingStatus: result.accountingStatus,
      hasUnresolvedAttempts: result.hasUnresolvedAttempts,
      canRetry: result.canRetry,
      lastCheckedAt: result.lastCheckedAt,
    };
  }
  async billing(accountId: string, customerId: string, page: number, pageSize: number) {
    await this.authorize(accountId, customerId);
    const condition = and(
      eq(invoices.customerId, customerId),
      inArray(invoices.status, ['ISSUED', 'CANCELLED']),
    );
    const rows = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(condition)
      .orderBy(desc(invoices.invoiceDate), invoices.id)
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const items = await Promise.all(rows.map((row) => this.invoice(accountId, customerId, row.id)));
    const [total] = await this.db.select({ value: count() }).from(invoices).where(condition);
    return { items, total: total!.value };
  }
  async invoice(accountId: string, customerId: string, invoiceId: string) {
    await this.authorize(accountId, customerId);
    const [row] = await this.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.id, invoiceId),
          eq(invoices.customerId, customerId),
          ne(invoices.status, 'DRAFT'),
        ),
      );
    if (!row) fail('CUSTOMER_RECORD_NOT_FOUND', 'Invoice was not found', 404);
    const item = await this.core.billing.get(invoiceId);
    return {
      id: item.id,
      number: item.invoiceNumber,
      financialYear: item.financialYear,
      date: item.invoiceDate,
      status: item.status,
      total: item.grandTotal,
      received: item.receivedAmount,
      adjusted: item.adjustmentAmount,
      due: item.dueAmount,
      paymentStatus: item.paymentStatus,
      subtotal: item.subtotal,
      taxTotal: item.taxTotal,
      dueDate: item.dueDate,
      company: party(item.snapshot?.company),
      customer: party(item.snapshot?.customer),
      paymentInstructions: text(item.snapshot?.company.paymentInstructions),
      footerNotes: text(item.snapshot?.company.footerNotes),
      bankAccounts: (item.snapshot?.bankAccounts ?? []).map((bank) => ({
        name: bank.name,
        bankName: bank.bankName,
        accountNumber: bank.accountNumber,
        branch: bank.branch,
        ifscCode: bank.ifscCode,
        swiftCode: text(bank.swiftCode),
      })),
      lines: item.lines.map((line) => ({
        position: line.position,
        description: line.description,
        amount: line.amount,
        taxTreatment: line.taxTreatment,
        taxAmount: line.taxAmount,
        total: line.total,
        taxes: line.appliedTaxes.map((tax) => ({
          component: tax.component,
          rate: tax.rate,
          amount: tax.amount,
        })),
      })),
      guestDisplayText: item.details.guestDisplayText,
      label: item.details.label ?? null,
      payments: item.receipts
        .filter((r) => r.status === 'CONFIRMED')
        .map((r) => ({
          number: r.receiptNumber,
          date: r.receivedDate,
          amount: r.amount,
          method: r.method,
        })),
    };
  }
}
