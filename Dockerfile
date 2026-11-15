# Kundali for Google Cloud Run: the web app (browser mode, no companion) and the score leaderboard API,
# served by one small Node server (server-web/server.mjs). Scores are kept in Firestore.
# Stage 1: build the web app (repo root) with Node.
FROM node:22-alpine AS build
WORKDIR /app/web
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . ./
# dist/_headers stays: the server reads its security headers from it (and never serves it)
RUN npx vite build \
 && find dist -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.html' -o -name '*.json' -o -name '*.wasm' -o -name '*.svg' \) \
      -size +1k -exec gzip -9 -k {} \;

# Stage 2: the server's production dependencies only (@google-cloud/firestore).
FROM node:22-alpine AS deps
WORKDIR /app/server
COPY server-web/package.json server-web/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Stage 3: runtime. Non-root, listens on $PORT (Cloud Run sets it; default 8080).
FROM node:22-alpine
ENV NODE_ENV=production PORT=8080 KUNDALI_DIST=/app/dist
WORKDIR /app/server
COPY --from=deps /app/server/node_modules ./node_modules
COPY server-web/package.json server-web/server.mjs ./
COPY --from=build /app/web/dist /app/dist
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
