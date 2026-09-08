-- WAITLIST.6 — Hatch cuts over to its waitlist board; constraints tighten.
--
-- 🔴 APPLY ONLY AFTER PR 2 HAS MERGED AND DEPLOYED. This migration makes a
-- manual board Hatch's primary. Until the code that renders a manual board and
-- writes to it is live, that would leave 102 deals on a board the running app
-- does not know how to drive. Mig 597 deliberately left the gym board primary
-- for exactly this window.
--
-- Everything here is guarded and ordered so a failure rolls the whole thing
-- back rather than leaving a half-cutover Hatch.

-- ─── 1. Sweep any deal the live code created before PR 1 deployed ──────────
--
-- Mig 594 added deals.pipeline_id; the deployed main did not populate it until
-- PR 1 shipped. Rows created in between carry NULL, and the orchestrator scopes
-- its read with `.in('pipeline_id', …)`, which never matches NULL — so each one
-- would be duplicated nightly until swept. Idempotent: a no-op if none exist.
update public.deals d
   set pipeline_id = ps.pipeline_id
  from public.pipeline_stages ps
 where ps.id = d.stage_id
   and d.pipeline_id is null;

-- ─── 2. Resolve duplicate open deals (Richard, 2026-09-08) ────────────────
--
-- Two contacts hold several open deals each — 8 and 2, all form-testing
-- residue from April–June. They would violate the unique index added in step 6.
-- Decision: keep the most recently created per (contact, board), close the rest.
-- The newest is already the one contacts.pipeline_stage_slug follows (mig 595),
-- so nothing visible changes.
--
-- 'lost' is an imperfect word for "duplicate row", and it is used deliberately:
-- dealStatusSchema is z.enum(['open','won','lost']) and the whole app validates
-- against those three, so inventing a fourth state for an 8-row cleanup would
-- ripple through schemas, filters and UI for no gain. Nothing is deleted, and
-- no timeline noise is generated — log_deal_stage_change fires on stage_id
-- changes, not status ones.
with ranked as (
  select id,
         row_number() over (
           partition by contact_id, pipeline_id
           order by created_at desc, id desc
         ) as rn
    from public.deals
   where status = 'open'
     and contact_id is not null
     and pipeline_id is not null
)
update public.deals d
   set status = 'lost'
  from ranked r
 where r.id = d.id
   and r.rn > 1;

-- ─── 3. Move Hatch onto its waitlist board ────────────────────────────────
do $$
declare
  v_loc      uuid := '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4';  -- UN1T Hatch Street
  v_waitlist uuid;
  v_entry    uuid;
  v_moved    int;
begin
  select id into v_waitlist from public.pipelines
   where location_id = v_loc and key = 'waitlist';
  if v_waitlist is null then
    raise exception 'WAITLIST.6: Hatch waitlist pipeline missing — apply mig 597 first';
  end if;

  select id into v_entry from public.pipeline_stages
   where pipeline_id = v_waitlist and slug = 'waitlist_new_enquiry';
  if v_entry is null then
    raise exception 'WAITLIST.6: waitlist_new_enquiry stage missing';
  end if;

  -- All of them into New Enquiry. "No Answer" means we called and got no
  -- answer, so New Enquiry means "not yet worked" — and none of these 102 have
  -- been. Column 1 is the truthful starting point, and the to-do list.
  update public.deals
     set stage_id = v_entry, pipeline_id = v_waitlist
   where location_id = v_loc and status = 'open';
  get diagnostics v_moved = row_count;
  raise notice 'WAITLIST.6: moved % Hatch deals to New Enquiry', v_moved;

  -- Flip primary in two statements, never one: pipelines_one_primary_per_location
  -- is a UNIQUE index checked per statement, so setting the new primary before
  -- clearing the old one would collide.
  update public.pipelines
     set is_primary = false, enabled = false
   where location_id = v_loc and key = 'acquisition';

  update public.pipelines
     set is_primary = true, display_order = 0
   where id = v_waitlist;

  -- Hatch's gym stages are done. Archive rather than delete: closed deals still
  -- point at them, and the contact timeline reads their names.
  update public.pipeline_stages
     set archived = true
   where location_id = v_loc and pipeline_id <> v_waitlist;
end $$;

-- ─── 4. Archive the stray gym stages at the non-gym locations ─────────────
--
-- CCF Autos (a car dealership), SourceIt and Test Studio were each given the
-- full gym stage set by the CROSS JOIN seeding in migs 147/150/350 — columns
-- like "Trial Done" and "ClassPass" they could never fill. Their pipelines are
-- already disabled so nothing renders; archiving makes that true in the data too.
update public.pipeline_stages ps
   set archived = true
  from public.pipelines p
 where p.id = ps.pipeline_id
   and p.enabled = false;

-- ─── 5. Tighten, but only once nothing is orphaned ────────────────────────
do $$
declare v_n int;
begin
  select count(*) into v_n from public.pipeline_stages where pipeline_id is null;
  if v_n > 0 then
    raise exception 'WAITLIST.6: % stages still have no pipeline_id', v_n;
  end if;

  select count(*) into v_n
    from public.deals where pipeline_id is null and stage_id is not null;
  if v_n > 0 then
    raise exception 'WAITLIST.6: % deals still have no pipeline_id', v_n;
  end if;

  select count(*) into v_n from (
    select 1 from public.deals
     where status = 'open' and contact_id is not null and pipeline_id is not null
     group by contact_id, pipeline_id having count(*) > 1
  ) t;
  if v_n > 0 then
    raise exception 'WAITLIST.6: % contact/board pairs still hold multiple open deals', v_n;
  end if;
end $$;

alter table public.pipeline_stages alter column pipeline_id set not null;

-- ─── 6. One open deal per contact PER BOARD ───────────────────────────────
-- Partial, so closed deals never collide and a person can re-enter a board later.
create unique index if not exists deals_one_open_per_contact_pipeline
  on public.deals (contact_id, pipeline_id) where status = 'open';

-- ─── 7. Retire the legacy board column ────────────────────────────────────
-- Superseded by pipelines.key. No JS reads it (verified 2026-09-08), its unique
-- constraint was re-keyed to (pipeline_id, name) in mig 597, and no RLS policy
-- on deals or pipeline_stages references it (verified against pg_policy).
alter table public.pipeline_stages drop column if exists board;

-- ─── 8. Final proof ───────────────────────────────────────────────────────
do $$
declare
  v_loc       uuid := '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4';
  v_entry_cnt int;
  v_elsewhere int;
begin
  select count(*) into v_entry_cnt
    from public.deals d
    join public.pipeline_stages ps on ps.id = d.stage_id
   where d.location_id = v_loc and d.status = 'open'
     and ps.slug = 'waitlist_new_enquiry';

  select count(*) into v_elsewhere
    from public.deals d
    join public.pipeline_stages ps on ps.id = d.stage_id
   where d.location_id = v_loc and d.status = 'open'
     and ps.slug <> 'waitlist_new_enquiry';

  if v_elsewhere > 0 then
    raise exception 'WAITLIST.6: % Hatch open deals are not in New Enquiry', v_elsewhere;
  end if;
  raise notice 'WAITLIST.6: Hatch New Enquiry holds % deals', v_entry_cnt;

  if not exists (
    select 1 from public.pipelines
     where location_id = v_loc and key = 'waitlist' and is_primary and enabled
  ) then
    raise exception 'WAITLIST.6: the waitlist board is not Hatch''s enabled primary';
  end if;
end $$;
