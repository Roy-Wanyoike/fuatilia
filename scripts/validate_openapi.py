#!/usr/bin/env python3
"""
validate_openapi.py — the gate for the FuatiliA /v1 OpenAPI contract (issue #67).

WHAT IT DOES (three stages, ALL must pass for exit 0):

  1. SPEC VALIDATION
     Primary: the `openapi_spec_validator` package (pip install --user
     openapi-spec-validator) validates the document against the official
     OpenAPI 3.1 schema.
     Fallback (documented choice): when the package is unavailable (offline
     install, minimal CI image), a structural check runs PyYAML +
     jsonschema (Draft 2020-12) against the OpenAPI 3.1 meta-schema SUBSET
     this repo needs — OAS_VERSION_META below. It covers: document level
     fields, every path item's legal methods, every operation (responses
     required; operationId/parameters/requestBody/security/
     x-required-permission shapes), responses (description required),
     components (schemas/parameters/responses/securitySchemes/headers),
     and full $ref resolution across the document. This is deliberately a
     SUBSET: it cannot replace the official validator, it just fails loudly
     on the structural mistakes this lane can actually make.

  2. PERMISSION VOCABULARY CROSS-CHECK (read-only)
     Every `x-required-permission` STRING on every operation must appear in
     the closed PERMISSIONS array extracted from src/domain/auth/roles.ts.
     The script READS repo files; it never modifies them. `null` means the
     operation is public (no authentication is attempted — routes/public.ts)
     and is valid only for that.

  3. ROUTE-TABLE CONSISTENCY CROSS-CHECK (read-only)
     The (method, pattern) rows are extracted from the FOUR mounted route
     tables + the public table (src/adapters/http/routes/{public,auth,
     receivables,payments,collections}.ts) and must match the spec's
     (method, path) set EXACTLY — same count, same members. The spec may
     never document an unmounted route nor omit a mounted one.

USAGE:  python3 scripts/validate_openapi.py   (from the repo root, or anywhere
        — the repo root is resolved from this script's location).
EXIT:   0 = all stages pass; 1 = any check failed (reasons printed).
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SPEC_PATH = REPO_ROOT / "api" / "openapi" / "fuatilia.v1.yaml"
ROLES_PATH = REPO_ROOT / "src" / "domain" / "auth" / "roles.ts"
ROUTE_TABLES = [
    REPO_ROOT / "src" / "adapters" / "http" / "routes" / "public.ts",
    REPO_ROOT / "src" / "adapters" / "http" / "routes" / "auth.ts",
    REPO_ROOT / "src" / "adapters" / "http" / "routes" / "receivables.ts",
    REPO_ROOT / "src" / "adapters" / "http" / "routes" / "payments.ts",
    REPO_ROOT / "src" / "adapters" / "http" / "routes" / "collections.ts",
]

HTTP_METHODS = {"get", "put", "post", "patch", "delete", "head", "options", "trace"}

# ---------------------------------------------------------------------------
# The OpenAPI 3.1 meta-schema SUBSET (fallback validator). Deliberately
# minimal: the shapes this repo's contract can take, with full $ref chasing.
# ---------------------------------------------------------------------------
OAS_VERSION_META = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "OpenAPI 3.1 meta-schema subset (fuatilia lane)",
    "type": "object",
    "required": ["openapi", "info", "paths"],
    "properties": {
        "openapi": {"type": "string", "pattern": "^3\\.1\\.\\d+(-.+)?$"},
        "info": {
            "type": "object",
            "required": ["title", "version"],
            "properties": {
                "title": {"type": "string"},
                "version": {"type": "string"},
                "summary": {"type": "string"},
                "description": {"type": "string"},
            },
        },
        "servers": {"type": "array", "items": {"type": "object"}},
        "tags": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["name"],
                "properties": {"name": {"type": "string"}},
            },
        },
        "security": {"type": "array", "items": {"type": "object"}},
        # path items: keys are paths, values validated recursively below
        "paths": {"$ref": "#/$defs/pathItems"},
        "components": {
            "type": "object",
            "properties": {
                "schemas": {"type": "object"},
                "parameters": {"type": "object"},
                "responses": {"type": "object"},
                "headers": {"type": "object"},
                "securitySchemes": {"type": "object"},
            },
        },
    },
    "$defs": {
        "pathItems": {
            "type": "object",
            "propertyNames": {"pattern": "^/"},
            "additionalProperties": {"$ref": "#/$defs/pathItem"},
        },
        "pathItem": {
            "type": "object",
            "properties": {
                meth: {"$ref": "#/$defs/operation"} for meth in HTTP_METHODS
            },
            "additionalProperties": {
                # path-level parameters/$ref/etc. — permissive, checked below
            },
        },
        "operation": {
            "type": "object",
            "required": ["responses"],
            "properties": {
                "tags": {"type": "array", "items": {"type": "string"}},
                "summary": {"type": "string"},
                "description": {"type": "string"},
                "operationId": {"type": "string"},
                "parameters": {
                    "type": "array",
                    "items": {"$ref": "#/$defs/parameterOrRef"},
                },
                "requestBody": {"$ref": "#/$defs/requestBodyOrRef"},
                "responses": {"$ref": "#/$defs/responses"},
                "security": {"type": "array", "items": {"type": "object"}},
                "x-required-permission": {
                    "oneOf": [{"type": "string"}, {"type": "null"}]
                },
            },
        },
        "ref": {
            "type": "object",
            "required": ["$ref"],
            "properties": {
                "$ref": {"type": "string", "pattern": "^#/"},
                "summary": {"type": "string"},
                "description": {"type": "string"},
            },
        },
        "parameterOrRef": {
            "oneOf": [
                {"$ref": "#/$defs/ref"},
                {"$ref": "#/$defs/parameter"},
            ],
        },
        "requestBodyOrRef": {
            "oneOf": [
                {"$ref": "#/$defs/ref"},
                {"$ref": "#/$defs/requestBody"},
            ],
        },
        "responseOrRef": {
            "oneOf": [
                {"$ref": "#/$defs/ref"},
                {"$ref": "#/$defs/response"},
            ],
        },
        "parameter": {
            "type": "object",
            "required": ["name", "in"],
            "properties": {
                "name": {"type": "string"},
                "in": {"type": "string", "enum": ["path", "query", "header", "cookie"]},
                "required": {"type": "boolean"},
                "schema": {"type": "object"},
            },
        },
        "requestBody": {
            "type": "object",
            "required": ["content"],
            "properties": {
                "required": {"type": "boolean"},
                "content": {"type": "object"},
            },
        },
        "responses": {
            "type": "object",
            "propertyNames": {"pattern": "^(default|[1-5][0-9][0-9])$"},
            "additionalProperties": {"$ref": "#/$defs/responseOrRef"},
        },
        "response": {
            "type": "object",
            "required": ["description"],
            "properties": {
                "description": {"type": "string"},
                "headers": {"type": "object"},
                "content": {"type": "object"},
            },
        },
    },
}


def fail(msg: str) -> None:
    print(f"FAIL: {msg}")
    sys.exit(1)


def load_yaml(path: Path):
    try:
        import yaml
    except ImportError as exc:  # pragma: no cover
        fail(f"PyYAML is required to parse {path.name} ({exc})")
    if not path.exists():
        fail(f"missing file: {path}")
    try:
        with path.open("r", encoding="utf-8") as fh:
            return yaml.safe_load(fh)
    except yaml.YAMLError as exc:
        fail(f"{path.name} is not valid YAML: {exc}")


# --- stage 1: spec validation ------------------------------------------------

def validate_with_official_validator(doc) -> bool:
    """True when the official openapi-spec-validator accepts the document."""
    try:
        try:
            from openapi_spec_validator import validate as oas_validate  # >= 0.7
        except ImportError:
            from openapi_spec_validator import validate_spec as oas_validate  # legacy
    except ImportError:
        return False
    try:
        oas_validate(doc)
    except Exception as exc:  # the validator raises Exception subclasses per version
        fail(f"openapi-spec-validator rejected the spec: {exc}")
    return True


def _all_refs(doc) -> list[str]:
    refs: list[str] = []
    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "$ref" and isinstance(value, str):
                    refs.append(value)
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)
    walk(doc)
    return refs


def _resolve_ref(doc, ref: str):
    if not ref.startswith("#/"):
        raise ValueError(f"non-local $ref is not supported by this checker: {ref}")
    node = doc
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(node, dict) or part not in node:
            raise ValueError(f"unresolvable $ref: {ref}")
        node = node[part]
    return node


def validate_structurally(doc) -> None:
    """PyYAML + jsonschema fallback against the curated OpenAPI 3.1 subset."""
    try:
        import jsonschema
    except ImportError:
        fail("neither openapi-spec-validator nor jsonschema is importable — "
             "pip install openapi-spec-validator (or PyYAML + jsonschema)")
    # 1a. meta-schema subset over the document skeleton
    try:
        jsonschema.Draft202012Validator(OAS_VERSION_META).validate(doc)
    except jsonschema.ValidationError as exc:
        fail(f"spec fails the OpenAPI 3.1 meta-schema subset at "
             f"{list(exc.absolute_path) or ['<document>']}: {exc.message}")
    # 1b. every $ref resolves (jsonschema cannot chase YAML document refs)
    for ref in _all_refs(doc):
        try:
            _resolve_ref(doc, ref)
        except ValueError as exc:
            fail(str(exc))
    # 1c. path params declared on the path item must be templated and required
    for path, item in (doc.get("paths") or {}).items():
        for meth, op in item.items():
            if meth not in HTTP_METHODS or not isinstance(op, dict):
                continue
            for param in op.get("parameters", []) or []:
                if param.get("in") == "path":
                    name = param.get("name")
                    if f"{{{name}}}" not in path:
                        fail(f"operation {meth.upper()} {path}: path parameter "
                             f"'{name}' does not appear in the path template")
                    if not param.get("required"):
                        fail(f"operation {meth.upper()} {path}: path parameter "
                             f"'{name}' must be required")


# --- stage 2: permission vocabulary cross-check (read-only) -------------------

def permissions_from_roles_ts(source: str) -> set[str]:
    """Extract the closed PERMISSIONS array from src/domain/auth/roles.ts."""
    match = re.search(r"export const PERMISSIONS\s*=\s*\[(.*?)\]", source, re.S)
    if not match:
        fail("could not find the PERMISSIONS array in src/domain/auth/roles.ts")
    entries = re.findall(r"'([a-z][a-z0-9]*:[a-zA-Z0-9-]+)'", match.group(1))
    if not entries:
        fail("PERMISSIONS array in roles.ts parsed as empty — extraction bug")
    return set(entries)


def required_permissions_by_operation(doc) -> list[tuple[str, str, object]]:
    """[(method, path, x-required-permission)] for every operation."""
    rows = []
    for path, item in (doc.get("paths") or {}).items():
        for meth, op in item.items():
            if meth not in HTTP_METHODS or not isinstance(op, dict):
                continue
            if "x-required-permission" not in op:
                fail(f"{meth.upper()} {path}: missing x-required-permission "
                     f"(every mounted operation declares it; null = public)")
            rows.append((meth.upper(), path, op["x-required-permission"]))
    return rows


def check_permissions(doc, vocabulary: set[str]) -> int:
    rows = required_permissions_by_operation(doc)
    public = 0
    for meth, path, permission in rows:
        if permission is None:
            public += 1
            continue
        if not isinstance(permission, str):
            fail(f"{meth} {path}: x-required-permission must be a string or null")
        if permission not in vocabulary:
            fail(f"{meth} {path}: x-required-permission '{permission}' is "
                 f"OUTSIDE the closed vocabulary in src/domain/auth/roles.ts")
    print(f"  permissions: {len(rows) - public} permission-gated + {public} "
          f"public operation(s); every permission string is in the roles.ts "
          f"vocabulary ({len(vocabulary)} entries)")
    return len(rows)


# --- stage 3: route-table consistency cross-check (read-only) -----------------

# Rows are `method: 'X',\n pattern: '/v1/...'` (some with a permission column
# that may be a literal or a named constant — irrelevant to this check).
ROUTE_ROW = re.compile(
    r"method:\s*'(GET|POST|PUT|PATCH|DELETE)'\s*,\s*pattern:\s*'(/v1/[^']+)'",
    re.S,
)


def routes_from_route_tables() -> set[tuple[str, str]]:
    rows: set[tuple[str, str]] = set()
    for table in ROUTE_TABLES:
        if not table.exists():
            fail(f"route table missing: {table.relative_to(REPO_ROOT)}")
        source = table.read_text(encoding="utf-8")
        found = {(method, to_openapi_path(pattern))
                 for method, pattern in ROUTE_ROW.findall(source)}
        if not found:
            fail(f"no route rows parsed from {table.name} — the row regex "
                 f"needs updating to match the table's shape")
        rows |= found
    return rows


def to_openapi_path(pattern: str) -> str:
    """`/v1/payments/:paymentId` → `/v1/payments/{paymentId}` (kernel → OAS)."""
    return re.sub(r":([A-Za-z_][A-Za-z0-9_]*)", r"{\1}", pattern)


def routes_from_spec(doc) -> set[tuple[str, str]]:
    rows: set[tuple[str, str]] = set()
    for path, item in (doc.get("paths") or {}).items():
        for meth, op in item.items():
            if meth in HTTP_METHODS and isinstance(op, dict):
                rows.add((meth.upper(), path))
    return rows


def check_routes(doc) -> tuple[int, int]:
    mounted = routes_from_route_tables()
    spec = routes_from_spec(doc)
    missing_in_spec = mounted - spec
    extra_in_spec = spec - mounted
    if missing_in_spec:
        fail("routes MOUNTED but NOT in the spec: "
             + ", ".join(f"{m} {p}" for m, p in sorted(missing_in_spec)))
    if extra_in_spec:
        fail("routes IN THE SPEC but not mounted (aspirational endpoints are "
             "forbidden): " + ", ".join(f"{m} {p}" for m, p in sorted(extra_in_spec)))
    print(f"  routes: {len(mounted)} mounted rows across "
          f"{len(ROUTE_TABLES)} route tables == {len(spec)} spec operations "
          f"over {len(doc.get('paths') or {})} paths — sets match exactly")
    return len(mounted), len(spec)


# --- main ---------------------------------------------------------------------

def main() -> int:
    print(f"fuatilia OpenAPI contract validator")
    print(f"  spec:   {SPEC_PATH.relative_to(REPO_ROOT)}")

    doc = load_yaml(SPEC_PATH)

    if validate_with_official_validator(doc):
        print("  spec:    VALID against the official OpenAPI 3.1 schema "
              "(openapi-spec-validator)")
    else:
        print("  spec:    openapi-spec-validator unavailable — falling back to "
              "the PyYAML + jsonschema structural check against the documented "
              "OpenAPI 3.1 meta-schema SUBSET (see module docstring)")
        validate_structurally(doc)
        print("  spec:    VALID against the meta-schema subset; all $refs resolve; "
              "path parameters templated + required")

    vocabulary = permissions_from_roles_ts(ROLES_PATH.read_text(encoding="utf-8"))
    print(f"  vocab:   {ROLES_PATH.relative_to(REPO_ROOT)} (read-only)")
    operation_count = check_permissions(doc, vocabulary)
    mounted_count, spec_count = check_routes(doc)

    if mounted_count != spec_count or mounted_count != operation_count:
        fail("count mismatch between mounted rows, spec operations and "
             "permission-annotated operations")

    print("PASS: spec valid; permissions in vocabulary; route sets identical "
          f"({mounted_count} == {spec_count} == {operation_count})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
