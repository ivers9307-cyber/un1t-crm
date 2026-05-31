-- 224_membership_snapshots.sql
-- DASH-MEMBERSHIP.1 — monthly membership snapshot for the business board
-- 12-month trend.
--
-- The live breakdown (monthly recurring vs class packs vs payg) is read
-- straight from `contacts` on each dashboard load, so the headline cards
-- are always current. But a TREND needs history, and we keep no
-- point-in-time record of membership counts. This table stores one row
-- per location per month, written by the membership-snapshot cron. The
-- business dashboard's trend chart reads from here.
--
-- Starts capturing from the first cron run (baseline ~1 June 2026); the
-- trend line grows one point per month from there.

BEGIN;

CREATE TABLE IF NOT EXISTS membership_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  snapshot_date      date NOT NULL,
  monthly_recurring  integer NOT NULL DEFAULT 0,
  class_packs        integer NOT NULL DEFAULT 0,
  payg               integer NOT NULL DEFAULT 0,
  total_members      integer NOT NULL DEFAULT 0,
  active_recurring   integer NOT NULL DEFAULT 0,
  dead_packs         integer NOT NULL DEFAULT 0,
  detail             jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_membership_snapshots_loc_date
  ON membership_snapshots (location_id, snapshot_date DESC);

COMMENT ON TABLE membership_snapshots IS
  'Monthly point-in-time membership counts per location (DASH-MEMBERSHIP.1). Written by the membership-snapshot cron; read by the business dashboard 12-month trend chart. Live cards read contacts directly, not this table.';

INSERT INTO cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES ('membership-snapshot', 2678400, 172800,
        'Monthly membership snapshot for the business-board trend. Runs 1st of month 02:00 UTC; ~31d interval + 2d grace.')
ON CONFLICT (name) DO NOTHING;

COMMIT;
