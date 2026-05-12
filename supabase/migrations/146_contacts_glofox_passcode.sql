-- GLOFOX3.5 — store the one-time Glofox passcode on the contact row
-- so the welcome-sequence merge tag {{glofox_passcode}} can read it.
--
-- generateGlofoxPasscode() (mig 143 / glofox.js) mints a fresh
-- 8-char passcode and doubles it as the initial Glofox password.
-- findOrCreateGlofoxMember writes it to glofox_push_events.passcode_sent
-- for forensic; this column makes it available at send time too.
--
-- TTL story: the passcode is cleared either after the welcome
-- sequence completes (handled by an enrolment hook) OR after 30 days
-- (a future cleanup cron — TODO). For now we just store it; a
-- never-cleared passcode is safe-ish because the operator can rotate
-- via Glofox UI anyway.
--
-- Not encrypted at rest — sits alongside email + phone + dob which
-- are all plaintext. If we ever upgrade contact-level encryption,
-- this column joins the others.

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS glofox_passcode TEXT;

COMMENT ON COLUMN contacts.glofox_passcode IS
  'GLOFOX3.5: one-time Glofox passcode minted at member-create time. Read by the welcome-sequence {{glofox_passcode}} merge tag. Cleared post-welcome (TODO: 30-day TTL cron).';
