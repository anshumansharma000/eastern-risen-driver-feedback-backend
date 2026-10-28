import { describe, expect, it } from 'vitest';
import { nextProgress, validateEventTimes } from './timeline.rules.js';
const start = new Date('2026-10-10T09:00:00Z'),
  end = new Date('2026-10-10T10:00:00Z');
describe('operational timeline rules', () => {
  it('starts on pickup and completes explicitly', () => {
    expect(nextProgress('SCHEDULED', 'PASSENGER_PICKED_UP', start, null, null)).toBe('IN_PROGRESS');
    expect(nextProgress('IN_PROGRESS', 'DROPPED_OFF', end, start, null)).toBe('IN_PROGRESS');
    expect(nextProgress('IN_PROGRESS', 'TRIP_COMPLETED', end, start, null)).toBe('COMPLETED');
  });
  it('allows a late milestone without reversing completion', () => {
    expect(nextProgress('COMPLETED', 'ARRIVED', start, start, end)).toBe('COMPLETED');
    expect(() =>
      nextProgress('COMPLETED', 'ARRIVED', new Date(end.getTime() + 1), start, end),
    ).toThrow();
    expect(() => nextProgress('COMPLETED', 'TRIP_COMPLETED', end, start, end)).toThrow();
  });
  it('rejects completion before start and milestones after cancellation', () => {
    expect(() => nextProgress('IN_PROGRESS', 'TRIP_COMPLETED', start, end, null)).toThrow();
    expect(() => nextProgress('CANCELLED', 'TRIP_STARTED', start, null, null)).toThrow();
    expect(nextProgress('COMPLETED', 'NOTE', end, start, end)).toBe('COMPLETED');
  });
  it('accepts offline receipt times but rejects future, invalid and pre-booking events', () => {
    expect(() =>
      validateEventTimes(start, end, new Date('2026-10-11T10:00:00Z'), start),
    ).not.toThrow();
    expect(() => validateEventTimes(end, start, end, start)).toThrow();
    expect(() => validateEventTimes(start, end, start, start)).toThrow();
    expect(() => validateEventTimes(new Date('2026-10-01T10:00:00Z'), end, end, start)).toThrow();
    expect(() => validateEventTimes(new Date('invalid'), end, end, start)).toThrow();
  });
});
