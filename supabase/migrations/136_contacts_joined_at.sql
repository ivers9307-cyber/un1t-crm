-- GLOFOX2.1.13 — contacts.joined_at for tenure-based audiences.
--
-- Glofox surfaces a `joined_at` field on the User schema:
--   "Represents the date when the user joined the location. Used
--    primarily for imports, integrations, and member transfers to
--    distinguish joining date (which can be set in the past) from
--    created_at (date in which a document was created in Mongo
--    set as today's date)."
--
-- Two semantically-distinct dates:
--   joined_at  — when this person became a member (can be backdated
--                during a CSV import — operator's source of truth)
--   created    — when the Glofox row was made (always 'today' at
--                row-creation time, useless for tenure)
--
-- The sync prefers joined_at and falls back to created (parsed as
-- Unix seconds) when joined_at is absent — common for members
-- created via the normal sign-up flow.
--
-- Powers audience filters like:
--   - "Members > 6 months" → anniversary campaigns
--   - "Members < 30 days" → onboarding nurture
--   - "Members joined in <month>" → cohort analysis

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ;

-- Index supports the typical "joined_at within range" audience
-- filter (days_since_gt / days_since_lt operators in
-- src/lib/audience-filter.js).
CREATE INDEX IF NOT EXISTS idx_contacts_joined_at ON contacts (joined_at);
