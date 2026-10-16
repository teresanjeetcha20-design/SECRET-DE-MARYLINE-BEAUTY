/** Assemble le service avec les vraies dépendances (Firestore, prestataires, FormSubmit). */
import { getAuth } from 'firebase-admin/auth';
import { getConfig } from './config.mjs';
import { createProviders } from './providers/index.mjs';
import { createFirestoreRepo, db } from './repository/firestoreRepo.mjs';
import { createPaymentService } from './paymentService.mjs';
import { createLogger } from './logger.mjs';
import { createNotifier } from './notify.mjs';
import { createMailer } from './mailer.mjs';
import baseCatalog from './catalog.mjs';

let _service = null;
export function getService() {
  if (_service) return _service;
  const config = getConfig();
  const repo = createFirestoreRepo();
  const logEvent = createLogger(repo);
  const mailer = createMailer({ apiKey: process.env.BREVO_API_KEY, fromEmail: process.env.MAIL_FROM_EMAIL, fromName: process.env.MAIL_FROM_NAME || 'Secret de Maryline Beauty', siteUrl: config.siteUrl });
  const notifier = createNotifier({ merchantEmail: config.merchantEmail, mailer });
  const notifyReview = async (order, payment) => { await logEvent('NEEDS_REVIEW', { orderId: order.id, paymentId: payment.id, reason: payment.reviewReason }); };
  const verifyIdToken = async (token) => { db(); return getAuth().verifyIdToken(token); };
  _service = createPaymentService({
    repo, providers: createProviders(config), config, baseCatalog,
    notifyPaid: notifier.notifyPaid, notifyNew: notifier.notifyNew, notifyReview, logEvent, verifyIdToken,
  });
  return _service;
}

export function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
