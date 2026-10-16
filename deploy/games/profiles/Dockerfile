# Service de profils des jeux : un seul fichier, aucune dépendance.
FROM node:22-alpine
ENV NODE_ENV=production DATA_DIR=/data PORT_PUBLIC=3300 PORT_INTERNAL=3301
WORKDIR /app
COPY server.mjs ./
USER node
EXPOSE 3300 3301
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3300/health || exit 1
CMD ["node", "server.mjs"]
