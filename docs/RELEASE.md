# Release Process

How **Fuatilia** cuts a release. Written to be executable by a **single maintainer** in
one sitting — no release train, no CI dependency (the documented CI billing lock is an
owner action, see [docs/ops/CI-BILLING-BLOCKER.md](ops/CI-BILLING-BLOCKER.md); local
gates remain the merge gate until it clears).

---

## 1. Scope & invariants

- **Source of truth:** `main` on `Roy-Wanyoike/fuatilia`. `main` is append-only
  (squash-merge PRs only, never force-push, never commit directly except release-doc
  chores).
- **Release artifact set:** one `CHANGELOG.md` entry + one git tag `vX.Y.Z` + one GitHub
  Release with auto-generated notes (`.github/release.yml`).
- **One release per delivery wave.** A wave closes when its last PR merges to `main`;
  the release documents exactly that merged set (see [CHANGELOG.md](../CHANGELOG.md)
  for the wave→version mapping already reconstructed: v0.1.0–v0.12.0).
- **No runtime code changes** happen in release lanes. Release work touches only:
  `CHANGELOG.md`, `docs/RELEASE.md`, `.github/release.yml`, tags, GitHub Releases.

## 2. Versioning policy (SemVer, 0.x while pre-GA)

Fuatilia follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html) with
the standard **0.x carve-out**: while the major version is `0`, the public API (HTTP
`/v1` surface, OpenAPI contract, event catalog, webhook signing contract) may change
without a major bump. Rules:

| Change | Pre-GA (0.x) | Post-GA (≥1.0.0) |
|---|---|---|
| New features, new adapters, new domains | **MINOR** (`0.11.0 → 0.12.0`) | MINOR |
| Breaking API/schema/event-contract change | **MINOR** (0.x allows it; the entry MUST be flagged `**BREAKING**` in `CHANGELOG.md` and listed first under `Changed`) | **MAJOR** |
| Fix-only cut-down (no features) | **PATCH** | PATCH |
| Dependency major bumps | ride along in the wave's MINOR | MINOR |

- **MINOR = wave.** One wave → one MINOR release. PATCH releases exist only if a defect
  must ship outside a wave.
- **1.0.0 (GA) is gated on all of:** GitHub Actions gates green on `main` (billing lock
  resolved), a production deployment running real PostgreSQL 16 + NATS JetStream, the
  R1–R10 financial-truth invariant audit re-run on the deployed stack, and a complete
  `CHANGELOG.md`. Until then every release is `0.x` and carries no stability guarantee.

## 3. Tag discipline

- **Format:** annotated tags `vMAJOR.MINOR.PATCH` (`v0.12.0`), created on `main` at the
  exact commit the release documents.
- **Never move or delete a pushed tag.** A mistake is fixed forward with a new PATCH
  release (`v0.12.1`), never by re-cutting `v0.12.0`.
- **Tag message:** `fuatilia vX.Y.Z — wave N: <theme>` (theme = the wave name used in
  `CHANGELOG.md`).
- **Order of operations is fixed:** changelog entry lands → tag → push → GitHub Release.
  A release without a `CHANGELOG.md` entry does not exist.

### 4. Historical tag backfill (optional, exact)

The wave history v0.1.0–v0.11.0 was reconstructed (see the provenance note in
[CHANGELOG.md](../CHANGELOG.md)) — no tags existed before v0.12.0. `main` is
squash-merge-only and append-only, so these SHAs are stable and the backfill is exact:

| Version | Wave closed by | Merge commit (main) |
|---|---|---|
| v0.1.0 | PR #11 (wave 1) | `c896c551ee48fd90729ab87cd61e0e4a661433bd` |
| v0.2.0 | PR #14 (wave 2) | `f1d3d4293d46925db6ebdb97f3e347a2a280c661` |
| v0.3.0 | PR #33 (wave 3) | `b160590986c476efbc5f5c1cf03d839bb68d5183` |
| v0.4.0 / v0.5.0 | waves 4–5 interleaved (#38–#45) | `3bcb842197a9d8b33f229dfbf018ccaa3803bbdd` (after #45) — backfill **v0.5.0 only**, or skip |
| v0.6.0 | PR #51 (wave 6) | `7b9bd24da01148ce230cd5e856ef208eaf208a3a` |
| v0.7.0 | PR #59 (wave 7) | `ab7ccbb595ea323861e82a176371169536e0c094` |
| v0.8.0 | PR #63 (wave 8) | `8be0d08c0c76e66d79ee786a534792a73a9e3e00` |
| v0.9.0 | PR #71 (wave 9) | `74d54ae41654233408a34911b30153faa77130cf` |
| v0.10.0 | PR #81 (wave 10) | `3b79e805f88aabf5ddcbfc93f088bb863b269cad` |
| v0.11.0 | PR #124 (wave 11) | `f8e237e5969c224f5c988c5c83b9e828dc340003` |

Backfill (run from a clean checkout of `main`):

```bash
for vt in "v0.1.0:c896c551" "v0.2.0:f1d3d429" "v0.3.0:b160590" \
          "v0.6.0:7b9bd24d" "v0.7.0:ab7ccbb5" "v0.8.0:8be0d08c" \
          "v0.9.0:74d54ae4" "v0.10.0:3b79e805" "v0.11.0:f8e237e5"; do
  tag="${vt%%:*}"; sha="${vt##*:}"
  git tag -a "$tag" "$sha" -m "fuatilia $tag — historical wave release (backfilled per docs/RELEASE.md)"
done
git push origin v0.1.0 v0.2.0 v0.3.0 v0.6.0 v0.7.0 v0.8.0 v0.9.0 v0.10.0 v0.11.0
```

Skipping the backfill is acceptable; v0.12.0 (`e60aca2`, current `main` tip at the time
of writing) is the first *real* tag and everything from here on is tagged at cut time.

## 5. Release notes: GitHub auto-generation + template

### 5.1 How `Closes #N` flows into the notes

The repo contract is **issue → PR (`Closes #N`) → full gates green → merge closes the
issue**. It flows into releases like this:

1. Every PR title/body carries `Closes #N` (titles included — this is repo convention,
   e.g. `feat(comms): email provider adapter — SMTP, idempotent sends, redaction-safe
   metadata (Closes #127)`).
2. The squash-merge onto `main` keeps that trailer in the commit message → GitHub
   auto-closes issue #N at merge time.
3. GitHub's auto-generated release notes list each merged PR **title verbatim**, so the
   `(Closes #N)` reference travels into the release notes automatically — a reader can
   walk from the note to the PR to the closed issue.
4. `CHANGELOG.md` records the PR number (`(#125)`); the issue closure is visible via the
   PR. Do not duplicate `Closes` lines in the changelog itself.
5. After `gh release create --generate-notes`, spot-check that every PR listed in the
   new `CHANGELOG.md` section appears in the generated notes, and that the issues
   closed by the wave show `closed` on GitHub.

### 5.2 Label→category mapping (`.github/release.yml`)

Auto-generated notes bucket PRs by **label**. Labels that exist today:
`bug`, `enhancement`, `feature`, `documentation`, `docs`, `dependencies`,
`github_actions`, `devops`, `compliance`, `agent-ready`, plus the GitHub defaults
(`duplicate`, `invalid`, `question`, `wontfix`, `good first issue`, `help wanted`,
`accessibility`).

Create the two missing ones once:

```bash
gh label create breaking --repo Roy-Wanyoike/fuatilia --color D93F0B --description "Breaking API/schema/contract change (flag in CHANGELOG too)"
gh label create security --repo Roy-Wanyoike/fuatilia --color B60205 --description "Security or credential-hygiene fix"
```

And label PRs at open time (single maintainer habit, 5 seconds per PR):

```bash
gh pr edit <N> --repo Roy-Wanyoike/fuatilia --add-label feature      # or bug, docs, dependencies, ...
```

Unlabelled PRs fall into **Other changes** (the `"*"` catch-all), so nothing is ever
dropped from the notes.

### 5.3 Notes template

Use this as the body (`--notes-file`) on top of the generated list, or store it in
`.github/RELEASE_TEMPLATE.md` and paste per release:

```markdown
## Wave N — <theme>

<One paragraph: what this wave makes true for the product. Money-truth invariants
touched (R1–R10) and how they are preserved.>

## Highlights
- <3–6 bullets, user/operator-facing>

## Closes
- #N, #N, #N   <!-- issues closed by this wave via `Closes #N` -->

## Verification
- make gate green on <main SHA>   <!-- typecheck · vitest · gofmt · govet · gotest -->
- db validate: ALL GATES GREEN    <!-- when db migrations changed -->
- OpenAPI PASS                    <!-- when the /v1 contract changed -->

**Full Changelog**: see [CHANGELOG.md](https://github.com/Roy-Wanyoike/fuatilia/blob/main/CHANGELOG.md)
```

## 6. Single-maintainer runbook (executable)

Prerequisite: a clean checkout on `main`, up to date. The version below is `$V`
(e.g. `0.13.0`), wave `$W`, theme `$T`.

```bash
# 0. Preconditions
git checkout main && git pull --ff-only
git status --porcelain            # must be empty
export V=0.13.0 W=13 T="wave-13 theme"

# 1. Verify the wave's gates on the exact main tip (local gate is the merge gate)
make gate                         # typecheck · vitest · gofmt · govet · gotest
#    db migrations changed?  cd db && ./validate.sh
#    /v1 contract changed?   python3 scripts/validate_openapi.py

# 2. Reconstruct the wave's merged-PR set (accuracy over memory)
gh pr list --repo Roy-Wanyoike/fuatilia --state merged --limit 100 --json number,title,mergedAt

# 3. Write the CHANGELOG.md entry: Unreleased -> [v$V] — wave $W — date,
#    Added/Changed/Fixed, one bullet per merged PR with (#N). Commit it.
git add CHANGELOG.md && git commit -m "chore(release): v$V — wave $W changelog"

# 4. Tag exactly the commit the entry documents
git tag -a "v$V" -m "fuatilia v$V — wave $W: $T"

# 5. Push both
git push origin main "v$V"

# 6. Create the GitHub Release with auto-generated notes
gh release create "v$V" --repo Roy-Wanyoike/fuatilia \
  --generate-notes \
  --title "v$V — wave $W: $T" \
  --notes-file release-notes.md      # body from the §5.3 template; --generate-notes appends What's Changed + Full Changelog

# 7. Verify
gh release view "v$V" --repo Roy-Wanyoike/fuatilia   # notes + categories sane
gh pr list --repo Roy-Wanyoike/fuatilia --state merged --limit 50   # every wave PR listed once in the notes
```

**Hotfix path (outside a wave):** branch from the tagged commit, fix, PR with
`Closes #N`, gates green, merge; bump **PATCH** (`v$V` → `v$V+0.0.1`), add a
`CHANGELOG.md` entry, tag, `gh release create --generate-notes`. Cherry-pick only what
the fix needs; never re-tag an old version.

**Rollback policy:** releases are immutable. Bad release → fix forward as a PATCH. A
broken tag must never be deleted or moved once pushed.

### Post-release checklist

- [ ] `CHANGELOG.md` entry exists, every wave PR appears exactly once, correct section
- [ ] Tag `v$V` is on `main` at the documented commit, pushed
- [ ] GitHub Release exists with `--generate-notes` output + template body
- [ ] All wave issues auto-closed (`Closes #N` worked)
- [ ] Labels on the wave's PRs matched `.github/release.yml` categories
- [ ] Worklog (`worklog.md`) updated with the release record
