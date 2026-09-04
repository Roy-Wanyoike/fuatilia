#!/usr/bin/env python3
"""
validate_deploy.py — the static gate for the Fuatilia deployment foundation
(issue #75, roadmap P0 criterion 7).

The build environment has NO Docker daemon, so this validator is deliberately
static/structural. What it proves and what it cannot:

  PROVES
  - docker-compose.yml parses as YAML and has exactly the five expected
    services (postgres, nats, migrate, api, worker);
  - every build context, Dockerfile, host-mounted path and
    entrypoint/command-referenced file EXISTS in the repository;
  - the service graph is ACYCLIC with the required ordering edges
    (postgres healthy → migrate → {api, worker}; nats → worker);
  - only the api service exposes ports;
  - base images are pinned (no :latest, no implicit-latest FROM) on both the
    Dockerfile stages and the compose services, and JetStream is enabled;
  - backend-go/Dockerfile is multi-stage, builds BOTH cmd targets, is
    CGO_ENABLED=0, and its final stages run as nonroot with the api
    healthcheck hitting its own /v1/health;
  - every env var referenced by compose (${VAR}) or read from Go code
    (os.Getenv / os.LookupEnv in backend-go/) has a committed .env.example
    key — the environment contract cannot drift in EITHER direction of
    "missing key";
  - no committed credential default: POSTGRES_PASSWORD and DATABASE_URL in
    .env.example must be CHANGE_ME placeholders.

  CANNOT PROVE (needs a Docker daemon — see docs/DEPLOY.md "What is NOT
  verified"): that images build, that the binaries link and serve, that
  containers start, that healthchecks pass, or that migrations run.

Usage:
  python3 scripts/validate_deploy.py [--allow-pending-lanes]

  backend-go/cmd/api (issue #72) and backend-go/cmd/worker (issue #74) are
  delivered by PARALLEL lanes. Until they merge, pass --allow-pending-lanes
  to downgrade their absence from a failure to an explicit PENDING; on the
  merged tree the plain invocation exits 0.

Exit codes: 0 = all gates green · 1 = gate failure · 2 = tooling error.
PyYAML is required (a hand-rolled "minimal YAML parser" fallback is NOT
committed on purpose — it would be the lie this gate exists to prevent):
  pip install pyyaml
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

COMPOSE = REPO / "docker-compose.yml"
ENV_EXAMPLE = REPO / ".env.example"
DEPLOY_DOC = REPO / "docs" / "DEPLOY.md"
DOCKERFILE = REPO / "backend-go" / "Dockerfile"
DOCKERIGNORE = REPO / "backend-go" / ".dockerignore"
BACKEND_GO = REPO / "backend-go"

REQUIRED_SERVICES = {"postgres", "nats", "migrate", "api", "worker"}
REQUIRED_NAMED_VOLUMES = {"fuatilia_pgdata", "fuatilia_nats"}
REQUIRED_ENV_KEYS = {
    # the contract this issue owns (docs/DEPLOY.md env table):
    "DATABASE_URL",
    "NATS_URL",
    "LISTEN_ADDR",
    "OUTBOX_BATCH",
    "OUTBOX_POLL_INTERVAL",
    "OUTBOX_MAX_ATTEMPTS",
    "FUATILIA_PG_MAX_CONNS",
    "FUATILIA_PG_MAX_CONN_LIFETIME",
    "FUATILIA_PG_MAX_CONN_IDLE_TIME",
    "POSTGRES_USER",
    "POSTGRES_DB",
    "POSTGRES_PASSWORD",
}
SCRIPT_SUFFIXES = (".cjs", ".js", ".mjs", ".sql", ".sh")

failures: list[str] = []
pending: list[str] = []


def record(ok: bool, message: str, *, soft: bool = False) -> None:
    """Print one check result; hard failures accumulate, pending does not."""
    tag = "  OK  " if ok else ("PENDING" if soft else " FAIL ")
    print(f"  [{tag}] {message}")
    if not ok and not soft:
        failures.append(message)


def section(title: str) -> None:
    print(f"\n[{title}]")


# --------------------------------------------------------------------------
# [1] compose YAML parse
# --------------------------------------------------------------------------
def load_compose() -> tuple[dict | None, str]:
    try:
        import yaml  # noqa: PLC0415 — deliberately the only import path
    except ImportError:
        print(
            "ERROR: PyYAML is required (no fallback parser is committed by design).\n"
            "  pip install pyyaml"
        )
        sys.exit(2)
    raw = COMPOSE.read_text(encoding="utf-8")
    return yaml.safe_load(raw), raw


# --------------------------------------------------------------------------
# [2] referenced paths exist
# --------------------------------------------------------------------------
def check_referenced_paths(doc: dict) -> None:
    section("2. referenced paths exist (build contexts, Dockerfiles, mounts, scripts)")
    services = doc.get("services") or {}
    for name, cfg in sorted(services.items()):
        build = (cfg or {}).get("build") or {}
        if isinstance(build, str):
            build = {"context": build}
        if build:
            ctx = build.get("context", ".")
            ctx_path = (REPO / ctx).resolve()
            record(
                ctx_path.is_dir(),
                f"services.{name}: build context {ctx!r} exists",
            )
            dockerfile = build.get("dockerfile", "Dockerfile")
            df_path = ctx_path / dockerfile
            record(df_path.is_file(), f"services.{name}: dockerfile {ctx}/{dockerfile} exists")
            if name in ("api", "worker"):
                ignore = ctx_path / ".dockerignore"
                record(
                    ignore.is_file(),
                    f"services.{name}: build context has a .dockerignore ({ctx}/.dockerignore)",
                )
        for mount in (cfg or {}).get("volumes") or []:
            host = mount.split(":")[0] if isinstance(mount, str) else None
            if host and host.startswith("./"):
                record(
                    (REPO / host).exists(),
                    f"services.{name}: host path {host!r} exists",
                )
        for field in ("entrypoint", "command"):
            tokens = (cfg or {}).get(field) or []
            if isinstance(tokens, str):
                tokens = tokens.split()
            for tok in tokens:
                if (
                    isinstance(tok, str)
                    and tok.endswith(SCRIPT_SUFFIXES)
                    and "${" not in tok
                ):
                    record(
                        (REPO / tok).is_file(),
                        f"services.{name}: {field} references file {tok!r} — exists",
                    )

    for path, why in (
        (ENV_EXAMPLE, "environment contract"),
        (DEPLOY_DOC, "deployment documentation"),
        (BACKEND_GO / "go.mod", "Dockerfile COPY go.mod"),
        (BACKEND_GO / "go.sum", "Dockerfile COPY go.sum"),
        (REPO / "db" / "migrations", "migration suite directory"),
    ):
        record(path.exists(), f"repository: {path.relative_to(REPO)} exists ({why})")

    migration_files = list((REPO / "db" / "migrations").glob("*.sql"))
    record(
        len(migration_files) > 0,
        f"repository: db/migrations holds {len(migration_files)} .sql migration(s)",
    )


# --------------------------------------------------------------------------
# [3] parallel-lane binaries (#72 api, #74 worker)
# --------------------------------------------------------------------------
def check_pending_lanes(allow_pending: bool) -> None:
    section("3. parallel-lane binaries (issues #72 / #74 land in parallel)")
    for lane_dir, issue in ((BACKEND_GO / "cmd" / "api", "#72"), (BACKEND_GO / "cmd" / "worker", "#74")):
        go_files = list(lane_dir.glob("*.go")) if lane_dir.is_dir() else []
        ok = bool(go_files)
        msg = (
            f"{lane_dir.relative_to(REPO)}/ exists with {len(go_files)} .go file(s) (issue {issue})"
            if ok
            else f"{lane_dir.relative_to(REPO)}/ not on this branch yet (built by parallel lane, issue {issue})"
        )
        record(ok, msg, soft=allow_pending)
    if allow_pending and failures == []:
        print(
            "  note   : --allow-pending-lanes is ACTIVE — the Dockerfile compiles\n"
            "           ./cmd/api and ./cmd/worker at the agreed paths; those dirs\n"
            "           arrive via issues #72/#74 and the plain (flagless) validator\n"
            "           run must exit 0 on the merged tree."
        )


# --------------------------------------------------------------------------
# [4] Dockerfile structure
# --------------------------------------------------------------------------
FROM_RE = re.compile(r"(?im)^\s*FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$")


def dockerfile_stages(text: str) -> list[tuple[str, str, str]]:
    """Split a Dockerfile into (stage_name, from_image, block_text) triples."""
    matches = list(FROM_RE.finditer(text))
    stages = []
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        image = m.group(1)
        name = m.group(2) or image
        stages.append((name, image, text[m.start():end]))
    return stages


def check_dockerfile() -> set[str]:
    section("4. backend-go/Dockerfile structure (multi-stage, static, non-root, pinned)")
    text = DOCKERFILE.read_text(encoding="utf-8")
    stages = dockerfile_stages(text)
    names = {n for n, _, _ in stages}

    record(len(stages) >= 5, f"multi-stage build present ({len(stages)} stages: {', '.join(names)})")
    record(
        {"build-api", "build-worker"} <= names and {"api", "worker"} <= names,
        "defines per-target build stages and final stages 'api' + 'worker'",
    )
    defined: set[str] = set()
    for name, image, _ in stages:
        if image in defined:
            # `FROM <stage>` is an in-file stage reference, not a registry
            # image — only external bases can carry an implicit :latest.
            defined.add(name)
            continue
        if "@" in image:
            pinned = True
        elif ":" in image:
            pinned = not image.endswith(":latest")
        else:
            pinned = False  # bare image ref == implicit :latest
        record(pinned, f"stage {name}: base image {image!r} is pinned (no implicit/explicit :latest)")
        defined.add(name)

    build = next((b for n, _, b in stages if n == "build"), "")
    record("CGO_ENABLED=0" in build, "build stage: CGO_ENABLED=0 (fully static binaries)")
    record("GOTOOLCHAIN=local" in build, "build stage: GOTOOLCHAIN=local (no toolchain downloads)")
    record("./cmd/api" in next((b for n, _, b in stages if n == "build-api"), ""),
           "build-api compiles ./cmd/api (issue #72 path)")
    record("./cmd/worker" in next((b for n, _, b in stages if n == "build-worker"), ""),
           "build-worker compiles ./cmd/worker (issue #74 path)")

    api_block = next((b for n, _, b in stages if n == "api"), "")
    worker_block = next((b for n, _, b in stages if n == "worker"), "")
    for name, block in (("api", api_block), ("worker", worker_block)):
        record(
            bool(re.search(r"(?im)^\s*USER\s+nonroot", block)),
            f"stage {name}: runs as nonroot (USER nonroot)",
        )
        record(
            bool(re.search(r'(?im)^\s*ENTRYPOINT\s+\["/', block)),
            f"stage {name}: exec-form ENTRYPOINT (no shell needed on distroless)",
        )
    record(
        bool(re.search(r"(?im)^\s*EXPOSE\s+8080\s*$", api_block))
        and not re.search(r"(?im)^\s*EXPOSE\s", worker_block),
        "only the api stage declares EXPOSE 8080",
    )
    record(
        "HEALTHCHECK" in api_block and "/v1/health" in api_block and "/bin/busybox" in api_block,
        "api stage: HEALTHCHECK probes its own /v1/health (busybox wget — distroless has no shell)",
    )
    return names


# --------------------------------------------------------------------------
# [5] service graph + [6] posture
# --------------------------------------------------------------------------
def depends_map(cfg: dict) -> dict[str, str | None]:
    dep = cfg.get("depends_on") or {}
    if isinstance(dep, list):
        return {s: None for s in dep}
    return {s: (v or {}).get("condition") for s, v in dep.items()}


def check_graph_and_posture(doc: dict, dockerfile_stages_names: set[str]) -> None:
    section("5. compose service graph (acyclic, required ordering, exposure)")
    services = doc.get("services") or {}
    extra = set(services) - REQUIRED_SERVICES
    record(not extra, f"services are exactly {sorted(REQUIRED_SERVICES)} (unexpected: {sorted(extra) or 'none'})")
    missing = REQUIRED_SERVICES - set(services)
    record(not missing, f"no missing services ({sorted(missing) or 'all present'})")
    if missing or extra:
        return

    graph = {name: set(depends_map(cfg)) for name, cfg in services.items()}
    for name, deps in sorted(graph.items()):
        unknown = deps - set(services)
        record(not unknown, f"services.{name}: depends_on targets exist ({sorted(unknown) or 'ok'})")

    WHITE, GREY, BLACK = 0, 1, 2
    color = {n: WHITE for n in services}

    def dfs(node: str, stack: list[str]) -> None:
        color[node] = GREY
        for dep in graph.get(node, ()):
            if color.get(dep) == GREY:
                record(False, f"service graph has a cycle: {' -> '.join(stack + [node, dep])}")
                return
            if color.get(dep) == WHITE:
                dfs(dep, stack + [node])
        color[node] = BLACK

    for node in services:
        if color[node] == WHITE:
            dfs(node, [])
    record(all(c == BLACK for c in color.values()), "service graph is acyclic")

    api_dep = depends_map(services["api"])
    worker_dep = depends_map(services["worker"])
    migrate_dep = depends_map(services["migrate"])
    record(
        api_dep.get("postgres") == "service_healthy",
        "api depends_on postgres: service_healthy",
    )
    record(
        api_dep.get("migrate") == "service_completed_successfully",
        "api depends_on migrate: service_completed_successfully",
    )
    record(
        worker_dep.get("migrate") == "service_completed_successfully",
        "worker depends_on migrate: service_completed_successfully",
    )
    record("nats" in worker_dep, "worker depends_on nats")
    record(
        migrate_dep.get("postgres") == "service_healthy",
        "migrate depends_on postgres: service_healthy (schema before everything)",
    )

    exposed = {name: (cfg.get("ports") or []) for name, cfg in services.items()}
    offenders = {n: p for n, p in exposed.items() if n != "api" and p}
    record(not offenders, f"only api exposes ports (offenders: {offenders or 'none'})")
    record(bool(exposed.get("api")), f"api publishes its port ({exposed.get('api')})")
    record(
        not any("expose" in (cfg or {}) for cfg in services.values()),
        "no service uses the redundant 'expose' key",
    )

    section("6. compose posture (pinned images, volumes, jetstream, one-shot migrate)")
    record(
        str(services["postgres"].get("image", "")).startswith("postgres:16"),
        f"postgres image pinned to the 16 line ({services['postgres'].get('image')})",
    )
    record(
        str(services["nats"].get("image", "")).startswith("nats:2.11"),
        f"nats image pinned to the 2.11 line ({services['nats'].get('image')})",
    )
    record(
        services["migrate"].get("image") == "node:22-alpine",
        "migrate runs node:22-alpine (issue-specified one-shot runner)",
    )
    for name in ("api", "worker"):
        target = (services[name].get("build") or {}).get("target")
        record(
            target in dockerfile_stages_names,
            f"services.{name}: build target {target!r} exists in backend-go/Dockerfile",
        )

    nats_cmd = services["nats"].get("command") or []
    nats_cmd = " ".join(nats_cmd if isinstance(nats_cmd, list) else [str(nats_cmd)])
    record(
        "-js" in nats_cmd or "--jetstream" in nats_cmd,
        f"nats runs with JetStream enabled ({nats_cmd!r})",
    )
    record(
        "-sd" in nats_cmd or "--store_dir" in nats_cmd,
        "nats stream state is directed at the JetStream volume mount",
    )

    volumes = set((doc.get("volumes") or {}))
    record(REQUIRED_NAMED_VOLUMES <= volumes, f"named volumes declared: {sorted(REQUIRED_NAMED_VOLUMES)}")
    pg_mounts = [m for m in (services["postgres"].get("volumes") or []) if "fuatilia_pgdata" in str(m)]
    record(
        any("/var/lib/postgresql/data" in str(m) for m in pg_mounts),
        "postgres data lives on the named volume fuatilia_pgdata",
    )
    nats_mounts = [m for m in (services["nats"].get("volumes") or []) if "fuatilia_nats" in str(m)]
    record(
        any("/data" in str(m) for m in nats_mounts),
        "nats JetStream state lives on the named volume fuatilia_nats",
    )
    record(
        not services["postgres"].get("ports") and not services["nats"].get("ports"),
        "postgres and nats publish nothing to the host (internal network only)",
    )

    entry = services["migrate"].get("entrypoint") or []
    record(
        any("db/migrate.cjs" in str(t) for t in entry),
        f"migrate one-shot runs db/migrate.cjs ({entry})",
    )
    record(
        services["migrate"].get("restart") in (None, "no"),
        "migrate is a one-shot (restart: no) — not a daemon",
    )
    pg_health = (services["postgres"].get("healthcheck") or {}).get("test") or []
    record(
        any("pg_isready" in str(t) for t in pg_health),
        "postgres has a pg_isready healthcheck (gates api/worker startup)",
    )


# --------------------------------------------------------------------------
# [7] environment contract
# --------------------------------------------------------------------------
ENV_KEY_RE = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=")
COMPOSE_REF_RE = re.compile(r"(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)")
GO_ENV_RE = re.compile(r"os\.(?:Getenv|LookupEnv)\(\s*\"([A-Za-z0-9_]+)\"")


def env_example_keys() -> dict[str, str]:
    keys: dict[str, str] = {}
    for line in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = ENV_KEY_RE.match(line)
        if m:
            keys[m.group(1)] = line.split("=", 1)[1]
    return keys


def check_env_contract(doc: dict, raw_compose: str) -> None:
    section("7. environment contract (.env.example ⊇ compose refs ∪ backend-go reads)")
    keys = env_example_keys()
    record(bool(keys), f".env.example parses ({len(keys)} keys)")

    compose_refs = set(COMPOSE_REF_RE.findall(raw_compose))
    record(bool(compose_refs), f"compose interpolates {len(compose_refs)} variable(s): {sorted(compose_refs)}")

    go_reads: set[str] = set()
    for go in sorted(BACKEND_GO.rglob("*.go")):
        if go.name.endswith("_test.go"):
            continue
        go_reads |= set(GO_ENV_RE.findall(go.read_text(encoding="utf-8")))
    record(
        True,
        f"backend-go Go sources read {len(go_reads)} env var(s) via os.Getenv/LookupEnv: "
        f"{sorted(go_reads) or '(none yet — cmd lanes pending)'}",
    )

    required_missing = REQUIRED_ENV_KEYS - set(keys)
    record(
        not required_missing,
        f".env.example carries every contract key ({sorted(required_missing) or 'all present'})",
    )

    drift = (compose_refs | go_reads) - set(keys)
    record(
        not drift,
        f"no drift: compose refs ∪ backend-go reads ⊆ .env.example keys (missing: {sorted(drift) or 'none'})",
    )

    values = keys
    for cred in ("POSTGRES_PASSWORD", "DATABASE_URL"):
        record(
            "CHANGE_ME" in values.get(cred, ""),
            f".env.example: {cred} is a CHANGE_ME placeholder, not a default credential",
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="Static gate for the Fuatilia deployment foundation.")
    parser.add_argument(
        "--allow-pending-lanes",
        action="store_true",
        help="downgrade missing backend-go/cmd/{api,worker} (issues #72/#74) from failure to PENDING",
    )
    args = parser.parse_args()

    print("fuatilia deployment foundation — static validator")
    print(f"repo: {REPO}")
    print("mode: " + ("--allow-pending-lanes (parallel lanes #72/#74 not yet merged)" if args.allow_pending_lanes else "strict"))

    section("1. docker-compose.yml parses as YAML")
    doc, raw = load_compose()
    record(isinstance(doc, dict) and "services" in doc, "compose file parsed and has a services map")
    if not isinstance(doc, dict) or "services" not in doc:
        print("\nVALIDATION FAILED — compose file unparseable")
        return 1

    check_referenced_paths(doc)
    check_pending_lanes(args.allow_pending_lanes)
    stage_names = check_dockerfile()
    check_graph_and_posture(doc, stage_names)
    check_env_contract(doc, raw)

    print()
    if failures:
        print(f"VALIDATION FAILED — {len(failures)} gate failure(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("VALIDATION PASSED — all static gates green")
    if pending:
        for p in pending:
            print(f"  (pending) {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
