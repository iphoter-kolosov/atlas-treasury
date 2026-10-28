import { serve } from '@hono/node-server';
import { loadConfig, validateConfig, paypalConfigured, claudeConfigured } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';
import { createContext, consoleLog } from './context.js';
import { createApp } from './app.js';
import { reconcile } from './reconcile.js';

const RECONCILE_EVERY_MS = 2 * 60 * 1000;

const config = loadConfig();
const problems = validateConfig(config);
if (problems.length) {
  console.error(`Atlas Treasury cannot start. Fix the configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}

const db = openDb(config.dbPath);
seed(db, config);
const ctx = await createContext({ config, db });
const app = createApp(ctx);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  consoleLog('info', `Atlas Treasury listening on http://localhost:${info.port} (${config.demoMode ? 'DEMO_MODE' : 'normal'})`);
  consoleLog('info', `PayPal: ${paypalConfigured(config) ? config.paypal.api : 'NOT configured (money actions return 503)'}; Claude: ${claudeConfigured(config) ? config.claudeModel : 'NOT configured (AI actions return 503)'}`);
});

if (ctx.paypal) {
  setInterval(() => reconcile(ctx).catch((e) => consoleLog('warn', `reconcile failed: ${e.message}`)), RECONCILE_EVERY_MS).unref();
}
