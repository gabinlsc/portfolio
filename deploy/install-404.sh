#!/usr/bin/env bash
# Installe la page 404 commune pour les sites sans racine statique (jeux, admin.glsc.fr, click.glsc.fr).
# Appelé par deploy2.sh et deploy5.sh avec le dossier du dépôt téléchargé : install-404.sh <dépôt>
# N'active rien seul : ce sont les vhosts (modèles deploy/nginx/*.tpl) qui incluent /etc/nginx/glsc-404.inc.
set -euo pipefail
SRC="${1:?usage : install-404.sh <dossier du dépôt>}"
DIR=/var/www/glsc-errors
for f in errors/404.html assets/_glsc/fonts.css assets/_glsc/favicon.svg assets/_glsc/favicon-32.png assets/_glsc/apple-touch-icon.png deploy/nginx/glsc-404.inc; do
  [ -s "$SRC/$f" ] || { echo "install-404 : $f manquant" >&2; exit 1; }
done
install -d -m 755 "$DIR" "$DIR/_glsc"
install -m 644 "$SRC/errors/404.html" "$DIR/404.html"
install -m 644 "$SRC/assets/_glsc/fonts.css" "$SRC/assets/_glsc/favicon.svg" "$SRC/assets/_glsc/favicon-32.png" "$SRC/assets/_glsc/apple-touch-icon.png" "$DIR/_glsc/"
rm -rf "${DIR:?}/_glsc/fonts"
cp -r "$SRC/assets/_glsc/fonts" "$DIR/_glsc/fonts"
find "$DIR" -type d -exec chmod 755 {} + ; find "$DIR" -type f -exec chmod 644 {} +
install -m 644 "$SRC/deploy/nginx/glsc-404.inc" /etc/nginx/glsc-404.inc
