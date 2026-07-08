# Host Self-Serve Event Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a 3rd-party event host create + edit their own events in the host portal, gated by a UN1T review step (draft → submit → approve → published), without ever exposing UN1T-only fields or letting an unapproved event go public or take money.

**Architecture:** A new `status` column on `race_events` (default `'published'`, so existing events are untouched) drives a state machine enforced in three places: host create/edit API routes (`getCurrentHost`-gated, `host_id` forced to self), a staff review route + queue (`ADMIN_ROLES`, org-scoped), and the four public read/booking paths (which gain `status='published'`). Host events anchor to one hidden `locations` row per host (avoids the `teams (location_id, name)` collision) and carry free-text `venue_name`/`venue_address` shown in place of a UN1T address.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role `createServerClient`), Zod, Vitest, Tailwind (dark host surfaces). Spec: `docs/superpowers/specs/2026-07-08-host-self-serve-events-design.md`.

---

## File Structure

**Create:**
- `supabase/migrations/388_host_self_serve_events.sql` — status/venue/audit cols on race_events; `anchor_location_id` on event_hosts; `is_host_anchor` on locations.
- `src/lib/host-events.js` — pure: statuses, `eventIsPublic`, `computeEditTransition`, `hostEventDefaults`, `deriveHostEventPatch`, `HostEventSchema` (Zod). DB helper `ensureAnchorLocation`.
- `src/lib/host-events.test.js` — unit tests for the pure functions.
- `src/app/api/host/events/[id]/route.js` — GET (load own event) + PUT (edit, with re-review transition).
- `src/app/api/host/events/[id]/submit/route.js` — POST (draft/rejected → pending_review).
- `src/app/api/events/[id]/review/route.js` — POST approve/reject (staff, ADMIN_ROLES, org IDOR).
- `src/app/host/(portal)/events/new/page.js` — host create page.
- `src/app/host/(portal)/events/[id]/edit/page.js` — host edit page.
- `src/components/host/HostEventForm.jsx` — shared create/edit form (client).
- `src/components/settings/HostEventReviewQueue.jsx` — staff pending-review queue.

**Modify:**
- `src/app/api/host/events/route.js` — add `POST` (create as draft) beside the existing GET.
- `src/app/api/public/events/[slug]/route.js` — add `status='published'` gate + `eventIsPublic` assertion.
- `src/app/event/[slug]/page.js` — `generateMetadata` gate `status='published'`.
- `src/app/welcome/[location]/events/page.js` — listing gate `status='published'` + `host_id IS NULL`.
- `src/app/api/public/events/[slug]/register/route.js` — booking gate `status='published'` + assertion.
- `src/app/host/(portal)/page.js` — "Create event" button, per-event status chip, edit link.
- `src/app/settings/hosts/page.jsx` — mount `<HostEventReviewQueue/>` (pending count + list).
- `scripts/check-route-guards.mjs` — (verify `getCurrentHost` already in SESSION_GUARDS; no change expected).

---

## Task 1: Migration — status, venue, audit, anchor columns

**Files:**
- Create: `supabase/migrations/388_host_self_serve_events.sql`

- [ ] **Step 1: Write the migration**

```sql
-- HOST-PORTAL.3 — host self-serve event creation.
-- Adds the draft→pending_review→published→rejected lifecycle to race_events
-- (default 'published' so every existing + staff-created event is unaffected),
-- free-text venue columns for host-run venues, an audit trail, a per-host hidden
-- anchor location (event_hosts.anchor_location_id), and a flag to exclude those
-- anchors from staff/public/reporting location surfaces.

alter table race_events
  add column if not exists status text not null default 'published'
    check (status in ('draft', 'pending_review', 'published', 'rejected')),
  add column if not exists venue_name text,
  add column if not exists venue_address text,
  add column if not exists submitted_at timestamptz,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid,
  add column if not exists rejected_reason text;

comment on column race_events.status is
  'Publication lifecycle. Only host-authored events leave ''published''; staff/internal events keep the default.';

create index if not exists idx_race_events_host_pending
  on race_events (host_id, status) where host_id is not null;

alter table event_hosts
  add column if not exists anchor_location_id uuid references locations(id);

comment on column event_hosts.anchor_location_id is
  'Hidden per-host locations row used as location_id for all this host''s events. Provisioned lazily on first host-authored event create. Avoids the teams (location_id, name) cross-host collision.';

alter table locations
  add column if not exists is_host_anchor boolean not null default false;

comment on column locations.is_host_anchor is
  'TRUE = a hidden per-host anchor location for host-run events. Exclude from staff location pickers, public UN1T listings, and org location rollups.';
```

- [ ] **Step 2: Apply via Supabase MCP**

Apply `388_host_self_serve_events.sql` with `mcp__36c9302e-...__apply_migration` against project `iyvtbjjxdggiadzwwvdj` (confirm via `list_projects` — NOT sentinel). Name: `host_self_serve_events`.

- [ ] **Step 3: Run advisors**

Run `mcp__36c9302e-...__get_advisors` type=security. Expected: no new ERROR. (New columns on RLS-enabled tables are fine; `is_host_anchor`/`status` need no policy change — all writes are service-role via `/api`.)

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/388_host_self_serve_events.sql
git commit -m "HOST-PORTAL.3 — mig 388: event status lifecycle + venue + per-host anchor"
```

---

## Task 2: Pure lib — status machine, public predicate, edit diff, defaults

**Files:**
- Create: `src/lib/host-events.js`
- Test: `src/lib/host-events.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/host-events.test.js
import { describe, it, expect } from 'vitest'
import {
  eventIsPublic,
  hostEventDefaults,
  computeEditTransition,
  deriveSlug,
  HOST_EVENT_KINDS,
} from './host-events'

describe('eventIsPublic', () => {
  it('is public only when active AND status=published', () => {
    expect(eventIsPublic({ active: true, status: 'published' })).toBe(true)
    expect(eventIsPublic({ active: false, status: 'published' })).toBe(false)
    expect(eventIsPublic({ active: true, status: 'draft' })).toBe(false)
    expect(eventIsPublic({ active: true, status: 'pending_review' })).toBe(false)
    expect(eventIsPublic({ active: true, status: 'rejected' })).toBe(false)
  })
  it('treats a missing status as not public (defensive)', () => {
    expect(eventIsPublic({ active: true })).toBe(false)
    expect(eventIsPublic(null)).toBe(false)
  })
})

describe('hostEventDefaults', () => {
  it('forces safe UN1T-only fields off', () => {
    const d = hostEventDefaults()
    expect(d).toMatchObject({
      member_pricing_enabled: false,
      members_only: false,
      member_fee_cents: null,
      shared: false,
      create_in_glofox: false,
      staff_required: 0,
      payment_currency: 'EUR',
      capacity_mode: 'people',
    })
  })
})

describe('computeEditTransition', () => {
  const published = { status: 'published', race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }] }

  it('keeps published + no re-review for a cosmetic-only edit', () => {
    const t = computeEditTransition(published, { race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }], description: 'new copy' })
    expect(t).toEqual({ status: 'published', reReview: false })
  })
  it('re-reviews when price changes on a published event', () => {
    const t = computeEditTransition(published, { race_date: '2026-09-01', non_member_fee_cents: 3000, waves: [{ id: 'w1', start_time: '10:00' }] })
    expect(t).toEqual({ status: 'pending_review', reReview: true })
  })
  it('re-reviews when date changes on a published event', () => {
    const t = computeEditTransition(published, { race_date: '2026-09-08', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '10:00' }] })
    expect(t).toEqual({ status: 'pending_review', reReview: true })
  })
  it('re-reviews when a wave start_time changes on a published event', () => {
    const t = computeEditTransition(published, { race_date: '2026-09-01', non_member_fee_cents: 2500, waves: [{ id: 'w1', start_time: '11:00' }] })
    expect(t).toEqual({ status: 'pending_review', reReview: true })
  })
  it('draft/rejected edits never trigger re-review and keep their status', () => {
    expect(computeEditTransition({ status: 'draft', non_member_fee_cents: 2500 }, { non_member_fee_cents: 9999 })).toEqual({ status: 'draft', reReview: false })
    expect(computeEditTransition({ status: 'rejected', non_member_fee_cents: 2500 }, { non_member_fee_cents: 9999 })).toEqual({ status: 'rejected', reReview: false })
  })
})

describe('deriveSlug', () => {
  it('slugifies a name', () => {
    expect(deriveSlug('Summer Throwdown 2026!')).toBe('summer-throwdown-2026')
  })
  it('falls back to a non-empty slug', () => {
    expect(deriveSlug('###')).toBe('event')
    expect(deriveSlug('')).toBe('event')
  })
})

describe('HOST_EVENT_KINDS', () => {
  it('excludes lead_gen (UN1T-only)', () => {
    expect(HOST_EVENT_KINDS).not.toContain('lead_gen')
    expect(HOST_EVENT_KINDS).toContain('workshop')
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/lib/host-events.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/lib/host-events.js` (pure parts)**

```js
// Host self-serve event lifecycle (HOST-PORTAL.3). Pure helpers + the host
// event Zod schema + the anchor-location provisioner. See
// docs/superpowers/specs/2026-07-08-host-self-serve-events-design.md.

import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'

export const HOST_EVENT_STATUSES = ['draft', 'pending_review', 'published', 'rejected']
// lead_gen is a UN1T lead-capture concept — never host-selectable.
export const HOST_EVENT_KINDS = ['workshop', 'seminar', 'masterclass', 'open_day', 'race']

export const HOST_EVENT_STATUS_LABEL = {
  draft: 'Draft',
  pending_review: 'In review',
  published: 'Published',
  rejected: 'Needs changes',
}

/** An event is publicly visible/bookable only when active AND published. */
export function eventIsPublic(event) {
  return !!event && event.active === true && event.status === 'published'
}

/** Server-forced defaults for a host-authored event — UN1T-only fields off. */
export function hostEventDefaults() {
  return {
    member_pricing_enabled: false,
    members_only: false,
    member_fee_cents: null,
    shared: false,
    create_in_glofox: false,
    staff_required: 0,
    payment_currency: 'EUR',
    capacity_mode: 'people',
  }
}

export function deriveSlug(name) {
  const s = String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'event'
}

/**
 * Decide the status transition when a host edits their event.
 * - Not published (draft/rejected): keep status, never re-review.
 * - Published: cosmetic edits stay published; a change to price
 *   (non_member_fee_cents), race_date, or any wave start_time flips to
 *   pending_review (UN1T re-approval; the event stays live at old values).
 * @param {{status:string, race_date?:string, non_member_fee_cents?:number, waves?:Array}} current
 * @param {{race_date?:string, non_member_fee_cents?:number, waves?:Array}} changes
 * @returns {{status:string, reReview:boolean}}
 */
export function computeEditTransition(current, changes) {
  if (current.status !== 'published') return { status: current.status, reReview: false }

  const priceChanged = 'non_member_fee_cents' in changes
    && Number(changes.non_member_fee_cents) !== Number(current.non_member_fee_cents)
  const dateChanged = 'race_date' in changes
    && String(changes.race_date || '') !== String(current.race_date || '')

  const curTimes = (current.waves || []).map((w) => `${w.id || ''}:${w.start_time || ''}`).join('|')
  const newTimes = (changes.waves || []).map((w) => `${w.id || ''}:${w.start_time || ''}`).join('|')
  const waveTimeChanged = 'waves' in changes && curTimes !== newTimes

  const reReview = priceChanged || dateChanged || waveTimeChanged
  return { status: reReview ? 'pending_review' : 'published', reReview }
}

// Strict host-event input schema — a subset of the internal CreateSchema. The
// host route NEVER accepts UN1T-only fields (location_id, host_id, shared,
// staff_required, member pricing, create_in_glofox); .strict() rejects extras.
export const HostEventSchema = z.object({
  kind: z.enum(HOST_EVENT_KINDS),
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional().nullable(),
  race_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  registration_opens_at: z.string().datetime().optional().nullable(),
  registration_closes_at: z.string().datetime().optional().nullable(),
  allowed_team_sizes: z.array(z.number().int().min(1).max(8)).min(1),
  ticket_price_cents: z.number().int().min(0).max(1_000_000), // per person → non_member_fee_cents
  session_start_time: z.string().regex(/^\d{2}:\d{2}$/),
  session_capacity: z.number().int().min(1).max(100000),
  session_label: z.string().max(120).optional().nullable(),
  hero_image_url: z.string().url().optional().nullable(),
  accent_hex: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().nullable(),
  venue_name: z.string().trim().min(1).max(200),
  venue_address: z.string().trim().max(500).optional().nullable(),
  confirmation_email_subject: z.string().max(300).optional().nullable(),
  confirmation_email_intro: z.string().max(5000).optional().nullable(),
  reminder_email_subject: z.string().max(300).optional().nullable(),
  reminder_email_intro: z.string().max(5000).optional().nullable(),
}).strict()

export { uuidLike }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/host-events.test.js`
Expected: PASS (all groups).

- [ ] **Step 5: Commit**

```bash
git add src/lib/host-events.js src/lib/host-events.test.js
git commit -m "HOST-PORTAL.3 — host-events lib: status machine, public predicate, edit diff, schema"
```

---

## Task 3: Anchor-location provisioner (`ensureAnchorLocation`)

**Files:**
- Modify: `src/lib/host-events.js` (append the DB helper)
- Test: `src/lib/host-events.test.js` (append a mock-db test)

- [ ] **Step 1: Add the failing test**

```js
// append to src/lib/host-events.test.js
import { ensureAnchorLocation } from './host-events'

function fakeDb(existingAnchor) {
  const calls = { inserted: null, updatedHost: null }
  return {
    calls,
    from(table) {
      if (table === 'locations') {
        return {
          insert: (row) => ({ select: () => ({ single: async () => { calls.inserted = row; return { data: { id: 'loc-new' }, error: null } } }) }),
        }
      }
      if (table === 'event_hosts') {
        return { update: (patch) => ({ eq: async () => { calls.updatedHost = patch; return { error: null } } }) }
      }
      throw new Error('unexpected table ' + table)
    },
  }
}

describe('ensureAnchorLocation', () => {
  it('returns the existing anchor without creating one', async () => {
    const db = fakeDb()
    const id = await ensureAnchorLocation(db, { id: 'h1', name: 'Acme', organization_id: 'org1', anchor_location_id: 'loc-existing' })
    expect(id).toBe('loc-existing')
    expect(db.calls.inserted).toBe(null)
  })
  it('creates a hidden anchor location + links it when none exists', async () => {
    const db = fakeDb()
    const id = await ensureAnchorLocation(db, { id: 'h1', name: 'Acme', organization_id: 'org1', anchor_location_id: null })
    expect(id).toBe('loc-new')
    expect(db.calls.inserted).toMatchObject({ organization_id: 'org1', is_host_anchor: true, active: true })
    expect(db.calls.inserted.name).toContain('Acme')
    expect(db.calls.updatedHost).toEqual({ anchor_location_id: 'loc-new' })
  })
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/lib/host-events.test.js -t ensureAnchorLocation`
Expected: FAIL (`ensureAnchorLocation` not exported).

- [ ] **Step 3: Implement the helper (append to `src/lib/host-events.js`)**

```js
/**
 * Return the host's anchor location id, provisioning a hidden per-host
 * `locations` row on first use. Idempotent per host. Service-role db.
 * @param {import('@supabase/supabase-js').SupabaseClient} db
 * @param {{id:string, name:string, organization_id:string, anchor_location_id:string|null}} host
 * @returns {Promise<string>} anchor location id
 */
export async function ensureAnchorLocation(db, host) {
  if (host.anchor_location_id) return host.anchor_location_id
  const { data, error } = await db
    .from('locations')
    .insert({
      organization_id: host.organization_id,
      name: `${host.name} (host events)`,
      active: true,
      is_host_anchor: true,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`anchor location provisioning failed: ${error?.message || 'no row'}`)
  await db.from('event_hosts').update({ anchor_location_id: data.id }).eq('id', host.id)
  return data.id
}
```

Note: `locations` may have other NOT NULL columns without defaults. During implementation, run `select column_name, is_nullable, column_default from information_schema.columns where table_name='locations'` (Supabase MCP `execute_sql`) and add any required fields to the insert. Do NOT create a `landing_page_settings` row for it (keeps it unlisted publicly).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/host-events.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/host-events.js src/lib/host-events.test.js
git commit -m "HOST-PORTAL.3 — ensureAnchorLocation: lazy per-host hidden anchor"
```

---

## Task 4: Public visibility gating (4 paths)

**Files:**
- Modify: `src/app/api/public/events/[slug]/route.js`
- Modify: `src/app/event/[slug]/page.js`
- Modify: `src/app/welcome/[location]/events/page.js`
- Modify: `src/app/api/public/events/[slug]/register/route.js`

- [ ] **Step 1: Data route** — `src/app/api/public/events/[slug]/route.js`

Find the query `.eq('slug', params.slug).eq('active', true).single()` (~line 32). Add the status filter:

```js
    .eq('slug', params.slug)
    .eq('active', true)
    .eq('status', 'published')
    .single()
```

Import `eventIsPublic` and add a belt-and-suspenders assertion right after the `race` row is loaded (before returning it):

```js
import { eventIsPublic } from '@/lib/host-events'
// ...after fetching `race` (the .single() result):
if (!eventIsPublic(race)) {
  return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
}
```

- [ ] **Step 2: Metadata** — `src/app/event/[slug]/page.js`

Find the `generateMetadata` lookup `.eq('active', true)` (~line 44); add `.eq('status', 'published')` so unpublished events get no OG metadata.

- [ ] **Step 3: Public listing** — `src/app/welcome/[location]/events/page.js`

Find the query (~lines 91-97) with `.or(...).eq('active', true).gte('race_date', today)`. Add:

```js
    .eq('active', true)
    .eq('status', 'published')
    .is('host_id', null)          // host events never appear in a UN1T location listing
    .gte('race_date', today)
```

- [ ] **Step 4: Register route** — `src/app/api/public/events/[slug]/register/route.js`

Find `.eq('slug', ...).eq('active', true).single()` (~line 101). Add `.eq('status', 'published')`. Import `eventIsPublic` and after loading `race`, before any booking work:

```js
import { eventIsPublic } from '@/lib/host-events'
// ...after the race .single():
if (!race || !eventIsPublic(race)) {
  return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
}
```
(Confirm the select includes `active, status` so the predicate has its inputs.)

- [ ] **Step 5: Verify existing events stay visible**

Run: `npm test` — the full suite must stay green (existing event/registration tests use default `status='published'`).
Run: `npm run build` — all four routes compile.
Manually confirm via `execute_sql` that a sample existing event has `status='published'`.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/public/events src/app/event src/app/welcome
git commit -m "HOST-PORTAL.3 — gate all public event paths on status=published"
```

---

## Task 5: Host create API (`POST /api/host/events`)

**Files:**
- Modify: `src/app/api/host/events/route.js` (add POST beside GET)

- [ ] **Step 1: Add the POST handler**

```js
import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { HostEventSchema, hostEventDefaults, deriveSlug, ensureAnchorLocation } from '@/lib/host-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// (existing GET stays)

export async function POST(request) {
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let body
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = HostEventSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Invalid event', issues: parsed.error.issues }, { status: 400 })
  }
  const input = parsed.data

  const db = createServerClient()
  // getCurrentHost returns HOST_PORTAL_COLS only; re-read the anchor + org for provisioning.
  const { data: host } = await db
    .from('event_hosts')
    .select('id, name, organization_id, anchor_location_id')
    .eq('id', session.host.id)
    .single()
  if (!host) return NextResponse.json({ success: false, error: 'Host not found' }, { status: 404 })

  const locationId = await ensureAnchorLocation(db, host)

  // Unique slug within the anchor location.
  let slug = deriveSlug(input.name)
  for (let n = 2; ; n++) {
    const { data: clash } = await db.from('race_events').select('id').eq('location_id', locationId).eq('slug', slug).maybeSingle()
    if (!clash) break
    slug = `${deriveSlug(input.name)}-${n}`
  }

  const defaults = hostEventDefaults()
  const { data: event, error } = await db
    .from('race_events')
    .insert({
      location_id: locationId,
      host_id: host.id,
      status: 'draft',
      active: true,
      kind: input.kind,
      name: input.name,
      slug,
      description: input.description ?? null,
      race_date: input.race_date,
      registration_opens_at: input.registration_opens_at ?? null,
      registration_closes_at: input.registration_closes_at ?? null,
      allowed_team_sizes: input.allowed_team_sizes,
      non_member_fee_cents: input.ticket_price_cents,
      hero_image_url: input.hero_image_url ?? null,
      accent_hex: input.accent_hex ?? null,
      venue_name: input.venue_name,
      venue_address: input.venue_address ?? null,
      confirmation_email_subject: input.confirmation_email_subject ?? null,
      confirmation_email_intro: input.confirmation_email_intro ?? null,
      reminder_email_subject: input.reminder_email_subject ?? null,
      reminder_email_intro: input.reminder_email_intro ?? null,
      ...defaults,
    })
    .select('id, slug')
    .single()
  if (error || !event) return NextResponse.json({ success: false, error: error?.message || 'Create failed' }, { status: 500 })

  // Single session → one race_waves row (mirrors non-race kinds).
  const { error: waveErr } = await db.from('race_waves').insert({
    race_event_id: event.id,
    start_time: input.session_start_time,
    capacity: input.session_capacity,
    label: input.session_label ?? null,
    display_order: 0,
  })
  if (waveErr) {
    await db.from('race_events').delete().eq('id', event.id) // rollback the orphan
    return NextResponse.json({ success: false, error: waveErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { id: event.id } })
}
```

Note: confirm the exact `race_waves` column names against `supabase/migrations/083_race_waves.sql` (esp. `display_order`/`label`/`capacity`) during implementation.

- [ ] **Step 2: Verify route guard**

Run: `npm run check:route-guards`
Expected: PASS (`getCurrentHost` recognised; POST + GET both guarded).

- [ ] **Step 3: Build**

Run: `npm run build` — route compiles.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/host/events/route.js
git commit -m "HOST-PORTAL.3 — POST /api/host/events: create as draft (host-scoped)"
```

---

## Task 6: Host edit API (`GET` + `PUT /api/host/events/[id]`)

**Files:**
- Create: `src/app/api/host/events/[id]/route.js`

- [ ] **Step 1: Implement GET + PUT**

```js
// GET loads the host's own event for the edit form; PUT applies edits and the
// price/date re-review transition. host_id === session.host.id or 404. (HOST-PORTAL.3)
import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'
import { HostEventSchema, computeEditTransition } from '@/lib/host-events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function loadOwn(db, session, id) {
  const { data } = await db
    .from('race_events')
    .select('id, host_id, status, kind, name, slug, description, race_date, registration_opens_at, registration_closes_at, allowed_team_sizes, non_member_fee_cents, hero_image_url, accent_hex, venue_name, venue_address, confirmation_email_subject, confirmation_email_intro, reminder_email_subject, reminder_email_intro, race_waves ( id, start_time, capacity, label, display_order )')
    .eq('id', id)
    .maybeSingle()
  if (!data || data.host_id !== session.host.id) return null
  return data
}

export async function GET(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const event = await loadOwn(db, session, params.id)
  if (!event) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  return NextResponse.json({ success: true, data: event })
}

export async function PUT(request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let body
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = HostEventSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid event', issues: parsed.error.issues }, { status: 400 })
  const input = parsed.data

  const db = createServerClient()
  const current = await loadOwn(db, session, params.id)
  if (!current) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  const changes = {
    race_date: input.race_date,
    non_member_fee_cents: input.ticket_price_cents,
    // map single-session input to a waves shape for the diff (compare stored wave time)
    waves: (current.race_waves || []).slice(0, 1).map((w) => ({ id: w.id, start_time: input.session_start_time })),
  }
  const currentForDiff = {
    status: current.status,
    race_date: current.race_date,
    non_member_fee_cents: current.non_member_fee_cents,
    waves: (current.race_waves || []).slice(0, 1).map((w) => ({ id: w.id, start_time: w.start_time })),
  }
  const transition = computeEditTransition(currentForDiff, changes)

  const { error } = await db.from('race_events').update({
    kind: input.kind,
    name: input.name,
    description: input.description ?? null,
    race_date: input.race_date,
    registration_opens_at: input.registration_opens_at ?? null,
    registration_closes_at: input.registration_closes_at ?? null,
    allowed_team_sizes: input.allowed_team_sizes,
    non_member_fee_cents: input.ticket_price_cents,
    hero_image_url: input.hero_image_url ?? null,
    accent_hex: input.accent_hex ?? null,
    venue_name: input.venue_name,
    venue_address: input.venue_address ?? null,
    confirmation_email_subject: input.confirmation_email_subject ?? null,
    confirmation_email_intro: input.confirmation_email_intro ?? null,
    reminder_email_subject: input.reminder_email_subject ?? null,
    reminder_email_intro: input.reminder_email_intro ?? null,
    status: transition.status,
    ...(transition.reReview ? { submitted_at: new Date().toISOString(), reviewed_at: null } : {}),
  }).eq('id', current.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  // Update the single session wave (start_time/capacity/label).
  const wave = (current.race_waves || [])[0]
  if (wave) {
    await db.from('race_waves').update({ start_time: input.session_start_time, capacity: input.session_capacity, label: input.session_label ?? null }).eq('id', wave.id)
  } else {
    await db.from('race_waves').insert({ race_event_id: current.id, start_time: input.session_start_time, capacity: input.session_capacity, label: input.session_label ?? null, display_order: 0 })
  }

  return NextResponse.json({ success: true, data: { id: current.id, status: transition.status, reReview: transition.reReview } })
}
```

Note: `new Date().toISOString()` is fine in a route (the workflow-script ban does NOT apply to app code).

- [ ] **Step 2: Guard + build**

Run: `npm run check:route-guards` (PASS) then `npm run build` (compiles).

- [ ] **Step 3: Commit**

```bash
git add "src/app/api/host/events/[id]/route.js"
git commit -m "HOST-PORTAL.3 — GET+PUT /api/host/events/[id]: edit + price/date re-review"
```

---

## Task 7: Host submit API (`POST /api/host/events/[id]/submit`)

**Files:**
- Create: `src/app/api/host/events/[id]/submit/route.js`

- [ ] **Step 1: Implement**

```js
// Host submits a draft/rejected event for UN1T review. (HOST-PORTAL.3)
import { NextResponse } from 'next/server'
import { getCurrentHost } from '@/lib/host-auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const params = await props.params
  const session = await getCurrentHost()
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { data: event } = await db.from('race_events').select('id, host_id, status').eq('id', params.id).maybeSingle()
  if (!event || event.host_id !== session.host.id) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (event.status !== 'draft' && event.status !== 'rejected') {
    return NextResponse.json({ success: false, error: `Cannot submit an event that is ${event.status}.` }, { status: 409 })
  }

  const { error } = await db.from('race_events').update({
    status: 'pending_review',
    submitted_at: new Date().toISOString(),
    rejected_reason: null,
  }).eq('id', event.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: { id: event.id, status: 'pending_review' } })
}
```

- [ ] **Step 2: Guard + build + commit**

Run: `npm run check:route-guards` (PASS), `npm run build`.
```bash
git add "src/app/api/host/events/[id]/submit/route.js"
git commit -m "HOST-PORTAL.3 — POST submit: draft/rejected -> pending_review"
```

---

## Task 8: Staff review API (`POST /api/events/[id]/review`)

**Files:**
- Create: `src/app/api/events/[id]/review/route.js`

- [ ] **Step 1: Implement (ADMIN_ROLES + org IDOR)**

```js
// Staff approve/reject a host event pending review. ADMIN_ROLES; the event's
// host must be in the caller's org (IDOR guard). (HOST-PORTAL.3)
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { ADMIN_ROLES } from '@/lib/schemas'
import { loadHostForOrg } from '@/lib/hosts'
import { z } from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ReviewSchema = z.object({
  action: z.enum(['approve', 'reject']),
  reason: z.string().max(2000).optional().nullable(),
})

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.includes(user.role)) return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 })

  let body
  try { body = await request.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = ReviewSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid', issues: parsed.error.issues }, { status: 400 })
  if (parsed.data.action === 'reject' && !parsed.data.reason?.trim()) {
    return NextResponse.json({ success: false, error: 'A reason is required to reject.' }, { status: 400 })
  }

  const db = createServerClient()
  const { data: event } = await db.from('race_events').select('id, host_id, status').eq('id', params.id).maybeSingle()
  if (!event || !event.host_id) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  // IDOR: the event's host must belong to the caller's org.
  const host = await loadHostForOrg(db, event.host_id, orgId)
  if (!host) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (event.status !== 'pending_review') {
    return NextResponse.json({ success: false, error: `Event is ${event.status}, not pending review.` }, { status: 409 })
  }

  const nowIso = new Date().toISOString()
  const patch = parsed.data.action === 'approve'
    ? { status: 'published', reviewed_at: nowIso, reviewed_by: user.id, rejected_reason: null }
    : { status: 'rejected', reviewed_at: nowIso, reviewed_by: user.id, rejected_reason: parsed.data.reason.trim() }
  const { error } = await db.from('race_events').update(patch).eq('id', event.id)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  // Fire-and-forget host notification (reuse the transactional email path); never block the response.
  // TODO-in-impl: call the existing host-notify helper if one exists; otherwise skip in v1.

  return NextResponse.json({ success: true, data: { id: event.id, status: patch.status } })
}
```

Note: the `TODO-in-impl` email line is optional for v1 — if no host-notify helper exists, omit it (do not invent one). The status change is the contract.

- [ ] **Step 2: Guard + build + commit**

Run: `npm run check:route-guards` (PASS), `npm run build`.
```bash
git add "src/app/api/events/[id]/review/route.js"
git commit -m "HOST-PORTAL.3 — POST /api/events/[id]/review: approve/reject (ADMIN, org-scoped)"
```

---

## Task 9: Staff review queue UI (Settings → Hosts)

**Files:**
- Create: `src/components/settings/HostEventReviewQueue.jsx`
- Modify: `src/app/settings/hosts/page.jsx`

- [ ] **Step 1: Build `HostEventReviewQueue.jsx`**

A client component that fetches pending host events for the org and renders a list; each row has Approve + Reject (reason prompt) buttons calling `POST /api/events/[id]/review`. Data source: add a small `GET /api/hosts/pending-events` (ADMIN_ROLES, org-scoped) returning `race_events` where `host_id ∈ org hosts AND status='pending_review'` with the host name + venue + date + price + session. (Create that GET route in the same task, mirroring `/api/hosts` org resolution.) On success, refresh the list.

Structure (mirror the light-theme `un1t-*` chips + `@/components/ui` primitives used elsewhere in settings):
- Section header "Pending review" with a count.
- Empty state "No events awaiting review."
- Each item: name, host, `venue_name`, date, price, session time/capacity, description preview; buttons **Approve & publish** / **Reject** (opens a reason input).

- [ ] **Step 2: Create `GET /api/hosts/pending-events`**

```js
// GET /api/hosts/pending-events — org's host events awaiting review. ADMIN_ROLES.
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { ADMIN_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.includes(user.role)) return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return NextResponse.json({ success: false, error: 'no_active_organization' }, { status: 400 })

  const db = createServerClient()
  const { data: hosts } = await db.from('event_hosts').select('id, name').eq('organization_id', orgId)
  const hostIds = (hosts || []).map((h) => h.id)
  const nameById = new Map((hosts || []).map((h) => [h.id, h.name]))
  if (hostIds.length === 0) return NextResponse.json({ success: true, data: [] })

  const { data: events } = await db
    .from('race_events')
    .select('id, host_id, name, venue_name, venue_address, race_date, non_member_fee_cents, description, submitted_at, race_waves ( start_time, capacity )')
    .in('host_id', hostIds)
    .eq('status', 'pending_review')
    .order('submitted_at', { ascending: true })
    .limit(200)
  const rows = (events || []).map((e) => ({ ...e, host_name: nameById.get(e.host_id) || '—' }))
  return NextResponse.json({ success: true, data: rows })
}
```

- [ ] **Step 3: Mount in `src/app/settings/hosts/page.jsx`**

Add `<HostEventReviewQueue />` above (or as a tab beside) the hosts list. It self-fetches; the count in its header is the "badge".

- [ ] **Step 4: Guard + build + commit**

Run: `npm run check:route-guards` (PASS), `npm run lint`, `npm run build`.
```bash
git add src/components/settings/HostEventReviewQueue.jsx "src/app/api/hosts/pending-events/route.js" src/app/settings/hosts/page.jsx
git commit -m "HOST-PORTAL.3 — staff review queue on Settings > Hosts"
```

---

## Task 10: Host portal UI (form + pages + dashboard)

**Files:**
- Create: `src/components/host/HostEventForm.jsx`
- Create: `src/app/host/(portal)/events/new/page.js`
- Create: `src/app/host/(portal)/events/[id]/edit/page.js`
- Modify: `src/app/host/(portal)/page.js`

- [ ] **Step 1: `HostEventForm.jsx`** (client)

A dark-styled form (mirror the host portal's existing dark classes: `bg-white/[0.04]`, `border-white/12`, white text). Fields = the `HostEventSchema` set: kind `<select>` (HOST_EVENT_KINDS), name, description, race_date, session (start_time + capacity + optional label), allowed_team_sizes (checkbox group 1–8), a single **ticket price** in € (converted to cents `ticket_price_cents`), hero image URL + accent hex, venue_name + venue_address, and the four email copy fields (optional, collapsed). Props: `mode: 'create'|'edit'`, `initial` (for edit), `eventId`.
- Submit: `POST /api/host/events` (create) or `PUT /api/host/events/[id]` (edit); on success route to `/host/events/[id]` (roster) or `/host`.
- Do NOT render any UN1T-only field (location, host, staff_required, member pricing, shared, glofox).
- Convert euros→cents on submit; cents→euros when hydrating `initial`.

- [ ] **Step 2: `events/new/page.js`** (server) — gate `getCurrentHost()` → redirect; render `<HostEventForm mode="create" />` with a heading. `export const dynamic = 'force-dynamic'`.

- [ ] **Step 3: `events/[id]/edit/page.js`** (server) — gate; load the event via `GET /api/host/events/[id]` shape (or fetch inline with the same `host_id === session.host.id` check → `notFound()`); map row → `initial` (cents→euros, first wave → session); render `<HostEventForm mode="edit" eventId={id} initial={...} />`. Show the `rejected_reason` banner if `status==='rejected'`.

- [ ] **Step 4: Dashboard `page.js`** — add a "Create event" link (to `/host/events/new`); on each event row show a status chip (`HOST_EVENT_STATUS_LABEL[e.status]`) and, when `status !== 'published'`, an "Edit" link to `/host/events/[id]/edit` and (for draft/rejected) a "Submit for review" affordance (POST submit). Add `status` to the dashboard's event select.

- [ ] **Step 5: Lint + build + commit**

Run: `npm run lint`, `npm run build` (all host pages compile; verify `/host/events/new` and `/host/events/[id]/edit` appear in the route list and don't collide with `/host/events/[id]`).
```bash
git add src/components/host/HostEventForm.jsx "src/app/host/(portal)/events" "src/app/host/(portal)/page.js"
git commit -m "HOST-PORTAL.3 — host portal: create/edit event form + pages + dashboard status"
```

---

## Task 11: Exclude anchor locations + final wiring

**Files:**
- Audit + Modify: any staff/public/report surface that enumerates `locations` without a host-anchor filter.

- [ ] **Step 1: Find location enumerations**

Run: `grep -rn "from('locations')" src/ | grep -v is_host_anchor`
For each that populates a **staff location picker, a public listing, or an org rollup**, add `.eq('is_host_anchor', false)` (or `.or('is_host_anchor.is.null,is_host_anchor.eq.false')`). Do NOT touch service-role reads that fetch a location by explicit id (those are fine). Prioritise: the sidebar/location switcher source, `assertLocationAccess` data (host anchors have no `profile_locations` so already excluded — verify), and any dashboard that lists locations for the org.

- [ ] **Step 2: Register new routes in openapi (if that file lists them)**

Check `src/lib/openapi.js` — the existing host routes may already be omitted (host surface). Match the existing convention; if host routes are omitted there, leave the new ones out too.

- [ ] **Step 3: Full CI mirror + build**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
npm run build
```
Expected: all green; build lists `/host/events/new`, `/host/events/[id]/edit`, `/api/host/events` (POST), `/api/host/events/[id]`, `/api/host/events/[id]/submit`, `/api/events/[id]/review`, `/api/hosts/pending-events`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "HOST-PORTAL.3 — exclude host-anchor locations from pickers/rollups; final wiring"
```

---

## Task 12: Adversarial review + PR

- [ ] **Step 1: Adversarial review** (Workflow, 3 lenses + verify) on:
  1. **Public gate** — prove no `draft`/`pending_review`/`rejected` event is viewable (data route, metadata) or bookable (register) or listed on any path; confirm the `eventIsPublic` assertion + `.eq('status','published')` both hold and existing events (default published) are unaffected.
  2. **Host scoping** — a host cannot create/edit/submit for another `host_id`; `HostEventSchema.strict()` rejects UN1T-only fields (location_id/host_id/shared/staff_required/member pricing/glofox); the anchor is always the caller's host's.
  3. **Review route** — ADMIN_ROLES + org IDOR (`loadHostForOrg`) unbypassable; a manager in org A cannot approve org B's host event; only `pending_review` → published/rejected.
- [ ] **Step 2: Fix any confirmed findings**, re-run CI mirror + build.
- [ ] **Step 3: Push + PR**

```bash
git push -u origin host-selfserve-events
gh pr create --base main --title "HOST-PORTAL.3 — host self-serve event creation" --fill
```

---

## Self-Review (completed at write time)

- **Spec coverage:** lifecycle (Task 1,2), venue + anchor (Task 1,3,5), public gating (Task 4), host create/edit/submit (Tasks 5–7), review queue (Tasks 8–9), edit-after-publish rule (Task 2 `computeEditTransition` + Task 6), out-of-scope respected (no promo/approvals-provider/multi-wave). ✓
- **Placeholder scan:** the two `TODO-in-impl`/note lines (host-notify email, `locations` NOT NULL audit, `race_waves` column confirm, openapi) are explicit "verify against live schema during impl" instructions, not deferred logic — acceptable and bounded. ✓
- **Type consistency:** `ticket_price_cents` (input) → `non_member_fee_cents` (column) mapping is consistent across Tasks 5/6; `computeEditTransition` waves shape `{id,start_time}` consistent between test (Task 2) and caller (Task 6); `eventIsPublic` signature consistent (Tasks 2,4). ✓
