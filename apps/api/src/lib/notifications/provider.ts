export interface NotificationPayload {
  userId: string;
  type: string;
  title: string;
  body: string;
  metadata?: Record<string, unknown>;
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
