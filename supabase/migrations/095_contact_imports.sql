-- ============================================================
-- 095: Contact CSV import infrastructure
--
-- Two new tables drive the wizard at /contacts/imports:
--
--   contact_imports         — one row per batch
--   contact_import_rows     — one row per CSV row, post-resolution
--
-- The per-row table is what makes rollback possible: for UPDATE
-- rows we capture `before_snapshot` (the contact's prior values
-- limited to fields the import was authoritative for), which the
-- rollback path UPDATEs back. CREATE rows are reversed by deleting
-- the contacts whose `created_via_import_id` matches the batch.
--
-- Also adds `contacts.created_via_import_id` so any contact created
-- via a batch is traceable. Updated rows DO NOT get this stamped
-- (they predate the batch) — the import_rows table is the audit
-- record for those.
--
-- Master-only at the application layer (route guard). RLS on the
-- two new tables only allows SELECT for location members + INSERT
-- via the service-role server route, since rollback needs to
-- mutate contacts the caller might not normally have ownership of.
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS contact_imports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
  source_filename text,
  -- { csv_column_name: contact_field_name } as the operator confirmed
  -- in the wizard. Stored so a rollback or a later debug can replay
  -- the same mapping.
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Optional batch tag stamped on every contact in the import (added
  -- to contacts.tags). Used for retargeting like "tag this lead
  -- magnet list as cold_lead_jan26".
  batch_tag text,
  total_rows int NOT NULL DEFAULT 0,
  created_count int NOT NULL DEFAULT 0,
  updated_count int NOT NULL DEFAULT 0,
  skipped_count int NOT NULL DEFAULT 0,
  errored_count int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'rolling_back', 'rolled_back', 'failed')),
  rolled_back_at timestamptz,
  rolled_back_by uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_imports_location_created
  ON contact_imports (location_id, created_at DESC);

CREATE TABLE IF NOT EXISTS contact_import_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_id uuid NOT NULL REFERENCES contact_imports(id) ON DELETE CASCADE,
  -- 1-based row number from the CSV (header is row 0). Useful for
  -- the error CSV download which writes back the same row order.
  row_number int NOT NULL,
  action text NOT NULL CHECK (action IN ('created', 'updated', 'skipped', 'errored', 'rolled_back')),
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  -- Original CSV row, post-mapping (so if the operator mapped
  -- `Email Address` → `email`, raw_row.email is the value).
  raw_row jsonb NOT NULL,
  -- Previous values for `updated` rows, NULL for create / skipped /
  -- errored. Limited to the fields the import touched so rollback
  -- doesn't accidentally unset something the operator never wrote.
  before_snapshot jsonb,
  error_message text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_contact_import_rows_import_row
  ON contact_import_rows (import_id, row_number);
CREATE INDEX IF NOT EXISTS idx_contact_import_rows_contact
  ON contact_import_rows (contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS created_via_import_id uuid
  REFERENCES contact_imports(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_created_via_import
  ON contacts (created_via_import_id) WHERE created_via_import_id IS NOT NULL;

-- RLS — location members can read; only the service-role server
-- route writes. Master bypasses naturally (auth_is_master in the
-- helper functions).
ALTER TABLE contact_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_import_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view contact imports at their location"
  ON contact_imports FOR SELECT
  USING (
    private.auth_is_master() OR private.auth_is_in_location(location_id)
  );

CREATE POLICY "Members can view contact import rows for accessible batches"
  ON contact_import_rows FOR SELECT
  USING (
    private.auth_is_master() OR EXISTS (
      SELECT 1 FROM contact_imports ci
      WHERE ci.id = contact_import_rows.import_id
        AND private.auth_is_in_location(ci.location_id)
    )
  );

COMMENT ON TABLE contact_imports IS
  'Mig 095: one row per CSV import batch. Master-only writes (server-side route gate). Rollback capability via the rolled_back_* fields + per-row before_snapshot in contact_import_rows.';

COMMENT ON COLUMN contacts.created_via_import_id IS
  'Mig 095: stamped on contacts CREATED by a CSV import. UPDATE rows are NOT stamped — those predate the batch. Rollback uses this column to find contacts to delete.';

COMMIT;
