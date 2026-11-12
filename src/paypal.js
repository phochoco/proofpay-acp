// Escrow on PayPal's Orders v2 API: AUTHORIZE holds the buyer's money, CAPTURE releases it to
// the supplier, VOID gives it back. Nothing here needs a smart contract.
//
//   create order (intent AUTHORIZE) -> buyer approves in PayPal -> authorize   = funds held
//   evaluator approves  -> capture authorization                               = supplier paid
//   evaluator rejects   -> void authorization                                  = buyer keeps money
//
// Without sandbox credentials a mock with the same interface is used so the app still runs.
import { randomUUID } from 'node:crypto';
import { env } from './env.js';

const fmt = (n) => (Math.round(Number(n) * 100) / 100).toFixed(2);

class PayPalSandbox {
  mode = 'sandbox';
  base = 'https://api-m.sandbox.paypal.com';
  #token = null;
  #expires = 0;

  constructor(clientId, secret) {
    this.auth = Buffer.from(`${clientId}:${secret}`).toString('base64');
  }

  async token() {
    if (this.#token && Date.now() < this.#expires) return this.#token;
    const res = await fetch(`${this.base}/v1/oauth2/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${this.auth}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`PayPal auth failed (${res.status}). Check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET.`);
    const json = await res.json();
    this.#token = json.access_token;
    this.#expires = Date.now() + (json.expires_in - 60) * 1000;
    return this.#token;
  }

  async req(method, path, body, requestId) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        authorization: `Bearer ${await this.token()}`,
        'content-type': 'application/json',
        prefer: 'return=representation',
        ...(requestId ? { 'paypal-request-id': requestId } : {}), // idempotency: a retry never double-charges
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const detail = json.details?.[0]?.issue || json.name || res.status;
      throw new Error(`PayPal ${method} ${path} -> ${detail}: ${json.message || ''} (debug_id ${json.debug_id || 'n/a'})`);
    }
    return json;
  }

  async createEscrowOrder({ jobId, amount, description, returnUrl, cancelUrl, payeeEmail }) {
    const order = await this.req('POST', '/v2/checkout/orders', {
      intent: 'AUTHORIZE',
      purchase_units: [{
        reference_id: jobId,
        custom_id: jobId,
        description: description.slice(0, 127),
        amount: { currency_code: 'USD', value: fmt(amount) },
        ...(payeeEmail ? { payee: { email_address: payeeEmail } } : {}),
      }],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: 'ProofPay ACP',
            user_action: 'PAY_NOW',
            shipping_preference: 'NO_SHIPPING',
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    }, `create-${jobId}`);
    const approveUrl = order.links?.find((l) => l.rel === 'payer-action' || l.rel === 'approve')?.href;
    if (!approveUrl) throw new Error('PayPal order created but no approval link was returned.');
    return { orderId: order.id, approveUrl };
  }

  async authorize(orderId) {
    const order = await this.req('POST', `/v2/checkout/orders/${orderId}/authorize`, {}, `auth-${orderId}`);
    const auth = order.purchase_units?.[0]?.payments?.authorizations?.[0];
    if (!auth) throw new Error('PayPal authorize returned no authorization.');
    return { authorizationId: auth.id, status: auth.status };
  }

  async capture(authorizationId, note) {
    const cap = await this.req('POST', `/v2/payments/authorizations/${authorizationId}/capture`,
      { final_capture: true, note_to_payer: note.slice(0, 255) }, `cap-${authorizationId}`);
    return { captureId: cap.id, status: cap.status };
  }

  async void(authorizationId) {
    await this.req('POST', `/v2/payments/authorizations/${authorizationId}/void`, undefined, `void-${authorizationId}`);
    return { status: 'VOIDED' };
  }

  /** Pays an agent its fee through PayPal Payouts. Needs Payouts enabled on the sandbox app. */
  async payout({ id, email, amount, note }) {
    const res = await this.req('POST', '/v1/payments/payouts', {
      sender_batch_header: { sender_batch_id: id, email_subject: 'ProofPay ACP agent fee' },
      items: [{ recipient_type: 'EMAIL', receiver: email, amount: { value: fmt(amount), currency: 'USD' }, note: note.slice(0, 255), sender_item_id: id }],
    });
    return { payoutId: res.batch_header?.payout_batch_id, status: res.batch_header?.batch_status };
  }
}

/** Same interface, no network. Clearly labelled MOCK everywhere it is shown. */
class PayPalMock {
  mode = 'mock';
  orders = new Map();

  async createEscrowOrder({ amount, returnUrl, cancelUrl }) {
    const orderId = `MOCK-${randomUUID().slice(0, 8).toUpperCase()}`;
    this.orders.set(orderId, { amount: fmt(amount), status: 'CREATED', returnUrl, cancelUrl });
    return { orderId, approveUrl: `/mock-paypal/approve?token=${orderId}` };
  }
  approve(orderId) {
    const o = this.orders.get(orderId);
    if (!o) throw new Error('unknown mock order');
    o.status = 'APPROVED';
    return o;
  }
  async authorize(orderId) {
    const o = this.orders.get(orderId);
    if (o?.status !== 'APPROVED') throw new Error('ORDER_NOT_APPROVED');
    o.status = 'AUTHORIZED';
    o.authorizationId = `MOCK-AUTH-${randomUUID().slice(0, 8).toUpperCase()}`;
    return { authorizationId: o.authorizationId, status: 'CREATED' };
  }
  #byAuth(id) {
    const o = [...this.orders.values()].find((x) => x.authorizationId === id);
    if (o?.status !== 'AUTHORIZED') throw new Error('AUTHORIZATION_NOT_OPEN');
    return o;
  }
  async capture(authorizationId) {
    this.#byAuth(authorizationId).status = 'CAPTURED';
    return { captureId: `MOCK-CAP-${randomUUID().slice(0, 8).toUpperCase()}`, status: 'COMPLETED' };
  }
  async void(authorizationId) {
    this.#byAuth(authorizationId).status = 'VOIDED';
    return { status: 'VOIDED' };
  }
  async payout() {
    return { payoutId: `MOCK-PAYOUT-${randomUUID().slice(0, 8).toUpperCase()}`, status: 'SUCCESS' };
  }
}

export function createPayPal() {
  const id = env('PAYPAL_CLIENT_ID');
  const secret = env('PAYPAL_CLIENT_SECRET');
  return id && secret ? new PayPalSandbox(id, secret) : new PayPalMock();
}
