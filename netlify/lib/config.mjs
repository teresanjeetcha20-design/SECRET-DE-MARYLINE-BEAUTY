/**
 * Configuration centrale (lue depuis les variables d'environnement Netlify).
 * Aucune valeur secrète n'est écrite dans le code.
 */
export const SHOP_NAME = 'Secret de Maryline Beauty';

// Pays couverts par PawaPay (Mobile Money). currency = devise imposée par les opérateurs ;
// decimals = décimales acceptées par TOUS les opérateurs du pays (montant arrondi au supérieur).
export const COUNTRIES = {
  BEN: { code: 'BEN', label: 'Bénin',             currency: 'XOF', dialCode: '229', decimals: 0 },
  BFA: { code: 'BFA', label: 'Burkina Faso',      currency: 'XOF', dialCode: '226', decimals: 0 },
  CMR: { code: 'CMR', label: 'Cameroun',          currency: 'XAF', dialCode: '237', decimals: 0, nationalLength: 9 },
  CIV: { code: 'CIV', label: 'Côte d\'Ivoire',    currency: 'XOF', dialCode: '225', decimals: 0 },
  COD: { code: 'COD', label: 'RD Congo',          currency: 'USD', dialCode: '243', decimals: 2 },
  COG: { code: 'COG', label: 'Congo-Brazzaville', currency: 'XAF', dialCode: '242', decimals: 0 },
  ETH: { code: 'ETH', label: 'Éthiopie',          currency: 'ETB', dialCode: '251', decimals: 2 },
  GAB: { code: 'GAB', label: 'Gabon',             currency: 'XAF', dialCode: '241', decimals: 0 },
  GHA: { code: 'GHA', label: 'Ghana',             currency: 'GHS', dialCode: '233', decimals: 2 },
  KEN: { code: 'KEN', label: 'Kenya',             currency: 'KES', dialCode: '254', decimals: 0 },
  LSO: { code: 'LSO', label: 'Lesotho',           currency: 'LSL', dialCode: '266', decimals: 2 },
  MWI: { code: 'MWI', label: 'Malawi',            currency: 'MWK', dialCode: '265', decimals: 2 },
  MOZ: { code: 'MOZ', label: 'Mozambique',        currency: 'MZN', dialCode: '258', decimals: 0 },
  NGA: { code: 'NGA', label: 'Nigeria',           currency: 'NGN', dialCode: '234', decimals: 0 },
  RWA: { code: 'RWA', label: 'Rwanda',            currency: 'RWF', dialCode: '250', decimals: 0 },
  SEN: { code: 'SEN', label: 'Sénégal',           currency: 'XOF', dialCode: '221', decimals: 0 },
  SLE: { code: 'SLE', label: 'Sierra Leone',      currency: 'SLE', dialCode: '232', decimals: 2 },
  TZA: { code: 'TZA', label: 'Tanzanie',          currency: 'TZS', dialCode: '255', decimals: 0 },
  UGA: { code: 'UGA', label: 'Ouganda',           currency: 'UGX', dialCode: '256', decimals: 0 },
  ZMB: { code: 'ZMB', label: 'Zambie',            currency: 'ZMW', dialCode: '260', decimals: 2 },
  ZWE: { code: 'ZWE', label: 'Zimbabwe',          currency: 'USD', dialCode: '263', decimals: 2 },
};

// Une session de Payment Page PawaPay est valable 15 minutes (doc PawaPay).
export const PAYMENT_SESSION_TTL_MS = 15 * 60 * 1000;
// Marge avant de déclarer « expiré » un paiement introuvable chez le prestataire
export const EXPIRY_GRACE_MS = 2 * 60 * 1000;

export function getConfig(env = process.env) {
  const raw = String(env.PAYMENT_COUNTRIES || 'ALL').trim().toUpperCase();
  const enabledCountries = (raw === 'ALL' ? Object.keys(COUNTRIES) : raw.split(',').map((s) => s.trim())).filter((c) => COUNTRIES[c]);
  const pawapayEnv = env.PAWAPAY_ENV === 'production' ? 'production' : 'sandbox';
  return {
    pawapay: {
      token: env.PAWAPAY_API_TOKEN || '',
      env: pawapayEnv,
      baseUrl: (env.PAWAPAY_BASE_URL || (pawapayEnv === 'production' ? 'https://api.pawapay.io' : 'https://api.sandbox.pawapay.io')).replace(/\/$/, ''),
      verifySignature: env.PAWAPAY_VERIFY_SIGNATURE !== 'false',
    },
    paypal: {
      clientId: env.PAYPAL_CLIENT_ID || '',
      clientSecret: env.PAYPAL_CLIENT_SECRET || '',
      env: env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
      baseUrl: env.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
    },
    stripe: {
      secretKey: /^(sk|rk)_(test|live)_/.test(env.STRIPE_SECRET_KEY || '') ? env.STRIPE_SECRET_KEY : '',
      webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
      live: /^(sk|rk)_live_/.test(env.STRIPE_SECRET_KEY || ''),
    },
    transfer: { enabled: env.BANK_TRANSFER !== 'false' },
    // Sans identifiants Firebase côté serveur, aucune commande ne peut être enregistrée : rien n'est proposé
    firebaseReady: !!((env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) || env.FIREBASE_SERVICE_ACCOUNT),
    siteUrl: (env.SITE_URL || env.URL || '').replace(/\/$/, ''),
    merchantEmail: env.MERCHANT_NOTIFY_EMAIL || '',
    mainCountry: env.MAIN_COUNTRY || 'France',
    countries: enabledCountries.map((c) => COUNTRIES[c]),
  };
}
