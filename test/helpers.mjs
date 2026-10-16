import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { createMemoryRepo } from '../netlify/lib/repository/memoryRepo.mjs';
import { createPaymentService } from '../netlify/lib/paymentService.mjs';
import { PawaPayProvider } from '../netlify/lib/providers/pawapay.mjs';
import { getConfig } from '../netlify/lib/config.mjs';

// Catalogue de test au format SMB (prix en euros, formats par contenance)
export const BASE_CATALOG = [
  { id: 'nag', name: 'N-Acetyl Glucosamine', formats: [{ size: '50g', price: 20 }, { size: '100g', price: 40 }, { size: '250g', price: null }] },
  { id: 'ectoine', name: 'Ectoïne', formats: [{ size: '10g', price: 25 }] },
];
export const DELIVERY = { zones: [{ name: 'Paris', fee: 0 }], other: 6.9,
  countries: [{ name: 'Cameroun', fee: 25 }, { name: 'Belgique', fee: 9.5 }, { name: 'Ghana', fee: 30 }, { name: 'Kenya', fee: null }], otherCountry: null };

export const { privateKey: TEST_PRIV, publicKey: TEST_PUB } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
export const TEST_KEY_ID = 'HTTP_EC_P256_KEY:1';

/** Faux serveur PawaPay (endpoints v2 utilisés par l'intégration). */
export function createFakePawaPay() {
  const state = { deposits: new Map(), sessions: [], calls: [], rejectNext: null, downNext: false };
  async function fetchImpl(url, opts = {}) {
    const u = new URL(url);
    state.calls.push(`${opts.method || 'GET'} ${u.pathname}`);
    const res = (status, body) => ({ status, ok: status < 300, json: async () => body });
    if (state.downNext) { state.downNext = false; throw new Error('ECONNRESET'); }
    if (u.pathname === '/v2/paymentpage' && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      if (state.rejectNext) { const code = state.rejectNext; state.rejectNext = null; return res(200, { depositId: body.depositId, status: 'REJECTED', failureReason: { failureCode: code } }); }
      if (state.onSession) state.onSession(body);
      state.sessions.push(body);
      return res(201, { redirectUrl: `https://sandbox.paywith.pawapay.io/?token=x&depositId=${body.depositId}` });
    }
    if (u.pathname.startsWith('/v2/deposits/')) {
      const id = decodeURIComponent(u.pathname.split('/').pop());
      const d = state.deposits.get(id);
      return res(200, d ? { status: 'FOUND', data: d } : { status: 'NOT_FOUND' });
    }
    if (u.pathname === '/v2/public-key/http') {
      return res(200, [{ id: TEST_KEY_ID, key: TEST_PUB.export({ type: 'spki', format: 'pem' }) }]);
    }
    return res(404, {});
  }
  /** Simule le résultat d'un dépôt côté PawaPay */
  function setDeposit(depositId, status, extra = {}) {
    state.deposits.set(depositId, { depositId, status, amount: '0', currency: 'XAF', country: 'CMR',
      payer: { type: 'MMO', accountDetails: { phoneNumber: '237690000000', provider: 'MTN_MOMO_CMR' } },
      created: new Date().toISOString(), ...extra });
  }
  return { state, fetchImpl, setDeposit };
}

/** Construit une requête de callback signée comme le fait PawaPay (RFC 9421, ECDSA P-256, DER). */
export function signedCallback(body, { url = 'https://shop.test/api/payments/webhook/pawapay', privateKey = TEST_PRIV, tamper } = {}) {
  const rawBody = JSON.stringify(body);
  const digest = `sha-512=:${createHash('sha512').update(rawBody).digest('base64')}:`;
  const created = Math.floor(Date.now() / 1000);
  const params = `("@method" "@authority" "@path" "signature-date" "content-digest" "content-type");alg="ecdsa-p256-sha256";keyid="${TEST_KEY_ID}";created=${created};expires=${created + 60}`;
  const u = new URL(url);
  const headers = { host: u.host, 'content-type': 'application/json; charset=UTF-8', 'content-digest': digest, 'signature-date': new Date().toISOString() };
  const base = [
    `"@method": POST`, `"@authority": ${u.host}`, `"@path": ${u.pathname}`,
    `"signature-date": ${headers['signature-date']}`, `"content-digest": ${digest}`, `"content-type": ${headers['content-type']}`,
    `"@signature-params": ${params}`,
  ].join('\n');
  const sig = sign('sha256', Buffer.from(base), { key: privateKey, dsaEncoding: 'der' }).toString('base64');
  headers['signature-input'] = `sig-pp=${params}`;
  headers.signature = `sig-pp=:${sig}:`;
  return { method: 'POST', url, headers, rawBody: tamper ? tamper(rawBody) : rawBody };
}

export function setup({ clock = { t: Date.parse('2026-10-12T10:00:00Z') }, verifySignature = true, fx = null, env = {}, deps = {} } = {}) {
  const fake = createFakePawaPay();
  const repo = createMemoryRepo({ pricing: { deliveryConfig: DELIVERY, fx, promoCodes: { NOEL20: { code: 'NOEL20', pct: 20, active: true, usedCount: 0 } } } });
  const config = getConfig({ PAWAPAY_API_TOKEN: 'test-token', PAWAPAY_ENV: 'sandbox', SITE_URL: 'https://shop.test', PAYMENT_COUNTRIES: 'ALL', FIREBASE_CLIENT_EMAIL: 'test@x', FIREBASE_PRIVATE_KEY: 'x', ...env });
  const providers = { pawapay: new PawaPayProvider({ token: 'test-token', baseUrl: 'https://api.sandbox.pawapay.io', verifySignature, fetchImpl: fake.fetchImpl }), ...(deps.providers || {}) };
  const notified = [], created = [], reviews = [], events = [];
  const service = createPaymentService({
    repo, providers, config, baseCatalog: BASE_CATALOG, now: () => clock.t,
    notifyPaid: async (o) => { notified.push(o.id); },
    notifyNew: async (o) => { created.push(o.id); },
    notifyReview: async (o, p) => { reviews.push(p.reviewReason); },
    logEvent: async (type, d) => { events.push({ type, ...d }); },
    verifyIdToken: deps.verifyIdToken || null,
  });
  return { service, repo, fake, clock, notified, created, reviews, events, config };
}

export const VALID_INPUT = (extra = {}) => ({
  idempotencyKey: 'test-key-' + Math.random().toString(36).slice(2, 12),
  provider: 'pawapay',
  country: 'CMR',
  lines: [{ productId: 'nag', qty: '100g', quantity: 2 }],
  delivery: { city: 'Douala', country: 'Cameroun' },
  customer: { nom: 'Awa Test', tel: '6 95 12 34 56', email: 'awa@test.cm', adresse: 'Bonapriso' },
  ...extra,
});
