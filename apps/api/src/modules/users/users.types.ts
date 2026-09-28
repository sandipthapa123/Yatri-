import type { AccountStatus, AppUser, UserRole } from '@yatri/types';

export type { AccountStatus, UserRole };

/** Raw `users` row shape, as returned by `pg` (snake_case). Internal only. */
export interface UserRow {
  id: string;
  role: UserRole;
  status: AccountStatus;
  phone_number: string | null;
  email: string | null;
  password_hash: string | null;
  full_name: string | null;
  profile_picture_url: string | null;
  created_at: Date;
  updated_at: Date;
}

/** What a passenger/driver/admin is allowed to see of their own account. */
export type PublicProfile = AppUser;

export function toPublicProfile(row: UserRow): PublicProfile {
  return {
    id: row.id,
    role: row.role,
    status: row.status,
    phoneNumber: row.phone_number,
    fullName: row.full_name,
    profilePictureUrl: row.profile_picture_url,
    createdAt: row.created_at.toISOString(),
  };
}
