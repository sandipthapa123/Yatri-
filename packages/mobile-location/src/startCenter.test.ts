import type { PublicCity } from '@yatri/types';
import { describe, expect, it } from 'vitest';

import { startCenterOf } from './startCenter';

const city = (over: Partial<PublicCity>): PublicCity => ({
  id: 'c',
  code: 'C',
  name: 'City',
  provinceName: 'Bagmati',
  status: 'ACTIVE',
  openNow: true,
  hoursText: 'Open all day, every day',
  centerLatitude: 1,
  centerLongitude: 2,
  vehicleCategories: [],
  paymentMethods: [],
  ...over,
});

describe('where a map starts', () => {
  it('uses an open city, else the first city, and nothing when there are none (the country view is used then)', () => {
    expect(startCenterOf(null)).toBeNull();
    expect(startCenterOf({ cities: [] })).toBeNull();
    expect(
      startCenterOf({
        cities: [city({ openNow: false, centerLatitude: 5, centerLongitude: 6 }), city({})],
      }),
    ).toEqual({ latitude: 1, longitude: 2 });
    expect(
      startCenterOf({ cities: [city({ openNow: false, centerLatitude: 5, centerLongitude: 6 })] }),
    ).toEqual({ latitude: 5, longitude: 6 });
  });
});
