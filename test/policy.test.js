import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from '../src/policy.js';

const agent = { name: 'Vega', monthly_budget_cents: 30000, per_tx_auto_limit_cents: 2500, allowed_categories: ['gpu', 'voice'] };
const task = { id: 't1', title: 'Video', status: 'open', price_cents: 120000 };
const req = (over = {}) => ({ amount_cents: 2000, currency: 'USD', vendor_email: 'a@x.com', vendor_name: 'A', category: 'gpu', task_id: 't1', ...over });
const ctx = (over = {}) => ({ task, knownVendors: new Set(['a@x.com']), denylist: [], taskSpentCents: 0, ...over });

test('auto when everything is within limits', () => {
  const r = evaluate(req(), agent, 0, ctx());
  assert.equal(r.verdict, 'auto');
});

test('blocked: non-positive amount, bad currency, denylist, missing/closed task', () => {
  assert.equal(evaluate(req({ amount_cents: 0 }), agent, 0, ctx()).verdict, 'blocked');
  assert.equal(evaluate(req({ amount_cents: -5 }), agent, 0, ctx()).verdict, 'blocked');
  assert.equal(evaluate(req({ currency: 'EUR' }), agent, 0, ctx()).verdict, 'blocked');
  assert.equal(evaluate(req(), agent, 0, ctx({ denylist: ['A@X.com'] })).verdict, 'blocked');
  assert.equal(evaluate(req({ task_id: null }), agent, 0, ctx({ task: null })).verdict, 'blocked');
  assert.equal(evaluate(req(), agent, 0, ctx({ task: null })).verdict, 'blocked');
  assert.equal(evaluate(req(), agent, 0, ctx({ task: { ...task, status: 'rejected' } })).verdict, 'blocked');
  assert.equal(evaluate(req(), agent, 0, ctx({ task: { ...task, status: 'accepted' } })).verdict, 'blocked');
});

test('blocked wins over needs_approval and reports every blocking reason', () => {
  const r = evaluate(req({ amount_cents: 0, currency: 'EUR', category: 'nope' }), agent, 0, ctx());
  assert.equal(r.verdict, 'blocked');
  assert.equal(r.reasons.length, 2);
});

test('needs_approval over per-payment limit, with a human sentence', () => {
  const r = evaluate(req({ amount_cents: 4500 }), agent, 0, ctx());
  assert.equal(r.verdict, 'needs_approval');
  assert.match(r.reasons[0], /Over Vega's per-payment limit: \$45\.00 > \$25\.00/);
});

test('needs_approval when monthly budget would be exceeded (boundary is inclusive)', () => {
  assert.equal(evaluate(req({ amount_cents: 2000 }), agent, 28000, ctx()).verdict, 'auto'); // exactly 300.00
  const r = evaluate(req({ amount_cents: 2000 }), agent, 28001, ctx());
  assert.equal(r.verdict, 'needs_approval');
  assert.match(r.reasons.join(' '), /monthly budget/);
});

test('needs_approval for category outside allowed list and for new vendors', () => {
  assert.match(evaluate(req({ category: 'ads' }), agent, 0, ctx()).reasons.join(' '), /allowed categories/);
  assert.match(evaluate(req(), agent, 0, ctx({ knownVendors: new Set() })).reasons.join(' '), /New vendor/);
});

test('vendor matching is case-insensitive via normalized email', () => {
  assert.equal(evaluate(req({ vendor_email: 'a@x.com' }), agent, 0, ctx({ knownVendors: new Set(['a@x.com']) })).verdict, 'auto');
});

test('margin guard: spend above 60% of task price needs approval; no price = no guard', () => {
  const t = { ...task, price_cents: 10000 };
  assert.equal(evaluate(req({ amount_cents: 2000 }), agent, 0, ctx({ task: t, taskSpentCents: 4000 })).verdict, 'auto'); // 60.00 == 60%
  const r = evaluate(req({ amount_cents: 2000 }), agent, 0, ctx({ task: t, taskSpentCents: 4001 }));
  assert.equal(r.verdict, 'needs_approval');
  assert.match(r.reasons.join(' '), /Margin guard/);
  assert.equal(evaluate(req({ amount_cents: 2000 }), agent, 0, ctx({ task: { ...task, price_cents: null }, taskSpentCents: 999999 })).verdict, 'auto');
});

test('multiple review reasons accumulate', () => {
  const r = evaluate(req({ amount_cents: 99999, category: 'ads' }), agent, 0, ctx({ knownVendors: new Set() }));
  assert.equal(r.verdict, 'needs_approval');
  assert.ok(r.reasons.length >= 4);
});
