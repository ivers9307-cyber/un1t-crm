# `/start` Booking Wizard — Phase 2 (Class path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Let a `/start` lead book a real Glofox **class**. The page enqueues instantly; a per-minute cron creates/links the Glofox account, books the class (or routes to staff review if they've attended before / on any failure), and sends a WhatsApp confirmation.

**Architecture:** Public `GET /api/public/classes` lists live Glofox classes. Public `POST /api/public/class-booking` captures the lead in the CRM (contact + `new_lead` deal + `lead_source`/tag) and enqueues a `class_booking_requests` row, returning instantly. The `process-class-bookings` cron drains the queue through a pure-ish decision lib. Confirmation reuses Phase 1's `maybeSendBookingWhatsappConfirm`. Review/failures land in the existing `agent_membership_requests` + `/approvals`.

**Branch:** `start-booking-wizard` (same as Phase 1 / PR #709). **Migration `class_booking_requests_queue` is ALREADY APPLIED** (table + indexes + `update_updated_at` trigger + RLS + the `process-class-bookings` cron_heartbeats row).

**Glofox integration (verified signatures — from `src/lib/glofox.js`, `glofox-push.js`, `booking-tools.js`):**
- `glofoxCredentialsForLocation(db, locationId)` → `{branchId, apiKey, apiToken, namespace, webhookSecret}`. Missing-check: `missingGlofoxCredentialsForLocation(creds)` → string[].
- `fetchUpcomingEvents(creds, { start, end, limit })` → `{ ok, events }` (events from Glofox `/2.0/events`; fields incl. `_id, name, time_start, duration, size, booked, active, private`).
- `shapeClassListForAgent(events, nowMs, limit)` → `[{event_id, name, time, spots_left, full}]` (filters active/non-private/future).
- `findOrCreateGlofoxMember({db, locationId, contact, source, createIfMissing, attachTrial})` → `{status, glofox_member_id, passcode?, error}`; status ∈ skipped|linked|needs_review|failed|created. `createIfMissing` creates via `/2.0/register`; `attachTrial` purchases the location's trial membership (`locations.settings.glofox.trial_membership_id` + `trial_plan_code`) — grants class credits when the membership is a class-pack.
- `createBooking(creds, { user_id, model: GLOFOX_BOOKING_MODEL, model_id })` → `{ ok, status, body }`; `GLOFOX_BOOKING_MODEL === 'event'`, `user_id` = glofox_member_id, `model_id` = the class `event_id`. Failure → `body.message_code`.
- `fetchUserCredits(creds, userId)` → `Credit[]`; `computeCreditsRemaining(credits)` (from `@/lib/glofox-sync`) → integer | null.
- "Attended before" signal: **`contacts.last_attended_at IS NOT NULL`** (advance-only, sync-maintained; null for a brand-new lead).
- Approval→book: `PATCH /api/agent/membership-requests/[id]` with `status:'approved'` on a `kind:'class_booking'` `pending` row **already calls `createBooking`** + in-thread confirm. We reuse it by inserting a `pending` row.
- Cron pattern: `src/app/api/cron/run-sequences/route.js` (CRON_SECRET bearer check + `stampHeartbeat(name)` on success) + `vercel.json` crons array.

---

## File Structure
- **Create** `src/app/api/public/classes/route.js` — `GET`: Stillorgan's live class list, UI-shaped (day + time + spots).
- **Create** `src/lib/public-classes.js` — `listPublicClasses(db, locationId, days)` (resolve creds → fetch → shape for UI) + test.
- **Create** `src/app/api/public/class-booking/route.js` — `POST`: validate, capture lead, enqueue.
- **Create** `src/lib/class-booking-processor.js` — `processClassBookingRequest(db, request)` decision tree + `routeClassBookingToReview(...)` + test.
- **Create** `src/app/api/cron/process-class-bookings/route.js` — drain cron.
- **Modify** `vercel.json` — add the cron entry.
- **Modify** `src/components/StartFunnel.jsx` — enable the class branch (fetch classes → day/time picker → enqueue).

---

## Task 1: Public class list (lib + endpoint)

**Files:** Create `src/lib/public-classes.js` (+ `.test.js`), `src/app/api/public/classes/route.js`

- [ ] **Step 1: Failing test** `src/lib/public-classes.test.js`

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  fetchUpcomingEvents: vi.fn(async () => ({ ok: true, events: [
    { _id: 'e1', name: 'S&C', time_start: 4102444800, duration: 60, size: 12, booked: 4, active: true, private: false },
  ] })),
}))
import { shapePublicClass } from './public-classes'

beforeEach(() => vi.clearAllMocks())
describe('shapePublicClass', () => {
  it('maps a glofox event to the UI shape with Dublin day + time', () => {
    const c = shapePublicClass({ _id: 'e1', name: 'S&C', time_start: 1751959800, size: 12, booked: 4 })
    expect(c.event_id).toBe('e1')
    expect(c.name).toBe('S&C')
    expect(c.spots_left).toBe(8)
    expect(c.full).toBe(false)
    expect(typeof c.day).toBe('string')       // YYYY-MM-DD (Europe/Dublin)
    expect(/^\d{2}:\d{2}$/.test(c.time)).toBe(true)
  })
  it('marks full when no spots', () => {
    expect(shapePublicClass({ _id: 'e', name: 'x', time_start: 1751959800, size: 5, booked: 5 }).full).toBe(true)
  })
})
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/lib/public-classes.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement** `src/lib/public-classes.js`

```javascript
// Public class listing for the /start wizard. Reuses the Glofox event fetch
// the agent uses, but shapes each class with a structured day (YYYY-MM-DD,
// Europe/Dublin) + HH:MM time so the UI can group by day. No auth — display-
// safe class data only (name/time/spots), same as the agent's class list.
import { glofoxCredentialsForLocation, missingGlofoxCredentialsForLocation, fetchUpcomingEvents } from '@/lib/glofox'

const DUBLIN = 'Europe/Dublin'
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: DUBLIN, year: 'numeric', month: '2-digit', day: '2-digit' })
const timeFmt = new Intl.DateTimeFormat('en-GB', { timeZone: DUBLIN, hour: '2-digit', minute: '2-digit', hour12: false })
const labelFmt = new Intl.DateTimeFormat('en-IE', { timeZone: DUBLIN, weekday: 'short', day: 'numeric', month: 'short' })

export function shapePublicClass(e) {
  const startSec = Number(e.time_start) || 0
  const ms = startSec * 1000
  const size = Number(e.size) || 0
  const booked = Number(e.booked) || 0
  const spots = Math.max(0, size - booked)
  const d = new Date(ms)
  return {
    event_id: e._id || e.id,
    name: e.name || 'Class',
    starts_at: new Date(ms).toISOString(),
    day: dayFmt.format(d),          // YYYY-MM-DD
    day_label: labelFmt.format(d),  // "Tue 8 Jul"
    time: timeFmt.format(d),        // "18:30"
    spots_left: spots,
    full: size > 0 && spots === 0,
  }
}

// Resolve a location's live, bookable classes for the next `days` days.
export async function listPublicClasses(db, locationId, days = 7) {
  const creds = await glofoxCredentialsForLocation(db, locationId)
  if (missingGlofoxCredentialsForLocation(creds).length) return []
  const start = Math.floor(Date.now() / 1000)
  const end = start + Math.min(14, Math.max(1, days)) * 86400
  const { ok, events } = await fetchUpcomingEvents(creds, { start, end, limit: 100 })
  if (!ok || !Array.isArray(events)) return []
  const now = Date.now()
  return events
    .filter((e) => e && e.active !== false && e.private !== true && (Number(e.time_start) || 0) * 1000 > now)
    .map(shapePublicClass)
    .filter((c) => !c.full)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at))
}
```

- [ ] **Step 4: Run test → PASS.** Fix until green.

- [ ] **Step 5: Implement the endpoint** `src/app/api/public/classes/route.js`

```javascript
// GET /api/public/classes — live Glofox class list for the Stillorgan /start
// wizard. Public (display-safe data only); rate-limited. Stillorgan-scoped via
// the 'stillorgan' landing public_path so no arbitrary location can be queried.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { listPublicClasses } from '@/lib/public-classes'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const db = createServerClient()
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `pubclasses:${ip}`, { max: 30, windowMs: 5 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many requests. Please wait a moment.')

  try {
    const { data: page } = await db.from('landing_page_settings')
      .select('location_id').eq('public_path', 'stillorgan').maybeSingle()
    if (!page?.location_id) return NextResponse.json({ success: true, data: { classes: [] } })
    const classes = await listPublicClasses(db, page.location_id, 7)
    return NextResponse.json({ success: true, data: { classes } })
  } catch (e) {
    logWarn('public-classes', 'list failed', { err: e })
    return NextResponse.json({ success: true, data: { classes: [] } })
  }
}
```

- [ ] **Step 6: Commit** — `git add src/lib/public-classes.js src/lib/public-classes.test.js src/app/api/public/classes/route.js && git commit -m "feat(start): public Glofox class listing (lib + endpoint)"`

---

## Task 2: Enqueue endpoint (`POST /api/public/class-booking`)

**Files:** Create `src/app/api/public/class-booking/route.js`

Captures the lead in the CRM immediately (so the lead exists regardless of the async Glofox outcome) and enqueues. "Reclassify as fresh lead" = open a `new_lead` deal + stamp `lead_source`/tag, exactly like a fresh website lead.

- [ ] **Step 1: Implement** (no unit test — integration route; verified via the cron test + e2e)

```javascript
// POST /api/public/class-booking — public enqueue for the /start wizard's class
// path. Captures the lead in the CRM (contact + new_lead deal + lead_source +
// tag = "reclassify as a fresh lead") then enqueues a class_booking_requests
// row for the process-class-bookings cron. Returns instantly; the booking +
// WhatsApp confirmation happen async. No auth; rate-limited.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { findOrCreateRaceContact } from '@/lib/race-contact-linking'
import { writeContactTag } from '@/lib/contact-tags'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'

const Schema = z.object({
  event_id: z.string().trim().min(1).max(64),
  class_name: z.string().trim().max(200).optional(),
  starts_at: z.string().trim().max(40).optional(),
  first_name: z.string().trim().min(1).max(120),
  last_name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  phone: z.string().trim().min(1).max(50).refine((v) => v.replace(/\D/g, '').length >= 7, 'Enter a valid phone number'),
  consent: z.boolean().refine((v) => v === true, { message: 'Please tick consent to continue' }),
})

export async function POST(request) {
  const db = createServerClient()
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `classbook:${ip}`, { max: 8, windowMs: 15 * 60_000 })
  if (!limit.allowed) return rateLimitResponse(limit, 'Too many submissions. Please wait a few minutes.')

  const validation = await validateBody(request, Schema)
  if (!validation.ok) return validation.response
  const b = validation.data

  // Stillorgan-scoped (the /start funnel is Stillorgan only).
  const { data: page } = await db.from('landing_page_settings')
    .select('location_id').eq('public_path', 'stillorgan').maybeSingle()
  if (!page?.location_id) {
    return NextResponse.json({ success: false, error: 'Class booking is not available right now.' }, { status: 400 })
  }
  const locationId = page.location_id
  const name = `${b.first_name} ${b.last_name}`.trim()

  const contactId = await findOrCreateRaceContact({ db, locationId, email: b.email.toLowerCase(), name, phone: b.phone })
  if (!contactId) return NextResponse.json({ success: false, error: 'Could not capture your details. Please try again.' }, { status: 500 })

  // Attribute + "reclassify as a fresh lead" (new_lead deal). All best-effort.
  try { await db.from('contacts').update({ lead_source: 'meta_book' }).eq('id', contactId).is('lead_source', null) } catch (e) { logWarn('classbook', 'lead_source failed', { err: e }) }
  try { await writeContactTag(db, { contactId, locationId, tag: 'stillorgan-start' }) } catch (e) { logWarn('classbook', 'tag failed', { err: e }) }
  try {
    const { applyFormMarketingConsent } = await import('@/lib/marketing-consent')
    await applyFormMarketingConsent(db, { contactId, consent: true, source: 'start_class', ipAddress: ip })
  } catch (e) { logWarn('classbook', 'consent failed', { err: e }) }
  try {
    const { data: openDeal } = await db.from('deals').select('id').eq('contact_id', contactId).eq('status', 'open').maybeSingle()
    if (!openDeal) {
      const { data: stage } = await db.from('pipeline_stages').select('id').eq('location_id', locationId).eq('slug', 'new_lead').maybeSingle()
      if (stage) await db.from('deals').insert({ title: b.first_name || 'Class lead', contact_id: contactId, stage_id: stage.id, location_id: locationId, status: 'open' })
    }
  } catch (e) { logWarn('classbook', 'deal failed', { err: e }) }

  // Enqueue. The cron does the Glofox work + WhatsApp confirm.
  const { error: insErr } = await db.from('class_booking_requests').insert({
    location_id: locationId, contact_id: contactId,
    glofox_event_id: b.event_id, class_name: b.class_name || null,
    starts_at: b.starts_at || null,
    customer_name: name, customer_email: b.email.toLowerCase(), customer_phone: b.phone,
    status: 'queued',
  })
  if (insErr) {
    logWarn('classbook', 'enqueue failed', { err: insErr })
    return NextResponse.json({ success: false, error: 'Could not start your booking. Please try again.' }, { status: 500 })
  }
  return NextResponse.json({ success: true, data: { queued: true } })
}
```

- [ ] **Step 2: Verify** — `npx eslint src/app/api/public/class-booking/route.js` (0 errors). Do NOT next build (CI handles it).
- [ ] **Step 3: Commit** — `git add src/app/api/public/class-booking/route.js && git commit -m "feat(start): class-booking enqueue endpoint (CRM capture + queue)"`

---

## Task 3: Decision-tree processor (the core)

**Files:** Create `src/lib/class-booking-processor.js` (+ `.test.js`)

Read `src/lib/glofox-push.js` (`findOrCreateGlofoxMember`, `purchaseGlofoxMembership` if exported, `getLocationTrialConfig`) and `src/lib/glofox.js` (`createBooking`, `GLOFOX_BOOKING_MODEL`, `fetchUserCredits`) before implementing, to wire the exact calls.

**Decision tree** for one `class_booking_requests` row:
1. Resolve creds; missing → mark `failed`.
2. Load the contact (`first_name, name, email, phone, wa_phone, glofox_member_id, last_attended_at`). Missing → `failed`.
3. **`last_attended_at != null` → route to review** (insert `agent_membership_requests` `kind='class_booking'` `status='pending'`; set request `needs_review` + `approval_request_id`). Stop.
4. Never attended → ensure a Glofox account with a class credit:
   - No `glofox_member_id` → `findOrCreateGlofoxMember({createIfMissing:true, attachTrial:true})`; on `failed`/no id → route to review (`account_failed`). Treat `status==='created'` as trial-granted.
   - Have a member id (or just got one): read live credits via `fetchUserCredits` + `computeCreditsRemaining`. If `<= 0` and we did NOT just grant a trial → grant the trial now (the existing-account-no-credits case: the operator's call is "grant the trial and book") via the same membership-purchase the `attachTrial` path uses; best-effort.
5. `createBooking(creds, { user_id: memberId, model: GLOFOX_BOOKING_MODEL, model_id: request.glofox_event_id })`.
   - `ok` → mark request `booked`; send WhatsApp `booking_class_confirmed` via `maybeSendBookingWhatsappConfirm` with `bodyParams=[firstName, className, classTimeLabel]` (classTimeLabel from `fmtBookingTime`-style Dublin format of `starts_at`, or the stored label).
   - not `ok` → route to review (`booking_failed:<message_code>`).

- [ ] **Step 1: Failing test** `src/lib/class-booking-processor.test.js` — cover: (a) prior-attendance → review + no booking; (b) brand-new → create+book+confirm; (c) booking failure → review. Mock `@/lib/glofox`, `@/lib/glofox-push`, `@/lib/glofox-sync`, `@/lib/automations/booking-whatsapp-confirm`, and a chainable `db`.

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/glofox', () => ({
  glofoxCredentialsForLocation: vi.fn(async () => ({ branchId: 'b', apiKey: 'k', apiToken: 't' })),
  missingGlofoxCredentialsForLocation: vi.fn(() => []),
  createBooking: vi.fn(async () => ({ ok: true, status: 200, body: {} })),
  fetchUserCredits: vi.fn(async () => [{ active: true, available: 3 }]),
  GLOFOX_BOOKING_MODEL: 'event',
}))
vi.mock('@/lib/glofox-sync', () => ({ computeCreditsRemaining: vi.fn(() => 3) }))
vi.mock('@/lib/glofox-push', () => ({ findOrCreateGlofoxMember: vi.fn(async () => ({ status: 'created', glofox_member_id: 'gm1' })) }))
vi.mock('@/lib/automations/booking-whatsapp-confirm', () => ({ maybeSendBookingWhatsappConfirm: vi.fn(async () => ({ sent: true })) }))

import { processClassBookingRequest } from './class-booking-processor'
import { createBooking } from '@/lib/glofox'
import { maybeSendBookingWhatsappConfirm } from '@/lib/automations/booking-whatsapp-confirm'

// chainable db mock: records updates + inserts; returns a contact
function makeDb(contact) {
  const calls = { updates: [], inserts: [] }
  const api = {
    from(t) { this._t = t; return this },
    select() { return this }, eq() { return this }, is() { return this },
    maybeSingle: async () => ({ data: contact }),
    update(v) { calls.updates.push({ t: api._t, v }); return { eq: () => ({ is: async () => ({}), then: undefined }) } },
    insert(v) { calls.inserts.push({ t: api._t, v }); return { select: () => ({ single: async () => ({ data: { id: 'amr1' } }) }), then: (r) => r({ error: null }) } },
  }
  return { api, calls }
}

beforeEach(() => vi.clearAllMocks())

describe('processClassBookingRequest', () => {
  const req = { id: 'r1', location_id: 'L', contact_id: 'c1', glofox_event_id: 'e1', class_name: 'S&C', starts_at: '2026-07-08T17:30:00.000Z' }

  it('routes prior-attendance leads to review, never books', async () => {
    const { api } = makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', last_attended_at: '2026-06-01T10:00:00Z' })
    const r = await processClassBookingRequest(api, req)
    expect(r.outcome).toBe('needs_review')
    expect(createBooking).not.toHaveBeenCalled()
  })

  it('brand-new lead: creates account, books, confirms', async () => {
    const { api } = makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: null, last_attended_at: null })
    const r = await processClassBookingRequest(api, req)
    expect(r.outcome).toBe('booked')
    expect(createBooking).toHaveBeenCalled()
    expect(maybeSendBookingWhatsappConfirm).toHaveBeenCalled()
  })

  it('booking failure → review', async () => {
    createBooking.mockResolvedValueOnce({ ok: false, status: 400, body: { message_code: 'EVENT_FULL' } })
    const { api } = makeDb({ id: 'c1', first_name: 'Sam', phone: '0871234567', glofox_member_id: 'gm1', last_attended_at: null })
    const r = await processClassBookingRequest(api, req)
    expect(r.outcome).toBe('needs_review')
  })
})
```

- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `src/lib/class-booking-processor.js` per the decision tree above (read the Glofox helpers first to match signatures exactly). Export `processClassBookingRequest(db, request)` returning `{ outcome: 'booked'|'needs_review'|'failed', detail? }`. Mark the `class_booking_requests` row status accordingly (`booked`/`needs_review`/`failed`, set `last_error`/`glofox_booking_id`/`approval_request_id`, bump `attempts`). For review, insert the `agent_membership_requests` row (`kind:'class_booking'`, `status:'pending'`, `details:{ event_id: request.glofox_event_id, class_name: request.class_name, class_time: <label>, mode:'draft', source:'start_funnel' }`, `location_id`, `contact_id`). Format the class time label from `request.starts_at` in Europe/Dublin. Confirm WhatsApp send uses `maybeSendBookingWhatsappConfirm({ db, locationId: request.location_id, contact, templateName: 'booking_class_confirmed', bodyParams: [firstName, className, classLabel] })`.
- [ ] **Step 4: Run → green.** Fix until 3/3 pass.
- [ ] **Step 5: Commit** — `git add src/lib/class-booking-processor.js src/lib/class-booking-processor.test.js && git commit -m "feat(start): class-booking decision-tree processor"`

---

## Task 4: Drain cron + vercel.json

**Files:** Create `src/app/api/cron/process-class-bookings/route.js`; Modify `vercel.json`

- [ ] **Step 1: Implement the cron**

```javascript
// Drains class_booking_requests: claims queued rows, runs each through the
// decision-tree processor, stamps the heartbeat. Bounded batch per run.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { processClassBookingRequest } from '@/lib/class-booking-processor'
import { logWarn } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const db = createServerClient()
  const stats = { processed: 0, booked: 0, review: 0, failed: 0 }
  try {
    const { data: rows } = await db.from('class_booking_requests')
      .select('*').eq('status', 'queued').order('created_at', { ascending: true }).limit(25)
    for (const row of rows || []) {
      // claim
      const { data: claimed } = await db.from('class_booking_requests')
        .update({ status: 'processing', attempts: (row.attempts || 0) + 1 })
        .eq('id', row.id).eq('status', 'queued').select('id').maybeSingle()
      if (!claimed) continue // lost the race
      stats.processed++
      try {
        const r = await processClassBookingRequest(db, row)
        if (r.outcome === 'booked') stats.booked++
        else if (r.outcome === 'needs_review') stats.review++
        else stats.failed++
      } catch (e) {
        stats.failed++
        logWarn('process-class-bookings', `row ${row.id} threw`, { err: e })
        try { await db.from('class_booking_requests').update({ status: 'failed', last_error: String(e?.message || e) }).eq('id', row.id) } catch {}
      }
    }
    await stampHeartbeat('process-class-bookings', stats)
    return NextResponse.json({ success: true, ...stats })
  } catch (e) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 })
  }
}
```

- [ ] **Step 2: vercel.json** — add to the `crons` array: `{ "path": "/api/cron/process-class-bookings", "schedule": "* * * * *" }`.
- [ ] **Step 3: Verify** — `npx eslint` the cron route; `grep -n "process-class-bookings" vercel.json` shows the entry; confirm the route has the CRON_SECRET guard (so `check:route-guards` passes).
- [ ] **Step 4: Commit** — `git add src/app/api/cron/process-class-bookings/route.js vercel.json && git commit -m "feat(start): process-class-bookings drain cron"`

---

## Task 5: Wizard class branch

**Files:** Modify `src/components/StartFunnel.jsx`

Enable the disabled "class" option: choosing class (after details) loads `GET /api/public/classes`, groups by `day`, lets the user pick a day then a time, and `POST`s to `/api/public/class-booking`, landing on a class-specific "you're being booked" done screen. Reuse the existing details step + state. Read the current file first; add a `classStep`/class state and a `bookClass()` handler mirroring the consultation pattern. The class "done" copy: *"You're being booked in — watch for a WhatsApp confirming your class. 🎉"*. Keep the consultation path unchanged.

- [ ] **Step 1: Implement** the class branch (complete the choose→details→class-picker→done flow; `chooseClass()` sets `path='class'` + `step='details'`; after details, `step='classcal'` fetches classes; render day chips from unique `c.day` + time buttons; on click → `bookClass(c)` → `POST /api/public/class-booking` with `{ event_id, class_name, starts_at, first_name, last_name, email, phone, consent }`). On success set a `classdone` step.
- [ ] **Step 2: Verify** — `npx eslint src/components/StartFunnel.jsx` (0 errors).
- [ ] **Step 3: Commit** — `git add src/components/StartFunnel.jsx && git commit -m "feat(start): enable class-booking branch in the wizard"`

---

## Task 6: Verification (manual, post-deploy)
- [ ] Preview `/start` → choose **Book a free class** → details → pick a day + time → submit → "being booked" screen; a `class_booking_requests` row appears `queued`, then the cron flips it `booked` (or `needs_review`).
- [ ] With a **brand-new** email/phone: confirm a Glofox account is created + the class is booked + (once `booking_class_confirmed` is approved) a WhatsApp arrives. Contact shows `lead_source=meta_book`, tag `stillorgan-start`, a `new_lead` deal.
- [ ] With an email that has **prior attendance**: confirm it routes to `/approvals` (a `class_booking` request) and does NOT auto-book; approving there books it.
- [ ] Force a Glofox failure (bad event id): confirm it lands in `needs_review`, not lost.

**Precondition:** operator creates + Meta approves UTILITY template `booking_class_confirmed` (3 vars: name · class · day&time). Until then the class confirm no-ops; booking still happens.

---

## Self-Review
- **Spec coverage:** class listing (T1) ✓; capture+enqueue with "reclassify as fresh lead" (T2) ✓; decision tree incl. attended-before→review, new→create+trial+book, existing+credits→book, existing+no-credits→grant+book, failure→review (T3) ✓; async cron (T4) ✓; WhatsApp class confirm via Phase 1 automation (T3) ✓; review→`/approvals` reusing `agent_membership_requests` (T3) ✓; wizard class option (T5) ✓. Migration applied ✓.
- **Placeholder scan:** T3/T5 implementations are specified rather than fully transcribed because they require reading the live Glofox helper signatures — the implementer reads them first (flagged in each task). All other code is complete.
- **Type consistency:** `processClassBookingRequest(db, request)` defined T3, called T4. `maybeSendBookingWhatsappConfirm({db, locationId, contact, templateName, bodyParams})` matches Phase 1's signature. `class_booking_requests` columns match the applied migration.
