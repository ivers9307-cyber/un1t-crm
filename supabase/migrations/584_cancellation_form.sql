-- 584: CANCEL-FORM.1 — customer membership cancellation form.
--
-- A staff-sent, per-contact, single-use link lets a member pause or cancel
-- their membership from a public page. Submissions land in the existing
-- agent_membership_requests approval queue (kind pause | cancellation);
-- fulfilment in Glofox stays MANUAL until a location opts in to the
-- auto-cancel toggle below (default OFF).
--
-- Four changes:
--   1. agent_membership_requests.channel gains 'email' — the channel a
--      form link was DELIVERED by, so the approve path knows where to send
--      the confirmation. Rebuilt from the live list (mig 234), not from an
--      old migration file (mig 568's warning).
--   2. cancellation_form_links — one row per issued link. The URL token is
--      an HMAC over {link id, expiry} (src/lib/cancellation-form/token.js)
--      and never carries the contact id; this row is the source of truth
--      for who it was for, who sent it, opened/used state, and the request
--      it produced. token_fingerprint = sha256(token) so the live credential
--      is never stored (consent-token-guard.js pattern).
--   3. contacts.glofox_user_membership_id — the per-member membership
--      INSTANCE id from GET /2.0/members/{id} → membership.user_membership_id
--      (distinct from the catalog membershipId). The v3.0 cancel endpoint is
--      addressed by it; captured by the detail sync from here on.
--   4. locations.glofox_auto_cancel_memberships — per-location opt-in for
--      executing the Glofox cancel on approval. A COLUMN, like
--      dunning_auto_enroll (mig 428), not a key inside settings.customer_agent:
--      that blob is rebuilt wholesale by the settings PUT, so a flag inside it
--      could be silently reset by a stale editor. Only Stillorgan has Glofox
--      credentials; elsewhere the executor lands NOT_EXECUTABLE regardless.

-- 1. channel CHECK ────────────────────────────────────────────────────────
ALTER TABLE public.agent_membership_requests
  DROP CONSTRAINT IF EXISTS agent_membership_requests_channel_check;
ALTER TABLE public.agent_membership_requests
  ADD CONSTRAINT agent_membership_requests_channel_check
  CHECK (channel IN ('whatsapp', 'instagram', 'email'));

-- 2. issued-link audit ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cancellation_form_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  contact_id        uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  issued_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  issued_at         timestamptz NOT NULL DEFAULT now(),
  channel           text NOT NULL CHECK (channel IN ('email', 'whatsapp')),
  -- sha256 of the signed token (hex). UNIQUE so a resolved token maps to
  -- exactly one row and a forged-but-signed id swap cannot match.
  token_fingerprint text NOT NULL UNIQUE,
  expires_at        timestamptz NOT NULL,
  opened_at         timestamptz,
  used_at           timestamptz,
  -- send failed, or staff withdrew the link (a later resend supersedes).
  revoked_at        timestamptz,
  send_error        text,
  -- whatsapp_conversations.id when delivered by WhatsApp, so the approve
  -- path can answer in-thread.
  conversation_id   uuid,
  request_id        uuid REFERENCES public.agent_membership_requests(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cancellation_form_links_contact
  ON public.cancellation_form_links (contact_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS idx_cancellation_form_links_location_open
  ON public.cancellation_form_links (location_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cancellation_form_links_issued_by
  ON public.cancellation_form_links (issued_by) WHERE issued_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cancellation_form_links_request
  ON public.cancellation_form_links (request_id) WHERE request_id IS NOT NULL;

ALTER TABLE public.cancellation_form_links ENABLE ROW LEVEL SECURITY;

-- Every API path uses the service-role client and enforces location access
-- in app code (CLAUDE.md). These policies govern browser reads only: staff
-- assigned to the location see the "form sent / opened / submitted" chip;
-- writes are manager-at-location (+ master), per-command (never FOR ALL,
-- mig 483/485 lesson). One permissive policy per (table, command).
DROP POLICY IF EXISTS cancellation_form_links_select ON public.cancellation_form_links;
CREATE POLICY cancellation_form_links_select ON public.cancellation_form_links
  FOR SELECT TO authenticated
  USING (
    (SELECT private.auth_is_master())
    OR private.auth_is_manager_at(location_id)
    OR EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.location_id = cancellation_form_links.location_id
    )
  );
DROP POLICY IF EXISTS cancellation_form_links_insert ON public.cancellation_form_links;
CREATE POLICY cancellation_form_links_insert ON public.cancellation_form_links
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.auth_is_master()) OR private.auth_is_manager_at(location_id));
DROP POLICY IF EXISTS cancellation_form_links_update ON public.cancellation_form_links;
CREATE POLICY cancellation_form_links_update ON public.cancellation_form_links
  FOR UPDATE TO authenticated
  USING ((SELECT private.auth_is_master()) OR private.auth_is_manager_at(location_id))
  WITH CHECK ((SELECT private.auth_is_master()) OR private.auth_is_manager_at(location_id));
DROP POLICY IF EXISTS cancellation_form_links_delete ON public.cancellation_form_links;
CREATE POLICY cancellation_form_links_delete ON public.cancellation_form_links
  FOR DELETE TO authenticated
  USING ((SELECT private.auth_is_master()) OR private.auth_is_manager_at(location_id));

COMMENT ON TABLE public.cancellation_form_links IS
  'CANCEL-FORM.1: one row per staff-issued membership cancellation form link. Token is HMAC-signed over {id, exp}; token_fingerprint = sha256(token).';

-- 3. per-member membership instance id ──────────────────────────────────
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS glofox_user_membership_id text;
COMMENT ON COLUMN public.contacts.glofox_user_membership_id IS
  'CANCEL-FORM.1: Glofox membership INSTANCE id (GET /2.0/members/{id} → membership.user_membership_id). Addressed by POST /v3.0/memberships/{id}/cancel. Distinct from the catalog membershipId.';

-- 4. per-location auto-cancel opt-in ────────────────────────────────────
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS glofox_auto_cancel_memberships boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.locations.glofox_auto_cancel_memberships IS
  'CANCEL-FORM.1: when true, approving a membership cancellation request calls Glofox POST /v3.0/memberships/{id}/cancel (ON_DATE). Default false = staff cancel by hand in Glofox after approving.';
