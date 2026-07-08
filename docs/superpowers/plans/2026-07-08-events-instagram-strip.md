# Instagram Strip on the Events Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a swipeable carousel of a studio's latest Instagram posts/reels on the public events page (`/[location]/events`) as social proof, auto-pulled from the location's connected IG account.

**Architecture:** A ~6h cron (`instagram-feed-sync`) pulls the latest media from each location's connected IG business account via the Graph API, re-hosts thumbnails to a public Supabase Storage bucket (IG CDN URLs expire), and upserts them into a new `instagram_feed_posts` cache table. The public events page (already a server component) reads that cache and renders an `InstagramStrip` carousel. No live Graph call on page load. An operator toggle (`landing_page_settings.show_instagram_feed`) gates it per studio.

**Tech Stack:** Next.js 16 (App Router), Supabase (Postgres + Storage, service-role client), Meta Graph API v21, Vitest, Tailwind (landing/`lp-*` dark theme + Poppins).

**Spec:** `docs/superpowers/specs/2026-07-08-events-instagram-strip-design.md`

**Conventions (from CLAUDE.md):** migrations forward-only via Supabase MCP (`get_advisors` after); `.insert/.update/.upsert` must be awaited; 1000-row cap → paginate; crons use Bearer `CRON_SECRET` + `stampHeartbeat`; service-role routes get NO RLS (enforce in code); no new `console.log` in prod paths (use `console.error`). Run the CI mirror + `npm run build` before pushing.

**Working branch:** `events-instagram-strip` (already created off `origin/main`; the spec is committed there).

---

### Task 1: Migration — cache table, storage bucket, toggle column, heartbeat row

**Files:**
- Create: `supabase/migrations/382_instagram_feed.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
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

-- Cron heartbeat row.
INSERT INTO public.cron_heartbeats (name)
VALUES ('instagram-feed-sync')
ON CONFLICT (name) DO NOTHING;
```

- [ ] **Step 2: Apply via Supabase MCP**

Confirm the project first (`list_projects` → `iyvtbjjxdggiadzwwvdj`, un1t-crm — NOT sentinel). Then `apply_migration` with name `382_instagram_feed` and the SQL above.

- [ ] **Step 3: Run security advisors**

Call `get_advisors` (type=security). Expected: no new ERROR for `instagram_feed_posts` (RLS is enabled with no policy — that's intentional and advisor-clean, like `event_hosts`). If `cron_heartbeats` has a different column set than `(name)`, adjust the INSERT to match its actual columns (verify with `list_tables` or by reading an existing heartbeat migration).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/382_instagram_feed.sql
git commit -m "EVENTS-IG.1 — mig 382: instagram_feed_posts + toggle + bucket"
```

---

### Task 2: `normalizeIgMedia` — pure Graph→row shaping

**Files:**
- Create: `src/lib/instagram-feed.js`
- Test: `src/lib/instagram-feed.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { normalizeIgMedia } from './instagram-feed.js'

describe('normalizeIgMedia', () => {
  const img = { id: '1', media_type: 'IMAGE', media_url: 'https://cdn/i1.jpg', permalink: 'https://instagram.com/p/1', caption: 'hello', timestamp: '2026-07-01T10:00:00Z' }
  const reel = { id: '2', media_type: 'VIDEO', media_product_type: 'REELS', thumbnail_url: 'https://cdn/t2.jpg', media_url: 'https://cdn/v2.mp4', permalink: 'https://instagram.com/reel/2', timestamp: '2026-07-02T10:00:00Z' }

  it('maps an image post to a row (image_url from media_url)', () => {
    const [row] = normalizeIgMedia([img])
    expect(row).toMatchObject({ ig_media_id: '1', media_type: 'IMAGE', is_reel: false, permalink: 'https://instagram.com/p/1', image_url: 'https://cdn/i1.jpg', posted_at: '2026-07-01T10:00:00Z' })
  })

  it('detects a reel and uses thumbnail_url for video image_url', () => {
    const [row] = normalizeIgMedia([reel])
    expect(row.is_reel).toBe(true)
    expect(row.image_url).toBe('https://cdn/t2.jpg')
  })

  it('truncates long captions to <=140 chars with an ellipsis', () => {
    const [row] = normalizeIgMedia([{ ...img, caption: 'x'.repeat(200) }])
    expect(row.caption.length).toBeLessThanOrEqual(140)
    expect(row.caption.endsWith('…')).toBe(true)
  })

  it('drops items with no id/permalink or no usable image', () => {
    expect(normalizeIgMedia([{ id: '3', permalink: 'https://instagram.com/p/3', media_type: 'IMAGE' }])).toHaveLength(0) // no media_url
    expect(normalizeIgMedia([{ media_type: 'IMAGE', media_url: 'x' }])).toHaveLength(0) // no id/permalink
    expect(normalizeIgMedia(null)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/instagram-feed.test.js`
Expected: FAIL — `normalizeIgMedia is not a function`.

- [ ] **Step 3: Write the implementation**

```js
// Instagram feed for the public events-page strip (EVENTS-IG.1).
// Graph media → cache rows, thumbnail re-host, per-location sync.

const GRAPH = 'https://graph.facebook.com/v21.0'
const CAPTION_MAX = 140

/**
 * Shape Graph media items into cache-row candidates. Pure. `image_url` is the
 * transient IG CDN URL the sync re-hosts; rows with no usable image are dropped.
 * @param {Array<object>} items
 * @returns {Array<{ig_media_id,media_type,is_reel,permalink,caption,image_url,posted_at}>}
 */
export function normalizeIgMedia(items) {
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && it.id && it.permalink)
    .map((it) => {
      const isReel = it.media_product_type === 'REELS' || it.media_type === 'VIDEO'
      let caption = typeof it.caption === 'string' ? it.caption : null
      if (caption && caption.length > CAPTION_MAX) caption = caption.slice(0, CAPTION_MAX - 1).trimEnd() + '…'
      const image_url = it.media_type === 'VIDEO' ? (it.thumbnail_url || null) : (it.media_url || null)
      return {
        ig_media_id: String(it.id),
        media_type: it.media_type || 'IMAGE',
        is_reel: isReel,
        permalink: it.permalink,
        caption,
        image_url,
        posted_at: it.timestamp || null,
      }
    })
    .filter((r) => r.image_url)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/instagram-feed.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/instagram-feed.js src/lib/instagram-feed.test.js
git commit -m "EVENTS-IG.1 — normalizeIgMedia (Graph→row shaping)"
```

---

### Task 3: `fetchIgMedia` + `fetchIgUsername` — Graph calls (injectable fetch)

**Files:**
- Modify: `src/lib/instagram-feed.js`
- Test: `src/lib/instagram-feed.test.js`

- [ ] **Step 1: Write the failing test (append to the test file)**

```js
import { fetchIgMedia, fetchIgUsername } from './instagram-feed.js'

describe('fetchIgMedia', () => {
  const conn = { external_account_id: 'ig123', access_token: 'tok' }
  it('calls the media edge with fields+token and normalizes the result', async () => {
    const calls = []
    const fetchImpl = async (url) => { calls.push(url); return { ok: true, json: async () => ({ data: [{ id: '1', media_type: 'IMAGE', media_url: 'https://cdn/i.jpg', permalink: 'https://instagram.com/p/1' }] }) } }
    const rows = await fetchIgMedia(conn, { fetchImpl, limit: 5 })
    expect(calls[0]).toContain('/ig123/media')
    expect(calls[0]).toContain('access_token=tok')
    expect(rows).toHaveLength(1)
  })
  it('throws on a Graph error (so the caller keeps last-good)', async () => {
    const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad scope' } }) })
    await expect(fetchIgMedia(conn, { fetchImpl })).rejects.toThrow(/bad scope/)
  })
  it('throws when the connection lacks id/token', async () => {
    await expect(fetchIgMedia({}, {})).rejects.toThrow(/external_account_id/)
  })
})

describe('fetchIgUsername', () => {
  it('returns the account username, or null on error', async () => {
    const ok = async () => ({ ok: true, json: async () => ({ username: 'un1tstillorgan' }) })
    expect(await fetchIgUsername({ external_account_id: 'ig123', access_token: 'tok' }, { fetchImpl: ok })).toBe('un1tstillorgan')
    const bad = async () => ({ ok: false, status: 400, json: async () => ({}) })
    expect(await fetchIgUsername({ external_account_id: 'ig123', access_token: 'tok' }, { fetchImpl: bad })).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/instagram-feed.test.js`
Expected: FAIL — `fetchIgMedia is not a function`.

- [ ] **Step 3: Write the implementation (append to `instagram-feed.js`)**

```js
const MEDIA_FIELDS = 'id,media_type,media_product_type,media_url,thumbnail_url,permalink,caption,timestamp'

/**
 * Fetch + normalize the latest media for a connected IG account.
 * Throws on a Graph/HTTP error so the caller can keep the last-good cache.
 * @param {{external_account_id:string, access_token:string}} connection
 * @param {{limit?:number, fetchImpl?:Function}} [opts]
 */
export async function fetchIgMedia(connection, { limit = 12, fetchImpl = fetch } = {}) {
  const igId = connection?.external_account_id
  const token = connection?.access_token
  if (!igId || !token) throw new Error('instagram-feed: connection missing external_account_id/access_token')
  const url = `${GRAPH}/${igId}/media?fields=${MEDIA_FIELDS}&limit=${limit}&access_token=${encodeURIComponent(token)}`
  const res = await fetchImpl(url)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`instagram-feed graph ${res.status}: ${json?.error?.message || 'unknown'}`)
  return normalizeIgMedia(json?.data || [])
}

/**
 * Fetch the account's @username (for the "Follow" header). Best-effort: returns
 * null on any error — the strip still renders without it.
 */
export async function fetchIgUsername(connection, { fetchImpl = fetch } = {}) {
  const igId = connection?.external_account_id
  const token = connection?.access_token
  if (!igId || !token) return null
  try {
    const res = await fetchImpl(`${GRAPH}/${igId}?fields=username&access_token=${encodeURIComponent(token)}`)
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return null
    return json?.username || null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/instagram-feed.test.js`
Expected: PASS (all Task 2 + Task 3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/instagram-feed.js src/lib/instagram-feed.test.js
git commit -m "EVENTS-IG.1 — fetchIgMedia + fetchIgUsername (Graph calls)"
```

---

### Task 4: `syncLocationIgFeed` — re-host, upsert, prune, keep-last-good

**Files:**
- Modify: `src/lib/instagram-feed.js`
- Test: `src/lib/instagram-feed.test.js`

Design notes locked here:
- Re-host: fetch the image bytes, upload to `instagram-feed/{location_id}/{ig_media_id}.jpg` (upsert). A single image failure skips that post, keeps the rest.
- Upsert onConflict `location_id,ig_media_id`. Prune = delete this location's rows whose `ig_media_id` is not in the freshly-synced set — but ONLY when we actually got posts (an empty Graph response must not wipe the cache).
- A Graph error propagates (throws) → the cron's per-location catch skips it → last-good kept.

- [ ] **Step 1: Write the failing test (append)**

```js
import { syncLocationIgFeed } from './instagram-feed.js'

function fakeDb(existingIds = []) {
  const ops = { upserts: [], deletedIn: null, uploads: [] }
  const db = {
    from: (table) => ({
      upsert: async (row, opts) => { ops.upserts.push({ table, row, opts }); return { error: null } },
      select: () => ({ eq: async () => ({ data: existingIds.map((id) => ({ ig_media_id: id })) }) }),
      delete: () => ({ eq: () => ({ in: async (_c, ids) => { ops.deletedIn = ids; return { error: null } } }) }),
    }),
    storage: { from: () => ({ upload: async (path) => { ops.uploads.push(path); return { error: null } } }) },
  }
  return { db, ops }
}

describe('syncLocationIgFeed', () => {
  const conn = { location_id: 'loc1', external_account_id: 'ig1', access_token: 'tok' }
  const mediaResp = { ok: true, json: async () => ({ data: [
    { id: 'A', media_type: 'IMAGE', media_url: 'https://cdn/a.jpg', permalink: 'https://instagram.com/p/A', timestamp: '2026-07-01T00:00:00Z' },
    { id: 'B', media_type: 'VIDEO', media_product_type: 'REELS', thumbnail_url: 'https://cdn/b.jpg', permalink: 'https://instagram.com/reel/B', timestamp: '2026-07-02T00:00:00Z' },
  ] }) }
  // fetchImpl: media edge → mediaResp; username → username; image bytes → ok arrayBuffer
  const fetchImpl = async (url) => {
    if (url.includes('/media')) return mediaResp
    if (url.includes('fields=username')) return { ok: true, json: async () => ({ username: 'un1t' }) }
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }
  }

  it('re-hosts thumbnails, upserts each post, prunes stale rows', async () => {
    const { db, ops } = fakeDb(['A', 'B', 'OLD'])
    const r = await syncLocationIgFeed({ db, connection: conn, fetchImpl })
    expect(r.synced).toBe(2)
    expect(ops.uploads).toEqual(['loc1/A.jpg', 'loc1/B.jpg'])
    expect(ops.upserts.map((u) => u.row.ig_media_id).sort()).toEqual(['A', 'B'])
    expect(ops.upserts.find((u) => u.row.ig_media_id === 'B').row.is_reel).toBe(true)
    expect(ops.upserts[0].row.ig_username).toBe('un1t')
    expect(ops.deletedIn).toEqual(['OLD']) // stale pruned; A/B kept
  })

  it('does NOT prune when Graph returns zero posts (keep last-good)', async () => {
    const { db, ops } = fakeDb(['A'])
    const emptyFetch = async (url) => url.includes('/media')
      ? { ok: true, json: async () => ({ data: [] }) }
      : { ok: true, json: async () => ({ username: 'un1t' }) }
    const r = await syncLocationIgFeed({ db, connection: conn, fetchImpl: emptyFetch })
    expect(r.synced).toBe(0)
    expect(ops.deletedIn).toBeNull()
    expect(ops.upserts).toHaveLength(0)
  })

  it('skips a post whose image re-host fails but keeps the others', async () => {
    const { db, ops } = fakeDb([])
    const failB = async (url) => {
      if (url.includes('/media')) return mediaResp
      if (url.includes('fields=username')) return { ok: true, json: async () => ({ username: 'un1t' }) }
      if (url.includes('b.jpg')) return { ok: false, status: 500 } // B's image fails
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }
    }
    const r = await syncLocationIgFeed({ db, connection: conn, fetchImpl: failB })
    expect(r.synced).toBe(1)
    expect(ops.upserts.map((u) => u.row.ig_media_id)).toEqual(['A'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/instagram-feed.test.js`
Expected: FAIL — `syncLocationIgFeed is not a function`.

- [ ] **Step 3: Write the implementation (append)**

```js
const BUCKET = 'instagram-feed'

async function rehostThumb({ db, locationId, post, fetchImpl }) {
  const res = await fetchImpl(post.image_url)
  if (!res.ok) throw new Error(`thumb fetch ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const path = `${locationId}/${post.ig_media_id}.jpg`
  const { error } = await db.storage.from(BUCKET).upload(path, buf, { contentType: 'image/jpeg', upsert: true })
  if (error) throw new Error(`thumb upload: ${error.message}`)
  return path
}

/**
 * Sync ONE location's IG feed: fetch latest media (+username), re-host thumbs,
 * upsert rows, prune stale. Throws only on a Graph fetch error (caller keeps
 * last-good). Empty (non-error) response = no writes, no prune.
 * @param {{db:object, connection:object, fetchImpl?:Function}} args
 * @returns {Promise<{synced:number}>}
 */
export async function syncLocationIgFeed({ db, connection, fetchImpl = fetch }) {
  const locationId = connection.location_id
  const posts = await fetchIgMedia(connection, { fetchImpl })      // throws → keep last-good
  if (posts.length === 0) return { synced: 0 }                     // never wipe on empty
  const username = await fetchIgUsername(connection, { fetchImpl })
  const now = new Date().toISOString()
  const keptIds = []
  for (const post of posts) {
    let thumb_path
    try {
      thumb_path = await rehostThumb({ db, locationId, post, fetchImpl })
    } catch (e) {
      console.error(`[instagram-feed] rehost ${locationId}/${post.ig_media_id}: ${e.message}`)
      continue
    }
    await db.from('instagram_feed_posts').upsert({
      location_id: locationId,
      ig_media_id: post.ig_media_id,
      ig_username: username,
      media_type: post.media_type,
      is_reel: post.is_reel,
      permalink: post.permalink,
      caption: post.caption,
      thumb_path,
      posted_at: post.posted_at,
      fetched_at: now,
    }, { onConflict: 'location_id,ig_media_id' })
    keptIds.push(post.ig_media_id)
  }
  // Prune rows no longer in the latest set (only reached when posts.length > 0).
  const { data: existing } = await db.from('instagram_feed_posts').select('ig_media_id').eq('location_id', locationId)
  const stale = (existing || []).map((r) => r.ig_media_id).filter((id) => !keptIds.includes(id))
  if (stale.length > 0) await db.from('instagram_feed_posts').delete().eq('location_id', locationId).in('ig_media_id', stale)
  return { synced: keptIds.length }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/instagram-feed.test.js`
Expected: PASS (all tests). Note: `console.error` in the rehost-fail path is expected (allowed in a lib error path).

- [ ] **Step 5: Commit**

```bash
git add src/lib/instagram-feed.js src/lib/instagram-feed.test.js
git commit -m "EVENTS-IG.1 — syncLocationIgFeed (re-host + upsert + prune)"
```

---

### Task 5: Cron route + vercel.json schedule

**Files:**
- Create: `src/app/api/cron/instagram-feed-sync/route.js`
- Modify: `vercel.json`

- [ ] **Step 1: Write the cron route**

```js
// GET /api/cron/instagram-feed-sync — refresh each location's IG feed cache.
// Bearer CRON_SECRET. Per-location isolation: one studio's failure never blocks
// the others. Heartbeat on completion. (EVENTS-IG.1)

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { syncLocationIgFeed } from '@/lib/instagram-feed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()
  const { data: conns } = await db
    .from('channel_connections')
    .select('location_id, external_account_id, access_token')
    .eq('platform', 'instagram')
    .eq('is_active', true)

  let ok = 0
  let failed = 0
  for (const conn of (conns || [])) {
    if (!conn.external_account_id || !conn.access_token) continue
    try {
      await syncLocationIgFeed({ db, connection: conn })
      ok += 1
    } catch (e) {
      failed += 1
      console.error(`[instagram-feed-sync] location ${conn.location_id}: ${e.message}`)
    }
  }
  await stampHeartbeat('instagram-feed-sync')
  return NextResponse.json({ success: true, data: { locations: (conns || []).length, ok, failed } })
}
```

- [ ] **Step 2: Add the vercel.json cron entry**

Add to the `crons` array in `vercel.json` (every 6 hours):

```json
{ "path": "/api/cron/instagram-feed-sync", "schedule": "0 */6 * * *" }
```

- [ ] **Step 3: Verify the route guard + heartbeat wiring**

Run: `npm run check:route-guards`
Expected: PASS — the new route is recognised as a cron (it checks `CRON_SECRET`).

Run: `grep -L stampHeartbeat src/app/api/cron/*/route.js`
Expected: lists only `health-check` (the new route must NOT appear — it calls `stampHeartbeat`).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/cron/instagram-feed-sync/route.js vercel.json
git commit -m "EVENTS-IG.1 — instagram-feed-sync cron (6h) + vercel schedule"
```

---

### Task 6: `InstagramStrip` carousel component

**Files:**
- Create: `src/components/landing-page/InstagramStrip.jsx`
- Test: `src/components/landing-page/InstagramStrip.test.jsx`

The component receives already-resolved posts (with a public `thumb_url`), a `username`, and a `profileUrl`. Dark landing theme. CSS scroll-snap carousel — no external script. Each tile is an `<a>` to the post's `permalink` (new tab, `rel="noopener noreferrer"`). Renders `null` when there are no posts.

- [ ] **Step 1: Write the failing test**

```jsx
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import InstagramStrip from './InstagramStrip.jsx'

const posts = [
  { id: '1', permalink: 'https://instagram.com/p/1', thumb_url: 'https://x/1.jpg', is_reel: false, caption: 'a' },
  { id: '2', permalink: 'https://instagram.com/reel/2', thumb_url: 'https://x/2.jpg', is_reel: true, caption: 'b' },
]

describe('InstagramStrip', () => {
  it('renders a tile per post linking to the permalink with rel=noopener', () => {
    const { container } = render(<InstagramStrip posts={posts} username="un1t" profileUrl="https://instagram.com/un1t" />)
    const links = container.querySelectorAll('a[href^="https://instagram.com/p/"], a[href^="https://instagram.com/reel/"]')
    expect(links.length).toBe(2)
    links.forEach((a) => expect(a.getAttribute('rel')).toContain('noopener'))
  })

  it('marks reels (data-reel) so the badge shows', () => {
    const { container } = render(<InstagramStrip posts={posts} />)
    expect(container.querySelectorAll('[data-reel="true"]').length).toBe(1)
  })

  it('renders nothing when there are no posts', () => {
    const { container } = render(<InstagramStrip posts={[]} />)
    expect(container.firstChild).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/landing-page/InstagramStrip.test.jsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

```jsx
'use client'

// Public events-page Instagram strip (EVENTS-IG.1). A horizontal scroll-snap
// carousel of the studio's latest posts/reels. Tiles link out to Instagram.
// Renders nothing when there are no posts. Dark landing theme (lp-*).

export default function InstagramStrip({ posts, username, profileUrl }) {
  if (!posts || posts.length === 0) return null
  const handle = username ? `@${username}` : 'Instagram'
  const href = profileUrl || (username ? `https://instagram.com/${username}` : null)

  return (
    <section className="w-full py-12">
      <div className="flex items-center justify-between mb-5 px-1">
        <h2 className="text-xl font-semibold tracking-tight text-white">Follow along</h2>
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-sm text-white/70 hover:text-white transition">
            {handle} →
          </a>
        )}
      </div>
      <div className="flex gap-3 overflow-x-auto snap-x snap-mandatory pb-2 -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {posts.map((p) => (
          <a
            key={p.id}
            href={p.permalink}
            target="_blank"
            rel="noopener noreferrer"
            data-reel={p.is_reel ? 'true' : 'false'}
            className="relative shrink-0 snap-start w-40 h-40 sm:w-48 sm:h-48 rounded-xl overflow-hidden bg-white/5 border border-white/10 group"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.thumb_url} alt={p.caption || 'Instagram post'} loading="lazy" className="w-full h-full object-cover transition duration-300 group-hover:scale-105" />
            {p.is_reel && (
              <span className="absolute top-2 right-2 grid place-items-center w-6 h-6 rounded-full bg-black/50 backdrop-blur">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="white" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
              </span>
            )}
          </a>
        ))}
      </div>
    </section>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/landing-page/InstagramStrip.test.jsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/landing-page/InstagramStrip.jsx src/components/landing-page/InstagramStrip.test.jsx
git commit -m "EVENTS-IG.1 — InstagramStrip carousel component"
```

---

### Task 7: Wire the strip into the public events page

**Files:**
- Modify: `src/app/welcome/[location]/events/page.js`

The page already loads the landing row (`loadByPath`, `select('*, …')` → includes `show_instagram_feed`) and has `row.location_id`. Add a helper to read the cached posts + build public thumbnail URLs, then render `<InstagramStrip>` below the events list — gated on the toggle.

- [ ] **Step 1: Add the posts-loader helper (near `loadByPath`)**

```js
import InstagramStrip from '@/components/landing-page/InstagramStrip'

// Latest cached IG posts for the strip, with public thumbnail URLs resolved.
async function loadInstagramPosts(db, locationId) {
  const { data } = await db
    .from('instagram_feed_posts')
    .select('id, ig_username, is_reel, permalink, caption, thumb_path, posted_at')
    .eq('location_id', locationId)
    .order('posted_at', { ascending: false })
    .limit(10)
  if (!data || data.length === 0) return { posts: [], username: null }
  const posts = data.map((p) => ({
    id: p.id,
    permalink: p.permalink,
    is_reel: p.is_reel,
    caption: p.caption,
    thumb_url: db.storage.from('instagram-feed').getPublicUrl(p.thumb_path).data.publicUrl,
  }))
  return { posts, username: data[0].ig_username || null }
}
```

- [ ] **Step 2: Render the strip in the page body (below the events list)**

In the default export, after the `<PublicEventsList … />` render, add (using the `db` + `row` already in scope; if `db`/`row.location_id` isn't in scope at render time, resolve them alongside the existing events query):

```jsx
{row.show_instagram_feed !== false && (() => null)()}
```

Replace that placeholder pattern with a real fetch: near where the page fetches events, also do:

```js
const ig = row.show_instagram_feed !== false
  ? await loadInstagramPosts(db, row.location_id)
  : { posts: [], username: null }
```

and in the JSX, below the list:

```jsx
{ig.posts.length > 0 && (
  <InstagramStrip
    posts={ig.posts}
    username={ig.username}
    profileUrl={ig.username ? `https://instagram.com/${ig.username}` : null}
  />
)}
```

(Read the current `page.js` body first to place these against the real variable names — `db`, `row`, and the events-list render. The strip must sit inside the same `#lp-shell` container as the list so it inherits the dark theme.)

- [ ] **Step 3: Build to verify the wiring compiles**

Run: `npm run build`
Expected: build succeeds; `/welcome/[location]/events` still lists.

- [ ] **Step 4: Commit**

```bash
git add "src/app/welcome/[location]/events/page.js"
git commit -m "EVENTS-IG.1 — render InstagramStrip on the public events page"
```

---

### Task 8: Operator on/off toggle in landing settings

**Files:**
- Modify: `src/app/api/landing-page-settings/route.js`
- Modify: `src/components/LandingPageSettingsForm.jsx`

- [ ] **Step 1: Accept the field in the API PutSchema**

In `src/app/api/landing-page-settings/route.js`, add to the `PutSchema` object:

```js
show_instagram_feed: z.boolean().optional(),
```

Confirm the update path persists it — if the route builds an explicit `updates` object (allow-list), add `show_instagram_feed`; if it spreads validated `body`, it flows through automatically. (Read the route's update block and match its style.)

- [ ] **Step 2: Add the toggle to the settings form**

In `src/components/LandingPageSettingsForm.jsx`, add a labelled checkbox bound to `show_instagram_feed` (default `true` when the field is absent), following the form's existing controlled-field pattern (match how a sibling boolean/text field reads from state and writes into the PUT payload). Label: "Show Instagram posts on the events page". Helper text: "Latest posts from your connected Instagram account. Turn off to hide the strip."

- [ ] **Step 3: Lint + build**

Run: `npx eslint src/app/api/landing-page-settings/route.js src/components/LandingPageSettingsForm.jsx`
Expected: clean.
Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/landing-page-settings/route.js src/components/LandingPageSettingsForm.jsx
git commit -m "EVENTS-IG.1 — operator toggle: show_instagram_feed"
```

---

### Task 9: Live token-scope check, CI mirror, build, PR

**Files:** none (verification + ship)

- [ ] **Step 1: Verify the IG token has media-read scope (live)**

For a connected location, read its `channel_connections` row (`external_account_id`, `access_token`) and hit the media edge once (curl or a throwaway node call):
`https://graph.facebook.com/v21.0/{external_account_id}/media?fields=id,permalink&limit=1&access_token={token}`
- If it returns media → scope is good; the strip will populate on the first cron run (or trigger the cron manually with the `CRON_SECRET`).
- If it errors with a permissions/scope message → **flag to Richard**: the IG connection needs re-authing with `instagram_basic`. The feature still ships safely (strip stays empty) — note it in the PR.

- [ ] **Step 2: Run the full CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`
Expected: all pass.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: succeeds.

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin HEAD
gh pr create --base main --fill
```
Report the PR URL. PR body should note: mig 382 applied via MCP; the `instagram-feed` public bucket; the token-scope check result; and that the strip is empty until the first cron run populates the cache.

- [ ] **Step 5: Adversarial verification (ultracode)**

Run a verification workflow over the diff: (a) the public read exposes no sensitive fields + no IDOR (location scoping); (b) sync prune can never wipe on empty/error (keep-last-good holds); (c) the cron is CRON_SECRET-gated and per-location isolated; (d) no expiring IG URL is ever rendered (only re-hosted `thumb_url`); (e) the toggle default (absent → shown) is intended. Fix any confirmed blocker before merge.

---

## Self-Review (completed by author)

- **Spec coverage:** cron (T5) · re-host to public bucket (T1 bucket + T4 rehost) · `instagram_feed_posts` (T1) · public read + render (T7) · carousel with reel badge + permalink (T6) · operator toggle (T1 column + T8) · graceful empty-state (T4 empty-guard + T6 null + T7 gate) · feasibility check (T9). All spec sections mapped.
- **Placeholder scan:** the only "read the current file to place against real names" notes are in T7/T8 (integration against existing code) — these carry the exact code to insert; the instruction is to position it, not to invent it.
- **Type consistency:** row shape (`ig_media_id, media_type, is_reel, permalink, caption, image_url|thumb_path, posted_at, ig_username`) is consistent across normalize (image_url transient) → sync (thumb_path persisted) → read (thumb_url resolved) → component (thumb_url, permalink, is_reel). `syncLocationIgFeed`, `fetchIgMedia`, `fetchIgUsername`, `normalizeIgMedia` names match their call sites.
