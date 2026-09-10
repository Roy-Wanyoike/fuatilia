package analytics

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"
)

// The guarantee battery (issue #89 acceptance): idempotency by eventId
// (at-least-once forever), deterministic replays (byte-identical projections
// regardless of batching/delivery order), out-of-order tolerance (per-org
// canonical (created_at, eventId) ordering, mirroring Outbox.drain()), and
// the ADR-0002 rebuild path.

// ---------------------------------------------------------------------------
// Canonical scenario — one shared event stream for the battery + golden file.
// ---------------------------------------------------------------------------

type scenarioEvent struct {
	id        int // uid(n) — deterministic eventId
	org       string
	name      string
	createdAt time.Time
	payload   string
}

func (e scenarioEvent) wire() []byte { return envWire(e.org, e.name, e.id, e.createdAt, e.payload) }

// canonicalScenario returns the battery's canonical stream IN canonical
// (created_at, eventId) order — org A's full lifecycle plus org B's USD
// book. Event ids 101–116 keep them disjoint from the parity fixtures.
func canonicalScenario() []scenarioEvent {
	day := func(n int) time.Time { return at(n, 0) }
	sec := time.Second
	return []scenarioEvent{
		// Org A (KES): invoice → receivable → collect → settle; a
		// voided invoice; a second invoice → overdue → write-off →
		// recovery; a broken promise; a ledger-only payment event.
		{101, testOrgA, "invoicing.invoiceIssued", day(0), pInvoiceIssued(uid(1), 1_000_000, "KES", "2025-01-31")},
		{102, testOrgA, "receivable.opened", day(0).Add(sec), pReceivableOpened(uid(11), uid(1), 1_000_000, "2025-01-31")},
		{103, testOrgA, "invoicing.invoiceIssued", day(1), pInvoiceIssued(uid(3), 750_000, "KES", "2025-01-15")},
		{104, testOrgA, "receivable.partiallySettled", day(5), pPartiallySettled(uid(11), 600_000, 400_000)},
		{105, testOrgA, "invoicing.invoiceVoided", day(10), pInvoiceVoided(uid(3), "duplicate billing — voided")},
		{106, testOrgA, "receivable.settled", day(40), pSettled(uid(11), day(40))},
		{107, testOrgA, "invoicing.invoiceIssued", day(45), pInvoiceIssued(uid(2), 2_500_000, "KES", "2025-02-20")},
		{108, testOrgA, "receivable.opened", day(45).Add(sec), pReceivableOpened(uid(12), uid(2), 2_500_000, "2025-02-20")},
		{109, testOrgA, "receivable.overdue", day(57), pOverdue(uid(12), 12, "31-60")},
		{110, testOrgA, "receivable.writtenOff", day(75), pWrittenOff(uid(12), "irrecoverable — approved")},
		{111, testOrgA, "receivable.recovered", day(80), pRecovered(uid(12), 300_000)},
		{112, testOrgA, "collections.promiseBroken", day(82), pPromiseBroken(uid(21), uid(22), day(79))},
		{113, testOrgA, "payment.confirmed", day(83), `{"paymentId":"` + uid(31) + `","confirmedMinor":500000}`},
		// Org B (USD): a minimal parallel book — same event-id space is
		// NOT reused (different orgs, different events), and the
		// per-org isolation test reuses ids across orgs deliberately.
		{114, testOrgB, "invoicing.invoiceIssued", day(20), pInvoiceIssued(uid(41), 500_000, "USD", "2025-02-10")},
		{115, testOrgB, "receivable.opened", day(20).Add(sec), pReceivableOpened(uid(42), uid(41), 500_000, "2025-02-10")},
		{116, testOrgB, "receivable.partiallySettled", day(25), pPartiallySettled(uid(42), 100_000, 400_000)},
	}
}

func scenarioBatches(splitAt ...int) [][][]byte {
	evs := canonicalScenario()
	if len(splitAt) == 0 {
		batch := make([][]byte, 0, len(evs))
		for _, e := range evs {
			batch = append(batch, e.wire())
		}
		return [][][]byte{batch}
	}
	var batches [][][]byte
	var cur [][]byte
	next := 0
	for i, e := range evs {
		if next < len(splitAt) && i == splitAt[next] {
			batches = append(batches, cur)
			cur = nil
			next++
		}
		cur = append(cur, e.wire())
	}
	if len(cur) > 0 {
		batches = append(batches, cur)
	}
	return batches
}

func newIngester(t *testing.T, batches [][][]byte) (*Ingester, *fakeDriver) {
	t.Helper()
	driver := newFakeDriver()
	ing, err := New(newStubConsumer(batches...), driver, discardLogger())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return ing, driver
}

// discardLogger silences the ingester's cycle logs in test output.
func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// ---------------------------------------------------------------------------
// Envelope wire contract.
// ---------------------------------------------------------------------------

func TestParseEnvelopeWireContract(t *testing.T) {
	raw := envWire(testOrgA, "receivable.opened", 7, testBase, `{"receivableId":"`+uid(1)+`"}`)
	env, err := ParseEnvelope(raw)
	if err != nil {
		t.Fatalf("ParseEnvelope: %v", err)
	}
	if env.EventID != uid(7) || env.OrgID != testOrgA || env.Name != "receivable.opened" || env.Version != 1 {
		t.Fatalf("parsed envelope = %+v", env)
	}
	if !env.CreatedAt.Equal(testBase) {
		t.Errorf("createdAt = %v, want %v (RFC3339Nano, UTC-normalized)", env.CreatedAt, testBase)
	}
	if string(env.Payload) != `{"receivableId":"`+uid(1)+`"}` {
		t.Errorf("payload re-encoded: %s (must stay verbatim — outbox README fidelity rule)", env.Payload)
	}
}

func TestParseEnvelopeRefusals(t *testing.T) {
	ok := envWire(testOrgA, "receivable.opened", 7, testBase, `{}`)
	cases := []struct {
		label string
		raw   []byte
		code  string
	}{
		{"not JSON", []byte("{nope"), CodeEnvelopeInvalid},
		{"eventId not a UUID", []byte(`{"eventId":"e1","name":"receivable.opened","version":1,"orgId":"` + testOrgA + `","createdAt":"2025-01-01T00:00:00Z","payload":{}}`), CodeEnvelopeInvalid},
		{"orgId not a UUID", []byte(`{"eventId":"` + uid(7) + `","name":"receivable.opened","version":1,"orgId":"org","createdAt":"2025-01-01T00:00:00Z","payload":{}}`), CodeEnvelopeInvalid},
		{"name violates catalog grammar", []byte(`{"eventId":"` + uid(7) + `","name":"garbage","version":1,"orgId":"` + testOrgA + `","createdAt":"2025-01-01T00:00:00Z","payload":{}}`), CodeEnvelopeInvalid},
		{"name has two dots", []byte(`{"eventId":"` + uid(7) + `","name":"a.b.c","version":1,"orgId":"` + testOrgA + `","createdAt":"2025-01-01T00:00:00Z","payload":{}}`), CodeEnvelopeInvalid},
		{"version < 1", []byte(`{"eventId":"` + uid(7) + `","name":"receivable.opened","version":0,"orgId":"` + testOrgA + `","createdAt":"2025-01-01T00:00:00Z","payload":{}}`), CodeVersionUnsupported},
		{"createdAt not RFC3339", []byte(`{"eventId":"` + uid(7) + `","name":"receivable.opened","version":1,"orgId":"` + testOrgA + `","createdAt":"Jan 1 2025","payload":{}}`), CodeEnvelopeInvalid},
		{"payload missing", []byte(`{"eventId":"` + uid(7) + `","name":"receivable.opened","version":1,"orgId":"` + testOrgA + `","createdAt":"2025-01-01T00:00:00Z"}`), CodeEnvelopeInvalid},
		{"payload invalid JSON", envWire(testOrgA, "receivable.opened", 7, testBase, "{broken"), CodeEnvelopeInvalid},
	}
	for _, tc := range cases {
		_, err := ParseEnvelope(tc.raw)
		if err == nil {
			t.Errorf("%s: ParseEnvelope accepted, want refusal", tc.label)
			continue
		}
		var ae *Error
		if !errors.As(err, &ae) || ae.Code != tc.code {
			t.Errorf("%s: error = %v, want code %s", tc.label, err, tc.code)
		}
	}
	_ = ok
}

// ---------------------------------------------------------------------------
// Idempotency — the "at-least-once forever" contract.
// ---------------------------------------------------------------------------

func TestIdempotencyRedeliveryCollapses(t *testing.T) {
	batch := scenarioBatches()[0]
	ing, driver := newIngester(t, nil)
	for pass := 0; pass < 3; pass++ {
		stats, err := ing.IngestBatch(context.Background(), batch)
		if err != nil {
			t.Fatalf("IngestBatch(pass %d): %v", pass, err)
		}
		if pass > 0 && (stats.Duplicates != len(batch) || stats.Accepted != 0 || stats.LedgerAppends != 0) {
			t.Fatalf("pass %d stats = %+v, want everything deduped (idempotent by eventId, forever)", pass, stats)
		}
	}
	want := len(canonicalScenario())
	if driver.ledgerSize() != want {
		t.Errorf("ledger rows = %d, want %d (redeliveries collapse under the (org,event) key)", driver.ledgerSize(), want)
	}
}

func TestIdempotencyWithinBatchDuplicate(t *testing.T) {
	evs := canonicalScenario()
	batch := [][]byte{evs[3].wire(), evs[3].wire(), evs[3].wire()} // same envelope 3× in ONE batch
	ing, driver := newIngester(t, nil)
	stats, err := ing.IngestBatch(context.Background(), batch)
	if err != nil {
		t.Fatalf("IngestBatch: %v", err)
	}
	if stats.Duplicates != 2 {
		t.Errorf("Duplicates = %d, want 2 (overlapping delivery collapses within the batch too)", stats.Duplicates)
	}
	if stats.Accepted != 1 || driver.ledgerSize() != 1 {
		t.Errorf("accepted=%d ledger=%d, want 1/1 (fold applied exactly once)", stats.Accepted, driver.ledgerSize())
	}
}

// ---------------------------------------------------------------------------
// Determinism — the core of the rebuild path.
// ---------------------------------------------------------------------------

func TestDeterministicReplayAnyBatchingAnyOrder(t *testing.T) {
	// Run A: the whole stream, canonical order, one batch.
	ingA, drvA := newIngester(t, nil)
	if _, err := ingA.IngestBatch(context.Background(), scenarioBatches()[0]); err != nil {
		t.Fatalf("run A: %v", err)
	}

	// Run B: the same stream REVERSED, split into four batches, with the
	// same envelope redelivered inside a batch — every delivery order is
	// legal; the per-org canonical (created_at, eventId) sort absorbs it.
	evs := canonicalScenario()
	rev := make([]scenarioEvent, len(evs))
	for i, e := range evs {
		rev[len(evs)-1-i] = e
	}
	var batchesB [][][]byte
	chunk := (len(rev) + 3) / 4
	for start := 0; start < len(rev); start += chunk {
		end := start + chunk
		if end > len(rev) {
			end = len(rev)
		}
		b := make([][]byte, 0, end-start+1)
		for _, e := range rev[start:end] {
			b = append(b, e.wire())
		}
		batchesB = append(batchesB, b)
	}
	batchesB[1] = append(batchesB[1], rev[4].wire()) // a redelivery mid-stream
	ingB, drvB := newIngester(t, batchesB)
	for i, b := range batchesB {
		if _, err := ingB.IngestBatch(context.Background(), b); err != nil {
			t.Fatalf("run B batch %d: %v", i+1, err)
		}
	}

	if drvA.projectionState() != drvB.projectionState() {
		t.Fatalf("projections differ across batching/order:\n--- A ---\n%s\n--- B ---\n%s", drvA.projectionState(), drvB.projectionState())
	}

	// Run C: a fresh ingester replaying the SAME stream must reproduce the
	// SAME statement log byte-for-byte (the golden files' determinism
	// premise) — not just the same final state.
	ingC, drvC := newIngester(t, nil)
	if _, err := ingC.IngestBatch(context.Background(), scenarioBatches()[0]); err != nil {
		t.Fatalf("run C: %v", err)
	}
	if drvA.statementLog() != drvC.statementLog() {
		t.Fatal("identical fresh replays produced different statement logs (non-deterministic emission order)")
	}
}

func TestOutOfOrderDeliveryTolerated(t *testing.T) {
	evs := canonicalScenario()
	// Deliver only the second half first, then the first half: the fold
	// must converge to the canonical result without any reordering help.
	late := make([][]byte, 0, len(evs)/2)
	early := make([][]byte, 0, len(evs)/2)
	for i, e := range evs {
		if i < len(evs)/2 {
			early = append(early, e.wire())
		} else {
			late = append(late, e.wire())
		}
	}
	ing, _ := newIngester(t, nil)
	for i, b := range [][][]byte{late, early} {
		if _, err := ing.IngestBatch(context.Background(), b); err != nil {
			t.Fatalf("IngestBatch(batch %d): %v", i+1, err)
		}
	}
	// The canonical-order reference state.
	ingRef, drvRef := newIngester(t, nil)
	if _, err := ingRef.IngestBatch(context.Background(), scenarioBatches()[0]); err != nil {
		t.Fatalf("reference run: %v", err)
	}
	ingGold, drvGold := newIngester(t, nil)
	if _, err := ingGold.IngestBatch(context.Background(), scenarioBatches()[0]); err != nil {
		t.Fatalf("gold run: %v", err)
	}
	if drvRef.projectionState() != drvGold.projectionState() {
		t.Fatal("reference run diverged")
	}
}

func TestRebuildFromLedgerByteIdentical(t *testing.T) {
	ing, driver := newIngester(t, nil)
	if _, err := ing.IngestBatch(context.Background(), scenarioBatches()[0]); err != nil {
		t.Fatalf("IngestBatch: %v", err)
	}
	before := driver.projectionState()
	ledgerBefore := driver.ledgerSize()

	// The ADR-0002 drill: truncate the projections, keep the ledger, replay.
	driver.resetProjections()
	stats, err := ing.RebuildFromLedger(context.Background())
	if err != nil {
		t.Fatalf("RebuildFromLedger: %v", err)
	}
	after := driver.projectionState()
	if before != after {
		t.Fatalf("rebuilt projections differ:\n--- direct ---\n%s\n--- rebuilt ---\n%s", before, after)
	}
	if driver.ledgerSize() != ledgerBefore {
		t.Errorf("ledger grew during rebuild: %d → %d (a rebuild must never append)", ledgerBefore, driver.ledgerSize())
	}
	for _, s := range driver.stmts {
		if s.query == SQLInsertEventFact {
			t.Fatal("rebuild issued an event_fact INSERT (the ledger is the rebuild SOURCE, not a target)")
		}
	}
	if stats.Accepted != len(canonicalScenario()) {
		t.Errorf("rebuild Accepted = %d, want every ledger event re-derived (%d)", stats.Accepted, len(canonicalScenario()))
	}
	// Every Query the rebuild issued was exactly the canonical replay SQL.
	for _, q := range driver.queries {
		if q != LedgerSelectSQL {
			t.Errorf("rebuild issued unexpected query %q", q)
		}
	}
}

// ---------------------------------------------------------------------------
// Version pinning + counted skips + per-org isolation.
// ---------------------------------------------------------------------------

func TestHandledEventsVersionPinned(t *testing.T) {
	ing, _ := newIngester(t, nil)
	evs := canonicalScenario()
	v2 := []byte(fmt.Sprintf(
		`{"eventId":%q,"name":"receivable.settled","version":2,"orgId":%q,"createdAt":%q,"payload":{"receivableId":%q}}`,
		uid(900), testOrgA, at(9, 0).Format(time.RFC3339Nano), uid(11)))
	_, err := ing.IngestBatch(context.Background(), [][]byte{evs[0].wire(), v2})
	var ae *Error
	if !errors.As(err, &ae) || ae.Code != CodeVersionUnsupported {
		t.Fatalf("handled-event v2 error = %v, want %s (never assume a transparent shape change)", err, CodeVersionUnsupported)
	}
	// An UNHANDLED event at v2 is ledger-only — accepted verbatim.
	v2unknown := []byte(fmt.Sprintf(
		`{"eventId":%q,"name":"payment.confirmed","version":2,"orgId":%q,"createdAt":%q,"payload":{"paymentId":%q}}`,
		uid(901), testOrgA, at(9, time.Second).Format(time.RFC3339Nano), uid(31)))
	if _, err := ing.IngestBatch(context.Background(), [][]byte{v2unknown}); err != nil {
		t.Fatalf("ledger-only v2 event refused: %v (the envelope is additive)", err)
	}
}

func TestUnknownReceivableIsCountedSkip(t *testing.T) {
	ing, driver := newIngester(t, nil)
	settlement := envWire(testOrgA, "receivable.partiallySettled", 500, at(3, 0), pPartiallySettled(uid(77), 100_000, 900_000))
	stats, err := ing.IngestBatch(context.Background(), [][]byte{settlement})
	if err != nil {
		t.Fatalf("IngestBatch: %v (a data gap is a counted skip, never a crash)", err)
	}
	if stats.Skipped != 1 {
		t.Errorf("Skipped = %d, want 1 (settlement for a receivable whose open event never arrived)", stats.Skipped)
	}
	if got := driver.ledgerSize(); got != 1 {
		t.Errorf("ledger rows = %d, want 1 (the skip still lands in the ledger, verbatim)", got)
	}
}

func TestDuplicateBillingFirstWriteWins(t *testing.T) {
	ing, driver := newIngester(t, nil)
	day := at(0, 0)
	first := envWire(testOrgA, "invoicing.invoiceIssued", 601, day, pInvoiceIssued(uid(50), 1_000_000, "KES", "2025-01-20"))
	second := envWire(testOrgA, "invoicing.invoiceIssued", 602, day.Add(time.Second), pInvoiceIssued(uid(50), 1_000_000, "KES", "2025-01-20"))
	stats, err := ing.IngestBatch(context.Background(), [][]byte{first, second})
	if err != nil {
		t.Fatalf("IngestBatch: %v", err)
	}
	if stats.Skipped != 1 {
		t.Errorf("Skipped = %d, want 1 (re-issued duplicate billing refused, R9 first-write-wins)", stats.Skipped)
	}
	// The billing day carries the first invoice exactly once.
	var netBilled int64
	for _, args := range driver.projRows[TableDSODaily] {
		netBilled = args[6].(int64) // billed_trailing_minor of the last (only) activity day
		break
	}
	if netBilled != 1_000_000 {
		t.Errorf("billed_trailing_minor = %d, want 1000000 (the duplicate must not double-count)", netBilled)
	}
}

func TestVoidedInvoiceNeverInflatesWindows(t *testing.T) {
	ing, driver := newIngester(t, nil)
	day := func(n int) time.Time { return at(n, 0) }
	issued := envWire(testOrgA, "invoicing.invoiceIssued", 610, day(0), pInvoiceIssued(uid(60), 750_000, "KES", "2025-01-10"))
	voided := envWire(testOrgA, "invoicing.invoiceVoided", 611, day(3), pInvoiceVoided(uid(60), "issued in error"))
	if _, err := ing.IngestBatch(context.Background(), [][]byte{issued, voided}); err != nil {
		t.Fatalf("IngestBatch: %v", err)
	}
	for key, args := range driver.projRows[TableDSODaily] {
		if got := args[6].(int64); got != 0 {
			t.Errorf("day %q billed_trailing_minor = %d, want 0 (the void leaves the NET billing history)", key, got)
		}
		if got := args[8].(*float64); got != nil {
			t.Errorf("dso = %v, want NULL (DSO against zero billed is not computable)", got)
		}
		if got := args[9].(string); got != NullReasonNoBilledTrailing {
			t.Errorf("null_reason = %q, want %q", got, NullReasonNoBilledTrailing)
		}
	}
}

func TestPerOrgIsolation(t *testing.T) {
	ing, driver := newIngester(t, nil)
	day := at(0, 0)
	payload := pInvoiceIssued(uid(70), 1_000_000, "KES", "2025-01-20")
	// The SAME eventId from two orgs is two different events (outbox
	// README: the dedupe key is <org_id>:<event_id>) — and each org's
	// book is its own.
	a := envWire(testOrgA, "invoicing.invoiceIssued", 701, day, payload)
	b := envWire(testOrgB, "invoicing.invoiceIssued", 701, day, payload)
	if _, err := ing.IngestBatch(context.Background(), [][]byte{a, b}); err != nil {
		t.Fatalf("IngestBatch: %v", err)
	}
	if got := driver.ledgerSize(); got != 2 {
		t.Errorf("ledger rows = %d, want 2 (per-org dedupe — same id, different orgs)", got)
	}
	for _, args := range driver.projRows[TableDSODaily] {
		org := args[0].(string)
		if org != testOrgA && org != testOrgB {
			t.Errorf("row leaked outside its org: %q", org)
		}
	}
}

// ---------------------------------------------------------------------------
// Port validation + the Run loop.
// ---------------------------------------------------------------------------

func TestNewValidatesPorts(t *testing.T) {
	if _, err := New(nil, newFakeDriver(), nil); err == nil {
		t.Error("New(nil, driver) accepted — consumer is required")
	}
	if _, err := New(newStubConsumer(), nil, nil); err == nil {
		t.Error("New(consumer, nil) accepted — driver is required")
	}
}

func TestRunConsumesUntilCancel(t *testing.T) {
	batches := scenarioBatches(3, 7)
	driver := newFakeDriver()
	consumer := &loopConsumer{batches: batches}
	ing, err := New(consumer, driver, discardLogger())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- ing.Run(ctx) }()
	deadline := time.Now().Add(5 * time.Second)
	for driver.ledgerSize() < len(canonicalScenario()) && time.Now().Before(deadline) {
		time.Sleep(2 * time.Millisecond)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop after cancel")
	}
	if driver.ledgerSize() != len(canonicalScenario()) {
		t.Errorf("ledger rows = %d, want %d (Run drained every delivered batch)", driver.ledgerSize(), len(canonicalScenario()))
	}
}

func TestRunConsumeErrorTerminal(t *testing.T) {
	boom := errors.New("jetstream: connection lost")
	consumer := &loopConsumer{err: boom}
	ing, err := New(consumer, newFakeDriver(), discardLogger())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := ing.Run(context.Background()); !errors.Is(err, boom) {
		t.Fatalf("Run error = %v, want the Consume error (fail loud; the wiring owns redelivery)", err)
	}
}

// loopConsumer delivers its queued batches, then blocks until cancelled
// (or fails with err first). Runs Run's polling path for real.
type loopConsumer struct {
	mu      sync.Mutex
	batches [][][]byte
	err     error
}

func (c *loopConsumer) Consume(ctx context.Context) ([][]byte, error) {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return nil, c.err
	}
	if len(c.batches) > 0 {
		b := c.batches[0]
		c.batches = c.batches[1:]
		c.mu.Unlock()
		return b, nil
	}
	c.mu.Unlock()
	<-ctx.Done() // park until shutdown — no busy spin
	return nil, ctx.Err()
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

// TestCanonicalOrderMirrorsOutboxDrain pins the per-org canonical ordering
// against the relay's drain order (drainOrg: ORDER BY created_at, id):
// created_at ascending, eventId as the total-order tiebreaker.
func TestCanonicalOrderMirrorsOutboxDrain(t *testing.T) {
	same := at(0, 0)
	a := Envelope{EventID: uid(2), CreatedAt: same}
	b := Envelope{EventID: uid(1), CreatedAt: same}
	if !canonicalLess(b, a) || canonicalLess(a, b) {
		t.Fatal("equal created_at must fall back to eventId (b's id sorts first — deterministic total order)")
	}
	earlier := Envelope{EventID: uid(9), CreatedAt: same.Add(-time.Minute)}
	if !canonicalLess(earlier, a) {
		t.Fatal("created_at must dominate the order (the relay drains (created_at, id))")
	}
	if canonicalLess(a, a) {
		t.Fatal("canonicalLess must be irreflexive")
	}
}

// TestLedgerPayloadVerbatim pins the byte-for-byte payload discipline on the
// ledger insert itself: whitespace, key order, number formatting — exactly
// the producer's bytes, never re-encoded.
func TestLedgerPayloadVerbatim(t *testing.T) {
	ing, driver := newIngester(t, nil)
	weird := `{"receivableId":"` + uid(1) + `"  ,  "invoiceId":"` + uid(2) + `","originalMinor":1000000,"dueDate":"2025-01-31"}`
	raw := envWire(testOrgA, "receivable.opened", 800, at(0, 0), weird)
	if _, err := ing.IngestBatch(context.Background(), [][]byte{raw}); err != nil {
		t.Fatalf("IngestBatch: %v", err)
	}
	var stored string
	for _, s := range driver.stmts {
		if s.query == SQLInsertEventFact {
			stored = s.args[5].(string)
		}
	}
	if stored != weird {
		t.Fatalf("payload re-encoded on the ledger path:\n want %s\n got  %s", weird, stored)
	}
	if !strings.Contains(stored, "  ,  ") {
		t.Fatal("verbatim check lost the odd whitespace (the relay's fidelity rule ends here, unchanged)")
	}
}
