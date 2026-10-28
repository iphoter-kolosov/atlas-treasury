import { api } from './api.js';
import { badge, busy, emptyState, fmtDate, h, toast, usd } from './ui.js';

// ---- agent run timeline ----
const pretty = (v) => (typeof v === 'string' ? v : JSON.stringify(v, null, 2));

export function timeline(steps, finalText) {
  const items = (steps || []).map((s) => {
    if (s.type === 'text') return h('li', { class: 'text' }, h('div', { class: 'tl-title' }, 'Thinking'), h('div', { class: 'wrap-text muted' }, s.text));
    const verdict = s.output?.verdict;
    return h('li', { class: s.is_error ? 'error' : '' },
      h('div', { class: 'tl-title' }, h('code', {}, s.name), s.is_error ? badge('error', 'red') : verdict ? badge(verdict) : null),
      h('div', { class: 'tl-body' }, 'in  ' + pretty(s.input || {})), h('div', { class: 'tl-body' }, 'out ' + pretty(s.output)));
  });
  if (finalText) items.push(h('li', { class: 'final' }, h('div', { class: 'tl-title' }, 'Result'), h('div', { class: 'wrap-text' }, finalText)));
  return items.length ? h('ol', { class: 'timeline' }, items) : emptyState('No steps recorded.');
}

export function runCard(run) {
  const steps = run.transcript || run.steps || [];
  const last = [...steps].reverse().find((s) => s.type === 'text');
  return h('div', { class: 'card run' },
    h('div', { class: 'run-head' }, h('span', { class: 'avatar' }, run.agent_emoji || '🤖'), h('b', {}, run.agent_name || run.agent_id), h('span', { class: 'muted' }, fmtDate(run.created_at)),
      h('span', { class: 'chip' }, `${(run.tokens_in || 0) + (run.tokens_out || 0)} tokens`)),
    h('p', { class: 'wrap-text', style: 'margin-bottom:12px' }, h('b', {}, 'Instruction: '), run.input),
    timeline(steps.filter((s) => s !== last), last?.text));
}

// ---- approval card with QR ----
export function approvalCard(card, { onDone, showButtons = true } = {}) {
  const pending = card.state === 'pending';
  const link = card.token ? `${location.origin}/approve/${card.token}` : null;
  const note = h('input', { type: 'text', placeholder: 'Optional note for the audit trail' });
  const decide = (decision) => async (e) => {
    await busy(e.currentTarget, async () => {
      await api(`/api/approvals/${card.token}/${decision}`, { method: 'POST', body: { note: note.value } });
      toast(decision === 'approve' ? 'Approved - payout submitted to PayPal' : 'Rejected', 'ok');
      onDone?.();
    });
  };
  return h('div', { class: 'card approval' },
    h('div', {},
      h('div', { class: 'row' }, h('span', { class: 'avatar' }, card.agent.emoji), h('div', {}, h('b', {}, card.agent.name), h('div', { class: 'muted' }, card.agent.role)), badge(card.state)),
      h('div', { class: 'amount', style: 'margin-top:10px' }, usd(card.amount_cents)),
      h('div', { class: 'muted' }, `to ${card.vendor_name} (${card.category})`),
      card.reasons?.length ? h('ul', { class: 'reasons' }, card.reasons.map((r) => h('li', {}, r))) : null,
      h('dl', { class: 'kv' },
        h('dt', {}, 'Task'), h('dd', {}, card.task ? `${card.task.title} (${card.task.client_name})` : '-'),
        h('dt', {}, 'Why'), h('dd', {}, card.justification), h('dt', {}, 'Expected result'), h('dd', {}, card.expected_result),
        h('dt', {}, 'Vendor'), h('dd', { class: 'mono' }, card.vendor_email)),
      pending && showButtons && card.token ? h('div', { style: 'margin-top:14px;display:grid;gap:8px' }, note,
        h('div', { class: 'row' }, h('button', { class: 'warm', onclick: decide('approve') }, 'Approve'), h('button', { class: 'danger', onclick: decide('reject') }, 'Reject'),
          link ? h('a', { href: link, target: '_blank', rel: 'noopener', class: 'muted' }, 'open phone view') : null)) : null),
    pending && card.token ? h('div', { class: 'qr' }, h('img', { src: `/api/approvals/${card.token}/qr.svg`, alt: 'QR code to approve on your phone' }), h('small', {}, 'Scan to approve on your phone')) : null);
}

// ---- proof chain drawer ----
export async function openProof(ledgerId) {
  const proof = await api(`/api/ledger/${ledgerId}/proof`);
  const back = h('div', { class: 'drawer-back' });
  const close = () => { back.remove(); drawer.remove(); };
  back.addEventListener('click', close);
  const step = (label, content, missing) => h('li', { class: missing ? 'missing' : '' }, h('div', { class: 'step' }, label), content);
  const { ledger: l, task, spend_request: sr, invoice, order, events } = proof;
  const kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  const items = [
    step('1 - Task', task ? kv([['Title', task.title], ['Client', task.client_name], ['Price', usd(task.price_cents)], ['Status', badge(task.status)]]) : 'No task linked', !task),
    sr ? step('2 - Spend request', kv([['Vendor', `${sr.vendor_name} (${sr.vendor_email})`], ['Amount', usd(sr.amount_cents)], ['Why', sr.justification], ['Expected result', sr.expected_result]])) : step('2 - Spend request', 'Not a spend row', true),
    sr ? step('3 - Policy verdict', h('div', {}, badge(sr.policy_verdict), h('ul', {}, (sr.policy_reasons || []).map((r) => h('li', {}, r))))) : step('3 - Policy verdict', '-', true),
    sr ? step('4 - Human decision', sr.decided_by ? kv([['By', sr.decided_by], ['When', fmtDate(sr.decided_at)], ['Note', sr.decision_note || '-']]) : 'Waiting', !sr.decided_by) : step('4 - Human decision', '-', true),
    step('5 - PayPal', kv([[`${l.paypal_ref_type || 'ref'}`, h('code', {}, l.paypal_ref_id || '-')], sr?.payout_item_id ? ['payout item', h('code', {}, sr.payout_item_id)] : null,
      invoice ? ['invoice', `${invoice.paypal_invoice_number} (${invoice.status})`] : null, order ? ['order', h('code', {}, order.paypal_order_id)] : null]), !l.paypal_ref_id),
    step('6 - Webhook events', events.length ? h('ul', {}, events.map((e) => h('li', {}, `${fmtDate(e.created_at)} - ${e.type} `, e.verified ? badge('verified', 'green') : badge('unverified', 'gray')))) : 'None received yet', !events.length),
    step('7 - Result', task?.result_summary ? h('div', {}, task.result_summary, task.result_url ? h('div', {}, h('a', { href: task.result_url, target: '_blank', rel: 'noopener' }, task.result_url)) : null) : 'No result recorded yet', !task?.result_summary),
  ];
  const drawer = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Proof chain' },
    h('div', { class: 'drawer-head' }, h('div', {}, h('h2', {}, 'Proof chain'), h('div', { class: 'muted wrap-text' }, `${l.memo || l.kind} - ${usd(l.amount_cents)}`)), h('button', { class: 'ghost small', onclick: close }, 'Close')),
    h('ol', { class: 'proof' }, items));
  document.body.append(back, drawer);
}
