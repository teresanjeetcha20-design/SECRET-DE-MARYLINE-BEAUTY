import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMailer, renderEmailHtml } from '../netlify/lib/mailer.mjs';
import { makeUnsubscribeToken, readUnsubscribeToken } from '../netlify/lib/unsubscribe.mjs';

test('e-mail : contenu échappé (pas d\'injection HTML), liens cliquables, lien de désinscription', () => {
  const h = renderEmailHtml('Bonjour <b>Awa</b>\nVoir https://site.test', 'https://site.test', 'https://site.test/?desabonnement=x');
  assert.ok(h.includes('&lt;b&gt;Awa&lt;/b&gt;') && !h.includes('<b>Awa</b>'));
  assert.ok(h.includes('<a href="https://site.test"'));
  assert.ok(h.includes('Se désinscrire'));
});
test('Brevo : envoi, adresse invalide, non configuré', async () => {
  const calls = [];
  const m = createMailer({ apiKey: 'k', fromEmail: 'boutique@test.fr', fetchImpl: async (u, o) => { calls.push(JSON.parse(o.body)); return { status: 201 }; } });
  assert.deepEqual(await m.send({ to: 'lea@test.fr', subject: 'S', text: 'T', unsubscribeUrl: 'https://x/u' }), { ok: true });
  assert.equal(calls[0].headers['List-Unsubscribe'], '<https://x/u>');
  assert.equal((await m.send({ to: 'pas-un-email', subject: 'S', text: 'T' })).error, 'BAD_EMAIL');
  assert.equal(createMailer({}).configured, false);
});
test('jeton de désinscription : valide, falsifié, autre secret', () => {
  const t = makeUnsubscribeToken('Lea@Test.fr', 'secret');
  assert.equal(readUnsubscribeToken(t, 'secret'), 'lea@test.fr');
  assert.equal(readUnsubscribeToken(t.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')), 'secret'), null);
  assert.equal(readUnsubscribeToken(t, 'autre'), null);
  assert.equal(readUnsubscribeToken(Buffer.from('autre@test.fr').toString('base64url') + '.' + t.split('.')[1], 'secret'), null);
});
test('Brevo refuse : code + message transmis à l\'admin (pour expliquer la cause)', async () => {
  const m = createMailer({ apiKey: 'k', fromEmail: 'b@test.fr', fetchImpl: async () => ({ status: 401, json: async () => ({ code: 'unauthorized', message: 'We have detected you are using an unrecognised IP address 1.2.3.4' }) }) });
  const r = await m.send({ to: 'lea@test.fr', subject: 'S', text: 'T' });
  assert.equal(r.error, 'unauthorized'); assert.match(r.detail, /IP address/);
});
import { createNotifier } from '../netlify/lib/notify.mjs';
test('alerte commerçante : envoyée par Brevo quand il est configuré (réponse directe à la cliente)', async () => {
  const sent = [];
  const mailer = { configured: true, send: async (m) => { sent.push(m); return { ok: true }; } };
  let formsubmit = 0;
  const n = createNotifier({ merchantEmail: 'boutique@test.fr', mailer, fetchImpl: async () => { formsubmit++; return { ok: true }; } });
  await n.notifyPaid({ id: 'SMBX', amount: 26.9, nom: 'Awa', tel: '06', email: 'awa@test.fr', items: 'NAG ×1', adresse: '1 rue A', ville: 'Lyon', pays: 'France' });
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'boutique@test.fr'); assert.equal(sent[0].replyTo, 'awa@test.fr');
  assert.match(sent[0].text, /26,9 €|26,90 €/); assert.equal(formsubmit, 0);
});
test('alerte commerçante : secours FormSubmit si Brevo échoue', async () => {
  let formsubmit = 0;
  const n = createNotifier({ merchantEmail: 'b@test.fr', mailer: { configured: true, send: async () => ({ ok: false, error: 'x' }) }, fetchImpl: async () => { formsubmit++; return { ok: true }; } });
  await n.notifyNew({ id: 'SMBX', amount: 10, nom: 'A', tel: '06', items: 'x' });
  assert.equal(formsubmit, 1);
});
