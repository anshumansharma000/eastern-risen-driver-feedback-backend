import type {
  CatalogPage,
  CatalogVendor,
  CatalogVehicle,
  VendorInput,
  VehicleInput,
  CatalogStatus,
} from './catalog.contracts.js';
/** These are the only core-to-shared business dependencies. Replace adapters when extracting core. */
export interface SharedCatalog {
  requireVendor(id: string): Promise<void>;
  requireVehicle(id: string): Promise<void>;
  getVendor(id: string): Promise<CatalogVendor>;
  getVehicle(id: string): Promise<CatalogVehicle>;
  listVendors(page: number, pageSize: number): Promise<CatalogPage<CatalogVendor>>;
  createVendor(input: VendorInput, actorId: string): Promise<CatalogVendor>;
  updateVendor(id: string, input: VendorInput, actorId: string): Promise<CatalogVendor>;
  setVendorStatus(id: string, status: CatalogStatus, actorId: string): Promise<CatalogVendor>;
  listVehicles(page: number, pageSize: number): Promise<CatalogPage<CatalogVehicle>>;
  createVehicle(input: VehicleInput, actorId: string): Promise<CatalogVehicle>;
  updateVehicle(id: string, input: VehicleInput, actorId: string): Promise<CatalogVehicle>;
  setVehicleStatus(id: string, status: CatalogStatus, actorId: string): Promise<CatalogVehicle>;
}
export type CoreRole = 'CORE_ADMIN' | 'CORE_REPORT_VIEWER' | 'CORE_DATA_ENTRY';
export interface CoreUserInput {
  username: string;
  email: string;
  displayName: string;
  password: string;
  role: CoreRole;
}
export interface CoreUser {
  id: string;
  username: string | null;
  email: string;
  displayName: string;
  role: CoreRole;
  status: 'ACTIVE' | 'DEACTIVATED' | 'ARCHIVED';
}
export interface CoreIdentity {
  updateProfile(
    id: string,
    input: Pick<CoreUserInput, 'username' | 'email' | 'displayName'>,
    actorId: string,
  ): Promise<CoreUser>;
  createUser(input: CoreUserInput, actorId: string): Promise<CoreUser>;
  listUsers(page: number, pageSize: number): Promise<{ items: CoreUser[]; total: number }>;
  updateUser(
    id: string,
    input: { role: CoreRole; status: CoreUser['status'] },
    actorId: string,
  ): Promise<CoreUser>;
  resetPassword(id: string, password: string, actorId: string): Promise<void>;
}
