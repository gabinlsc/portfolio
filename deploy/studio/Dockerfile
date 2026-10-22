# Service de StudioGLSC (demandes de devis, suivi de projet) : un seul fichier, aucune dépendance.
FROM node:22-alpine
ENV NODE_ENV=production DATA_DIR=/data PORT_PUBLIC=3302 PORT_ADMIN=3303
WORKDIR /app
COPY server.mjs ./
USER node
EXPOSE 3302 3303
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3302/health || exit 1
CMD ["node", "server.mjs"]
