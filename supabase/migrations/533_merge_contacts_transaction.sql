-- 533 — MERGE-TX.1: move the whole contact merge into one Postgres function,
-- so it runs in one implicit transaction.
--
-- WHY
-- ───
-- mergeContacts (src/lib/contact-merge.js) did, in order: read both contacts →
-- dedupePreUpdate (DELETEs the loser's colliding rows) → re-point every FK
-- table → stamp the survivor → delete the loser. Supabase exposes no
-- multi-table transaction from the client, so ~25 statements ran unprotected.
--
-- The FK re-points are idempotent and the survivor stamp throws before the
-- delete (#1361), so a RE-RUN completes an interrupted merge. The
-- unrecoverable part is dedupePreUpdate: its deletes happen FIRST, before
-- anything that can fail, so a merge that is abandoned rather than retried has
-- permanently destroyed the loser's contact_preferences row — which is exactly
-- the state mig 532 had to repair, and which (per UNSUBTOKEN.2, same PR) leaves
-- a contact mailable but unable to unsubscribe.
--
-- Inside a function every statement shares one transaction. Any failure —
-- constraint, trigger, deadlock, a dropped connection mid-call — rolls the
-- whole thing back. There is no half-merge to re-run, and no state to explain.
--
--
-- THE FK LIST IS DERIVED FROM THE CATALOG, NOT COPIED
-- ───────────────────────────────────────────────────
-- The JS carried three hand-maintained lists (CASCADE_TABLES, SET_NULL_TABLES,
-- REDACT_ON_DELETE_TABLES) totalling 21 (table, column) pairs. Copying them
-- into SQL would have created a second list to drift.
--
-- It would also have copied a list that is already wrong. pg_constraint says
-- **81** columns reference contacts(id) today. The 60 the JS never re-points
-- are almost all ON DELETE CASCADE, so today a merge silently DESTROYS the
-- loser's InBody scans, heart-rate sessions, consultations, coaching goals,
-- achievements, health metrics, monthly targets, Strava activities, devices,
-- app claim tokens and per-location marketing consent. Two of them
-- (person_groups.primary_contact_id, ON DELETE RESTRICT NOT NULL, and
-- offer_purchases.contact_id, NO ACTION) would instead BLOCK the final delete
-- and leave the half-merge this migration exists to prevent.
--
-- So this function asks pg_constraint at call time. A table added tomorrow is
-- covered the day it is added, and nothing has to remember.
--
--
-- THE DEDUPE IS DERIVED THE SAME WAY — AND IT IS NOT OPTIONAL
-- ──────────────────────────────────────────────────────────
-- Re-pointing a loser row onto the survivor breaks any unique index whose key
-- includes the FK column. The JS hand-wrote three rules for the three tables it
-- knew about. Once the FK list comes from the catalog the dedupe MUST too:
-- contact_location_preferences is PRIMARY KEY (contact_id, location_id), and
-- the merge only runs on two contacts at the SAME location, so a naive
-- catalog-wide re-point would collide on essentially every merge.
--
-- The generic rule is: for each unique index over the FK column, delete the
-- loser rows that would collide with a survivor row on the index's OTHER key
-- columns, honouring the index's partial predicate on both sides.
--
-- Applied to today's catalog that rule reproduces the three JS rules exactly:
--
--   contact_preferences   UNIQUE (contact_id)             — no other key
--                         columns, so "survivor has a row" deletes every loser
--                         row. Identical to JS rule 1.
--   sequence_enrollments  UNIQUE (sequence_id, contact_id) — deletes the loser
--                         rows whose sequence_id the survivor also holds.
--                         Identical to JS rule 2.
--   contact_tags          UNIQUE (contact_id, tag) WHERE removed_at IS NULL —
--                         predicate applied to both sides, so the loser's
--                         REMOVED tag rows are untouched and get re-pointed.
--                         Identical to JS rule 3.
--
-- The hand rules were the general rule all along. The other 24 unique indexes
-- it now also covers can only IMPROVE on today: those tables are not in the JS
-- list at all, so every loser row on them is currently destroyed with the
-- loser. After this, colliding rows are deleted (same outcome as today) and
-- non-colliding rows are preserved (strictly better). That includes
-- whatsapp_broadcast_recipients, UNIQUE (broadcast_id, contact_id) — a latent
-- 23505 in the JS, which re-pointed the table without deduping it.
--
--
-- ROWS THAT REFERENCE BOTH CONTACTS
-- ─────────────────────────────────
-- Five tables carry two FKs to contacts, so a row can name the survivor AND the
-- loser — a relation between two people who turn out to be one person. It
-- cannot survive the merge: member_friendships has CHECK (requester <>
-- addressee), and person_link_suggestions is UNIQUE (a, b), so re-pointing
-- blind would abort the merge.
--
-- The FK's own delete action states the schema author's intent for "this
-- contact is gone", so it decides here too: a SET NULL column is nulled (the
-- row survives without the person — whatsapp_conversations,
-- instagram_conversations, team_members), a CASCADE/RESTRICT column takes the
-- whole row (the row IS the relation — member_friendships,
-- person_link_suggestions). Both happen before any re-point.
--
--
-- WHAT STAYS IN JS
-- ───────────────
-- The field-merge rule (pickMergedFields: survivor wins unless empty, where
-- empty means null/undefined/blank-or-whitespace but NOT 0 or false; plus keep
-- the older created_at) and the tag union (mergeTagArrays: survivor-first,
-- trimmed, case-sensitive dedupe) stay in JS, tested by the 15 tests that
-- already pin them, and are passed in. Porting them would have created a third
-- copy of a subtle rule — ContactMergeModal.jsx already carries a preview copy.
--
-- p_merged_fields is therefore attacker-shaped input to a service-role
-- function, so it is whitelisted here: an unknown key RAISES rather than being
-- ignored, which also means adding a field to the JS FIELDS list fails loudly
-- instead of silently not merging. id and location_id are not whitelisted and
-- can never be written.
--
--
-- SECURITY: INVOKER
-- ─────────────────
-- Mirrors 513 / 515 / 517 / 521. The only caller is the service-role client,
-- which bypasses RLS anyway, so DEFINER buys nothing — while this function
-- DELETES contacts and rewrites every table that references them, so a future
-- accidental grant to `authenticated` under DEFINER would be about the worst
-- primitive in the database. INVOKER + revoke + service_role grant means an
-- accidental grant still cannot exceed the grantee's own table privileges.
-- The function does NO access check of its own: the caller runs the
-- owner/master role check and the location check first.
--
--
-- AND THE MERGE HAS NEVER ACTUALLY WORKED
-- ───────────────────────────────────────
-- pickMergedFields has listed `last_active_at` among the columns it stamps
-- since the merge feature shipped (commit 36e49302). **public.contacts has no
-- such column** — information_schema confirms it, and the string appears in no
-- migration in this repo, ever. PostgREST rejects an UPDATE naming an unknown
-- column (PGRST204), so the stamp 400s on EVERY merge.
--
-- Because #1361 made the stamp throw before the loser delete, that failure
-- lands after dedupePreUpdate has already deleted the loser's
-- contact_preferences row and after every FK re-point — which is precisely the
-- half-merged state mig 532 had to repair, and the shape its header described
-- without being able to prove a cause. This is the cause.
--
-- So `last_active_at` is dropped from the stamp list here and in
-- pickMergedFields. It never merged anything, because it never existed; the
-- nearest real columns (last_attended_at, last_booked_at, last_marketing_touch_at)
-- are different facts and picking one would be inventing product behaviour, so
-- that is left as an operator decision rather than guessed at.
--
-- Forward-only. Idempotent (create or replace). No data is touched by applying
-- it — it only defines the function.

drop function if exists public.merge_contacts(uuid, uuid, jsonb, text[]);

create or replace function public.merge_contacts(
  p_survivor_id  uuid,
  p_loser_id     uuid,
  p_merged_fields jsonb,
  p_merged_tags   text[]
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  -- Every column the caller may stamp onto the survivor. Mirrors the FIELDS
  -- list in pickMergedFields (src/lib/contact-merge.js) plus created_at, which
  -- that function only emits when the loser's is older. id and location_id are
  -- deliberately absent — a merge never moves a contact between locations.
  c_stampable constant text[] := array[
    'name', 'first_name', 'last_name',
    'email', 'phone', 'label',
    'glofox_member_id', 'trial_credits_remaining',
    'lead_source', 'lead_created_at',
    'last_emailed_at',
    'created_at'
  ];

  v_survivor_loc uuid;
  v_loser_loc    uuid;
  v_bad_key      text;
  v_fk           record;
  v_idx          record;
  v_sql          text;
  v_pred         text;
  v_join         text;
  v_set          text;
  v_count        bigint;
  v_folded       jsonb := '{}'::jsonb;
  v_survivor     jsonb;
begin
  if p_survivor_id is null or p_loser_id is null then
    raise exception 'merge_contacts: survivorId and loserId required';
  end if;
  if p_survivor_id = p_loser_id then
    raise exception 'merge_contacts: cannot merge a contact with itself';
  end if;

  -- Lock both contacts in a deterministic (id) order, so two operators merging
  -- the same pair from opposite directions queue instead of deadlocking.
  perform 1 from public.contacts where id = least(p_survivor_id, p_loser_id) for update;
  perform 1 from public.contacts where id = greatest(p_survivor_id, p_loser_id) for update;

  select location_id into v_survivor_loc
    from public.contacts where id = p_survivor_id;
  if not found then
    raise exception 'merge_contacts: survivor % not found', p_survivor_id;
  end if;
  select location_id into v_loser_loc
    from public.contacts where id = p_loser_id;
  if not found then
    raise exception 'merge_contacts: loser % not found', p_loser_id;
  end if;

  -- Same guard the JS carried. IS DISTINCT FROM matches its `!==` on both
  -- edges: two NULL locations pass, NULL vs a value does not.
  if v_survivor_loc is distinct from v_loser_loc then
    raise exception 'merge_contacts: contacts must be at the same location';
  end if;

  -- Whitelist the stamp payload. An unrecognised key is an error, not a
  -- silently dropped field — see the header.
  select k into v_bad_key
    from jsonb_object_keys(coalesce(p_merged_fields, '{}'::jsonb)) as k
   where k <> all (c_stampable)
   limit 1;
  if v_bad_key is not null then
    raise exception 'merge_contacts: % is not a mergeable contact field', v_bad_key;
  end if;

  -- ── Guard: a self-referencing FK on contacts would make the passes below
  -- rewrite or delete contacts rows themselves. There is none today; if one is
  -- ever added, stop rather than guess.
  perform 1
     from pg_constraint con
    where con.contype = 'f'
      and con.confrelid = 'public.contacts'::regclass
      and con.conrelid  = 'public.contacts'::regclass;
  if found then
    raise exception 'merge_contacts: contacts now references itself — the merge needs a decision about that FK before it can run';
  end if;

  -- ── Guard: composite FKs. Every referencing FK is single-column today and
  -- the re-point below assumes it. A composite one needs its own rule.
  perform 1
     from pg_constraint con
     join pg_class cl on cl.oid = con.conrelid
    where con.contype = 'f'
      and con.confrelid = 'public.contacts'::regclass
      and array_length(con.conkey, 1) > 1;
  if found then
    raise exception 'merge_contacts: a composite foreign key to contacts exists — the re-point cannot handle it';
  end if;

  -- ── PASS 1 — rows that reference BOTH contacts ────────────────────────
  -- SET NULL columns are nulled (the row outlives the person); anything else
  -- takes the whole row (the row IS the relation). See the header.
  for v_fk in
    select cl.relname as tbl,
           array_agg(att.attname order by att.attname)   as cols,
           array_agg(att.attname order by att.attname)
             filter (where con.confdeltype = 'n')        as null_cols
      from pg_constraint con
      join pg_class cl        on cl.oid = con.conrelid
      join pg_namespace ns    on ns.oid = cl.relnamespace
      join unnest(con.conkey) as k(attnum) on true
      join pg_attribute att   on att.attrelid = cl.oid and att.attnum = k.attnum
     where con.contype = 'f'
       and con.confrelid = 'public.contacts'::regclass
       and ns.nspname = 'public'
       and cl.relkind in ('r', 'p')
     group by cl.relname
    having count(*) > 1
     order by cl.relname
  loop
    -- "names the survivor in one of its contact columns AND the loser in one"
    v_sql := format('(%s) and (%s)',
      (select string_agg(format('%I = $1', c), ' or ') from unnest(v_fk.cols) c),
      (select string_agg(format('%I = $2', c), ' or ') from unnest(v_fk.cols) c));

    if v_fk.null_cols is not null and array_length(v_fk.null_cols, 1) = array_length(v_fk.cols, 1) then
      -- Every contacts FK on this table is ON DELETE SET NULL → the schema says
      -- the row outlives the person, so keep it and drop the loser's side.
      v_set := (select string_agg(format('%I = case when %I = $2 then null else %I end', c, c, c), ', ')
                  from unnest(v_fk.cols) c);
      execute format('update public.%I set %s where %s', v_fk.tbl, v_set, v_sql)
        using p_survivor_id, p_loser_id;
    else
      -- At least one is CASCADE/RESTRICT → the row IS the relation, and a
      -- relation between someone and themselves is not one. Take the row.
      execute format('delete from public.%I where %s', v_fk.tbl, v_sql)
        using p_survivor_id, p_loser_id;
    end if;
  end loop;

  -- ── PASS 2 — dedupe, so the re-point cannot violate a unique index ────
  -- Mirrors dedupePreUpdate's ordering: every dedupe happens before any
  -- re-point, exactly as the JS did.
  for v_idx in
    select cl.relname                                   as tbl,
           fkatt.attname                                as fk_col,
           ix.indexrelid,
           pg_get_expr(ix.indpred, ix.indrelid)         as pred,
           -- KEY columns only. An INCLUDE (covering) column rides in indkey but
           -- takes no part in the uniqueness, so treating one as a dedupe key
           -- would under-delete and let the re-point hit 23505. None of today's
           -- indexes have one; indnkeyatts keeps that true if one appears.
           (select array_agg(a2.attname order by ik.ord)
              from unnest(ix.indkey::smallint[]) with ordinality as ik(attnum, ord)
              join pg_attribute a2
                on a2.attrelid = cl.oid and a2.attnum = ik.attnum
             where ik.ord <= ix.indnkeyatts
               and a2.attname <> fkatt.attname)         as other_cols
      from pg_constraint con
      join pg_class cl       on cl.oid = con.conrelid
      join pg_namespace ns   on ns.oid = cl.relnamespace
      join unnest(con.conkey) as k(attnum) on true
      join pg_attribute fkatt on fkatt.attrelid = cl.oid and fkatt.attnum = k.attnum
      join pg_index ix       on ix.indrelid = cl.oid and ix.indisunique
     where con.contype = 'f'
       and con.confrelid = 'public.contacts'::regclass
       and ns.nspname = 'public'
       and cl.relkind in ('r', 'p')
       -- The FK column must be one of the index's KEY columns for a re-point to
       -- be able to violate it; being merely INCLUDEd is not enough.
       and exists (
         select 1
           from unnest(ix.indkey::smallint[]) with ordinality as kk(attnum, ord)
          where kk.attnum = fkatt.attnum and kk.ord <= ix.indnkeyatts)
       -- An expression index cannot be reasoned about column-wise. There are
       -- none over a contacts FK today; if one appears, the re-point below
       -- would simply raise 23505 and roll the merge back, which is the safe
       -- direction — so this skips rather than blocking every merge.
       and ix.indexprs is null
     order by cl.relname, fkatt.attname
  loop
    -- The index predicate comes back with UNQUALIFIED column names. In the
    -- outer DELETE they bind to the target table; inside the EXISTS they bind
    -- to merge_src, the innermost range table. That is exactly the "apply the
    -- predicate to both sides" the partial-index case needs.
    v_pred := case when v_idx.pred is null then '' else ' and (' || v_idx.pred || ')' end;
    v_join := coalesce(
      (select string_agg(format('merge_src.%I = public.%I.%I', c, v_idx.tbl, c), ' and ')
         from unnest(v_idx.other_cols) c),
      '');
    if v_join <> '' then v_join := ' and ' || v_join; end if;

    execute format(
      'delete from public.%I
        where %I = $2 %s
          and exists (select 1 from public.%I as merge_src
                       where merge_src.%I = $1 %s %s)',
      v_idx.tbl, v_idx.fk_col, v_pred,
      v_idx.tbl, v_idx.fk_col, v_pred, v_join)
      using p_survivor_id, p_loser_id;
  end loop;

  -- ── PASS 3 — re-point every referencing column at the survivor ────────
  -- Idempotent: a second run matches no rows and folds nothing.
  for v_fk in
    select cl.relname as tbl, att.attname as col
      from pg_constraint con
      join pg_class cl      on cl.oid = con.conrelid
      join pg_namespace ns  on ns.oid = cl.relnamespace
      join unnest(con.conkey) as k(attnum) on true
      join pg_attribute att on att.attrelid = cl.oid and att.attnum = k.attnum
     where con.contype = 'f'
       and con.confrelid = 'public.contacts'::regclass
       and ns.nspname = 'public'
       and cl.relkind in ('r', 'p')
     order by cl.relname, att.attname
  loop
    execute format('update public.%I set %I = $1 where %I = $2',
                   v_fk.tbl, v_fk.col, v_fk.col)
      using p_survivor_id, p_loser_id;
    get diagnostics v_count = row_count;
    if v_count > 0 then
      -- Same "<table>.<column>" → count shape the JS returned, zero-count
      -- entries omitted, so the UI contract is unchanged.
      v_folded := v_folded || jsonb_build_object(v_fk.tbl || '.' || v_fk.col, v_count);
    end if;
  end loop;

  -- ── Stamp the survivor — AFTER the re-points, as before ───────────────
  -- jsonb_populate_record is seeded with the survivor's CURRENT row, so keys
  -- absent from p_merged_fields keep their existing value. That is what makes
  -- pickMergedFields' "omit created_at unless the loser's is older" work.
  update public.contacts c
     set name                    = m.name,
         first_name              = m.first_name,
         last_name               = m.last_name,
         email                   = m.email,
         phone                   = m.phone,
         label                   = m.label,
         glofox_member_id        = m.glofox_member_id,
         trial_credits_remaining = m.trial_credits_remaining,
         lead_source             = m.lead_source,
         lead_created_at         = m.lead_created_at,
         last_emailed_at         = m.last_emailed_at,
         created_at              = m.created_at,
         tags                    = coalesce(p_merged_tags, c.tags)
    from jsonb_populate_record(
           (select cc from public.contacts cc where cc.id = p_survivor_id),
           coalesce(p_merged_fields, '{}'::jsonb)
         ) m
   where c.id = p_survivor_id;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    -- Kept from the JS as the invariant it always was. Unreachable in practice
    -- now (the row is locked above), but a stamp that silently touches nothing
    -- must never be reported as a merge. The MESSAGE changed on purpose: the
    -- JS told the operator the fold had already happened and a re-run was safe,
    -- which was true of an unprotected sequence and is the opposite of true
    -- here — this raise rolls the entire merge back.
    raise exception
      'merge_contacts: failed to stamp survivor % with the merged fields (the update matched no row). The whole merge has been ROLLED BACK: loser % still exists and nothing has moved.',
      p_survivor_id, p_loser_id;
  end if;

  delete from public.contacts where id = p_loser_id;

  select to_jsonb(c) into v_survivor from public.contacts c where c.id = p_survivor_id;
  return jsonb_build_object('survivor', v_survivor, 'folded', v_folded);
end;
$$;

comment on function public.merge_contacts(uuid, uuid, jsonb, text[]) is
  'MERGE-TX.1 (mig 533) — folds the loser contact into the survivor in ONE transaction: dedupe by unique index, re-point every referencing FK, stamp the survivor, delete the loser. The referencing tables and the dedupe keys are read from pg_constraint/pg_index at call time, NOT hard-coded, so a table added later is covered without an edit. Takes the already-merged field values from the caller (pickMergedFields / mergeTagArrays in src/lib/contact-merge.js) and whitelists them; it does NO permission or location-access check of its own beyond requiring both contacts to share a location — the caller runs the owner/master role check first. service_role only.';

revoke execute on function public.merge_contacts(uuid, uuid, jsonb, text[])
  from public, anon, authenticated;
grant execute on function public.merge_contacts(uuid, uuid, jsonb, text[])
  to service_role;
