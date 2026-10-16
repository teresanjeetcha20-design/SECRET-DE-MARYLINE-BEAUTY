// POST /api/payments/paypal/capture — la cliente a validé dans la fenêtre PayPal : le serveur vérifie et encaisse.
import { getService, json } from '../lib/bootstrap.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false });
  let input;
  try { input = JSON.parse(await req.text()); } catch (_) { return json(400, { ok: false }); }
  try {
    const r = await getService().confirmPayment({ orderId: input.orderId, accessToken: input.accessToken });
    return json(r.ok ? 200 : (r.code === 'FORBIDDEN' ? 403 : 404), r);
  } catch (e) {
    console.error('[payments] paypal capture', e);
    return json(500, { ok: false, message: 'Erreur inattendue.' });
  }
};
export const config = { path: '/api/payments/paypal/capture' };
