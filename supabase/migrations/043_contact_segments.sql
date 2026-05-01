-- Saved contact filters ("segments"). Operators build an advanced
-- filter on the /contacts page (using AudienceBuilder) and can save
-- it as a named segment for reuse — same shape that campaigns and
-- broadcasts already store as their `audience_filter`.
--
-- Per-location, no cross-tenant leakage. RLS mirrors the existing
-- pattern used for email_sequences / campaigns: any user with
-- access to the location can read; anyone with `email` permission
-- (or master) can write.

CREATE TABLE IF NOT EXISTS contact_segments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id   UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT,
  -- Same shape as campaigns.audience_filter / email_sequences.audience_filter.
  -- { logic: 'and' | 'or', filters: [{ field, op, value }] }
  filter        JSONB NOT NULL DEFAULT '{"logic":"and","filters":[]}'::JSONB,
  created_by    UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (location_id, name)
);

CREATE INDEX IF NOT EXISTS idx_contact_segments_location
  ON contact_segments (location_id);

ALTER TABLE contact_segments ENABLE ROW LEVEL SECURITY;

-- Same select pattern as email_sequences (mig 005): rows visible if
-- the caller has access to the segment's location. private.auth_is_master()
-- short-circuits for masters.
DROP POLICY IF EXISTS contact_segments_select ON contact_segments;
CREATE POLICY contact_segments_select ON contact_segments
  FOR SELECT
  USING (
    private.auth_is_master()
    OR private.auth_is_in_location(location_id)
  );

-- Write access: same as select. Permission gating (whether the user
-- has the 'email' permission) happens at the API layer; RLS just
-- enforces tenant isolation.
DROP POLICY IF EXISTS contact_segments_insert ON contact_segments;
CREATE POLICY contact_segments_insert ON contact_segments
  FOR INSERT
  WITH CHECK (
    private.auth_is_master()
    OR private.auth_is_in_location(location_id)
  );

DROP POLICY IF EXISTS contact_segments_update ON contact_segments;
CREATE POLICY contact_segments_update ON contact_segments
  FOR UPDATE
  USING (
    private.auth_is_master()
    OR private.auth_is_in_location(location_id)
  );

DROP POLICY IF EXISTS contact_segments_delete ON contact_segments;
CREATE POLICY contact_segments_delete ON contact_segments
  FOR DELETE
  USING (
    private.auth_is_master()
    OR private.auth_is_in_location(location_id)
  );

COMMENT ON TABLE contact_segments IS
  'Saved AudienceBuilder filters reusable from the /contacts page. JSON shape matches campaigns.audience_filter.';
