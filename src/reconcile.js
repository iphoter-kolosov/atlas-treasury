// Sandbox webhooks can be minutes late (or never arrive on localhost). The reconciler polls PayPal for anything still
// pending, so the UI never gets stuck. It calls the same idempotent record* functions as the webhook handler.

import { all } from './db.js';
import { toCents } from './money.js';
import { logEvent, recordCaptureCompleted, recordInvoicePaid, settlePayout } from './treasury.js';

export async function reconcile(ctx) {
  if (!ctx.paypal) return { skipped: 'PayPal not configured', invoices: 0, payouts: 0, orders: 0 };
  const result = { invoices: 0, payouts: 0, orders: 0, errors: [] };
  const guard = async (label, fn) => {
    try { await fn(); } catch (e) { result.errors.push(`${label}: ${e.message}`); ctx.log?.('warn', `reconcile ${label}: ${e.message}`); }
  };

  for (const inv of all(ctx.db, "SELECT * FROM invoices WHERE status IN ('sent','created')")) {
    await guard(`invoice ${inv.id}`, async () => {
      const remote = await ctx.paypal.getInvoice(inv.paypal_invoice_id);
      if (['PAID', 'MARKED_AS_PAID'].includes(remote.status) && recordInvoicePaid(ctx, inv.paypal_invoice_id)) {
        result.invoices += 1;
        logEvent(ctx, 'paypal_webhook', 'reconciler.invoice.paid', { invoice_id: inv.id }, { refs: [inv.id, inv.paypal_invoice_id] });
      }
    });
  }

  const batches = all(ctx.db, "SELECT DISTINCT payout_batch_id b FROM spend_requests WHERE status='approved' AND payout_batch_id IS NOT NULL");
  for (const { b } of batches) {
    await guard(`payout ${b}`, async () => {
      const remote = await ctx.paypal.getPayoutBatch(b);
      for (const item of remote.items || []) {
        const srId = item.payout_item?.sender_item_id;
        if (!srId) continue;
        const st = item.transaction_status;
        if (st === 'SUCCESS' && settlePayout(ctx, srId, 'paid', { itemId: item.payout_item_id })) result.payouts += 1;
        else if (st === 'UNCLAIMED' && settlePayout(ctx, srId, 'unclaimed', { itemId: item.payout_item_id, reason: item.errors?.message || st })) result.payouts += 1;
        else if (['FAILED', 'RETURNED', 'BLOCKED', 'REFUNDED', 'REVERSED'].includes(st) && settlePayout(ctx, srId, 'failed', { itemId: item.payout_item_id, reason: item.errors?.message || st })) result.payouts += 1;
      }
    });
  }

  for (const o of all(ctx.db, "SELECT * FROM orders WHERE status='created'")) {
    await guard(`order ${o.id}`, async () => {
      const remote = await ctx.paypal.getOrder(o.paypal_order_id);
      const cap = remote.purchase_units?.[0]?.payments?.captures?.[0];
      if (cap?.status === 'COMPLETED' && recordCaptureCompleted(ctx, { captureId: cap.id, orderId: o.paypal_order_id, amountCents: toCents(cap.amount.value) })) result.orders += 1;
    });
  }
  return result;
}
