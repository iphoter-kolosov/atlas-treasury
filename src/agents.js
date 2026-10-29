// Claude agents. The model can only call the tools below; each tool is a thin, validated wrapper over treasury.js.
// It never sees PayPal credentials and never talks to PayPal directly.

import { all, insert, nowIso, one, uid, update } from './db.js';
import { NotConfiguredError } from './config.js';
import { fmtUsd } from './money.js';
import {
  TreasuryError, budgetSnapshot, captureCheckout, createCheckoutLink, createSpendRequest, createTaskInvoice, getAgent, getTask,
  logEvent, markTaskDone, remindInvoice,
} from './treasury.js';

export const MAX_TOOL_STEPS = 8;

export function createClaudeClient(apiKey, Anthropic) {
  return new Anthropic({ apiKey });
}

export function requireClaude(ctx) {
  if (!ctx.claude) throw new NotConfiguredError('Claude');
  return ctx.claude;
}

/** Daily cap protects a public demo from running up the bill. Counted per UTC day, per process-independent DB row. */
export function bumpAiCalls(ctx) {
  const day = new Date().toISOString().slice(0, 10);
  const row = one(ctx.db, 'SELECT calls FROM ai_calls WHERE day=?', day);
  if ((row?.calls || 0) >= ctx.config.aiDailyCap) throw new TreasuryError(`Daily Claude cap reached (${ctx.config.aiDailyCap} calls/day). Try again tomorrow.`, 429);
  ctx.db.prepare('INSERT INTO ai_calls(day, calls) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET calls=calls+1').run(day);
}

// ---- tool schemas -------------------------------------------------------------------
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const TASK_ID = { type: 'string', description: 'Task id, e.g. task_launch_video' };

export const AGENT_TOOLS = [
  { name: 'get_task', description: 'Read one task: client, price, status, result.', input_schema: obj({ task_id: TASK_ID }, ['task_id']) },
  { name: 'list_open_tasks', description: 'List tasks you can work on (open or done, not yet accepted).', input_schema: obj({}) },
  { name: 'get_budget', description: 'Your remaining monthly budget, auto-approval limit, allowed categories, earned amount and ROI.', input_schema: obj({}) },
  {
    name: 'mark_task_done', description: 'Record that the task result is delivered. Provide a factual summary and a link to the result.',
    input_schema: obj({ task_id: TASK_ID, result_summary: { type: 'string' }, result_url: { type: 'string' } }, ['task_id', 'result_summary']),
  },
  {
    name: 'create_invoice', description: 'Create and email a PayPal invoice to the task client. Amounts in USD with at most 2 decimals. Defaults to the task price if line_items is empty.',
    input_schema: obj({
      task_id: TASK_ID,
      line_items: { type: 'array', items: obj({ name: { type: 'string' }, quantity: { type: 'integer', minimum: 1 }, unit_amount_usd: { type: 'number' } }, ['name', 'unit_amount_usd']) },
      due_in_days: { type: 'integer', minimum: 0, maximum: 60 }, note: { type: 'string' },
    }, ['task_id']),
  },
  { name: 'create_checkout_link', description: 'Create a PayPal checkout link (Orders API) for the full task price. Share the returned approve_url with the client.', input_schema: obj({ task_id: TASK_ID }, ['task_id']) },
  {
    name: 'request_spend',
    description: 'Ask to pay a vendor from your budget via PayPal Payouts. The policy engine decides: auto (paid at once), needs_approval (waits for the human owner) or blocked. Max $2,000. You cannot override the verdict.',
    input_schema: obj({
      task_id: TASK_ID, vendor_name: { type: 'string' }, vendor_email: { type: 'string', description: 'PayPal email of the vendor' },
      category: { type: 'string', description: 'e.g. gpu, stock-media, voice, server, saas, ads' }, amount_usd: { type: 'number' },
      justification: { type: 'string', description: 'Why this payment is needed, for the human reviewer' }, expected_result: { type: 'string', description: 'What this payment will produce' },
    }, ['task_id', 'vendor_name', 'vendor_email', 'category', 'amount_usd', 'justification', 'expected_result']),
  },
  { name: 'send_invoice_reminder', description: 'Send a PayPal reminder for an unpaid invoice (use the local invoice id, e.g. inv_ab12).', input_schema: obj({ invoice_id: { type: 'string' } }, ['invoice_id']) },
  { name: 'query_ledger', description: 'Query the money ledger. All filters optional.', input_schema: ledgerFilterSchema() },
];

function ledgerFilterSchema() {
  return obj({
    kind: { type: 'string', enum: ['income', 'spend', 'refund', 'dispute_hold', 'dispute_release'] },
    agent_id: { type: 'string' }, task_id: { type: 'string' }, category: { type: 'string' },
    since_days: { type: 'integer', minimum: 1, maximum: 365 }, limit: { type: 'integer', minimum: 1, maximum: 100 },
  });
}

export const TREASURER_TOOLS = [
  AGENT_TOOLS.find((t) => t.name === 'query_ledger'),
  { name: 'get_budget', description: 'Budget snapshot for one agent.', input_schema: obj({ agent_id: { type: 'string' } }, ['agent_id']) },
  { name: 'list_tasks', description: 'All tasks with status, price and result.', input_schema: obj({}) },
  // Sent-but-unpaid invoices are receivables, not ledger rows yet; without this the treasurer cannot answer "what is owed to us".
  { name: 'list_invoices', description: 'All PayPal invoices with status (sent/paid/cancelled), amount, task and PayPal invoice number.', input_schema: obj({}) },
];

// ---- tool implementations ----------------------------------------------------------------
export function queryLedger(ctx, f = {}) {
  const where = [];
  const params = [];
  for (const [col, key] of [['l.kind', 'kind'], ['l.agent_id', 'agent_id'], ['l.task_id', 'task_id'], ['s.category', 'category']]) {
    if (f[key]) { where.push(`${col}=?`); params.push(String(f[key])); }
  }
  if (f.since_days) { where.push('l.created_at>=?'); params.push(new Date(Date.now() - Number(f.since_days) * 86400_000).toISOString()); }
  const limit = Math.min(Number(f.limit) || 50, 100);
  const rows = all(ctx.db, `SELECT l.id, l.kind, l.amount_cents, l.agent_id, l.task_id, l.status, l.memo, l.created_at, s.category, s.vendor_name, s.expected_result, t.status AS task_status, t.result_summary
    FROM ledger l LEFT JOIN spend_requests s ON s.id=l.spend_request_id LEFT JOIN tasks t ON t.id=l.task_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.created_at DESC LIMIT ${limit}`, ...params);
  return { count: rows.length, total_cents: rows.reduce((s, r) => s + r.amount_cents, 0), rows };
}

const ownsTask = (agent, task) => agent.id === 'atlas' || task.agent_id === agent.id;
function mustOwn(ctx, agent, taskId) {
  const task = getTask(ctx, taskId);
  if (!task) throw new TreasuryError(`Unknown task ${taskId}`, 404);
  if (!ownsTask(agent, task)) throw new TreasuryError(`Task ${taskId} belongs to ${task.agent_id}, not to ${agent.id}`, 403);
  return task;
}

function agentHandlers(ctx, agent, runCtx) {
  return {
    get_task: ({ task_id }) => mustOwn(ctx, agent, task_id),
    list_open_tasks: () => all(ctx.db, "SELECT id,title,client_name,status,price_cents,result_summary,agent_id FROM tasks WHERE status IN ('open','done') AND (agent_id=? OR ?='atlas')", agent.id, agent.id),
    get_budget: () => budgetSnapshot(ctx, agent.id),
    mark_task_done: ({ task_id, result_summary, result_url }) => { mustOwn(ctx, agent, task_id); return markTaskDone(ctx, task_id, result_summary, result_url); },
    create_invoice: async ({ task_id, line_items, due_in_days, note }) => {
      mustOwn(ctx, agent, task_id);
      return createTaskInvoice(ctx, task_id, { lineItems: line_items, dueInDays: due_in_days ?? 14, note });
    },
    create_checkout_link: async ({ task_id }) => { mustOwn(ctx, agent, task_id); return createCheckoutLink(ctx, task_id); },
    request_spend: async (a) => {
      mustOwn(ctx, agent, a.task_id);
      const sr = await createSpendRequest(ctx, agent.id, a.task_id, a);
      runCtx.spendRequests.push(sr.id);
      return { spend_request_id: sr.id, verdict: sr.policy_verdict, status: sr.status, reasons: sr.policy_reasons, note: sr.policy_verdict === 'needs_approval' ? 'Waiting for the human owner; do not retry or split the payment.' : undefined };
    },
    send_invoice_reminder: ({ invoice_id }) => remindInvoice(ctx, invoice_id),
    query_ledger: (f) => queryLedger(ctx, f),
  };
}

// ---- generic tool-use loop ---------------------------------------------------------------------
export async function runToolLoop(ctx, { system, tools, handlers, userText, maxSteps = MAX_TOOL_STEPS, maxTokens = 1500 }) {
  const claude = requireClaude(ctx);
  const messages = [{ role: 'user', content: userText }];
  const steps = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let finalText = '';
  let toolSteps = 0;
  let truncated = false;

  for (;;) {
    bumpAiCalls(ctx);
    const res = await claude.messages.create({ model: ctx.config.claudeModel, max_tokens: maxTokens, system, tools, messages });
    tokensIn += res.usage?.input_tokens || 0;
    tokensOut += res.usage?.output_tokens || 0;
    messages.push({ role: 'assistant', content: res.content });
    for (const b of res.content) if (b.type === 'text' && b.text.trim()) steps.push({ type: 'text', text: b.text });
    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !uses.length) {
      finalText = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      break;
    }
    if (toolSteps + uses.length > maxSteps) { truncated = true; break; }
    const results = [];
    for (const u of uses) {
      toolSteps += 1;
      let output;
      let isError = false;
      try {
        const fn = handlers[u.name];
        if (!fn) throw new TreasuryError(`Unknown tool ${u.name}`);
        output = await fn(u.input || {});
      } catch (e) {
        isError = true;
        output = { error: e.message, ...(e.status ? { status: e.status } : {}) };
      }
      steps.push({ type: 'tool', name: u.name, input: u.input, output, is_error: isError });
      results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(output), ...(isError ? { is_error: true } : {}) });
    }
    messages.push({ role: 'user', content: results });
  }
  if (truncated) finalText = finalText || `Stopped after ${maxSteps} tool steps (safety limit).`;
  return { steps, finalText, tokensIn, tokensOut, truncated };
}

const agentSystem = (agent) => `You are ${agent.name} ${agent.emoji || ''}, the ${agent.role} of Atlas Corp, a company run entirely by AI agents that holds a PayPal account.
Your monthly budget is ${fmtUsd(agent.monthly_budget_cents)}; payments up to ${fmtUsd(agent.per_tx_auto_limit_cents)} in categories [${agent.allowed_categories.join(', ') || 'none'}] are auto-approved, everything else waits for the human owner.
Rules: money only moves through your tools. The policy engine's verdict is final - never try to split a payment to dodge a limit, never retry a payment that is waiting for approval.
Every payment must belong to a task and say what result it will produce. Be concise: act with tools, then give a 2-3 sentence summary of what you did and what is pending.`;

export async function runAgent(ctx, agentId, instruction, taskId = null) {
  const agent = getAgent(ctx, agentId);
  if (!agent) throw new TreasuryError(`Unknown agent ${agentId}`, 404);
  requireClaude(ctx);
  const text = String(instruction || '').trim();
  if (!text) throw new TreasuryError('instruction is required');
  if (text.length > 2000) throw new TreasuryError('instruction is too long (max 2000 chars)');
  const runCtx = { spendRequests: [] };
  const userText = taskId ? `${text}\n\n(Focus task id: ${taskId})` : text;
  const out = await runToolLoop(ctx, { system: agentSystem(agent), tools: AGENT_TOOLS, handlers: agentHandlers(ctx, agent, runCtx), userText });
  const runId = uid('run');
  insert(ctx.db, 'agent_runs', {
    id: runId, agent_id: agentId, task_id: taskId, input: text, transcript: JSON.stringify(out.steps),
    tokens_in: out.tokensIn, tokens_out: out.tokensOut, created_at: nowIso(),
  });
  logEvent(ctx, 'agent', 'agent.run', { run_id: runId, agent_id: agentId, spend_requests: runCtx.spendRequests }, { refs: [runId, ...runCtx.spendRequests] });
  return { run_id: runId, agent_id: agentId, steps: out.steps, final_text: out.finalText, tokens_in: out.tokensIn, tokens_out: out.tokensOut, truncated: out.truncated };
}

// ---- the Treasurer: Q&A over the ledger -------------------------------------------------------------
export async function askTreasurer(ctx, question) {
  const q = String(question || '').trim();
  if (!q) throw new TreasuryError('question is required');
  if (q.length > 1000) throw new TreasuryError('question is too long (max 1000 chars)');
  requireClaude(ctx);
  const handlers = {
    query_ledger: (f) => queryLedger(ctx, f),
    get_budget: ({ agent_id }) => budgetSnapshot(ctx, agent_id),
    list_tasks: () => all(ctx.db, 'SELECT id,title,agent_id,client_name,status,price_cents,result_summary,result_url FROM tasks'),
    list_invoices: () => all(ctx.db, 'SELECT id,task_id,agent_id,paypal_invoice_number,amount_cents,currency,status,reminders,created_at,paid_at FROM invoices ORDER BY created_at DESC'),
  };
  const system = `You are the Treasurer of Atlas Corp. Answer the owner's questions about money using ONLY tool results (amounts are integer cents; show dollars).
Cite the ledger rows you rely on as [led_xxxx] using their exact ids, and name the task and result each payment produced. If the data does not answer the question, say so. Be brief.`;
  const out = await runToolLoop(ctx, { system, tools: TREASURER_TOOLS, handlers, userText: q, maxSteps: 6 });
  const cited = [...new Set([...out.finalText.matchAll(/\[(led_[a-f0-9]+)\]/g)].map((m) => m[1]))];
  return { answer: out.finalText, cited_ledger_ids: cited, steps: out.steps };
}

// ---- dispute analyst -----------------------------------------------------------------------------------------
const RECOMMENDATIONS = ['accept_claim', 'provide_evidence', 'offer_refund'];

export function parseAnalysis(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Analyst returned no JSON');
  const j = JSON.parse(m[0]);
  if (!RECOMMENDATIONS.includes(j.recommendation)) throw new Error(`Analyst recommendation "${j.recommendation}" is not one of ${RECOMMENDATIONS.join(', ')}`);
  return {
    summary: String(j.summary || ''), evidence_we_have: Array.isArray(j.evidence_we_have) ? j.evidence_we_have.map(String) : [],
    risk: ['low', 'medium', 'high'].includes(j.risk) ? j.risk : 'medium', recommendation: j.recommendation, draft_message: String(j.draft_message || ''),
  };
}

export async function analyzeDispute(ctx, disputeId) {
  requireClaude(ctx);
  const d = one(ctx.db, 'SELECT * FROM disputes WHERE id=?', disputeId);
  if (!d) throw new TreasuryError('Unknown dispute', 404);
  const task = d.linked_task_id ? getTask(ctx, d.linked_task_id) : null;
  const invoices = task ? all(ctx.db, 'SELECT paypal_invoice_number,status,amount_cents,paid_at FROM invoices WHERE task_id=?', task.id) : [];
  const orders = task ? all(ctx.db, 'SELECT paypal_order_id,capture_id,status,amount_cents FROM orders WHERE task_id=?', task.id) : [];
  const facts = { dispute: { id: d.paypal_dispute_id, reason: d.reason, status: d.status, amount_usd: fmtUsd(d.amount_cents || 0) }, task, invoices, orders };
  bumpAiCalls(ctx);
  const res = await ctx.claude.messages.create({
    model: ctx.config.claudeModel, max_tokens: 1200,
    system: `You are the dispute analyst of Atlas Corp. You advise a human; you never decide. Reply with ONLY one JSON object:
{"summary": string, "evidence_we_have": string[], "risk": "low"|"medium"|"high", "recommendation": "accept_claim"|"provide_evidence"|"offer_refund", "draft_message": string}
Base everything strictly on the facts given. If the task has no delivered result, do not recommend fighting the dispute.`,
    messages: [{ role: 'user', content: JSON.stringify(facts) }],
  });
  const analysis = parseAnalysis(res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'));
  update(ctx.db, 'disputes', d.id, { ai_analysis: JSON.stringify(analysis), recommendation: analysis.recommendation });
  logEvent(ctx, 'agent', 'dispute.analyzed', { dispute_id: d.id, recommendation: analysis.recommendation }, { refs: [d.id, d.paypal_dispute_id] });
  return analysis;
}
