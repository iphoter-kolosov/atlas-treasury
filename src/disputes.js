// Human decision on a dispute. The analyst only recommends; PayPal is called here, after an explicit owner click.

import { one, update } from './db.js';
import { TreasuryError, logEvent, requirePaypal } from './treasury.js';

export const DISPUTE_DECISIONS = ['accept_claim', 'provide_evidence', 'offer_refund', 'dismiss'];

export async function decideDispute(ctx, id, decision, { note = '', message = '' } = {}) {
  if (!DISPUTE_DECISIONS.includes(decision)) throw new TreasuryError(`decision must be one of ${DISPUTE_DECISIONS.join(', ')}`);
  const d = one(ctx.db, 'SELECT * FROM disputes WHERE id=?', id);
  if (!d) throw new TreasuryError('Unknown dispute', 404);
  if (d.human_decision) throw new TreasuryError(`Already decided: ${d.human_decision}`, 409);
  const text = (message || note || '').trim();

  if (decision !== 'dismiss') {
    const paypal = requirePaypal(ctx);
    if (decision === 'accept_claim') await paypal.acceptClaim(d.paypal_dispute_id, text || 'Accepting the claim.');
    else if (decision === 'provide_evidence') {
      if (!text) throw new TreasuryError('provide_evidence needs a message with the evidence notes');
      await paypal.provideEvidence(d.paypal_dispute_id, text);
    } else {
      if (!d.linked_capture_id) throw new TreasuryError('No linked capture to refund; use accept_claim instead');
      await paypal.refundCapture(d.linked_capture_id, { amountCents: d.amount_cents, note: text || 'Refund offered to resolve the dispute.', requestId: `refund-${d.id}` });
    }
  }
  update(ctx.db, 'disputes', id, { human_decision: decision });
  logEvent(ctx, 'human', `dispute.${decision}`, { dispute_id: id, note: text }, { refs: [id, d.paypal_dispute_id] });
  return one(ctx.db, 'SELECT * FROM disputes WHERE id=?', id);
}
