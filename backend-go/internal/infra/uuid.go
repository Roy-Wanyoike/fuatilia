package infra

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"regexp"
)

// uuidShape is the canonical 8-4-4-4-12 form accepted across the wire
// (route/body fields validated as UUIDs). Any version nibble is accepted:
// the schema's DEFAULT gen_random_uuid() emits v4 but historical rows must
// not be refused.
var uuidShape = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// NewUUID returns a fresh RFC 4122 v4 UUID string from crypto/rand. This is
// the kernel's idGen port — the TS lanes use crypto.randomUUID. The module
// manifest is dispatcher-owned and carries no uuid dependency, so the v4
// layout (version nibble 4, RFC variant bits) is stamped here over 16 random
// bytes — the exact construction of the TS id port, stdlib-only.
func NewUUID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		// crypto/rand never fails on supported platforms; refuse loudly rather
		// than emitting a collidable id.
		panic(fmt.Sprintf("crypto/rand unavailable: %v", err))
	}
	buf[6] = (buf[6] & 0x0f) | 0x40 // version 4
	buf[8] = (buf[8] & 0x3f) | 0x80 // RFC 4122 variant
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(buf[0:4]),
		hex.EncodeToString(buf[4:6]),
		hex.EncodeToString(buf[6:8]),
		hex.EncodeToString(buf[8:10]),
		hex.EncodeToString(buf[10:16]))
}

// IsUUID reports whether raw is a well-formed canonical UUID string.
func IsUUID(raw string) bool { return uuidShape.MatchString(raw) }

// RandomHex returns n random bytes as lowercase hex (used for unusable
// provisioned credential verifiers — no plaintext maps to them).
func RandomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Sprintf("crypto/rand unavailable: %v", err))
	}
	return hex.EncodeToString(buf)
}
