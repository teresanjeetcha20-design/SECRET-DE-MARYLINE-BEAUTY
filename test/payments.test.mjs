import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, VALID_INPUT, signedCallback } from './helpers.mjs';

async function createdOrder(ctx, input = VALID_INPUT()) {
  const r = await ctx.service.createPayment(input);
  assert.equal(r.ok, true, JSON.stringify(r));
  const order = await ctx.repo.getOrder(r.orderId);
  return { r, order, depositId: order.paymentId, input };
}
const webhook = (ctx, depositId, extra = {}) => ctx.service.handleWebhook('pawapay', signedCallback({ depositId, status: 'COMPLETED', ...extra }));

test('création : montant serveur, UUID enregistré avant l\'appel PawaPay, Payment Page en XAF', async () => {
  const ctx = setup();
  let paymentExistedBeforeCall = false;
  // Au moment précis de l'appel à PawaPay, le paiement doit déjà être en base
  ctx.fake.state.onSession = body => { paymentExistedBeforeCall = !!ctx.repo._db.payments.get(body.depositId); };
  const { r, order, depositId } = await createdOrder(ctx);
  assert.ok(paymentExistedBeforeCall);
  assert.match(depositId, /^[0-9a-f-]{36}$/);
  assert.equal(order.amount, 2 * 40 + 25);                              // euros, recalculés par le serveur
  assert.equal(order.paymentAmount, Math.ceil(105 * 655.957));          // payé en F CFA
  assert.equal(order.status, 'À vérifier');
  assert.equal(order.paymentStatus, 'paiement_en_cours');
  const s = ctx.fake.state.sessions[0];
  assert.deepEqual(s.amountDetails, { amount: String(Math.ceil(105 * 655.957)), currency: 'XAF' });
  assert.equal(s.country, 'CMR');
  assert.equal(s.depositId, depositId);
  assert.equal(s.returnUrl, `https://shop.test/?pay=return&order=${order.id}`);
  assert.ok(r.redirectUrl.startsWith('https://'));
  assert.ok(r.accessToken && !JSON.stringify(order).includes(r.accessToken), 'jeton jamais stocké en clair');
  assert.equal(order.tel, '237695123456');
});

test('double clic / rechargement : même commande, une seule session PawaPay', async () => {
  const ctx = setup();
  const input = VALID_INPUT();
  const a = await ctx.service.createPayment(input);
  const b = await ctx.service.createPayment(input);
  assert.equal(a.orderId, b.orderId);
  assert.equal(b.redirectUrl, a.redirectUrl);
  assert.equal(ctx.fake.state.sessions.length, 1);
  assert.equal(ctx.repo._db.orders.size, 1);
});

test('webhook succès : commande payée après re-vérification API, commerçante notifiée', async () => {
  const ctx = setup();
  const { order, depositId } = await createdOrder(ctx);
  ctx.fake.setDeposit(depositId, 'COMPLETED', { amount: String(order.paymentAmount), providerTransactionId: 'MP123' });
  const res = await webhook(ctx, depositId);
  assert.equal(res.status, 200);
  const o = await ctx.repo.getOrder(order.id);
  assert.equal(o.paymentStatus, 'payee');
  assert.equal(o.status, 'En attente');
  assert.equal(o.providerTransactionId, 'MP123');
  assert.deepEqual(ctx.notified, [order.id]);
  assert.ok(ctx.fake.state.calls.includes(`GET /v2/deposits/${depositId}`));
});

test('webhook reçu deux fois : aucun effet la seconde fois', async () => {
  const ctx = setup();
  const { order, depositId } = await createdOrder(ctx);
  ctx.fake.setDeposit(depositId, 'COMPLETED', { amount: String(order.paymentAmount) });
  await webhook(ctx, depositId);
  const after1 = await ctx.repo.getOrder(order.id);
  await webhook(ctx, depositId);
  const after2 = await ctx.repo.getOrder(order.id);
  assert.deepEqual(after2, after1);
  assert.equal(ctx.notified.length, 1, 'une seule notification');
});

test('webhook échec : commande « échouée », nouvelle tentative possible', async () => {
  const ctx = setup();
  const { r, order, depositId } = await createdOrder(ctx);
  ctx.fake.setDeposit(depositId, 'FAILED', { amount: String(order.paymentAmount), failureReason: { failureCode: 'INSUFFICIENT_BALANCE' } });
  await ctx.service.handleWebhook('pawapay', signedCallback({ depositId, status: 'FAILED' }));
  const st = await ctx.service.getStatusForClient(order.id);
  assert.equal(st.paymentStatus, 'echouee');
  assert.equal(st.canRetry, true);
  assert.match(st.message, /Solde insuffisant/);
  const retry = await ctx.service.retryPayment({ orderId: order.id, accessToken: r.accessToken });
  assert.equal(retry.ok, true);
  const o = await ctx.repo.getOrder(order.id);
  assert.notEqual(o.paymentId, depositId, 'nouvel identifiant pour la nouvelle tentative');
  assert.equal(ctx.fake.state.sessions.length, 2);
});

test('montant incohérent : jamais « payée », passage en vérification', async () => {
  const ctx = setup();
  const { order, depositId } = await createdOrder(ctx);
  ctx.fake.setDeposit(depositId, 'COMPLETED', { amount: '100' });
  await webhook(ctx, depositId, { amount: String(order.paymentAmount) });   // le callback ment, l'API fait foi
  const o = await ctx.repo.getOrder(order.id);
  assert.equal(o.paymentStatus, 'a_verifier');
  assert.equal(ctx.notified.length, 0);
  assert.deepEqual(ctx.reviews, ['AMOUNT_MISMATCH']);
});

test('devise incohérente : refusée de la même façon', async () => {
  const ctx = setup();
  const { order, depositId } = await createdOrder(ctx);
  ctx.fake.setDeposit(depositId, 'COMPLETED', { amount: String(order.paymentAmount), currency: 'XOF' });
  await webhook(ctx, depositId);
  assert.equal((await ctx.repo.getOrder(order.id)).paymentStatus, 'a_verifier');
});

test('callback falsifié « COMPLETED » alors que PawaPay dit FAILED : l\'API fait foi', async () => {
  const ctx = setup();
  const { order, depositId } = await createdOrder(ctx);
  ctx.fake.setDeposit(depositId, 'FAILED', { amount: String(order.paymentAmount), failureReason: { failureCode: 'PAYMENT_NOT_APPROVED' } });
  await webhook(ctx, depositId, { amount: String(order.paymentAmount) });
  assert.equal((await ctx.repo.getOrder(order.id)).paymentStatus, 'echouee');
  assert.equal(ctx.notified.length, 0);
});

test('signature invalide : 401 et aucune modification', async () => {
  const ctx = setup();
  const { order, depositId } = await createdOrder(ctx);
  ctx.fake.setDeposit(depositId, 'COMPLETED', { amount: String(order.paymentAmount) });
  const req = signedCallback({ depositId, status: 'COMPLETED' }, { tamper: s => s + ' ' });
  const res = await ctx.service.handleWebhook('pawapay', req);
  assert.equal(res.status, 401);
  assert.equal((await ctx.repo.getOrder(order.id)).paymentStatus, 'paiement_en_cours');
});

test('retour de la cliente sur le site sans paiement : la commande reste non payée', async () => {
  const ctx = setup();
  const { order } = await createdOrder(ctx);
  const st = await ctx.service.getStatusForClient(order.id);   // PawaPay : NOT_FOUND (rien payé)
  assert.equal(st.paymentStatus, 'paiement_en_cours');
  assert.equal(st.final, false);
});

test('page abandonnée : expirée après 15 min (+ marge), puis nouvelle tentative', async () => {
  const ctx = setup();
  const { r, order } = await createdOrder(ctx);
  ctx.clock.t += 18 * 60 * 1000;
  const rec = await ctx.service.reconcile();
  assert.equal(rec.changed, 1);
  assert.equal((await ctx.repo.getOrder(order.id)).paymentStatus, 'annulee_expiree');
  const retry = await ctx.service.retryPayment({ orderId: order.id, accessToken: r.accessToken });
  assert.equal(retry.ok, true);
});

test('re-vérification planifiée : rattrape un callback perdu', async () => {
  const ctx = setup();
  const { order, depositId } = await createdOrder(ctx);
  ctx.fake.setDeposit(depositId, 'COMPLETED', { amount: String(order.paymentAmount) });
  ctx.clock.t += 5 * 60 * 1000;
  await ctx.service.reconcile();
  assert.equal((await ctx.repo.getOrder(order.id)).paymentStatus, 'payee');
  assert.equal(ctx.notified.length, 1);
});

test('PawaPay injoignable à la création : pas de paiement perdu, message clair', async () => {
  const ctx = setup();
  ctx.fake.state.downNext = true;
  const r = await ctx.service.createPayment(VALID_INPUT());
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PROVIDER_UNAVAILABLE');
  const o = await ctx.repo.getOrder(r.orderId);
  assert.equal(o.paymentStatus, 'en_attente_paiement');
  assert.ok(ctx.repo._db.payments.get(o.paymentId), 'identifiant conservé pour la réconciliation');
});

test('refus immédiat de PawaPay (opérateur indisponible) : échec avec message', async () => {
  const ctx = setup();
  ctx.fake.state.rejectNext = 'PROVIDER_TEMPORARILY_UNAVAILABLE';
  const r = await ctx.service.createPayment(VALID_INPUT());
  assert.equal(r.ok, false);
  assert.match(r.message, /indisponible/);
  assert.equal((await ctx.repo.getOrder(r.orderId)).paymentStatus, 'echouee');
});

test('nouvelle tentative : jeton obligatoire', async () => {
  const ctx = setup();
  const { order } = await createdOrder(ctx);
  const r = await ctx.service.retryPayment({ orderId: order.id, accessToken: 'mauvais' });
  assert.equal(r.code, 'FORBIDDEN');
});

test('double paiement (deux tentatives réussies) : signalé, pas de double validation', async () => {
  const ctx = setup();
  const { r, order, depositId: first } = await createdOrder(ctx);
  ctx.fake.setDeposit(first, 'FAILED', { amount: String(order.paymentAmount), failureReason: { failureCode: 'UNKNOWN_ERROR' } });
  await webhook(ctx, first);
  await ctx.service.retryPayment({ orderId: order.id, accessToken: r.accessToken });
  const second = (await ctx.repo.getOrder(order.id)).paymentId;
  ctx.fake.setDeposit(second, 'COMPLETED', { amount: String(order.paymentAmount) });
  await webhook(ctx, second);
  // la 1re tentative finit par réussir (réconciliation tardive chez l'opérateur)
  ctx.fake.setDeposit(first, 'COMPLETED', { amount: String(order.paymentAmount) });
  await webhook(ctx, first);
  const o = await ctx.repo.getOrder(order.id);
  assert.equal(o.paymentStatus, 'payee');
  assert.equal(o.doublePaymentAlert, true);
  assert.equal(ctx.notified.length, 1);
  assert.ok(ctx.reviews.includes('DOUBLE_PAYMENT'));
});

test('pays non couvert par PawaPay (Mali) : refusé', async () => {
  const ctx = setup();
  const r = await ctx.service.createPayment({ ...VALID_INPUT(), country: 'MLI' });
  assert.equal(r.code, 'BAD_COUNTRY');
});

test('statut public : aucune donnée personnelle, montant payé affiché', async () => {
  const ctx = setup();
  const { order } = await createdOrder(ctx);
  const st = await ctx.service.getStatusForClient(order.id);
  assert.ok(!JSON.stringify(st).includes('Awa') && !JSON.stringify(st).includes('237695'));
  assert.match(st.paymentAmount, /F CFA$/);
});
test('identifiant de commande au format SMB', async () => {
  const ctx = setup();
  const { order } = await createdOrder(ctx);
  assert.match(order.id, /^SMB[A-Z0-9]{8,30}$/);
});
