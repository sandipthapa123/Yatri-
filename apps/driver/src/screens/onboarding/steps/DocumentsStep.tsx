import type { DocumentSummary, DocumentTypeRef, Vehicle } from '@yatri/types';
import * as DocumentPicker from 'expo-document-picker';
import { useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useTheme } from '@yatri/mobile-ui';
import { WizardShell } from '../WizardShell';

interface RequiredSlot {
  key: string;
  documentType: DocumentTypeRef;
  vehicleId: string | null;
  label: string;
}

function buildRequiredSlots(
  documentTypes: DocumentTypeRef[],
  vehicle: Vehicle | null,
): RequiredSlot[] {
  const slots: RequiredSlot[] = [];
  for (const t of documentTypes) {
    if (t.ownerType === 'DRIVER' && t.isRequired) {
      slots.push({ key: `driver-${t.id}`, documentType: t, vehicleId: null, label: t.label });
    }
  }
  if (vehicle) {
    for (const t of documentTypes) {
      if (
        t.ownerType === 'VEHICLE' &&
        t.isRequired &&
        (t.vehicleCategoryId === null || t.vehicleCategoryId === vehicle.categoryId)
      ) {
        slots.push({
          key: `vehicle-${t.id}`,
          documentType: t,
          vehicleId: vehicle.id,
          label: `${t.label} (vehicle)`,
        });
      }
    }
  }
  return slots;
}

function findDocument(
  documents: DocumentSummary[],
  documentTypeId: string,
  vehicleId: string | null,
): DocumentSummary | undefined {
  return documents.find((d) => d.documentType.id === documentTypeId && d.vehicleId === vehicleId);
}

function statusText(doc: DocumentSummary | undefined): string {
  if (!doc) return 'Not uploaded';
  switch (doc.status) {
    case 'PENDING':
      return 'Uploaded — pending review';
    case 'APPROVED':
      return 'Approved';
    case 'REJECTED':
      return doc.rejectionReason ? `Rejected: ${doc.rejectionReason}` : 'Rejected';
    case 'EXPIRED':
      return 'Expired — please re-upload';
    default:
      return doc.status;
  }
}

interface Props {
  documentTypes: DocumentTypeRef[];
  vehicle: Vehicle | null;
  documents: DocumentSummary[];
  onUpload: (input: {
    documentTypeCode: string;
    vehicleId: string | null;
    file: { uri: string; name: string; type: string };
  }) => Promise<void>;
  onBack: () => void;
  onContinue: () => Promise<void>;
}

export function DocumentsStep({
  documentTypes,
  vehicle,
  documents,
  onUpload,
  onBack,
  onContinue,
}: Props) {
  const theme = useTheme();
  const slots = buildRequiredSlots(documentTypes, vehicle);
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const allUploaded = slots.every((slot) =>
    findDocument(documents, slot.documentType.id, slot.vehicleId),
  );

  async function handlePick(slot: RequiredSlot) {
    const existing = findDocument(documents, slot.documentType.id, slot.vehicleId);
    if (existing?.status === 'APPROVED') return;

    const result = await DocumentPicker.getDocumentAsync({
      type: ['image/jpeg', 'image/png', 'application/pdf'],
      copyToCacheDirectory: true,
    });
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    if (!asset) return;

    setUploadingKey(slot.key);
    setRowError((prev) => ({ ...prev, [slot.key]: '' }));
    AccessibilityInfo.announceForAccessibility(`Uploading ${slot.label}.`);
    try {
      await onUpload({
        documentTypeCode: slot.documentType.code,
        vehicleId: slot.vehicleId,
        file: {
          uri: asset.uri,
          name: asset.name,
          type: asset.mimeType ?? 'application/octet-stream',
        },
      });
      AccessibilityInfo.announceForAccessibility(`${slot.label} uploaded.`);
    } catch {
      const message = 'Upload failed. Please try a different file.';
      setRowError((prev) => ({ ...prev, [slot.key]: message }));
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setUploadingKey(null);
    }
  }

  async function handleContinue() {
    if (!allUploaded) {
      const message = 'Upload every required document before continuing.';
      setSubmitError(message);
      AccessibilityInfo.announceForAccessibility(message);
      return;
    }
    setSaving(true);
    setSubmitError(undefined);
    try {
      await onContinue();
    } catch {
      setSubmitError('Something went wrong. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <WizardShell
      stepNumber={4}
      totalSteps={5}
      title="Required documents"
      subtitle="Upload a clear photo or PDF of each document below."
      onBack={onBack}
      onContinue={() => {
        void handleContinue();
      }}
      continueDisabled={!allUploaded}
      continueBusy={saving}
      errorMessage={submitError}
    >
      {slots.map((slot) => {
        const doc = findDocument(documents, slot.documentType.id, slot.vehicleId);
        const uploading = uploadingKey === slot.key;
        const locked = doc?.status === 'APPROVED';
        return (
          <View
            key={slot.key}
            style={[
              styles.row,
              { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
            ]}
          >
            <Text style={[styles.rowTitle, { color: theme.colors.textPrimary }]}>{slot.label}</Text>
            <Text
              style={[styles.rowStatus, { color: theme.colors.textSecondary }]}
              accessibilityLabel={`${slot.label} status: ${statusText(doc)}`}
            >
              Status: {statusText(doc)}
            </Text>
            <Pressable
              onPress={() => {
                void handlePick(slot);
              }}
              disabled={uploading || locked}
              accessibilityRole="button"
              accessibilityLabel={
                locked
                  ? `${slot.label} approved, cannot be changed`
                  : doc
                    ? `Replace ${slot.label}`
                    : `Upload ${slot.label}`
              }
              accessibilityState={{ busy: uploading, disabled: uploading || locked }}
              style={[
                styles.uploadButton,
                {
                  minHeight: theme.minTouchTarget,
                  borderColor: theme.colors.secondary,
                  opacity: locked ? 0.5 : 1,
                },
              ]}
            >
              {uploading ? (
                <ActivityIndicator color={theme.colors.secondary} />
              ) : (
                <Text style={{ color: theme.colors.secondary, fontWeight: '600' }}>
                  {locked ? 'Approved' : doc ? 'Replace file' : 'Upload file'}
                </Text>
              )}
            </Pressable>
            {rowError[slot.key] ? (
              <Text style={[styles.error, { color: theme.colors.error }]} accessibilityRole="alert">
                {rowError[slot.key]}
              </Text>
            ) : null}
          </View>
        );
      })}
    </WizardShell>
  );
}

const styles = StyleSheet.create({
  row: { borderWidth: 1, borderRadius: 16, padding: 16, gap: 8 },
  rowTitle: { fontSize: 16, fontWeight: '700' },
  rowStatus: { fontSize: 14 },
  uploadButton: {
    borderWidth: 1,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'flex-start',
    paddingHorizontal: 16,
  },
  error: { fontSize: 13 },
});
