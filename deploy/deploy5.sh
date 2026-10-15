#!/usr/bin/env bash
# deploy5 — tout ce que fait deploy4 (sites, status, jeux), plus l'espace privé :
#   admin.glsc.fr  hub privé (kanban, trafic, santé, sécurité, jeux, fichiers, coffre…) avec mot de passe + 2FA
#   click.glsc.fr  liens courts créés depuis l'admin
#
# Usage (en root sur le VPS) :
#   curl -fsSL https://raw.githubusercontent.com/gabinlsc/portfolio/main/deploy/deploy5.sh | bash
#   GLSC_ONLY_ADMIN=1 … | bash     → saute deploy4 (mise à jour rapide de l'admin seule)
#   GLSC_NO_FAIL2BAN=1 … | bash    → n'installe pas fail2ban
#
# Prérequis : enregistrements DNS « A » admin.glsc.fr et click.glsc.fr vers le VPS (sans AAAA).
# Relançable à volonté. Les données de l'admin (/var/lib/glsc-admin) ne sont jamais effacées.

set -euo pipefail

REPO_TGZ="https://codeload.github.com/gabinlsc/portfolio/tar.gz/refs/heads/main"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/root/glsc-backups/$STAMP-admin"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

OPT=/opt/glsc-admin
ETC=/etc/glsc-admin
VAR=/var/lib/glsc-admin
WEB=/var/www/admin.glsc.fr
CLICK=/var/www/click.glsc.fr
ACME_ROOT=/var/www/letsencrypt
NGX=/etc/nginx
SITES=("admin.glsc.fr|admin" "click.glsc.fr|click")

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
info() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✘ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Lance ce script en root."
mkdir -p "$BACKUP"

save() {
  [ -e "$1" ] || return 0
  mkdir -p "$(dirname "$BACKUP$1")"
  cp -a "$1" "$BACKUP$1"
}

# ---------------------------------------------------------------- 0. téléchargement
info "0/8 Téléchargement du dépôt"
if [ -n "${GLSC_SRC:-}" ]; then
  SRC="$GLSC_SRC"   # tests : copie locale du dépôt au lieu de GitHub
else
  curl -fsSL "$REPO_TGZ" | tar -xz -C "$WORK"
  SRC="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
fi
for f in deploy/deploy4.sh admin/lib/router.php admin/lib/click.php admin/public/index.php admin/public/assets/app.js \
         admin/public/assets/admin.css admin/click/index.php admin/bin/glsc-admin-setup admin/collector/glsc_admin_collect.py \
         admin/systemd/glsc-admin-collect.service admin/systemd/glsc-admin-collect.timer admin/systemd/glsc-admin-queue.path \
         admin/systemd/glsc-admin-queue.service deploy/nginx/glsc-log.conf deploy/nginx/glsc-admin-php.inc.tpl \
         deploy/nginx/admin.glsc.fr.conf.tpl deploy/nginx/click.glsc.fr.conf.tpl deploy/nginx/acme-only.conf.tpl assets/_glsc/fonts.css; do
  [ -s "$SRC/$f" ] || die "Archive incomplète : $f manquant. Rien n'a été modifié."
done
ok "archive complète"

# ---------------------------------------------------------------- 1. deploy4
if [ "${GLSC_ONLY_ADMIN:-0}" = 1 ]; then
  info "1/8 deploy4 sauté (GLSC_ONLY_ADMIN=1)"
else
  info "1/8 Sites, status et jeux (deploy4)"
  bash "$SRC/deploy/deploy4.sh"
fi

# ---------------------------------------------------------------- 2. paquets
info "2/8 PHP et outils"
PHP_SOCK="$(grep -rhoE 'fastcgi_pass[[:space:]]+unix:[^;]+' "$NGX/sites-enabled/" 2>/dev/null | head -1 | sed -E 's/.*unix://' || true)"
[ -S "${PHP_SOCK:-/nonexistent}" ] || PHP_SOCK="$(ls -1 /run/php/php*-fpm.sock 2>/dev/null | sort -V | tail -1 || true)"
[ -S "${PHP_SOCK:-/nonexistent}" ] || die "PHP-FPM introuvable (aucun socket dans /run/php). Rien d'autre n'a été modifié."
PHP_VER="$(basename "$PHP_SOCK" | grep -oE '[0-9]+\.[0-9]+' || true)"
ok "PHP-FPM : $PHP_SOCK"
need=()
command -v php >/dev/null || need+=("php${PHP_VER}-cli")
php -m 2>/dev/null | grep -qi '^pdo_sqlite$' || need+=("php${PHP_VER}-sqlite3")
command -v qrencode >/dev/null || need+=(qrencode)
if [ "${GLSC_NO_FAIL2BAN:-0}" != 1 ] && ! command -v fail2ban-client >/dev/null; then need+=(fail2ban); fi
if [ ${#need[@]} -gt 0 ]; then
  apt-get update -qq >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${need[@]}" >/dev/null 2>&1 \
    || die "Installation impossible de : ${need[*]}"
  ok "installé : ${need[*]}"
fi
if ! php -r 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);'; then die "Extension PHP pdo_sqlite toujours absente."; fi
systemctl reload "php${PHP_VER}-fpm" 2>/dev/null || systemctl reload php-fpm 2>/dev/null || true
if command -v fail2ban-client >/dev/null; then
  systemctl enable --now fail2ban >/dev/null 2>&1 || true
  ok "fail2ban actif (bannit 10 min une IP après 5 échecs SSH)"
fi

# ---------------------------------------------------------------- 3. code et pages
info "3/8 Code de l'admin"
install -d -m 755 "$OPT" "$OPT/lib" "$OPT/lib/modules"
save "$OPT"
rm -rf "${OPT:?}/lib.new"; cp -r "$SRC/admin/lib" "$OPT/lib.new"
find "$OPT/lib.new" -type d -exec chmod 755 {} + ; find "$OPT/lib.new" -type f -exec chmod 644 {} +
rm -rf "${OPT:?}/lib.old"; mv "$OPT/lib" "$OPT/lib.old"; mv "$OPT/lib.new" "$OPT/lib"; rm -rf "${OPT:?}/lib.old"
install -m 755 "$SRC/admin/collector/glsc_admin_collect.py" "$OPT/glsc_admin_collect.py"
install -m 755 "$SRC/admin/bin/glsc-admin-setup" /usr/local/sbin/glsc-admin-setup
ok "code dans $OPT, commande glsc-admin-setup installée"

publish_root() {   # publish_root <dossier> <source index.php>
  local dir="$1" tmp
  tmp="$(mktemp -d "$(dirname "$dir")/.glsc-XXXX")"
  install -m 644 "$SRC/$2" "$tmp/index.php"
  mkdir -p "$tmp/assets"
  if [ "$dir" = "$WEB" ]; then cp -r "$SRC/admin/public/assets/." "$tmp/assets/"; else install -m 644 "$SRC/admin/public/assets/admin.css" "$SRC/admin/public/assets/favicon.svg" "$tmp/assets/"; fi
  mkdir -p "$tmp/_glsc"
  cp -r "$SRC/assets/_glsc/fonts" "$SRC/assets/_glsc/fonts.css" "$tmp/_glsc/"
  find "$tmp" -type d -exec chmod 755 {} + ; find "$tmp" -type f -exec chmod 644 {} +
  chown -R root:www-data "$tmp"
  [ -d "$dir" ] && { save "$dir"; mv "$dir" "$tmp.old"; }
  mv "$tmp" "$dir"; rm -rf "$tmp.old"
}
publish_root "$WEB" admin/public/index.php
publish_root "$CLICK" admin/click/index.php
ok "pages : $WEB et $CLICK"

# ---------------------------------------------------------------- 4. données et identifiants
info "4/8 Données"
install -d -m 750 -o root -g www-data "$VAR" "$VAR/pub" "$ETC"
install -d -m 700 -o www-data -g www-data "$VAR/app" "$VAR/app/files" "$VAR/queue"
install -d -m 700 -o root -g root "$VAR/collector"
[ -f "$ETC/auth.json" ] && { chown root:www-data "$ETC/auth.json"; chmod 640 "$ETC/auth.json"; }
sha_json="$(curl -fsS --max-time 8 -H 'Accept: application/vnd.github+json' https://api.github.com/repos/gabinlsc/portfolio/commits/main 2>/dev/null || true)"
if [ -n "$sha_json" ]; then
  printf '%s' "$sha_json" | python3 -c 'import json,sys,time
d=json.load(sys.stdin); print(json.dumps({"sha": d["sha"], "subject": d["commit"]["message"].splitlines()[0][:120], "at": int(time.time())}))' \
    > "$ETC/portfolio-version.json" 2>/dev/null && chmod 644 "$ETC/portfolio-version.json" || rm -f "$ETC/portfolio-version.json"
fi
ok "données dans $VAR (jamais effacées par ce script)"

# ---------------------------------------------------------------- 5. nginx commun
info "5/8 nginx : journal JSON et PHP"
LOGCONF="$NGX/conf.d/glsc-log.conf"
INC="$NGX/glsc-admin-php.inc"
cp -a "$NGX/conf.d" "$WORK/conf.d.before"
[ -f "$INC" ] && cp -a "$INC" "$WORK/inc.before"
save "$LOGCONF"; save "$INC"
install -m 644 "$SRC/deploy/nginx/glsc-log.conf" "$LOGCONF"
sed "s#__PHP_SOCK__#$PHP_SOCK#g" "$SRC/deploy/nginx/glsc-admin-php.inc.tpl" > "$INC"; chmod 644 "$INC"
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
  ok "toutes les requêtes sont aussi écrites dans /var/log/nginx/glsc-access.log"
else
  nginx -t 2>&1 | sed 's/^/      /' | tail -4 || true
  rm -rf "${NGX:?}/conf.d"; cp -a "$WORK/conf.d.before" "$NGX/conf.d"
  if [ -f "$WORK/inc.before" ]; then cp -a "$WORK/inc.before" "$INC"; else rm -f "$INC"; fi
  die "nginx refuse le journal JSON : configuration restaurée, rien d'autre n'a été modifié."
fi
touch /var/log/nginx/glsc-access.log

# ---------------------------------------------------------------- 6. sites HTTPS
info "6/8 admin.glsc.fr et click.glsc.fr (HTTPS)"
install -d -m 755 "$ACME_ROOT"
LOCAL_IPS=" $(hostname -I 2>/dev/null) $(curl -4 -s --max-time 5 https://ifconfig.me 2>/dev/null || true) "
for entry in "${SITES[@]}"; do
  IFS='|' read -r domain tpl <<<"$entry"
  avail="$NGX/sites-available/$domain"; enabled="$NGX/sites-enabled/$domain"
  others="$(grep -lsE "server_name[^;]*\b${domain//./\\.}\b" "$NGX"/sites-enabled/* | grep -v "/$domain\$" || true)"
  if [ -n "$others" ]; then warn "$domain déjà déclaré dans $others : ignoré."; continue; fi
  v4="$(getent ahostsv4 "$domain" 2>/dev/null | awk 'NR==1{print $1}' || true)"
  v6="$(getent ahostsv6 "$domain" 2>/dev/null | awk '$1 !~ /^::ffff:/ {print $1; exit}' || true)"
  if [ -z "$v4" ] || [[ "$LOCAL_IPS" != *" $v4 "* ]]; then
    warn "$domain : le DNS pointe vers « ${v4:-rien} », pas vers ce serveur. Crée l'enregistrement A puis relance deploy5."
    continue
  fi
  if [ -n "$v6" ] && [[ "$LOCAL_IPS" != *" $v6 "* ]]; then
    warn "$domain : une adresse IPv6 ($v6) pointe ailleurs. Supprime l'enregistrement AAAA puis relance deploy5."
    continue
  fi
  before="$WORK/$domain.before"; [ -f "$avail" ] && { cp -a "$avail" "$before"; save "$avail"; }
  apply() {
    printf '%s\n' "$1" > "$avail"; chmod 644 "$avail"
    [ -e "$enabled" ] || ln -s "$avail" "$enabled"
    if nginx -t >/dev/null 2>&1; then systemctl reload nginx; return 0; fi
    nginx -t 2>&1 | sed 's/^/      /' | tail -4 || true
    if [ -f "$before" ]; then cp -a "$before" "$avail"; else rm -f "$enabled" "$avail"; fi
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    return 1
  }
  if [ ! -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]; then
    apply "$(sed -e "s#__DOMAIN__#$domain#g" "$SRC/deploy/nginx/acme-only.conf.tpl")" || { warn "$domain : nginx refuse la config temporaire."; continue; }
    if certbot certonly --webroot -w "$ACME_ROOT" -d "$domain" --non-interactive --agree-tos \
         --register-unsafely-without-email --keep-until-expiring >"$WORK/certbot-$domain.log" 2>&1; then
      ok "$domain : certificat obtenu"
    else
      warn "$domain : certbot a échoué :"; tail -6 "$WORK/certbot-$domain.log" | sed 's/^/      /'
      continue
    fi
  fi
  if apply "$(cat "$SRC/deploy/nginx/$domain.conf.tpl")"; then
    ok "$domain : en ligne en HTTPS"
  else
    warn "$domain : nginx refuse la config HTTPS, ancienne config restaurée."
  fi
done

# ---------------------------------------------------------------- 7. sonde
info "7/8 Sonde (chaque minute) et file d'attente"
for u in glsc-admin-collect.service glsc-admin-collect.timer glsc-admin-queue.path glsc-admin-queue.service; do
  save "/etc/systemd/system/$u"
  install -m 644 "$SRC/admin/systemd/$u" "/etc/systemd/system/$u"
done
systemctl daemon-reload
# la base de l'admin est créée par PHP (propriétaire www-data) : on la crée avant la première mesure
if [ ! -f "$VAR/app/app.db" ]; then
  runuser -u www-data -- env GLSC_ADMIN_LIB="$OPT/lib" php -r 'require getenv("GLSC_ADMIN_LIB")."/bootstrap.php"; db();' \
    && ok "base de l'admin créée" || warn "création de la base impossible pour l'instant (elle le sera à la première visite)"
fi
if systemctl start glsc-admin-collect.service; then ok "première mesure faite"; else warn "la sonde a échoué : journalctl -u glsc-admin-collect -n 30"; fi
systemctl enable --now glsc-admin-collect.timer glsc-admin-queue.path >/dev/null 2>&1
ok "timer actif (1 mesure/min) et file d'attente surveillée"

# ---------------------------------------------------------------- 8. identifiants + vérification
info "8/8 Identifiants et vérification"
if [ -s "$ETC/auth.json" ]; then
  ok "identifiants déjà configurés (glsc-admin-setup --password / --2fa / --recovery pour les changer)"
elif [ -r /dev/tty ] && { : </dev/tty; } 2>/dev/null; then
  warn "première installation : choisis ton mot de passe et active la 2FA"
  glsc-admin-setup </dev/tty || warn "configuration interrompue : relance « glsc-admin-setup »"
else
  warn "pas de terminal interactif : lance maintenant « glsc-admin-setup » pour créer tes identifiants"
fi
for url in https://admin.glsc.fr/ https://click.glsc.fr/; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$url" || true)"
  case "$code" in 200|302) ok "$code  $url" ;; *) warn "$code  $url" ;; esac
done

info "Terminé. Sauvegardes : $BACKUP"
echo "  Admin       : https://admin.glsc.fr  (mot de passe + code 2FA)"
echo "  Identifiants: glsc-admin-setup [--password | --2fa | --recovery]"
echo "  Sonde       : journalctl -u glsc-admin-collect -n 30"
echo "  L'ancien glsc.fr/private reste en place tant que tu ne le supprimes pas."
