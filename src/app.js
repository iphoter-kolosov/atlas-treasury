import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { getConnInfo } from '@hono/node-server/conninfo';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

import { all, nowIso, one, update } from './db.js';
import { NotConfiguredError, claudeConfigured, paypalConfigured } from './config.js';
import { PayPalError } from './paypal.js';
import { WebhookRejected, handleWebhook } from './webhooks.js';
import { reconcile } from './reconcile.js';
import { analyzeDispute, askTreasurer, runAgent } from './agents.js';
import { decideDispute } from './disputes.js';
import {
  TreasuryError, approvalCard, budgetSnapshot, captureCheckout, createCheckoutLink, createTaskInvoice, decideApproval, decideTask, getAgent,
  listApprovals, overview, proofChain, recordInvoiceOffline, remindInvoice,
} from './treasury.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');
const RUNS_PER_HOUR = 20;

const parseRow = (r, keys) => {
  if (!r) return r;
  const out = { ...r };
  for (const k of keys) if (typeof out[k] === 'string') { try { out[k] = JSON.parse(out[k]); } catch { /* keep raw string */ } }
  return out;
};

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createApp(ctx) {
  const app = new Hono();
  const { config, db } = ctx;
  const runLog = new Map(); // ip -> [timestamps]; protects the public demo's Claude budget

  const isAdmin = (c) => {
    if (!config.adminToken) return false;
    const bearer = (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '');
    return safeEqual(bearer || c.req.header('x-admin-token') || '', config.adminToken);
  };
  // Sandbox demo (DEMO_MODE=1) lets anyone click; otherwise owner actions need ADMIN_TOKEN.
  const requireOwner = async (c, next) => {
    if (config.demoMode || isAdmin(c)) return next();
    return c.json({ error: 'Owner action: send ADMIN_TOKEN as "Authorization: Bearer ..."' }, 401);
  };
  const showTokens = (c) => config.demoMode || isAdmin(c);

  function rateLimit(c) {
    let ip = 'local';
    try { ip = c.req.header('x-forwarded-for')?.split(',')[0].trim() || getConnInfo(c).remote.address || 'local'; } catch { /* no socket in tests */ }
    const hourAgo = Date.now() - 3600_000;
    const hits = (runLog.get(ip) || []).filter((t) => t > hourAgo);
    if (hits.length >= RUNS_PER_HOUR) throw new TreasuryError(`Rate limit: ${RUNS_PER_HOUR} AI runs per hour per visitor`, 429);
    hits.push(Date.now());
    runLog.set(ip, hits);
  }

  app.onError((e, c) => {
    if (e instanceof NotConfiguredError) return c.json({ error: e.message, configured: false }, 503);
    if (e instanceof TreasuryError || e instanceof WebhookRejected) return c.json({ error: e.message }, e.status);
    if (e instanceof PayPalError) return c.json({ error: e.message, paypal_debug_id: e.debugId, details: e.details }, 502);
    ctx.log('error', `${c.req.method} ${c.req.path}: ${e.stack || e.message}`);
    return c.json({ error: 'Internal error' }, 500);
  });

  // ---- health + read models ----
  app.get('/api/health', (c) => c.json({
    ok: true, demo_mode: config.demoMode, time: nowIso(),
    paypal: { configured: paypalConfigured(config), api: config.paypal.api, webhook_signature_check: Boolean(config.paypal.webhookId) },
    claude: { configured: claudeConfigured(config), model: config.claudeModel },
    ai_calls_today: one(db, 'SELECT calls FROM ai_calls WHERE day=?', nowIso().slice(0, 10))?.calls ?? 0,
    ai_daily_cap: config.aiDailyCap,
  }));

  app.get('/api/overview', (c) => c.json(overview(ctx)));
  app.get('/api/agents', (c) => c.json(all(db, 'SELECT id FROM agents ORDER BY rowid').map((a) => ({ ...getAgent(ctx, a.id), ...budgetSnapshot(ctx, a.id) }))));
  app.get('/api/tasks', (c) => c.json(all(db, 'SELECT * FROM tasks ORDER BY created_at, id')));
  app.get('/api/ledger', (c) => c.json(all(db, `SELECT l.*, a.name AS agent_name, a.emoji AS agent_emoji, t.title AS task_title, t.status AS task_status
    FROM ledger l LEFT JOIN agents a ON a.id=l.agent_id LEFT JOIN tasks t ON t.id=l.task_id ORDER BY l.created_at DESC LIMIT 1000`)));
  app.get('/api/ledger/:id/proof', (c) => {
    const p = proofChain(ctx, c.req.param('id'));
    return p ? c.json(p) : c.json({ error: 'Unknown ledger row' }, 404);
  });
  app.get('/api/invoices', (c) => c.json(all(db, 'SELECT i.*, t.title AS task_title, t.client_name FROM invoices i LEFT JOIN tasks t ON t.id=i.task_id ORDER BY i.created_at DESC')));
  app.get('/api/orders', (c) => c.json(all(db, 'SELECT o.*, t.title AS task_title FROM orders o LEFT JOIN tasks t ON t.id=o.task_id ORDER BY o.created_at DESC')));
  app.get('/api/disputes', (c) => c.json(all(db, 'SELECT * FROM disputes ORDER BY created_at DESC').map((d) => parseRow(d, ['ai_analysis']))));
  app.get('/api/runs', (c) => c.json(all(db, 'SELECT r.*, a.name AS agent_name, a.emoji AS agent_emoji FROM agent_runs r LEFT JOIN agents a ON a.id=r.agent_id ORDER BY r.created_at DESC LIMIT 30').map((r) => parseRow(r, ['transcript']))));
  app.get('/api/events', (c) => c.json(all(db, 'SELECT * FROM events ORDER BY created_at DESC LIMIT 300').map((e) => parseRow(e, ['payload']))));

  // ---- approvals ----
  app.get('/api/approvals', (c) => c.json(listApprovals(ctx, { includeTokens: showTokens(c) })));
  app.get('/api/approvals/:token', (c) => {
    const card = approvalCard(ctx, c.req.param('token'));
    return card ? c.json(card) : c.json({ error: 'Unknown approval link' }, 404);
  });
  app.get('/api/approvals/:token/qr.svg', async (c) => {
    const token = c.req.param('token');
    if (!approvalCard(ctx, token)) return c.json({ error: 'Unknown approval link' }, 404);
    const svg = await QRCode.toString(`${config.publicUrl}/approve/${token}`, { type: 'svg', margin: 1, color: { dark: '#003087', light: '#ffffff' } });
    return c.body(svg, 200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
  });
  for (const decision of ['approve', 'reject']) {
    // The single-use token IS the credential here (it is what the QR code / phone link carries).
    app.post(`/api/approvals/:token/${decision}`, async (c) => {
      const body = await c.req.json().catch(() => ({}));
      return c.json(await decideApproval(ctx, c.req.param('token'), decision, String(body.note || ''), 'owner'));
    });
  }
  app.get('/approve/:token', (c) => c.html(readFileSync(join(PUBLIC_DIR, 'approve.html'), 'utf8')));

  // ---- tasks, invoices, checkout ----
  app.post('/api/tasks/:id/decision', requireOwner, async (c) => {
    const { accepted } = await c.req.json();
    return c.json(decideTask(ctx, c.req.param('id'), Boolean(accepted)));
  });
  app.post('/api/tasks/:id/invoice', requireOwner, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await createTaskInvoice(ctx, c.req.param('id'), { lineItems: body.line_items, dueInDays: body.due_in_days ?? 14, note: body.note }));
  });
  app.post('/api/tasks/:id/checkout', requireOwner, async (c) => c.json(await createCheckoutLink(ctx, c.req.param('id'))));
  app.post('/api/invoices/:id/remind', requireOwner, async (c) => c.json(await remindInvoice(ctx, c.req.param('id'))));
  app.post('/api/invoices/:id/paid-offline', requireOwner, async (c) => c.json(await recordInvoiceOffline(ctx, c.req.param('id'))));

  // Buyer returns here after approving at PayPal; we capture and show a plain confirmation.
  app.get('/checkout/return', async (c) => {
    const paypalOrderId = c.req.query('token');
    if (!paypalOrderId) return c.html('<p>Missing order token.</p>', 400);
    const order = await captureCheckout(ctx, paypalOrderId);
    return c.html(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>Payment ${order.status === 'captured' ? 'received' : 'pending'}</h1><p>Thank you. Order <code>${paypalOrderId.replace(/[^A-Z0-9]/gi, '')}</code> is ${order.status}.</p></body>`);
  });
  app.get('/checkout/cancel', (c) => c.html('<p style="font-family:system-ui;margin:4rem auto;max-width:32rem">Checkout cancelled. No money moved.</p>'));

  // ---- disputes ----
  app.post('/api/disputes/:id/analyze', requireOwner, async (c) => { rateLimit(c); return c.json(await analyzeDispute(ctx, c.req.param('id'))); });
  app.post('/api/disputes/:id/decision', requireOwner, async (c) => {
    const body = await c.req.json();
    return c.json(await decideDispute(ctx, c.req.param('id'), body.decision, { note: body.note, message: body.message }));
  });

  // ---- AI ----
  app.post('/api/agents/:id/run', requireOwner, async (c) => {
    rateLimit(c);
    const body = await c.req.json().catch(() => ({}));
    return c.json(await runAgent(ctx, c.req.param('id'), body.instruction, body.task_id || null));
  });
  app.post('/api/ask', requireOwner, async (c) => {
    rateLimit(c);
    const body = await c.req.json().catch(() => ({}));
    return c.json(await askTreasurer(ctx, body.question));
  });

  // ---- PayPal plumbing ----
  app.post('/api/reconcile', requireOwner, async (c) => c.json(await reconcile(ctx)));
  app.post('/webhooks/paypal', async (c) => {
    const raw = await c.req.text();
    const res = await handleWebhook(ctx, c.req.raw.headers, raw);
    return c.json(res);
  });

  app.use('/*', serveStatic({ root: relative(process.cwd(), PUBLIC_DIR) || '.' }));
  return app;
}
