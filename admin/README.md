# admin.glsc.fr

Hub privé de glsc.fr, en PHP 8 + SQLite sans framework, interface en JavaScript sans étape de build.
Installé et mis à jour par `deploy/deploy5.sh`.

## Organisation

| Dossier | Rôle | Sur le serveur |
|---|---|---|
| `public/` | point d'entrée `index.php` et interface (`assets/`) | `/var/www/admin.glsc.fr/` |
| `click/` | point d'entrée de click.glsc.fr (liens courts) | `/var/www/click.glsc.fr/` |
| `gst/` | point d'entrée de gst.glsc.fr (espace StudioGLSC, voir plus bas) | `/var/www/gst.glsc.fr/` |
| `lib/` | tout le code PHP : connexion, API (`lib/modules/*.php`), pages | `/opt/glsc-admin/lib/` |
| `bin/glsc-admin-setup` | crée ou change mot de passe, 2FA et codes de secours (`--gst` pour l'espace StudioGLSC) | `/usr/local/sbin/` |
| `bin/glsc-gst-import` | copie unique des devis, factures et réglages de l'admin vers gst | `/usr/local/sbin/` |
| `collector/` | sonde root : logs nginx, santé, Docker, SSH, GitHub, alertes Discord | `/opt/glsc-admin/` |
| `systemd/` | `glsc-admin-collect.timer` (chaque minute), `glsc-admin-queue.path` (demandes de l'admin) | `/etc/systemd/system/` |

Données (jamais effacées par les scripts) :

- `/etc/glsc-admin/auth.json` : empreinte du mot de passe (argon2id), secret 2FA, empreintes des codes de secours ;
- `/var/lib/glsc-admin/app/` : base `app.db` et fichiers partagés (propriétaire www-data) ;
- `/var/lib/glsc-admin/pub/` : mesures publiées par la sonde (lecture seule pour www-data) ;
- `/var/lib/glsc-admin/queue/` : demandes de l'admin à la sonde (message Discord, redémarrage d'un jeu en liste blanche).

## gst.glsc.fr : espace StudioGLSC

Même code que l'admin (`GLSC_ADMIN_INSTANCE=gst`, posé par `gst/index.php`), mais un espace à part, aux couleurs du kit de marque StudioGLSC (`public/assets/gst.css`, thème clair et sombre) :

- **Identifiants séparés** : `/etc/glsc-gst/auth.json`, créé par `glsc-admin-setup --gst` (mot de passe, 2FA et codes de secours propres à gst). Même mécanisme de connexion que l'admin (verrouillage, sessions de 2 h, CSRF) ; les cookies sont par domaine, une connexion à l'un n'ouvre pas l'autre.
- **Données séparées** : `/var/lib/glsc-gst/app/app.db` (même schéma, migrations identiques, sans le kanban ni les liens d'exemple). Comprise dans la sauvegarde chiffrée avec `/etc/glsc-gst`.
- **Modules** : `billing` (Devis & factures), `accounting` (Compta), `studio` (demandes et projets clients) et `gst` (accueil : ce qui demande une action). Aucune autre route de l'admin n'existe sur gst (le routeur ne charge que ces modules), ni fichiers partagés, ni webhook GitHub.
- **Partagé en lecture avec l'admin** : jeton du service studio (`/etc/glsc-admin/studio-token`), mesures de la sonde (`/var/lib/glsc-admin/pub`) et file d'alertes Discord.
- **Première mise en service** : enregistrement DNS A `gst.glsc.fr`, relancer deploy5 (ou laisser le déploiement automatique), puis `glsc-admin-setup --gst`, `glsc-gst-import --dry-run` et `glsc-gst-import`. L'import refuse de tourner si gst contient déjà des données et ne modifie jamais la base de l'admin. Dans l'admin, Devis & factures, Compta et StudioGLSC ne sont plus au menu (lien « Espace StudioGLSC » à la place) ; leurs pages restent joignables par `#/billing`, `#/accounting` et `#/studio` jusqu'au retrait du code, après validation de l'import. Les alertes Discord de demandes et de messages clients mènent à gst.glsc.fr.
- Tests : `php admin/tests/gst_test.php`.

## Devis & factures

Module `billing` (menu « Devis & factures » de gst.glsc.fr ; plus dans le menu de l'admin, mais encore joignable par `#/billing` tant que l'import n'est pas validé) : clients professionnels, devis, factures d'acompte, de solde ou complètes, avoirs. Les documents émis reçoivent un numéro continu (D-AAAA-NNN, F-AAAA-NNN, A-AAAA-NNN) et un instantané figé (vendeur, client, lignes) : ils ne se modifient plus, une facture se corrige par un avoir. TVA non applicable (art. 293 B du CGI). L'aperçu s'imprime en PDF depuis le navigateur. Données dans `app.db` (tables `bill_clients` et `bill_docs`, comprises dans la sauvegarde chiffrée). Code : `lib/billing.php` (règles, testables), `lib/modules/billing.php` (API), `public/assets/modules/billing.js` (interface). Mode test (activé par défaut) : les documents créés sont marqués TEST, numérotés à part (TEST-D-AAAA-NNN), émissibles sans SIRET, exclus du chiffre d'affaires et supprimables avec trois validations (deux confirmations puis saisie du numéro ou de « SUPPRIMER LES TESTS »). Les documents réels ne se suppriment jamais. Tests : `php admin/tests/billing_test.php`.

## Compta

Module `accounting` (menu « Compta » de gst.glsc.fr) pour la micro-entreprise, à partir des factures réelles payées du module Devis & factures (les documents de test n'y entrent jamais) :
- **Tableau de bord** : chiffre d'affaires encaissé, cotisations estimées, dépenses, résultat estimé, à encaisser, graphique mensuel, meilleurs clients, plafond de la micro-entreprise et seuils de franchise de TVA, prochaine déclaration, rappels (CFE, impôt, facturation électronique).
- **Recettes** : le livre des recettes (obligatoire), généré automatiquement, imprimable en PDF, export CSV. Un avoir émis sur une facture déjà payée apparaît comme un remboursement négatif.
- **Dépenses** : suivi facultatif par catégorie, export CSV.
- **Déclarations** : périodes mensuelles ou trimestrielles, cotisations estimées (taux, ACRE, versement libératoire), état (à déclarer, en retard, déclarée, payée) et ce que tu as déclaré et payé.
- **Exports** : CSV (recettes, factures, dépenses), archive JSON complète (documents figés, clients, dépenses, déclarations) pour la conservation de 10 ans, bilan annuel imprimable.
- **Réglages** : catégorie d'activité, fréquence, taux et seuils (valeurs 2026 par défaut, toutes modifiables : à vérifier sur autoentrepreneur.urssaf.fr).
Les e-mails d'envoi des devis et factures et les relances (rappel, relance ferme, mise en demeure) sont dans l'aperçu d'un document de « Devis & factures ». Code : `lib/accounting.php` (calculs, testables), `lib/modules/accounting.php` (API et exports), `public/assets/modules/accounting.js` (interface). Tests : `php admin/tests/accounting_test.php`. Données : tables `bill_expenses` et `bill_declarations` (migration 4), comprises dans la sauvegarde chiffrée.

## Sécurité

- Mot de passe + code TOTP (codes rejoués refusés) ou code de secours à usage unique.
- 5 échecs par IP (ou 30 au total) en 15 min bloquent la connexion ; nginx limite aussi `/login` à 10 requêtes/min.
- Session : cookie `__Host-`, `Secure`, `HttpOnly`, `SameSite=Strict`, 2 h d'inactivité, 12 h maximum ; jeton CSRF sur toute modification.
- CSP stricte (aucun script inline ni ressource externe), interface construite sans `innerHTML`.
- Le coffre est chiffré dans le navigateur (AES-GCM, clé PBKDF2 600 000 itérations) : le serveur ne voit jamais les secrets.
- Le site web n'a aucun droit sur Docker ni sur les logs : il dépose des demandes que la sonde root filtre.

## Tester en local

```bash
cd admin/public && ln -sfn ../../assets/_glsc _glsc
GLSC_ADMIN_LIB=$PWD/../lib GLSC_ADMIN_ETC=/tmp/glsc/etc GLSC_ADMIN_VAR=/tmp/glsc/var GLSC_ADMIN_INSECURE=1 \
  php -S 127.0.0.1:8099 ../tests/dev-router.php
GLSC_ADMIN_ETC=/tmp/glsc/etc GLSC_ADMIN_LIB=$PWD/../lib php ../bin/glsc-admin-setup     # identifiants de test
python3 ../tests/make_fixture.py /tmp/glsc/access.log 30                                 # faux trafic
python3 ../collector/glsc_admin_collect.py collect --var /tmp/glsc/var --log /tmp/glsc/access.log --offline
```

Les icônes de l'interface (`public/assets/icons.js`) sont générées par `npm run build:icons`.
