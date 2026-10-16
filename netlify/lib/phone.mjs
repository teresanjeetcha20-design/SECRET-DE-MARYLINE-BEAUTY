import { COUNTRIES } from './config.mjs';

/**
 * Normalise un numéro au format international attendu par PawaPay :
 * chiffres uniquement, indicatif pays obligatoire, pas de « + » ni de 0 initial.
 * Retourne null si le numéro est invalide.
 *
 * - « +237 6 95 12 34 56 », « 00237695123456 », « 695123456 » (Cameroun) → « 237695123456 »
 * - Pour les pays sans longueur nationale connue (ex. Gabon), le format international est exigé.
 * La validation finale par opérateur est faite par PawaPay sur sa page de paiement.
 */
export function normalizePhone(raw, countryCode) {
  if (raw == null) return null;
  let s = String(raw).trim().replace(/[\s.\-()/]/g, '');
  let international = false;
  if (s.startsWith('+')) { s = s.slice(1); international = true; }
  else if (s.startsWith('00')) { s = s.slice(2); international = true; }
  if (!/^\d+$/.test(s)) return null;
  const c = COUNTRIES[countryCode];
  if (!international && c) {
    if (s.startsWith(c.dialCode) && (!c.nationalLength || s.length === c.dialCode.length + c.nationalLength)) {
      // déjà avec indicatif, sans +
    } else if (c.nationalLength && s.length === c.nationalLength) {
      s = c.dialCode + s;
    } else if (c.nationalLength && s.length === c.nationalLength + 1 && s.startsWith('0')) {
      s = c.dialCode + s.slice(1);
    } else {
      return null;
    }
  }
  if (s.startsWith('0')) return null;
  if (s.length < 9 || s.length > 15) return null;
  if (c && !s.startsWith(c.dialCode)) return null;
  return s;
}

/** Masque un numéro pour les journaux : 237695123456 → 2376*****456 */
export function maskPhone(p) {
  const s = String(p || '');
  if (s.length < 7) return '***';
  return s.slice(0, 4) + '*'.repeat(s.length - 7) + s.slice(-3);
}
