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
| `deploy/games/` | [uno](https://uno.glsc.fr), [president](https://president.glsc.fr), [vortex](https://vortex.glsc.fr).glsc.fr — jeux en ligne | `/opt/glsc-games/` (Docker) |
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

- Un conteneur Docker par jeu (`deploy/games/compose.yml`), construit depuis les dépôts GitHub `uno`, `president` et `vortex-fps`.
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
