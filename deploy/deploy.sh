#!/usr/bin/env bash
# Déploie les pages de glsc.fr depuis la branche main du dépôt GitHub.
#
# Usage (en root sur le VPS) :
#   curl -fsSL https://raw.githubusercontent.com/gabinlsc/portfolio/main/deploy/deploy.sh | bash
#
# Chaque fichier remplacé est d'abord sauvegardé dans /root/glsc-backups/<date>/.
# Si nginx refuse la nouvelle config de games.glsc.fr, l'ancienne est remise en place.

set -euo pipefail

RAW="https://raw.githubusercontent.com/gabinlsc/portfolio/main"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/root/glsc-backups/$STAMP"

HUB=/var/www/html
CV=/var/www/html/cv
OLD=/var/www/old.glsc.fr
SHARE=/var/www/share.glsc.fr
GAMES=/var/www/games.glsc.fr
GAMES_CONF=/etc/nginx/sites-enabled/games.glsc.fr

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
info() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Lance ce script en root."; exit 1; }
mkdir -p "$BACKUP"

# Télécharge $1 (chemin dans le dépôt) vers $2, avec contrôle du contenu.
fetch() {
  local tmp
  tmp="$(mktemp)"
  curl -fsSL "$RAW/$1" -o "$tmp"
  if [[ "$1" == *.html ]] && ! grep -q '</html>' "$tmp"; then
    rm -f "$tmp"; echo "Fichier incomplet : $1"; exit 1
  fi
  install -m 644 "$tmp" "$2"
  rm -f "$tmp"
}

# Sauvegarde un fichier ou un dossier s'il existe.
save() {
  [ -e "$1" ] || return 0
  local dest="$BACKUP$1"
  mkdir -p "$(dirname "$dest")"
  cp -a "$1" "$dest"
}

# Vide un dossier de site (après l'avoir déplacé en sauvegarde) sauf s'il contient déjà notre page.
reset_site_dir() {
  local dir="$1" marker="$2"
  if [ -f "$dir/index.html" ] && grep -q "$marker" "$dir/index.html"; then
    return 0
  fi
  if [ -d "$dir" ]; then
    mkdir -p "$BACKUP/var/www"
    mv "$dir" "$BACKUP$dir"
    warn "ancien contenu de $dir déplacé dans $BACKUP$dir"
  fi
  mkdir -p "$dir"
}

info "1/6 Hub (glsc.fr)"
save "$HUB/index.php"
fetch index.html "$HUB/index.php"
fetch og.png "$HUB/og.png"
ok "index.php et og.png"

info "2/6 CV (cv.glsc.fr)"
save "$CV/index.php"
fetch cv/index.html "$CV/index.php"
ok "index.php (photocv.jpg conservée)"

info "3/6 Archives (old.glsc.fr)"
save "$OLD/index.html"
fetch old/index.html "$OLD/index.html"
ok "index.html"

info "4/6 Projets (share.glsc.fr)"
if grep -qE '^\s*location\s+/\s*\{' /etc/nginx/sites-enabled/share.glsc.fr 2>/dev/null \
   && grep -A3 -E '^\s*location\s+/\s*\{' /etc/nginx/sites-enabled/share.glsc.fr | grep -q proxy_pass; then
  warn "share.glsc.fr passe par une application (proxy_pass) : page Projets NON installée."
  warn "Envoie la config à Claude : cat /etc/nginx/sites-enabled/share.glsc.fr"
else
  reset_site_dir "$SHARE" "Projets · Gabin Lescoat"
  fetch projets/index.html "$SHARE/index.html"
  cp "$SHARE/index.html" "$SHARE/index.php"
  chown -R www-data:www-data "$SHARE"
  ok "index.html (+ copie index.php)"
fi

info "5/6 Salle de jeux (games.glsc.fr)"
reset_site_dir "$GAMES" "Salle de jeux · GLSC.fr"
fetch games/index.html "$GAMES/index.html"
chown -R www-data:www-data "$GAMES"
ok "index.html"

CONF_REAL="$(readlink -f "$GAMES_CONF")"
save "$CONF_REAL"
fetch deploy/nginx/games.glsc.fr.conf "$CONF_REAL"
if nginx -t 2>/dev/null; then
  systemctl reload nginx
  ok "config nginx statique appliquée et nginx rechargé"
else
  cp -a "$BACKUP$CONF_REAL" "$CONF_REAL"
  nginx -t && systemctl reload nginx
  warn "nginx a refusé la nouvelle config : l'ancienne est remise en place."
  nginx -t 2>&1 | tail -5 || true
fi

info "6/6 Vérification"
for url in https://glsc.fr https://cv.glsc.fr https://old.glsc.fr https://share.glsc.fr https://games.glsc.fr https://glsc.fr/og.png; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)"
  printf '  %s  %s\n' "$code" "$url"
done

info "Terminé. Sauvegardes : $BACKUP"
echo "Ouvre les sites avec Ctrl + F5 pour vider le cache du navigateur."
