import type { LineInput } from '../domain/billing.js';
export interface InvoiceInput {
  companyId: string;
  customerId: string;
  guestId?: string | null;
  guestDisplayText: string;
  passengerCount?: number | null;
  serviceCategoryId: string;
  vehicleId?: string | null;
  invoiceDate: string;
  dueDate?: string | null;
  serviceProvidedAt: string;
  placeOfSupplyState: string | null;
  placeOfSupplyCountry: string | null;
  label?: string | null;
  bankAccountIds: string[];
  lines: LineInput[];
}
interface SnapshotParty {
  id: string;
  name: string;
  [key: string]: unknown;
}
export interface InvoiceSnapshot {
  company: SnapshotParty;
  customer: SnapshotParty;
  guest: SnapshotParty | null;
  serviceCategory: SnapshotParty & { code: string };
  vehicle: (SnapshotParty & { registrationNumber: string; vehicleType: string }) | null;
  bankAccounts: Array<
    SnapshotParty & {
      bankName: string | null;
      accountNumber: string;
      branch: string | null;
      ifscCode: string | null;
    }
  >;
  [key: string]: unknown;
}
export type PaymentMethod = 'CASH' | 'CHEQUE' | 'DD' | 'CARD' | 'UPI' | 'GATEWAY';
export interface PaymentDetails {
  reference?: string;
  bankName?: string;
  instrumentDate?: string;
  cardLastFour?: string;
}
export interface ReceiptInput {
  invoiceId: string;
  receivedDate: string;
  amount: string;
  method: PaymentMethod;
  details: PaymentDetails;
  status: 'PENDING' | 'CONFIRMED';
}
export interface AdjustmentInput {
  invoiceId: string;
  amount: string;
  reason: string;
  date: string;
}
