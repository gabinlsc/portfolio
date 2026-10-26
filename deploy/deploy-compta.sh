#!/usr/bin/env bash
# Déploie Compta by glsc (dépôt gabinlsc/compta) sur ce serveur : télécharge la branche main et lance son deploy.sh
# (sauvegarde, échange atomique, vérification des pages, retour arrière automatique, nginx et certificat HTTPS au premier lancement).
# Lancé par glsc-deploy.service quand le webhook GitHub signale un push sur main de gabinlsc/compta, ou à la main :
#   sudo bash deploy/deploy-compta.sh
# Variables : GLSC_COMPTA_DOMAIN (défaut compta.glsc.fr), GLSC_COMPTA_EMAIL (défaut pro@glsc.fr, pour Let's Encrypt).
# Code de sortie 3 : la nouvelle version ne répondait pas et l'ancienne a été remise en service (même convention que deploy4.sh).
set -euo pipefail
DOMAIN="${GLSC_COMPTA_DOMAIN:-compta.glsc.fr}"
EMAIL="${GLSC_COMPTA_EMAIL:-pro@glsc.fr}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
echo "▸ Téléchargement de gabinlsc/compta@main"
curl -fsSL --retry 3 --max-time 120 "https://codeload.github.com/gabinlsc/compta/tar.gz/refs/heads/main" | tar -xz -C "$TMP"
SRC="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -1)"
[ -s "$SRC/deploy.sh" ] || { echo "✗ deploy.sh introuvable dans le dépôt compta" >&2; exit 1; }
COMPTA_SRC="$SRC" exec bash "$SRC/deploy.sh" --domain "$DOMAIN" --email "$EMAIL"
