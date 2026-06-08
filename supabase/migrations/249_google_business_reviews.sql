-- Review Carousel: Google Business Profile per-location OAuth + synced reviews.
--
-- google_business_connections mirrors xero_connections (mig 029): per-location
-- OAuth tokens, refresh_token rotates on every refresh. google_reviews holds the
-- synced review pool, one row per (location, google_review_id), with a per-review
-- `hidden` operator toggle. The public /welcome/[location] page reads google_reviews
-- via the service-role client; the public-read policy is defence-in-depth.

-- ── Connections ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS google_business_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  account_resource   text,                 -- e.g. accounts/1234567890
  location_resource  text,                 -- e.g. accounts/123/locations/456 (review-fetch key)
  location_title     text,                 -- display name of the Google listing
  access_token       text NOT NULL,
  refresh_token      text NOT NULL,
  expires_at         timestamptz NOT NULL,
  scopes             text NOT NULL DEFAULT '',
  average_rating     numeric(2,1),         -- snapshot from Google at last sync
  total_review_count integer,              -- snapshot from Google at last sync
  last_synced_at     timestamptz,
  sync_error         text,
  connected_at       timestamptz NOT NULL DEFAULT now(),
  connected_by       uuid REFERENCES profiles(id),
  last_refreshed_at  timestamptz,
  CONSTRAINT google_business_connections_one_per_location UNIQUE (location_id)
);

ALTER TABLE google_business_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS gbc_member_select ON google_business_connections;
CREATE POLICY gbc_member_select ON google_business_connections
  FOR SELECT USING (private.auth_is_in_location(location_id));

DROP POLICY IF EXISTS gbc_owner_write ON google_business_connections;
CREATE POLICY gbc_owner_write ON google_business_connections
  FOR ALL
  USING (private.auth_is_in_location(location_id))
  WITH CHECK (private.auth_is_in_location(location_id));

-- Bump last_refreshed_at whenever the access_token changes (mirror mig 029).
CREATE OR REPLACE FUNCTION private.bump_gbc_refresh_ts()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.access_token IS DISTINCT FROM OLD.access_token THEN
    NEW.last_refreshed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS gbc_refresh_ts ON google_business_connections;
CREATE TRIGGER gbc_refresh_ts
  BEFORE UPDATE ON google_business_connections
  FOR EACH ROW EXECUTE FUNCTION private.bump_gbc_refresh_ts();

-- ── Reviews ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS google_reviews (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id      uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  google_review_id text NOT NULL,
  rating           smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment          text,
  author_name      text,
  author_photo_url text,
  review_time      timestamptz,
  reply_comment    text,
  hidden           boolean NOT NULL DEFAULT false,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT google_reviews_unique_per_location UNIQUE (location_id, google_review_id)
);

-- Display index: the exact predicate the carousel query uses.
CREATE INDEX IF NOT EXISTS google_reviews_display_idx
  ON google_reviews (location_id, review_time DESC)
  WHERE hidden = false AND comment IS NOT NULL;

ALTER TABLE google_reviews ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS google_reviews_member_select ON google_reviews;
CREATE POLICY google_reviews_member_select ON google_reviews
  FOR SELECT USING (private.auth_is_in_location(location_id));

-- Public-read (anon) — defence-in-depth; the page uses the service-role client.
DROP POLICY IF EXISTS google_reviews_public_read ON google_reviews;
CREATE POLICY google_reviews_public_read ON google_reviews
  FOR SELECT TO anon USING (hidden = false AND comment IS NOT NULL);

-- ── Heartbeat row for the sync cron (mig 053 monitoring chain) ──
INSERT INTO cron_heartbeats (name, expected_interval_seconds, grace_seconds, last_ok_at)
VALUES ('sync-google-reviews', 86400, 14400, now())
ON CONFLICT (name) DO NOTHING;

COMMENT ON TABLE google_business_connections IS
  'Per-location Google Business Profile OAuth tokens. Mirrors xero_connections; tokens auto-refresh via src/lib/google-business/client.js.';
COMMENT ON TABLE google_reviews IS
  'Synced Google reviews per location. Filled by /api/cron/sync-google-reviews; rendered by the reviews landing-page block.';
