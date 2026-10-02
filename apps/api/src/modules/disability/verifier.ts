import { settingBool } from '../settings/settings.service';

/**
 * The seam to an OFFICIAL card-checking service, if one is ever connected. No government service is assumed or bundled:
 * until an adapter is registered here the official method is simply "not available" and every application goes to a person.
 *
 * A verifier can only CONFIRM. Anything else (it could not confirm, it was unreachable, it is not connected) sends the
 * application to a reviewer; it never refuses a rider on a machine's answer alone.
 */
export interface CardCheck {
  /** The card number as the rider typed it. Used for this one call and never stored. */
  cardNumber: string;
  issuingAuthority: string;
  issueDate: string;
  expiryDate: string;
}

export interface DisabilityCardVerifier {
  readonly name: string;
  /** True only when the service positively confirmed the card. Throws (a ProviderError) when it could not be asked. */
  confirm(card: CardCheck): Promise<boolean>;
}

let verifier: DisabilityCardVerifier | null = null;

/** Connect an official service (called at start-up by whoever wires one in; tests install a fake). */
export function setDisabilityVerifier(v: DisabilityCardVerifier | null): void {
  verifier = v;
}

export const getDisabilityVerifier = (): DisabilityCardVerifier | null => verifier;

/** The method is offered only when an administrator switched it on AND a service is actually connected. */
export function officialMethodState(): { available: boolean; reason: string | null } {
  if (!settingBool('DISABILITY_OFFICIAL_API_ENABLED')) {
    return { available: false, reason: 'The official check has not been switched on.' };
  }
  if (!verifier) return { available: false, reason: 'No official verification service is connected.' };
  return { available: true, reason: null };
}
