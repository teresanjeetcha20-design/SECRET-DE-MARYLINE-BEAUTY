/** Jetons de désinscription signés (aucune donnée en clair modifiable par un tiers). */
import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

export function unsubscribeSecret(env = process.env) {
  return env.UNSUBSCRIBE_SECRET || createHash('sha256').update('smb-unsub:' + (env.BREVO_API_KEY || env.FIREBASE_PRIVATE_KEY || env.FIREBASE_SERVICE_ACCOUNT || 'dev')).digest('hex');
}
export function makeUnsubscribeToken(email, secret) {
  const e = Buffer.from(String(email).trim().toLowerCase()).toString('base64url');
  const sig = createHmac('sha256', secret).update(e).digest('base64url').slice(0, 32);
  return `${e}.${sig}`;
}
export function readUnsubscribeToken(token, secret) {
  const [e, sig] = String(token || '').split('.');
  if (!e || !sig) return null;
  const expected = createHmac('sha256', secret).update(e).digest('base64url').slice(0, 32);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const email = Buffer.from(e, 'base64url').toString('utf8');
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : null;
}
