// POST /api/notify/email — e-mails aux clientes (statut de commande, retour en stock, campagnes, relance panier).
// Réservé à l'administration : jeton Firebase obligatoire + présence dans la collection « admins ».
import { getAuth } from 'firebase-admin/auth';
import { db, createFirestoreRepo } from '../lib/repository/firestoreRepo.mjs';
import { createMailer } from '../lib/mailer.mjs';
import { json } from '../lib/bootstrap.mjs';
import { makeUnsubscribeToken, unsubscribeSecret } from '../lib/unsubscribe.mjs';

export default async (req) => {
  const mailerOpts = {
    apiKey: process.env.BREVO_API_KEY, fromEmail: process.env.MAIL_FROM_EMAIL,
    fromName: process.env.MAIL_FROM_NAME || 'Secret de Maryline Beauty', replyTo: process.env.MAIL_REPLY_TO,
    siteUrl: (process.env.SITE_URL || process.env.URL || '').replace(/\/$/, ''),
  };
  if (req.method === 'GET') return json(200, { configured: createMailer(mailerOpts).configured });
  if (req.method !== 'POST') return json(405, { ok: false });

  // 1. Vérifier que c'est bien l'administration
  const token = String(req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  let uid, firestore;
  try { firestore = db(); }
  catch (e) {
    console.error('[notify] Firebase', e.message);
    return json(503, { ok: false, code: 'FIREBASE_NOT_CONFIGURED', message: 'Identifiants Firebase manquants ou invalides dans Netlify (FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, FIREBASE_PROJECT_ID).' });
  }
  try {
    const decoded = await getAuth().verifyIdToken(token);
    uid = decoded.uid;
    const adm = await firestore.doc(`admins/${uid}`).get();
    if (!adm.exists) return json(403, { ok: false, message: 'Accès réservé à l\'administration.' });
  } catch (e) {
    return json(401, { ok: false, message: 'Session admin expirée — reconnectez-vous.' });
  }

  // 2. Envoyer (50 e-mails maximum par appel)
  let input;
  try { input = JSON.parse(await req.text()); } catch (_) { return json(400, { ok: false }); }
  const messages = Array.isArray(input.messages) ? input.messages.slice(0, 50) : [];
  if (!messages.length) return json(400, { ok: false, message: 'Aucun message.' });
  const mailer = createMailer(mailerOpts);
  if (!mailer.configured) return json(503, { ok: false, code: 'NOT_CONFIGURED', message: 'L\'envoi d\'e-mails n\'est pas encore configuré (BREVO_API_KEY / MAIL_FROM_EMAIL dans Netlify).' });

  const marketing = !!input.marketing;
  const repo = createFirestoreRepo();
  const secret = unsubscribeSecret();
  const results = [];
  for (const m of messages) {
    if (marketing && await repo.isUnsubscribed(m.to).catch(() => false)) { results.push({ to: m.to, ok: false, error: 'UNSUBSCRIBED' }); continue; }
    const unsubscribeUrl = marketing && mailerOpts.siteUrl ? `${mailerOpts.siteUrl}/?desabonnement=${makeUnsubscribeToken(m.to, secret)}` : '';
    results.push({ to: m.to, ...(await mailer.send({ ...m, unsubscribeUrl })) });
  }
  const sent = results.filter((r) => r.ok).length;
  console.log('[notify] emails', JSON.stringify({ uid, marketing, sent, failed: results.length - sent }));
  return json(200, { ok: sent > 0, sent, results });
};
export const config = { path: '/api/notify/email' };
