# Event entry move, host portal (PR 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host moves one of their own entries to another of their own events from the host portal, on the same shared function and dialog that staff use (PR 1, #1950).

**Architecture:** Two host-scoped routes (`/api/host/registrations/[id]/move-targets`, `/api/host/registrations/[id]/move`) wrap `listMoveTargets` / `moveRegistration` with `getCurrentHost()`, the entry's event must belong to the host, and `allowedEventIds` is the host's own event set, so the same-payee rule is enforced twice. The host event page regroups its attendee table by entry and gains a Move action rendered by a new client component that reuses `MoveEntryDialog` with host URLs. The move history reads move into a small shared lib used by both the staff teams route and the host page.

**Tech Stack:** Next.js 16 App Router (service-role routes + a server page), React 19 client component, vitest (node for routes/lib, jsdom for the component).

**Spec:** `docs/superpowers/specs/2026-10-08-event-entry-move-design.md`, section "Host surface (PR 2)". The spec is the authority.

**Worktree:** `~/code/un1t-crm-evmove2`, branch `event-move-host`, off `origin/main` AFTER #1950 merged. Run every command from there. Never `git stash`.

**Decisions fixed for this PR** (recorded in the spec):
- `actor_type = 'host'`, `actor_id = event_hosts.id` (the host entity, which is what `getCurrentHost()` returns), `actor_name = host.name`; under admin view-as, `actor_name = "<admin email> as <host name>"` and `actor_id` stays the host id.
- An entry awaiting payment cannot be moved by a host (a host cannot collect or waive money): the route refuses with code `pending_payment`, 400, message "This entry is awaiting payment. It can move once it is paid."; the table shows "Pay first" instead of Move.
- Hosts may force a full wave (it is their capacity). Same `force` flow.
- The dialog keeps its light panel on the dark host page (the `Modal` primitive is white); the surrounding table is host-dark. No dark skin of the dialog.
- After a successful move the host page reloads (`window.location.reload()`, the host portal convention in `HostEventActions`), so the server-rendered table and footer refresh.

---

## File map

| File | Responsibility |
|---|---|
| `src/lib/registration-move-history.js` | `loadMoveHistory(db, { eventId, regIds })` → `{ lastMoveByReg, movedOut }`, extracted from the teams route. |
| `src/app/api/events/[id]/teams/route.js` | Uses the shared loader (behaviour unchanged). |
| `src/app/api/host/registrations/[id]/move-targets/route.js` | GET targets for a host. |
| `src/app/api/host/registrations/[id]/move/route.js` | POST the move for a host. |
| `src/app/api/host/registrations/[id]/move/route.test.js` | Gate, fence, pending_payment, mapping, actor. |
| `src/components/host/HostAttendeeTable.jsx` | Client table grouped by entry, Move / Pay first, chips, footer, dialog with host URLs. |
| `src/components/host/HostAttendeeTable.test.jsx` | jsdom tests. |
| `src/app/host/(portal)/events/[id]/page.js` | Builds entries + history server-side, renders the table. |
| `src/lib/openapi.js` | Registers the two host routes. |
| `docs/changelog/entries/<PR>.md` | After `gh pr create`. |

---

### Task 1: Shared move-history loader

**Files:**
- Create: `src/lib/registration-move-history.js`
- Create: `src/lib/registration-move-history.test.js`
- Modify: `src/app/api/events/[id]/teams/route.js` (replace its inline `loadMoveHistory`)

- [ ] **Step 1: Read the current inline loader**

Run: `grep -n "loadMoveHistory" -A 60 'src/app/api/events/[id]/teams/route.js' | head -90`. Note its two selects (moves in: `.eq('to_event_id', eventId)`, newest first, matched in memory against `regIds`; moves out: `.eq('from_event_id', eventId)`, `order created_at desc`, `limit(200)`, labelled with `entryLabel`), its error handling (log and degrade, never fail the response) and the shapes it returns (`last_move` fields: `id, registration_id, created_at, actor_name, price_gap_cents, forced, notified_at, from_event { id, name, race_date }`; `moved_out` items: `{ id, created_at, actor_name, label, to_event }`).

- [ ] **Step 2: Write the failing test** (`src/lib/registration-move-history.test.js`)

```js
import { describe, it, expect, vi } from 'vitest'
import { loadMoveHistory } from './registration-move-history.js'

function fakeDb({ movesIn = [], movesOut = [], inError = null, outError = null } = {}) {
  const calls = []
  return {
    calls,
    from(table) {
      const q = { table, ops: [] }
      calls.push(q)
      const b = {}
      for (const name of ['select', 'eq', 'in', 'order', 'limit']) b[name] = (...a) => { q.ops.push([name, ...a]); return b }
      b.then = (res, rej) => {
        const isOut = q.ops.some((o) => o[0] === 'eq' && o[1] === 'from_event_id')
        const v = isOut ? { data: outError ? null : movesOut, error: outError } : { data: inError ? null : movesIn, error: inError }
        return Promise.resolve(v).then(res, rej)
      }
      return b
    },
  }
}
const mv = (over) => ({ id: 'm1', registration_id: 'r1', created_at: '2026-10-08T10:00:00Z', actor_name: 'Richard', price_gap_cents: 0, forced: false, notified_at: null, from_event: { id: 'e1', name: 'A', race_date: '2026-10-18' }, ...over })

describe('loadMoveHistory', () => {
  it('keeps the newest move in per entry, only for entries on the list', async () => {
    const db = fakeDb({ movesIn: [mv({ id: 'new', created_at: '2026-10-09T00:00:00Z' }), mv({ id: 'old' }), mv({ id: 'gone', registration_id: 'r9' })] })
    const { lastMoveByReg } = await loadMoveHistory(db, { eventId: 'e2', regIds: ['r1'] })
    expect(lastMoveByReg.r1.id).toBe('new')
    expect(lastMoveByReg.r9).toBeUndefined()
  })
  it('labels moves out and caps at 200, newest first', async () => {
    const db = fakeDb({ movesOut: [{ id: 'o1', created_at: '2026-10-08T10:00:00Z', actor_name: '', registration: { teams: { name: 'Wolves', size: 2, team_members: [{}, {}] } }, to_event: { id: 'e5', name: 'B', race_date: '2026-11-01' } }] })
    const { movedOut } = await loadMoveHistory(db, { eventId: 'e1', regIds: [] })
    expect(movedOut).toEqual([{ id: 'o1', created_at: '2026-10-08T10:00:00Z', actor_name: '', label: 'Wolves', to_event: { id: 'e5', name: 'B', race_date: '2026-11-01' } }])
    const out = db.calls.find((q) => q.ops.some((o) => o[0] === 'eq' && o[1] === 'from_event_id'))
    expect(out.ops).toContainEqual(['order', 'created_at', { ascending: false }])
    expect(out.ops).toContainEqual(['limit', 200])
  })
  it('skips the moves-in read when there are no entries', async () => {
    const db = fakeDb()
    const { lastMoveByReg } = await loadMoveHistory(db, { eventId: 'e1', regIds: [] })
    expect(lastMoveByReg).toEqual({})
    expect(db.calls.filter((q) => q.ops.some((o) => o[0] === 'eq' && o[1] === 'to_event_id'))).toHaveLength(0)
  })
  it('degrades on a read error and never throws', async () => {
    const db = fakeDb({ inError: { message: 'boom' }, outError: { message: 'boom' } })
    const r = await loadMoveHistory(db, { eventId: 'e1', regIds: ['r1'] })
    expect(r).toEqual({ lastMoveByReg: {}, movedOut: [] })
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/lib/registration-move-history.test.js 2>&1 | tail -5`. Expected: cannot resolve module.

- [ ] **Step 4: Create the module by moving the code**

Move the teams route's inline `loadMoveHistory` into `src/lib/registration-move-history.js` with this signature and header, keeping its selects, its `logError` calls and its shapes byte-for-byte:

```js
// registration-move-history — the two reads behind the "Moved from" chip and
// the "moves to other events" footer (EVENT-MOVE.1). Shared by the staff teams
// route and the host event page. Both reads degrade: a failure is logged and
// costs only the chip or the footer, never the caller's response.
import { entryLabel } from './registration-entry'
import { logError } from './log'

/**
 * @param {object} db  service-role client; the CALLER has already gated the event
 * @param {{ eventId: string, regIds: string[] }} args
 * @returns {Promise<{ lastMoveByReg: Record<string, object>, movedOut: Array<object> }>}
 */
export async function loadMoveHistory(db, { eventId, regIds }) { /* moved body */ }
```

The teams route imports it and does `const { lastMoveByReg, movedOut } = await loadMoveHistory(db, { eventId: params.id, regIds })`, then `for (const r of regs) r.last_move = lastMoveByReg[r.id] || null`. Delete the inline function and any now-unused imports there.

- [ ] **Step 5: Run both test files**

Run: `npx vitest run src/lib/registration-move-history.test.js 'src/app/api/events/[id]/teams' 2>&1 | tail -6` and `npm run check:select-columns 2>&1 | tail -2`. Expected: all pass; the teams route tests are unchanged and still pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/registration-move-history.js src/lib/registration-move-history.test.js 'src/app/api/events/[id]/teams/route.js'
git commit -m "EVENT-MOVE.2 — move history loader shared by the teams route and the host page"
```

---

### Task 2: Host routes

**Files:**
- Create: `src/app/api/host/registrations/[id]/move-targets/route.js`
- Create: `src/app/api/host/registrations/[id]/move/route.js`
- Create: `src/app/api/host/registrations/[id]/move/route.test.js`
- Create: `src/app/api/host/registrations/[id]/move-targets/route.test.js`
- Modify: `src/lib/openapi.js`

- [ ] **Step 1: Read the staff routes** (`src/app/api/event-registrations/[id]/move/route.js` and `move-targets/route.js`) for the status mapping, `MoveSchema`, the `message` convention and the `readRegistrationForMove` use. The host routes mirror them with the host gate instead of the staff gate.

- [ ] **Step 2: Write the failing move-route test**

```js
// EVENT-MOVE.2 — POST /api/host/registrations/[id]/move. A host moves ONE of
// their own entries to another of their OWN events. The lib's rules are tested
// in src/lib/registration-move.test.js; this pins the host gate, the own-event
// fence, pending_payment, the mapping and the actor.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({ getCurrentHost: vi.fn(), createServerClient: vi.fn(), readRegistrationForMove: vi.fn(), moveRegistration: vi.fn() }))
vi.mock('@/lib/host-auth', () => ({ getCurrentHost: mocks.getCurrentHost }))
vi.mock('@/lib/supabase', () => ({ createServerClient: mocks.createServerClient }))
vi.mock('@/lib/registration-move', async (importOriginal) => ({ ...(await importOriginal()), readRegistrationForMove: mocks.readRegistrationForMove, moveRegistration: mocks.moveRegistration }))

const { POST } = await import('./route.js')

const H1 = 'h0000000-0000-0000-0000-000000000001'
const E1 = 'e0000000-0000-0000-0000-000000000001'
const E2 = 'e0000000-0000-0000-0000-000000000002'
const E9 = 'e0000000-0000-0000-0000-000000000009'
const W9 = 'f0000000-0000-0000-0000-000000000009'
const R1 = 'a0000000-0000-0000-0000-000000000001'
const session = (over = {}) => ({ host: { id: H1, name: 'Pride Training Club' }, authUserId: 'u1', email: 'colm@x.ie', ...over })
const props = { params: Promise.resolve({ id: R1 }) }
const post = (body) => new Request(`http://localhost/api/host/registrations/${R1}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const BODY = { target_event_id: E2, target_wave_id: W9 }

// The route reads the host's own event ids once: `from('race_events').select('id').eq('host_id', H1)`.
function dbWith({ ownEvents = [E1, E2], eventsError = null } = {}) {
  const b = { select: () => b, eq: () => b, then: (res, rej) => Promise.resolve({ data: eventsError ? null : ownEvents.map((id) => ({ id })), error: eventsError }).then(res, rej) }
  return { from: vi.fn(() => b) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createServerClient.mockReturnValue(dbWith())
  mocks.readRegistrationForMove.mockResolvedValue({ registration: { id: R1, status: 'confirmed', race_event_id: E1, race: { id: E1, host_id: H1, location_id: 'L1' } }, error: null })
  mocks.moveRegistration.mockResolvedValue({ ok: true, move: { id: 'mv1' }, registration: { id: R1 }, notified: true })
})

describe('POST /api/host/registrations/[id]/move', () => {
  it('401 without a host session', async () => {
    mocks.getCurrentHost.mockResolvedValue(null)
    expect((await POST(post(BODY), props)).status).toBe(401)
    expect(mocks.moveRegistration).not.toHaveBeenCalled()
  })
  it('404 for an entry on another host\'s event', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    mocks.readRegistrationForMove.mockResolvedValue({ registration: { id: R1, status: 'confirmed', race_event_id: E9, race: { id: E9, host_id: 'other', location_id: 'L1' } }, error: null })
    expect((await POST(post(BODY), props)).status).toBe(404)
    expect(mocks.moveRegistration).not.toHaveBeenCalled()
  })
  it('404 for a missing entry, 500 for a failed read', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    mocks.readRegistrationForMove.mockResolvedValueOnce({ registration: null, error: null })
    expect((await POST(post(BODY), props)).status).toBe(404)
    mocks.readRegistrationForMove.mockResolvedValueOnce({ registration: null, error: { message: 'boom' } })
    expect((await POST(post(BODY), props)).status).toBe(500)
  })
  it('400 pending_payment: a host cannot move an unpaid entry', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    mocks.readRegistrationForMove.mockResolvedValue({ registration: { id: R1, status: 'pending_payment', race_event_id: E1, race: { id: E1, host_id: H1, location_id: 'L1' } }, error: null })
    const res = await POST(post(BODY), props)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ success: false, error: 'pending_payment', message: expect.stringMatching(/awaiting payment/) })
    expect(mocks.moveRegistration).not.toHaveBeenCalled()
  })
  it('400 on a bad body (after the gate)', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    expect((await POST(post({ target_event_id: 'nope' }), props)).status).toBe(400)
  })
  it('passes the own-event fence, the host actor and expectedSourceEventId to the lib', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    const res = await POST(post({ ...BODY, force: true, note: ' moved by host ' }), props)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, data: { notified: true } })
    const args = mocks.moveRegistration.mock.calls[0][1]
    expect(args).toMatchObject({ registrationId: R1, targetEventId: E2, targetWaveId: W9, force: true, notify: true, note: 'moved by host', expectedSourceEventId: E1, actor: { type: 'host', id: H1, name: 'Pride Training Club' } })
    expect(args.allowedEventIds).toBeInstanceOf(Set)
    expect([...args.allowedEventIds]).toEqual([E1, E2])
  })
  it('names the admin under view-as', async () => {
    mocks.getCurrentHost.mockResolvedValue(session({ impersonatedBy: { id: 'adm' }, email: 'richard@x.ie' }))
    await POST(post(BODY), props)
    expect(mocks.moveRegistration.mock.calls[0][1].actor).toEqual({ type: 'host', id: H1, name: 'richard@x.ie as Pride Training Club' })
  })
  it('500 when the own-events read fails, before the lib runs', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    mocks.createServerClient.mockReturnValue(dbWith({ eventsError: { message: 'boom' } }))
    expect((await POST(post(BODY), props)).status).toBe(500)
    expect(mocks.moveRegistration).not.toHaveBeenCalled()
  })
  it('maps lib refusals like the staff route', async () => {
    mocks.getCurrentHost.mockResolvedValue(session())
    for (const [error, status] of [['not_found', 404], ['wave_full', 409], ['conflict', 409], ['load_failed', 500], ['write_failed', 500], ['checked_in', 400]]) {
      mocks.moveRegistration.mockResolvedValueOnce({ ok: false, error, spots_left: error === 'wave_full' ? 0 : undefined })
      const res = await POST(post(BODY), props)
      expect(res.status).toBe(status)
      const j = await res.json()
      expect(j.error).toBe(error)
      expect(typeof j.message).toBe('string')
    }
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run 'src/app/api/host/registrations/[id]/move/route.test.js' 2>&1 | tail -5`. Expected: cannot find `./route.js`.

- [ ] **Step 4: Write a small shared helper for both host routes** at `src/app/api/host/registrations/[id]/_shared.js`? No: App Router treats any file under `app/` as routable only when named `route.js`/`page.js`, but keep helpers in `src/lib/`. Create `src/lib/host-move-session.js`:

```js
// host-move-session — what both host move routes need: the host session, the
// entry (which must sit on one of the host's events: 404 otherwise, so entry
// ids cannot be enumerated across hosts), the host's own event ids (the
// allowedEventIds fence for the lib, enforcing same-payee twice), and the
// actor to record. EVENT-MOVE.2.
import { NextResponse } from 'next/server'
import { getCurrentHost } from './host-auth'
import { createServerClient } from './supabase'
import { readRegistrationForMove, MOVE_ERRORS, MOVE_ERROR_MESSAGES } from './registration-move'
import { logError } from './log'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function json(status, body) { return NextResponse.json(body, { status }) }

/**
 * @returns {Promise<{ response: Response } | { db, session, registration, allowedEventIds: Set<string>, actor }>}
 */
export async function resolveHostMoveContext(registrationId) {
  const session = await getCurrentHost()
  if (!session) return { response: json(401, { success: false, error: 'Unauthorized' }) }
  if (!UUID_RE.test(String(registrationId || ''))) return { response: json(404, { success: false, error: 'Not found' }) }
  const db = createServerClient()
  const { registration, error } = await readRegistrationForMove(db, registrationId)
  if (error) return { response: json(500, { success: false, error: MOVE_ERRORS.LOAD_FAILED, message: MOVE_ERROR_MESSAGES[MOVE_ERRORS.LOAD_FAILED] }) }
  if (!registration || registration.race?.host_id !== session.host.id) return { response: json(404, { success: false, error: 'Not found' }) }

  const { data: events, error: evErr } = await db.from('race_events').select('id').eq('host_id', session.host.id)
  if (evErr) {
    logError('host-move', 'own events read failed', { err: evErr, hostId: session.host.id })
    return { response: json(500, { success: false, error: MOVE_ERRORS.LOAD_FAILED, message: 'Your events could not be read. Try again.' }) }
  }
  const allowedEventIds = new Set((events || []).map((e) => e.id))
  const actor = {
    type: 'host',
    id: session.host.id,
    name: session.impersonatedBy ? `${session.email || 'admin'} as ${session.host.name}` : session.host.name,
  }
  return { db, session, registration, allowedEventIds, actor }
}
```

Note: with the test's `vi.mock('@/lib/registration-move', …)` the helper's import resolves to the same mock because it imports `./registration-move` (vitest mocks by resolved path, so `@/lib/registration-move` and `./registration-move` are the same module). Keep the relative import inside `src/lib`.

- [ ] **Step 5: Write the move route**

```js
// /api/host/registrations/[id]/move — EVENT-MOVE.2
//
// POST — a host moves ONE of their own entries to another of their OWN events.
// Same lib, same dialog as the staff route; the host fence is
// allowedEventIds (their own events) on top of the lib's same-payee rule. A
// host cannot move an entry that is still awaiting payment (they cannot
// collect or waive money), so pending_payment is refused here.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { uuidLike } from '@/lib/schemas'
import { validateBody } from '@/lib/validate'
import { moveRegistration, MOVE_ERRORS, MOVE_ERROR_MESSAGES } from '@/lib/registration-move'
import { resolveHostMoveContext } from '@/lib/host-move-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const HostMoveSchema = z.object({
  target_event_id: uuidLike,
  target_wave_id: uuidLike.nullable().optional(),
  notify: z.boolean().optional().default(true),
  note: z.string().trim().max(1000).nullable().optional(),
  force: z.boolean().optional().default(false),
})

const STATUS_FOR = { [MOVE_ERRORS.NOT_FOUND]: 404, [MOVE_ERRORS.WAVE_FULL]: 409, [MOVE_ERRORS.CONFLICT]: 409, [MOVE_ERRORS.LOAD_FAILED]: 500, [MOVE_ERRORS.WRITE_FAILED]: 500 }
const PENDING_MESSAGE = 'This entry is awaiting payment. It can move once it is paid.'

export async function POST(request, props) {
  const params = await props.params
  const ctx = await resolveHostMoveContext(params.id)
  if (ctx.response) return ctx.response
  const { db, registration, allowedEventIds, actor } = ctx

  if (registration.status === 'pending_payment') {
    return NextResponse.json({ success: false, error: 'pending_payment', message: PENDING_MESSAGE }, { status: 400 })
  }
  const validation = await validateBody(request, HostMoveSchema)
  if (!validation.ok) return validation.response
  const body = validation.data

  const result = await moveRegistration(db, {
    registrationId: params.id,
    targetEventId: body.target_event_id,
    targetWaveId: body.target_wave_id || null,
    expectedSourceEventId: registration.race_event_id,
    actor,
    note: body.note || null,
    notify: body.notify,
    force: body.force,
    allowedEventIds,
  })
  if (!result.ok) {
    return NextResponse.json({
      success: false, error: result.error,
      message: MOVE_ERROR_MESSAGES[result.error] || 'The move could not be completed.',
      ...(result.spots_left !== undefined ? { spots_left: result.spots_left } : {}),
    }, { status: STATUS_FOR[result.error] || 400 })
  }
  return NextResponse.json({ success: true, data: { move: result.move, registration: result.registration, notified: result.notified === true } })
}
```

Check how the staff move route reads `validateBody`'s failure (`validation.response`) and copy exactly.

- [ ] **Step 6: Write the targets route**

```js
// /api/host/registrations/[id]/move-targets — EVENT-MOVE.2
// GET — the host's OWN upcoming events this entry may move to, with per-wave
// spots and the price gap. Host-only (shows capacity); never public.
import { NextResponse } from 'next/server'
import { listMoveTargets, MOVE_ERRORS, MOVE_ERROR_MESSAGES } from '@/lib/registration-move'
import { resolveHostMoveContext } from '@/lib/host-move-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const ctx = await resolveHostMoveContext(params.id)
  if (ctx.response) return ctx.response
  const { db, allowedEventIds } = ctx
  const result = await listMoveTargets(db, { registrationId: params.id, allowedEventIds, allowedLocationIds: null })
  if (!result.ok) {
    const status = result.error === MOVE_ERRORS.NOT_FOUND ? 404 : 500
    return NextResponse.json({ success: false, error: result.error, message: MOVE_ERROR_MESSAGES[result.error] || 'Could not load events.' }, { status })
  }
  return NextResponse.json({ success: true, data: { entry: result.entry, source: result.source, targets: result.targets } })
}
```

- [ ] **Step 7: Targets route test** (`move-targets/route.test.js`): same mocks as Step 2 plus `listMoveTargets`; cases: 401 no session; 404 another host's entry; 200 passes `allowedEventIds` = own event set and `allowedLocationIds: null`; 500 on a lib `load_failed`.

- [ ] **Step 8: OpenAPI** — after the two staff entries in `src/lib/openapi.js`, register `/api/host/registrations/{id}/move-targets` (get) and `/api/host/registrations/{id}/move` (post) with the same shapes, using the tag the neighbouring `/api/host/*` entries use (`grep -n "path: '/api/host/" src/lib/openapi.js | head -3`; if none exist, use `['Host portal']`) and the host security scheme those use.

- [ ] **Step 9: Run tests and gates**

Run: `npx vitest run 'src/app/api/host/registrations' src/lib/registration-move.test.js 2>&1 | tail -6 && npm run check:route-guards 2>&1 | tail -2 && npm run check:location-scoping 2>&1 | tail -2 && npm run check:select-columns 2>&1 | tail -2 && npm run check:guardrails 2>&1 | tail -2`. Expected: all pass; `check:route-guards` accepts `getCurrentHost(` (it is in its recognised list), but it scans the ROUTE file: the helper hides the call, so if the guard flags the two routes, add a literal comment line `// guard: getCurrentHost( via resolveHostMoveContext` is NOT enough; instead call `getCurrentHost()` in the route itself first (keep the helper for the rest) so the scan sees it. Prefer that over an EXEMPT entry.

- [ ] **Step 10: Commit**

```bash
git add src/lib/host-move-session.js 'src/app/api/host/registrations' src/lib/openapi.js
git commit -m "EVENT-MOVE.2 — host routes: move-targets + move, fenced to the host's own events"
```

---

### Task 3: Host attendee table with Move

**Files:**
- Create: `src/components/host/HostAttendeeTable.jsx`
- Create: `src/components/host/HostAttendeeTable.test.jsx`
- Modify: `src/app/host/(portal)/events/[id]/page.js`

- [ ] **Step 1: Failing component test**

```jsx
// @vitest-environment jsdom
// EVENT-MOVE.2 — the host attendee table: one row per entry, Move for paid
// entries, Pay first for unpaid, chips from last_move, moved-out footer, and
// the dialog wired to the host routes.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import HostAttendeeTable from './HostAttendeeTable.jsx'

const entries = [
  { id: 'r1', status: 'confirmed', label: 'The Crushers', people: [{ name: 'Aoife Byrne', email: 'a@x.ie' }, { name: 'Dan Walsh', email: '' }], wave: '11:00', phone: '+3531', last_move: { id: 'm1', created_at: '2026-10-06T10:00:00Z', actor_name: 'Colm', notified_at: null, forced: false, from_event: { id: 'e0', name: 'PTC Oct 4', race_date: '2026-10-04' } }, registration: { id: 'r1', status: 'confirmed', teams: { name: 'The Crushers', size: 2, team_members: [{ name: 'Aoife Byrne', role: 'captain', email: 'a@x.ie' }, { name: 'Dan Walsh' }] } } },
  { id: 'r2', status: 'pending_payment', label: 'Mark Kelly', people: [{ name: 'Mark Kelly', email: 'm@x.ie' }], wave: '11:00', phone: '', last_move: null, registration: { id: 'r2', status: 'pending_payment', teams: { name: 'Mark Kelly', size: 1, team_members: [{ name: 'Mark Kelly', role: 'captain' }] } } },
]
const movedOut = [{ id: 'o1', created_at: '2026-10-07T10:00:00Z', actor_name: 'Colm', label: 'Wolves', to_event: { id: 'e5', name: 'PTC Nov 1', race_date: '2026-11-01' } }]

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('HostAttendeeTable', () => {
  it('renders one row per entry with its people, Move for paid and Pay first for unpaid', () => {
    render(<HostAttendeeTable eventId="e1" entries={entries} movedOut={[]} currency="EUR" />)
    expect(screen.getAllByRole('row')).toHaveLength(3) // header + 2
    expect(screen.getByText(/Aoife Byrne, Dan Walsh/)).toBeTruthy()
    expect(screen.getAllByRole('button', { name: /^Move$/ })).toHaveLength(1)
    expect(screen.getByText(/Pay first/)).toBeTruthy()
  })
  it('shows moved-in and not-emailed chips', () => {
    render(<HostAttendeeTable eventId="e1" entries={entries} movedOut={[]} currency="EUR" />)
    expect(screen.getByText(/moved in/i)).toBeTruthy()
    expect(screen.getByText(/Not emailed/)).toBeTruthy()
  })
  it('lists moves out', () => {
    render(<HostAttendeeTable eventId="e1" entries={entries} movedOut={movedOut} currency="EUR" />)
    expect(screen.getByText(/1 move to other events/)).toBeTruthy()
    expect(screen.getByText(/Wolves/)).toBeTruthy()
  })
  it('opens the dialog against the host routes', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: { entry: { id: 'r1', label: 'The Crushers', headcount: 2 }, source: {}, targets: [] } }) }))
    vi.stubGlobal('fetch', fetchMock)
    render(<HostAttendeeTable eventId="e1" entries={entries} movedOut={[]} currency="EUR" />)
    fireEvent.click(screen.getByRole('button', { name: /^Move$/ }))
    await screen.findByText(/Move The Crushers to another event/)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/host/registrations/r1/move-targets')
  })
  it('renders nothing but the empty line with no entries', () => {
    render(<HostAttendeeTable eventId="e1" entries={[]} movedOut={[]} currency="EUR" />)
    expect(screen.getByText(/No attendees yet/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/host/HostAttendeeTable.test.jsx 2>&1 | tail -4`. Expected: cannot resolve module.

- [ ] **Step 3: Write the component**

```jsx
'use client'
// HostAttendeeTable — EVENT-MOVE.2. The host event page's roster, one row per
// ENTRY (a team or a single person), with a Move action for paid entries.
// Dark host-portal styling like HostPromoCodes; the move dialog itself keeps
// its light panel (the shared Modal primitive). An entry awaiting payment
// shows "Pay first": a host cannot collect or waive money, and the host route
// refuses it anyway.
//
// `entries` and `movedOut` are built server-side by the page (it holds the
// tenancy gate); this component only renders and opens the dialog. After a
// move the page reloads, the host portal convention (HostEventActions).

import { useState } from 'react'
import MoveEntryDialog, { NOT_EMAILED_MESSAGE } from '@/components/MoveEntryDialog'

const STATUS_LABEL = { confirmed: 'Confirmed', pending_payment: 'Awaiting payment', cancelled: 'Cancelled', no_show: 'No-show' }
const th = 'px-3 py-2 font-medium'
const td = 'px-3 py-2'
const LIVE = new Set(['confirmed', 'pending_payment'])

function fmtDate(d) {
  if (!d) return ''
  try { return new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' }) } catch { return d }
}

export default function HostAttendeeTable({ eventId, entries, movedOut, currency = 'EUR' }) {
  const [moving, setMoving] = useState(null) // the entry being moved
  const [notice, setNotice] = useState(null)
  const rows = Array.isArray(entries) ? entries : []
  const out = Array.isArray(movedOut) ? movedOut : []

  return (
    <section className="mt-8">
      {notice && (
        <div role="status" className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-200 text-sm px-3 py-2 flex items-start gap-2">
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-amber-200/70 hover:text-amber-100" aria-label="Dismiss notice">×</button>
        </div>
      )}
      {rows.length === 0 ? (
        <p className="text-white/50 text-sm">No attendees yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-sm whitespace-nowrap">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-white/40 border-b border-white/10">
                <th className={th}>Entry</th>
                <th className={th}>People</th>
                <th className={th}>Time</th>
                <th className={th}>Status</th>
                <th className={th}>Phone</th>
                <th className={th}></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-b border-white/5 last:border-0">
                  <td className={td}>
                    <span className="text-white">{e.label}</span>
                    {e.last_move && (
                      <span className="ml-2 text-[11px] text-sky-300" title={`Moved in from ${e.last_move.from_event?.name || 'another event'} on ${fmtDate(e.last_move.created_at)} by ${e.last_move.actor_name || 'staff'}${e.last_move.forced ? ' (time was full)' : ''}`}>
                        moved in {fmtDate(e.last_move.created_at)}
                      </span>
                    )}
                    {e.last_move && e.last_move.notified_at === null && (
                      <span className="ml-2 text-[11px] text-amber-300" title="The customer was not emailed about this move. Tell them yourself.">Not emailed</span>
                    )}
                  </td>
                  <td className={`${td} text-white/70`}>{e.people.map((p) => p.name).filter(Boolean).join(', ') || '—'}</td>
                  <td className={`${td} text-white/70`}>{e.wave || '—'}</td>
                  <td className={`${td} text-white/70`}>{STATUS_LABEL[e.status] || e.status}</td>
                  <td className={`${td} text-white/60`}>{e.phone || ''}</td>
                  <td className={`${td} text-right`}>
                    {e.status === 'confirmed' && (
                      <button type="button" onClick={() => setMoving(e)} className="rounded-md border border-white/20 text-white text-xs px-2.5 py-1 hover:bg-white/5">Move</button>
                    )}
                    {e.status === 'pending_payment' && <span className="text-xs text-white/35">Pay first</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {out.length > 0 && (
        <details className="mt-3 text-sm text-white/50">
          <summary className="cursor-pointer select-none">{out.length} {out.length === 1 ? 'move' : 'moves'} to other events</summary>
          <ul className="mt-2 space-y-1 pl-4">
            {out.map((m) => (
              <li key={m.id}>{m.label} → {m.to_event?.name || 'another event'}{m.to_event?.race_date ? ` (${fmtDate(m.to_event.race_date)})` : ''} · {fmtDate(m.created_at)} · {m.actor_name || 'staff'}</li>
            ))}
          </ul>
        </details>
      )}

      {moving && (
        <MoveEntryDialog
          open
          registration={moving.registration}
          targetsUrl={`/api/host/registrations/${moving.id}/move-targets`}
          moveUrl={`/api/host/registrations/${moving.id}/move`}
          onClose={() => setMoving(null)}
          onNotice={(msg) => setNotice(msg || NOT_EMAILED_MESSAGE)}
          onMoved={() => { setMoving(null); window.location.reload() }}
        />
      )}
    </section>
  )
}
```

`currency` is accepted for the future "difference outstanding" chip; the host table does not show the gap chip in this PR (the host sets their own prices; the dialog already told them). Remove the prop if lint flags it unused, or keep it used in a `title`. Decide, do not leave an unused prop.

Note: `vi.stubGlobal('fetch')` in the dialog test needs `window.location.reload` not to run; the test never completes a move, so it is fine.

- [ ] **Step 4: Rewrite the page to build entries server-side**

In `src/app/host/(portal)/events/[id]/page.js`: keep the gate and `fetchEventAttendees`; add `import { loadMoveHistory } from '@/lib/registration-move-history'`, `import { entryLabel } from '@/lib/registration-entry'`, `import HostAttendeeTable from '@/components/host/HostAttendeeTable'`; select `payment_currency` on the race; then

```js
  const regs = await fetchEventAttendees(db, params.id)
  const { lastMoveByReg, movedOut } = await loadMoveHistory(db, { eventId: params.id, regIds: regs.map((r) => r.id) })
  const entries = regs.map((reg) => {
    const members = Array.isArray(reg.teams?.team_members) ? reg.teams.team_members : []
    return {
      id: reg.id,
      status: reg.status,
      label: entryLabel(reg),
      people: members.map((m) => ({ name: m.name || '', email: m.email || '' })),
      wave: reg.wave?.label || (reg.wave?.start_time || '').slice(0, 5) || '',
      phone: reg.payment?.contact_phone || '',
      last_move: lastMoveByReg[reg.id] || null,
      // What the dialog needs to label the entry before the targets load.
      registration: { id: reg.id, status: reg.status, teams: reg.teams ? { name: reg.teams.name, size: reg.teams.size, team_members: members.map((m) => ({ name: m.name, role: m.role, email: m.email })) } : null },
    }
  })
  const confirmed = regs.filter((r) => r.status === 'confirmed').length
  const people = entries.reduce((n, e) => n + Math.max(1, e.people.length), 0)
```

Replace the header line's `{rows.length} attendee…` with `{people} attendee…`, delete the flattened `rows` and the inline table, keep Export CSV (gate it on `regs.length > 0`) and `HostEventActions`, and render `<HostAttendeeTable eventId={race.id} entries={entries} movedOut={movedOut} currency={race.payment_currency || 'EUR'} />` in place of the old `<section>`. `HostPromoCodes` stays below.

Only plain objects cross into the client component (no Dates, no functions): the shapes above are JSON-safe.

- [ ] **Step 5: Run tests, lint and the column gate**

Run: `npx vitest run src/components/host/HostAttendeeTable.test.jsx src/components/MoveEntryDialog.test.jsx 2>&1 | tail -6 && npm run check:select-columns 2>&1 | tail -2 && npm run check:guardrails 2>&1 | tail -2 && npx eslint src/components/host/HostAttendeeTable.jsx 'src/app/host/(portal)/events/[id]/page.js'`. Expected: all pass (the host portal paths are exempt from the chip-contrast rule by design; the amber/sky text on black is the existing portal idiom).

- [ ] **Step 6: Commit**

```bash
git add src/components/host/HostAttendeeTable.jsx src/components/host/HostAttendeeTable.test.jsx 'src/app/host/(portal)/events/[id]/page.js'
git commit -m "EVENT-MOVE.2 — host event page: one row per entry, Move for paid entries, moved-in chips, moves-out footer"
```

---

### Task 4: Gate, build, PR, changelog

- [ ] **Step 1: CI mirror** — the full thirteen-command mirror from `CLAUDE.md` ("Build, test & ship"). All exit 0.
- [ ] **Step 2: `npm run build`** — expect "Compiled successfully" and both `/api/host/registrations/[id]/move` routes listed.
- [ ] **Step 3: Push + PR**

```bash
git push -u origin HEAD
gh pr create --base main --title "EVENT-MOVE.2 — hosts move their own entries between their own events" --body "$(cat <<'EOF'
Hosts move one of their own entries to another of their own events from the host event page, on the shared function and dialog from #1950. No migration.

- `POST /api/host/registrations/[id]/move`, `GET …/move-targets`: `getCurrentHost()`, the entry must sit on the host's event (404 otherwise), `allowedEventIds` = the host's own events (same-payee enforced twice). An entry awaiting payment is refused (`pending_payment`): a host cannot collect or waive money. Actor recorded as the host (admin view-as named).
- Host event page: one row per entry, Move for paid entries, "Pay first" for unpaid, moved-in / Not emailed chips, moves-out footer, amber notice when the email did not go out. The move history reads are now one shared lib used by the staff teams route too.

Spec: docs/superpowers/specs/2026-10-08-event-entry-move-design.md (Host surface). Mig 708 is already applied.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: Changelog entry** `docs/changelog/entries/<PR>.md`, one row keyed `#<PR>`, `EVENT-MOVE.2 — hosts move their own entries between their own events | 2026-10-08. …`; run `npx vitest run tests/changelog-entries.test.js`; commit, push.
- [ ] **Step 5: Report** the PR URL; nothing to apply.

---

## Self-review against the spec (Host surface)

- One row per entry with people in a cell, Move per live paid entry, "Pay first" for unpaid: Task 3. ✔
- Host routes with `getCurrentHost()`, `host_id === session.host.id`, `allowedEventIds` fence, `actor_type='host'`: Task 2. ✔
- Same dialog, same price-gap notice, hosts may force: Task 3 reuses `MoveEntryDialog` unchanged. ✔
- Footer "moves out": Task 3 via the shared loader of Task 1. ✔
- Not in scope: Mia, cross-payee moves, a dark dialog skin, the gap chip on the host table.
