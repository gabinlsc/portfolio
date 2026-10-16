#!/usr/bin/env bash
# Enregistre les commandes slash du bot (/classement, /profil, /defi) auprès de Discord. À lancer une fois, puis après chaque
# changement de COMMANDS dans deploy/games/profiles/discord.mjs. Nécessite node et curl.
#   DISCORD_APP_ID=123… DISCORD_BOT_TOKEN=… bash deploy/discord/register-commands.sh [ID_DU_SERVEUR]
# Avec un identifiant de serveur, les commandes apparaissent tout de suite sur ce serveur ; sans, partout (jusqu'à 1 h de délai).
# Le jeton du bot est un secret : il ne sert qu'ici, jamais sur le serveur de jeux (qui n'a besoin que de la clé PUBLIQUE).
set -euo pipefail
: "${DISCORD_APP_ID:?DISCORD_APP_ID manquant (Developer Portal > ton application > General Information > Application ID)}"
: "${DISCORD_BOT_TOKEN:?DISCORD_BOT_TOKEN manquant (Developer Portal > Bot > Reset Token)}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
guild="${1:-}"
url="https://discord.com/api/v10/applications/$DISCORD_APP_ID/commands"
[ -z "$guild" ] || url="https://discord.com/api/v10/applications/$DISCORD_APP_ID/guilds/$guild/commands"
node --input-type=module -e "import { COMMANDS } from '$here/../games/profiles/discord.mjs'; process.stdout.write(JSON.stringify(COMMANDS));" |
  curl -fsS -X PUT "$url" -H "Authorization: Bot $DISCORD_BOT_TOKEN" -H 'Content-Type: application/json' -d @- >/dev/null
echo "Commandes enregistrées : /classement, /profil, /defi"
