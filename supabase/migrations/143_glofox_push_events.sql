-- GLOFOX3.1 — outbound (CRM → Glofox) push audit table.
--
-- Mirror of glofox_webhook_events (mig 132) but for the OPPOSITE
-- direction. Every push attempt — whether triggered by a booking
-- form, an event registration, the manual "Create in Glofox"
-- button, or the always-on dup-prevention search — lands here so
-- the operator can see what was sent, what came back, and what
-- needs review.
--
-- Status taxonomy:
--   linked         — search-by-email found an existing Glofox member;
--                    we wrote the glofox_member_id without creating
--   created        — POST /2.0/register succeeded; new Glofox member
--                    created (with optional trial membership purchase)
--   updated        — PUT /2.0/members/{id} succeeded; existing
--                    Glofox member's fields refreshed from CRM
--   skipped        — opt-in flag was off and no email match (pure
--                    CRM-only contact, by design)
--   needs_review   — partial success or ambiguous (e.g., create
--                    succeeded but trial membership purchase failed,
--                    multiple Glofox matches for same email).
--                    Surfaces in the /admin/glofox-import Review tab
--   failed         — push attempted, Glofox returned an error, or
--                    a network failure killed the call. Operator can
--                    retry from the Review tab

CREATE TABLE IF NOT EXISTS glofox_push_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id      UUID REFERENCES contacts(id) ON DELETE CASCADE,
  location_id     UUID REFERENCES locations(id),
  -- What kind of push triggered this row.
  source          TEXT NOT NULL CHECK (source IN (
    'booking_form', 'event_registration', 'manual_button',
    'dup_check', 'cron'
  )),
  -- Outcome — see comment block above for the taxonomy.
  status          TEXT NOT NULL CHECK (status IN (
    'linked', 'created', 'updated', 'skipped',
    'needs_review', 'failed'
  )),
  glofox_member_id  TEXT,                  -- the resolved id, or NULL on failure
  glofox_response   JSONB,                 -- raw Glofox response for forensic
  error_message     TEXT,                  -- on 'failed' / 'needs_review'
  passcode_sent     TEXT,                  -- nullable; set when created with trial
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  reviewed_at       TIMESTAMPTZ,           -- operator marks reviewed
  reviewed_by       UUID REFERENCES profiles(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_glofox_push_events_contact ON glofox_push_events (contact_id);
CREATE INDEX IF NOT EXISTS idx_glofox_push_events_location ON glofox_push_events (location_id);
CREATE INDEX IF NOT EXISTS idx_glofox_push_events_status ON glofox_push_events (status);
CREATE INDEX IF NOT EXISTS idx_glofox_push_events_needs_review
  ON glofox_push_events (created_at DESC)
  WHERE status IN ('needs_review', 'failed') AND reviewed_at IS NULL;

ALTER TABLE glofox_push_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY glofox_push_events_select ON glofox_push_events
  FOR SELECT USING (
    location_id IN (
      SELECT location_id FROM profile_locations WHERE profile_id = auth.uid()
    )
  );
