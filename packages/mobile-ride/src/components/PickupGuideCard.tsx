import type { LiveTripSnapshot, TripCounterpart } from '@yatri/types';

import { pickupGuide } from '../accessibilityText';
import { Card, Fact, type UiProps } from './RideUi';

/**
 * Where to meet, as text: the pickup address and landmark, which way the driver is from it, how far and how long, and the
 * vehicle to look for. For anyone who does not use the map (a blind or low-vision passenger above all). Every figure is
 * the server's snapshot; the map is never needed to find the driver.
 */
export function PickupGuideCard(
  props: UiProps & { snapshot: LiveTripSnapshot; vehicle: TripCounterpart['vehicle'] },
) {
  const { snapshot, vehicle, colors, minTouchTarget } = props;
  const ui = { colors, minTouchTarget };
  if (snapshot.status !== 'DRIVER_EN_ROUTE' && snapshot.status !== 'DRIVER_ARRIVED') return null;
  return (
    <Card {...ui} title="Finding your driver, in words">
      {pickupGuide(snapshot, vehicle).map((r) => (
        <Fact key={r.label} {...ui} label={r.label} value={r.value} />
      ))}
    </Card>
  );
}
