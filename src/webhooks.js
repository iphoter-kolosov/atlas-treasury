// PayPal webhooks -> ledger. Every event is stored verbatim (audit), deduplicated on event.id, and only then mapped.

import { all, one } from './db.js';
import { toCents } from './money.js';
import {
  logEvent, recordCaptureCompleted, recordInvoicePaid, recordRefund, settlePayout, upsertDispute,
} from './treasury.js';

export class WebhookRejected extends Error {
  constructor(message) { super(message); this.name = 'WebhookRejected'; this.status = 400; }
}

const upLink = (resource) => (resource.links || []).find((l) => l.rel === 'up')?.href?.split('/').filter(Boolean).pop();

/** Maps one verified/accepted event onto the ledger. Pure DB work; safe to call twice. */
export function applyEvent(ctx, event) {
  const r = event.resource || {};
  switch (event.event_type) {
    case 'INVOICING.INVOICE.PAID': {
      const id = r.invoice?.id || r.id;
      const amount = r.invoice?.amount?.value ?? r.amount?.value;
      return recordInvoicePaid(ctx, id, { amountCents: amount ? toCents(amount) : undefined });
    }
    case 'PAYMENT.CAPTURE.COMPLETED':
      return recordCaptureCompleted(ctx, {
        captureId: r.id, orderId: r.supplementary_data?.related_ids?.order_id, customId: r.custom_id, amountCents: toCents(r.amount.value),
      });
    case 'PAYMENT.CAPTURE.REFUNDED':
      return recordRefund(ctx, { refundId: r.id, captureId: upLink(r), amountCents: toCents(r.amount.value) });
    case 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED':
      return settlePayout(ctx, r.payout_item?.sender_item_id || r.sender_item_id, 'paid', { itemId: r.payout_item_id });
    case 'PAYMENT.PAYOUTS-ITEM.FAILED':
    case 'PAYMENT.PAYOUTS-ITEM.UNCLAIMED':
    case 'PAYMENT.PAYOUTS-ITEM.RETURNED':
      return settlePayout(ctx, r.payout_item?.sender_item_id || r.sender_item_id, 'failed', {
        itemId: r.payout_item_id, reason: r.errors?.message || event.event_type,
      });
    case 'PAYMENT.PAYOUTSBATCH.DENIED': {
      const batchId = r.batch_header?.payout_batch_id;
      let changed = false;
      for (const sr of all(ctx.db, 'SELECT id FROM spend_requests WHERE payout_batch_id=?', batchId)) {
        changed = settlePayout(ctx, sr.id, 'failed', { reason: 'Payout batch denied' }) || changed;
      }
      return changed;
    }
    case 'PAYMENT.PAYOUTSBATCH.SUCCESS':
      return false; // item events carry the per-request truth; the batch event is audit-only
    case 'CUSTOMER.DISPUTE.CREATED':
    case 'CUSTOMER.DISPUTE.UPDATED':
    case 'CUSTOMER.DISPUTE.RESOLVED': {
      const dispute = upsertDispute(ctx, r);
      ctx.onDispute?.(dispute); // analyst runs out of band; never blocks the 200 to PayPal
      return true;
    }
    default:
      return false;
  }
}

function refsFor(event) {
  const r = event.resource || {};
  return [r.id, r.invoice?.id, r.dispute_id, r.payout_item_id, r.payout_batch_id, r.batch_header?.payout_batch_id,
    r.custom_id, r.supplementary_data?.related_ids?.order_id, r.payout_item?.sender_item_id, r.sender_item_id, upLink(r)];
}

/**
 * @returns {{status: 'duplicate'|'processed'|'ignored', verified: boolean, eventId: string}}
 * @throws WebhookRejected when a signature is required and invalid.
 */
export async function handleWebhook(ctx, headers, rawBody) {
  let event;
  try { event = JSON.parse(rawBody); } catch { throw new WebhookRejected('Body is not JSON'); }
  if (!event?.id || !event?.event_type) throw new WebhookRejected('Not a PayPal event');

  let verified = false;
  const webhookId = ctx.config.paypal.webhookId;
  if (webhookId) {
    if (!ctx.paypal) throw new WebhookRejected('PAYPAL_WEBHOOK_ID is set but PayPal credentials are missing; cannot verify signature');
    verified = await ctx.paypal.verifyWebhookSignature(headers, rawBody, webhookId).catch((e) => {
      ctx.log?.('error', `webhook verification call failed: ${e.message}`);
      return false;
    });
    if (!verified) throw new WebhookRejected('Invalid webhook signature');
  } else {
    // Local/sandbox convenience only. Loud on purpose: an unsigned webhook can forge income.
    ctx.log?.('warn', `PAYPAL_WEBHOOK_ID empty: accepting UNVERIFIED webhook ${event.id} (${event.event_type})`);
  }

  const { inserted } = logEvent(ctx, 'paypal_webhook', event.event_type, event, { verified, refs: refsFor(event), id: event.id });
  if (!inserted) return { status: 'duplicate', verified, eventId: event.id };
  const changed = applyEvent(ctx, event);
  return { status: changed ? 'processed' : 'ignored', verified, eventId: event.id };
}

export const eventCount = (ctx) => one(ctx.db, 'SELECT COUNT(*) c FROM events').c;
