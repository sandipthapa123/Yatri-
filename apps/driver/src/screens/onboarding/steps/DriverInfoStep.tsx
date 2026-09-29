import { useState } from 'react';
import { AccessibilityInfo } from 'react-native';

import { FormField } from '../FormField';
import { WizardShell } from '../WizardShell';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface DriverInfoValues {
  licenseNumber: string;
  licenseExpiryDate: string;
}

interface Props {
  initialValues: DriverInfoValues;
  onBack: () => void;
  onContinue: (values: DriverInfoValues, patch: Record<string, string>) => Promise<void>;
}

export function DriverInfoStep({ initialValues, onBack, onContinue }: Props) {
  const [values, setValues] = useState(initialValues);
  const [errors, setErrors] = useState<Partial<Record<keyof DriverInfoValues, string>>>({});
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  function set<K extends keyof DriverInfoValues>(key: K, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function validate(): boolean {
    const next: Partial<Record<keyof DriverInfoValues, string>> = {};
    if (values.licenseNumber.trim().length === 0) {
      next.licenseNumber = 'Enter your driving licence number.';
    }
    if (
      !ISO_DATE.test(values.licenseExpiryDate) ||
      Number.isNaN(Date.parse(values.licenseExpiryDate))
    ) {
      next.licenseExpiryDate = 'Enter a valid date as YYYY-MM-DD.';
    } else if (new Date(values.licenseExpiryDate) <= new Date()) {
      next.licenseExpiryDate = 'Licence expiry date must be in the future.';
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
        licenseNumber: values.licenseNumber.trim(),
        licenseExpiryDate: values.licenseExpiryDate.trim(),
      });
    } catch {
      const message = 'Could not save your licence details. Please try again.';
      setSubmitError(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <WizardShell
      stepNumber={2}
      totalSteps={5}
      title="Driver information"
      subtitle="Your driving licence details, kept separate from your public profile."
      onBack={onBack}
      onContinue={() => {
        void handleContinue();
      }}
      continueBusy={saving}
      errorMessage={submitError}
    >
      <FormField
        label="Driving licence number"
        required
        value={values.licenseNumber}
        onChangeText={(v) => set('licenseNumber', v)}
        errorMessage={errors.licenseNumber}
        autoCapitalize="characters"
        placeholder="e.g. 03-123456"
      />
      <FormField
        label="Licence expiry date"
        required
        hint="Format: YYYY-MM-DD"
        value={values.licenseExpiryDate}
        onChangeText={(v) => set('licenseExpiryDate', v)}
        errorMessage={errors.licenseExpiryDate}
        placeholder="2028-01-01"
        keyboardType="numbers-and-punctuation"
      />
    </WizardShell>
  );
}
