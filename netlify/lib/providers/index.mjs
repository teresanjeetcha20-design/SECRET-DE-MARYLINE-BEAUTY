/** Registre des prestataires de paiement en ligne. */
import { PawaPayProvider } from './pawapay.mjs';
import { PayPalProvider } from './paypal.mjs';
import { StripeProvider } from './stripe.mjs';
import { SHOP_NAME } from '../config.mjs';

export function createProviders(config, deps = {}) {
  const providers = {};
  if (config.stripe && config.stripe.secretKey) {
    providers.stripe = new StripeProvider({ secretKey: config.stripe.secretKey, webhookSecret: config.stripe.webhookSecret, brandName: SHOP_NAME, fetchImpl: deps.stripeFetchImpl || deps.fetchImpl });
  }
  if (config.paypal && config.paypal.clientId && config.paypal.clientSecret) {
    providers.paypal = new PayPalProvider({ clientId: config.paypal.clientId, clientSecret: config.paypal.clientSecret, baseUrl: config.paypal.baseUrl, brandName: SHOP_NAME, fetchImpl: deps.paypalFetchImpl || deps.fetchImpl });
  }
  if (config.pawapay && config.pawapay.token) {
    providers.pawapay = new PawaPayProvider({ token: config.pawapay.token, baseUrl: config.pawapay.baseUrl, verifySignature: config.pawapay.verifySignature, fetchImpl: deps.fetchImpl });
  }
  return providers;
}
