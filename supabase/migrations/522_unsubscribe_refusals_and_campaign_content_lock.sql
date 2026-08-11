-- ============================================================
-- 522 — UNSUB-RL.1 + CAMPHIST.1
--
-- Two independent sections. They share a migration number because they ship
-- in one PR; neither depends on the other, and either can be applied alone.
--
-- ⚠️ ORDERING: apply this AFTER the code in this PR deploys, or at any time
-- before. Both sections are additive and the code tolerates their absence:
--   • Section A — recordRefusedOptOut() wraps its INSERT in try/catch and logs
--     the refusal either way, so the app is correct before the table exists.
--   • Section B — a defence-in-depth trigger. The app-level lock (the detail
--     page, CampaignEditor, and the existing 409 on PUT /api/campaigns/[id])
--     is what actually closes the hole; this stops the same write arriving
--     through psql, a future direct-column writer, or the browser Supabase
--     client, whose RLS policy has no status predicate.
--
-- After applying, run get_advisors for BOTH types (security + performance).
-- ============================================================


-- ============================================================
-- SECTION A — unsubscribe_refusals (UNSUB-RL.1)
--
-- THE DEFECT THIS MAKES MEASURABLE
-- /api/unsubscribe/[token] rate-limited RFC 8058 one-click POSTs at 10 per IP
-- per 15 minutes. Those POSTs are issued by the recipient's MAIL PROVIDER, and
-- Gmail sends them from a shared proxy pool, so many people unsubscribing from
-- one campaign arrive on one source IP. Past the tenth, the route returned 429
-- before it had even read the token, so the opt-out was dropped having written
-- NOTHING. The person stayed on the list, believing they had left.
--
-- The worst property of that failure was that it was unmeasurable. 9 one-click
-- unsubscribes landed in a single 15-minute window on 2026-08-05, against a
-- limit of 10 — a near miss we can see only because those nine SUCCEEDED. How
-- many were refused is unknowable from the data, because a refusal left no
-- row anywhere.
--
-- This table is the answer to that question from now on. A refusal is a
-- compliance event (Gmail/Yahoo bulk-sender rules, GDPR/PECR), and the
-- fingerprint below makes each one recoverable by hand.
-- ============================================================

CREATE TABLE IF NOT EXISTS unsubscribe_refusals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'unsubscribe' | 'preferences'
  endpoint     TEXT NOT NULL,

  -- 'ip_enumeration_budget' | 'invalid_token' | 'token_flood'
  -- Kept as TEXT with a CHECK rather than an enum so adding a reason is a
  -- one-line migration; mirrors the consent_log.action treatment in mig 516.
  reason       TEXT NOT NULL CHECK (reason IN (
                 'ip_enumeration_budget', 'invalid_token', 'token_flood'
               )),

  -- Known only when the token resolved. NULL for an invalid token, which is
  -- precisely the case where we cannot say whose opt-out was lost.
  contact_id   UUID REFERENCES contacts(id)  ON DELETE SET NULL,
  location_id  UUID REFERENCES locations(id) ON DELETE SET NULL,
  campaign_id  UUID REFERENCES campaigns(id) ON DELETE SET NULL,

  -- Which channels the caller asked to leave (email/sms/whatsapp marketing).
  channels     TEXT[],

  ip_address   TEXT,
  user_agent   TEXT,

  -- SHA-256 of the presented token, first 128 bits, hex.
  --
  -- NEVER the raw token. contact_preferences.unsubscribe_token is a LIVE
  -- capability: storing it here would turn a diagnostics table into a store of
  -- working unsubscribe links for real contacts, readable by anyone who can
  -- read this table. The fingerprint still joins back to exactly one
  -- contact_preferences row (compute it the same way in SQL if you need to),
  -- which is what makes a refused opt-out actionable rather than merely
  -- countable.
  token_fingerprint TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE unsubscribe_refusals IS
  'UNSUB-RL.1 — every consent request the public token endpoints refused. A refused opt-out is a compliance event; before this table it left no trace at all.';
COMMENT ON COLUMN unsubscribe_refusals.token_fingerprint IS
  'SHA-256 of the presented token, first 32 hex chars. NEVER the raw token, which is a live unsubscribe capability.';

-- The operational query is "what have we refused lately", newest first.
CREATE INDEX IF NOT EXISTS idx_unsub_refusals_created
  ON unsubscribe_refusals (created_at DESC);

-- And "did we drop this person's opt-out", for the recoverable cases.
CREATE INDEX IF NOT EXISTS idx_unsub_refusals_contact
  ON unsubscribe_refusals (contact_id)
  WHERE contact_id IS NOT NULL;

-- RLS: service role only, exactly like rate_limit_buckets (mig 015).
-- No CREATE POLICY = no authenticated or anon role can read or write it.
-- Service role bypasses RLS automatically, and every writer here is an /api
-- route on the service-role client.
--
-- NOTE the mig 483/485 lesson: do NOT add a restrictive `FOR ALL ... USING
-- (false)` "deny writes" policy to this table. That form denies SELECT too and
-- fails silently (empty set, no error). Absence of policies is the correct
-- lock-down, not a restrictive one.
ALTER TABLE unsubscribe_refusals ENABLE ROW LEVEL SECURITY;


-- ============================================================
-- SECTION B — campaign content lock (CAMPHIST.1)
--
-- THE DEFECT
-- `?edit=1` on /communications/sent/email/[id] opened the full campaign editor
-- for a campaign in ANY status, including 'sent'. CampaignEditor saves by
-- writing the campaigns row DIRECTLY from the browser Supabase client, so the
-- 409 guard on PUT /api/campaigns/[id] never ran, and campaigns_location_scoped
-- (mig 014) is `FOR ALL ... USING auth_is_in_location(location_id)` with no
-- status predicate, so the database allowed it too.
--
-- The result is silent history corruption: campaign_recipients (its per-row
-- sent/delivered/opened/clicked/bounced timestamps), campaign_link_clicks and
-- email_sends all keep pointing at a campaigns row whose subject and body are
-- no longer what was sent. Every report built on them — open rate, the click
-- report, campaign_outcome_stats, list_health_monthly_stats — then describes
-- the wrong creative, permanently, because the sent copy exists nowhere else.
--
-- WHAT THIS BLOCKS: changes to CONTENT columns once the campaign has left the
-- editable states. It deliberately does NOT block the send state machine,
-- which updates status, the total_* counters, sent_at, send_started_at,
-- cancel_requested_at, last_error and the A/B outcome columns on exactly these
-- rows, every minute, from the run-campaigns cron.
--
-- The reuse path is POST /api/campaigns/[id]/duplicate.
-- ============================================================

CREATE OR REPLACE FUNCTION public.campaigns_lock_sent_content()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Only guard rows that have left the editable states. Mirrors
  -- EDITABLE_CAMPAIGN_STATUSES in src/lib/campaign-editability.js — keep the
  -- two in step.
  IF OLD.status IN ('draft', 'scheduled') THEN
    RETURN NEW;
  END IF;

  IF (NEW.subject         IS DISTINCT FROM OLD.subject)
  OR (NEW.html_content     IS DISTINCT FROM OLD.html_content)
  OR (NEW.design_json      IS DISTINCT FROM OLD.design_json)
  OR (NEW.preview_text     IS DISTINCT FROM OLD.preview_text)
  OR (NEW.audience_filter  IS DISTINCT FROM OLD.audience_filter)
  OR (NEW.from_name        IS DISTINCT FROM OLD.from_name)
  OR (NEW.from_email       IS DISTINCT FROM OLD.from_email)
  OR (NEW.reply_to         IS DISTINCT FROM OLD.reply_to)
  OR (NEW.ab_subject_b     IS DISTINCT FROM OLD.ab_subject_b)
  THEN
    RAISE EXCEPTION
      'Campaign % is % — its content is the record of what was sent and cannot be edited. Duplicate it instead.',
      OLD.id, OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS campaigns_lock_sent_content ON campaigns;
CREATE TRIGGER campaigns_lock_sent_content
  BEFORE UPDATE ON campaigns
  FOR EACH ROW
  EXECUTE FUNCTION public.campaigns_lock_sent_content();

COMMENT ON FUNCTION public.campaigns_lock_sent_content() IS
  'CAMPHIST.1 — refuses content edits to a campaign past draft/scheduled. Defence in depth behind the app-level lock; the send state machine (status, total_*, sent_at, A/B outcome) is deliberately unaffected.';
