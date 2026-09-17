-- HORIZONMIN.1 — backfill min_coaches on future shift_blocks the generator
-- created at the DB default.
--
-- generateBlocksForTemplate (src/lib/roster.js) built shift_blocks rows
-- without min_coaches, so every block it materialised — the nightly
-- extend-roster-horizon cron, template create, template update's
-- regeneration — and every block upsertShiftAssignment created (assistant
-- chat) fell to the column default of 1 (mig 177), whatever the template
-- said. A template needing 2 coaches therefore produced blocks that never
-- flagged understaffed with 1 coach on. The code fix writes min_coaches
-- going forward; this corrects what already exists.
--
-- Scope, deliberately narrow:
--   - FUTURE blocks only (block_date >= today in Europe/Dublin). Past blocks
--     are the record of what ran and are never reclassified (the mig 177
--     snapshot rule).
--   - Only blocks sitting at exactly 1, and only where the template now
--     asks for more than 1. A block at any other value was set on purpose
--     (a manager's edit, a manual block, an exact copy), so it is never
--     overwritten. The residual ambiguity — a manager who deliberately set
--     a 2-coach template's block DOWN to 1 — is indistinguishable from the
--     bug in the data, and is accepted: the value it restores is the
--     template's own.
--   - LEAST(template min, block max) honours shift_blocks_min_coaches_check
--     (0 <= min_coaches <= max_coaches); a block whose max was cut below the
--     template's min would otherwise fail the whole statement.
--
-- Idempotent: a re-run matches nothing it already corrected.

update public.shift_blocks b
set    min_coaches = least(t.min_coaches, b.max_coaches)
from   public.shift_templates t
where  b.template_id = t.id
  and  b.block_date >= (now() at time zone 'Europe/Dublin')::date
  and  b.min_coaches = 1
  and  t.min_coaches > 1;
