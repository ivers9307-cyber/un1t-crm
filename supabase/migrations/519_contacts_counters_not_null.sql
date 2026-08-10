-- 519 — contacts counter columns become NOT NULL.
--
-- FILTER-C.1. Every DATE field in the audience registry offers is_null /
-- is_not_null; the ten COUNTER fields below offer neither, so an operator can
-- ask "opened = 0" but not "opened is empty". That asymmetry is only safe if
-- the column cannot BE empty. All ten were declared `integer/bigint DEFAULT 0`
-- but NULLABLE, which left "never opened" split across two cohorts — one of
-- them unaskable and therefore invisible. That is the same NULL-dropping class
-- as COMMSFIX.B.1 (the 8-Aug sale email, 229 contacts silently excluded by a
-- bare `neq`) and FILTER-P1.2 (days_since_gt dropping never-attended contacts).
--
-- Two ways to close it: expose is_null on the counters, or make the NULL
-- impossible. The live evidence chose the second.
--
--   2026-08-10, project iyvtbjjxdggiadzwwvdj, 8,572 contacts:
--     total_emails_sent / _opened / _clicked        0 NULL
--     total_wa_sent / total_wa_received             0 NULL
--     total_bookings_30d / _attended_30d / _noshow_30d  0 NULL
--     lifetime_value_cents / lifetime_transaction_count 0 NULL
--
-- Zero NULLs, DEFAULT 0 on every one, and every writer already coalesces
-- (glofox-sync.js `?? 0`, glofox-invoices.js accumulators). So exposing
-- "opened is empty" would have shipped an operator-visible filter that matches
-- nobody and cannot explain why — a new trap of the same family. Pinning the
-- guarantee in the schema instead makes `= 0` the whole truth permanently, and
-- makes the *next* writer that would have introduced a NULL fail loudly at the
-- INSERT rather than quietly at audience time.
--
-- The two genuinely-nullable numbers are deliberately untouched and keep their
-- null operators: trial_credits_remaining (6,530 NULL — "no trial") and
-- glofox_membership_price_cents (4,886 NULL — "no membership"). Absence means
-- something there; on a counter it does not.
--
-- Rewrite cost: the UPDATEs are no-ops today and SET NOT NULL is a single
-- sequential scan of an 8.5k-row table. Forward-only; the backfill stays in
-- front of each ALTER so a row written between authoring and applying is
-- healed rather than blocking the migration.
--
-- src/lib/audience-filter.js records the guarantee per field as
-- `notNull: true`; audience-filter-counter-nullability.test.js fails if this
-- file and that registry disagree in either direction.

-- Email engagement counters (mig 005; total_emails_clicked backfilled by 508).
UPDATE contacts SET total_emails_sent = 0 WHERE total_emails_sent IS NULL;
ALTER TABLE contacts ALTER COLUMN total_emails_sent SET NOT NULL;

UPDATE contacts SET total_emails_opened = 0 WHERE total_emails_opened IS NULL;
ALTER TABLE contacts ALTER COLUMN total_emails_opened SET NOT NULL;

UPDATE contacts SET total_emails_clicked = 0 WHERE total_emails_clicked IS NULL;
ALTER TABLE contacts ALTER COLUMN total_emails_clicked SET NOT NULL;

-- WhatsApp message counters.
UPDATE contacts SET total_wa_sent = 0 WHERE total_wa_sent IS NULL;
ALTER TABLE contacts ALTER COLUMN total_wa_sent SET NOT NULL;

UPDATE contacts SET total_wa_received = 0 WHERE total_wa_received IS NULL;
ALTER TABLE contacts ALTER COLUMN total_wa_received SET NOT NULL;

-- Booking aggregates (GLOFOX2.1.14, mig 137) — refreshed by the Glofox sync.
UPDATE contacts SET total_bookings_30d = 0 WHERE total_bookings_30d IS NULL;
ALTER TABLE contacts ALTER COLUMN total_bookings_30d SET NOT NULL;

UPDATE contacts SET total_attended_30d = 0 WHERE total_attended_30d IS NULL;
ALTER TABLE contacts ALTER COLUMN total_attended_30d SET NOT NULL;

UPDATE contacts SET total_noshow_30d = 0 WHERE total_noshow_30d IS NULL;
ALTER TABLE contacts ALTER COLUMN total_noshow_30d SET NOT NULL;

-- Lifetime money aggregates (GLOFOX2.1.20, mig 140) — INVOICE_UPDATED webhook.
UPDATE contacts SET lifetime_value_cents = 0 WHERE lifetime_value_cents IS NULL;
ALTER TABLE contacts ALTER COLUMN lifetime_value_cents SET NOT NULL;

UPDATE contacts SET lifetime_transaction_count = 0 WHERE lifetime_transaction_count IS NULL;
ALTER TABLE contacts ALTER COLUMN lifetime_transaction_count SET NOT NULL;

COMMENT ON COLUMN contacts.total_emails_sent IS
  'Cumulative marketing/transactional emails sent. NOT NULL since mig 519 — "never sent" is 0, never NULL, which is why the audience registry offers no is_null operator on it.';
COMMENT ON COLUMN contacts.total_emails_opened IS
  'Cumulative Postmark Open events. NOT NULL since mig 519 — "never opened" is 0, never NULL.';
COMMENT ON COLUMN contacts.total_emails_clicked IS
  'Cumulative Postmark Click events (backfilled by mig 508). NOT NULL since mig 519 — "never clicked" is 0, never NULL.';
