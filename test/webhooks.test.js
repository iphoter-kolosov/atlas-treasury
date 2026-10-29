import test from 'node:test';
import assert from 'node:assert/strict';
import { all, one } from '../src/db.js';
import { handleWebhook, WebhookRejected } from '../src/webhooks.js';
import { reconcile } from '../src/reconcile.js';
import { createCheckoutLink, createSpendRequest, createTaskInvoice, decideApproval, upsertDispute } from '../src/treasury.js';
import { fakePayPal, makeCtx, spendInput } from './helpers.js';

const send = (ctx, event, headers = {}) => handleWebhook(ctx, new Headers(headers), JSON.stringify(event));
const ev = (id, event_type, resource) => ({ id, event_type, resource });

test('INVOICING.INVOICE.PAID books income once, marks invoice and task paid; replay is a duplicate', async () => {
  const ctx = makeCtx({ paypal: fakePayPal() });
  await createTaskInvoice(ctx, 'task_launch_video', {});
  const e = ev('WH-1', 'INVOICING.INVOICE.PAID', { invoice: { id: 'INV2-ABC', amount: { value: '1200.00' } } });
  assert.equal((await send(ctx, e)).status, 'processed');
  assert.equal((await send(ctx, e)).status, 'duplicate');
  const led = all(ctx.db, 'SELECT * FROM ledger');
  assert.equal(led.length, 1);
  assert.equal(led[0].kind, 'income');
  assert.equal(led[0].amount_cents, 120000);
  assert.equal(led[0].agent_id, 'vega');
  assert.equal(one(ctx.db, 'SELECT status FROM invoices').status, 'paid');
  assert.ok(one(ctx.db, "SELECT paid_at FROM tasks WHERE id='task_launch_video'").paid_at);
  assert.equal(all(ctx.db, "SELECT * FROM events WHERE source='paypal_webhook'").length, 1, 'duplicate not stored twice');
});

test('same payment seen by webhook AND reconciler is booked once', async () => {
  const pp = fakePayPal({ getInvoice: async () => ({ status: 'PAID' }) });
  const ctx = makeCtx({ paypal: pp });
  await createTaskInvoice(ctx, 'task_launch_video', {});
  await send(ctx, ev('WH-2', 'INVOICING.INVOICE.PAID', { invoice: { id: 'INV2-ABC' } }));
  const r = await reconcile(ctx);
  assert.equal(r.invoices, 0);
  assert.equal(all(ctx.db, "SELECT * FROM ledger WHERE kind='income'").length, 1);
});

test('reconciler alone un-sticks an invoice when the webhook never arrives', async () => {
  const pp = fakePayPal({ getInvoice: async () => ({ status: 'PAID' }) });
  const ctx = makeCtx({ paypal: pp });
  await createTaskInvoice(ctx, 'task_launch_video', {});
  const r = await reconcile(ctx);
  assert.equal(r.invoices, 1);
  assert.equal(one(ctx.db, 'SELECT amount_cents FROM ledger').amount_cents, 120000);
});

test('PAYMENT.CAPTURE.COMPLETED matches the order by order_id, books income; REFUNDED books a refund linked to the capture', async () => {
  const ctx = makeCtx({ paypal: fakePayPal() });
  const order = await createCheckoutLink(ctx, 'task_gpu_render');
  assert.match(order.approve_url, /checkoutnow/);
  const cap = ev('WH-3', 'PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-9', custom_id: 'task_gpu_render', amount: { value: '650.00' }, supplementary_data: { related_ids: { order_id: 'ORDER-1' } } });
  assert.equal((await send(ctx, cap)).status, 'processed');
  assert.equal(one(ctx.db, 'SELECT * FROM orders').status, 'captured');
  assert.equal(one(ctx.db, 'SELECT capture_id FROM orders').capture_id, 'CAP-9');
  const ref = ev('WH-4', 'PAYMENT.CAPTURE.REFUNDED', { id: 'REF-9', amount: { value: '100.00' }, links: [{ rel: 'up', href: 'https://api/v2/payments/captures/CAP-9' }] });
  assert.equal((await send(ctx, ref)).status, 'processed');
  const rows = all(ctx.db, 'SELECT kind, amount_cents, agent_id, task_id FROM ledger ORDER BY kind').map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { kind: 'income', amount_cents: 65000, agent_id: 'orion', task_id: 'task_gpu_render' },
    { kind: 'refund', amount_cents: -10000, agent_id: 'orion', task_id: 'task_gpu_render' },
  ]);
});

test('payout item events settle the spend request via sender_item_id; failure frees the budget', async () => {
  const ctx = makeCtx({ paypal: fakePayPal() });
  await createSpendRequest(ctx, 'vega', 'task_launch_video', spendInput({ amount_usd: 45, category: 'voice' }));
  const sr = one(ctx.db, 'SELECT approval_token AS token, id FROM spend_requests');
  await decideApproval(ctx, sr.token, 'approve');
  const ok = ev('WH-5', 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED', { payout_item_id: 'PI-1', payout_batch_id: 'PB', sender_item_id: sr.id });
  assert.equal((await send(ctx, ok)).status, 'processed');
  assert.equal(one(ctx.db, 'SELECT status, payout_item_id FROM spend_requests').status, 'paid');
  assert.equal(one(ctx.db, 'SELECT status FROM ledger').status, 'completed');

  // second request that fails
  await createSpendRequest(ctx, 'vega', 'task_launch_video', spendInput({ amount_usd: 44, category: 'voice', vendor_email: 'b@example.com' }));
  const sr2 = one(ctx.db, "SELECT approval_token AS token, id FROM spend_requests WHERE status='pending'");
  await decideApproval(ctx, sr2.token, 'approve');
  await send(ctx, ev('WH-6', 'PAYMENT.PAYOUTS-ITEM.RETURNED', { payout_item_id: 'PI-2', sender_item_id: sr2.id }));
  assert.equal(one(ctx.db, 'SELECT status FROM spend_requests WHERE id=?', sr2.id).status, 'failed');
  assert.equal(one(ctx.db, "SELECT status FROM ledger WHERE spend_request_id=?", sr2.id).status, 'failed');
});

test('UNCLAIMED keeps the payout as money out (held by PayPal 30 days), not a failure; RETURNED later fails it', async () => {
  const ctx = makeCtx({ paypal: fakePayPal() });
  await createSpendRequest(ctx, 'vega', 'task_launch_video', spendInput({ amount_usd: 45, category: 'voice' }));
  const sr = one(ctx.db, 'SELECT approval_token AS token, id FROM spend_requests');
  await decideApproval(ctx, sr.token, 'approve');
  await send(ctx, ev('WH-U1', 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED', { payout_item_id: 'PI-U', sender_item_id: sr.id }));
  assert.equal(one(ctx.db, 'SELECT status FROM spend_requests').status, 'unclaimed');
  assert.equal(one(ctx.db, 'SELECT status FROM ledger').status, 'unclaimed');
  await send(ctx, ev('WH-U2', 'PAYMENT.PAYOUTS-ITEM.RETURNED', { payout_item_id: 'PI-U', sender_item_id: sr.id }));
  assert.equal(one(ctx.db, 'SELECT status FROM spend_requests').status, 'failed');
});

test('PAYOUTSBATCH.DENIED fails every request in the batch; reconciler settles payouts from batch items', async () => {
  const pp = fakePayPal();
  const ctx = makeCtx({ paypal: pp });
  await createSpendRequest(ctx, 'vega', 'task_launch_video', spendInput({ amount_usd: 45, category: 'voice' }));
  const sr = one(ctx.db, 'SELECT approval_token AS token, id FROM spend_requests');
  await decideApproval(ctx, sr.token, 'approve');
  const batchId = one(ctx.db, 'SELECT payout_batch_id b FROM spend_requests').b;
  pp.getPayoutBatch = async () => ({ items: [{ transaction_status: 'SUCCESS', payout_item_id: 'PI-7', payout_item: { sender_item_id: sr.id } }] });
  const r = await reconcile(ctx);
  assert.equal(r.payouts, 1);
  assert.equal(one(ctx.db, 'SELECT status FROM spend_requests').status, 'paid');
  // a denied batch after success must not flip a paid request
  await send(ctx, ev('WH-7', 'PAYMENT.PAYOUTSBATCH.DENIED', { batch_header: { payout_batch_id: batchId } }));
  assert.equal(one(ctx.db, 'SELECT status FROM spend_requests').status, 'paid');
});

test('dispute events upsert a dispute, hold funds once, release on resolve, and trigger the analyst hook', async () => {
  const ctx = makeCtx({ paypal: fakePayPal() });
  const seen = [];
  ctx.onDispute = (d) => seen.push(d.paypal_dispute_id);
  await createCheckoutLink(ctx, 'task_gpu_render');
  await send(ctx, ev('WH-8', 'PAYMENT.CAPTURE.COMPLETED', { id: 'CAP-D', amount: { value: '650.00' }, supplementary_data: { related_ids: { order_id: 'ORDER-1' } } }));
  const body = { dispute_id: 'PP-D-1', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', status: 'OPEN', dispute_amount: { value: '650.00' }, disputed_transactions: [{ seller_transaction_id: 'CAP-D' }] };
  await send(ctx, ev('WH-9', 'CUSTOMER.DISPUTE.CREATED', body));
  await send(ctx, ev('WH-10', 'CUSTOMER.DISPUTE.UPDATED', body));
  const d = one(ctx.db, 'SELECT * FROM disputes');
  assert.equal(d.linked_task_id, 'task_gpu_render');
  assert.equal(d.amount_cents, 65000);
  assert.equal(all(ctx.db, "SELECT * FROM ledger WHERE kind='dispute_hold'").length, 1);
  await send(ctx, ev('WH-11', 'CUSTOMER.DISPUTE.RESOLVED', { ...body, status: 'RESOLVED' }));
  assert.equal(one(ctx.db, 'SELECT status FROM disputes').status, 'RESOLVED');
  assert.equal(all(ctx.db, "SELECT * FROM ledger WHERE kind='dispute_release'").length, 1);
  assert.equal(seen.length, 3);
  assert.equal(all(ctx.db, 'SELECT * FROM disputes').length, 1);
});

test('signature is required when PAYPAL_WEBHOOK_ID is set: invalid -> rejected and NOT stored; valid -> verified=1', async () => {
  const pp = fakePayPal({ verifyWebhookSignature: async () => false });
  const ctx = makeCtx({ paypal: pp, env: { PAYPAL_WEBHOOK_ID: 'WHID' } });
  const e = ev('WH-12', 'INVOICING.INVOICE.PAID', { invoice: { id: 'X' } });
  await assert.rejects(send(ctx, e), WebhookRejected);
  assert.equal(all(ctx.db, 'SELECT * FROM events').length, 0);
  pp.verifyWebhookSignature = async () => true;
  const r = await send(ctx, e);
  assert.equal(r.verified, true);
  assert.equal(one(ctx.db, 'SELECT verified FROM events').verified, 1);
});

test('webhook id set but no PayPal client: refuse rather than trust', async () => {
  const ctx = makeCtx({ paypal: null, env: { PAYPAL_WEBHOOK_ID: 'WHID' } });
  await assert.rejects(send(ctx, ev('WH-13', 'X', {})), WebhookRejected);
});

test('no PAYPAL_WEBHOOK_ID: accepted as UNVERIFIED (verified=0) with a loud warning', async () => {
  const ctx = makeCtx({ paypal: null });
  const r = await send(ctx, ev('WH-14', 'SOMETHING.ELSE', {}));
  assert.equal(r.verified, false);
  assert.equal(r.status, 'ignored');
  assert.equal(one(ctx.db, 'SELECT verified FROM events').verified, 0);
  assert.ok(ctx.logs.some(([lvl, m]) => lvl === 'warn' && /UNVERIFIED/.test(m)));
});

test('garbage bodies are rejected', async () => {
  const ctx = makeCtx();
  await assert.rejects(handleWebhook(ctx, new Headers(), 'not json'), WebhookRejected);
  await assert.rejects(handleWebhook(ctx, new Headers(), '{"foo":1}'), WebhookRejected);
});

test('upsertDispute works directly and links nothing when the capture is unknown', () => {
  const ctx = makeCtx();
  const d = upsertDispute(ctx, { dispute_id: 'PP-D-2', reason: 'X', status: 'OPEN', dispute_amount: { value: '5.00' }, disputed_transactions: [{ seller_transaction_id: 'NOPE' }] });
  assert.equal(d.linked_task_id, null);
});
