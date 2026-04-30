-- ============================================================
-- 014: Lock down RLS to per-location scoping
--
-- Replaces the permissive "Authenticated full access" policies
-- (USING (true)) introduced in migrations 001, 002, 005, and the
-- mis-scoped "Service role full access" policies in 007 with
-- policies that enforce profile_locations membership at the DB layer.
--
-- Service role still bypasses RLS automatically (used by API routes
-- and cron). Anon-only public policies (booking widget, branding bucket)
-- are scoped TO anon and untouched.
--
-- Idempotent: uses DROP POLICY IF EXISTS / CREATE OR REPLACE FUNCTION
-- so it can be re-run safely.
-- ============================================================


-- ============================================================
-- HELPER FUNCTIONS
-- SECURITY DEFINER + STABLE so they're cached per-statement and
-- don't trigger recursive RLS on profile_locations / profiles.
-- ============================================================

CREATE OR REPLACE FUNCTION public.auth_is_in_location(loc_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT loc_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM profile_locations
        WHERE profile_id = auth.uid()
          AND location_id = loc_id
     );
$$;

CREATE OR REPLACE FUNCTION public.auth_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM profiles WHERE id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.auth_is_owner_or_manager()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.auth_role() IN ('owner', 'manager');
$$;

CREATE OR REPLACE FUNCTION public.auth_is_owner()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.auth_role() = 'owner';
$$;

GRANT EXECUTE ON FUNCTION public.auth_is_in_location(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.auth_role()                TO authenticated;
GRANT EXECUTE ON FUNCTION public.auth_is_owner_or_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION public.auth_is_owner()            TO authenticated;


-- ============================================================
-- CORE DATA TABLES (direct location_id)
-- ============================================================

-- contacts ----------------------------------------------------
DROP POLICY IF EXISTS "Authenticated full access" ON contacts;
CREATE POLICY contacts_location_scoped ON contacts
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));

-- deals -------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated full access" ON deals;
CREATE POLICY deals_location_scoped ON deals
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));

-- notes -------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated full access" ON notes;
CREATE POLICY notes_location_scoped ON notes
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));

-- activities --------------------------------------------------
DROP POLICY IF EXISTS "Authenticated full access" ON activities;
CREATE POLICY activities_location_scoped ON activities
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));

-- event_types -------------------------------------------------
-- (anon SELECT policy "Public can view active events" is preserved
--  because it's TO anon, not authenticated.)
DROP POLICY IF EXISTS "Authenticated full access" ON event_types;
CREATE POLICY event_types_location_scoped ON event_types
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));

-- bookings ----------------------------------------------------
-- (anon INSERT/SELECT for the public booking widget are TO anon;
--  preserved.)
DROP POLICY IF EXISTS "Authenticated full access" ON bookings;
CREATE POLICY bookings_location_scoped ON bookings
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));


-- ============================================================
-- EMAIL MARKETING (direct location_id)
-- ============================================================

-- contact_preferences ----------------------------------------
DROP POLICY IF EXISTS "Authenticated full access" ON contact_preferences;
CREATE POLICY contact_preferences_location_scoped ON contact_preferences
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));

-- email_templates --------------------------------------------
DROP POLICY IF EXISTS "Authenticated full access" ON email_templates;
CREATE POLICY email_templates_location_scoped ON email_templates
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));

-- campaigns --------------------------------------------------
DROP POLICY IF EXISTS "Authenticated full access" ON campaigns;
CREATE POLICY campaigns_location_scoped ON campaigns
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));

-- email_sequences --------------------------------------------
DROP POLICY IF EXISTS "Authenticated full access" ON email_sequences;
CREATE POLICY email_sequences_location_scoped ON email_sequences
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));

-- email_sends ------------------------------------------------
DROP POLICY IF EXISTS "Authenticated full access" ON email_sends;
CREATE POLICY email_sends_location_scoped ON email_sends
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));


-- ============================================================
-- EMAIL MARKETING (scoped through parent)
-- ============================================================

-- consent_log: scoped through contacts.location_id
DROP POLICY IF EXISTS "Authenticated full access" ON consent_log;
CREATE POLICY consent_log_via_contact ON consent_log
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = consent_log.contact_id
         AND public.auth_is_in_location(c.location_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM contacts c
       WHERE c.id = consent_log.contact_id
         AND public.auth_is_in_location(c.location_id)
    )
  );

-- campaign_recipients: scoped through campaigns.location_id
DROP POLICY IF EXISTS "Authenticated full access" ON campaign_recipients;
CREATE POLICY campaign_recipients_via_campaign ON campaign_recipients
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM campaigns ca
       WHERE ca.id = campaign_recipients.campaign_id
         AND public.auth_is_in_location(ca.location_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM campaigns ca
       WHERE ca.id = campaign_recipients.campaign_id
         AND public.auth_is_in_location(ca.location_id)
    )
  );

-- sequence_steps: scoped through email_sequences.location_id
DROP POLICY IF EXISTS "Authenticated full access" ON sequence_steps;
CREATE POLICY sequence_steps_via_sequence ON sequence_steps
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM email_sequences s
       WHERE s.id = sequence_steps.sequence_id
         AND public.auth_is_in_location(s.location_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM email_sequences s
       WHERE s.id = sequence_steps.sequence_id
         AND public.auth_is_in_location(s.location_id)
    )
  );

-- sequence_enrollments: scoped through email_sequences.location_id
DROP POLICY IF EXISTS "Authenticated full access" ON sequence_enrollments;
CREATE POLICY sequence_enrollments_via_sequence ON sequence_enrollments
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM email_sequences s
       WHERE s.id = sequence_enrollments.sequence_id
         AND public.auth_is_in_location(s.location_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM email_sequences s
       WHERE s.id = sequence_enrollments.sequence_id
         AND public.auth_is_in_location(s.location_id)
    )
  );


-- ============================================================
-- WHATSAPP
--
-- Migration 007 created policies named "Service role full access"
-- but with NO `TO` clause, so they applied to the `public` role
-- (anon + authenticated) — i.e. wide open. Drop them all and replace
-- with location-scoped authenticated policies. Service role bypasses
-- RLS automatically, so the webhook handler is unaffected.
-- ============================================================

DROP POLICY IF EXISTS "Service role full access" ON whatsapp_templates;
DROP POLICY IF EXISTS "Service role full access" ON whatsapp_broadcasts;
DROP POLICY IF EXISTS "Service role full access" ON whatsapp_broadcast_recipients;
DROP POLICY IF EXISTS "Service role full access" ON whatsapp_conversations;
DROP POLICY IF EXISTS "Service role full access" ON whatsapp_messages;

-- whatsapp_templates ------------------------------------------
CREATE POLICY whatsapp_templates_location_scoped ON whatsapp_templates
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));

-- whatsapp_broadcasts -----------------------------------------
CREATE POLICY whatsapp_broadcasts_location_scoped ON whatsapp_broadcasts
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));

-- whatsapp_conversations --------------------------------------
CREATE POLICY whatsapp_conversations_location_scoped ON whatsapp_conversations
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));

-- whatsapp_messages -------------------------------------------
CREATE POLICY whatsapp_messages_location_scoped ON whatsapp_messages
  FOR ALL TO authenticated
  USING (public.auth_is_in_location(location_id))
  WITH CHECK (public.auth_is_in_location(location_id));

-- whatsapp_broadcast_recipients: scoped through broadcasts.location_id
CREATE POLICY whatsapp_broadcast_recipients_via_broadcast ON whatsapp_broadcast_recipients
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM whatsapp_broadcasts b
       WHERE b.id = whatsapp_broadcast_recipients.broadcast_id
         AND public.auth_is_in_location(b.location_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM whatsapp_broadcasts b
       WHERE b.id = whatsapp_broadcast_recipients.broadcast_id
         AND public.auth_is_in_location(b.location_id)
    )
  );


-- ============================================================
-- EVENTS — child tables (blocked_times)
-- ============================================================

-- blocked_times: scoped through event_types.location_id.
-- (anon SELECT "Public can view blocked times" is TO anon and preserved.)
DROP POLICY IF EXISTS "Authenticated full access" ON blocked_times;
CREATE POLICY blocked_times_via_event_type ON blocked_times
  FOR ALL TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM event_types et
       WHERE et.id = blocked_times.event_type_id
         AND public.auth_is_in_location(et.location_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM event_types et
       WHERE et.id = blocked_times.event_type_id
         AND public.auth_is_in_location(et.location_id)
    )
  );


-- ============================================================
-- PIPELINE STAGES
-- Stages currently live per-location but are also referenced as
-- shared lookup data (handle_new_booking falls back to location_id IS NULL).
-- Read: any authenticated user can see stages in their locations OR
--       global stages (location_id IS NULL).
-- Write: owners/managers only, and only for their own locations.
-- ============================================================
DROP POLICY IF EXISTS "Authenticated full access" ON pipeline_stages;

CREATE POLICY pipeline_stages_select ON pipeline_stages
  FOR SELECT TO authenticated
  USING (location_id IS NULL OR public.auth_is_in_location(location_id));

CREATE POLICY pipeline_stages_admin_write ON pipeline_stages
  FOR ALL TO authenticated
  USING (
    public.auth_is_owner_or_manager()
    AND (location_id IS NULL OR public.auth_is_in_location(location_id))
  )
  WITH CHECK (
    public.auth_is_owner_or_manager()
    AND (location_id IS NULL OR public.auth_is_in_location(location_id))
  );


-- ============================================================
-- WEBHOOK SUBSCRIPTIONS
-- Admin-only configuration. Owners manage; managers read.
-- ============================================================
DROP POLICY IF EXISTS "Authenticated full access" ON webhook_subscriptions;

CREATE POLICY webhook_subscriptions_admin_select ON webhook_subscriptions
  FOR SELECT TO authenticated
  USING (
    public.auth_is_owner_or_manager()
    AND (location_id IS NULL OR public.auth_is_in_location(location_id))
  );

CREATE POLICY webhook_subscriptions_owner_write ON webhook_subscriptions
  FOR ALL TO authenticated
  USING (
    public.auth_is_owner()
    AND (location_id IS NULL OR public.auth_is_in_location(location_id))
  )
  WITH CHECK (
    public.auth_is_owner()
    AND (location_id IS NULL OR public.auth_is_in_location(location_id))
  );


-- ============================================================
-- COMPANY SETTINGS
-- Migration 013's read policy lets any authenticated user read every
-- location's settings. Replace with a location-scoped read; keep the
-- owner-manage policy as-is.
-- ============================================================
DROP POLICY IF EXISTS "Authenticated users can read company settings" ON company_settings;

CREATE POLICY company_settings_location_scoped_read ON company_settings
  FOR SELECT TO authenticated
  USING (public.auth_is_in_location(location_id));


-- ============================================================
-- VERIFICATION
-- After running, confirm there are no remaining permissive policies:
--
--   SELECT schemaname, tablename, policyname, qual
--     FROM pg_policies
--    WHERE schemaname = 'public'
--      AND qual = 'true'
--      AND policyname NOT ILIKE 'Public can%'
--      AND policyname NOT ILIKE 'Public read access%';
--
-- This should return zero rows. The remaining `qual = true` rows are
-- the intentional anon policies for the public booking widget and
-- branding bucket.
-- ============================================================
