-- ============================================================
-- 025: Car Processing — standalone module for the Tesla import
--      side of the business (CCF Autos). Tracks each vehicle from
--      UK purchase → Irish sale, with the costs / VAT / buyer
--      details / supporting invoices needed to close out a deal.
--
-- Design notes:
--   - Location-scoped via the existing private.auth_is_in_location()
--     RLS pattern. The user runs this from their CCF Autos location.
--     Anyone outside that location's profile_locations link can't see
--     these records via PostgREST regardless of the web permission
--     toggle.
--   - The web permission `car_processing` (added in shared/permissions.js,
--     defaults to FALSE for every role) gates the UI sidebar entry and
--     page-level access. RLS is the security boundary; the permission
--     is just UI hygiene.
--   - status enum is checked via a CHECK constraint rather than a
--     Postgres enum so future statuses ('cancelled', 'returned'…)
--     don't require an enum migration.
-- ============================================================

CREATE TABLE IF NOT EXISTS cars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,

  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'pending', 'completed')),

  -- Vehicle identifiers (UK side, then Irish side once registered here).
  uk_reg TEXT,
  irish_reg TEXT,
  vin TEXT,
  make TEXT NOT NULL DEFAULT 'Tesla',
  model TEXT,
  vehicle_year INTEGER,

  -- UK purchase costs.
  uk_purchase_price_ex_vat NUMERIC(10, 2),
  uk_vat NUMERIC(10, 2),

  -- Irish sale prices. Both stored explicitly because Irish VAT
  -- applies to the margin scheme depending on how the vehicle was
  -- bought; we let the operator enter both figures and compute
  -- profit on the read side rather than enforcing a relationship.
  irish_sale_price_inc_vat NUMERIC(10, 2),
  irish_sale_price_ex_vat NUMERIC(10, 2),

  -- Buyer details — set when the car moves to 'pending'.
  buyer_name TEXT,
  buyer_email TEXT,
  buyer_phone TEXT,
  buyer_address TEXT,

  -- Xero integration (Phase B). The button in the UI calls
  -- /api/cars/[id]/issue-xero-invoice which currently returns a
  -- placeholder error; the columns are here so wiring the real call
  -- later doesn't need a schema migration.
  xero_invoice_id TEXT,
  xero_invoice_number TEXT,
  xero_invoice_url TEXT,
  xero_invoice_issued_at TIMESTAMPTZ,

  -- Confirmation flags. UK VAT refund is the major sticking point
  -- for closing a deal, so it's a first-class field rather than a
  -- check-box on a generic checklist.
  uk_vat_refund_received BOOLEAN NOT NULL DEFAULT FALSE,
  uk_vat_refund_received_at TIMESTAMPTZ,

  -- Free-form notes the operator can use for anything not modelled
  -- (delivery dates, customer agreements, etc.).
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cars_location_status
  ON cars(location_id, status);
CREATE INDEX IF NOT EXISTS idx_cars_status
  ON cars(status);

-- Per-document table — each row is one uploaded invoice / image
-- attached to a car. Multiple "other" docs are allowed; the named
-- types (NCT, Irish customs, BCA, transporter) are a soft
-- expectation enforced in the UI's promotion checklist, not the DB.
CREATE TABLE IF NOT EXISTS car_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  car_id UUID NOT NULL REFERENCES cars(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL
    CHECK (doc_type IN ('nct_invoice', 'irish_customs', 'bca_invoice', 'transporter', 'other')),
  storage_path TEXT NOT NULL,    -- key inside the car-documents bucket
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  uploaded_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_car_documents_car
  ON car_documents(car_id);
CREATE INDEX IF NOT EXISTS idx_car_documents_type
  ON car_documents(car_id, doc_type);

-- Trigger: bump cars.updated_at on every UPDATE. Reuses the
-- existing public.update_updated_at() function (added in 014).
DROP TRIGGER IF EXISTS cars_set_updated_at ON cars;
CREATE TRIGGER cars_set_updated_at
  BEFORE UPDATE ON cars
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at();

-- ============================================================
-- RLS — same pattern as every other tenant-data table:
--   - Service role bypasses (used by API routes server-side).
--   - Authenticated users can read/write only at locations they
--     belong to via profile_locations.
--   - Anon has no direct DB access.
-- ============================================================

ALTER TABLE cars ENABLE ROW LEVEL SECURITY;
ALTER TABLE car_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cars_location_scoped" ON cars;
CREATE POLICY "cars_location_scoped"
  ON cars
  FOR ALL
  TO authenticated
  USING (private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_in_location(location_id));

DROP POLICY IF EXISTS "car_documents_via_car" ON car_documents;
CREATE POLICY "car_documents_via_car"
  ON car_documents
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM cars c
      WHERE c.id = car_documents.car_id
        AND private.auth_is_in_location(c.location_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM cars c
      WHERE c.id = car_documents.car_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

-- ============================================================
-- Storage bucket for car_documents files. Private — all access
-- routes through the API using the service-role client which
-- bypasses storage RLS. We don't grant any direct read/write to
-- anon or authenticated, deliberately.
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('car-documents', 'car-documents', false)
ON CONFLICT (id) DO NOTHING;
