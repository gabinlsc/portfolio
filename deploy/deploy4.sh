#!/usr/bin/env bash
# deploy4 — tout ce que fait deploy3 (donc deploy2), plus les jeux en ligne :
#   uno.glsc.fr, president.glsc.fr et vortex.glsc.fr, chacun dans un conteneur Docker durci.
#
# Usage (en root sur le VPS) :
#   curl -fsSL https://raw.githubusercontent.com/gabinlsc/portfolio/main/deploy/deploy4.sh | bash
#
# Prérequis : un enregistrement DNS « A » vers le VPS pour uno, president et vortex (sans AAAA).
# Un jeu dont le DNS n'est pas prêt est quand même installé ; seul son HTTPS est reporté.
# Relançable à volonté : il met aussi les jeux à jour depuis GitHub.
#
# GLSC_ONLY_GAME=uno|president|vortex : ne met à jour que ce jeu (sources, image, conteneur), sans toucher
# aux sites ni à nginx. C'est ce qu'utilise le déploiement automatique après un push sur le dépôt du jeu.

set -euo pipefail

REPO_TGZ="https://codeload.github.com/gabinlsc/portfolio/tar.gz/refs/heads/main"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/root/glsc-backups/$STAMP-games"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

GAMES_DIR=/opt/glsc-games
ACME_ROOT=/var/www/letsencrypt
NGX=/etc/nginx
# domaine | nom affiché | port local | dépôt GitHub | modèle nginx
GAMES=(
  "uno.glsc.fr|UNO|3101|uno|game-proxy"
  "president.glsc.fr|Le Président|3102|president|game-proxy"
  "vortex.glsc.fr|Vortex|3103|vortex-fps|game-vortex"
)

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
info() { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✘ %s\033[0m\n' "$*"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Lance ce script en root."
ONLY="${GLSC_ONLY_GAME:-}"
case "$ONLY" in ""|uno|president|vortex) ;; *) die "GLSC_ONLY_GAME doit valoir uno, president ou vortex." ;; esac
wanted() { [ -z "$ONLY" ] || [ "${1%%.*}" = "$ONLY" ]; }   # wanted <domaine>
mkdir -p "$BACKUP"

save() {
  [ -e "$1" ] || return 0
  mkdir -p "$(dirname "$BACKUP$1")"
  cp -a "$1" "$BACKUP$1"
}

# ---------------------------------------------------------------- 0. téléchargement
info "0/7 Téléchargement du dépôt"
curl -fsSL "$REPO_TGZ" | tar -xz -C "$WORK"
SRC="$(find "$WORK" -mindepth 1 -maxdepth 1 -type d | head -1)"
for f in deploy/deploy3.sh deploy/games/compose.yml deploy/games/president.Dockerfile deploy/games/vortex.Dockerfile \
         deploy/nginx/glsc-games.conf deploy/nginx/game-proxy.conf.tpl deploy/nginx/game-vortex.conf.tpl deploy/nginx/acme-only.conf.tpl; do
  [ -s "$SRC/$f" ] || die "Archive incomplète : $f manquant. Rien n'a été modifié."
done
ok "archive complète"

command -v docker >/dev/null || die "Docker n'est pas installé."
if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose); else die "Le plugin « docker compose » est introuvable."; fi
command -v git >/dev/null || apt-get install -y -qq git >/dev/null

# ---------------------------------------------------------------- 1. deploy3
info "1/7 Sites, sécurité et status (deploy3)"
if [ -n "$ONLY" ]; then ok "ignoré : seul $ONLY est mis à jour"; else bash "$SRC/deploy/deploy3.sh"; fi

# ---------------------------------------------------------------- 2. anciens processus
info "2/7 Anciens processus node (projets morts de games.glsc.fr)"
stopped=0
[ -n "$ONLY" ] && stopped=-1
for port in $([ -z "$ONLY" ] && echo 3000 3001 3005); do
  for pid in $(ss -ltnpH "sport = :$port" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
    cmd="$({ tr '\0' ' ' < "/proc/$pid/cmdline"; } 2>/dev/null || true)"
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    # Sécurité : on ne touche qu'aux processus de l'ancien games.glsc.fr
    case "$cmd $cwd" in *games.glsc.fr*) ;; *) warn "port $port : processus $pid ($cmd) conservé, il n'appartient pas à l'ancien games.glsc.fr"; continue;; esac
    unit="$(grep -o '[^/]*\.service' "/proc/$pid/cgroup" 2>/dev/null | head -1 || true)"
    if [ -n "$unit" ] && [ "$unit" != "user@0.service" ] && [[ "$unit" != session-* ]]; then
      systemctl disable --now "$unit" >/dev/null 2>&1 || true
      ok "service $unit arrêté et désactivé (port $port)"
    elif ps -o comm= -p "$(ps -o ppid= -p "$pid" | tr -d ' ')" 2>/dev/null | grep -qi pm2; then
      command -v pm2 >/dev/null && pm2 delete "$(pm2 jlist 2>/dev/null | python3 -c "import json,sys;print(next((p['name'] for p in json.load(sys.stdin) if p.get('pid')==$pid),''))")" >/dev/null 2>&1 || true
      pm2 save >/dev/null 2>&1 || true
      ok "processus pm2 $pid supprimé (port $port)"
    else
      kill "$pid" 2>/dev/null || true; sleep 2; kill -9 "$pid" 2>/dev/null || true
      ok "processus $pid arrêté (port $port)"
    fi
    stopped=$((stopped + 1))
  done
done
[ "$stopped" -eq 0 ] && ok "aucun ancien processus à arrêter"
[ "$stopped" -eq -1 ] && ok "ignoré : seul $ONLY est mis à jour"

# ---------------------------------------------------------------- 3. sources des jeux
info "3/7 Sources des jeux (GitHub)"
install -d -m 755 "$GAMES_DIR" "$GAMES_DIR/src" "$GAMES_DIR/dockerfiles"
for entry in "${GAMES[@]}"; do
  IFS='|' read -r domain name port repo tpl <<<"$entry"
  wanted "$domain" || continue
  dir="$GAMES_DIR/src/$repo"
  if [ -d "$dir/.git" ]; then
    git -C "$dir" fetch -q --depth 1 origin main && git -C "$dir" reset -q --hard origin/main
  else
    rm -rf "${dir:?}"; git clone -q --depth 1 "https://github.com/gabinlsc/$repo.git" "$dir"
  fi
  ok "$name : $(git -C "$dir" log -1 --format='%h · %s' | cut -c1-70)"
done
install -m 644 "$SRC/deploy/games/president.Dockerfile" "$SRC/deploy/games/vortex.Dockerfile" "$GAMES_DIR/dockerfiles/"
# résultats des parties (classements) : seul dossier où les conteneurs peuvent écrire (utilisateur node, uid 1000)
for svc in uno president vortex; do install -d -m 750 -o 1000 -g 1000 "/var/lib/glsc-games/$svc"; done
save "$GAMES_DIR/compose.yml"
install -m 644 "$SRC/deploy/games/compose.yml" "$GAMES_DIR/compose.yml"

# ---------------------------------------------------------------- mémoire d'appoint (swap)
# Le VPS S n'a que ~2 Go de RAM : la compilation des jeux peut dépasser la mémoire libre.
# Un fichier swap de 2 Go sur le disque évite que le système coupe la compilation (ou un autre programme).
info "Mémoire d'appoint (swap)"
if [ -n "$(swapon --show --noheadings 2>/dev/null)" ]; then
  ok "swap déjà actif ($(free -h | awk '/^Swap/{print $2}'))"
elif [ "$(df --output=avail -k / | tail -1)" -lt $((6 * 1024 * 1024)) ]; then
  warn "moins de 6 Go libres sur le disque : pas de swap créé (la compilation risque de manquer de mémoire)"
else
  if [ ! -f /swapfile ]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap /swapfile >/dev/null
  fi
  swapon /swapfile
  save /etc/fstab
  grep -qE '^/swapfile[[:space:]]' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-glsc-swap.conf   # n'utilise le swap qu'en dernier recours
  sysctl -q -p /etc/sysctl.d/99-glsc-swap.conf 2>/dev/null || true
  ok "swap de 2 Go activé (permanent, utilisé seulement si la RAM est pleine)"
fi

# ---------------------------------------------------------------- 4. build + lancement
info "4/7 Construction des images (quelques minutes la première fois)"
cd "$GAMES_DIR"
for svc in ${ONLY:-uno president vortex}; do
  if "${COMPOSE[@]}" build -q "$svc" >"$WORK/build-$svc.log" 2>&1; then
    ok "image $svc construite"
  else
    tail -15 "$WORK/build-$svc.log" | sed 's/^/      /'
    die "La construction de $svc a échoué. Les jeux déjà en ligne continuent de tourner."
  fi
done
if [ -n "$ONLY" ]; then
  "${COMPOSE[@]}" up -d --no-deps "$ONLY" >/dev/null 2>&1
  ok "conteneur $ONLY relancé"
else
  "${COMPOSE[@]}" up -d --remove-orphans >/dev/null 2>&1
  ok "conteneurs lancés"
fi
docker image prune -f >/dev/null 2>&1 || true

# client statique de Vortex → /var/www/vortex.glsc.fr (remplacement atomique)
if wanted vortex.glsc.fr; then
tmp="$(mktemp -d /var/www/.vortex-XXXX)"
cid="$(docker create glsc/vortex:latest)"
docker cp "$cid:/app/public/." "$tmp/" && docker rm -f "$cid" >/dev/null
chmod 755 "$tmp"; find "$tmp" -type d -exec chmod 755 {} + ; find "$tmp" -type f -exec chmod 644 {} +
if [ -d /var/www/vortex.glsc.fr ]; then mv /var/www/vortex.glsc.fr "$tmp.old"; fi
mv "$tmp" /var/www/vortex.glsc.fr && rm -rf "$tmp.old"
ok "client Vortex publié dans /var/www/vortex.glsc.fr"
fi

# santé locale
sleep 5
health_ok=1
for entry in "${GAMES[@]}"; do
  IFS='|' read -r domain name port repo tpl <<<"$entry"
  wanted "$domain" || continue
  if [ "$repo" = vortex-fps ]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
            -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' -H "Origin: https://$domain" --max-time 3 "http://127.0.0.1:$port/play" || true)"
    [ "$code" = 101 ] && ok "$name répond en local (WebSocket)" || { health_ok=0; warn "$name ne répond pas en local (code $code) : docker logs glsc-games-vortex-1"; }
  else
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port/health" || true)"
    [ "$code" = 200 ] && ok "$name répond en local" || { health_ok=0; warn "$name ne répond pas en local (code $code) : docker logs glsc-games-$repo-1"; }
  fi
done
if [ -n "$ONLY" ]; then
  [ "$health_ok" = 1 ] || die "$ONLY ne répond pas après la mise à jour."
  info "Terminé : $ONLY est à jour. Sauvegardes : $BACKUP"
  exit 0
fi

# ---------------------------------------------------------------- 5. nginx commun
info "5/7 nginx : réglages communs des jeux"
install -d -m 755 "$ACME_ROOT"
COMMON="$NGX/conf.d/glsc-games.conf"
had_common=0; [ -f "$COMMON" ] && { cp -a "$COMMON" "$WORK/common.before"; had_common=1; save "$COMMON"; }
install -m 644 "$SRC/deploy/nginx/glsc-games.conf" "$COMMON"
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx; ok "WebSocket et limitation de débit"
else
  nginx -t 2>&1 | sed 's/^/      /' | tail -4 || true
  if [ "$had_common" = 1 ]; then cp -a "$WORK/common.before" "$COMMON"; else rm -f "$COMMON"; fi
  die "nginx refuse les réglages communs : rien d'autre n'a été modifié côté nginx."
fi

# ---------------------------------------------------------------- 6. un site HTTPS par jeu
info "6/7 nginx et HTTPS par jeu"
LOCAL_IPS=" $(hostname -I 2>/dev/null) $(curl -4 -s --max-time 5 https://ifconfig.me 2>/dev/null || true) "
render() { sed -e "s#__DOMAIN__#$2#g" -e "s#__PORT__#$3#g" -e "s#__NAME__#$4#g" "$SRC/deploy/nginx/$1.conf.tpl"; }

for entry in "${GAMES[@]}"; do
  IFS='|' read -r domain name port repo tpl <<<"$entry"
  avail="$NGX/sites-available/$domain"; enabled="$NGX/sites-enabled/$domain"
  others="$(grep -lsE "server_name[^;]*\b${domain//./\\.}\b" "$NGX"/sites-enabled/* | grep -v "/$domain\$" || true)"
  if [ -n "$others" ]; then warn "$domain déjà déclaré dans $others : ignoré."; continue; fi

  # DNS : l'IPv4 doit pointer ici, et pas d'IPv6 vers ailleurs (sinon Let's Encrypt échoue)
  v4="$(getent ahostsv4 "$domain" 2>/dev/null | awk 'NR==1{print $1}')"
  v6="$(getent ahostsv6 "$domain" 2>/dev/null | awk '$1 !~ /^::ffff:/ {print $1; exit}')"
  if [ -z "$v4" ] || [[ "$LOCAL_IPS" != *" $v4 "* ]]; then
    warn "$domain : le DNS pointe vers « ${v4:-rien} », pas vers ce serveur. Crée l'enregistrement A puis relance deploy4."
    continue
  fi
  if [ -n "$v6" ] && [[ "$LOCAL_IPS" != *" $v6 "* ]]; then
    warn "$domain : une adresse IPv6 ($v6) pointe ailleurs. Supprime l'enregistrement AAAA puis relance deploy4."
    continue
  fi

  before="$WORK/$domain.before"; [ -f "$avail" ] && { cp -a "$avail" "$before"; save "$avail"; }
  apply() {   # apply <contenu> → 0 si nginx accepte, sinon restaure
    printf '%s\n' "$1" > "$avail"; chmod 644 "$avail"
    [ -e "$enabled" ] || ln -s "$avail" "$enabled"
    if nginx -t >/dev/null 2>&1; then systemctl reload nginx; return 0; fi
    nginx -t 2>&1 | sed 's/^/      /' | tail -4 || true
    if [ -f "$before" ]; then cp -a "$before" "$avail"; else rm -f "$enabled" "$avail"; fi
    nginx -t >/dev/null 2>&1 && systemctl reload nginx
    return 1
  }

  if [ ! -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]; then
    apply "$(render acme-only "$domain" "$port" "$name")" || { warn "$domain : nginx refuse la config temporaire."; continue; }
    if certbot certonly --webroot -w "$ACME_ROOT" -d "$domain" --non-interactive --agree-tos \
         --register-unsafely-without-email --keep-until-expiring >"$WORK/certbot-$domain.log" 2>&1; then
      ok "$domain : certificat obtenu"
    else
      warn "$domain : certbot a échoué :"; tail -6 "$WORK/certbot-$domain.log" | sed 's/^/      /'
      continue
    fi
  fi
  if apply "$(render "$tpl" "$domain" "$port" "$name")"; then
    ok "$domain : en ligne en HTTPS"
  else
    warn "$domain : nginx refuse la config HTTPS, ancienne config restaurée."
  fi
done

# ---------------------------------------------------------------- 7. vérification
info "7/7 Vérification"
"${COMPOSE[@]}" ps --format '{{.Service}}|{{.Status}}' 2>/dev/null | while IFS='|' read -r s st; do printf '    %-10s %s\n' "$s" "$st"; done
for entry in "${GAMES[@]}"; do
  IFS='|' read -r domain name port repo tpl <<<"$entry"
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "https://$domain/" || true)"
  [ "$code" = 200 ] && ok "$code  https://$domain" || warn "$code  https://$domain"
done

info "Terminé. Sauvegardes : $BACKUP"
echo "  Mettre les jeux à jour plus tard : relance simplement deploy4."
echo "  Logs d'un jeu : docker logs -f glsc-games-uno-1 (ou president-1, vortex-1)"
