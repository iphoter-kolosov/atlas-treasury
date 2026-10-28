// Tiny DOM helpers. Everything is built with createElement/textContent, so server data can never inject markup.

export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (kid) => {
    if (kid == null || kid === false) return;
    if (Array.isArray(kid)) kid.forEach(add);
    else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  };
  kids.forEach(add);
  return el;
}

export const usd = (cents) => {
  const n = (cents ?? 0) / 100;
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
export const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
};

const TONE = {
  income: 'green', spend: 'red', refund: 'warm', dispute_hold: 'warm', dispute_release: 'green',
  paid: 'green', completed: 'green', accepted: 'green', approved: 'green', captured: 'green', auto: 'green', pending: 'warm', needs_approval: 'warm', sent: 'warm', created: 'gray',
  done: 'warm', open: 'gray', failed: 'red', rejected: 'red', blocked: 'red', expired: 'gray',
};
export const badge = (text, tone) => h('span', { class: `badge ${tone || TONE[String(text).toLowerCase()] || ''}` }, String(text).replace(/_/g, ' '));

export function budgetBar(spent, budget) {
  const pct = budget > 0 ? Math.min(100, Math.round((spent / budget) * 100)) : 0;
  const cls = pct >= 100 ? 'over' : pct >= 75 ? 'warn' : '';
  return h('div', {},
    h('div', { class: `bar ${cls}`, role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('i', { style: `width:${pct}%` })),
    h('div', { class: 'bar-label' }, h('span', {}, h('b', {}, usd(spent)), ' spent'), h('span', {}, `of ${usd(budget)} (${pct}%)`)));
}

export function toast(message, tone = '') {
  const el = h('div', { class: `toast ${tone}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), tone === 'error' ? 8000 : 3500);
}

/** Runs an async action with the button disabled and a spinner; shows errors as toasts. */
export async function busy(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.replaceChildren(h('span', { class: 'spinner' }), ' ', label);
  try { return await fn(); } catch (e) { toast(e.message, 'error'); return undefined; } finally { btn.disabled = false; btn.textContent = label; }
}

export const emptyState = (text) => h('div', { class: 'empty' }, text);
