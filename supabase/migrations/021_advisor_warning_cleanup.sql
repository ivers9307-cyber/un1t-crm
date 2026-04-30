-- ============================================================
-- 021: Clear the remaining advisor WARN-level findings
--
-- Four sections, all independent:
--
--   A. Drop redundant anon policies on the public-booking-facing tables.
--      Verified: every public booking flow goes through /api/public/*
--      which uses the service-role Supabase client (createServerClient),
--      bypassing RLS entirely. The "Anon full access" / "Public can ..."
--      policies on bookings, event_types, blocked_times are dead code —
--      but they show up to the linter as `rls_policy_always_true` and
--      they widen the anon attack surface needlessly. Drop them all.
--      Anon now has zero direct access to these tables.
--
--   B. Drop redundant "Service role full access" policies on the
--      schedule tables. Service role bypasses RLS automatically — those
--      policies do nothing. They were added in migration 010 before we
--      understood that. The remaining authenticated-targeted policies
--      keep the schedule UI working unchanged.
--
--   C. Set search_path = '' on the four trigger / utility functions the
--      linter flagged. Fully-qualifies all table references so the
--      function body can't resolve to a different schema than it was
--      written against. This is the recommended hardening for SECURITY
--      DEFINER and trigger functions — closes a search-path-injection
--      class of bugs.
--
--   D. Revoke EXECUTE on SECURITY DEFINER helpers from PUBLIC (which
--      includes anon). The auth_* helpers are still callable by
--      authenticated because migration 014 explicitly granted that;
--      trigger-only functions are revoked from anon AND authenticated
--      (no one outside the trigger system or service role should call
--      them). Service role retains EXECUTE because the role bypasses
--      grants the same way it bypasses RLS.
--
-- All four sections are idempotent — rerunning is a no-op.
-- ============================================================


-- ============================================================
-- A. Drop redundant anon policies on public-booking-facing tables
-- ============================================================

DROP POLICY IF EXISTS "Anon full access"                       ON bookings;
DROP POLICY IF EXISTS "Public can create bookings"             ON bookings;
DROP POLICY IF EXISTS "Public can view bookings for availability" ON bookings;

DROP POLICY IF EXISTS "Anon full access"                       ON event_types;
DROP POLICY IF EXISTS "Public can view active events"          ON event_types;

DROP POLICY IF EXISTS "Anon full access"                       ON blocked_times;
DROP POLICY IF EXISTS "Public can view blocked times"          ON blocked_times;


-- ============================================================
-- B. Drop redundant "Service role full access" policies
-- ============================================================

DROP POLICY IF EXISTS "Service role full access" ON shifts;
DROP POLICY IF EXISTS "Service role full access" ON shift_templates;
DROP POLICY IF EXISTS "Service role full access" ON shift_swap_requests;
DROP POLICY IF EXISTS "Service role full access" ON schedule_notifications;


-- ============================================================
-- C. Lock down search_path on flagged functions
--
-- For each: CREATE OR REPLACE with `SET search_path = ''` and fully
-- qualified table references. Bodies are otherwise byte-identical to
-- what's currently deployed.
-- ============================================================

-- update_updated_at — generic trigger; no table refs, but adding the
-- SET clause anyway for consistency.
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- fire_deal_webhooks — references public.webhook_subscriptions and
-- net.http_post (pg_net extension).
CREATE OR REPLACE FUNCTION public.fire_deal_webhooks()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  sub RECORD;
  payload JSONB;
BEGIN
  -- Only fire if stage or status actually changed
  IF OLD.stage_id IS DISTINCT FROM NEW.stage_id
     OR OLD.status IS DISTINCT FROM NEW.status THEN

    payload = jsonb_build_object(
      'event', 'deal.updated',
      'current', jsonb_build_object(
        'id', NEW.id,
        'title', NEW.title,
        'contact_id', NEW.contact_id,
        'stage_id', NEW.stage_id,
        'status', NEW.status,
        'updated_at', NEW.updated_at
      ),
      'previous', jsonb_build_object(
        'stage_id', OLD.stage_id,
        'status', OLD.status
      )
    );

    FOR sub IN
      SELECT target_url FROM public.webhook_subscriptions
      WHERE event_type = 'deal.updated' AND active = TRUE
    LOOP
      -- pg_net is a Supabase extension for async HTTP requests
      PERFORM net.http_post(
        url := sub.target_url,
        body := payload::TEXT,
        headers := '{"Content-Type": "application/json"}'::JSONB
      );
    END LOOP;
  END IF;

  RETURN NEW;
END;
$$;

-- log_wa_message_to_timeline — references public.activities and public.contacts.
CREATE OR REPLACE FUNCTION public.log_wa_message_to_timeline()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.contact_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.direction = 'outbound' THEN
    INSERT INTO public.activities (contact_id, type, subject, note, created_at)
    VALUES (NEW.contact_id, 'whatsapp_sent', 'WhatsApp sent',
      COALESCE('WhatsApp: ' || LEFT(NEW.body, 100), 'WhatsApp template: ' || NEW.template_name),
      NEW.created_at);
    UPDATE public.contacts SET last_wa_message_at = NEW.sent_at, total_wa_sent = total_wa_sent + 1
    WHERE id = NEW.contact_id;
  ELSIF NEW.direction = 'inbound' THEN
    INSERT INTO public.activities (contact_id, type, subject, note, created_at)
    VALUES (NEW.contact_id, 'whatsapp_received', 'WhatsApp received',
      'WhatsApp: ' || LEFT(NEW.body, 100), NEW.created_at);
    UPDATE public.contacts SET last_wa_message_at = NEW.sent_at, total_wa_received = total_wa_received + 1
    WHERE id = NEW.contact_id;
  END IF;

  RETURN NEW;
END;
$$;

-- update_holiday_allowance — references public.staff_allowances. Trigger
-- fires on time_off updates. Pulls EXTRACT(YEAR ...) which is a builtin
-- so doesn't need qualification.
CREATE OR REPLACE FUNCTION public.update_holiday_allowance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  -- When a holiday request is approved, increment used_days
  IF NEW.type = 'holiday' AND NEW.status = 'approved' AND (OLD.status IS NULL OR OLD.status != 'approved') THEN
    INSERT INTO public.staff_allowances (profile_id, year, total_days, used_days)
    VALUES (NEW.profile_id, EXTRACT(YEAR FROM NEW.start_date)::INT, 20, NEW.total_days)
    ON CONFLICT (profile_id, year)
    DO UPDATE SET
      used_days = public.staff_allowances.used_days + NEW.total_days,
      updated_at = NOW();
  END IF;

  -- When a previously approved holiday is cancelled or rejected, decrement used_days
  IF NEW.type = 'holiday' AND OLD.status = 'approved' AND NEW.status IN ('cancelled', 'rejected') THEN
    UPDATE public.staff_allowances
    SET used_days = GREATEST(0, used_days - OLD.total_days),
        updated_at = NOW()
    WHERE profile_id = OLD.profile_id
    AND year = EXTRACT(YEAR FROM OLD.start_date)::INT;
  END IF;

  RETURN NEW;
END;
$$;


-- ============================================================
-- D. Tighten EXECUTE grants on SECURITY DEFINER helpers
--
-- Two groups:
--   d1: auth_* + get_user_role — used in RLS expressions, must remain
--       callable by `authenticated` (existing migration 014 GRANT
--       handles that). Revoke from PUBLIC removes anon access.
--   d2: trigger functions + admin/server-only RPCs — no caller outside
--       the trigger system or service role. Revoke from PUBLIC, anon,
--       authenticated. Service role keeps execute (bypasses grants).
-- ============================================================

-- d1: auth helpers — keep authenticated, drop anon. Supabase grants
-- anon explicitly at project init (not via PUBLIC), so REVOKE FROM
-- PUBLIC alone leaves the anon ACL entry intact. Revoke from anon
-- directly. Authenticated retains EXECUTE because RLS policies on
-- contacts / deals / etc. evaluate `auth_is_in_location()` in the
-- authenticated role's context — removing that grant would lock
-- signed-in users out of every location-scoped table.
REVOKE EXECUTE ON FUNCTION public.auth_is_in_location(UUID)        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.auth_role()                       FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.auth_is_owner_or_manager()        FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.auth_is_owner()                   FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_user_role(UUID)               FROM PUBLIC, anon;

-- d2: trigger / admin / server-only — strip from anon + authenticated
REVOKE EXECUTE ON FUNCTION public.create_contact_preferences()      FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_booking()              FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user()                 FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_booking_status_change()       FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_deal_stage_change()           FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.log_email_send_activity()         FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rate_limit_hit(text, timestamptz, integer)
                                                                    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable()                 FROM PUBLIC, anon, authenticated;


-- ============================================================
-- VERIFICATION (run manually)
--
--   -- A: should return 0 rows
--   SELECT tablename, policyname FROM pg_policies
--    WHERE schemaname = 'public'
--      AND tablename IN ('bookings','event_types','blocked_times')
--      AND 'anon' = ANY (roles);
--
--   -- B: should return 0 rows
--   SELECT tablename, policyname FROM pg_policies
--    WHERE schemaname = 'public'
--      AND policyname = 'Service role full access'
--      AND tablename IN ('shifts','shift_templates',
--                        'shift_swap_requests','schedule_notifications');
--
--   -- C: should show all four with proconfig containing search_path=
--   SELECT proname, proconfig FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND proname IN ('update_updated_at','fire_deal_webhooks',
--                      'log_wa_message_to_timeline','update_holiday_allowance');
--
--   -- D: should NOT include anon / authenticated for the listed funcs
--   SELECT proname, proacl FROM pg_proc p
--     JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND proname IN ('auth_is_in_location','handle_new_booking','rate_limit_hit');
-- ============================================================
