-- 457 — revoke REST execute on log_membership_transition (TREND-FLOWS.1).
--
-- Advisor WARN after mig 456: SECURITY DEFINER functions in public are
-- exposed at /rest/v1/rpc/* to anon + authenticated. Postgres refuses
-- to run a trigger function outside a trigger, so this was noise, but
-- revoke anyway so the advisor stays clean.

revoke execute on function public.log_membership_transition() from anon, authenticated, public;
