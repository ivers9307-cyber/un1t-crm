-- 348 — contacts.hr_leaderboard_opt_out: per-member opt-out from the public
-- HR leaderboard / studio TV.
--
-- DECISION #1 (Richard, 2026-07-03): the leaderboard is SHOWN BY DEFAULT
-- (opt-OUT, not opt-in). A member is on the public board unless they
-- explicitly remove themselves. So the column defaults to FALSE = shown.
--
-- Semantics: when TRUE, the member's own HR data / session still exists and
-- still scores for THEM (their personal reports, their challenge points), they
-- are simply not RENDERED on the public surfaces:
--   - /api/public/live/[locationId]        (open-session tiles on the TV)
--   - /api/public/challenges/[locationId]  (challenge standings + gym board)
-- Anonymous walk-in sessions (null contact_id) are unaffected — they were never
-- tied to a contact, so there is nobody to opt out.
--
-- Additive + fully reversible (drop the column). Nothing is backfilled: every
-- existing member keeps the default (shown), matching current behaviour, so the
-- live Stillorgan TV keeps working with no operator action.

alter table public.contacts
  add column if not exists hr_leaderboard_opt_out boolean not null default false;

comment on column public.contacts.hr_leaderboard_opt_out is
  'DECISION #1 (mig 348) — when TRUE, hide this member from the public HR leaderboard / studio TV (live tiles + challenge standings + gym board). Default FALSE = shown (opt-out model). Their own HR data still exists and still scores for them; they are only excluded from the PUBLIC render. Anonymous walk-in sessions are unaffected.';
