import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../../database/client.js';
import { vendors } from '../../database/schema/vendors.js';
import type { SharedCatalog } from '../../modules/core/application/ports.js';
import type { VendorService } from '../../modules/vendors/vendor.service.js';
import type { VehicleService } from '../../modules/vehicles/vehicle.service.js';
import { AppError } from '../errors/app-error.js';
function present<T extends { createdAt: Date; updatedAt: Date; archivedAt: Date | null }>(row: T) {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}
/** Local adapter for the shared catalog. Core never queries feedback or catalog tables. */
export function createSharedCatalogAdapter(
  db: AppDatabase,
  vendorService: VendorService,
  vehicleService: VehicleService,
): SharedCatalog {
  const getVendor = async (id: string) => {
    const [vendor] = await db.select().from(vendors).where(eq(vendors.id, id));
    if (!vendor)
      throw new AppError({
        code: 'VENDOR_NOT_FOUND',
        message: 'Vendor was not found',
        statusCode: 404,
      });
    return present(vendor);
  };
  return {
    getVendor,
    getVehicle: async (id) => present(await vehicleService.get(id)),
    async requireVendor(id) {
      await getVendor(id);
    },
    async requireVehicle(id) {
      await vehicleService.get(id);
    },
    async listVendors(page, pageSize, q, status) {
      const result = await vendorService.list({
        page,
        pageSize,
        ...(q === undefined ? {} : { q }),
        ...(status === undefined ? {} : { status }),
      });
      return { ...result, items: result.items.map(present) };
    },
    async createVendor(input, actorId) {
      return present(await vendorService.create(input, actorId));
    },
    async updateVendor(id, input, actorId) {
      return present(
        await vendorService.update(
          id,
          {
            ...input,
            contactName: input.contactName ?? null,
            contactEmail: input.contactEmail ?? null,
            contactPhone: input.contactPhone ?? null,
          },
          actorId,
        ),
      );
    },
    async setVendorStatus(id, status, actorId) {
      return present(await vendorService.changeStatus(id, status, actorId));
    },
    async listVehicles(page, pageSize, q, status) {
      const result = await vehicleService.list({
        page,
        pageSize,
        ...(q === undefined ? {} : { q }),
        ...(status === undefined ? {} : { status }),
      });
      return { ...result, items: result.items.map(present) };
    },
    async createVehicle(input, actorId) {
      return present(await vehicleService.create(input, actorId));
    },
    async updateVehicle(id, input, actorId) {
      return present(await vehicleService.update(id, input, actorId));
    },
    async setVehicleStatus(id, status, actorId) {
      return present(await vehicleService.changeStatus(id, status, actorId));
    },
  };
}
