// The policy engine is pure code on purpose: "The LLM proposes, the policy engine disposes, the human signs."
// No model, no network, no clock - everything it needs is passed in, so every rule is unit-testable.

import { fmtUsd } from './money.js';

export const ALLOWED_CURRENCIES = ['USD'];
export const MARGIN_GUARD_RATIO = 0.6;

/**
 * @param request {amount_cents, currency, vendor_email, vendor_name, category, task_id}
 * @param agent {name, monthly_budget_cents, per_tx_auto_limit_cents, allowed_categories: string[]}
 * @param monthSpentCents committed spend of this agent in the current month
 * @param context {task, knownVendors: Set<string>, denylist: string[], taskSpentCents}
 * @returns {{verdict: 'auto'|'needs_approval'|'blocked', reasons: string[]}}
 */
export function evaluate(request, agent, monthSpentCents, context = {}) {
  const blocked = [];
  const review = [];
  const { task = null, denylist = [], taskSpentCents = 0 } = context;
  const knownVendors = context.knownVendors ?? new Set();
  const vendor = String(request.vendor_email || '').trim().toLowerCase();

  if (!Number.isInteger(request.amount_cents) || request.amount_cents <= 0) blocked.push('Amount must be greater than zero.');
  if (!ALLOWED_CURRENCIES.includes(request.currency)) blocked.push(`Currency ${request.currency} is not allowed (only ${ALLOWED_CURRENCIES.join(', ')}).`);
  if (vendor && denylist.map((d) => d.toLowerCase()).includes(vendor)) blocked.push(`Vendor ${vendor} is on the denylist.`);
  if (!request.task_id) blocked.push('Every payment must be tied to a task (no task_id given).');
  else if (!task) blocked.push(`Task ${request.task_id} does not exist.`);
  else if (!['open', 'done'].includes(task.status)) blocked.push(`Task "${task.title}" is ${task.status}; spending is only allowed on open or done tasks.`);

  if (blocked.length) return { verdict: 'blocked', reasons: blocked };

  const name = agent.name;
  if (request.amount_cents > agent.per_tx_auto_limit_cents) {
    review.push(`Over ${name}'s per-payment limit: ${fmtUsd(request.amount_cents)} > ${fmtUsd(agent.per_tx_auto_limit_cents)}.`);
  }
  if (monthSpentCents + request.amount_cents > agent.monthly_budget_cents) {
    review.push(`Would exceed ${name}'s monthly budget: ${fmtUsd(monthSpentCents)} spent + ${fmtUsd(request.amount_cents)} > ${fmtUsd(agent.monthly_budget_cents)}.`);
  }
  if (!agent.allowed_categories.includes(request.category)) {
    review.push(`Category "${request.category}" is outside ${name}'s allowed categories (${agent.allowed_categories.join(', ') || 'none'}).`);
  }
  if (!vendor || !knownVendors.has(vendor)) {
    review.push(`New vendor: ${request.vendor_name || vendor || 'unknown'} has never been paid before.`);
  }
  if (task.price_cents && taskSpentCents + request.amount_cents > task.price_cents * MARGIN_GUARD_RATIO) {
    review.push(
      `Margin guard: spend on this task would reach ${fmtUsd(taskSpentCents + request.amount_cents)}, above ${Math.round(MARGIN_GUARD_RATIO * 100)}% of its ${fmtUsd(task.price_cents)} price.`,
    );
  }

  return review.length ? { verdict: 'needs_approval', reasons: review } : { verdict: 'auto', reasons: ['Within all limits.'] };
}
