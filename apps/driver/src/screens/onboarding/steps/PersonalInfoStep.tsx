import { resolveMediaUrl, useAuth } from '@yatri/mobile-auth';
import type { DriverDetails } from '@yatri/types';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useTheme } from '../../../theme/useTheme';
import { FormField } from '../FormField';
import { WizardShell } from '../WizardShell';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const PHONE_E164 = /^\+[1-9]\d{6,14}$/;

export interface PersonalInfoValues {
  fullLegalName: string;
  dateOfBirth: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
}

export function detailsToPersonalInfoValues(details: DriverDetails): PersonalInfoValues {
  return {
    fullLegalName: details.fullLegalName ?? '',
    dateOfBirth: details.dateOfBirth ?? '',
    addressLine1: details.addressLine1 ?? '',
    addressLine2: details.addressLine2 ?? '',
    city: details.city ?? '',
    emergencyContactName: details.emergencyContactName ?? '',
    emergencyContactPhone: details.emergencyContactPhone ?? '',
  };
}

interface Props {
  initialValues: PersonalInfoValues;
  onContinue: (values: PersonalInfoValues, patch: Record<string, string | null>) => Promise<void>;
}

export function PersonalInfoStep({ initialValues, onContinue }: Props) {
  const theme = useTheme();
  const { user, uploadProfilePicture } = useAuth();
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<Partial<Record<keyof PersonalInfoValues, string>>>({});
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [uploadingPicture, setUploadingPicture] = useState(false);
  const [pictureError, setPictureError] = useState<string | undefined>(undefined);

  async function handleChangePicture() {
    setPictureError(undefined);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      const message = 'Photo library access is needed to set a profile picture.';
      setPictureError(message);
      AccessibilityInfo.announceForAccessibility(message);
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    if (!asset) return;

    setUploadingPicture(true);
    try {
      await uploadProfilePicture({
        uri: asset.uri,
        name: asset.fileName ?? `profile-${Date.now()}.jpg`,
        type: asset.mimeType ?? 'image/jpeg',
      });
      AccessibilityInfo.announceForAccessibility('Profile picture updated.');
    } catch {
      const message = 'Could not upload your profile picture. Please try a different photo.';
      setPictureError(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setUploadingPicture(false);
    }
  }

  function set<K extends keyof PersonalInfoValues>(key: K, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): boolean {
    const next: Partial<Record<keyof PersonalInfoValues, string>> = {};
    if (values.fullLegalName.trim().length === 0)
      next.fullLegalName = 'Enter your full legal name.';
    if (!ISO_DATE.test(values.dateOfBirth) || Number.isNaN(Date.parse(values.dateOfBirth))) {
      next.dateOfBirth = 'Enter a valid date as YYYY-MM-DD.';
    } else if (new Date(values.dateOfBirth) >= new Date()) {
      next.dateOfBirth = 'Date of birth must be in the past.';
    }
    if (values.addressLine1.trim().length === 0) next.addressLine1 = 'Enter your address.';
    if (values.city.trim().length === 0) next.city = 'Enter your city.';
    if (
      values.emergencyContactPhone.trim().length > 0 &&
      !PHONE_E164.test(values.emergencyContactPhone.trim())
    ) {
      next.emergencyContactPhone = 'Use international format, e.g. +9779800000000.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) {
      AccessibilityInfo.announceForAccessibility('Please fix the highlighted fields.');
    }
    return Object.keys(next).length === 0;
  }

  async function handleContinue() {
    if (!validate()) return;
    setSaving(true);
    setSubmitError(undefined);
    try {
      await onContinue(values, {
        fullLegalName: values.fullLegalName.trim(),
        dateOfBirth: values.dateOfBirth.trim(),
        addressLine1: values.addressLine1.trim(),
        addressLine2: values.addressLine2.trim() || null,
        city: values.city.trim(),
        emergencyContactName: values.emergencyContactName.trim() || null,
        emergencyContactPhone: values.emergencyContactPhone.trim() || null,
      });
    } catch {
      const message = 'Could not save your information. Please try again.';
      setSubmitError(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <WizardShell
      stepNumber={1}
      totalSteps={5}
      title="Personal information"
      subtitle="This is used to verify your identity. We only ask for what's required."
      onContinue={() => {
        void handleContinue();
      }}
      continueBusy={saving}
      errorMessage={submitError}
    >
      <View style={styles.avatarSection}>
        <Pressable
          onPress={() => {
            void handleChangePicture();
          }}
          disabled={uploadingPicture}
          accessibilityRole="button"
          accessibilityLabel="Change profile picture"
          accessibilityHint="Opens your photo library to choose a picture"
          accessibilityState={{ busy: uploadingPicture, disabled: uploadingPicture }}
          style={styles.avatarPressable}
        >
          {user?.profilePictureUrl ? (
            <Image
              source={{ uri: resolveMediaUrl(user.profilePictureUrl) ?? undefined }}
              style={[styles.avatarImage, { borderColor: theme.colors.border }]}
              accessible={false}
            />
          ) : (
            <View
              style={[
                styles.avatarImage,
                styles.avatarPlaceholder,
                { backgroundColor: theme.colors.surface, borderColor: theme.colors.border },
              ]}
            >
              <Text style={{ color: theme.colors.textSecondary, fontSize: 13 }}>No photo</Text>
            </View>
          )}
          {uploadingPicture ? (
            <View style={styles.avatarOverlay}>
              <ActivityIndicator color={theme.colors.textInverse} />
            </View>
          ) : null}
        </Pressable>
        <Text style={[styles.changePhotoLabel, { color: theme.colors.secondary }]}>
          {uploadingPicture ? 'Uploading…' : 'Change profile picture'}
        </Text>
        {pictureError ? (
          <Text style={{ color: theme.colors.error, fontSize: 13 }} accessibilityRole="alert">
            {pictureError}
          </Text>
        ) : null}
      </View>

      <FormField
        label="Full legal name"
        required
        value={values.fullLegalName}
        onChangeText={(v) => set('fullLegalName', v)}
        errorMessage={errors.fullLegalName}
        autoComplete="name"
        textContentType="name"
        autoCapitalize="words"
        placeholder="As shown on your ID"
      />
      <FormField
        label="Date of birth"
        required
        hint="Format: YYYY-MM-DD"
        value={values.dateOfBirth}
        onChangeText={(v) => set('dateOfBirth', v)}
        errorMessage={errors.dateOfBirth}
        placeholder="1995-06-15"
        keyboardType="numbers-and-punctuation"
      />
      <FormField
        label="Address"
        required
        value={values.addressLine1}
        onChangeText={(v) => set('addressLine1', v)}
        errorMessage={errors.addressLine1}
        autoComplete="street-address"
        placeholder="Street address"
      />
      <FormField
        label="Address line 2"
        value={values.addressLine2}
        onChangeText={(v) => set('addressLine2', v)}
        placeholder="Apartment, area (optional)"
      />
      <FormField
        label="City"
        required
        value={values.city}
        onChangeText={(v) => set('city', v)}
        errorMessage={errors.city}
        placeholder="e.g. Kathmandu"
      />
      <FormField
        label="Emergency contact name"
        value={values.emergencyContactName}
        onChangeText={(v) => set('emergencyContactName', v)}
        placeholder="Optional"
        autoCapitalize="words"
      />
      <FormField
        label="Emergency contact phone"
        hint="International format, e.g. +9779800000000"
        value={values.emergencyContactPhone}
        onChangeText={(v) => set('emergencyContactPhone', v)}
        errorMessage={errors.emergencyContactPhone}
        placeholder="Optional"
        keyboardType="phone-pad"
      />
    </WizardShell>
  );
}

const styles = StyleSheet.create({
  avatarSection: { alignItems: 'center', gap: 8 },
  avatarPressable: { position: 'relative' },
  avatarImage: { width: 88, height: 88, borderRadius: 44, borderWidth: 1 },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  avatarOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 44,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  changePhotoLabel: { fontSize: 14, fontWeight: '600' },
});
