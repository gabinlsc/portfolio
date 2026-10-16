# glsc.fr

Sites statiques de [glsc.fr](https://glsc.fr), dans un style néo-brutaliste cartoon.

| Dossier du dépôt | Site | Racine sur le VPS |
|---|---|---|
| `index.html` | [glsc.fr](https://glsc.fr) — le Hub | `/var/www/html/index.php` |
| `cv/` | [cv.glsc.fr](https://cv.glsc.fr) — CV (version A4 avec Ctrl + P) | `/var/www/html/cv/index.php` |
| `projets/` | [share.glsc.fr](https://share.glsc.fr) — Projets | `/var/www/share.glsc.fr/` |
| `games/` | [games.glsc.fr](https://games.glsc.fr) — Salle de jeux | `/var/www/games.glsc.fr/` |
| `old/` | [old.glsc.fr](https://old.glsc.fr) — Archives | `/var/www/old.glsc.fr/` |
| `status/` | [status.glsc.fr](https://status.glsc.fr) — Statut des services | `/var/www/status.glsc.fr/` |
| `deploy/games/` | [plus4](https://plus4.glsc.fr), [president](https://president.glsc.fr), [petitbac](https://petitbac.glsc.fr), [vortex](https://vortex.glsc.fr).glsc.fr — jeux en ligne (uno.glsc.fr redirige vers plus4) | `/opt/glsc-games/` (Docker) |
| `admin/` | [admin.glsc.fr](https://admin.glsc.fr) — espace privé, et [click.glsc.fr](https://click.glsc.fr) — liens courts | `/var/www/admin.glsc.fr/`, `/opt/glsc-admin/` |

Fichiers communs copiés dans chaque racine : `assets/_glsc/` (polices, icônes, CSS et JS des pages), `errors/404.html`, `seo/<site>/robots.txt` et `sitemap.xml`.

La page 404 (`errors/404.html`) sert à tous les sites : copiée dans chaque racine statique, et dans `/var/www/glsc-errors/` pour les jeux, l'admin et les liens courts (`deploy/nginx/glsc-404.inc`). Elle s'adapte au site et à l'adresse demandée, et cache quelques secrets (code Konami, terminal avec « : », chiffres à casser…). Elle est autonome : après l'avoir modifiée, `npm run build:404` recalcule les empreintes de sa CSP.
Aucune ressource externe : tout est servi depuis le VPS.

La page Projets affiche l'activité GitHub de chaque dépôt (dernier commit, langages, commits sur 30 jours) : la sonde de l'admin écrit `/var/www/share.glsc.fr/github.json` toutes les 15 minutes, sans jeton, en ne redemandant le détail d'un dépôt qu'après un nouveau push.

## Déployer

En root sur le VPS (deploy5 inclut deploy4, qui inclut deploy3, qui inclut deploy2) :

```bash
curl -fsSL https://raw.githubusercontent.com/gabinlsc/portfolio/main/deploy/deploy5.sh | bash
```

Pour mettre à jour seulement l'admin (plus rapide) : `curl -fsSL …/deploy5.sh | GLSC_ONLY_ADMIN=1 bash`.

Les scripts sauvegardent tout ce qu'il remplace dans `/root/glsc-backups/<date>/`, restaure la config nginx si `nginx -t` échoue, et vérifie chaque site à la fin.

### Déploiement automatique

Une fois deploy5 lancé une première fois, chaque push sur `main` met le serveur à jour tout seul :

| Dépôt | Ce qui est relancé |
| --- | --- |
| `portfolio` | deploy3 puis deploy5 `GLSC_ONLY_ADMIN=1` (sites, status, admin) ; deploy5 complet si `deploy/games/`, `deploy/deploy4.sh` ou un modèle nginx de jeu change |
| `plus4`, `president`, `petitbac`, `vortex-fps` | deploy4 `GLSC_ONLY_GAME=<jeu>` : seul ce jeu est reconstruit et relancé |

- GitHub appelle `https://admin.glsc.fr/hooks/github` (webhook signé par HMAC-SHA256, secret dans `/etc/glsc-admin/github-webhook.secret`). PHP vérifie la signature et ne fait que déposer une demande dans `/var/lib/glsc-admin/deploy/`.
- `glsc-deploy.path` réveille `glsc-deploy.service` (root), qui télécharge le dépôt et lance uniquement les scripts prévus pour la cible (liste blanche). Plusieurs pushes rapprochés sur un même dépôt ne donnent qu'un déploiement.
- Historique, journaux complets, bouton « Déployer maintenant » et marche à suivre pour créer les webhooks : admin → GitHub & déploiements. Résultat sur Discord (alerte « déploiement »).
- **Retour arrière automatique** : deploy4 garde l'image du jeu en service (`glsc/<jeu>:previous`) et la remet si le nouveau jeu ne répond pas dans les 40 s. Pour le portfolio, la sonde vérifie glsc.fr, admin.glsc.fr et status.glsc.fr après le déploiement ; en cas d'échec elle relance les scripts avec la dernière version qui avait réussi. Le déploiement apparaît « annulé, ancienne version remise » dans l'admin, et une alerte orange part sur Discord.
- Journal système : `journalctl -u glsc-deploy -n 50`.

### Classements des jeux

- +4, Président, Petit Bac et Vortex écrivent chaque partie (ou manche) terminée dans `/var/lib/glsc-games/<jeu>/results.jsonl` (variable `RESULTS_FILE`, seul dossier modifiable des conteneurs). Seuls les humains encore à la table sont comptés.
- La sonde de l'admin lit ces fichiers chaque minute et publie `/var/www/games.glsc.fr/leaderboard.json` : top 10 par jeu, sur 7 jours et depuis toujours (victoires ; places de président et « abonné au trou du cul » ; éliminations pour Vortex).
- **Succès** (16, dont « Première victoire », « Série de 3 », « Président ! », « Manche parfaite » à Vortex, « Touche-à-tout »…) : la sonde rejoue l'historique des parties et publie, dans `leaderboard.json`, qui a débloqué quoi. Les emojis apparaissent à côté des pseudos du classement, et la liste des succès de chaque jeu s'affiche dessous (nombre de joueurs, dernier à l'avoir obtenu). Liste et conditions : `ACHIEVEMENTS` dans `admin/collector/glsc_admin_collect.py`.
- **Saisons** : onglet « Ce mois-ci » (mois civil, heure de Paris) dans chaque classement, et **hall des champions** : à chaque fin de mois, le meilleur joueur de chaque jeu (au moins 3 parties et une victoire ou une élimination) est inscrit au hall ; un profil garde un titre permanent « Champion +4 · septembre 2026 » sur sa fiche.
- **Défi du jour** : un défi par jour, le même pour tous (« Gagne une partie de +4 », « Joue 3 manches du Président »…, tiré selon la date parmi `CHALLENGES`). Connecté, on voit sa progression, sa série de jours consécutifs et son record ; deux succès (« Défi relevé », « Assidu » à 7 jours d'affilée).
- **Historique** : les 20 dernières parties de chaque profil (jeu, rang, nombre de joueurs, autres joueurs ayant un profil) sur la page de profil.
- Pseudos par défaut (« Joueur 2 »…) et injurieux filtrés automatiquement ; n'importe quel pseudo peut être masqué depuis l'admin (Jeux en direct → Classements).

### Profils des joueurs

- Page [games.glsc.fr/profil](https://games.glsc.fr/profil/) : un profil réserve un pseudo (personne d'autre ne peut le prendre, même avec une autre casse ou des accents) et regroupe les parties, stats et succès de tous les jeux. Pas d'e-mail, pas de mot de passe : un **code de récupération** (120 bits, affiché une seule fois) sert à se reconnecter ailleurs.
- Service `profiles` (conteneur durci, `deploy/games/profiles/server.mjs`, aucune dépendance) : le serveur ne garde que l'**empreinte SHA-256** du code et de chaque cookie de session. Cookie `glsc_sid` : aléatoire (256 bits), `HttpOnly`, `Secure`, `SameSite=Lax`, valable sur `*.glsc.fr` pour suivre le joueur d'un jeu à l'autre ; 10 sessions par profil, déconnexion « partout », nouveau code, renommage (1 par semaine), suppression (les parties du profil disparaissent des classements).
- Écritures acceptées uniquement depuis nos pages (en-tête `Origin`), JSON de 2 Ko maximum, limitation de débit par adresse (création, récupération, lecture), comparaison en temps constant, aucun secret dans les journaux. Pseudos : lettres latines seulement (pas d'homoglyphes cyrilliques), mêmes filtres que les classements.
- Deux écoutes : publique (`https://games.glsc.fr/api/profile/…`, via nginx) et interne (`http://profiles:3301/identify`, réseau Docker), que les serveurs de jeu appellent à chaque connexion avec le cookie : profil reconnu → pseudo imposé et identifiant `pid` ajouté au résultat de la partie ; invité → son pseudo ne doit pas être celui d'un profil.
- La sonde regroupe les classements par profil (renommer ne perd rien ; l'historique joué sous un pseudo avant de le réserver est rattaché à son profil) et publie `players.json` (fiches publiques : stats et succès). Si le service est coupé, tout continue comme avant, par pseudo.
- **Équipes** : un profil crée une équipe (jusqu'à 5 par profil, 20 membres), partage son code `EQ-XXXX-XXXX` (40 bits, essais limités) et voit le classement privé de ses membres (victoires du mois et au total, calculées à partir de `players.json` que le service lit en lecture seule dans `/site`). Le créateur peut retirer un membre, changer le code, supprimer l'équipe ; s'il part, le plus ancien membre prend la suite ; supprimer son profil fait quitter ses équipes. Un non-membre ne peut pas savoir si une équipe existe (404 identique).
- **Signalements de bugs** : le bouton « 🐞 Un bug ? » des jeux envoie un message (3 à 600 caractères, connecté ou non) à `POST /api/profile/report`, avec le jeu, le code du salon, la phase et le navigateur, **jamais l'adresse IP** (5 par 10 min et par adresse). Le service les écrit dans `reports.jsonl` ; la sonde les relaie sur Discord (alerte « Un joueur signale un bug », désactivable ; texte neutralisé : pas de mention, pas de blocs de code cassés) et garde les 60 derniers pour l'admin.
- Test : `node --test deploy/games/profiles/server.test.mjs`. Données : `/var/lib/glsc-games/profiles/profiles.json` (incluses dans les sauvegardes chiffrées).

### Récap Discord

- Chaque lundi à 9 h, la sonde envoie sur Discord le récap de la semaine écoulée : visites (et évolution), sources, CV et projets cliqués, parties et champions des jeux, commits et déploiements, incidents, tentatives SSH, disque et certificats. Désactivable dans l'admin (Réglages → « Récap de la semaine »).
- À la demande, en root sur le serveur : `glsc-recap` (7 derniers jours), `glsc-recap --semaine` (semaine dernière complète), `glsc-recap --apercu` (affiche sans envoyer). Ou depuis l'admin : Réglages → « Récap des 7 derniers jours ».

### SSH

`glsc-ssh-harden` (en root, installé par deploy5) coupe la connexion par mot de passe et met fail2ban au régime sévère (sshd : 4 essais → 1 h ; récidivistes : 3 bans en un jour → 1 semaine). Il refuse de s'appliquer sans clé valide dans `/root/.ssh/authorized_keys`, demande de confirmer qu'une connexion par clé a été testée dans un autre terminal, valide la config (`sshd -t`), recharge sans couper les sessions ouvertes et revient en arrière si le résultat n'est pas celui attendu. `--status` montre l'état, `--undo` remet le mot de passe, `--fail2ban` ne touche que fail2ban. Installer une clé (depuis ton PC) : `ssh-keygen -t ed25519`, puis `ssh-copy-id root@87.106.8.177` (sous Windows PowerShell : `type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@87.106.8.177 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"`).

### Sauvegardes chiffrées

- Chaque nuit vers 3 h 30 (`glsc-backup.timer`), la sonde archive la base de l'admin (copie SQLite cohérente), les classements des jeux, les identifiants et secrets de `/etc/glsc-admin`, la config nginx, les certificats Let's Encrypt et les unités systemd, puis chiffre le tout avec [age](https://age-encryption.org) et une clé **publique** (`/etc/glsc-backup/recipient`). Le serveur ne peut donc pas relire ses propres sauvegardes : la clé privée n'y reste jamais.
- Mise en route, une seule fois, en root : `glsc-backup-setup` (affiche la clé privée une fois, à ranger dans ton gestionnaire de mots de passe) ou `glsc-backup-setup --recipient age1…` avec une clé générée chez toi.
- Copie hors du serveur : `glsc-backup-setup --rclone mon-stockage:glsc` (tout stockage géré par rclone : S3, IONOS Object Storage, SFTP, Drive…) ou `--discord` (archives de 8 Mo maximum, sur le salon des alertes). 14 archives sont gardées sur le serveur (`/var/backups/glsc`), 60 jours chez rclone.
- État, bouton « Sauvegarder maintenant » et alerte Discord en cas d'échec : admin → Réglages. En ligne de commande : `glsc-backup-setup --status`, `journalctl -u glsc-backup -n 30`.
- Restaurer, sur n'importe quelle machine : `age -d -i cle.txt glsc-AAAAMMJJ-HHMMSS.tar.gz.age | tar -xz -C /tmp/restauration`, puis recopier ce qu'il faut (la base de l'admin est dans `bases/`).

## Modifier les pages

- Le Hub utilise Tailwind compilé : après avoir changé des classes dans `index.html`, lancer `npm install` puis `npm run build:css`.
- Après avoir ajouté une icône (`<i data-lucide="nom">`), lancer `npm run build:icons`.
- `npm run build` fait les deux.

## status.glsc.fr

- `status/collector/glsc_status.py` : sonde sans dépendance (Python 3.8+), lancée chaque minute par `glsc-status.timer`.
  Elle teste les cibles de `status/targets.json` (HTTP ou port TCP, même format que Serv-Pulse), garde 24 h de mesures
  minute par minute et 90 jours d'agrégats dans `/var/lib/glsc-status/state.json`, puis écrit `status.json` pour la page.
- Un incident s'ouvre après 2 échecs d'affilée. Alertes Discord : mettre l'URL du webhook dans `/etc/glsc-status/discord-webhook`.
- Ajouter un service : une ligne dans `status/targets.json`, puis relancer deploy3.
- Logs de la sonde : `journalctl -u glsc-status -n 50`.

## Jeux en ligne

- Un conteneur Docker par jeu (`deploy/games/compose.yml`), construit depuis les dépôts GitHub `plus4`, `president`, `petitbac` et `vortex-fps`. Le service de +4 garde l'identifiant interne `uno` (conteneur `glsc-games-uno-1`, résultats, `GLSC_ONLY_GAME=uno`) pour ne pas perdre l'historique.
- Conteneurs durcis : lecture seule, aucun privilège, utilisateur non-root, mémoire limitée, ports ouverts uniquement sur `127.0.0.1`.
- nginx relaie HTTPS et WebSocket ; limitation de débit par IP (`deploy/nginx/glsc-games.conf`).
- Vortex tourne en mode serveur ouvert (joueurs anonymes, 16 max) ; son client statique est servi par nginx.
- Mettre les jeux à jour : relancer deploy4 (il récupère la dernière version de chaque dépôt).
- Logs : `docker logs -f glsc-games-uno-1` (ou `president-1`, `vortex-1`).

## admin.glsc.fr

Espace privé (voir `admin/README.md`) : kanban, notes et liens, alternance, trafic de tous les sites, stats du CV et des projets,
liens courts, santé du serveur, sécurité, jeux en direct, GitHub et déploiements, partage de fichiers, coffre chiffré, mini-outils.

- Connexion : mot de passe + code 2FA (ou code de secours). Identifiants : `glsc-admin-setup` sur le serveur.
- Une sonde root (`glsc-admin-collect.timer`, chaque minute) lit les logs et l'état du serveur ; le site PHP ne fait que lire ses résultats.
- Prérequis DNS : enregistrements A `admin.glsc.fr` et `click.glsc.fr` vers le VPS.
