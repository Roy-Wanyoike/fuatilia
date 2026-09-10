package webhooks

// EnvSigningKeys — the production, environment-backed SigningKeys binding
// (issue #177): endpoint signing secrets resolve from the process
// environment through cmd/worker's configuration, never from the schema
// (0012 stores secret_hash / secret_prefix only) and never from files, code
// or logs (docs/security/secrets.md §1: "Env or KMS — never files, never
// code, never logs").
//
// WEBHOOK_SIGNING_SECRETS grammar (validated at boot, fail-closed):
//
//      entry   := orgUUID ":" endpointUUID ":" secret
//      entries := entry ( "," | "\n" entry )*
//
//   - orgUUID / endpointUUID are canonical lowercase UUID text — the exact
//     shape the 0012 uuid columns render and the claimed rows carry.
//   - secret is non-empty after edge-trim and carries no control characters;
//     the entry separators (comma, newline) can never be part of a secret —
//     a secret that needs them is a configuration error, not a silent
//     truncation.
//   - an empty entry (a doubled or trailing separator) is refused, and a
//     duplicate (org, endpoint) pair is refused: the value is exactly the
//     configured set — one endpoint, one secret.
//
// Rotation path (docs/security/secrets.md §4): update the deployment env and
// rolling-restart the worker between delivery windows — receivers honoring
// the ±5 min skew window tolerate the cutover. The KMS adapter is the same
// port: an implementation of the one-method SigningKeys interface swaps in at
// the cmd/worker wiring site with no worker change; this type is the
// env-backed default, not a ceiling.
//
// Secret material never appears in errors or logs: parse failures identify
// the entry by index and the offending identifier only.

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

// uuidShape matches the canonical lowercase UUID text PostgreSQL uuid
// columns render (8-4-4-4-12 lowercase hex) — the shape ClaimDue returns.
var uuidShape = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// EnvSigningKeys resolves endpoint signing secrets from a parsed
// WEBHOOK_SIGNING_SECRETS value. Construct with ParseEnvSigningKeys; the
// zero value resolves nothing (every SecretFor call fails closed).
type EnvSigningKeys struct {
	keys map[string]string // "org:endpoint" → secret
}

// ParseEnvSigningKeys parses the WEBHOOK_SIGNING_SECRETS env value into a
// SigningKeys resolver. Malformed input is a WEBHOOK_CONFIG_INVALID error —
// the worker refuses to boot rather than deliver unsigned or wrongly-signed
// envelopes. The error never echoes the secret material.
func ParseEnvSigningKeys(raw string) (EnvSigningKeys, error) {
	if strings.TrimSpace(raw) == "" {
		return EnvSigningKeys{}, &Error{Code: CodeConfigInvalid,
			Message: "no signing secrets configured (expected entries of <orgID>:<endpointID>:<secret> separated by commas or newlines)"}
	}
	keys := make(map[string]string)
	for i, entry := range strings.Split(strings.ReplaceAll(raw, "\n", ","), ",") {
		if strings.TrimSpace(entry) == "" {
			return EnvSigningKeys{}, &Error{Code: CodeConfigInvalid,
				Message: fmt.Sprintf("entry %d: empty (expected <orgID>:<endpointID>:<secret>)", i+1)}
		}
		parts := strings.SplitN(entry, ":", 3)
		if len(parts) != 3 {
			return EnvSigningKeys{}, &Error{Code: CodeConfigInvalid,
				Message: fmt.Sprintf("entry %d: expected <orgID>:<endpointID>:<secret>", i+1)}
		}
		orgID := strings.TrimSpace(parts[0])
		endpointID := strings.TrimSpace(parts[1])
		secret := strings.TrimSpace(parts[2])
		if !uuidShape.MatchString(orgID) {
			return EnvSigningKeys{}, &Error{Code: CodeConfigInvalid,
				Message: fmt.Sprintf("entry %d: org id is not canonical lowercase UUID text", i+1)}
		}
		if !uuidShape.MatchString(endpointID) {
			return EnvSigningKeys{}, &Error{Code: CodeConfigInvalid,
				Message: fmt.Sprintf("entry %d: endpoint id is not canonical lowercase UUID text", i+1)}
		}
		if secret == "" {
			return EnvSigningKeys{}, &Error{Code: CodeConfigInvalid,
				Message: fmt.Sprintf("entry %d: secret is empty", i+1)}
		}
		if hasControlChar(secret) {
			return EnvSigningKeys{}, &Error{Code: CodeConfigInvalid,
				Message: fmt.Sprintf("entry %d: secret contains a control character", i+1)}
		}
		key := orgID + ":" + endpointID
		if _, dup := keys[key]; dup {
			return EnvSigningKeys{}, &Error{Code: CodeConfigInvalid,
				Message: fmt.Sprintf("entry %d: duplicate signing secret for endpoint %s (org %s)", i+1, endpointID, orgID)}
		}
		keys[key] = secret
	}
	return EnvSigningKeys{keys: keys}, nil
}

// SecretFor resolves one endpoint's signing secret — the SigningKeys port.
// The context is accepted for signature compatibility only: resolution is an
// in-memory map read with no I/O and no cancellation points. An unknown
// (org, endpoint) pair is WEBHOOK_SECRET_REQUIRED — the delivery records
// "signing key unavailable" and walks the retry ladder instead of sending an
// unsigned envelope (fail closed at delivery time, not just at boot).
func (k EnvSigningKeys) SecretFor(_ context.Context, orgID, endpointID string) (string, error) {
	secret, ok := k.keys[orgID+":"+endpointID]
	if !ok {
		return "", &Error{Code: CodeSecretRequired,
			Message: fmt.Sprintf("no signing secret configured for endpoint %s (org %s) — add it to the deployment's WEBHOOK_SIGNING_SECRETS", endpointID, orgID)}
	}
	return secret, nil
}

// hasControlChar reports whether s carries an ASCII control character —
// never part of an issued secret, always a sign of a broken env value.
func hasControlChar(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}
