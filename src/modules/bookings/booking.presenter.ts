export function presentBooking(booking: {
  id: string;
  bookingReference: string;
  passengerName: string;
  startsAt: Date;
  endsAt: Date;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'ARCHIVED';
  notes: string | null;
  tripCount: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}) {
  return {
    ...booking,
    startsAt: booking.startsAt.toISOString(),
    endsAt: booking.endsAt.toISOString(),
    createdAt: booking.createdAt.toISOString(),
    updatedAt: booking.updatedAt.toISOString(),
    archivedAt: booking.archivedAt?.toISOString() ?? null,
  };
}
