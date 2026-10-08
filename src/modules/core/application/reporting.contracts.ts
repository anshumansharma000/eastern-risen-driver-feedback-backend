export type CustomerCategory = 'AGENT' | 'LEISURE' | 'CORPORATE';
export type InvoiceStatus = 'DRAFT' | 'ISSUED' | 'CANCELLED';
export type SortOrder = 'asc' | 'desc';

export interface CommonReportQuery {
  from?: string;
  to?: string;
  companyId?: string;
  customerId?: string;
  customerCategory?: CustomerCategory;
  serviceCategoryId?: string;
  vehicleId?: string;
  q?: string;
  sortOrder?: SortOrder;
  page?: number;
  pageSize?: number;
}

export interface InvoiceReportQuery extends CommonReportQuery {
  status?: InvoiceStatus;
  paymentStatus?: 'NOT_APPLICABLE' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  financialYear?: string;
  hasVehicle?: boolean;
  sortBy?: string;
}
export interface VehicleInvoiceReportQuery extends CommonReportQuery {
  status?: InvoiceStatus;
  includeUnassigned?: boolean;
  sortBy?: string;
}
export interface TaxReportQuery extends CommonReportQuery {
  status?: InvoiceStatus;
  component?: 'IGST' | 'CGST' | 'SGST' | 'SERVICE_TAX';
  rate?: string;
  sortBy?: string;
}
export interface PaymentReportQuery extends CommonReportQuery {
  status?: 'PENDING' | 'CONFIRMED' | 'REVERSED';
  method?: 'CASH' | 'CHEQUE' | 'DD' | 'CARD' | 'UPI' | 'GATEWAY';
  sortBy?: string;
}
export interface UnifiedPaymentReportQuery extends Omit<CommonReportQuery, 'vehicleId'> {
  source?: 'MANUAL' | 'GATEWAY';
  needsReview?: boolean;
  receiptStatus?: 'PENDING' | 'CONFIRMED' | 'REVERSED';
  gatewayStatus?:
    'CREATING' | 'READY' | 'PAID' | 'EXPIRED' | 'TERMINATED' | 'REVIEW_REQUIRED' | 'REFUNDED';
  method?: PaymentReportQuery['method'];
  sortBy?: string;
}
export interface ReceivablesReportQuery extends CommonReportQuery {
  paymentStatus?: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  ageingBucket?: 'NOT_DUE' | '1_30' | '31_60' | '61_90' | '90_PLUS' | 'NO_DUE_DATE';
  overdueOnly?: boolean;
  dueFrom?: string;
  dueTo?: string;
  sortBy?: string;
}
export interface DiscountReportQuery extends CommonReportQuery {
  status?: 'ACTIVE' | 'REVERSED';
  creatorId?: string;
  sortBy?: string;
}
export interface DashboardQuery {
  from?: string;
  to?: string;
  companyId?: string;
  customerCategory?: CustomerCategory;
  serviceCategoryId?: string;
}
export interface CustomerStatementQuery {
  from?: string;
  to?: string;
  companyId?: string;
  includeSettled?: boolean;
}
export interface AuditReportQuery {
  from?: string;
  to?: string;
  actorId?: string;
  action?: string;
  entityType?: string;
  entityId?: string;
  sortOrder?: SortOrder;
  page?: number;
  pageSize?: number;
}
