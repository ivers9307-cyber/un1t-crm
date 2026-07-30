-- 459 — backfill deals.stage_entered_at from the activity log (PIPE-AGE.2).
--
-- Mig 458 left existing deals NULL (honest unknown) so the card footer
-- fell back to time-in-pipeline only — Richard wants both metrics on
-- every card. Turns out the data was there all along: the pre-existing
-- deal_stage_change_trigger has logged every stage move into
-- activities (type='pipeline', deal_id) since 2026-04-30. A deal's
-- entry into its CURRENT stage is therefore its latest pipeline
-- activity; deals with no pipeline activity have never moved, so they
-- have been in their stage since the deal was created.
--
-- This is a true backfill, not an estimate — no rows are invented.

update deals d
set stage_entered_at = m.last_move
from (
  select deal_id, max(created_at) as last_move
  from activities
  where type = 'pipeline' and deal_id is not null
  group by deal_id
) m
where m.deal_id = d.id
  and d.stage_entered_at is null;

update deals
set stage_entered_at = created_at
where stage_entered_at is null;
