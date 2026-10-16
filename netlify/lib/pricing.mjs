/**
 * Recalcul du montant d'une commande CÔTÉ SERVEUR (prix de la boutique en euros).
 * Le navigateur n'envoie que : produit, format, quantité, code promo, ville et pays de livraison.
 * Tout prix éventuellement envoyé par le navigateur est ignoré.
 *
 * Même logique que le site (js/smb-shared.js) : promotions produits (−x %, arrondi au centime),
 * codes promo, frais de livraison par ville (pays principal) ou par pays.
 */
export const EUR_TO_XAF = 655.957;               // parité fixe euro / franc CFA
const MAX_QTY_PER_LINE = 50;
const MAX_LINES = 40;
const r2 = (n) => Math.round(n * 100) / 100;

export class PricingError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function parsePrice(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return isFinite(v) && v > 0 ? r2(v) : null;
  const s = String(v);
  if (/devis/i.test(s)) return null;
  const m = s.replace(/[\s\u00a0\u202f]/g, '').match(/(\d+(?:[.,]\d+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  return isFinite(n) && n > 0 ? r2(n) : null;
}

/** Formats d'un produit créé/modifié dans l'admin : [{ qty|size, price }] ou { price }. */
export function adminFormats(c) {
  if (c.formats && c.formats.length) return c.formats.map((f) => ({ size: String(f.size || f.qty || 'Unité'), price: parsePrice(f.price) }));
  return [{ size: 'Unité', price: parsePrice(c.price) }];
}

/** Catalogue effectif = catalogue d'origine (data.js) + produits ajoutés/modifiés dans l'admin. */
export function buildCatalog(baseCatalog, customProducts = [], productStatus = {}) {
  const hidden = (s) => s === 'archived' || s === 'draft';
  const byId = new Map();
  for (const bp of baseCatalog) byId.set(String(bp.id), { id: String(bp.id), name: bp.name, formats: bp.formats.map((f) => ({ size: f.size, price: parsePrice(f.price) })) });
  for (const c of (customProducts || []).filter((x) => x && x.name)) {
    const id = String(c.id);
    const base = byId.get(id);
    if (base) {
      base.name = c.name || base.name;
      if ((c.formats && c.formats.length) || c.price) base.formats = adminFormats(c);
    } else {
      byId.set(id, { id, name: c.name, formats: adminFormats(c) });
    }
  }
  for (const id of [...byId.keys()]) if (hidden(productStatus[id])) byId.delete(id);
  return byId;
}

export function validatePromo(promo, now = Date.now()) {
  if (!promo) return null;
  const pct = Number(promo.pct);
  if (!promo.active || !(pct > 0 && pct <= 90)) return null;
  if (promo.expires && new Date(promo.expires + 'T23:59:59').getTime() < now) return null;
  if (promo.maxUses && (promo.usedCount || 0) >= promo.maxUses) return null;
  return { code: promo.code, pct };
}

export function deliveryFeeFor(cfg, city, country, mainCountry = 'France') {
  const c = cfg || {};
  const low = (v) => String(v || '').trim().toLowerCase();
  if (country && low(country) !== low(mainCountry)) {
    const k = (c.countries || []).find((x) => low(x.name) === low(country));
    return k ? k.fee : (typeof c.otherCountry === 'number' ? c.otherCountry : null);
  }
  const z = (c.zones || []).find((x) => low(x.name) === low(city));
  return z ? z.fee : (typeof c.other === 'number' ? c.other : null);
}

/**
 * @param {object} input  { lines:[{productId, qty, quantity}], promoCode, delivery:{ city, country } }
 * @param {object} data   { baseCatalog, customProducts, productStatus, productPromos, promo, deliveryConfig, mainCountry }
 */
export function computeOrderTotal(input, data, now = Date.now()) {
  const catalog = buildCatalog(data.baseCatalog, data.customProducts, data.productStatus);
  const rawLines = Array.isArray(input.lines) ? input.lines : [];
  if (!rawLines.length) throw new PricingError('EMPTY_CART', 'Le panier est vide.');
  if (rawLines.length > MAX_LINES) throw new PricingError('TOO_MANY_LINES', 'Panier trop volumineux.');

  const lines = [];
  for (const l of rawLines) {
    const p = catalog.get(String(l.productId));
    if (!p) throw new PricingError('UNKNOWN_PRODUCT', 'Un produit du panier n\'est plus disponible.');
    const fmt = p.formats.find((f) => f.size === String(l.qty || '')) || (p.formats.length === 1 && !l.qty ? p.formats[0] : null);
    if (!fmt) throw new PricingError('UNKNOWN_FORMAT', `Le format choisi pour « ${p.name} » n'existe plus.`);
    const quantity = Number(l.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY_PER_LINE) throw new PricingError('BAD_QUANTITY', 'Quantité invalide.');
    let unit = fmt.price;
    if (unit === null) throw new PricingError('QUOTE_ONLY', `« ${p.name} (${fmt.size}) » est vendu sur devis : contactez-nous pour ce format.`);
    const pct = Number((data.productPromos || {})[p.id]) || 0;
    if (pct > 0 && pct < 100) unit = Math.round(unit * (100 - pct)) / 100;
    lines.push({ id: p.id, name: p.name, qty: fmt.size, quantity, unitPrice: unit, total: r2(unit * quantity) });
  }
  const subtotal = r2(lines.reduce((a, l) => a + l.total, 0));

  let discount = 0, promoCode = '';
  if (input.promoCode) {
    const promo = validatePromo(data.promo, now);
    if (!promo) throw new PricingError('BAD_PROMO', 'Code promo invalide ou expiré.');
    discount = Math.round(subtotal * promo.pct) / 100;
    promoCode = promo.code;
  }

  const d = input.delivery || {};
  const city = String(d.city || '').trim().slice(0, 80);
  const country = String(d.country || data.mainCountry || 'France').trim().slice(0, 60);
  if (!city) throw new PricingError('NO_DELIVERY', 'Indiquez votre ville de livraison.');
  const deliveryFee = deliveryFeeFor(data.deliveryConfig, city, country, data.mainCountry || 'France');
  if (typeof deliveryFee !== 'number' || deliveryFee < 0) {
    throw new PricingError('DELIVERY_TO_CONFIRM', `Les frais de livraison vers ${city} (${country}) sont à confirmer : choisissez le virement ou contactez-nous.`);
  }

  const amount = r2(subtotal - discount + deliveryFee);
  if (!(amount > 0)) throw new PricingError('BAD_AMOUNT', 'Montant invalide.');
  const itemsLabel = lines.map((l) => `${l.name}${l.qty ? ' (' + l.qty + ')' : ''} ×${l.quantity}`).join(', ');
  return { lines, subtotal, discount, deliveryFee: r2(deliveryFee), deliveryZone: `${city}, ${country}`, city, country, amount, promoCode, itemsLabel };
}

// ── Devises ─────────────────────────────────────────────────────────────────
// Boutique en euros. Mobile Money : XAF / XOF à la parité fixe (1 € = 655,957 F CFA) ;
// autres devises : taux « 1 € = N <devise> » réglé dans l'admin (config/fx) + marge de sécurité.
// Montant arrondi AU SUPÉRIEUR selon les décimales acceptées dans le pays.
export const CFA_CURRENCIES = new Set(['XAF', 'XOF']);
export function convertFromEUR(amountEUR, currency, decimals, fx) {
  if (currency === 'EUR') return { amount: r2(amountEUR), eurRate: 1, marginPct: 0 };
  if (CFA_CURRENCIES.has(currency)) return { amount: Math.ceil(amountEUR * EUR_TO_XAF - 1e-9), eurRate: EUR_TO_XAF, marginPct: 0 };
  const eurRate = Number(fx && fx.eurRates && fx.eurRates[currency]);
  if (!(eurRate > 0)) return null;
  const marginPct = Math.min(Math.max(Number(fx.marginPct) || 0, 0), 20);
  const raw = amountEUR * eurRate * (1 + marginPct / 100);
  const f = 10 ** (decimals || 0);
  return { amount: Math.ceil(raw * f - 1e-9) / f, eurRate, marginPct };
}
/** Format attendu par PawaPay : pas de zéros inutiles (« 98.4 », « 1500 »). */
export function formatProviderAmount(n) {
  return Number(n).toFixed(2).replace(/\.?0+$/, '');
}
export function formatEUR(n) {
  const v = r2(Number(n) || 0);
  return v.toLocaleString('fr-FR', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 }).replace(/\u202f|\u00a0/g, ' ') + ' €';
}
export function formatMoney(n, currency) {
  if (currency === 'EUR') return formatEUR(n);
  if (CFA_CURRENCIES.has(currency)) return Math.round(n).toLocaleString('fr-FR').replace(/\u202f|\u00a0/g, ' ') + ' F CFA';
  return Number(n).toLocaleString('fr-FR', { maximumFractionDigits: 2 }).replace(/\u202f|\u00a0/g, ' ') + ' ' + currency;
}
