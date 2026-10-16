// GET /api/payments/status?orderId=… — interrogé par la page « Paiement en cours ».
// Ne renvoie aucune donnée personnelle ; peut déclencher une re-vérification auprès du prestataire.
import { getService, json } from '../lib/bootstrap.mjs';
import { ORDER_ID_RE } from '../lib/paymentService.mjs';

export default async (req) => {
  const orderId = new URL(req.url).searchParams.get('orderId') || '';
  if (!ORDER_ID_RE.test(orderId)) return json(400, { ok: false });
  try {
    const r = await getService().getStatusForClient(orderId);
    return json(r.ok ? 200 : 404, r);
  } catch (e) {
    console.error('[payments] status', e);
    return json(500, { ok: false });
  }
};
export const config = { path: '/api/payments/status' };
