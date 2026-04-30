-- ============================================================
-- 028: Per-car GBP→EUR FX rate
--
-- Profit estimate previously mixed currencies — UK ex-VAT and
-- UK transporter were stored in GBP but subtracted directly from
-- the EUR Irish sale price. Adding an explicit per-car rate so
-- the operator can capture what they actually paid (or expect to
-- pay) and the calc converts everything to EUR cleanly.
--
-- 4dp because FX rates routinely move in tenths of a cent and
-- rounding to 2dp would compound noticeably across a £30k
-- purchase. Default left NULL — UI falls back to a global default
-- constant in src/lib/cars.js (DEFAULT_GBP_TO_EUR) until the
-- operator enters their actual rate.
-- ============================================================

ALTER TABLE cars
  ADD COLUMN IF NOT EXISTS fx_gbp_to_eur NUMERIC(8, 4);
