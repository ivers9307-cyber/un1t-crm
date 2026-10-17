-- 733 — ORGSETAUDIT.1: every change to public.org_settings leaves an
-- audit_events row naming the organisation and, for an admin's save, the
-- admin.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 17 Oct 2026).
-- Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-733-org-settings-audit.test.js).
--
-- NUMBERING: applied live 17 Oct 10:50 UTC as `731_org_settings_audit` (the
-- schema_migrations name stays that); renumbered FILE-ONLY to 733 because
-- #2079 merged `731_contacts_read_by_studio_membership` to main first. The two
-- '-- 731:' comments inside log_mutation's body are left as applied: Postgres
-- stores a function's comments, so the file's body stays byte-identical to
-- prod's. Nothing depends on this file, so the move changes no replay order.
--
-- ===========================================================================
-- THE FINDING
-- ===========================================================================
-- org_settings holds the organisation's AI and email hard caps, its legal
-- identity (mig 425), its ops alert recipients (mig 424), its brand and Mia's
-- organisation defaults (mig 729), and its only trigger besides 729's fence
-- was touch_updated_at: nothing recorded who changed a cap or an alert
-- address, or what it was before. Mig 730 closed it to client sessions, so
-- every write is now a service-role route (/api/settings/org-branding,
-- /api/settings/org-usage, /api/settings/customer-agent/org: masters and org
-- admins, each stamping updated_by = the caller) or the usage-rollup cron.
--
-- The estate's mutation audit (private.log_mutation, the `audit_mutation`
-- AFTER ROW trigger since mig 191, redacting by key name since 647/655)
-- cannot simply be attached, for two reasons:
--   * it names the row `<table>/<NEW.id>`, and org_settings has no id (its
--     key is organization_id): an UPDATE row would read 'org_settings/?' and
--     carry only the changed columns, so it would not say WHICH organisation;
--   * its actor is auth.uid(), which is NULL for every service-role write,
--     so after mig 730 every org_settings row would have no actor.
--
-- VERIFIED LIVE (17 Oct 2026, BEFORE this migration; mig 730 applied):
-- private.log_mutation() is SECURITY DEFINER, owner postgres, search_path '',
-- EXECUTE {postgres, authenticated, service_role} (no anon: mig 678). It runs
-- as `audit_mutation` (AFTER INSERT OR UPDATE OR DELETE, FOR EACH ROW,
-- tgtype 29, enabled, no arguments) on exactly six tables: cars,
-- invoices_queue, locations, organizations, profile_locations, profiles.
-- Every one of the six has an `id` column. audit_events.actor_id references
-- profiles(id) ON DELETE SET NULL, as does org_settings.updated_by.
-- org_settings: 2 rows, no `id`, PK organization_id, updated_by set by all
-- three admin routes (`updated_by: user.id`) and never by the cron.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
--   1. private.log_mutation() takes two OPTIONAL trigger arguments:
--        TG_ARGV[0]  the key column for target_resource (default 'id');
--        TG_ARGV[1]  an actor column, read ONLY when auth.uid() is NULL, the
--                    statement is a service-role API call (the PostgREST
--                    JWT role claim, or the SET ROLE, is service_role) and
--                    the operation is INSERT or UPDATE. A migration, the SQL
--                    editor or the Supabase MCP (postgres, no claim) never
--                    borrows it, so a backfill is never credited to whoever
--                    saved last; a DELETE (the org cascade) has no actor.
--                    A value that is not a uuid is ignored, never an error.
--      With no arguments (the six existing triggers) the function behaves
--      exactly as before: target `<table>/<id>`, actor auth.uid(). The body
--      is otherwise mig 647/655's, verbatim: the same skip list, diff,
--      redaction, best-effort failure path. CREATE OR REPLACE keeps its
--      owner and EXECUTE ACL.
--   2. CREATE TRIGGER audit_mutation AFTER INSERT OR UPDATE OR DELETE ON
--      org_settings ... EXECUTE FUNCTION
--      private.log_mutation('organization_id', 'updated_by').
--      Rows read 'org_settings/<organization_id>', category 'mutation',
--      action org_settings.created|updated|deleted, location_id NULL (as
--      organizations rows: the /api/admin/audit-log route shows them to
--      masters only). No org_settings column matches audit_is_secret_key, so
--      values are kept: that is the point (the cap before and after, which
--      address alerts now go to). customer_agent is walked by the same
--      key-name redaction as every jsonb column.
--   The usage-rollup cron's notice-month write sets updated_by = NULL in the
--   same PR, so its change is recorded with no actor instead of the last
--   admin's.
--
-- Guards: tests/audit-secret-keys-guard.test.js (org_settings joins
-- AUDITED_TABLES, so a later secret-looking column on it must match the
-- redaction rule); this file's self-check.
--
-- APPLY: before the code (the cron's updated_by change is harmless either
-- way: until it deploys, a notice-month row credits the last admin).
-- Rollback: DROP TRIGGER audit_mutation ON public.org_settings, then mig
-- 647/655's log_mutation body (the test's ROLLBACK_733).
-- ===========================================================================

BEGIN;

-- CREATE TRIGGER takes SHARE ROW EXCLUSIVE on org_settings, read by every
-- branded email and page. Abort after 5 s rather than queue. Nothing is
-- half-applied: re-run.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION private.log_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  -- Columns ignored when diffing an UPDATE: bookkeeping churn that isn't
  -- worth an audit row on its own (unchanged from mig 191).
  v_skip    text[] := array['updated_at', 'unifi_synced_at'];
  -- 731: optional trigger arguments. [0] the key column for target_resource
  -- (default 'id'); [1] an actor column, read only for a service-role API
  -- write with no auth.uid() (see mig 731's header).
  v_key       text := coalesce(nullif(tg_argv[0], ''), 'id');
  v_actor_col text := nullif(tg_argv[1], '');
  v_actor     uuid;
  v_idrow   jsonb;
  v_old     jsonb;
  v_new     jsonb;
  v_before  jsonb;
  v_after   jsonb;
  v_changed text[];
  v_verb    text := case tg_op when 'INSERT' then 'created' when 'DELETE' then 'deleted' else 'updated' end;
  v_details jsonb;
  v_target  text;
  v_loc     uuid;
  v_state   text;
  v_state2  text;
begin
  -- 731: who. auth.uid() first, as before; the actor column only for a
  -- service-role API write. A bad value or an unreadable claim leaves NULL.
  v_actor := auth.uid();
  if v_actor is null and v_actor_col is not null and tg_op <> 'DELETE' then
    begin
      if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
         or coalesce(current_setting('role', true), '') = 'service_role' then
        v_actor := nullif(to_jsonb(NEW) ->> v_actor_col, '')::uuid;
      end if;
    exception when others then
      v_actor := null;
    end;
  end if;

  begin
    -- Who / what / where first: the failure path below reuses them.
    if (tg_op = 'DELETE') then
      v_idrow := to_jsonb(OLD);
    else
      v_idrow := to_jsonb(NEW);
    end if;
    v_target := tg_table_name || '/' || coalesce(v_idrow ->> v_key, '?');
    v_loc    := nullif(v_idrow ->> 'location_id', '')::uuid;

    if (tg_op = 'INSERT') then
      v_details := jsonb_build_object('after', private.audit_redact(v_idrow));

    elsif (tg_op = 'DELETE') then
      v_details := jsonb_build_object('before', private.audit_redact(v_idrow));

    else  -- UPDATE: diff the RAW rows, store only redacted copies.
      v_old   := to_jsonb(OLD);
      v_new   := v_idrow;
      select jsonb_object_agg(k, v_old -> k), jsonb_object_agg(k, v_new -> k)
        into v_before, v_after
      from jsonb_object_keys(v_new) as k
      where not (k = any (v_skip))
        and (v_old -> k) is distinct from (v_new -> k);
      if v_after is null then
        return null;  -- nothing meaningful changed: don't log
      end if;
      select coalesce(array_agg(coalesce(o.path, n.path)), '{}')
        into v_changed
      from private.audit_secret_paths(v_before) as o
      full join private.audit_secret_paths(v_after) as n on n.path = o.path
      where o.val is distinct from n.val;
      v_details := jsonb_build_object(
        'before', private.audit_redact(v_before),
        'after',  private.audit_redact(v_after,  v_changed));
    end if;

    insert into public.audit_events
      (category, action, actor_id, target_resource, location_id, details)
    values (
      'mutation',
      tg_table_name || '.' || v_verb,
      v_actor,
      v_target,
      v_loc,
      v_details
    );
  exception when others then
    -- Best-effort: an audit failure must never break the mutation, and a
    -- redaction failure must never store an unredacted copy. So the row is
    -- still written, with who / what / when / target and the SQLSTATE, and
    -- NO values. If that insert fails too, the write still goes through.
    -- The warnings name the operation, the target id and SQLSTATEs only
    -- (never SQLERRM, which can quote a value).
    v_state := sqlstate;
    begin
      insert into public.audit_events
        (category, action, actor_id, target_resource, location_id, details)
      values (
        'mutation',
        tg_table_name || '.' || v_verb,
        v_actor,
        coalesce(v_target, tg_table_name || '/?'),
        v_loc,
        jsonb_build_object('audit_redaction_failed', v_state)
      );
      raise warning 'log_mutation: audit details dropped for % % (%)',
        tg_op, coalesce(v_target, tg_table_name || '/?'), v_state;
    exception when others then
      v_state2 := sqlstate;
      raise warning 'log_mutation: audit row skipped for % % (% then %)',
        tg_op, coalesce(v_target, tg_table_name || '/?'), v_state, v_state2;
    end;
  end;

  return null;  -- AFTER ROW trigger: return value is ignored
end;
$function$;

DROP TRIGGER IF EXISTS audit_mutation ON public.org_settings;
CREATE TRIGGER audit_mutation
  AFTER INSERT OR UPDATE OR DELETE ON public.org_settings
  FOR EACH ROW
  EXECUTE FUNCTION private.log_mutation('organization_id', 'updated_by');

-- ---------------------------------------------------------------------------
-- Self-check: the catalog, never this file's text. Any failure raises and
-- the whole file rolls back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_fn constant regprocedure := 'private.log_mutation()'::regprocedure;
  v_tables text;
  v_bad text;
BEGIN
  -- 1. The function kept its posture: DEFINER, pinned search_path, owner
  --    postgres, and no EXECUTE for anon or PUBLIC (mig 678).
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_fn) THEN
    RAISE EXCEPTION 'mig 733: private.log_mutation() is no longer SECURITY DEFINER';
  END IF;
  IF NOT coalesce((SELECT proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid = v_fn), false) THEN
    RAISE EXCEPTION 'mig 733: private.log_mutation() lost its empty search_path';
  END IF;
  IF (SELECT proowner::regrole::text FROM pg_proc WHERE oid = v_fn) <> 'postgres' THEN
    RAISE EXCEPTION 'mig 733: private.log_mutation() is not owned by postgres';
  END IF;
  IF has_function_privilege('anon', v_fn, 'EXECUTE') OR has_function_privilege('public', v_fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'mig 733: anon or PUBLIC can execute private.log_mutation()';
  END IF;

  -- 2. It runs on exactly the six tables of mig 191, with no arguments, plus
  --    org_settings with this file's two.
  SELECT string_agg(c.relname || '(' || t.tgnargs::text || ')', ', ' ORDER BY c.relname)
    INTO v_tables
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE t.tgfoid = v_fn AND NOT t.tgisinternal;
  IF v_tables IS DISTINCT FROM
     'cars(0), invoices_queue(0), locations(0), org_settings(2), organizations(0), profile_locations(0), profiles(0)' THEN
    RAISE EXCEPTION 'mig 733: private.log_mutation() runs on %, expected the six of mig 191 plus org_settings(2)', v_tables;
  END IF;

  -- 3. Every one is the same trigger shape: AFTER, FOR EACH ROW, INSERT +
  --    UPDATE + DELETE (tgtype 29), enabled.
  SELECT string_agg(c.relname || ' type=' || t.tgtype::text || ' enabled=' || t.tgenabled::text, ', ')
    INTO v_bad
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE t.tgfoid = v_fn AND NOT t.tgisinternal AND (t.tgtype <> 29 OR t.tgenabled = 'D');
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'mig 733: log_mutation trigger of the wrong shape or disabled: %', v_bad;
  END IF;

  -- 4. org_settings' arguments are its key and its actor column, and both
  --    columns exist.
  IF (SELECT encode(tgargs, 'escape') FROM pg_trigger
       WHERE tgrelid = 'public.org_settings'::regclass AND tgname = 'audit_mutation')
     IS DISTINCT FROM E'organization_id\\000updated_by\\000' THEN
    RAISE EXCEPTION 'mig 733: org_settings.audit_mutation does not pass (organization_id, updated_by)';
  END IF;
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid = 'public.org_settings'::regclass
       AND attname IN ('organization_id', 'updated_by') AND NOT attisdropped) <> 2 THEN
    RAISE EXCEPTION 'mig 733: org_settings is missing organization_id or updated_by';
  END IF;

  RAISE NOTICE 'mig 733: org_settings is audited (audit_mutation, keyed on organization_id, actor from updated_by on service-role writes).';
END $$;

COMMIT;
