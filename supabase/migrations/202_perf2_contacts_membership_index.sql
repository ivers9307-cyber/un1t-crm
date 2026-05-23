-- 202_perf2_contacts_membership_index.sql
--
-- PERF.2.B — composite index for the membership-status contact scans.
--
-- The PERF.2 readout (docs/PERF_2_readout_2026-05-23.md) found that
-- ~half of all database exec time is the Lead / Churn Radar loads
-- sequentially scanning the contacts table. Every radar query filters
--   location_id = $1 AND glofox_membership_status = ANY($2)
-- and the only supporting index was idx_contacts_location (location_id
-- alone) — useless here, since UN1T is effectively single-location so
-- every row shares the location_id. EXPLAIN confirmed a full Seq Scan
-- (Rows Removed by Filter: 8162).
--
-- This composite lets the planner bitmap-index-scan the churn-radar
-- member fetches (members are ~13% of contacts). The lead-radar fetch
-- matches ~86% of the table so the planner will still (correctly)
-- seq-scan it — that path is addressed app-side by PERF.2.A caching.
--
-- idx_contacts_location is now redundant (this composite covers
-- location_id-only lookups via its leading column) but is left in
-- place; dropping it is deferred to a separate, deliberate change.

begin;

create index if not exists idx_contacts_location_membership_status
  on public.contacts (location_id, glofox_membership_status);

commit;
