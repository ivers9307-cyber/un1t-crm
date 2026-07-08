-- EVENTS-IG.1 — Instagram feed cache for the public events-page strip.
-- Populated by the instagram-feed-sync cron from each location's connected IG
-- account (channel_connections, mig 230). Thumbnails are re-hosted to the
-- public `instagram-feed` storage bucket because IG CDN URLs expire.

CREATE TABLE IF NOT EXISTS public.instagram_feed_posts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id  uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  ig_media_id  text NOT NULL,
  ig_username  text,
  media_type   text,
  is_reel      boolean NOT NULL DEFAULT false,
  permalink    text NOT NULL,
  caption      text,
  thumb_path   text NOT NULL,
  posted_at    timestamptz,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, ig_media_id)
);

CREATE INDEX IF NOT EXISTS idx_instagram_feed_location_posted
  ON public.instagram_feed_posts (location_id, posted_at DESC);

-- RLS on, NO policy: the only reader is the events page via the service-role
-- client (which bypasses RLS). Mirrors event_hosts.
ALTER TABLE public.instagram_feed_posts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.instagram_feed_posts IS
  'Cached latest IG posts/reels per location for the public events-page strip (EVENTS-IG.1). Refreshed ~6h by the instagram-feed-sync cron; thumbnails re-hosted to the public instagram-feed bucket.';

-- Operator on/off toggle (default ON — shows when an IG account is connected + synced).
ALTER TABLE public.landing_page_settings
  ADD COLUMN IF NOT EXISTS show_instagram_feed boolean NOT NULL DEFAULT true;

-- Public storage bucket for the re-hosted thumbnails (public read; service-role writes).
INSERT INTO storage.buckets (id, name, public)
VALUES ('instagram-feed', 'instagram-feed', true)
ON CONFLICT (id) DO NOTHING;

-- Cron heartbeat row (6h interval, 2h grace — matches the vercel schedule).
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES ('instagram-feed-sync', 21600, 7200, 'EVENTS-IG.1 — refreshes the events-page Instagram strip cache')
ON CONFLICT (name) DO NOTHING;
