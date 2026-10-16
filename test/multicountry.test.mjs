import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatProviderAmount, EUR_TO_XAF } from '../netlify/lib/pricing.mjs';
import { setup, VALID_INPUT, signedCallback } from './helpers.mjs';

const FX = { eurRates: { GHS: 15.2, KES: 140.5, USD: 1.08 }, marginPct: 3 };

test('Mobile Money au Ghana : payé en GHS avec le taux de l\'admin + marge', async () => {
  const ctx = setup({ fx: FX });
  const r = await ctx.service.createPayment(VALID_INPUT({ country: 'GHA', delivery: { city: 'Accra', country: 'Ghana' }, customer: { nom: 'Ama', tel: '+233 24 123 4567', email: 'ama@test.gh', adresse: 'Osu' } }));
  assert.equal(r.ok, true, JSON.stringify(r));
  const o = await ctx.repo.getOrder(r.orderId);
  assert.equal(o.amount, 110);                                              // 80 € + livraison Ghana 30 €
  assert.equal(o.paymentAmount, Math.ceil(110 * 15.2 * 1.03 * 100 - 1e-9) / 100);
  assert.equal(o.paymentCurrency, 'GHS'); assert.equal(o.tel, '233241234567');
  assert.match(o.total, /^110 € — payé .* GHS$/);
  assert.deepEqual(ctx.fake.state.sessions[0].amountDetails, { amount: formatProviderAmount(o.paymentAmount), currency: 'GHS' });
});
test('Sénégal en F CFA (XOF) sans taux ; RD Congo en dollars (2 décimales)', async () => {
  const ctx = setup({ fx: FX });
  const sn = await ctx.service.createPayment(VALID_INPUT({ country: 'SEN', customer: { nom: 'Fatou', tel: '+221 77 123 45 67', email: 'f@test.sn', adresse: 'Dakar' } }));
  const o1 = await ctx.repo.getOrder(sn.orderId);
  assert.equal(o1.paymentCurrency, 'XOF'); assert.equal(o1.paymentAmount, Math.ceil(105 * EUR_TO_XAF));
  const cd = await ctx.service.createPayment(VALID_INPUT({ country: 'COD', customer: { nom: 'Grâce', tel: '+243 81 234 5678', email: 'g@test.cd', adresse: 'Kinshasa' } }));
  const o2 = await ctx.repo.getOrder(cd.orderId);
  assert.equal(o2.paymentCurrency, 'USD'); assert.equal(o2.paymentAmount, Math.ceil(105 * 1.08 * 1.03 * 100 - 1e-9) / 100);
});
test('pays hors F CFA sans taux : refusé', async () => {
  const ctx = setup({ fx: FX });
  const r = await ctx.service.createPayment(VALID_INPUT({ country: 'NGA', customer: { nom: 'Ade', tel: '+234 803 123 4567', email: 'a@test.ng', adresse: 'Lagos' } }));
  assert.equal(r.code, 'NO_RATE');
});
test('paiement confirmé dans la devise locale : montant ET devise vérifiés', async () => {
  const ctx = setup({ fx: FX });
  const r = await ctx.service.createPayment(VALID_INPUT({ country: 'GHA', delivery: { city: 'Accra', country: 'Ghana' }, customer: { nom: 'Ama', tel: '+233 24 123 4567', email: 'ama@test.gh', adresse: 'Osu' } }));
  const o = await ctx.repo.getOrder(r.orderId);
  ctx.fake.setDeposit(o.paymentId, 'COMPLETED', { amount: String(o.paymentAmount), currency: 'GHS', country: 'GHA' });
  await ctx.service.handleWebhook('pawapay', signedCallback({ depositId: o.paymentId, status: 'COMPLETED' }));
  assert.equal((await ctx.repo.getOrder(o.id)).paymentStatus, 'payee');
});
test('numéro Mobile Money invalide pour le pays : refusé avec l\'indicatif attendu', async () => {
  const ctx = setup();
  const r = await ctx.service.createPayment(VALID_INPUT({ country: 'GAB', customer: { nom: 'Awa', tel: '12', email: 'a@test.ga', adresse: 'Libreville' } }));
  assert.equal(r.code, 'BAD_PHONE'); assert.match(r.message, /\+241/);
});
