export type CatalogStatus = 'ACTIVE' | 'DEACTIVATED' | 'ARCHIVED';
export interface CatalogVendor {
  id: string;
  name: string;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  status: CatalogStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}
export interface CatalogVehicle {
  id: string;
  registrationNumber: string;
  displayName: string;
  vehicleType: string;
  registeredOwner: string | null;
  address: string | null;
  contactNumber: string | null;
  accountNumber: string | null;
  ifscCode: string | null;
  bankName: string | null;
  status: CatalogStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}
export interface VendorInput {
  name: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
}
export interface VehicleInput {
  registrationNumber: string;
  displayName: string;
  vehicleType: string;
  registeredOwner?: string | null;
  address?: string | null;
  contactNumber?: string | null;
  accountNumber?: string | null;
  ifscCode?: string | null;
  bankName?: string | null;
}
export interface CatalogPage<T> {
  items: T[];
  total: number;
}
