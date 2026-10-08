-- 709 — EVENT-MOVE.3: record how a moved entry's price difference was settled.
--
-- WHY. A move never moves money (mig 708). When the target event costs more,
-- the teams page shows "€X difference outstanding" and staff collect it with
-- a payment link or waive it; the chip then had no way to clear. These three
-- columns record that decision. Nothing here touches money.
--
-- WHAT. Three nullable columns on registration_moves, written only by the
-- staff settle route (service role), with a compare-and-set on
-- gap_settled_at IS NULL so a double submit cannot overwrite the first
-- answer. Safe to apply before the code deploys.

alter table public.registration_moves
  add column if not exists gap_settled_at timestamptz,
  add column if not exists gap_settled_how text check (gap_settled_how in ('collected', 'waived')),
  add column if not exists gap_settled_by_name text;

comment on column public.registration_moves.gap_settled_at is 'EVENT-MOVE.3 — when staff marked the price difference collected or waived; NULL = outstanding (or no gap).';
comment on column public.registration_moves.gap_settled_how is 'EVENT-MOVE.3 — collected | waived.';
comment on column public.registration_moves.gap_settled_by_name is 'EVENT-MOVE.3 — snapshot of the staff member who settled it.';
