import test from 'node:test';
import assert from 'node:assert/strict';
import { all, one } from '../src/db.js';
import { NotConfiguredError } from '../src/config.js';
import { analyzeDispute, askTreasurer, parseAnalysis, runAgent } from '../src/agents.js';
import { fakeClaude, fakePayPal, makeCtx } from './helpers.js';

const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const text = (t) => ({ type: 'text', text: t });

test('agent run: model calls request_spend, policy gates it, transcript + audit are stored', async () => {
  const claude = fakeClaude([
    [text('Checking budget.'), use('tu1', 'get_budget', {})],
    [use('tu2', 'request_spend', { task_id: 'task_launch_video', vendor_name: 'VoiceBank', vendor_email: 'v@example.com', category: 'voice', amount_usd: 45, justification: 'Narration', expected_result: 'Voice track' })],
    [text('Voice-over requested; $45 waits for owner approval.')],
  ]);
  const ctx = makeCtx({ paypal: fakePayPal(), claude });
  const out = await runAgent(ctx, 'vega', 'Order a voice-over for the launch video', 'task_launch_video');
  assert.equal(out.steps.filter((s) => s.type === 'tool').length, 2);
  const spend = out.steps.find((s) => s.name === 'request_spend');
  assert.equal(spend.output.verdict, 'needs_approval');
  assert.equal(spend.is_error, false);
  assert.match(out.final_text, /waits for owner approval/);
  assert.equal(out.tokens_in, 30);
  assert.equal(all(ctx.db, 'SELECT * FROM agent_runs').length, 1);
  assert.equal(all(ctx.db, "SELECT * FROM spend_requests WHERE status='pending'").length, 1);
  // tool results are fed back to the model in the next request
  const lastReq = claude.requests.at(-1);
  assert.equal(lastReq.messages.at(-1).content[0].type, 'tool_result');
  assert.equal(lastReq.model, 'claude-sonnet-5-5');
});

test('agent cannot touch another agent\'s task, and tool errors go back to the model as is_error', async () => {
  const claude = fakeClaude([
    [use('a', 'mark_task_done', { task_id: 'task_gpu_render', result_summary: 'x' })],
    [text('Not mine.')],
  ]);
  const ctx = makeCtx({ paypal: fakePayPal(), claude });
  const out = await runAgent(ctx, 'vega', 'finish the render task');
  assert.equal(out.steps[0].is_error, true);
  assert.match(out.steps[0].output.error, /belongs to orion/);
  assert.equal(one(ctx.db, "SELECT status FROM tasks WHERE id='task_gpu_render'").status, 'open');
});

test('without PayPal, a model-requested auto payment returns an error to the model - no fake success', async () => {
  const claude = fakeClaude([
    [use('a', 'create_invoice', { task_id: 'task_launch_video' })],
    [text('Could not invoice: PayPal is not configured.')],
  ]);
  const ctx = makeCtx({ paypal: null, claude });
  const out = await runAgent(ctx, 'vega', 'invoice the client');
  assert.equal(out.steps[0].is_error, true);
  assert.equal(out.steps[0].output.error, 'PayPal not configured');
  assert.equal(all(ctx.db, 'SELECT * FROM invoices').length, 0);
});

test('tool loop stops after 8 tool steps (safety limit)', async () => {
  const claude = fakeClaude([[use('a', 'get_budget', {}), use('b', 'get_budget', {}), use('c', 'get_budget', {}), use('d', 'get_budget', {}), use('e', 'get_budget', {})]]);
  const ctx = makeCtx({ paypal: fakePayPal(), claude });
  const out = await runAgent(ctx, 'vega', 'loop forever');
  assert.equal(out.truncated, true);
  assert.equal(out.steps.filter((s) => s.type === 'tool').length, 5, 'first batch of 5 runs, the next batch would exceed 8');
  assert.ok(claude.requests.length <= 3);
});

test('no Claude key -> NotConfiguredError (HTTP 503 upstream)', async () => {
  const ctx = makeCtx({ claude: null });
  await assert.rejects(runAgent(ctx, 'vega', 'hi'), NotConfiguredError);
  await assert.rejects(askTreasurer(ctx, 'q'), NotConfiguredError);
});

test('AI_DAILY_CAP stops further model calls', async () => {
  const claude = fakeClaude([[text('ok')]]);
  const ctx = makeCtx({ claude, env: { AI_DAILY_CAP: '2' } });
  await runAgent(ctx, 'vega', 'one');
  await runAgent(ctx, 'vega', 'two');
  await assert.rejects(runAgent(ctx, 'vega', 'three'), (e) => e.status === 429 && /Daily Claude cap/.test(e.message));
  assert.equal(claude.requests.length, 2);
});

test('input validation: empty and oversized instructions, unknown agent', async () => {
  const ctx = makeCtx({ claude: fakeClaude([[text('x')]]) });
  await assert.rejects(runAgent(ctx, 'vega', '   '), /instruction is required/);
  await assert.rejects(runAgent(ctx, 'vega', 'x'.repeat(2001)), /too long/);
  await assert.rejects(runAgent(ctx, 'nobody', 'hi'), (e) => e.status === 404);
});

test('treasurer answers from query_ledger and reports cited ledger ids', async () => {
  const claude = fakeClaude([
    [use('q', 'query_ledger', { kind: 'spend', category: 'gpu' })],
    [text('You spent $38.00 on GPUs [led_aaa111] which produced 48 frames.')],
  ]);
  const ctx = makeCtx({ claude });
  const out = await askTreasurer(ctx, 'What did we spend on GPUs this month?');
  assert.deepEqual(out.cited_ledger_ids, ['led_aaa111']);
  assert.equal(out.steps[0].output.count, 0);
});

test('parseAnalysis validates the dispute analyst JSON', () => {
  const a = parseAnalysis('Here: {"summary":"s","evidence_we_have":["invoice"],"risk":"low","recommendation":"provide_evidence","draft_message":"hi"} done');
  assert.equal(a.recommendation, 'provide_evidence');
  assert.throws(() => parseAnalysis('{"recommendation":"burn_it"}'), /not one of/);
  assert.throws(() => parseAnalysis('no json'), /no JSON/);
  assert.equal(parseAnalysis('{"recommendation":"accept_claim","risk":"weird"}').risk, 'medium');
});

test('analyzeDispute stores the analysis and recommendation (human still decides)', async () => {
  const claude = fakeClaude([[text('{"summary":"Client got the video","evidence_we_have":["accepted task"],"risk":"low","recommendation":"provide_evidence","draft_message":"Delivered on time."}')]]);
  const ctx = makeCtx({ claude });
  ctx.db.prepare("INSERT INTO disputes(id,paypal_dispute_id,reason,status,amount_cents,linked_task_id,created_at) VALUES('dsp_1','PP-D-1','NOT_RECEIVED','OPEN',65000,'task_gpu_render',?)").run(new Date().toISOString());
  await analyzeDispute(ctx, 'dsp_1');
  const d = one(ctx.db, 'SELECT * FROM disputes');
  assert.equal(d.recommendation, 'provide_evidence');
  assert.equal(d.human_decision, null);
  assert.equal(JSON.parse(d.ai_analysis).risk, 'low');
});
