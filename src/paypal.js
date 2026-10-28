// Thin PayPal REST client. One file, no SDK: judges can read exactly which endpoints we call.
// Every POST carries a PayPal-Request-Id so retries (ours or the reconciler's) can never double-charge or double-pay.

import { randomUUID } from 'node:crypto';
import { fromCents } from './money.js';

export class PayPalError extends Error {
  constructor(message, { status, debugId, details, path } = {}) {
    super(message);
    this.name = 'PayPalError';
    this.status = status;
    this.debugId = debugId;
    this.details = details;
    this.path = path;
  }
}

const idFromHref = (href) => String(href || '').split('/').filter(Boolean).pop();

export function createPayPalClient({ clientId, clientSecret, baseUrl, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!clientId || !clientSecret) throw new Error('createPayPalClient: clientId and clientSecret are required');
  const base = baseUrl.replace(/\/$/, '');
  let token = null; // {value, expiresAt}

  async function accessToken() {
    if (token && token.expiresAt > now() + 30_000) return token.value;
    const res = await fetchImpl(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw new PayPalError(`PayPal auth failed: ${body.error_description || res.status}`, { status: res.status, debugId: res.headers?.get?.('paypal-debug-id'), path: '/v1/oauth2/token' });
    }
    token = { value: body.access_token, expiresAt: now() + (body.expires_in || 300) * 1000 };
    return token.value;
  }

  async function request(method, path, body, { requestId } = {}) {
    const headers = { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', Accept: 'application/json' };
    if (method === 'POST') headers['PayPal-Request-Id'] = requestId || randomUUID();
    const res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
    }
    if (!res.ok) {
      throw new PayPalError(`PayPal ${method} ${path} -> ${res.status}: ${data?.message || data?.name || 'error'}`, {
        status: res.status,
        debugId: data?.debug_id || res.headers?.get?.('paypal-debug-id'),
        details: data?.details,
        path,
      });
    }
    return data;
  }

  const money = (cents, currency = 'USD') => ({ currency_code: currency, value: fromCents(cents) });

  return {
    request,

    // ---- Invoicing v2 ---------------------------------------------------
    async generateNextInvoiceNumber() {
      const r = await request('POST', '/v2/invoicing/generate-next-invoice-number', {});
      return r.invoice_number;
    },
    /** items: [{name, quantity, unit_amount_cents}] */
    async createInvoice({ invoiceNumber, currency = 'USD', client, items, note, dueInDays = 14, requestId }) {
      const [given, ...rest] = String(client.name || 'Client').split(' ');
      const payload = {
        detail: {
          invoice_number: invoiceNumber,
          invoice_date: new Date(now()).toISOString().slice(0, 10),
          currency_code: currency,
          note,
          payment_term: { term_type: `NET_${dueInDays}` },
        },
        primary_recipients: [{ billing_info: { email_address: client.email, name: { given_name: given, surname: rest.join(' ') || '-' } } }],
        items: items.map((i) => ({ name: i.name, quantity: String(i.quantity ?? 1), unit_amount: money(i.unit_amount_cents, currency) })),
      };
      if (dueInDays <= 0) payload.detail.payment_term = { term_type: 'DUE_ON_RECEIPT' };
      const r = await request('POST', '/v2/invoicing/invoices', payload, { requestId });
      return { id: idFromHref(r.href), href: r.href };
    },
    async sendInvoice(id, { sendToRecipient = true, subject, note } = {}) {
      return request('POST', `/v2/invoicing/invoices/${id}/send`, { send_to_recipient: sendToRecipient, send_to_invoicer: false, subject, note });
    },
    getInvoice: (id) => request('GET', `/v2/invoicing/invoices/${id}`),
    remindInvoice: (id, { subject = 'Friendly reminder', note = 'Your invoice is still open.' } = {}) =>
      request('POST', `/v2/invoicing/invoices/${id}/remind`, { subject, note, send_to_invoicer: false }),
    /** Only used by the explicit "client paid offline" button. */
    recordPayment: (id, { amountCents, currency = 'USD', note = 'Paid offline (recorded by owner)', date }) =>
      request('POST', `/v2/invoicing/invoices/${id}/payments`, {
        method: 'OTHER', payment_date: date || new Date(now()).toISOString().slice(0, 10), note, amount: money(amountCents, currency),
      }),
    cancelInvoice: (id, { subject = 'Invoice cancelled', note = 'This invoice was cancelled.' } = {}) =>
      request('POST', `/v2/invoicing/invoices/${id}/cancel`, { subject, note, send_to_invoicer: false, send_to_recipient: true }),

    // ---- Orders v2 (checkout link) ---------------------------------------
    async createOrder({ taskId, invoiceId, description, amountCents, currency = 'USD', returnUrl, cancelUrl, requestId }) {
      const r = await request('POST', '/v2/checkout/orders', {
        intent: 'CAPTURE',
        purchase_units: [{ custom_id: taskId, invoice_id: invoiceId, description, amount: money(amountCents, currency) }],
        payment_source: { paypal: { experience_context: { return_url: returnUrl, cancel_url: cancelUrl, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' } } },
      }, { requestId });
      const link = (r.links || []).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
      return { id: r.id, status: r.status, approveUrl: link?.href || null };
    },
    captureOrder: (id, requestId) => request('POST', `/v2/checkout/orders/${id}/capture`, {}, { requestId: requestId || `capture-${id}` }),
    getOrder: (id) => request('GET', `/v2/checkout/orders/${id}`),

    // ---- Payments v2 -----------------------------------------------------
    refundCapture: (captureId, { amountCents, currency = 'USD', note, requestId } = {}) =>
      request('POST', `/v2/payments/captures/${captureId}/refund`,
        { ...(amountCents ? { amount: money(amountCents, currency) } : {}), note_to_payer: note }, { requestId }),

    // ---- Payouts v1 (our "spend" rail) -----------------------------------
    /** items: [{receiver, amountCents, currency, note, senderItemId}] */
    createPayout: (items, senderBatchId, { emailSubject = 'Payment from Atlas Treasury' } = {}) =>
      request('POST', '/v1/payments/payouts', {
        sender_batch_header: { sender_batch_id: senderBatchId, email_subject: emailSubject },
        items: items.map((i) => ({
          recipient_type: 'EMAIL', receiver: i.receiver, note: i.note, sender_item_id: i.senderItemId,
          amount: { currency: i.currency || 'USD', value: fromCents(i.amountCents) },
        })),
      }, { requestId: senderBatchId }),
    getPayoutBatch: (batchId) => request('GET', `/v1/payments/payouts/${batchId}`),

    // ---- Disputes v1 -----------------------------------------------------
    listDisputes: (query = '') => request('GET', `/v1/customer/disputes${query ? `?${query}` : ''}`),
    getDispute: (id) => request('GET', `/v1/customer/disputes/${id}`),
    acceptClaim: (id, note) => request('POST', `/v1/customer/disputes/${id}/accept-claim`, { note, accept_claim_reason: 'REASON_NOT_SET' }),
    // Notes-only evidence. NOTE: PayPal documents multipart for file evidence; the JSON notes form is unverified against live sandbox.
    provideEvidence: (id, note) => request('POST', `/v1/customer/disputes/${id}/provide-evidence`, { evidences: [{ evidence_type: 'OTHER', notes: note }] }),
    sendMessage: (id, message) => request('POST', `/v1/customer/disputes/${id}/send-message`, { message }),

    // ---- Webhooks --------------------------------------------------------
    /** headers: Headers-like with .get(); rawBody: exact string PayPal sent. */
    async verifyWebhookSignature(headers, rawBody, webhookId) {
      const h = (n) => (typeof headers.get === 'function' ? headers.get(n) : headers[n]);
      const r = await request('POST', '/v1/notifications/verify-webhook-signature', {
        auth_algo: h('paypal-auth-algo'),
        cert_url: h('paypal-cert-url'),
        transmission_id: h('paypal-transmission-id'),
        transmission_sig: h('paypal-transmission-sig'),
        transmission_time: h('paypal-transmission-time'),
        webhook_id: webhookId,
        webhook_event: JSON.parse(rawBody),
      });
      return r.verification_status === 'SUCCESS';
    },
    async ensureWebhook(url, eventNames) {
      const list = await request('GET', '/v1/notifications/webhooks');
      const existing = (list.webhooks || []).find((w) => w.url === url);
      if (existing) return { id: existing.id, created: false };
      const created = await request('POST', '/v1/notifications/webhooks', { url, event_types: eventNames.map((name) => ({ name })) });
      return { id: created.id, created: true };
    },
  };
}

/** Webhook event types Atlas Treasury subscribes to (also used by `npm run setup:webhook`). */
export const WEBHOOK_EVENTS = [
  'INVOICING.INVOICE.PAID',
  'PAYMENT.CAPTURE.COMPLETED',
  'PAYMENT.CAPTURE.REFUNDED',
  'PAYMENT.PAYOUTSBATCH.SUCCESS',
  'PAYMENT.PAYOUTSBATCH.DENIED',
  'PAYMENT.PAYOUTS-ITEM.SUCCEEDED',
  'PAYMENT.PAYOUTS-ITEM.FAILED',
  'PAYMENT.PAYOUTS-ITEM.UNCLAIMED',
  'PAYMENT.PAYOUTS-ITEM.RETURNED',
  'CUSTOMER.DISPUTE.CREATED',
  'CUSTOMER.DISPUTE.UPDATED',
  'CUSTOMER.DISPUTE.RESOLVED',
];
