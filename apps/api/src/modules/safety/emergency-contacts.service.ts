import type { EmergencyContact, EmergencyContactsResponse } from '@yatri/types';

import { env } from '../../config/env';
import { recordAudit } from '../../lib/audit';
import { isUniqueViolation, query, withTransaction } from '../../lib/db';
import { HttpError } from '../../middleware/errorHandler';

/**
 * A person's emergency contacts: who should be told, with a link to follow the trip, if they raise an
 * SOS. Private to their owner — no other user, driver or passenger, and no admin screen, ever lists
 * them; only the SOS service reads them, at the moment it needs to send the message.
 */
interface Row {
  id: string;
  name: string;
  phone_number: string;
}
const toContact = (r: Row): EmergencyContact => ({
  id: r.id,
  name: r.name,
  phoneNumber: r.phone_number,
});

export async function listContacts(userId: string): Promise<EmergencyContactsResponse> {
  const r = await query<Row>(
    'SELECT id, name, phone_number FROM emergency_contacts WHERE user_id = $1 ORDER BY created_at',
    [userId],
  );
  return {
    contacts: r.rows.map(toContact),
    limit: env.EMERGENCY_CONTACTS_MAX,
    emergencyNumber: env.EMERGENCY_SERVICES_NUMBER,
  };
}

export async function addContact(
  userId: string,
  role: 'PASSENGER' | 'DRIVER',
  input: { name: string; phoneNumber: string },
): Promise<EmergencyContact> {
  const contact = await withTransaction(async (client) => {
    // Serialise this person's additions so the limit cannot be raced past.
    await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [userId]);
    const own = await client.query<{ phone_number: string; n: string }>(
      `SELECT (SELECT phone_number FROM users WHERE id = $1) AS phone_number,
              (SELECT count(*)::text FROM emergency_contacts WHERE user_id = $1) AS n`,
      [userId],
    );
    if (Number(own.rows[0]?.n ?? 0) >= env.EMERGENCY_CONTACTS_MAX) {
      throw new HttpError(
        409,
        'EMERGENCY_CONTACT_LIMIT',
        `You can keep up to ${env.EMERGENCY_CONTACTS_MAX} emergency contacts. Remove one to add another.`,
      );
    }
    if (own.rows[0]?.phone_number === input.phoneNumber) {
      throw new HttpError(422, 'VALIDATION_ERROR', 'That is your own phone number.');
    }
    const ins = await client.query<Row>(
      `INSERT INTO emergency_contacts (user_id, name, phone_number) VALUES ($1, $2, $3)
       RETURNING id, name, phone_number`,
      [userId, input.name, input.phoneNumber],
    );
    return toContact(ins.rows[0] as Row);
  }).catch((err) => {
    if (isUniqueViolation(err)) {
      throw new HttpError(409, 'DUPLICATE_CONTACT', 'You already have that contact.');
    }
    throw err;
  });
  // The audit entry says a contact was added — never the number itself.
  await recordAudit({
    actorId: userId,
    actorRole: role,
    action: 'EMERGENCY_CONTACT_ADDED',
    subjectType: 'user',
    subjectIds: [userId],
  });
  return contact;
}

export async function removeContact(
  userId: string,
  role: 'PASSENGER' | 'DRIVER',
  contactId: string,
): Promise<void> {
  const r = await query('DELETE FROM emergency_contacts WHERE id = $1 AND user_id = $2', [
    contactId,
    userId,
  ]);
  // Somebody else's contact and a missing one look the same.
  if (!r.rowCount) throw new HttpError(404, 'NOT_FOUND', 'Contact not found.');
  await recordAudit({
    actorId: userId,
    actorRole: role,
    action: 'EMERGENCY_CONTACT_REMOVED',
    subjectType: 'user',
    subjectIds: [userId],
  });
}

/** For the SOS service only: the people to tell. */
export async function contactsForSos(userId: string): Promise<EmergencyContact[]> {
  return (await listContacts(userId)).contacts;
}
