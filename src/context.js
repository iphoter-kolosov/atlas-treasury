import { claudeConfigured, paypalConfigured } from './config.js';
import { analyzeDispute, createClaudeClient } from './agents.js';
import { createPayPalClient } from './paypal.js';

const LEVELS = { error: console.error, warn: console.warn, info: console.log };
export const consoleLog = (level, msg) => (LEVELS[level] || console.log)(`[${level}] ${msg}`);

/** Wires config + db + (optional) integrations. Tests pass fakes via `overrides`. */
export async function createContext({ config, db, overrides = {} }) {
  let paypal = null;
  if (paypalConfigured(config)) {
    paypal = createPayPalClient({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, baseUrl: config.paypal.api });
  }
  let claude = null;
  if (claudeConfigured(config)) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    claude = createClaudeClient(config.anthropicApiKey, Anthropic);
  }
  const ctx = { db, config, paypal, claude, log: consoleLog, ...overrides };
  // Dispute analysis runs out of band so PayPal gets its 200 immediately.
  ctx.onDispute ??= (dispute) => {
    if (!ctx.claude) return;
    analyzeDispute(ctx, dispute.id).catch((e) => ctx.log('warn', `dispute analysis failed: ${e.message}`));
  };
  return ctx;
}
