-- PIPELINES.4 — contacts.pipeline_stage_slug follows the PRIMARY board.
--
-- Mig 155's trigger picked `order by d.created_at desc limit 1` — the newest
-- open deal on ANY board. That was unambiguous while a contact could only have
-- one. With a second board it becomes "whichever board most recently created a
-- deal", silently redefining the column that the audience builder and campaign
-- filters read, and that sequence auto-exit re-checks continuously.
--
-- Live exposure today is low and was checked, not assumed: the two active
-- sequences filter on glofox_membership_status or carry no audience filter at
-- all, and the only pipeline_stage_change sequence is still draft. But the
-- column is exposed in the audience builder regardless, and auto-exit is a
-- CONTINUING condition — a wrong value there unenrols people quietly, which is
-- the kind of failure nobody reports because it looks like nothing happening.
--
-- Fix: pin it to the location's is_primary pipeline. Falls back to the old
-- behaviour when a contact's location has no primary board, so a location that
-- has not been given one behaves exactly as before rather than nulling a
-- column live audiences read. Removing a silent failure must never create a
-- louder one.
--
-- The `IS DISTINCT FROM` guard on the UPDATE is preserved verbatim from the
-- live definition: it is what stops the trigger writing (and re-firing
-- downstream work) on every no-op deal touch.

create or replace function public.sync_contacts_pipeline_stage_slug()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_contact_id UUID;
  v_slug TEXT;
BEGIN
  v_contact_id := COALESCE(NEW.contact_id, OLD.contact_id);
  IF v_contact_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  -- The primary board owns the canonical slug.
  SELECT ps.slug
  INTO v_slug
  FROM deals d
  JOIN pipeline_stages ps ON d.stage_id = ps.id
  JOIN pipelines p        ON p.id = ps.pipeline_id
  WHERE d.contact_id = v_contact_id
    AND d.status = 'open'
    AND p.is_primary
  ORDER BY d.created_at DESC
  LIMIT 1;

  -- No primary board at this contact's location: keep mig 155's behaviour
  -- rather than blanking a column live audiences read.
  IF v_slug IS NULL THEN
    SELECT ps.slug
    INTO v_slug
    FROM deals d
    JOIN pipeline_stages ps ON d.stage_id = ps.id
    WHERE d.contact_id = v_contact_id
      AND d.status = 'open'
    ORDER BY d.created_at DESC
    LIMIT 1;
  END IF;

  UPDATE contacts
  SET pipeline_stage_slug = v_slug
  WHERE id = v_contact_id
    AND pipeline_stage_slug IS DISTINCT FROM v_slug;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- PIPELINES.2b parked the returning board: it holds 0 deals and cannot fill —
-- only 581 of 8,594 Stillorgan contacts (6.8%) have last_attended_at at all,
-- and the count lapsed-with-a-future-booking, which its entry column needs, is
-- zero. Its board module is deliberately unregistered in shared/pipelines, so
-- leaving the row enabled would render an empty tab and log a skipped board on
-- every nightly run. The stage rows stay exactly where they are, ready if
-- attendance coverage ever improves.
--
-- Still passes pipelines_module_matches_mode: derived with a non-null module,
-- just switched off.
update public.pipelines
   set enabled = false
 where key = 'returning';

-- Count, don't trust (mig 559's lesson).
do $$
declare
  v_drift int;
  v_returning_enabled int;
begin
  -- Re-pointing the trigger must move nobody.
  --
  -- This mirrors what the trigger COMPUTES — distinct on contact, newest open
  -- deal on the primary board — rather than comparing every open deal to the
  -- stored slug. The first draft did the latter and failed on 6 rows, all of
  -- them one contact holding 8 open deals from repeated form testing. That was
  -- the assertion being wrong, not the data: a contact with several open deals
  -- has always had exactly one canonical slug, and it is the newest deal's.
  --
  -- Those duplicates are real and still need resolving — they will violate the
  -- unique(contact_id, pipeline_id) index in the final tightening migration —
  -- but that is an operator decision about which deals to close, not something
  -- to settle inside a trigger repoint.
  with newest as (
    select distinct on (d.contact_id) d.contact_id, ps.slug
      from deals d
      join pipeline_stages ps on ps.id = d.stage_id
      join pipelines p on p.id = ps.pipeline_id and p.is_primary
     where d.status = 'open'
     order by d.contact_id, d.created_at desc
  )
  select count(*) into v_drift
    from contacts c
    join newest n on n.contact_id = c.id
   where c.pipeline_stage_slug is distinct from n.slug;
  if v_drift > 0 then
    raise exception 'PIPELINES.4: % contacts disagree with their primary board''s slug', v_drift;
  end if;

  select count(*) into v_returning_enabled
    from public.pipelines where key = 'returning' and enabled;
  if v_returning_enabled > 0 then
    raise exception 'PIPELINES.4: % returning pipelines still enabled', v_returning_enabled;
  end if;
end $$;
