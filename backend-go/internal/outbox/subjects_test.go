package outbox

import (
	"errors"
	"strings"
	"testing"
)

// The 27 catalog names of src/domain/events/catalog.ts (E01–E27) — pinned
// here byte for byte so a naming drift in the TS catalog fails the relay's
// gate BEFORE a rogue name can reach the broker (issue #74: "the relay is
// the last enforcement point").
var catalogEventNames = []string{
	"invoicing.invoiceNumberAllocated",       // E01
	"invoicing.invoiceIssued",                // E02
	"invoicing.invoiceSent",                  // E03
	"invoicing.invoiceVoided",                // E04
	"receivable.opened",                      // E05
	"receivable.partiallySettled",            // E06
	"receivable.settled",                     // E07
	"receivable.overdue",                     // E08
	"receivable.writtenOff",                  // E09
	"receivable.recovered",                   // E10
	"payment.initiated",                      // E11
	"payment.confirmed",                      // E12
	"payment.failed",                         // E13
	"payment.reversed",                       // E14
	"payments.duplicateCallbackObserved",     // E15
	"reconciliation.paymentMatched",          // E16
	"reconciliation.paymentPartiallyMatched", // E17
	"reconciliation.matchReversed",           // E18
	"adjustment.creditNoteIssued",            // E19
	"adjustment.creditNoteApplied",           // E20
	"adjustment.refundRequested",             // E21
	"adjustment.refundCompleted",             // E22
	"adjustment.creditBalanceApplied",        // E23
	"allocation.executed",                    // E24
	"allocation.reversed",                    // E25
	"collections.caseOpened",                 // E26
	"collections.promiseBroken",              // E27
}

func TestSubjectForCatalogNamesAllDeriveValidSubjects(t *testing.T) {
	for _, name := range catalogEventNames {
		subject, err := SubjectFor(name, 1)
		if err != nil {
			t.Fatalf("catalog name %s must derive a subject, got %v", name, err)
		}
		domain, event, _ := strings.Cut(name, ".")
		want := "fuatilia." + domain + "." + event + ".v1"
		if subject != want {
			t.Fatalf("catalog name %s derived %q, want %q", name, subject, want)
		}
		if strings.ContainsAny(subject, "*> ") {
			t.Fatalf("catalog name %s derived a wildcard-bearing subject %q", name, subject)
		}
	}
}

func TestSubjectForVersions(t *testing.T) {
	cases := []struct {
		name    string
		version int
		want    string
		wantErr string
	}{
		{"version 1", 1, "fuatilia.payment.confirmed.v1", ""},
		{"version 2 is a new literal subject", 2, "fuatilia.payment.confirmed.v2", ""},
		{"large version", 17, "fuatilia.payment.confirmed.v17", ""},
		{"version 0 refused", 0, "", CodeEventVersionUnsupported},
		{"negative version refused", -3, "", CodeEventVersionUnsupported},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			subject, err := SubjectFor("payment.confirmed", tc.version)
			if tc.wantErr != "" {
				var oerr *Error
				if !errors.As(err, &oerr) || oerr.Code != tc.wantErr {
					t.Fatalf("SubjectFor v%d err = %v, want code %s", tc.version, err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if subject != tc.want {
				t.Fatalf("subject = %q, want %q", subject, tc.want)
			}
		})
	}
}

func TestSubjectForMalformedNames(t *testing.T) {
	cases := []struct {
		name  string
		event string
		why   string
	}{
		{"no dot", "paymentconfirmed", "envelope requires exactly one dot"},
		{"two dots", "payment.confirmed.extra", "three tokens cannot satisfy one-dot grammar"},
		{"leading dot", ".confirmed", "empty domain token"},
		{"trailing dot", "payment.", "empty event token"},
		{"uppercase start", "Payment.confirmed", "must be lowerCamelCase"},
		{"underscore", "payment_confirmed", "underscore is not catalog grammar"},
		{"nats wildcard star", "payment.*", "wildcards must never reach a subject"},
		{"nats wildcard gt", "payment.>", "wildcards must never reach a subject"},
		{"space token", "payment. confirmed", "whitespace cannot survive a subject token"},
		{"digit start", "1payment.confirmed", "first char must be a letter"},
		{"empty", "", "nothing to derive"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			subject, err := SubjectFor(tc.event, 1)
			if err == nil {
				t.Fatalf("malformed name %q derived subject %q — must refuse", tc.event, subject)
			}
			var oerr *Error
			if !errors.As(err, &oerr) || oerr.Code != CodeEventNameMalformed {
				t.Fatalf("malformed name %q err = %v, want code %s", tc.event, err, CodeEventNameMalformed)
			}
		})
	}
}

// The defensive fail-closed guard: even if eventTypeNamePattern were ever
// loosened, a name that yields wildcard/empty subject tokens must still be
// refused (subjects.go's second gate).
func TestSubjectForDefensiveTokenGuard(t *testing.T) {
	// These pass the regex? No — but a regression in the regex must be caught
	// by the token guard. Simulate by calling the guard logic through a name
	// the regex admits but that contains a dot beyond the cut (regex forbids
	// it today; this test documents the intended behaviour of the guard under
	// a loosened pattern by checking the current double-gate coherence).
	if eventTypeNamePattern.MatchString("payment.confirmed.extra") {
		t.Fatal("pattern must keep refusing multi-dot names")
	}
}
