// GET /api/payments/config — le site sait si le paiement en ligne est actif et pour quels pays.
import { getService, json } from '../lib/bootstrap.mjs';

export default async () => {
  try { return json(200, await getService().publicConfig()); }
  catch (e) { console.error('[payments] config', e); return json(200, { enabled: false, stripe: false, paypal: false, pawapay: false, transfer: false, countries: [] }); }
};
export const config = { path: '/api/payments/config' };
