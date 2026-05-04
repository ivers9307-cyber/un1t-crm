-- ============================================================
-- 084: UN1T-member pricing for races + standalone race payments
--
-- Two intertwined concepts land here:
--
--   1. Member pricing on race_events. An operator can flip on
--      "different pricing for members" with a member_fee_cents and
--      a non_member_fee_cents. A members_only flag hides the
--      non-member option from the public form entirely.
--
--   2. A NEW standalone race_payments table — deliberately separate
--      from the cars.deposit_* columns (mig 046/047/078). UN1T (gym
--      + races) and CCF Autos (cars) are different businesses, so
--      they should not share payment plumbing. Future Phase 2 will
--      generalise this into a polymorphic `orders` table that houses
--      every paid transaction; this migration lays the foundation
--      while keeping the surface area small enough to ship today.
--
-- team_members gains is_member + member_validation_status +
-- member_contact_id + member_validated_at so the public signup
-- route can stamp validation results, and the race-day control UI
-- can render a member badge per name.
--
-- race_registrations gains team_composition (denormalised
-- 'all_members' | 'mixed' | 'all_non_members') so the operator's
-- race-day filter chip is an indexed lookup rather than an N+1
-- aggregate over team_members.
-- ============================================================

BEGIN;

-- ─── race_events: member pricing ─────────────────────────────────

ALTER TABLE race_events
  ADD COLUMN IF NOT EXISTS member_pricing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS member_fee_cents       INT,
  ADD COLUMN IF NOT EXISTS non_member_fee_cents   INT,
  ADD COLUMN IF NOT EXISTS members_only           BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS payment_currency       TEXT NOT NULL DEFAULT 'EUR';

COMMENT ON COLUMN race_events.member_pricing_enabled IS
  'When TRUE, the public signup form validates each team member''s email against contacts where lead_status=''member'' and applies member_fee_cents per verified member, non_member_fee_cents per unverified. When FALSE, all entrants pay non_member_fee_cents (or are free if non_member_fee_cents is NULL).';

COMMENT ON COLUMN race_events.member_fee_cents IS
  'Per-person fee for verified UN1T members (minor units, e.g. €25 = 2500). NULL = members enter free even when pricing is enabled. Only consulted when member_pricing_enabled = TRUE.';

COMMENT ON COLUMN race_events.non_member_fee_cents IS
  'Per-person fee for non-members or unverified entrants (minor units). NULL = race is free for everyone (member_pricing_enabled is irrelevant in that case).';

COMMENT ON COLUMN race_events.members_only IS
  'When TRUE, the public signup form refuses any team that contains an unverified member. Operator-side: a hard gate, not just a pricing nudge. Independent of member_pricing_enabled — a free members-only race is valid (members_only=true, member_pricing_enabled=false, non_member_fee_cents=NULL).';

COMMENT ON COLUMN race_events.payment_currency IS
  'ISO-4217 currency code for fees on this race. EUR for UN1T Dublin; future locations may differ. Stored at race level so a race''s pricing is self-contained.';

-- ─── team_members: membership validation ─────────────────────────

ALTER TABLE team_members
  ADD COLUMN IF NOT EXISTS is_member                BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS member_validation_status TEXT NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS member_contact_id        UUID REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS member_validated_at      TIMESTAMPTZ;

-- Belt-and-braces enum check. 'pending' is reserved for a future
-- async validation flow — current code only writes 'verified',
-- 'failed', or 'not_applicable'.
ALTER TABLE team_members
  DROP CONSTRAINT IF EXISTS team_members_member_validation_status_check;
ALTER TABLE team_members
  ADD CONSTRAINT team_members_member_validation_status_check
  CHECK (member_validation_status IN ('not_applicable', 'pending', 'verified', 'failed'));

COMMENT ON COLUMN team_members.is_member IS
  'TRUE when this person was matched against an active UN1T member contact at signup time. Drives member_fee pricing + the member badge on the race-day control UI.';

COMMENT ON COLUMN team_members.member_validation_status IS
  'Validation outcome: not_applicable (member pricing wasn''t enabled on the race), verified (matched a contact with lead_status=''member''), failed (claimed member but no match), pending (reserved for async flows).';

COMMENT ON COLUMN team_members.member_contact_id IS
  'When is_member=TRUE, the contacts.id we matched against. Distinct from team_members.contact_id which (on the captain row only) is set to whoever filled out the signup form regardless of membership.';

CREATE INDEX IF NOT EXISTS idx_team_members_member_contact
  ON team_members (member_contact_id) WHERE member_contact_id IS NOT NULL;

-- ─── race_registrations: denormalised team composition ───────────

ALTER TABLE race_registrations
  ADD COLUMN IF NOT EXISTS team_composition TEXT NOT NULL DEFAULT 'all_non_members';

ALTER TABLE race_registrations
  DROP CONSTRAINT IF EXISTS race_registrations_team_composition_check;
ALTER TABLE race_registrations
  ADD CONSTRAINT race_registrations_team_composition_check
  CHECK (team_composition IN ('all_members', 'mixed', 'all_non_members'));

COMMENT ON COLUMN race_registrations.team_composition IS
  'Denormalised summary of team_members.is_member values for this registration: all_members | mixed | all_non_members. Updated at signup time + on any operator edit of the roster. Drives the race-day filter chip and "members on course" reporting without an N+1 aggregate.';

CREATE INDEX IF NOT EXISTS idx_race_registrations_composition
  ON race_registrations (race_event_id, team_composition);

-- ─── race_payments (NEW — separate from cars.deposit_*) ──────────
--
-- Purpose: every paid race registration gets a row here. Lifecycle
-- parallels Revolut's order states but tracked in our domain so
-- future Orders tab (Phase 2) can roll this up alongside other
-- order types without us reaching into per-domain columns.

CREATE TABLE IF NOT EXISTS race_payments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  race_event_id            UUID NOT NULL REFERENCES race_events(id) ON DELETE CASCADE,
  race_registration_id     UUID REFERENCES race_registrations(id) ON DELETE SET NULL,
  -- The captain — same person who filled out signup. Drives email +
  -- SMS confirmation routing.
  contact_id               UUID REFERENCES contacts(id) ON DELETE SET NULL,
  contact_email            TEXT NOT NULL,
  contact_phone            TEXT,
  contact_name             TEXT,
  -- Money. Minor units throughout (cents) to match Revolut's wire
  -- format and avoid float drift.
  amount_cents             INT NOT NULL,
  currency                 TEXT NOT NULL DEFAULT 'EUR',
  -- Per-team breakdown so the operator can see "2 members × €15 +
  -- 2 non-members × €25" in the order detail UI without recalculating.
  member_count             INT NOT NULL DEFAULT 0,
  non_member_count         INT NOT NULL DEFAULT 0,
  member_fee_cents         INT,
  non_member_fee_cents     INT,
  -- Lifecycle. Mirrors the eventual generic orders.status enum so
  -- the future Phase-2 migration is a no-op rename.
  status                   TEXT NOT NULL DEFAULT 'pending',
  -- Provider integration. payment_provider stays generic because
  -- Phase 2 may add Stripe / SumUp / cash. payment_provider_ref is
  -- the Revolut order_id (uuid) for revolut payments.
  payment_provider         TEXT NOT NULL DEFAULT 'revolut',
  payment_provider_ref     TEXT,
  payment_checkout_token   TEXT,
  payment_checkout_url     TEXT,
  -- Timestamps. *_at columns set when state advances; nullable so
  -- a single row can carry the full timeline.
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at             TIMESTAMPTZ,
  failed_at                TIMESTAMPTZ,
  abandoned_at             TIMESTAMPTZ,
  refunded_at              TIMESTAMPTZ,
  refunded_amount_cents    INT,
  -- Confirmation-send stamps so a webhook retry doesn't double-send.
  confirmation_email_sent_at TIMESTAMPTZ,
  confirmation_sms_sent_at   TIMESTAMPTZ,
  -- Free-form metadata for future analytics (UTM, referrer, etc).
  metadata                 JSONB,
  CONSTRAINT race_payments_status_check
    CHECK (status IN ('pending', 'completed', 'failed', 'abandoned', 'refunded'))
);

COMMENT ON TABLE race_payments IS
  'Payment lifecycle for race registrations. DELIBERATELY SEPARATE from cars.deposit_* (mig 046/078) — UN1T (races) and CCF Autos (cars) are different businesses and share no payment plumbing. Phase 2 will generalise this into a polymorphic orders table; the column shape here is chosen to make that migration a renamed-table operation.';

COMMENT ON COLUMN race_payments.status IS
  'pending → (completed | failed | abandoned). refunded only reachable from completed via a manual operator action. abandoned is set by a sweeper/cron when a pending row is older than (e.g.) 30min with no provider state change.';

COMMENT ON COLUMN race_payments.payment_provider_ref IS
  'Provider-side identifier. For revolut: the order_id (UUID). Webhook lookup uses this column.';

COMMENT ON COLUMN race_payments.payment_checkout_token IS
  'Revolut order.token returned by createOrder — what the embedded checkout SDK mounts. For non-Revolut providers: the equivalent client-side handle.';

CREATE INDEX IF NOT EXISTS idx_race_payments_event
  ON race_payments (race_event_id);
CREATE INDEX IF NOT EXISTS idx_race_payments_registration
  ON race_payments (race_registration_id) WHERE race_registration_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_race_payments_status
  ON race_payments (race_event_id, status);
CREATE INDEX IF NOT EXISTS idx_race_payments_provider_ref
  ON race_payments (payment_provider_ref) WHERE payment_provider_ref IS NOT NULL;
-- Email lookup powers Phase-2 retry-detection (find earlier failed/
-- abandoned orders for the same email when a new one completes).
CREATE INDEX IF NOT EXISTS idx_race_payments_contact_email
  ON race_payments (contact_email, status);

ALTER TABLE race_payments ENABLE ROW LEVEL SECURITY;

-- Operator scoping via the parent race_event's location. Master
-- bypass mirrors the rest of the race_* table policies.
DROP POLICY IF EXISTS race_payments_location_scoped ON race_payments;
CREATE POLICY race_payments_location_scoped ON race_payments
  FOR ALL
  TO authenticated
  USING (
    private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.race_events re
      WHERE re.id = race_payments.race_event_id
        AND private.auth_is_in_location(re.location_id)
    )
  )
  WITH CHECK (
    private.auth_is_master() OR EXISTS (
      SELECT 1 FROM public.race_events re
      WHERE re.id = race_payments.race_event_id
        AND private.auth_is_in_location(re.location_id)
    )
  );

CREATE OR REPLACE FUNCTION private.touch_race_payments_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN NEW.updated_at := NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS race_payments_touch_updated_at ON race_payments;
CREATE TRIGGER race_payments_touch_updated_at
  BEFORE UPDATE ON race_payments
  FOR EACH ROW EXECUTE FUNCTION private.touch_race_payments_updated_at();

-- ─── back-link from race_registrations to its current payment ────
-- Convenience: the operator UI listing wants the payment status
-- inline without a per-row join from registration → payment. The
-- foreign key + ON DELETE SET NULL keeps it loosely coupled (a
-- payment delete won't cascade to the registration).

ALTER TABLE race_registrations
  ADD COLUMN IF NOT EXISTS active_payment_id UUID
    REFERENCES race_payments(id) ON DELETE SET NULL;

COMMENT ON COLUMN race_registrations.active_payment_id IS
  'Pointer to the most recent race_payments row for this registration. NULL when the race was free or the registration was created without a payment flow. Updated by the public signup route + by the webhook on retry.';

CREATE INDEX IF NOT EXISTS idx_race_registrations_active_payment
  ON race_registrations (active_payment_id) WHERE active_payment_id IS NOT NULL;

-- ─── race_registrations.status: add 'pending_payment' ────────────
-- Existing CHECK allowed confirmed/cancelled/no_show only. A paid
-- registration starts as pending_payment until the webhook flips
-- it to confirmed (or the user abandons → operator can prune).

ALTER TABLE race_registrations
  DROP CONSTRAINT IF EXISTS race_registrations_status_check;
ALTER TABLE race_registrations
  ADD CONSTRAINT race_registrations_status_check
  CHECK (status IN ('pending_payment', 'confirmed', 'cancelled', 'no_show'));

COMMENT ON COLUMN race_registrations.status IS
  'pending_payment: signup submitted but checkout not yet completed (mig 084). confirmed: paid (or free). cancelled: operator removed. no_show: race day passed without showing.';

COMMIT;
