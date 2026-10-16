/**
 * Statuts de paiement internes (indépendants du prestataire).
 * Le statut de préparation/livraison reste dans le champ `status` de la commande.
 */
export const PAYMENT_STATUS = Object.freeze({
  PENDING: 'en_attente_paiement',     // commande créée, paiement pas encore lancé
  IN_PROGRESS: 'paiement_en_cours',   // cliente sur la page de paiement / validation en cours
  PAID: 'payee',                      // confirmé par le serveur (webhook + vérification API)
  FAILED: 'echouee',                  // refusé… → nouvelle tentative possible
  EXPIRED: 'annulee_expiree',         // abandonné ou session expirée → nouvelle tentative possible
  NEEDS_REVIEW: 'a_verifier',         // anomalie (montant incohérent, statut inconnu) → contrôle humain
  TRANSFER: 'virement_attendu',       // virement bancaire : en attente de réception des fonds
});

export const FINAL_STATUSES = new Set([PAYMENT_STATUS.PAID, PAYMENT_STATUS.NEEDS_REVIEW]);
export const RETRYABLE_STATUSES = new Set([PAYMENT_STATUS.FAILED, PAYMENT_STATUS.EXPIRED]);
export const OPEN_STATUSES = new Set([PAYMENT_STATUS.PENDING, PAYMENT_STATUS.IN_PROGRESS]);

// Messages affichés aux clientes (le message technique du prestataire est réservé à l'équipe)
const FAILURE_MESSAGES = {
  INSUFFICIENT_BALANCE: 'Solde insuffisant sur votre compte mobile money.',
  PAYMENT_NOT_APPROVED: 'Le paiement n\'a pas été validé sur votre téléphone.',
  PAYER_NOT_FOUND: 'Ce numéro n\'a pas de compte mobile money chez cet opérateur.',
  PAYER_LIMIT_REACHED: 'Votre limite de transaction mobile money est atteinte.',
  WALLET_LIMIT_REACHED: 'La limite de votre portefeuille mobile money est atteinte.',
  PAYMENT_IN_PROGRESS: 'Un autre paiement est déjà en attente sur ce numéro. Réessayez dans quelques minutes.',
  PROVIDER_TEMPORARILY_UNAVAILABLE: 'L\'opérateur est momentanément indisponible. Réessayez plus tard.',
  AMOUNT_OUT_OF_BOUNDS: 'Le montant dépasse les limites de l\'opérateur. Contactez-nous.',
  EXPIRED: 'Le délai de paiement est dépassé.',
  DECLINED: 'Le paiement a été refusé par votre banque ou par PayPal.',
  VOIDED: 'Le paiement PayPal a été annulé.',
};
export function customerFailureMessage(code) {
  return FAILURE_MESSAGES[code] || 'Le paiement n\'a pas abouti.';
}
