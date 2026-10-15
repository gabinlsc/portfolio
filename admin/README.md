# admin.glsc.fr

Hub privé de glsc.fr, en PHP 8 + SQLite sans framework, interface en JavaScript sans étape de build.
Installé et mis à jour par `deploy/deploy5.sh`.

## Organisation

| Dossier | Rôle | Sur le serveur |
|---|---|---|
| `public/` | point d'entrée `index.php` et interface (`assets/`) | `/var/www/admin.glsc.fr/` |
| `click/` | point d'entrée de click.glsc.fr (liens courts) | `/var/www/click.glsc.fr/` |
| `lib/` | tout le code PHP : connexion, API (`lib/modules/*.php`), pages | `/opt/glsc-admin/lib/` |
| `bin/glsc-admin-setup` | crée ou change mot de passe, 2FA et codes de secours | `/usr/local/sbin/` |
| `collector/` | sonde root : logs nginx, santé, Docker, SSH, GitHub, alertes Discord | `/opt/glsc-admin/` |
| `systemd/` | `glsc-admin-collect.timer` (chaque minute), `glsc-admin-queue.path` (demandes de l'admin) | `/etc/systemd/system/` |

Données (jamais effacées par les scripts) :

- `/etc/glsc-admin/auth.json` : empreinte du mot de passe (argon2id), secret 2FA, empreintes des codes de secours ;
- `/var/lib/glsc-admin/app/` : base `app.db` et fichiers partagés (propriétaire www-data) ;
- `/var/lib/glsc-admin/pub/` : mesures publiées par la sonde (lecture seule pour www-data) ;
- `/var/lib/glsc-admin/queue/` : demandes de l'admin à la sonde (message Discord, redémarrage d'un jeu en liste blanche).

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
