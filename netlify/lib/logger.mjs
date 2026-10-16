/**
 * Journal des événements de paiement : sortie console (logs Netlify) + collection payment_events.
 * Ne jamais y mettre de jeton, de clé ou de numéro complet.
 */
export function createLogger(repo) {
  return async function logEvent(type, details = {}) {
    const entry = { type, ...details, at: new Date().toISOString() };
    console.log('[payments]', JSON.stringify(entry));
    try { if (repo && repo.logEvent) await repo.logEvent(entry); } catch (e) { console.warn('[payments] journal indisponible', e.message); }
  };
}
