// POST /api/payments/create — crée la commande, recalcule le montant et renvoie l'URL de la Payment Page.
import { getService, json } from '../lib/bootstrap.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false });
  const raw = await req.text();
  if (raw.length > 20000) return json(413, { ok: false, message: 'Requête trop volumineuse.' });
  let input;
  try { input = JSON.parse(raw); } catch (_) { return json(400, { ok: false, message: 'Requête invalide.' }); }
  try {
    const r = await getService().createPayment(input);
    return json(r.ok ? 200 : (r.code === 'PROVIDER_UNAVAILABLE' ? 503 : 400), r);
  } catch (e) {
    console.error('[payments] create', e);
    return json(500, { ok: false, message: 'Erreur inattendue. Réessayez dans un instant.' });
  }
};
export const config = { path: '/api/payments/create' };
