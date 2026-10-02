import { ProviderError } from '../providers/errors';
import { providerRequest } from '../providers/http';
import type {
  GatewayPaymentLookup,
  GatewayPaymentOpened,
  GatewayPaymentRequest,
  GatewayPaymentState,
  PaymentGateway,
} from './gateway';

export interface KhaltiConfig {
  secretKey: string;
  baseUrl: string;
  returnUrl: string;
  websiteUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

const PAISA_PER_NPR = 100;

/** Khalti's words for where a payment is, as the one list of states. Anything it adds later is "not paid". */
const STATE: Record<string, GatewayPaymentState> = {
  Completed: 'COMPLETED',
  Pending: 'PENDING',
  Initiated: 'PENDING',
  Expired: 'EXPIRED',
  'User canceled': 'FAILED',
  Refunded: 'FAILED',
  'Partially Refunded': 'FAILED',
};

/**
 * Khalti ePayment (the hosted-page flow). The rider pays on Khalti's page and Khalti sends them back; that return is never
 * proof. Only `lookup`, a server-to-server question with the secret key, can say the money arrived. Khalti counts in paisa.
 */
export class KhaltiGateway implements PaymentGateway {
  readonly name = 'khalti';
  /** Khalti's ePayment API has no refund endpoint: a refund is made in the merchant dashboard and staff record its reference. */
  readonly supportsRefund = false;
  constructor(private readonly c: KhaltiConfig) {}

  private headers() {
    return { Authorization: `Key ${this.c.secretKey}`, 'Content-Type': 'application/json' };
  }
  private url(path: string) {
    return `${this.c.baseUrl.replace(/\/$/, '')}${path}`;
  }

  async initiate(r: GatewayPaymentRequest): Promise<GatewayPaymentOpened> {
    const res = await providerRequest<{ pidx?: string; payment_url?: string; expires_in?: number }>({
      capability: 'PAYMENTS',
      provider: this.name,
      operation: 'initiate',
      url: this.url('/epayment/initiate/'),
      init: {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          return_url: this.c.returnUrl,
          website_url: this.c.websiteUrl,
          amount: r.amountNpr * PAISA_PER_NPR,
          purchase_order_id: r.attemptId,
          purchase_order_name: r.description.slice(0, 100),
        }),
      },
      timeoutMs: this.c.timeoutMs,
      idempotent: false, // a second "initiate" would open a second payment
      expect: 'json',
      ...(this.c.fetchImpl ? { fetchImpl: this.c.fetchImpl } : {}),
    });
    const { pidx, payment_url: paymentUrl, expires_in: expiresIn } = res.data ?? {};
    if (!pidx || !paymentUrl) throw new ProviderError('PAYMENTS', this.name, 'BAD_RESPONSE');
    return {
      providerRef: pidx,
      paymentUrl,
      expiresAt: typeof expiresIn === 'number' ? new Date(Date.now() + expiresIn * 1000) : null,
    };
  }

  async lookup(providerRef: string): Promise<GatewayPaymentLookup> {
    const res = await providerRequest<{ status?: string; total_amount?: number }>({
      capability: 'PAYMENTS',
      provider: this.name,
      operation: 'lookup',
      url: this.url('/epayment/lookup/'),
      init: { method: 'POST', headers: this.headers(), body: JSON.stringify({ pidx: providerRef }) },
      timeoutMs: this.c.timeoutMs,
      idempotent: true,
      expect: 'json',
      ...(this.c.fetchImpl ? { fetchImpl: this.c.fetchImpl } : {}),
    });
    const body = res.data;
    if (!body || typeof body.status !== 'string') throw new ProviderError('PAYMENTS', this.name, 'BAD_RESPONSE');
    return {
      state: STATE[body.status] ?? 'FAILED',
      amountNpr: typeof body.total_amount === 'number' ? body.total_amount / PAISA_PER_NPR : null,
    };
  }

  /** Looking up a payment that does not exist: Khalti answers 400/404 (an answer, so the credentials and path work); 401 is a wrong key. */
  async check(): Promise<void> {
    try {
      await providerRequest({
        capability: 'PAYMENTS',
        provider: this.name,
        operation: 'check',
        url: this.url('/epayment/lookup/'),
        init: { method: 'POST', headers: this.headers(), body: JSON.stringify({ pidx: 'health-check' }) },
        timeoutMs: this.c.timeoutMs,
        idempotent: true,
        expect: 'none',
        ...(this.c.fetchImpl ? { fetchImpl: this.c.fetchImpl } : {}),
      });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'BAD_REQUEST') return;
      throw err;
    }
  }
}
