import { query } from '../../lib/db';
import type { UserRole, UserRow } from './users.types';

const SELECT_COLUMNS = `
  id, role, status, phone_number, email, password_hash,
  full_name, profile_picture_url, created_at, updated_at
`;

export async function findUserById(id: string): Promise<UserRow | null> {
  const result = await query<UserRow>(`SELECT ${SELECT_COLUMNS} FROM users WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function findUserByPhoneAndRole(
  phoneNumber: string,
  role: UserRole,
): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `SELECT ${SELECT_COLUMNS} FROM users WHERE phone_number = $1 AND role = $2`,
    [phoneNumber, role],
  );
  return result.rows[0] ?? null;
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const result = await query<UserRow>(`SELECT ${SELECT_COLUMNS} FROM users WHERE email = $1`, [
    email.toLowerCase(),
  ]);
  return result.rows[0] ?? null;
}

export async function createPassengerOrDriver(
  phoneNumber: string,
  role: Extract<UserRole, 'PASSENGER' | 'DRIVER'>,
): Promise<UserRow> {
  const result = await query<UserRow>(
    `INSERT INTO users (phone_number, role, status)
     VALUES ($1, $2, 'ACTIVE')
     RETURNING ${SELECT_COLUMNS}`,
    [phoneNumber, role],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create user');
  return row;
}

export async function createAdmin(
  email: string,
  passwordHash: string,
  fullName: string,
): Promise<UserRow> {
  const result = await query<UserRow>(
    `INSERT INTO users (email, password_hash, full_name, role, status)
     VALUES ($1, $2, $3, 'ADMIN', 'ACTIVE')
     RETURNING ${SELECT_COLUMNS}`,
    [email.toLowerCase(), passwordHash, fullName],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Failed to create admin user');
  return row;
}

export interface ProfileUpdate {
  fullName?: string;
  profilePictureUrl?: string | null;
}

export async function updateProfile(id: string, update: ProfileUpdate): Promise<UserRow | null> {
  const result = await query<UserRow>(
    `UPDATE users
     SET full_name = COALESCE($2, full_name),
         profile_picture_url = CASE WHEN $3::boolean THEN $4 ELSE profile_picture_url END
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id, update.fullName ?? null, 'profilePictureUrl' in update, update.profilePictureUrl ?? null],
  );
  return result.rows[0] ?? null;
}
