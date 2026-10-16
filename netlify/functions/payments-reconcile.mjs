// Fonction planifiée (toutes les 10 min) : re-vérifie les paiements restés en attente
// (callback perdu, page de paiement abandonnée ou expirée).
import { getService } from '../lib/bootstrap.mjs';

export default async () => {
  try { await getService().reconcile(); } catch (e) { console.error('[payments] reconcile', e); }
};
export const config = { schedule: '*/10 * * * *' };
