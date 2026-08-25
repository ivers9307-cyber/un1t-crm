# Per-event comms location — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each event an explicit "send comms from" UN1T location that drives both its Twilio (SMS) and email sender identity, defaulting to the org master location, so hosted events (which sit on a sender-less anchor location) stop resolving comms identity from the anchor.

**Architecture:** Add a nullable `race_events.sending_location_id` column. A single resolver (`resolveEventCommsLocation`) returns the real location a send should use: explicit override → host event's org master (`resolveMasterLocationId`, mig 464) → the event's own `location_id`. Both SMS paths and both email paths route through it. A staff-only picker on the admin event form supplies the default. No backfill; the resolver handles NULL.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role routes), Zod, Vitest. Migrations applied via Supabase MCP against project `iyvtbjjxdggiadzwwvdj`.

**Spec:** `docs/superpowers/specs/2026-08-18-event-comms-location-design.md`

**Branch:** `event-comms-location` (already created off `origin/main`).

---

### Task 1: Migration — `race_events.sending_location_id`

**Files:**
- Create: `supabase/migrations/553_race_event_sending_location.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- 553 — per-event comms location. The real UN1T location whose Twilio + email
-- identity an event's outbound comms (confirmation/payment SMS, confirmation/
-- reminder email) use. NULL is resolved at send time by resolveEventCommsLocation
-- (host event → org master_location_id → anchor; normal event → location_id), so
-- no backfill is needed. ON DELETE SET NULL falls back to that resolver.
ALTER TABLE public.race_events
  ADD COLUMN IF NOT EXISTS sending_location_id uuid NULL
    REFERENCES public.locations(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.race_events.sending_location_id IS
  'EVENT-COMMS-LOC (mig 553) — real UN1T location whose Twilio + email identity this event''s outbound comms use. NULL → resolved at send time (host event → org master_location_id → anchor; normal event → location_id).';
```

- [ ] **Step 2: Apply via Supabase MCP**

Call `apply_migration` with `project_id: "iyvtbjjxdggiadzwwvdj"`, `name: "race_event_sending_location"`, and the SQL above. Confirm the project ref via `list_projects` first (must be `un1t-crm`, NOT sentinel `tpttqakxmyxrwnqjepfm`).

- [ ] **Step 3: Verify + advisor**

Run `execute_sql` on `iyvtbjjxdggiadzwwvdj`:
```sql
select column_name, data_type, is_nullable from information_schema.columns
where table_schema='public' and table_name='race_events' and column_name='sending_location_id';
```
Expected: one row, `uuid`, `YES`. Then `get_advisors` (type `security`) — expect no NEW findings referencing `race_events` (pre-existing INFO/WARN unrelated).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/553_race_event_sending_location.sql
git commit -m "EVENT-COMMS-LOC — mig 553: race_events.sending_location_id"
```

---

### Task 2: The resolver (`resolveEventCommsLocation` + pure `pickCommsLocationTarget`)

**Files:**
- Create: `src/lib/event-comms-location.js`
- Test: `src/lib/event-comms-location.test.js`

- [ ] **Step 1: Write the failing test (pure picker)**

```js
// src/lib/event-comms-location.test.js
import { describe, it, expect } from 'vitest'
import { pickCommsLocationTarget } from './event-comms-location'

describe('pickCommsLocationTarget', () => {
  it('uses the explicit override when set (wins over everything)', () => {
    expect(pickCommsLocationTarget(
      { sending_location_id: 'L1', host_id: 'h', location_id: 'anchor' }, 'MASTER',
    )).toBe('L1')
  })

  it('uses the org master for a host event with no override', () => {
    expect(pickCommsLocationTarget(
      { host_id: 'h', location_id: 'anchor' }, 'MASTER',
    )).toBe('MASTER')
  })

  it('falls back to the event location (anchor) when a host event has no master', () => {
    expect(pickCommsLocationTarget(
      { host_id: 'h', location_id: 'anchor' }, null,
    )).toBe('anchor')
  })

  it('uses the event location for a normal (non-host) event', () => {
    expect(pickCommsLocationTarget(
      { location_id: 'L2' }, null,
    )).toBe('L2')
  })

  it('returns null for a null event', () => {
    expect(pickCommsLocationTarget(null, 'MASTER')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/event-comms-location.test.js`
Expected: FAIL — `pickCommsLocationTarget is not a function`.

- [ ] **Step 3: Write the module (pure picker + async wrapper)**

```js
// src/lib/event-comms-location.js
//
// Resolve the real UN1T location whose Twilio + email identity an event's
// outbound comms should use. Hosted events sit on a sender-less per-host anchor
// location; this returns the org master (or an explicit per-event override)
// instead, so BOTH sms (sendLocationSms) and email (resolveEmailSender) send
// from a real location. See spec 2026-08-18-event-comms-location-design.md.

import { resolveMasterLocationId } from './host-events'
import { overlayConnections } from './connection-registry'

/**
 * Pure tier logic: which location id an event's comms should use.
 * override → host event's org master → the event's own location.
 * @param {{ sending_location_id?: string|null, host_id?: string|null, location_id?: string|null }|null} event
 * @param {string|null} masterLocationId
 * @returns {string|null}
 */
export function pickCommsLocationTarget(event, masterLocationId) {
  if (!event) return null
  if (event.sending_location_id) return event.sending_location_id
  if (event.host_id) return masterLocationId || event.location_id || null
  return event.location_id || null
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} db  service-role client
 * @param {{ sending_location_id?: string|null, host_id?: string|null, location_id?: string|null }|null} event
 * @returns {Promise<object|null>} the location row to send from (twilio_sender overlaid), or null
 */
export async function resolveEventCommsLocation(db, event) {
  if (!event) return null

  let masterLocationId = null
  if (!event.sending_location_id && event.host_id && event.location_id) {
    // Host event, no override → the org master. Derive the org from the event's
    // (anchor) location, then resolveMasterLocationId (falls back to the anchor
    // when no master is configured — never a wrong location).
    const { data: anchor } = await db
      .from('locations')
      .select('organization_id')
      .eq('id', event.location_id)
      .maybeSingle()
    masterLocationId = await resolveMasterLocationId(db, {
      organization_id: anchor?.organization_id || null,
      anchor_location_id: event.location_id,
    })
  }

  const targetId = pickCommsLocationTarget(event, masterLocationId)
  if (!targetId) return null

  const { data: row } = await db
    .from('locations')
    .select('id, name, twilio_alpha_sender_id, organization_id')
    .eq('id', targetId)
    .maybeSingle()
  if (!row) return null

  // INTEG-A2 dual-read: registry twilio_sender row first (matches send paths).
  return overlayConnections(db, row, ['twilio_sender'])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/event-comms-location.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/event-comms-location.js src/lib/event-comms-location.test.js
git commit -m "EVENT-COMMS-LOC — resolveEventCommsLocation + pure pickCommsLocationTarget"
```

---

### Task 3: SMS confirmation + confirmation email → comms location (`race-confirmations.js`)

**Files:**
- Modify: `src/lib/race-confirmations.js`

Read the current file first. The race select is in `sendRaceConfirmations` (the `race:race_event_id ( … )` block); `sendEmail` passes `locationId: payment.race?.location_id`; `sendSms` builds `senderLocation` via `resolveSenderLocation`.

- [ ] **Step 1: Add `host_id, sending_location_id` to the race select**

In the `race:race_event_id ( … )` select block, add the two fields (they gate the resolver):
```
      race:race_event_id (
        id, name, slug, race_date, location_id, host_id, sending_location_id,
        venue_name, venue_address,
        accent_hex, hero_image_url,
        confirmation_email_subject, confirmation_email_intro, confirmation_email_template_id,
        confirmation_sms_enabled,
        locations:location_id ( id, name, twilio_alpha_sender_id, organization_id )
      ),
```

- [ ] **Step 2: Import the resolver + resolve once in the orchestrator**

At the top imports, add:
```js
import { resolveEventCommsLocation } from './event-comms-location'
```
In `sendRaceConfirmations`, immediately AFTER the existing `overlayConnections` block that overlays `payment.race.locations`, add:
```js
  // EVENT-COMMS-LOC — the real location whose SMS + email identity this event's
  // comms use (host events resolve off their org master, not the sender-less
  // anchor). Falls back to the embedded location when unresolved.
  const commsLocation = await resolveEventCommsLocation(db, {
    location_id: payment.race?.location_id,
    host_id: payment.race?.host_id,
    sending_location_id: payment.race?.sending_location_id,
  })
  const commsLocationId = commsLocation?.id || payment.race?.location_id || null
```

- [ ] **Step 3: Pass `commsLocation`/`commsLocationId` into the send helpers**

Change the `sendEmail(...)` call to pass `commsLocationId` and the `sendSms(...)` call to pass `commsLocation`:
```js
      if (channel === 'email') outcome = await sendEmail({ db, payment, ctx, commsLocationId })
      else if (channel === 'sms') outcome = await sendSms({ db, payment, location, ctx, commsLocation })
```
> Note: the race-confirmations orchestrator does not use the same `channel` loop as booking-confirmations — locate the existing `sendEmail(...)` and `sendSms(...)` call sites and add the new arg to each. Do NOT change their other args.

- [ ] **Step 4: Use the comms location inside the helpers**

In `sendEmail`, change the `sendTransactionalEmail({ … locationId: … })` line to:
```js
      locationId: commsLocationId,
```
In `sendSms`, change the sender-resolution line to prefer the comms location, keeping `resolveSenderLocation` as the inner safety net:
```js
  const senderLocation = await resolveSenderLocation(db, commsLocation || location)
```

- [ ] **Step 5: Run the existing suite for this module + build**

Run: `npx vitest run src/lib/race-confirmations.test.js src/lib/event-email.test.js`
Expected: PASS (behaviour-preserving for non-host events; email characterization tests still green).
Run: `npm run build`
Expected: compiles (new import resolves).

- [ ] **Step 6: Commit**

```bash
git add src/lib/race-confirmations.js
git commit -m "EVENT-COMMS-LOC — race confirmation SMS + email use the comms location"
```

---

### Task 4: Payment-link SMS → comms location (`payment-sms` route)

**Files:**
- Modify: `src/app/api/registrations/[id]/payment-sms/route.js`

- [ ] **Step 1: Add `host_id, sending_location_id` to the race select**

In the `race_events!inner ( … )` select, add the fields:
```
      race_events!inner (
        id, name, location_id, host_id, sending_location_id,
        locations:location_id ( id, name, twilio_alpha_sender_id, organization_id )
      )
```

- [ ] **Step 2: Import the resolver**

```js
import { resolveEventCommsLocation } from '@/lib/event-comms-location'
```

- [ ] **Step 3: Resolve the comms location before sending**

Replace the current `resolveSenderLocation` line (added in #1448) with:
```js
  // EVENT-COMMS-LOC — send the payment link from the event's comms location
  // (host events → org master, not the sender-less anchor).
  const commsLocation = await resolveEventCommsLocation(db, {
    location_id: reg.race_events.location_id,
    host_id: reg.race_events.host_id,
    sending_location_id: reg.race_events.sending_location_id,
  })
  const senderLocation = await resolveSenderLocation(db, commsLocation || reg.race_events.locations)
```
(`sendLocationSms({ location: senderLocation, … })` is unchanged.)

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/registrations/[id]/payment-sms/route.js"
git commit -m "EVENT-COMMS-LOC — payment-link SMS uses the comms location"
```

---

### Task 5: Reminder email → comms location (`event-attendee-reminders.js`)

**Files:**
- Modify: `src/lib/event-attendee-reminders.js`

Current: `runEventReminders` selects `race_events` (`id, name, slug, race_date, start_time, location_id, kind, active, …`); `sendReminderEmail` passes `locationId: ev.location_id`.

- [ ] **Step 1: Add `host_id, sending_location_id` to the race_events select**

Add both fields to the `.select(...)` on `race_events` in `runEventReminders`.

- [ ] **Step 2: Import the resolver + resolve per event**

```js
import { resolveEventCommsLocation } from '@/lib/event-comms-location'
```
In the per-event loop of `runEventReminders`, after `const locationName = …`, add:
```js
    const commsLocation = await resolveEventCommsLocation(db, {
      location_id: ev.location_id, host_id: ev.host_id, sending_location_id: ev.sending_location_id,
    })
    const commsLocationId = commsLocation?.id || ev.location_id || null
```
Thread `commsLocationId` into the `sendReminderEmail({ … })` call (add the arg).

- [ ] **Step 3: Use it in `sendReminderEmail`**

Change `locationId: ev.location_id || null` in the `sendTransactionalEmail({ … })` call to:
```js
    locationId: commsLocationId || null,
```
(Add `commsLocationId` to `sendReminderEmail`'s destructured args.)

- [ ] **Step 4: Run the module's tests**

Run: `npx vitest run src/lib/event-attendee-reminders.test.js`
Expected: PASS (reminder email tests unaffected — same shell, only the from-location id changes).

- [ ] **Step 5: Commit**

```bash
git add src/lib/event-attendee-reminders.js
git commit -m "EVENT-COMMS-LOC — reminder email uses the comms location"
```

---

### Task 6: Create-route schema + persist + IDOR guard (`/api/events`)

**Files:**
- Modify: `src/app/api/events/route.js`
- Test: `src/app/api/events/route.test.js`

- [ ] **Step 1: Write the failing schema test**

Append to `src/app/api/events/route.test.js`:
```js
describe('events CreateSchema sending_location_id', () => {
  const base = {
    location_id: '00000000-0000-0000-0000-000000000001',
    name: 'Hyrox Sim', race_date: '2026-08-01', waves: [{ start_time: '09:00' }],
  }
  it('parses clean when omitted', () => {
    expect(CreateSchema.parse({ ...base }).sending_location_id).toBeUndefined()
  })
  it('accepts a uuid and null', () => {
    expect(CreateSchema.parse({ ...base, sending_location_id: '11111111-1111-1111-1111-111111111111' }).sending_location_id)
      .toBe('11111111-1111-1111-1111-111111111111')
    expect(CreateSchema.parse({ ...base, sending_location_id: null }).sending_location_id).toBeNull()
  })
  it('rejects a non-uuid', () => {
    expect(() => CreateSchema.parse({ ...base, sending_location_id: 'nope' })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/api/events/route.test.js`
Expected: FAIL on the accept/reject cases (field not in schema).

- [ ] **Step 3: Add the field to `CreateSchema` + insert + IDOR guard**

In `CreateSchema` (near the `confirmation_email_template_id` block):
```js
  // EVENT-COMMS-LOC (mig 553) — the real UN1T location this event's SMS + email
  // send from. In-org non-anchor validated below.
  sending_location_id: uuidLike.nullable().optional(),
```
In the `.insert({ … })` object (near the email-config fields):
```js
      sending_location_id: body.sending_location_id ?? null,
```
Add an IDOR guard next to the existing email-template guard (the id must be a real, active, in-`body.location_id`-org, non-anchor location). After resolving the event's org from `body.location_id`:
```js
  if (body.sending_location_id) {
    const { data: loc } = await db.from('locations')
      .select('organization_id').eq('id', body.location_id).single()
    const { data: send } = await db.from('locations')
      .select('id, organization_id, is_host_anchor')
      .eq('id', body.sending_location_id).maybeSingle()
    if (!loc || !send || send.is_host_anchor || send.organization_id !== loc.organization_id) {
      return NextResponse.json({ success: false, error: 'invalid_sending_location' }, { status: 400 })
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/api/events/route.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/events/route.js src/app/api/events/route.test.js
git commit -m "EVENT-COMMS-LOC — create route: sending_location_id + IDOR guard"
```

---

### Task 7: Update-route schema + loadRace + IDOR guard (`/api/events/[id]`)

**Files:**
- Modify: `src/app/api/events/[id]/route.js`
- Test: `src/app/api/events/[id]/route.test.js`

- [ ] **Step 1: Write the failing schema test**

Append to `src/app/api/events/[id]/route.test.js`:
```js
describe('events UpdateSchema sending_location_id', () => {
  it('parses clean when omitted', () => {
    expect(UpdateSchema.parse({ name: 'x' }).sending_location_id).toBeUndefined()
  })
  it('accepts a uuid and null', () => {
    expect(UpdateSchema.parse({ sending_location_id: '22222222-2222-2222-2222-222222222222' }).sending_location_id)
      .toBe('22222222-2222-2222-2222-222222222222')
    expect(UpdateSchema.parse({ sending_location_id: null }).sending_location_id).toBeNull()
  })
  it('rejects a non-uuid', () => {
    expect(() => UpdateSchema.parse({ sending_location_id: 'nope' })).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run "src/app/api/events/[id]/route.test.js"`
Expected: FAIL on accept/reject cases.

- [ ] **Step 3: Add field to `UpdateSchema`, `loadRace` select, + IDOR guard**

In `UpdateSchema` (near the email-config block):
```js
  // EVENT-COMMS-LOC (mig 553) — flows through the generic scalar patch; in-org
  // non-anchor validated in PUT.
  sending_location_id: uuidLike.nullable().optional(),
```
In `loadRace`'s `.select(...)` column list, add `sending_location_id,`.
In `PUT`, next to the email-template IDOR guard, validate against `existing.location_id`'s org:
```js
  if (body.sending_location_id) {
    const { data: loc } = await db.from('locations')
      .select('organization_id').eq('id', existing.location_id).single()
    const { data: send } = await db.from('locations')
      .select('id, organization_id, is_host_anchor')
      .eq('id', body.sending_location_id).maybeSingle()
    if (!loc || !send || send.is_host_anchor || send.organization_id !== loc.organization_id) {
      return NextResponse.json({ success: false, error: 'invalid_sending_location' }, { status: 400 })
    }
  }
```
(The value itself reaches the DB through the existing generic `updates = { ...body }` patch — no separate write needed.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run "src/app/api/events/[id]/route.test.js"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/events/[id]/route.js" "src/app/api/events/[id]/route.test.js"
git commit -m "EVENT-COMMS-LOC — update route: sending_location_id + loadRace + IDOR guard"
```

---

### Task 8: Admin form "Send comms from" picker (`RaceEventForm.jsx`)

**Files:**
- Modify: `src/components/RaceEventForm.jsx`

This form already fetches `emailTemplates` from `/api/templates?location_id=…` and posts the payload. The picker is shown only when the event is hosted (`hostId` truthy) — its location list is the real UN1T locations of the event's org, defaulting to the org master.

- [ ] **Step 1: Load the location options + master default**

Add a small server-backed list. Reuse the existing pattern that lists non-anchor locations. Add state near the other `useState`s:
```jsx
  const [sendingLocationId, setSendingLocationId] = useState(race?.sending_location_id || '')
  const [locationOptions, setLocationOptions] = useState([]) // {id,name,is_master}
```
Add a `useEffect` (mirroring the `emailTemplates` fetch) that GETs a locations list for the org and, when `sendingLocationId` is empty and it's a host event, pre-selects the master:
```jsx
  useEffect(() => {
    if (!locationId) return
    fetch(`/api/locations/sendable?event_location_id=${encodeURIComponent(locationId)}`)
      .then(r => r.json()).then(j => {
        const opts = j?.data || []
        setLocationOptions(opts)
        if (!sendingLocationId) {
          const master = opts.find(o => o.is_master)
          if (master) setSendingLocationId(master.id)
        }
      }).catch(() => {})
  }, [locationId]) // eslint-disable-line react-hooks/exhaustive-deps
```
> A tiny read-only route `GET /api/locations/sendable?event_location_id=…` returns `{ id, name, is_master }[]` — active, `is_host_anchor=false`, in the org of `event_location_id`, with `is_master = (id === organizations.master_location_id)`. Add it as Step 1b (session-guarded, `assertLocationAccess` on `event_location_id`). If a suitable existing endpoint already returns org locations, use it instead and compute `is_master` client-side from a field it returns.

- [ ] **Step 1b: Add the `GET /api/locations/sendable` route**

Create `src/app/api/locations/sendable/route.js`:
```js
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const eventLocationId = new URL(request.url).searchParams.get('event_location_id')
  if (!eventLocationId) return NextResponse.json({ success: true, data: [] })
  const guard = assertLocationAccess(user, eventLocationId)
  if (guard) return guard

  const db = createServerClient()
  const { data: anchor } = await db.from('locations')
    .select('organization_id').eq('id', eventLocationId).maybeSingle()
  if (!anchor?.organization_id) return NextResponse.json({ success: true, data: [] })
  const [{ data: org }, { data: locs }] = await Promise.all([
    db.from('organizations').select('master_location_id').eq('id', anchor.organization_id).maybeSingle(),
    db.from('locations').select('id, name')
      .eq('organization_id', anchor.organization_id).eq('active', true).eq('is_host_anchor', false)
      .order('name'),
  ])
  const masterId = org?.master_location_id || null
  const data = (locs || []).map(l => ({ id: l.id, name: l.name, is_master: l.id === masterId }))
  return NextResponse.json({ success: true, data })
}
```
> `assertLocationAccess` on the anchor id is correct — a manager of the event's location may edit it. Register nothing extra; `check:route-guards` sees `getCurrentUser`.

- [ ] **Step 2: Render the dropdown (host events only)**

In the JSX, inside the confirmation/comms area and gated on the host flag the form already tracks (e.g. `hostId`), render:
```jsx
{hostId && (
  <div>
    <label className="block text-sm mb-1.5">Send comms from</label>
    <select
      value={sendingLocationId}
      onChange={e => setSendingLocationId(e.target.value)}
      className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
    >
      {locationOptions.map(o => (
        <option key={o.id} value={o.id}>{o.name}{o.is_master ? ' (default)' : ''}</option>
      ))}
    </select>
    <p className="text-[11px] text-un1t-subtle mt-1">
      Which UN1T location&apos;s Twilio sender + email identity this event&apos;s texts and emails use.
    </p>
  </div>
)}
```

- [ ] **Step 3: Add to the save payload**

In the `payload` object, add:
```js
      sending_location_id: sendingLocationId || null,
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles.
> No unit test: this is presentation, and local dev has no DB so the authed form can't be exercised locally (see `local-dev-login`). Behaviour is covered by the schema tests (Tasks 6–7) + the resolver (Task 2).

- [ ] **Step 5: Commit**

```bash
git add src/components/RaceEventForm.jsx src/app/api/locations/sendable/route.js
git commit -m "EVENT-COMMS-LOC — admin form: Send comms from picker + sendable-locations route"
```

---

### Task 9: Full CI mirror, build, PR

- [ ] **Step 1: Run the CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql
```
Expected: all pass, 0 lint errors. `check:route-guards` must still pass (the new `/api/locations/sendable` route is `getCurrentUser`-guarded).

- [ ] **Step 2: Production build**

```bash
npm run build
```
Expected: compiles clean.

- [ ] **Step 3: CHANGELOG entry**

Add a row `#538 EVENT-COMMS-LOC` at the top of the `docs/CHANGELOG.md` "Done" table summarizing the feature + mig 553 + resolver + the four comms paths + the picker.

- [ ] **Step 4: Commit + push + PR**

```bash
git add docs/CHANGELOG.md
git commit -m "docs: CHANGELOG #538 — EVENT-COMMS-LOC"
git push -u origin HEAD
gh pr create --base main --fill
```
Report the PR URL. Do NOT merge — leave for review (main auto-deploys on merge).

---

## Self-review

- **Spec coverage:** data model → T1; resolver (pure + wrapper) → T2; SMS confirmation → T3; payment SMS → T4; email confirmation → T3; email reminder → T5; create schema/persist/IDOR → T6; update schema/loadRace/IDOR → T7; picker + default → T8; rollout (migration-first, no backfill) → T1/T9. No spec requirement left unassigned.
- **Placeholder scan:** none — every code step carries full code; the one "locate the existing call site" note (T3 S3) is a real instruction, not a placeholder, because that orchestrator's shape must be read live.
- **Type consistency:** `resolveEventCommsLocation(db, event)` and `pickCommsLocationTarget(event, masterLocationId)` are used with those exact signatures in T2–T5; `sending_location_id` (snake_case) is the column/schema/payload name throughout; `commsLocation` (row) vs `commsLocationId` (id) used consistently — row → `sendLocationSms`/`resolveSenderLocation`, id → `sendTransactionalEmail`/`locationId`.
- **Rollout note:** email identity changes live on deploy (host emails move to the master location's identity); SMS is latent (event SMS off via #1445). Verify Stillorgan has a `tenant_email_domains` row before deploy, else email stays on the global default (unchanged).
