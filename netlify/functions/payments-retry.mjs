// POST /api/payments/retry — nouvelle tentative (nouvel identifiant de paiement) après échec ou expiration.
import { getService, json } from '../lib/bootstrap.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false });
  let input;
  try { input = JSON.parse(await req.text()); } catch (_) { return json(400, { ok: false }); }
  try {
    const r = await getService().retryPayment({ orderId: input.orderId, accessToken: input.accessToken });
    return json(r.ok ? 200 : (r.code === 'FORBIDDEN' ? 403 : 400), r);
  } catch (e) {
    console.error('[payments] retry', e);
    return json(500, { ok: false, message: 'Erreur inattendue. Réessayez dans un instant.' });
  }
};
export const config = { path: '/api/payments/retry' };
