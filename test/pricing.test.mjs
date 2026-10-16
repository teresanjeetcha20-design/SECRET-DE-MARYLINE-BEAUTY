import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeOrderTotal, convertFromEUR, buildCatalog, PricingError, EUR_TO_XAF } from '../netlify/lib/pricing.mjs';
import { BASE_CATALOG, DELIVERY } from './helpers.mjs';

const data = (extra = {}) => ({ baseCatalog: BASE_CATALOG, customProducts: [], productStatus: {}, productPromos: {}, promo: null, deliveryConfig: DELIVERY, mainCountry: 'France', ...extra });
const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof PricingError); return e.code; } assert.fail('aucune erreur'); };

test('total en euros : produits + livraison standard France', () => {
  const t = computeOrderTotal({ lines: [{ productId: 'nag', qty: '50g', quantity: 2 }], delivery: { city: 'Lyon', country: 'France' } }, data());
  assert.equal(t.subtotal, 40); assert.equal(t.deliveryFee, 6.9); assert.equal(t.amount, 46.9);
});
test('ville avec tarif propre (Paris offert) et pays étranger', () => {
  assert.equal(computeOrderTotal({ lines: [{ productId: 'nag', qty: '50g', quantity: 1 }], delivery: { city: 'paris', country: 'France' } }, data()).amount, 20);
  assert.equal(computeOrderTotal({ lines: [{ productId: 'nag', qty: '50g', quantity: 1 }], delivery: { city: 'Douala', country: 'Cameroun' } }, data()).amount, 45);
});
test('promotion produit −10 % puis code −20 % (arrondis au centime comme le site)', () => {
  const t = computeOrderTotal({ lines: [{ productId: 'ectoine', qty: '10g', quantity: 3 }], promoCode: 'NOEL20', delivery: { city: 'Paris', country: 'France' } },
    data({ productPromos: { ectoine: 10 }, promo: { code: 'NOEL20', pct: 20, active: true } }));
  assert.equal(t.lines[0].unitPrice, 22.5); assert.equal(t.subtotal, 67.5); assert.equal(t.discount, 13.5); assert.equal(t.amount, 54);
});
test('refus : sur devis, produit masqué, format inconnu, quantité, panier vide, code invalide', () => {
  const d = { city: 'Paris', country: 'France' };
  assert.equal(code(() => computeOrderTotal({ lines: [{ productId: 'nag', qty: '250g', quantity: 1 }], delivery: d }, data())), 'QUOTE_ONLY');
  assert.equal(code(() => computeOrderTotal({ lines: [{ productId: 'nag', qty: '50g', quantity: 1 }], delivery: d }, data({ productStatus: { nag: 'draft' } }))), 'UNKNOWN_PRODUCT');
  assert.equal(code(() => computeOrderTotal({ lines: [{ productId: 'nag', qty: '5kg', quantity: 1 }], delivery: d }, data())), 'UNKNOWN_FORMAT');
  assert.equal(code(() => computeOrderTotal({ lines: [{ productId: 'nag', qty: '50g', quantity: 0 }], delivery: d }, data())), 'BAD_QUANTITY');
  assert.equal(code(() => computeOrderTotal({ lines: [], delivery: d }, data())), 'EMPTY_CART');
  assert.equal(code(() => computeOrderTotal({ lines: [{ productId: 'nag', qty: '50g', quantity: 1 }], promoCode: 'FAUX', delivery: d }, data())), 'BAD_PROMO');
});
test('livraison à confirmer (pays sans tarif) : paiement refusé', () => {
  assert.equal(code(() => computeOrderTotal({ lines: [{ productId: 'nag', qty: '50g', quantity: 1 }], delivery: { city: 'Nairobi', country: 'Kenya' } }, data())), 'DELIVERY_TO_CONFIRM');
  assert.equal(code(() => computeOrderTotal({ lines: [{ productId: 'nag', qty: '50g', quantity: 1 }], delivery: { city: 'Rome', country: 'Italie' } }, data())), 'DELIVERY_TO_CONFIRM');
});
test('le prix envoyé par le navigateur est ignoré', () => {
  const t = computeOrderTotal({ lines: [{ productId: 'nag', qty: '50g', quantity: 1, unitPrice: 0.01, price: 0.01 }], delivery: { city: 'Paris', country: 'France' } }, data());
  assert.equal(t.amount, 20);
});
test('produits de l\'admin : fiche modifiée, produit créé, prix « sur devis »', () => {
  const cat = buildCatalog(BASE_CATALOG, [{ id: 'nag', name: 'NAG premium', formats: [{ qty: '50g', price: 30 }] }, { id: 'custom_1', name: 'Sérum', price: 12.5 }, { id: 'custom_2', name: 'Kit', formats: [{ qty: '1kg', price: '' }] }], {});
  assert.deepEqual(cat.get('nag').formats, [{ size: '50g', price: 30 }]);
  assert.deepEqual(cat.get('custom_1').formats, [{ size: 'Unité', price: 12.5 }]);
  assert.equal(cat.get('custom_2').formats[0].price, null);
});
test('conversion Mobile Money : F CFA à parité fixe, devise locale avec taux + marge, arrondis au supérieur', () => {
  assert.deepEqual(convertFromEUR(46.9, 'XAF', 0, null), { amount: Math.ceil(46.9 * EUR_TO_XAF - 1e-9), eurRate: EUR_TO_XAF, marginPct: 0 });
  assert.equal(convertFromEUR(10, 'XOF', 0, null).amount, 6560);
  assert.equal(convertFromEUR(10, 'GHS', 2, { eurRates: { GHS: 16.2 }, marginPct: 3 }).amount, 166.86);
  assert.equal(convertFromEUR(10, 'GHS', 2, { eurRates: {} }), null);
  assert.equal(convertFromEUR(46.9, 'EUR', 2, null).amount, 46.9);
});
