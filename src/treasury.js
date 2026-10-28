// Treasury core: every money movement goes through here, never from the LLM and never straight from an HTTP handler.
// ctx = { db, config, paypal|null, claude|null, log }

import { all, insert, monthStartIso, newToken, nowIso, one, run, uid, update } from './db.js';
import { NotConfiguredError } from './config.js';
import { evaluate } from './policy.js';
import { MAX_REQUEST_CENTS, fmtUsd, toCents } from './money.js';

export const APPROVAL_TTL_MS = 48 * 3600 * 1000;
export const DEFAULT_DENYLIST = []; // extend via env later; kept explicit so the policy input is visible

export class TreasuryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TreasuryError';
    this.status = status;
  }
}

export function requirePaypal(ctx) {
  if (!ctx.paypal) throw new NotConfiguredError('PayPal');
  return ctx.paypal;
}

const parseJson = (s, fallback) => {
  try { return JSON.parse(s); } catch { return fallback; }
};

export function hydrateAgent(row) {
  return row && { ...row, allowed_categories: parseJson(row.allowed_categories, []) };
}
export const getAgent = (ctx, id) => hydrateAgent(one(ctx.db, 'SELECT * FROM agents WHERE id=?', id));
export const getTask = (ctx, id) => one(ctx.db, 'SELECT * FROM tasks WHERE id=?', id);

// ---- audit + ledger ---------------------------------------------------------
export function logEvent(ctx, source, type, payload = {}, { verified = 0, refs = [], id } = {}) {
  const eventId = id || uid('ev');
  const res = insert(ctx.db, 'events', {
    id: eventId, source, type, payload: JSON.stringify(payload), verified: verified ? 1 : 0, refs: refs.filter(Boolean).join(' '), created_at: nowIso(),
  }, { ignore: true });
  return { id: eventId, inserted: res.changes > 0 };
}

/** Returns true if a new row was written; false if the same PayPal object was already booked. */
export function addLedger(ctx, row) {
  const res = insert(ctx.db, 'ledger', {
    id: uid('led'), currency: 'USD', status: 'completed', created_at: nowIso(), ...row,
  }, { ignore: true });
  return res.changes > 0;
}

// ---- budgets ---------------------------------------------------------------------
const COMMITTED = "status IN ('approved','paid')";

export function agentMonthSpent(ctx, agentId, now = new Date()) {
  return one(ctx.db, `SELECT COALESCE(SUM(amount_cents),0) AS s FROM spend_requests WHERE agent_id=? AND ${COMMITTED} AND created_at>=?`, agentId, monthStartIso(now)).s;
}
export function taskSpent(ctx, taskId) {
  return one(ctx.db, `SELECT COALESCE(SUM(amount_cents),0) AS s FROM spend_requests WHERE task_id=? AND ${COMMITTED}`, taskId).s;
}
export function agentMonthEarned(ctx, agentId, now = new Date()) {
  return one(ctx.db, "SELECT COALESCE(SUM(amount_cents),0) AS s FROM ledger WHERE agent_id=? AND kind='income' AND status='completed' AND created_at>=?", agentId, monthStartIso(now)).s;
}
export function knownVendors(ctx) {
  return new Set(all(ctx.db, "SELECT DISTINCT lower(vendor_email) AS e FROM spend_requests WHERE status='paid'").map((r) => r.e));
}

export function budgetSnapshot(ctx, agentId) {
  const agent = getAgent(ctx, agentId);
  if (!agent) throw new TreasuryError(`Unknown agent ${agentId}`, 404);
  const spent = agentMonthSpent(ctx, agentId);
  const earned = agentMonthEarned(ctx, agentId);
  return {
    agent_id: agent.id, name: agent.name, monthly_budget_cents: agent.monthly_budget_cents, spent_cents: spent,
    remaining_cents: Math.max(0, agent.monthly_budget_cents - spent), earned_cents: earned,
    roi: spent > 0 ? Number((earned / spent).toFixed(2)) : null, per_tx_auto_limit_cents: agent.per_tx_auto_limit_cents,
    allowed_categories: agent.allowed_categories,
  };
}

// ---- spend requests -----------------------------------------------------------------
/** Validates what the model (or an HTTP caller) gave us. Throws TreasuryError on anything dubious. */
export function parseSpendInput(input) {
  let amount_cents;
  try { amount_cents = toCents(input.amount_usd); } catch (e) { throw new TreasuryError(e.message); }
  if (amount_cents <= 0) throw new TreasuryError('amount_usd must be greater than zero');
  if (amount_cents > MAX_REQUEST_CENTS) throw new TreasuryError(`amount_usd exceeds the hard cap of ${fmtUsd(MAX_REQUEST_CENTS)} per request`);
  const email = String(input.vendor_email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new TreasuryError('vendor_email is not a valid email address');
  const vendor_name = String(input.vendor_name || '').trim().slice(0, 120);
  if (!vendor_name) throw new TreasuryError('vendor_name is required');
  return {
    amount_cents, vendor_email: email, vendor_name, category: String(input.category || '').trim().toLowerCase(),
    justification: String(input.justification || '').slice(0, 1000), expected_result: String(input.expected_result || '').slice(0, 500),
  };
}

export async function createSpendRequest(ctx, agentId, taskId, rawInput) {
  const agent = getAgent(ctx, agentId);
  if (!agent) throw new TreasuryError(`Unknown agent ${agentId}`, 404);
  const parsed = parseSpendInput(rawInput);
  const task = taskId ? getTask(ctx, taskId) : null;
  const spentMonth = agentMonthSpent(ctx, agentId);
  const { verdict, reasons } = evaluate(
    { ...parsed, currency: 'USD', task_id: taskId },
    agent, spentMonth,
    { task, knownVendors: knownVendors(ctx), denylist: DEFAULT_DENYLIST, taskSpentCents: taskId ? taskSpent(ctx, taskId) : 0 },
  );

  // Fail before persisting anything: an "auto" payment we cannot execute must not look like it happened.
  if (verdict === 'auto') requirePaypal(ctx);

  const id = uid('sr');
  const row = {
    id, agent_id: agentId, task_id: taskId || null, vendor_name: parsed.vendor_name, vendor_email: parsed.vendor_email,
    category: parsed.category, amount_cents: parsed.amount_cents, currency: 'USD', justification: parsed.justification,
    expected_result: parsed.expected_result, policy_verdict: verdict, policy_reasons: JSON.stringify(reasons),
    status: verdict === 'blocked' ? 'rejected' : 'pending', created_at: nowIso(),
  };
  if (verdict === 'needs_approval') {
    row.approval_token = newToken();
    row.approval_expires_at = new Date(Date.now() + APPROVAL_TTL_MS).toISOString();
  }
  if (verdict === 'blocked') { row.decided_by = 'policy'; row.decided_at = nowIso(); row.decision_note = reasons.join(' '); }
  insert(ctx.db, 'spend_requests', row);
  logEvent(ctx, 'policy', `spend.${verdict}`, { spend_request_id: id, agent_id: agentId, amount_cents: parsed.amount_cents, reasons }, { refs: [id, taskId] });

  if (verdict === 'auto') {
    await executePayout(ctx, id, 'policy:auto');
  } else if (verdict === 'needs_approval') {
    notifyApproval(ctx, id).catch((e) => ctx.log?.('warn', `approval webhook failed: ${e.message}`));
  }
  return publicSpendRequest(ctx, id);
}

export function publicSpendRequest(ctx, id, { includeToken = false } = {}) {
  const r = one(ctx.db, 'SELECT * FROM spend_requests WHERE id=?', id);
  if (!r) return null;
  const { approval_token, ...rest } = r;
  return { ...rest, policy_reasons: parseJson(r.policy_reasons, []), ...(includeToken ? { approval_token } : {}) };
}

async function notifyApproval(ctx, id) {
  const url = ctx.config.approvalWebhookUrl;
  if (!url) return;
  const card = approvalCard(ctx, one(ctx.db, 'SELECT approval_token FROM spend_requests WHERE id=?', id).approval_token);
  const res = await (ctx.fetchImpl || fetch)(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(card) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function executePayout(ctx, spendRequestId, decidedBy) {
  const sr = one(ctx.db, 'SELECT * FROM spend_requests WHERE id=?', spendRequestId);
  const paypal = requirePaypal(ctx);
  if (sr.payout_batch_id) return sr; // already submitted; idempotent
  try {
    const batch = await paypal.createPayout([{
      receiver: sr.vendor_email, amountCents: sr.amount_cents, currency: sr.currency, senderItemId: sr.id,
      note: `${sr.vendor_name}: ${sr.justification}`.slice(0, 200),
    }], `atlas-${sr.id}`);
    const batchId = batch.batch_header.payout_batch_id;
    update(ctx.db, 'spend_requests', sr.id, {
      status: 'approved', payout_batch_id: batchId, decided_by: sr.decided_by || decidedBy, decided_at: sr.decided_at || nowIso(),
    });
    addLedger(ctx, {
      kind: 'spend', amount_cents: -sr.amount_cents, agent_id: sr.agent_id, task_id: sr.task_id, spend_request_id: sr.id,
      paypal_ref_type: 'payout', paypal_ref_id: batchId, status: 'pending', memo: `${sr.vendor_name} - ${sr.justification}`.slice(0, 300),
    });
    logEvent(ctx, 'agent', 'payout.submitted', { spend_request_id: sr.id, batch_id: batchId, batch_status: batch.batch_header.batch_status }, { refs: [sr.id, batchId, sr.task_id] });
  } catch (e) {
    update(ctx.db, 'spend_requests', sr.id, { status: 'failed', failure_reason: e.message.slice(0, 500), decided_by: sr.decided_by || decidedBy, decided_at: sr.decided_at || nowIso() });
    logEvent(ctx, 'agent', 'payout.failed', { spend_request_id: sr.id, error: e.message, debug_id: e.debugId }, { refs: [sr.id] });
    throw e;
  }
  return one(ctx.db, 'SELECT * FROM spend_requests WHERE id=?', sr.id);
}

/** Called by webhook handler and reconciler. Idempotent. */
export function settlePayout(ctx, spendRequestId, outcome, { itemId = null, reason = null } = {}) {
  const sr = one(ctx.db, 'SELECT * FROM spend_requests WHERE id=?', spendRequestId);
  if (!sr || sr.status === 'paid' || (sr.status === 'failed' && outcome === 'failed')) return false;
  if (outcome === 'paid') {
    update(ctx.db, 'spend_requests', sr.id, { status: 'paid', payout_item_id: itemId || sr.payout_item_id });
    run(ctx.db, "UPDATE ledger SET status='completed' WHERE spend_request_id=? AND kind='spend'", sr.id);
  } else {
    update(ctx.db, 'spend_requests', sr.id, { status: 'failed', payout_item_id: itemId || sr.payout_item_id, failure_reason: reason });
    run(ctx.db, "UPDATE ledger SET status='failed' WHERE spend_request_id=? AND kind='spend'", sr.id);
  }
  return true;
}

// ---- human approval ---------------------------------------------------------------------
export function approvalCard(ctx, token) {
  const sr = one(ctx.db, 'SELECT * FROM spend_requests WHERE approval_token=?', token);
  if (!sr) return null;
  const agent = getAgent(ctx, sr.agent_id);
  const task = sr.task_id ? getTask(ctx, sr.task_id) : null;
  const expired = sr.approval_expires_at && new Date(sr.approval_expires_at) < new Date();
  return {
    id: sr.id, token, state: sr.status === 'pending' ? (expired ? 'expired' : 'pending') : sr.status,
    agent: { id: agent.id, name: agent.name, emoji: agent.emoji, role: agent.role },
    amount_cents: sr.amount_cents, currency: sr.currency, vendor_name: sr.vendor_name, vendor_email: sr.vendor_email, category: sr.category,
    justification: sr.justification, expected_result: sr.expected_result, reasons: parseJson(sr.policy_reasons, []),
    task: task && { id: task.id, title: task.title, client_name: task.client_name, price_cents: task.price_cents },
    budget: budgetSnapshot(ctx, agent.id), expires_at: sr.approval_expires_at, decided_by: sr.decided_by, decision_note: sr.decision_note, created_at: sr.created_at,
  };
}

export function listApprovals(ctx, { includeTokens = false } = {}) {
  return all(ctx.db, "SELECT approval_token FROM spend_requests WHERE approval_token IS NOT NULL ORDER BY created_at DESC LIMIT 200")
    .map((r) => approvalCard(ctx, r.approval_token))
    .map((c) => (includeTokens ? c : { ...c, token: undefined }));
}

export async function decideApproval(ctx, token, decision, note = '', by = 'owner') {
  if (!['approve', 'reject'].includes(decision)) throw new TreasuryError('decision must be approve or reject');
  const sr = one(ctx.db, 'SELECT * FROM spend_requests WHERE approval_token=?', token);
  if (!sr) throw new TreasuryError('Unknown approval token', 404);
  if (sr.status !== 'pending') throw new TreasuryError(`Already ${sr.status}; approval links are single-use`, 409);
  if (new Date(sr.approval_expires_at) < new Date()) throw new TreasuryError('Approval link expired (48 h)', 410);

  if (decision === 'reject') {
    update(ctx.db, 'spend_requests', sr.id, { status: 'rejected', decided_by: by, decided_at: nowIso(), decision_note: note.slice(0, 500) });
    logEvent(ctx, 'human', 'spend.rejected', { spend_request_id: sr.id, note }, { refs: [sr.id, sr.task_id] });
    return approvalCard(ctx, token);
  }
  requirePaypal(ctx); // 503 before we burn the single-use token
  // Claim the token atomically: status flips pending -> approved before any network call.
  const claim = run(ctx.db, "UPDATE spend_requests SET status='approved', decided_by=?, decided_at=?, decision_note=? WHERE id=? AND status='pending'", by, nowIso(), note.slice(0, 500), sr.id);
  if (claim.changes !== 1) throw new TreasuryError('Already decided', 409);
  logEvent(ctx, 'human', 'spend.approved', { spend_request_id: sr.id, note }, { refs: [sr.id, sr.task_id] });
  await executePayout(ctx, sr.id, by);
  return approvalCard(ctx, token);
}

// ---- tasks ---------------------------------------------------------------------------------
export function markTaskDone(ctx, taskId, resultSummary, resultUrl) {
  const t = getTask(ctx, taskId);
  if (!t) throw new TreasuryError(`Unknown task ${taskId}`, 404);
  if (!['open', 'done'].includes(t.status)) throw new TreasuryError(`Task is already ${t.status}`);
  update(ctx.db, 'tasks', taskId, { status: 'done', result_summary: String(resultSummary || '').slice(0, 2000), result_url: resultUrl ? String(resultUrl).slice(0, 500) : null });
  logEvent(ctx, 'agent', 'task.done', { task_id: taskId }, { refs: [taskId] });
  return getTask(ctx, taskId);
}

export function decideTask(ctx, taskId, accepted) {
  const t = getTask(ctx, taskId);
  if (!t) throw new TreasuryError(`Unknown task ${taskId}`, 404);
  if (t.status !== 'done') throw new TreasuryError('Only a task marked done can be accepted or rejected');
  update(ctx.db, 'tasks', taskId, { status: accepted ? 'accepted' : 'rejected', accepted_at: accepted ? nowIso() : null });
  logEvent(ctx, 'human', accepted ? 'task.accepted' : 'task.rejected', { task_id: taskId }, { refs: [taskId] });
  return getTask(ctx, taskId);
}

// ---- income: invoices + checkout ------------------------------------------------------------------
export async function createTaskInvoice(ctx, taskId, { lineItems, dueInDays = 14, note = '' } = {}) {
  const paypal = requirePaypal(ctx);
  const task = getTask(ctx, taskId);
  if (!task) throw new TreasuryError(`Unknown task ${taskId}`, 404);
  if (!task.client_email) throw new TreasuryError('Task has no client_email; cannot invoice');
  let items = (lineItems || []).map((l) => ({ name: String(l.name || task.title).slice(0, 200), quantity: Number(l.quantity || 1), unit_amount_cents: toCents(l.unit_amount_usd) }));
  if (!items.length && task.price_cents) items = [{ name: task.title, quantity: 1, unit_amount_cents: task.price_cents }];
  if (!items.length) throw new TreasuryError('No line items and the task has no price');
  if (items.some((i) => !Number.isInteger(i.quantity) || i.quantity < 1 || i.unit_amount_cents <= 0)) throw new TreasuryError('Invalid line item');
  const total = items.reduce((s, i) => s + i.quantity * i.unit_amount_cents, 0);
  if (total > MAX_REQUEST_CENTS * 10) throw new TreasuryError('Invoice total unreasonably large');

  const localId = uid('inv');
  const invoiceNumber = await paypal.generateNextInvoiceNumber();
  const created = await paypal.createInvoice({
    invoiceNumber, client: { name: task.client_name, email: task.client_email }, items, note: note || `Atlas Treasury - ${task.title}`, dueInDays, requestId: `create-${localId}`,
  });
  await paypal.sendInvoice(created.id, { subject: `Invoice ${invoiceNumber}: ${task.title}`, note });
  const full = await paypal.getInvoice(created.id).catch(() => null);
  insert(ctx.db, 'invoices', {
    id: localId, task_id: taskId, agent_id: task.agent_id, paypal_invoice_id: created.id, paypal_invoice_number: invoiceNumber,
    payer_view_url: full?.detail?.metadata?.recipient_view_url || null, amount_cents: total, currency: 'USD', status: 'sent', created_at: nowIso(),
  });
  logEvent(ctx, 'agent', 'invoice.sent', { invoice_id: localId, paypal_invoice_id: created.id, total_cents: total }, { refs: [localId, created.id, taskId] });
  return one(ctx.db, 'SELECT * FROM invoices WHERE id=?', localId);
}

export async function remindInvoice(ctx, localId) {
  const paypal = requirePaypal(ctx);
  const inv = one(ctx.db, 'SELECT * FROM invoices WHERE id=?', localId);
  if (!inv) throw new TreasuryError('Unknown invoice', 404);
  if (inv.status === 'paid') throw new TreasuryError('Invoice already paid');
  await paypal.remindInvoice(inv.paypal_invoice_id);
  run(ctx.db, 'UPDATE invoices SET reminders=reminders+1 WHERE id=?', localId);
  logEvent(ctx, 'agent', 'invoice.reminded', { invoice_id: localId }, { refs: [localId, inv.paypal_invoice_id] });
  return one(ctx.db, 'SELECT * FROM invoices WHERE id=?', localId);
}

/** The explicit "client paid offline" button: tells PayPal, then books income locally (idempotent). */
export async function recordInvoiceOffline(ctx, localId) {
  const paypal = requirePaypal(ctx);
  const inv = one(ctx.db, 'SELECT * FROM invoices WHERE id=?', localId);
  if (!inv) throw new TreasuryError('Unknown invoice', 404);
  if (inv.status === 'paid') throw new TreasuryError('Invoice already paid');
  await paypal.recordPayment(inv.paypal_invoice_id, { amountCents: inv.amount_cents });
  logEvent(ctx, 'human', 'invoice.paid_offline', { invoice_id: localId }, { refs: [localId, inv.paypal_invoice_id] });
  recordInvoicePaid(ctx, inv.paypal_invoice_id, { memoSuffix: ' (recorded as paid offline)' });
  return one(ctx.db, 'SELECT * FROM invoices WHERE id=?', localId);
}

export function recordInvoicePaid(ctx, paypalInvoiceId, { amountCents, memoSuffix = '' } = {}) {
  const inv = one(ctx.db, 'SELECT * FROM invoices WHERE paypal_invoice_id=?', paypalInvoiceId);
  if (!inv || inv.status === 'paid') return false;
  const amount = amountCents ?? inv.amount_cents;
  update(ctx.db, 'invoices', inv.id, { status: 'paid', paid_at: nowIso() });
  const task = inv.task_id ? getTask(ctx, inv.task_id) : null;
  addLedger(ctx, {
    kind: 'income', amount_cents: amount, agent_id: inv.agent_id, task_id: inv.task_id, paypal_ref_type: 'invoice', paypal_ref_id: paypalInvoiceId,
    memo: `Invoice ${inv.paypal_invoice_number} paid${task ? ` - ${task.title}` : ''}${memoSuffix}`,
  });
  if (task) update(ctx.db, 'tasks', task.id, { paid_at: nowIso() });
  return true;
}

export async function createCheckoutLink(ctx, taskId) {
  const paypal = requirePaypal(ctx);
  const task = getTask(ctx, taskId);
  if (!task) throw new TreasuryError(`Unknown task ${taskId}`, 404);
  if (!task.price_cents) throw new TreasuryError('Task has no price; set price_cents first');
  const localId = uid('ord');
  const order = await paypal.createOrder({
    taskId, invoiceId: localId, description: task.title.slice(0, 120), amountCents: task.price_cents,
    returnUrl: `${ctx.config.publicUrl}/checkout/return?o=${localId}`, cancelUrl: `${ctx.config.publicUrl}/checkout/cancel?o=${localId}`, requestId: `order-${localId}`,
  });
  insert(ctx.db, 'orders', { id: localId, task_id: taskId, paypal_order_id: order.id, approve_url: order.approveUrl, amount_cents: task.price_cents, status: 'created', created_at: nowIso() });
  logEvent(ctx, 'agent', 'checkout.created', { order_id: localId, paypal_order_id: order.id }, { refs: [localId, order.id, taskId] });
  return one(ctx.db, 'SELECT * FROM orders WHERE id=?', localId);
}

export async function captureCheckout(ctx, paypalOrderId) {
  const paypal = requirePaypal(ctx);
  const order = one(ctx.db, 'SELECT * FROM orders WHERE paypal_order_id=?', paypalOrderId);
  if (!order) throw new TreasuryError('Unknown order', 404);
  if (order.status === 'captured') return order;
  const res = await paypal.captureOrder(paypalOrderId);
  const cap = res.purchase_units?.[0]?.payments?.captures?.[0];
  if (cap?.status === 'COMPLETED') recordCaptureCompleted(ctx, { captureId: cap.id, orderId: paypalOrderId, amountCents: toCents(cap.amount.value) });
  return one(ctx.db, 'SELECT * FROM orders WHERE id=?', order.id);
}

export function recordCaptureCompleted(ctx, { captureId, orderId, customId, amountCents }) {
  let order = orderId ? one(ctx.db, 'SELECT * FROM orders WHERE paypal_order_id=?', orderId) : null;
  const taskId = order?.task_id || customId || null;
  if (order && order.status !== 'captured') update(ctx.db, 'orders', order.id, { status: 'captured', capture_id: captureId });
  const task = taskId ? getTask(ctx, taskId) : null;
  const booked = addLedger(ctx, {
    kind: 'income', amount_cents: amountCents, agent_id: task?.agent_id || null, task_id: taskId, paypal_ref_type: 'capture', paypal_ref_id: captureId,
    memo: `Checkout payment captured${task ? ` - ${task.title}` : ''}`,
  });
  if (booked && task) update(ctx.db, 'tasks', task.id, { paid_at: nowIso() });
  return booked;
}

export function recordRefund(ctx, { refundId, captureId, amountCents }) {
  const incomeRow = one(ctx.db, "SELECT * FROM ledger WHERE paypal_ref_type='capture' AND paypal_ref_id=? AND kind='income'", captureId);
  return addLedger(ctx, {
    kind: 'refund', amount_cents: -Math.abs(amountCents), agent_id: incomeRow?.agent_id || null, task_id: incomeRow?.task_id || null,
    paypal_ref_type: 'refund', paypal_ref_id: refundId, memo: `Refund of capture ${captureId}`,
  });
}

// ---- disputes ------------------------------------------------------------------------------------------
export function upsertDispute(ctx, d) {
  const amountCents = d.dispute_amount?.value ? toCents(d.dispute_amount.value) : 0;
  const captureId = d.disputed_transactions?.[0]?.seller_transaction_id || null;
  const income = captureId ? one(ctx.db, "SELECT * FROM ledger WHERE paypal_ref_type='capture' AND paypal_ref_id=? AND kind='income'", captureId) : null;
  const existing = one(ctx.db, 'SELECT * FROM disputes WHERE paypal_dispute_id=?', d.dispute_id);
  const open = !['RESOLVED', 'CLOSED'].includes(String(d.status || '').toUpperCase());
  let id = existing?.id;
  if (!existing) {
    id = uid('dsp');
    insert(ctx.db, 'disputes', {
      id, paypal_dispute_id: d.dispute_id, reason: d.reason || null, status: d.status || null, amount_cents: amountCents,
      linked_task_id: income?.task_id || null, linked_capture_id: captureId, created_at: nowIso(),
    });
  } else {
    update(ctx.db, 'disputes', id, { status: d.status || existing.status, reason: d.reason || existing.reason, amount_cents: amountCents || existing.amount_cents });
  }
  if (open) {
    addLedger(ctx, { kind: 'dispute_hold', amount_cents: -amountCents, agent_id: income?.agent_id || null, task_id: income?.task_id || null, paypal_ref_type: 'dispute', paypal_ref_id: d.dispute_id, memo: `Funds held for dispute ${d.dispute_id} (${d.reason || 'reason n/a'})` });
  } else {
    addLedger(ctx, { kind: 'dispute_release', amount_cents: amountCents, agent_id: income?.agent_id || null, task_id: income?.task_id || null, paypal_ref_type: 'dispute', paypal_ref_id: d.dispute_id, memo: `Dispute ${d.dispute_id} resolved - hold released` });
  }
  return one(ctx.db, 'SELECT * FROM disputes WHERE id=?', id);
}

// ---- read models ----------------------------------------------------------------------------------------
export function overview(ctx, now = new Date()) {
  const since = monthStartIso(now);
  const sum = (sql, ...p) => one(ctx.db, sql, ...p).s;
  const earned = sum("SELECT COALESCE(SUM(amount_cents),0) s FROM ledger WHERE kind='income' AND status='completed' AND created_at>=?", since);
  const refunds = sum("SELECT COALESCE(SUM(amount_cents),0) s FROM ledger WHERE kind='refund' AND created_at>=?", since);
  const spent = sum("SELECT COALESCE(SUM(-amount_cents),0) s FROM ledger WHERE kind='spend' AND status IN ('pending','completed') AND created_at>=?", since);
  return {
    month_start: since, earned_cents: earned, refunded_cents: -refunds, spent_cents: spent, net_cents: earned + refunds - spent,
    pending_approvals: sum("SELECT COUNT(*) s FROM spend_requests WHERE status='pending' AND policy_verdict='needs_approval' AND approval_expires_at>?", nowIso()),
    open_disputes: sum("SELECT COUNT(*) s FROM disputes WHERE upper(status) NOT IN ('RESOLVED','CLOSED')"),
    agents: all(ctx.db, 'SELECT id FROM agents ORDER BY rowid').map((a) => ({ ...getAgent(ctx, a.id), ...budgetSnapshot(ctx, a.id) })),
  };
}

export function proofChain(ctx, ledgerId) {
  const row = one(ctx.db, 'SELECT * FROM ledger WHERE id=?', ledgerId);
  if (!row) return null;
  const sr = row.spend_request_id ? publicSpendRequest(ctx, row.spend_request_id) : null;
  const task = row.task_id ? getTask(ctx, row.task_id) : null;
  const refs = [row.paypal_ref_id, row.spend_request_id, row.task_id, sr?.payout_batch_id, sr?.payout_item_id].filter(Boolean);
  const events = all(ctx.db, 'SELECT * FROM events ORDER BY created_at').filter((e) => refs.some((r) => e.refs.split(' ').includes(r)))
    .map((e) => ({ ...e, payload: parseJson(e.payload, {}) }));
  return {
    ledger: row, task, agent: row.agent_id ? getAgent(ctx, row.agent_id) : null, spend_request: sr,
    invoice: row.paypal_ref_type === 'invoice' ? one(ctx.db, 'SELECT * FROM invoices WHERE paypal_invoice_id=?', row.paypal_ref_id) : null,
    order: row.paypal_ref_type === 'capture' ? one(ctx.db, 'SELECT * FROM orders WHERE capture_id=?', row.paypal_ref_id) : null,
    events,
  };
}
