# PRESENT — Slideshow Broadcast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone CRM "Present" feature — upload slide images into a deck, open a public viewer link on any screen, and advance slides from a presenter remote on a laptop with every viewer following within ~1 second.

**Architecture:** Two new tables (`presentations`, `presentation_slides`) + a public `presentation-slides` storage bucket. Staff author decks behind login (new `presentations` permission); each deck has a public `view_token`. Viewers poll a service-role public endpoint every ~1s and soft-swap a preloaded `<img>` when a `version` counter changes (no reload). Reuses the patterns of the existing TV-cast system (public token route, public bucket, fullscreen viewer) but not its tables.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + Storage + RLS), Vitest, Tailwind (`un1t-*` tokens), lucide-react. Branch already exists: `feat-presentations` (the design spec is committed there).

**Spec:** `docs/superpowers/specs/2026-06-18-present-slideshow-design.md`

---

## File structure

**New — pure logic + test**
- `src/lib/presentations.js` — pure helpers: `naturalSortByName`, `clampIndex`, `hasAdvanced`.
- `src/lib/presentations.test.js` — unit tests for the above.

**New — migration**
- `supabase/migrations/291_presentations.sql` — tables, indexes, RLS, public bucket.

**New — API routes** (all under `src/app/api/`)
- `presentations/route.js` — GET list, POST create.
- `presentations/[id]/route.js` — GET one (+slides), DELETE.
- `presentations/[id]/slides/route.js` — POST multipart upload (N images).
- `presentations/[id]/slides/[slideId]/route.js` — DELETE one slide.
- `presentations/[id]/slides/reorder/route.js` — PUT reorder.
- `presentations/[id]/advance/route.js` — POST set current index.
- `public/presentations/[token]/state/route.js` — GET public viewer state.

**New — pages + components**
- `src/app/presentations/page.js` — deck list + create (server page → client list).
- `src/app/presentations/PresentationsClient.jsx` — list UI + new-deck modal.
- `src/app/presentations/[id]/page.js` — author/edit (server shell).
- `src/app/presentations/[id]/PresentationEditor.jsx` — upload / reorder / delete / copy link.
- `src/app/presentations/[id]/present/page.js` — presenter remote (server shell).
- `src/app/presentations/[id]/present/PresenterRemote.jsx` — prev/next + keys + jump grid.
- `src/app/present/[token]/page.js` — public viewer (server prefetch).
- `src/app/present/[token]/PresentViewer.jsx` — fullscreen preloaded-image viewer + poll.

**Modify**
- `shared/permissions.js` — add `presentations` to `WEB_PERMISSIONS` + `DEFAULT_WEB_PERMISSIONS_BY_ROLE`.
- `scripts/check-mobile-parity.mjs` — add `presentations` to `WEB_ONLY_OK`.
- `src/lib/nav-items.js` — add a `/presentations` sidebar entry.
- `src/proxy.js:104` — add `/present/` to `publicPaths`.
- `src/components/AppShell.jsx:28` — add `/present` to `PUBLIC_PATHS`.
- `src/lib/openapi.js` — register the new routes.

---

## Task 1: Pure helpers (`src/lib/presentations.js`) — TDD

**Files:**
- Create: `src/lib/presentations.js`
- Test: `src/lib/presentations.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/presentations.test.js
import { describe, it, expect } from 'vitest'
import { naturalSortByName, clampIndex, hasAdvanced } from './presentations'

describe('presentations: naturalSortByName', () => {
  it('orders Slide2 before Slide10 (numeric-aware, not lexicographic)', () => {
    const items = [
      { name: 'Slide10.JPG' }, { name: 'Slide2.JPG' }, { name: 'Slide1.JPG' },
    ]
    expect(naturalSortByName(items).map((i) => i.name))
      .toEqual(['Slide1.JPG', 'Slide2.JPG', 'Slide10.JPG'])
  })
  it('is stable for names that do not sort cleanly', () => {
    const items = [{ name: 'intro' }, { name: 'cover' }, { name: 'intro' }]
    const out = naturalSortByName(items)
    expect(out).toHaveLength(3)
    expect(out.map((i) => i.name).sort()).toEqual(['cover', 'intro', 'intro'])
  })
  it('does not mutate the input array', () => {
    const items = [{ name: 'b' }, { name: 'a' }]
    naturalSortByName(items)
    expect(items.map((i) => i.name)).toEqual(['b', 'a'])
  })
})

describe('presentations: clampIndex', () => {
  it('clamps to [0, count-1]', () => {
    expect(clampIndex(-3, 5)).toBe(0)
    expect(clampIndex(99, 5)).toBe(4)
    expect(clampIndex(2, 5)).toBe(2)
  })
  it('returns 0 for an empty deck or non-finite input', () => {
    expect(clampIndex(0, 0)).toBe(0)
    expect(clampIndex(3, 0)).toBe(0)
    expect(clampIndex(NaN, 5)).toBe(0)
    expect(clampIndex(undefined, 5)).toBe(0)
  })
})

describe('presentations: hasAdvanced', () => {
  it('true only when the version actually changed', () => {
    expect(hasAdvanced(3, 4)).toBe(true)
    expect(hasAdvanced(3, 3)).toBe(false)
    expect(hasAdvanced(null, 0)).toBe(true)   // first load
    expect(hasAdvanced(0, 0)).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/presentations.test.js`
Expected: FAIL — "Failed to resolve import './presentations'".

- [ ] **Step 3: Write the implementation**

```js
// src/lib/presentations.js
// PRESENT — pure helpers for the slideshow feature. No IO.
//
// Used by the slide-upload route (ordering), the advance route + public
// viewer (index clamping), and the viewer's change detection.

/**
 * Return a new array sorted by `.name` with numeric-aware comparison so
 * PowerPoint's "Slide1.JPG … Slide10.JPG" exports order correctly
 * (a plain lexicographic sort puts Slide10 before Slide2). Stable + pure.
 */
export function naturalSortByName(items) {
  return [...(items || [])].sort((a, b) =>
    String(a?.name ?? '').localeCompare(String(b?.name ?? ''), undefined, { numeric: true, sensitivity: 'base' }),
  )
}

/** Clamp a slide index into [0, count-1]; 0 for an empty deck or bad input. */
export function clampIndex(index, count) {
  const n = Number(index)
  const c = Number(count)
  if (!Number.isFinite(c) || c <= 0) return 0
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(Math.trunc(n), c - 1))
}

/** True when a polled `version` differs from the last one the viewer saw. */
export function hasAdvanced(prevVersion, nextVersion) {
  return prevVersion !== nextVersion
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/presentations.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/presentations.js src/lib/presentations.test.js
git commit -m "PRESENT — pure helpers (naturalSortByName, clampIndex, hasAdvanced) + tests"
```

---

## Task 2: Migration 291 — tables, RLS, public bucket

**Files:**
- Create: `supabase/migrations/291_presentations.sql` (also the source-of-record; apply via Supabase MCP `apply_migration`).

> Verify 291 is the next free number before applying (highest applied is 290 / class_timer). Bump if needed and rename the file to match.

- [ ] **Step 1: Write the migration SQL**

```sql
-- 291_presentations.sql — PRESENT slideshow feature.
-- Standalone laptop-driven multi-screen slideshow. Decks of uploaded slide
-- images; a public view_token drives the viewer; a version counter is the
-- viewer's change signal.

create table if not exists public.presentations (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null references public.locations(id) on delete cascade,
  title         text not null,
  view_token    uuid not null unique default gen_random_uuid(),
  current_index int  not null default 0,
  version       int  not null default 0,
  created_by    uuid references public.profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.presentation_slides (
  id              uuid primary key default gen_random_uuid(),
  presentation_id uuid not null references public.presentations(id) on delete cascade,
  location_id     uuid not null references public.locations(id) on delete cascade,
  position        int  not null,
  image_path      text not null,
  created_at      timestamptz not null default now()
);

create index if not exists idx_presentations_location on public.presentations(location_id);
create index if not exists idx_presentation_slides_deck on public.presentation_slides(presentation_id, position);

alter table public.presentations enable row level security;
alter table public.presentation_slides enable row level security;

-- Location-scoped read/write for authenticated staff (defence-in-depth;
-- the API routes use the service-role client and are the real gate). The
-- public viewer never uses this client — it reads via a service-role API
-- keyed on view_token.
create policy "presentations_location_scoped" on public.presentations
  for all to authenticated
  using (private.auth_is_in_location(location_id))
  with check (private.auth_is_in_location(location_id));

create policy "presentation_slides_location_scoped" on public.presentation_slides
  for all to authenticated
  using (private.auth_is_in_location(location_id))
  with check (private.auth_is_in_location(location_id));

-- Public storage bucket for slide images (mirrors tv-content). Public read;
-- writes happen server-side with the service-role client (bypasses RLS).
insert into storage.buckets (id, name, public)
values ('presentation-slides', 'presentation-slides', true)
on conflict (id) do nothing;
```

- [ ] **Step 2: Apply via Supabase MCP**

Use the `apply_migration` MCP tool (project `iyvtbjjxdggiadzwwvdj`) with name `291_presentations` and the SQL above.

- [ ] **Step 3: Run the security advisor**

Use `get_advisors` MCP tool, `type=security`. Expected: no NEW errors for `presentations` / `presentation_slides` (RLS enabled, policies present, no mutable search_path). Fix anything flagged before moving on.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/291_presentations.sql
git commit -m "PRESENT — mig 291: presentations + presentation_slides tables + public bucket"
```

---

## Task 3: Deck CRUD routes

**Files:**
- Create: `src/app/api/presentations/route.js`
- Create: `src/app/api/presentations/[id]/route.js`

- [ ] **Step 1: Write the list + create route**

```js
// src/app/api/presentations/route.js
// GET  /api/presentations?location_id=<uuid>  — list decks at a location
// POST /api/presentations                      — create a deck { location_id, title }
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function deny() {
  return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'presentations')) return deny()
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id') || user.activeLocation?.id
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'Provide ?location_id=<uuid>' }, { status: 400 })
  }
  if (!user.isMaster && !getUserLocationIds(user).includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Location not in your scope' }, { status: 403 })
  }
  const db = createServerClient()
  const { data, error } = await db
    .from('presentations')
    .select('id, title, view_token, current_index, version, created_at, updated_at, presentation_slides(count)')
    .eq('location_id', locationId)
    .order('updated_at', { ascending: false })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  const presentations = (data || []).map((p) => ({
    id: p.id, title: p.title, view_token: p.view_token,
    current_index: p.current_index, version: p.version,
    created_at: p.created_at, updated_at: p.updated_at,
    slide_count: p.presentation_slides?.[0]?.count ?? 0,
  }))
  return NextResponse.json({ success: true, presentations })
}

const CreateSchema = z.object({ location_id: uuidLike, title: z.string().min(1).max(120) })

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'presentations')) return deny()
  const validation = await validateBody(request, CreateSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const guard = assertLocationAccess(user, body.location_id)
  if (guard) return guard
  const db = createServerClient()
  const { data, error } = await db
    .from('presentations')
    .insert({ location_id: body.location_id, title: body.title.trim(), created_by: user.id })
    .select('id, title, view_token, current_index, version')
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, presentation: data })
}
```

- [ ] **Step 2: Write the single-deck GET + DELETE route**

```js
// src/app/api/presentations/[id]/route.js
// GET    /api/presentations/[id]  — one deck + its ordered slides (resolved URLs)
// DELETE /api/presentations/[id]  — delete deck (cascade slides) + storage objects
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function deny() {
  return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
}
function bucketUrl(path) {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/presentation-slides/${path}`
}
async function loadOwned(db, user, id) {
  const { data: row } = await db
    .from('presentations')
    .select('id, location_id, title, view_token, current_index, version')
    .eq('id', id)
    .maybeSingle()
  if (!row) return { notFound: true }
  if (assertLocationAccess(user, row.location_id)) return { notFound: true }
  return { row }
}

export async function GET(_request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'presentations')) return deny()
  const { id } = await params
  const db = createServerClient()
  const { row, notFound } = await loadOwned(db, user, id)
  if (notFound) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const { data: slides } = await db
    .from('presentation_slides')
    .select('id, position, image_path')
    .eq('presentation_id', id)
    .order('position', { ascending: true })
  return NextResponse.json({
    success: true,
    presentation: { ...row, slides: (slides || []).map((s) => ({ id: s.id, position: s.position, url: bucketUrl(s.image_path) })) },
  })
}

export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'presentations')) return deny()
  const { id } = await params
  const db = createServerClient()
  const { row, notFound } = await loadOwned(db, user, id)
  if (notFound) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  // Best-effort storage cleanup, then the row (cascade removes slide rows).
  const { data: slides } = await db.from('presentation_slides').select('image_path').eq('presentation_id', id)
  const paths = (slides || []).map((s) => s.image_path)
  if (paths.length) { try { await db.storage.from('presentation-slides').remove(paths) } catch { /* best effort */ } }
  const { error } = await db.from('presentations').delete().eq('id', id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
```

- [ ] **Step 3: Verify routes resolve + guards present**

Run: `npm run check:route-guards`
Expected: PASS — the new routes are detected as session-guarded (they use `getCurrentUser`).

- [ ] **Step 4: Commit**

```bash
git add 'src/app/api/presentations/route.js' 'src/app/api/presentations/[id]/route.js'
git commit -m "PRESENT — deck CRUD routes (list/create/get/delete)"
```

---

## Task 4: Slide routes — upload, delete, reorder

**Files:**
- Create: `src/app/api/presentations/[id]/slides/route.js`
- Create: `src/app/api/presentations/[id]/slides/[slideId]/route.js`
- Create: `src/app/api/presentations/[id]/slides/reorder/route.js`

- [ ] **Step 1: Write the multipart upload route**

```js
// src/app/api/presentations/[id]/slides/route.js
// POST /api/presentations/[id]/slides  (multipart/form-data, field `files` × N)
// Uploads images to the presentation-slides bucket, appends slide rows
// after the current max position (natural-sorted by filename), bumps version.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { naturalSortByName } from '@/lib/presentations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']
const MAX_BYTES = 15 * 1024 * 1024

function deny() {
  return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
}

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'presentations')) return deny()
  const { id } = await params
  const db = createServerClient()

  const { data: deck } = await db.from('presentations').select('id, location_id, version').eq('id', id).maybeSingle()
  if (!deck || assertLocationAccess(user, deck.location_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }

  const form = await request.formData()
  const files = form.getAll('files').filter((f) => f && typeof f !== 'string')
  if (!files.length) return NextResponse.json({ success: false, error: 'No files provided.' }, { status: 400 })
  for (const f of files) {
    if (!ALLOWED.includes(f.type)) return NextResponse.json({ success: false, error: `"${f.name}" must be PNG/JPEG/WebP/GIF/AVIF.` }, { status: 400 })
    if (f.size > MAX_BYTES) return NextResponse.json({ success: false, error: `"${f.name}" is over 15MB.` }, { status: 400 })
  }

  // Append after the current highest position.
  const { data: maxRow } = await db
    .from('presentation_slides').select('position').eq('presentation_id', id)
    .order('position', { ascending: false }).limit(1).maybeSingle()
  let pos = (maxRow?.position ?? -1) + 1

  const ordered = naturalSortByName(files.map((f) => ({ name: f.name || '', file: f })))
  const inserted = []
  for (const { file } of ordered) {
    const ext = (file.name?.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
    const path = `${deck.location_id}/${id}/${crypto.randomUUID()}.${ext}`
    const buffer = Buffer.from(await file.arrayBuffer())
    const { error: upErr } = await db.storage.from('presentation-slides')
      .upload(path, buffer, { contentType: file.type, cacheControl: '3600', upsert: false })
    if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 400 })
    const { data: row, error: insErr } = await db.from('presentation_slides')
      .insert({ presentation_id: id, location_id: deck.location_id, position: pos, image_path: path })
      .select('id, position, image_path').single()
    if (insErr) return NextResponse.json({ success: false, error: insErr.message }, { status: 500 })
    inserted.push(row); pos += 1
  }

  await db.from('presentations').update({ version: deck.version + 1, updated_at: new Date().toISOString() }).eq('id', id)
  return NextResponse.json({ success: true, added: inserted.length })
}
```

- [ ] **Step 2: Write the delete-one-slide route**

```js
// src/app/api/presentations/[id]/slides/[slideId]/route.js
// DELETE /api/presentations/[id]/slides/[slideId]
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function DELETE(_request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'presentations')) {
    return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
  }
  const { id, slideId } = await params
  const db = createServerClient()
  const { data: deck } = await db.from('presentations').select('id, location_id, version').eq('id', id).maybeSingle()
  if (!deck || assertLocationAccess(user, deck.location_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const { data: slide } = await db.from('presentation_slides')
    .select('id, image_path').eq('id', slideId).eq('presentation_id', id).maybeSingle()
  if (!slide) return NextResponse.json({ success: false, error: 'Slide not found' }, { status: 404 })
  try { await db.storage.from('presentation-slides').remove([slide.image_path]) } catch { /* best effort */ }
  const { error } = await db.from('presentation_slides').delete().eq('id', slideId)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  await db.from('presentations').update({ version: deck.version + 1, updated_at: new Date().toISOString() }).eq('id', id)
  return NextResponse.json({ success: true })
}
```

- [ ] **Step 3: Write the reorder route**

```js
// src/app/api/presentations/[id]/slides/reorder/route.js
// PUT /api/presentations/[id]/slides/reorder  { order: [slideId, …] }
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({ order: z.array(uuidLike).min(1) })

export async function PUT(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'presentations')) {
    return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
  }
  const { id } = await params
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const { order } = validation.data
  const db = createServerClient()
  const { data: deck } = await db.from('presentations').select('id, location_id, version').eq('id', id).maybeSingle()
  if (!deck || assertLocationAccess(user, deck.location_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  // Rewrite positions to match the given order. Only slides on this deck.
  for (let i = 0; i < order.length; i++) {
    await db.from('presentation_slides').update({ position: i }).eq('id', order[i]).eq('presentation_id', id)
  }
  await db.from('presentations').update({ version: deck.version + 1, updated_at: new Date().toISOString() }).eq('id', id)
  return NextResponse.json({ success: true })
}
```

- [ ] **Step 4: Verify guards**

Run: `npm run check:route-guards`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/presentations/[id]/slides'
git commit -m "PRESENT — slide routes (multipart upload, delete, reorder)"
```

---

## Task 5: Advance route + public viewer-state route

**Files:**
- Create: `src/app/api/presentations/[id]/advance/route.js`
- Create: `src/app/api/public/presentations/[token]/state/route.js`

- [ ] **Step 1: Write the advance route**

```js
// src/app/api/presentations/[id]/advance/route.js
// POST /api/presentations/[id]/advance  { index }  → set current_index, bump version
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { validateBody } from '@/lib/validate'
import { clampIndex } from '@/lib/presentations'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Schema = z.object({ index: z.number().int() })

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !hasPermission(user, 'presentations')) {
    return NextResponse.json({ success: false, error: 'Not authorised for presentations' }, { status: 403 })
  }
  const { id } = await params
  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const db = createServerClient()
  const { data: deck } = await db.from('presentations').select('id, location_id, version').eq('id', id).maybeSingle()
  if (!deck || assertLocationAccess(user, deck.location_id)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const { count } = await db.from('presentation_slides')
    .select('id', { count: 'exact', head: true }).eq('presentation_id', id)
  const next = clampIndex(validation.data.index, count || 0)
  const { data, error } = await db.from('presentations')
    .update({ current_index: next, version: deck.version + 1, updated_at: new Date().toISOString() })
    .eq('id', id).select('current_index, version').single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, current_index: data.current_index, version: data.version })
}
```

- [ ] **Step 2: Write the public viewer-state route**

```js
// src/app/api/public/presentations/[token]/state/route.js
// GET /api/public/presentations/[token]/state — NO auth (token IS the auth).
// The viewer polls this ~1s; soft-swaps the slide when `version` changes.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function bucketUrl(path) {
  return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/presentation-slides/${path}`
}

export async function GET(_request, { params }) {
  const { token } = await params
  if (!token) return NextResponse.json({ success: false, error: 'missing_token' }, { status: 400 })
  const db = createServerClient()
  const { data: deck } = await db
    .from('presentations')
    .select('id, title, current_index, version')
    .eq('view_token', token)
    .maybeSingle()
  if (!deck) return NextResponse.json({ success: false, error: 'invalid_token' }, { status: 404 })
  const { data: slides } = await db
    .from('presentation_slides')
    .select('image_path')
    .eq('presentation_id', deck.id)
    .order('position', { ascending: true })
  return NextResponse.json({
    success: true,
    title: deck.title,
    current_index: deck.current_index,
    version: deck.version,
    slides: (slides || []).map((s) => bucketUrl(s.image_path)),
  })
}
```

- [ ] **Step 3: Verify guards (the public route must be on the exempt list)**

Run: `npm run check:route-guards`
Expected: the `public/presentations/[token]/state` route is recognised as public via the `/api/public/` convention (no extra config). If the checker flags it, add it to the `EXEMPT` map in `scripts/check-route-guards.mjs` with reason `"public viewer state — token is the capability"`. PASS.

- [ ] **Step 4: Commit**

```bash
git add 'src/app/api/presentations/[id]/advance' 'src/app/api/public/presentations'
git commit -m "PRESENT — advance route + public viewer-state route"
```

---

## Task 6: Permission + nav + parity

**Files:**
- Modify: `shared/permissions.js` (WEB_PERMISSIONS + DEFAULT_WEB_PERMISSIONS_BY_ROLE)
- Modify: `scripts/check-mobile-parity.mjs` (WEB_ONLY_OK)
- Modify: `src/lib/nav-items.js`

- [ ] **Step 1: Register the permission**

In `shared/permissions.js`, in the `WEB_PERMISSIONS` frozen array (near the `tv_displays` entry, ~line 89), add:

```js
  { key: 'presentations',      label: '… Presentations',         hint: 'Run a slide deck across multiple screens from a laptop (workshops / events). Upload slide images, open a public viewer link per screen, advance from a presenter remote. Owner/master/manager/head_coach by default.' },
```

Then in `DEFAULT_WEB_PERMISSIONS_BY_ROLE` (same file), add `presentations` next to each role's `tv_displays` entry: `true` for `master`, `owner`, `manager`, `head_coach`; `false` for `staff`.

- [ ] **Step 2: Satisfy the parity linter (web-only)**

In `scripts/check-mobile-parity.mjs`, add to the `WEB_ONLY_OK` map:

```js
  presentations: 'Desktop authoring + present-from-laptop surface; the public viewer is a plain URL opened on a screen. No mobile screen.',
```

- [ ] **Step 3: Add the sidebar entry**

In `src/lib/nav-items.js`, import `Projector` from lucide-react (add to the existing lucide import block), then add to the `gym` section (right after the Class timer / Live HR group):

```js
  // PRESENT — run a slide deck across multiple screens from a laptop.
  { href: '/presentations', label: 'Presentations', icon: Projector, permission: 'presentations', section: 'gym' },
```

Then update `src/lib/nav-items.test.js` `hrefsIn('gym')` assertion to include `/presentations` in the expected array (append it after the existing gym hrefs).

- [ ] **Step 4: Run parity + tests**

Run: `npm run check:mobile-parity && npx vitest run src/lib/nav-items.test.js`
Expected: parity PASS; nav-items test PASS (after updating the assertion).

- [ ] **Step 5: Commit**

```bash
git add shared/permissions.js scripts/check-mobile-parity.mjs src/lib/nav-items.js src/lib/nav-items.test.js
git commit -m "PRESENT — presentations permission + sidebar entry + parity"
```

---

## Task 7: Public viewer (`/present/[token]`) + public-path wiring

**Files:**
- Create: `src/app/present/[token]/page.js`
- Create: `src/app/present/[token]/PresentViewer.jsx`
- Modify: `src/proxy.js:104`
- Modify: `src/components/AppShell.jsx:28`

- [ ] **Step 1: Wire the public paths (BOTH — known footgun)**

In `src/proxy.js` line 104, add `'/present/'` to the `publicPaths` array (next to `'/tv/'`).
In `src/components/AppShell.jsx` line 28, add `'/present'` to the `PUBLIC_PATHS` array (next to `'/tv'`).

- [ ] **Step 2: Write the viewer client component**

```jsx
// src/app/present/[token]/PresentViewer.jsx
'use client'
// PRESENT — fullscreen public viewer. Preloads every slide image once, then
// only toggles which is visible on current_index change (no reload, no flash).
// Polls /api/public/presentations/[token]/state ~1s; swaps on version change.
import { useEffect, useRef, useState } from 'react'
import { hasAdvanced } from '@/lib/presentations'

const POLL_MS = 1000

export default function PresentViewer({ token, initial }) {
  const [slides, setSlides] = useState(initial?.slides || [])
  const [index, setIndex] = useState(initial?.current_index || 0)
  const [invalid, setInvalid] = useState(false)
  const versionRef = useRef(initial?.version ?? null)

  useEffect(() => {
    let cancelled = false
    const tick = async () => {
      try {
        const res = await fetch(`/api/public/presentations/${token}/state?_=${Date.now()}`, { cache: 'no-store' })
        if (res.status === 404) { if (!cancelled) setInvalid(true); return }
        if (!res.ok) return
        const j = await res.json()
        if (cancelled || !j.success) return
        if (hasAdvanced(versionRef.current, j.version)) {
          versionRef.current = j.version
          setSlides(j.slides || [])
          setIndex(j.current_index || 0)
        }
      } catch { /* network blip — retry next tick */ }
    }
    const h = setInterval(tick, POLL_MS)
    return () => { cancelled = true; clearInterval(h) }
  }, [token])

  if (invalid) {
    return <Stage><div style={{ color: '#444', fontSize: 14 }}>Invalid presentation link.</div></Stage>
  }
  const current = slides[index]
  return (
    <Stage>
      {/* Preload every slide; show only the current one. Swapping is instant. */}
      {slides.map((url, i) => (
        <img
          key={url}
          src={url}
          alt=""
          style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%',
            objectFit: 'contain', opacity: i === index ? 1 : 0,
            transition: 'opacity 120ms ease', pointerEvents: 'none',
          }}
        />
      ))}
      {!current && <div style={{ color: '#444', fontSize: 14 }}>Waiting for the presenter…</div>}
    </Stage>
  )
}

function Stage({ children }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#000', overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
    }}>
      {children}
    </div>
  )
}
```

- [ ] **Step 3: Write the viewer server page (prefetch initial state)**

```jsx
// src/app/present/[token]/page.js
// Public fullscreen viewer. Mirrors /tv/cast/[token]: prefetch state
// server-side so the screen renders immediately.
import { headers } from 'next/headers'
import PresentViewer from './PresentViewer'

export const dynamic = 'force-dynamic'
export const metadata = {
  title: 'Presentation',
  viewport: 'width=device-width, initial-scale=1, viewport-fit=cover',
}

export default async function PresentPage(props) {
  const params = await props.params
  const proto = (await headers()).get('x-forwarded-proto') || 'https'
  const host = (await headers()).get('host')
  const res = await fetch(`${proto}://${host}/api/public/presentations/${params.token}/state`, { cache: 'no-store' }).catch(() => null)
  let initial = null
  if (res?.ok) { const j = await res.json(); if (j.success) initial = j }
  return <PresentViewer token={params.token} initial={initial} />
}
```

- [ ] **Step 4: Commit**

```bash
git add 'src/app/present' src/proxy.js src/components/AppShell.jsx
git commit -m "PRESENT — public /present/[token] viewer + middleware/AppShell public-path wiring"
```

---

## Task 8: Presenter remote (`/presentations/[id]/present`)

**Files:**
- Create: `src/app/presentations/[id]/present/page.js`
- Create: `src/app/presentations/[id]/present/PresenterRemote.jsx`

- [ ] **Step 1: Write the server shell**

```jsx
// src/app/presentations/[id]/present/page.js
import { redirect, notFound } from 'next/navigation'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import PresenterRemote from './PresenterRemote'

export const dynamic = 'force-dynamic'

export default async function PresentControlPage(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'presentations')) redirect('/')
  const db = createServerClient()
  const { data: deck } = await db.from('presentations')
    .select('id, location_id, title, current_index').eq('id', params.id).maybeSingle()
  if (!deck || (!user.isMaster && !getUserLocationIds(user).includes(deck.location_id))) notFound()
  const { data: slides } = await db.from('presentation_slides')
    .select('id, position, image_path').eq('presentation_id', params.id).order('position', { ascending: true })
  const base = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/presentation-slides`
  return (
    <PresenterRemote
      id={deck.id}
      title={deck.title}
      initialIndex={deck.current_index || 0}
      slides={(slides || []).map((s) => ({ id: s.id, url: `${base}/${s.image_path}` }))}
    />
  )
}
```

- [ ] **Step 2: Write the remote client component**

```jsx
// src/app/presentations/[id]/present/PresenterRemote.jsx
'use client'
// PRESENT — presenter remote. Prev/Next + arrow/space keys + jump grid.
// Each navigation POSTs /advance {index}; the public viewers follow on their poll.
import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { clampIndex } from '@/lib/presentations'

export default function PresenterRemote({ id, title, initialIndex, slides }) {
  const [index, setIndex] = useState(clampIndex(initialIndex, slides.length))
  const [busy, setBusy] = useState(false)
  const total = slides.length

  const go = useCallback(async (target) => {
    const next = clampIndex(target, total)
    setIndex(next) // optimistic
    setBusy(true)
    try {
      const r = await fetch(`/api/presentations/${id}/advance`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ index: next }),
      })
      const j = await r.json()
      if (j.success && typeof j.current_index === 'number') setIndex(j.current_index)
    } catch { /* keep optimistic */ } finally { setBusy(false) }
  }, [id, total])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') { e.preventDefault(); go(index + 1) }
      else if (e.key === 'ArrowLeft' || e.key === 'Backspace' || e.key === 'PageUp') { e.preventDefault(); go(index - 1) }
      else if (e.key === 'Home') { e.preventDefault(); go(0) }
      else if (e.key === 'End') { e.preventDefault(); go(total - 1) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, total, go])

  if (total === 0) {
    return <div className="p-6 text-sm text-un1t-subtle">This deck has no slides yet. Add slides on the edit page first.</div>
  }
  const next = slides[index + 1]
  return (
    <div className="p-4 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">{title}</h1>
        <span className="text-sm text-un1t-subtle tabular-nums">Slide {index + 1} / {total}</span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-3">
        <div className="rounded-xl border border-un1t-border bg-black aspect-video overflow-hidden flex items-center justify-center">
          <img src={slides[index].url} alt="" className="max-h-full max-w-full object-contain" />
        </div>
        <div className="rounded-xl border border-un1t-border bg-black/90 aspect-video overflow-hidden flex items-center justify-center">
          {next ? <img src={next.url} alt="" className="max-h-full max-w-full object-contain opacity-90" />
                : <span className="text-xs text-un1t-subtle">End of deck</span>}
        </div>
      </div>

      <div className="flex items-center justify-center gap-3">
        <button type="button" disabled={busy || index === 0} onClick={() => go(index - 1)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-un1t-border px-5 py-3 text-base font-medium hover:bg-un1t-surface disabled:opacity-40">
          <ChevronLeft size={18} /> Prev
        </button>
        <button type="button" disabled={busy || index >= total - 1} onClick={() => go(index + 1)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-6 py-3 text-base font-semibold text-white hover:bg-emerald-500 disabled:opacity-40">
          Next <ChevronRight size={18} />
        </button>
      </div>

      <div className="flex flex-wrap gap-1.5 pt-2">
        {slides.map((s, i) => (
          <button key={s.id} type="button" onClick={() => go(i)}
            className={`h-12 w-20 overflow-hidden rounded border ${i === index ? 'border-emerald-500 ring-2 ring-emerald-500/40' : 'border-un1t-border'}`}>
            <img src={s.url} alt="" className="h-full w-full object-cover" />
          </button>
        ))}
      </div>
      <p className="text-center text-xs text-un1t-subtle">Use ← → or space to advance. Viewers update within ~1 second.</p>
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add 'src/app/presentations/[id]/present'
git commit -m "PRESENT — presenter remote (prev/next, keys, next-slide preview, jump grid)"
```

---

## Task 9: Deck list + author/edit pages

**Files:**
- Create: `src/app/presentations/page.js`
- Create: `src/app/presentations/PresentationsClient.jsx`
- Create: `src/app/presentations/[id]/page.js`
- Create: `src/app/presentations/[id]/PresentationEditor.jsx`

- [ ] **Step 1: Write the list server page**

```jsx
// src/app/presentations/page.js
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import PresentationsClient from './PresentationsClient'

export const dynamic = 'force-dynamic'

export default async function PresentationsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'presentations')) redirect('/')
  return <PresentationsClient locationId={user.activeLocation?.id} appUrl={process.env.NEXT_PUBLIC_APP_URL} />
}
```

- [ ] **Step 2: Write the list client (load, create, copy link, links to edit/present)**

```jsx
// src/app/presentations/PresentationsClient.jsx
'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Plus, Projector, Play, Pencil, Copy, Check } from 'lucide-react'

export default function PresentationsClient({ locationId, appUrl }) {
  const [decks, setDecks] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [title, setTitle] = useState('')
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(null)

  async function load() {
    try {
      const r = await fetch(`/api/presentations?location_id=${locationId}`, { cache: 'no-store' })
      const j = await r.json()
      if (j.success) setDecks(j.presentations || [])
    } finally { setLoading(false) }
  }
  useEffect(() => { if (locationId) load() /* eslint-disable-next-line */ }, [locationId])

  async function create(e) {
    e.preventDefault()
    if (!title.trim()) return
    setError(null)
    const r = await fetch('/api/presentations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ location_id: locationId, title: title.trim() }),
    })
    const j = await r.json()
    if (!j.success) { setError(j.error || 'Could not create'); return }
    setTitle(''); setCreating(false); load()
  }
  function viewerUrl(token) { return `${appUrl || ''}/present/${token}` }
  async function copy(token) {
    try { await navigator.clipboard.writeText(viewerUrl(token)); setCopied(token); setTimeout(() => setCopied(null), 1500) } catch { /* ignore */ }
  }

  return (
    <div className="p-6 max-w-3xl">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold">Presentations</h1>
          <p className="text-sm text-un1t-subtle mt-1">Run a slide deck across multiple screens from your laptop.</p>
        </div>
        <button type="button" onClick={() => setCreating(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500">
          <Plus size={15} /> New presentation
        </button>
      </div>

      {creating && (
        <form onSubmit={create} className="mb-5 rounded-xl border border-un1t-border bg-white p-4 flex gap-2">
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Workshop title"
            className="flex-1 rounded-md border border-un1t-border px-3 py-2 text-sm" />
          <button type="submit" className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white">Create</button>
          <button type="button" onClick={() => { setCreating(false); setTitle('') }} className="rounded-md px-3 py-2 text-sm text-un1t-subtle">Cancel</button>
        </form>
      )}
      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}

      {loading ? (
        <p className="text-sm text-un1t-subtle">Loading…</p>
      ) : decks.length === 0 ? (
        <div className="rounded-xl border border-un1t-border bg-un1t-surface p-6 text-center text-sm text-un1t-subtle">
          <Projector className="mx-auto mb-2 text-un1t-muted" /> No decks yet. Create one, then upload your exported slide images.
        </div>
      ) : (
        <ul className="space-y-2">
          {decks.map((d) => (
            <li key={d.id} className="rounded-xl border border-un1t-border bg-white p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium truncate">{d.title}</p>
                <p className="text-xs text-un1t-subtle">{d.slide_count} slide{d.slide_count === 1 ? '' : 's'}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button type="button" onClick={() => copy(d.view_token)} title="Copy viewer link"
                  className="inline-flex items-center gap-1 rounded-md border border-un1t-border px-2.5 py-1.5 text-xs font-medium hover:bg-un1t-surface">
                  {copied === d.view_token ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Viewer link</>}
                </button>
                <Link href={`/presentations/${d.id}`} className="inline-flex items-center gap-1 rounded-md border border-un1t-border px-2.5 py-1.5 text-xs font-medium hover:bg-un1t-surface">
                  <Pencil size={13} /> Edit
                </Link>
                <Link href={`/presentations/${d.id}/present`} className="inline-flex items-center gap-1 rounded-md bg-un1t-accent px-2.5 py-1.5 text-xs font-medium text-white hover:opacity-90">
                  <Play size={13} /> Present
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Write the editor server shell**

```jsx
// src/app/presentations/[id]/page.js
import { redirect, notFound } from 'next/navigation'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import PresentationEditor from './PresentationEditor'

export const dynamic = 'force-dynamic'

export default async function PresentationEditPage(props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) redirect('/login')
  if (!hasPermission(user, 'presentations')) redirect('/')
  const db = createServerClient()
  const { data: deck } = await db.from('presentations')
    .select('id, location_id, title, view_token').eq('id', params.id).maybeSingle()
  if (!deck || (!user.isMaster && !getUserLocationIds(user).includes(deck.location_id))) notFound()
  return <PresentationEditor id={deck.id} title={deck.title} viewToken={deck.view_token} appUrl={process.env.NEXT_PUBLIC_APP_URL} />
}
```

- [ ] **Step 4: Write the editor client (upload / reorder / delete / copy link)**

```jsx
// src/app/presentations/[id]/PresentationEditor.jsx
'use client'
// PRESENT — author a deck: upload slide images, reorder, delete, copy viewer link.
import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Upload, Trash2, ArrowUp, ArrowDown, Copy, Check, Play } from 'lucide-react'

export default function PresentationEditor({ id, title, viewToken, appUrl }) {
  const [slides, setSlides] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const fileRef = useRef(null)

  async function load() {
    const r = await fetch(`/api/presentations/${id}`, { cache: 'no-store' })
    const j = await r.json()
    if (j.success) setSlides(j.presentation.slides || [])
    setLoading(false)
  }
  useEffect(() => { load() /* eslint-disable-next-line */ }, [id])

  async function onFiles(e) {
    const files = Array.from(e.target.files || [])
    if (!files.length) return
    setBusy(true); setError(null)
    const fd = new FormData()
    for (const f of files) fd.append('files', f)
    const r = await fetch(`/api/presentations/${id}/slides`, { method: 'POST', body: fd })
    const j = await r.json()
    setBusy(false)
    if (fileRef.current) fileRef.current.value = ''
    if (!j.success) { setError(j.error || 'Upload failed'); return }
    load()
  }

  async function remove(slideId) {
    if (!confirm('Delete this slide?')) return
    setBusy(true)
    await fetch(`/api/presentations/${id}/slides/${slideId}`, { method: 'DELETE' })
    setBusy(false); load()
  }

  async function move(i, dir) {
    const j = i + dir
    if (j < 0 || j >= slides.length) return
    const order = slides.map((s) => s.id)
    ;[order[i], order[j]] = [order[j], order[i]]
    setSlides((prev) => { const c = [...prev]; [c[i], c[j]] = [c[j], c[i]]; return c }) // optimistic
    setBusy(true)
    await fetch(`/api/presentations/${id}/slides/reorder`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ order }),
    })
    setBusy(false)
  }

  const viewerUrl = `${appUrl || ''}/present/${viewToken}`
  async function copy() { try { await navigator.clipboard.writeText(viewerUrl); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* ignore */ } }

  return (
    <div className="p-6 max-w-3xl space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/presentations" className="text-xs text-un1t-subtle hover:text-un1t-text">← Presentations</Link>
          <h1 className="text-2xl font-bold">{title}</h1>
        </div>
        <Link href={`/presentations/${id}/present`} className="inline-flex items-center gap-1.5 rounded-md bg-un1t-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90">
          <Play size={15} /> Present
        </Link>
      </div>

      <div className="rounded-xl border border-un1t-border bg-un1t-surface p-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-un1t-subtle">Viewer link (open this on each screen)</p>
          <p className="truncate text-sm font-mono">{viewerUrl}</p>
        </div>
        <button type="button" onClick={copy} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-un1t-border bg-white px-2.5 py-1.5 text-xs font-medium hover:bg-un1t-surface">
          {copied ? <><Check size={13} /> Copied</> : <><Copy size={13} /> Copy</>}
        </button>
      </div>

      <div>
        <input ref={fileRef} type="file" accept="image/*" multiple onChange={onFiles} className="hidden" />
        <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
          <Upload size={15} /> {busy ? 'Uploading…' : 'Upload slides'}
        </button>
        <p className="mt-1 text-xs text-un1t-subtle">In PowerPoint: Export → JPEG/PNG → “All Slides”, then select them all here. They sort by filename (Slide1, Slide2, …).</p>
        {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      </div>

      {loading ? <p className="text-sm text-un1t-subtle">Loading…</p> : (
        <ul className="space-y-2">
          {slides.map((s, i) => (
            <li key={s.id} className="flex items-center gap-3 rounded-lg border border-un1t-border bg-white p-2">
              <span className="w-6 text-center text-xs text-un1t-subtle tabular-nums">{i + 1}</span>
              <img src={s.url} alt="" className="h-14 w-24 rounded object-cover bg-black" />
              <div className="ml-auto flex items-center gap-1">
                <button type="button" disabled={busy || i === 0} onClick={() => move(i, -1)} className="rounded p-1.5 text-un1t-subtle hover:bg-un1t-surface disabled:opacity-30"><ArrowUp size={15} /></button>
                <button type="button" disabled={busy || i === slides.length - 1} onClick={() => move(i, 1)} className="rounded p-1.5 text-un1t-subtle hover:bg-un1t-surface disabled:opacity-30"><ArrowDown size={15} /></button>
                <button type="button" disabled={busy} onClick={() => remove(s.id)} className="rounded p-1.5 text-un1t-subtle hover:bg-un1t-surface" aria-label="Delete"><Trash2 size={15} /></button>
              </div>
            </li>
          ))}
          {slides.length === 0 && <li className="rounded-lg border border-un1t-border bg-un1t-surface p-4 text-center text-sm text-un1t-subtle">No slides yet — upload your exported images above.</li>}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Commit**

```bash
git add 'src/app/presentations/page.js' 'src/app/presentations/PresentationsClient.jsx' 'src/app/presentations/[id]/page.js' 'src/app/presentations/[id]/PresentationEditor.jsx'
git commit -m "PRESENT — deck list + author/edit pages (upload, reorder, copy link)"
```

---

## Task 10: openapi registration, full CI mirror, build, ship

**Files:**
- Modify: `src/lib/openapi.js`

- [ ] **Step 1: Register the routes in openapi**

Add the new presentation routes to `src/lib/openapi.js` following the existing registration pattern (path + method + brief summary for each: list/create/get/delete deck, slides upload/delete/reorder, advance, public state). Keep it minimal — one entry per route.

- [ ] **Step 2: Run the full CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards`
Expected: all PASS. Fix any failures before continuing.

- [ ] **Step 3: Run a real production build (new routes + pages + imports)**

Run: `npm run build`
Expected: build completes, route tree lists `/presentations`, `/presentations/[id]`, `/presentations/[id]/present`, `/present/[token]`, and the `/api/presentations/*` + `/api/public/presentations/[token]/state` routes. No import-resolution / Turbopack errors.

- [ ] **Step 4: Run next lint (internal-link rule that bare eslint misses)**

Run: `npx next lint`
Expected: no `@next/next/no-html-link-for-pages` errors (all internal navigation uses `next/link`).

- [ ] **Step 5: Commit + push + PR**

```bash
git add src/lib/openapi.js
git commit -m "PRESENT — register presentation routes in openapi"
git push -u origin feat-presentations
gh pr create --base main --head feat-presentations \
  --title "PRESENT — laptop-driven multi-screen synced slideshow" \
  --body "See docs/superpowers/specs/2026-06-18-present-slideshow-design.md. Upload slide images into a deck, open /present/<token> on each screen, drive from /presentations/[id]/present; viewers follow within ~1s. New presentations permission (web-only). mig 291 + public presentation-slides bucket. Verified: tests + lint + build + parity + route-guards clean."
```

- [ ] **Step 6: Merge**

```bash
gh pr merge --squash --admin --delete-branch
```

---

## Manual verification (operator, before the workshop)

1. `/presentations` → New presentation → title.
2. Edit → Upload your PowerPoint-exported slide images (all at once) → confirm they appear in order; reorder/delete as needed.
3. Copy the **Viewer link**; open it on a second screen/browser (and a third) → confirm it shows slide 1.
4. Open **Present** on the laptop → click Next / press → / Space → confirm every screen advances within ~1s with no flash; test Prev, the jump grid, and a second viewer staying in sync.

## Self-review notes (coverage vs spec)

- Schema (presentations + presentation_slides incl. denormalised location_id + public bucket) → Task 2 ✓
- API (CRUD, multipart upload, delete, reorder, advance, public state) → Tasks 3–5 ✓
- Natural-sort / clampIndex / change-detection (pure, tested) → Task 1 ✓
- Surfaces (list, editor, remote, public viewer) → Tasks 7–9 ✓
- 1s-poll soft-swap sync (preloaded images, version signal) → Task 7 ✓
- New `presentations` permission + WEB_ONLY_OK + nav → Task 6 ✓
- Public-path wiring (proxy + AppShell, both) → Task 7 ✓
- openapi + CI + build + ship → Task 10 ✓
- Non-goals (pptx/PDF convert, notes, rotation, realtime) → explicitly deferred in spec ✓

## Deferred (not blocking the weekend)

Supabase Realtime for true-instant sync · PDF/`.pptx` upload with client-side rasterisation · portrait rotation of the viewer · speaker notes / annotations.
