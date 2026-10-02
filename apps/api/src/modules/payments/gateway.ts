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

export interface GatewayRefundRequest {
  /** The vendor's reference for the payment being refunded. */
  providerRef: string;
  /** Whole rupees, decided by the server (never more than was paid). */
  amountNpr: number;
  /** Yatri's own refund id: sent as the idempotency key, so asking twice returns the same refund and never pays back twice. */
  refundId: string;
}

export type GatewayRefundState = 'COMPLETED' | 'PENDING' | 'FAILED';

export interface GatewayRefundResult {
  /** The vendor's reference for the refund, kept on the refund record. */
  refundRef: string;
  state: GatewayRefundState;
}

export interface PaymentGateway {
  readonly name: string;
  /**
   * Whether this vendor can return money through its API. Where it cannot (a vendor that only refunds in its merchant
   * dashboard), a refund of an online payment is returned by staff there and the vendor's reference is recorded here.
   */
  readonly supportsRefund: boolean;
  /** Return money to the payer. Idempotent on `refundId`. Only when `supportsRefund`. */
  refund?(request: GatewayRefundRequest): Promise<GatewayRefundResult>;
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
