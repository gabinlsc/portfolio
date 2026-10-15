# Vortex · Rift Outpost — serveur de jeu WebSocket (128 Hz) + client Three.js.
# Contexte de build : le dépôt https://github.com/gabinlsc/vortex-fps
# Le client statique (/app/public) est extrait de l'image par deploy4.sh et servi par nginx.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
ARG GAME_URL=wss://vortex.glsc.fr/play
RUN VITE_GAME_URL="$GAME_URL" npx vite build \
 && npx esbuild server/main.ts --bundle --platform=node --format=esm --packages=external --outfile=dist-server/main.mjs

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist ./public
USER node
# Mode serveur ouvert : joueurs anonymes, écoute uniquement sur 127.0.0.1 (réseau de l'hôte),
# limites intégrées (16 joueurs, 32 connexions, contrôle de l'origine, budget de messages).
CMD ["node", "dist-server/main.mjs", "--local-dev"]
