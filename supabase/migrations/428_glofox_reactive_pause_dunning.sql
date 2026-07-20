-- 428_glofox_reactive_pause_dunning.sql
--
-- GLOFOX-REACTIVE — capture the membership pause window from the
-- Glofox `service` webhook, and enable event-driven (reactive)
-- arrears dunning.
--
-- Three structures:
--
-- 1. glofox_services — source-of-truth table mirroring SERVICE_*
--    events. UNIQUE on Glofox's service id makes the receiver
--    idempotent (Glofox retries SERVICE_UPDATED on state changes;
--    we overwrite, not duplicate). The one datum we can't get
--    anywhere else lives here: the pause window, incl. resume_date.
--
-- 2. contacts.glofox_membership_paused_at / _resume_at —
--    denormalised so the profile + churn radar read one contacts
--    row (no join), mirroring glofox_membership_state (mig 195).
--
-- 3. locations.dunning_auto_enroll — per-location opt-in for
--    reactive dunning. Default FALSE: dunning stays manual until an
--    operator flips it, because it sends real customer messages.

-- ─────────────────────────────────────────────────────────────
-- 1. Source-of-truth table for Glofox services (memberships as
--    "services", incl. the pause object).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS glofox_services (
  id                     TEXT PRIMARY KEY,             -- Glofox service id
  contact_id             UUID REFERENCES contacts(id) ON DELETE CASCADE,
  location_id            UUID REFERENCES locations(id),
  membership_id          TEXT,                          -- links to the membership
  glofox_user_id         TEXT,
  status                 TEXT,                          -- service status string
  paused                 BOOLEAN NOT NULL DEFAULT false,
  pause_start_at         TIMESTAMPTZ,                   -- pause.start_date
  pause_resume_at        TIMESTAMPTZ,                   -- pause.resume_date (the headline new datum)
  pause_duration_unit    TEXT,                          -- DAY / WEEK / MONTH
  pause_duration_amount  INTEGER,
  next_payment_at        TIMESTAMPTZ,                   -- next_payment_date
  raw_payload            JSONB,                         -- full event for forensic
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  synced_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_glofox_services_contact  ON glofox_services (contact_id);
CREATE INDEX IF NOT EXISTS idx_glofox_services_location ON glofox_services (location_id);
CREATE INDEX IF NOT EXISTS idx_glofox_services_paused   ON glofox_services (paused) WHERE paused = true;

COMMENT ON TABLE glofox_services IS
  'GLOFOX-REACTIVE — mirror of Glofox SERVICE_* webhook events. Holds the membership pause window (start/duration/resume) which is unavailable from any other Glofox surface (the member GET has only a bare subscription.paused boolean).';

-- ─────────────────────────────────────────────────────────────
-- 2. Denormalised pause window on contacts (profile + churn read
--    one row, no join — mirrors glofox_membership_state, mig 195).
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS glofox_membership_paused_at TIMESTAMPTZ;
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS glofox_membership_resume_at TIMESTAMPTZ;

COMMENT ON COLUMN public.contacts.glofox_membership_paused_at IS
  'GLOFOX-REACTIVE — when the membership pause began (Glofox service pause.start_date). Denormalised from glofox_services. Null when not paused.';
COMMENT ON COLUMN public.contacts.glofox_membership_resume_at IS
  'GLOFOX-REACTIVE — when a paused membership is scheduled to resume (Glofox service pause.resume_date). Drives the "Paused · resumes {date}" profile banner. Null when not paused.';

-- ─────────────────────────────────────────────────────────────
-- 3. Per-location opt-in for reactive (event-driven) dunning.
--    Default FALSE — dunning stays 100% manual (operator clicks
--    "Send payment reminder") until an operator turns this on.
-- ─────────────────────────────────────────────────────────────
ALTER TABLE public.locations
  ADD COLUMN IF NOT EXISTS dunning_auto_enroll BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.locations.dunning_auto_enroll IS
  'GLOFOX-REACTIVE — when true, an INVOICE_UPDATED=PAST_DUE webhook auto-enrolls the contact into locations.dunning_sequence_id. Default false (manual dunning only). Paused members are never auto-enrolled.';
