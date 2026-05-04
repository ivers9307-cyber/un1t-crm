-- ============================================================
-- 086: Race-contact linking + competition_competitor lead status
--
-- Two related changes:
--
--   1. team_members.contact_id is now populated for EVERY member
--      with an email (not just the captain). This means that when
--      an operator opens a contact profile, they can see every
--      race the contact has competed in — captain or otherwise.
--
--   2. New documented value for contacts.lead_status:
--      'competition_competitor' — the race-only path. Auto-assigned
--      when the public race signup creates a fresh contact for a
--      team member who isn't already in the CRM. Distinct from
--      'member' (UN1T gym member) and other statuses so operators
--      can target competition-only contacts in retargeting.
--
-- Backfill: every existing team_members row with an email gets
-- linked. Match is (location_id, lower(email)). Unmatched emails
-- have a contact created with lead_status='competition_competitor'
-- and source='race_signup_backfill'. The team's location is the
-- contact's location.
--
-- Note on taxonomy: lead_status is TEXT with no CHECK constraint
-- (mig 001 default). The new value is documented via column
-- comment but no schema change is needed to accept it. The
-- AudienceBuilder UI gets the new option in the same deploy.
-- ============================================================

BEGIN;

COMMENT ON COLUMN contacts.lead_status IS
  'Lifecycle bucket. Known values (mig 086): active_trial, cold, lost_member, member, returning, competition_competitor. competition_competitor is auto-assigned when a fresh contact is created via the public race signup (mig 086) — distinct from member so race-only attendees can be targeted separately.';

-- ─── Backfill: existing team_members with emails ────────────────

-- Step 1: link team_members to existing contacts where the email
-- already matches one in the same location. Match is case-insensitive
-- on email (contacts has UNIQUE NOT NULL email; team_members.email
-- is free-text, may have casing variation).
UPDATE team_members tm
   SET contact_id = c.id
  FROM contacts c
  JOIN teams t ON t.id = tm.team_id
 WHERE tm.contact_id IS NULL
   AND tm.email IS NOT NULL
   AND lower(c.email) = lower(tm.email)
   AND c.location_id = t.location_id;

-- Step 2: for any team_member still unlinked + with an email,
-- create a fresh contact with lead_status='competition_competitor'
-- and link it. Insert one contact per unique (location_id, email)
-- pair to avoid double-creating when the same email appears across
-- multiple team_members.
WITH unlinked AS (
  SELECT DISTINCT ON (t.location_id, lower(tm.email))
    t.location_id,
    lower(tm.email) AS email_normalised,
    tm.email AS email_raw,
    tm.name
  FROM team_members tm
  JOIN teams t ON t.id = tm.team_id
  WHERE tm.contact_id IS NULL
    AND tm.email IS NOT NULL
  ORDER BY t.location_id, lower(tm.email), tm.joined_at DESC
),
inserted_contacts AS (
  INSERT INTO contacts (location_id, name, email, lead_status, source, lead_source, created_at, updated_at)
  SELECT
    u.location_id,
    COALESCE(u.name, 'Race competitor'),
    u.email_raw,
    'competition_competitor',
    'race_signup_backfill',
    'website',
    NOW(),
    NOW()
  FROM unlinked u
  ON CONFLICT (email) DO NOTHING
  RETURNING id, location_id, lower(email) AS email_normalised
)
UPDATE team_members tm
   SET contact_id = ic.id
  FROM inserted_contacts ic
  JOIN teams t ON t.location_id = ic.location_id
 WHERE tm.team_id = t.id
   AND tm.contact_id IS NULL
   AND lower(tm.email) = ic.email_normalised;

-- Step 3: any team_members rows STILL unlinked at this point have
-- emails that match a contact at a DIFFERENT location (the contacts
-- UNIQUE constraint on email blocked the insert in step 2). Link
-- them to the existing contact regardless of location — operators
-- can split later if needed.
UPDATE team_members tm
   SET contact_id = c.id
  FROM contacts c
 WHERE tm.contact_id IS NULL
   AND tm.email IS NOT NULL
   AND lower(c.email) = lower(tm.email);

COMMIT;
