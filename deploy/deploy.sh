#!/usr/bin/env bash
# Ancien script de déploiement : remplacé par deploy2.sh, qui fait tout ce qu'il faisait et plus.
set -euo pipefail
echo "deploy.sh est remplacé par deploy2.sh, lancement…"
curl -fsSL https://raw.githubusercontent.com/gabinlsc/portfolio/main/deploy/deploy2.sh | bash
