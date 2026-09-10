package observability

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
)

// Structured logging (issue #88): the slog JSON factory plus the redaction
// handler that stands between every emitter and the wire.
//
// Level comes from FUATILIA_LOG_LEVEL (debug|info|warn|error,
// case-insensitive, default info). Redaction is enforced by a wrapping
// slog.Handler, NOT by emitter discipline: keys that CONTAIN
// authorization, password, token, secret or credential (case-insensitive)
// are never emitted — at the top level, inside slog groups at any depth,
// or inside map values smuggled through slog.Any. An attribute whose group
// path contains a forbidden name is dropped whole (fail closed: a group
// named "credentials" hides everything beneath it), and a group whose
// children are all redacted disappears entirely.

// EnvLogLevel is the only variable the log factory reads.
const EnvLogLevel = "FUATILIA_LOG_LEVEL"

// DefaultLogLevel applies when FUATILIA_LOG_LEVEL is unset or unrecognized —
// a log-level typo must not kill the boot (info is the production default).
const DefaultLogLevel = "info"

// forbiddenFragments are the secret-bearing key fragments. Matching is
// containment on the lowercased key (so "x-authorization", "api_token",
// "clientSecret" and "user_credentials" are all caught).
var forbiddenFragments = []string{"authorization", "password", "token", "secret", "credential"}

// LevelFromEnv resolves FUATILIA_LOG_LEVEL. The bool reports whether the
// value was recognized ("" counts as recognized — the default); unknown
// values fall back to info so the caller MAY warn without failing boot.
func LevelFromEnv(env func(string) string) (slog.Level, bool) {
	raw := ""
	if env != nil {
		raw = strings.ToLower(strings.TrimSpace(env(EnvLogLevel)))
	}
	switch raw {
	case "", DefaultLogLevel:
		return slog.LevelInfo, true
	case "debug":
		return slog.LevelDebug, true
	case "warn", "warning":
		return slog.LevelWarn, true
	case "error":
		return slog.LevelError, true
	default:
		return slog.LevelInfo, false
	}
}

// NewLogger builds the production logger: JSON records on out (os.Stdout
// when out is nil), level from FUATILIA_LOG_LEVEL, redaction always on.
func NewLogger(env func(string) string, out io.Writer) *slog.Logger {
	level, _ := LevelFromEnv(env)
	if out == nil {
		out = os.Stdout
	}
	return NewRedactedLogger(slog.NewJSONHandler(out, &slog.HandlerOptions{Level: level}))
}

// NewRedactedLogger wraps an existing handler with the redaction guard —
// for composition roots that already own their handler.
func NewRedactedLogger(base slog.Handler) *slog.Logger {
	return slog.New(redactHandler{base: base})
}

// redactHandler is the redaction guard around a base slog.Handler. It is
// immutable and safe for concurrent use (the base handler carries the
// synchronization contract; the group stack is copied on every With*).
type redactHandler struct {
	base   slog.Handler
	groups []string // live group path; WithAttrs/WithGroup bookkeeping
}

func (h redactHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.base.Enabled(ctx, level)
}

// WithAttrs pre-filters the attribute context so a secret bound once can
// never leak through any later record emitted from the derived logger.
func (h redactHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	kept := make([]slog.Attr, 0, len(attrs))
	for _, a := range attrs {
		if f, ok := redactAttr(a, h.groups); ok {
			kept = append(kept, f)
		}
	}
	return redactHandler{base: h.base.WithAttrs(kept), groups: copyGroups(h.groups)}
}

func (h redactHandler) WithGroup(name string) slog.Handler {
	groups := copyGroups(h.groups)
	if name != "" {
		groups = append(groups, name)
	}
	// The group is still added to the base: a forbidden group name drops
	// every record attribute beneath it at Handle time (prefix check), and
	// an empty group is omitted by the JSON handler rather than fabricated.
	return redactHandler{base: h.base.WithGroup(name), groups: groups}
}

func (h redactHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.NumAttrs() == 0 {
		return h.base.Handle(ctx, r)
	}
	kept := make([]slog.Attr, 0, r.NumAttrs())
	r.Attrs(func(a slog.Attr) bool {
		if f, ok := redactAttr(a, h.groups); ok {
			kept = append(kept, f)
		}
		return true
	})
	filtered := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	filtered.AddAttrs(kept...)
	return h.base.Handle(ctx, filtered)
}

// redactAttr filters one attribute at group path prefix. ok=false means the
// attribute (and everything beneath it) is forbidden and must be dropped.
func redactAttr(a slog.Attr, prefix []string) (slog.Attr, bool) {
	path := make([]string, 0, len(prefix)+1)
	path = append(path, prefix...)
	path = append(path, a.Key)
	if keyForbidden(path...) {
		return slog.Attr{}, false
	}
	switch a.Value.Kind() {
	case slog.KindGroup:
		children := a.Value.Group()
		kept := make([]slog.Attr, 0, len(children))
		for _, child := range children {
			if f, ok := redactAttr(child, path); ok {
				kept = append(kept, f)
			}
		}
		if len(kept) == 0 {
			// A group whose every child was redacted reveals nothing —
			// drop it instead of emitting an empty object.
			return slog.Attr{}, false
		}
		return slog.Attr{Key: a.Key, Value: slog.GroupValue(kept...)}, true
	case slog.KindAny:
		return slog.Attr{Key: a.Key, Value: redactAnyValue(a.Value)}, true
	default:
		return a, true
	}
}

// redactAnyValue strips forbidden keys from map values smuggled through
// slog.Any (map[string]any and map[string]string, recursively). The input
// map is NEVER mutated — a filtered copy is returned; unhandled shapes pass
// through untouched.
func redactAnyValue(v slog.Value) slog.Value {
	switch m := v.Any().(type) {
	case map[string]any:
		out := make(map[string]any, len(m))
		for k, val := range m {
			if keyForbidden(k) {
				continue
			}
			out[k] = redactAnyValue(slog.AnyValue(val)).Any()
		}
		return slog.AnyValue(out)
	case map[string]string:
		out := make(map[string]string, len(m))
		for k, val := range m {
			if keyForbidden(k) {
				continue
			}
			out[k] = val
		}
		return slog.AnyValue(out)
	default:
		return v
	}
}

// keyForbidden reports whether any segment of the key path (group names and
// the leaf key alike) contains a forbidden fragment, case-insensitively.
func keyForbidden(segments ...string) bool {
	for _, s := range segments {
		ls := strings.ToLower(s)
		for _, fragment := range forbiddenFragments {
			if strings.Contains(ls, fragment) {
				return true
			}
		}
	}
	return false
}

func copyGroups(groups []string) []string {
	out := make([]string, len(groups))
	copy(out, groups)
	return out
}
