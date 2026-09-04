import { presentTrip } from '../trips/trip.presenter.js';
import type { EngagementService } from './engagement.service.js';

type Engagement = Awaited<ReturnType<EngagementService['get']>>;

export function presentEngagement(engagement: Engagement) {
  return {
    id: engagement.id,
    booking: {
      id: engagement.bookingId,
      bookingReference: engagement.bookingReference,
      passengerName: engagement.passengerName,
    },
    sequenceNumber: engagement.sequenceNumber,
    driver: {
      id: engagement.driverId,
      displayName: engagement.driverNameSnapshot,
      driverCode: engagement.driverCodeSnapshot,
      sourceType: engagement.driverSourceSnapshot,
      vendorId: engagement.vendorId,
      vendorName: engagement.vendorNameSnapshot,
    },
    feedbackPurposes: [...engagement.feedbackPurposes],
    status: engagement.status,
    startedFeedbackAt: engagement.startedFeedbackAt?.toISOString() ?? null,
    trips: engagement.trips.map(presentTrip),
    createdAt: engagement.createdAt.toISOString(),
    updatedAt: engagement.updatedAt.toISOString(),
    archivedAt: engagement.archivedAt?.toISOString() ?? null,
  };
}
