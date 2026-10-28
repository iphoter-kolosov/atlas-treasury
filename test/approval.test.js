import test from 'node:test';
import assert from 'node:assert/strict';
import { all, one, run } from '../src/db.js';
import { NotConfiguredError } from '../src/config.js';
import { PayPalError } from '../src/paypal.js';
import {
  TreasuryError, agentMonthSpent, approvalCard, createSpendRequest, decideApproval, knownVendors, listApprovals, parseSpendInput, settlePayout,
} from '../src/treasury.js';
import { fakePayPal, makeCtx, spendInput } from './helpers.js';

const TASK = 'task_launch_video';

test('over-limit request waits for approval, creates a token, moves no money', async () => {
  const pp = fakePayPal();
  const ctx = makeCtx({ paypal: pp });
  const sr = await createSpendRequest(ctx, 'vega', TASK, spendInput({ amount_usd: 45, category: 'voice' }));
  assert.equal(sr.policy_verdict, 'needs_approval');
  assert.equal(sr.status, 'pending');
  assert.ok(sr.policy_reasons.some((r) => /per-payment limit/.test(r)));
  assert.equal(pp.calls.filter((c) => c.name === 'createPayout').length, 0);
  assert.equal(all(ctx.db, 'SELECT * FROM ledger').length, 0);
  assert.equal(sr.approval_token, undefined, 'public view must not leak the token');
  assert.equal(listApprovals(ctx).length, 1);
  assert.equal(listApprovals(ctx)[0].token, undefined);
  assert.equal(listApprovals(ctx, { includeTokens: true })[0].state, 'pending');
});

test('approve -> payout executes with sender_item_id, ledger spend is pending, budget counts it', async () => {
  const pp = fakePayPal();
  const ctx = makeCtx({ paypal: pp });
  await createSpendRequest(ctx, 'vega', TASK, spendInput({ amount_usd: 45, category: 'voice' }));
  const { token, id } = one(ctx.db, 'SELECT approval_token AS token, id FROM spend_requests');
  const card = await decideApproval(ctx, token, 'approve', 'ok');
  assert.equal(card.state, 'approved');
  const payout = pp.calls.find((c) => c.name === 'createPayout');
  assert.deepEqual(payout.args[0][0], { receiver: 'gpu@example.com', amountCents: 4500, currency: 'USD', senderItemId: id, note: payout.args[0][0].note });
  assert.equal(payout.args[1], `atlas-${id}`);
  const led = one(ctx.db, 'SELECT * FROM ledger');
  assert.equal(led.kind, 'spend');
  assert.equal(led.amount_cents, -4500);
  assert.equal(led.status, 'pending');
  assert.equal(led.paypal_ref_type, 'payout');
  assert.equal(agentMonthSpent(ctx, 'vega'), 4500);
  // webhook/reconciler settles it; second settle is a no-op
  assert.equal(settlePayout(ctx, id, 'paid', { itemId: 'ITEM1' }), true);
  assert.equal(settlePayout(ctx, id, 'paid', { itemId: 'ITEM1' }), false);
  assert.equal(one(ctx.db, 'SELECT status FROM ledger').status, 'completed');
  assert.ok(knownVendors(ctx).has('gpu@example.com'), 'paid vendor becomes known');
});

test('approval token is single-use', async () => {
  const ctx = makeCtx({ paypal: fakePayPal() });
  await createSpendRequest(ctx, 'vega', TASK, spendInput({ amount_usd: 45, category: 'voice' }));
  const { token } = one(ctx.db, 'SELECT approval_token AS token FROM spend_requests');
  await decideApproval(ctx, token, 'approve');
  await assert.rejects(decideApproval(ctx, token, 'approve'), (e) => e instanceof TreasuryError && e.status === 409);
  await assert.rejects(decideApproval(ctx, token, 'reject'), (e) => e.status === 409);
  assert.equal(all(ctx.db, 'SELECT * FROM ledger').length, 1);
});

test('concurrent approve clicks pay once', async () => {
  const pp = fakePayPal();
  const ctx = makeCtx({ paypal: pp });
  await createSpendRequest(ctx, 'vega', TASK, spendInput({ amount_usd: 45, category: 'voice' }));
  const { token } = one(ctx.db, 'SELECT approval_token AS token FROM spend_requests');
  const results = await Promise.allSettled([decideApproval(ctx, token, 'approve'), decideApproval(ctx, token, 'approve')]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(pp.calls.filter((c) => c.name === 'createPayout').length, 1);
});

test('expired token (48 h) is refused', async () => {
  const ctx = makeCtx({ paypal: fakePayPal() });
  await createSpendRequest(ctx, 'vega', TASK, spendInput({ amount_usd: 45, category: 'voice' }));
  const { token } = one(ctx.db, 'SELECT approval_token AS token FROM spend_requests');
  run(ctx.db, 'UPDATE spend_requests SET approval_expires_at=?', new Date(Date.now() - 1000).toISOString());
  assert.equal(approvalCard(ctx, token).state, 'expired');
  await assert.rejects(decideApproval(ctx, token, 'approve'), (e) => e.status === 410);
});

test('reject records the note and never calls PayPal', async () => {
  const pp = fakePayPal();
  const ctx = makeCtx({ paypal: pp });
  await createSpendRequest(ctx, 'vega', TASK, spendInput({ amount_usd: 45, category: 'voice' }));
  const { token } = one(ctx.db, 'SELECT approval_token AS token FROM spend_requests');
  const card = await decideApproval(ctx, token, 'reject', 'too expensive');
  assert.equal(card.state, 'rejected');
  assert.equal(card.decision_note, 'too expensive');
  assert.equal(pp.calls.length, 0);
  assert.equal(agentMonthSpent(ctx, 'vega'), 0);
});

test('auto verdict pays immediately for a known vendor within limits', async () => {
  const pp = fakePayPal();
  const ctx = makeCtx({ paypal: pp });
  // make the vendor "known" by a previously paid request
  run(ctx.db, "INSERT INTO spend_requests(id,agent_id,task_id,vendor_name,vendor_email,category,amount_cents,policy_verdict,status,created_at) VALUES('old','vega','task_launch_video','GPU Cloud','gpu@example.com','gpu',100,'auto','paid',?)", new Date().toISOString());
  const sr = await createSpendRequest(ctx, 'vega', TASK, spendInput({ amount_usd: 20 }));
  assert.equal(sr.policy_verdict, 'auto');
  assert.equal(sr.status, 'approved');
  assert.equal(pp.calls.filter((c) => c.name === 'createPayout').length, 1);
});

test('blocked request is stored as rejected by policy and never reaches PayPal', async () => {
  const pp = fakePayPal();
  const ctx = makeCtx({ paypal: pp });
  const noTask = await createSpendRequest(ctx, 'vega', null, spendInput());
  assert.equal(noTask.policy_verdict, 'blocked');
  assert.equal(noTask.status, 'rejected');
  assert.equal(noTask.decided_by, 'policy');
  assert.equal(pp.calls.length, 0);
});

test('without PayPal keys: auto and approve fail loudly with NotConfigured; pending requests still queue', async () => {
  const ctx = makeCtx({ paypal: null });
  run(ctx.db, "INSERT INTO spend_requests(id,agent_id,task_id,vendor_name,vendor_email,category,amount_cents,policy_verdict,status,created_at) VALUES('old','vega','task_launch_video','GPU Cloud','gpu@example.com','gpu',100,'auto','paid',?)", new Date().toISOString());
  await assert.rejects(createSpendRequest(ctx, 'vega', TASK, spendInput({ amount_usd: 20 })), NotConfiguredError);
  assert.equal(all(ctx.db, 'SELECT * FROM spend_requests WHERE id != ?', 'old').length, 0, 'nothing persisted for an unexecutable payment');
  await createSpendRequest(ctx, 'vega', TASK, spendInput({ amount_usd: 45, category: 'voice' }));
  const { token } = one(ctx.db, "SELECT approval_token AS token FROM spend_requests WHERE status='pending'");
  await assert.rejects(decideApproval(ctx, token, 'approve'), NotConfiguredError);
  assert.equal(one(ctx.db, "SELECT status FROM spend_requests WHERE approval_token=?", token).status, 'pending', 'token not burned');
});

test('PayPal payout failure marks the request failed and surfaces the error', async () => {
  const pp = fakePayPal({ createPayout: async () => { throw new PayPalError('boom', { status: 400, debugId: 'd1' }); } });
  const ctx = makeCtx({ paypal: pp });
  await createSpendRequest(ctx, 'vega', TASK, spendInput({ amount_usd: 45, category: 'voice' }));
  const { token } = one(ctx.db, 'SELECT approval_token AS token FROM spend_requests');
  await assert.rejects(decideApproval(ctx, token, 'approve'), PayPalError);
  assert.equal(one(ctx.db, 'SELECT status FROM spend_requests').status, 'failed');
  assert.equal(all(ctx.db, 'SELECT * FROM ledger').length, 0);
});

test('monthly budget is enforced from committed spend', async () => {
  const ctx = makeCtx({ paypal: fakePayPal() });
  run(ctx.db, "INSERT INTO spend_requests(id,agent_id,task_id,vendor_name,vendor_email,category,amount_cents,policy_verdict,status,created_at) VALUES('old','lyra','task_price_report','V','gpu@example.com','ads',14900,'auto','paid',?)", new Date().toISOString());
  const sr = await createSpendRequest(ctx, 'lyra', 'task_price_report', spendInput({ amount_usd: 5, category: 'ads' }));
  assert.equal(sr.policy_verdict, 'needs_approval');
  assert.ok(sr.policy_reasons.some((r) => /monthly budget/.test(r)));
});

test('parseSpendInput validates amounts, emails and the $2,000 cap', () => {
  const ok = parseSpendInput(spendInput({ amount_usd: 19.99 }));
  assert.equal(ok.amount_cents, 1999);
  assert.throws(() => parseSpendInput(spendInput({ amount_usd: 2000.01 })), /hard cap/);
  assert.throws(() => parseSpendInput(spendInput({ amount_usd: 1.234 })), /2 decimals/);
  assert.throws(() => parseSpendInput(spendInput({ amount_usd: -3 })), /greater than zero/);
  assert.throws(() => parseSpendInput(spendInput({ amount_usd: 'abc' })), /Invalid amount|number/);
  assert.throws(() => parseSpendInput(spendInput({ vendor_email: 'not-an-email' })), /valid email/);
  assert.equal(parseSpendInput(spendInput({ amount_usd: 2000 })).amount_cents, 200000);
});
