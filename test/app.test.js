import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { one } from '../src/db.js';
import { createSpendRequest } from '../src/treasury.js';
import { fakeClaude, fakePayPal, makeCtx, spendInput } from './helpers.js';

const call = (app, method, path, body, headers = {}) =>
  app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });

test('health reports which integrations are configured', async () => {
  const app = createApp(makeCtx({ env: { DEMO_MODE: '1' } }));
  const h = await (await call(app, 'GET', '/api/health')).json();
  assert.equal(h.ok, true);
  assert.equal(h.paypal.configured, false);
  assert.equal(h.claude.configured, false);
  assert.equal(h.demo_mode, true);
  const app2 = createApp(makeCtx({ paypal: fakePayPal(), claude: fakeClaude([]), env: { PAYPAL_CLIENT_ID: 'a', PAYPAL_CLIENT_SECRET: 'b', ANTHROPIC_API_KEY: 'k' } }));
  const h2 = await (await call(app2, 'GET', '/api/health')).json();
  assert.equal(h2.paypal.configured, true);
  assert.equal(h2.claude.configured, true);
});

test('seeded data: 4 agents with budgets, 3 tasks', async () => {
  const app = createApp(makeCtx());
  const agents = await (await call(app, 'GET', '/api/agents')).json();
  assert.deepEqual(agents.map((a) => a.id), ['atlas', 'vega', 'orion', 'lyra']);
  assert.equal(agents[1].monthly_budget_cents, 30000);
  assert.equal(agents[1].remaining_cents, 30000);
  assert.equal((await (await call(app, 'GET', '/api/tasks')).json()).length, 3);
  const ov = await (await call(app, 'GET', '/api/overview')).json();
  assert.equal(ov.agents.length, 4);
});

test('AI and money actions answer 503 with a clear message when not configured', async () => {
  const app = createApp(makeCtx({ env: { DEMO_MODE: '1' } }));
  let r = await call(app, 'POST', '/api/agents/vega/run', { instruction: 'hi' });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), { error: 'Claude not configured', configured: false });
  r = await call(app, 'POST', '/api/ask', { question: 'hi' });
  assert.equal(r.status, 503);
  r = await call(app, 'POST', '/api/tasks/task_launch_video/invoice', {});
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, 'PayPal not configured');
  r = await call(app, 'POST', '/api/tasks/task_gpu_render/checkout');
  assert.equal(r.status, 503);
});

test('owner endpoints need ADMIN_TOKEN outside demo mode; approvals hide tokens from anonymous callers', async () => {
  const ctx = makeCtx({ paypal: fakePayPal(), env: { ADMIN_TOKEN: 'secret-admin' } });
  await createSpendRequest(ctx, 'vega', 'task_launch_video', spendInput({ amount_usd: 45, category: 'voice' }));
  const app = createApp(ctx);
  assert.equal((await call(app, 'POST', '/api/reconcile')).status, 401);
  assert.equal((await call(app, 'POST', '/api/reconcile', undefined, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await call(app, 'POST', '/api/reconcile', undefined, { authorization: 'Bearer secret-admin' })).status, 200);
  const anon = await (await call(app, 'GET', '/api/approvals')).json();
  assert.equal(anon[0].token, undefined);
  const admin = await (await call(app, 'GET', '/api/approvals', undefined, { 'x-admin-token': 'secret-admin' })).json();
  assert.ok(admin[0].token);
});

test('approval HTTP flow: card -> QR svg -> approve -> second approve is 409', async () => {
  const pp = fakePayPal();
  const ctx = makeCtx({ paypal: pp });
  await createSpendRequest(ctx, 'vega', 'task_launch_video', spendInput({ amount_usd: 45, category: 'voice' }));
  const { token } = one(ctx.db, 'SELECT approval_token AS token FROM spend_requests');
  const app = createApp(ctx);
  const card = await (await call(app, 'GET', `/api/approvals/${token}`)).json();
  assert.equal(card.agent.name, 'Vega');
  assert.equal(card.amount_cents, 4500);
  assert.ok(card.reasons.length >= 1);
  const qr = await call(app, 'GET', `/api/approvals/${token}/qr.svg`);
  assert.equal(qr.headers.get('content-type'), 'image/svg+xml');
  assert.match(await qr.text(), /<svg/);
  const ok = await call(app, 'POST', `/api/approvals/${token}/approve`, { note: 'go' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).state, 'approved');
  assert.equal((await call(app, 'POST', `/api/approvals/${token}/approve`, {})).status, 409);
  assert.equal((await call(app, 'GET', '/api/approvals/nope')).status, 404);
  const page = await call(app, 'GET', `/approve/${token}`);
  assert.equal(page.status, 200);
});

test('webhook endpoint: signature failure -> 400, unsigned local mode -> stored', async () => {
  const bad = createApp(makeCtx({ paypal: fakePayPal({ verifyWebhookSignature: async () => false }), env: { PAYPAL_WEBHOOK_ID: 'W' } }));
  const r = await call(bad, 'POST', '/webhooks/paypal', { id: 'WH-1', event_type: 'X', resource: {} });
  assert.equal(r.status, 400);
  const ctx = makeCtx();
  const ok = await call(createApp(ctx), 'POST', '/webhooks/paypal', { id: 'WH-2', event_type: 'X', resource: {} });
  assert.equal(ok.status, 200);
  assert.equal(one(ctx.db, "SELECT COUNT(*) c FROM events WHERE source='paypal_webhook'").c, 1);
});

test('agent run endpoint is rate limited per visitor (20/hour)', async () => {
  const claude = fakeClaude([[{ type: 'text', text: 'ok' }]]);
  const app = createApp(makeCtx({ claude, env: { DEMO_MODE: '1', AI_DAILY_CAP: '1000' } }));
  let last;
  for (let i = 0; i < 21; i += 1) last = await call(app, 'POST', '/api/agents/vega/run', { instruction: 'x' });
  assert.equal(last.status, 429);
});

test('dispute decision requires a PayPal client and then calls the right API', async () => {
  const pp = fakePayPal();
  const ctx = makeCtx({ paypal: pp, env: { DEMO_MODE: '1' } });
  ctx.db.prepare("INSERT INTO disputes(id,paypal_dispute_id,reason,status,amount_cents,linked_capture_id,created_at) VALUES('dsp_1','PP-D-1','X','OPEN',1000,'CAP-1',?)").run(new Date().toISOString());
  const app = createApp(ctx);
  const r = await call(app, 'POST', '/api/disputes/dsp_1/decision', { decision: 'offer_refund', note: 'sorry' });
  assert.equal(r.status, 200);
  assert.equal(pp.calls.find((c) => c.name === 'refundCapture').args[0], 'CAP-1');
  assert.equal((await call(app, 'POST', '/api/disputes/dsp_1/decision', { decision: 'accept_claim' })).status, 409);
});
