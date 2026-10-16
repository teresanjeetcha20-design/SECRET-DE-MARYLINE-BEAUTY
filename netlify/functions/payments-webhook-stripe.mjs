// POST /api/payments/webhook/stripe — notification Stripe (URL à déclarer dans Stripe › Développeurs › Webhooks).
// Signature vérifiée, puis statut RE-VÉRIFIÉ via l'API Stripe avant toute mise à jour.
import { getService, json } from '../lib/bootstrap.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false });
  const rawBody = await req.text();
  const headers = Object.fromEntries(req.headers.entries());
  const r = await getService().handleWebhook('stripe', { method: req.method, url: req.url, headers, rawBody });
  return json(r.status, r.body);
};
export const config = { path: '/api/payments/webhook/stripe' };
