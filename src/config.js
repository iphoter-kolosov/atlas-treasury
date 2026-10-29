// All configuration comes from the environment (see .env.example). Nothing is hard-coded.
// `node --env-file=.env` is used by the npm scripts, so no dotenv dependency is needed.

const bool = (v) => v === '1' || v === 'true';

export function loadConfig(env = process.env) {
  const port = Number(env.PORT || 8787);
  return {
    port,
    publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    dbPath: env.DB_PATH || './data/treasury.db',
    demoMode: bool(env.DEMO_MODE),
    adminToken: env.ADMIN_TOKEN || '',
    paypal: {
      clientId: env.PAYPAL_CLIENT_ID || '',
      clientSecret: env.PAYPAL_CLIENT_SECRET || '',
      api: (env.PAYPAL_API || 'https://api-m.sandbox.paypal.com').replace(/\/$/, ''),
      webhookId: env.PAYPAL_WEBHOOK_ID || '',
    },
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    claudeModel: env.CLAUDE_MODEL || 'claude-sonnet-5-5',
    aiDailyCap: Number(env.AI_DAILY_CAP || 300),
    approvalWebhookUrl: env.APPROVAL_WEBHOOK_URL || '',
    sandboxVendorEmails: (env.SANDBOX_VENDOR_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean),
    currency: 'USD',
    // The merchant account's own currency. PayPal converts incoming USD into it, and payouts must be sent in it
    // (a HUF-primary account rejects USD payouts with "insufficient funds"). Empty = same as `currency`.
    settlement: {
      currency: (env.SETTLEMENT_CURRENCY || '').toUpperCase(),
      fxRate: Number(env.SETTLEMENT_FX_RATE || 0), // units of settlement currency per 1 USD
    },
  };
}

export const paypalConfigured = (cfg) => Boolean(cfg.paypal.clientId && cfg.paypal.clientSecret);
export const claudeConfigured = (cfg) => Boolean(cfg.anthropicApiKey);

/** Returns a list of human-readable problems. Empty list = OK to boot. */
export function validateConfig(cfg) {
  const problems = [];
  if (!cfg.demoMode && !cfg.adminToken) problems.push('ADMIN_TOKEN is required unless DEMO_MODE=1');
  if (!cfg.demoMode && !cfg.publicUrl.startsWith('https://') && !cfg.publicUrl.includes('localhost')) {
    problems.push('PUBLIC_URL should be https:// outside local development');
  }
  if (!Number.isFinite(cfg.port) || cfg.port <= 0) problems.push('PORT must be a positive number');
  if (!cfg.paypal.api.startsWith('https://')) problems.push('PAYPAL_API must be an https:// URL');
  if (cfg.settlement.currency && cfg.settlement.currency !== cfg.currency && !(cfg.settlement.fxRate > 0)) {
    problems.push('SETTLEMENT_FX_RATE (> 0) is required when SETTLEMENT_CURRENCY differs from USD');
  }
  return problems;
}

export class NotConfiguredError extends Error {
  constructor(what) {
    super(`${what} not configured`);
    this.name = 'NotConfiguredError';
    this.what = what;
    this.status = 503;
  }
}
