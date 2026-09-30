import type { FleetNotificationType } from '@yatri/types';

import { notify } from '../../lib/notifications';

/**
 * How fleet operations talks to a driver, through the one notification system. The words come from the
 * shared describe functions in @yatri/types (the same sentence the screens use); nothing is sent for a
 * change that did not happen.
 */
export async function notifyDriver(
  userId: string,
  type: FleetNotificationType,
  body: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await notify({ userId, type, title: 'Yatri drivers', body, metadata }).catch(() => undefined);
}
