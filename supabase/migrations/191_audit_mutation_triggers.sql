-- AUDIT-EXPAND.2 — DB-trigger mutation auditing.
--
-- AUDIT-EXPAND.1 (mig 180) built the unified audit_events table and
-- reserved the 'mutation' category for trigger-based, per-table
-- auditing — the safety net that records row changes even when a
-- change bypasses the app-level logAuditEvent helper (a direct DB
-- edit, a script, or a code path that was never instrumented).
--
-- WHAT THIS MIGRATION ADDS
-- ───────────────────────
--   1. private.log_mutation() — one generic AFTER-row trigger
--      function that writes a category='mutation' audit_events row.
--   2. An `audit_mutation` trigger on each key business table.
--
-- ROW SHAPE PRODUCED
--   - category        'mutation'
--   - action          '<table>.created' | '.updated' | '.deleted'
--   - actor_id        auth.uid() — NULL for service-role / cron writes
--   - target_resource '<table>/<row id>'
--   - location_id     read generically from the row when it has one
--   - details:
--       INSERT → { after:  <full row> }
--       DELETE → { before: <full row> }
--       UPDATE → { before: <changed cols, old>, after: <changed cols, new> }
--     The { before, after } shape renders straight into the existing
--     Before/After panels on /admin/audit-log.
--
-- DESIGN NOTES
--   - A no-op UPDATE (only updated_at / unifi_synced_at moved, or
--     nothing changed) is not logged.
--   - Credential-bearing columns are redacted from every payload.
--   - The audit_events INSERT is wrapped in an exception block:
--     auditing is best-effort and must never abort the real
--     mutation (same philosophy as the logAuditEvent helper).
--   - SECURITY DEFINER so the function — owned by the migration
--     role — can insert into audit_events, which is otherwise
--     service-role write only (mig 180 RLS).

set check_function_bodies = off;

create or replace function private.log_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Columns never copied into the audit payload (tokens / API keys).
  v_deny  text[] := array['sensibo_api_key', 'deposit_token',
                          'deposit_revolut_checkout_url', 'bca_config'];
  -- Columns ignored when diffing an UPDATE — bookkeeping churn that
  -- isn't worth an audit row on its own.
  v_skip  text[] := array['updated_at', 'unifi_synced_at'];
  v_idrow  jsonb;
  v_old    jsonb;
  v_new    jsonb;
  v_before jsonb;
  v_after  jsonb;
  v_verb   text;
  v_details jsonb;
begin
  if (tg_op = 'INSERT') then
    v_idrow := to_jsonb(NEW);
    v_verb  := 'created';
    v_details := jsonb_build_object('after', v_idrow - v_deny);

  elsif (tg_op = 'DELETE') then
    v_idrow := to_jsonb(OLD);
    v_verb  := 'deleted';
    v_details := jsonb_build_object('before', v_idrow - v_deny);

  else  -- UPDATE — reduce to just the columns whose value changed.
    v_old   := to_jsonb(OLD);
    v_new   := to_jsonb(NEW);
    v_idrow := v_new;
    v_verb  := 'updated';
    select jsonb_object_agg(k, v_old -> k), jsonb_object_agg(k, v_new -> k)
      into v_before, v_after
    from jsonb_object_keys(v_new) as k
    where not (k = any(v_skip))
      and not (k = any(v_deny))
      and (v_old -> k) is distinct from (v_new -> k);
    if v_after is null then
      return null;  -- nothing meaningful changed → don't log
    end if;
    v_details := jsonb_build_object('before', v_before, 'after', v_after);
  end if;

  begin
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
    -- Best-effort: an audit failure must never break the mutation.
    null;
  end;

  return null;  -- AFTER ROW trigger — return value is ignored
end;
$$;

comment on function private.log_mutation() is
  'AUDIT-EXPAND.2 — generic AFTER-row trigger: writes a category=mutation audit_events row for INSERT/UPDATE/DELETE on the table it is attached to.';

-- ── Attach to the key business tables ───────────────────────────
-- Deliberately scoped to business-critical, low-to-moderate-churn
-- tables. High-frequency tables (bookings, tv_content, …) and
-- audit_events itself are intentionally excluded.

drop trigger if exists audit_mutation on public.cars;
create trigger audit_mutation after insert or update or delete
  on public.cars for each row execute function private.log_mutation();

drop trigger if exists audit_mutation on public.locations;
create trigger audit_mutation after insert or update or delete
  on public.locations for each row execute function private.log_mutation();

drop trigger if exists audit_mutation on public.organizations;
create trigger audit_mutation after insert or update or delete
  on public.organizations for each row execute function private.log_mutation();

drop trigger if exists audit_mutation on public.profiles;
create trigger audit_mutation after insert or update or delete
  on public.profiles for each row execute function private.log_mutation();

drop trigger if exists audit_mutation on public.profile_locations;
create trigger audit_mutation after insert or update or delete
  on public.profile_locations for each row execute function private.log_mutation();

drop trigger if exists audit_mutation on public.invoices_queue;
create trigger audit_mutation after insert or update or delete
  on public.invoices_queue for each row execute function private.log_mutation();
