# Review Carousel — Google Business reviews on the studio landing pages

**Status:** Design (pre-build) · **Date:** 2026-06-08 · **Surface:** `/welcome/[location]` public marketing pages

A native landing-page block that renders a continuous, auto-scrolling marquee
("wall of love") of a studio's Google reviews. Reviews are pulled from the
**Google Business Profile API** (owner-authorized), synced nightly into a local
table, auto-filtered to 4★+, and operator-curatable via a per-review hide
toggle. Closes the "reviews/reputation" category gap noted in the platform
roadmap.

## Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Data source | **Google Business Profile API** (owner OAuth) | Free + official; returns ALL reviews (paginated). Operator owns UN1T's listings. The official Places API hard-caps at 5 reviews — rejected. |
| Display style | **Continuous marquee strip** | Reads as abundance/social proof; modern; no arrows needed. |
| Curation | **Auto ≥ min rating (default 4★), newest first, text-only + per-review hide toggle** | Low ongoing effort with a safety net to suppress an odd review. |
| Refresh | **Nightly cron → local table; page reads table** | Fast public page, stays in quota, decouples build from Google's approval wait. |
| Aggregate header | **Yes** — "4.9 ★ · 127 Google reviews" | The headline number is often stronger proof than any single quote. |
| Connection scope | **Per-location** (mirrors `xero_connections`) | One OAuth grant per studio; consistent with the existing integration pattern. |

## Architecture

```
Google Business Profile  ──(owner OAuth, business.manage)──►  /api/cron/sync-google-reviews (daily)
                                                                       │  upsert by review id
                                                                       ▼
                                                              google_reviews (per-location table)
                                                                       ▲  SELECT visible, ≥min, text-only
   /welcome/[location]  ◄── CSS-only marquee ◄── `reviews` block renderer ◄┘
```

The public page **never calls Google at request time** — it reads `google_reviews`.
This keeps the marketing funnel fast (matches the perf posture for public pages),
stays well inside the Business Profile quota (300 QPM after approval), and
**decouples the entire UI build from Google's API-access approval timeline**: the
table is the contract, so the block, editor, and carousel all work the moment a
few rows exist (seeded or live).

### Reuse map (mirror existing patterns)

| New thing | Modeled on |
|---|---|
| `google_business_connections` table + token refresh | `xero_connections` (mig 029) + `src/lib/xero/client.js#withFreshToken` |
| `connect / callback / disconnect / status` routes | `src/app/api/xero/*` |
| Daily sync cron + heartbeat | `/api/cron/*` + `src/lib/cron-heartbeat.js` + `cron_heartbeats` row |
| `reviews` landing block | `BLOCK_TYPES` registry in `src/lib/landing-page-blocks.js` + `BlockRenderers.jsx` |
| Integration card on Settings → Integrations | `src/app/settings/integrations/` + `IntegrationsAdmin.jsx` |
| Public-read RLS for the page | `landing_page_settings` public-read policy |

## Data model (migration 249 — `249_google_business_reviews.sql`)

### `google_business_connections` (per-location OAuth, 1:1)

Mirrors `xero_connections` shape exactly.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `location_id` | uuid NOT NULL FK → locations, **UNIQUE** | one per location |
| `account_resource` | text NOT NULL | GBP account, e.g. `accounts/1234567890` |
| `location_resource` | text NOT NULL | the chosen GBP location, e.g. `accounts/123/locations/456` — the review-fetch key |
| `location_title` | text | display name of the Google listing |
| `access_token` | text NOT NULL | short-lived (~1h) |
| `refresh_token` | text NOT NULL | **rotates on refresh** — must persist every refresh (Xero gotcha) |
| `expires_at` | timestamptz NOT NULL | access_token expiry |
| `scopes` | text NOT NULL | space-separated; expect `https://www.googleapis.com/auth/business.manage` |
| `average_rating` | numeric(2,1) | snapshot from Google at last sync (drives the aggregate header) |
| `total_review_count` | int | snapshot from Google at last sync |
| `last_synced_at` | timestamptz | set by the cron on success |
| `connected_at` / `connected_by` / `last_refreshed_at` | | same as Xero; `last_refreshed_at` bumped by a BEFORE-UPDATE trigger when `access_token` changes |

RLS: `private.auth_is_in_location(location_id)` for SELECT + ALL (owner-write
mirror of Xero). No public read of the connection row (tokens are sensitive).

### `google_reviews` (synced review pool, per-location)

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `location_id` | uuid NOT NULL FK → locations | tenant scope |
| `google_review_id` | text NOT NULL | Google's review id/name; **UNIQUE(location_id, google_review_id)** for idempotent upsert |
| `rating` | smallint NOT NULL | 1–5, normalized from Google's `ONE`…`FIVE` enum |
| `comment` | text | review body (may be null → excluded from carousel) |
| `author_name` | text | reviewer display name |
| `author_photo_url` | text | reviewer avatar (nullable) |
| `review_time` | timestamptz | Google `createTime` — sort key (newest first) |
| `reply_comment` | text | owner reply, if any (not displayed in v1; stored for future) |
| `hidden` | boolean NOT NULL DEFAULT false | operator suppress toggle |
| `synced_at` | timestamptz NOT NULL DEFAULT now() | last upsert time |

Indexes: `UNIQUE(location_id, google_review_id)`; partial display index
`(location_id, review_time DESC) WHERE hidden = false AND comment IS NOT NULL`.

RLS: per-location member SELECT + a **public-read policy** (anon) so the
`/welcome/[location]` page can render via the browser/anon path if ever needed —
but note the page uses `createServerClient()` (service role) today, so public
read is defense-in-depth. Writes are service-role only (the cron).

Heartbeat: insert a `cron_heartbeats` row
`('sync-google-reviews', 86400, 14400)` (daily interval, 4h grace) in the same
migration so the health-check + Sentinel watch it automatically.

### `reviews` block schema (config, not data)

Added to `BLOCK_TYPES` in `src/lib/landing-page-blocks.js`. The block stores
**display config only** — the reviews themselves live in `google_reviews`.

```js
const REVIEWS_DEFAULT = () => ({
  id: newBlockId(),
  type: 'reviews',
  title: 'What our members say',
  min_rating: 4,          // 1–5, configurable
  show_aggregate: true,   // the "4.9 ★ · 127 reviews" header
  speed: 'normal',        // 'slow' | 'normal' | 'fast' marquee duration
})
```

No schema migration needed for the block — it rides in the existing
`landing_page_settings.blocks` JSONB (passthrough-validated). `blocksOrDefault`
already filters unknown types, so adding `reviews` to the registry is the only
gate.

## OAuth connection (mirror Xero)

- **Library:** `src/lib/google-business/client.js`
  - `buildAuthorizeUrl({ state })` — Google OAuth 2.0 consent URL, scope
    `business.manage`, `access_type=offline`, `prompt=consent` (to guarantee a
    refresh_token).
  - `exchangeAuthorizationCode(code)` → token set.
  - `withFreshToken(locationId)` → returns a valid access_token, transparently
    refreshing if `expires_at` is within ~60s and **persisting the rotated
    refresh_token** (Google rotates like Xero).
  - `listAccounts(accessToken)` / `listLocations(accessToken, accountResource)` —
    for the post-connect picker.
  - `listReviews(accessToken, locationResource, pageToken?)` — pages the
    **legacy `https://mybusiness.googleapis.com/v4/{location}/reviews`** endpoint
    (reviews were NOT migrated to the newer split Business Information API).
  - `GoogleBusinessError` class for typed failures.
- **Routes** (`src/app/api/google-business/`), all `runtime=nodejs`,
  owner/master only, IDOR-guarded by `location_id` like Xero:
  - `GET connect?location_id=` — signs `nonce.location_id` state, sets httpOnly
    cookie, redirects to Google.
  - `GET callback` — verifies state cookie, exchanges code, fetches accounts +
    locations, **stores the connection with the first location selected by
    default** and redirects to a picker if the account has >1 location (two gyms
    share one Google account, so the picker matters here — slight extension over
    Xero's "first tenant").
  - `POST select-location` — operator picks which GBP location maps to this CRM
    location (writes `location_resource` + `location_title`).
  - `POST disconnect` — deletes the connection row.
  - `GET status?location_id=` — safe subset (no tokens) for the settings card.
- **Env vars:** `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
  `GOOGLE_OAUTH_REDIRECT_URI=https://crm.un1tdublin.com/api/google-business/callback`.
  No silent fallbacks (per repo convention).
- **UI:** a Google Business card added to `IntegrationsAdmin.jsx` on
  `/settings/integrations`, next to Xero — Connect / status / location picker /
  "Sync now" / Disconnect.

## Sync job

`/api/cron/sync-google-reviews` (Vercel cron, daily; `maxDuration = 300`;
`Authorization: Bearer ${CRON_SECRET}`):

1. Load all `google_business_connections` rows.
2. For each: `withFreshToken(location_id)` → page `listReviews` (100/page via
   `nextPageToken`) until exhausted (cap with the standard pagination guard).
3. Normalize each review (rating enum → int; capture author, comment, time,
   reply) and **upsert by `(location_id, google_review_id)`** — idempotent across
   ticks; existing `hidden` flags are preserved (upsert must not reset `hidden`).
4. Snapshot `averageRating` + `totalReviewCount` onto the connection row; set
   `last_synced_at`.
5. `stampHeartbeat('sync-google-reviews')` on success.

Best-effort per connection (one studio's failure doesn't abort the others;
errors logged via `console.error`). Manual trigger: the "Sync now" button calls
the same runner for one location.

## The block + carousel

- New `reviews` case in `src/components/landing-page/BlockRenderers.jsx`.
- **Server-rendered, data passed down (no fetch inside the renderer):** the
  `StudioLandingPage` server component already loads the landing row (which
  carries `location_id`). When the blocks include a `reviews` block, the page
  reads that block's `min_rating`, queries `google_reviews` once
  (`WHERE hidden=false AND comment IS NOT NULL AND rating >= min_rating ORDER BY
  review_time DESC`, capped ~30) plus the connection's aggregate snapshot, and
  passes the result into `BlockRenderer` via a `reviewsData` prop. This keeps the
  renderer pure/synchronous (consistent with how other blocks render) and does
  exactly one DB read regardless of block count.
- **Aggregate header** (when `show_aggregate`): renders
  `average_rating ★ · total_review_count Google reviews` from the connection
  snapshot.
- **Marquee = pure CSS, zero client JS:** the track is duplicated and animated
  with `@keyframes` `translateX(-50%)`; `animation-duration` from `speed`;
  `:hover { animation-play-state: paused }`; wrapped in
  `@media (prefers-reduced-motion: reduce)` to disable the scroll (becomes a
  static, wrapping grid). Edge gradient fades match the dark theme.
- **Card:** gold stars, comment (clamped to ~4 lines), author name + photo, a
  subtle "Google" attribution mark.
- **Empty state:** if no connection or zero qualifying reviews, the block
  **renders nothing** — so a not-yet-configured studio (e.g. Hatch Street
  pre-launch) simply shows no section.
- **Mobile:** marquee is horizontal by nature; cards sized for small screens; the
  duplicated-track approach works identically.

## Curation / editor

In `LandingPageSettingsForm.jsx`, the `reviews` block editor exposes:

- `title` text, `min_rating` selector (1–5), `show_aggregate` toggle, `speed`
  selector.
- A **connection status line** ("Connected to *UN1T Stillorgan* · last synced 2h
  ago" / "Not connected → Settings → Integrations") + a **"Sync now"** button.
- A **list of synced reviews** (rating, author, comment preview) each with a
  **hide/show toggle** that flips `google_reviews.hidden` via a small
  `PATCH /api/google-reviews/[id]` (owner/manager with `landing_page` permission).

Editing the block uses the **existing `landing_page` permission** (no new
permission key). Connecting the integration uses the **owner/master role gate**
(same as Xero connect). **→ No new `WEB_PERMISSIONS` entry, so no mobile-parity
impact** (this is a web-only marketing surface anyway).

## Security / RLS / conventions

- Service-role routes enforce access in app code (`assertLocationAccess`) — never
  rely on RLS for a service-role query (per the IDOR lesson). Detail routes 404
  on cross-tenant ids.
- Connection tokens: per-location RLS, never returned by `status` (safe subset
  only). At-rest encryption via Supabase (pgcrypto layering is a future TODO,
  same as Xero).
- Standard response shape `{ success, data?, error?, issues? }`.
- New routes registered in `src/lib/openapi.js`.

## ToS / attribution

Per Google Business Profile terms: display reviewer name + photo, don't alter
review text, and attribute to Google. The card shows a "Google" mark; the
aggregate header names Google explicitly.

## Sequencing — the Google approval gate is the long pole

Google Business Profile API access starts at **0 QPM**; approval (verified GBP
60+ days + business website — UN1T qualifies) takes **days to weeks**. Plan:

1. **Day 1:** submit the GBP API access request in Google Cloud Console; create
   the OAuth client + consent screen.
2. **In parallel (not blocked):** build the migration, table, block, renderer,
   editor, and sync runner against `google_reviews`.
3. **Seed for QA:** a one-off script inserts ~6 sample rows so the carousel +
   editor can be visually verified before approval lands.
4. **On approval:** set env vars, connect via OAuth, pick the location, run the
   sync — live.

*(Optional, only if early live validation is wanted: a Places-API interim
provider returns 5 reviews with no approval, behind the same table contract.
Out of scope unless requested — adds a second provider.)*

## Testing (repo convention: pure-lib Vitest)

- `google-business/client.test.js`: rating-enum→int normalization, text-only +
  min-rating filter, token-refresh rotation persistence, authorize-URL shape.
- Sync runner: upsert idempotency, `hidden` preservation across re-sync,
  aggregate snapshot.
- Block: `blocksOrDefault` accepts `reviews`; default factory shape; marquee
  config → duration mapping (pure helper).
- Routes: connect/callback state-CSRF + IDOR guards; hide PATCH auth.
- Heartbeat presence: `sync-google-reviews` stamps on success.

## File-level change list

- **Migration:** `supabase/migrations/249_google_business_reviews.sql` (both
  tables + RLS + indexes + heartbeat row + refresh-ts trigger).
- **Lib:** `src/lib/google-business/client.js`, `src/lib/google-business/sync.js`,
  `+ tests`.
- **API:** `src/app/api/google-business/{connect,callback,select-location,disconnect,status}/route.js`,
  `src/app/api/google-reviews/[id]/route.js` (PATCH hide), `src/app/api/cron/sync-google-reviews/route.js`.
- **Block system:** edit `src/lib/landing-page-blocks.js` (registry + default);
  edit `src/components/landing-page/BlockRenderers.jsx` (renderer + `ReviewsMarquee`).
- **Editor:** edit `src/components/LandingPageSettingsForm.jsx` (reviews block
  controls + hide list + sync-now).
- **Integrations UI:** edit `src/app/settings/integrations/IntegrationsAdmin.jsx`
  (Google Business card).
- **Config:** `vercel.json` (cron entry); `src/lib/openapi.js` (route registration);
  env vars documented in CLAUDE.md.

## Out of scope (YAGNI)

- Live per-request fetching from Google.
- Replying to reviews from the CRM (read-only).
- Other review sources (Yelp / Facebook / Trustpilot).
- Hand-picking individual featured reviews (auto + hide chosen instead).
- Third-party embeddable widgets.
- Multi-currency / non-UN1T tenants (CCF Autos has no review use-case today).
