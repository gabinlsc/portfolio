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
| `deploy/games/` | [plus4](https://plus4.glsc.fr), [president](https://president.glsc.fr), [vortex](https://vortex.glsc.fr).glsc.fr — jeux en ligne (uno.glsc.fr redirige vers plus4) | `/opt/glsc-games/` (Docker) |
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
| `plus4`, `president`, `vortex-fps` | deploy4 `GLSC_ONLY_GAME=<jeu>` : seul ce jeu est reconstruit et relancé |

- GitHub appelle `https://admin.glsc.fr/hooks/github` (webhook signé par HMAC-SHA256, secret dans `/etc/glsc-admin/github-webhook.secret`). PHP vérifie la signature et ne fait que déposer une demande dans `/var/lib/glsc-admin/deploy/`.
- `glsc-deploy.path` réveille `glsc-deploy.service` (root), qui télécharge le dépôt et lance uniquement les scripts prévus pour la cible (liste blanche). Plusieurs pushes rapprochés sur un même dépôt ne donnent qu'un déploiement.
- Historique, journaux complets, bouton « Déployer maintenant » et marche à suivre pour créer les webhooks : admin → GitHub & déploiements. Résultat sur Discord (alerte « déploiement »).
- **Retour arrière automatique** : deploy4 garde l'image du jeu en service (`glsc/<jeu>:previous`) et la remet si le nouveau jeu ne répond pas dans les 40 s. Pour le portfolio, la sonde vérifie glsc.fr, admin.glsc.fr et status.glsc.fr après le déploiement ; en cas d'échec elle relance les scripts avec la dernière version qui avait réussi. Le déploiement apparaît « annulé, ancienne version remise » dans l'admin, et une alerte orange part sur Discord.
- Journal système : `journalctl -u glsc-deploy -n 50`.

### Classements des jeux

- +4, Président et Vortex écrivent chaque partie (ou manche) terminée dans `/var/lib/glsc-games/<jeu>/results.jsonl` (variable `RESULTS_FILE`, seul dossier modifiable des conteneurs). Seuls les humains encore à la table sont comptés.
- La sonde de l'admin lit ces fichiers chaque minute et publie `/var/www/games.glsc.fr/leaderboard.json` : top 10 par jeu, sur 7 jours et depuis toujours (victoires ; places de président et « abonné au trou du cul » ; éliminations pour Vortex).
- Pseudos par défaut (« Joueur 2 »…) et injurieux filtrés automatiquement ; n'importe quel pseudo peut être masqué depuis l'admin (Jeux en direct → Classements).

### Récap Discord

- Chaque lundi à 9 h, la sonde envoie sur Discord le récap de la semaine écoulée : visites (et évolution), sources, CV et projets cliqués, parties et champions des jeux, commits et déploiements, incidents, tentatives SSH, disque et certificats. Désactivable dans l'admin (Réglages → « Récap de la semaine »).
- À la demande, en root sur le serveur : `glsc-recap` (7 derniers jours), `glsc-recap --semaine` (semaine dernière complète), `glsc-recap --apercu` (affiche sans envoyer). Ou depuis l'admin : Réglages → « Récap des 7 derniers jours ».

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

- Un conteneur Docker par jeu (`deploy/games/compose.yml`), construit depuis les dépôts GitHub `plus4`, `president` et `vortex-fps`. Le service de +4 garde l'identifiant interne `uno` (conteneur `glsc-games-uno-1`, résultats, `GLSC_ONLY_GAME=uno`) pour ne pas perdre l'historique.
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
