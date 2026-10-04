import { query } from '../../lib/db';
import type {
  GatewayRefundRequest,
  GatewayRefundResult,
  GatewayPaymentLookup,
  GatewayPaymentOpened,
  GatewayPaymentRequest,
  PaymentGateway,
} from './gateway';

/**
 * A stand-in for a payment vendor, for development and tests only (providerProblems refuses it in staging and production).
 * It opens a "payment" with a made-up address and reports it completed for the amount that was asked, so the rest of the flow
 * (idempotency, amount check, marking paid) is exercised with no network and no money.
 */
export class SandboxGateway implements PaymentGateway {
  readonly name = 'sandbox';
  readonly supportsRefund = true;
  constructor(private readonly publicBaseUrl: string) {}

  async initiate(r: GatewayPaymentRequest): Promise<GatewayPaymentOpened> {
    const providerRef = `sbx_${r.attemptId}`;
    return {
      providerRef,
      paymentUrl: `${this.publicBaseUrl.replace(/\/$/, '')}/sandbox-payment/${providerRef}`,
      expiresAt: null,
    };
  }

  async refund(r: GatewayRefundRequest): Promise<GatewayRefundResult> {
    return { refundRef: `sbxr_${r.refundId}`, state: 'COMPLETED' };
  }

  async lookup(providerRef: string): Promise<GatewayPaymentLookup> {
    const r = await query<{ amount_npr: number }>(
      'SELECT amount_npr FROM payment_attempts WHERE provider = $1 AND provider_ref = $2',
      [this.name, providerRef],
    );
    return r.rows[0]
      ? { state: 'COMPLETED', amountNpr: r.rows[0].amount_npr }
      : { state: 'FAILED', amountNpr: null };
  }
}
