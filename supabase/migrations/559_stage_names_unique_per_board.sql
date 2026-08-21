-- RETURNPIPE.2 — stage names are unique per BOARD, not per location.
--
-- Mig 558 added a second pipeline whose final column is "Converted", the same
-- name the acquisition funnel's win column already carries. The pre-existing
-- constraint was UNIQUE (location_id, name), so the row collided — and because
-- 558's insert carried a bare `on conflict do nothing`, it was DISCARDED IN
-- SILENCE. The migration reported success and the board shipped with four
-- columns instead of five. Caught by counting the rows afterwards rather than
-- by anything the migration itself said.
--
-- Two fixes, and the ordering matters — the constraint has to be widened
-- before the row can land.
--
-- 1. The invariant was right for one board and wrong for two. What actually
--    needs to be true is that a name is unambiguous WITHIN a board: two
--    columns called "Converted" on the same board would be unusable, on
--    different boards they are simply the win column of each flow. Widening to
--    (location_id, board, name) still rejects everything it rejected before
--    within a board, so nothing that was previously prevented becomes
--    possible.
--
--    The slug constraint is untouched: slugs stay globally unique per location
--    (returning_converted vs converted), which is what the code keys on.
--
-- 2. Insert the row 558 lost, now that it can exist.
--
-- LESSON worth carrying: `on conflict do nothing` on a seed insert converts a
-- schema disagreement into a missing row and a green checkmark. Where the rows
-- are known and finite, conflict-target the column you actually expect to
-- collide (the slug) so a collision on anything else still raises.

alter table public.pipeline_stages
  drop constraint if exists pipeline_stages_location_name_unique;

alter table public.pipeline_stages
  add constraint pipeline_stages_location_board_name_unique
  unique (location_id, board, name);

insert into public.pipeline_stages (location_id, name, slug, display_order, color, is_dormant, archived, board)
values
  ('a0000000-0000-0000-0000-000000000001', 'Converted', 'returning_converted', 405, '#0F6E56', false, false, 'returning')
on conflict (location_id, slug) do nothing;
