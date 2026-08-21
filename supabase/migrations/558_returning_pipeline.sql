-- RETURNPIPE.1 — a second pipeline for returning customers.
--
-- Richard's call (2026-08-21): a returning customer follows a DIFFERENT FLOW
-- from a new one, so they get their own board rather than a badge or a filter
-- on the existing columns. The pipeline page already renders tabs off a `view`
-- search param (Funnel / Off funnel), so this is a third tab, not new page
-- architecture.
--
-- WHY A `board` COLUMN AND NOT is_dormant
-- splitStagesByFunnel partitions the live stages on is_dormant — two groups,
-- and every stage row falls in one of them. A third set of stages needs a
-- third axis or it leaks into the acquisition funnel's tab. `board` is that
-- axis; is_dormant continues to mean "parked, not moving through acquisition"
-- WITHIN a board.
--
-- Defaulted to 'acquisition' so every existing row keeps its current meaning
-- and every existing query that ignores this column behaves identically.
--
-- THE FLOW (Richard's words, his stage names):
--   Booked back in → 1st class back → 2nd class back → Final class → Converted
--
-- "Booked back in" is the entry column and was added on top of his original
-- four deliberately: the live 3-Class Trial sequence is generating bookings
-- right now, and without an entry column a booking is invisible until the
-- person physically turns up — which is the same defect FUNNEL.5 fixed on the
-- acquisition board a day earlier. It also makes booked-but-never-showed a
-- visible drop-off rather than an absence.
--
-- COUNTING IS SCOPED TO THE RETURN, not lifetime. Someone who trained nine
-- times two years ago and has just come back once belongs in "1st class back",
-- not "Final class". The classifier derives the episode from the bookings
-- themselves — the first attendance after a >= 60 day gap — so it works on
-- existing data with no new per-contact state to backfill or keep in sync.

alter table public.pipeline_stages
  add column if not exists board text not null default 'acquisition';

comment on column public.pipeline_stages.board is
  'RETURNPIPE.1 — which pipeline this stage belongs to: ''acquisition'' (new customers, '
  'the original funnel + its off-funnel piles) or ''returning'' (customers who trained '
  'before and came back). The pipeline page renders one board per tab. is_dormant still '
  'means "parked, not moving through acquisition" and now applies WITHIN a board. '
  'Defaulted to ''acquisition'' so every pre-existing row and every query that ignores '
  'this column is unchanged.';

-- Stillorgan's returning board. Display orders sit in their own 400 band so
-- they can never interleave with the acquisition stages (301-311) if anything
-- ever sorts the two together.
insert into public.pipeline_stages (location_id, name, slug, display_order, color, is_dormant, archived, board)
values
  ('a0000000-0000-0000-0000-000000000001', 'Booked back in',   'returning_booked',        401, '#378ADD', false, false, 'returning'),
  ('a0000000-0000-0000-0000-000000000001', '1st class back',   'returning_first_class',   402, '#1D9E75', false, false, 'returning'),
  ('a0000000-0000-0000-0000-000000000001', '2nd class back',   'returning_second_class',  403, '#5DCAA5', false, false, 'returning'),
  ('a0000000-0000-0000-0000-000000000001', 'Final class',      'returning_final_class',   404, '#EF9F27', false, false, 'returning'),
  ('a0000000-0000-0000-0000-000000000001', 'Converted',        'returning_converted',     405, '#0F6E56', false, false, 'returning')
on conflict do nothing;
