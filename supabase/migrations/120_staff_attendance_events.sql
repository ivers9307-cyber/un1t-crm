-- 120_staff_attendance_events.sql
--
-- Phase 1 of "zero-touch arrival tracking": every UniFi Access door
-- unlock pushes a webhook to the CRM, we audit the event here, and
-- (when we can match it to a scheduled shift) stamp the actual
-- arrival time onto shift_assignments.start_time_override.
--
-- Two reasons we keep a separate audit table instead of just stamping
-- shift_assignments and walking away:
--
--   1. Diagnostics. If a coach was on the schedule but their arrival
--      didn't get stamped, we want to know whether the webhook fired
--      at all, what user/door it was attributed to, and why we
--      couldn't match it (no shift in window? door at wrong location?
--      already-stamped from an earlier unlock?).
--
--   2. Future-proofing. Phase 2 will pipe UniFi Protect detection
--      events through the same table when no Access unlock fired
--      (member tailgate, broken card reader, etc). Same shape, just
--      a different `source`.
--
-- Read access is gated by the new `attendance_reports` permission at
-- the application layer (owner / manager / master only). RLS here
-- enforces the location boundary on top so a manager at one studio
-- can't query another studio's attendance even if the API gate is
-- bypassed.
--
-- Also extends the webhook_events provider whitelist to recognise
-- `unifi_access` for the standard dedup pattern (mig 107).

BEGIN;

-- ── webhook_events provider whitelist ──────────────────────────

ALTER TABLE public.webhook_events DROP CONSTRAINT IF EXISTS webhook_events_provider_check;
ALTER TABLE public.webhook_events ADD CONSTRAINT webhook_events_provider_check
  CHECK (provider = ANY (ARRAY[
    'postmark', 'revolut', 'revolut_race', 'whatsapp', 'twilio', 'xero',
    'unifi_access'
  ]));

-- ── staff_attendance_events ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.staff_attendance_events (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Resolved staff identity. Nullable because we still log events
  -- that came from a UniFi user we can't map (e.g. customer NFC
  -- card, deactivated staff, never-synced profile_locations row).
  profile_id              uuid REFERENCES public.profiles(id) ON DELETE SET NULL,

  -- Always set — we know which door / which location the event
  -- happened at even when we can't resolve the user.
  location_id             uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,

  -- 'unifi_access' for v1 (door unlock). Will grow to include
  -- 'protect' (camera detection) in Phase 2 and 'manual' for an
  -- operator entering an arrival by hand.
  source                  text NOT NULL CHECK (source IN ('unifi_access', 'protect', 'manual')),

  -- Raw external IDs as observed on the wire. unifi_user_id matches
  -- profile_locations.unifi_user_id when the user is staff;
  -- unifi_door_id is what we saw in the payload (used to filter
  -- 'staff entrance only' rules in future).
  unifi_user_id           text,
  unifi_door_id           text,

  -- When the event happened (controller-reported, NOT when we got
  -- the webhook — the two can differ by minutes if the controller
  -- queues during an outage). The bucketing logic uses event_at.
  event_at                timestamptz NOT NULL,

  -- When the CRM received it. Useful for catching webhook delivery
  -- delay incidents.
  received_at             timestamptz NOT NULL DEFAULT now(),

  -- The shift assignment we matched against, if any. NULL means we
  -- received an event but couldn't tie it to a scheduled shift.
  matched_assignment_id   uuid REFERENCES public.shift_assignments(id) ON DELETE SET NULL,

  -- Diagnostic: what was the outcome of the match attempt?
  --   matched               — found a shift, stamped start_time_override
  --   no_shift_in_window    — staff was identified, no shift within ±4h
  --   already_stamped       — found a shift but it already has an arrival (we don't overwrite)
  --   unknown_user          — couldn't map unifi_user_id to a profile
  --   wrong_location        — staff identified but not assigned at this location
  match_outcome           text NOT NULL CHECK (match_outcome IN (
    'matched', 'no_shift_in_window', 'already_stamped', 'unknown_user', 'wrong_location'
  )),

  -- Full webhook payload for audit. Truncated to first 8KB on
  -- ingest so a hostile / malformed source can't blow up storage.
  payload                 jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at              timestamptz NOT NULL DEFAULT now()
);

-- Reporting: per-staff-per-day arrival lookups. Most queries filter
-- by location_id + a date range, so location_id leads.
CREATE INDEX IF NOT EXISTS idx_staff_attendance_events_location_event
  ON public.staff_attendance_events (location_id, event_at DESC);

CREATE INDEX IF NOT EXISTS idx_staff_attendance_events_profile_event
  ON public.staff_attendance_events (profile_id, event_at DESC)
  WHERE profile_id IS NOT NULL;

-- "Show me the unmatched events" — small partial index for diagnostics.
CREATE INDEX IF NOT EXISTS idx_staff_attendance_events_unmatched
  ON public.staff_attendance_events (event_at DESC)
  WHERE match_outcome <> 'matched';

CREATE INDEX IF NOT EXISTS idx_staff_attendance_events_assignment
  ON public.staff_attendance_events (matched_assignment_id)
  WHERE matched_assignment_id IS NOT NULL;

-- ── RLS ────────────────────────────────────────────────────────

ALTER TABLE public.staff_attendance_events ENABLE ROW LEVEL SECURITY;

-- Read: staff at this location (the application layer additionally
-- requires the attendance_reports permission). Master always sees.
CREATE POLICY "Staff read attendance at their locations"
  ON public.staff_attendance_events FOR SELECT TO public
  USING (
    private.auth_is_master()
    OR private.auth_is_in_location(location_id)
  );

-- Writes are service-role-only (the webhook receiver runs with the
-- service-role key and bypasses RLS). No INSERT/UPDATE/DELETE
-- policies — restrictive by default.

COMMIT;
