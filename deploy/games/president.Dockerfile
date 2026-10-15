# Le Président — image de production (serveur Socket.IO + client Vue servi par le même processus).
# Contexte de build : le dépôt https://github.com/gabinlsc/president
FROM node:22-alpine AS build
WORKDIR /app
COPY . .
RUN npm ci --no-audit --no-fund && npm run build
# Le serveur est bundlé par esbuild ; seule la dépendance socket.io reste externe.
RUN node -e "const l=require('./package-lock.json');const v=l.packages['node_modules/socket.io'].version;require('fs').writeFileSync('/runtime-package.json',JSON.stringify({name:'president-runtime',private:true,type:'module',dependencies:{'socket.io':v}}))"

FROM node:22-alpine
ENV NODE_ENV=production PORT=3001 STATIC_DIR=/app/public
WORKDIR /app
COPY --from=build /runtime-package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/apps/server/dist ./dist
COPY --from=build /app/apps/web/dist ./public
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "dist/index.js"]
