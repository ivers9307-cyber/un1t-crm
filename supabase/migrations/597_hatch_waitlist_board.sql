-- WAITLIST.1 — UN1T Hatch Street's manual waitlist board.
--
-- Hatch runs on un1t.online, not Glofox, so classifyContact() reads fields its
-- contacts do not have and 'dormant' is its fallthrough: 98 of 99 website
-- waitlist leads — 83 of them created in the last 60 days — were filed as
-- ghosts. This board replaces that with something true.
--
-- MANUAL on purpose (Richard, 2026-09-08). Entry is automatic; every move
-- after that is by hand. It is deliberately NOT a funnel: a Hatch lead who
-- books a class books on un1t.online, invisibly to the CRM, so a derived
-- "Converted" column would be a guess. Someone is Converted when a human says
-- so.
--
-- COLUMN SEMANTICS (Richard, 2026-09-08): "No Answer" means WE CALLED AND GOT
-- NO ANSWER — the recorded outcome of an attempt, not a holding pen for people
-- nobody has tried yet. So New Enquiry means "not yet worked", and column 1 is
-- the to-do list.
--
-- The waitlist_ prefix is required: Hatch's archived gym stages still hold
-- 'new_lead' and 'converted', and pipeline_stages_location_slug_unique is per
-- LOCATION. Same reason mig 558 used returning_.
--
-- ENABLED BUT NOT PRIMARY, deliberately. The cutover — moving Hatch's 102
-- deals onto this board, making it primary, retiring the gym board — happens
-- atomically in mig 598, AFTER the code that renders and writes a manual board
-- has deployed. Demoting the gym board here instead would leave Hatch's 102
-- deals sitting on a disabled board, visible nowhere, for the length of a
-- deploy. Until 598 the board simply shows as an empty second tab, which is
-- also the chance to eyeball the columns before anything moves.

-- FIRST: re-key the name-uniqueness constraint onto the real board column.
--
-- Mig 559 widened it to (location_id, board, name) after mig 558's second board
-- collided on the name "Converted" — a collision that `on conflict do nothing`
-- swallowed, so the migration reported success and the board shipped with four
-- columns instead of five.
--
-- This board hit the SAME wall on its first apply, for the same reason and on
-- the same column name: `board` is a legacy text column that still defaults to
-- 'acquisition', so these five rows landed in Hatch's acquisition namespace,
-- where "Converted" already exists. It raised rather than vanishing only
-- because the insert below conflict-targets the slug explicitly — 559's actual
-- lesson, doing its job.
--
-- The invariant 559 wanted is unchanged: a name must be unambiguous WITHIN a
-- board. `pipeline_id` simply IS the board now, so keying on it says the same
-- thing about the real column instead of the one mig 598 drops. Nothing that
-- was rejected within a board becomes possible.
alter table public.pipeline_stages
  drop constraint if exists pipeline_stages_location_board_name_unique;

alter table public.pipeline_stages
  add constraint pipeline_stages_pipeline_name_unique unique (pipeline_id, name);

do $$
declare
  v_loc      uuid := '28c78d6b-f7b3-4edf-8c7c-840bd047b3f4';  -- UN1T Hatch Street
  v_pipeline uuid;
  v_stages   int;
begin
  insert into public.pipelines
    (location_id, key, name, module, mode, is_primary, display_order, enabled)
  values
    (v_loc, 'waitlist', 'Waitlist', null, 'manual', false, 1, true)
  on conflict (location_id, key) do update
     set mode = 'manual', module = null, enabled = true
  returning id into v_pipeline;

  if v_pipeline is null then
    raise exception 'WAITLIST.1: could not resolve the waitlist pipeline id';
  end if;

  -- Conflict-target the slug explicitly. Mig 559's lesson: a bare
  -- `on conflict do nothing` turns a schema disagreement into a missing column
  -- and a green checkmark — that migration shipped a five-column board with
  -- four columns and reported success.
  -- `board` is set explicitly even though mig 598 drops it: while the column
  -- exists and is NOT NULL with a default of 'acquisition', letting it default
  -- would leave every waitlist row asserting it belongs to the gym board.
  insert into public.pipeline_stages
    (location_id, pipeline_id, board, name, slug, display_order, color, is_dormant, archived)
  values
    (v_loc, v_pipeline, 'waitlist', 'New Enquiry',              'waitlist_new_enquiry',    501, '#3B82F6', false, false),
    (v_loc, v_pipeline, 'waitlist', 'No Answer',                'waitlist_no_answer',      502, '#F59E0B', false, false),
    (v_loc, v_pipeline, 'waitlist', 'Interested in membership', 'waitlist_interested',     503, '#10B981', false, false),
    (v_loc, v_pipeline, 'waitlist', 'Not interested',           'waitlist_not_interested', 504, '#52525B', false, false),
    (v_loc, v_pipeline, 'waitlist', 'Converted',                'waitlist_converted',      505, '#059669', false, false)
  on conflict (location_id, slug) do nothing;

  -- Count, don't trust.
  select count(*) into v_stages
    from public.pipeline_stages where pipeline_id = v_pipeline;
  if v_stages <> 5 then
    raise exception 'WAITLIST.1: expected 5 waitlist stages, found %', v_stages;
  end if;

  -- The gym board must still be Hatch's primary until mig 598 cuts over, or
  -- its 102 deals lose the board that owns contacts.pipeline_stage_slug.
  if not exists (
    select 1 from public.pipelines
     where location_id = v_loc and key = 'acquisition' and is_primary and enabled
  ) then
    raise exception 'WAITLIST.1: Hatch acquisition board is no longer the enabled primary';
  end if;
end $$;
