/**
 * Envoi d'e-mails aux clientes via Brevo (offre gratuite : 300 e-mails/jour).
 * Variables : BREVO_API_KEY, MAIL_FROM_EMAIL (adresse validée dans Brevo), MAIL_FROM_NAME, MAIL_REPLY_TO (facultatif).
 * Les e-mails marketing (campagnes, relances) contiennent un lien de désinscription.
 */
import { SHOP_NAME } from './config.mjs';
const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = (html) => html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#C2520F">$1</a>');

export function renderEmailHtml(text, siteUrl, unsubscribeUrl) {
  const body = linkify(escapeHtml(text).replace(/\n/g, '<br>'));
  return `<!doctype html><html lang="fr"><body style="margin:0;background:#FFF9F3;font-family:Georgia,'Times New Roman',serif">
  <div style="max-width:560px;margin:0 auto;padding:32px 20px">
    <div style="text-align:center;color:#4A1238;font-size:22px;letter-spacing:1px;margin-bottom:6px">Secret de Maryline <span style="color:#F47721;font-style:italic">Beauty</span></div>
    <div style="text-align:center;color:#B07D1E;font-size:12px;letter-spacing:3px;text-transform:uppercase;margin-bottom:24px">Actifs cosmétiques d'exception</div>
    <div style="background:#ffffff;border:1px solid #F1E2D3;border-radius:16px;padding:28px;color:#3D0F33;font-size:15px;line-height:1.7;font-family:Arial,Helvetica,sans-serif">${body}</div>
    <div style="text-align:center;color:#8A7A80;font-size:12px;margin-top:22px;font-family:Arial,Helvetica,sans-serif">
      ${siteUrl ? `<a href="${escapeHtml(siteUrl)}" style="color:#C2520F">${escapeHtml(siteUrl.replace(/^https?:\/\//, ''))}</a>` : ''}
      ${unsubscribeUrl ? `<br><br><a href="${escapeHtml(unsubscribeUrl)}" style="color:#8A7A80">Se désinscrire de nos e-mails</a>` : ''}
    </div>
  </div></body></html>`;
}

export function createMailer({ apiKey, fromEmail, fromName = SHOP_NAME, replyTo, siteUrl = '', fetchImpl = fetch } = {}) {
  const configured = !!(apiKey && fromEmail);
  async function send({ to, name, subject, text, unsubscribeUrl, replyTo: replyOverride }) {
    if (!configured) return { ok: false, error: 'NOT_CONFIGURED' };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(to || ''))) return { ok: false, error: 'BAD_EMAIL' };
    const plain = String(text || '').slice(0, 5000) + (unsubscribeUrl ? `\n\n—\nSe désinscrire : ${unsubscribeUrl}` : '');
    const body = {
      sender: { name: fromName, email: fromEmail },
      to: [{ email: String(to).trim(), ...(name ? { name: String(name).slice(0, 80) } : {}) }],
      subject: String(subject || SHOP_NAME).slice(0, 150),
      htmlContent: renderEmailHtml(String(text || '').slice(0, 5000), siteUrl, unsubscribeUrl),
      textContent: plain,
      ...((replyOverride || replyTo) ? { replyTo: { email: replyOverride || replyTo } } : {}),
      ...(unsubscribeUrl ? { headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>` } } : {}),
    };
    try {
      const r = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST', headers: { 'api-key': apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status >= 200 && r.status < 300) return { ok: true };
      let j = null; try { j = await r.json(); } catch (_) {}
      return { ok: false, error: (j && j.code) || `HTTP_${r.status}`, detail: String((j && j.message) || '').slice(0, 240) };
    } catch (e) { return { ok: false, error: 'NETWORK' }; }
  }
  return { configured, send };
}
