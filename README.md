# glsc.fr

Sites statiques de [glsc.fr](https://glsc.fr), dans un style néo-brutaliste cartoon.

| Dossier du dépôt | Site | Racine sur le VPS |
|---|---|---|
| `index.html` | [glsc.fr](https://glsc.fr) — le Hub | `/var/www/html/index.php` |
| `cv/` | [cv.glsc.fr](https://cv.glsc.fr) — CV (version A4 avec Ctrl + P) | `/var/www/html/cv/index.php` |
| `projets/` | [share.glsc.fr](https://share.glsc.fr) — Projets | `/var/www/share.glsc.fr/` |
| `games/` | [games.glsc.fr](https://games.glsc.fr) — Salle de jeux | `/var/www/games.glsc.fr/` |
| `old/` | [old.glsc.fr](https://old.glsc.fr) — Archives | `/var/www/old.glsc.fr/` |

Fichiers communs copiés dans chaque racine : `assets/_glsc/` (polices, icônes, CSS et JS des pages), `errors/404.html`, `seo/<site>/robots.txt` et `sitemap.xml`.
Aucune ressource externe : tout est servi depuis le VPS.

## Déployer

En root sur le VPS :

```bash
curl -fsSL https://raw.githubusercontent.com/gabinlsc/portfolio/main/deploy/deploy2.sh | bash
```

Le script sauvegarde tout ce qu'il remplace dans `/root/glsc-backups/<date>/`, restaure la config nginx si `nginx -t` échoue, et vérifie chaque site à la fin.

## Modifier les pages

- Le Hub utilise Tailwind compilé : après avoir changé des classes dans `index.html`, lancer `npm install` puis `npm run build:css`.
- Après avoir ajouté une icône (`<i data-lucide="nom">`), lancer `npm run build:icons`.
- `npm run build` fait les deux.
