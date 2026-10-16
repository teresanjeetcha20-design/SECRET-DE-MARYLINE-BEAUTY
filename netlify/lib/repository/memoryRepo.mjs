/** Dépôt en mémoire : utilisé par les tests (même interface que firestoreRepo). */
export function createMemoryRepo(seed = {}) {
  const db = {
    orders: new Map(), payments: new Map(), checkoutKeys: new Map(), tracking: new Map(),
    events: [], promoUses: {},
    pricing: { customProducts: [], productStatus: {}, productPromos: {}, promoCodes: {}, deliveryConfig: { zones: [], other: null, countries: [], otherCountry: null }, ...(seed.pricing || {}) },
  };
  const clone = o => (o ? JSON.parse(JSON.stringify(o)) : o);
  return {
    _db: db,
    async getPricingData(promoCode) {
      const p = db.pricing;
      return { customProducts: p.customProducts, productStatus: p.productStatus, productPromos: p.productPromos,
        promo: promoCode ? clone(p.promoCodes[promoCode]) || null : null, deliveryConfig: p.deliveryConfig };
    },
    async getFxConfig() { return clone(db.pricing.fx) || null; },
    async getCheckoutKey(key) { return db.checkoutKeys.get(key) || null; },
    async createOrder(order, checkoutKey) {
      if (db.orders.has(order.id)) throw new Error('ORDER_EXISTS');
      db.orders.set(order.id, clone(order));
      db.tracking.set(order.id, { id: order.id, status: order.status, date: order.date, items: order.items, total: order.total });
      if (checkoutKey) db.checkoutKeys.set(checkoutKey, order.id);
    },
    unsubscribed: new Set(),
    async isUnsubscribed(email) { return this.unsubscribed.has(String(email).toLowerCase()); },
    async unsubscribe(email) { this.unsubscribed.add(String(email).toLowerCase()); },
    async createOrderWithPayment(order, payment, checkoutKey) {
      if (db.orders.has(order.id)) throw new Error('ORDER_EXISTS');
      db.orders.set(order.id, clone(order));
      db.payments.set(payment.id, clone(payment));
      db.tracking.set(order.id, { id: order.id, status: order.status, date: order.date, items: order.items, total: order.total });
      if (checkoutKey) db.checkoutKeys.set(checkoutKey, order.id);
    },
    async addPaymentAttempt(orderId, payment, orderPatch) {
      db.payments.set(payment.id, clone(payment));
      Object.assign(db.orders.get(orderId), clone(orderPatch));
    },
    async getOrder(id) { return clone(db.orders.get(id)) || null; },
    async getPayment(id) { return clone(db.payments.get(id)) || null; },
    async updatePayment(id, patch) { Object.assign(db.payments.get(id), clone(patch)); },
    async updateOrder(id, patch) { Object.assign(db.orders.get(id), clone(patch)); },
    /** decide(payment, order) → { paymentPatch, orderPatch, trackingPatch } | null (aucun changement) */
    async transition(paymentId, decide) {
      const payment = db.payments.get(paymentId);
      if (!payment) return { found: false };
      const order = db.orders.get(payment.orderId);
      const res = decide(clone(payment), clone(order));
      if (!res) return { found: true, changed: false, payment: clone(payment), order: clone(order) };
      Object.assign(payment, clone(res.paymentPatch || {}));
      Object.assign(order, clone(res.orderPatch || {}));
      if (res.trackingPatch) Object.assign(db.tracking.get(order.id) || {}, res.trackingPatch);
      return { found: true, changed: true, payment: clone(payment), order: clone(order) };
    },
    async findOpenPayments(limit = 50) {
      return [...db.payments.values()].filter(p => p.status === 'en_attente_paiement' || p.status === 'paiement_en_cours').slice(0, limit).map(clone);
    },
    async incrementPromoUse(code) { db.promoUses[code] = (db.promoUses[code] || 0) + 1; },
    async logEvent(e) { db.events.push(e); },
  };
}
