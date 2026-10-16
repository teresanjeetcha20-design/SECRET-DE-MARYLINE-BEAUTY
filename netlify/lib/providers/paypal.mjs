/**
 * Implémentation PayPal (Orders API v2) — paiement par compte PayPal ou carte bancaire.
 * Endpoints utilisés :
 *   POST /v1/oauth2/token                    → jeton d'accès (client_credentials)
 *   POST /v2/checkout/orders                 → crée la commande PayPal (montant fixé en EUR) + lien d'approbation
 *   GET  /v2/checkout/orders/{id}            → statut (source de vérité)
 *   POST /v2/checkout/orders/{id}/capture    → encaisse après approbation de la cliente
 *
 * Les prix de la boutique étant en euros, le montant est payé en euros (aucune conversion).
 * L'encaissement (capture) n'a lieu qu'après approbation explicite de la cliente sur PayPal ; il est déclenché
 * par le serveur (retour de la cliente ou re-vérification planifiée), jamais par le navigateur.
 */
import { PaymentProvider } from './PaymentProvider.mjs';

export class PayPalProvider extends PaymentProvider {
  constructor({ clientId, clientSecret, baseUrl, brandName = 'Secret de Maryline Beauty', fetchImpl = fetch, timeoutMs = 15000 }) {
    super();
    if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET manquants');
    this.clientId = clientId; this.clientSecret = clientSecret;
    this.baseUrl = baseUrl; this.brandName = brandName;
    this.fetch = fetchImpl; this.timeoutMs = timeoutMs;
    this._token = null; this._tokenExp = 0;
  }
  get name() { return 'paypal'; }
  /** Une commande PayPal non approuvée reste ouverte longtemps ; on la considère expirée après 60 min. */
  get sessionTtlMs() { return 60 * 60 * 1000; }

  async _raw(method, path, { body, headers = {}, form } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(this.baseUrl + path, {
        method, headers, signal: ctrl.signal,
        body: form ? form : body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await res.json(); } catch (_) { json = null; }
      return { httpStatus: res.status, json };
    } finally { clearTimeout(t); }
  }
  async _accessToken() {
    if (this._token && Date.now() < this._tokenExp) return this._token;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const { httpStatus, json } = await this._raw('POST', '/v1/oauth2/token', {
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      form: 'grant_type=client_credentials',
    });
    if (httpStatus !== 200 || !json || !json.access_token) {
      const e = new Error(`Authentification PayPal impossible (HTTP ${httpStatus})`); e.code = 'PAYPAL_AUTH'; throw e;
    }
    this._token = json.access_token;
    this._tokenExp = Date.now() + Math.max(60, (json.expires_in || 3000) - 120) * 1000;
    return this._token;
  }
  async _api(method, path, body, requestId) {
    const token = await this._accessToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', Prefer: 'return=representation' };
    if (requestId) headers['PayPal-Request-Id'] = requestId;   // idempotence côté PayPal
    return this._raw(method, path, { body, headers });
  }

  async initiatePayment({ paymentId, amount, currency, returnUrl, reason, orderId, embedded }) {
    const body = {
      intent: 'CAPTURE',
      purchase_units: [{
        reference_id: orderId, custom_id: paymentId, invoice_id: paymentId,
        description: String(reason || 'Commande Secret de Maryline Beauty').slice(0, 120),
        amount: { currency_code: currency, value: Number(amount).toFixed(2) },
      }],
    };
    if (embedded) {
      // Boutons PayPal intégrés au site : la fenêtre PayPal (compte ou carte) s'ouvre par-dessus la page
      body.application_context = { brand_name: this.brandName, locale: 'fr-FR', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' };
    } else {
      body.payment_source = { paypal: { experience_context: {
        brand_name: this.brandName, locale: 'fr-FR', landing_page: 'NO_PREFERENCE',
        shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW',
        return_url: returnUrl, cancel_url: returnUrl + '&cancel=true',
      } } };
    }
    const { httpStatus, json } = await this._api('POST', '/v2/checkout/orders', body, paymentId);
    if (httpStatus >= 200 && httpStatus < 300 && json && json.id) {
      const link = (json.links || []).find(l => l.rel === 'payer-action' || l.rel === 'approve');
      if (link || embedded) return { ok: true, redirectUrl: link ? link.href : '', providerRef: json.id };
      return { ok: false, failureCode: 'NO_REDIRECT_URL', failureMessage: 'Lien d\'approbation PayPal absent' };
    }
    if (httpStatus >= 500) { const e = new Error(`PayPal indisponible (HTTP ${httpStatus})`); throw e; }
    const issue = json && json.details && json.details[0] && json.details[0].issue;
    return { ok: false, failureCode: issue || (json && json.name) || `HTTP_${httpStatus}`, failureMessage: json && json.message };
  }

  _fromCapture(c) {
    if (!c) return { status: 'UNKNOWN' };
    const amount = c.amount ? Number(c.amount.value) : undefined, currency = c.amount ? c.amount.currency_code : undefined;
    if (c.status === 'COMPLETED') return { status: 'COMPLETED', amount, currency, providerTransactionId: c.id, operator: 'PAYPAL' };
    if (c.status === 'PENDING') return { status: 'PROCESSING' };
    if (c.status === 'DECLINED' || c.status === 'FAILED') return { status: 'FAILED', failureCode: 'DECLINED' };
    return { status: 'UNKNOWN' };   // remboursée, etc. → contrôle humain
  }
  static _capture(order) {
    const pu = order && order.purchase_units && order.purchase_units[0];
    return pu && pu.payments && pu.payments.captures && pu.payments.captures[0];
  }

  async getStatus(paymentId, payment) {
    const ref = payment && payment.providerRef;
    if (!ref) return { status: 'NOT_FOUND' };
    let { httpStatus, json } = await this._api('GET', `/v2/checkout/orders/${encodeURIComponent(ref)}`);
    if (httpStatus === 404) return { status: 'NOT_FOUND' };
    if (httpStatus !== 200 || !json) { const e = new Error(`Vérification PayPal impossible (HTTP ${httpStatus})`); throw e; }
    const pu = json.purchase_units && json.purchase_units[0];
    if (!pu || pu.custom_id !== paymentId) return { status: 'UNKNOWN' };   // commande PayPal qui ne correspond pas
    if (json.status === 'COMPLETED') return this._fromCapture(PayPalProvider._capture(json));
    if (json.status === 'APPROVED') {
      // La cliente a validé sur PayPal : le serveur encaisse (idempotent grâce à PayPal-Request-Id)
      const cap = await this._api('POST', `/v2/checkout/orders/${encodeURIComponent(ref)}/capture`, {}, `${paymentId}-capture`);
      if (cap.httpStatus >= 200 && cap.httpStatus < 300 && cap.json) return this._fromCapture(PayPalProvider._capture(cap.json));
      const issue = cap.json && cap.json.details && cap.json.details[0] && cap.json.details[0].issue;
      if (issue === 'ORDER_ALREADY_CAPTURED') {
        const again = await this._api('GET', `/v2/checkout/orders/${encodeURIComponent(ref)}`);
        return this._fromCapture(PayPalProvider._capture(again.json));
      }
      if (issue === 'INSTRUMENT_DECLINED' || issue === 'PAYER_CANNOT_PAY' || issue === 'TRANSACTION_REFUSED') return { status: 'FAILED', failureCode: 'DECLINED' };
      const e = new Error(`Encaissement PayPal impossible (${issue || 'HTTP ' + cap.httpStatus})`); throw e;
    }
    if (json.status === 'VOIDED') return { status: 'FAILED', failureCode: 'VOIDED' };
    // CREATED / PAYER_ACTION_REQUIRED / SAVED : la cliente n'a pas (encore) validé
    return { status: 'NOT_FOUND' };
  }

  async verifyWebhook() { return { valid: false, reason: 'NOT_USED' }; }   // statut obtenu par re-vérification
}
