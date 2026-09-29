import type { TripCounterpart, TripRole } from '@yatri/types';
import { resolveMediaUrl } from '@yatri/mobile-auth';
import { useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

import { ratingText } from '../rideText';
import { Card, type UiProps } from './RideUi';

/**
 * Who is on the other end of the ride. The passenger sees the driver (name, photo, vehicle,
 * registration, rating); the driver sees the passenger's name only. Everything is also text:
 * the photo is a supplement with a description, never the only way to know who is coming.
 * No phone numbers exist in this data.
 */
export function CounterpartCard(
  props: UiProps & { counterpart: TripCounterpart; viewer: TripRole },
) {
  const { counterpart, viewer, colors } = props;
  const [photoFailed, setPhotoFailed] = useState(false);
  const isPassenger = viewer === 'PASSENGER';
  const who = isPassenger ? 'Your driver' : 'Your passenger';
  const name = counterpart.name ?? (isPassenger ? 'Driver' : 'Passenger');
  const showPhoto = isPassenger && counterpart.photoUrl && !photoFailed;

  return (
    <Card {...props} title={who}>
      <View style={styles.row}>
        {showPhoto ? (
          <Image
            source={{ uri: resolveMediaUrl(counterpart.photoUrl) ?? undefined }}
            accessible
            accessibilityRole="image"
            accessibilityLabel={`Photo of ${isPassenger ? 'your driver' : 'the passenger'}, ${name}`}
            onError={() => setPhotoFailed(true)}
            style={[styles.photo, { backgroundColor: colors.border }]}
          />
        ) : null}
        <View style={styles.text}>
          <Text
            accessibilityRole="text"
            style={{ color: colors.textPrimary, fontSize: 18, fontWeight: '700' }}
          >
            {name}
          </Text>
          {isPassenger ? (
            <>
              {counterpart.vehicle ? (
                <Text
                  accessible
                  accessibilityLabel={`Vehicle: ${counterpart.vehicle.description}. Registration: ${counterpart.vehicle.registrationNumber}.`}
                  style={{ color: colors.textPrimary }}
                >
                  {counterpart.vehicle.description}
                  {'\n'}Registration {counterpart.vehicle.registrationNumber}
                </Text>
              ) : null}
              <Text style={{ color: colors.textSecondary }}>{ratingText(counterpart.rating)}</Text>
            </>
          ) : null}
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  photo: { width: 64, height: 64, borderRadius: 32 },
  text: { flex: 1, gap: 2 },
});
