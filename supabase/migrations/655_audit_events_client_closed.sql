-- 655 — AUDITRLS.1: audit_events is closed to every client session, and the
-- mutation audit trigger stops copying staff test phone numbers.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 28-29 Sep
-- 2026). Behaviour is proven ahead of apply by a PGlite replay
-- (tests/migration-655-audit-events-client-closed.test.js).
--
-- ===========================================================================
-- THE FINDING
-- ===========================================================================
-- audit_events carries Supabase's default grants (anon + authenticated
-- arwdDxtm) and ONE policy, audit_events_select_master_owner (mig 180 →
-- 204 → 626): FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM
-- profiles p WHERE p.id = auth.uid() AND p.role IN ('master','owner') AND
-- auth_is_active_staff())). It has no location or organisation term: it
-- would give every active owner every organisation's audit log (4,164 rows:
-- auth events, business events, every mutation's before/after).
-- VERIFIED LIVE: it does not work today, by accident. The EXISTS runs as the
-- caller, and authenticated holds no SELECT on profiles (mig 153b), so every
-- client read of audit_events errors 42501 on profiles (probe: an active
-- owner's JWT, rolled back). Grant any profiles column and it opens.
-- No client reads the table: un1t-crm's readers are the service-role
-- /api/admin/audit-log route and src/lib/audit.js; champ-app, un1t-platform
-- and champ-bridge never name it. The audit trigger function is SECURITY
-- DEFINER (owner postgres); tombstone_staff_profile is service-role only.
-- Not in realtime; no view; no other policy reads it.
--
-- Also: locations.settings.customer_agent.test_phones (staff test phone
-- numbers; personal data, not a credential, so mig 647 left it) is copied
-- into every locations.* audit row on a settings change: 32 rows today
-- (last 31 Jul; none since 647). Forward only: the 32 are the rows Richard
-- declined to scrub on 28 Sep (C27).
--
-- VERIFIED LIVE (29 Sep, pg_get_functiondef only): prod's audit_redact,
-- audit_secret_paths, audit_is_secret_key and log_mutation bodies are
-- byte-identical to mig 647's file, so the two walkers below are 647's
-- bodies with only the marked lines changed.
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
-- 1. Drop the policy, REVOKE ALL from anon + authenticated. RLS stays on with
--    no policy, so a client that regained a grant would still read 0 rows.
--    service_role keeps its grants; the trigger writes as its owner.
-- 2. private.audit_is_pii_key(key): an exact-name list (today test_phones),
--    pinned to src/lib/secret-keys.js AUDIT_PII_KEY_EXACT. Not callable by
--    clients.
-- 3. private.audit_redact / private.audit_secret_paths: mig 647's bodies,
--    with the one predicate widened to "secret OR pii". A PII value is
--    stored "[redacted]" ("[redacted: changed]" when it changed); null, ""
--    and [] are kept ("none set" stays visible). The [] rule is PII-only:
--    credential handling is byte-identical to 647. Signatures are unchanged,
--    so 647's REVOKEs on them stand.
-- Nothing else changes: log_mutation, its attachments, its SECURITY DEFINER
-- and its empty search_path are untouched (the self-check proves it).
--
-- Apply AFTER the PR merges (no code depends on it), the same day.
-- Rollback: plan C34 Task 5 Step 6 (a new migration).

BEGIN;

-- audit_events is written by every audited table's writes: never queue
-- behind a long lock on it, fail the apply instead.
SET LOCAL lock_timeout = '5s';
SET LOCAL check_function_bodies = off;

-- ── 1. the client door ──────────────────────────────────────────────────
DROP POLICY IF EXISTS audit_events_select_master_owner ON public.audit_events;
REVOKE ALL ON public.audit_events FROM anon, authenticated;

COMMENT ON TABLE public.audit_events IS
  'Unified audit log (mig 180). Service role only (AUDITRLS.1, mig 655): no client grant, RLS on with no policy. Read it through /api/admin/audit-log, which scopes owners to the locations they own.';

-- ── 2. the PII list ─────────────────────────────────────────────────────
create or replace function private.audit_is_pii_key(p_key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_key is not null and lower(p_key) in ('test_phones')
$$;

comment on function private.audit_is_pii_key(text) is
  'AUDITRLS.1 (mig 655) — true when a jsonb key holds personal data the audit trigger masks (exact names; mirrored by src/lib/secret-keys.js AUDIT_PII_KEY_EXACT).';

revoke all on function private.audit_is_pii_key(text) from public, anon, authenticated;

-- ── 3. the walkers (mig 647 bodies; changed lines marked -- 655) ─────────
create or replace function private.audit_redact(
  p_doc jsonb,
  p_changed text[] default '{}',
  p_prefix text default '',
  p_depth integer default 0
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_max_depth constant integer := 12;
  v_out jsonb;
begin
  if jsonb_typeof(p_doc) in ('object', 'array') and p_depth >= c_max_depth then
    return to_jsonb('[redacted: too deep]'::text);
  elsif jsonb_typeof(p_doc) = 'object' then
    select coalesce(jsonb_object_agg(e.key,
             case
               when private.audit_is_secret_key(e.key) or private.audit_is_pii_key(e.key) then  -- 655
                 case
                   when e.value = 'null'::jsonb or e.value = '""'::jsonb then e.value
                   when private.audit_is_pii_key(e.key) and e.value = '[]'::jsonb then e.value  -- 655
                   when (p_prefix || e.key) = any (p_changed) then to_jsonb('[redacted: changed]'::text)
                   else to_jsonb('[redacted]'::text)
                 end
               else private.audit_redact(e.value, p_changed, p_prefix || e.key || '.', p_depth + 1)
             end), '{}'::jsonb)
      into v_out
      from jsonb_each(p_doc) as e;
    return v_out;
  elsif jsonb_typeof(p_doc) = 'array' then
    select coalesce(jsonb_agg(private.audit_redact(a.value, p_changed, p_prefix || (a.ord - 1)::text || '.', p_depth + 1)
                              order by a.ord), '[]'::jsonb)
      into v_out
      from jsonb_array_elements(p_doc) with ordinality as a(value, ord);
    return v_out;
  end if;
  return p_doc;
end;
$$;

comment on function private.audit_redact(jsonb, text[], text, integer) is
  'AUDITSECRETS.1 (mig 647), AUDITRLS.1 (mig 655) — copy of a jsonb value with every secret-named key (private.audit_is_secret_key) or PII key (private.audit_is_pii_key) masked "[redacted]", or "[redacted: changed]" when its dotted path is in p_changed. JSON null and "" are kept (and [] for a PII key). An object/array at depth 12 or deeper becomes "[redacted: too deep]".';

create or replace function private.audit_secret_paths(
  p_doc jsonb,
  p_prefix text default '',
  p_depth integer default 0
)
returns table (path text, val jsonb)
language plpgsql
immutable
set search_path = ''
as $$
declare
  c_max_depth constant integer := 12;  -- the same cap as audit_redact
  r record;
begin
  if jsonb_typeof(p_doc) = 'object' then
    for r in select e.key, e.value from jsonb_each(p_doc) as e loop
      if private.audit_is_secret_key(r.key) or private.audit_is_pii_key(r.key) then  -- 655
        path := p_prefix || r.key;
        val := r.value;
        return next;
      elsif jsonb_typeof(r.value) in ('object', 'array') and p_depth + 1 >= c_max_depth then
        -- Too deep to look inside: report the subtree whole, as a
        -- possible secret (audit_redact masks it "[redacted: too deep]").
        path := p_prefix || r.key;
        val := r.value;
        return next;
      elsif jsonb_typeof(r.value) in ('object', 'array') then
        return query select s.path, s.val
          from private.audit_secret_paths(r.value, p_prefix || r.key || '.', p_depth + 1) as s;
      end if;
    end loop;
  elsif jsonb_typeof(p_doc) = 'array' then
    for r in select a.value, a.ord from jsonb_array_elements(p_doc) with ordinality as a(value, ord) loop
      if jsonb_typeof(r.value) in ('object', 'array') and p_depth + 1 >= c_max_depth then
        path := p_prefix || (r.ord - 1)::text;
        val := r.value;
        return next;
      elsif jsonb_typeof(r.value) in ('object', 'array') then
        return query select s.path, s.val
          from private.audit_secret_paths(r.value, p_prefix || (r.ord - 1)::text || '.', p_depth + 1) as s;
      end if;
    end loop;
  end if;
  return;
end;
$$;

comment on function private.audit_secret_paths(jsonb, text, integer) is
  'AUDITSECRETS.1 (mig 647), AUDITRLS.1 (mig 655) — every secret-named or PII leaf of a jsonb value as (dotted path, value); a subtree at depth 12 or deeper is reported whole. Used by the audit trigger to mark which masked value changed; never stored.';

-- ── Self-check: the catalog and the behaviour, never the file ───────────
do $$
declare
  v_fn     text;
  v_owner  text;
  v_role   text;
  v_priv   text;
  v_got    jsonb;
  v_want   jsonb;
  v_tables text[];
begin
  -- 1. no policy of any kind left on audit_events (a stray one means someone
  --    else is using the table from a client: stop and look)
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'audit_events') then
    raise exception 'AUDITRLS.1: public.audit_events still has a policy: %',
      (select string_agg(policyname, ', ' order by policyname) from pg_policies where schemaname = 'public' and tablename = 'audit_events');
  end if;

  -- 2. RLS still enabled
  if not (select relrowsecurity from pg_class where oid = 'public.audit_events'::regclass) then
    raise exception 'AUDITRLS.1: RLS is not enabled on public.audit_events';
  end if;

  -- 3. no client privilege, table or column, inheritance-aware: one
  --    has_table_privilege call per (role, privilege)
  foreach v_role in array array['anon', 'authenticated'] loop
    foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'] loop
      if has_table_privilege(v_role, 'public.audit_events', v_priv) then
        raise exception 'AUDITRLS.1: % still holds % on public.audit_events', v_role, v_priv;
      end if;
    end loop;
    foreach v_priv in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
      if has_any_column_privilege(v_role, 'public.audit_events', v_priv) then
        raise exception 'AUDITRLS.1: % still holds a column % on public.audit_events', v_role, v_priv;
      end if;
    end loop;
  end loop;

  -- 4. the service role still reads and writes
  if not (has_table_privilege('service_role', 'public.audit_events', 'SELECT')
          and has_table_privilege('service_role', 'public.audit_events', 'INSERT')) then
    raise exception 'AUDITRLS.1: service_role lost SELECT/INSERT on public.audit_events';
  end if;

  -- 5. the audit trigger function still runs on the six mig-191 tables,
  --    enabled, and is still SECURITY DEFINER with an empty search_path
  --    (with no client grant it must write as its owner)
  select array_agg(n.nspname || '.' || c.relname || ':' || t.tgenabled::text order by n.nspname, c.relname)
    into v_tables
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal
    and t.tgfoid = 'private.log_mutation()'::regprocedure;
  if v_tables is distinct from array['public.cars:O','public.invoices_queue:O','public.locations:O',
                                     'public.organizations:O','public.profile_locations:O','public.profiles:O'] then
    raise exception 'AUDITRLS.1: the audit trigger runs on % (expected the six mig-191 tables, enabled)', v_tables;
  end if;
  if not exists (
    select 1 from pg_proc
    where oid = 'private.log_mutation()'::regprocedure
      and prosecdef
      and proconfig @> array['search_path=""']
  ) then
    raise exception 'AUDITRLS.1: the audit trigger function lost SECURITY DEFINER or its empty search_path; with no client grant it could not write';
  end if;

  -- 6. no helper callable by a client, and every helper callable by the
  --    audit trigger's OWNER (the walkers run as that role: if it could not
  --    execute one, every audit row would silently become
  --    audit_redaction_failed, and a check run as the applying role would
  --    not notice).
  select proowner::regrole::text into v_owner from pg_proc where oid = 'private.log_mutation()'::regprocedure;
  foreach v_fn in array array[
    'private.audit_is_pii_key(text)',
    'private.audit_is_secret_key(text)',
    'private.audit_redact(jsonb,text[],text,integer)',
    'private.audit_secret_paths(jsonb,text,integer)'
  ] loop
    if has_function_privilege('authenticated', v_fn, 'EXECUTE')
       or has_function_privilege('anon', v_fn, 'EXECUTE') then
      raise exception 'AUDITRLS.1: % is executable by a client role', v_fn;
    end if;
    if not has_function_privilege(v_owner, v_fn, 'EXECUTE') then
      raise exception 'AUDITRLS.1: the audit trigger''s owner (%) cannot execute %', v_owner, v_fn;
    end if;
  end loop;

  -- 7. behaviour: PII masked + marked, [] kept for PII only, secrets as 647
  v_got := private.audit_redact(
    '{"settings":{"customer_agent":{"enabled":true,"test_phones":["x"]},
                  "glofox":{"api_key":"k","branch_id":"b"}},
      "other":{"test_phones":[]},"tokens":[]}'::jsonb,
    array['settings.customer_agent.test_phones']);
  v_want :=
    '{"settings":{"customer_agent":{"enabled":true,"test_phones":"[redacted: changed]"},
                  "glofox":{"api_key":"[redacted]","branch_id":"b"}},
      "other":{"test_phones":[]},"tokens":"[redacted]"}'::jsonb;
  if v_got is distinct from v_want then
    raise exception 'AUDITRLS.1: audit_redact returned % (expected %)', v_got, v_want;
  end if;
  if (select count(*) from private.audit_secret_paths(v_want)) <> 4 then
    raise exception 'AUDITRLS.1: audit_secret_paths found % masked leaves in the fixture (expected 4)',
      (select count(*) from private.audit_secret_paths(v_want));
  end if;
end;
$$;

COMMIT;
