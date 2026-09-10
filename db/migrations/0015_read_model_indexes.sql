-- 0015_read_model_indexes.sql — read-model indexes for the mounted /v1 queries
-- (issue #137, wave 11-c). Purely ADDITIVE: ten indexes over the tables the
-- 22-op /v1 surface reads; no table, column, constraint or trigger changes.
--
-- Every index below is derived from an actual statement the Go kernel runs
-- (backend-go/internal/repositories/**, mounted by routes.go), captured with
-- EXPLAIN ANALYZE before/after on a seeded 0014-state database — the query →
-- index map lives in db/README.md and the raw evidence in db/explain/.
--
-- WHY PLAIN CREATE INDEX (not CONCURRENTLY): db/migrate.cjs executes each
-- migration file as ONE Query message = ONE implicit transaction, and
-- CREATE INDEX CONCURRENTLY cannot run inside a transaction block — a
-- "CONCURRENTLY" statement here would fail the whole file. Plain CREATE INDEX
-- takes a brief SHARE lock (blocks writes, not reads) and applies atomically
-- with the schema_migrations row; at the current table scale the build is
-- sub-second. If a future migration must index a hot multi-GB table online,
-- run the CONCURRENTLY build OUTSIDE the runner first and make the migration
-- a no-op backstop — out of scope here.
--
-- House rules respected: forward-only, one file = one transaction (no
-- BEGIN/COMMIT here), deterministic idx_ naming, per-index query provenance
-- in comments.

-- ---------------------------------------------------------------------------
-- List pagination — GET /v1/receivables, /v1/payments, /v1/collections/cases.
-- The list repositories (ReceivablesByOrg / PaymentsByOrg / CasesByOrg) all
-- page as: WHERE org_id = $1 ORDER BY <col> <order>, id LIMIT $2 OFFSET $3
-- plus a total count(*) per org. The DEFAULT sort (no ?sort= param) is
-- created_at — and no table carried an (org_id, created_at, id) index, so
-- every default page was a full org scan + top-N sort. The trailing id makes
-- the page order fully index-ordered (deterministic tiebreak the runner
-- always appends) and the leading org_id serves the count(*) scan too.
-- ---------------------------------------------------------------------------

-- GET /v1/receivables (default page: WHERE org_id = $1 ORDER BY created_at, id
-- LIMIT/OFFSET; plus SELECT count(*) FROM receivables WHERE org_id = $1).
CREATE INDEX idx_receivables_org_created ON receivables (org_id, created_at, id);

-- GET /v1/receivables?sort=dueDate (whitelisted sort: ORDER BY due_date <o>, id).
-- idx_receivables_live_due (0004) is partial (live states) for the aging scan;
-- the list route orders the FULL org set by due_date, which needs its own index.
CREATE INDEX idx_receivables_org_due ON receivables (org_id, due_date, id);

-- GET /v1/payments (default page + count over payments).
CREATE INDEX idx_payments_org_created ON payments (org_id, created_at, id);

-- GET /v1/payments?sort=initiatedAt (ORDER BY initiated_at <o>, id). Subsumes
-- idx_payments_initiated_at (0005) — the older index keeps the write path
-- honest only until a dedicated cleanup lane drops it; NOT dropped here to
-- keep 0015 purely additive.
CREATE INDEX idx_payments_org_initiated ON payments (org_id, initiated_at, id);

-- GET /v1/collections/cases (default page + count over collections_cases).
CREATE INDEX idx_collections_cases_org_created ON collections_cases (org_id, created_at, id);

-- ---------------------------------------------------------------------------
-- Payment detail — GET /v1/payments/:paymentId mounts the payment row plus
-- its live allocations and refunds; the same allocation scan IS the R6
-- ceiling input in every refund/confirm command (CommittedAgainstPayment).
-- ---------------------------------------------------------------------------

-- AllocationsForPayment: WHERE org_id = $1 AND source_type = 'payment' AND
-- source_id = $2 AND reversed_at IS NULL ORDER BY allocated_at, id —
-- ordered index scan, no sort node. (uq_allocations_replay served the filter
-- but ordered by sequence_no, forcing a sort per read.)
CREATE INDEX idx_allocations_payment_live ON allocations (org_id, source_type, source_id, allocated_at, id)
    WHERE reversed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Case detail overlay — GET /v1/collections/cases/:caseId (and every case
-- command's derive pass) evaluates CaseHasPendingPromise: any covered
-- receivable with a live promise fact holds the case at 'promised'.
-- ---------------------------------------------------------------------------

-- CaseHasPendingPromise: WHERE org_id = $1 AND receivable_id = ANY($2) AND
-- state IN ('created','pending','partially_fulfilled') — promises had no
-- receivable_id index at all (idx_promises_open keys (org_id, state)), so
-- the EXISTS probed every live promise of the org.
CREATE INDEX idx_promises_receivable_open ON promises (org_id, receivable_id)
    WHERE state IN ('created', 'pending', 'partially_fulfilled');

-- ---------------------------------------------------------------------------
-- Authorization hot path — EVERY authenticated /v1 request projects the
-- caller's grants through ActiveRulesForUser, whose anti-join probes
-- role_assignments by revoked_grant_id. That column had no index, so each
-- request hashed/scanned the whole append-only grant ledger.
-- ---------------------------------------------------------------------------

-- ActiveRulesForUser / ActiveGrantFor anti-join:
--   ... AND NOT EXISTS (SELECT 1 FROM role_assignments rv
--                       WHERE rv.revoked_grant_id = ra.id)
CREATE INDEX idx_role_assignments_revoked_grant ON role_assignments (revoked_grant_id)
    WHERE revoked_grant_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Webhook delivery claims — the worker's ClaimDue loop (webhooks/store.go)
-- polls cross-org (no org_id predicate): oldest due queued/failed delivery
-- first, else a delivering row whose claim lease expired.
-- ---------------------------------------------------------------------------

-- The due branch: WHERE d.state IN ('queued','failed') AND
-- COALESCE(d.next_attempt_at, d.created_at) <= $1
-- ORDER BY COALESCE(d.next_attempt_at, d.created_at), d.created_at, d.id
-- LIMIT 1 FOR UPDATE SKIP LOCKED. idx_webhook_deliveries_due (0012) leads
-- with org_id — right for per-org scans, useless for the global claim, and
-- it cannot order by the COALESCE anyway. This expression index gives the
-- claim its exact order across all orgs.
CREATE INDEX idx_webhook_deliveries_claim_due ON webhook_deliveries
    (COALESCE(next_attempt_at, created_at), created_at, id)
    WHERE state IN ('queued', 'failed');

-- The lease-recovery branch: WHERE d.state = 'delivering' AND d.updated_at <= $2
-- (a worker died between POST and record; the lease expiry makes the row
-- claimable again). delivering rows had no index at all.
CREATE INDEX idx_webhook_deliveries_claim_lease ON webhook_deliveries (updated_at)
    WHERE state = 'delivering';

COMMENT ON INDEX idx_receivables_org_created  IS 'GET /v1/receivables default page + org count: WHERE org_id = $1 ORDER BY created_at, id LIMIT/OFFSET (issue #137).';
COMMENT ON INDEX idx_receivables_org_due      IS 'GET /v1/receivables?sort=dueDate: WHERE org_id = $1 ORDER BY due_date <o>, id (issue #137).';
COMMENT ON INDEX idx_payments_org_created     IS 'GET /v1/payments default page + org count: WHERE org_id = $1 ORDER BY created_at, id LIMIT/OFFSET (issue #137).';
COMMENT ON INDEX idx_payments_org_initiated   IS 'GET /v1/payments?sort=initiatedAt: WHERE org_id = $1 ORDER BY initiated_at <o>, id (issue #137).';
COMMENT ON INDEX idx_collections_cases_org_created IS 'GET /v1/collections/cases default page + org count: WHERE org_id = $1 ORDER BY created_at, id LIMIT/OFFSET (issue #137).';
COMMENT ON INDEX idx_allocations_payment_live IS 'GET /v1/payments/:paymentId allocations + R6 ceiling input: WHERE org_id AND source_type=''payment'' AND source_id AND reversed_at IS NULL ORDER BY allocated_at, id (issue #137).';
COMMENT ON INDEX idx_promises_receivable_open IS 'Case detail pending-promise overlay: WHERE org_id AND receivable_id = ANY(...) AND state IN (created,pending,partially_fulfilled) (issue #137).';
COMMENT ON INDEX idx_role_assignments_revoked_grant IS 'Auth hot path anti-join (every request): NOT EXISTS (SELECT 1 FROM role_assignments rv WHERE rv.revoked_grant_id = ra.id) (issue #137).';
COMMENT ON INDEX idx_webhook_deliveries_claim_due IS 'Worker ClaimDue due branch (cross-org): state IN (queued,failed) ORDER BY COALESCE(next_attempt_at, created_at), created_at, id LIMIT 1 SKIP LOCKED (issue #137).';
COMMENT ON INDEX idx_webhook_deliveries_claim_lease IS 'Worker ClaimDue lease recovery: state = ''delivering'' AND updated_at <= lease cutoff (issue #137).';
