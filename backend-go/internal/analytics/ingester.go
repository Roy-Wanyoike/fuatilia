package analytics

import (
	"context"
	"log/slog"
	"sort"
	"time"
)

// Ingester drives the consume → dedupe → ledger-append → fold → emit cycle.
// It owns NO clock (the watermark is event-derived) and NO connection (both
// boundaries are ports). Safe for single-goroutine use — one ingester per
// process, like the outbox relay.
type Ingester struct {
	consumer Consumer
	driver   Driver
	log      *slog.Logger

	orgs map[string]*orgState
	seen map[string]map[string]struct{} // orgID → eventID set (the at-least-once dedupe)
}

// Stats aggregates one cycle (IngestBatch or RebuildFromLedger).
type Stats struct {
	Received      int // envelopes delivered by the consumer
	Accepted      int // new envelopes (parsed, not deduped)
	Duplicates    int // eventId redeliveries collapsed (at-least-once is the fabric's contract)
	LedgerAppends int // event_fact inserts (skipped entirely during rebuild)
	RowsEmitted   int // projection upserts (dso/aging/effectiveness/cohort)
	Skipped       int // expected, counted fold refusals (data gaps — see README)
}

// PollInterval is the idle wait between consumer ticks in Run (relay parity:
// the outbox relay's default poll cadence).
const PollInterval = time.Second

// New wires an Ingester over its ports.
func New(c Consumer, d Driver, log *slog.Logger) (*Ingester, error) {
	if c == nil {
		return nil, errf(CodeConfigInvalid, "consumer is required")
	}
	if d == nil {
		return nil, errf(CodeConfigInvalid, "driver is required")
	}
	if log == nil {
		log = slog.Default()
	}
	return &Ingester{
		consumer: c,
		driver:   d,
		log:      log,
		orgs:     map[string]*orgState{},
		seen:     map[string]map[string]struct{}{},
	}, nil
}

// handledEvents are the catalog events the fold applies to projections
// (docs/04 E02/E04/E05/E06/E07/E08/E09/E10/E27). Every OTHER catalog event —
// and any future one, the envelope is additive — is ledger-only: preserved
// verbatim in event_fact, never a projection input. Handled events are
// version-pinned (v1): a v2 payload is a different shape and must be
// handled explicitly, never assumed (outbox README "Consumer idempotency
// contract").
var handledEvents = map[string]struct{}{
	"invoicing.invoiceIssued":     {},
	"invoicing.invoiceVoided":     {},
	"receivable.opened":           {},
	"receivable.partiallySettled": {},
	"receivable.settled":          {},
	"receivable.overdue":          {},
	"receivable.writtenOff":       {},
	"receivable.recovered":        {},
	"collections.promiseBroken":   {},
}

// IngestBatch processes one delivered batch:
//
//  1. parse + validate every envelope (fail loud — one malformed envelope
//     refuses the batch; the consumer redelivers),
//  2. dedupe on (orgId, eventId) — at-least-once forever,
//  3. append NEW events to their org's canonical log and to event_fact
//     (orgs in sorted order, events in canonical (created_at, eventId)
//     order — the deterministic SQL log the golden files snapshot),
//  4. re-fold each org and re-derive every projection row from full state.
//
// Events of an org whose processing fails are NOT marked seen: redelivery
// re-ingests them harmlessly (ledger rows collapse under
// ReplacingMergeTree; the fold is deterministic).
func (ing *Ingester) IngestBatch(ctx context.Context, batch [][]byte) (Stats, error) {
	var stats Stats
	stats.Received = len(batch)

	// 1. Parse + validate.
	parsed := make([]Envelope, 0, len(batch))
	for i, raw := range batch {
		env, err := ParseEnvelope(raw)
		if err != nil {
			return stats, errf(CodeEnvelopeInvalid, "batch[%d]: %v", i, err)
		}
		if _, handled := handledEvents[env.Name]; handled && env.Version != 1 {
			return stats, errf(CodeVersionUnsupported,
				"event %s (%s): handled events are pinned to payload version 1, got v%d — handle new versions explicitly",
				env.EventID, env.Name, env.Version)
		}
		parsed = append(parsed, env)
	}

	// 2. Dedupe (orgId, eventId) — across batches (the seen map) AND
	// within one batch (overlapping delivery: a live drain can mix with a
	// replayed range in a single Consume batch). At-least-once forever
	// means the same event may arrive any number of times through any
	// path; every duplicate after the first is collapsed here.
	fresh := make([]Envelope, 0, len(parsed))
	batchSeen := make(map[string]struct{}, len(parsed))
	for _, env := range parsed {
		if ing.alreadySeen(env) {
			stats.Duplicates++
			continue
		}
		key := env.OrgID + "\x00" + env.EventID
		if _, dup := batchSeen[key]; dup {
			stats.Duplicates++
			continue
		}
		batchSeen[key] = struct{}{}
		fresh = append(fresh, env)
	}
	stats.Accepted = len(fresh)
	if len(fresh) == 0 {
		ing.log.Debug("analytics.ingest_cycle", "received", stats.Received, "duplicates", stats.Duplicates)
		return stats, nil
	}

	// 3. Group by org, sorted for a deterministic statement order.
	byOrg := map[string][]Envelope{}
	for _, env := range fresh {
		byOrg[env.OrgID] = append(byOrg[env.OrgID], env)
	}
	orgIDs := make([]string, 0, len(byOrg))
	for org := range byOrg {
		orgIDs = append(orgIDs, org)
	}
	sort.Strings(orgIDs)

	for _, org := range orgIDs {
		events := byOrg[org]
		state := ing.orgs[org]
		if state == nil {
			state = newOrgState(org)
			ing.orgs[org] = state
		}
		state.upsertLog(events)

		// 3a. Ledger appends — canonical order within the org (the fold's
		// order), so the ledger's SQL log is replay-stable.
		canonical := append([]Envelope(nil), events...)
		sort.SliceStable(canonical, func(i, j int) bool { return canonicalLess(canonical[i], canonical[j]) })
		for i := range canonical {
			env := &canonical[i]
			if err := ing.driver.Exec(ctx, SQLInsertEventFact,
				env.OrgID, env.EventID, env.Name, int64(env.Version),
				env.CreatedAt, string(env.Payload), LabelDerivedFromEvents, env.CreatedAt,
			); err != nil {
				return stats, err
			}
			stats.LedgerAppends++
		}

		// 4. Re-fold + re-emit.
		if err := state.refold(); err != nil {
			return stats, err
		}
		rows, err := emitProjections(ctx, ing.driver, state)
		if err != nil {
			return stats, err
		}
		stats.RowsEmitted += rows
		stats.Skipped += len(state.skips)
		for _, sk := range state.skips {
			ing.log.Warn("analytics.fold_skip", "org_id", org, "code", sk.code, "detail", sk.message)
		}

		// Mark the org's batch seen only after its processing succeeded.
		ing.markSeen(events)
	}

	ing.log.Info("analytics.ingest_cycle",
		"received", stats.Received,
		"accepted", stats.Accepted,
		"duplicates", stats.Duplicates,
		"ledger_appends", stats.LedgerAppends,
		"rows_emitted", stats.RowsEmitted,
		"skipped", stats.Skipped,
	)
	return stats, nil
}

// RebuildFromLedger re-derives every projection from the event-fact ledger —
// the ADR-0002 rebuild path (db/clickhouse/README.md). The ingester resets
// its state, reads the ledger through the Driver port (the ONLY read this
// lane performs), re-folds each org in canonical order and re-emits. No
// ledger appends happen during a rebuild — the ledger is the source.
func (ing *Ingester) RebuildFromLedger(ctx context.Context) (Stats, error) {
	var stats Stats

	rows, err := ing.driver.Query(ctx, LedgerSelectSQL)
	if err != nil {
		return stats, err
	}
	defer func() { _ = rows.Close() }()

	byOrg := map[string][]Envelope{}
	totalEvents := 0
	for rows.Next() {
		var orgID, eventID, name, payload string
		var version int64
		var createdAt time.Time
		if err := rows.Scan(&orgID, &eventID, &name, &version, &createdAt, &payload); err != nil {
			return stats, err
		}
		env := Envelope{
			EventID:   eventID,
			Name:      name,
			Version:   int(version),
			OrgID:     orgID,
			CreatedAt: createdAt.UTC(),
			Payload:   []byte(payload),
		}
		byOrg[orgID] = append(byOrg[orgID], env)
		totalEvents++
	}
	if err := rows.Err(); err != nil {
		return stats, err
	}
	if err := rows.Close(); err != nil {
		return stats, err
	}

	// Fresh state: a rebuild is a full replay, not an increment.
	ing.orgs = map[string]*orgState{}
	ing.seen = map[string]map[string]struct{}{}

	orgIDs := make([]string, 0, len(byOrg))
	for org := range byOrg {
		orgIDs = append(orgIDs, org)
	}
	sort.Strings(orgIDs)

	for _, org := range orgIDs {
		events := byOrg[org]
		state := newOrgState(org)
		state.upsertLog(events) // upsert sorts into canonical order
		ing.orgs[org] = state
		ing.markSeen(events)

		if err := state.refold(); err != nil {
			return stats, err
		}
		n, err := emitProjections(ctx, ing.driver, state)
		if err != nil {
			return stats, err
		}
		stats.RowsEmitted += n
		stats.Skipped += len(state.skips)
		for _, sk := range state.skips {
			ing.log.Warn("analytics.fold_skip", "org_id", org, "code", sk.code, "detail", sk.message)
		}
	}
	stats.Received = totalEvents
	stats.Accepted = totalEvents // a rebuild re-derives from every ledger event
	ing.log.Info("analytics.rebuild",
		"orgs", len(orgIDs),
		"rows_emitted", stats.RowsEmitted,
		"skipped", stats.Skipped,
	)
	return stats, nil
}

// Run consumes batches until ctx is cancelled: Consume → IngestBatch, with a
// PollInterval idle wait when no work is available. A Consume error is
// terminal (the later-wave wiring owns redelivery/backoff policy); a batch
// error is returned too — fail loud, at-least-once redelivery replays it.
func (ing *Ingester) Run(ctx context.Context) error {
	for {
		if ctx.Err() != nil {
			return nil // graceful stop
		}
		batch, err := ing.consumer.Consume(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if len(batch) == 0 {
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(PollInterval):
			}
			continue
		}
		if _, err := ing.IngestBatch(ctx, batch); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
	}
}

func (ing *Ingester) alreadySeen(env Envelope) bool {
	set := ing.seen[env.OrgID]
	if set == nil {
		return false
	}
	_, ok := set[env.EventID]
	return ok
}

func (ing *Ingester) markSeen(events []Envelope) {
	for _, env := range events {
		set := ing.seen[env.OrgID]
		if set == nil {
			set = map[string]struct{}{}
			ing.seen[env.OrgID] = set
		}
		set[env.EventID] = struct{}{}
	}
}
