import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryRepo } from '../netlify/lib/repository/memoryRepo.mjs';
import { createPaymentService } from '../netlify/lib/paymentService.mjs';
import { createProviders } from '../netlify/lib/providers/index.mjs';
import { getConfig } from '../netlify/lib/config.mjs';
import { BASE_CATALOG, DELIVERY, VALID_INPUT } from './helpers.mjs';

/** Faux serveur PayPal (Orders v2). */
function fakePayPal() {
  const st = { orders: new Map(), calls: [], captureDecline: false, captureAmount: null, down: false, n: 0 };
  async function fetchImpl(url, opts = {}) {
    const u = new URL(url); const m = opts.method || 'GET';
    st.calls.push(`${m} ${u.pathname}`);
    const res = (status, body) => ({ status, ok: status < 300, json: async () => body });
    if (st.down) throw new Error('ECONNRESET');
    if (u.pathname === '/v1/oauth2/token') {
      assert.match(opts.headers.Authorization, /^Basic /);
      return res(200, { access_token: 'TOKEN', expires_in: 32000 });
    }
    assert.equal(opts.headers.Authorization, 'Bearer TOKEN');
    if (u.pathname === '/v2/checkout/orders' && m === 'POST') {
      const body = JSON.parse(opts.body);
      const rid = opts.headers['PayPal-Request-Id'];
      for (const o of st.orders.values()) if (o._rid === rid) return res(200, o);   // idempotence
      const id = 'PP' + (++st.n);
      const o = { id, _rid: rid, status: 'PAYER_ACTION_REQUIRED', purchase_units: body.purchase_units.map(p => ({ ...p })),
        links: [{ rel: 'payer-action', href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}` }], _body: body };
      st.orders.set(id, o); return res(200, o);
    }
    const mm = u.pathname.match(/^\/v2\/checkout\/orders\/([^/]+)(\/capture)?$/);
    if (mm) {
      const o = st.orders.get(decodeURIComponent(mm[1])); if (!o) return res(404, { name: 'RESOURCE_NOT_FOUND' });
      if (mm[2] && m === 'POST') {
        if (o.status === 'COMPLETED') return res(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_ALREADY_CAPTURED' }] });
        if (o.status !== 'APPROVED') return res(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] });
        if (st.captureDecline) return res(422, { name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'INSTRUMENT_DECLINED' }] });
        const amt = st.captureAmount || o.purchase_units[0].amount;
        o.status = 'COMPLETED';
        o.purchase_units[0].payments = { captures: [{ id: 'CAP-' + o.id, status: 'COMPLETED', amount: amt }] };
        return res(201, o);
      }
      return res(200, o);
    }
    return res(404, {});
  }
  return { st, fetchImpl, approveLast() { const o = [...st.orders.values()].pop(); o.status = 'APPROVED'; return o; } };
}

function setup() {
  const fake = fakePayPal();
  const config = getConfig({ PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'sec', SITE_URL: 'https://shop.test', BANK_TRANSFER: 'false', FIREBASE_CLIENT_EMAIL: 'test@x', FIREBASE_PRIVATE_KEY: 'x' });
  const repo = createMemoryRepo({ pricing: { deliveryConfig: DELIVERY, promoCodes: {} } });
  const paid = [];
  const service = createPaymentService({ repo, providers: createProviders(config, { paypalFetchImpl: fake.fetchImpl }), config,
    baseCatalog: BASE_CATALOG, notifyPaid: async o => paid.push(o.id) });
  return { fake, repo, service, paid };
}
const input = () => ({ ...VALID_INPUT(), provider: 'paypal', country: undefined,
  delivery: { country: 'Cameroun', city: 'Douala' }, customer: { nom: 'Awa', tel: '+33 6 12 34 56 78', email: 'awa@test.fr', adresse: 'Paris' } });

test('PayPal : commande en euros (parité fixe), lien d\'approbation, rien d\'encaissé avant validation', async () => {
  const ctx = setup();
  const cfg = await ctx.service.publicConfig();
  assert.equal(cfg.paypal, true); assert.equal(cfg.pawapay, false, 'pas de mobile money sans jeton PawaPay');
  const r = await ctx.service.createPayment(input());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.redirectUrl, /sandbox\.paypal\.com\/checkoutnow/);
  const o = await ctx.repo.getOrder(r.orderId);
  const eur = o.amount;   // boutique en euros : aucune conversion
  assert.equal(o.paymentCurrency, 'EUR'); assert.equal(o.paymentAmount, eur);
  const body = [...ctx.fake.st.orders.values()][0]._body;
  assert.deepEqual(body.purchase_units[0].amount, { currency_code: 'EUR', value: eur.toFixed(2) });
  assert.equal(body.purchase_units[0].custom_id, o.paymentId);
  assert.match(body.payment_source.paypal.experience_context.cancel_url, /cancel=true$/);
  // la cliente n'a pas encore validé : statut inchangé, aucune capture
  await ctx.service.getStatusForClient(o.id);
  assert.ok(!ctx.fake.st.calls.some(c => c.endsWith('/capture')));
  assert.notEqual((await ctx.repo.getOrder(o.id)).paymentStatus, 'payee');
});

test('PayPal : après validation, le serveur encaisse et marque la commande payée (une seule fois)', async () => {
  const ctx = setup();
  const r = await ctx.service.createPayment(input());
  ctx.fake.approveLast();
  const o = await ctx.repo.getOrder(r.orderId);
  await ctx.service.applyProviderStatus(o.paymentId, 'client_poll');
  const after = await ctx.repo.getOrder(o.id);
  assert.equal(after.paymentStatus, 'payee');
  assert.equal(after.providerTransactionId, 'CAP-PP1');
  await ctx.service.applyProviderStatus(o.paymentId, 'reconcile');   // 2e vérification : aucun effet
  assert.equal(ctx.paid.length, 1);
  assert.equal(ctx.fake.st.calls.filter(c => c.endsWith('/capture')).length, 1);
});

test('PayPal : montant encaissé différent → « à vérifier », jamais « payée »', async () => {
  const ctx = setup();
  const r = await ctx.service.createPayment(input());
  ctx.fake.approveLast(); ctx.fake.st.captureAmount = { currency_code: 'EUR', value: '1.00' };
  const o = await ctx.repo.getOrder(r.orderId);
  await ctx.service.applyProviderStatus(o.paymentId, 'client_poll');
  assert.equal((await ctx.repo.getOrder(o.id)).paymentStatus, 'a_verifier');
});

test('PayPal : carte refusée → échec avec message, nouvelle tentative possible', async () => {
  const ctx = setup();
  const r = await ctx.service.createPayment(input());
  ctx.fake.approveLast(); ctx.fake.st.captureDecline = true;
  const o = await ctx.repo.getOrder(r.orderId);
  await ctx.service.applyProviderStatus(o.paymentId, 'client_poll');
  const s = await ctx.service.getStatusForClient(o.id);
  assert.equal(s.paymentStatus, 'echouee'); assert.equal(s.canRetry, true); assert.match(s.message, /refusé/);
  ctx.fake.st.captureDecline = false;
  const retry = await ctx.service.retryPayment({ orderId: o.id, accessToken: r.accessToken });
  assert.equal(retry.ok, true); assert.equal(ctx.fake.st.orders.size, 2);
});

test('PayPal : abandon → expiré après 60 min, aucune capture', async () => {
  const fake = fakePayPal(); const clock = { t: Date.parse('2026-10-13T10:00:00Z') };
  const config = getConfig({ PAYPAL_CLIENT_ID: 'cid', PAYPAL_CLIENT_SECRET: 'sec', SITE_URL: 'https://shop.test', BANK_TRANSFER: 'false', FIREBASE_CLIENT_EMAIL: 'test@x', FIREBASE_PRIVATE_KEY: 'x' });
  const repo = createMemoryRepo({ pricing: { deliveryConfig: DELIVERY, promoCodes: {} } });
  const service = createPaymentService({ repo, providers: createProviders(config, { paypalFetchImpl: fake.fetchImpl }), config, baseCatalog: BASE_CATALOG, now: () => clock.t });
  const r = await service.createPayment(input());
  const o = await repo.getOrder(r.orderId);
  clock.t += 30 * 60000; await service.applyProviderStatus(o.paymentId, 'reconcile');
  assert.equal((await repo.getOrder(o.id)).paymentStatus, 'paiement_en_cours');
  clock.t += 35 * 60000; await service.applyProviderStatus(o.paymentId, 'reconcile');
  assert.equal((await repo.getOrder(o.id)).paymentStatus, 'annulee_expiree');
  assert.ok(!fake.st.calls.some(c => c.endsWith('/capture')));
});

test('PayPal injoignable : la commande reste ouverte (pas de faux échec)', async () => {
  const ctx = setup();
  const r = await ctx.service.createPayment(input());
  ctx.fake.st.down = true;
  const o = await ctx.repo.getOrder(r.orderId);
  await assert.rejects(ctx.service.applyProviderStatus(o.paymentId, 'reconcile'));
  assert.equal((await ctx.repo.getOrder(o.id)).paymentStatus, 'paiement_en_cours');
});

test('Boutons PayPal intégrés : commande PayPal créée sans redirection, encaissée après validation', async () => {
  const ctx = setup();
  const r = await ctx.service.createPayment({ ...input(), embedded: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.paypalOrderId, 'PP1');
  const body = [...ctx.fake.st.orders.values()][0]._body;
  assert.equal(body.payment_source, undefined, 'pas de page de redirection');
  assert.equal(body.application_context.brand_name, 'Secret de Maryline Beauty');
  // mauvais jeton : refusé
  assert.equal((await ctx.service.confirmPayment({ orderId: r.orderId, accessToken: 'faux' })).code, 'FORBIDDEN');
  ctx.fake.approveLast();
  const c = await ctx.service.confirmPayment({ orderId: r.orderId, accessToken: r.accessToken });
  assert.equal(c.paymentStatus, 'payee');
  assert.equal(ctx.paid.length, 1);
});

test('Boutons PayPal : fenêtre fermée puis rouverte → nouvelle commande PayPal, aucune double commande boutique', async () => {
  const ctx = setup();
  const inp = { ...input(), embedded: true };
  const r1 = await ctx.service.createPayment(inp);
  const r2 = await ctx.service.createPayment(inp);
  assert.equal(r2.orderId, r1.orderId, 'même commande boutique');
  assert.equal(r2.paypalOrderId, 'PP2');
  ctx.fake.approveLast();
  const c = await ctx.service.confirmPayment({ orderId: r1.orderId, accessToken: r1.accessToken });
  assert.equal(c.paymentStatus, 'payee');
});
