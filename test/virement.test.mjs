import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, VALID_INPUT } from './helpers.mjs';

const input = (x = {}) => VALID_INPUT({ provider: 'virement', country: undefined, delivery: { city: 'Paris', country: 'France' }, promoCode: 'NOEL20', customer: { nom: 'Léa', tel: '0612345678', email: 'lea@test.fr', adresse: '1 rue A' }, ...x });

test('virement : commande créée par le serveur au bon montant, « virement attendu », commerçante prévenue', async () => {
  const ctx = setup();
  const r = await ctx.service.createPayment(input({ lines: [{ productId: 'nag', qty: '50g', quantity: 2, unitPrice: 0.01 }] }));
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.transfer, true);
  const o = await ctx.repo.getOrder(r.orderId);
  assert.equal(o.amount, 32); assert.equal(o.paymentStatus, 'virement_attendu'); assert.equal(o.status, 'En attente');
  assert.equal(o.paymentMode, 'Virement bancaire'); assert.equal(o.discount, 8);
  assert.deepEqual(ctx.created, [o.id]); assert.equal(ctx.repo._db.promoUses.NOEL20, 1);
  assert.ok(ctx.repo._db.tracking.get(o.id), 'suivi public créé');
});
test('virement : double clic → même commande', async () => {
  const ctx = setup();
  const i = input();
  const a = await ctx.service.createPayment(i), b = await ctx.service.createPayment(i);
  assert.equal(a.orderId, b.orderId); assert.equal(ctx.repo._db.orders.size, 1); assert.equal(ctx.created.length, 1);
});
test('virement désactivé : refusé', async () => {
  const ctx = setup({ env: { BANK_TRANSFER: 'false' } });
  assert.equal((await ctx.service.createPayment(input())).code, 'DISABLED');
});
test('virement : livraison à confirmer → refusé (montant inconnu)', async () => {
  const ctx = setup();
  assert.equal((await ctx.service.createPayment(input({ delivery: { city: 'Nairobi', country: 'Kenya' } }))).code, 'DELIVERY_TO_CONFIRM');
});
test('configuration publique : moyens actifs, aucun secret', async () => {
  const ctx = setup({ fx: { eurRates: { GHS: 16.2 }, marginPct: 3 } });
  const c = await ctx.service.publicConfig();
  assert.equal(c.transfer, true); assert.equal(c.pawapay, true);
  assert.ok(c.countries.some((x) => x.code === 'GHA') && !c.countries.some((x) => x.code === 'KEN'), 'pays hors F CFA proposé seulement avec un taux');
  assert.ok(!JSON.stringify(c).includes('test-token'));
});

test('identifiants Firebase absents côté serveur : aucun paiement proposé', async () => {
  const ctx = setup({ env: { FIREBASE_CLIENT_EMAIL: '', FIREBASE_PRIVATE_KEY: '' } });
  const c = await ctx.service.publicConfig();
  assert.equal(c.enabled, false); assert.equal(c.transfer, false);
});
