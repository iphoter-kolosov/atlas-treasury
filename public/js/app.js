import { api } from './api.js';
import * as views from './views.js';
import { h, toast } from './ui.js';

const ROUTES = [
  ['overview', 'Overview', views.overview, false],
  ['ledger', 'Ledger', views.ledger, false],
  ['approvals', 'Approvals', views.approvals, true],
  ['invoices', 'Invoices', views.invoices, false],
  ['disputes', 'Disputes', views.disputes, false],
  ['timeline', 'Timeline', views.timelineView, false],
  ['audit', 'Audit', views.audit, false],
  ['ask', 'Ask', views.ask, false],
];
const POLL_MS = 9000;
const view = document.getElementById('view');
let rendering = 0;

const current = () => {
  const key = location.hash.replace(/^#\//, '').split('?')[0] || 'overview';
  return ROUTES.find((r) => r[0] === key) || ROUTES[0];
};

async function renderNav() {
  let pending = 0;
  let health = null;
  try { [pending, health] = await Promise.all([api('/api/overview').then((o) => o.pending_approvals), api('/api/health')]); } catch { /* shown by the view itself */ }
  const key = current()[0];
  document.getElementById('nav').replaceChildren(...ROUTES.map(([id, label]) =>
    h('a', { href: `#/${id}`, class: id === key ? 'active' : '' }, label, id === 'approvals' && pending ? h('span', { class: 'count' }, pending) : null)));
  if (health) {
    const chip = (name, on) => h('span', {}, h('i', { class: `dot ${on ? 'on' : 'off'}` }), `${name} ${on ? 'connected' : 'not configured'}`);
    document.getElementById('health').replaceChildren(chip('PayPal', health.paypal.configured), chip('Claude', health.claude.configured));
  }
}

async function render({ quiet = false } = {}) {
  const token = ++rendering;
  const [, , fn] = current();
  const next = document.createElement('div');
  try { await fn(next, () => render()); } catch (e) { next.replaceChildren(h('div', { class: 'card' }, h('b', {}, 'Could not load this page. '), e.message)); if (!quiet) toast(e.message, 'error'); }
  if (token !== rendering) return; // a newer navigation won
  const scroll = window.scrollY;
  view.replaceChildren(...next.childNodes);
  if (quiet) window.scrollTo(0, scroll); else window.scrollTo(0, 0);
  renderNav();
}

window.addEventListener('hashchange', () => render());
// Live pages refresh by themselves so a phone approval shows up on the desktop without a click.
setInterval(() => {
  const [, , , live] = current();
  const typing = document.activeElement && ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName);
  if (live && !typing && !document.hidden && !document.querySelector('.drawer')) render({ quiet: true });
}, POLL_MS);
render();
