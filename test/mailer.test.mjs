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
