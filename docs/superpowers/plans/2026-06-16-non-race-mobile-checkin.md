# Non-race mobile check-in — mobile events browse surface (EVENT-CHECKIN.E) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff browse to and check people in to non-race event kinds (workshop / seminar / open_day / masterclass) from the CF Studio mobile app, which is race-only today.

**Architecture:** Pure-JS/OTA mobile UI on top of an already-kind-agnostic backend. New unified mobile events list (all kinds) + event detail, mirroring web `/events`. Race rows keep the existing `/races/[id]` control board; non-race rows go to a detail screen → the existing kind-agnostic check-in roster (`mobile/app/races/checkin/[id].jsx`, reused unchanged). One new staff-accessible `GET /api/events` list endpoint; the existing `GET /api/events/[id]/checkin` is extended (additively) with event metadata. Shared event-kind presentation + browse-ordering helpers in `shared/events.js` keep web and mobile from drifting.

**Tech Stack:** Next.js 16 (App Router, route handlers) + Supabase service-role reads; Expo / React Native (expo-router, NativeWind); Vitest for the pure helpers.

**Spec:** `docs/superpowers/specs/2026-06-16-non-race-mobile-checkin-design.md`

**Branch:** `event-checkin-e-mobile-events` (already created off `main`).

---

## File structure

**Create**
- `shared/events.js` — pure: `EVENT_KINDS`, `eventKindLabel`, `eventKindTone`, `isRaceKind`, `orderEventsForBrowse`. Imported by web + mobile.
- `shared/events.test.js` — Vitest for the above.
- `src/app/api/events/route.js` — `GET /api/events`: staff-accessible list of all kinds at the active location, with `kind`, date/time, status, a rendered signup summary, and an `is_upcoming` flag (server computes the Dublin-today boundary).
- `mobile/lib/events-api.js` — `listEvents()` (the new list) + `eventDateLabel()` presentation helper.
- `mobile/app/events/_layout.jsx` — Stack for the events route group (mirrors `mobile/app/races/_layout.jsx`).
- `mobile/app/events/index.jsx` — the events list screen (all kinds).
- `mobile/app/events/[id].jsx` — event detail (metadata + live counts + actions).

**Modify**
- `src/app/events/page.js` — source kind label/tone + upcoming/past split from `shared/events.js` (behaviour-preserving DRY).
- `src/app/api/events/[id]/checkin/route.js` — extend the GET's `event` object with metadata (additive).
- `mobile/app/(tabs)/more.jsx` — the "Events" tile now routes to `/events` (the new list); drop the `events-hub` indirection.

**Delete**
- `mobile/app/events.jsx` — the old single-card chooser; replaced by `mobile/app/events/index.jsx` (both map to `/events`, only one can exist).
- `mobile/lib/events-hub.js` + `mobile/lib/events-hub.test.js` — the chooser-routing abstraction is no longer needed now that there's one rich list.

**Reused unchanged (do NOT edit — keeps this conflict-free with the open Phase D scanner PR #553, which touches `mobile/app/races/`)**
- `mobile/app/races/checkin/[id].jsx` — the kind-agnostic check-in roster.
- `mobile/app/races/[id].jsx` — race-day control board.
- `src/lib/event-signups.js`, `src/lib/event-checkins.js` — pure count helpers.

---

## Task 1: Shared event-kind + browse-ordering helpers (TDD) and adopt on web

**Files:**
- Create: `shared/events.js`
- Test: `shared/events.test.js`
- Modify: `src/app/events/page.js`

- [ ] **Step 1: Write the failing test**

Create `shared/events.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { EVENT_KINDS, eventKindLabel, eventKindTone, isRaceKind, orderEventsForBrowse } from './events'

describe('event kind presentation', () => {
  it('exposes the multi-kind list (mig 122)', () => {
    expect(EVENT_KINDS).toEqual(['race', 'workshop', 'seminar', 'open_day', 'masterclass', 'lead_gen'])
  })

  it('labels each kind', () => {
    expect(eventKindLabel('race')).toBe('Race')
    expect(eventKindLabel('workshop')).toBe('Workshop')
    expect(eventKindLabel('seminar')).toBe('Seminar')
    expect(eventKindLabel('open_day')).toBe('Open day')
    expect(eventKindLabel('masterclass')).toBe('Masterclass')
    expect(eventKindLabel('lead_gen')).toBe('Lead Gen')
  })

  it('maps each kind to a semantic tone', () => {
    expect(eventKindTone('race')).toBe('emerald')
    expect(eventKindTone('workshop')).toBe('sky')
    expect(eventKindTone('seminar')).toBe('indigo')
    expect(eventKindTone('open_day')).toBe('amber')
    expect(eventKindTone('masterclass')).toBe('pink')
    expect(eventKindTone('lead_gen')).toBe('teal')
  })

  it('falls back to race for null/unknown kinds (matches the web default)', () => {
    expect(eventKindLabel(null)).toBe('Race')
    expect(eventKindLabel('mystery')).toBe('Race')
    expect(eventKindTone(undefined)).toBe('emerald')
  })

  it('isRaceKind treats null/undefined as race', () => {
    expect(isRaceKind('race')).toBe(true)
    expect(isRaceKind(null)).toBe(true)
    expect(isRaceKind(undefined)).toBe(true)
    expect(isRaceKind('workshop')).toBe(false)
  })
})

describe('orderEventsForBrowse', () => {
  const today = '2026-06-16'

  it('splits on the Dublin-today boundary (today counts as upcoming)', () => {
    const events = [
      { id: 'past', race_date: '2026-06-10' },
      { id: 'today', race_date: '2026-06-16' },
      { id: 'future', race_date: '2026-06-20' },
    ]
    const { upcoming, past } = orderEventsForBrowse(events, today)
    expect(upcoming.map((e) => e.id)).toEqual(['today', 'future'])
    expect(past.map((e) => e.id)).toEqual(['past'])
  })

  it('sorts upcoming ascending (nearest first) and past descending (most recent first)', () => {
    const events = [
      { id: 'p1', race_date: '2026-06-01' },
      { id: 'p2', race_date: '2026-06-14' },
      { id: 'u1', race_date: '2026-06-25' },
      { id: 'u2', race_date: '2026-06-17' },
    ]
    const { upcoming, past } = orderEventsForBrowse(events, today)
    expect(upcoming.map((e) => e.id)).toEqual(['u2', 'u1'])
    expect(past.map((e) => e.id)).toEqual(['p2', 'p1'])
  })

  it('treats a missing race_date as upcoming so half-created events are not hidden', () => {
    const events = [{ id: 'nodate', race_date: null }]
    const { upcoming, past } = orderEventsForBrowse(events, today)
    expect(upcoming.map((e) => e.id)).toEqual(['nodate'])
    expect(past).toEqual([])
  })

  it('tolerates non-array input', () => {
    expect(orderEventsForBrowse(null, today)).toEqual({ upcoming: [], past: [] })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run shared/events.test.js`
Expected: FAIL — `Failed to resolve import "./events"` / functions undefined.

- [ ] **Step 3: Write the minimal implementation**

Create `shared/events.js`:

```js
// Pure event helpers shared by web (src/app/events) and mobile
// (mobile/app/events). Kept here so the kind labels/tones + the
// upcoming/past split can't drift between platforms. Pure — no DB,
// no network, no platform imports — so it unit-tests under Node and
// imports cleanly into the RN bundle.

// The multi-kind set from mig 122. `race` is the original/default kind.
export const EVENT_KINDS = ['race', 'workshop', 'seminar', 'open_day', 'masterclass', 'lead_gen']

// label + a SEMANTIC tone per kind. Each platform maps the tone to its
// own colour classes (web Tailwind vs mobile NativeWind) so the palette
// stays one decision here.
const KIND_META = {
  race:        { label: 'Race',        tone: 'emerald' },
  workshop:    { label: 'Workshop',    tone: 'sky' },
  seminar:     { label: 'Seminar',     tone: 'indigo' },
  open_day:    { label: 'Open day',    tone: 'amber' },
  masterclass: { label: 'Masterclass', tone: 'pink' },
  lead_gen:    { label: 'Lead Gen',    tone: 'teal' },
}

// Unknown/null kinds fall back to race — matches the web list's
// `kindBadge(r.kind || 'race')` default.
function meta(kind) {
  return KIND_META[kind] || KIND_META.race
}

export function eventKindLabel(kind) {
  return meta(kind).label
}

export function eventKindTone(kind) {
  return meta(kind).tone
}

export function isRaceKind(kind) {
  return (kind || 'race') === 'race'
}

/**
 * Split events into upcoming vs past against a YYYY-MM-DD "today" and
 * sort each block for a browse list: upcoming ascending (nearest first),
 * past descending (most recent first). An event with no race_date counts
 * as upcoming so a half-created event isn't hidden. Pure — the caller
 * supplies `today` (compute it in the operator's timezone server-side).
 * @param {Array<{race_date?: string|null}>} events
 * @param {string} today  YYYY-MM-DD
 * @returns {{upcoming: Array, past: Array}}
 */
export function orderEventsForBrowse(events, today) {
  const list = Array.isArray(events) ? events : []
  const upcoming = list
    .filter((e) => !e?.race_date || e.race_date >= today)
    .sort((a, b) => (a?.race_date || '').localeCompare(b?.race_date || ''))
  const past = list
    .filter((e) => e?.race_date && e.race_date < today)
    .sort((a, b) => (b?.race_date || '').localeCompare(a?.race_date || ''))
  return { upcoming, past }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run shared/events.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Adopt the helpers on the web list (behaviour-preserving)**

In `src/app/events/page.js`:

Add the import (next to the existing `event-signups` import on line 14):

```js
import { eventKindLabel, eventKindTone, orderEventsForBrowse } from '../../../shared/events'
```

> Note the relative path: `src/app/events/page.js` → repo root `shared/` is `../../../shared/events`.

Replace the `KIND_BADGE` map + `kindBadge` (lines 18–30) with a tone→class map that sources label/tone from the shared helper (keeps the exact same visual output):

```js
// Tone (from shared/events) → web Tailwind pill classes. The label and
// tone now live in shared/events.js so web + mobile can't drift; this map
// is just the web colour binding.
const TONE_CLS = {
  emerald: 'bg-emerald-500/15 text-emerald-700',
  sky:     'bg-sky-500/15 text-sky-700',
  indigo:  'bg-indigo-500/15 text-indigo-700',
  amber:   'bg-amber-500/15 text-amber-700',
  pink:    'bg-pink-500/15 text-pink-700',
  teal:    'bg-teal-500/15 text-teal-700',
}
const kindBadge = (k) => ({ label: eventKindLabel(k), cls: TONE_CLS[eventKindTone(k)] })
```

Replace the inline upcoming/past split (lines 88–95) with the shared helper:

```js
  const today = todayIsoDublin()
  const { upcoming, past } = orderEventsForBrowse(races, today)
```

(Leave everything else — `visible`, `tabs`, the `kindBadge(r.kind || 'race')` calls — unchanged. `kindBadge` keeps returning `{ label, cls }` so the JSX is untouched.)

- [ ] **Step 6: Run the full suite + lint to confirm no regression**

Run: `npm test && npm run lint`
Expected: PASS, no lint errors.

- [ ] **Step 7: Commit**

```bash
git add shared/events.js shared/events.test.js src/app/events/page.js
git commit -m "EVENT-CHECKIN.E — shared event-kind + browse-ordering helpers

shared/events.js: EVENT_KINDS, eventKindLabel/Tone, isRaceKind,
orderEventsForBrowse (pure, TDD'd). Web /events sources kind label/tone +
the upcoming/past split from it so web + mobile can't drift.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `GET /api/events` — staff-accessible events list endpoint

**Files:**
- Create: `src/app/api/events/route.js`

> No openapi registration — the sibling event/race routes (`/api/races`, `/api/events/[id]/checkin`) are not registered in `src/lib/openapi.js`, so we stay consistent. No new permission key (reuses `races`). The route's logic leans on the already-tested pure helpers (`orderEventsForBrowse` from Task 1, `computeSignupCounts`/`formatSignupSummary`/`sumWaveCapacity` from `event-signups`); it is verified by the `next build` + smoke in Task 7, matching how the un-unit-tested sibling routes are handled.

- [ ] **Step 1: Create the route**

Create `src/app/api/events/route.js`:

```js
// GET /api/events — list every event kind at the active (or ?location_id=)
// location for the mobile events browse surface (EVENT-CHECKIN.E).
//
// Staff-accessible: hasPermission('races') with NO MANAGER_ROLES gate — the
// mobile door-staff use case mirrors web /events (front-of-house). This is
// the deliberate divergence from GET /api/races, which is the manager-only
// race-day CONTROL list. Returns the data a list row needs: kind, date/time,
// status, a rendered signup summary, and an is_upcoming flag (the Dublin
// today boundary is computed server-side so mobile carries no timezone math).

import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { formatSignupSummary, sumWaveCapacity } from '@/lib/event-signups'
import { isRaceKind, orderEventsForBrowse } from '@shared/events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Today's date as the operator sees it (Europe/Dublin), YYYY-MM-DD —
// same approach as the web /events page so the boundary matches.
function todayIsoDublin() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Dublin', year: 'numeric', month: '2-digit', day: '2-digit',
  })
  return fmt.format(new Date())
}

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermission(user, 'races')) {
    return NextResponse.json({ success: false, error: 'Events feature is disabled at this location' }, { status: 403 })
  }

  const url = new URL(request.url)
  const filterLocation = url.searchParams.get('location_id')
  if (filterLocation) {
    const guard = assertLocationAccess(user, filterLocation)
    if (guard) return guard
  }
  const activeLocationId = filterLocation || user.activeLocation?.id || null
  if (!activeLocationId) return NextResponse.json({ success: true, data: [] })

  const db = createServerClient()
  // Scope to the active location PLUS any event flagged `shared` (owned by
  // one location, surfaced everywhere) — same rule as the web /events list.
  const { data, error } = await db
    .from('race_events')
    .select(`
      id, name, slug, race_date, start_time, capacity, capacity_mode,
      active, kind, shared, location_id,
      waves:race_waves ( capacity ),
      registrations:race_registrations ( id, status, team:teams ( size ) )
    `)
    .or(`location_id.eq.${activeLocationId},shared.eq.true`)
    .order('race_date', { ascending: false })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const shaped = (data || []).map((r) => {
    const isRace = isRaceKind(r.kind)
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      kind: r.kind || 'race',
      race_date: r.race_date,
      start_time: r.start_time,
      active: r.active,
      shared: r.shared,
      signup_summary: formatSignupSummary(r.registrations, {
        isRace,
        capacity: sumWaveCapacity(r.waves) ?? r.capacity,
        mode: r.capacity_mode,
      }),
    }
  })

  // Upcoming first (nearest date asc), then past (most recent desc). Stamp
  // is_upcoming so the client can render a "Past" divider without doing its
  // own timezone-sensitive date math.
  const { upcoming, past } = orderEventsForBrowse(shaped, todayIsoDublin())
  const ordered = [
    ...upcoming.map((e) => ({ ...e, is_upcoming: true })),
    ...past.map((e) => ({ ...e, is_upcoming: false })),
  ]
  return NextResponse.json({ success: true, data: ordered })
}
```

> Import note: web/`src` code imports the repo-root `shared/` via the **`@shared/*`** jsconfig alias (e.g. `@shared/events`) — that's the convention across `src/`. (Only the mobile RN bundle uses relative `../../../shared/...` paths, since it has no alias.) *[Superseded 2026-07-26 / SDK 57: mobile now imports `'shared/<module>'` via the `shared` file: package — relative `../shared` paths no longer resolve.]*

- [ ] **Step 2: Confirm the route-guard linter accepts it**

Run: `npm run check:route-guards`
Expected: PASS — the route calls `getCurrentUser()` (a recognised session guard). No EXEMPT entry needed.

- [ ] **Step 3: Confirm lint + the existing suite are clean**

Run: `npm run lint && npm test`
Expected: PASS (no new tests here; the pure helpers are covered by Task 1 + `event-signups.test.js`).

- [ ] **Step 4: Commit**

```bash
git add 'src/app/api/events/route.js'
git commit -m "EVENT-CHECKIN.E — GET /api/events staff-accessible events list

All event kinds at the active location for the mobile browse surface:
kind, date/time, status, rendered signup summary, is_upcoming flag.
Gated on hasPermission('races') with no MANAGER_ROLES check (mirrors web
/events for door staff) — the one deliberate divergence from the
manager-only /api/races control list. Reuses event-signups + shared
orderEventsForBrowse; no new permission, no migration.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Extend the check-in roster GET with event metadata

**Files:**
- Modify: `src/app/api/events/[id]/checkin/route.js`

> The mobile event-detail screen reuses this GET (it already returns the roster + live counts). Adding event metadata is purely additive — the existing roster screen ignores the new `event` fields.

- [ ] **Step 1: Add the `sumWaveCapacity` import**

In `src/app/api/events/[id]/checkin/route.js`, add to the imports (next to the existing `checkinCounts` import):

```js
import { sumWaveCapacity } from '@/lib/event-signups'
```

- [ ] **Step 2: Widen the GET select to fetch the metadata**

In the `GET` handler, replace the `race_events` select (currently `id, name, location_id, race_date, kind,` plus the waves/registrations embeds) so it also pulls slug/time/capacity/status, and the waves embed includes `capacity`:

```js
  const { data: race } = await db
    .from('race_events')
    .select(`
      id, name, location_id, race_date, kind, slug, start_time, capacity, capacity_mode, active,
      waves:race_waves ( id, start_time, label, display_order, capacity ),
      registrations:race_registrations (
        id, status, wave_id,
        teams ( id, name, team_members ( id, name, email, contact_id ) )
      )
    `)
    .eq('id', params.id)
    .single()
```

- [ ] **Step 3: Return the metadata on the `event` object**

Replace the existing `event: { id: race.id, name: race.name, kind: race.kind, isRace: (race.kind || 'race') === 'race' }` line in the JSON response with:

```js
      event: {
        id: race.id,
        name: race.name,
        kind: race.kind,
        isRace: (race.kind || 'race') === 'race',
        slug: race.slug,
        race_date: race.race_date,
        start_time: race.start_time,
        capacity: sumWaveCapacity(race.waves) ?? race.capacity,
        capacity_mode: race.capacity_mode,
        active: race.active,
      },
```

- [ ] **Step 4: Confirm lint + suite**

Run: `npm run lint && npm test`
Expected: PASS — additive change, no test depends on the old `event` shape.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/events/[id]/checkin/route.js'
git commit -m "EVENT-CHECKIN.E — return event metadata on the check-in roster GET

Additive: the GET now includes slug, start_time, resolved capacity,
capacity_mode, race_date and active on its event object so the mobile
event-detail screen can render metadata from the same fetch. Existing
roster consumers ignore the new fields.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Mobile events API client

**Files:**
- Create: `mobile/lib/events-api.js`

- [ ] **Step 1: Create the client**

Create `mobile/lib/events-api.js`:

```js
// Mobile events browse client (EVENT-CHECKIN.E). The list goes through
// api() so Bearer + x-active-location + x-impersonate-target are built
// once and can't drift (see the impersonation-header lesson). The event
// DETAIL + roster reuse getCheckinRoster from event-checkin-api.js — the
// check-in GET already returns the event metadata + live counts.

import { api } from './api'

/** GET /api/events?location_id= → { success, data: events[] } */
export function listEvents({ locationId } = {}) {
  const qs = locationId ? `?location_id=${encodeURIComponent(locationId)}` : ''
  return api(`/api/events${qs}`, { locationId })
}

/** Short date label for a YYYY-MM-DD event date, e.g. "Tue, 16 Jun". */
export function eventDateLabel(iso) {
  if (!iso) return ''
  try {
    return new Date(iso + 'T00:00:00').toLocaleDateString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
    })
  } catch {
    return iso
  }
}
```

- [ ] **Step 2: Confirm the mobile import linter is happy**

Run: `npm run check:mobile-imports`
Expected: PASS — `./api` exports `api`.

- [ ] **Step 3: Commit**

```bash
git add mobile/lib/events-api.js
git commit -m "EVENT-CHECKIN.E — mobile events-api client (listEvents + date label)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Mobile events list screen + nav rewire

**Files:**
- Create: `mobile/app/events/_layout.jsx`
- Create: `mobile/app/events/index.jsx`
- Delete: `mobile/app/events.jsx`
- Modify: `mobile/app/(tabs)/more.jsx`
- Modify: `mobile/app/_layout.jsx` (root stack — flip the `events` screen to `headerShown: false`)
- Delete: `mobile/lib/events-hub.js`, `mobile/lib/events-hub.test.js`

- [ ] **Step 1: Delete the old chooser screen (frees the `/events` route for the folder)**

```bash
git rm mobile/app/events.jsx
```

- [ ] **Step 2: Create the events route-group layout**

Create `mobile/app/events/_layout.jsx`:

```jsx
// Stack layout for the mobile events browse surface (EVENT-CHECKIN.E).
// Reached from the More launcher (/events). Each screen sets its own
// title + BackHeaderLeft. Mirrors mobile/app/races/_layout.jsx.
import { Stack } from 'expo-router'

export default function EventsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: '#FFFFFF' },
        headerTintColor: '#111827',
        headerTitleStyle: { fontWeight: '600' },
        headerBackTitle: 'Back',
      }}
    >
      <Stack.Screen name="index" options={{ title: 'Events' }} />
      <Stack.Screen name="[id]" options={{ title: 'Event' }} />
    </Stack>
  )
}
```

- [ ] **Step 3: Create the events list screen**

Create `mobile/app/events/index.jsx`:

```jsx
// EVENT-CHECKIN.E — mobile events browse list (all kinds). Mirrors web
// /events. Race rows open the existing race-day control board; non-race
// rows open the event detail (→ the kind-agnostic check-in roster).
// Gated by canMobile('races') — the same key that gates the whole events
// feature. The list endpoint is staff-accessible, so door staff see it.
import { useState, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, RefreshControl, ActivityIndicator } from 'react-native'
import { useRouter, Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import { canMobile } from '../../lib/permissions'
import { listEvents, eventDateLabel } from '../../lib/events-api'
import { eventKindLabel, eventKindTone, isRaceKind } from '../../../shared/events'
import BackHeaderLeft from '../../components/BackHeaderLeft'

// Semantic tone (shared/events) → NativeWind pill classes.
const TONE_CLS = {
  emerald: 'bg-emerald-500/15 text-emerald-700',
  sky:     'bg-sky-500/15 text-sky-700',
  indigo:  'bg-indigo-500/15 text-indigo-700',
  amber:   'bg-amber-500/15 text-amber-700',
  pink:    'bg-pink-500/15 text-pink-700',
  teal:    'bg-teal-500/15 text-teal-700',
}

function EventRow({ event, onPress }) {
  const toneCls = TONE_CLS[eventKindTone(event.kind)] || TONE_CLS.emerald
  return (
    <Pressable
      onPress={onPress}
      className="bg-white border border-un1t-border rounded-2xl p-4 mb-2 active:opacity-70"
    >
      <View className="flex-row items-center justify-between mb-0.5">
        <Text className="text-base font-semibold text-un1t-text flex-1" numberOfLines={1}>{event.name || 'Event'}</Text>
        <View className={`px-2 py-0.5 rounded-full ml-2 ${toneCls}`}>
          <Text className={`text-[10px] uppercase tracking-wider ${toneCls.split(' ')[1]}`}>{eventKindLabel(event.kind)}</Text>
        </View>
      </View>
      <Text className="text-xs text-un1t-subtle">
        {eventDateLabel(event.race_date)}
        {event.start_time ? ` · ${String(event.start_time).slice(0, 5)}` : ''}
        {event.active === false ? '  · Inactive' : ''}
      </Text>
      <Text className="text-xs text-un1t-subtle mt-1">{event.signup_summary}</Text>
    </Pressable>
  )
}

export default function EventsList() {
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const canView = canMobile(profile, 'races', activeLocation)

  const [events, setEvents] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    const res = await listEvents({ locationId: activeLocation?.id })
    if (res.success === false) { setError(res.error || 'Failed to load'); setEvents([]); return }
    setError(null)
    setEvents(Array.isArray(res.data) ? res.data : [])
  }, [activeLocation?.id])

  useFocusEffect(useCallback(() => {
    if (!canView) { setLoading(false); return }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [canView, load]))

  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false) }

  function openEvent(ev) {
    // Race → existing control board; non-race → the event detail.
    if (isRaceKind(ev.kind)) router.push(`/races/${ev.id}`)
    else router.push(`/events/${ev.id}`)
  }

  // First past event marks where the "Past" divider goes.
  const firstPastId = events.find((e) => e.is_upcoming === false)?.id || null

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Events', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }} />

      {!canView ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
          <Text className="text-xs text-un1t-subtle text-center mt-1">Events are only shown where they’re enabled for you.</Text>
        </View>
      ) : (
        <ScrollView
          contentContainerClassName="px-4 py-3 pb-10"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
        >
          {error && (
            <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
              <Text className="text-red-500 text-sm">{error}</Text>
            </View>
          )}

          {loading ? (
            <View className="py-12 items-center"><ActivityIndicator /></View>
          ) : events.length === 0 ? (
            <View className="py-16 items-center px-6">
              <Ionicons name="calendar-outline" size={30} color="#94A3B8" />
              <Text className="text-base font-semibold text-un1t-text mt-3">No events</Text>
              <Text className="text-xs text-un1t-subtle text-center mt-1">Events at {activeLocation?.name || 'this studio'} show up here. Create them on the web.</Text>
            </View>
          ) : (
            events.map((ev) => (
              <View key={ev.id}>
                {ev.id === firstPastId && (
                  <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mt-3 mb-2">Past</Text>
                )}
                <EventRow event={ev} onPress={() => openEvent(ev)} />
              </View>
            ))
          )}
        </ScrollView>
      )}
    </View>
  )
}
```

- [ ] **Step 4: Point the More-grid "Events" tile at the new list**

In `mobile/app/(tabs)/more.jsx`:

Remove the events-hub import (line 26):

```js
import { eventsLanding, EVENTS_ROUTES } from '../../lib/events-hub'
```

Replace the events-tile block (lines 212–223, the comment block + `const evLanding = …` + the `if (evLanding) { tiles.push(…) }`) with:

```js
  // EVENT-CHECKIN.E — one "Events" tile opens the unified mobile events
  // list (all kinds). Race rows open the race-day control board; non-race
  // rows open the event detail → check-in. Gated by the `races` permission
  // (kept as the internal key for the whole multi-kind events feature).
  if (canMobile(profile, 'races', activeLocation)) {
    tiles.push({ key: 'events', icon: 'calendar-outline', label: 'Events', onPress: () => router.push('/events') })
  }
```

- [ ] **Step 4b: Flip the root-stack `events` screen to `headerShown: false`**

The root `mobile/app/_layout.jsx` explicitly registers each screen. The old single-file `events.jsx` was registered with `headerShown: true` (it had no nested layout). Now that `events` is a folder route group **with its own `_layout.jsx`** (which supplies per-screen headers, exactly like the `races` group), the root entry must hide its header to avoid a double header. Change the events line to match the `races` line:

```jsx
              <Stack.Screen name="events" options={{ headerShown: false }} />
```

(Leave every other `Stack.Screen` registration untouched.)

- [ ] **Step 5: Delete the now-unused events-hub module + test**

```bash
git rm mobile/lib/events-hub.js mobile/lib/events-hub.test.js
```

- [ ] **Step 6: Run the mobile-import + parity + suite + lint gates**

Run: `npm run check:mobile-imports && npm run check:mobile-parity && npm test && npm run lint`
Expected: PASS. Specifically:
- mobile-imports: confirms `events/index.jsx` imports resolve and nothing still imports the deleted `events-hub`.
- parity: still green — no permission change (`races` already has its `MOBILE_PERMISSIONS` entry).
- test: the deleted `events-hub.test.js` is gone; everything else green.

- [ ] **Step 7: Commit**

```bash
git add mobile/app/events/_layout.jsx mobile/app/events/index.jsx 'mobile/app/(tabs)/more.jsx' mobile/app/_layout.jsx
git commit -m "EVENT-CHECKIN.E — mobile events list + route the Events tile to it

New /events route group (all kinds): race rows → race-day control,
non-race rows → event detail. The More-grid Events tile now opens this
list. Retires the single-card events-hub chooser (events.jsx +
events-hub.js/.test) now that there's one rich list.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Mobile event detail screen

**Files:**
- Create: `mobile/app/events/[id].jsx`

- [ ] **Step 1: Create the detail screen**

Create `mobile/app/events/[id].jsx`:

```jsx
// EVENT-CHECKIN.E — mobile event detail (browse). Metadata + live
// attendance summary + actions. Data comes from the check-in roster GET
// (getCheckinRoster), which returns the event metadata + counts. The
// interactive roster lives on the existing /races/checkin/[id] screen
// (kind-agnostic, reused unchanged). Non-race kinds reach check-in here;
// races also expose the race-day control board.
import { useState, useCallback } from 'react'
import { View, Text, ScrollView, Pressable, ActivityIndicator, Linking } from 'react-native'
import Constants from 'expo-constants'
import { useLocalSearchParams, useRouter, Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../../lib/auth-context'
import { canMobile } from '../../lib/permissions'
import { getCheckinRoster } from '../../lib/event-checkin-api'
import { eventDateLabel, eventKindBadgeClasses } from '../../lib/events-api'
import { eventKindLabel, isRaceKind } from '../../../shared/events'
import BackHeaderLeft from '../../components/BackHeaderLeft'

function MetaRow({ icon, children }) {
  if (!children) return null
  return (
    <View className="flex-row items-center mb-2">
      <Ionicons name={icon} size={15} color="#64748B" />
      <Text className="text-sm text-un1t-text ml-2">{children}</Text>
    </View>
  )
}

export default function EventDetail() {
  const { id } = useLocalSearchParams()
  const { profile, activeLocation } = useAuth()
  const router = useRouter()
  const canView = canMobile(profile, 'races', activeLocation)

  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    const res = await getCheckinRoster(id, { locationId: activeLocation?.id })
    if (res.success === false) { setError(res.error || 'Failed to load'); return }
    setError(null)
    setData(res.data)
  }, [id, activeLocation?.id])

  useFocusEffect(useCallback(() => {
    if (!canView) { setLoading(false); return }
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [canView, load]))

  const event = data?.event
  const counts = data?.counts
  const badge = event ? eventKindBadgeClasses(event.kind) : eventKindBadgeClasses('race')

  function openPublicPage() {
    const base = Constants.expoConfig?.extra?.apiBaseUrl
    if (base && event?.slug) Linking.openURL(`${base}/event/${event.slug}`)
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: event?.name || 'Event', headerLeft: () => <BackHeaderLeft label="Events" fallbackHref="/events" /> }} />

      {!canView ? (
        <View className="py-16 items-center px-6">
          <Text className="text-base font-semibold text-un1t-text mt-3">Not available</Text>
        </View>
      ) : loading && !data ? (
        <View className="flex-1 items-center justify-center"><ActivityIndicator color="#94A3B8" /></View>
      ) : error && !data ? (
        <View className="flex-1 items-center justify-center p-6">
          <Text className="text-sm text-red-700 text-center">{error}</Text>
          <Pressable onPress={() => router.back()} className="mt-4"><Text className="text-sm text-blue-600">Back</Text></Pressable>
        </View>
      ) : event ? (
        <ScrollView contentContainerClassName="px-4 py-4 pb-12">
          {/* Header: name + kind badge */}
          <View className="flex-row items-center mb-4">
            <Text className="text-xl font-bold text-un1t-text flex-1" numberOfLines={2}>{event.name}</Text>
            <View className={`px-2.5 py-1 rounded-full ml-2 ${badge.bg}`}>
              <Text className={`text-[11px] uppercase tracking-wider ${badge.text}`}>{eventKindLabel(event.kind)}</Text>
            </View>
          </View>

          {/* Metadata */}
          <View className="bg-white border border-un1t-border rounded-2xl p-4 mb-4">
            <MetaRow icon="calendar-outline">
              {eventDateLabel(event.race_date)}{event.start_time ? ` · ${String(event.start_time).slice(0, 5)}` : ''}
            </MetaRow>
            {Number.isFinite(event.capacity) && event.capacity > 0 ? (
              <MetaRow icon="people-outline">
                Capacity {event.capacity} {event.capacity_mode === 'people' ? 'people' : 'teams'}
              </MetaRow>
            ) : null}
            <MetaRow icon={event.active === false ? 'pause-circle-outline' : 'checkmark-circle-outline'}>
              {event.active === false ? 'Inactive' : 'Active'}
            </MetaRow>
            {event.slug ? (
              <Pressable onPress={openPublicPage} className="flex-row items-center mt-1 active:opacity-60">
                <Ionicons name="open-outline" size={15} color="#2563EB" />
                <Text className="text-sm text-blue-600 ml-2">Public signup page</Text>
              </Pressable>
            ) : null}
          </View>

          {/* Live attendance */}
          <View className="bg-white border border-un1t-border rounded-2xl p-4 mb-4">
            <Text className="text-[11px] uppercase tracking-wider text-un1t-subtle mb-1">Checked in</Text>
            {counts && counts.expected > 0 ? (
              <Text className="text-2xl font-bold text-un1t-text">{counts.present} <Text className="text-base font-normal text-un1t-subtle">/ {counts.expected} people</Text></Text>
            ) : (
              <Text className="text-sm text-un1t-subtle">No one registered yet.</Text>
            )}
          </View>

          {/* Actions */}
          <Pressable
            onPress={() => router.push(`/races/checkin/${id}`)}
            className="bg-blue-600 rounded-2xl py-3.5 items-center flex-row justify-center mb-2 active:opacity-80"
          >
            <Ionicons name="checkmark-done-outline" size={18} color="#FFFFFF" />
            <Text className="text-base font-semibold text-white ml-2">Attendees & check in</Text>
          </Pressable>

          {isRaceKind(event.kind) && (
            <Pressable
              onPress={() => router.push(`/races/${id}`)}
              className="border border-un1t-border rounded-2xl py-3.5 items-center flex-row justify-center active:bg-un1t-border/40"
            >
              <Ionicons name="flag-outline" size={18} color="#111827" />
              <Text className="text-base font-semibold text-un1t-text ml-2">Race-day control</Text>
            </Pressable>
          )}
        </ScrollView>
      ) : null}
    </View>
  )
}
```

- [ ] **Step 2: Run the mobile-import + lint gates**

Run: `npm run check:mobile-imports && npm run lint`
Expected: PASS — every named import (`getCheckinRoster`, `eventDateLabel`, `eventKindLabel`/`eventKindTone`/`isRaceKind`, `canMobile`, `useAuth`, `BackHeaderLeft`) resolves to a real export in its target module.

- [ ] **Step 3: Commit**

```bash
git add 'mobile/app/events/[id].jsx'
git commit -m "EVENT-CHECKIN.E — mobile event detail screen

Browse metadata (date/time, capacity, status, public page link) + live
checked-in count + actions: 'Attendees & check in' (all kinds, → the
reused roster) and 'Race-day control' (race only). Data from the
check-in roster GET; fresh-on-focus.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Full CI mirror, production build, push, PR

**Files:** none (verification + ship).

- [ ] **Step 1: Run the complete CI mirror**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards
```
Expected: all five PASS.

- [ ] **Step 2: Run a real production build (catches import-resolution / Turbopack failures the CI mirror misses)**

Run: `npm run build`
Expected: build completes. The new `GET /api/events` route and the new `shared/events` import on web must compile.

- [ ] **Step 3: Sanity-check the mobile bundle exports (Metro)**

Run: `cd mobile && npx expo export -p ios >/dev/null 2>&1 && echo OK || echo FAILED; cd -`
Expected: `OK` — the new `mobile/app/events/*` screens + `events-api` bundle cleanly. (Metro tolerates bad imports, so this is a bundling smoke test, not an import check — `check:mobile-imports` in Step 1 is the import gate.)

- [ ] **Step 4: Push the branch**

```bash
git push -u origin event-checkin-e-mobile-events
```

- [ ] **Step 5: Open the PR**

```bash
gh pr create --base main --head event-checkin-e-mobile-events \
  --title "EVENT-CHECKIN.E — non-race mobile check-in via a mobile events browse surface" \
  --body "$(cat <<'EOF'
## What

Adds a mobile events browse surface so staff can reach and check people in to **non-race** event kinds (workshop / seminar / open_day / masterclass) from the CF Studio app. The app was race-only; non-race events were unreachable on mobile.

The check-in backend was already kind-agnostic — this is mobile UI plus one staff-accessible list endpoint.

## Changes

- **`shared/events.js`** (new, TDD'd) — `eventKindLabel`/`eventKindTone`/`isRaceKind` + `orderEventsForBrowse`. Web `/events` now sources kind label/tone + the upcoming/past split from it so web + mobile can't drift.
- **`GET /api/events`** (new) — staff-accessible list of all kinds at the active location (kind, date/time, status, signup summary, `is_upcoming`). Gated on `hasPermission('races')` with **no** `MANAGER_ROLES` check (mirrors web `/events` for door staff) — the one deliberate divergence from the manager-only `/api/races` control list.
- **`GET /api/events/[id]/checkin`** — additively returns event metadata (slug, time, capacity, status) so the mobile detail screen renders from one fetch.
- **Mobile** — new `/events` list (all kinds) + `/events/[id]` detail; the More-grid "Events" tile opens the list. Race rows → existing race-day control board; non-race rows → detail → the **reused, unchanged** check-in roster (`/races/checkin/[id]`). Retired the old single-card events-hub chooser.

## Scope / boundaries

- Browse + check-in only — **no event authoring on mobile** (stays web).
- No `RaceTeamsManager` port (team editing stays web).
- No in-app QR scanner here (that's Phase D / #553, a separate native release).
- Reuses the `races` permission key — no new permission, no migration, no parity change.

## Out-of-band

- Pure-JS → **OTA-able**; merging to `main` auto-publishes to the production channel.
- Conflict-free with the open Phase D PR #553 (this touches `mobile/app/events/`, not `mobile/app/races/`).

## Verified

N tests pass, lint clean, build clean, parity + mobile-imports + route-guards clean. Mobile screens are auth-gated, so not author-verified — needs operator device QA (non-blocking, as with Phase C).

Spec: `docs/superpowers/specs/2026-06-16-non-race-mobile-checkin-design.md`
Plan: `docs/superpowers/plans/2026-06-16-non-race-mobile-checkin.md`
EOF
)"
```

> If `gh` is unavailable, use the curl-against-`api.github.com` pattern from CLAUDE.md ("Shipping from the sandbox"). Report the PR URL back.

- [ ] **Step 6: Update the feature memory**

Append the EVENT-CHECKIN.E outcome (PR #, OTA status, device-QA-pending) to the `event-checkin-feature` memory and mark #3 done.

---

## Notes for the implementer
- **Do not edit `mobile/app/races/checkin/[id].jsx` or `mobile/app/races/[id].jsx`** — they're reused as-is and editing them risks conflicts with the open Phase D PR #553.
- **`race_events.start_time`** is an event-level column (not a wave time) — render it directly (`String(start_time).slice(0,5)`), as the web list does.
- Importing `shared/events.js`: **web/`src` code uses the `@shared/events` jsconfig alias** (the convention across `src/`). **Mobile RN code uses a relative path** — `../../../shared/events` from `mobile/app/events/*` (no alias in the RN bundle). Don't use a relative `../../../../shared` path from `src/` — switch it to `@shared`. *[Superseded 2026-07-26 / SDK 57: mobile now imports `'shared/events'` via the `shared` file: package.]*
- Mobile cannot import `src/lib/*` — that's why the count formatting happens server-side in `GET /api/events` and only `shared/events.js` crosses into the RN bundle.
```
