/**
 * Cœur du paiement en ligne, indépendant du prestataire et de la base de données.
 *
 * Règles de sécurité appliquées ici :
 *  - le montant est TOUJOURS recalculé côté serveur (pricing.mjs) ;
 *  - l'identifiant de paiement (UUID) est enregistré AVANT l'appel au prestataire ;
 *  - une commande ne passe « payée » qu'après interrogation du prestataire (getStatus),
 *    jamais sur la base du retour de la cliente ni du seul contenu d'un webhook ;
 *  - montant et devise confirmés doivent être identiques à ceux de la commande ;
 *  - toutes les transitions passent par une transaction : un webhook reçu deux fois ne change rien.
 */
import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { computeOrderTotal, PricingError, formatEUR, formatMoney, convertFromEUR, CFA_CURRENCIES } from './pricing.mjs';
import { normalizePhone, maskPhone } from './phone.mjs';
import { PAYMENT_STATUS as S, OPEN_STATUSES, RETRYABLE_STATUSES, customerFailureMessage } from './statuses.mjs';
import { PAYMENT_SESSION_TTL_MS, EXPIRY_GRACE_MS, SHOP_NAME } from './config.mjs';

const MAX_ATTEMPTS = 5;
const STATUS_CHECK_MIN_INTERVAL_MS = 15000;
const sha256 = s => createHash('sha256').update(String(s)).digest('hex');

export function newOrderId(t = Date.now()) {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return 'SMB' + t.toString(36).toUpperCase() + [...randomBytes(5)].map(b => A[b % 32]).join('');
}
export const ORDER_ID_RE = /^SMB[A-Z0-9]{8,30}$/;
function str(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }

export function createPaymentService({ repo, providers, config, baseCatalog, notifyPaid = async () => {}, notifyNew = async () => {}, notifyReview = async () => {}, logEvent = async () => {}, verifyIdToken = null, now = () => Date.now() }) {

  function provider(name) { return providers[name]; }
  const PROVIDER_LABEL = { stripe: 'Carte / Apple Pay / Google Pay (Stripe)', paypal: 'PayPal', pawapay: 'Mobile Money (PawaPay)', virement: 'Virement bancaire' };
  function returnUrl(orderId) { return `${config.siteUrl}/?pay=return&order=${encodeURIComponent(orderId)}`; }

  // ── Lancement d'une tentative auprès du prestataire ──────────────────────────
  async function startAttempt(order, payment, extra = {}) {
    const prov = provider(payment.provider);
    if (!prov) return { ok: false, code: 'DISABLED', message: 'Ce moyen de paiement n\'est plus disponible.', orderId: order.id };
    const embedded = !!extra._embedded; delete extra._embedded;
    let r;
    try {
      r = await prov.initiatePayment({
        paymentId: payment.id, amount: payment.amount, currency: payment.currency, country: payment.country,
        returnUrl: returnUrl(order.id), reason: `Commande ${order.id} — ${SHOP_NAME}`, orderId: order.id, embedded,
        customerEmail: order.email, description: order.items,
      });
    } catch (e) {
      await logEvent('INITIATE_ERROR', { orderId: order.id, paymentId: payment.id, error: e.message });
      // Statut inconnu : le paiement reste en attente ; la re-vérification planifiée le clôturera.
      return { ok: false, code: 'PROVIDER_UNAVAILABLE', message: 'Le service de paiement ne répond pas. Réessayez dans un instant.', orderId: order.id, canRetry: true, ...extra };
    }
    if (!r.ok) {
      await repo.transition(payment.id, (p, o) => (p.status !== S.PENDING ? null : {
        paymentPatch: { status: S.FAILED, failureCode: r.failureCode, updatedAtMs: now() },
        orderPatch: o.paymentId === p.id ? { paymentStatus: S.FAILED, paymentFailureCode: r.failureCode } : {},
      }));
      await logEvent('INITIATE_REJECTED', { orderId: order.id, paymentId: payment.id, failureCode: r.failureCode, failureMessage: String(r.failureMessage || '').slice(0, 300) });
      return { ok: false, code: r.failureCode, message: customerFailureMessage(r.failureCode), orderId: order.id, canRetry: true, ...extra };
    }
    await repo.transition(payment.id, (p, o) => (p.status !== S.PENDING ? null : {
      paymentPatch: { status: S.IN_PROGRESS, redirectUrl: r.redirectUrl, providerRef: r.providerRef || '', sessionStartedAtMs: now(), updatedAtMs: now() },
      orderPatch: o.paymentId === p.id ? { paymentStatus: S.IN_PROGRESS } : {},
    }));
    await logEvent('PAYMENT_PAGE_CREATED', { orderId: order.id, paymentId: payment.id });
    return { ok: true, orderId: order.id, redirectUrl: r.redirectUrl, ...(r.providerRef && prov.name === 'paypal' ? { paypalOrderId: r.providerRef } : {}), ...extra };
  }

  const ttlOf = p => (provider(p.provider) || {}).sessionTtlMs || PAYMENT_SESSION_TTL_MS;
  function sessionStillValid(p) {
    return OPEN_STATUSES.has(p.status) && p.redirectUrl && p.sessionStartedAtMs && now() - p.sessionStartedAtMs < ttlOf(p) - 60000;
  }

  async function newAttempt(order, extra = {}) {
    const embeddedFlag = extra._embedded;
    if ((order.paymentAttempts || 1) >= MAX_ATTEMPTS) {
      return { ok: false, code: 'TOO_MANY_ATTEMPTS', message: 'Trop de tentatives de paiement. Contactez-nous pour finaliser votre commande.', orderId: order.id };
    }
    // Même montant et même devise que la 1re tentative (taux figé à la création de la commande)
    const payment = {
      id: randomUUID(), orderId: order.id, provider: order.paymentProvider,
      amount: order.paymentAmount ?? order.amount, currency: order.paymentCurrency ?? order.currency,
      country: order.country, status: S.PENDING, createdAtMs: now(), updatedAtMs: now(),
    };
    // Identifiant enregistré AVANT l'appel au prestataire
    await repo.addPaymentAttempt(order.id, payment, { paymentId: payment.id, paymentStatus: S.PENDING, paymentAttempts: (order.paymentAttempts || 1) + 1 });
    await logEvent('PAYMENT_RETRY', { orderId: order.id, paymentId: payment.id });
    return startAttempt({ ...order, paymentId: payment.id }, payment, { ...extra, ...(embeddedFlag ? { _embedded: true } : {}) });
  }

  // ── Création d'une commande (paiement en ligne ou virement) ──────────────────
  async function createPayment(input) {
    const kind = String(input.provider || '');
    const isTransfer = kind === 'virement';
    const prov = isTransfer ? null : provider(kind);
    if (isTransfer ? !config.transfer.enabled : !prov) return { ok: false, code: 'DISABLED', message: 'Ce moyen de paiement n\'est pas encore disponible.' };
    const isMobileMoney = kind === 'pawapay';

    // Carte, PayPal, virement : en euros. Mobile money : devise du pays du compte de la cliente.
    const country = isMobileMoney
      ? config.countries.find(c => c.code === String(input.country || '').toUpperCase())
      : { code: 'EUR', label: '', currency: 'EUR', decimals: 2 };
    if (!country) return { ok: false, code: 'BAD_COUNTRY', message: 'Ce pays n\'est pas encore accepté pour le paiement Mobile Money.' };

    const key = String(input.idempotencyKey || '');
    if (!/^[A-Za-z0-9-]{16,64}$/.test(key)) return { ok: false, code: 'BAD_REQUEST', message: 'Requête invalide.' };

    // Anti double-clic / rechargement : même clé → même commande, pas de second débit
    const existingOrderId = await repo.getCheckoutKey(key);
    if (existingOrderId) {
      const order = await repo.getOrder(existingOrderId);
      if (!order.paymentProvider || order.paymentProvider === 'virement') return { ok: true, orderId: order.id, transfer: true, amount: order.amount, total: order.total, resumed: true };
      if (order.paymentStatus === S.PAID) return { ok: true, orderId: order.id, alreadyPaid: true };
      const current = order.paymentId ? await repo.getPayment(order.paymentId) : null;
      if (current && sessionStillValid(current) && !input.embedded) return { ok: true, orderId: order.id, redirectUrl: current.redirectUrl, resumed: true };
      if (current && OPEN_STATUSES.has(current.status)) {
        await applyProviderStatus(current.id, 'resume').catch(() => {});
        const fresh = await repo.getOrder(order.id);
        if (fresh.paymentStatus === S.PAID) return { ok: true, orderId: order.id, alreadyPaid: true };
        if (OPEN_STATUSES.has(fresh.paymentStatus) && !input.embedded) return { ok: false, code: 'IN_PROGRESS', message: 'Un paiement est en cours de validation. Patientez quelques instants.', orderId: order.id };
      }
      // Boutons PayPal : chaque ouverture de la fenêtre PayPal crée une nouvelle commande PayPal (l'ancienne n'a rien débité)
      if (input.embedded && current && OPEN_STATUSES.has(current.status)) {
        await repo.transition(current.id, p => (OPEN_STATUSES.has(p.status) ? { paymentPatch: { status: S.EXPIRED, failureCode: 'REPLACED', updatedAtMs: now() }, orderPatch: {} } : null));
      }
      return newAttempt(await repo.getOrder(order.id), input.embedded ? { _embedded: true } : {});
    }

    // Coordonnées
    const c = input.customer || {};
    const nom = str(c.nom, 80);
    const email = str(c.email, 120).toLowerCase();
    const rawTel = str(c.tel, 40);
    const tel = isMobileMoney ? (normalizePhone(rawTel, country.code) || normalizePhone(rawTel)) : (normalizePhone(rawTel) || rawTel.replace(/[^\d+]/g, ''));
    const adresse = str(c.adresse, 200);
    if (nom.length < 2) return { ok: false, code: 'BAD_CUSTOMER', message: 'Indiquez votre nom complet.' };
    if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) return { ok: false, code: 'BAD_EMAIL', message: 'Adresse e-mail invalide.' };
    if (!tel || tel.replace(/\D/g, '').length < 8) return { ok: false, code: 'BAD_PHONE', message: isMobileMoney ? `Numéro de téléphone invalide. Saisissez-le au format international (ex : +${country.dialCode} …).` : 'Numéro de téléphone invalide.' };
    if (!adresse) return { ok: false, code: 'BAD_ADDRESS', message: 'Indiquez votre adresse de livraison.' };
    const type = c.type === 'professionnel' ? 'professionnel' : 'particulier';
    const societe = type === 'professionnel' ? str(c.societe, 100) : '';
    if (type === 'professionnel' && !societe) return { ok: false, code: 'BAD_CUSTOMER', message: 'Indiquez le nom de votre établissement.' };

    // Compte client (facultatif) : jeton Firebase vérifié par le serveur
    let uid = '';
    if (input.idToken && verifyIdToken) {
      try { const dec = await verifyIdToken(String(input.idToken)); uid = dec.uid || ''; } catch (_) { uid = ''; }
    }

    // Montant recalculé côté serveur
    const promoCode = input.promoCode ? str(input.promoCode, 30).toUpperCase() : '';
    if (promoCode && !/^[A-Z0-9_-]{2,30}$/.test(promoCode)) return { ok: false, code: 'BAD_PROMO', message: 'Code promo invalide ou expiré.' };
    let totals;
    try {
      const data = await repo.getPricingData(promoCode || null);
      totals = computeOrderTotal({ lines: input.lines, promoCode, delivery: input.delivery }, { baseCatalog, mainCountry: config.mainCountry, ...data }, now());
    } catch (e) {
      if (e instanceof PricingError) return { ok: false, code: e.code, message: e.message };
      throw e;
    }

    // Conversion dans la devise du pays de paiement (Mobile Money hors euro)
    const fx = isMobileMoney && !CFA_CURRENCIES.has(country.currency) ? await repo.getFxConfig() : null;
    const conv = convertFromEUR(totals.amount, country.currency, country.decimals, fx);
    if (!conv) return { ok: false, code: 'NO_RATE', message: `Le paiement Mobile Money depuis ${country.label} n'est pas encore disponible.` };

    const accessToken = randomBytes(24).toString('base64url');
    const t = new Date(now());
    const order = {
      id: newOrderId(now()),
      type, nom, societe, email, tel, adresse,
      codePostal: str(c.codePostal, 12), ville: totals.city, pays: totals.country,
      instructions: str(c.instructions, 500), uid,
      lines: totals.lines, items: totals.itemsLabel,
      subtotal: totals.subtotal, discount: totals.discount, promoCode: totals.promoCode,
      deliveryZone: totals.deliveryZone, deliveryFee: totals.deliveryFee,
      amount: totals.amount, currency: 'EUR',
      total: formatEUR(totals.amount) + (country.currency !== 'EUR' ? ` — payé ${formatMoney(conv.amount, country.currency)}` : ''),
      paymentAmount: conv.amount, paymentCurrency: country.currency, fxEurRate: conv.eurRate, fxMarginPct: conv.marginPct,
      country: isMobileMoney ? country.code : '',
      paymentMode: PROVIDER_LABEL[kind], paymentProvider: kind,
      paymentStatus: isTransfer ? S.TRANSFER : S.PENDING, paymentAttempts: isTransfer ? 0 : 1,
      date: t.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }),
      heure: t.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }),
      ts: now(), archived: false,
      status: isTransfer ? 'En attente' : 'À vérifier',
      accessTokenHash: sha256(accessToken),
      relance: !!input.relance,
    };

    if (isTransfer) {
      await repo.createOrder(order, key);
      if (order.promoCode) await repo.incrementPromoUse(order.promoCode);
      await logEvent('ORDER_CREATED', { orderId: order.id, provider: 'virement', amountEUR: order.amount });
      await notifyNew(order);
      return { ok: true, orderId: order.id, transfer: true, amount: order.amount, total: order.total, accessToken };
    }

    const payment = {
      id: randomUUID(), orderId: order.id, provider: prov.name, amount: conv.amount, currency: country.currency,
      country: order.country, status: S.PENDING, createdAtMs: now(), updatedAtMs: now(),
    };
    order.paymentId = payment.id;

    // Commande + identifiant de paiement enregistrés AVANT l'appel au prestataire
    await repo.createOrderWithPayment(order, payment, key);
    await logEvent('ORDER_CREATED', { orderId: order.id, paymentId: payment.id, provider: prov.name, amountEUR: order.amount, paymentAmount: payment.amount, paymentCurrency: payment.currency, country: order.country, phone: maskPhone(tel) });
    return startAttempt(order, payment, { accessToken, amount: order.amount, total: order.total, ...(input.embedded && prov.name === 'paypal' ? { _embedded: true } : {}) });
  }

  // ── Boutons PayPal : la cliente a validé dans la fenêtre PayPal → le serveur vérifie et encaisse ──
  async function confirmPayment({ orderId, accessToken }) {
    const order = await repo.getOrder(String(orderId || ''));
    if (!order || !order.accessTokenHash) return { ok: false, code: 'NOT_FOUND', message: 'Commande introuvable.' };
    const a = Buffer.from(sha256(accessToken || '')), b = Buffer.from(order.accessTokenHash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: 'FORBIDDEN', message: 'Accès refusé.' };
    if (order.paymentStatus !== S.PAID && order.paymentId) {
      try { await applyProviderStatus(order.paymentId, 'client_approve'); }
      catch (e) { await logEvent('CONFIRM_ERROR', { orderId: order.id, error: e.message }); }
    }
    return getStatusForClient(order.id);
  }

  // ── Nouvelle tentative après échec / expiration ──────────────────────────────
  async function retryPayment({ orderId, accessToken }) {
    const order = await repo.getOrder(String(orderId || ''));
    if (!order || !order.accessTokenHash) return { ok: false, code: 'NOT_FOUND', message: 'Commande introuvable.' };
    const a = Buffer.from(sha256(accessToken || '')), b = Buffer.from(order.accessTokenHash);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, code: 'FORBIDDEN', message: 'Accès refusé.' };
    if (order.paymentStatus === S.PAID) return { ok: true, orderId: order.id, alreadyPaid: true };
    const current = order.paymentId ? await repo.getPayment(order.paymentId) : null;
    if (current && sessionStillValid(current)) return { ok: true, orderId: order.id, redirectUrl: current.redirectUrl, resumed: true };
    if (current && OPEN_STATUSES.has(current.status)) {
      await applyProviderStatus(current.id, 'retry').catch(() => {});
      const fresh = await repo.getOrder(order.id);
      if (fresh.paymentStatus === S.PAID) return { ok: true, orderId: order.id, alreadyPaid: true };
      if (OPEN_STATUSES.has(fresh.paymentStatus)) {
        return { ok: false, code: 'IN_PROGRESS', message: 'Un paiement est encore en cours de validation. Patientez quelques instants.', orderId: order.id };
      }
    }
    const fresh = await repo.getOrder(order.id);
    if (fresh.paymentStatus === S.NEEDS_REVIEW) return { ok: false, code: 'NEEDS_REVIEW', message: 'Votre paiement est en cours de vérification par notre équipe.', orderId: order.id };
    return newAttempt(fresh);
  }

  // ── Synchronisation avec le prestataire (source de vérité) ────────────────────
  async function applyProviderStatus(paymentId, source) {
    const payment = await repo.getPayment(paymentId);
    if (!payment) return { found: false };
    const prov = provider(payment.provider);
    if (!prov) return { found: true, changed: false };
    const r = await prov.getStatus(paymentId, payment);   // lève une exception si le prestataire est injoignable
    const t = now();

    const result = await repo.transition(paymentId, (p, o) => {
      if (p.status === S.PAID) return null;                         // final
      const isCurrent = o.paymentId === p.id;
      if (r.status === 'COMPLETED') {
        const amountOk = Math.abs(Number(r.amount) - Number(p.amount)) < 0.005 && r.currency === p.currency;
        if (!amountOk) {
          if (p.status === S.NEEDS_REVIEW) return null;
          return {
            paymentPatch: { status: S.NEEDS_REVIEW, reviewReason: 'AMOUNT_MISMATCH', confirmedAmount: r.amount ?? null, confirmedCurrency: r.currency ?? null, updatedAtMs: t },
            orderPatch: { paymentStatus: S.NEEDS_REVIEW, paymentReviewReason: 'AMOUNT_MISMATCH' },
          };
        }
        if (o.paymentStatus === S.PAID && o.paymentId !== p.id) {
          // Deux tentatives payées pour la même commande → remboursement à prévoir
          return {
            paymentPatch: { status: S.NEEDS_REVIEW, reviewReason: 'DOUBLE_PAYMENT', providerTransactionId: r.providerTransactionId || '', updatedAtMs: t },
            orderPatch: { doublePaymentAlert: true },
          };
        }
        return {
          paymentPatch: { status: S.PAID, paidAtMs: t, providerTransactionId: r.providerTransactionId || '', operator: r.operator || '', updatedAtMs: t },
          orderPatch: { paymentStatus: S.PAID, paymentId: p.id, paidAt: new Date(t).toISOString(), providerTransactionId: r.providerTransactionId || '',
            paymentOperator: r.operator || '', status: o.status === 'À vérifier' ? 'En attente' : o.status },
          trackingPatch: { status: o.status === 'À vérifier' ? 'En attente' : o.status },
          _event: 'PAID',
        };
      }
      if (p.status === S.NEEDS_REVIEW) return null;
      if (r.status === 'FAILED') {
        if (p.status === S.FAILED) return null;
        return {
          paymentPatch: { status: S.FAILED, failureCode: r.failureCode || 'UNKNOWN_ERROR', updatedAtMs: t },
          orderPatch: isCurrent && o.paymentStatus !== S.PAID ? { paymentStatus: S.FAILED, paymentFailureCode: r.failureCode || 'UNKNOWN_ERROR' } : {},
        };
      }
      if (r.status === 'PROCESSING') {
        if (p.status === S.IN_PROGRESS) return null;
        return {
          paymentPatch: { status: S.IN_PROGRESS, updatedAtMs: t },
          orderPatch: isCurrent && o.paymentStatus !== S.PAID ? { paymentStatus: S.IN_PROGRESS } : {},
        };
      }
      if (r.status === 'NOT_FOUND') {
        // Payment Page abandonnée ou expirée : aucun callback n'est envoyé (doc PawaPay)
        const started = p.sessionStartedAtMs || p.createdAtMs;
        if (OPEN_STATUSES.has(p.status) && t - started > ttlOf(p) + EXPIRY_GRACE_MS) {
          return {
            paymentPatch: { status: S.EXPIRED, failureCode: 'EXPIRED', updatedAtMs: t },
            orderPatch: isCurrent && o.paymentStatus !== S.PAID ? { paymentStatus: S.EXPIRED, paymentFailureCode: 'EXPIRED' } : {},
          };
        }
        return null;
      }
      // Statut inattendu : on ne devine pas, contrôle humain
      return {
        paymentPatch: { status: S.NEEDS_REVIEW, reviewReason: 'UNKNOWN_STATUS', updatedAtMs: t },
        orderPatch: isCurrent ? { paymentStatus: S.NEEDS_REVIEW, paymentReviewReason: 'UNKNOWN_STATUS' } : {},
      };
    });

    if (result.changed) {
      await logEvent('STATUS_CHANGED', { source, orderId: result.order.id, paymentId, providerStatus: r.status, newStatus: result.payment.status });
      if (result.payment.status === S.PAID && result.order.paymentStatus === S.PAID && result.order.paymentId === paymentId) {
        if (result.order.promoCode) await repo.incrementPromoUse(result.order.promoCode);
        await notifyPaid(result.order);
      }
      if (result.payment.status === S.NEEDS_REVIEW) await notifyReview(result.order, result.payment);
    } else {
      await logEvent('STATUS_UNCHANGED', { source, paymentId, providerStatus: r.status });
    }
    return result;
  }

  // ── Webhook ───────────────────────────────────────────────────────────────────
  async function handleWebhook(providerName, req) {
    const prov = providers[providerName];
    if (!prov) return { status: 404, body: { ok: false } };
    const v = await prov.verifyWebhook(req);
    if (!v.valid) {
      await logEvent('WEBHOOK_REJECTED', { provider: providerName, reason: v.reason });
      return { status: 401, body: { ok: false } };
    }
    await logEvent('WEBHOOK_RECEIVED', { provider: providerName, paymentId: v.paymentId });
    const payment = await repo.getPayment(v.paymentId);
    if (!payment) {
      await logEvent('WEBHOOK_UNKNOWN_PAYMENT', { paymentId: v.paymentId });
      return { status: 200, body: { ok: true } };   // rien à faire, inutile que le prestataire renvoie
    }
    try {
      await applyProviderStatus(v.paymentId, 'webhook');
    } catch (e) {
      await logEvent('WEBHOOK_CHECK_ERROR', { paymentId: v.paymentId, error: e.message });
      return { status: 500, body: { ok: false } };   // la re-vérification planifiée prendra le relais
    }
    return { status: 200, body: { ok: true } };
  }

  // ── Statut pour la page « Paiement en cours » ─────────────────────────────────
  async function getStatusForClient(orderId) {
    let order = await repo.getOrder(String(orderId || ''));
    if (!order || !order.paymentProvider || order.paymentProvider === 'virement') return { ok: false, code: 'NOT_FOUND' };
    const payment = order.paymentId ? await repo.getPayment(order.paymentId) : null;
    if (payment && OPEN_STATUSES.has(payment.status) && now() - (payment.lastCheckedAtMs || 0) > STATUS_CHECK_MIN_INTERVAL_MS) {
      await repo.updatePayment(payment.id, { lastCheckedAtMs: now() });
      try { await applyProviderStatus(payment.id, 'client_poll'); } catch (_) { /* on réessaiera au prochain appel */ }
      order = await repo.getOrder(order.id);
    }
    const st = order.paymentStatus;
    const messages = {
      [S.PENDING]: 'Préparation du paiement…',
      [S.IN_PROGRESS]: order.paymentProvider === 'pawapay' ? 'Validez le paiement sur votre téléphone.' : 'Finalisation de votre paiement…',
      [S.PAID]: 'Paiement confirmé. Merci !',
      [S.FAILED]: customerFailureMessage(order.paymentFailureCode),
      [S.EXPIRED]: customerFailureMessage('EXPIRED'),
      [S.NEEDS_REVIEW]: 'Votre paiement est en cours de vérification par notre équipe. Nous vous contactons rapidement.',
    };
    return {
      ok: true, orderId: order.id, paymentStatus: st, message: messages[st] || '',
      final: st === S.PAID || st === S.NEEDS_REVIEW, canRetry: RETRYABLE_STATUSES.has(st),
      total: order.total, items: order.items,
      paymentAmount: order.paymentAmount != null ? formatMoney(order.paymentAmount, order.paymentCurrency || 'EUR') : '',
    };
  }

  // ── Re-vérification planifiée (callbacks perdus, sessions abandonnées) ────────
  async function reconcile() {
    const open = await repo.findOpenPayments(100);
    let checked = 0, changed = 0, errors = 0;
    for (const p of open) {
      if (now() - (p.updatedAtMs || p.createdAtMs) < 60000) continue;
      try { const r = await applyProviderStatus(p.id, 'reconcile'); checked++; if (r.changed) changed++; }
      catch (e) { errors++; await logEvent('RECONCILE_ERROR', { paymentId: p.id, error: e.message }); }
    }
    await logEvent('RECONCILE_DONE', { open: open.length, checked, changed, errors });
    return { open: open.length, checked, changed, errors };
  }

  // Ce que le site peut proposer (aucun secret) : moyens actifs, pays Mobile Money
  async function publicConfig() {
    if (config.firebaseReady === false) return { enabled: false, stripe: false, paypal: false, pawapay: false, transfer: false, countries: [], reason: 'FIREBASE_NOT_CONFIGURED' };
    let fx = null;
    if (providers.pawapay) { try { fx = await repo.getFxConfig(); } catch (_) { fx = null; } }
    const rates = (fx && fx.eurRates) || {};
    const countries = providers.pawapay ? config.countries
      .filter(c => CFA_CURRENCIES.has(c.currency) || Number(rates[c.currency]) > 0)
      .map(c => ({ code: c.code, label: c.label, currency: c.currency, decimals: c.decimals, dialCode: c.dialCode,
        eurRate: CFA_CURRENCIES.has(c.currency) ? 655.957 : Number(rates[c.currency]) }))
      .sort((a, b) => a.label.localeCompare(b.label, 'fr')) : [];
    return {
      enabled: !!(providers.stripe || providers.paypal || (providers.pawapay && countries.length) || config.transfer.enabled),
      stripe: !!providers.stripe, stripeLive: !!(config.stripe && config.stripe.live),
      paypal: !!providers.paypal, paypalEnv: config.paypal.env, paypalClientId: providers.paypal ? config.paypal.clientId : '',
      pawapay: !!providers.pawapay && countries.length > 0, pawapayEnv: config.pawapay.env, countries,
      marginPct: Math.min(Math.max(Number(fx && fx.marginPct) || 0, 0), 20),
      transfer: !!config.transfer.enabled,
    };
  }

  return { createPayment, confirmPayment, retryPayment, applyProviderStatus, handleWebhook, getStatusForClient, reconcile, publicConfig };
}
