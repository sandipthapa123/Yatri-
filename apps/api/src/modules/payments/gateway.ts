import { env } from '../../config/env';
import { KhaltiGateway } from './khalti-gateway';
import { SandboxGateway } from './sandbox-gateway';

/**
 * THE seam to an online payment vendor. The ride's payment record, the rules about who may pay and the amount are Yatri's
 * (digital-payments.service); a gateway only does two things: open a payment for an amount the server decided, and say what
 * became of it. Nothing in the business logic knows which vendor is behind it, and a vendor can never decide an amount.
 */
export interface GatewayPaymentRequest {
  /** Yatri's own id for this try; the vendor stores it as the merchant's order id. */
  attemptId: string;
  tripId: string;
  /** Whole rupees, decided by the server. */
  amountNpr: number;
  description: string;
}

export interface GatewayPaymentOpened {
  providerRef: string;
  /** The vendor's page where the rider pays. */
  paymentUrl: string;
  expiresAt: Date | null;
}

export type GatewayPaymentState = 'COMPLETED' | 'PENDING' | 'FAILED' | 'EXPIRED';

export interface GatewayPaymentLookup {
  state: GatewayPaymentState;
  /** Whole rupees the vendor says it took; compared with what Yatri asked for before anything is marked paid. */
  amountNpr: number | null;
}

export interface PaymentGateway {
  readonly name: string;
  /** Opening a payment is never repeated automatically (a retry could open two). */
  initiate(request: GatewayPaymentRequest): Promise<GatewayPaymentOpened>;
  /** A read: safe to repeat, retried on a passing failure. */
  lookup(providerRef: string): Promise<GatewayPaymentLookup>;
  /** A live check that proves the credentials and the network path, without opening a payment. */
  check?(): Promise<void>;
}

let gateway: PaymentGateway | null | undefined;

/** The configured gateway, or null when digital payments are off (cash and organization billing only). */
export function getPaymentGateway(): PaymentGateway | null {
  if (gateway !== undefined) return gateway;
  switch (env.PAYMENT_PROVIDER) {
    case 'khalti':
      gateway = new KhaltiGateway({
        secretKey: env.KHALTI_SECRET_KEY ?? '',
        baseUrl: env.KHALTI_BASE_URL ?? (env.NODE_ENV === 'production' ? 'https://khalti.com/api/v2' : 'https://dev.khalti.com/api/v2'),
        returnUrl: env.KHALTI_RETURN_URL ?? '',
        websiteUrl: env.PUBLIC_BASE_URL,
        timeoutMs: env.PROVIDER_TIMEOUT_MS,
      });
      break;
    case 'sandbox':
      gateway = new SandboxGateway(env.PUBLIC_BASE_URL);
      break;
    case 'none':
      gateway = null;
      break;
  }
  return gateway ?? null;
}

/** Test seam: install a gateway (undefined resets to the configured one). */
export function setPaymentGatewayForTests(g: PaymentGateway | null | undefined): void {
  gateway = g;
}
