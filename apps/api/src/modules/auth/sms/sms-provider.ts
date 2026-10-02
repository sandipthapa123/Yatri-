export interface SmsMessage {
  toPhoneNumber: string;
  body: string;
}

/**
 * Everything above this interface (OTP service, routes) only ever talks to an SmsProvider: swapping the vendor means one
 * class here and a value for SMS_PROVIDER, never a change to auth logic. A failure is thrown as a ProviderError (a named
 * kind, nothing the vendor said), so the caller and the fallback decide by kind.
 */
export interface SmsProvider {
  readonly name?: string;
  send(message: SmsMessage): Promise<void>;
  /** A live check that proves the credentials and the network path without sending anything. */
  check?(): Promise<void>;
}
