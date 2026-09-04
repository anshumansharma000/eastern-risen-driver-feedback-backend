import { describe, expect, it } from 'vitest';
import { deriveEngagementGroups } from './trip.service.js';

describe('deriveEngagementGroups', () => {
  it('groups only consecutive trips by the same driver', () => {
    const trips = [
      { id: 'a1', driverId: 'A' },
      { id: 'a2', driverId: 'A' },
      { id: 'b1', driverId: 'B' },
      { id: 'b2', driverId: 'B' },
      { id: 'a3', driverId: 'A' },
    ];

    expect(deriveEngagementGroups(trips).map((group) => group.map((trip) => trip.id))).toEqual([
      ['a1', 'a2'],
      ['b1', 'b2'],
      ['a3'],
    ]);
  });

  it('handles empty and single-driver schedules', () => {
    expect(deriveEngagementGroups([])).toEqual([]);
    expect(
      deriveEngagementGroups([
        { id: 'a1', driverId: 'A' },
        { id: 'a2', driverId: 'A' },
      ]).map((group) => group.map((trip) => trip.id)),
    ).toEqual([['a1', 'a2']]);
  });
});
