/**
 * Implémentation PawaPay (Merchant API v2).
 * Endpoints utilisés (doc officielle docs.pawapay.io, API v2) :
 *   POST /v2/paymentpage            → crée une session de Payment Page (redirectUrl valable 15 min)
 *   GET  /v2/deposits/{depositId}   → statut du dépôt (FOUND/NOT_FOUND + data.status)
 *   GET  /v2/public-key/http        → clés publiques pour vérifier les callbacks signés
 */
import { PaymentProvider } from './PaymentProvider.mjs';
import { verifyHttpSignature } from './httpSignature.mjs';
import { formatProviderAmount } from '../pricing.mjs';

const KEY_CACHE_MS = 60 * 60 * 1000;

export class PawaPayProvider extends PaymentProvider {
  constructor({ token, baseUrl, verifySignature = true, fetchImpl = fetch, timeoutMs = 15000 }) {
    super();
    if (!token) throw new Error('PAWAPAY_API_TOKEN manquant');
    this.token = token;
    this.baseUrl = baseUrl;
    this.verifySignature = verifySignature;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this._keys = null;
    this._keysAt = 0;
  }

  get name() { return 'pawapay'; }

  async _request(method, path, body) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(this.baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      let json = null;
      try { json = await res.json(); } catch (_) { json = null; }
      return { httpStatus: res.status, json };
    } finally { clearTimeout(t); }
  }

  async initiatePayment({ paymentId, amount, currency, country, returnUrl, reason, orderId }) {
    const body = {
      depositId: paymentId,
      returnUrl,
      // Montant fixé : la cliente ne peut pas le modifier. Le pays est obligatoire dans ce cas.
      amountDetails: { amount: formatProviderAmount(amount), currency },
      country,
      language: 'FR',
      reason: String(reason || 'Commande SMB').slice(0, 50),
      metadata: [{ orderId }],
    };
    const { httpStatus, json } = await this._request('POST', '/v2/paymentpage', body);
    // PawaPay répond 200 ou 201 (Created) quand la session est créée
    const ok2xx = httpStatus >= 200 && httpStatus < 300;
    if (ok2xx && json && json.redirectUrl) return { ok: true, redirectUrl: json.redirectUrl };
    if (ok2xx && json && json.status === 'REJECTED') {
      const fr = json.failureReason || {};
      return { ok: false, failureCode: fr.failureCode || 'REJECTED', failureMessage: fr.failureMessage };
    }
    if (ok2xx) {
      // Réponse positive mais sans URL : on ne devine pas, l'erreur est journalisée avec les clés reçues
      return { ok: false, failureCode: 'NO_REDIRECT_URL', failureMessage: `Réponse sans redirectUrl (clés : ${json ? Object.keys(json).join(',') : 'aucune'})` };
    }
    if (httpStatus >= 500 || httpStatus === 0) {
      const err = new Error(`PawaPay indisponible (HTTP ${httpStatus})`);
      err.retryable = true;
      throw err;
    }
    const fr = (json && json.failureReason) || {};
    return { ok: false, failureCode: fr.failureCode || `HTTP_${httpStatus}`, failureMessage: fr.failureMessage };
  }

  async getStatus(paymentId) {
    const { httpStatus, json } = await this._request('GET', `/v2/deposits/${encodeURIComponent(paymentId)}`);
    if (httpStatus < 200 || httpStatus >= 300 || !json) {
      const err = new Error(`Vérification PawaPay impossible (HTTP ${httpStatus})`);
      err.retryable = true;
      throw err;
    }
    if (json.status === 'NOT_FOUND') return { status: 'NOT_FOUND' };
    if (json.status !== 'FOUND' || !json.data) return { status: 'UNKNOWN', raw: { status: json.status } };
    const d = json.data;
    const map = { COMPLETED: 'COMPLETED', FAILED: 'FAILED', ACCEPTED: 'PROCESSING', PROCESSING: 'PROCESSING', IN_RECONCILIATION: 'PROCESSING' };
    return {
      status: map[d.status] || 'UNKNOWN',
      providerStatus: d.status,
      amount: d.amount !== undefined ? Number(d.amount) : undefined,
      currency: d.currency,
      country: d.country,
      failureCode: d.failureReason && d.failureReason.failureCode,
      providerTransactionId: d.providerTransactionId,
      operator: d.payer && d.payer.accountDetails && d.payer.accountDetails.provider,
    };
  }

  async _publicKey(keyid) {
    if (!this._keys || Date.now() - this._keysAt > KEY_CACHE_MS) {
      const { httpStatus, json } = await this._request('GET', '/v2/public-key/http');
      if (httpStatus < 200 || httpStatus >= 300 || !Array.isArray(json)) return null;
      this._keys = json; this._keysAt = Date.now();
    }
    const k = this._keys.find(k => k.id === keyid);
    return k ? k.key : null;
  }

  async verifyWebhook(req) {
    if (this.verifySignature) {
      const r = await verifyHttpSignature(req, keyid => this._publicKey(keyid));
      if (!r.valid) return r;
    }
    let body;
    try { body = JSON.parse(req.rawBody); } catch (_) { return { valid: false, reason: 'BAD_JSON' }; }
    if (!body || typeof body.depositId !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.depositId)) {
      return { valid: false, reason: 'NO_DEPOSIT_ID' };
    }
    return { valid: true, paymentId: body.depositId };
  }
}
