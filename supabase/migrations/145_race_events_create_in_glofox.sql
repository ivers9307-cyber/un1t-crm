-- GLOFOX3.3 — opt-in flag on race_events (the events module, all
-- kinds — race / workshop / seminar / open_day / masterclass): when
-- true, every confirmed public registration on this event pushes
-- the registrant + every team_member with a contact to Glofox via
-- findOrCreateGlofoxMember (createIfMissing=true, attachTrial=true).
--
-- Default false: existing events untouched. Operator opts in per
-- event. For race kinds, the push covers EVERY team member (not
-- just the captain) — the registration form already collects
-- per-member email + we already create a CRM contact for each.
-- For non-race kinds, team_size is typically 1 and only the
-- registrant matters.
--
-- The push runs from /api/public/events/[slug]/register after the
-- registration row lands. Best-effort, fire-and-forget; failures
-- write to glofox_push_events for the Review tab (mig 143).

ALTER TABLE race_events
  ADD COLUMN IF NOT EXISTS create_in_glofox BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN race_events.create_in_glofox IS
  'GLOFOX3.3: when true, public registrations against this event push every team member to Glofox (search-and-link OR create + attach trial + welcome sequence).';
