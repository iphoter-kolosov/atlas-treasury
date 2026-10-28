import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';

export function makeCtx({ paypal = null, claude = null, env = {} } = {}) {
  const config = loadConfig({ PUBLIC_URL: 'https://treasury.test', ...env });
  const db = openDb(':memory:');
  seed(db, config);
  const logs = [];
  return { db, config, paypal, claude, log: (level, msg) => logs.push([level, msg]), logs };
}

/** Records calls and returns plausible PayPal shapes. Override any method per test. */
export function fakePayPal(overrides = {}) {
  const calls = [];
  const rec = (name, result) => async (...args) => {
    calls.push({ name, args });
    return typeof result === 'function' ? result(...args) : result;
  };
  const api = {
    calls,
    createPayout: rec('createPayout', (items, batchId) => ({ batch_header: { payout_batch_id: `PB-${batchId}`, batch_status: 'PENDING' } })),
    getPayoutBatch: rec('getPayoutBatch', { items: [] }),
    generateNextInvoiceNumber: rec('generateNextInvoiceNumber', '0001'),
    createInvoice: rec('createInvoice', { id: 'INV2-ABC', href: 'https://api/v2/invoicing/invoices/INV2-ABC' }),
    sendInvoice: rec('sendInvoice', {}),
    getInvoice: rec('getInvoice', { status: 'SENT', detail: { metadata: { recipient_view_url: 'https://sandbox.paypal.com/invoice/p/#ABC' } } }),
    remindInvoice: rec('remindInvoice', {}),
    recordPayment: rec('recordPayment', {}),
    createOrder: rec('createOrder', { id: 'ORDER-1', status: 'PAYER_ACTION_REQUIRED', approveUrl: 'https://sandbox.paypal.com/checkoutnow?token=ORDER-1' }),
    captureOrder: rec('captureOrder', { purchase_units: [{ payments: { captures: [{ id: 'CAP-1', status: 'COMPLETED', amount: { value: '1200.00' } }] } }] }),
    getOrder: rec('getOrder', { purchase_units: [] }),
    refundCapture: rec('refundCapture', { id: 'REF-1' }),
    acceptClaim: rec('acceptClaim', {}),
    provideEvidence: rec('provideEvidence', {}),
    sendMessage: rec('sendMessage', {}),
    verifyWebhookSignature: rec('verifyWebhookSignature', true),
    ...overrides,
  };
  return api;
}

/** Scripted Claude: each entry is a response `content` array (+ optional stop_reason). */
export function fakeClaude(script) {
  const requests = [];
  let i = 0;
  return {
    requests,
    messages: {
      async create(req) {
        requests.push(structuredClone(req));
        const step = script[Math.min(i++, script.length - 1)];
        const content = Array.isArray(step) ? step : step.content;
        const stop_reason = step.stop_reason || (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
        return { content, stop_reason, usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  };
}

export const spendInput = (over = {}) => ({
  vendor_name: 'GPU Cloud', vendor_email: 'gpu@example.com', category: 'gpu', amount_usd: 20, justification: 'Render frames', expected_result: '48 frames', ...over,
});
