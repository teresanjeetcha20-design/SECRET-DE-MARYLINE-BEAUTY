/**
 * Implémentation Stripe Checkout — carte bancaire, Apple Pay, Google Pay
 * (et tout autre moyen activé dans le tableau de bord Stripe : PayPal, Link, Bancontact…).
 * Endpoints utilisés :
 *   POST /v1/checkout/sessions                          → crée la page de paiement (montant fixé)
 *   GET  /v1/checkout/sessions/{id}?expand[]=payment_intent → statut (source de vérité)
 * Webhook : signature « Stripe-Signature » (HMAC SHA-256) vérifiée, puis statut RE-VÉRIFIÉ via l'API.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PaymentProvider } from './PaymentProvider.mjs';

export class StripeProvider extends PaymentProvider {
  constructor({ secretKey, webhookSecret = '', brandName = 'Secret de Maryline Beauty', fetchImpl = fetch, timeoutMs = 15000, now = () => Date.now() }) {
    super();
    if (!secretKey) throw new Error('STRIPE_SECRET_KEY manquant');
    this.secretKey = secretKey; this.webhookSecret = webhookSecret; this.brandName = brandName;
    this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.now = now;
  }
  get name() { return 'stripe'; }
  /** Session Stripe valable 31 min : au-delà, la commande passe « expirée » (nouvelle tentative possible). */
  get sessionTtlMs() { return 33 * 60 * 1000; }

  static form(obj, prefix = '', out = []) {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined || v === null || v === '') continue;
      const key = prefix ? `${prefix}[${k}]` : k;
      if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? StripeProvider.form(item, `${key}[${i}]`, out) : out.push([`${key}[${i}]`, String(item)])));
      else if (typeof v === 'object') StripeProvider.form(v, key, out);
      else out.push([key, String(v)]);
    }
    return out;
  }

  async _api(method, path, params, idempotencyKey) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers = { Authorization: `Bearer ${this.secretKey}`, 'Stripe-Version': '2024-06-20' };
      if (params) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      const res = await this.fetch('https://api.stripe.com/v1/' + path, {
        method, headers, signal: ctrl.signal,
        body: params ? new URLSearchParams(StripeProvider.form(params)).toString() : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch (_) { json = null; }
      return { httpStatus: res.status, json };
    } finally { clearTimeout(t); }
  }

  async initiatePayment({ paymentId, amount, currency, returnUrl, reason, orderId, customerEmail, description }) {
    const params = {
      mode: 'payment',
      locale: 'fr',
      client_reference_id: paymentId,
      customer_email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customerEmail || '') ? customerEmail : undefined,
      metadata: { paymentId, orderId },
      payment_intent_data: { metadata: { paymentId, orderId }, description: String(reason || '').slice(0, 300) },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: String(currency || 'EUR').toLowerCase(),
          unit_amount: Math.round(Number(amount) * 100),
          product_data: { name: String(reason || `Commande ${this.brandName}`).slice(0, 120), description: description ? String(description).slice(0, 500) : undefined },
        },
      }],
      success_url: returnUrl,
      cancel_url: returnUrl + '&cancel=true',
      expires_at: Math.floor(this.now() / 1000) + 31 * 60,
    };
    const { httpStatus, json } = await this._api('POST', 'checkout/sessions', params, paymentId);
    if (httpStatus >= 200 && httpStatus < 300 && json && json.url) return { ok: true, redirectUrl: json.url, providerRef: json.id };
    if (httpStatus >= 500 || httpStatus === 429) throw new Error(`Stripe indisponible (HTTP ${httpStatus})`);
    const err = (json && json.error) || {};
    return { ok: false, failureCode: err.code || err.type || `HTTP_${httpStatus}`, failureMessage: err.message };
  }

  async getStatus(paymentId, payment) {
    const ref = payment && payment.providerRef;
    if (!ref) return { status: 'NOT_FOUND' };
    const { httpStatus, json } = await this._api('GET', `checkout/sessions/${encodeURIComponent(ref)}?expand[]=payment_intent`);
    if (httpStatus === 404) return { status: 'NOT_FOUND' };
    if (httpStatus !== 200 || !json) throw new Error(`Vérification Stripe impossible (HTTP ${httpStatus})`);
    if (!json.metadata || json.metadata.paymentId !== paymentId) return { status: 'UNKNOWN' };   // session qui ne correspond pas
    const pi = json.payment_intent && typeof json.payment_intent === 'object' ? json.payment_intent : null;
    if (json.payment_status === 'paid') {
      const method = pi && pi.payment_method_types && pi.payment_method_types[0];
      return {
        status: 'COMPLETED',
        amount: (json.amount_total || 0) / 100,
        currency: String(json.currency || '').toUpperCase(),
        providerTransactionId: (pi && pi.id) || (typeof json.payment_intent === 'string' ? json.payment_intent : json.id),
        operator: method ? method.toUpperCase() : 'STRIPE',
      };
    }
    if (json.status === 'complete') {
      // Moyen de paiement différé (ex. prélèvement) : en cours, ou refusé
      if (pi && (pi.status === 'canceled' || pi.status === 'requires_payment_method')) return { status: 'FAILED', failureCode: 'DECLINED' };
      return { status: 'PROCESSING' };
    }
    // open (la cliente n'a pas encore payé) ou expired (abandon) : rien n'a été débité
    return { status: 'NOT_FOUND' };
  }

  async verifyWebhook({ headers, rawBody }) {
    if (!this.webhookSecret) return { valid: false, reason: 'NO_WEBHOOK_SECRET' };
    const header = headers['stripe-signature'] || headers['Stripe-Signature'] || '';
    const parts = {};
    String(header).split(',').forEach((p) => {
      const i = p.indexOf('=');
      if (i < 0) return;
      const k = p.slice(0, i).trim();
      (parts[k] = parts[k] || []).push(p.slice(i + 1).trim());
    });
    const t = parts.t && parts.t[0];
    if (!t || !parts.v1) return { valid: false, reason: 'NO_SIGNATURE' };
    if (Math.abs(Math.floor(this.now() / 1000) - Number(t)) > 300) return { valid: false, reason: 'TIMESTAMP' };
    const expected = createHmac('sha256', this.webhookSecret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
    const ok = parts.v1.some((s) => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
    if (!ok) return { valid: false, reason: 'BAD_SIGNATURE' };
    let evt;
    try { evt = JSON.parse(rawBody); } catch (_) { return { valid: false, reason: 'BAD_JSON' }; }
    const obj = evt && evt.data && evt.data.object;
    const paymentId = (obj && obj.metadata && obj.metadata.paymentId) || '';
    return { valid: true, paymentId, type: evt.type };
  }
}
