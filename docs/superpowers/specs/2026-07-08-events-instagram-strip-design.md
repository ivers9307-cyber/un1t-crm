# Instagram strip on the public events page — design

**Date:** 2026-07-08
**Feature key:** EVENTS-IG.1
**Status:** approved design → implementation plan next

## Goal

Add a swipeable carousel of a studio's latest Instagram posts/reels to the
public events page (`/[location]/events`) as **social proof** — "here's what's
happening at the gym" reinforcing the events listing. Auto-pulled from the
location's connected Instagram account; zero ongoing operator effort.

## Decisions (locked with Richard)

- **Post source:** AUTO — pull the latest posts/reels from the location's
  connected IG business account via the Graph API (not operator-curated).
- **Layout:** a horizontal, swipeable **carousel strip**; reels get a ▶ badge;
  tapping a tile opens the post on Instagram (new tab).
- **Placement:** below the events list (events stay the primary CTA).
- **Count:** latest ~10 shown (sync fetches ~12).
- **Refresh cadence:** ~every 6 hours (cron), not on page load.
- **Operator toggle:** a per-studio on/off switch (default ON when an IG
  account is connected).

## Existing infrastructure this builds on

- **`channel_connections`** (mig 230): per-location IG connection with
  `external_account_id` (**the IG business account id** — what `/media` needs),
  `page_id`, `access_token` (page token), `is_active`. Resolved via
  `resolveChannelConnection(locationId, 'instagram', db)` (`src/lib/agent/channels.js`).
  Already populated for the DM/inbox integration.
- **Public events page:** `src/app/welcome/[location]/events/page.js` (server
  component, `force-dynamic`) → renders `PublicEventsList`
  (`src/components/landing-page/`). Landing theme: `#lp-shell`, Poppins,
  dark. Resolves the studio via `landing_page_settings.public_path`.
- **CSP:** the app's only CSP header is `frame-ancestors *`, and it is **scoped to
  `/embed/*` + `/book/*`** — everything else, this page included, ships
  `X-Frame-Options: SAMEORIGIN`. There is no `img-src`/`script-src` anywhere in
  the app, so rendering IG media is unconstrained.
- **Media re-host precedent:** the estate already re-hosts inbound WhatsApp
  media to Supabase Storage because provider URLs expire/require auth. Same
  pattern here.

## Architecture — sync-and-cache (never fetch-on-load)

```
[cron every ~6h]  instagram-feed-sync
   for each location with an active IG channel_connections row:
     GET graph.facebook.com/v21.0/{external_account_id}/media
         ?fields=id,media_type,media_product_type,media_url,thumbnail_url,permalink,caption,timestamp&limit=12
     → normalizeIgMedia(response)            (pure, tested)
     → re-host each thumbnail → public bucket `instagram-feed`
     → upsert rows into `instagram_feed_posts` (onConflict location_id,ig_media_id)
     → prune this location's rows no longer in the latest set
     → stampHeartbeat('instagram-feed-sync') on overall success

[public request]  /welcome/[location]/events/page.js  (server component)
     → select latest ~10 instagram_feed_posts for this location, posted_at desc
     → pass to <InstagramStrip posts=… handle=… profileUrl=… />

[render]  InstagramStrip.jsx  (landing-page/, dark UN1T + Poppins)
     → horizontal carousel; reel tiles get ▶ badge
     → each tile = <a href={permalink} target="_blank" rel="noopener noreferrer">
     → header: "Follow @handle" linking to the IG profile
     → renders NOTHING when posts is empty
```

**Why re-host instead of storing IG URLs:** IG's `media_url`/`thumbnail_url`
are short-lived CDN links that expire within hours–days. Re-hosting to our own
public bucket means the strip never shows broken images and the public page
never depends on a live Graph call (fast + resilient).

## Data model

**New table `instagram_feed_posts`** (migration; RLS ON, no policy — the only
reader is the server component via the service-role client, like `event_hosts`):

| column           | type        | notes |
|------------------|-------------|-------|
| `id`             | uuid PK     | |
| `location_id`    | uuid FK→locations ON DELETE CASCADE | |
| `ig_media_id`    | text        | Instagram media id; UNIQUE (location_id, ig_media_id) |
| `media_type`     | text        | IMAGE / VIDEO / CAROUSEL_ALBUM |
| `is_reel`        | boolean     | derived: media_product_type='REELS' (or VIDEO) |
| `permalink`      | text        | the instagram.com post URL (tile link) |
| `caption`        | text NULL   | truncated (~140 chars) for alt/title |
| `thumb_path`     | text        | storage path in the `instagram-feed` bucket |
| `posted_at`      | timestamptz | from media `timestamp` |
| `fetched_at`     | timestamptz | last sync stamp |

Index on `(location_id, posted_at desc)` for the public read.

**New public Storage bucket `instagram-feed`** — public read (this is public
social content; unlike private WhatsApp media). Path e.g.
`{location_id}/{ig_media_id}.jpg`.

**`landing_page_settings.show_instagram_feed`** boolean, default `true` — the
operator on/off toggle per studio. The strip renders only when: the setting is
true AND the location has an active IG connection AND there are synced posts.

## New/changed files

- **Migration** — `instagram_feed_posts` + `landing_page_settings.show_instagram_feed` + a `cron_heartbeats` row for `instagram-feed-sync`. Applied via Supabase MCP; `get_advisors` after.
- **`src/lib/instagram-feed.js`** — `normalizeIgMedia(graphItems)` (pure: shape + reel detection + caption truncation, unit-tested) and `syncLocationIgFeed({ db, connection, storage })` (fetch → re-host → upsert → prune). Graph fetch isolated so it's mockable.
- **`src/app/api/cron/instagram-feed-sync/route.js`** — Bearer `CRON_SECRET`; iterates active IG connections; per-location try/catch; `stampHeartbeat` on success. Registered in `vercel.json`.
- **`src/components/landing-page/InstagramStrip.jsx`** — the carousel (client component; CSS scroll-snap, no external script).
- **`src/app/welcome/[location]/events/page.js`** — select the posts + toggle + render `<InstagramStrip>` below the list.
- **Settings UI** — a `show_instagram_feed` toggle wherever `landing_page_settings` is edited (landing/events settings surface).
- **Tests** — `instagram-feed.test.js` (normalize + sync with mocked Graph/storage/db), light `InstagramStrip` test.

## Feasibility + graceful fallback

The media pull needs the connection's page token to carry `instagram_basic`
(media read). The Meta Business login used for IG DMs very likely already
granted it. **Build-time check:** hit `/{external_account_id}/media` live once
during implementation to confirm. If the scope is missing, the cron logs it and
the strip simply stays empty — **no breakage** — until the connection is
re-authed with the scope. This is a flagged dependency, not a blocker for the
build.

## Error handling

- Cron: per-location `try/catch` — one studio's Graph/rate-limit failure never
  blocks the others. On a failed fetch we **keep the last-good cache** (never
  wipe rows on error). Heartbeat only on overall success.
- Re-host failure for a single image → skip that post, keep the rest.
- Public page: an empty or failed select → the section just doesn't render (no
  broken UI). `force-dynamic` already in place.
- Media-URL expiry is avoided entirely by re-hosting.

## Testing

- **Pure:** `normalizeIgMedia` — Graph item → row shape, reel detection
  (media_product_type/REELS vs VIDEO), caption truncation, missing-field
  tolerance.
- **Sync:** `syncLocationIgFeed` with a mocked Graph fetch + mocked
  storage/db — asserts upsert shape, prune of stale ids, per-location
  isolation, keep-last-good on fetch error.
- **Component:** renders N tiles, reel badge on reels, permalink href +
  `rel="noopener"`, empty → renders null.

## Scope / YAGNI (explicitly out)

- No operator curation/pinning/hiding of individual posts (auto-only; that's a
  possible v2).
- No inline video autoplay — tiles are thumbnails that link out to Instagram.
- One carousel per location (no multi-account mixing).
- Public web only — **not** the mobile app.
- No IG insights/analytics.

## Open items / dependencies

1. **Token scope** (`instagram_basic`) — verify live during the build; graceful
   empty-state if absent.
2. **@handle + profile URL** — derive from the connection (`display_name` /
   username) if available; otherwise a small settings field. Confirm during
   implementation which field carries the username.
3. Bucket creation is part of the migration/setup step.
