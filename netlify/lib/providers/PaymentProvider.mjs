/**
 * Contrat commun à tous les prestataires de paiement.
 *
 * Pour ajouter un prestataire (ex. cartes via CinetPay ou Flutterwave) :
 *   1. créer providers/<nom>.mjs qui étend PaymentProvider ;
 *   2. l'enregistrer dans providers/index.mjs ;
 *   3. créer sa fonction webhook (netlify/functions/payments-webhook-<nom>.mjs)
 *      qui appelle paymentService.handleWebhook(<nom>, request).
 * Le reste (commandes, statuts, page « Paiement en cours », tests) ne change pas.
 *
 * Statuts normalisés renvoyés par getStatus / parseWebhook :
 *   'COMPLETED' | 'FAILED' | 'PROCESSING' | 'NOT_FOUND' | 'UNKNOWN'
 */
export class PaymentProvider {
  /** Identifiant court stocké avec la commande ('pawapay', 'cinetpay'…) */
  get name() { throw new Error('not implemented'); }

  /**
   * Lance un paiement et renvoie l'URL de la page de paiement.
   * @param {{paymentId:string, amount:number, currency:string, country:string, returnUrl:string, reason:string, orderId:string}} p
   * @returns {Promise<{ok:true, redirectUrl:string} | {ok:false, failureCode:string, failureMessage?:string}>}
   * Doit lever une exception en cas d'erreur réseau (statut inconnu).
   */
  async initiatePayment(p) { throw new Error('not implemented'); }

  /**
   * Interroge le prestataire (source de vérité).
   * @returns {Promise<{status:string, amount?:number, currency?:string, country?:string,
   *                    failureCode?:string, providerTransactionId?:string, raw?:object}>}
   */
  async getStatus(paymentId) { throw new Error('not implemented'); }

  /**
   * Authentifie un webhook et en extrait l'identifiant de paiement.
   * Le contenu du webhook n'est JAMAIS utilisé pour valider : le service re-vérifie via getStatus.
   * @param {{method:string, url:string, headers:object, rawBody:string}} req
   * @returns {Promise<{valid:boolean, reason?:string, paymentId?:string}>}
   */
  async verifyWebhook(req) { throw new Error('not implemented'); }
}
