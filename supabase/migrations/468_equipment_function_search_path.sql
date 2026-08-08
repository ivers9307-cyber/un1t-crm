-- EQUIP-MAINT.1b — pin search_path on equipment_touch_updated_at.
--
-- Advisor remediation (function_search_path_mutable, WARN). Mig 467
-- created the trigger function without a pinned search_path, which the
-- security advisor flagged immediately after the DDL applied. Same fix
-- and same idempotent style as mig 402 §3 (whatsapp_spend_rollup).
--
-- Forward-only: 467 is already applied to prod, so this lands as its
-- own migration rather than an edit to that file.
--
-- Why it matters: a SECURITY INVOKER trigger function with a mutable
-- search_path resolves unqualified names against the caller's path. The
-- body here only assigns new.updated_at := now(), so the practical risk
-- is low, but `now()` is still an unqualified resolution and the estate
-- convention is to pin rather than reason case-by-case.

do $$
begin
  if to_regprocedure('public.equipment_touch_updated_at()') is not null then
    alter function public.equipment_touch_updated_at()
      set search_path = public;
  end if;
end $$;
