// Idempotent seed: 4 agents + 3 tasks. With DEMO_MODE=1 and an empty ledger it also adds clearly-labelled sample history
// so a keyless demo is readable. Sample rows use ids prefixed "demo-" and memo "[demo data]" - they are data, not a code path:
// nothing here pretends PayPal succeeded, and approving the sample request still returns 503 without keys.

import { pathToFileURL } from 'node:url';
import { insert, newToken, nowIso, one, uid } from './db.js';
import { paypalConfigured } from './config.js';

const FALLBACK_VENDOR = 'vendor@example.com';

export function seed(db, config) {
  const vendors = config.sandboxVendorEmails.length ? config.sandboxVendorEmails : [FALLBACK_VENDOR];
  const vendor = (i) => vendors[i % vendors.length];
  const agents = [
    { id: 'atlas', name: 'Atlas', role: 'CEO / orchestrator', emoji: '🧭', monthly_budget_cents: 50000, per_tx_auto_limit_cents: 5000, allowed_categories: ['saas', 'server', 'ads', 'gpu', 'stock-media', 'voice'] },
    { id: 'vega', name: 'Vega', role: 'video studio', emoji: '🎬', monthly_budget_cents: 30000, per_tx_auto_limit_cents: 2500, allowed_categories: ['gpu', 'stock-media', 'voice'] },
    { id: 'orion', name: 'Orion', role: 'infrastructure', emoji: '🛰️', monthly_budget_cents: 40000, per_tx_auto_limit_cents: 4000, allowed_categories: ['server', 'gpu', 'saas'] },
    { id: 'lyra', name: 'Lyra', role: 'sales & client care', emoji: '💬', monthly_budget_cents: 15000, per_tx_auto_limit_cents: 1500, allowed_categories: ['ads', 'saas'] },
  ];
  agents.forEach((a, i) => insert(db, 'agents', { ...a, allowed_categories: JSON.stringify(a.allowed_categories), payout_email: vendor(i) }, { ignore: true }));

  const tasks = [
    { id: 'task_launch_video', agent_id: 'vega', title: 'Product launch video for a camera shop', client_name: 'Lumen Camera Shop', client_email: 'client-lumen@example.com', price_cents: 120000 },
    { id: 'task_price_report', agent_id: 'lyra', title: 'Weekly competitor price-monitoring report', client_name: 'Northwind Optics', client_email: 'client-northwind@example.com', price_cents: 40000 },
    { id: 'task_gpu_render', agent_id: 'orion', title: 'GPU render of 3D product shots (48 frames)', client_name: 'Brightside Studio', client_email: 'client-brightside@example.com', price_cents: 65000 },
  ];
  tasks.forEach((t) => insert(db, 'tasks', { ...t, status: 'open', created_at: nowIso() }, { ignore: true }));

  // Sample history only for a keyless demo: with real sandbox keys it would collide with live PayPal data (agents rightly flag "duplicates").
  if (config.demoMode && !paypalConfigured(config) && one(db, 'SELECT COUNT(*) c FROM ledger').c === 0) seedDemoHistory(db, vendor);
}

function seedDemoHistory(db, vendor) {
  const day = (n) => new Date(Date.now() - n * 86400_000).toISOString();
  const memo = (s) => `${s} [demo data]`;
  db.prepare("UPDATE tasks SET status='accepted', result_summary=?, result_url=?, accepted_at=?, paid_at=? WHERE id='task_price_report'")
    .run('Delivered a 12-page report covering 41 competitor SKUs.', 'https://example.com/report', day(3), day(2));
  db.prepare("UPDATE tasks SET status='done', result_summary=? WHERE id='task_launch_video'").run('Final 45 s cut rendered and delivered for review.');
  insert(db, 'invoices', { id: 'demo-inv-1', task_id: 'task_price_report', agent_id: 'lyra', paypal_invoice_id: 'DEMO-INV-0001', paypal_invoice_number: 'DEMO-0001', amount_cents: 40000, status: 'paid', created_at: day(5), paid_at: day(2) }, { ignore: true });
  const ledger = [
    { id: 'demo-led-1', kind: 'income', amount_cents: 40000, agent_id: 'lyra', task_id: 'task_price_report', paypal_ref_type: 'invoice', paypal_ref_id: 'DEMO-INV-0001', memo: memo('Invoice DEMO-0001 paid - weekly price report'), created_at: day(2) },
    { id: 'demo-led-2', kind: 'spend', amount_cents: -1800, agent_id: 'lyra', task_id: 'task_price_report', spend_request_id: 'demo-sr-1', paypal_ref_type: 'payout', paypal_ref_id: 'DEMO-BATCH-1', memo: memo('Scraping API credits - auto-approved'), created_at: day(4) },
    { id: 'demo-led-3', kind: 'spend', amount_cents: -2400, agent_id: 'vega', task_id: 'task_launch_video', spend_request_id: 'demo-sr-2', paypal_ref_type: 'payout', paypal_ref_id: 'DEMO-BATCH-2', memo: memo('Stock footage pack - auto-approved'), created_at: day(3) },
    { id: 'demo-led-4', kind: 'spend', amount_cents: -3800, agent_id: 'orion', task_id: 'task_gpu_render', spend_request_id: 'demo-sr-3', paypal_ref_type: 'payout', paypal_ref_id: 'DEMO-BATCH-3', memo: memo('GPU hours - approved by owner'), created_at: day(1) },
  ];
  ledger.forEach((l) => insert(db, 'ledger', { ...l, currency: 'USD', status: 'completed' }));
  const sr = (id, agent, task, v, cat, cents, why, result, verdict, reasons, status, decidedBy) => insert(db, 'spend_requests', {
    id, agent_id: agent, task_id: task, vendor_name: v[0], vendor_email: v[1], category: cat, amount_cents: cents, currency: 'USD', justification: why, expected_result: result,
    policy_verdict: verdict, policy_reasons: JSON.stringify(reasons), status, decided_by: decidedBy,
    ...(verdict === 'needs_approval' ? { approval_token: newToken(), approval_expires_at: day(-1) } : {}), decided_at: day(1), payout_batch_id: `DEMO-BATCH-${id.slice(-1)}`, created_at: day(4),
  });
  sr('demo-sr-1', 'lyra', 'task_price_report', ['ScrapeKit', vendor(0)], 'saas', 1800, 'Proxy and scraping credits to collect competitor prices.', '41 SKUs of fresh competitor prices', 'auto', ['Within all limits.'], 'paid', 'policy:auto');
  sr('demo-sr-2', 'vega', 'task_launch_video', ['ClipVault', vendor(1)], 'stock-media', 2400, 'Licensed product b-roll for the intro.', '8 clips, 4K', 'auto', ['Within all limits.'], 'paid', 'policy:auto');
  sr('demo-sr-3', 'orion', 'task_gpu_render', ['RenderFarm Co', vendor(2)], 'gpu', 3800, 'Rent 6 GPU hours for the 48-frame render.', '48 frames of 4K product shots', 'needs_approval', ['New vendor: RenderFarm Co has never been paid before.'], 'paid', 'owner');
  // One live approval so the dashboard shows a QR code on first boot.
  const token = newToken();
  insert(db, 'spend_requests', {
    id: uid('sr'), agent_id: 'vega', task_id: 'task_launch_video', vendor_name: 'VoiceBank Studio', vendor_email: vendor(1), category: 'voice', amount_cents: 4500, currency: 'USD',
    justification: 'Professional voice-over for the 45 s launch video; the client asked for an English narrator.', expected_result: 'Narration track, 45 s, two takes',
    policy_verdict: 'needs_approval', policy_reasons: JSON.stringify(["Over Vega's per-payment limit: $45.00 > $25.00.", 'New vendor: VoiceBank Studio has never been paid before.']),
    status: 'pending', approval_token: token, approval_expires_at: new Date(Date.now() + 48 * 3600_000).toISOString(), created_at: nowIso(),
  });
  insert(db, 'events', { id: uid('ev'), source: 'policy', type: 'spend.needs_approval', payload: JSON.stringify({ note: 'demo data' }), verified: 0, refs: 'task_launch_video', created_at: nowIso() }, { ignore: true });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { loadConfig } = await import('./config.js');
  const { openDb } = await import('./db.js');
  const config = loadConfig();
  const db = openDb(config.dbPath);
  seed(db, config);
  console.log(`Seeded ${config.dbPath}`);
}
