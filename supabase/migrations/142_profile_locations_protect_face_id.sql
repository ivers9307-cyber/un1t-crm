-- P2.2 — protect_face_id mapping for staff face-recognition.
--
-- Phase 2 of zero-touch attendance. The dark-launch receiver
-- (P2.1, mig 121) captures Protect alarm events but can't yet
-- map a face to a staff profile. This column closes that loop.
--
-- profile_locations already carries unifi_user_id (Access mapping
-- from mig 120). protect_face_id is its sibling for Protect's
-- face-library identifier. Two reasons they're siblings, not the
-- same column:
--   - Different external systems with independent rotation/
--     re-enrolment cadences (a card replacement doesn't change
--     the face id; a face re-enrolment doesn't change the card).
--   - One staff member might be enrolled in Access OR Protect or
--     both. Tracking them independently lets the receiver fall
--     back gracefully if one identifier is missing.
--
-- The receiver (P2.5) reads this column to resolve face_id →
-- profile_id at event time, then uses the existing
-- matchArrivalToShift logic shared with the Access receiver.

ALTER TABLE profile_locations
  ADD COLUMN IF NOT EXISTS protect_face_id TEXT;

-- Index supports the receiver's "find profile by face_id at this
-- location" lookup. Partial index — most rows have NULL until
-- the operator enrols staff.
CREATE INDEX IF NOT EXISTS idx_profile_locations_protect_face_id
  ON profile_locations (location_id, protect_face_id)
  WHERE protect_face_id IS NOT NULL;
