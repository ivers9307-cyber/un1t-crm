-- ============================================================
-- 026: Cost line items on cars
--
-- The initial v1 only modelled UK purchase cost + VAT and the Irish
-- sale price. Real margin needs the per-vehicle ancillary costs:
-- UK transporter (UK delivery to port), ferry, Irish import customs,
-- NCT, and a free-form 'additional' bucket for one-off line items
-- (detailing, replacement tyres, etc.).
--
-- Stored as NUMERIC(10,2) — same shape as the existing price columns.
-- All default to NULL so existing rows aren't suddenly assumed to
-- have €0 of costs (which would inflate their profit number);
-- estimatedProfit() in src/lib/cars.js coerces NULL to 0 at compute
-- time, so the operator sees the same value they had before until
-- they explicitly fill these in.
--
-- additional_costs_label is a TEXT alongside additional_costs so the
-- operator can tag what the line was for ('detailing', 'tyres') — UI
-- shows it next to the value.
-- ============================================================

ALTER TABLE cars
  ADD COLUMN IF NOT EXISTS uk_transporter_cost     NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS ferry_cost              NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS import_customs_cost     NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS nct_cost                NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS additional_costs        NUMERIC(10, 2),
  ADD COLUMN IF NOT EXISTS additional_costs_label  TEXT;
