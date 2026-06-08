# Review Carousel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `reviews` landing-page block that renders a continuous CSS marquee of a studio's Google reviews, fed by an owner-OAuth Google Business Profile connection synced nightly into a local table, auto-filtered to ≥4★ with a per-review hide toggle.

**Architecture:** Google Business Profile (owner OAuth, mirrors the Xero per-location connection) → daily cron syncs reviews into `google_reviews` → the `/welcome/[location]` server page reads the table once and passes `reviewsData` into the block renderer → a pure-CSS marquee renders it. The public page never calls Google live, which decouples the whole UI build from Google's API-access approval lead time.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role server client), Vitest (pure-lib tests), Tailwind, lucide-react. Reuses repo conventions: `{ success, ... }` response shape, `createServerClient()`, `envOrThrow`, `stampHeartbeat`, the `BLOCK_TYPES` registry.

**Reference design:** `docs/REVIEW_CAROUSEL_DESIGN.md`.

**Build order rationale:** the migration + block + renderer + seed land first so the *visible* carousel is testable immediately (against seeded rows), before the Google OAuth + sync — which is gated on Google's days-to-weeks API-access approval.

---

### Conventions every task follows

- **supabase-js await caveat:** builders are thenables with no `.catch`. Use `try { await db... } catch {}`, never `await db...().catch()`.
- **Service-role routes enforce access in app code** (`assertLocationAccess`), never "RLS handles it". Detail routes 404 (not 403) on cross-tenant ids.
- **No new `WEB_PERMISSIONS` key** — editing the block uses the existing `landing_page` permission; connecting Google uses the owner/master role gate (mirrors Xero connect). So **no mobile-parity impact**.
- **Run the CI mirror before any commit that the task says to commit:** `npm test && npm run lint`. The final task runs the full mirror + `npm run build`.
- Tests are **pure-lib Vitest** (`src/lib/**/*.test.js`); React components get a build + manual-verify step, matching the repo's testing posture (no DOM test harness exists).

---

## Task 1: Migration — `google_business_connections` + `google_reviews`

**Files:**
- Create: `supabase/migrations/249_google_business_reviews.sql`

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/249_google_business_reviews.sql`:

```sql
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
```

- [ ] **Step 2: Apply the migration**

Apply via the Supabase MCP `apply_migration` tool (name `google_business_reviews`, the SQL above) OR paste into the Supabase SQL Editor. Migrations are forward-only.

Expected: success, no error.

- [ ] **Step 3: Run the security advisor**

Use the `get_advisors` MCP tool, `type=security`. Expected: no new ERROR-level findings for `google_business_connections` or `google_reviews` (RLS is enabled on both; the trigger function sets `search_path = ''`).

- [ ] **Step 4: Commit**

```bash
git add 'supabase/migrations/249_google_business_reviews.sql'
git commit -m "REVIEWS.1 — mig 249: google_business_connections + google_reviews tables"
```

---

## Task 2: Register the `reviews` block type

**Files:**
- Modify: `src/lib/landing-page-blocks.js`
- Test: `src/lib/landing-page-blocks.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `src/lib/landing-page-blocks.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  BLOCK_TYPES,
  newBlockOfType,
  blocksOrDefault,
  defaultBlocks,
} from './landing-page-blocks'

describe('reviews block type', () => {
  it('is registered in BLOCK_TYPES', () => {
    const reviews = BLOCK_TYPES.find((t) => t.type === 'reviews')
    expect(reviews).toBeTruthy()
    expect(reviews.label).toBe('Google reviews')
  })

  it('newBlockOfType("reviews") returns the config defaults', () => {
    const b = newBlockOfType('reviews')
    expect(b.type).toBe('reviews')
    expect(typeof b.id).toBe('string')
    expect(b.min_rating).toBe(4)
    expect(b.show_aggregate).toBe(true)
    expect(b.speed).toBe('normal')
    expect(b.title).toBe('What our members say')
  })

  it('blocksOrDefault keeps a saved reviews block (known type)', () => {
    const saved = [{ id: 'x', type: 'reviews', min_rating: 5 }]
    expect(blocksOrDefault(saved)).toHaveLength(1)
  })

  it('reviews is NOT in the default starter set', () => {
    expect(defaultBlocks().some((b) => b.type === 'reviews')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/landing-page-blocks.test.js`
Expected: FAIL — `reviews` not found in `BLOCK_TYPES`.

- [ ] **Step 3: Add the default factory and registry entry**

In `src/lib/landing-page-blocks.js`, add the factory right after `TESTIMONIAL_DEFAULT` (around line 105):

```js
const REVIEWS_DEFAULT = () => ({
  id:             newBlockId(),
  type:           'reviews',
  title:          'What our members say',
  min_rating:     4,        // 1–5; reviews below this are hidden
  show_aggregate: true,     // "4.9 ★ · 127 Google reviews" header
  speed:          'normal', // 'slow' | 'normal' | 'fast' marquee speed
})
```

Then add an entry to the `BLOCK_TYPES` array (after the `testimonial` entry, ~line 119):

```js
  { type: 'reviews',     label: 'Google reviews', description: 'Auto-scrolling marquee of your Google reviews.',       factory: REVIEWS_DEFAULT },
```

Do **not** add it to `defaultBlocks()` — operators add it explicitly.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/landing-page-blocks.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/landing-page-blocks.js src/lib/landing-page-blocks.test.js
git commit -m "REVIEWS.2 — register reviews block type + factory"
```

---

## Task 3: Pure helpers (rating normalize, filter, marquee duration)

**Files:**
- Create: `src/lib/google-business/reviews.js`
- Test: `src/lib/google-business/reviews.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/google-business/reviews.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  normalizeStarRating,
  normalizeReview,
  filterVisibleReviews,
  marqueeDurationSeconds,
} from './reviews'

describe('normalizeStarRating', () => {
  it('maps the Google word enum to 1–5', () => {
    expect(normalizeStarRating('ONE')).toBe(1)
    expect(normalizeStarRating('THREE')).toBe(3)
    expect(normalizeStarRating('FIVE')).toBe(5)
  })
  it('returns 0 for unknown/empty so it is filtered out downstream', () => {
    expect(normalizeStarRating('STAR_RATING_UNSPECIFIED')).toBe(0)
    expect(normalizeStarRating(null)).toBe(0)
  })
})

describe('normalizeReview', () => {
  it('flattens a Google v4 review into our row shape', () => {
    const row = normalizeReview({
      reviewId: 'abc',
      starRating: 'FIVE',
      comment: 'Best gym ever',
      createTime: '2026-05-01T10:00:00Z',
      reviewer: { displayName: 'Aoife M.', profilePhotoUrl: 'http://x/p.jpg' },
      reviewReply: { comment: 'Thanks!' },
    })
    expect(row).toMatchObject({
      google_review_id: 'abc',
      rating: 5,
      comment: 'Best gym ever',
      author_name: 'Aoife M.',
      author_photo_url: 'http://x/p.jpg',
      reply_comment: 'Thanks!',
      review_time: '2026-05-01T10:00:00Z',
    })
  })
  it('tolerates missing reviewer / reply / comment', () => {
    const row = normalizeReview({ reviewId: 'z', starRating: 'FOUR', createTime: '2026-01-01T00:00:00Z' })
    expect(row.rating).toBe(4)
    expect(row.comment).toBeNull()
    expect(row.author_name).toBeNull()
    expect(row.reply_comment).toBeNull()
  })
})

describe('filterVisibleReviews', () => {
  const rows = [
    { rating: 5, comment: 'great', hidden: false },
    { rating: 3, comment: 'meh', hidden: false },          // below min
    { rating: 5, comment: null, hidden: false },           // no text
    { rating: 5, comment: 'hidden one', hidden: true },    // hidden
    { rating: 4, comment: 'solid', hidden: false },
  ]
  it('keeps only text reviews at/above min rating and not hidden', () => {
    const out = filterVisibleReviews(rows, 4)
    expect(out.map((r) => r.comment)).toEqual(['great', 'solid'])
  })
  it('defaults min rating to 4 when not a number', () => {
    expect(filterVisibleReviews(rows, undefined)).toHaveLength(2)
  })
})

describe('marqueeDurationSeconds', () => {
  it('scales with count and speed', () => {
    expect(marqueeDurationSeconds('normal', 6)).toBe(36) // 6 per card * 6
    expect(marqueeDurationSeconds('slow', 6)).toBe(54)   // 9 * 6
    expect(marqueeDurationSeconds('fast', 6)).toBe(24)   // 4 * 6
  })
  it('has a sane floor so a single card still scrolls', () => {
    expect(marqueeDurationSeconds('normal', 1)).toBe(12)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/google-business/reviews.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

Create `src/lib/google-business/reviews.js`:

```js
// Pure helpers for normalizing + filtering Google reviews and sizing the
// marquee. No IO — unit-tested in reviews.test.js.

const STAR_WORDS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }

// Google v4 reviews return starRating as a word enum (ONE..FIVE) or
// STAR_RATING_UNSPECIFIED. Map to an int; 0 means "drop it".
export function normalizeStarRating(word) {
  return STAR_WORDS[word] || 0
}

// Flatten a Google v4 review object into our google_reviews row shape.
// Returns null rating 0 reviews are filtered by the sync caller.
export function normalizeReview(r) {
  return {
    google_review_id: r.reviewId || r.name || null,
    rating:           normalizeStarRating(r.starRating),
    comment:          r.comment || null,
    author_name:      r.reviewer?.displayName || null,
    author_photo_url: r.reviewer?.profilePhotoUrl || null,
    review_time:      r.createTime || null,
    reply_comment:    r.reviewReply?.comment || null,
  }
}

// The carousel predicate, applied in JS so the renderer and tests share it.
export function filterVisibleReviews(rows, minRating) {
  const min = Number.isFinite(minRating) ? minRating : 4
  return (Array.isArray(rows) ? rows : []).filter(
    (r) => !r.hidden && r.comment && r.rating >= min
  )
}

// Marquee scroll duration. Longer track (more cards) → longer duration so
// the px/sec speed stays roughly constant. Floor keeps a 1-card strip moving.
const SECONDS_PER_CARD = { slow: 9, normal: 6, fast: 4 }
export function marqueeDurationSeconds(speed, count) {
  const per = SECONDS_PER_CARD[speed] || SECONDS_PER_CARD.normal
  return Math.max(per * 2, per * (count || 0))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/google-business/reviews.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/google-business/reviews.js src/lib/google-business/reviews.test.js
git commit -m "REVIEWS.3 — pure helpers: rating normalize, visible filter, marquee duration"
```

---

## Task 4: Seed script for visual QA

**Files:**
- Create: `scripts/seed-google-reviews.mjs`

This lets the carousel be verified before Google approval lands. It inserts sample rows for one location.

- [ ] **Step 1: Write the seed script**

Create `scripts/seed-google-reviews.mjs`:

```js
// One-off QA seed: inserts sample google_reviews rows for a location so the
// carousel can be verified before the live Google sync exists.
//
//   node scripts/seed-google-reviews.mjs <location_id>
//
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the env
// (same as the app). Idempotent — upserts by (location_id, google_review_id).

import { createClient } from '@supabase/supabase-js'

const locationId = process.argv[2]
if (!locationId) {
  console.error('Usage: node scripts/seed-google-reviews.mjs <location_id>')
  process.exit(1)
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const db = createClient(url, key)

const SAMPLES = [
  { author_name: 'Aoife M.', rating: 5, comment: "Best gym I've trained at. The coaches actually care and the S&C programming is next level." },
  { author_name: 'Daniel K.', rating: 5, comment: '3x a week completely changed my fitness. Coach-led classes keep me accountable.' },
  { author_name: 'Sarah B.', rating: 5, comment: 'Brilliant community and the strength programming is no joke. Down 8kg in 3 months.' },
  { author_name: 'Mark R.', rating: 4, comment: 'Top class facility, friendly staff, never a boring session.' },
  { author_name: 'Niamh O.', rating: 5, comment: 'Genuinely look forward to every session. Coaching is excellent.' },
  { author_name: 'Conor D.', rating: 5, comment: 'Hyrox-style training that actually prepares you for race day.' },
]

const rows = SAMPLES.map((s, i) => ({
  location_id: locationId,
  google_review_id: `seed-${i + 1}`,
  rating: s.rating,
  comment: s.comment,
  author_name: s.author_name,
  author_photo_url: null,
  review_time: new Date(Date.now() - i * 86400000).toISOString(),
  hidden: false,
}))

const { error } = await db
  .from('google_reviews')
  .upsert(rows, { onConflict: 'location_id,google_review_id' })

if (error) {
  console.error('Seed failed:', error.message)
  process.exit(1)
}
console.log(`Seeded ${rows.length} reviews for location ${locationId}.`)
```

- [ ] **Step 2: Find a location id and run the seed**

Get the Stillorgan location id (Supabase SQL Editor: `select id, name from locations order by name;`). Then run from `un1t-crm/`:

```bash
node scripts/seed-google-reviews.mjs <stillorgan-location-id>
```

Expected: `Seeded 6 reviews for location <id>.`

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-google-reviews.mjs
git commit -m "REVIEWS.4 — QA seed script for google_reviews"
```

---

## Task 5: Reviews renderer (CSS marquee) + page wiring

**Files:**
- Modify: `src/components/landing-page/BlockRenderers.jsx` (add renderer + dispatch + forward `reviewsData`)
- Modify: `src/app/welcome/[location]/page.js` (fetch reviews + aggregate, pass `reviewsData`)
- Modify: `src/app/globals.css` (marquee keyframes)

- [ ] **Step 1: Add the marquee keyframes**

Append to `src/app/globals.css`:

```css
/* Review carousel marquee — duplicated track translated -50% so it loops
   seamlessly. Duration set inline per block. Pauses on hover; disabled for
   reduced-motion users (track wraps to a static grid instead). */
@keyframes reviews-marquee {
  from { transform: translateX(0); }
  to   { transform: translateX(-50%); }
}
.reviews-marquee-track {
  display: flex;
  width: max-content;
  animation: reviews-marquee linear infinite;
}
.reviews-marquee-viewport:hover .reviews-marquee-track {
  animation-play-state: paused;
}
@media (prefers-reduced-motion: reduce) {
  .reviews-marquee-track {
    animation: none;
    flex-wrap: wrap;
    width: 100%;
    justify-content: center;
  }
}
```

- [ ] **Step 2: Add the renderer + dispatch case in BlockRenderers.jsx**

In `src/components/landing-page/BlockRenderers.jsx`:

(a) Change the `BlockRenderer` signature to accept `reviewsData` (line 38) and add a `reviews` case to the switch (after the `testimonial` case, line 58):

```jsx
export default function BlockRenderer({ block, onEdit, locationId, publicPath, reviewsData }) {
```

```jsx
    case 'testimonial': return <TestimonialBlock block={block} onEdit={localOnEdit} />
    case 'reviews':     return <ReviewsBlock     block={block} onEdit={localOnEdit} reviewsData={reviewsData} />
```

(b) Add the imports for the helper + stars at the top (after the existing imports, ~line 20):

```jsx
import { filterVisibleReviews, marqueeDurationSeconds } from '@/lib/google-business/reviews'
```

(c) Add the renderer component (place after `TestimonialBlock`, ~line 423):

```jsx
// Reviews — continuous CSS marquee of Google reviews. Data is passed down
// from the page (reviewsData = { reviews: [...], averageRating, totalCount });
// the renderer itself does no fetching, so it stays pure + server-safe.
//
// Edit mode (onEdit set, inside the settings iframe) has no live reviewsData —
// show a small placeholder so the operator knows where the section lands.
export function ReviewsBlock({ block, onEdit, reviewsData }) {
  const minRating = Number.isFinite(block.min_rating) ? block.min_rating : 4
  const all = reviewsData?.reviews || []
  const visible = filterVisibleReviews(all, minRating)

  if (visible.length === 0) {
    if (!onEdit) return null
    return (
      <section className="bg-black text-white py-20 md:py-28 border-t border-white/10">
        <div className="max-w-6xl mx-auto px-6 text-center text-white/40 text-sm border border-dashed border-white/20 rounded py-10">
          Google reviews appear here on the live page (connect Google Business in
          Settings → Locations → Integrations, then sync).
        </div>
      </section>
    )
  }

  const duration = marqueeDurationSeconds(block.speed, visible.length)
  // Duplicate the track so translateX(-50%) loops seamlessly.
  const track = [...visible, ...visible]

  return (
    <section className="bg-black text-white py-20 md:py-28 border-t border-white/10 overflow-hidden">
      <div className="max-w-6xl mx-auto px-6">
        {(block.title || block.show_aggregate) && (
          <div className="text-center mb-10">
            {block.title && (
              <h2 className="text-2xl md:text-3xl font-black tracking-tight">{block.title}</h2>
            )}
            {block.show_aggregate && reviewsData?.averageRating != null && (
              <p className="mt-2 text-sm text-white/60">
                <span className="text-amber-400">★</span>{' '}
                <span className="text-white/90 font-semibold">
                  {Number(reviewsData.averageRating).toFixed(1)}
                </span>
                {reviewsData.totalCount != null && <> · {reviewsData.totalCount} Google reviews</>}
              </p>
            )}
          </div>
        )}
      </div>
      <div className="reviews-marquee-viewport relative">
        <div
          className="reviews-marquee-track gap-4 px-2"
          style={{ animationDuration: `${duration}s` }}
        >
          {track.map((r, i) => (
            <ReviewCard key={`${r.id || r.google_review_id || i}-${i}`} review={r} />
          ))}
        </div>
        {/* Edge fades */}
        <div className="pointer-events-none absolute inset-y-0 left-0 w-16 bg-gradient-to-r from-black to-transparent" aria-hidden="true" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-black to-transparent" aria-hidden="true" />
      </div>
    </section>
  )
}

function ReviewCard({ review }) {
  const stars = '★★★★★'.slice(0, Math.max(0, Math.min(5, review.rating || 0)))
  return (
    <figure className="w-72 shrink-0 bg-white/[0.04] border border-white/10 rounded-xl p-5">
      <div className="text-amber-400 text-sm tracking-[0.15em]" aria-label={`${review.rating} out of 5`}>{stars}</div>
      <blockquote className="mt-3 text-sm leading-relaxed text-white/85 line-clamp-5">
        {review.comment}
      </blockquote>
      <figcaption className="mt-4 flex items-center gap-2 text-xs text-white/55">
        {review.author_photo_url ? (
           
          <img src={review.author_photo_url} alt="" className="w-6 h-6 rounded-full object-cover" loading="lazy" />
        ) : null}
        <span className="text-white/75 font-medium">{review.author_name || 'Google user'}</span>
        <span className="ml-auto inline-flex items-center gap-1 text-white/40">
          <span className="text-[#4285F4] font-bold">G</span> Google
        </span>
      </figcaption>
    </figure>
  )
}
```

> Note: `line-clamp-5` requires the `@tailwindcss/line-clamp` plugin (built into Tailwind 3.3+; this repo is on 3.4 so it is available with no config).

- [ ] **Step 3: Wire the page to fetch reviews + pass `reviewsData`**

In `src/app/welcome/[location]/page.js`, inside `StudioLandingPage`, after `const blocks = blocksOrDefault(row.blocks)` (line 78) add a reviews fetch that only runs when a reviews block is present:

```jsx
  // Reviews carousel data — only query when the page actually has a reviews
  // block. One read for the whole page; the renderer filters/sizes in JS.
  let reviewsData = null
  const reviewsBlock = blocks.find((b) => b.type === 'reviews')
  if (reviewsBlock && row.location_id) {
    const db = createServerClient()
    const minRating = Number.isFinite(reviewsBlock.min_rating) ? reviewsBlock.min_rating : 4
    const [{ data: reviews }, { data: conn }] = await Promise.all([
      db.from('google_reviews')
        .select('id, google_review_id, rating, comment, author_name, author_photo_url, review_time, hidden')
        .eq('location_id', row.location_id)
        .eq('hidden', false)
        .gte('rating', minRating)
        .not('comment', 'is', null)
        .order('review_time', { ascending: false })
        .limit(30),
      db.from('google_business_connections')
        .select('average_rating, total_review_count')
        .eq('location_id', row.location_id)
        .maybeSingle(),
    ])
    reviewsData = {
      reviews: reviews || [],
      averageRating: conn?.average_rating ?? null,
      totalCount: conn?.total_review_count ?? null,
    }
  }
```

Then pass it into the block map (line 101-103):

```jsx
      {blocks.map((block) => (
        <BlockRenderer key={block.id} block={block} reviewsData={reviewsData} />
      ))}
```

> The `?edit=1` preview path renders `<EditModeOverlay>` (a separate client component) — it does NOT receive `reviewsData`, so the reviews block shows the edit-mode placeholder there. That's intended; the live page shows the real carousel.

- [ ] **Step 4: Build + manually verify**

```bash
npm run build
```
Expected: build succeeds (no import-resolution errors).

Then `npm run dev` and open `http://localhost:3000/welcome/<public_path>` for the seeded location (find `public_path` via `select public_path from landing_page_settings;`). First add a reviews block to that landing row — quickest for QA is SQL:

```sql
update landing_page_settings
set blocks = blocks || jsonb_build_array(jsonb_build_object(
  'id', gen_random_uuid()::text, 'type', 'reviews',
  'title', 'What our members say', 'min_rating', 4,
  'show_aggregate', true, 'speed', 'normal'))
where public_path = '<public_path>';
```

Expected: a dark auto-scrolling marquee of the 6 seeded reviews with star ratings, pausing on hover.

- [ ] **Step 5: Commit**

```bash
git add src/components/landing-page/BlockRenderers.jsx 'src/app/welcome/[location]/page.js' src/app/globals.css
git commit -m "REVIEWS.5 — reviews marquee renderer + welcome page data wiring"
```

---

## Task 6: Reviews block config panel in the editor

**Files:**
- Modify: `src/components/LandingPageSettingsForm.jsx` (add a `reviews` case to `BlockEditPanel`)

- [ ] **Step 1: Locate `BlockEditPanel`**

In `src/components/LandingPageSettingsForm.jsx`, find the `BlockEditPanel` function (the per-type field editor referenced in the header comment, "add a case to BlockEditPanel below"). It switches on `block.type` and renders inputs that call an `update(path, value)` helper.

- [ ] **Step 2: Add the `reviews` case**

Add this case to the `BlockEditPanel` switch (match the surrounding cases' field markup — this uses plain inputs; adjust class names to match the neighbours, e.g. the `embed`/`stats` cases):

```jsx
      case 'reviews':
        return (
          <div className="space-y-3">
            <label className="block">
              <span className="text-xs text-un1t-subtle">Heading</span>
              <input
                type="text"
                value={block.title || ''}
                onChange={(e) => update(['title'], e.target.value)}
                className="mt-1 w-full bg-un1t-bg/30 border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text"
              />
            </label>
            <label className="block">
              <span className="text-xs text-un1t-subtle">Minimum star rating to show</span>
              <select
                value={block.min_rating ?? 4}
                onChange={(e) => update(['min_rating'], Number(e.target.value))}
                className="mt-1 w-full bg-un1t-bg/30 border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text"
              >
                {[5, 4, 3, 2, 1].map((n) => (
                  <option key={n} value={n}>{n}★ and up</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-un1t-subtle">Marquee speed</span>
              <select
                value={block.speed || 'normal'}
                onChange={(e) => update(['speed'], e.target.value)}
                className="mt-1 w-full bg-un1t-bg/30 border border-un1t-border rounded-md px-3 py-1.5 text-sm text-un1t-text"
              >
                <option value="slow">Slow</option>
                <option value="normal">Normal</option>
                <option value="fast">Fast</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={block.show_aggregate !== false}
                onChange={(e) => update(['show_aggregate'], e.target.checked)}
              />
              <span className="text-xs text-un1t-subtle">Show the “4.9 ★ · N Google reviews” header</span>
            </label>
            <p className="text-[11px] text-un1t-muted">
              Reviews come from your Google Business listing. Connect it and hide
              specific reviews in <strong>Settings → Locations → Integrations</strong>.
            </p>
          </div>
        )
```

> Confirm the helper name (`update` vs another) and field-wrapper markup by matching the adjacent `embed`/`stats` cases — reuse whatever they use so styling stays consistent.

- [ ] **Step 3: Build + manually verify**

```bash
npm run build
```
Expected: success.

`npm run dev`, open the landing-page editor (`/settings/locations/<id>` → Landing page, or the per-location landing editor), add a **Google reviews** section, confirm the four config fields appear and edits persist on save.

- [ ] **Step 4: Commit**

```bash
git add src/components/LandingPageSettingsForm.jsx
git commit -m "REVIEWS.6 — reviews block config panel (title/min rating/speed/aggregate)"
```

---

## Task 7: Google Business OAuth client

**Files:**
- Create: `src/lib/google-business/client.js`
- Test: `src/lib/google-business/client.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/google-business/client.test.js`:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildAuthorizeUrl, GoogleBusinessError } from './client'

beforeEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = 'cid'
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'secret'
  process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://crm.test/api/google-business/callback'
})

describe('buildAuthorizeUrl', () => {
  it('includes offline access + consent prompt + business.manage scope', () => {
    const url = new URL(buildAuthorizeUrl({ state: 'nonce.loc' }))
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('scope')).toContain('business.manage')
    expect(url.searchParams.get('state')).toBe('nonce.loc')
    expect(url.searchParams.get('client_id')).toBe('cid')
  })
})

describe('GoogleBusinessError', () => {
  it('carries status + body', () => {
    const e = new GoogleBusinessError('boom', { status: 401, body: { x: 1 } })
    expect(e.name).toBe('GoogleBusinessError')
    expect(e.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/google-business/client.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client**

Create `src/lib/google-business/client.js`:

```js
// Hand-rolled Google OAuth 2.0 + Business Profile client. Mirrors the Xero
// client (src/lib/xero/client.js): withFreshToken() refreshes + persists the
// rotated token, then hands callers a Bearer-authenticated fetch helper.
//
// Reviews live on the LEGACY v4 endpoint (mybusiness.googleapis.com/v4); the
// newer split APIs (Account Management, Business Information) host accounts +
// locations. All three are reachable with the business.manage scope.

import { createServerClient } from '@/lib/supabase'

const GOOGLE_AUTH_URL  = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const GBP_SCOPE        = 'https://www.googleapis.com/auth/business.manage'
const REFRESH_BUFFER_MS = 60 * 1000

export class GoogleBusinessError extends Error {
  constructor(message, { status, body, cause } = {}) {
    super(message)
    this.name = 'GoogleBusinessError'
    this.status = status
    this.body = body
    if (cause) this.cause = cause
  }
}

function envOrThrow(name) {
  const v = process.env[name]
  if (!v) throw new GoogleBusinessError(`Missing required env var: ${name}`)
  return v
}

export function getGoogleClientCreds() {
  return {
    clientId: envOrThrow('GOOGLE_OAUTH_CLIENT_ID'),
    clientSecret: envOrThrow('GOOGLE_OAUTH_CLIENT_SECRET'),
    redirectUri: envOrThrow('GOOGLE_OAUTH_REDIRECT_URI'),
  }
}

export function buildAuthorizeUrl({ state }) {
  const { clientId, redirectUri } = getGoogleClientCreds()
  const u = new URL(GOOGLE_AUTH_URL)
  u.searchParams.set('response_type', 'code')
  u.searchParams.set('client_id', clientId)
  u.searchParams.set('redirect_uri', redirectUri)
  u.searchParams.set('scope', GBP_SCOPE)
  u.searchParams.set('state', state)
  u.searchParams.set('access_type', 'offline') // issue a refresh_token
  u.searchParams.set('prompt', 'consent')      // force refresh_token re-issue on reconnect
  return u.toString()
}

async function tokenRequest(params) {
  const { clientId, clientSecret } = getGoogleClientCreds()
  const body = new URLSearchParams({ ...params, client_id: clientId, client_secret: clientSecret })
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new GoogleBusinessError(`Google token request failed: ${res.status}`, { status: res.status, body: json })
  }
  return json
}

export function exchangeAuthorizationCode(code) {
  const { redirectUri } = getGoogleClientCreds()
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
}

export function refreshAccessToken(refreshToken) {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
}

async function apiGet(accessToken, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new GoogleBusinessError(`Google API ${res.status} on ${url}`, { status: res.status, body: json })
  }
  return json
}

// Account Management API — the accounts this token can manage.
export async function listAccounts(accessToken) {
  const json = await apiGet(accessToken, 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts')
  return Array.isArray(json.accounts) ? json.accounts : []
}

// Business Information API — locations under an account. accountResource is
// e.g. "accounts/123". Returns [{ name: 'locations/456', title }].
export async function listLocations(accessToken, accountResource) {
  const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${accountResource}/locations?readMask=name,title&pageSize=100`
  const json = await apiGet(accessToken, url)
  return Array.isArray(json.locations) ? json.locations : []
}

// Legacy v4 reviews. locationResource is the FULL path
// "accounts/123/locations/456". Returns { reviews, averageRating,
// totalReviewCount, nextPageToken }.
export async function listReviews(accessToken, locationResource, pageToken) {
  let url = `https://mybusiness.googleapis.com/v4/${locationResource}/reviews?pageSize=50`
  if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`
  return apiGet(accessToken, url)
}

// Load the stored connection, refresh if near expiry, persist the rotated
// token. Returns { conn, accessToken }. Service-role so cron/background safe.
export async function withFreshToken(locationId) {
  const db = createServerClient()
  const { data: conn, error } = await db
    .from('google_business_connections')
    .select('*')
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) throw new GoogleBusinessError(`Failed to load Google connection: ${error.message}`)
  if (!conn) throw new GoogleBusinessError('No Google Business connection for this location.')

  const expiresAt = new Date(conn.expires_at).getTime()
  const needsRefresh = Number.isFinite(expiresAt) && expiresAt - Date.now() < REFRESH_BUFFER_MS

  let accessToken = conn.access_token
  if (needsRefresh) {
    const refreshed = await refreshAccessToken(conn.refresh_token)
    accessToken = refreshed.access_token
    // Google only re-issues refresh_token on first consent / prompt=consent;
    // keep the existing one when the refresh response omits it.
    const newRefresh = refreshed.refresh_token || conn.refresh_token
    const newExpiresAt = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString()
    const { error: upErr } = await db
      .from('google_business_connections')
      .update({ access_token: accessToken, refresh_token: newRefresh, expires_at: newExpiresAt })
      .eq('id', conn.id)
    if (upErr) throw new GoogleBusinessError(`Failed to persist refreshed token: ${upErr.message}`)
  }

  return { conn, accessToken }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/google-business/client.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/google-business/client.js src/lib/google-business/client.test.js
git commit -m "REVIEWS.7 — Google Business OAuth client (mirror of Xero client)"
```

---

## Task 8: Sync runner

**Files:**
- Create: `src/lib/google-business/sync.js`
- Test: `src/lib/google-business/sync.test.js`

- [ ] **Step 1: Write the failing test**

Create `src/lib/google-business/sync.test.js`. It tests the pure `buildReviewRows` aggregator that the IO runner delegates to:

```js
import { describe, it, expect } from 'vitest'
import { buildReviewRows } from './sync'

describe('buildReviewRows', () => {
  const locationId = 'loc-1'
  const pages = [
    { reviews: [
      { reviewId: 'a', starRating: 'FIVE', comment: 'great', createTime: '2026-05-02T00:00:00Z', reviewer: { displayName: 'A' } },
      { reviewId: 'b', starRating: 'STAR_RATING_UNSPECIFIED', comment: 'noise', createTime: '2026-05-01T00:00:00Z' }, // rating 0 → dropped
    ] },
    { reviews: [
      { reviewId: 'c', starRating: 'FOUR', createTime: '2026-04-30T00:00:00Z' }, // no comment → kept in DB, filtered at render
    ] },
  ]

  it('flattens all pages, drops rating-0 reviews, stamps location_id', () => {
    const rows = buildReviewRows(locationId, pages)
    expect(rows.map((r) => r.google_review_id)).toEqual(['a', 'c'])
    expect(rows.every((r) => r.location_id === locationId)).toBe(true)
    expect(rows.every((r) => typeof r.synced_at === 'string')).toBe(true)
  })

  it('never includes a hidden key (upsert must not reset operator hides)', () => {
    const rows = buildReviewRows(locationId, pages)
    expect(rows.every((r) => !('hidden' in r))).toBe(true)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/google-business/sync.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the sync runner**

Create `src/lib/google-business/sync.js`:

```js
// Google reviews sync. syncReviewsForLocation pages the v4 reviews endpoint,
// upserts by (location_id, google_review_id) WITHOUT touching `hidden` (so
// operator hides survive), and snapshots the aggregate onto the connection.

import { createServerClient } from '@/lib/supabase'
import { withFreshToken, listReviews } from './client'
import { normalizeReview } from './reviews'

const MAX_PAGES = 50 // 50 pages * 50/page = 2500 reviews — ample headroom

// Pure: flatten Google review pages → DB rows. Drops rating-0 (unspecified).
// Deliberately omits `hidden` so the upsert can't clobber operator state.
export function buildReviewRows(locationId, pages) {
  const now = new Date().toISOString()
  const rows = []
  for (const page of pages || []) {
    for (const r of page?.reviews || []) {
      const n = normalizeReview(r)
      if (!n.google_review_id || n.rating < 1) continue
      rows.push({
        location_id: locationId,
        google_review_id: n.google_review_id,
        rating: n.rating,
        comment: n.comment,
        author_name: n.author_name,
        author_photo_url: n.author_photo_url,
        review_time: n.review_time,
        reply_comment: n.reply_comment,
        synced_at: now,
      })
    }
  }
  return rows
}

// Sync one location. Returns { synced, total, average } or throws.
export async function syncReviewsForLocation(locationId) {
  const db = createServerClient()
  const { conn, accessToken } = await withFreshToken(locationId)
  if (!conn.location_resource) {
    throw new Error('Connection has no location selected yet.')
  }

  const pages = []
  let pageToken
  let aggregate = { averageRating: null, totalReviewCount: null }
  for (let i = 0; i < MAX_PAGES; i++) {
    const json = await listReviews(accessToken, conn.location_resource, pageToken)
    pages.push(json)
    if (aggregate.averageRating == null && json.averageRating != null) {
      aggregate = { averageRating: json.averageRating, totalReviewCount: json.totalReviewCount ?? null }
    }
    pageToken = json.nextPageToken
    if (!pageToken) break
  }

  const rows = buildReviewRows(locationId, pages)
  if (rows.length > 0) {
    const { error } = await db
      .from('google_reviews')
      .upsert(rows, { onConflict: 'location_id,google_review_id' })
    if (error) throw new Error(`Upsert failed: ${error.message}`)
  }

  const { error: connErr } = await db
    .from('google_business_connections')
    .update({
      average_rating: aggregate.averageRating,
      total_review_count: aggregate.totalReviewCount,
      last_synced_at: new Date().toISOString(),
      sync_error: null,
    })
    .eq('id', conn.id)
  if (connErr) throw new Error(`Aggregate update failed: ${connErr.message}`)

  return { synced: rows.length, total: aggregate.totalReviewCount, average: aggregate.averageRating }
}

// Sync every connected location. Best-effort per location — records sync_error
// on the connection but never throws so one bad location can't abort the cron.
export async function syncAllLocations() {
  const db = createServerClient()
  const { data: conns } = await db
    .from('google_business_connections')
    .select('location_id')
    .not('location_resource', 'is', null)

  const results = []
  for (const c of conns || []) {
    try {
      const r = await syncReviewsForLocation(c.location_id)
      results.push({ location_id: c.location_id, ...r })
    } catch (e) {
      results.push({ location_id: c.location_id, error: e?.message || String(e) })
      try {
        await db.from('google_business_connections')
          .update({ sync_error: e?.message || String(e) })
          .eq('location_id', c.location_id)
      } catch { /* best-effort */ }
    }
  }
  return results
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/google-business/sync.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/google-business/sync.js src/lib/google-business/sync.test.js
git commit -m "REVIEWS.8 — review sync runner (paginate, upsert preserving hidden, aggregate snapshot)"
```

---

## Task 9: OAuth routes (connect / callback / select-location / disconnect / status)

**Files:**
- Create: `src/app/api/google-business/connect/route.js`
- Create: `src/app/api/google-business/callback/route.js`
- Create: `src/app/api/google-business/select-location/route.js`
- Create: `src/app/api/google-business/disconnect/route.js`
- Create: `src/app/api/google-business/status/route.js`

These mirror `src/app/api/xero/{connect,callback,disconnect,status}/route.js`. Owner/master only, IDOR-guarded by `location_id`.

- [ ] **Step 1: connect**

Create `src/app/api/google-business/connect/route.js`:

```js
import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { getCurrentUser } from '@/lib/auth'
import { buildAuthorizeUrl } from '@/lib/google-business/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))
  if (user.role !== 'owner' && user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }
  const url = new URL(req.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  }
  const isMaster = user.role === 'master'
  const userLocationIds = (user.locations || []).map((l) => l.id)
  if (!isMaster && !userLocationIds.includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Not a member of that location' }, { status: 403 })
  }

  const nonce = randomBytes(24).toString('hex')
  const state = `${nonce}.${locationId}`
  const res = NextResponse.redirect(buildAuthorizeUrl({ state }))
  res.cookies.set('gbp_oauth_state', state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 600,
    path: '/',
  })
  return res
}
```

- [ ] **Step 2: callback**

Create `src/app/api/google-business/callback/route.js`. On success it stores the connection and, if the account has exactly one location, auto-selects it; otherwise it lands on the settings page where the picker lives.

```js
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { exchangeAuthorizationCode, listAccounts, listLocations, GoogleBusinessError } from '@/lib/google-business/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function settingsUrl(req, locationId, params = {}) {
  const u = new URL(`/settings/locations/${locationId}`, req.url)
  u.searchParams.set('tab', 'integrations')
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
  return u
}

export async function GET(req) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.redirect(new URL('/login', req.url))

  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const oauthError = url.searchParams.get('error')
  const cookieState = req.cookies.get('gbp_oauth_state')?.value
  const [, locationId] = (state || '').split('.')

  const clear = (res) => { res.cookies.set('gbp_oauth_state', '', { maxAge: 0, path: '/' }); return res }
  const fail = (msg) => clear(NextResponse.redirect(settingsUrl(req, locationId || '', { gbp_error: msg })))

  if (user.role !== 'owner' && user.role !== 'master') return fail('Not permitted')
  if (oauthError) return fail(`Google declined: ${oauthError}`)
  if (!code || !state) return fail('Missing code/state')
  if (!cookieState || cookieState !== state) return fail('OAuth state mismatch')
  if (!locationId) return fail('Invalid state')

  try {
    const tokens = await exchangeAuthorizationCode(code)
    const accounts = await listAccounts(tokens.access_token)
    if (!accounts.length) return fail('No Google Business accounts on this login')
    const account = accounts[0] // { name: 'accounts/123', ... }

    let locationResource = null
    let locationTitle = null
    const locs = await listLocations(tokens.access_token, account.name)
    if (locs.length === 1) {
      locationResource = `${account.name}/${locs[0].name}` // accounts/123/locations/456
      locationTitle = locs[0].title || null
    }

    const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()
    const db = createServerClient()
    const { error: upErr } = await db.from('google_business_connections').upsert({
      location_id: locationId,
      account_resource: account.name,
      location_resource: locationResource,
      location_title: locationTitle,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      scopes: tokens.scope || '',
      connected_by: user.id,
    }, { onConflict: 'location_id' })
    if (upErr) return fail(`DB error: ${upErr.message}`)

    return clear(NextResponse.redirect(settingsUrl(req, locationId, { gbp_connected: '1' })))
  } catch (e) {
    const msg = e instanceof GoogleBusinessError ? e.message : (e.message || String(e))
    return fail(msg)
  }
}
```

- [ ] **Step 3: select-location**

Create `src/app/api/google-business/select-location/route.js`:

```js
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({
  location_id: uuidLike,
  location_resource: z.string().min(1).max(300), // accounts/123/locations/456
  location_title: z.string().max(300).nullable().optional(),
})

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || (user.role !== 'owner' && user.role !== 'master')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db
    .from('google_business_connections')
    .update({ location_resource: body.location_resource, location_title: body.location_title ?? null })
    .eq('location_id', body.location_id)
    .select('location_id, location_resource, location_title')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data })
}
```

- [ ] **Step 4: disconnect**

Create `src/app/api/google-business/disconnect/route.js`:

```js
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({ location_id: uuidLike })

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || (user.role !== 'owner' && user.role !== 'master')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const guard = assertLocationAccess(user, validation.data.location_id)
  if (guard) return guard

  const db = createServerClient()
  const { error } = await db
    .from('google_business_connections')
    .delete()
    .eq('location_id', validation.data.location_id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
```

- [ ] **Step 5: status**

Create `src/app/api/google-business/status/route.js` (safe subset — no tokens):

```js
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  if (!locationId) return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db
    .from('google_business_connections')
    .select('location_id, account_resource, location_resource, location_title, average_rating, total_review_count, last_synced_at, sync_error, connected_at')
    .eq('location_id', locationId)
    .maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: data || null })
}
```

- [ ] **Step 6: Build to verify imports resolve**

Run: `npm run build`
Expected: success (catches any bad import / route export).

- [ ] **Step 7: Commit**

```bash
git add src/app/api/google-business/
git commit -m "REVIEWS.9 — Google Business OAuth routes (connect/callback/select-location/disconnect/status)"
```

---

## Task 10: Sync cron + vercel.json

**Files:**
- Create: `src/app/api/cron/sync-google-reviews/route.js`
- Modify: `vercel.json`

- [ ] **Step 1: Write the cron route**

Create `src/app/api/cron/sync-google-reviews/route.js`:

```js
import { NextResponse } from 'next/server'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { syncAllLocations } from '@/lib/google-business/sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

/**
 * GET /api/cron/sync-google-reviews
 * Daily Vercel cron — pulls each connected location's Google reviews into
 * google_reviews. Best-effort per location (errors recorded on the connection
 * row, never aborts the run). Secured by CRON_SECRET.
 */
export async function GET(request) {
  const cronSecret = process.env.CRON_SECRET
  const authHeader = request.headers.get('authorization')
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }

  let results = []
  try {
    results = await syncAllLocations()
  } catch (e) {
    console.error('[cron] sync-google-reviews failed:', e?.message || e)
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }

  await stampHeartbeat('sync-google-reviews')
  return NextResponse.json({ success: true, results })
}
```

- [ ] **Step 2: Register the cron in vercel.json**

In `vercel.json`, add an entry to the `crons` array (after the existing last entry, `close-stale-impersonations`):

```json
    {
      "path": "/api/cron/sync-google-reviews",
      "schedule": "0 4 * * *"
    }
```

(Daily at 04:00 UTC. Remember the prior comma on the previous array element.)

- [ ] **Step 3: Verify heartbeat coverage + build**

Run:
```bash
grep -L stampHeartbeat src/app/api/cron/*/route.js
```
Expected: only `health-check/route.js` is listed (the sync route must NOT appear — it stamps).

```bash
npm run build
```
Expected: success.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/sync-google-reviews/route.js vercel.json
git commit -m "REVIEWS.10 — daily sync-google-reviews cron + heartbeat"
```

---

## Task 11: Hide route + connection card + integrations tab

**Files:**
- Create: `src/app/api/google-reviews/[id]/route.js` (PATCH hide/show)
- Create: `src/components/settings/GoogleReviewsCard.jsx`
- Create: `src/components/settings/integrations/GoogleReviewsTab.jsx`
- Modify: `src/app/settings/locations/[id]/page.js` (register the tab — mirror the Xero tab)

- [ ] **Step 1: Hide/show PATCH route**

Create `src/app/api/google-reviews/[id]/route.js`. Resolves the review's `location_id` first, then enforces access + the `landing_page` permission, and 404s on cross-tenant ids:

```js
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({ hidden: z.boolean() })

export async function PATCH(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  const { id } = await params
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response

  const db = createServerClient()
  const { data: review } = await db
    .from('google_reviews')
    .select('id, location_id')
    .eq('id', id)
    .maybeSingle()
  // 404 (not 403) on miss/cross-tenant so ids can't be enumerated.
  if (!review) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const guard = assertLocationAccess(user, review.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!hasPermissionForLocation(user, review.location_id, 'landing_page')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }

  const { data, error } = await db
    .from('google_reviews')
    .update({ hidden: validation.data.hidden })
    .eq('id', id)
    .select('id, hidden')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data })
}
```

> Confirm `hasPermissionForLocation` is exported from `@/lib/permissions` (it's used by `/api/landing-page-settings/route.js`). If the import path differs, match that route's import.

- [ ] **Step 2: GoogleReviewsCard component**

Create `src/components/settings/GoogleReviewsCard.jsx`. Mirrors `XeroLocationCard`: connect/reconnect/disconnect, a location picker when none is selected, "Sync now", and the per-review hide list.

```jsx
'use client'

// Per-location Google Business reviews card (Settings → Locations →
// Integrations). Connect/disconnect mirror XeroLocationCard; adds a GBP
// location picker, a "Sync now" button, and the per-review hide toggles
// that drive the landing-page carousel.

import { useState, useEffect, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { Plug, RefreshCw, Unlink, Star, EyeOff, Eye } from 'lucide-react'

export default function GoogleReviewsCard({ location, connection }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState(null)
  const [reviews, setReviews] = useState([])
  const [locs, setLocs] = useState([])     // GBP locations to pick from
  const [pickBusy, setPickBusy] = useState(false)

  const connected = !!connection
  const locationSelected = !!connection?.location_resource

  const onConnect = () => { window.location.href = `/api/google-business/connect?location_id=${location.id}` }

  const onDisconnect = async () => {
    if (!confirm(`Disconnect Google reviews from ${location.name}?`)) return
    setBusy(true)
    try {
      const res = await fetch('/api/google-business/disconnect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: location.id }),
      })
      const j = await res.json()
      if (!j.success) alert(j.error || 'Disconnect failed')
      router.refresh()
    } finally { setBusy(false) }
  }

  const loadReviews = useCallback(async () => {
    if (!connected) return
    const res = await fetch(`/api/google-reviews?location_id=${location.id}`).catch(() => null)
    if (!res) return
    const j = await res.json().catch(() => ({}))
    if (j.success) setReviews(j.data || [])
  }, [connected, location.id])

  useEffect(() => { loadReviews() }, [loadReviews])

  const onSync = async () => {
    setSyncing(true); setSyncResult(null)
    try {
      const res = await fetch('/api/google-business/sync-now', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: location.id }),
      })
      const j = await res.json()
      setSyncResult(j.success ? { ok: j.data } : { error: j.error || 'Sync failed' })
      if (j.success) { await loadReviews(); router.refresh() }
    } catch (e) {
      setSyncResult({ error: e.message || 'Network error' })
    } finally { setSyncing(false) }
  }

  const toggleHide = async (rev) => {
    const res = await fetch(`/api/google-reviews/${rev.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hidden: !rev.hidden }),
    })
    const j = await res.json()
    if (j.success) setReviews((rs) => rs.map((r) => (r.id === rev.id ? { ...r, hidden: j.data.hidden } : r)))
    else alert(j.error || 'Update failed')
  }

  return (
    <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-un1t-text">Google reviews — {location.name}</div>
          {connected ? (
            <div className="text-xs text-un1t-subtle mt-1 space-y-0.5">
              <div>Listing: <span className="text-un1t-text">{connection.location_title || (locationSelected ? connection.location_resource : 'not selected')}</span></div>
              <div className="text-un1t-muted">
                {connection.average_rating != null && <>{connection.average_rating}★ · {connection.total_review_count} reviews · </>}
                last synced {connection.last_synced_at ? new Date(connection.last_synced_at).toLocaleString() : 'never'}
              </div>
              {connection.sync_error && <div className="text-red-700">{connection.sync_error}</div>}
            </div>
          ) : (
            <div className="text-xs text-un1t-subtle mt-1">Not connected.</div>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {connected ? (
            <>
              {locationSelected && (
                <button onClick={onSync} disabled={syncing}
                  className="flex items-center gap-1 text-xs px-3 py-1.5 bg-un1t-border/40 hover:bg-un1t-border text-un1t-text rounded-md disabled:opacity-50">
                  <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Syncing…' : 'Sync now'}
                </button>
              )}
              <button onClick={onConnect} disabled={busy}
                className="flex items-center gap-1 text-xs px-3 py-1.5 bg-un1t-border/40 hover:bg-un1t-border text-un1t-text rounded-md disabled:opacity-50">
                <RefreshCw size={12} /> Reconnect
              </button>
              <button onClick={onDisconnect} disabled={busy}
                className="flex items-center gap-1 text-xs px-3 py-1.5 border border-red-500/40 hover:bg-red-500/10 text-red-700 rounded-md disabled:opacity-50">
                <Unlink size={12} /> Disconnect
              </button>
            </>
          ) : (
            <button onClick={onConnect} disabled={busy}
              className="flex items-center gap-1 text-xs px-3 py-1.5 bg-un1t-text text-un1t-bg rounded-md font-semibold hover:bg-un1t-accent disabled:opacity-50">
              <Plug size={12} /> Connect Google
            </button>
          )}
        </div>
      </div>

      {/* Location picker — shown when connected but no GBP location selected. */}
      {connected && !locationSelected && (
        <LocationPicker
          locationId={location.id}
          locs={locs}
          setLocs={setLocs}
          busy={pickBusy}
          setBusy={setPickBusy}
          onPicked={() => router.refresh()}
        />
      )}

      {syncResult?.error && <div className="mt-2 text-[11px] text-red-700">{syncResult.error}</div>}
      {syncResult?.ok && <div className="mt-2 text-[11px] text-emerald-700">Synced {syncResult.ok.synced} reviews.</div>}

      {/* Hide list */}
      {connected && locationSelected && reviews.length > 0 && (
        <div className="mt-4 pt-3 border-t border-un1t-border/50">
          <div className="text-xs uppercase tracking-wider text-un1t-subtle font-semibold mb-2">
            Synced reviews — hide any you don’t want on the landing page
          </div>
          <ul className="space-y-1.5 max-h-80 overflow-auto">
            {reviews.map((r) => (
              <li key={r.id} className={`flex items-start gap-2 text-xs p-2 rounded ${r.hidden ? 'opacity-50 bg-un1t-bg/20' : 'bg-un1t-bg/30'}`}>
                <span className="text-amber-600 shrink-0 inline-flex items-center"><Star size={11} className="fill-amber-500 stroke-amber-500" />{r.rating}</span>
                <span className="flex-1 text-un1t-text">
                  <span className="font-medium">{r.author_name || 'Google user'}:</span>{' '}
                  <span className="text-un1t-subtle">{r.comment || <em>(no text)</em>}</span>
                </span>
                <button onClick={() => toggleHide(r)} className="shrink-0 text-un1t-muted hover:text-un1t-text" title={r.hidden ? 'Show' : 'Hide'}>
                  {r.hidden ? <Eye size={13} /> : <EyeOff size={13} />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function LocationPicker({ locationId, locs, setLocs, busy, setBusy, onPicked }) {
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    fetch(`/api/google-business/locations?location_id=${locationId}`)
      .then((r) => r.json()).then((j) => { if (j.success) setLocs(j.data || []) })
      .finally(() => setLoaded(true))
  }, [locationId, setLocs])

  const pick = async (l) => {
    setBusy(true)
    try {
      const res = await fetch('/api/google-business/select-location', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, location_resource: l.resource, location_title: l.title }),
      })
      const j = await res.json()
      if (!j.success) { alert(j.error || 'Failed'); return }
      onPicked()
    } finally { setBusy(false) }
  }

  return (
    <div className="mt-3 pt-3 border-t border-un1t-border/50">
      <div className="text-xs text-un1t-subtle mb-2">Pick which Google listing maps to this studio:</div>
      {!loaded ? <div className="text-[11px] text-un1t-muted">Loading…</div> : (
        <div className="flex flex-wrap gap-2">
          {locs.length === 0 && <div className="text-[11px] text-un1t-muted">No listings found on this Google account.</div>}
          {locs.map((l) => (
            <button key={l.resource} disabled={busy} onClick={() => pick(l)}
              className="text-xs px-3 py-1.5 bg-un1t-border/40 hover:bg-un1t-border rounded-md disabled:opacity-50">
              {l.title || l.resource}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
```

This card references two more endpoints — add them in the next two steps.

- [ ] **Step 3: Add the `sync-now` + `locations` list endpoints**

Create `src/app/api/google-business/sync-now/route.js`:

```js
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { syncReviewsForLocation } from '@/lib/google-business/sync'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const Schema = z.object({ location_id: uuidLike })

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || (user.role !== 'owner' && user.role !== 'master')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const guard = assertLocationAccess(user, validation.data.location_id)
  if (guard) return guard

  try {
    const data = await syncReviewsForLocation(validation.data.location_id)
    return NextResponse.json({ success: true, data })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}
```

Create `src/app/api/google-business/locations/route.js` (lists the GBP locations for the picker):

```js
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { withFreshToken, listLocations } from '@/lib/google-business/client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || (user.role !== 'owner' && user.role !== 'master')) {
    return NextResponse.json({ success: false, error: 'Not permitted' }, { status: 403 })
  }
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  if (!locationId) return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  try {
    const { conn, accessToken } = await withFreshToken(locationId)
    const locs = await listLocations(accessToken, conn.account_resource)
    const data = locs.map((l) => ({ resource: `${conn.account_resource}/${l.name}`, title: l.title || l.name }))
    return NextResponse.json({ success: true, data })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}
```

Also create `src/app/api/google-reviews/route.js` (the list the card reads — member-scoped, includes hidden so the toggle reflects state):

```js
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  if (!locationId) return NextResponse.json({ success: false, error: 'location_id is required' }, { status: 400 })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db
    .from('google_reviews')
    .select('id, rating, comment, author_name, hidden, review_time')
    .eq('location_id', locationId)
    .order('review_time', { ascending: false })
    .limit(200)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: data || [] })
}
```

- [ ] **Step 4: GoogleReviewsTab + register in the location settings page**

Create `src/components/settings/integrations/GoogleReviewsTab.jsx` (mirror `XeroIntegrationTab.jsx`):

```jsx
import GoogleReviewsCard from '@/components/settings/GoogleReviewsCard'

export default function GoogleReviewsTab({ location, connection }) {
  return (
    <div className="space-y-4">
      <p className="text-xs text-un1t-subtle">
        Connect this studio’s Google Business listing to power the reviews
        carousel on its landing page. Reviews sync nightly; hide any you don’t
        want featured below.
      </p>
      <GoogleReviewsCard location={location} connection={connection || null} />
    </div>
  )
}
```

In `src/app/settings/locations/[id]/page.js`, find where the Xero integration tab is wired (search for `XeroIntegrationTab` / the `tab` strip / `?tab=integrations`). Mirror it: load the `google_business_connections` row for the location (service-role select, same place the Xero connection is loaded) and render `GoogleReviewsTab` in the Integrations tab content, beneath the Xero card. Concretely:

  - Add to the data loading: `const { data: gbpConnection } = await db.from('google_business_connections').select('*').eq('location_id', id).maybeSingle()`
  - In the integrations tab JSX, after the Xero tab/card, render: `<GoogleReviewsTab location={location} connection={gbpConnection} />`
  - Add the import: `import GoogleReviewsTab from '@/components/settings/integrations/GoogleReviewsTab'`

> Match the file's existing structure exactly — if integrations is a sub-tab with its own component, add the card there; if the page renders cards in a list, append it to that list.

- [ ] **Step 5: Build + manual verify**

```bash
npm run build
```
Expected: success.

`npm run dev` → `/settings/locations/<id>?tab=integrations` shows the Google reviews card with a **Connect Google** button and (because Task 4 seeded rows) — once a connection row exists — the hide list. (Full connect flow can't be exercised until Google approval + env vars; the card + hide toggles work against seeded rows if you insert a connection row manually for QA.)

- [ ] **Step 6: Commit**

```bash
git add src/app/api/google-reviews/ src/app/api/google-business/sync-now/ src/app/api/google-business/locations/ src/components/settings/GoogleReviewsCard.jsx src/components/settings/integrations/GoogleReviewsTab.jsx 'src/app/settings/locations/[id]/page.js'
git commit -m "REVIEWS.11 — hide route + Google reviews settings card + integrations tab"
```

---

## Task 12: OpenAPI registration, env docs, final verification

**Files:**
- Modify: `src/lib/openapi.js` (register the new routes)
- Modify: `CLAUDE.md` (env vars + a short feature note)

- [ ] **Step 1: Register routes in OpenAPI**

In `src/lib/openapi.js`, follow the existing registration pattern to add the new public-ish/admin routes so Swagger stays in sync:
`/api/google-business/status` (GET), `/api/google-business/select-location` (POST), `/api/google-business/disconnect` (POST), `/api/google-business/sync-now` (POST), `/api/google-business/locations` (GET), `/api/google-reviews` (GET), `/api/google-reviews/{id}` (PATCH), `/api/cron/sync-google-reviews` (GET). Match the shape of an existing simple registration (e.g. how a Xero route is registered) — path, method, brief summary, `{ success }` response.

> If a route is trivial and the repo doesn't register every cron, match the prevailing convention — register at least the operator-facing ones (`status`, `select-location`, `disconnect`, `sync-now`, `google-reviews` GET + PATCH).

- [ ] **Step 2: Document env vars + feature in CLAUDE.md**

In `CLAUDE.md` under "Environment Variables", add:

```
GOOGLE_OAUTH_CLIENT_ID=          # Google Cloud OAuth 2.0 web client — Business Profile reviews
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_OAUTH_REDIRECT_URI=https://crm.un1tdublin.com/api/google-business/callback
```

Add a one-paragraph "Google reviews carousel" note under a suitable section (e.g. near the Xero integration), pointing to `docs/REVIEW_CAROUSEL_DESIGN.md`, noting: scope `business.manage`, reviews on the legacy v4 endpoint, daily `sync-google-reviews` cron, `google_business_connections` + `google_reviews` tables (mig 249), the `reviews` landing block, and that Google API access approval (0→300 QPM) is a prerequisite.

- [ ] **Step 3: Run the full CI mirror + build**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run build
```
Expected: all green. (Parity passes with no change because no `WEB_PERMISSIONS` key was added.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/openapi.js CLAUDE.md
git commit -m "REVIEWS.12 — register routes in OpenAPI + document Google reviews env/feature"
```

- [ ] **Step 5: Ship (branch already in use) — push + open PR**

Per repo convention all work is on a feature branch off `main`. Push and open the PR:

```bash
git push -u origin review-carousel
```
Then open the PR via the GitHub API (see CLAUDE.md "The canonical ship loop"), `base=main`, title `REVIEWS — Google reviews carousel landing-page block`, body summarising the migration (249), tables, OAuth, cron, block, and the **Google API-access approval prerequisite**. Report the PR URL.

---

## Post-merge / operator runbook (not code)

1. **Google Cloud:** create an OAuth 2.0 Web client (authorized redirect `https://crm.un1tdublin.com/api/google-business/callback`), configure the consent screen, enable the **My Business Account Management**, **My Business Business Information**, and legacy **Google My Business** APIs, and **submit the Business Profile API access request** (0→300 QPM; days–weeks).
2. **Vercel:** set `GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI`, then redeploy (env changes don't auto-redeploy).
3. **Connect:** Settings → Locations → Stillorgan → Integrations → Connect Google → pick the listing → Sync now.
4. **Add the block:** in the landing-page editor add a **Google reviews** section, set min rating, save.
5. Repeat connect for Hatch Street when its listing is ready.

## Out of scope (YAGNI)

Live per-request fetching · replying to reviews from the CRM · other review sources · hand-picking individual reviews · third-party widgets · mobile surface.
