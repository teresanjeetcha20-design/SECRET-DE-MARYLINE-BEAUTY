import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { StripeProvider } from '../netlify/lib/providers/stripe.mjs';
import { setup, VALID_INPUT } from './helpers.mjs';

/** Faux Stripe (Checkout Sessions). */
function fakeStripe(clock) {
  const st = { sessions: new Map(), calls: [], idem: new Map(), down: false, n: 0 };
  async function fetchImpl(url, opts = {}) {
    const u = new URL(url); const m = opts.method || 'GET';
    st.calls.push(`${m} ${u.pathname}`);
    const res = (status, body) => ({ status, ok: status < 300, json: async () => body });
    if (st.down) throw new Error('ECONNRESET');
    assert.equal(opts.headers.Authorization, 'Bearer sk_test_x');
    if (u.pathname === '/v1/checkout/sessions' && m === 'POST') {
      const p = Object.fromEntries(new URLSearchParams(opts.body));
      const key = opts.headers['Idempotency-Key'];
      if (st.idem.has(key)) return res(200, st.sessions.get(st.idem.get(key)));
      const id = 'cs_test_' + (++st.n);
      const s = { id, url: 'https://checkout.stripe.com/c/pay/' + id, status: 'open', payment_status: 'unpaid', metadata: { paymentId: p['metadata[paymentId]'], orderId: p['metadata[orderId]'] },
        amount_total: Number(p['line_items[0][price_data][unit_amount]']), currency: p['line_items[0][price_data][currency]'], payment_intent: null, _params: p };
      st.sessions.set(id, s); st.idem.set(key, id);
      return res(200, s);
    }
    const mm = u.pathname.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (mm) { const s = st.sessions.get(decodeURIComponent(mm[1])); return s ? res(200, s) : res(404, { error: { code: 'resource_missing' } }); }
    return res(404, {});
  }
  return { st, fetchImpl, pay(id, amount, pm = 'card') { const s = st.sessions.get(id); s.status = 'complete'; s.payment_status = 'paid'; if (amount != null) s.amount_total = amount; s.payment_intent = { id: 'pi_' + id, status: 'succeeded', payment_method_types: [pm] }; } };
}

function stripeCtx(extra = {}) {
  const clock = { t: Date.parse('2026-10-12T10:00:00Z') };
  const fake = fakeStripe(clock);
  const stripe = new StripeProvider({ secretKey: 'sk_test_x', webhookSecret: 'whsec_test', fetchImpl: fake.fetchImpl, now: () => clock.t });
  const ctx = setup({ clock, deps: { providers: { stripe }, ...extra } });
  return { ...ctx, stripeFake: fake };
}
const input = (x = {}) => VALID_INPUT({ provider: 'stripe', country: undefined, delivery: { city: 'Lyon', country: 'France' }, customer: { nom: 'Léa Martin', tel: '06 12 34 56 78', email: 'lea@test.fr', adresse: '1 rue A', codePostal: '69001' }, ...x });
function signed(ctx, evt, secret = 'whsec_test', at = ctx.clock.t) {
  const raw = JSON.stringify(evt); const t = Math.floor(at / 1000);
  const sig = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return { method: 'POST', url: 'https://shop.test/api/payments/webhook/stripe', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, rawBody: raw };
}
const evtFor = (order, type = 'checkout.session.completed') => ({ type, data: { object: { id: 'cs_x', metadata: { paymentId: order.paymentId, orderId: order.id } } } });

test('Stripe : session créée par le serveur en euros, montant recalculé, retour vers le site', async () => {
  const ctx = stripeCtx();
  const r = await ctx.service.createPayment(input({ lines: [{ productId: 'nag', qty: '50g', quantity: 2, unitPrice: 0.01 }] }));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.redirectUrl, /^https:\/\/checkout\.stripe\.com\//);
  const o = await ctx.repo.getOrder(r.orderId);
  assert.equal(o.amount, 46.9); assert.equal(o.paymentCurrency, 'EUR'); assert.equal(o.paymentProvider, 'stripe');
  const p = ctx.stripeFake.st.sessions.get('cs_test_1')._params;
  assert.equal(p['line_items[0][price_data][unit_amount]'], '4690');
  assert.equal(p['line_items[0][price_data][currency]'], 'eur');
  assert.equal(p.success_url, `https://shop.test/?pay=return&order=${o.id}`);
  assert.equal(p.customer_email, 'lea@test.fr');
  assert.ok(!Object.keys(p).some((k) => k.startsWith('payment_method_types')), 'moyens de paiement choisis dans le tableau de bord Stripe');
  assert.equal(o.codePostal, '69001'); assert.equal(o.ville, 'Lyon'); assert.equal(o.pays, 'France');
});

test('Stripe : double clic → une seule commande et une seule session', async () => {
  const ctx = stripeCtx();
  const i = input();
  const a = await ctx.service.createPayment(i), b = await ctx.service.createPayment(i);
  assert.equal(a.orderId, b.orderId); assert.equal(ctx.stripeFake.st.sessions.size, 1); assert.equal(ctx.repo._db.orders.size, 1);
});

test('Stripe : webhook signé → statut re-vérifié auprès de Stripe → commande payée, commerçante prévenue une fois', async () => {
  const ctx = stripeCtx();
  const r = await ctx.service.createPayment(input());
  const o = await ctx.repo.getOrder(r.orderId);
  ctx.stripeFake.pay('cs_test_1', null, 'card');                       // Stripe a encaissé le montant de la session
  assert.equal((await ctx.service.handleWebhook('stripe', signed(ctx, evtFor(o)))).status, 200);
  await ctx.service.handleWebhook('stripe', signed(ctx, evtFor(o)));
  const after = await ctx.repo.getOrder(o.id);
  assert.equal(after.paymentStatus, 'payee'); assert.equal(after.status, 'En attente');
  assert.equal(after.providerTransactionId, 'pi_cs_test_1'); assert.equal(after.paymentOperator, 'CARD');
  assert.deepEqual(ctx.notified, [o.id]);
});

test('Stripe : faux webhook (mauvaise signature, rejeu ancien) refusé', async () => {
  const ctx = stripeCtx();
  const r = await ctx.service.createPayment(input());
  const o = await ctx.repo.getOrder(r.orderId);
  ctx.stripeFake.pay('cs_test_1', 4690);
  assert.equal((await ctx.service.handleWebhook('stripe', signed(ctx, evtFor(o), 'whsec_FAUX'))).status, 401);
  assert.equal((await ctx.service.handleWebhook('stripe', signed(ctx, evtFor(o), 'whsec_test', ctx.clock.t - 3600000))).status, 401);
  assert.equal((await ctx.repo.getOrder(o.id)).paymentStatus, 'paiement_en_cours');
});

test('Stripe : un webhook « payé » mensonger ne suffit pas (Stripe dit non payé)', async () => {
  const ctx = stripeCtx();
  const r = await ctx.service.createPayment(input());
  const o = await ctx.repo.getOrder(r.orderId);
  await ctx.service.handleWebhook('stripe', signed(ctx, evtFor(o)));
  assert.equal((await ctx.repo.getOrder(o.id)).paymentStatus, 'paiement_en_cours');
  assert.equal(ctx.notified.length, 0);
});

test('Stripe : montant payé différent → « à vérifier », jamais « payée »', async () => {
  const ctx = stripeCtx();
  const r = await ctx.service.createPayment(input());
  const o = await ctx.repo.getOrder(r.orderId);
  ctx.stripeFake.pay('cs_test_1', 100);
  await ctx.service.handleWebhook('stripe', signed(ctx, evtFor(o)));
  assert.equal((await ctx.repo.getOrder(o.id)).paymentStatus, 'a_verifier');
  assert.deepEqual(ctx.reviews, ['AMOUNT_MISMATCH']);
});

test('Stripe : page abandonnée → expirée par la vérification planifiée, nouvelle tentative = nouvelle session', async () => {
  const ctx = stripeCtx();
  const r = await ctx.service.createPayment(input());
  ctx.clock.t += 40 * 60 * 1000;
  await ctx.service.reconcile();
  assert.equal((await ctx.repo.getOrder(r.orderId)).paymentStatus, 'annulee_expiree');
  const st = await ctx.service.getStatusForClient(r.orderId);
  assert.equal(st.canRetry, true);
  const retry = await ctx.service.retryPayment({ orderId: r.orderId, accessToken: r.accessToken });
  assert.equal(retry.ok, true); assert.equal(ctx.stripeFake.st.sessions.size, 2);
});

test('Stripe : la page « Paiement en cours » déclenche la vérification (webhook perdu)', async () => {
  const ctx = stripeCtx();
  const r = await ctx.service.createPayment(input());
  ctx.stripeFake.pay('cs_test_1');
  ctx.clock.t += 20000;
  const st = await ctx.service.getStatusForClient(r.orderId);
  assert.equal(st.paymentStatus, 'payee'); assert.equal(st.final, true);
});

test('Stripe injoignable : commande conservée, message clair', async () => {
  const ctx = stripeCtx();
  ctx.stripeFake.st.down = true;
  const r = await ctx.service.createPayment(input());
  assert.equal(r.code, 'PROVIDER_UNAVAILABLE');
  assert.equal((await ctx.repo.getOrder(r.orderId)).paymentStatus, 'en_attente_paiement');
});

test('compte client : jeton vérifié par le serveur → commande rattachée au compte', async () => {
  const ctx = stripeCtx({ verifyIdToken: async (t) => { if (t !== 'jeton-ok') throw new Error('bad'); return { uid: 'u42' }; } });
  const a = await ctx.service.createPayment(input({ idToken: 'jeton-ok' }));
  const b = await ctx.service.createPayment(input({ idToken: 'faux' }));
  assert.equal((await ctx.repo.getOrder(a.orderId)).uid, 'u42');
  assert.equal((await ctx.repo.getOrder(b.orderId)).uid, '');
});

test('professionnel : nom de l\'établissement obligatoire et enregistré', async () => {
  const ctx = stripeCtx();
  const bad = await ctx.service.createPayment(input({ customer: { nom: 'Spa Awa', tel: '0612345678', email: 'spa@test.fr', adresse: '2 rue B', type: 'professionnel' } }));
  assert.equal(bad.code, 'BAD_CUSTOMER');
  const ok = await ctx.service.createPayment(input({ customer: { nom: 'Spa Awa', tel: '0612345678', email: 'spa@test.fr', adresse: '2 rue B', type: 'professionnel', societe: 'Spa Awa SARL' } }));
  const o = await ctx.repo.getOrder(ok.orderId);
  assert.equal(o.type, 'professionnel'); assert.equal(o.societe, 'Spa Awa SARL');
});
