package outbox

import (
	"context"
	"time"

	"github.com/Roy-Wanyoike/fuatilia/backend-go/internal/observability"
)

// Relay metrics probes (issue #176): the relay IS the observability
// BacklogSource — the read-only SQL seam the fuatilia_ lag/DLQ gauges feed
// from. The metrics package stays database-free by design; this side of the
// seam is where the SQL lives (same pool, same least-privilege role the
// relay already runs under: SELECT on outbox_events only).

// Compile-time proof the relay satisfies the probe port (RefreshBacklog's
// contract) — a signature drift fails here, not in the worker's boot.
var _ observability.BacklogSource = (*Relay)(nil)

// OutboxLag probes the pending backlog (observability.BacklogSource): the
// same count + oldest-pending query the cycle log's pendingLag runs,
// expressed in the metrics package's units.
func (r *Relay) OutboxLag(ctx context.Context) (observability.OutboxLag, error) {
	lag, err := r.pendingLag(ctx)
	if err != nil {
		return observability.OutboxLag{}, err
	}
	return observability.OutboxLag{
		PendingRows:   lag.rows,
		OldestPending: time.Duration(lag.oldestMS) * time.Millisecond,
	}, nil
}

// DLQDepth counts poisoned rows (observability.BacklogSource) — the DLQ the
// runbook replays with `worker replay poisons`.
func (r *Relay) DLQDepth(ctx context.Context) (int64, error) {
	var depth int64
	err := r.pool.QueryRow(ctx,
		`SELECT count(*) FROM outbox_events WHERE status = 'poisoned'`,
	).Scan(&depth)
	return depth, err
}

// recordMetrics feeds one cycle's numbers into the wired observability sink
// (issue #176): the backlog probe AFTER the drain — the gauges then read the
// residual backlog the next cycle inherits, which is what a lag alert
// thresholds on — plus the cycle counters from the same stats the log line
// carries. A failed probe is logged and never fails the cycle:
// observability must not take the relay down, and gauges are left untouched
// rather than presenting stale data as fresh.
func (r *Relay) recordMetrics(ctx context.Context, stats cycleStats) {
	if !r.cfg.Metrics.Enabled() {
		return
	}
	if err := r.cfg.Metrics.RefreshBacklog(ctx, r); err != nil {
		r.log.Warn("outbox.metrics_probe_failed", "error", err.Error())
	}
	r.cfg.Metrics.AddOutboxPublished(int64(stats.published))
	r.cfg.Metrics.AddOutboxFailed(int64(stats.failed))
	r.cfg.Metrics.AddOutboxDLQIn(int64(stats.poisoned))
}
