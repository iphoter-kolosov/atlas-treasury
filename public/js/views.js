import { api } from './api.js';
import { approvalCard, openProof, runCard, timeline } from './components.js';
import { badge, budgetBar, busy, emptyState, fmtDate, h, toast, usd } from './ui.js';

const head = (title, sub, extra) => h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, title), sub ? h('p', {}, sub) : null), extra);
const SANDBOX = 'https://www.sandbox.paypal.com';

const PRESETS = {
  atlas: [
    ['Review open tasks', 'Review all open tasks and tell me which ones need attention.'],
    ['Budget position', 'Summarize our budget position across the company.'],
  ],
  vega: [
    ['Order voice-over ($45)', 'Finish the launch video: order a 45 USD voice-over from VoiceBank Studio (voice@example.com, category voice) for task_launch_video.'],
    ['Mark video done', 'Mark the launch video task done with a short result summary.'],
  ],
  orion: [
    ['Rent GPU ($38)', 'Rent GPU time for the render task: 38 USD from RenderFarm Co (gpu@example.com, category gpu) for task_gpu_render.'],
    ['Check my budget', 'Check our remaining server budget.'],
  ],
  lyra: [
    ['Invoice the client', 'Invoice the client of task_price_report for the full task price.'],
    ['Remind unpaid', 'Send a reminder for any unpaid invoice.'],
  ],
};

// ================= Overview =================
export async function overview(root, rerender) {
  const [ov, approvals, tasks, health] = await Promise.all([api('/api/overview'), api('/api/approvals'), api('/api/tasks'), api('/api/health')]);
  const pending = approvals.filter((a) => a.state === 'pending');
  const kpi = (label, value, hint, cls = '', href) => h(href ? 'a' : 'div', { class: `card kpi ${cls}`, href }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'hint' }, hint));
  root.append(
    head('Overview', 'Agents earn through PayPal, spend inside budgets, and you sign what is out of policy.'),
    health.demo_mode && !health.paypal.configured ? h('div', { class: 'banner' }, 'Demo data is shown because PayPal and Claude keys are not configured. Money and AI actions answer with a clear "not configured" error instead of pretending.') : null,
    h('div', { class: 'grid kpis' },
      kpi('Earned this month', usd(ov.earned_cents), 'invoices and checkout', 'pos'),
      kpi('Spent', usd(ov.spent_cents), 'payouts to vendors', 'neg'),
      kpi('Net', usd(ov.net_cents), 'earned - refunds - spent', ov.net_cents >= 0 ? 'pos' : 'neg'),
      kpi('Waiting for you', String(ov.pending_approvals), 'approvals', ov.pending_approvals ? 'warm' : '', '#/approvals'),
      kpi('Open disputes', String(ov.open_disputes), 'needs a human call', '', '#/disputes')),
    pending.length ? h('section', { class: 'block' }, h('h2', {}, 'Waiting for your tap'), h('div', { class: 'grid' }, pending.slice(0, 2).map((c) => approvalCard(c, { onDone: rerender })))) : null,
    h('section', { class: 'block' }, h('h2', {}, 'Agents'), h('div', { class: 'grid agents' }, ov.agents.map((a) => agentCard(a, rerender)))),
    h('section', { class: 'block' }, h('h2', {}, 'Tasks'), tasksTable(tasks, ov.agents, rerender)));
}

function agentCard(a, rerender) {
  const input = h('textarea', { placeholder: `Tell ${a.name} what to do...`, 'aria-label': `Instruction for ${a.name}` });
  const out = h('div');
  const run = async (e) => {
    if (!input.value.trim()) return toast('Write an instruction first', 'error');
    await busy(e.currentTarget, async () => {
      out.replaceChildren(h('div', { class: 'muted' }, h('span', { class: 'spinner' }), ' ', `${a.name} is working...`));
      try {
        const res = await api(`/api/agents/${a.id}/run`, { method: 'POST', body: { instruction: input.value } });
        out.replaceChildren(timeline(res.steps, res.final_text));
      } catch (err) { out.replaceChildren(); throw err; }
    });
  };
  return h('div', { class: 'card agent' },
    h('div', { class: 'agent-head' }, h('div', { class: 'avatar' }, a.emoji), h('div', {}, h('div', { class: 'name' }, a.name), h('div', { class: 'role' }, a.role)),
      h('div', { class: 'roi' }, h('b', {}, a.roi == null ? '-' : `${a.roi}x`), h('span', {}, 'ROI'))),
    budgetBar(a.spent_cents, a.monthly_budget_cents),
    h('div', { class: 'stats' },
      h('div', {}, h('span', {}, 'Earned'), usd(a.earned_cents)), h('div', {}, h('span', {}, 'Remaining'), usd(a.remaining_cents)), h('div', {}, h('span', {}, 'Auto up to'), usd(a.per_tx_auto_limit_cents))),
    h('div', { class: 'chips' }, a.allowed_categories.map((c) => h('span', { class: 'chip' }, c))),
    h('div', { class: 'runbox' },
      input,
      h('div', { class: 'row presets' }, (PRESETS[a.id] || []).map(([label, text]) => h('button', { class: 'ghost small', title: text, onclick: () => { input.value = text; input.focus(); } }, label))),
      h('div', { class: 'row' }, h('button', { onclick: run }, `Run ${a.name}`)), out));
}

function tasksTable(tasks, agents, rerender) {
  const name = (id) => agents.find((a) => a.id === id)?.name || id;
  const decide = (id, accepted) => (e) => busy(e.currentTarget, async () => { await api(`/api/tasks/${id}/decision`, { method: 'POST', body: { accepted } }); rerender(); });
  return h('div', { class: 'card table-wrap' }, h('table', { class: 'table' },
    h('thead', {}, h('tr', {}, ['Task', 'Agent', 'Client', 'Price', 'Status', 'Result', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, tasks.map((t) => h('tr', {},
      h('td', {}, h('b', {}, t.title), h('div', { class: 'mono muted' }, t.id)), h('td', {}, name(t.agent_id)), h('td', {}, t.client_name), h('td', {}, usd(t.price_cents)),
      h('td', {}, badge(t.status), t.paid_at ? [' ', badge('paid', 'green')] : null),
      h('td', { class: 'wrap-text' }, t.result_summary || '-'),
      h('td', {}, t.status === 'done' ? h('div', { class: 'row' }, h('button', { class: 'good small', onclick: decide(t.id, true) }, 'Accept'), h('button', { class: 'danger small', onclick: decide(t.id, false) }, 'Reject')) : null))))));
}

// ================= Ledger =================
const KIND_LABEL = { income: 'Income', spend: 'Spend', refund: 'Refund', dispute_hold: 'Dispute hold', dispute_release: 'Hold released' };

export async function ledger(root) {
  const rows = await api('/api/ledger');
  const agents = [...new Set(rows.map((r) => r.agent_name).filter(Boolean))];
  let agentFilter = null;
  let api_ = null;
  const search = h('input', { type: 'search', placeholder: 'Quick filter...', 'aria-label': 'Quick filter', oninput: (e) => api_?.setGridOption('quickFilterText', e.target.value) });
  const pills = h('div', { class: 'row' });
  const gridEl = h('div', { id: 'ledger-grid' });
  const setAgent = (name) => { agentFilter = name; paintPills(); api_?.onFilterChanged(); updateTotals(); };
  const paintPills = () => pills.replaceChildren(...[null, ...agents].map((n) => h('button', { class: `pill ${agentFilter === n ? 'on' : ''}`, onclick: () => setAgent(n) }, n || 'All agents')));
  const visibleRows = () => rows.filter((r) => !agentFilter || r.agent_name === agentFilter);
  const updateTotals = () => api_?.setGridOption('pinnedBottomRowData', [{ memo: 'Total (visible agent filter)', amount_cents: visibleRows().reduce((s, r) => s + (r.status === 'failed' ? 0 : r.amount_cents), 0), _total: true }]);
  paintPills();

  root.append(head('Ledger', 'Every money movement, linked to the task that caused it. Click a row for the proof chain.',
      h('div', { class: 'row' }, h('button', { class: 'ghost', onclick: () => api_?.exportDataAsCsv({ fileName: 'atlas-ledger.csv' }) }, 'Export CSV'))),
    h('div', { class: 'filters' }, search, pills), gridEl);

  if (!rows.length) return gridEl.replaceWith(emptyState('No money has moved yet.'));
  if (!window.agGrid) { // CDN blocked: still show the data, honestly labelled
    gridEl.replaceWith(h('div', {}, h('div', { class: 'fallback-note' }, 'AG Grid could not load from the CDN; showing a plain table.'), plainLedger(rows)));
    return undefined;
  }
  const money = (p) => { if (p.value == null) return ''; return h('span', { class: `amt ${p.value >= 0 ? 'pos' : 'neg'}` }, usd(p.value)); };
  const refLink = (p) => {
    const r = p.data; if (!r || r._total || !r.paypal_ref_id) return '';
    const base = r.paypal_ref_type === 'invoice' && !String(r.paypal_ref_id).startsWith('DEMO') ? `${SANDBOX}/invoice/details/${r.paypal_ref_id}` : null;
    const label = `${r.paypal_ref_type}: ${r.paypal_ref_id}`;
    return base ? h('a', { href: base, target: '_blank', rel: 'noopener', onclick: (e) => e.stopPropagation() }, label) : h('span', { class: 'mono' }, label);
  };
  const cols = [
    { headerName: 'Time', field: 'created_at', width: 125, minWidth: 110, valueFormatter: (p) => fmtDate(p.value), sort: 'desc' },
    { headerName: 'Kind', field: 'kind', width: 125, minWidth: 110, cellRenderer: (p) => (p.value ? badge(KIND_LABEL[p.value] || p.value, ({ income: 'green', spend: 'red' })[p.value] || 'warm') : '') },
    { headerName: 'Agent', field: 'agent_name', width: 105, minWidth: 100, valueGetter: (p) => (p.data?.agent_name ? `${p.data.agent_emoji} ${p.data.agent_name}` : '') },
    { headerName: 'Amount', field: 'amount_cents', width: 115, minWidth: 105, type: 'rightAligned', cellRenderer: money },
    { headerName: 'Task', field: 'task_title', flex: 1.2, minWidth: 150, wrapText: true, autoHeight: true },
    { headerName: 'Result', field: 'task_status', width: 125, minWidth: 120, cellRenderer: (p) => (p.value ? badge(p.value) : '') },
    { headerName: 'PayPal ref', field: 'paypal_ref_id', flex: 1, minWidth: 160, wrapText: true, autoHeight: true, cellRenderer: refLink },
    { headerName: 'Status', field: 'status', width: 120, minWidth: 115, cellRenderer: (p) => (p.value ? badge(p.value) : '') },
    { headerName: 'Why', field: 'memo', flex: 1.6, minWidth: 200, wrapText: true, autoHeight: true },
  ];
  api_ = window.agGrid.createGrid(gridEl, {
    columnDefs: cols, rowData: rows, defaultColDef: { sortable: true, resizable: true, filter: false, suppressHeaderMenuButton: true, cellClass: 'cell-pad' },
    isExternalFilterPresent: () => Boolean(agentFilter), doesExternalFilterPass: (node) => !agentFilter || node.data.agent_name === agentFilter,
    pinnedBottomRowData: [{ memo: 'Total (visible agent filter)', amount_cents: rows.reduce((s, r) => s + (r.status === 'failed' ? 0 : r.amount_cents), 0), _total: true }],
    onRowClicked: (e) => { if (e.data && !e.data._total) openProof(e.data.id).catch((err) => toast(err.message, 'error')); },
    getRowStyle: (p) => (p.data?._total ? { fontWeight: '700', background: '#f4f6fb' } : { cursor: 'pointer' }),
    animateRows: true,
  });
  return undefined;
}

function plainLedger(rows) {
  return h('div', { class: 'card table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Time', 'Kind', 'Agent', 'Amount', 'Task', 'Status', 'Why'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', { style: 'cursor:pointer', onclick: () => openProof(r.id) }, h('td', {}, fmtDate(r.created_at)), h('td', {}, badge(r.kind)), h('td', {}, r.agent_name || ''),
      h('td', {}, h('span', { class: `amt ${r.amount_cents >= 0 ? 'pos' : 'neg'}` }, usd(r.amount_cents))), h('td', {}, r.task_title || ''), h('td', {}, badge(r.status)), h('td', {}, r.memo))))));
}

// ================= Approvals =================
export async function approvals(root, rerender) {
  const list = await api('/api/approvals');
  const pending = list.filter((a) => a.state === 'pending');
  const history = list.filter((a) => a.state !== 'pending');
  root.append(head('Approvals', 'Out-of-policy payments wait here. Scan the QR code with your phone to approve with one tap.'),
    pending.length ? h('div', { class: 'grid' }, pending.map((c) => approvalCard(c, { onDone: rerender }))) : h('div', { class: 'card' }, emptyState('Nothing waiting. Ask an agent to buy something above its limit and it will show up here.')),
    h('section', { class: 'block' }, h('h2', {}, 'History'),
      history.length ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['When', 'Agent', 'Amount', 'Vendor', 'Decision', 'Note'].map((t) => h('th', {}, t)))),
        h('tbody', {}, history.map((c) => h('tr', {}, h('td', {}, fmtDate(c.created_at)), h('td', {}, `${c.agent.emoji} ${c.agent.name}`), h('td', {}, usd(c.amount_cents)), h('td', {}, c.vendor_name),
          h('td', {}, badge(c.state), c.decided_by ? [' ', h('span', { class: 'muted' }, `by ${c.decided_by}`)] : null), h('td', { class: 'wrap-text' }, c.decision_note || '-')))))) : emptyState('No past decisions yet.')));
}

// ================= Invoices & checkout =================
export async function invoices(root, rerender) {
  const [inv, orders, tasks] = await Promise.all([api('/api/invoices'), api('/api/orders'), api('/api/tasks')]);
  const act = (path, msg) => (e) => busy(e.currentTarget, async () => { await api(path, { method: 'POST', body: {} }); toast(msg, 'ok'); rerender(); });
  root.append(head('Invoices & checkout', 'Income runs through PayPal Invoicing (send, remind, mark paid) and the Orders API (checkout link).'),
    h('section', { class: 'block', style: 'margin-top:0' }, h('h2', {}, 'Bill a task'),
      h('div', { class: 'card table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Task', 'Client', 'Price', 'Status', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, tasks.map((t) => h('tr', {}, h('td', {}, t.title), h('td', {}, `${t.client_name} `, h('span', { class: 'muted mono' }, t.client_email)), h('td', {}, usd(t.price_cents)), h('td', {}, badge(t.status)),
          h('td', {}, h('div', { class: 'row' }, h('button', { class: 'small', onclick: act(`/api/tasks/${t.id}/invoice`, 'Invoice created and sent') }, 'Invoice client'),
            h('button', { class: 'ghost small', onclick: act(`/api/tasks/${t.id}/checkout`, 'Checkout link created') }, 'Checkout link'))))))))),
    h('section', { class: 'block' }, h('h2', {}, 'Invoices'),
      inv.length ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Number', 'Task', 'Amount', 'Status', 'Reminders', 'Payer link', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, inv.map((i) => h('tr', {}, h('td', { class: 'mono' }, i.paypal_invoice_number), h('td', {}, i.task_title, h('div', { class: 'muted' }, i.client_name)), h('td', {}, usd(i.amount_cents)), h('td', {}, badge(i.status)), h('td', {}, String(i.reminders)),
          h('td', {}, i.payer_view_url ? h('a', { href: i.payer_view_url, target: '_blank', rel: 'noopener' }, 'open') : '-'),
          h('td', {}, i.status === 'paid' ? null : h('div', { class: 'row' }, h('button', { class: 'ghost small', onclick: act(`/api/invoices/${i.id}/remind`, 'Reminder sent') }, 'Remind'),
            h('button', { class: 'small', onclick: act(`/api/invoices/${i.id}/paid-offline`, 'Recorded as paid offline') }, 'Client paid offline')))))))) : h('div', { class: 'card' }, emptyState('No invoices yet.'))),
    h('section', { class: 'block' }, h('h2', {}, 'Checkout links'),
      orders.length ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Task', 'Amount', 'Status', 'Payer link'].map((t) => h('th', {}, t)))),
        h('tbody', {}, orders.map((o) => h('tr', {}, h('td', {}, o.task_title), h('td', {}, usd(o.amount_cents)), h('td', {}, badge(o.status)), h('td', {}, o.approve_url ? h('a', { href: o.approve_url, target: '_blank', rel: 'noopener' }, 'open PayPal checkout') : '-')))))) : h('div', { class: 'card' }, emptyState('No checkout links yet.'))));
}

// ================= Disputes =================
export async function disputes(root, rerender) {
  const list = await api('/api/disputes');
  const decide = (id, decision, getMsg) => (e) => busy(e.currentTarget, async () => {
    await api(`/api/disputes/${id}/decision`, { method: 'POST', body: { decision, message: getMsg?.() } });
    toast('Sent to PayPal', 'ok'); rerender();
  });
  const card = (d) => {
    const a = d.ai_analysis;
    const msg = h('textarea', { 'aria-label': 'Message to PayPal / buyer', placeholder: 'Message or evidence notes' });
    if (a?.draft_message) msg.value = a.draft_message;
    return h('div', { class: 'card', style: 'display:grid;gap:12px' },
      h('div', { class: 'row' }, h('b', {}, d.reason || 'Dispute'), badge(d.status || 'unknown'), h('span', { class: 'mono muted' }, d.paypal_dispute_id), h('b', { style: 'margin-left:auto' }, usd(d.amount_cents))),
      a ? h('div', {}, h('div', { class: 'row' }, h('b', {}, 'AI analyst'), badge(`risk ${a.risk}`, a.risk === 'high' ? 'red' : a.risk === 'low' ? 'green' : 'warm'), badge(`recommends: ${a.recommendation.replace(/_/g, ' ')}`)),
        h('p', { class: 'wrap-text', style: 'margin-top:6px' }, a.summary), a.evidence_we_have?.length ? h('ul', {}, a.evidence_we_have.map((x) => h('li', {}, x))) : null)
        : h('div', { class: 'row' }, h('span', { class: 'muted' }, 'No analysis yet.'), h('button', { class: 'ghost small', onclick: (e) => busy(e.currentTarget, async () => { await api(`/api/disputes/${d.id}/analyze`, { method: 'POST', body: {} }); rerender(); }) }, 'Analyze with Claude')),
      d.human_decision ? h('div', {}, 'Your decision: ', badge(d.human_decision, 'green')) : h('div', { style: 'display:grid;gap:8px' }, msg,
        h('div', { class: 'row' }, h('button', { class: 'small', onclick: decide(d.id, 'provide_evidence', () => msg.value) }, 'Provide evidence'), h('button', { class: 'warm small', onclick: decide(d.id, 'offer_refund', () => msg.value) }, 'Offer refund'),
          h('button', { class: 'danger small', onclick: decide(d.id, 'accept_claim', () => msg.value) }, 'Accept claim'), h('button', { class: 'ghost small', onclick: decide(d.id, 'dismiss') }, 'Dismiss'))));
  };
  root.append(head('Disputes', 'An agent triages every dispute. PayPal is only called after you click.'),
    list.length ? h('div', { class: 'grid' }, list.map(card)) : h('div', { class: 'card' }, emptyState('No disputes. PayPal webhooks (CUSTOMER.DISPUTE.*) will create them here.')));
}

// ================= Agent timeline =================
export async function timelineView(root) {
  const runs = await api('/api/runs');
  root.append(head('Agent timeline', 'What each agent did, tool call by tool call. The model only ever calls these tools.'),
    runs.length ? runs.map(runCard) : h('div', { class: 'card' }, emptyState('No agent runs yet. Give an agent an instruction on the Overview.')));
}

// ================= Audit =================
export async function audit(root) {
  const events = await api('/api/events');
  root.append(head('Audit trail', 'Every webhook, agent action, policy verdict and human decision.'),
    events.length ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['When', 'Source', 'Type', 'Verified', 'Payload'].map((t) => h('th', {}, t)))),
      h('tbody', {}, events.map((e) => h('tr', {}, h('td', {}, fmtDate(e.created_at)), h('td', {}, badge(e.source, e.source === 'human' ? 'warm' : e.source === 'paypal_webhook' ? '' : 'gray')), h('td', { class: 'mono' }, e.type),
        h('td', {}, e.source === 'paypal_webhook' ? (e.verified ? badge('signature ok', 'green') : badge('unverified', 'red')) : '-'),
        h('td', { style: 'max-width:420px' }, h('details', {}, h('summary', { class: 'muted' }, 'payload'), h('pre', { class: 'tl-body' }, JSON.stringify(e.payload, null, 2))))))))) : h('div', { class: 'card' }, emptyState('No events yet.')));
}

// ================= Ask the treasurer =================
export async function ask(root) {
  const chat = h('div', { class: 'chat' });
  const input = h('input', { type: 'text', placeholder: 'e.g. What did we spend on GPUs this month and what did it produce?', 'aria-label': 'Question' });
  const examples = ['What did we spend on GPUs this month and what did it produce?', 'Which agent has the best ROI?', 'Which tasks have we been paid for?'];
  const askBtn = h('button', { onclick: (e) => send(e) }, 'Ask');
  const send = async (e) => {
    const q = input.value.trim(); if (!q) return;
    input.value = '';
    chat.append(h('div', { class: 'bubble q' }, q));
    const pending = h('div', { class: 'bubble a' }, h('span', { class: 'spinner' }), ' thinking...');
    chat.append(pending);
    await busy(e.currentTarget, async () => {
      try {
        const res = await api('/api/ask', { method: 'POST', body: { question: q } });
        pending.replaceChildren(...splitCites(res.answer));
      } catch (err) { pending.remove(); throw err; }
    });
  };
  const splitCites = (text) => text.split(/(\[led_[a-f0-9]+\])/g).map((part) => {
    const m = part.match(/^\[(led_[a-f0-9]+)\]$/);
    return m ? h('button', { class: 'cite', title: 'Open proof chain', onclick: () => openProof(m[1]).catch((err) => toast(err.message, 'error')) }, m[1]) : part;
  });
  root.append(head('Ask the treasurer', 'Claude answers from the ledger only, and cites the rows it used.'), chat,
    h('div', { class: 'row', style: 'margin-bottom:10px' }, examples.map((x) => h('button', { class: 'ghost small', onclick: () => { input.value = x; input.focus(); } }, x))),
    h('div', { class: 'row', style: 'flex-wrap:nowrap' }, input, askBtn));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send({ currentTarget: askBtn }); });
}
