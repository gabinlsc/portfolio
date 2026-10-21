#!/usr/bin/env bash
# deploy2 — met en ligne la version « main » du dépôt sur le VPS. Remplace deploy.sh.
#
# Usage (en root sur le VPS) :
#   curl -fsSL https://raw.githubusercontent.com/gabinlsc/portfolio/main/deploy/deploy2.sh | bash
#
# Ce que fait le script, dans l'ordre :
#   1. télécharge le dépôt entier (archive GitHub, pas de cache de 5 min) ;
#   2. sauvegarde tout ce qu'il va remplacer dans /root/glsc-backups/<date>/ ;
#   3. met à jour les 5 sites + les fichiers communs (/_glsc, 404.html, robots.txt, sitemap.xml) ;
#   4. applique les réglages nginx (en-têtes de sécurité, page 404, games.glsc.fr statique) ;
#      si « nginx -t » échoue, TOUTE la config nginx touchée est restaurée ;
#   5. vérifie chaque site.
# Il est relançable autant de fois que nécessaire.

set -euo pipefail

REPO_TGZ="https://codeload.github.com/gabinlsc/portfolio/tar.gz/refs/heads/main"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/root/glsc-backups/$STAMP"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

HUB=/var/www/html
CV=/var/www/html/cv
OLD=/var/www/old.glsc.fr
SHARE=/var/www/share.glsc.fr
GAMES=/var/www/games.glsc.fr
NGX=/etc/nginx
GAMES_CONF="$NGX/sites-enabled/games.glsc.fr"
SEC_CONF="$NGX/conf.d/glsc-security.conf"
TOKENS_CONF="$NGX/conf.d/glsc-server-tokens.conf"

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
info() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✘ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Lance ce script en root."
mkdir -p "$BACKUP"

# ---------------------------------------------------------------- outils
save() {                      # sauvegarde un fichier/dossier (chemin absolu) s'il existe
  [ -e "$1" ] || return 0
  mkdir -p "$(dirname "$BACKUP$1")"
  cp -a "$1" "$BACKUP$1"
}
put() {                       # put <fichier du dépôt> <destination>
  [ -s "$SRC/$1" ] || die "Fichier manquant dans le dépôt : $1"
  save "$2"
  install -m 644 "$SRC/$1" "$2"
}
reset_site_dir() {            # déplace en sauvegarde un dossier qui ne contient pas encore notre page
  local dir="$1" marker="$2"
  if [ -f "$dir/index.html" ] && grep -q "$marker" "$dir/index.html"; then return 0; fi
  if [ -d "$dir" ]; then
    mkdir -p "$(dirname "$BACKUP$dir")"
    mv "$dir" "$BACKUP$dir"
    warn "ancien contenu de $dir déplacé dans $BACKUP$dir"
  fi
  mkdir -p "$dir"
}
common_files() {              # common_files <racine> <dossier seo>
  local root="$1" seo="$2"
  save "$root/_glsc"
  rm -rf "${root:?}/_glsc"
  cp -r "$SRC/assets/_glsc" "$root/_glsc"
  find "$root/_glsc" -type d -exec chmod 755 {} + ; find "$root/_glsc" -type f -exec chmod 644 {} +
  put errors/404.html "$root/404.html"
  put assets/_glsc/favicon.ico "$root/favicon.ico"                 # navigateurs et robots qui demandent /favicon.ico
  put assets/_glsc/apple-touch-icon.png "$root/apple-touch-icon.png"
  put "seo/$seo/robots.txt" "$root/robots.txt"
  put "seo/$seo/sitemap.xml" "$root/sitemap.xml"
}

# ---------------------------------------------------------------- 1. téléchargement
info "1/6 Téléchargement du dépôt"
curl -fsSL "$REPO_TGZ" | tar -xz -C "$WORK"
SRC="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
for f in index.html cv/index.html old/index.html projets/index.html projets/etudes/salle-de-jeux/index.html projets/etudes/plus4/index.html projets/etudes/president/index.html projets/etudes/petit-bac/index.html games/index.html games/profil/index.html games/nouveautes/index.html errors/404.html deploy/install-404.sh \
         assets/_glsc/icons.js assets/_glsc/hub.css assets/_glsc/fonts.css assets/_glsc/favicon.svg assets/_glsc/favicon.ico assets/_glsc/apple-touch-icon.png deploy/nginx/glsc-security.conf deploy/nginx/games.glsc.fr.conf; do
  [ -s "$SRC/$f" ] || die "Archive incomplète : $f manquant. Rien n'a été modifié."
done
ok "archive complète ($(basename "$SRC"))"

# ---------------------------------------------------------------- 2-3. sites
info "2/6 Hub (glsc.fr) et CV (cv.glsc.fr)"
put index.html "$HUB/index.php"
put og.png "$HUB/og.png"
common_files "$HUB" glsc.fr
if [ -f "$HUB/index.nginx-debian.html" ]; then
  save "$HUB/index.nginx-debian.html"; rm -f "$HUB/index.nginx-debian.html"
  ok "page par défaut de nginx retirée"
fi
ok "Hub"
put cv/index.html "$CV/index.php"
common_files "$CV" cv.glsc.fr
ok "CV (photocv.jpg conservée)"

info "3/6 Archives, Projets, Salle de jeux"
put old/index.html "$OLD/index.html"
common_files "$OLD" old.glsc.fr
ok "Archives (old.glsc.fr)"

if grep -A3 -E '^\s*location\s+/\s*\{' "$NGX/sites-enabled/share.glsc.fr" 2>/dev/null | grep -q proxy_pass; then
  warn "share.glsc.fr passe par une application (proxy_pass) : page Projets NON installée."
else
  reset_site_dir "$SHARE" "Projets · Gabin Lescoat"
  put projets/index.html "$SHARE/index.html"
  for e in salle-de-jeux plus4 president petit-bac; do mkdir -p "$SHARE/etudes/$e"; put "projets/etudes/$e/index.html" "$SHARE/etudes/$e/index.html"; install -m 644 "$SHARE/etudes/$e/index.html" "$SHARE/etudes/$e/index.php"; done   # index.php comme à la racine : ce site ne cherche que lui dans un dossier
  install -m 644 "$SHARE/index.html" "$SHARE/index.php"
  common_files "$SHARE" share.glsc.fr
  chown -R www-data:www-data "$SHARE"
  ok "Projets (share.glsc.fr)"
fi

reset_site_dir "$GAMES" "Salle de jeux · GLSC.fr"
put games/index.html "$GAMES/index.html"
mkdir -p "$GAMES/profil"
put games/profil/index.html "$GAMES/profil/index.html"
mkdir -p "$GAMES/nouveautes"
put games/nouveautes/index.html "$GAMES/nouveautes/index.html"
common_files "$GAMES" games.glsc.fr
chown -R www-data:www-data "$GAMES"
ok "Salle de jeux (games.glsc.fr)"
bash "$SRC/deploy/install-404.sh" "$SRC"
ok "page 404 commune (jeux, admin, liens courts) dans /var/www/glsc-errors"
# glsc.fr, cv et old ont dans leur vhost « error_page 404 /errors/404.html » servie depuis $HUB/errors :
# on remplace aussi cette page-là (l'ancienne est sauvegardée), sans toucher aux vhosts
if [ -f "$HUB/errors/404.html" ]; then
  put errors/404.html "$HUB/errors/404.html"
  ok "page 404 des anciens vhosts ($HUB/errors/404.html)"
fi

# ---------------------------------------------------------------- 4. nginx
info "4/6 Configuration nginx"
GAMES_REAL="$(readlink -f "$GAMES_CONF")"
NGX_SNAPSHOT="$WORK/nginx-before"
mkdir -p "$NGX_SNAPSHOT"
cp -a "$NGX/conf.d" "$NGX_SNAPSHOT/conf.d"
[ -f "$GAMES_REAL" ] && cp -a "$GAMES_REAL" "$NGX_SNAPSHOT/games.conf"
save "$GAMES_REAL"; save "$SEC_CONF"; save "$TOKENS_CONF"

restore_nginx() {
  rm -rf "${NGX:?}/conf.d" && cp -a "$NGX_SNAPSHOT/conf.d" "$NGX/conf.d"
  [ -f "$NGX_SNAPSHOT/games.conf" ] && cp -a "$NGX_SNAPSHOT/games.conf" "$GAMES_REAL"
}

if grep -qE '^\s*include\s+/etc/nginx/conf\.d/\*\.conf' "$NGX/nginx.conf"; then
  install -m 644 "$SRC/deploy/nginx/glsc-security.conf" "$SEC_CONF"
  # server_tokens : seulement s'il n'est pas déjà réglé ailleurs (sinon doublon = erreur)
  if grep -rqsE '^\s*server_tokens\s' "$NGX/nginx.conf" "$NGX/sites-enabled/" \
     $(find "$NGX/conf.d" -name '*.conf' ! -name "$(basename "$TOKENS_CONF")"); then
    rm -f "$TOKENS_CONF"
  else
    echo 'server_tokens off; # masque la version de nginx' > "$TOKENS_CONF"
  fi
  # error_page 404 déjà défini au niveau http ? on retire la nôtre pour éviter un conflit
  if grep -qE '^\s*error_page\s+[0-9 ]*404' "$NGX/nginx.conf"; then
    sed -i '/^error_page 404/d' "$SEC_CONF"
  fi
else
  warn "nginx.conf n'inclut pas conf.d/*.conf : en-têtes de sécurité non appliqués."
fi
install -m 644 "$SRC/deploy/nginx/games.glsc.fr.conf" "$GAMES_REAL"

if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
  ok "nginx -t OK, nginx rechargé (en-têtes de sécurité, page 404, games.glsc.fr statique)"
else
  warn "nginx refuse la nouvelle config :"
  nginx -t 2>&1 | sed 's/^/      /' | tail -6 || true
  restore_nginx
  nginx -t >/dev/null 2>&1 && systemctl reload nginx
  warn "ancienne config nginx restaurée — les pages, elles, sont bien à jour."
fi

# ---------------------------------------------------------------- 5. vérifications
info "5/6 Vérification des sites"
for url in https://glsc.fr https://cv.glsc.fr https://old.glsc.fr https://share.glsc.fr https://games.glsc.fr \
           https://glsc.fr/og.png https://glsc.fr/_glsc/icons.js https://glsc.fr/robots.txt; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)"
  [ "$code" = 200 ] && ok "$code  $url" || warn "$code  $url"
done
code="$(curl -s -o "$WORK/404" -w '%{http_code}' https://glsc.fr/cette-page-n-existe-pas || true)"
if [ "$code" = 404 ] && grep -q "s'est perdue" "$WORK/404"; then ok "404 personnalisée"; else warn "404 : code $code (page par défaut de nginx ?)"; fi
if curl -sI https://glsc.fr | grep -qi '^strict-transport-security'; then ok "en-têtes de sécurité présents"; else warn "en-têtes de sécurité absents"; fi

info "6/6 Terminé"
echo "  Sauvegardes : $BACKUP"
echo "  Ouvre les sites avec Ctrl + F5 pour vider le cache du navigateur."
