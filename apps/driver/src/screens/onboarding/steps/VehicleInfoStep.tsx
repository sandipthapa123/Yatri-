import type { Vehicle, VehicleCategory } from '@yatri/types';
import { useState } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '@yatri/mobile-ui';
import { FormField } from '../FormField';
import { WizardShell } from '../WizardShell';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REGISTRATION = /^[A-Za-z0-9 -]+$/;
const CURRENT_YEAR = new Date().getUTCFullYear();

export interface VehicleFormValues {
  categoryId: string;
  make: string;
  model: string;
  year: string;
  color: string;
  registrationNumber: string;
  vin: string;
  registrationExpiryDate: string;
  insuranceProvider: string;
  insurancePolicyNumber: string;
  insuranceExpiryDate: string;
}

export function vehicleToFormValues(vehicle: Vehicle): VehicleFormValues {
  return {
    categoryId: vehicle.categoryId,
    make: vehicle.make,
    model: vehicle.model,
    year: String(vehicle.year),
    color: vehicle.color,
    registrationNumber: vehicle.registrationNumber,
    vin: vehicle.vin ?? '',
    registrationExpiryDate: vehicle.registrationExpiryDate ?? '',
    insuranceProvider: vehicle.insuranceProvider ?? '',
    insurancePolicyNumber: vehicle.insurancePolicyNumber ?? '',
    insuranceExpiryDate: vehicle.insuranceExpiryDate ?? '',
  };
}

const EMPTY_VALUES: VehicleFormValues = {
  categoryId: '',
  make: '',
  model: '',
  year: '',
  color: '',
  registrationNumber: '',
  vin: '',
  registrationExpiryDate: '',
  insuranceProvider: '',
  insurancePolicyNumber: '',
  insuranceExpiryDate: '',
};

interface Props {
  categories: VehicleCategory[];
  initialValues?: VehicleFormValues;
  /** Present once the driver already has a vehicle on file — locks the category and edits in place. */
  isEditingExisting: boolean;
  onBack: () => void;
  onContinue: (values: VehicleFormValues) => Promise<void>;
}

export function VehicleInfoStep({
  categories,
  initialValues,
  isEditingExisting,
  onBack,
  onContinue,
}: Props) {
  const theme = useTheme();
  const [values, setValues] = useState<VehicleFormValues>(initialValues ?? EMPTY_VALUES);
  const [errors, setErrors] = useState<Partial<Record<keyof VehicleFormValues, string>>>({});
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof VehicleFormValues>(key: K, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): boolean {
    const next: Partial<Record<keyof VehicleFormValues, string>> = {};
    if (!values.categoryId) next.categoryId = 'Select a vehicle type.';
    if (values.make.trim().length === 0) next.make = 'Enter the make.';
    if (values.model.trim().length === 0) next.model = 'Enter the model.';
    const yearNum = Number(values.year);
    if (!Number.isInteger(yearNum) || yearNum < 1970 || yearNum > CURRENT_YEAR + 1) {
      next.year = `Enter a year between 1970 and ${CURRENT_YEAR + 1}.`;
    }
    if (values.color.trim().length === 0) next.color = 'Enter the colour.';
    const reg = values.registrationNumber.trim();
    if (reg.length < 3 || reg.length > 20 || !REGISTRATION.test(reg)) {
      next.registrationNumber = 'Enter a valid registration number.';
    }
    if (
      values.registrationExpiryDate.trim() &&
      !ISO_DATE.test(values.registrationExpiryDate.trim())
    ) {
      next.registrationExpiryDate = 'Use format YYYY-MM-DD.';
    }
    if (values.insuranceExpiryDate.trim() && !ISO_DATE.test(values.insuranceExpiryDate.trim())) {
      next.insuranceExpiryDate = 'Use format YYYY-MM-DD.';
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
      await onContinue(values);
    } catch {
      const message = 'Could not save your vehicle. Please check your details and try again.';
      setSubmitError(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <WizardShell
      stepNumber={3}
      totalSteps={5}
      title="Vehicle information"
      subtitle="Add the vehicle you'll use to accept rides."
      onBack={onBack}
      onContinue={() => {
        void handleContinue();
      }}
      continueBusy={saving}
      errorMessage={submitError}
    >
      <View style={styles.field}>
        <Text style={[styles.label, { color: theme.colors.textPrimary }]}>Vehicle type *</Text>
        {isEditingExisting ? (
          <Text style={[styles.lockedValue, { color: theme.colors.textSecondary }]}>
            {categories.find((c) => c.id === values.categoryId)?.label ?? 'Vehicle type'}
            {' — cannot be changed after adding a vehicle.'}
          </Text>
        ) : (
          <View style={styles.categoryRow} accessibilityRole="radiogroup">
            {categories.map((category) => {
              const selected = values.categoryId === category.id;
              return (
                <Pressable
                  key={category.id}
                  onPress={() => set('categoryId', category.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={category.label}
                  style={[
                    styles.categoryChip,
                    {
                      minHeight: theme.minTouchTarget,
                      borderColor: selected ? theme.colors.secondary : theme.colors.border,
                      backgroundColor: selected ? theme.colors.secondary : theme.colors.surface,
                    },
                  ]}
                >
                  <Text
                    style={{
                      color: selected ? theme.colors.textInverse : theme.colors.textPrimary,
                      fontWeight: '600',
                    }}
                  >
                    {category.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        )}
        {errors.categoryId ? (
          <Text style={[styles.error, { color: theme.colors.error }]} accessibilityRole="alert">
            {errors.categoryId}
          </Text>
        ) : null}
      </View>

      <FormField
        label="Make"
        required
        value={values.make}
        onChangeText={(v) => set('make', v)}
        errorMessage={errors.make}
        placeholder="e.g. Honda"
      />
      <FormField
        label="Model"
        required
        value={values.model}
        onChangeText={(v) => set('model', v)}
        errorMessage={errors.model}
        placeholder="e.g. CB Shine"
      />
      <FormField
        label="Year"
        required
        value={values.year}
        onChangeText={(v) => set('year', v.replace(/\D/g, '').slice(0, 4))}
        errorMessage={errors.year}
        placeholder="e.g. 2020"
        keyboardType="number-pad"
      />
      <FormField
        label="Colour"
        required
        value={values.color}
        onChangeText={(v) => set('color', v)}
        errorMessage={errors.color}
        placeholder="e.g. Red"
      />
      <FormField
        label="Registration number"
        required
        value={values.registrationNumber}
        onChangeText={(v) => set('registrationNumber', v)}
        errorMessage={errors.registrationNumber}
        autoCapitalize="characters"
        placeholder="e.g. BA 12 PA 3456"
      />
      <FormField
        label="VIN"
        value={values.vin}
        onChangeText={(v) => set('vin', v)}
        placeholder="Optional"
        autoCapitalize="characters"
      />
      <FormField
        label="Registration expiry date"
        hint="Format: YYYY-MM-DD"
        value={values.registrationExpiryDate}
        onChangeText={(v) => set('registrationExpiryDate', v)}
        errorMessage={errors.registrationExpiryDate}
        placeholder="Optional"
      />
      <FormField
        label="Insurance provider"
        value={values.insuranceProvider}
        onChangeText={(v) => set('insuranceProvider', v)}
        placeholder="Optional"
      />
      <FormField
        label="Insurance policy number"
        value={values.insurancePolicyNumber}
        onChangeText={(v) => set('insurancePolicyNumber', v)}
        placeholder="Optional"
      />
      <FormField
        label="Insurance expiry date"
        hint="Format: YYYY-MM-DD"
        value={values.insuranceExpiryDate}
        onChangeText={(v) => set('insuranceExpiryDate', v)}
        errorMessage={errors.insuranceExpiryDate}
        placeholder="Optional"
      />
    </WizardShell>
  );
}

const styles = StyleSheet.create({
  field: { gap: 8 },
  label: { fontSize: 15, fontWeight: '600' },
  lockedValue: { fontSize: 15 },
  categoryRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },
  error: { fontSize: 13 },
});
