-- 458 — deals.stage_entered_at (PIPE-AGE.1).
--
-- The pipeline card footer shows "time in current stage", but nothing
-- recorded when a deal entered its stage: the classifier bulk-updates
-- stage_id in place. Stamp it at the row level with a BEFORE trigger
-- so every writer (reclassify bulk moves, webhook classify, manual
-- routes) is covered without app-code changes.
--
-- Existing deals keep NULL (= unknown; the card falls back to
-- time-in-pipeline) rather than a backfilled lie — the stamp becomes
-- accurate per-deal from its first stage move after this applies. New
-- deals default to now() (they enter their first stage at creation).

-- Two steps ON PURPOSE: adding the column WITH a default would
-- fast-default every existing row to migration time (the backfilled
-- lie). Bare add leaves existing rows NULL; the default then only
-- applies to future inserts.
alter table deals add column stage_entered_at timestamptz;
alter table deals alter column stage_entered_at set default now();

comment on column deals.stage_entered_at is
  'When the deal entered its current stage (mig 458 trigger; NULL = predates tracking). Powers the pipeline card time-in-stage footer.';

create or replace function stamp_deal_stage_entered()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.stage_entered_at := now();
  return new;
end;
$$;

create trigger trg_deal_stage_entered
before update of stage_id on deals
for each row
when (old.stage_id is distinct from new.stage_id)
execute function stamp_deal_stage_entered();
