import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPalError, createPayPalClient } from '../src/paypal.js';

function mockFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const key = `${init.method || 'GET'} ${u.pathname}`;
    calls.push({ key, url, init, body: init.body && init.headers?.['Content-Type'] === 'application/json' ? JSON.parse(init.body) : init.body });
    const handler = routes[key];
    if (!handler) return new Response(JSON.stringify({ name: 'NOT_FOUND', message: key }), { status: 404 });
    const out = typeof handler === 'function' ? handler(calls.at(-1)) : handler;
    const wrapped = out && typeof out === 'object' && 'body' in out; // {status, body} form is for error responses
    return new Response(JSON.stringify(wrapped ? out.body : out), { status: wrapped ? out.status || 200 : 200 });
  };
  fn.calls = calls;
  return fn;
}
const tokenRoute = { 'POST /v1/oauth2/token': { access_token: 'tok', expires_in: 3600 } };
const client = (routes, extra = {}) => {
  const fetchImpl = mockFetch({ ...tokenRoute, ...routes });
  return { fetchImpl, pp: createPayPalClient({ clientId: 'id', clientSecret: 'sec', baseUrl: 'https://api.test/', fetchImpl, ...extra }) };
};

test('OAuth token is fetched once and cached; Basic auth header is built from the credentials', async () => {
  const { fetchImpl, pp } = client({ 'GET /v2/invoicing/invoices/I1': { status: 'SENT' } });
  await pp.getInvoice('I1');
  await pp.getInvoice('I1');
  const tokenCalls = fetchImpl.calls.filter((c) => c.key === 'POST /v1/oauth2/token');
  assert.equal(tokenCalls.length, 1);
  assert.equal(tokenCalls[0].init.headers.Authorization, `Basic ${Buffer.from('id:sec').toString('base64')}`);
  assert.equal(fetchImpl.calls.at(-1).init.headers.Authorization, 'Bearer tok');
});

test('token is refreshed after expiry', async () => {
  let t = 0;
  const { fetchImpl, pp } = client({ 'GET /v2/invoicing/invoices/I1': {} , 'POST /v1/oauth2/token': { access_token: 'tok', expires_in: 100 } }, { now: () => t });
  await pp.getInvoice('I1');
  t = 200_000;
  await pp.getInvoice('I1');
  assert.equal(fetchImpl.calls.filter((c) => c.key === 'POST /v1/oauth2/token').length, 2);
});

test('every POST carries PayPal-Request-Id; GET does not; explicit id is honoured', async () => {
  const { fetchImpl, pp } = client({
    'POST /v2/invoicing/invoices/I1/remind': {}, 'GET /v2/invoicing/invoices/I1': {}, 'POST /v2/checkout/orders': { id: 'O1', status: 'CREATED', links: [{ rel: 'payer-action', href: 'https://pay/o1' }] },
  });
  await pp.remindInvoice('I1');
  await pp.getInvoice('I1');
  const order = await pp.createOrder({ taskId: 't1', invoiceId: 'ord_1', description: 'd', amountCents: 12345, returnUrl: 'r', cancelUrl: 'c', requestId: 'fixed-id' });
  const post = fetchImpl.calls.find((c) => c.key === 'POST /v2/invoicing/invoices/I1/remind');
  assert.match(post.init.headers['PayPal-Request-Id'], /^[0-9a-f-]{36}$/);
  assert.equal(fetchImpl.calls.find((c) => c.key === 'GET /v2/invoicing/invoices/I1').init.headers['PayPal-Request-Id'], undefined);
  const o = fetchImpl.calls.find((c) => c.key === 'POST /v2/checkout/orders');
  assert.equal(o.init.headers['PayPal-Request-Id'], 'fixed-id');
  assert.equal(o.body.intent, 'CAPTURE');
  assert.equal(o.body.purchase_units[0].custom_id, 't1');
  assert.equal(o.body.purchase_units[0].invoice_id, 'ord_1');
  assert.deepEqual(o.body.purchase_units[0].amount, { currency_code: 'USD', value: '123.45' });
  assert.equal(order.approveUrl, 'https://pay/o1');
});

test('errors become PayPalError with status, debug_id and details', async () => {
  const { pp } = client({ 'GET /v2/invoicing/invoices/BAD': { status: 422, body: { name: 'UNPROCESSABLE', message: 'nope', debug_id: 'dbg123', details: [{ issue: 'X' }] } } });
  await assert.rejects(pp.getInvoice('BAD'), (e) => {
    assert.ok(e instanceof PayPalError);
    assert.equal(e.status, 422);
    assert.equal(e.debugId, 'dbg123');
    assert.deepEqual(e.details, [{ issue: 'X' }]);
    return true;
  });
});

test('auth failure is a PayPalError too', async () => {
  const fetchImpl = mockFetch({ 'POST /v1/oauth2/token': { status: 401, body: { error_description: 'Client Authentication failed' } } });
  const pp = createPayPalClient({ clientId: 'x', clientSecret: 'y', baseUrl: 'https://api.test', fetchImpl });
  await assert.rejects(pp.getInvoice('I'), /Client Authentication failed/);
});

test('createInvoice builds the v2 invoicing payload and extracts the id from href', async () => {
  const { fetchImpl, pp } = client({ 'POST /v2/invoicing/invoices': { rel: 'self', href: 'https://api.test/v2/invoicing/invoices/INV2-XYZ', method: 'GET' } });
  const r = await pp.createInvoice({
    invoiceNumber: '0007', client: { name: 'Ada Lovelace', email: 'ada@example.com' }, items: [{ name: 'Video', quantity: 2, unit_amount_cents: 50000 }], dueInDays: 14, note: 'thanks',
  });
  assert.equal(r.id, 'INV2-XYZ');
  const b = fetchImpl.calls.find((c) => c.key === 'POST /v2/invoicing/invoices').body;
  assert.equal(b.detail.invoice_number, '0007');
  assert.equal(b.detail.payment_term.term_type, 'NET_14');
  assert.equal(b.primary_recipients[0].billing_info.email_address, 'ada@example.com');
  assert.deepEqual(b.primary_recipients[0].billing_info.name, { given_name: 'Ada', surname: 'Lovelace' });
  assert.deepEqual(b.items[0], { name: 'Video', quantity: '2', unit_amount: { currency_code: 'USD', value: '500.00' } });
});

test('due immediately maps to DUE_ON_RECEIPT', async () => {
  const { fetchImpl, pp } = client({ 'POST /v2/invoicing/invoices': { href: 'https://x/INV2-1' } });
  await pp.createInvoice({ invoiceNumber: '1', client: { name: 'A', email: 'a@b.co' }, items: [{ name: 'x', unit_amount_cents: 100 }], dueInDays: 0 });
  assert.equal(fetchImpl.calls.at(-1).body.detail.payment_term.term_type, 'DUE_ON_RECEIPT');
});

test('createPayout uses sender_item_id for correlation and the batch id as idempotency key', async () => {
  const { fetchImpl, pp } = client({ 'POST /v1/payments/payouts': { batch_header: { payout_batch_id: 'PB1', batch_status: 'PENDING' } } });
  await pp.createPayout([{ receiver: 'v@example.com', amountCents: 4500, senderItemId: 'sr_1', note: 'n' }], 'atlas-sr_1');
  const c = fetchImpl.calls.find((x) => x.key === 'POST /v1/payments/payouts');
  assert.equal(c.init.headers['PayPal-Request-Id'], 'atlas-sr_1');
  assert.equal(c.body.sender_batch_header.sender_batch_id, 'atlas-sr_1');
  assert.deepEqual(c.body.items[0], { recipient_type: 'EMAIL', receiver: 'v@example.com', note: 'n', sender_item_id: 'sr_1', amount: { currency: 'USD', value: '45.00' } });
});

test('refundCapture, recordPayment, dispute calls hit the documented paths', async () => {
  const { fetchImpl, pp } = client({
    'POST /v2/payments/captures/C1/refund': { id: 'R1' }, 'POST /v2/invoicing/invoices/I1/payments': {},
    'GET /v1/customer/disputes/PP-D-1': { dispute_id: 'PP-D-1' }, 'POST /v1/customer/disputes/PP-D-1/accept-claim': {},
    'POST /v1/customer/disputes/PP-D-1/provide-evidence': {}, 'POST /v1/customer/disputes/PP-D-1/send-message': {},
  });
  await pp.refundCapture('C1', { amountCents: 1000, note: 'sorry' });
  await pp.recordPayment('I1', { amountCents: 2500 });
  await pp.getDispute('PP-D-1');
  await pp.acceptClaim('PP-D-1', 'ok');
  await pp.provideEvidence('PP-D-1', 'delivered');
  await pp.sendMessage('PP-D-1', 'hello');
  const byKey = Object.fromEntries(fetchImpl.calls.map((c) => [c.key, c.body]));
  assert.deepEqual(byKey['POST /v2/payments/captures/C1/refund'].amount, { currency_code: 'USD', value: '10.00' });
  assert.equal(byKey['POST /v2/invoicing/invoices/I1/payments'].method, 'OTHER');
  assert.equal(byKey['POST /v1/customer/disputes/PP-D-1/provide-evidence'].evidences[0].notes, 'delivered');
  assert.equal(byKey['POST /v1/customer/disputes/PP-D-1/send-message'].message, 'hello');
});

test('verifyWebhookSignature posts the transmission headers and parsed event, returns true only on SUCCESS', async () => {
  let status = 'SUCCESS';
  const { fetchImpl, pp } = client({ 'POST /v1/notifications/verify-webhook-signature': () => ({ verification_status: status }) });
  const headers = new Headers({
    'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.paypal.com/cert', 'paypal-transmission-id': 'tid', 'paypal-transmission-sig': 'sig', 'paypal-transmission-time': '2026-10-28T00:00:00Z',
  });
  const raw = JSON.stringify({ id: 'WH-1', event_type: 'X' });
  assert.equal(await pp.verifyWebhookSignature(headers, raw, 'WHID'), true);
  const b = fetchImpl.calls.at(-1).body;
  assert.equal(b.webhook_id, 'WHID');
  assert.equal(b.transmission_id, 'tid');
  assert.deepEqual(b.webhook_event, { id: 'WH-1', event_type: 'X' });
  status = 'FAILURE';
  assert.equal(await pp.verifyWebhookSignature(headers, raw, 'WHID'), false);
});

test('ensureWebhook returns the existing hook or creates one', async () => {
  let existing = [{ id: 'WH-OLD', url: 'https://t/webhooks/paypal' }];
  const { fetchImpl, pp } = client({
    'GET /v1/notifications/webhooks': () => ({ webhooks: existing }), 'POST /v1/notifications/webhooks': { id: 'WH-NEW' },
  });
  assert.deepEqual(await pp.ensureWebhook('https://t/webhooks/paypal', ['A']), { id: 'WH-OLD', created: false });
  existing = [];
  assert.deepEqual(await pp.ensureWebhook('https://t/webhooks/paypal', ['A', 'B']), { id: 'WH-NEW', created: true });
  assert.deepEqual(fetchImpl.calls.at(-1).body.event_types, [{ name: 'A' }, { name: 'B' }]);
});
