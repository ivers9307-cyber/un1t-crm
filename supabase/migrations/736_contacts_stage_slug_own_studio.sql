-- HATCHPIPE.1 — contacts.pipeline_stage_slug comes from the contact's OWN studio.
-- Spec A §6.6 (docs/superpowers/specs/2026-10-17-hatch-pipeline-and-invoices-design.md).
--
-- Mig 595 pinned the slug to "the primary board" but did not scope that board to
-- the contact's studio, and its fall-back branch took the newest open deal on ANY
-- board. With two live studios a Stillorgan member holding a newer Hatch waitlist
-- deal therefore carried a Hatch stage, and the audiences, campaign filters and
-- sequence auto-exit rules that read the column (a CONTINUING condition) saw the
-- wrong studio's stage. Mig 595 also wrote NULL when the last open deal closed,
-- silently dropping the contact out of every audience that filters on the slug.
--
-- The one rule (A-1), with v_loc = contacts.location_id:
--   1. the newest open deal on the enabled primary board at v_loc; else
--   2. the newest open deal on any other enabled board at v_loc; else
--   3. leave the slug unchanged. The trigger never NULLs a slug as a side effect.
--
-- The IS DISTINCT FROM guard on the UPDATE is kept verbatim from mig 595: it is
-- what stops the trigger writing (and re-firing downstream work) on every no-op
-- deal touch.
--
-- grant: none (function body only, CREATE OR REPLACE keeps the ACL)

-- ─── 1. The function ────────────────────────────────────────────────────────

create or replace function public.sync_contacts_pipeline_stage_slug()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  v_contact_id UUID;
  v_loc UUID;
  v_slug TEXT;
BEGIN
  v_contact_id := COALESCE(NEW.contact_id, OLD.contact_id);
  IF v_contact_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_loc := (SELECT location_id FROM contacts WHERE id = v_contact_id);

  -- 1. The enabled primary board at the contact's own studio.
  SELECT ps.slug
  INTO v_slug
  FROM deals d
  JOIN pipeline_stages ps ON ps.id = d.stage_id
  JOIN pipelines p        ON p.id = ps.pipeline_id
  WHERE d.contact_id = v_contact_id
    AND d.status = 'open'
    AND p.location_id = v_loc
    AND p.enabled
    AND p.is_primary
  ORDER BY d.created_at DESC, d.id DESC
  LIMIT 1;

  -- 2. Any other enabled board at the same studio.
  IF v_slug IS NULL THEN
    SELECT ps.slug
    INTO v_slug
    FROM deals d
    JOIN pipeline_stages ps ON ps.id = d.stage_id
    JOIN pipelines p        ON p.id = ps.pipeline_id
    WHERE d.contact_id = v_contact_id
      AND d.status = 'open'
      AND p.location_id = v_loc
      AND p.enabled
    ORDER BY d.created_at DESC, d.id DESC
    LIMIT 1;
  END IF;

  -- 3. Nothing at the contact's own studio: leave the slug as it is.
  IF v_slug IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  UPDATE contacts
  SET pipeline_stage_slug = v_slug
  WHERE id = v_contact_id
    AND pipeline_stage_slug IS DISTINCT FROM v_slug;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- ─── 2. Recompute and self-check ────────────────────────────────────────────
--
-- The trigger fires only on deal writes, so contacts already carrying another
-- studio's slug need one pass of the same rule. Counts were measured on the live
-- data on 17 Oct 2026 (read-only) before this file was written; the migration
-- raises, rolling itself back, if the data has moved and any of them differs.
--   (a) contact not at Hatch Street holding an open Hatch deal (Stillorgan
--       members with a Hatch waitlist deal): slug returns to their own studio's.
--   (b) contact at Hatch Street: exactly one. Its slug came from a newer
--       Stillorgan deal; the rule moves it to its own Hatch waitlist stage.
--   (c) contact at a studio with no enabled board: step 3, no change.
--   (d) every other contact: no change.

do $$
declare
  v_hatch    constant uuid := '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4';  -- UN1T Hatch Street
  v_expect_a constant int := 13;
  v_expect_b constant int := 1;
  v_expect_c constant int := 0;
  v_expect_d constant int := 0;
  v_a int;
  v_b int;
  v_c int;
  v_d int;
  v_updated int;
  v_wrong int;
begin
  -- The rule, once: one row per contact holding an open deal on an enabled
  -- board at its own studio (primary first, then newest). Contacts with no such
  -- deal have no row, which is step 3.
  create temp table a1_slug_rule on commit drop as
    select distinct on (c.id)
           c.id as contact_id,
           c.location_id,
           ps.slug as new_slug
      from contacts c
      join deals d            on d.contact_id = c.id and d.status = 'open'
      join pipeline_stages ps on ps.id = d.stage_id
      join pipelines p        on p.id = ps.pipeline_id
                             and p.location_id = c.location_id
                             and p.enabled
     order by c.id, p.is_primary desc, d.created_at desc, d.id desc;

  with changed as (
    select r.contact_id,
           r.location_id,
           case
             when r.location_id = v_hatch then 'b'
             when not exists (select 1 from pipelines pe
                               where pe.location_id = r.location_id and pe.enabled) then 'c'
             when exists (select 1 from deals dh
                           where dh.contact_id = r.contact_id
                             and dh.status = 'open'
                             and dh.location_id = v_hatch) then 'a'
             else 'd'
           end as cls
      from a1_slug_rule r
      join contacts c on c.id = r.contact_id
     where r.new_slug is not null
       and r.new_slug is distinct from c.pipeline_stage_slug
  )
  select count(*) filter (where cls = 'a'),
         count(*) filter (where cls = 'b'),
         count(*) filter (where cls = 'c'),
         count(*) filter (where cls = 'd')
    into v_a, v_b, v_c, v_d
    from changed;

  if v_a is distinct from v_expect_a
     or v_b is distinct from v_expect_b
     or v_c is distinct from v_expect_c
     or v_d is distinct from v_expect_d then
    raise exception 'HATCHPIPE.1: slug changes a/b/c/d = %/%/%/%, expected %/%/%/%',
      v_a, v_b, v_c, v_d, v_expect_a, v_expect_b, v_expect_c, v_expect_d;
  end if;

  update contacts c
     set pipeline_stage_slug = r.new_slug
    from a1_slug_rule r
   where c.id = r.contact_id
     and r.new_slug is not null
     and c.pipeline_stage_slug is distinct from r.new_slug;
  get diagnostics v_updated = row_count;

  if v_updated <> v_expect_a + v_expect_b + v_expect_c + v_expect_d then
    raise exception 'HATCHPIPE.1: updated % contacts, expected %',
      v_updated, v_expect_a + v_expect_b + v_expect_c + v_expect_d;
  end if;

  -- Post-check: no contact with an own-studio open deal holds a slug other than
  -- the rule's, which also rules out a slug from another studio's stage.
  select count(*) into v_wrong
    from a1_slug_rule r
    join contacts c on c.id = r.contact_id
   where c.pipeline_stage_slug is distinct from r.new_slug;
  if v_wrong > 0 then
    raise exception 'HATCHPIPE.1: % contacts with an own-studio open deal hold a different slug', v_wrong;
  end if;

  drop table a1_slug_rule;
end $$;
