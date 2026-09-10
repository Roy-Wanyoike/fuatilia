-- 0016_drop_subsumed_payments_index.sql — subsumed-index cleanup (issue #179,
-- wave 11-c): the one drop #137's purely-additive 0015 deliberately deferred.
--
-- 0005 shipped idx_payments_initiated_at ON payments (org_id, initiated_at)
-- for the GET /v1/payments?sort=initiatedAt page. 0015's
-- idx_payments_org_initiated (org_id, initiated_at, id) serves the exact same
-- equality predicate AND supplies the id tiebreak the repository always
-- appends to its ORDER BY, so after the drop the page keeps an identical
-- backward ordered index scan (same buffers, sub-ms) — see the committed
-- before/after evidence in db/explain/0016-{before,after}.txt.
--
-- The older index was pure write amplification from 0015 on: every payment
-- INSERT/state transition maintained two redundant b-trees over the same
-- leading columns. Nothing can miss it — every payments read in the kernel is
-- org-scoped (repositories.PaymentsByOrg is the only payments list call site;
-- issue #137's query→index map in db/README.md), so an (initiated_at)-leading
-- order is never requested cross-org.

DROP INDEX IF EXISTS idx_payments_initiated_at;
