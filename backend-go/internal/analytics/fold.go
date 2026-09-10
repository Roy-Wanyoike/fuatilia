package analytics

import (
	"encoding/json"
	"fmt"
	"time"
)

// The fold: event → derived state, applied strictly in canonical
// (created_at, eventId) order. Every event lands in event_fact regardless of
// type (the ledger is the provable derivation of every figure); only the
// money/book events below also move projection state.
//
// Balance truth (documented in 0002_dso_daily.sql): E05 originalMinor opens,
// E06 remainingMinor is authoritative on partial settlement, E07/E09 close to
// zero. allocation.executed (E24) and adjustment.creditNoteApplied (E20) are
// LEDGER-ONLY by design: the receivable side of every allocation and credit
// application is emitted by the receivable lane as E06/E07/E10
// (src/domain/receivables/receivable.ts applyAllocation), so folding E24/E20
// money too would double-count. Their payloads remain fully auditable in
// event_fact.

// refold recomputes ALL derived state from the canonical log. O(log) — the
// ingester calls it once per org per batch, which is what makes out-of-order
// delivery and replay trivially correct.
func (s *orgState) refold() error {
	s.book = map[string]*bookEntry{}
	s.bookOrder = nil
	s.voidedInvoices = map[string]struct{}{}
	s.invoices = map[string]*invoiceRecord{}
	s.invoiceOrder = nil
	s.billedByDay = map[string]map[int64]int64{}
	s.collectedByReceivable = map[string]map[int64]int64{}
	s.promisesBrokenByDay = map[int64]int64{}
	s.promiseDays = map[int64]struct{}{}
	s.activityDays = map[int64]struct{}{}
	s.skips = nil

	for i := range s.log {
		if err := s.apply(&s.log[i]); err != nil {
			return err
		}
	}
	return nil
}

// apply folds one event. Shape violations are hard errors (fail loud —
// the consumer redelivers, the outbox DLQ is the recovery path); missing
// references are counted skips (visible, deterministic, non-blocking).
func (s *orgState) apply(ev *Envelope) error {
	day := dayKey(ev.CreatedAt)

	switch ev.Name {
	case "invoicing.invoiceIssued": // E02 — billing
		var p struct {
			InvoiceID  string      `json:"invoiceId"`
			CustomerID string      `json:"customerId"`
			TotalMinor json.Number `json:"totalMinor"`
			Currency   string      `json:"currency"`
			DueDate    string      `json:"dueDate"`
		}
		if err := mustDecode(ev, &p); err != nil {
			return err
		}
		invoiceID, err := payloadUUID(p.InvoiceID, CodePayloadInvalid, "invoiceId")
		if err != nil {
			return err
		}
		total, err := payloadAmount(p.TotalMinor, "totalMinor")
		if err != nil {
			return err
		}
		currency, err := payloadCurrency(p.Currency)
		if err != nil {
			return err
		}
		if _, err := payloadInstant(p.DueDate, CodeDueDateInvalid, "dueDate"); err != nil {
			return err
		}
		if _, dup := s.invoices[invoiceID]; dup {
			s.skip(CodePayloadInvalid,
				"duplicate billing for invoice %s refused (first-write-wins, R9) — event %s", invoiceID, ev.EventID)
			return nil
		}
		rec := &invoiceRecord{invoiceID: invoiceID, currency: currency, day: day, total: total}
		s.invoices[invoiceID] = rec
		s.invoiceOrder = append(s.invoiceOrder, rec)
		if _, voided := s.voidedInvoices[invoiceID]; !voided {
			// A voided invoice is not a billed amount — including when the
			// void event canonically precedes the issue event (clock skew):
			// the NET billing history must stay void-correct either way.
			if s.billedByDay[currency] == nil {
				s.billedByDay[currency] = map[int64]int64{}
			}
			s.billedByDay[currency][day] += total
		}
		s.activityDays[day] = struct{}{}

	case "invoicing.invoiceVoided": // E04 — billing correction
		var p struct {
			InvoiceID string `json:"invoiceId"`
			Reason    string `json:"reason"`
			ActorID   string `json:"actorId"`
		}
		if err := mustDecode(ev, &p); err != nil {
			return err
		}
		invoiceID, err := payloadUUID(p.InvoiceID, CodePayloadInvalid, "invoiceId")
		if err != nil {
			return err
		}
		if _, err := payloadString(p.Reason, "reason"); err != nil {
			return err
		}
		s.voidedInvoices[invoiceID] = struct{}{}
		if inv, ok := s.invoices[invoiceID]; ok {
			// Void-correct the NET billing history: the voided total leaves
			// the day it was billed, so every window recomputation —
			// historical ones included — sees the truth.
			s.billedByDay[inv.currency][inv.day] -= inv.total
		}
		s.activityDays[day] = struct{}{}

	case "receivable.opened": // E05 — book opening
		var p struct {
			ReceivableID  string      `json:"receivableId"`
			InvoiceID     string      `json:"invoiceId"`
			OriginalMinor json.Number `json:"originalMinor"`
			DueDate       string      `json:"dueDate"`
		}
		if err := mustDecode(ev, &p); err != nil {
			return err
		}
		receivableID, err := payloadUUID(p.ReceivableID, CodeReceivableInvalid, "receivableId")
		if err != nil {
			return err
		}
		if _, dup := s.book[receivableID]; dup {
			// Mirror of aging.ts parseReceivableFacts duplicate refusal.
			return errf(CodeReceivableDup, "duplicate receivableId %s (event %s)", receivableID, ev.EventID)
		}
		invoiceID, err := payloadUUID(p.InvoiceID, CodePayloadInvalid, "invoiceId")
		if err != nil {
			return err
		}
		original, err := payloadAmount(p.OriginalMinor, "originalMinor")
		if err != nil {
			return err
		}
		dueTime, err := payloadInstant(p.DueDate, CodeDueDateInvalid, "dueDate")
		if err != nil {
			return err
		}
		currency := ""
		if inv, ok := s.invoices[invoiceID]; ok {
			currency = inv.currency
		}
		entry := &bookEntry{
			receivableID: receivableID,
			invoiceID:    invoiceID,
			currency:     currency,
			original:     original,
			balance:      original,
			dueTime:      dueTime,
			openedDay:    day,
			transitions:  []balanceTransition{{day: day, balance: original}},
		}
		s.book[receivableID] = entry
		s.bookOrder = append(s.bookOrder, entry)
		s.activityDays[day] = struct{}{}

	case "receivable.partiallySettled": // E06 — authoritative remaining
		var p struct {
			ReceivableID   string      `json:"receivableId"`
			AmountMinor    json.Number `json:"amountMinor"`
			RemainingMinor json.Number `json:"remainingMinor"`
		}
		if err := mustDecode(ev, &p); err != nil {
			return err
		}
		receivableID, err := payloadUUID(p.ReceivableID, CodeReceivableInvalid, "receivableId")
		if err != nil {
			return err
		}
		amount, err := payloadAmount(p.AmountMinor, "amountMinor")
		if err != nil {
			return err
		}
		remaining, err := payloadAmount(p.RemainingMinor, "remainingMinor")
		if err != nil {
			return err
		}
		entry, ok := s.book[receivableID]
		if !ok {
			s.skip(CodeUnknownReceivable,
				"partiallySettled for unknown receivable %s (event %s) — open event not in the fabric", receivableID, ev.EventID)
			return nil
		}
		// remainingMinor IS the balance truth (docs/04 E06); the collected
		// side records the amount as stated by the producer.
		entry.balance = remaining
		entry.transitions = append(entry.transitions, balanceTransition{day: day, balance: remaining})
		s.recordCollected(entry, day, amount)
		s.activityDays[day] = struct{}{}

	case "receivable.settled": // E07 — full settlement
		var p struct {
			ReceivableID string `json:"receivableId"`
			SettledAt    string `json:"settledAt"`
		}
		if err := mustDecode(ev, &p); err != nil {
			return err
		}
		receivableID, err := payloadUUID(p.ReceivableID, CodeReceivableInvalid, "receivableId")
		if err != nil {
			return err
		}
		if _, err := payloadInstant(p.SettledAt, CodeFactDateInvalid, "settledAt"); err != nil {
			return err
		}
		entry, ok := s.book[receivableID]
		if !ok {
			s.skip(CodeUnknownReceivable,
				"settled for unknown receivable %s (event %s) — open event not in the fabric", receivableID, ev.EventID)
			return nil
		}
		// E07 carries no amount: the money settled away IS the balance at
		// settle time (traceable in the fold, evidenced by the ledger).
		s.recordCollected(entry, day, entry.balance)
		entry.balance = 0
		entry.settled = true
		entry.transitions = append(entry.transitions, balanceTransition{day: day, balance: 0})
		s.activityDays[day] = struct{}{}

	case "receivable.overdue": // E08 — policy trigger, aging is computed from dueDate
		var p struct {
			ReceivableID string `json:"receivableId"`
			DaysLate     int64  `json:"daysLate"`
			AgingBucket  string `json:"agingBucket"`
		}
		if err := mustDecode(ev, &p); err != nil {
			return err
		}
		if _, err := payloadUUID(p.ReceivableID, CodeReceivableInvalid, "receivableId"); err != nil {
			return err
		}
		// No projection effect: buckets derive from E05 dueDate via the
		// aging.ts port (E08's snapshot is the collections trigger, not the
		// aging truth). Ledger-only.

	case "receivable.writtenOff": // E09 — balance → 0, never resurrected
		var p struct {
			ReceivableID string `json:"receivableId"`
			Reason       string `json:"reason"`
			ApprovedBy   string `json:"approvedBy"`
		}
		if err := mustDecode(ev, &p); err != nil {
			return err
		}
		receivableID, err := payloadUUID(p.ReceivableID, CodeReceivableInvalid, "receivableId")
		if err != nil {
			return err
		}
		if _, err := payloadString(p.Reason, "reason"); err != nil {
			return err
		}
		entry, ok := s.book[receivableID]
		if !ok {
			s.skip(CodeUnknownReceivable,
				"writtenOff for unknown receivable %s (event %s) — open event not in the fabric", receivableID, ev.EventID)
			return nil
		}
		entry.balance = 0
		entry.writtenOff = true
		entry.transitions = append(entry.transitions, balanceTransition{day: day, balance: 0})
		s.activityDays[day] = struct{}{}

	case "receivable.recovered": // E10 — post-write-off recovery
		var p struct {
			ReceivableID string      `json:"receivableId"`
			AmountMinor  json.Number `json:"amountMinor"`
		}
		if err := mustDecode(ev, &p); err != nil {
			return err
		}
		receivableID, err := payloadUUID(p.ReceivableID, CodeReceivableInvalid, "receivableId")
		if err != nil {
			return err
		}
		amount, err := payloadAmount(p.AmountMinor, "amountMinor")
		if err != nil {
			return err
		}
		entry, ok := s.book[receivableID]
		if !ok {
			s.skip(CodeUnknownReceivable,
				"recovered for unknown receivable %s (event %s) — open event not in the fabric", receivableID, ev.EventID)
			return nil
		}
		// A recovery is a collection fact: the balance stays 0 (write-off is
		// terminal, receivable.ts), the money still counts as recovered.
		s.recordCollected(entry, day, amount)
		s.activityDays[day] = struct{}{}

	case "collections.promiseBroken": // E27 — the only promise outcome v1 emits
		var p struct {
			PromiseID  string `json:"promiseId"`
			CaseID     string `json:"caseId"`
			ExpectedAt string `json:"expectedAt"`
		}
		if err := mustDecode(ev, &p); err != nil {
			return err
		}
		if _, err := payloadUUID(p.PromiseID, CodePayloadInvalid, "promiseId"); err != nil {
			return err
		}
		s.promisesBrokenByDay[day]++    // evidence count for the structural promise_kept NULL
		s.promiseDays[day] = struct{}{} // the break moves effectiveness evidence on its own day

	default:
		// Ledger-only event (payments, reconciliation, adjustments,
		// allocations, case openings, future additions — the envelope is
		// additive). It is preserved verbatim in event_fact; the fold's
		// forward-compatibility is: unknown events never break the replay.
	}

	return nil
}

// recordCollected records collected money against a receivable's day. The
// currency dimension is resolved at emission (from the receivable's book
// entry), so a settlement never needs its own currency fact.
func (s *orgState) recordCollected(entry *bookEntry, day int64, amount int64) {
	if amount == 0 {
		return
	}
	if s.collectedByReceivable[entry.receivableID] == nil {
		s.collectedByReceivable[entry.receivableID] = map[int64]int64{}
	}
	s.collectedByReceivable[entry.receivableID][day] += amount
}

// skip records an expected, counted refusal.
func (s *orgState) skip(code, format string, args ...any) {
	s.skips = append(s.skips, skipRecord{code: code, message: fmt.Sprintf(format, args...)})
}

// mustDecode decodes a payload into the event's narrow struct (json.Number
// semantics) — unknown payload fields are allowed (the envelope is additive);
// a payload that is not a JSON object is a shape violation.
func mustDecode(ev *Envelope, target any) error {
	dec := decoder(ev.Payload)
	if err := dec.Decode(target); err != nil {
		return errf(CodePayloadInvalid, "event %s (%s) payload: %v", ev.EventID, ev.Name, err)
	}
	return nil
}

// watermark returns the org's deterministic processing watermark: the
// created_at of the LAST event in canonical order. Never the wall clock.
func (s *orgState) watermark() time.Time {
	if len(s.log) == 0 {
		return time.Time{}
	}
	return s.log[len(s.log)-1].CreatedAt
}
