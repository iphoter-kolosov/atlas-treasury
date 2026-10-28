import { api } from './api.js';
import { badge, budgetBar, busy, h, usd } from './ui.js';

const token = location.pathname.split('/').filter(Boolean).pop();
const sheet = document.getElementById('sheet');

function stateView(icon, title, text) {
  return [h('div', { class: 'state' }, h('div', { class: 'tick' }, icon), h('h2', {}, title), h('p', { class: 'muted' }, text))];
}

async function load() {
  let card;
  try { card = await api(`/api/approvals/${token}`); } catch (e) { return sheet.replaceChildren(...stateView('?', 'Link not found', e.message)); }
  const pending = card.state === 'pending';
  const note = h('input', { type: 'text', placeholder: 'Optional note', 'aria-label': 'Note' });
  const decide = (decision) => (e) => busy(e.currentTarget, async () => {
    const res = await api(`/api/approvals/${token}/${decision}`, { method: 'POST', body: { note: note.value } });
    sheet.replaceChildren(...stateView(decision === 'approve' ? '✅' : '🚫', decision === 'approve' ? 'Approved' : 'Rejected',
      decision === 'approve' ? `${usd(res.amount_cents)} to ${res.vendor_name} was submitted to PayPal Payouts.` : 'Nothing was paid. The agent has been told.'));
  });
  // Show the budget *after* this payment so the owner sees the real consequence.
  const after = card.budget.spent_cents + (pending ? card.amount_cents : 0);
  sheet.replaceChildren(
    h('div', { class: 'who' }, h('div', { class: 'avatar' }, card.agent.emoji), h('div', {}, h('b', {}, `${card.agent.name} asks to pay`), h('div', { class: 'muted' }, card.agent.role)), h('span', { style: 'margin-left:auto' }, badge(card.state))),
    h('div', {}, h('div', { class: 'big' }, usd(card.amount_cents)), h('div', { class: 'muted' }, `to ${card.vendor_name} - ${card.category}`)),
    card.reasons?.length ? h('div', { class: 'reasons-box' }, h('b', {}, 'Why this needs you'), h('ul', {}, card.reasons.map((r) => h('li', {}, r)))) : null,
    h('div', { class: 'why' }, h('b', {}, 'Agent says'), card.justification),
    h('div', { class: 'why' }, h('b', {}, 'Expected result'), card.expected_result),
    card.task ? h('div', { class: 'why' }, h('b', {}, 'For task'), `${card.task.title} - ${card.task.client_name}`) : null,
    h('div', {}, h('div', { class: 'muted', style: 'margin-bottom:6px' }, `${card.agent.name}'s monthly budget after this payment`), budgetBar(after, card.budget.monthly_budget_cents)),
    pending ? h('div', { class: 'actions' }, note, h('button', { class: 'warm', onclick: decide('approve') }, `Approve ${usd(card.amount_cents)}`), h('button', { class: 'danger', onclick: decide('reject') }, 'Reject'),
      h('small', { class: 'muted' }, `Single-use link, expires ${new Date(card.expires_at).toLocaleString()}.`))
      : h('div', { class: 'state' }, h('p', { class: 'muted' }, card.state === 'expired' ? 'This link expired after 48 hours.' : `Already ${card.state}${card.decided_by ? ` by ${card.decided_by}` : ''}. Approval links are single-use.`)));
}
load();
