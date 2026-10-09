# Event move: settle the price difference (EVENT-MOVE.3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff can mark a moved entry's price difference as collected or waived, so the "€X difference outstanding" chip clears and the history says how it was settled.

**Architecture:** Three nullable columns on `registration_moves` (mig 709). One staff route, `POST /api/event-registrations/[id]/moves/[moveId]/settle`, gated like the move route at the entry's CURRENT event studio, writing with a compare-and-set so a double click cannot settle twice. The teams route's `last_move` carries the new columns; the chip on the teams page gains Collected / Waived buttons and hides once settled. No money moves, ever: this records a decision staff made elsewhere (a payment link, cash, or a waiver).

**Tech Stack:** Postgres (one ALTER), Next.js 16 App Router route (service role), vitest, React component change.

**Spec:** `docs/superpowers/specs/2026-10-08-event-entry-move-design.md`; add the "Settling the gap" paragraph from Task 4 below.

**Worktree:** `~/code/un1t-crm-evmove3`, branch `event-move-gap-settled`, off `origin/main` AFTER #1951 merged.

**Decisions fixed:** staff only (manager role + `races` at the entry's current event studio, the same rule as moving); two outcomes, `collected` and `waived`; recorded on the move row with who and when; a settled gap shows nothing on the card except a note inside the "Moved from" tooltip; idempotent (settling a settled move answers 200 with `unchanged: true`); the host table does not show the gap in PR 2 and gains nothing here.

---

### Task 1: Migration 709

**Files:** Create `supabase/migrations/709_registration_moves_gap_settled.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 709 — EVENT-MOVE.3: record how a moved entry's price difference was settled.
--
-- WHY. A move never moves money (mig 708). When the target event costs more,
-- the teams page shows "€X difference outstanding" and staff collect it with
-- a payment link or waive it; the chip then had no way to clear. These three
-- columns record that decision. Nothing here touches money.
--
-- WHAT. Three nullable columns on registration_moves, written only by the
-- staff settle route (service role), with a compare-and-set on
-- gap_settled_at IS NULL so a double submit cannot overwrite the first
-- answer. Safe to apply before the code deploys.

alter table public.registration_moves
  add column if not exists gap_settled_at timestamptz,
  add column if not exists gap_settled_how text check (gap_settled_how in ('collected', 'waived')),
  add column if not exists gap_settled_by_name text;

comment on column public.registration_moves.gap_settled_at is 'EVENT-MOVE.3 — when staff marked the price difference collected or waived; NULL = outstanding (or no gap).';
comment on column public.registration_moves.gap_settled_how is 'EVENT-MOVE.3 — collected | waived.';
comment on column public.registration_moves.gap_settled_by_name is 'EVENT-MOVE.3 — snapshot of the staff member who settled it.';
```

- [ ] **Step 2:** `npm test -- tests/table-default-acl-guard.test.js tests/migration-708-registration-moves.test.js 2>&1 | tail -4` (the 708 PGlite test must still pass; it applies 708 only). Expected: pass.
- [ ] **Step 3: Commit** `EVENT-MOVE.3 — mig 709: gap_settled_* on registration_moves`.

---

### Task 2: Settle route

**Files:**
- Create `src/app/api/event-registrations/[id]/moves/[moveId]/settle/route.js`
- Create `src/app/api/event-registrations/[id]/moves/[moveId]/settle/route.test.js`
- Modify `src/lib/openapi.js` (register it after the move route's entry)

- [ ] **Step 1: Failing route test** (mirror `src/app/api/event-registrations/[id]/move/route.test.js`'s mocks and `manager()` user builder exactly; read it first)

Cases: 401 no user; 404 when the entry's CURRENT event studio is not the caller's; 403 for a non-manager there; 400 bad body (`how` must be `collected` | `waived`); 404 when the move does not belong to the entry (`registration_id` mismatch) or does not exist; 400 `no_gap` when `price_gap_cents <= 0`; 200 `{ unchanged: true }` when already settled; 200 happy path writes `{ gap_settled_at, gap_settled_how, gap_settled_by_name }` with `.eq('id', moveId).is('gap_settled_at', null).select('id')` and answers the settled row; 500 when the write errors; a lost CAS (zero rows) answers 200 `{ unchanged: true }` (someone else settled it first) and re-reads nothing; the actor name under impersonation is the real caller (copy the move route's actor resolution).

- [ ] **Step 2: Write the route**

```js
// /api/event-registrations/[id]/moves/[moveId]/settle — EVENT-MOVE.3
//
// POST { how: 'collected' | 'waived' } — staff record that a moved entry's
// price difference was collected (by a payment link, cash, …) or waived.
// Records a decision; never moves money. Manager+ holding `races` at the
// entry's CURRENT event studio (the same rule as moving it). Idempotent.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccessOr404, hasRoleAtLocation } from '@/lib/auth'
import { hasPermissionAtAnyLocation, hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { MANAGER_ROLES, uuidLike } from '@/lib/schemas'
import { readRegistrationForMove } from '@/lib/registration-move'
import { logError } from '@/lib/log'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const SettleSchema = z.object({ how: z.enum(['collected', 'waived']) })

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!hasPermissionAtAnyLocation(user, 'races')) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  if (!uuidLike.safeParse(params.id).success || !uuidLike.safeParse(params.moveId).success) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const db = createServerClient()
  const { registration, error: regErr } = await readRegistrationForMove(db, params.id)
  if (regErr) return NextResponse.json({ success: false, error: 'load_failed', message: 'The entry could not be read. Try again.' }, { status: 500 })
  if (!registration) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const locationId = registration.race?.location_id
  if (!locationId) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const guard = assertLocationAccessOr404(user, locationId)
  if (guard) return guard
  if (!hasPermissionForLocation(user, locationId, 'races') || !hasRoleAtLocation(user, locationId, MANAGER_ROLES)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const validation = await validateBody(request, SettleSchema)
  if (!validation.ok) return validation.response

  const { data: move, error: moveErr } = await db
    .from('registration_moves')
    .select('id, registration_id, price_gap_cents, gap_settled_at, gap_settled_how, gap_settled_by_name')
    .eq('id', params.moveId)
    .maybeSingle()
  if (moveErr) return NextResponse.json({ success: false, error: 'load_failed', message: 'The move could not be read. Try again.' }, { status: 500 })
  if (!move || move.registration_id !== params.id) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!(move.price_gap_cents > 0)) return NextResponse.json({ success: false, error: 'no_gap', message: 'This move has no outstanding difference.' }, { status: 400 })
  if (move.gap_settled_at) return NextResponse.json({ success: true, data: { unchanged: true, move } })

  const actorName = user.impersonatingFrom
    ? `${user.impersonatingFrom.masterName || user.impersonatingFrom.masterEmail || 'admin'} as ${user.full_name || user.email || 'staff'}`
    : (user.full_name || user.email || 'staff')
  const patch = { gap_settled_at: new Date().toISOString(), gap_settled_how: validation.data.how, gap_settled_by_name: actorName }
  const { data: rows, error: writeErr } = await db
    .from('registration_moves')
    .update(patch)
    .eq('id', params.moveId)
    .is('gap_settled_at', null)
    .select('id, registration_id, price_gap_cents, gap_settled_at, gap_settled_how, gap_settled_by_name')
  if (writeErr) {
    logError('event-move-settle', 'settle write failed', { err: writeErr, moveId: params.moveId })
    return NextResponse.json({ success: false, error: 'write_failed', message: 'The change could not be saved. Try again.' }, { status: 500 })
  }
  if (!rows || rows.length === 0) return NextResponse.json({ success: true, data: { unchanged: true, move } })
  return NextResponse.json({ success: true, data: { unchanged: false, move: rows[0] } })
}
```

Check how the move route names the impersonation field on the user (`impersonatingFrom` with `masterName`/`masterEmail`) and copy it exactly.

- [ ] **Step 3:** OpenAPI entry (tag `Races`, same shape as the move route's), run the test file + `npm run check:route-guards` + `check:location-scoping` + `check:select-columns` + `check:guardrails`. Arm `no-unchecked-supabase-write` on the new route in `eslint.guardrails.config.mjs` if route files are armed per path there (read the file; if routes are not armed by convention, skip).
- [ ] **Step 4: Commit** `EVENT-MOVE.3 — settle route: collected | waived, CAS, idempotent`.

---

### Task 3: Teams list + chip actions

**Files:**
- Modify `src/lib/registration-move-history.js` (add `gap_settled_at, gap_settled_how, gap_settled_by_name` to the moves-in select) and its test (assert the select names them)
- Modify `src/components/RaceTeamsManager.jsx` and `src/components/RaceTeamsManager.move.test.jsx`

- [ ] **Step 1: Failing component tests** (append to the move test): with `canMoveEntries` and `last_move.price_gap_cents: 1000, gap_settled_at: null` the chip shows two buttons "Collected" and "Waived"; clicking Collected POSTs to `/api/event-registrations/r1/moves/mv1/settle` with `{ how: 'collected' }` and then reloads the list (fetch called again for the teams URL); with `gap_settled_at` set the chip and buttons are absent and the "Moved from" tooltip contains "difference collected by Richard"; without `canMoveEntries` the chip shows but no buttons; a failed POST shows its `message` in the page's red banner.

- [ ] **Step 2: Implement** in `TeamCard`: the outstanding chip renders only when `price_gap_cents > 0 && !gap_settled_at`; beside it, when `canMove`, two `type="button"` text buttons (`text-[11px] text-un1t-accent hover:underline`): Collected / Waived, each `window.confirm`-free (it is reversible only by SQL, so confirm: use `confirm('Mark the €X difference as collected?')` like Cancel entry does); on success `onChanged()`; on failure `onError(j.message || j.error)`. Extend the "Moved from" tooltip with `· difference <how> by <name> on <date>` when settled.

- [ ] **Step 3:** run `npx vitest run src/components/RaceTeamsManager src/lib/registration-move-history.test.js 'src/app/api/events/[id]/teams'`, `check:select-columns`, `check:guardrails`, eslint on touched files.
- [ ] **Step 4: Commit** `EVENT-MOVE.3 — teams page: Collected / Waived on the difference chip`.

---

### Task 4: Spec, gate, PR

- [ ] **Step 1: Spec.** In `docs/superpowers/specs/2026-10-08-event-entry-move-design.md`, under "Staff surface (PR 1)" → UI, add a paragraph "Settling the gap (EVENT-MOVE.3)": the chip's two actions, the three columns, staff-only, CAS, idempotent, tooltip note; and remove "Collect the price gap in one click…" from Open follow-ups.
- [ ] **Step 2:** full CI mirror (the thirteen commands in `CLAUDE.md`), `npm run build`.
- [ ] **Step 3:** push, `gh pr create` titled `EVENT-MOVE.3 — mark a moved entry's price difference collected or waived`, body leading with "🔴 Apply mig 709 before merging (the teams list selects the new columns)". Changelog entry `docs/changelog/entries/<PR>.md`, test, commit, push.
- [ ] **Step 4:** report the PR URL and that mig 709 needs applying.
