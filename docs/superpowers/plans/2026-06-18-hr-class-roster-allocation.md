# HR Class Roster + Anonymous Sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tag each HR session `booked` vs `presence` from a real Glofox booking roster, show unregistered walk-in straps on the board by device id, and surface the full live-class roster on the coach view.

**Architecture:** A new `class_bookings` roster table is populated for free off the existing per-member `fetchUserBookings` path (every `BOOKING_*` webhook + daily sync). It drives both the booked tag (direct event+member lookup at session-stamp time) and a coach-view roster panel. `heart_rate_sessions.contact_id` becomes nullable so the bridge can create anonymous sessions for unmatched straps while a class is live; boards fall back to the device id for the label.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + RLS), Vitest. New lib `src/lib/class-bookings.js` mirrors the existing `src/lib/class-occurrences.js` shape (pure mappers exported + unit-tested; IO does fetch/upsert).

**Design spec:** `docs/superpowers/specs/2026-06-18-hr-class-roster-allocation-design.md`

**Ships as 3 PRs** (each: full CI mirror + real `next build` + apply migration + `get_advisors` + branch/PR):
- **PR1** — roster data layer (`class_bookings` + population). Invisible; verify rows populate.
- **PR2** — booked tag + anonymous sessions.
- **PR3** — coach roster panel UI.

> **Migration numbers:** plan assumes 288 (PR1) and 289 (PR2). Confirm at execution with `ls supabase/migrations | sort | tail -3` and bump if taken.

---

## File structure

| File | Responsibility | PR |
|---|---|---|
| `supabase/migrations/288_class_bookings.sql` | roster table + RLS + indexes | 1 |
| `src/lib/class-bookings.js` | `mapBookingToRosterRow` (pure), `upsertClassBookings` (IO), `lookupBookedMember` (IO), `mergeRosterWithSessions` (pure), `getClassRoster` (IO) | 1,2,3 |
| `src/lib/class-bookings.test.js` | unit tests for the pure helpers + DB-mocked IO | 1,2,3 |
| `src/lib/glofox-sync.js` | hook `upsertClassBookings` into the booking-fetch path | 1 |
| `src/app/api/admin/backfill-class-bookings/route.js` | one-shot roster backfill | 1 |
| `supabase/migrations/289_hr_session_contact_nullable.sql` | `heart_rate_sessions.contact_id` → nullable | 2 |
| `src/lib/bridge-samples.js` | booked-tag lookup in `findOrCreateAutoSession`; anon session in `resolveStrapsForBatch` | 2 |
| `src/lib/live-class.js` | booked-tag lookup in `pairOverride`; guard side-effects on null contact; device-id label in `getLiveSessions` | 2,3 |
| `src/app/api/public/live/[locationId]/route.js` | left-join contacts, device-id fallback label | 2 |
| `src/app/api/live/[locationId]/route.js` | return roster alongside sessions | 3 |
| `src/app/live/[locationId]/LiveClassClient.jsx` | roster panel | 3 |

---

# PR1 — Roster data layer

### Task 1.1: `class_bookings` migration

**Files:**
- Create: `supabase/migrations/288_class_bookings.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 288: HR-CLASS-ALLOC.2 — the per-event class booking roster. Glofox exposes
-- no per-event attendee endpoint, so we assemble the roster from the per-member
-- /2.0/bookings fetches we already do (daily glofox-sync + every BOOKING_*
-- webhook via applyMemberSync). Drives (a) the booked-vs-presence tag on
-- heart_rate_sessions and (b) the coach-view live-class roster panel.
CREATE TABLE IF NOT EXISTS public.class_bookings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id       uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  glofox_event_id   text NOT NULL,
  glofox_booking_id text NOT NULL,
  glofox_member_id  text,
  contact_id        uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  member_name       text,
  class_name        text,
  starts_at         timestamptz,
  status            text,
  attended          boolean NOT NULL DEFAULT false,
  raw               jsonb,
  synced_at         timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, glofox_booking_id)
);

CREATE INDEX IF NOT EXISTS idx_class_bookings_event
  ON public.class_bookings (location_id, glofox_event_id);
CREATE INDEX IF NOT EXISTS idx_class_bookings_member_event
  ON public.class_bookings (location_id, glofox_member_id, glofox_event_id);
CREATE INDEX IF NOT EXISTS idx_class_bookings_contact
  ON public.class_bookings (contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE public.class_bookings ENABLE ROW LEVEL SECURITY;

-- Staff at the location can read; writes are service-role only (sync workers).
CREATE POLICY "class_bookings_location_read" ON public.class_bookings
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

COMMENT ON TABLE public.class_bookings IS
  'HR-CLASS-ALLOC.2 (mig 288): per-event Glofox booking roster, assembled from per-member /2.0/bookings fetches. Drives the booked tag + coach roster panel.';
```

- [ ] **Step 2: Apply via Supabase MCP** (`apply_migration`, project `iyvtbjjxdggiadzwwvdj`, name `class_bookings`). Then `get_advisors type=security` — expect no NEW issues (the table has an RLS read policy; service-role writes need no policy).

- [ ] **Step 3: Verify** with `execute_sql`: `select count(*) from public.class_bookings;` → `0`. Confirm the table + 3 indexes exist.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/288_class_bookings.sql
git commit -m "HR-CLASS-ALLOC.2 PR1 — class_bookings roster table (mig 288)"
```

---

### Task 1.2: `mapBookingToRosterRow` pure mapper

**Files:**
- Create: `src/lib/class-bookings.js`
- Test: `src/lib/class-bookings.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { mapBookingToRosterRow } from './class-bookings'

describe('class-bookings: mapBookingToRosterRow', () => {
  const base = {
    _id: 'bk1', event_id: 'ev1', event_name: 'DR1VE',
    time_start: 1_750_000_000, status: 'booked', attended: false,
  }
  it('shapes a Glofox booking into a roster row', () => {
    const row = mapBookingToRosterRow(base, { locationId: 'loc1', contactId: 'c1', glofoxMemberId: 'm1', memberName: 'Jo B' })
    expect(row).toMatchObject({
      location_id: 'loc1', glofox_event_id: 'ev1', glofox_booking_id: 'bk1',
      glofox_member_id: 'm1', contact_id: 'c1', member_name: 'Jo B',
      class_name: 'DR1VE', status: 'BOOKED', attended: false,
    })
    expect(row.starts_at).toBe(new Date(1_750_000_000 * 1000).toISOString())
  })
  it('uppercases status and coerces attended', () => {
    const row = mapBookingToRosterRow({ ...base, status: 'attended', attended: true }, { locationId: 'loc1' })
    expect(row.status).toBe('ATTENDED')
    expect(row.attended).toBe(true)
  })
  it('returns null without a booking id or event id', () => {
    expect(mapBookingToRosterRow({ event_id: 'ev1' }, { locationId: 'loc1' })).toBeNull()
    expect(mapBookingToRosterRow({ _id: 'bk1' }, { locationId: 'loc1' })).toBeNull()
    expect(mapBookingToRosterRow({ _id: 'bk1', event_id: 'ev1' }, {})).toBeNull()
  })
})
```

- [ ] **Step 2: Run it, verify fail** — `npx vitest run src/lib/class-bookings.test.js` → FAIL ("mapBookingToRosterRow is not a function").

- [ ] **Step 3: Write the implementation**

```js
// HR-CLASS-ALLOC.2 — the Glofox class booking roster. Pure mappers are
// exported + unit-tested; the IO (upsert / lookup / roster read) does the DB
// work. Mirrors the shape of class-occurrences.js.
//
// Glofox has no per-event attendee endpoint, so the roster is assembled from
// the per-member /2.0/bookings fetches applyMemberSync already does.

import { toMillis } from '@/lib/class-occurrences'

/**
 * Pure: shape one Glofox Booking (per /2.0/bookings) into a class_bookings
 * upsert row. Returns null when it lacks the bits we need (booking id, event
 * id, or location). `ctx` carries the resolved contact linkage.
 *
 * @param {object} booking  a /2.0/bookings item ({ _id, event_id, event_name, time_start, status, attended })
 * @param {{ locationId: string, contactId?: string|null, glofoxMemberId?: string|null, memberName?: string|null }} ctx
 */
export function mapBookingToRosterRow(booking, ctx = {}) {
  if (!booking || !booking._id || !booking.event_id || !ctx.locationId) return null
  const startMs = toMillis(booking.time_start)
  return {
    location_id: ctx.locationId,
    glofox_event_id: String(booking.event_id),
    glofox_booking_id: String(booking._id),
    glofox_member_id: ctx.glofoxMemberId ?? null,
    contact_id: ctx.contactId ?? null,
    member_name: ctx.memberName ? String(ctx.memberName).slice(0, 200) : null,
    class_name: booking.event_name ? String(booking.event_name).slice(0, 200) : null,
    starts_at: startMs == null ? null : new Date(startMs).toISOString(),
    status: typeof booking.status === 'string' ? booking.status.toUpperCase() : null,
    attended: booking.attended === true,
    raw: booking,
    synced_at: new Date().toISOString(),
  }
}
```

- [ ] **Step 4: Run it, verify pass** — `npx vitest run src/lib/class-bookings.test.js` → PASS (3).

- [ ] **Step 5: Commit**

```bash
git add src/lib/class-bookings.js src/lib/class-bookings.test.js
git commit -m "HR-CLASS-ALLOC.2 PR1 — mapBookingToRosterRow pure mapper"
```

---

### Task 1.3: `upsertClassBookings` IO helper

**Files:**
- Modify: `src/lib/class-bookings.js`
- Test: `src/lib/class-bookings.test.js`

- [ ] **Step 1: Write the failing test** (append)

```js
import { vi } from 'vitest'
import { upsertClassBookings } from './class-bookings'

describe('class-bookings: upsertClassBookings', () => {
  it('upserts shaped rows on the booking-id conflict key', async () => {
    let captured = null
    const db = { from: vi.fn(() => ({ upsert: vi.fn((rows, opts) => { captured = { rows, opts }; return Promise.resolve({ error: null }) }) })) }
    const bookings = [
      { _id: 'bk1', event_id: 'ev1', event_name: 'DR1VE', time_start: 1_750_000_000, status: 'booked' },
      { _id: 'bk2', event_id: 'ev2', event_name: 'TEMPO', time_start: 1_750_003_600, status: 'booked' },
    ]
    const out = await upsertClassBookings(db, { locationId: 'loc1', contactId: 'c1', glofoxMemberId: 'm1', memberName: 'Jo B', bookings })
    expect(out.upserted).toBe(2)
    expect(captured.opts).toEqual({ onConflict: 'location_id,glofox_booking_id' })
    expect(captured.rows[0]).toMatchObject({ glofox_booking_id: 'bk1', contact_id: 'c1' })
  })
  it('no-ops on an empty / non-array list', async () => {
    const db = { from: vi.fn() }
    expect((await upsertClassBookings(db, { locationId: 'loc1', bookings: [] })).upserted).toBe(0)
    expect(db.from).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run it, verify fail** — FAIL ("upsertClassBookings is not a function").

- [ ] **Step 3: Implement** (append to `class-bookings.js`)

```js
import { logWarn } from '@/lib/log'

/**
 * IO: upsert a member's bookings into the roster. Best-effort — never throws
 * (callers fire it as a side-effect of member sync). Returns { upserted }.
 *
 * @param {object} db  service-role client
 * @param {{ locationId, contactId?, glofoxMemberId?, memberName?, bookings: object[] }} opts
 */
export async function upsertClassBookings(db, { locationId, contactId = null, glofoxMemberId = null, memberName = null, bookings } = {}) {
  if (!db || !locationId || !Array.isArray(bookings) || bookings.length === 0) return { upserted: 0 }
  const rows = []
  for (const b of bookings) {
    const row = mapBookingToRosterRow(b, { locationId, contactId, glofoxMemberId, memberName })
    if (row) rows.push(row)
  }
  if (rows.length === 0) return { upserted: 0 }
  const { error } = await db.from('class_bookings').upsert(rows, { onConflict: 'location_id,glofox_booking_id' })
  if (error) {
    logWarn('class-bookings', 'upsert failed', { locationId, error: error.message })
    return { upserted: 0, error: error.message }
  }
  return { upserted: rows.length }
}
```

- [ ] **Step 4: Run it, verify pass** — PASS (5 total).

- [ ] **Step 5: Commit** — `git commit -am "HR-CLASS-ALLOC.2 PR1 — upsertClassBookings IO helper"`

---

### Task 1.4: Hook into `applyMemberSync`'s booking path

**Files:**
- Modify: `src/lib/glofox-sync.js` (around the `mapped.recent_bookings = trimRecentBookings(...)` write at ~line 1457, inside the `opts.creds && !opts.skipBookings` branch)

The booking fetch already happens here; we attach a best-effort roster upsert using the **same** `bookingsList`. `applyMemberSync` runs later and has the resolved `contact_id` — but the simplest correct hook is at the upsert point where we have `bookingsList`, `memberId`, and the mapped name. The roster `contact_id` is resolved on the next read if null; to set it now, do the upsert inside `applyMemberSync` after the contact row is resolved (it has `existing.id`). **Decision: upsert in `applyMemberSync`** so `contact_id` is populated.

- [ ] **Step 1: Read** the `applyMemberSync` body (`src/lib/glofox-sync.js:1702`+) to find where `m` (the mapped member, carrying `m.recent_bookings`) and the resolved contact id are both in scope, and where `opts.creds`/the raw bookings list are available. The mapped member is built by the function that fetched bookings (the `mapMember`-style builder around 1434-1457). Thread the raw `bookingsList` onto the mapped object as a non-persisted field `m.__bookings_list` (or pass via opts) so `applyMemberSync` can upsert it.

- [ ] **Step 2: In the builder** (the `opts.creds && !opts.skipBookings` branch, right after `mapped.recent_bookings = trimRecentBookings(bookingsList, 10)`), stash the raw list:

```js
    mapped.recent_bookings = trimRecentBookings(bookingsList, 10)
    // HR-CLASS-ALLOC.2 — carry the raw bookings so applyMemberSync can upsert
    // the per-event roster (class_bookings). Non-persisted (stripped before write).
    mapped.__bookings_list = bookingsList
```

- [ ] **Step 3: In `applyMemberSync`**, after the contact row is resolved/updated (where `contact_id` + `glofox_member_id` + a display name are known), fire the best-effort upsert. Import at top of file:

```js
import { upsertClassBookings } from '@/lib/class-bookings.js'
```

and after the member write succeeds:

```js
  // HR-CLASS-ALLOC.2 — refresh this member's slice of the class_bookings roster
  // from the same bookings list we just fetched. Best-effort.
  if (Array.isArray(member?.__bookings_list) && member.__bookings_list.length) {
    try {
      await upsertClassBookings(db, {
        locationId,
        contactId: contactId,                 // the resolved contacts.id in this scope
        glofoxMemberId: m.glofox_member_id,
        memberName: [m.first_name, m.last_name].filter(Boolean).join(' ') || null,
        bookings: member.__bookings_list,
      })
    } catch (e) {
      logWarn('glofox-sync', 'class_bookings upsert threw', { err: e?.message })
    }
  }
```

> At execution: confirm the exact in-scope variable names for the resolved contact id + mapped member (`contactId` / `m` / `mapped`) by reading the function; adjust the references. `member` here is the param passed to `applyMemberSync` (the full Glofox member). If `__bookings_list` is only on the builder's `mapped` (not the `member` param), thread it through `opts.bookings` instead — `applyMemberSync` already accepts `opts.bookings`.

- [ ] **Step 4: Strip the non-persisted field** before any DB write of the member (so `__bookings_list` never hits `contacts`). Verify the update payload is built from an explicit column allowlist (it is — `updates.recent_bookings = ...` style at ~1783), so `__bookings_list` is naturally excluded. Add a test assertion if a full-object write exists anywhere.

- [ ] **Step 5: Run the glofox-sync test suite** — `npx vitest run src/lib/glofox-sync.test.js` → PASS (existing tests unaffected; the upsert is best-effort and mocked-DB tolerant). If a test stubs `db.from` without a `class_bookings` branch, add one returning `{ upsert: () => Promise.resolve({ error: null }) }`.

- [ ] **Step 6: Commit** — `git commit -am "HR-CLASS-ALLOC.2 PR1 — populate class_bookings from applyMemberSync booking fetch"`

---

### Task 1.5: Backfill route

**Files:**
- Create: `src/app/api/admin/backfill-class-bookings/route.js`

- [ ] **Step 1: Write the route** (master-gated; pages active members, fetches each one's bookings, upserts). Follow the existing `glofox` admin-route + pagination conventions (`src/app/api/glofox/list-members/route.js` for the creds + member-iteration shape; the `.range()` pagination pattern from CLAUDE.md).

```js
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { uuidLike } from '@/lib/schemas'
import { getGlofoxCredsForLocation } from '@/lib/glofox'   // confirm exact export name at execution
import { fetchUserBookings } from '@/lib/glofox'
import { upsertClassBookings } from '@/lib/class-bookings'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user || user.role !== 'master') {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  if (!locationId || !uuidLike.safeParse(locationId).success) {
    return NextResponse.json({ success: false, error: 'Provide ?location_id=<uuid>' }, { status: 400 })
  }
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const creds = await getGlofoxCredsForLocation(db, locationId)  // confirm helper
  if (!creds) return NextResponse.json({ success: false, error: 'Location not connected to Glofox' }, { status: 400 })

  // Page active members with a glofox_member_id; upsert each one's bookings.
  const PAGE = 1000
  let from = 0, members = 0, upserted = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data: page, error } = await db
      .from('contacts')
      .select('id, glofox_member_id, first_name, last_name')
      .eq('location_id', locationId)
      .not('glofox_member_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error || !page?.length) break
    for (const c of page) {
      const bookings = await fetchUserBookings(creds, c.glofox_member_id)
      const out = await upsertClassBookings(db, {
        locationId, contactId: c.id, glofoxMemberId: c.glofox_member_id,
        memberName: [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
        bookings,
      })
      members++; upserted += out.upserted || 0
    }
    if (page.length < PAGE) break
    from += PAGE
  }
  return NextResponse.json({ success: true, members, upserted })
}
```

- [ ] **Step 2: Verify** `getGlofoxCredsForLocation` + `fetchUserBookings` export names at execution (`grep -n "export.*getGlofox\|export async function fetchUserBookings" src/lib/glofox.js`); fix imports.

- [ ] **Step 3: Route-guard check** — `npm run check:route-guards` → the route has `getCurrentUser` + `assertLocationAccess`, passes.

- [ ] **Step 4: Commit** — `git commit -am "HR-CLASS-ALLOC.2 PR1 — class_bookings backfill route"`

---

### Task 1.6: Ship PR1

- [ ] **Step 1:** `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards`
- [ ] **Step 2:** `npm run build` (mig 288 already applied; no new imports beyond lib — still build).
- [ ] **Step 3:** Push branch `feat-hr-class-roster`, open PR `base=main`, merge `--squash --admin --delete-branch`.
- [ ] **Step 4:** Verify on prod: trigger the backfill (`POST /api/admin/backfill-class-bookings?location_id=<stillorgan>`), then `select count(*), count(distinct glofox_event_id) from class_bookings;` → non-zero. Sanity-check a few rows against the Glofox timetable.

---

# PR2 — Booked tag + anonymous sessions

### Task 2.1: `contact_id` nullable migration

**Files:**
- Create: `supabase/migrations/289_hr_session_contact_nullable.sql`

- [ ] **Step 1: Write**

```sql
-- 289: HR-CLASS-ALLOC.2 — anonymous (walk-in) HR sessions. An unregistered
-- strap broadcasting during a live class now creates a session with no
-- contact, labelled by its device id on the board. contact_id goes nullable;
-- the customer-self RLS policy keys on contact_id = auth_contact_id() so a
-- null-contact row never matches a customer — anon sessions stay staff-only.
ALTER TABLE public.heart_rate_sessions ALTER COLUMN contact_id DROP NOT NULL;

COMMENT ON COLUMN public.heart_rate_sessions.contact_id IS
  'Nullable since HR-CLASS-ALLOC.2 (mig 289): NULL = anonymous walk-in session (unregistered strap during a live class); labelled by device_identifier.';
```

- [ ] **Step 2: Apply** via MCP; `get_advisors type=security` → no new issues.
- [ ] **Step 3: Commit** — `git commit -m "HR-CLASS-ALLOC.2 PR2 — heart_rate_sessions.contact_id nullable (mig 289)"`

---

### Task 2.2: `resolveClassLinkSource` + `lookupBookedMember`

**Files:**
- Modify: `src/lib/class-bookings.js`
- Test: `src/lib/class-bookings.test.js`

- [ ] **Step 1: Write the failing test** (append)

```js
import { resolveClassLinkSource, lookupBookedMember } from './class-bookings'

describe('class-bookings: resolveClassLinkSource', () => {
  it('null when no live class', () => {
    expect(resolveClassLinkSource({ liveClass: null, booked: false })).toBeNull()
    expect(resolveClassLinkSource({ liveClass: null, booked: true })).toBeNull()
  })
  it('booked vs presence under a live class', () => {
    expect(resolveClassLinkSource({ liveClass: { glofox_event_id: 'e' }, booked: true })).toBe('booked')
    expect(resolveClassLinkSource({ liveClass: { glofox_event_id: 'e' }, booked: false })).toBe('presence')
  })
})

describe('class-bookings: lookupBookedMember', () => {
  const okDb = (rows) => ({ from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ eq: vi.fn(() => ({ not: vi.fn(() => ({ limit: vi.fn(() => Promise.resolve({ data: rows })) })) })) })) })) })) })) }) })
  it('true when a non-cancelled booking row exists', async () => {
    expect(await lookupBookedMember(okDb([{ id: 'x' }]), { locationId: 'l', glofoxEventId: 'e', glofoxMemberId: 'm' })).toBe(true)
  })
  it('false when none / missing member id', async () => {
    expect(await lookupBookedMember(okDb([]), { locationId: 'l', glofoxEventId: 'e', glofoxMemberId: 'm' })).toBe(false)
    expect(await lookupBookedMember(okDb([{ id: 'x' }]), { locationId: 'l', glofoxEventId: 'e', glofoxMemberId: null })).toBe(false)
  })
})
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** (append)

```js
/**
 * Pure: the class_link_source stamp. No live class → null (session not tied to
 * a class). Live class → 'booked' if the member had a booking, else 'presence'.
 */
export function resolveClassLinkSource({ liveClass, booked }) {
  if (!liveClass) return null
  return booked ? 'booked' : 'presence'
}

/**
 * IO: did this Glofox member have a non-cancelled booking for this event?
 * Returns false fast when there's no member id (anon / CRM-only contact).
 */
export async function lookupBookedMember(db, { locationId, glofoxEventId, glofoxMemberId } = {}) {
  if (!db || !locationId || !glofoxEventId || !glofoxMemberId) return false
  const { data } = await db
    .from('class_bookings')
    .select('id')
    .eq('location_id', locationId)
    .eq('glofox_event_id', glofoxEventId)
    .eq('glofox_member_id', glofoxMemberId)
    .not('status', 'eq', 'CANCELLED')
    .limit(1)
  return Array.isArray(data) && data.length > 0
}
```

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -am "HR-CLASS-ALLOC.2 PR2 — resolveClassLinkSource + lookupBookedMember"`

---

### Task 2.3: Wire the booked tag into both session-create paths

**Files:**
- Modify: `src/lib/bridge-samples.js` (`findOrCreateAutoSession`, ~line 276 — the class-create branch from HR-CLASS-ALLOC.1)
- Modify: `src/lib/live-class.js` (`pairOverride`, ~line 156)

Both already resolve `liveClass = resolveCurrentOccurrence(...)` and stamp `class_link_source: 'presence'`. Replace the literal with the booked lookup.

- [ ] **Step 1 (bridge-samples.js):** the contact fetch in `findOrCreateAutoSession` selects `max_hr_override, dob` — add `glofox_member_id`. Then before the class-create insert:

```js
import { lookupBookedMember, resolveClassLinkSource } from '@/lib/class-bookings'
// ...
// occ is the resolved live occurrence; contact carries glofox_member_id
const booked = await lookupBookedMember(db, {
  locationId, glofoxEventId: occ.glofox_event_id, glofoxMemberId: contact?.glofox_member_id,
})
const linkSource = resolveClassLinkSource({ liveClass: occ, booked }) // 'booked' | 'presence'
```

and use `class_link_source: linkSource` in the insert (replacing the literal `'presence'`).

- [ ] **Step 2 (live-class.js `pairOverride`):** the contact select is `id, max_hr_override, dob` — add `glofox_member_id`. Replace the `class_link_source: liveClass ? 'presence' : null` logic with:

```js
const booked = liveClass ? await lookupBookedMember(db, {
  locationId, glofoxEventId: liveClass.glofox_event_id, glofoxMemberId: contact?.glofox_member_id,
}) : false
const linkSource = resolveClassLinkSource({ liveClass, booked })
// use linkSource for both the insert and the existing-session backfill branch
```

- [ ] **Step 3: Update the existing tests** — `bridge-samples.test.js` + `live-class.test.js` already mock `class_occurrences`; add a `class_bookings` branch to the `db.from` mocks returning the `lookupBookedMember` chain (default empty → presence). Add one case each asserting `booked` when the mock returns a row.

- [ ] **Step 4: Run** — `npx vitest run src/lib/bridge-samples.test.js src/lib/live-class.test.js` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "HR-CLASS-ALLOC.2 PR2 — stamp booked vs presence from class_bookings"`

---

### Task 2.4: Anonymous sessions in `resolveStrapsForBatch`

**Files:**
- Modify: `src/lib/bridge-samples.js` (`resolveStrapsForBatch`, ~line 230-264 — after the auto path, before `return map`)
- Test: `src/lib/bridge-samples.test.js`

- [ ] **Step 1: Write the failing test** — an unmatched device, a live class present, asserts a session is created and added to the map with `via: 'anon'`. DB-mock: `strap_assignments` empty, `contact_devices` empty for the key, `class_occurrences` returns a live occurrence, `heart_rate_sessions` insert returns `{ id: 'anon-sess' }`.

```js
it('creates an anonymous session for an unmatched strap during a live class', async () => {
  // ... build db mock: empty override + empty contact_devices for 'ant:999',
  //     class_occurrences → one live occ, heart_rate_sessions.insert → { id:'anon-sess' }
  const map = await resolveStrapsForBatch(db, { bridgeId:'b', locationId:'loc1', deviceKeys:['ant:999'], nowMs: NOW })
  expect(map.get('ant:999')).toMatchObject({ sessionId: 'anon-sess', contactId: null, via: 'anon' })
})
it('drops an unmatched strap when no class is live', async () => {
  // class_occurrences → [] ; expect map.has('ant:999') === false
})
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — add an anonymous helper + call it for still-unmatched keys. After the auto-path loop, before `return map`:

```js
  // (3) Anonymous path: any still-unmatched strap, but ONLY while a class is
  // live — create a contact-less session labelled by its device id so walk-ins
  // appear on the board. No class running → leave it unmatched (dropped).
  const stillUnmatched = uniqueKeys.filter((k) => !map.has(k))
  if (stillUnmatched.length > 0) {
    const occ = await resolveCurrentOccurrence(db, { locationId, nowMs })
    if (occ) {
      for (const key of stillUnmatched) {
        const sessionId = await createAnonymousSession(db, { locationId, deviceKey: key, occ, nowMs })
        if (sessionId) map.set(key, { sessionId, contactId: null, via: 'anon' })
      }
    }
  }
```

and the helper (near `findOrCreateAutoSession`):

```js
async function createAnonymousSession(db, { locationId, deviceKey, occ, nowMs }) {
  const { data: created, error } = await db
    .from('heart_rate_sessions')
    .insert({
      contact_id: null,
      location_id: locationId,
      booking_id: null,
      source: 'ble_bridge',
      device_identifier: deviceKey,
      started_at: new Date(nowMs).toISOString(),
      max_hr_used: 190,                       // default fallback; no contact to resolve from
      glofox_event_id: occ.glofox_event_id,
      class_name: occ.class_name,
      class_link_source: 'presence',
    })
    .select('id')
    .single()
  if (error) { logWarn('bridge-samples', 'anon session create failed', { err: error, deviceKey }); return null }
  return created?.id || null
}
```

> Idempotency: a second batch for the same anon strap must not create a *second* session. The `(1) override` + `(2) auto` paths return the existing open session for matched contacts; for anon there's no contact to key on. Before creating, look up an existing **open anon session** for `(location_id, device_identifier=deviceKey, contact_id IS NULL, ended_at IS NULL)` and reuse it. Add that lookup at the top of `createAnonymousSession` and a test for "second batch reuses the anon session."

- [ ] **Step 4: Run, verify pass** (incl. the reuse test).
- [ ] **Step 5: Commit** — `git commit -am "HR-CLASS-ALLOC.2 PR2 — anonymous sessions for unmatched straps during a live class"`

---

### Task 2.5: Guard side-effects on null contact

**Files:**
- Modify: `src/lib/live-class.js` (`endSession`, ~line 246 — the post-class email / achievements / exports block)

- [ ] **Step 1:** Read `endSession`'s fire-and-forget block. Each of `sendPostClassEmail` / `runDetectionForSession` / `enqueueExportsForSession` assumes a contact. Wrap them so they only run when the session has a `contact_id`:

```js
  // HR-CLASS-ALLOC.2 — anonymous (null-contact) sessions still get zones/points
  // from summariseSession, but skip the contact-bound side-effects.
  if (session.contact_id) {
    // existing post-class email + achievements + exports block, unchanged
  }
```

(Confirm `session` carries `contact_id` in the select; add it if not.)

- [ ] **Step 2: Test** — extend `live-class.test.js` `endSession` happy-path with a null-contact variant asserting summary is written but the email/achievement/export imports are NOT invoked. (The block is already dynamic-imported / mockable.)
- [ ] **Step 3: Run, verify pass.**
- [ ] **Step 4: Commit** — `git commit -am "HR-CLASS-ALLOC.2 PR2 — skip contact-bound side-effects on anonymous sessions"`

---

### Task 2.6: Board label fallback (device id)

**Files:**
- Modify: `src/lib/live-class.js` (`getLiveSessions`, ~line 44 — the contacts embed + `contactName`/`contactFirstName`/`displayName` derivation)
- Modify: `src/app/api/public/live/[locationId]/route.js` (the `contacts!inner` embed → left join + `displayName` fallback)

- [ ] **Step 1 (public TV route):** change `contacts!inner(id, name, location_id)` to `contacts!contact_id(id, name, location_id)` (left join, disambiguated per the two-FK rule). For each session, `displayName = contact ? firstNameLastInitial(contact.name) : session.device_identifier`. Anon rows now render as `ant:45075`.

- [ ] **Step 2 (coach `getLiveSessions`):** same — left-join contacts; when no contact, set `contactName = device_identifier`, `contactFirstName = device_identifier`, `contactId = null`. Keep the existing shape so the client needs no change.

- [ ] **Step 3: Test** — `live-class.test.js` `getLiveSessions`: add a null-contact session row asserting `contactName === device_identifier`. Public-route: if a route test exists, add an anon case; else verify via the build + a manual prod check post-merge.

- [ ] **Step 4: Run** vitest + `npm run build` (route change).
- [ ] **Step 5: Commit** — `git commit -am "HR-CLASS-ALLOC.2 PR2 — label anonymous sessions by device id on the boards"`

---

### Task 2.7: Ship PR2

- [ ] Full CI mirror + `npm run build`. Branch `feat-hr-class-roster-pr2` off main, PR `base=main`, squash-merge. Apply mig 289 (done in 2.1). Advisor clean.
- [ ] Prod sanity: during/after a class, `select class_link_source, count(*) from heart_rate_sessions where started_at > now() - interval '1 day' group by 1;` → see `booked` + `presence`; `select device_identifier from heart_rate_sessions where contact_id is null order by started_at desc limit 5;` → anon rows present once a walk-in strap is seen.

---

# PR3 — Coach roster panel

### Task 3.1: `mergeRosterWithSessions` pure helper

**Files:**
- Modify: `src/lib/class-bookings.js`
- Test: `src/lib/class-bookings.test.js`

- [ ] **Step 1: Write the failing test** — given roster rows + open sessions, returns a tagged list: booked+hasHr, booked+no-hr, anon (session not in roster).

```js
import { mergeRosterWithSessions } from './class-bookings'

describe('class-bookings: mergeRosterWithSessions', () => {
  const roster = [
    { glofox_member_id: 'm1', member_name: 'Jo B', status: 'BOOKED' },
    { glofox_member_id: 'm2', member_name: 'Al C', status: 'BOOKED' },
  ]
  const sessions = [
    { id: 's1', contactId: 'c1', glofoxMemberId: 'm1', contactName: 'Jo B', currentBpm: 140, device_identifier: 'ant:1' },
    { id: 's3', contactId: null, glofoxMemberId: null, contactName: 'ant:99', currentBpm: 120, device_identifier: 'ant:99' },
  ]
  it('tags booked+hr, booked+no-hr, and anon', () => {
    const out = mergeRosterWithSessions(roster, sessions)
    expect(out.find(r => r.label === 'Jo B')).toMatchObject({ booked: true, hasHr: true, currentBpm: 140 })
    expect(out.find(r => r.label === 'Al C')).toMatchObject({ booked: true, hasHr: false })
    expect(out.find(r => r.label === 'ant:99')).toMatchObject({ booked: false, hasHr: true, anon: true })
  })
})
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — join on `glofoxMemberId`; roster entries with a session are booked+hr, without are booked+no-hr; sessions with no roster match are anon/walk-in.

```js
/**
 * Pure: merge the class roster (class_bookings rows for the live occurrence)
 * with the open HR sessions into one tagged list for the coach panel.
 * Match key: glofox_member_id.
 */
export function mergeRosterWithSessions(roster = [], sessions = []) {
  const byMember = new Map()
  for (const s of sessions) if (s.glofoxMemberId) byMember.set(String(s.glofoxMemberId), s)
  const usedSessionIds = new Set()
  const out = []
  for (const r of roster) {
    if (String(r.status || '').toUpperCase() === 'CANCELLED') continue
    const s = r.glofox_member_id ? byMember.get(String(r.glofox_member_id)) : null
    if (s) usedSessionIds.add(s.id)
    out.push({
      label: r.member_name || (s ? s.contactName : null) || '—',
      booked: true, hasHr: !!s, anon: false,
      currentBpm: s?.currentBpm ?? null, sessionId: s?.id ?? null,
    })
  }
  for (const s of sessions) {
    if (usedSessionIds.has(s.id)) continue
    out.push({
      label: s.contactName || s.device_identifier || '—',
      booked: false, hasHr: true, anon: !s.contactId,
      currentBpm: s.currentBpm ?? null, sessionId: s.id,
    })
  }
  return out
}
```

> At execution: `getLiveSessions` must expose `glofoxMemberId` per session for the join — add it to the `getLiveSessions` select/shape in this PR (it embeds `contacts`; add `glofox_member_id` to the embed). Anon sessions have `glofoxMemberId: null`.

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -am "HR-CLASS-ALLOC.2 PR3 — mergeRosterWithSessions pure helper"`

---

### Task 3.2: `getClassRoster` IO + expose on `/api/live/[locationId]`

**Files:**
- Modify: `src/lib/class-bookings.js` (`getClassRoster`)
- Modify: `src/app/api/live/[locationId]/route.js` (return `roster` alongside `sessions`)
- Modify: `src/lib/live-class.js` (`getLiveSessions` — add `glofox_member_id` to the contacts embed + shape)

- [ ] **Step 1:** `getClassRoster(db, { locationId, nowMs })` — resolve the live occurrence (`resolveCurrentOccurrence`), read its `class_bookings` rows, return them (the merge happens in the route with the sessions it already fetches). Pure merge is tested; this IO just fetches.

```js
import { resolveCurrentOccurrence } from '@/lib/class-occurrences'

export async function getClassRoster(db, { locationId, nowMs = Date.now() } = {}) {
  const occ = await resolveCurrentOccurrence(db, { locationId, nowMs })
  if (!occ) return { occurrence: null, roster: [] }
  const { data } = await db
    .from('class_bookings')
    .select('glofox_member_id, member_name, status, attended, contact_id')
    .eq('location_id', locationId)
    .eq('glofox_event_id', occ.glofox_event_id)
  return { occurrence: occ, roster: data || [] }
}
```

- [ ] **Step 2:** In `/api/live/[locationId]/route.js`, after fetching `sessions = getLiveSessions(...)`, also `const { occurrence, roster } = await getClassRoster(db, { locationId })` and `const merged = mergeRosterWithSessions(roster, sessions)`; return `{ sessions, available_straps, roster: merged, occurrence }`.

- [ ] **Step 3:** Add `glofox_member_id` to `getLiveSessions`' contacts embed + emit it as `glofoxMemberId` on each session (null for anon).

- [ ] **Step 4: Test** the route shape if a route test exists; otherwise unit coverage on the merge (3.1) + manual verify. Run `npm run build`.
- [ ] **Step 5: Commit** — `git commit -am "HR-CLASS-ALLOC.2 PR3 — getClassRoster + roster on /api/live"`

---

### Task 3.3: Roster panel in `LiveClassClient.jsx`

**Files:**
- Modify: `src/app/live/[locationId]/LiveClassClient.jsx`

- [ ] **Step 1: Read** `LiveClassClient.jsx` to learn its existing session-tile rendering + fetch loop (it polls `/api/live/[locationId]`).
- [ ] **Step 2:** Consume the new `roster` array from the response. Render a "Class roster" section (below or beside the live leaderboard): booked+hr rows show name + live BPM (reuse the existing tile), booked+no-hr rows show name greyed with "no strap", anon rows show the device id + BPM with a "walk-in" chip. Use the `un1t-*` tokens + the `-700` status-text ramp per CLAUDE.md. Empty roster (no live class) → hide the section.
- [ ] **Step 3:** Manual visual check is auth-gated; rely on `npm run build` + a prod click-test post-merge. No new test (presentational).
- [ ] **Step 4: Commit** — `git commit -am "HR-CLASS-ALLOC.2 PR3 — coach live-class roster panel"`

---

### Task 3.4: Ship PR3

- [ ] Full CI mirror + `npm run build`. Branch `feat-hr-class-roster-pr3` off main, PR `base=main`, squash-merge. No migration.
- [ ] Prod: open `/live/<stillorgan>` during a class — roster shows booked members (HR where strap on), anon walk-ins tagged. Update memory ([[class-climate-v0]], [[champ-bridge-hr-live]]).

---

## Self-review

**Spec coverage:**
- 3-tier model → Task 2.3 (booked/presence) + 2.4 (anon) + 2.6 (labels). ✓
- `class_bookings` table → 1.1. ✓ Population (applyMemberSync hook + backfill) → 1.4 + 1.5. ✓
- Anonymous sessions (nullable + ingest + side-effect guards + board labels) → 2.1, 2.4, 2.5, 2.6. ✓
- Booked tag (direct lookup) → 2.2 + 2.3. ✓
- Roster panel (coach view) → 3.1–3.3. ✓ Public TV stays leaderboard (no roster) → unchanged in 2.6. ✓
- Honest limitation (no per-event endpoint) → documented in spec + 1.5. ✓

**Placeholder scan:** integration tasks (1.4, 2.3, 2.5, 2.6, 3.3) say "read the function / confirm variable names at execution" — these are real existing-code edits where exact line numbers shift; each gives the precise function, the new code block, and what to verify. Acceptable for an existing-codebase plan; not blank placeholders.

**Type consistency:** `mapBookingToRosterRow` / `upsertClassBookings` / `lookupBookedMember` / `resolveClassLinkSource` / `mergeRosterWithSessions` / `getClassRoster` names are used consistently across tasks. `class_link_source` values `'booked'|'presence'|null` match mig 287's CHECK. `via: 'anon'` parallels the existing `'override'|'auto'`. Session shape adds `glofoxMemberId` (3.2) before the merge consumes it (3.1). ✓
