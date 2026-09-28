export interface SmsMessage {
  toPhoneNumber: string;
  body: string;
}

/**
 * Everything above this interface (OTP service, routes) only ever talks to
 * an SmsProvider — swapping the real vendor (Twilio, Sparrow SMS, etc.)
 * later means writing one new class here, not touching auth logic.
 */
export interface SmsProvider {
  send(message: SmsMessage): Promise<void>;
}
