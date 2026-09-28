-- 647 — AUDITSECRETS.1: the mutation audit trigger stops copying credentials
-- into audit_events.
--
-- NOT APPLIED YET when this file was written. "VERIFIED LIVE" below is the
-- state of prod BEFORE this file runs (read-only, Supabase MCP, 28 Sep 2026);
-- it is the evidence for the fix, not proof the fix landed. Behaviour is
-- proven ahead of apply by a PGlite replay
-- (tests/migration-647-audit-redact-secrets.test.js).
--
-- ===========================================================================
-- THE FINDING
-- ===========================================================================
-- private.log_mutation() (mig 191, the `audit_mutation` AFTER-row trigger on
-- cars, invoices_queue, locations, organizations, profile_locations and
-- profiles) writes the changed columns' before/after into
-- audit_events.details. Its deny list names four TOP-LEVEL columns only
-- (sensibo_api_key, deposit_token, deposit_revolut_checkout_url, bca_config).
-- It never looks inside a jsonb column, and it misses two secret columns:
--   locations.settings        the WHOLE object on every settings change:
--                             glofox.api_key / api_token / webhook_secret,
--                             unifi.api_token
--   locations.thinq_pat       an LG ThinQ personal access token
--   profiles.pin_hash         a salted scrypt hash of a 4-digit studio PIN
--                             (10,000 guesses: minutes offline). The column
--                             itself is hidden from browsers (mig 153b); the
--                             audit copy is not.
--
-- VERIFIED LIVE (28 Sep, BEFORE this migration; key presence and equality
-- only, never a value): 38 audit rows hold a non-blank secret (35 locations
-- rows, 28 May to 31 Jul; 3 profiles rows). By key: settings.glofox.api_key
-- 34, .api_token 32, .webhook_secret 32, settings.unifi.api_token 32,
-- thinq_pat 1, pin_hash 3. They are the CURRENT values, not old ones: 32 rows
-- hold the live Glofox key, token and webhook secret and the live UniFi
-- token, 1 the live ThinQ PAT, and 1 a current PIN hash. No non-mutation
-- audit row carries a secret-named key.
-- Readers: the service-role /api/admin/audit-log route (master sees every
-- row; an owner only rows whose location_id is theirs, and locations/profiles
-- rows have location_id NULL, so owners never see these through the route),
-- the master-only /settings/audit-log page (renders details as raw JSON, and
-- the CSV export writes it verbatim), and the `audit_events_select_master_owner`
-- RLS policy, which lets any active master/owner profile read EVERY row
-- directly through PostgREST, across organisations (no browser code does).
--
-- ===========================================================================
-- THE FIX
-- ===========================================================================
-- Redact by KEY NAME, at every depth, in every audited table:
--   private.audit_is_secret_key(key)   the one rule (below)
--   private.audit_redact(doc, changed, prefix)
--                                      copies a jsonb value, replacing each
--                                      secret-named key's value with
--                                      "[redacted]" ("[redacted: changed]"
--                                      when its dotted path is in `changed`;
--                                      the trigger passes it for the AFTER
--                                      image only). A JSON
--                                      null or "" is kept as is, so "was
--                                      cleared" / "was never set" stay visible.
--   private.audit_secret_paths(doc, prefix)
--                                      every secret leaf as (path, value), so
--                                      the trigger can say WHICH secret
--                                      changed without storing it.
-- log_mutation() diffs the RAW rows (so a pure credential rotation is still
-- an audit row, showing "[redacted]" -> "[redacted: changed]"), then stores
-- only redacted copies. The four mig-191 deny columns are now masked instead
-- of dropped: a change to one of them alone used to log nothing, and now
-- logs who changed it (never the value).
-- All of it runs inside the existing best-effort block: a redaction error
-- skips the audit row (with a WARNING in the Postgres log, no values), it
-- never aborts the real write and never falls back to an unredacted copy.
--
-- The rule (case-insensitive, whole key name):
--   ends in (^|_) + api_key | apikey | token | secret | password | passwd |
--     passcode | pat | ciphertext | credential(s) | private_key | signing_key |
--     encryption_key | secret_key | access_key | auth_key | key_hash |
--     token_hash | pin_hash
--   or is exactly deposit_revolut_checkout_url | bca_config (mig 191's
--     explicit entries; a bearer URL and a whole config blob)
-- Checked against every key in audit_events.details and every column of the
-- six audited tables on prod (28 Sep): it matches exactly api_key, api_token,
-- webhook_secret, deposit_token, deposit_revolut_checkout_url,
-- sensibo_api_key, thinq_pat, pin_hash (+ bca_config), and none of
-- deposit_token_expires_at, content_hash, password_changed, pin_set_at,
-- pin_failed_count, pin_locked_until, *_url, *_path.
--
-- NOT IN THIS FILE: the 38 existing rows keep their secrets until Richard
-- runs the held scrub (plan C27 Appendix A). Nothing else changes: no table,
-- policy, grant or trigger attachment.
--
-- Apply AFTER the PR merges (no app code depends on it), the same day.
-- Rollback: re-run mig 191's function body (plan C27 Task 5 Step 6).

set check_function_bodies = off;

create or replace function private.audit_is_secret_key(p_key text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_key is not null and (
    lower(p_key) in ('deposit_revolut_checkout_url', 'bca_config')
    or lower(p_key) ~ '(^|_)(api_?key|token|secret|password|passwd|passcode|pat|ciphertext|credentials?|(private|signing|encryption|secret|access|auth)_?key|(key|token|pin)_hash)$'
  )
$$;

comment on function private.audit_is_secret_key(text) is
  'AUDITSECRETS.1 (mig 647) — true when a jsonb key / column name holds a credential; private.audit_redact masks its value in audit_events.details.';

create or replace function private.audit_redact(
  p_doc jsonb,
  p_changed text[] default '{}',
  p_prefix text default ''
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_out jsonb;
begin
  if jsonb_typeof(p_doc) = 'object' then
    select coalesce(jsonb_object_agg(e.key,
             case
               when private.audit_is_secret_key(e.key) then
                 case
                   when e.value = 'null'::jsonb or e.value = '""'::jsonb then e.value
                   when (p_prefix || e.key) = any (p_changed) then to_jsonb('[redacted: changed]'::text)
                   else to_jsonb('[redacted]'::text)
                 end
               else private.audit_redact(e.value, p_changed, p_prefix || e.key || '.')
             end), '{}'::jsonb)
      into v_out
      from jsonb_each(p_doc) as e;
    return v_out;
  elsif jsonb_typeof(p_doc) = 'array' then
    select coalesce(jsonb_agg(private.audit_redact(a.value, p_changed, p_prefix || (a.ord - 1)::text || '.')
                              order by a.ord), '[]'::jsonb)
      into v_out
      from jsonb_array_elements(p_doc) with ordinality as a(value, ord);
    return v_out;
  end if;
  return p_doc;
end;
$$;

comment on function private.audit_redact(jsonb, text[], text) is
  'AUDITSECRETS.1 (mig 647) — copy of a jsonb value with every secret-named key (private.audit_is_secret_key) masked "[redacted]", or "[redacted: changed]" when its dotted path is in p_changed. JSON null and "" are kept.';

create or replace function private.audit_secret_paths(p_doc jsonb, p_prefix text default '')
returns table (path text, val jsonb)
language plpgsql
immutable
set search_path = ''
as $$
declare
  r record;
begin
  if jsonb_typeof(p_doc) = 'object' then
    for r in select e.key, e.value from jsonb_each(p_doc) as e loop
      if private.audit_is_secret_key(r.key) then
        path := p_prefix || r.key;
        val := r.value;
        return next;
      elsif jsonb_typeof(r.value) in ('object', 'array') then
        return query select s.path, s.val from private.audit_secret_paths(r.value, p_prefix || r.key || '.') as s;
      end if;
    end loop;
  elsif jsonb_typeof(p_doc) = 'array' then
    for r in select a.value, a.ord from jsonb_array_elements(p_doc) with ordinality as a(value, ord) loop
      if jsonb_typeof(r.value) in ('object', 'array') then
        return query select s.path, s.val from private.audit_secret_paths(r.value, p_prefix || (r.ord - 1)::text || '.') as s;
      end if;
    end loop;
  end if;
  return;
end;
$$;

comment on function private.audit_secret_paths(jsonb, text) is
  'AUDITSECRETS.1 (mig 647) — every secret-named leaf of a jsonb value as (dotted path, value). Used by log_mutation to mark which secret changed; never stored.';

-- Pure helpers for the trigger only. `authenticated` holds USAGE on the
-- private schema, so shut the default PUBLIC EXECUTE.
revoke all on function private.audit_is_secret_key(text) from public, anon, authenticated;
revoke all on function private.audit_redact(jsonb, text[], text) from public, anon, authenticated;
revoke all on function private.audit_secret_paths(jsonb, text) from public, anon, authenticated;

create or replace function private.log_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Columns ignored when diffing an UPDATE: bookkeeping churn that isn't
  -- worth an audit row on its own (unchanged from mig 191).
  v_skip    text[] := array['updated_at', 'unifi_synced_at'];
  v_idrow   jsonb;
  v_old     jsonb;
  v_new     jsonb;
  v_before  jsonb;
  v_after   jsonb;
  v_changed text[];
  v_verb    text;
  v_details jsonb;
begin
  begin
    if (tg_op = 'INSERT') then
      v_idrow := to_jsonb(NEW);
      v_verb  := 'created';
      v_details := jsonb_build_object('after', private.audit_redact(v_idrow));

    elsif (tg_op = 'DELETE') then
      v_idrow := to_jsonb(OLD);
      v_verb  := 'deleted';
      v_details := jsonb_build_object('before', private.audit_redact(v_idrow));

    else  -- UPDATE: diff the RAW rows, store only redacted copies.
      v_old   := to_jsonb(OLD);
      v_new   := to_jsonb(NEW);
      v_idrow := v_new;
      v_verb  := 'updated';
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
      auth.uid(),
      tg_table_name || '/' || coalesce(v_idrow ->> 'id', '?'),
      nullif(v_idrow ->> 'location_id', '')::uuid,
      v_details
    );
  exception when others then
    -- Best-effort: an audit failure must never break the mutation, and a
    -- redaction failure must never store an unredacted copy. The warning
    -- names the table and SQLSTATE only (no values).
    raise warning 'log_mutation: audit row skipped for % (%)', tg_table_name, sqlstate;
  end;

  return null;  -- AFTER ROW trigger: return value is ignored
end;
$$;

comment on function private.log_mutation() is
  'AUDIT-EXPAND.2 (mig 191), AUDITSECRETS.1 (mig 647) — generic AFTER-row trigger: writes a category=mutation audit_events row for INSERT/UPDATE/DELETE; every secret-named key, at any depth, is stored as "[redacted]" / "[redacted: changed]".';

-- ── Self-check: the catalog and the behaviour, never the file ───────────
do $$
declare
  v_tables text[];
  v_got    jsonb;
  v_want   jsonb;
  v_fn     text;
begin
  -- 1. the trigger is still on exactly the six mig-191 tables, enabled
  select array_agg(c.relname::text order by c.relname)
    into v_tables
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where t.tgname = 'audit_mutation' and not t.tgisinternal and n.nspname = 'public'
    and t.tgenabled = 'O'
    and t.tgfoid = 'private.log_mutation()'::regprocedure;
  if v_tables is distinct from array['cars','invoices_queue','locations','organizations','profile_locations','profiles'] then
    raise exception 'AUDITSECRETS.1: audit_mutation is attached to % (expected the six mig-191 tables)', v_tables;
  end if;

  -- 2. log_mutation is still SECURITY DEFINER with an empty search_path
  if not exists (
    select 1 from pg_proc
    where oid = 'private.log_mutation()'::regprocedure
      and prosecdef
      and proconfig @> array['search_path=""']
  ) then
    raise exception 'AUDITSECRETS.1: private.log_mutation() lost SECURITY DEFINER or its empty search_path';
  end if;

  -- 3. the helpers are not callable from a browser or phone session
  foreach v_fn in array array[
    'private.audit_is_secret_key(text)',
    'private.audit_redact(jsonb,text[],text)',
    'private.audit_secret_paths(jsonb,text)'
  ] loop
    if has_function_privilege('authenticated', v_fn, 'EXECUTE')
       or has_function_privilege('anon', v_fn, 'EXECUTE') then
      raise exception 'AUDITSECRETS.1: % is executable by a client role', v_fn;
    end if;
  end loop;

  -- 4. the redaction does what this file says, on a fixture with every
  --    shape seen on prod (fictional values)
  v_got := private.audit_redact(
    '{"id":"x","thinq_pat":"p","pin_hash":"h","sensibo_api_key":null,
      "deposit_token":"","deposit_token_expires_at":"2026-01-01","content_hash":"c",
      "settings":{"glofox":{"api_key":"k","api_token":"t","webhook_secret":"w","branch_id":"b"},
                  "unifi":{"api_token":"u","host":"10.0.0.1"},
                  "wa_card_sets":[{"label":"l","access_token":"a"}]}}'::jsonb,
    array['settings.glofox.api_key']);
  v_want :=
    '{"id":"x","thinq_pat":"[redacted]","pin_hash":"[redacted]","sensibo_api_key":null,
      "deposit_token":"","deposit_token_expires_at":"2026-01-01","content_hash":"c",
      "settings":{"glofox":{"api_key":"[redacted: changed]","api_token":"[redacted]","webhook_secret":"[redacted]","branch_id":"b"},
                  "unifi":{"api_token":"[redacted]","host":"10.0.0.1"},
                  "wa_card_sets":[{"label":"l","access_token":"[redacted]"}]}}'::jsonb;
  if v_got is distinct from v_want then
    raise exception 'AUDITSECRETS.1: audit_redact returned % (expected %)', v_got, v_want;
  end if;

  if (select count(*) from private.audit_secret_paths(v_want)) <> 9 then
    raise exception 'AUDITSECRETS.1: audit_secret_paths found % secret leaves in the fixture (expected 9)',
      (select count(*) from private.audit_secret_paths(v_want));
  end if;
end;
$$;
