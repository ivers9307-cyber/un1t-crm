-- 205_perf2_deals_board_index.sql
--
-- PERF.2.F — composite index for the pipeline (Deals) board query.
--
-- The board lists deals filtered by location_id + status + stage_id
-- and sorted created_at DESC. The PERF.2 readout measured it at
-- 443 ms mean / 3.1 s max (5.9% of DB time) — the worst user-facing
-- query latency. deals had only single-column indexes on location_id,
-- status, stage_id and contact_id, so the planner could not satisfy
-- the filter + sort from a single index.
--
-- (location_id, status, created_at DESC) covers the filter prefix and
-- feeds the ORDER BY directly. stage_id keeps its own index
-- (idx_deals_stage) — it is an = ANY(...) multi-value filter, best
-- applied as a separate bitmap / filter step.

begin;

create index if not exists idx_deals_location_status_created
  on public.deals (location_id, status, created_at desc);

commit;
