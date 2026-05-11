-- GLOFOX2.1.15 — pull Glofox interactions into the CRM activity timeline.
--
-- Glofox surfaces a per-lead interactions log via
-- /2.1/branches/{branchId}/leads/{userId}/interactions with types:
--   NOTE                    — operator wrote a note on the contact
--   CALLED_AND_CONNECTED    — outbound call, member answered
--   CALLED_AND_NO_ANSWER    — outbound call, no answer
--   MANUAL_EMAIL            — operator sent a one-off email
--
-- These are touchpoints the front-desk team logs directly in
-- Glofox while working on the member. Without sync they're
-- invisible to the CRM — marketing might call a member who was
-- chased by front-desk an hour ago, or vice-versa.
--
-- Two new columns on activities:
--   source                   — 'crm' (default) or 'glofox'.
--                              Lets the activity timeline UI mark
--                              Glofox-sourced rows visually so it's
--                              clear who the original system-of-
--                              record is.
--   glofox_interaction_id    — Glofox's _id for the interaction.
--                              UNIQUE so re-syncs are idempotent
--                              (we ON CONFLICT DO UPDATE on the
--                              description if it changed).
--
-- The CRM-side activity creation flow is unchanged — those rows
-- just have source='crm' and glofox_interaction_id=NULL.
--
-- Future commit (bidirectional): on CRM-side activity create,
-- POST to Glofox /interactions so front-desk staff see CRM-side
-- notes too.

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'crm';

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS glofox_interaction_id TEXT;

-- Partial unique index — only enforces uniqueness when the column
-- is set, so existing CRM-only rows (NULL) don't conflict.
CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_glofox_interaction_id
  ON activities (glofox_interaction_id)
  WHERE glofox_interaction_id IS NOT NULL;

-- Sanity check on source values.
ALTER TABLE activities
  DROP CONSTRAINT IF EXISTS activities_source_check;
ALTER TABLE activities
  ADD CONSTRAINT activities_source_check CHECK (source IN ('crm', 'glofox'));
