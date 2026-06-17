# Coach Today Roster — Phase 3 Implementation Plan (swaps lifecycle + targeted/open claim + "On with you today")

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make shift swaps fully self-service for coaches on the Today dashboard — a coach can claim an open swap or accept/decline one targeted at them (→ `awaiting_approval`), a manager still finalises, and everyone sees "who's on with you today" — while fixing three latent embed bugs that currently make swaps silently non-functional.

**Architecture:** A new pure resolver (`src/lib/swap-lifecycle.js`) decides every swap state transition + its DB effects from `(swap, requestedStatus, user)`; the `PUT /api/schedule/swaps/[id]` route becomes a thin executor of that decision (DB writes + best-effort pushes). `GET /api/schedule/swaps` gains `for_me`/`open` filters so name-bearing actionable lists are served by the service-role route (mobile's authenticated client cannot read `profiles`). The shared dashboard fetch + the manager approvals provider get their broken embeds fixed. Then web + mobile UIs add Accept/Decline/Claim affordances, an "open swaps you can take" list, a targeted-swap colleague picker, and an "On with you today" team strip.

**Tech Stack:** Next.js 16 App Router (service-role API routes), Supabase/PostgREST, Zod, Vitest (pure-helper tests), Expo/React Native (mobile), shared JS in `shared/`.

**No migration:** `shift_swap_requests.status` is free `TEXT` (verified live — only FK constraints, no CHECK). `awaiting_approval` is added to the Zod enum only.

---

## Background facts (verified live against project `iyvtbjjxdggiadzwwvdj`)

- `shift_swap_requests` columns: `id, location_id, requester_shift_id (FK shift_assignments), requester_id (FK profiles), target_shift_id (FK shift_assignments, nullable, ON DELETE SET NULL), target_id (FK profiles, nullable), reason, status (free TEXT), review_note, reviewed_by, reviewed_at, created_at`.
- `shift_assignments` columns: `id, block_id (FK shift_blocks), profile_id (FK profiles), notes, status, assigned_by, assigned_at, updated_at, start_time_override, end_time_override, partial_reason`. **No `start_time`/`end_time`** (raw times live on the block/template). **No FK to `shift_templates`** (only via `shift_blocks.template_id`).
- The legacy `public.shifts` table was dropped (mig 238). Any `shifts!…` embed is dead.
- Mobile calls `fetchPersonalDashboardData(supabase, …)` with the **authenticated** client (`mobile/lib/dashboard-api.js`) — that role has NO grant on `public.profiles`, so embedding `profiles` in the shared fetch 500s the whole query on mobile. Other-user names must come from a service-role `/api` route.
- The canonical correct swap-shift embed (route.js `SWAP_SHIFT_EMBED` + `swapShiftShape` in `src/lib/roster-read.js`):
  ```
  shift_assignments!<fk>(
    id, profile_id, status, notes, start_time_override, end_time_override,
    shift_blocks!block_id ( block_date, start_time, end_time,
      shift_templates ( name, start_time, end_time, role_label ) ),
    profiles!profile_id ( id, full_name )
  )
  ```

## Swap lifecycle (the contract this phase implements)

States (`status`): `pending` → `awaiting_approval` → (`approved` | `rejected`); plus `cancelled`; manager approve may set assignment status `swapped`.

| From | Actor | Action (requestedStatus) | Effect |
|---|---|---|---|
| `pending`, `target_id` NULL | coach (≠requester, at location) | `awaiting_approval` (**claim**) | set `target_id = actor`, status `awaiting_approval` |
| `pending`, `target_id` = actor | target coach | `awaiting_approval` (**accept**) | status `awaiting_approval` (target unchanged) |
| `pending`, `target_id` = actor | target coach | `rejected` (**decline**) | status `rejected` |
| `awaiting_approval`, `target_id` = actor | taker | `pending` (**withdraw**) | status `pending`, `target_id = NULL` (re-opens to pool) |
| `pending`/`awaiting_approval` | requester | `cancelled` | status `cancelled` |
| `pending`/`awaiting_approval` | MANAGER_ROLES | `approved` | finalise (see below) + `reviewed_by/at` |
| `pending`/`awaiting_approval` | MANAGER_ROLES | `rejected` | status `rejected` + `reviewed_by/at` |

Manager **approve** finalisation (acts on assignments):
- `target_shift_id` set → reciprocal swap: swap `profile_id` between the two assignments, set both assignment `status='swapped'`.
- else `target_id` set (claim/accept, no reciprocal shift) → **reassign**: requester's assignment `profile_id = target_id`, `status='swapped'`.
- else (no `target_id`, no `target_shift_id`) → **drop**: requester's assignment `status='cancelled'`.

Any transition from a terminal state (`approved`/`rejected`/`cancelled`, or assignment already `swapped`) is rejected. Non-managers may only claim/accept/decline/withdraw/cancel-own as above; everything else → 403.

---

## PART A — Phase 3a (backend lifecycle + data correctness). Ships as its own PR.

### Task 1: Pure swap-lifecycle resolver + exhaustive tests

**Files:**
- Create: `src/lib/swap-lifecycle.js`
- Test: `src/lib/swap-lifecycle.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/swap-lifecycle.test.js
import { describe, it, expect } from 'vitest'
import { resolveSwapTransition, TERMINAL_SWAP_STATES } from './swap-lifecycle'

// Minimal swap factory. requester_shift / target_shift mirror the embed the
// route fetches (only profile_id is read by the resolver).
function makeSwap(over = {}) {
  return {
    id: 'swap-1',
    location_id: 'loc-1',
    status: 'pending',
    requester_id: 'req-1',
    target_id: null,
    requester_shift_id: 'asg-req',
    target_shift_id: null,
    requester_shift: { id: 'asg-req', profile_id: 'req-1' },
    target_shift: null,
    ...over,
  }
}
const manager = { id: 'mgr-1', role: 'manager' }
const coach = (id) => ({ id, role: 'staff' })

describe('resolveSwapTransition — coach claim (open swap)', () => {
  it('lets an eligible coach claim an open pending swap', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'awaiting_approval',
      user: coach('coach-2'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('claimed')
    expect(r.swapUpdates).toMatchObject({ status: 'awaiting_approval', target_id: 'coach-2' })
    expect(r.assignmentOps).toEqual([])
    expect(r.notify).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'claim_for_requester', to: ['req-1'] }),
        expect.objectContaining({ kind: 'claim_for_managers' }),
      ])
    )
  })

  it('rejects a claim by the requester themselves', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'awaiting_approval',
      user: coach('req-1'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })

  it('rejects a claim by a coach not at the swap location', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'awaiting_approval',
      user: coach('coach-2'),
      userLocationIds: ['loc-other'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })

  it('rejects claiming a swap already targeted at someone else', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ target_id: 'coach-9' }),
      requestedStatus: 'awaiting_approval',
      user: coach('coach-2'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })
})

describe('resolveSwapTransition — targeted accept/decline', () => {
  it('lets the target accept a targeted pending swap', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ target_id: 'coach-2' }),
      requestedStatus: 'awaiting_approval',
      user: coach('coach-2'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('accepted')
    expect(r.swapUpdates).toMatchObject({ status: 'awaiting_approval', target_id: 'coach-2' })
  })

  it('lets the target decline a targeted pending swap', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ target_id: 'coach-2' }),
      requestedStatus: 'rejected',
      user: coach('coach-2'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('declined')
    expect(r.swapUpdates).toMatchObject({ status: 'rejected' })
    expect(r.assignmentOps).toEqual([])
  })

  it('rejects an accept by a non-target coach', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ target_id: 'coach-2' }),
      requestedStatus: 'awaiting_approval',
      user: coach('coach-3'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })
})

describe('resolveSwapTransition — withdraw', () => {
  it('lets the taker withdraw, re-opening to the pool', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'pending',
      user: coach('coach-2'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('withdrawn')
    expect(r.swapUpdates).toMatchObject({ status: 'pending', target_id: null })
  })

  it('rejects withdraw by someone who is not the taker', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'pending',
      user: coach('coach-3'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })
})

describe('resolveSwapTransition — requester cancel', () => {
  it('lets the requester cancel their own pending swap', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'cancelled',
      user: coach('req-1'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('cancelled')
    expect(r.swapUpdates).toMatchObject({ status: 'cancelled' })
  })

  it('lets the requester cancel a claimed (awaiting_approval) swap', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'cancelled',
      user: coach('req-1'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
  })

  it('rejects cancel by a non-requester non-manager', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'cancelled',
      user: coach('coach-2'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })
})

describe('resolveSwapTransition — manager approve finalisation', () => {
  it('reassigns the requester shift to the taker on claim approval (target_id, no target_shift_id)', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'approved',
      user: manager,
      userLocationIds: ['loc-1'],
      reviewNote: 'ok',
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('approved_reassign')
    expect(r.swapUpdates).toMatchObject({ status: 'approved', reviewed_by: 'mgr-1', review_note: 'ok' })
    expect(r.swapUpdates.reviewed_at).toBeTruthy()
    expect(r.assignmentOps).toEqual([
      { id: 'asg-req', set: { profile_id: 'coach-2', status: 'swapped' } },
    ])
  })

  it('does a reciprocal swap when target_shift_id is set', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({
        status: 'awaiting_approval',
        target_id: 'coach-2',
        target_shift_id: 'asg-tgt',
        requester_shift: { id: 'asg-req', profile_id: 'req-1' },
        target_shift: { id: 'asg-tgt', profile_id: 'coach-2' },
      }),
      requestedStatus: 'approved',
      user: manager,
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('approved_swap')
    expect(r.assignmentOps).toEqual(
      expect.arrayContaining([
        { id: 'asg-req', set: { profile_id: 'coach-2', status: 'swapped' } },
        { id: 'asg-tgt', set: { profile_id: 'req-1', status: 'swapped' } },
      ])
    )
  })

  it('drops the shift when approving an untargeted swap', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'approved',
      user: manager,
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('approved_drop')
    expect(r.assignmentOps).toEqual([
      { id: 'asg-req', set: { status: 'cancelled' } },
    ])
  })

  it('lets a manager reject without touching assignments', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'rejected',
      user: manager,
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(true)
    expect(r.effect).toBe('rejected')
    expect(r.assignmentOps).toEqual([])
    expect(r.swapUpdates).toMatchObject({ status: 'rejected', reviewed_by: 'mgr-1' })
  })

  it('rejects a non-manager trying to approve', () => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: 'awaiting_approval', target_id: 'coach-2' }),
      requestedStatus: 'approved',
      user: coach('coach-2'),
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(403)
  })
})

describe('resolveSwapTransition — terminal-state + bad-input guards', () => {
  it.each(['approved', 'rejected', 'cancelled'])('rejects any action on a %s swap', (st) => {
    const r = resolveSwapTransition({
      swap: makeSwap({ status: st }),
      requestedStatus: 'awaiting_approval',
      user: manager,
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(409)
  })

  it('rejects an unknown requestedStatus', () => {
    const r = resolveSwapTransition({
      swap: makeSwap(),
      requestedStatus: 'banana',
      user: manager,
      userLocationIds: ['loc-1'],
    })
    expect(r.ok).toBe(false)
    expect(r.status).toBe(400)
  })

  it('exports the terminal set', () => {
    expect(TERMINAL_SWAP_STATES).toEqual(expect.arrayContaining(['approved', 'rejected', 'cancelled']))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/richardivers/code/un1t-crm-ct && npx vitest run src/lib/swap-lifecycle.test.js`
Expected: FAIL ("Cannot find module './swap-lifecycle'").

- [ ] **Step 3: Implement the resolver**

```js
// src/lib/swap-lifecycle.js
//
// Pure decision function for shift-swap state transitions. The route
// (PUT /api/schedule/swaps/[id]) fetches the swap row (with requester_shift /
// target_shift assignment embeds) and a user, calls resolveSwapTransition,
// then executes the returned swapUpdates + assignmentOps + notify. Keeping the
// logic pure makes the whole lifecycle unit-testable without a DB.
//
// Lifecycle: pending -> awaiting_approval -> (approved | rejected); plus
// cancelled. See docs/superpowers/plans/2026-06-17-coach-today-roster-phase3.md.

import { MANAGER_ROLES } from './schemas'

export const TERMINAL_SWAP_STATES = ['approved', 'rejected', 'cancelled']

// Statuses a client may request on PUT /api/schedule/swaps/[id].
const REQUESTABLE = ['awaiting_approval', 'approved', 'rejected', 'cancelled', 'pending']

function deny(status, error) {
  return { ok: false, status, error, swapUpdates: null, assignmentOps: [], notify: [], effect: 'denied' }
}

/**
 * @param {object} args
 * @param {object} args.swap       full swap row + requester_shift/target_shift embeds (profile_id read)
 * @param {string} args.requestedStatus
 * @param {object} args.user       { id, role }
 * @param {string[]} args.userLocationIds  the caller's location ids
 * @param {string|null} [args.reviewNote]
 * @param {string} [args.nowIso]   injectable timestamp (defaults to new Date().toISOString())
 * @returns {{ ok:boolean, status?:number, error?:string,
 *   swapUpdates:object|null, assignmentOps:Array<{id:string,set:object}>,
 *   notify:Array<{kind:string,to?:string[]}>, effect:string }}
 */
export function resolveSwapTransition({ swap, requestedStatus, user, userLocationIds, reviewNote = null, nowIso }) {
  if (!swap) return deny(404, 'Swap request not found')
  if (!user) return deny(401, 'Unauthorized')
  if (!REQUESTABLE.includes(requestedStatus)) return deny(400, 'Invalid status')

  const isManager = MANAGER_ROLES.includes(user.role)
  const isRequester = swap.requester_id === user.id
  const isTarget = !!swap.target_id && swap.target_id === user.id
  const atLocation = Array.isArray(userLocationIds) && userLocationIds.includes(swap.location_id)

  // Terminal states accept no further transitions.
  if (TERMINAL_SWAP_STATES.includes(swap.status)) {
    return deny(409, `Swap already ${swap.status}`)
  }

  // ── Requester cancels their own swap (any non-terminal state) ──
  if (requestedStatus === 'cancelled') {
    if (isRequester || isManager) {
      return { ok: true, status: 200, effect: 'cancelled', assignmentOps: [], notify: [],
        swapUpdates: { status: 'cancelled' } }
    }
    return deny(403, 'Only the requester or a manager can cancel')
  }

  // ── Coach claim (open) / targeted accept → awaiting_approval ──
  if (requestedStatus === 'awaiting_approval') {
    if (swap.status !== 'pending') return deny(409, 'Swap is not open for accepting')
    if (isRequester) return deny(403, 'You cannot accept your own swap')
    if (!atLocation) return deny(403, 'Not at this location')
    if (swap.target_id == null) {
      // open claim
      return { ok: true, status: 200, effect: 'claimed', assignmentOps: [],
        swapUpdates: { status: 'awaiting_approval', target_id: user.id },
        notify: [
          { kind: 'claim_for_requester', to: [swap.requester_id] },
          { kind: 'claim_for_managers' },
        ] }
    }
    if (isTarget) {
      // targeted accept
      return { ok: true, status: 200, effect: 'accepted', assignmentOps: [],
        swapUpdates: { status: 'awaiting_approval', target_id: user.id },
        notify: [
          { kind: 'accept_for_requester', to: [swap.requester_id] },
          { kind: 'accept_for_managers' },
        ] }
    }
    return deny(403, 'This swap is targeted at someone else')
  }

  // ── Withdraw a claim/acceptance → back to open pending ──
  if (requestedStatus === 'pending') {
    if (swap.status !== 'awaiting_approval') return deny(409, 'Nothing to withdraw')
    if (!isTarget) return deny(403, 'Only the taker can withdraw')
    return { ok: true, status: 200, effect: 'withdrawn', assignmentOps: [],
      swapUpdates: { status: 'pending', target_id: null },
      notify: [{ kind: 'withdraw_for_requester', to: [swap.requester_id] }] }
  }

  // ── Reject: target declines (pending) OR manager rejects (any non-terminal) ──
  if (requestedStatus === 'rejected') {
    const ts = nowIso || new Date().toISOString()
    if (isManager) {
      return { ok: true, status: 200, effect: 'rejected', assignmentOps: [],
        swapUpdates: { status: 'rejected', reviewed_by: user.id, reviewed_at: ts, review_note: reviewNote || null },
        notify: [{ kind: 'decision_for_requester', to: [swap.requester_id] }] }
    }
    if (isTarget && swap.status === 'pending') {
      return { ok: true, status: 200, effect: 'declined', assignmentOps: [],
        swapUpdates: { status: 'rejected' },
        notify: [{ kind: 'decline_for_requester', to: [swap.requester_id] }] }
    }
    return deny(403, 'Only the target or a manager can reject')
  }

  // ── Manager approve: finalise on the assignments ──
  if (requestedStatus === 'approved') {
    if (!isManager) return deny(403, 'Only a manager can approve')
    const ts = nowIso || new Date().toISOString()
    const swapUpdates = { status: 'approved', reviewed_by: user.id, reviewed_at: ts, review_note: reviewNote || null }
    if (swap.target_shift_id) {
      const reqProfile = swap.requester_shift?.profile_id
      const tgtProfile = swap.target_shift?.profile_id
      return { ok: true, status: 200, effect: 'approved_swap', swapUpdates,
        assignmentOps: [
          { id: swap.requester_shift_id, set: { profile_id: tgtProfile, status: 'swapped' } },
          { id: swap.target_shift_id, set: { profile_id: reqProfile, status: 'swapped' } },
        ],
        notify: [{ kind: 'decision_for_requester', to: [swap.requester_id] }] }
    }
    if (swap.target_id) {
      return { ok: true, status: 200, effect: 'approved_reassign', swapUpdates,
        assignmentOps: [
          { id: swap.requester_shift_id, set: { profile_id: swap.target_id, status: 'swapped' } },
        ],
        notify: [
          { kind: 'decision_for_requester', to: [swap.requester_id] },
          { kind: 'decision_for_taker', to: [swap.target_id] },
        ] }
    }
    return { ok: true, status: 200, effect: 'approved_drop', swapUpdates,
      assignmentOps: [{ id: swap.requester_shift_id, set: { status: 'cancelled' } }],
      notify: [{ kind: 'decision_for_requester', to: [swap.requester_id] }] }
  }

  return deny(400, 'Unsupported transition')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/richardivers/code/un1t-crm-ct && npx vitest run src/lib/swap-lifecycle.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
cd /Users/richardivers/code/un1t-crm-ct
git add src/lib/swap-lifecycle.js src/lib/swap-lifecycle.test.js
git commit -m "CT-P3 — pure swap-lifecycle resolver + tests (claim/accept/decline/withdraw/approve)"
```

---

### Task 2: Widen the swap-status enum

**Files:**
- Modify: `src/lib/schemas.js:158`

- [ ] **Step 1: Add `awaiting_approval` to the enum**

Replace:
```js
// Swap request status
export const swapStatusSchema = z.enum(['pending', 'approved', 'rejected', 'cancelled'])
```
with:
```js
// Swap request status. 'awaiting_approval' = a coach has claimed/accepted the
// swap and it's waiting for a manager to finalise (CT-P3). Free TEXT in the
// DB (no CHECK constraint) — this enum is the only gate.
export const swapStatusSchema = z.enum(['pending', 'awaiting_approval', 'approved', 'rejected', 'cancelled'])
```

- [ ] **Step 2: Verify schema tests still pass**

Run: `cd /Users/richardivers/code/un1t-crm-ct && npx vitest run src/lib/schemas.test.js`
Expected: PASS (if a swapStatus assertion exists it should still hold; the enum only widened).

- [ ] **Step 3: Commit**

```bash
cd /Users/richardivers/code/un1t-crm-ct
git add src/lib/schemas.js
git commit -m "CT-P3 — add awaiting_approval to swapStatusSchema (no migration; status is free text)"
```

---

### Task 3: Rewire `PUT /api/schedule/swaps/[id]` onto the resolver

**Files:**
- Modify: `src/app/api/schedule/swaps/[id]/route.js` (full rewrite of the handler body)

- [ ] **Step 1: Replace the route file**

```js
// src/app/api/schedule/swaps/[id]/route.js
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, getUserLocationIds } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { swapStatusSchema } from '@/lib/schemas'
import { resolveSwapTransition } from '@/lib/swap-lifecycle'
import { sendPush, sendPushToRolesAtLocation } from '@/lib/push'
import { MANAGER_ROLES } from '@/lib/schemas'

const SwapReviewSchema = z.object({
  status: swapStatusSchema,
  review_note: z.string().max(2000).nullable().optional(),
})

// PUT /api/schedule/swaps/:id — drive a swap through its lifecycle.
// Coaches: claim / accept / decline / withdraw / cancel-own.
// Managers: approve / reject (finalises on shift_assignments).
export async function PUT(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const validation = await validateBody(request, SwapReviewSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const db = createServerClient()

  // Fetch the swap. requester_shift_id / target_shift_id are shift_assignments.id.
  // Only profile_id is read off the embeds (for the reciprocal-swap reassign).
  const { data: swap } = await db.from('shift_swap_requests')
    .select('*, requester_shift:shift_assignments!requester_shift_id(id, profile_id, block_id), target_shift:shift_assignments!target_shift_id(id, profile_id, block_id)')
    .eq('id', params.id)
    .single()

  const decision = resolveSwapTransition({
    swap,
    requestedStatus: body.status,
    user,
    userLocationIds: getUserLocationIds(user),
    reviewNote: body.review_note ?? null,
  })

  if (!decision.ok) {
    return NextResponse.json({ success: false, error: decision.error }, { status: decision.status })
  }

  // Apply assignment effects first (reassign / reciprocal swap / drop), then
  // the swap row. Assignment writes are awaited so a failure surfaces.
  for (const op of decision.assignmentOps) {
    const { error: opErr } = await db.from('shift_assignments').update(op.set).eq('id', op.id)
    if (opErr) return NextResponse.json({ success: false, error: opErr.message }, { status: 400 })
  }

  const { data, error } = await db.from('shift_swap_requests')
    .update(decision.swapUpdates)
    .eq('id', params.id)
    .select()
    .single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })

  // Best-effort pushes — never block or fail the response.
  dispatchSwapPushes(decision, swap, user).catch(err => console.error('[swaps] push failed', err))

  return NextResponse.json({ success: true, data })
}

// Map the resolver's notify intents to Expo pushes. Bodies live here because
// they need user.full_name and human copy (the resolver stays pure).
async function dispatchSwapPushes(decision, swap, user) {
  const actor = user.full_name || 'A coach'
  for (const n of decision.notify) {
    switch (n.kind) {
      case 'claim_for_requester':
        await sendPush(n.to, { title: 'Shift claimed', body: `${actor} claimed your shift — awaiting manager approval.`, category: 'swap', data: { type: 'swap_claimed', swap_id: swap.id } })
        break
      case 'accept_for_requester':
        await sendPush(n.to, { title: 'Swap accepted', body: `${actor} accepted your swap — awaiting manager approval.`, category: 'swap', data: { type: 'swap_accepted', swap_id: swap.id } })
        break
      case 'claim_for_managers':
      case 'accept_for_managers':
        await sendPushToRolesAtLocation(swap.location_id, MANAGER_ROLES, { title: 'Swap awaiting approval', body: `${actor} took a shift. Tap to approve.`, category: 'swap', data: { type: 'swap_awaiting', swap_id: swap.id } })
        break
      case 'withdraw_for_requester':
        await sendPush(n.to, { title: 'Swap re-opened', body: `${actor} withdrew — your shift is open for swap again.`, category: 'swap', data: { type: 'swap_withdrawn', swap_id: swap.id } })
        break
      case 'decline_for_requester':
        await sendPush(n.to, { title: 'Swap declined', body: `${actor} declined your swap request.`, category: 'swap', data: { type: 'swap_declined', swap_id: swap.id } })
        break
      case 'decision_for_requester':
      case 'decision_for_taker': {
        const verb = decision.swapUpdates.status === 'approved' ? 'approved' : 'declined'
        await sendPush(n.to, { title: `Swap ${verb}`, body: `Your shift swap was ${verb}${decision.swapUpdates.review_note ? ` — “${decision.swapUpdates.review_note}”` : ''}.`, category: 'swap', data: { type: 'swap_decision', swap_id: swap.id, status: decision.swapUpdates.status } })
        break
      }
      default:
        break
    }
  }
}
```

- [ ] **Step 2: Sanity-check imports compile (build)**

Run: `cd /Users/richardivers/code/un1t-crm-ct && npm run build 2>&1 | tail -20`
Expected: build succeeds (catches any import-resolution issue). If a symlinked `node_modules` breaks Turbopack here, rely on the Vercel PR check instead and note it.

- [ ] **Step 3: Commit**

```bash
cd /Users/richardivers/code/un1t-crm-ct
git add 'src/app/api/schedule/swaps/[id]/route.js'
git commit -m "CT-P3 — swaps PUT executes the lifecycle resolver (claim/accept/decline/withdraw/approve-reassign)"
```

---

### Task 4: Add `for_me` / `open` filters to `GET /api/schedule/swaps`

**Files:**
- Modify: `src/app/api/schedule/swaps/route.js` (GET only)

- [ ] **Step 1: Extend the GET handler**

In `GET`, after `const status = searchParams.get('status')`, add:
```js
  const forMe = searchParams.get('for_me') === '1'
  const open = searchParams.get('open') === '1'
```
Then, after the existing `if (status) query = query.eq('status', status)` line, add:
```js
  // CT-P3 actionable lists for coaches. for_me = swaps targeted at / claimed
  // by the caller (needs their accept/decline or shows "awaiting manager").
  // open = unclaimed pool the caller may take (not their own). Names ride
  // along via the service-role profiles embed (works for web + mobile, which
  // can't embed profiles from its authenticated client).
  if (forMe) {
    query = query.eq('target_id', user.id).in('status', ['pending', 'awaiting_approval'])
  } else if (open) {
    query = query.is('target_id', null).eq('status', 'pending').neq('requester_id', user.id)
  }
```

Note: `user` is already available (the GET calls `getCurrentUser()` at the top). If `user` could be null, guard `for_me`/`open` with `if (!user) return NextResponse.json({ success: true, data: [] })` before applying them.

- [ ] **Step 2: Build check**

Run: `cd /Users/richardivers/code/un1t-crm-ct && npm run build 2>&1 | tail -20`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
cd /Users/richardivers/code/un1t-crm-ct
git add src/app/api/schedule/swaps/route.js
git commit -m "CT-P3 — GET /api/schedule/swaps gains for_me + open filters (name-bearing actionable lists)"
```

---

### Task 5: Fix both broken swap embeds in the shared dashboard fetch

**Files:**
- Modify: `shared/dashboard-data.js` (lines ~157-161 `pendingSwapsForMe`, ~184-188 `myPostedSwaps`)

- [ ] **Step 1: Fix `pendingSwapsForMe` (the `swapsTargetingMe` query)**

Replace:
```js
      supabase
        .from('shift_swap_requests')
        .select('id, requester_id, requester_shift_id, reason, created_at, requester:profiles!requester_id(full_name), requester_shift:shifts!requester_shift_id(shift_date, shift_templates(name))')
        .eq('target_id', profileId)
        .eq('status', 'pending'),
```
with:
```js
      // Swaps targeted at this coach that still need their accept/decline.
      // CT-P3: the old embed referenced the dropped public.shifts table AND
      // profiles!requester_id (which 500s on mobile's authenticated client —
      // no profiles grant). Read shift info via shift_assignments only; the
      // requester NAME for the actionable list is fetched client-side from
      // GET /api/schedule/swaps?for_me=1 (service-role).
      supabase
        .from('shift_swap_requests')
        .select('id, requester_id, requester_shift_id, target_id, status, reason, created_at, requester_shift:shift_assignments!requester_shift_id(shift_blocks!block_id(block_date, shift_templates(name)))')
        .eq('target_id', profileId)
        .eq('status', 'pending'),
```

- [ ] **Step 2: Fix `myPostedSwaps` (the template-path bug + status widen)**

Replace:
```js
      supabase
        .from('shift_swap_requests')
        .select('id, status, reason, created_at, target_id, requester_shift_id, requester_shift:shift_assignments!requester_shift_id(shift_blocks!block_id(block_date), shift_templates(name))')
        .eq('requester_id', profileId)
        .eq('status', 'pending'),
```
with:
```js
      // Swaps the coach has POSTED that are still live — pending (nobody took
      // it yet) OR awaiting_approval (someone claimed; pending manager). Used
      // by the Today "My requests" list to show status + cancel.
      // CT-P3 fix: shift_templates must nest UNDER shift_blocks (there is no
      // shift_assignments->shift_templates FK; the old sibling embed errored
      // → this list was silently always empty).
      supabase
        .from('shift_swap_requests')
        .select('id, status, reason, created_at, target_id, requester_shift_id, requester_shift:shift_assignments!requester_shift_id(shift_blocks!block_id(block_date, shift_templates(name)))')
        .eq('requester_id', profileId)
        .in('status', ['pending', 'awaiting_approval']),
```

- [ ] **Step 3: Verify dashboard-data tests (if any) + a live probe of both embeds**

Run: `cd /Users/richardivers/code/un1t-crm-ct && npx vitest run shared 2>&1 | tail -15`
Expected: PASS (or "no test files" — these are IO functions, may be untested).

Because CI never hits the DB, verify the two PostgREST embeds resolve against the live project using the Supabase MCP from the controlling session (not the subagent): a `SELECT` proving the FK path exists is in the plan's Background; the controller will run a one-row PostgREST-shaped check after this task. (Implementer: just make the string edits exactly as above — the controller validates the embeds.)

- [ ] **Step 4: Commit**

```bash
cd /Users/richardivers/code/un1t-crm-ct
git add shared/dashboard-data.js
git commit -m "CT-P3 — fix both swap embeds in shared dashboard fetch (dropped shifts table, profiles-on-mobile 500, template-under-block)"
```

---

### Task 6: Fix the manager approvals provider (embed + status + title)

**Files:**
- Modify: `src/lib/approvals/providers/shift-swaps.js`

- [ ] **Step 1: Fix the embed, widen the status filter, and reflect claimed state**

Replace the `fetchPending` query + mapping (lines ~25-61) so it (a) reads `shift_assignments` correctly (no `start_time`/`end_time` on that table), (b) includes `awaiting_approval`, and (c) labels claimed swaps. New `fetchPending` body:

```js
  async fetchPending(db, user) {
    const activeId = viewerActiveLocationId(user)
    if (!activeId) return { count: 0, items: [] }
    if (!canApproveAtActiveLocation(user, SCHEDULE_APPROVER_ROLES)) {
      return { count: 0, items: [] }
    }

    const q = db
      .from('shift_swap_requests')
      .select(`
        id, reason, created_at, location_id, status,
        requester:requester_id ( id, full_name ),
        target:target_id ( id, full_name ),
        location:location_id ( id, name ),
        requester_shift:requester_shift_id (
          id, start_time_override,
          shift_blocks!block_id ( block_date, start_time, shift_templates ( name ) )
        )
      `)
      // CT-P3: include awaiting_approval (a coach has claimed/accepted; this is
      // exactly the manager's decision queue). 'pending' open/targeted rows
      // still show so a manager can drop/approve directly.
      .in('status', ['pending', 'awaiting_approval'])
      .eq('location_id', activeId)
      .order('created_at', { ascending: false })
      .limit(50)

    const { data, error } = await q
    if (error) throw new Error(`shift_swap_requests: ${error.message}`)

    const items = (data || []).map((r) => {
      const requester = r.requester?.full_name || 'Coach'
      const target = r.target?.full_name
      const blk = r.requester_shift?.shift_blocks
      const tplName = blk?.shift_templates?.name
      const date = blk?.block_date
      const shift = date ? `${tplName ? `${tplName} · ` : ''}${date}` : null
      const claimed = r.status === 'awaiting_approval'
      const base = target ? `${requester} ↔ ${target}` : `${requester} (drop)`
      return {
        id: r.id,
        title: claimed ? `${base} — claimed` : base,
        subtitle: shift ? `Shift: ${shift}` : (r.reason || '—'),
        meta: r.location?.name || null,
        submittedAt: r.created_at,
        amount: null,
        currency: null,
        reviewUrl: `/schedule/swaps?focus=${r.id}`,
      }
    })
    return { count: items.length, items }
  },
```

- [ ] **Step 2: Widen `countPending` to match**

In `countPending`, replace:
```js
      .eq('status', 'pending')
```
with:
```js
      .in('status', ['pending', 'awaiting_approval'])
```

- [ ] **Step 3: Verify approvals registry tests pass**

Run: `cd /Users/richardivers/code/un1t-crm-ct && npx vitest run src/lib/approvals 2>&1 | tail -15`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
cd /Users/richardivers/code/un1t-crm-ct
git add src/lib/approvals/providers/shift-swaps.js
git commit -m "CT-P3 — fix shift-swaps approvals provider (assignment embed, include awaiting_approval, claimed label)"
```

---

### Task 7: Phase 3a review + CI mirror + PR

- [ ] **Step 1: Run the full CI mirror**

```bash
cd /Users/richardivers/code/un1t-crm-ct
npm test 2>&1 | tail -20 && npm run lint 2>&1 | tail -10 && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards
```
Expected: all green. (No new permission key → parity unaffected. No new route → route-guards unaffected; the modified routes keep `getCurrentUser`.)

- [ ] **Step 2: Push + open PR (`base=main`)** — controller handles via `gh`/curl per CLAUDE.md. Title: `CT-P3a — coach swap lifecycle (claim/accept/decline/withdraw) + fix 3 latent swap-embed bugs`. Body must call out: no migration (status is free text); the three embed fixes (pendingSwapsForMe dropped-table+profiles-500, myPostedSwaps template-path, approvals provider start_time + awaiting_approval); the new resolver + tests.

---

## PART B — Phase 3b (UI: Accept/Decline/Claim, open-pool list, targeted picker, "On with you today"). Ships as its own PR after 3a merges.

> Branch 3b off the updated `main` after 3a merges (so the resolver + route filters + fixed embeds are present).

### Task 8: Web — actionable swap surfaces on Today

**Files:**
- Create: `src/components/dashboard/SwapActions.jsx` (client) — "Swaps offered to you" (Accept/Decline) + "Open swaps you can take" (Claim), both fetched from the route.
- Modify: `src/components/dashboard/MyRequests.jsx` — remove the read-only `swapsForMe` block (now handled by SwapActions); keep posted-swaps + time-off. Show `awaiting_approval` posted swaps with the existing amber "Awaiting manager" chip (note: `StatusChip` currently matches `'awaiting_manager'` — update it to also accept `'awaiting_approval'`, or map in the row builder). Render the real status from `s.status` instead of the hard-coded `'pending'`.
- Modify: `src/app/dashboard/today/page.js` — mount `<SwapActions locationId={…} />`; stop passing `swapsForMe`.

- [ ] **Step 1: SwapActions component**

Fetches on mount (client):
- `GET /api/schedule/swaps?location_id=${locationId}&for_me=1` → offered/claimed-by-me. For each `status==='pending'` row render **Accept** (`PUT {status:'awaiting_approval'}`) + **Decline** (`PUT {status:'rejected'}`); for `awaiting_approval` render a **Withdraw** (`PUT {status:'pending'}`) + "Awaiting manager" chip.
- `GET /api/schedule/swaps?location_id=${locationId}&open=1` → open pool. Render **Claim** (`PUT {status:'awaiting_approval'}`).

Use the GET response's embedded `requester.full_name` + `requester_shift.shift_date` + `requester_shift.shift_templates.name` (the route shapes via `swapShiftShape`, so `requester_shift.shift_date` and `requester_shift.shift_templates.name` are present). After any successful PUT, refetch both lists (and `router.refresh()` so MyRequests/MonthRoster re-pull). Match the visual grammar of `MyRequests.jsx` (SectionHeader + ListCard + RequestRow + `Button` from `@/components/ui`). Empty state: render nothing (or a slim "No swaps to action").

- [ ] **Step 2: Targeted-swap colleague picker (web)**

In `MonthRoster.jsx`'s shift-tap menu, the existing **Post for swap** posts an OPEN swap. Add a **Swap with a specific coach…** option that opens a picker (fetch colleagues via `GET /api/staff?location_id=${locationId}`), then `POST /api/schedule/swaps {requester_shift_id: shift.id, target_id: <coachId>}`. Keep the existing open-post action as-is. Reuse the `Modal` primitive; keep it minimal (a searchable list of names).

- [ ] **Step 3: "On with you today" strip (web)**

New small client piece (in `SwapActions.jsx` or a sibling) that fetches `GET /api/schedule/shifts?location_id=${locationId}&start_date=${todayIso}&end_date=${todayIso}` and lists the other coaches on today (exclude self), each with their shift time. Read-only. Place it atop the roster on `today/page.js`.

- [ ] **Step 4: Build + lint (next link rule)**

```bash
cd /Users/richardivers/code/un1t-crm-ct && npm run build 2>&1 | tail -20 && npx next lint 2>&1 | tail -15
```
Expected: green. (Any internal navigation must use `<Link>`, not `<a href>`.)

- [ ] **Step 5: Commit**

```bash
cd /Users/richardivers/code/un1t-crm-ct
git add src/components/dashboard/SwapActions.jsx src/components/dashboard/MyRequests.jsx 'src/app/dashboard/today/page.js' src/components/dashboard/MonthRoster.jsx
git commit -m "CT-P3b (web) — Accept/Decline/Claim swaps, open-pool list, targeted picker, On-with-you-today strip"
```

---

### Task 9: Mobile — mirror the actionable swap surfaces

**Files:**
- Modify: `mobile/lib/schedule-api.js` — add `getSwapsForMe(locationId)`, `getOpenSwaps(locationId)`, `acceptSwap(id)`, `claimSwap(id)`, `declineSwap(id)`, `withdrawSwap(id)` (all via `api()`/`authHeaders()` — never hand-rolled headers). `getTeamShifts({locationId,startDate,endDate})` already exists for "On with you today". Targeted post: extend the existing swap-create helper to accept an optional `targetId`.
- Modify: `mobile/components/dashboard/PersonalDashboard.jsx` — add: "Swaps offered to you" (Accept/Decline, Withdraw if awaiting), "Open swaps you can take" (Claim), targeted-coach option in the shift-tap sheet (reuse `CoachPickerSheet.jsx` + `getLocationStaff`), and an "On with you today" strip. Use `shift.id` (the assignment id) for posting — never `shift.shift_assignment_id` (that field is undefined on dashboard data; this exact bug was fixed in Phase 2).
- Update the My-requests section to read `s.status` (show awaiting_approval) and use the route-fetched lists for offered/open (names) since the shared `pendingSwapsForMe` no longer carries the requester name.

- [ ] **Step 1: schedule-api helpers**

Add the helpers mirroring the existing `createSwapRequest`/`cancelSwapRequest` pattern (PUT `/api/schedule/swaps/[id]` with `{status}`; GET `/api/schedule/swaps?...&for_me=1` / `&open=1`). All through `authHeaders()`.

- [ ] **Step 2: PersonalDashboard wiring + sheets**

Render the two actionable lists + the team strip; wire Accept/Decline/Claim/Withdraw; targeted post via CoachPickerSheet. Refetch on success (and `useFocusEffect` freshness already in place from Phase 1/2).

- [ ] **Step 3: Mobile checks**

```bash
cd /Users/richardivers/code/un1t-crm-ct
npm run check:mobile-imports && npx expo export --platform ios >/dev/null 2>&1 && echo "expo export OK" || echo "expo export FAILED"
```
Run `expo export` from `mobile/` if the root invocation doesn't resolve. Expected: imports resolve + export succeeds (catches the class of bug CI misses for mobile).

- [ ] **Step 4: Commit**

```bash
cd /Users/richardivers/code/un1t-crm-ct
git add mobile/lib/schedule-api.js mobile/components/dashboard/PersonalDashboard.jsx
git commit -m "CT-P3b (mobile) — Accept/Decline/Claim swaps, open-pool list, targeted picker, On-with-you-today strip"
```

---

### Task 10: Phase 3b review + CI mirror + PR

- [ ] **Step 1: Full CI mirror**

```bash
cd /Users/richardivers/code/un1t-crm-ct
npm test 2>&1 | tail -20 && npm run lint 2>&1 | tail -10 && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards
```
Expected: all green.

- [ ] **Step 2: Push + open PR (`base=main`).** Title: `CT-P3b — coach self-service swap UI (accept/decline/claim, open pool, targeted picker, on-with-you-today)`. Body: web + mobile surfaces; depends on 3a; not browser/device-verified (auth-gated).

---

## Out of scope (deferred)
- **Phase 4** — flip `schedule` OFF in the `staff` role default in `shared/permissions.js` (keep `dashboard_personal` on). No migration. Do LAST, after 3a+3b are live and verified, so coaches never lose a capability mid-flight.

## Self-review notes
- Spec coverage: coach self-accept (claim+targeted) ✓ (resolver + route + UI), manager-finalises ✓ (approve reassigns/swaps/drops; provider surfaces awaiting_approval), both open+targeted ✓, "On with you today" ✓. The three latent embed bugs that would otherwise make swaps non-functional are fixed in 3a.
- No migration (status free TEXT — verified). No new permission key (parity-safe).
- Type consistency: resolver returns `{ ok, status, error, swapUpdates, assignmentOps:[{id,set}], notify:[{kind,to}], effect }` — consumed identically in the route. `awaiting_approval` is the single new status string across schema, resolver, route filters, shared fetch, provider, and UI chips.
