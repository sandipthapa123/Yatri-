import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAuth } from '@yatri/mobile-auth';
import type {
  DocumentSummary,
  DocumentTypeRef,
  DriverOnboardingProgress,
  Vehicle,
  VehicleCategory,
} from '@yatri/types';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import * as driverApi from '../../api/driverApi';
import type { RootStackParamList } from '../../navigation/RootNavigator';
import { useTheme } from '../../theme/useTheme';
import { DocumentsStep } from './steps/DocumentsStep';
import { DriverInfoStep, type DriverInfoValues } from './steps/DriverInfoStep';
import { PersonalInfoStep, detailsToPersonalInfoValues } from './steps/PersonalInfoStep';
import { ReviewStep } from './steps/ReviewStep';
import {
  VehicleInfoStep,
  vehicleToFormValues,
  type VehicleFormValues,
} from './steps/VehicleInfoStep';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

type Step = 1 | 2 | 3 | 4 | 5;

interface LoadedState {
  progress: DriverOnboardingProgress;
  categories: VehicleCategory[];
  vehicle: Vehicle | null;
  documentTypes: DocumentTypeRef[];
  documents: DocumentSummary[];
}

/**
 * `progress.steps.submitted` just means "has been submitted at least once"
 * (a checklist item) — REJECTED counts as submitted there too, since it's
 * not NOT_STARTED/IN_PROGRESS. Routing needs a different question: is the
 * application currently editable? REJECTED must stay editable so a driver
 * can fix it and resubmit; only these statuses are genuinely out of the
 * driver's hands right now.
 */
const NON_EDITABLE_STATUSES: DriverOnboardingProgress['status'][] = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'VERIFIED',
  'SUSPENDED',
];

function firstIncompleteStep(progress: DriverOnboardingProgress): Step {
  if (!progress.steps.personalInfo) return 1;
  if (!progress.steps.driverInfo) return 2;
  if (!progress.steps.vehicle) return 3;
  if (!progress.steps.documents) return 4;
  return 5;
}

/**
 * Hosts the five onboarding steps as one screen with local step state,
 * rather than five stack screens — this is what lets a resumed driver land
 * directly on the first incomplete step without re-navigating through
 * completed ones. Every mutation re-reads progress from the server (the
 * single source of truth for status/steps/missingRequirements), never
 * computed client-side.
 */
export function OnboardingScreen({ navigation }: Props) {
  const theme = useTheme();
  const { getAccessToken } = useAuth();
  const [state, setState] = useState<LoadedState | null>(null);
  const [step, setStep] = useState<Step>(1);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    setLoadError(undefined);
    try {
      const token = await getAccessToken();
      const [progress, categories, vehicles, documentTypes, documents] = await Promise.all([
        driverApi.getOnboarding(token),
        driverApi.getVehicleCategories(token),
        driverApi.listVehicles(token),
        driverApi.listDocumentTypes(token),
        driverApi.listDocuments(token),
      ]);

      if (NON_EDITABLE_STATUSES.includes(progress.status)) {
        navigation.replace('VerificationPending');
        return;
      }

      setState({ progress, categories, vehicle: vehicles[0] ?? null, documentTypes, documents });
      setStep(firstIncompleteStep(progress));
    } catch {
      setLoadError('Could not load your application. Please check your connection and try again.');
    }
  }, [getAccessToken, navigation]);

  useEffect(() => {
    (async () => {
      await load();
    })();
  }, [load]);

  const refresh = useCallback(async (): Promise<DriverOnboardingProgress> => {
    const token = await getAccessToken();
    const [progress, vehicles, documents] = await Promise.all([
      driverApi.getOnboarding(token),
      driverApi.listVehicles(token),
      driverApi.listDocuments(token),
    ]);
    setState((prev) =>
      prev ? { ...prev, progress, vehicle: vehicles[0] ?? null, documents } : prev,
    );
    return progress;
  }, [getAccessToken]);

  if (loadError) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: theme.colors.background }]}>
        <Text style={[styles.errorText, { color: theme.colors.error }]} accessibilityRole="alert">
          {loadError}
        </Text>
        <Pressable
          onPress={() => {
            void load();
          }}
          accessibilityRole="button"
          accessibilityLabel="Retry"
          style={[
            styles.retryButton,
            { backgroundColor: theme.colors.secondary, minHeight: theme.minTouchTarget },
          ]}
        >
          <Text style={{ color: theme.colors.textInverse, fontWeight: '700' }}>Retry</Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  if (!state) {
    return (
      <SafeAreaView style={[styles.center, { backgroundColor: theme.colors.background }]}>
        <ActivityIndicator
          color={theme.colors.secondary}
          accessibilityLabel="Loading your application"
        />
      </SafeAreaView>
    );
  }

  if (step === 1) {
    return (
      <PersonalInfoStep
        initialValues={detailsToPersonalInfoValues(state.progress.details)}
        onContinue={async (_values, patch) => {
          const token = await getAccessToken();
          await driverApi.updateOnboarding(token, patch);
          await refresh();
          setStep(2);
        }}
      />
    );
  }

  if (step === 2) {
    const values: DriverInfoValues = {
      licenseNumber: state.progress.details.licenseNumber ?? '',
      licenseExpiryDate: state.progress.details.licenseExpiryDate ?? '',
    };
    return (
      <DriverInfoStep
        initialValues={values}
        onBack={() => setStep(1)}
        onContinue={async (_values, patch) => {
          const token = await getAccessToken();
          await driverApi.updateOnboarding(token, patch);
          await refresh();
          setStep(3);
        }}
      />
    );
  }

  if (step === 3) {
    return (
      <VehicleInfoStep
        categories={state.categories}
        initialValues={state.vehicle ? vehicleToFormValues(state.vehicle) : undefined}
        isEditingExisting={!!state.vehicle}
        onBack={() => setStep(2)}
        onContinue={async (values: VehicleFormValues) => {
          const token = await getAccessToken();
          const base = {
            make: values.make.trim(),
            model: values.model.trim(),
            year: Number(values.year),
            color: values.color.trim(),
            registrationNumber: values.registrationNumber.trim(),
            vin: values.vin.trim() || undefined,
            registrationExpiryDate: values.registrationExpiryDate.trim() || undefined,
            insuranceProvider: values.insuranceProvider.trim() || undefined,
            insurancePolicyNumber: values.insurancePolicyNumber.trim() || undefined,
            insuranceExpiryDate: values.insuranceExpiryDate.trim() || undefined,
          };
          if (state.vehicle) {
            await driverApi.updateVehicle(token, state.vehicle.id, base);
          } else {
            await driverApi.createVehicle(token, { ...base, categoryId: values.categoryId });
          }
          await refresh();
          setStep(4);
        }}
      />
    );
  }

  if (step === 4) {
    return (
      <DocumentsStep
        documentTypes={state.documentTypes}
        vehicle={state.vehicle}
        documents={state.documents}
        onUpload={async ({ documentTypeCode, vehicleId, file }) => {
          const token = await getAccessToken();
          const doc = await driverApi.uploadDocument(token, {
            documentTypeCode,
            vehicleId: vehicleId ?? undefined,
            file,
          });
          setState((prev) => {
            if (!prev) return prev;
            const rest = prev.documents.filter(
              (d) => !(d.documentType.id === doc.documentType.id && d.vehicleId === doc.vehicleId),
            );
            return { ...prev, documents: [...rest, doc] };
          });
        }}
        onBack={() => setStep(3)}
        onContinue={async () => {
          await refresh();
          setStep(5);
        }}
      />
    );
  }

  return (
    <ReviewStep
      details={state.progress.details}
      vehicle={state.vehicle}
      documentCount={state.documents.length}
      missingRequirements={state.progress.missingRequirements}
      rejectionReason={state.progress.rejectionReason}
      onBack={() => setStep(4)}
      onSubmit={async () => {
        const token = await getAccessToken();
        await driverApi.submitVerification(token);
        navigation.replace('VerificationPending');
      }}
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  errorText: { fontSize: 15, textAlign: 'center' },
  retryButton: {
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 999,
    paddingHorizontal: 24,
  },
});
