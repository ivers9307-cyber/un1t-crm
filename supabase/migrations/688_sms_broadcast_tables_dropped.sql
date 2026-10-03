-- 688 — SMSTABLESDROP.1 (follow-ups C128): drop the retired SMS broadcast
-- tables. public.sms_broadcast_recipients, public.sms_broadcasts, the three
-- increment_sms_broadcast_* counters and sms_broadcasts_set_updated_at() (the
-- trigger function only sms_broadcasts uses) are dropped. DESTRUCTIVE.
--
-- APPROVED by Richard, 1 Oct 2026 (in chat): drop both tables and their
-- 7 rows (1 broadcast, 6 recipients) and the functions. The data is NOT
-- kept and NOT restorable; the rollback record at the end of this file
-- recreates the schema only.
--
-- NOT APPLIED YET when this file was written. Behaviour is proven ahead of
-- apply by tests/migration-688-sms-broadcast-tables-dropped.test.js.
--
-- ===========================================================================
-- WHY
-- ===========================================================================
-- SMS was retired with Twilio on 30 Sep 2026 (TWILIO-RETIRE.1/.2, #1851,
-- #1852, #1853, migs 664-666): no code has read or written these tables
-- since, and mig 683 (MEMBERWRITESWEEP.1d, applied 1 Oct) closed both to
-- every client role. They held one broadcast ever (12 Aug 2026) and its six
-- recipients.
--
-- VERIFIED LIVE (1 Oct 2026, read-only, Supabase MCP; counts and catalog
-- only, no row values):
--   * rows: sms_broadcasts 1, sms_broadcast_recipients 6;
--   * both: owner postgres, RLS on (not forced), relacl
--     {postgres=arwdDxtm/postgres,service_role=arwdDxtm/postgres}, no column
--     ACL, 0 policies, in no publication;
--   * pg_depend on the two tables, their row types and the four functions:
--     only their own sub-objects (row and array types, toast, column
--     defaults, their constraints and indexes), the recipients -> broadcasts
--     FK, and trigger sms_broadcasts_updated_at -> sms_broadcasts_set_
--     updated_at(). No view, matview, rule, FK from another table, statistics
--     object, BEGIN ATOMIC function or other trigger;
--   * outgoing FKs only (to locations, profiles, contacts): dropping the
--     tables removes nothing from those parents;
--   * function bodies naming sms_broadcast outside pg_catalog: exactly the
--     three counters; no policy anywhere names either table;
--   * logs, last 24 h (edge log request.url, postgres logs): no request
--     names either table or /rpc/increment_sms_broadcast_*; the only
--     statements naming them were the 667 and 683 applies.
--   * un1t-sentinel listed both in its investigator's read allowlist
--     (src/lib/tools/crm-db.js); removed in its own PR, which merges FIRST.
--
-- Functions dropped (exact prod signatures):
--   public.increment_sms_broadcast_delivered(uuid)
--   public.increment_sms_broadcast_metric(uuid, text, integer)
--   public.increment_sms_broadcast_undelivered(uuid)
--   public.sms_broadcasts_set_updated_at()
--
-- ===========================================================================
-- THE FILE
-- ===========================================================================
--   1. Preflight (aborts everything): both tables and all four functions
--      exist (a second run stops here, loudly: the file is ONE-SHOT, never
--      a silent no-op); both tables locked, then at most 1 broadcast and 6
--      recipients (more = something still writes); nothing outside the
--      dropped set depends on them (pg_depend), names them (function bodies,
--      policies) or uses the trigger function. Catalog counts outside the
--      dropped set are recorded.
--   2. The drops, every one RESTRICT: a hidden dependant makes the DROP
--      itself fail, so it is never dropped with them. Never add CASCADE.
--   3. Post-check (aborts everything): the tables, row types and functions
--      are gone and every recorded count is unchanged (nothing else moved).
--
-- APPLY ORDER: (1) the un1t-sentinel PR removing the two tables from
-- query_crm_table's allowlist is MERGED; (2) this PR is merged; (3) apply
-- (Supabase MCP apply_migration, body without BEGIN/COMMIT: it is already one
-- transaction). Pre: SELECT count(*) of each table = 1 / 6. Post:
-- to_regclass of both is NULL, the four to_regprocedure are NULL, advisors.
-- A lock timeout is the worst case (nothing uses the tables); re-run. The
-- post-check counts the whole catalog, so DDL committed by another session
-- in the milliseconds between the two checks (e.g. Realtime adding a
-- partition) aborts the file too: safe, re-run.
-- Preflight dry-run on prod, 1 Oct 2026 (the same queries as a read-only
-- SELECT, no lock): no foreign dependant, no foreign function text, no
-- policy; 14 relations, 4 types and 10 constraints in the dropped set; 6
-- RI triggers on locations/profiles/contacts go with the 3 outgoing FKs.
-- ===========================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Preflight.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_b regclass := to_regclass('public.sms_broadcasts');
  v_r regclass := to_regclass('public.sms_broadcast_recipients');
  v_sigs text[] := ARRAY[
    'public.increment_sms_broadcast_delivered(uuid)',
    'public.increment_sms_broadcast_metric(uuid, text, integer)',
    'public.increment_sms_broadcast_undelivered(uuid)',
    'public.sms_broadcasts_set_updated_at()'];
  v_sig text;
  v_fns oid[] := '{}';
  v_tbl oid[];
  v_rel oid[];
  v_typ oid[];
  v_con oid[];
  v_n bigint;
  v_bad text;
BEGIN
  IF v_b IS NULL OR v_r IS NULL THEN
    RAISE EXCEPTION 'mig 688: public.sms_broadcasts and public.sms_broadcast_recipients must both exist; this file is one-shot and has already run (or the schema is not the one it was written against)';
  END IF;
  FOREACH v_sig IN ARRAY v_sigs LOOP
    IF to_regprocedure(v_sig) IS NULL THEN
      RAISE EXCEPTION 'mig 688: function % does not exist', v_sig;
    END IF;
    v_fns := v_fns || to_regprocedure(v_sig)::oid;
  END LOOP;

  -- No writer can slip a row in between the count and the drop.
  LOCK TABLE public.sms_broadcast_recipients, public.sms_broadcasts IN ACCESS EXCLUSIVE MODE;

  SELECT count(*) INTO v_n FROM public.sms_broadcasts;
  IF v_n > 1 THEN
    RAISE EXCEPTION 'mig 688: public.sms_broadcasts holds % rows, at most 1 expected: something still writes it', v_n;
  END IF;
  SELECT count(*) INTO v_n FROM public.sms_broadcast_recipients;
  IF v_n > 6 THEN
    RAISE EXCEPTION 'mig 688: public.sms_broadcast_recipients holds % rows, at most 6 expected: something still writes it', v_n;
  END IF;

  -- The dropped set: the two tables, their indexes, toast tables (and their
  -- indexes), row and array types, constraints.
  v_tbl := ARRAY[v_b::oid, v_r::oid];
  SELECT array_agg(o) INTO v_rel FROM (
    SELECT unnest(v_tbl) AS o
    UNION SELECT indexrelid FROM pg_index WHERE indrelid = ANY (v_tbl)
    UNION SELECT reltoastrelid FROM pg_class WHERE oid = ANY (v_tbl) AND reltoastrelid <> 0
    UNION SELECT i.indexrelid FROM pg_index i JOIN pg_class c ON c.reltoastrelid = i.indrelid WHERE c.oid = ANY (v_tbl)
  ) s;
  SELECT array_agg(oid) INTO v_typ FROM pg_type
   WHERE typrelid = ANY (v_rel)
      OR typelem IN (SELECT oid FROM pg_type WHERE typrelid = ANY (v_rel));
  SELECT coalesce(array_agg(oid), '{}') INTO v_con FROM pg_constraint WHERE conrelid = ANY (v_tbl);

  -- Nothing outside the set depends on it.
  SELECT string_agg(DISTINCT pg_describe_object(d.classid, d.objid, d.objsubid), ', ') INTO v_bad
    FROM pg_depend d
   WHERE ((d.refclassid = 'pg_class'::regclass AND d.refobjid = ANY (v_tbl))
       OR (d.refclassid = 'pg_type'::regclass AND d.refobjid = ANY (v_typ))
       OR (d.refclassid = 'pg_proc'::regclass AND d.refobjid = ANY (v_fns)))
     AND NOT (
          (d.classid = 'pg_class'::regclass AND d.objid = ANY (v_rel))
       OR (d.classid = 'pg_type'::regclass AND d.objid = ANY (v_typ))
       OR (d.classid = 'pg_attrdef'::regclass
           AND d.objid IN (SELECT oid FROM pg_attrdef WHERE adrelid = ANY (v_tbl)))
       OR (d.classid = 'pg_constraint'::regclass AND d.objid = ANY (v_con))
       OR (d.classid = 'pg_trigger'::regclass
           AND d.objid IN (SELECT oid FROM pg_trigger
                            WHERE tgrelid = v_b AND tgname = 'sms_broadcasts_updated_at'
                              AND tgfoid = to_regprocedure('public.sms_broadcasts_set_updated_at()'))));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 688: objects outside the dropped set depend on it: %', v_bad;
  END IF;

  -- Function bodies are not in pg_depend (except BEGIN ATOMIC): read them,
  -- ignoring case (unquoted identifiers fold: SMS_BROADCASTS is the table).
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v_bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND p.prosrc ~* '\msms_broadcast'
     AND NOT (p.oid = ANY (v_fns));
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 688: functions outside the dropped set name sms_broadcast: %', v_bad;
  END IF;

  SELECT string_agg(schemaname || '.' || tablename || '.' || policyname, ', ') INTO v_bad
    FROM pg_policies
   WHERE (schemaname = 'public' AND tablename IN ('sms_broadcasts', 'sms_broadcast_recipients'))
      OR (coalesce(qual, '') || ' ' || coalesce(with_check, '')) ~ '\msms_broadcast';
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 688: policies name or sit on the SMS broadcast tables: %', v_bad;
  END IF;

  -- Counts outside the dropped set, for the post-check (temp namespaces
  -- excluded: another session's temp objects are not this file's business).
  PERFORM set_config('mig688.rels', (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname NOT LIKE 'pg\_temp\_%' AND n.nspname NOT LIKE 'pg\_toast\_temp\_%'
      AND NOT (c.oid = ANY (v_rel)))::text, true);
  PERFORM set_config('mig688.types', (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname NOT LIKE 'pg\_temp\_%' AND n.nspname NOT LIKE 'pg\_toast\_temp\_%'
      AND NOT (t.oid = ANY (v_typ)))::text, true);
  PERFORM set_config('mig688.procs', (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname NOT LIKE 'pg\_temp\_%' AND NOT (p.oid = ANY (v_fns)))::text, true);
  PERFORM set_config('mig688.constraints', (SELECT count(*) FROM pg_constraint
    WHERE NOT (oid = ANY (v_con)))::text, true);
  -- The FKs out of the set own internal RI triggers on contacts, locations
  -- and profiles; they go with their constraints.
  PERFORM set_config('mig688.triggers', (SELECT count(*) FROM pg_trigger
    WHERE NOT (tgrelid = ANY (v_tbl)) AND NOT (tgconstraint = ANY (v_con)))::text, true);
  PERFORM set_config('mig688.policies', (SELECT count(*) FROM pg_policy)::text, true);
END $$;

-- ---------------------------------------------------------------------------
-- 2. The drops. RESTRICT everywhere: never CASCADE.
-- ---------------------------------------------------------------------------
DROP FUNCTION public.increment_sms_broadcast_delivered(uuid) RESTRICT;
DROP FUNCTION public.increment_sms_broadcast_metric(uuid, text, integer) RESTRICT;
DROP FUNCTION public.increment_sms_broadcast_undelivered(uuid) RESTRICT;
DROP TABLE public.sms_broadcast_recipients RESTRICT;
DROP TABLE public.sms_broadcasts RESTRICT;
DROP FUNCTION public.sms_broadcasts_set_updated_at() RESTRICT;

-- ---------------------------------------------------------------------------
-- 3. Post-check: the catalog, never this file's text.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_name text;
  v_before bigint;
  v_after bigint;
BEGIN
  FOREACH v_name IN ARRAY ARRAY['public.sms_broadcasts', 'public.sms_broadcast_recipients'] LOOP
    IF to_regclass(v_name) IS NOT NULL OR to_regtype(v_name) IS NOT NULL THEN
      RAISE EXCEPTION 'mig 688: % still exists', v_name;
    END IF;
  END LOOP;
  FOREACH v_name IN ARRAY ARRAY[
    'public.increment_sms_broadcast_delivered(uuid)',
    'public.increment_sms_broadcast_metric(uuid, text, integer)',
    'public.increment_sms_broadcast_undelivered(uuid)',
    'public.sms_broadcasts_set_updated_at()'] LOOP
    IF to_regprocedure(v_name) IS NOT NULL THEN
      RAISE EXCEPTION 'mig 688: % still exists', v_name;
    END IF;
  END LOOP;

  FOREACH v_name IN ARRAY ARRAY['rels', 'types', 'procs', 'constraints', 'triggers', 'policies'] LOOP
    v_before := current_setting('mig688.' || v_name)::bigint;
    v_after := CASE v_name
      WHEN 'rels' THEN (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname NOT LIKE 'pg\_temp\_%' AND n.nspname NOT LIKE 'pg\_toast\_temp\_%')
      WHEN 'types' THEN (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname NOT LIKE 'pg\_temp\_%' AND n.nspname NOT LIKE 'pg\_toast\_temp\_%')
      WHEN 'procs' THEN (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT LIKE 'pg\_temp\_%')
      WHEN 'constraints' THEN (SELECT count(*) FROM pg_constraint)
      WHEN 'triggers' THEN (SELECT count(*) FROM pg_trigger)
      WHEN 'policies' THEN (SELECT count(*) FROM pg_policy)
    END;
    IF v_after <> v_before THEN
      RAISE EXCEPTION 'mig 688: % outside the dropped set changed: % before, % after',
        CASE v_name WHEN 'rels' THEN 'pg_class' WHEN 'types' THEN 'pg_type' WHEN 'procs' THEN 'pg_proc'
          WHEN 'constraints' THEN 'pg_constraint' WHEN 'triggers' THEN 'pg_trigger' ELSE 'pg_policy' END,
        v_before, v_after;
    END IF;
  END LOOP;

  RAISE NOTICE 'mig 688: sms_broadcasts, sms_broadcast_recipients, the three increment_sms_broadcast_* counters and sms_broadcasts_set_updated_at() are dropped; nothing else in the catalog changed.';
END $$;

COMMIT;

-- ===========================================================================
-- ROLLBACK. Schema only: the data is NOT restorable (the 7 rows are gone by
-- Richard's decision of 1 Oct 2026). The block below recreates prod's
-- definitions as read on 1 Oct 2026 in the post-683 closed state (postgres
-- + service_role only, RLS on, no policy), whatever the default ACLs are.
-- Proven by the replay test (it restores prod's catalog exactly). Run it
-- with the leading "-- " removed from each line.
-- ===========================================================================
-- ROLLBACK RECORD BEGIN (schema only)
-- BEGIN;
-- SET LOCAL lock_timeout = '5s';
--
-- CREATE TABLE public.sms_broadcasts (
--   id uuid NOT NULL DEFAULT gen_random_uuid(),
--   location_id uuid NOT NULL,
--   name text NOT NULL,
--   body text NOT NULL,
--   audience_filter jsonb NOT NULL DEFAULT '{"logic": "and", "filters": []}'::jsonb,
--   status text NOT NULL DEFAULT 'draft'::text,
--   scheduled_at timestamp with time zone,
--   sent_at timestamp with time zone,
--   total_recipients integer NOT NULL DEFAULT 0,
--   total_sent integer NOT NULL DEFAULT 0,
--   total_failed integer NOT NULL DEFAULT 0,
--   created_by uuid,
--   created_at timestamp with time zone NOT NULL DEFAULT now(),
--   updated_at timestamp with time zone NOT NULL DEFAULT now(),
--   total_delivered integer NOT NULL DEFAULT 0,
--   total_undelivered integer NOT NULL DEFAULT 0,
--   CONSTRAINT sms_broadcasts_pkey PRIMARY KEY (id),
--   CONSTRAINT sms_broadcasts_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 1600))),
--   CONSTRAINT sms_broadcasts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'sending'::text, 'sent'::text, 'cancelled'::text]))),
--   CONSTRAINT sms_broadcasts_location_id_fkey FOREIGN KEY (location_id) REFERENCES public.locations(id) ON DELETE CASCADE,
--   CONSTRAINT sms_broadcasts_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id)
-- );
-- CREATE INDEX sms_broadcasts_location_idx ON public.sms_broadcasts USING btree (location_id);
-- CREATE INDEX sms_broadcasts_status_idx ON public.sms_broadcasts USING btree (status, scheduled_at) WHERE (status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'sending'::text]));
-- CREATE INDEX idx_sms_broadcasts_created_by ON public.sms_broadcasts USING btree (created_by);
-- COMMENT ON TABLE public.sms_broadcasts IS 'One-shot SMS sends to a filtered audience. Phase 2 of the multi-location SMS rollout. Mirrors whatsapp_broadcasts but for freeform SMS over Twilio with per-location alpha sender ID.';
-- COMMENT ON COLUMN public.sms_broadcasts.total_delivered IS 'Cumulative count of recipients in the delivered state.';
-- COMMENT ON COLUMN public.sms_broadcasts.total_undelivered IS 'Cumulative count of recipients in the undelivered state.';
--
-- CREATE TABLE public.sms_broadcast_recipients (
--   id uuid NOT NULL DEFAULT gen_random_uuid(),
--   broadcast_id uuid NOT NULL,
--   contact_id uuid NOT NULL,
--   twilio_message_sid text,
--   status text NOT NULL DEFAULT 'pending'::text,
--   error_message text,
--   sent_at timestamp with time zone,
--   failed_at timestamp with time zone,
--   created_at timestamp with time zone NOT NULL DEFAULT now(),
--   delivered_at timestamp with time zone,
--   undelivered_at timestamp with time zone,
--   CONSTRAINT sms_broadcast_recipients_pkey PRIMARY KEY (id),
--   CONSTRAINT sms_broadcast_recipients_broadcast_id_contact_id_key UNIQUE (broadcast_id, contact_id),
--   CONSTRAINT sms_broadcast_recipients_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'delivered'::text, 'undelivered'::text, 'failed'::text]))),
--   CONSTRAINT sms_broadcast_recipients_broadcast_id_fkey FOREIGN KEY (broadcast_id) REFERENCES public.sms_broadcasts(id) ON DELETE CASCADE,
--   CONSTRAINT sms_broadcast_recipients_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.contacts(id) ON DELETE CASCADE
-- );
-- CREATE INDEX sms_broadcast_recipients_broadcast_idx ON public.sms_broadcast_recipients USING btree (broadcast_id);
-- CREATE INDEX sms_broadcast_recipients_contact_idx ON public.sms_broadcast_recipients USING btree (contact_id);
-- COMMENT ON COLUMN public.sms_broadcast_recipients.delivered_at IS 'Stamped by /api/webhooks/twilio/status when Twilio reports MessageStatus=delivered.';
-- COMMENT ON COLUMN public.sms_broadcast_recipients.undelivered_at IS 'Stamped by /api/webhooks/twilio/status when Twilio reports MessageStatus=undelivered.';
--
-- ALTER TABLE public.sms_broadcasts ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE public.sms_broadcast_recipients ENABLE ROW LEVEL SECURITY;
-- REVOKE ALL ON public.sms_broadcasts, public.sms_broadcast_recipients FROM anon, authenticated, PUBLIC;
-- GRANT ALL ON public.sms_broadcasts, public.sms_broadcast_recipients TO service_role;
--
-- CREATE OR REPLACE FUNCTION public.sms_broadcasts_set_updated_at()
--  RETURNS trigger
--  LANGUAGE plpgsql
--  SET search_path TO 'pg_catalog', 'public'
-- AS $function$
-- begin
--   new.updated_at = now();
--   return new;
-- end;
-- $function$;
-- CREATE TRIGGER sms_broadcasts_updated_at BEFORE UPDATE ON public.sms_broadcasts
--   FOR EACH ROW EXECUTE FUNCTION public.sms_broadcasts_set_updated_at();
--
-- CREATE OR REPLACE FUNCTION public.increment_sms_broadcast_delivered(p_broadcast_id uuid)
--  RETURNS void
--  LANGUAGE sql
--  SET search_path TO 'pg_catalog', 'public'
-- AS $function$
--   update sms_broadcasts set total_delivered = total_delivered + 1
--    where id = p_broadcast_id;
-- $function$;
-- CREATE OR REPLACE FUNCTION public.increment_sms_broadcast_undelivered(p_broadcast_id uuid)
--  RETURNS void
--  LANGUAGE sql
--  SET search_path TO 'pg_catalog', 'public'
-- AS $function$
--   update sms_broadcasts set total_undelivered = total_undelivered + 1
--    where id = p_broadcast_id;
-- $function$;
-- CREATE OR REPLACE FUNCTION public.increment_sms_broadcast_metric(p_broadcast_id uuid, p_metric text, p_delta integer DEFAULT 1)
--  RETURNS void
--  LANGUAGE plpgsql
--  SET search_path TO ''
-- AS $function$
-- begin
--   if p_metric not in ('total_sent','total_delivered','total_undelivered','total_failed') then
--     raise exception 'increment_sms_broadcast_metric: unknown metric %', p_metric;
--   end if;
--   update public.sms_broadcasts set
--     total_sent        = coalesce(total_sent,0)        + (case when p_metric='total_sent'        then p_delta else 0 end),
--     total_delivered   = coalesce(total_delivered,0)   + (case when p_metric='total_delivered'   then p_delta else 0 end),
--     total_undelivered = coalesce(total_undelivered,0) + (case when p_metric='total_undelivered' then p_delta else 0 end),
--     total_failed      = coalesce(total_failed,0)      + (case when p_metric='total_failed'      then p_delta else 0 end)
--   where id = p_broadcast_id;
-- end $function$;
-- REVOKE ALL ON FUNCTION public.sms_broadcasts_set_updated_at(),
--   public.increment_sms_broadcast_delivered(uuid),
--   public.increment_sms_broadcast_undelivered(uuid),
--   public.increment_sms_broadcast_metric(uuid, text, integer)
--   FROM PUBLIC, anon, authenticated;
-- GRANT EXECUTE ON FUNCTION public.sms_broadcasts_set_updated_at(),
--   public.increment_sms_broadcast_delivered(uuid),
--   public.increment_sms_broadcast_undelivered(uuid),
--   public.increment_sms_broadcast_metric(uuid, text, integer)
--   TO service_role;
-- COMMIT;
-- ROLLBACK RECORD END
