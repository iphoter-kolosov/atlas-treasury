import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT, emoji TEXT,
  monthly_budget_cents INTEGER NOT NULL, per_tx_auto_limit_cents INTEGER NOT NULL,
  allowed_categories TEXT NOT NULL DEFAULT '[]', payout_email TEXT
);
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, agent_id TEXT, title TEXT NOT NULL, client_name TEXT, client_email TEXT,
  status TEXT NOT NULL DEFAULT 'open', result_summary TEXT, result_url TEXT,
  price_cents INTEGER, created_at TEXT NOT NULL, accepted_at TEXT, paid_at TEXT
);
CREATE TABLE IF NOT EXISTS spend_requests(
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT, vendor_name TEXT, vendor_email TEXT, category TEXT,
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', justification TEXT, expected_result TEXT,
  policy_verdict TEXT NOT NULL, policy_reasons TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
  approval_token TEXT UNIQUE, approval_expires_at TEXT, decided_by TEXT, decided_at TEXT, decision_note TEXT,
  payout_batch_id TEXT, payout_item_id TEXT, failure_reason TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
  agent_id TEXT, task_id TEXT, spend_request_id TEXT, paypal_ref_type TEXT, paypal_ref_id TEXT,
  status TEXT NOT NULL DEFAULT 'completed', memo TEXT, created_at TEXT NOT NULL
);
-- Webhook + reconciler can both see the same PayPal object; this makes double-booking impossible.
CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_ref ON ledger(kind, paypal_ref_type, paypal_ref_id) WHERE paypal_ref_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS invoices(
  id TEXT PRIMARY KEY, task_id TEXT, agent_id TEXT, paypal_invoice_id TEXT, paypal_invoice_number TEXT, payer_view_url TEXT,
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', status TEXT NOT NULL, reminders INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, paid_at TEXT
);
CREATE TABLE IF NOT EXISTS orders(
  id TEXT PRIMARY KEY, task_id TEXT, paypal_order_id TEXT, approve_url TEXT, capture_id TEXT,
  amount_cents INTEGER NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS disputes(
  id TEXT PRIMARY KEY, paypal_dispute_id TEXT UNIQUE, reason TEXT, status TEXT, amount_cents INTEGER,
  linked_task_id TEXT, linked_capture_id TEXT, ai_analysis TEXT, recommendation TEXT, human_decision TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, source TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
  verified INTEGER NOT NULL DEFAULT 0, refs TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_runs(
  id TEXT PRIMARY KEY, agent_id TEXT, task_id TEXT, input TEXT, transcript TEXT NOT NULL DEFAULT '[]',
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_calls(day TEXT PRIMARY KEY, calls INTEGER NOT NULL DEFAULT 0);
`;

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
  db.exec(SCHEMA);
  return db;
}

export const uid = (prefix) => `${prefix}_${randomBytes(6).toString('hex')}`;
export const newToken = () => randomBytes(24).toString('base64url');
export const nowIso = () => new Date().toISOString();
export const monthStartIso = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();

export const one = (db, sql, ...params) => db.prepare(sql).get(...params) ?? null;
export const all = (db, sql, ...params) => db.prepare(sql).all(...params);
export const run = (db, sql, ...params) => db.prepare(sql).run(...params);

/** Insert an object into a table (keys = columns). Parameterized, never string-built from values. */
export function insert(db, table, row, { ignore = false } = {}) {
  const keys = Object.keys(row);
  const sql = `INSERT ${ignore ? 'OR IGNORE ' : ''}INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`;
  return db.prepare(sql).run(...keys.map((k) => row[k]));
}

export function update(db, table, id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => patch[k]), id);
}
