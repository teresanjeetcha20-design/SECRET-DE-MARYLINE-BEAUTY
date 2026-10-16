// POST /api/contact — formulaire de la page Contact.
// Le message est enregistré (admin › Messages clientes) et envoyé par e-mail à la boutique (Brevo).
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../lib/repository/firestoreRepo.mjs';
import { createMailer } from '../lib/mailer.mjs';
import { json } from '../lib/bootstrap.mjs';

const clean = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, n);

export default async (req) => {
  if (req.method !== 'POST') return json(405, { ok: false });
  let b;
  try { b = JSON.parse(await req.text()); } catch (_) { return json(400, { ok: false }); }
  if (b.website) return json(200, { ok: true });                         // robot (champ invisible rempli)
  const name = clean(b.name, 80), email = clean(b.email, 120).toLowerCase(), subject = clean(b.subject, 80) || 'Message', message = clean(b.message, 4000);
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || message.length < 10) {
    return json(400, { ok: false, message: 'Merci de renseigner votre nom, un e-mail valide et votre message (10 caractères minimum).' });
  }
  const t = new Date();
  let stored = false, mailed = false;
  try {
    await db().collection('contact_messages').add({
      name, email, subject, message, status: 'nouveau', at: t.getTime(),
      date: t.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }), heure: t.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }),
      createdAt: FieldValue.serverTimestamp(),
    });
    stored = true;
  } catch (e) { console.error('[contact] enregistrement', e.message); }
  const to = process.env.MERCHANT_NOTIFY_EMAIL;
  const mailer = createMailer({ apiKey: process.env.BREVO_API_KEY, fromEmail: process.env.MAIL_FROM_EMAIL, fromName: process.env.MAIL_FROM_NAME || 'Secret de Maryline Beauty' });
  if (to && mailer.configured) {
    const r = await mailer.send({ to, subject: `[Contact] ${subject} — ${name}`, text: `Nouveau message depuis la page Contact\n\nNom : ${name}\nE-mail : ${email}\nSujet : ${subject}\n\n${message}\n\n— Répondez directement à cet e-mail pour lui écrire.`, replyTo: email });
    mailed = r.ok;
    if (!r.ok) console.error('[contact] e-mail', r.error, r.detail || '');
  }
  if (!stored && !mailed) return json(503, { ok: false, message: 'Envoi impossible pour le moment. Écrivez-nous directement par e-mail ou sur WhatsApp.' });
  return json(200, { ok: true, stored, mailed });
};
export const config = { path: '/api/contact' };
