# Atlas Treasury — build spec (v1)

PayPal-native treasury for a company run by AI agents. Agents **earn** (PayPal Invoicing, Orders checkout), **spend**
within budgets (PayPal Payouts), and every out-of-policy payment waits for **one tap from the human owner on a phone**.
Every payment is linked to the task that caused it and the result it produced. Refunds and disputes are triaged by an
agent and decided by the human.

Motto: **"The LLM proposes, the policy engine disposes, the human signs."** Money rules are deterministic code, never the LLM.

Hackathon: PayPal AI Hackathon (Devpost). Judges: PayPal engineers. Criteria: Technological Implementation, Design,
Potential Impact, Innovation, Presentation. Public MIT repo. Sandbox only — never real money.

## Stack (fixed)
- Node 22 (ESM, `"type":"module"`), **Hono** + `@hono/node-server`. Storage: built-in `node:sqlite` (`DatabaseSync`), file path from
  `DB_PATH` (default `./data/treasury.db`). No native deps, no ORM.
- Claude via `@anthropic-ai/sdk`, model from `CLAUDE_MODEL` (default `claude-sonnet-5-5`), tool use loop.
- Frontend: static files in `public/` served by Hono; vanilla ES modules, no build step. **AG Grid Community** from jsDelivr CDN
  for the ledger grid. Clean, modern, light UI (one accent color, system font stack, good spacing), mobile-first approval page.
- Tests: `node --test` (built-in runner). Lint not required.
- Config from env (see `.env.example`): `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_API=https://api-m.sandbox.paypal.com`,
  `PAYPAL_WEBHOOK_ID`, `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `PUBLIC_URL`, `PORT` (default 8787), `DB_PATH`, `ADMIN_TOKEN`,
  `AI_DAILY_CAP` (default 300 Claude calls/day), `DEMO_MODE=1`.
- No secrets in repo. `.env` in `.gitignore`. Fail loudly on missing required config at startup (list what is missing),
  except PayPal/Claude may be absent in `npm test`.

## Domain (SQLite tables)
- `agents(id TEXT PK, name, role, emoji, monthly_budget_cents INT, per_tx_auto_limit_cents INT, allowed_categories TEXT json, payout_email)`
- `tasks(id TEXT PK, agent_id, title, client_name, client_email, status TEXT  -- open|done|accepted|rejected, result_summary, result_url, price_cents, created_at, accepted_at)`
- `spend_requests(id PK, agent_id, task_id, vendor_name, vendor_email, category, amount_cents, currency, justification, expected_result,
   policy_verdict TEXT -- auto|needs_approval|blocked, policy_reasons TEXT json, status -- pending|approved|rejected|paid|failed,
   approval_token, decided_by, decided_at, decision_note, payout_batch_id, payout_item_id, created_at)`
- `ledger(id PK, kind -- income|spend|refund|dispute_hold|dispute_release, amount_cents (signed: income +, spend -), currency,
   agent_id, task_id, spend_request_id, paypal_ref_type -- invoice|order|capture|payout|refund|dispute, paypal_ref_id, status, memo, created_at)`
- `invoices(id PK, task_id, agent_id, paypal_invoice_id, paypal_invoice_number, payer_view_url, amount_cents, currency, status, reminders INT, created_at, paid_at)`
- `orders(id PK, task_id, paypal_order_id, capture_id, amount_cents, status, created_at)`
- `disputes(id PK, paypal_dispute_id, reason, status, amount_cents, linked_task_id, linked_capture_id, ai_analysis TEXT json, recommendation, human_decision, created_at)`
- `events(id PK, source -- paypal_webhook|agent|human|policy, type, payload TEXT json, verified INT, created_at)`  ← audit trail
- `agent_runs(id PK, agent_id, task_id, input, transcript TEXT json, tokens_in, tokens_out, created_at)`
Seed (idempotent, `npm run seed`, also on first start when DB empty): 4 agents —
`atlas` (CEO / orchestrator, budget $500, auto ≤ $50), `vega` (video studio, $300, auto ≤ $25, categories gpu,stock-media,voice),
`orion` (infrastructure, $400, auto ≤ $40, categories server,gpu,saas), `lyra` (sales & client care, $150, auto ≤ $15, categories ads,saas).
Payout emails = sandbox personal account emails from env `SANDBOX_VENDOR_EMAILS` (comma list) or placeholder `vendor@example.com`.
Seed 3 tasks with realistic client work (e.g. "Product launch video for a camera shop", "Price-monitoring report", "GPU render of 3D product shots").

## Policy engine (`src/policy.js`, pure functions, fully unit-tested)
`evaluate(request, agent, monthSpentCents, context) -> {verdict, reasons[]}`:
- blocked: amount ≤ 0, currency not allowed, vendor on denylist, no task_id (every spend must be tied to a task), task not open/done.
- needs_approval: amount > per_tx_auto_limit; month spent + amount > monthly_budget; category not in agent.allowed_categories;
  new vendor (never paid before); spend > 60% of task price (margin guard) when task has price.
- auto otherwise. Reasons are human sentences ("Over Vega's per-payment limit: $45 > $25").

## PayPal client (`src/paypal.js`)
Thin fetch wrapper with OAuth2 client-credentials token cache, `PayPal-Request-Id` idempotency header on every POST,
throws `PayPalError` with status + debug_id + details. Functions:
- Invoicing v2: `createInvoice`, `sendInvoice`, `getInvoice`, `remindInvoice`, `recordPayment` (POST /v2/invoicing/invoices/{id}/payments — used only by the
  explicit "client paid offline" button), `cancelInvoice`, `generateNextInvoiceNumber`.
- Orders v2: `createOrder` (intent CAPTURE, purchase_units with custom_id=task id, invoice_id), `captureOrder`, `getOrder`.
- Payments v2: `refundCapture(captureId, amount, note)`.
- Payouts v1: `createPayout(items, senderBatchId)`, `getPayoutBatch`.
- Disputes v1: `listDisputes`, `getDispute`, `acceptClaim`, `provideEvidence` (multipart not needed — notes only), `sendMessage`.
- Webhooks: `verifyWebhookSignature(headers, rawBody)` via POST /v1/notifications/verify-webhook-signature; `ensureWebhook(url, events)`
  (list → create if missing), used by `npm run setup:webhook`.
Unit tests mock `fetch` (inject via param), not the network.

## Webhooks (`POST /webhooks/paypal`)
Read raw body, verify signature (reject 400 when invalid, unless `PAYPAL_WEBHOOK_ID` empty → mark verified=0 and log loudly).
Store every event in `events`. Idempotent on `event.id`. Handle:
`INVOICING.INVOICE.PAID` → invoice paid, ledger income, task → mark paid; `PAYMENT.CAPTURE.COMPLETED` → order captured, ledger income;
`PAYMENT.CAPTURE.REFUNDED` → ledger refund; `PAYMENT.PAYOUTSBATCH.SUCCESS|DENIED`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED|FAILED|UNCLAIMED|RETURNED` →
spend_request paid/failed, ledger spend; `CUSTOMER.DISPUTE.CREATED|UPDATED|RESOLVED` → disputes upsert, ledger hold/release, trigger dispute analyst.
Also a reconciler (`POST /api/reconcile`, and every 2 min in-process) that polls invoice/payout/order status for anything pending —
webhooks can be late in sandbox; the UI must never get stuck.

## Agents with Claude (`src/agents.js`)
One tool-use loop, system prompt per agent role. Tools (JSON schemas, English field names):
`get_task`, `list_open_tasks`, `get_budget` (remaining month budget, auto limit), `mark_task_done(task_id, result_summary, result_url)`,
`create_invoice(task_id, line_items[], due_in_days, note)`, `create_checkout_link(task_id)` (Orders → approve link),
`request_spend(task_id, vendor_name, vendor_email, category, amount_usd, justification, expected_result)` → goes to policy engine;
auto → payout executes immediately; needs_approval → approval card; returns verdict to the model,
`send_invoice_reminder(invoice_id)`, `query_ledger(filter)`.
The LLM never calls PayPal directly — only these tools; amounts are validated in code (max $2,000 per request, 2 decimals).
Endpoints:
- `POST /api/agents/:id/run {instruction, task_id?}` → runs loop (max 8 tool steps), stores transcript in agent_runs, returns
  steps (tool calls + results + final text) for the UI timeline.
- `POST /api/ask {question}` → "Treasurer" answers questions over the ledger (tools: query_ledger, get_budget, list tasks) with
  cited row ids, e.g. "What did we spend on GPUs this month and what did it produce?".
- Dispute analyst: on dispute create/update, Claude reads the dispute + linked task + result + invoice/order and returns JSON
  `{summary, evidence_we_have[], risk, recommendation: accept_claim|provide_evidence|offer_refund, draft_message}`. Human decides in UI.
Daily cap `AI_DAILY_CAP` and per-IP rate limit (20 runs/hour) to protect the public demo; when Claude key missing → 503 with clear message.

## Human approval
- Approval card JSON `GET /api/approvals`, page `GET /approve/:token` — mobile-first: agent avatar, amount, vendor, task, the
  agent's justification, the policy reasons in red, the remaining budget bar, expected result; two huge buttons Approve / Reject
  + optional note. Approve → `POST /api/approvals/:token/approve` → payout executes → ledger. Token single-use, 48 h expiry.
- Desktop dashboard shows pending approvals with a **QR code** (generate SVG server-side with `qrcode` npm package) to open the
  approval on a phone. This is the demo money-shot.
- Optional: `APPROVAL_WEBHOOK_URL` — POST the card JSON there (our real system forwards it to the owner's phone). Not required.

## UI (`public/`)
Single page app with hash routes, header "Atlas Treasury" + "Sandbox" badge:
1. **Overview**: KPI tiles (earned this month, spent, net, pending approvals, open disputes), per-agent cards with budget bars
   (spent / budget, earned, ROI = earned / spent), "Run agent" box per agent (instruction textarea + preset buttons).
2. **Ledger** (AG Grid Community): every money movement, columns: time, kind, agent, amount (colored), task, result (accepted?),
   PayPal ref (link to sandbox dashboard where possible), status, "why" memo. Grouping by agent, quick filter, CSV export.
   Row click → "Proof chain" side panel: task → spend request → policy verdict → human decision → PayPal ids → webhook events → result.
3. **Approvals**: pending + history.
4. **Invoices & checkout**: list, payer link, status, remind, "client paid offline" button.
5. **Disputes**: list, AI analysis, buttons that call the PayPal Disputes API after human click.
6. **Agent timeline**: last runs with tool steps rendered as a vertical timeline.
7. **Audit**: events table (webhook/agent/human/policy), verified flag.
8. **Ask the treasurer** chat box.
No text truncation with ellipsis: wrap text. No visible scrollbars where avoidable. Works at 390 px wide.

## Repo files
`README.md` (what it is, architecture diagram in mermaid, PayPal APIs used and where, how AI is used, run locally in 5 steps,
sandbox test accounts placeholder section, judges' quick tour), `LICENSE` (MIT, "Ihor Kolosov"), `.env.example`, `package.json`
scripts: `start`, `dev` (node --watch), `test`, `seed`, `setup:webhook`; `render.yaml` (Render web service, free plan, disk not
required); `Dockerfile` (node:22-slim). `src/` modules, `test/` tests. Keep code readable, comments explain WHY.

## Definition of done for the build helper
`npm test` green (policy, paypal client with mocked fetch, webhook idempotency + handler mapping, approval flow with mocked PayPal);
`npm start` boots with `DEMO_MODE=1` even without PayPal/Claude keys (UI loads, seed visible, PayPal/AI actions return clear
"not configured" errors); `curl localhost:8787/api/health` → JSON with which integrations are configured.
