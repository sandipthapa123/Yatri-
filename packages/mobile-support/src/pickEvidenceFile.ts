import type { PickedFile } from '@yatri/mobile-auth';
import * as DocumentPicker from 'expo-document-picker';

/**
 * The one way either app picks evidence for a support request: a photo, screenshot or PDF from the device.
 * The server checks what the bytes really are; this only offers the types it accepts.
 */
export async function pickEvidenceFile(): Promise<PickedFile | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: ['image/jpeg', 'image/png', 'application/pdf'],
    copyToCacheDirectory: true,
  });
  if (result.canceled || result.assets.length === 0) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return { uri: asset.uri, name: asset.name, type: asset.mimeType ?? 'application/octet-stream' };
}
