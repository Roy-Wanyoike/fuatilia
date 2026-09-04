#Fuatilia Go backend — one Dockerfile, two deployable targets.
#
#   docker build --target api    -t fuatilia-api    .   # serves /v1 (issue #72)
#   docker build --target worker -t fuatilia-worker .   # outbox relay (issue #74)
#
# Targets compile the parallel lanes' binaries at their agreed paths:
#   ./cmd/api    (issue #72) and ./cmd/worker (issue #74).
# scripts/validate_deploy.py gates these paths; until #72/#74 merge it runs
# with --allow-pending-lanes and exits 0 on the merged tree without the flag.
#
# Posture: multi-stage, CGO_ENABLED=0 static binaries, distroless/static
# final stages running as nonroot, every base image pinned to an explicit
# tag (no :latest, no implicit-latest), no secrets or config baked in —
# all runtime configuration arrives via environment (docker-compose.yml /
# .env, docs/DEPLOY.md).

# --- build: module deps + source (cached layers) ---------------------------
FROM golang:1.26.8-alpine3.23 AS build
# CGO off => fully static binaries for distroless/static; GOTOOLCHAIN=local
# forbids surprise toolchain downloads — the image IS the toolchain.
ENV CGO_ENABLED=0 GOTOOLCHAIN=local
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .

# --- per-target builds (a --target api build never compiles the worker) ----
FROM build AS build-api
RUN go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api

FROM build AS build-worker
RUN go build -trimpath -ldflags="-s -w" -o /out/worker ./cmd/worker

# --- api: distroless/static, non-root, healthcheck on its own /v1/health ---
FROM gcr.io/distroless/static-debian12:nonroot AS api
COPY --from=build-api /out/api /api
# distroless has no shell and no wget; busybox(1) is a statically linked musl
# binary whose wget applet drives the healthcheck below. Only this one binary
# is copied — no shell is reachable (busybox runs single applets by argument).
COPY --from=busybox:1.37.0-musl /bin/busybox /bin/busybox
# The compose port mapping (8080:8080) and this healthcheck both assume
# LISTEN_ADDR=0.0.0.0:8080 (the .env.example default) — keep them in agreement.
EXPOSE 8080
# The :nonroot tag already drops to uid 65532; restated explicitly so the
# non-root guarantee survives stage reshuffling.
USER nonroot:nonroot
ENTRYPOINT ["/api"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["/bin/busybox", "wget", "-q", "--spider", "http://127.0.0.1:8080/v1/health"]

# --- worker: distroless/static, non-root; no listener => no port, no probe -
FROM gcr.io/distroless/static-debian12:nonroot AS worker
COPY --from=build-worker /out/worker /worker
USER nonroot:nonroot
ENTRYPOINT ["/worker"]
