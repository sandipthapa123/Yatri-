export interface NotificationPayload {
  userId: string;
  type: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
  /**
   * Recording and delivering the same thing twice is wrong (a sweep that runs again, a retried request): give it a key
   * that names the thing and it is recorded and delivered at most once for that person.
   */
  dedupeKey?: string;
}

/**
 * Everything above this interface (verification workflow, future ride
 * events) only ever calls NotificationService.notify(), which persists the
 * record and then hands it to whichever NotificationProvider is
 * configured. Wiring up real push notifications or SMS later means writing
 * one new class here, not touching business logic.
 */
export interface NotificationProvider {
  send(payload: NotificationPayload): Promise<void>;
}
