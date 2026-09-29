import type { DriverDetails, Vehicle } from '@yatri/types';
import { useState } from 'react';
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native';

import { useTheme } from '../../../theme/useTheme';
import { WizardShell } from '../WizardShell';

interface Props {
  details: DriverDetails;
  vehicle: Vehicle | null;
  documentCount: number;
  missingRequirements: string[];
  rejectionReason: string | null;
  onBack: () => void;
  onSubmit: () => Promise<void>;
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.summaryRow}>
      <Text style={[styles.summaryLabel, { color: theme.colors.textSecondary }]}>{label}</Text>
      <Text style={[styles.summaryValue, { color: theme.colors.textPrimary }]}>{value}</Text>
    </View>
  );
}

export function ReviewStep({
  details,
  vehicle,
  documentCount,
  missingRequirements,
  rejectionReason,
  onBack,
  onSubmit,
}: Props) {
  const theme = useTheme();
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const canSubmit = missingRequirements.length === 0;

  async function handleSubmit() {
    if (!canSubmit) {
      AccessibilityInfo.announceForAccessibility('Complete every step before submitting.');
      return;
    }
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      await onSubmit();
    } catch {
      const message = 'Could not submit your application. Please try again.';
      setSubmitError(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <WizardShell
      stepNumber={5}
      totalSteps={5}
      title="Review and submit"
      subtitle="Check your details, then submit for admin review."
      onBack={onBack}
      onContinue={() => {
        void handleSubmit();
      }}
      continueLabel="Submit for verification"
      continueDisabled={!canSubmit}
      continueBusy={submitting}
      errorMessage={submitError}
    >
      {rejectionReason ? (
        <View
          style={[
            styles.banner,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.error },
          ]}
          accessible
          accessibilityRole="alert"
        >
          <Text style={[styles.bannerTitle, { color: theme.colors.error }]}>
            Previous submission rejected
          </Text>
          <Text style={{ color: theme.colors.textPrimary }}>{rejectionReason}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <Text
          style={[styles.sectionTitle, { color: theme.colors.textPrimary }]}
          accessibilityRole="header"
        >
          Personal information
        </Text>
        <SummaryRow label="Full legal name" value={details.fullLegalName ?? '—'} />
        <SummaryRow label="Date of birth" value={details.dateOfBirth ?? '—'} />
        <SummaryRow
          label="Address"
          value={
            [details.addressLine1, details.addressLine2, details.city].filter(Boolean).join(', ') ||
            '—'
          }
        />
      </View>

      <View style={styles.section}>
        <Text
          style={[styles.sectionTitle, { color: theme.colors.textPrimary }]}
          accessibilityRole="header"
        >
          Driver information
        </Text>
        <SummaryRow label="Licence number" value={details.licenseNumber ?? '—'} />
        <SummaryRow label="Licence expiry" value={details.licenseExpiryDate ?? '—'} />
      </View>

      <View style={styles.section}>
        <Text
          style={[styles.sectionTitle, { color: theme.colors.textPrimary }]}
          accessibilityRole="header"
        >
          Vehicle
        </Text>
        {vehicle ? (
          <>
            <SummaryRow
              label="Vehicle"
              value={`${vehicle.year} ${vehicle.make} ${vehicle.model}`}
            />
            <SummaryRow label="Registration number" value={vehicle.registrationNumber} />
          </>
        ) : (
          <SummaryRow label="Vehicle" value="Not added" />
        )}
      </View>

      <View style={styles.section}>
        <Text
          style={[styles.sectionTitle, { color: theme.colors.textPrimary }]}
          accessibilityRole="header"
        >
          Documents
        </Text>
        <SummaryRow
          label="Uploaded"
          value={`${documentCount} document${documentCount === 1 ? '' : 's'}`}
        />
      </View>

      {missingRequirements.length > 0 ? (
        <View
          style={[
            styles.banner,
            { backgroundColor: theme.colors.surface, borderColor: theme.colors.warning },
          ]}
          accessible
          accessibilityRole="summary"
          accessibilityLabel={`Still needed before you can submit: ${missingRequirements.join('. ')}`}
        >
          <Text style={[styles.bannerTitle, { color: theme.colors.warning }]}>Still needed</Text>
          {missingRequirements.map((item) => (
            <Text key={item} style={{ color: theme.colors.textPrimary }}>
              • {item}
            </Text>
          ))}
        </View>
      ) : null}
    </WizardShell>
  );
}

const styles = StyleSheet.create({
  section: { gap: 4 },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginBottom: 4 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12 },
  summaryLabel: { fontSize: 14, flexShrink: 0 },
  summaryValue: { fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  banner: { borderWidth: 1, borderRadius: 12, padding: 12, gap: 4 },
  bannerTitle: { fontSize: 14, fontWeight: '700' },
});
