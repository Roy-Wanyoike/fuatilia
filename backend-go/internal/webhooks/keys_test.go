package webhooks

// Pure table tests for the env-backed SigningKeys production binding
// (keys.go) — parsing grammar, fail-closed refusals and the SecretFor
// decision. No database, no network: this is the port's contract, exercised
// exactly as cmd/worker binds it (issue #177).

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestParseEnvSigningKeysAcceptsTheDocumentedGrammar(t *testing.T) {
	org := "00000000-0000-4000-8000-000000000001"
	endpoint := "00000000-0000-4000-8000-0000000000aa"
	other := "00000000-0000-4000-8000-0000000000bb"

	t.Run("single entry", func(t *testing.T) {
		keys, err := ParseEnvSigningKeys(org + ":" + endpoint + ":sk_whx_0123456789abcdef")
		if err != nil {
			t.Fatalf("parse single entry: %v", err)
		}
		got, err := keys.SecretFor(context.Background(), org, endpoint)
		if err != nil {
			t.Fatalf("SecretFor: %v", err)
		}
		if got != "sk_whx_0123456789abcdef" {
			t.Fatalf("SecretFor = %q, want the configured secret", got)
		}
	})

	t.Run("comma and newline separated entries", func(t *testing.T) {
		raw := org + ":" + endpoint + ":secret-one\n" +
			org + ":" + other + ":secret-two," +
			"00000000-0000-4000-8000-000000000002:" + endpoint + ":secret-three"
		keys, err := ParseEnvSigningKeys(raw)
		if err != nil {
			t.Fatalf("parse multi entry: %v", err)
		}
		for _, tc := range []struct {
			orgID, endpointID, want string
		}{
			{org, endpoint, "secret-one"},
			{org, other, "secret-two"},
			{"00000000-0000-4000-8000-000000000002", endpoint, "secret-three"},
		} {
			got, err := keys.SecretFor(context.Background(), tc.orgID, tc.endpointID)
			if err != nil {
				t.Fatalf("SecretFor(%s, %s): %v", tc.orgID, tc.endpointID, err)
			}
			if got != tc.want {
				t.Fatalf("SecretFor(%s, %s) = %q, want %q", tc.orgID, tc.endpointID, got, tc.want)
			}
		}
	})

	t.Run("secret may carry colons after the second separator", func(t *testing.T) {
		keys, err := ParseEnvSigningKeys(org + ":" + endpoint + ":whsec_a:b:c")
		if err != nil {
			t.Fatalf("parse colon-bearing secret: %v", err)
		}
		got, err := keys.SecretFor(context.Background(), org, endpoint)
		if err != nil {
			t.Fatalf("SecretFor: %v", err)
		}
		if got != "whsec_a:b:c" {
			t.Fatalf("SecretFor = %q, want whsec_a:b:c", got)
		}
	})

	t.Run("edge whitespace is trimmed from every token", func(t *testing.T) {
		keys, err := ParseEnvSigningKeys("  " + org + " :" + endpoint + ": whsec_padded  ")
		if err != nil {
			t.Fatalf("parse padded entry: %v", err)
		}
		got, err := keys.SecretFor(context.Background(), org, endpoint)
		if err != nil {
			t.Fatalf("SecretFor: %v", err)
		}
		if got != "whsec_padded" {
			t.Fatalf("SecretFor = %q, want whsec_padded", got)
		}
	})
}

func TestParseEnvSigningKeysRefusesMalformedValues(t *testing.T) {
	org := "00000000-0000-4000-8000-000000000001"
	endpoint := "00000000-0000-4000-8000-0000000000aa"

	cases := []struct {
		name string
		raw  string
		want string // substring of the expected message
	}{
		{"empty", "", "no signing secrets configured"},
		{"blank", "   \n  ", "no signing secrets configured"},
		{"trailing comma leaves an empty entry", org + ":" + endpoint + ":secret,", "entry 2: empty"},
		{"double comma", org + ":" + endpoint + ":s1,," + org + ":" + endpoint + ":s2", "entry 2: empty"},
		{"missing secret", org + ":" + endpoint, "expected <orgID>:<endpointID>:<secret>"},
		{"missing endpoint", org, "expected <orgID>:<endpointID>:<secret>"},
		{"empty secret", org + ":" + endpoint + ":", "secret is empty"},
		{"uppercase org uuid", "00000000-0000-4000-8000-00000000000A:" + endpoint + ":secret", "org id is not canonical lowercase UUID"},
		{"uppercase endpoint uuid", org + ":00000000-0000-4000-8000-0000000000AA:secret", "endpoint id is not canonical lowercase UUID"},
		{"non-uuid org", "not-a-uuid:" + endpoint + ":secret", "org id is not canonical lowercase UUID"},
		{"short uuid", "0000:" + endpoint + ":secret", "org id is not canonical lowercase UUID"},
		{"control character in secret", org + ":" + endpoint + ":secret\twith\ttab", "secret contains a control character"},
		{"duplicate pair", org + ":" + endpoint + ":s1," + org + ":" + endpoint + ":s2", "duplicate signing secret"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseEnvSigningKeys(tc.raw)
			if err == nil {
				t.Fatalf("ParseEnvSigningKeys(%q) = nil error, want refusal", tc.raw)
			}
			var domain *Error
			if !errors.As(err, &domain) {
				t.Fatalf("error %v is not a *webhooks.Error", err)
			}
			if domain.Code != CodeConfigInvalid {
				t.Fatalf("code = %s, want %s", domain.Code, CodeConfigInvalid)
			}
			if !strings.Contains(domain.Message, tc.want) {
				t.Fatalf("message %q does not mention %q", domain.Message, tc.want)
			}
		})
	}
}

func TestParseEnvSigningKeysErrorsNeverEchoSecretMaterial(t *testing.T) {
	org := "00000000-0000-4000-8000-000000000001"
	endpoint := "00000000-0000-4000-8000-0000000000aa"
	secret := "sk_whx_SUPER_SECRET_MATERIAL_9f2c"
	// Every refusal below involves the secret-bearing entry; none may echo it.
	raws := []string{
		org + ":" + endpoint,            // missing secret
		org + ":" + endpoint + ":",      // empty secret
		"zz:" + endpoint + ":" + secret, // bad org — fragment not echoed
		org + ":" + endpoint + ":s1,," + org + ":" + endpoint + ":" + secret, // empty middle entry
	}
	for _, raw := range raws {
		_, err := ParseEnvSigningKeys(raw)
		if err == nil {
			t.Fatalf("ParseEnvSigningKeys(%q) = nil error, want refusal", raw)
		}
		if strings.Contains(err.Error(), secret) {
			t.Fatalf("error %q echoes the secret material", err.Error())
		}
	}
}

func TestEnvSigningKeysSecretForFailuresAreFailClosed(t *testing.T) {
	org := "00000000-0000-4000-8000-000000000001"
	endpoint := "00000000-0000-4000-8000-0000000000aa"

	keys, err := ParseEnvSigningKeys(org + ":" + endpoint + ":whsec_known")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}

	t.Run("unknown endpoint refuses with the stable code", func(t *testing.T) {
		_, err := keys.SecretFor(context.Background(), org, "00000000-0000-4000-8000-0000000000ff")
		var domain *Error
		if !errors.As(err, &domain) {
			t.Fatalf("error %v is not a *webhooks.Error", err)
		}
		if domain.Code != CodeSecretRequired {
			t.Fatalf("code = %s, want %s", domain.Code, CodeSecretRequired)
		}
	})

	t.Run("unknown org refuses", func(t *testing.T) {
		if _, err := keys.SecretFor(context.Background(), "00000000-0000-4000-8000-0000000000ff", endpoint); err == nil {
			t.Fatal("unknown org resolved a secret, want refusal")
		}
	})

	t.Run("zero value resolves nothing", func(t *testing.T) {
		if _, err := (EnvSigningKeys{}).SecretFor(context.Background(), org, endpoint); err == nil {
			t.Fatal("zero value resolved a secret, want refusal")
		}
	})
}
