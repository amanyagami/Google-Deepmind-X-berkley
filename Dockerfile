# Kundali web app for Google Cloud Run (static, browser mode; no companion server).
# Stage 1: build web/ with Node.
FROM node:22-alpine AS build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npx vite build \
 && rm -f dist/_headers \
 && find dist -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.html' -o -name '*.json' -o -name '*.wasm' -o -name '*.svg' \) \
      -size +1k -exec gzip -9 -k {} \;

# Stage 2: small unprivileged nginx. Listens on $PORT (Cloud Run sets it; default 8080).
FROM nginxinc/nginx-unprivileged:1.27-alpine
ENV PORT=8080
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 8080
