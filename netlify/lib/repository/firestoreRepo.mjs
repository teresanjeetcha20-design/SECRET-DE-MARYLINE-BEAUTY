/**
 * Accès Firestore côté serveur (Firebase Admin SDK : contourne les règles, ne JAMAIS l'utiliser côté navigateur).
 *
 * Collections :
 *   orders/{orderId}          commande (+ paymentStatus, paymentId, amount…)
 *   payments/{paymentId}      une tentative de paiement
 *   order_tracking/{orderId}  suivi public sans données personnelles
 *   checkout_keys/{key}       anti double-clic : clé de commande → orderId
 *   payment_events/{auto}     journal technique (sans données sensibles)
 *   unsubscribed/{hash}       adresses désinscrites des e-mails marketing
 *
 * Identifiants Firebase (variables Netlify) : soit FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
 * (recommandé : plus court, les fonctions ont une limite d'environ 4 Ko pour toutes les variables),
 * soit FIREBASE_SERVICE_ACCOUNT (contenu complet du fichier JSON).
 */
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { createHash } from 'node:crypto';

export function credentials(env = process.env) {
  if (env.FIREBASE_PRIVATE_KEY && env.FIREBASE_CLIENT_EMAIL) {
    return { projectId: env.FIREBASE_PROJECT_ID, clientEmail: env.FIREBASE_CLIENT_EMAIL, privateKey: String(env.FIREBASE_PRIVATE_KEY).replace(/\\n/g, '\n') };
  }
  let raw = String(env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) throw new Error('Identifiants Firebase manquants (FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY)');
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
  const sa = JSON.parse(raw);
  return { projectId: sa.project_id, clientEmail: sa.client_email, privateKey: String(sa.private_key).replace(/\\n/g, '\n') };
}

let _db = null;
export function db(env = process.env) {
  if (_db) return _db;
  if (!getApps().length) initializeApp({ credential: cert(credentials(env)) });
  _db = getFirestore();
  return _db;
}
export const emailHash = (email) => createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('hex');

export function createFirestoreRepo() {
  const d = () => db();
  return {
    async getPricingData(promoCode) {
      const [customs, status, promos, delivery, promo] = await Promise.all([
        d().collection('custom_products').get(),
        d().collection('product_status').get(),
        d().doc('config/promos').get(),
        d().doc('config/delivery').get(),
        promoCode ? d().doc(`promo_codes/${promoCode}`).get() : Promise.resolve(null),
      ]);
      const productStatus = {};
      status.forEach((s) => { productStatus[s.id] = s.data().status; });
      return {
        customProducts: customs.docs.map((x) => ({ ...x.data(), id: x.data().id ?? x.id })),
        productStatus,
        productPromos: (promos.exists && promos.data().data) || {},
        deliveryConfig: delivery.exists ? delivery.data() : { zones: [], other: null, countries: [], otherCountry: null },
        promo: promo && promo.exists ? promo.data() : null,
      };
    },
    async getFxConfig() { const s = await d().doc('config/fx').get(); return s.exists ? s.data() : null; },
    async getCheckoutKey(key) { const s = await d().doc(`checkout_keys/${key}`).get(); return s.exists ? s.data().orderId : null; },
    async createOrderWithPayment(order, payment, checkoutKey) {
      const b = d().batch();
      b.create(d().doc(`orders/${order.id}`), { ...order, createdAt: FieldValue.serverTimestamp() });
      b.create(d().doc(`payments/${payment.id}`), payment);
      b.set(d().doc(`order_tracking/${order.id}`), { id: order.id, status: order.status, date: order.date, items: order.items, total: order.total, createdAt: FieldValue.serverTimestamp() });
      if (checkoutKey) b.create(d().doc(`checkout_keys/${checkoutKey}`), { orderId: order.id, at: Date.now() });
      await b.commit();
    },
    async createOrder(order, checkoutKey) {
      const b = d().batch();
      b.create(d().doc(`orders/${order.id}`), { ...order, createdAt: FieldValue.serverTimestamp() });
      b.set(d().doc(`order_tracking/${order.id}`), { id: order.id, status: order.status, date: order.date, items: order.items, total: order.total, createdAt: FieldValue.serverTimestamp() });
      if (checkoutKey) b.create(d().doc(`checkout_keys/${checkoutKey}`), { orderId: order.id, at: Date.now() });
      await b.commit();
    },
    async addPaymentAttempt(orderId, payment, orderPatch) {
      const b = d().batch();
      b.create(d().doc(`payments/${payment.id}`), payment);
      b.update(d().doc(`orders/${orderId}`), orderPatch);
      await b.commit();
    },
    async getOrder(id) { const s = await d().doc(`orders/${id}`).get(); return s.exists ? s.data() : null; },
    async getPayment(id) { const s = await d().doc(`payments/${id}`).get(); return s.exists ? s.data() : null; },
    async updatePayment(id, patch) { await d().doc(`payments/${id}`).update(patch); },
    async updateOrder(id, patch) { await d().doc(`orders/${id}`).update(patch); },
    async transition(paymentId, decide) {
      return d().runTransaction(async (tx) => {
        const pRef = d().doc(`payments/${paymentId}`);
        const pSnap = await tx.get(pRef);
        if (!pSnap.exists) return { found: false };
        const payment = pSnap.data();
        const oRef = d().doc(`orders/${payment.orderId}`);
        const oSnap = await tx.get(oRef);
        const order = oSnap.data();
        const res = decide(payment, order);
        if (!res) return { found: true, changed: false, payment, order };
        if (res.paymentPatch) tx.update(pRef, res.paymentPatch);
        if (res.orderPatch) tx.update(oRef, res.orderPatch);
        if (res.trackingPatch) tx.set(d().doc(`order_tracking/${order.id}`), res.trackingPatch, { merge: true });
        return { found: true, changed: true, payment: { ...payment, ...res.paymentPatch }, order: { ...order, ...res.orderPatch } };
      });
    },
    async findOpenPayments(limit = 50) {
      const s = await d().collection('payments').where('status', 'in', ['en_attente_paiement', 'paiement_en_cours']).limit(limit).get();
      return s.docs.map((x) => x.data());
    },
    async incrementPromoUse(code) { try { await d().doc(`promo_codes/${code}`).update({ usedCount: FieldValue.increment(1) }); } catch (_) {} },
    async logEvent(e) { await d().collection('payment_events').add(e); },
    async isUnsubscribed(email) { const s = await d().doc(`unsubscribed/${emailHash(email)}`).get(); return s.exists; },
    async unsubscribe(email) {
      const e = String(email).trim().toLowerCase();
      await d().doc(`unsubscribed/${emailHash(e)}`).set({ at: Date.now() });
      try { await d().doc(`newsletter/${encodeURIComponent(e)}`).delete(); } catch (_) {}
    },
  };
}
