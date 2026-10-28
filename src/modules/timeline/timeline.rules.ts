import { AppError } from '../../shared/errors/app-error.js';
import type { MilestoneType, OperationalStatus } from '../../database/schema/timeline.js';

export function timelineError(code: string, message: string, statusCode = 409): never {
  throw new AppError({ code, message, statusCode });
}
export function validateEventTimes(occurredAt: Date, recordedAt: Date, now: Date, startsAt: Date) {
  if (![occurredAt, recordedAt].every((d) => Number.isFinite(d.getTime())))
    timelineError('TIMELINE_TIME_INVALID', 'Valid timestamps are required', 400);
  if (
    occurredAt > recordedAt ||
    recordedAt.getTime() > now.getTime() + 300_000 ||
    occurredAt.getTime() < startsAt.getTime() - 86_400_000
  )
    timelineError(
      'TIMELINE_TIME_INVALID',
      'Event time must be within the booking reporting period and no later than recorded time',
      400,
    );
}
export function nextProgress(
  status: OperationalStatus,
  type: MilestoneType,
  occurredAt: Date,
  startedAt: Date | null,
  completedAt: Date | null,
): OperationalStatus {
  if (type === 'NOTE' || type === 'DELAY' || type === 'CORRECTION') return status;
  if (status === 'CANCELLED')
    timelineError('TRIP_OPERATION_CANCELLED', 'Cancelled trips cannot receive milestones');
  if (status === 'COMPLETED') {
    if (type === 'TRIP_COMPLETED' || !completedAt || occurredAt > completedAt)
      timelineError(
        'TRIP_OPERATION_COMPLETED',
        'This trip is completed; an administrator must reopen it for further progress',
      );
    // A late report enriches history without moving the current status backwards.
    return status;
  }
  if (type === 'TRIP_COMPLETED') {
    if (startedAt && occurredAt < startedAt)
      timelineError(
        'TRIP_COMPLETION_BEFORE_START',
        'Completion cannot precede the recorded trip start',
      );
    return 'COMPLETED';
  }
  if (type === 'TRIP_STARTED' || type === 'PASSENGER_PICKED_UP') return 'IN_PROGRESS';
  return status;
}
