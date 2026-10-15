#!/usr/bin/env bash
# deploy3 — tout ce que fait deploy2, plus status.glsc.fr (page de statut + sonde chaque minute).
#
# Usage (en root sur le VPS) :
#   curl -fsSL https://raw.githubusercontent.com/gabinlsc/portfolio/main/deploy/deploy3.sh | bash
#
# Prérequis : l'enregistrement DNS status.glsc.fr pointe vers le VPS.
# Le script obtient lui-même le certificat HTTPS (certbot --webroot) s'il n'existe pas encore.
# Il est relançable autant de fois que nécessaire.

set -euo pipefail

REPO_TGZ="https://codeload.github.com/gabinlsc/portfolio/tar.gz/refs/heads/main"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/root/glsc-backups/$STAMP-status"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

DOMAIN=status.glsc.fr
SITE=/var/www/status.glsc.fr
OPT=/opt/glsc-status
ETC=/etc/glsc-status
VAR=/var/lib/glsc-status
SVC_USER=glsc-status
NGX=/etc/nginx
CONF_AVAIL="$NGX/sites-available/$DOMAIN"
CONF_ENABLED="$NGX/sites-enabled/$DOMAIN"
CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"

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
info "0/5 Téléchargement du dépôt"
curl -fsSL "$REPO_TGZ" | tar -xz -C "$WORK"
SRC="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
for f in deploy/deploy2.sh status/index.html status/targets.json status/collector/glsc_status.py \
         status/systemd/glsc-status.service status/systemd/glsc-status.timer \
         deploy/nginx/status.glsc.fr.conf deploy/nginx/status.glsc.fr.http.conf \
         assets/_glsc/status.js errors/404.html seo/status.glsc.fr/robots.txt; do
  [ -s "$SRC/$f" ] || die "Archive incomplète : $f manquant. Rien n'a été modifié."
done
ok "archive complète"

# ---------------------------------------------------------------- 1. deploy2
info "1/5 Sites existants (deploy2)"
bash "$SRC/deploy/deploy2.sh"

# ---------------------------------------------------------------- 2. sonde
info "2/5 Sonde glsc-status"
if ! id "$SVC_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$SVC_USER"
  ok "utilisateur système $SVC_USER créé"
fi
install -d -m 755 "$OPT" "$ETC"
install -d -m 750 -o "$SVC_USER" -g "$SVC_USER" "$VAR"
install -d -m 755 "$SITE"
chown "$SVC_USER":www-data "$SITE"; chmod 755 "$SITE"
chown "$SVC_USER":"$SVC_USER" "$VAR"; chmod 750 "$VAR"
save "$OPT/glsc_status.py"; save "$ETC/targets.json"
install -m 755 "$SRC/status/collector/glsc_status.py" "$OPT/glsc_status.py"
install -m 644 "$SRC/status/targets.json" "$ETC/targets.json"
if [ -f "$ETC/discord-webhook" ]; then
  chown root:"$SVC_USER" "$ETC/discord-webhook"; chmod 640 "$ETC/discord-webhook"
  ok "alertes Discord actives"
fi
save /etc/systemd/system/glsc-status.service; save /etc/systemd/system/glsc-status.timer
install -m 644 "$SRC/status/systemd/glsc-status.service" /etc/systemd/system/glsc-status.service
install -m 644 "$SRC/status/systemd/glsc-status.timer" /etc/systemd/system/glsc-status.timer
systemctl daemon-reload
ok "sonde installée dans $OPT, config dans $ETC/targets.json"

# ---------------------------------------------------------------- 3. page
info "3/5 Page $DOMAIN"
install -m 644 "$SRC/status/index.html" "$SITE/index.html"
rm -rf "${SITE:?}/_glsc"
cp -r "$SRC/assets/_glsc" "$SITE/_glsc"
find "$SITE/_glsc" -type d -exec chmod 755 {} + ; find "$SITE/_glsc" -type f -exec chmod 644 {} +
install -m 644 "$SRC/errors/404.html" "$SITE/404.html"
install -m 644 "$SRC/seo/status.glsc.fr/robots.txt" "$SITE/robots.txt"
install -m 644 "$SRC/seo/status.glsc.fr/sitemap.xml" "$SITE/sitemap.xml"
chown -R root:www-data "$SITE/_glsc"
ok "fichiers de la page en place"

# première mesure tout de suite, pour que la page ait des données
if systemctl start glsc-status.service; then
  [ -s "$SITE/status.json" ] && ok "première mesure faite (status.json)" || warn "status.json absent après la première mesure"
else
  warn "la sonde a échoué : journalctl -u glsc-status -n 30"
fi
systemctl enable --now glsc-status.timer >/dev/null 2>&1
ok "timer actif : une mesure par minute"

# ---------------------------------------------------------------- 4. nginx + HTTPS
info "4/5 nginx et certificat HTTPS"
OTHERS="$(grep -lsE "server_name[^;]*\b$DOMAIN\b" "$NGX"/sites-enabled/* | grep -v "/$DOMAIN\$" || true)"
if [ -n "$OTHERS" ]; then
  warn "$DOMAIN est déjà déclaré dans : $OTHERS"
  warn "config nginx NON modifiée pour éviter un conflit. Envoie ce fichier à Claude."
else
  REAL="$CONF_AVAIL"
  [ -L "$CONF_ENABLED" ] && REAL="$(readlink -f "$CONF_ENABLED")"
  [ -f "$CONF_ENABLED" ] && [ ! -L "$CONF_ENABLED" ] && REAL="$CONF_ENABLED"
  BEFORE="$WORK/status-conf-before"
  if [ -f "$REAL" ]; then cp -a "$REAL" "$BEFORE"; save "$REAL"; fi

  apply_conf() {   # apply_conf <fichier du dépôt>  → 0 si nginx accepte, sinon restaure et 1
    install -m 644 "$SRC/$1" "$REAL"
    [ -e "$CONF_ENABLED" ] || ln -s "$REAL" "$CONF_ENABLED"
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx; return 0
    fi
    nginx -t 2>&1 | sed 's/^/      /' | tail -5 || true
    if [ -f "$BEFORE" ]; then cp -a "$BEFORE" "$REAL"; else rm -f "$CONF_ENABLED" "$REAL"; fi
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    return 1
  }

  if [ ! -f "$CERT" ]; then
    if apply_conf deploy/nginx/status.glsc.fr.http.conf; then
      ok "site en HTTP le temps d'obtenir le certificat"
      if certbot certonly --webroot -w "$SITE" -d "$DOMAIN" --non-interactive --agree-tos \
           --register-unsafely-without-email --keep-until-expiring >"$WORK/certbot.log" 2>&1; then
        ok "certificat Let's Encrypt obtenu"
      else
        warn "certbot a échoué (le DNS pointe-t-il bien vers ce serveur ?) :"
        tail -8 "$WORK/certbot.log" | sed 's/^/      /'
      fi
    else
      warn "nginx refuse la config HTTP : ancienne config restaurée."
    fi
  fi

  if [ -f "$CERT" ]; then
    if apply_conf deploy/nginx/status.glsc.fr.conf; then
      ok "HTTPS actif sur https://$DOMAIN"
    else
      warn "nginx refuse la config HTTPS : ancienne config restaurée."
    fi
  else
    warn "pas de certificat : HTTPS pas encore actif. Vérifie le DNS puis relance deploy3."
  fi
fi

# ---------------------------------------------------------------- 5. vérification
info "5/5 Vérification"
for url in "https://$DOMAIN/" "https://$DOMAIN/status.json"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)"
  [ "$code" = 200 ] && ok "$code  $url" || warn "$code  $url"
done
if [ -s "$SITE/status.json" ]; then
  python3 - "$SITE/status.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
icon = {"up": "🟢", "degraded": "🟡", "down": "🔴"}
for s in d["services"]:
    lat = "%s ms" % s["latency_ms"] if s["latency_ms"] is not None else s["detail"]
    print("    %s %-16s %s" % (icon.get(s["state"], "?"), s["name"], lat))
PY
fi
systemctl is-active --quiet glsc-status.timer && ok "glsc-status.timer actif" || warn "glsc-status.timer inactif"

info "Terminé. Sauvegardes : $BACKUP"
echo "  Alertes Discord (optionnel) : echo 'URL_DU_WEBHOOK' > $ETC/discord-webhook puis relance deploy3."
