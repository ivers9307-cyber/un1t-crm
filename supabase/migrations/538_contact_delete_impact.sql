-- 538 — IMPACTCAT.1: derive the contact delete-impact preview from the catalog,
-- the same way migration 533 derives the merge.
--
-- WHY
-- ───
-- getContactImpact (src/lib/contact-merge.js) powers the "what does deleting
-- this contact destroy?" dialog. It counted rows from three hand-maintained
-- lists — CASCADE_TABLES, SET_NULL_TABLES, REDACT_ON_DELETE_TABLES — totalling
-- 21 (table, column) pairs.
--
-- pg_constraint says **80** columns reference contacts(id) today: 51 CASCADE,
-- 27 SET NULL, 1 RESTRICT, 1 NO ACTION. So the preview under-reported the cost
-- of a delete by about 60 columns — InBody scans, heart-rate sessions,
-- consultations, coaching goals, achievements, health metrics, monthly targets,
-- Strava activities, devices, app claim tokens and per-location marketing
-- consent among them. The operator was told a delete costs far less than it
-- does, and then clicked the button.
--
-- Two of those 60 do not merely go uncounted, they would make the DELETE FAIL:
--
--   person_groups.primary_contact_id   ON DELETE RESTRICT, NOT NULL
--   offer_purchases.contact_id         ON DELETE NO ACTION, nullable
--
-- NO ACTION and RESTRICT both raise a foreign-key violation on delete (they
-- differ only in deferrability), so both belong in the dialog's `block_delete`
-- bucket — which exists in the return shape and which nothing has ever
-- populated. ContactEditDeleteActions.jsx hides the type-to-confirm input
-- entirely while `block_delete` is non-empty, so populating it is what stops an
-- operator attempting a delete that can only end in a raw FK error.
--
-- Same conclusion 533 reached for the merge: ask pg_constraint at call time. A
-- table added tomorrow is covered the day it is added, and nothing has to
-- remember.
--
--
-- ONE ROUND TRIP, NOT EIGHTY
-- ──────────────────────────
-- The counting happens HERE rather than in the caller. Eighty separate
-- PostgREST count requests to render one dialog is the alternative, and it gets
-- worse every time a table is added. Every referencing column on a table with
-- more than 1,000 rows has a leading index, so each count is an index lookup.
--
-- Zero-count rows are not returned: the UI omits them anyway, and the payload
-- is then proportional to what the contact actually has rather than to the
-- schema's width.
--
--
-- COMPOSITE AND SELF-REFERENCING FKs — COUNT THEM, DON'T RAISE
-- ───────────────────────────────────────────────────────────
-- 533 raises on both, correctly: a merge cannot re-point a composite FK safely
-- and must not rewrite contacts rows themselves. This function is a READ-ONLY
-- preview, so refusing to answer helps nobody. A composite FK is handled by
-- pairing conkey with confkey and keeping only the column that references
-- contacts.id — the other members of the key are not contact references and
-- counting them would be meaningless. A self-referencing FK simply reports as
-- table "contacts", which is the honest answer. Neither exists today.
--
-- Partitions are excluded (`not relispartition`): a partitioned table's FK is
-- cloned onto every partition, so counting both parent and children would
-- double-count. There are none today either.
--
-- The DISTINCT ON collapses the theoretical case of two FK constraints on the
-- same (table, column); the ordering makes the most restrictive rule win,
-- because "this will block the delete" is the answer that matters.
--
--
-- IDENTIFIERS ARE QUOTED, NEVER CONCATENATED
-- ──────────────────────────────────────────
-- The counts run through EXECUTE format('… %I …'). The names come from the
-- catalog rather than from a caller, but format('%I') is the habit that keeps
-- it true when someone later parameterises it.
--
--
-- SECURITY: INVOKER
-- ─────────────────
-- Mirrors 533 (and 513 / 515 / 517 / 521). The only caller is the service-role
-- client, which bypasses RLS anyway. INVOKER + revoke + a service_role grant
-- means an accidental future grant to `authenticated` cannot exceed that
-- grantee's own table privileges — which matters here because the function can
-- otherwise be used to probe row counts across every table in the schema.
-- It does NO access check of its own: the route runs the manager-role check
-- and the location check before calling.
--
--
-- DEPLOYMENT
-- ──────────
-- The caller FALLS BACK to the old hand-maintained lists when this function is
-- absent or errors, so the code is safe to deploy before this migration is
-- applied. The full 80-column preview only becomes live once it is.
--
-- Forward-only. Idempotent (create or replace). Applying it touches no data —
-- it only defines the function.

drop function if exists public.contact_delete_impact(uuid);

create or replace function public.contact_delete_impact(p_contact_id uuid)
returns table (
  table_name    text,
  column_name   text,
  delete_action text,
  delete_rule   text,
  row_count     bigint
)
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_fk    record;
  v_count bigint;
begin
  if p_contact_id is null then
    raise exception 'contact_delete_impact: p_contact_id required';
  end if;

  for v_fk in
    select distinct on (cl.relname, att.attname)
           cl.relname            as tbl,
           att.attname           as col,
           con.confdeltype::text as act
      from pg_constraint con
      join pg_class cl       on cl.oid = con.conrelid
      join pg_namespace ns   on ns.oid = cl.relnamespace
      -- Pair each referencing column with the contacts column it points at, so
      -- a composite FK contributes only its contacts.id member.
      join unnest(con.conkey, con.confkey) as k(attnum, refattnum) on true
      join pg_attribute att    on att.attrelid = cl.oid          and att.attnum = k.attnum
      join pg_attribute refatt on refatt.attrelid = con.confrelid and refatt.attnum = k.refattnum
     where con.contype = 'f'
       and con.confrelid = 'public.contacts'::regclass
       and ns.nspname = 'public'
       and cl.relkind in ('r', 'p')
       and not cl.relispartition
       and refatt.attname = 'id'
     order by cl.relname, att.attname,
              -- Most restrictive first, so a duplicate constraint pair cannot
              -- downgrade a blocker into a cascade.
              case con.confdeltype
                when 'r' then 1  -- restrict
                when 'a' then 2  -- no action
                when 'c' then 3  -- cascade
                when 'd' then 4  -- set default
                else 5           -- set null
              end
  loop
    execute format('select count(*) from public.%I where %I = $1', v_fk.tbl, v_fk.col)
       into v_count
      using p_contact_id;

    -- Nothing there is nothing to warn about.
    continue when v_count = 0;

    table_name    := v_fk.tbl;
    column_name   := v_fk.col;
    delete_action := v_fk.act;
    delete_rule   := case v_fk.act
                       when 'c' then 'cascade'
                       when 'n' then 'set null'
                       when 'd' then 'set default'
                       when 'r' then 'restrict'
                       when 'a' then 'no action'
                       else 'unknown'
                     end;
    row_count     := v_count;
    return next;
  end loop;
end;
$$;

comment on function public.contact_delete_impact(uuid) is
  'IMPACTCAT.1 (mig 538) — one row per (table, column) that references contacts(id) and actually holds rows for this contact, with the FK delete action (confdeltype: c/n/r/a/d), a decoded rule string and the row count. Read from pg_constraint at call time, NOT hard-coded, so a table added later is counted without an edit; zero-count columns are omitted. Powers the delete-impact preview (getContactImpact in src/lib/contact-merge.js) — read-only, does NO permission check of its own, service_role only.';

revoke execute on function public.contact_delete_impact(uuid) from public, anon, authenticated;
grant  execute on function public.contact_delete_impact(uuid) to service_role;
