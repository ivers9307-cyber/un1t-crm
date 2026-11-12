-- 806 — ASSISTCAP.1: the staff assistant gets its OWN monthly spend cap.
--
-- DECISION (Richard, 12 Nov 2026): the in-app staff assistant
-- (/api/assistant/chat) gets a SEPARATE hard monthly cap, set in the platform
-- so it can be adjusted — not a share of the org's Mia cap.
--
-- WHY SEPARATE, and why this is a follow-up rather than a new idea.
-- mig 421 deliberately excluded source 'assistant_chat' from
-- org_ai_spend_month_cents — the usage_events.source comment says it is
-- "metered but allowance-exempt (Richard 2026-07-19: track now, allocate cost
-- ~Oct)" — and ai_hard_cap_cents's own comment ends "(staff assistant
-- unaffected)". So the exclusion was always a deferral, not a decision that
-- the assistant needs no ceiling. This migration is the allocation that note
-- promised.
--
-- The two halves have opposite cost profiles, which is the real argument for
-- two numbers rather than one: Mia answers CUSTOMERS and must never stop
-- mid-conversation because staff spent the month's budget exploring, while the
-- assistant is internal tooling whose spend is discretionary and whose refusal
-- costs a staff member one answer. One shared number lets either starve the
-- other, silently, in whichever direction the month happens to run.
--
-- column-grant: n/a. org_settings has NO client privilege and no policy
-- (mig 730, ORGSETCLIENTWRITE.1) — every read and write is a service-role
-- route — so a new column needs no GRANT decision and no PostgREST select can
-- name it from a browser. The mig 733 audit trigger
-- (private.log_mutation('organization_id','updated_by')) picks both columns up
-- automatically, and neither name matches private.audit_is_secret_key(), which
-- is correct: a spend cap is configuration, not a credential.
--
-- ROLLBACK (by hand): DROP the function, then
--   ALTER TABLE org_settings DROP COLUMN assistant_hard_cap_cents,
--     DROP COLUMN assistant_cap_notice_month;
-- Nothing reads either until the code that ships with this deploys, so an
-- unapplied-code rollback is safe on its own.

ALTER TABLE org_settings
  ADD COLUMN assistant_hard_cap_cents NUMERIC
    CHECK (assistant_hard_cap_cents IS NULL OR assistant_hard_cap_cents > 0),
  ADD COLUMN assistant_cap_notice_month TEXT
    CHECK (assistant_cap_notice_month IS NULL OR assistant_cap_notice_month ~ '^\d{4}-\d{2}$');

COMMENT ON COLUMN org_settings.assistant_hard_cap_cents IS
  'ASSISTCAP.1 optional HARD monthly cap on STAFF ASSISTANT spend (cents, Dublin calendar month, the platform billing calendar). NULL = no cap, which is the shipped default. At cap: /api/assistant/chat refuses before any Anthropic call (code assistant_spend_cap) and tells the operator who can raise it; Mia, sequences and every other AI path are unaffected because they are judged on ai_hard_cap_cents against a spend sum that excludes assistant_chat (mig 421).';
COMMENT ON COLUMN org_settings.assistant_cap_notice_month IS
  'ASSISTCAP.1 the YYYY-MM the 80%-of-cap notice was last emailed for the ASSISTANT cap. Separate from ai_cap_notice_month so one cap''s notice can never suppress the other''s (capNoticeDecision is per-cap, and sharing one column would silently send only whichever cap crossed 80% first in a month).';

-- ── Live month sum for the assistant cap check ─────────────────────
-- The mirror of org_ai_spend_month_cents (mig 421, body untouched by 721):
-- same shape, same Europe/Dublin platform calendar, same
-- COALESCE(ue.organization_id, l.organization_id) so a row written with only a
-- location_id still attributes to its org — which matters here, because
-- /api/assistant/chat records usage with locationId and no organizationId.
-- The ONLY difference is `=` where that one has `<>`: this function is exactly
-- the spend the other deliberately leaves out.
--
-- SECURITY INVOKER with service_role as its only caller, matching its sibling.
-- It reads no `private` schema object, so it needs no USAGE there (service_role
-- holds none — see mig 721's header).

CREATE OR REPLACE FUNCTION public.org_assistant_spend_month_cents(p_org uuid, p_month_start date)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(SUM(ue.cost_estimate_cents), 0)
  FROM usage_events ue
  LEFT JOIN locations l ON l.id = ue.location_id
  WHERE COALESCE(ue.organization_id, l.organization_id) = p_org
    AND ue.meter = 'anthropic_tokens'
    AND ue.source = 'assistant_chat'
    AND (ue.occurred_at AT TIME ZONE 'Europe/Dublin')::date >= p_month_start;
$$;

COMMENT ON FUNCTION public.org_assistant_spend_month_cents(uuid, date) IS
  'ASSISTCAP.1 live STAFF ASSISTANT spend (cents) for an org since a month start, on the Europe/Dublin platform billing calendar. The complement of org_ai_spend_month_cents: that one excludes source assistant_chat, this one is only it, so the two never double-count a row.';

REVOKE EXECUTE ON FUNCTION public.org_assistant_spend_month_cents(uuid, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.org_assistant_spend_month_cents(uuid, date) TO service_role;

-- ── Self-check ────────────────────────────────────────────────────
-- Prove the columns exist with their CHECKs, the function exists with the
-- intended ACL, and that the two spend functions partition the ledger rather
-- than overlapping it (the bug a copy-paste of `<>` would introduce).
DO $$
DECLARE
  n int;
  acl text;
BEGIN
  SELECT count(*) INTO n FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'org_settings'
     AND column_name IN ('assistant_hard_cap_cents', 'assistant_cap_notice_month');
  IF n <> 2 THEN RAISE EXCEPTION 'ASSISTCAP.1: expected both columns, found %', n; END IF;

  SELECT pg_get_functiondef(p.oid) INTO acl
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public' AND p.proname = 'org_assistant_spend_month_cents';
  IF acl IS NULL THEN RAISE EXCEPTION 'ASSISTCAP.1: function missing'; END IF;
  IF acl NOT LIKE '%= ''assistant_chat''%' THEN
    RAISE EXCEPTION 'ASSISTCAP.1: function must match assistant_chat, not exclude it';
  END IF;

  -- service_role may execute; no client role may.
  IF NOT has_function_privilege('service_role',
        'public.org_assistant_spend_month_cents(uuid, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSISTCAP.1: service_role cannot execute the function';
  END IF;
  IF has_function_privilege('authenticated',
        'public.org_assistant_spend_month_cents(uuid, date)', 'EXECUTE')
     OR has_function_privilege('anon',
        'public.org_assistant_spend_month_cents(uuid, date)', 'EXECUTE') THEN
    RAISE EXCEPTION 'ASSISTCAP.1: a client role can execute the function';
  END IF;
END $$;
