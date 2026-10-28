// Registers (or finds) our webhook in the PayPal sandbox and prints PAYPAL_WEBHOOK_ID to put into .env.
import { loadConfig, paypalConfigured } from './config.js';
import { WEBHOOK_EVENTS, createPayPalClient } from './paypal.js';

const config = loadConfig();
if (!paypalConfigured(config)) {
  console.error('Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET first.');
  process.exit(1);
}
if (!config.publicUrl.startsWith('https://')) {
  console.error(`PUBLIC_URL must be a public https URL for PayPal to reach us (got ${config.publicUrl}). Use a tunnel (cloudflared/ngrok) locally.`);
  process.exit(1);
}
const paypal = createPayPalClient({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, baseUrl: config.paypal.api });
const { id, created } = await paypal.ensureWebhook(`${config.publicUrl}/webhooks/paypal`, WEBHOOK_EVENTS);
console.log(`${created ? 'Created' : 'Found existing'} webhook. Put this in .env:\nPAYPAL_WEBHOOK_ID=${id}`);
