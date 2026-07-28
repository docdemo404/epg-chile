FROM node:24-slim

# libSQL trae binarios precompilados, así que ya no hacen falta las
# herramientas de build nativo que exigía better-sqlite3.
WORKDIR /app

# Capa de dependencias aparte para aprovechar la caché entre builds.
COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY config ./config
COPY tsconfig.json ./

# Sin TURSO_DATABASE_URL la base es un archivo en /data.
ENV EPG_DATA_DIR=/data \
    EPG_EXPORT_DIR=/exports \
    EPG_CACHE_DIR=/cache \
    NODE_ENV=production \
    PORT=3000
RUN mkdir -p /data /exports /cache

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-strip-types", "src/server.ts"]
