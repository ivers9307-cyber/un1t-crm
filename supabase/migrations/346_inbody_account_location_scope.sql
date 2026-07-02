-- INBODY location scoping (security audit W2-H / M1) — DATA-ONLY migration.
--
-- THE LEAK: the bridge routes under /api/bridge/inbody/* handed out and ingested
-- InBody webhook events (member phone `tel_hp`, body-scan data) with NO location
-- scoping. Any bridge token could pull every location's InBody scans. Latent
-- today (only Stillorgan runs a Pi) but a real cross-tenant breach the moment a
-- 2nd Pi ships.
--
-- THE FIX (code side, already landed): the webhook stores each event's `account`
-- (the Lookin'Body account id, e.g. "stillorganun1t"); the bridge routes scope
-- to the accounts configured for the bridge's location at
-- locations.settings.inbody.accounts — the same JSONB-config pattern Glofox uses
-- for settings.glofox.branch_id. inbody_backfill_requests already carries
-- location_id at create, so its routes scope directly on location_id.
--
-- THIS MIGRATION only touches DATA (no DDL — `settings` is already JSONB):
--   1. Canonicalise existing inbody_webhook_events.account (lower/trim) so the
--      code's normalised .in('account', …) filter matches historical rows.
--   2. Seed Stillorgan's InBody account config so its live bridge keeps a
--      non-empty pending queue (avoids the "filter returns nothing" trap).
--   3. Backfill location_id on existing events from that account→location map
--      (nice-to-have: keeps the events table self-describing; the routes no
--      longer depend on it for pending).
--
-- ORDERING: apply this BEFORE the scoping code deploys — otherwise the live
-- Stillorgan bridge sees an empty pending queue until the config exists.
--
-- Stillorgan location id: a0000000-0000-0000-0000-000000000001 (namespace
-- untstillorgan). InBody account: stillorganun1t (per the webhook sample +
-- InBody API-KEY setup page).

BEGIN;

-- 1. Canonicalise historical account values (idempotent).
UPDATE public.inbody_webhook_events
SET account = lower(btrim(account))
WHERE account IS NOT NULL
  AND account <> lower(btrim(account));

-- 2. Seed Stillorgan's InBody account config. Merge into existing settings so
--    we don't clobber settings.glofox / others. jsonb_set with create_missing.
UPDATE public.locations
SET settings = jsonb_set(
      coalesce(settings, '{}'::jsonb),
      '{inbody,accounts}',
      '["stillorganun1t"]'::jsonb,
      true
    )
WHERE id = 'a0000000-0000-0000-0000-000000000001'
  -- Only if not already configured, so re-running (or a later hand-edit) is safe.
  AND coalesce(settings #> '{inbody,accounts}', 'null'::jsonb) = 'null'::jsonb;

-- 3. Backfill location_id on existing (unstamped) events from the account map.
--    Driven off the config we just wrote so the map has a single source of truth.
UPDATE public.inbody_webhook_events e
SET location_id = l.id
FROM public.locations l
WHERE e.location_id IS NULL
  AND e.account IS NOT NULL
  AND l.settings #> '{inbody,accounts}' @> to_jsonb(e.account);

COMMIT;
