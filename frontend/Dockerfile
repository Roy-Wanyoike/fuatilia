# Fuatilia web console — Next.js standalone multi-stage image (issue #138).
#
#   docker build -t fuatilia-frontend ./frontend
#
# Three stages, every base pinned to an explicit version tag (no :latest):
#   deps    — npm ci from the committed lockfile (reproducible install layer)
#   build   — next build with NEXT_OUTPUT=standalone (see next.config.mjs:
#             standalone output is opt-in per build env, so dev/CI builds are
#             unchanged). Emits .next/standalone/server.js + trimmed
#             node_modules — no package manager and no source in the runtime.
#   runner  — fresh alpine node base, non-root (uid 1000 "node"), only the
#             standalone bundle + static assets are copied in.
#
# Posture mirrors backend-go/Dockerfile: no secrets or config baked in —
# runtime configuration arrives via environment (docker-compose.yml /
# .env.example / docs/DEPLOY.md):
#   API_BASE_URL          server-side BFF target (compose: http://api:8080)
#   NEXT_PUBLIC_API_BASE  BUILD-TIME browser→API base (deliberately unset in
#                         the compose stack: the browser uses the same-origin
#                         BFF /api/v1 so the session token never enters
#                         browser JS; a direct-mode rebuild passes it as a
#                         build arg — see .env.example).

# --- deps: reproducible install layer ---------------------------------------
FROM node:22.20.0-alpine3.22 AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci

# --- build: compile the standalone bundle ------------------------------------
FROM node:22.20.0-alpine3.22 AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_OUTPUT=standalone
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# --- runner: minimal non-root runtime ----------------------------------------
FROM node:22.20.0-alpine3.22 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    # server.js (the standalone entrypoint) binds these: 0.0.0.0 is required
    # so the compose network — not just the container loopback — is served.
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# No public/ directory exists in this lane; if one lands, add:
#   COPY --from=build /app/public ./public
# The standalone server writes nothing except the optional image-optimizer
# cache under .next/cache — ownership is handed to the runtime user so that
# cache stays writable (uid 1000 = the image's precreated "node" user).
RUN chown -R node:node /app
USER node
# The compose port mapping (3000:3000) and this probe both assume PORT=3000 —
# keep them in agreement (same rule as the api target's 8080).
EXPOSE 3000
# busybox wget ships with alpine: probe the app's own root document. GET /
# renders the dashboard auth gate (a 200 page) with no credentials — a cheap,
# honest "the Next server is serving HTML" signal; deeper seams are probed by
# `make smoke` (Makefile, issue #138).
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD ["wget", "-q", "--spider", "http://127.0.0.1:3000/"]
CMD ["node", "server.js"]
