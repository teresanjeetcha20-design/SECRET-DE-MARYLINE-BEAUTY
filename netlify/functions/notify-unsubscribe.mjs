// POST /api/notify/unsubscribe { token } — désinscription des e-mails marketing (lien en bas des e-mails).
import { createFirestoreRepo } from '../lib/repository/firestoreRepo.mjs';
import { readUnsubscribeToken, unsubscribeSecret } from '../lib/unsubscribe.mjs';
import { json } from '../lib/bootstrap.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false });
  let input;
  try { input = JSON.parse(await req.text()); } catch (_) { return json(400, { ok: false }); }
  const email = readUnsubscribeToken(input.token, unsubscribeSecret());
  if (!email) return json(400, { ok: false, message: 'Lien de désinscription invalide.' });
  try {
    await createFirestoreRepo().unsubscribe(email);
    const [u, dom] = email.split('@');
    return json(200, { ok: true, email: u.slice(0, 2) + '***@' + dom });
  } catch (e) {
    console.error('[notify] unsubscribe', e);
    return json(500, { ok: false, message: 'Désinscription impossible pour le moment. Réessayez plus tard.' });
  }
};
export const config = { path: '/api/notify/unsubscribe' };
