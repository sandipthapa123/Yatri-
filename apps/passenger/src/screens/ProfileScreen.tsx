import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { resolveMediaUrl, useAuth } from '@yatri/mobile-auth';
import type { AccountStatus } from '@yatri/types';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { RootStackParamList } from '../navigation/RootNavigator';
import { useTheme } from '../theme/useTheme';

type Props = NativeStackScreenProps<RootStackParamList, 'Profile'>;

const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = {
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  DEACTIVATED: 'Deactivated',
};

function initials(name: string | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

export function ProfileScreen({ navigation }: Props) {
  const theme = useTheme();
  const { user, updateProfile, uploadProfilePicture, deactivateAccount, logout } = useAuth();

  const [fullName, setFullNameState] = useState(user?.fullName ?? '');
  const [editingName, setEditingName] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [uploadingPicture, setUploadingPicture] = useState(false);
  const [pictureError, setPictureError] = useState<string | undefined>(undefined);
  const [deactivating, setDeactivating] = useState(false);

  const accountStatus = user?.status ?? 'ACTIVE';
  const accountStatusLabel = ACCOUNT_STATUS_LABEL[accountStatus];

  async function handleChangePicture() {
    setPictureError(undefined);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      const message = 'Photo library access is needed to change your profile picture.';
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
    AccessibilityInfo.announceForAccessibility('Uploading profile picture.');
    try {
      const name = asset.fileName ?? `profile-${Date.now()}.jpg`;
      const type = asset.mimeType ?? 'image/jpeg';
      await uploadProfilePicture({ uri: asset.uri, name, type });
      AccessibilityInfo.announceForAccessibility('Profile picture updated.');
    } catch {
      const message = 'Could not upload your profile picture. Please try a different photo.';
      setPictureError(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setUploadingPicture(false);
    }
  }

  async function handleSaveName() {
    const trimmed = fullName.trim();
    if (trimmed.length === 0) {
      setNameError('Enter your name to continue.');
      AccessibilityInfo.announceForAccessibility('Enter your name to continue.');
      return;
    }
    setSavingName(true);
    setNameError(undefined);
    try {
      await updateProfile({ fullName: trimmed });
      setEditingName(false);
      AccessibilityInfo.announceForAccessibility('Name updated.');
    } catch {
      const message = 'Could not save your name. Please try again.';
      setNameError(message);
      AccessibilityInfo.announceForAccessibility(message);
    } finally {
      setSavingName(false);
    }
  }

  function handleDeactivate() {
    Alert.alert(
      'Deactivate account',
      'Your account will be deactivated and you will be signed out. This cannot be undone from the app. Continue?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Deactivate',
          style: 'destructive',
          onPress: () => {
            setDeactivating(true);
            deactivateAccount().catch(() => {
              setDeactivating(false);
              Alert.alert(
                'Something went wrong',
                'Could not deactivate your account. Please try again.',
              );
            });
          },
        },
      ],
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Pressable
          onPress={() => navigation.goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={[styles.backButton, { minHeight: theme.minTouchTarget }]}
        >
          <Text style={[styles.backText, { color: theme.colors.primary }]}>{'‹ Back'}</Text>
        </Pressable>

        <Text
          style={[styles.screenTitle, { color: theme.colors.textPrimary }]}
          accessibilityRole="header"
        >
          Profile
        </Text>

        <View style={styles.avatarSection}>
          <Pressable
            onPress={handleChangePicture}
            disabled={uploadingPicture}
            accessibilityRole="button"
            accessibilityLabel="Change profile picture"
            accessibilityHint="Opens your photo library to choose a new picture"
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
                <Text style={[styles.avatarInitials, { color: theme.colors.textPrimary }]}>
                  {initials(user?.fullName ?? null)}
                </Text>
              </View>
            )}
            {uploadingPicture ? (
              <View style={styles.avatarOverlay}>
                <ActivityIndicator color={theme.colors.textInverse} />
              </View>
            ) : null}
          </Pressable>
          <Text style={[styles.changePhotoLabel, { color: theme.colors.primary }]}>
            {uploadingPicture ? 'Uploading…' : 'Change photo'}
          </Text>
          {pictureError ? (
            <Text style={[styles.error, { color: theme.colors.error }]} accessibilityRole="alert">
              {pictureError}
            </Text>
          ) : null}
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: theme.colors.textSecondary }]} nativeID="name-label">
            Full name
          </Text>
          {editingName ? (
            <>
              <TextInput
                value={fullName}
                onChangeText={setFullNameState}
                autoComplete="name"
                textContentType="name"
                autoCapitalize="words"
                placeholder="Your full name"
                placeholderTextColor={theme.colors.textSecondary}
                style={[
                  styles.input,
                  {
                    color: theme.colors.textPrimary,
                    borderColor: nameError ? theme.colors.error : theme.colors.border,
                    backgroundColor: theme.colors.surface,
                  },
                ]}
                accessibilityLabel={nameError ? `Full name. ${nameError}` : 'Full name'}
                accessibilityLabelledBy="name-label"
              />
              <View style={styles.editActions}>
                <Pressable
                  onPress={handleSaveName}
                  disabled={savingName}
                  accessibilityRole="button"
                  accessibilityLabel={savingName ? 'Saving name' : 'Save name'}
                  accessibilityState={{ busy: savingName, disabled: savingName }}
                  style={[
                    styles.smallButton,
                    { backgroundColor: theme.colors.primary, minHeight: theme.minTouchTarget },
                  ]}
                >
                  <Text style={[styles.smallButtonText, { color: theme.colors.textInverse }]}>
                    {savingName ? 'Saving…' : 'Save'}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setEditingName(false);
                    setFullNameState(user?.fullName ?? '');
                    setNameError(undefined);
                  }}
                  disabled={savingName}
                  accessibilityRole="button"
                  accessibilityLabel="Cancel editing name"
                  style={[styles.smallButton, { minHeight: theme.minTouchTarget }]}
                >
                  <Text style={[styles.smallButtonText, { color: theme.colors.textSecondary }]}>
                    Cancel
                  </Text>
                </Pressable>
              </View>
              {nameError ? (
                <Text
                  style={[styles.error, { color: theme.colors.error }]}
                  accessibilityRole="alert"
                >
                  {nameError}
                </Text>
              ) : null}
            </>
          ) : (
            <View style={styles.viewRow}>
              <Text
                style={[styles.value, { color: theme.colors.textPrimary }]}
                accessibilityLabelledBy="name-label"
              >
                {user?.fullName?.trim() || 'Not set'}
              </Text>
              <Pressable
                onPress={() => setEditingName(true)}
                accessibilityRole="button"
                accessibilityLabel="Edit full name"
                style={[styles.editLink, { minHeight: theme.minTouchTarget }]}
              >
                <Text style={[styles.editLinkText, { color: theme.colors.primary }]}>Edit</Text>
              </Pressable>
            </View>
          )}
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Phone number</Text>
          <Text
            style={[styles.value, { color: theme.colors.textPrimary }]}
            accessibilityLabel={`Phone number ${user?.phoneNumber ?? 'not set'}`}
          >
            {user?.phoneNumber ?? 'Not set'}
          </Text>
        </View>

        <View style={styles.field}>
          <Text style={[styles.label, { color: theme.colors.textSecondary }]}>Account status</Text>
          <Text
            style={[styles.value, { color: theme.colors.textPrimary }]}
            accessibilityLabel={`Account status: ${accountStatusLabel}`}
          >
            Account status: {accountStatusLabel}
          </Text>
        </View>

        <View style={[styles.divider, { backgroundColor: theme.colors.border }]} />

        <Pressable
          onPress={() => {
            void logout();
          }}
          accessibilityRole="button"
          accessibilityLabel="Sign out"
          style={[styles.actionButton, { minHeight: theme.minTouchTarget }]}
        >
          <Text style={[styles.actionButtonText, { color: theme.colors.textPrimary }]}>
            Sign out
          </Text>
        </Pressable>

        <Pressable
          onPress={handleDeactivate}
          disabled={deactivating}
          accessibilityRole="button"
          accessibilityLabel={deactivating ? 'Deactivating account' : 'Deactivate account'}
          accessibilityHint="Permanently deactivates your account and signs you out"
          accessibilityState={{ busy: deactivating, disabled: deactivating }}
          style={[
            styles.actionButton,
            { minHeight: theme.minTouchTarget, opacity: deactivating ? 0.6 : 1 },
          ]}
        >
          <Text style={[styles.actionButtonText, { color: theme.colors.error }]}>
            {deactivating ? 'Deactivating…' : 'Deactivate account'}
          </Text>
        </Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 24, gap: 24 },
  backButton: { alignSelf: 'flex-start', justifyContent: 'center' },
  backText: { fontSize: 16, fontWeight: '600' },
  screenTitle: { fontSize: 24, fontWeight: '700' },
  avatarSection: { alignItems: 'center', gap: 8 },
  avatarPressable: { position: 'relative' },
  avatarImage: { width: 96, height: 96, borderRadius: 48, borderWidth: 1 },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  avatarInitials: { fontSize: 28, fontWeight: '700' },
  avatarOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 48,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  changePhotoLabel: { fontSize: 14, fontWeight: '600' },
  field: { gap: 6 },
  label: { fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  value: { fontSize: 17 },
  viewRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  editLink: { justifyContent: 'center', paddingHorizontal: 8 },
  editLinkText: { fontSize: 15, fontWeight: '600' },
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 16, minHeight: 48, fontSize: 16 },
  editActions: { flexDirection: 'row', gap: 12 },
  smallButton: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 10,
    paddingHorizontal: 12,
  },
  smallButtonText: { fontSize: 15, fontWeight: '600' },
  error: { fontSize: 13 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 4 },
  actionButton: { justifyContent: 'center', paddingVertical: 4 },
  actionButtonText: { fontSize: 16, fontWeight: '600' },
});
