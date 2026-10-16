# Secret de Maryline Beauty — mise en route

## Ce qui a été repris de LF Cosmetics

| Nouveauté | Où |
|---|---|
| **Paiement géré par le serveur** : la commande et son montant sont créés par le serveur (impossible de trafiquer un prix), protection anti double-clic, journal des paiements | automatique |
| **Page « Paiement en cours »** au retour du paiement, mise à jour toute seule, avec **« Réessayer »** en cas d'échec | site |
| **Vérification automatique toutes les 10 min** des paiements restés en attente (notification perdue, page abandonnée) | automatique |
| **Carte bancaire, Apple Pay, Google Pay** (Stripe) | site |
| **PayPal** : boutons officiels, paiement sans quitter le site | site |
| **Mobile Money** (MTN, Orange, Airtel, Moov… via PawaPay) : 21 pays d'Afrique, payé en F CFA ou en devise locale (taux réglés dans l'admin) | site |
| **Virement** : coordonnées et référence affichées, montant calculé par le serveur | site |
| **E-mails automatiques aux clientes** à chaque changement de statut et au retour en stock (Brevo) | admin › Messages automatiques |
| **Campagnes** e-mail et WhatsApp (promo, Noël, relance panier…), avec lien de désinscription | admin › Campagnes |
| **Parcours clientes et paniers abandonnés** (entonnoir, relance si la cliente l'a accepté) | admin › Parcours clientes |
| **Étiquettes produits** modifiables (nouveaux filtres de la boutique) | admin › Produits |
| **Bannière cookies** (le suivi des parcours n'a lieu que si la visiteuse accepte) | site |
| **Bouton WhatsApp** flottant | site |
| **Page publique « Suivi de commande »** | site, pied de page |

Non repris : le script de migration des anciens comptes LF (SMB n'en a pas besoin) et l'intro vidéo de LF (SMB a la sienne).

## Le dossier

```
public/          ← le site (seul dossier visible en ligne) : index.html, images, vidéo
netlify/         ← les fonctions de paiement et d'e-mails (jamais visibles en ligne)
scripts/ test/   ← vérifications automatiques lancées à chaque mise en ligne
package.json, netlify.toml, firestore.rules, .env.example
```

⚠️ Les fonctions **ne marchent pas avec le glisser-déposer** Netlify : le site doit être publié **via GitHub** (étape 2). À chaque mise en ligne, Netlify relance 69 tests ; si l'un échoue, l'ancienne version reste en ligne.

---

## Étape 1 — Coordonnées bancaires (pour le virement)
Ouvre `public/index.html` avec TextEdit. Tout en haut, section **CONFIGURATION**, remplis `bank` : `holder` (titulaire), `iban`, `bic`. Enregistre.

## Étape 2 — Publier avec GitHub (une seule fois)
1. https://github.com › crée un compte › **New repository** › nom `smb-site`, **Private** › Create.
2. **uploading an existing file** › glisse **tout le contenu** du dossier (public, netlify, scripts, test, package.json, package-lock.json, netlify.toml, firestore.rules, MISE-EN-ROUTE.md) › **Commit changes**.
3. Netlify › ton site › **Site configuration › Build & deploy › Link repository** › GitHub › `smb-site`. Netlify lit tout seul `netlify.toml` (ne rien changer).

Pour les mises à jour suivantes : sur GitHub, **Add file › Upload files**, glisse les fichiers modifiés, **Commit** → en ligne en 2 minutes.

## Étape 3 — Les variables secrètes (Netlify › Site configuration › Environment variables)
Pour chacune : coche **« Contient des valeurs secrètes »** et **« Tous les types de portées »**.

**Obligatoires**
| Nom | Valeur |
|---|---|
| `FIREBASE_PROJECT_ID` | `sm-beauty-ssite` |
| `FIREBASE_CLIENT_EMAIL` | la ligne `client_email` du **nouveau** fichier de clé Firebase |
| `FIREBASE_PRIVATE_KEY` | la ligne `private_key` du même fichier (tout le texte entre les guillemets, de `-----BEGIN` à `END PRIVATE KEY-----\n`) |
| `SITE_URL` | `https://legendary-naiad-f2f43d.netlify.app` |
| `MERCHANT_NOTIFY_EMAIL` | `massop_2003@yahoo.fr` (alerte à chaque commande payée ou par virement) |

> Si tu as déjà créé `FIREBASE_SERVICE_ACCOUNT`, supprime-la et utilise ces 3 variables : elles prennent moins de place (Netlify limite la taille totale des variables des fonctions à environ 4 Ko). Et la clé envoyée dans la conversation doit être **supprimée et régénérée** avant.

**Carte bancaire, Apple Pay, Google Pay (Stripe)**
| `STRIPE_SECRET_KEY` | `sk_test_…` puis `sk_live_…` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` (étape 4) |

**PayPal (facultatif)** — developer.paypal.com › Apps & Credentials › créer une app
| `PAYPAL_CLIENT_ID` · `PAYPAL_CLIENT_SECRET` | identifiants de l'app |
| `PAYPAL_ENV` | `sandbox` (tests) puis `live` |

**Mobile Money (facultatif)** — dashboard.pawapay.io
| `PAWAPAY_API_TOKEN` | jeton API (sandbox ≠ production) |
| `PAWAPAY_ENV` | `sandbox` puis `production` |

**E-mails aux clientes (facultatif mais conseillé)** — brevo.com (gratuit : 300 e-mails/jour)
| `BREVO_API_KEY` | Brevo › SMTP & API › Clés API |
| `MAIL_FROM_EMAIL` | une adresse **validée** dans Brevo › Expéditeurs |
| `MAIL_REPLY_TO` | `massop_2003@yahoo.fr` |

Puis **Deploys › Trigger deploy**.

## Étape 4 — Brancher les prestataires au site
- **Stripe** › Développeurs › Webhooks › Ajouter une destination : URL `https://legendary-naiad-f2f43d.netlify.app/api/payments/webhook/stripe` ; événements `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired` → copie le `whsec_…` dans `STRIPE_WEBHOOK_SECRET` → redéploie. Dans Paramètres › Moyens de paiement : active Cartes, Apple Pay, Google Pay.
- **PawaPay** › Callback URL des dépôts : `https://legendary-naiad-f2f43d.netlify.app/api/payments/webhook/pawapay` + active **Signed callbacks** + vérifie les pays activés.
- **PayPal** : rien à brancher (vérification par le serveur).

## Étape 5 — Firebase
Firestore › **Règles** › colle le nouveau `firestore.rules` › **Publier** (nouvelles collections : paiements, parcours, campagnes).

## Étape 6 — Réglages dans l'admin (`…/#/admin`)
1. **Codes promo & livraison › Frais de livraison** : mets au moins un **tarif standard France** et les pays où tu livres. Sans tarif, le paiement en ligne est refusé (« frais à confirmer ») et la cliente est recontactée.
2. **Taux de change** (seulement si Mobile Money hors zone F CFA : Ghana, Kenya…) : à mettre à jour chaque semaine. Le F CFA n'a besoin d'aucun taux (1 € = 655,957 F CFA).
3. **Messages automatiques** : relis les modèles, choisis si l'e-mail part automatiquement, envoie-toi un test.

## Étape 7 — Vérifier
- Ouvre `https://legendary-naiad-f2f43d.netlify.app/api/payments/config` : tu dois voir `"enabled":true` et `"stripe":true`, etc. Sinon le site masque les paiements en ligne et fonctionne comme avant.
- Commande test par carte : `4242 4242 4242 4242`, date future, code 123 → page « Paiement en cours » → « Paiement confirmé » → dans l'admin « ✅ Payée en ligne » + e-mail d'alerte reçu.
- Fermer la page Stripe sans payer → environ 35 min plus tard, la commande passe « Paiement expiré » ; « Réessayer » fonctionne.
- Mobile Money (sandbox) : numéros de test sur docs.pawapay.io › test numbers.
- Change le statut d'une commande test en « Expédié » → la cliente reçoit l'e-mail.

## Passer en réel
Stripe : clés `sk_live_…` + nouveau webhook en mode réel. PayPal : `PAYPAL_ENV=live` + identifiants live. PawaPay : onboarding terminé, `PAWAPAY_ENV=production`, nouveau jeton, callback déclarée en production. Redéployer, puis faire un vrai petit paiement par moyen.

---

## Nouveautés de la version 8

- **« Prévenir la cliente »** : après chaque changement de statut, une fenêtre s'ouvre avec le message prêt (modifiable). L'e-mail part automatiquement, la fenêtre indique s'il est bien parti (ou pourquoi il n'est pas parti), et un bouton envoie le même message sur WhatsApp. Le bouton « 💬 Prévenir la cliente » sur chaque commande permet de l'ouvrir à tout moment.
- **Messages prêts** (onglet Messages automatiques) : un par statut, plus « Relance paiement », « Retard de livraison », « Adresse à compléter », « Demande d'avis », et **+ Nouveau message** pour créer les tiens.
- **Fiche produit** : « + Nouvelle catégorie » et « + Nouvelle étiquette ». Produit simple : uniquement le prix et la contenance (ex. 30 ml).
- **Stock** : « Actualiser » confirme le rechargement ; suppression des demandes déjà prévenues (une par une, par produit, ou toutes).
- **Page Contact** : les messages arrivent dans l'admin (onglet **Messages clientes**) et par e-mail via Brevo. Les alertes de commande passent aussi par Brevo.
- **Paiement** : les 4 moyens sont toujours affichés ; ceux qui ne sont pas encore prêts sont grisés avec la raison (« Bientôt disponible », « Frais de livraison à confirmer »).
- **Professionnels** : la grille tarifaire affiche 8 lignes, avec « Afficher plus » et « Tout afficher ».

⚠️ Après la mise à jour : **republier `firestore.rules`** dans Firebase (nouvelle collection des messages de contact).

## E-mails : « envoyé » mais rien reçu ?
Brevo a accepté l'e-mail, mais il a été bloqué ou classé en spam. Pour savoir pourquoi : Brevo › **Transactionnel › Journaux** (ou « Logs »), cherche l'adresse de la cliente. Statuts possibles : *Délivré* (regarder les spams), *Bloqué*, *Rejet (bounce)*.
La cause la plus fréquente : l'expéditeur est une adresse **Yahoo ou Gmail**. Ces services refusent qu'un autre serveur envoie en leur nom. Solution durable : une adresse à ton nom de domaine (ex. contact@secretdemarylinebeauty.fr), puis Brevo › Expéditeurs, domaines › **Authentifier le domaine** (Brevo donne les lignes DNS à copier chez ton fournisseur de domaine).
