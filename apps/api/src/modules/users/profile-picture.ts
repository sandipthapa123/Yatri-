import { getStorageProvider } from '../../lib/storage/local-disk-provider';
import { toPublicProfile, type PublicProfile, type UserRow } from './users.types';

/** How long a freshly issued picture link lasts. It is re-issued on every read, so this can be short. */
export const PROFILE_PICTURE_URL_TTL_SECONDS = 24 * 60 * 60;

const OWN_STORAGE_PREFIX = '/api/v1/storage/content?';

/**
 * The picture link stored on the user is a signed URL that eventually expires. Whenever a picture is
 * shown, this issues a fresh link for the same stored object; a link that is not ours (an external
 * URL) is passed through unchanged. The one place that decides how a stored picture becomes a link.
 */
export async function freshProfilePictureUrl(stored: string | null): Promise<string | null> {
  if (!stored) return null;
  if (!stored.startsWith(OWN_STORAGE_PREFIX)) return stored;
  const params = new URLSearchParams(stored.slice(OWN_STORAGE_PREFIX.length));
  const key = params.get('key');
  if (!key) return stored;
  return getStorageProvider().createTemporaryAccessUrl(key, PROFILE_PICTURE_URL_TTL_SECONDS, {
    contentType: params.get('contentType') ?? undefined,
  });
}

/** The profile as the API returns it, with a picture link that works right now. */
export async function publicProfileWithPicture(row: UserRow): Promise<PublicProfile> {
  const profile = toPublicProfile(row);
  return { ...profile, profilePictureUrl: await freshProfilePictureUrl(row.profile_picture_url) };
}
