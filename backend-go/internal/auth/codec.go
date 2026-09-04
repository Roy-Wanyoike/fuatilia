package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
)

// SecretCodec is the injected codec port (src/domain/auth/apikeys.ts): the
// domain never imports a crypto library — it owns decisions, the adapter
// owns cryptography.
type SecretCodec interface {
	// Hash derives the stored verifier for a secret.
	Hash(secret string) string
	// Verify decides a presented secret against a stored verifier.
	Verify(secret, storedHash string) bool
}

// SHA256Codec is the production codec, matching the TS reference
// composition's sha256Codec (runtime/memory.ts): SHA-256 hex of the UTF-8
// secret. Verification compares digests with hmac.Equal — constant time, so
// timing cannot leak how much of a hash prefix matched.
type SHA256Codec struct{}

// Hash returns the lowercase hex SHA-256 digest of the secret.
func (SHA256Codec) Hash(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// Verify hashes the presented secret and compares digests in constant time.
func (SHA256Codec) Verify(secret, storedHash string) bool {
	sum := sha256.Sum256([]byte(secret))
	presented := hex.EncodeToString(sum[:])
	return hmac.Equal([]byte(presented), []byte(storedHash))
}
