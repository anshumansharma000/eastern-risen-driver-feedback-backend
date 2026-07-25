export interface TripView {
  readonly id: string;
  readonly bookingReference: string;
  readonly passengerName: string;
  readonly pickupLocation: string;
  readonly destination: string;
  readonly scheduledAt: Date;
  readonly scheduledEndAt: Date;
  readonly vehicleId: string;
  readonly vehicleSnapshot: { readonly registrationNumber: string; readonly displayName: string };
  readonly driverId: string;
  readonly driverNameSnapshot: string;
  readonly driverCodeSnapshot: string;
  readonly driverSourceSnapshot: 'AGENCY' | 'OUTSOURCED';
  readonly vendorId: string | null;
  readonly vendorNameSnapshot: string | null;
  readonly creationSource: 'ADMIN_ASSIGNED' | 'DRIVER_ENTERED';
  readonly status: 'READY' | 'FEEDBACK_STARTED' | 'SUBMITTED' | 'ARCHIVED';
  readonly startedFeedbackAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt: Date | null;
}

export function presentTrip(trip: TripView) {
  return {
    id: trip.id,
    bookingReference: trip.bookingReference,
    passengerName: trip.passengerName,
    pickupLocation: trip.pickupLocation,
    destination: trip.destination,
    scheduledAt: trip.scheduledAt.toISOString(),
    scheduledEndAt: trip.scheduledEndAt.toISOString(),
    vehicle: { id: trip.vehicleId, ...trip.vehicleSnapshot },
    driver: {
      id: trip.driverId,
      displayName: trip.driverNameSnapshot,
      driverCode: trip.driverCodeSnapshot,
      sourceType: trip.driverSourceSnapshot,
      vendorId: trip.vendorId,
      vendorName: trip.vendorNameSnapshot,
    },
    creationSource: trip.creationSource,
    status: trip.status,
    startedFeedbackAt: trip.startedFeedbackAt?.toISOString() ?? null,
    createdAt: trip.createdAt.toISOString(),
    updatedAt: trip.updatedAt.toISOString(),
    archivedAt: trip.archivedAt?.toISOString() ?? null,
  };
}
