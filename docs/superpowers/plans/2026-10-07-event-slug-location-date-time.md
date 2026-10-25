# EVENT-SLUG.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Event public URLs read as place, date and time (`/event/hatch-oct18-1100`), derived automatically on both create paths and re-derived on host edits until publish; then rename the 10 upcoming events.

**Architecture:** One pure helper `src/lib/event-slug.js` (place/date/time → slug, plus `uniqueEventSlug(db, base, { excludeId })` for the clash suffix and `shouldRederiveSlug(status)`). `POST /api/events`, `POST /api/host/events` and `PUT /api/host/events/[id]` call it. The data fix is SQL through the Supabase MCP after the code deploys. No migration, no form change.

**Tech Stack:** Next.js 16 route handlers, supabase-js, vitest. Spec: `docs/superpowers/specs/2026-10-07-event-slug-location-date-time-design.md`.

---

### Task 1: The pure slug helper

**Files:**
- Create: `src/lib/event-slug.js`
- Test: `src/lib/event-slug.test.js`

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest'
import { placeToken, dateToken, timeToken, eventSlug, shouldRederiveSlug, uniqueEventSlug } from './event-slug'

describe('placeToken', () => {
  it('strips UN1T and bracketed text and keeps the first word, lowercase', () => {
    expect(placeToken('UN1T Hatch Street (Harcourt Luas stop)')).toBe('hatch')
    expect(placeToken('UN1T STILLORGAN')).toBe('stillorgan')
    expect(placeToken('SAINT Studios')).toBe('saint')
    expect(placeToken('UN1T HATCH')).toBe('hatch')
  })
  it('skips a leading "the"', () => {
    expect(placeToken('The Marker Hotel')).toBe('marker')
  })
  it('drops non-ASCII and falls back to "event"', () => {
    expect(placeToken('Café Bleu')).toBe('caf')
    expect(placeToken('')).toBe('event')
    expect(placeToken(null)).toBe('event')
    expect(placeToken('UN1T ()')).toBe('event')
  })
})

describe('dateToken', () => {
  it('is lowercase 3-letter month plus unpadded day, parsed as a plain date', () => {
    expect(dateToken('2026-11-22')).toBe('nov22')
    expect(dateToken('2026-12-05')).toBe('dec5')
    expect(dateToken('2026-10-01')).toBe('oct1')
  })
  it('returns null for a missing or malformed date', () => {
    expect(dateToken(null)).toBeNull()
    expect(dateToken('22/11/2026')).toBeNull()
    expect(dateToken('2026-13-01')).toBeNull()
  })
})

describe('timeToken', () => {
  it('accepts HH:MM and HH:MM:SS', () => {
    expect(timeToken('11:00')).toBe('1100')
    expect(timeToken('18:35:00')).toBe('1835')
    expect(timeToken('09:05')).toBe('0905')
  })
  it('returns null for missing or malformed times', () => {
    expect(timeToken(null)).toBeNull()
    expect(timeToken('11am')).toBeNull()
    expect(timeToken('25:00')).toBeNull()
  })
})

describe('eventSlug', () => {
  it('joins place-date-time', () => {
    expect(eventSlug({ place: 'UN1T Hatch Street (Harcourt Luas stop)', date: '2026-10-18', time: '11:00:00' })).toBe('hatch-oct18-1100')
    expect(eventSlug({ place: 'UN1T STILLORGAN', date: '2026-11-22', time: '13:45' })).toBe('stillorgan-nov22-1345')
  })
  it('uses the EARLIEST of several times', () => {
    expect(eventSlug({ place: 'UN1T Stillorgan', date: '2026-10-17', times: ['12:00:00', '10:30:00', '11:15:00'] })).toBe('stillorgan-oct17-1030')
  })
  it('falls back to the name slug when the date or time is missing (lead-gen forms)', () => {
    expect(eventSlug({ place: 'UN1T Hatch Street', date: null, time: null, name: 'UN1T Hatch Street' })).toBe('un1t-hatch-street')
    expect(eventSlug({ place: 'UN1T Hatch Street', date: '2026-10-18', times: [], name: 'Open Day!' })).toBe('open-day')
  })
  it('falls back to "event" when nothing usable exists', () => {
    expect(eventSlug({ place: '', date: null, time: null, name: '' })).toBe('event')
  })
  it('always satisfies the route slug rule', () => {
    const rule = /^[a-z0-9]+(-[a-z0-9]+)*$/
    for (const s of [
      eventSlug({ place: 'UN1T Hatch Street (Harcourt Luas stop)', date: '2026-10-18', time: '11:00:00' }),
      eventSlug({ place: 'Café Bleu', date: '2026-01-01', time: '00:00' }),
      eventSlug({ place: '', date: null, time: null, name: '  Hello   World ' }),
    ]) expect(s).toMatch(rule)
  })
})

describe('shouldRederiveSlug', () => {
  it('re-derives while unpublished and freezes once published', () => {
    expect(shouldRederiveSlug('draft')).toBe(true)
    expect(shouldRederiveSlug('rejected')).toBe(true)
    expect(shouldRederiveSlug('pending_review')).toBe(true)
    expect(shouldRederiveSlug('published')).toBe(false)
    expect(shouldRederiveSlug(undefined)).toBe(false)
  })
})

describe('uniqueEventSlug', () => {
  function dbWithTaken(taken) {
    return {
      from: () => ({
        select: () => {
          const q = { _slug: null, _neq: null }
          q.eq = (col, v) => { q._slug = v; return q }
          q.neq = (col, v) => { q._neq = v; return q }
          q.maybeSingle = async () => {
            const hit = taken.find((t) => t.slug === q._slug && t.id !== q._neq)
            return { data: hit ? { id: hit.id } : null, error: null }
          }
          return q
        },
      }),
    }
  }
  it('returns the base when free', async () => {
    expect(await uniqueEventSlug(dbWithTaken([]), 'hatch-oct18-1100')).toBe('hatch-oct18-1100')
  })
  it('suffixes -2, -3 until free', async () => {
    const db = dbWithTaken([{ id: 'a', slug: 'hatch-oct18-1100' }, { id: 'b', slug: 'hatch-oct18-1100-2' }])
    expect(await uniqueEventSlug(db, 'hatch-oct18-1100')).toBe('hatch-oct18-1100-3')
  })
  it('ignores the event being edited', async () => {
    const db = dbWithTaken([{ id: 'me', slug: 'hatch-oct18-1100' }])
    expect(await uniqueEventSlug(db, 'hatch-oct18-1100', { excludeId: 'me' })).toBe('hatch-oct18-1100')
  })
  it('treats a read error as taken (never hands back a slug it could not check)', async () => {
    let n = 0
    const db = { from: () => ({ select: () => { const q = {}; q.eq = () => q; q.neq = () => q; q.maybeSingle = async () => (n++ === 0 ? { data: null, error: { message: 'boom' } } : { data: null, error: null }); return q } }) }
    expect(await uniqueEventSlug(db, 'x')).toBe('x-2')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/event-slug.test.js`
Expected: FAIL, "Failed to resolve import './event-slug'".

- [ ] **Step 3: Write the helper**

```js
// EVENT-SLUG.1 — an event's public URL reads as place, date and time:
//   /event/hatch-oct18-1100
//
// Derived at creation on both create paths (staff `POST /api/events`,
// host `POST /api/host/events`) and re-derived on host edits until the
// event is published, after which it freezes (links are out). Pure
// except `uniqueEventSlug`, which takes the db for the clash probe.
//
// Slugs are globally unique (mig 451) and matched exactly, case-sensitive,
// by every public resolver, so every token here is lowercase ASCII and the
// result always satisfies the route rule /^[a-z0-9]+(-[a-z0-9]+)*$/.

import { toSlug } from '@/lib/slug'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

export function placeToken(name) {
  const words = String(name || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\bun1t\b/gi, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w && w !== 'the')
  return words[0] || 'event'
}

export function dateToken(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDate || ''))
  if (!m) return null
  const month = Number(m[2])
  const day = Number(m[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${MONTHS[month - 1]}${day}`
}

export function timeToken(time) {
  const m = /^(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(String(time || ''))
  if (!m) return null
  if (Number(m[1]) > 23 || Number(m[2]) > 59) return null
  return `${m[1]}${m[2]}`
}

export function eventSlug({ place, date, time, times, name } = {}) {
  const candidates = (Array.isArray(times) ? times : [time]).map(timeToken).filter(Boolean).sort()
  const d = dateToken(date)
  const t = candidates[0] || null
  if (d && t) return `${placeToken(place)}-${d}-${t}`
  return toSlug(name) || 'event'
}

export function shouldRederiveSlug(status) {
  return status === 'draft' || status === 'rejected' || status === 'pending_review'
}

export async function uniqueEventSlug(db, base, { excludeId = null } = {}) {
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`
    let q = db.from('race_events').select('id').eq('slug', candidate)
    if (excludeId) q = q.neq('id', excludeId)
    // .maybeSingle(): 0 rows is the answer we want; slug is unique (mig 451).
    const { data, error } = await q.maybeSingle()
    if (!error && !data) return candidate
  }
  return `${base}-${Date.now()}`
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/event-slug.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/event-slug.js src/lib/event-slug.test.js
git commit -m "EVENT-SLUG.1 — eventSlug(): place-date-time slug helper with clash suffix and publish freeze"
```

---

### Task 2: Staff create path derives from studio + date + earliest wave

**Files:**
- Modify: `src/app/api/events/route.js` (import at ~line 26; slug block at ~lines 236-252)

- [ ] **Step 1: Replace the slug derivation**

Change `import { toSlug } from '@/lib/slug'` to `import { eventSlug, uniqueEventSlug } from '@/lib/event-slug'`.

Replace the block from `const slug = body.slug || toSlug(body.name)` through the `slugClash` 409 (and the `const db = createServerClient()` between them) with:

```js
  const db = createServerClient()

  // EVENT-SLUG.1 — the public URL reads as place-date-time
  // (/event/stillorgan-oct17-1030): studio name + race_date + the earliest
  // wave. An explicit body.slug still wins (and clashes 409 as before);
  // the derived one takes a -2/-3 suffix instead. lead_gen (no date, no
  // waves) falls back to the name-based slug exactly as before.
  let slug = body.slug || null
  if (!slug) {
    const { data: studio } = await db
      .from('locations')
      .select('name')
      .eq('id', body.location_id)
      .maybeSingle()
    const base = eventSlug({
      place: studio?.name,
      date: body.kind === 'lead_gen' ? null : body.race_date,
      times: (body.waves || []).map((w) => w.start_time),
      name: body.name,
    })
    slug = await uniqueEventSlug(db, base)
  } else {
    // HOST-APPROVALS.1 — slugs are globally unique (public /event/[slug] has
    // no location filter; mig 451 enforces it). Pre-check for a clean 409
    // instead of a raw constraint error.
    const { data: slugClash } = await db.from('race_events').select('id').eq('slug', slug).maybeSingle()
    if (slugClash) {
      return NextResponse.json({
        success: false,
        error: `The URL slug "${slug}" is already used by another event. Pick a different name or slug.`,
      }, { status: 409 })
    }
  }
```

There must be exactly one `const db = createServerClient()` in the handler afterwards.

- [ ] **Step 2: Gates**

Run: `npx eslint src/app/api/events/route.js && npm run check:select-columns && npx vitest run src/app/api/events`
Expected: clean; existing tests pass (update any that assert the old name-based slug).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/events/route.js
git commit -m "EVENT-SLUG.1 — POST /api/events derives the slug from studio, date and earliest wave"
```

---

### Task 3: Host create and host edit

**Files:**
- Modify: `src/app/api/host/events/route.js:57-62`
- Modify: `src/app/api/host/events/[id]/route.js` (PUT, the `race_events.update({...})` at ~line 60)
- Modify: `src/lib/host-events.js` (+ its test) if `deriveSlug` becomes unused

- [ ] **Step 1: Host create**

Import change:

```js
import { HostEventSchema, hostEventDefaults, ensureAnchorLocation } from '@/lib/host-events'
import { eventSlug, uniqueEventSlug } from '@/lib/event-slug'
```

Replace the `let slug = deriveSlug(input.name)` loop with:

```js
  // EVENT-SLUG.1 — /event/hatch-oct18-1100: venue + date + session time.
  // Globally unique (mig 451); a same-place-same-time clash takes -2, -3…
  const slug = await uniqueEventSlug(db, eventSlug({
    place: input.venue_name,
    date: input.race_date,
    time: input.session_start_time,
    name: input.name,
  }))
```

- [ ] **Step 2: Host edit re-derives until published**

Add `import { eventSlug, uniqueEventSlug, shouldRederiveSlug } from '@/lib/event-slug'`. Before the `race_events.update({` call:

```js
  // EVENT-SLUG.1 — a draft's URL follows its venue/date/time; once
  // published the slug is frozen (the link may be out).
  const slugPatch = shouldRederiveSlug(current.status)
    ? { slug: await uniqueEventSlug(db, eventSlug({ place: input.venue_name, date: input.race_date, time: input.session_start_time, name: input.name }), { excludeId: current.id }) }
    : {}
```

and `...slugPatch,` as the first entry of the update object.

- [ ] **Step 3: Drop `deriveSlug` if unused**

`grep -rn "deriveSlug" src shared | grep -v test` → if only its definition remains, delete it from `src/lib/host-events.js` and its import + cases from `src/lib/host-events.test.js`.

- [ ] **Step 4: Gates**

Run: `npx vitest run src/lib/host-events.test.js src/app/api/host && npx eslint 'src/app/api/host/events' src/lib/host-events.js && npm run check:select-columns && npm run check:route-guards && npm run check:location-scoping`

- [ ] **Step 5: Commit**

```bash
git add src/app/api/host/events/route.js 'src/app/api/host/events/[id]/route.js' src/lib/host-events.js src/lib/host-events.test.js
git commit -m "EVENT-SLUG.1 — host events derive place-date-time slugs; drafts re-derive on edit, published freeze"
```

---

### Task 3b: Old slugs redirect (added 7 Oct after the sent-campaign finding)

**Files:**
- Create: `supabase/migrations/706_race_event_slug_aliases.sql` — `race_event_slug_aliases(old_slug pk, race_event_id fk cascade, created_at)`, RLS on, `revoke all … from anon, authenticated`.
- Modify: `src/lib/event-slug.js` — `uniqueEventSlug` also probes the alias table; new `redirectTargetForSlug(db, slug)` (null when live/unknown/failed, the live slug for an alias).
- Modify: `src/app/event/[slug]/page.js` — `const target = await redirectTargetForSlug(createServerClient(), params.slug); if (target) redirect(\`/event/${target}\`)` before render.
- Test: `src/lib/event-slug.test.js` — alias counts as taken; redirect cases (live wins, alias → live, unknown, orphan alias, lookup failure).

- [x] Done; gates green (`vitest`, eslint, `check:select-columns`, `check:location-scoping`, `check:rls-restrictive`, `tests/table-default-acl-guard.test.js`).

### Task 4: CI mirror, build, PR

- [ ] **Step 1:** full thirteen-command CI mirror from CLAUDE.md, all exit 0.
- [ ] **Step 2:** `npm run build` (new import), exit 0.
- [ ] **Step 3:** `git push -u origin HEAD && gh pr create --base main`, then add `docs/changelog/entries/<PR>.md` (one row keyed `#<PR>`, shape per that folder's README), push, merge when **Test & lint** and **Next build** are green.

---

### Task 5: Data fix (after the PR deploys)

Run SQL through the Supabase MCP on project `iyvtbjjxdggiadzwwvdj`, one call per block (a `begin;` without `commit;` in the same call rolls back).

- [ ] **Step 1: Check nothing references the old slugs** — landing-page blocks, campaign and host-campaign bodies (confirm table/column names in `information_schema.columns` first). Any hit gets rewritten in the same transaction as Step 2.

- [ ] **Step 2: Rename, in one transaction**

```sql
begin;
update race_waves set start_time = '11:00'
  where race_event_id = (select id from race_events where slug = 'pride-training-club-10-30am') and start_time = '23:00';
create temp table ren(old_slug text, new_slug text) on commit drop;
insert into ren values
  ('hyrox-sim-october', 'stillorgan-oct17-1030'),
  ('pride-training-club-5', 'hatch-oct18-1100'),
  ('pride-training-club-4', 'hatch-oct18-1230'),
  ('pride-training-club-10-30am', 'hatch-oct25-1100'),
  ('pride-training-club-beginner-workout', 'hatch-oct25-1230'),
  ('ptc-at-x-saint-studio', 'saint-nov20-1835'),
  ('pride-training-club-6', 'stillorgan-nov22-1230'),
  ('pride-training-club-7', 'stillorgan-nov22-1345'),
  ('pride-training-club-christmas-edition-10-30', 'hatch-dec5-1030'),
  ('pride-training-club-12-30pm', 'stillorgan-dec20-1230')
;
insert into race_event_slug_aliases (old_slug, race_event_id)
  select r.old_slug, e.id from ren r join race_events e on e.slug = r.old_slug;
update race_events e set slug = r.new_slug from ren r where e.slug = r.old_slug;
update host_campaigns set body_html = replace(body_html, '/event/pride-training-club-5', '/event/hatch-oct18-1100'),
  design_json = replace(design_json::text, '/event/pride-training-club-5', '/event/hatch-oct18-1100')::jsonb
  where id = '2c015b2e-66dc-4acd-a0bd-8f2222de23b5' and status = 'draft';
update campaigns set html_content = replace(html_content, '/event/pride-training-club-4', '/event/hatch-oct18-1230')
  where id = '96b951df-ea1d-43e8-a96d-44c21a994c35' and status = 'draft';
select slug, race_date, (select min(start_time) from race_waves w where w.race_event_id = e.id) as t
  from race_events e where race_date >= current_date order by race_date, t;
commit;
```

Expected: 10 events + 1 wave updated, 10 alias rows, 2 draft bodies rewritten; the select lists the ten new slugs.

- [ ] **Step 3: Verify** each `https://crm.repset.ie/api/public/events/<slug>` returns 200 (curl loop over the ten), `curl -sI https://crm.repset.ie/event/pride-training-club-4` answers 307 to `/event/hatch-oct18-1230`, and open one `/event/<slug>` page in the browser.

- [ ] **Step 4: Report** the new URLs to Richard as a table, noting the 23:00 → 11:00 wave fix.
