import { formatEUR, formatMoney } from './pricing.mjs';
import { SHOP_NAME } from './config.mjs';

/**
 * Alerte la commerçante (service gratuit FormSubmit) :
 *  - quand une commande est PAYÉE en ligne ;
 *  - quand une commande par VIREMENT est passée.
 */
export function createNotifier({ merchantEmail, fetchImpl = fetch } = {}) {
  async function send(subject, order, extra = {}) {
    if (!merchantEmail) return false;
    try {
      const r = await fetchImpl(`https://formsubmit.co/ajax/${encodeURIComponent(merchantEmail)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          _subject: subject, _template: 'table', _captcha: 'false',
          Commande: `#${order.id}`,
          Type: order.type === 'professionnel' ? `Professionnel${order.societe ? ' — ' + order.societe : ''}` : 'Particulier',
          Montant: formatEUR(order.amount) + (order.paymentCurrency && order.paymentCurrency !== 'EUR' ? ` (payé ${formatMoney(order.paymentAmount, order.paymentCurrency)})` : ''),
          Cliente: order.nom, Téléphone: order.tel, Email: order.email || '—',
          Livraison: [order.adresse, [order.codePostal, order.ville].filter(Boolean).join(' '), order.pays].filter(Boolean).join(', '),
          Articles: order.items,
          ...extra,
        }),
      });
      return r.ok;
    } catch (e) {
      console.warn('[payments] notification commerçante échouée', e.message);
      return false;
    }
  }
  return {
    notifyPaid: (order) => send(`✅ Commande payée #${order.id} — ${SHOP_NAME}`, order, { Paiement: `${order.paymentMode || order.paymentProvider || ''} — réf. ${order.providerTransactionId || '—'}` }),
    notifyNew: (order) => send(`🏦 Nouvelle commande par virement #${order.id} — ${SHOP_NAME}`, order, { Paiement: 'Virement bancaire — à vérifier sur le compte (référence = n° de commande)' }),
  };
}
