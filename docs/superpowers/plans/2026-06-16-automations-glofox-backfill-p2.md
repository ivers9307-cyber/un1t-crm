# Automations — Glofox lead-provisioning BACKFILL (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Add a "Push existing un-linked leads now" button to the Glofox lead-provisioning card that creates Glofox accounts + trials for existing leads not yet in Glofox — chunked, confirm-with-count, idempotent, resumable.

**Architecture:** Phase 1 (PR #544) shipped the hub + the forward automation. Phase 2 adds a one-time backfill. Eligibility (un-linked, emailed, non-ClassPass, not-yet-attempted) is computed by a small SQL RPC (so already-attempted failures are excluded → "remaining" actually reaches 0). A batched runner calls the existing `findOrCreateGlofoxMember` (create+trial, `source='automation'`) per contact with throttle; the client loops batches until done, showing progress. Successful link/create sets `contacts.glofox_member_id` (verified) so contacts drop out naturally; failures get one attempt, land in the Glofox Review queue, and are excluded from re-attempts via their `source='automation'` audit row.

**Tech Stack:** Next.js 16, Supabase (service-role routes + an RPC), Vitest, Tailwind.

**Spec:** `docs/superpowers/specs/2026-06-16-automations-hub-glofox-lead-provisioning-design.md` (SP1 §"Phase 2"). **Branch:** `feat/automations-backfill` off main.

---

### Task 1: Migration — eligibility RPCs

**Files:** Create `supabase/migrations/278_glofox_backfill_rpcs.sql` (NNN = next after 277 → **278**).

- [ ] **Step 1: Write the migration**

```sql
-- 278_glofox_backfill_rpcs.sql — eligibility for the Glofox lead-
-- provisioning backfill (Automations Phase 2). Eligible = a contact at
-- the location with no glofox_member_id, a real email, not a ClassPass
-- shadow, and NOT already create-attempted by the automation (no
-- glofox_push_events row with source='automation'). The last clause is
-- what lets "remaining" reach 0 — permanently-failing contacts get one
-- attempt (which writes an 'automation' event) then drop out.
--
-- SECURITY INVOKER (runs as the caller). Only the service-role backfill
-- route calls these; execute is revoked from anon/authenticated so the
-- RPC isn't exposed via PostgREST to signed-in users.

create or replace function public.glofox_backfill_eligible_count(p_location_id uuid)
returns bigint language sql stable security invoker set search_path = public as $$
  select count(*)::bigint
  from contacts c
  where c.location_id = p_location_id
    and c.glofox_member_id is null
    and c.email is not null
    and coalesce(c.source, '') <> 'classpass'
    and not exists (
      select 1 from glofox_push_events e
      where e.contact_id = c.id and e.source = 'automation'
    );
$$;

create or replace function public.glofox_backfill_eligible_batch(p_location_id uuid, p_limit int)
returns setof contacts language sql stable security invoker set search_path = public as $$
  select c.*
  from contacts c
  where c.location_id = p_location_id
    and c.glofox_member_id is null
    and c.email is not null
    and coalesce(c.source, '') <> 'classpass'
    and not exists (
      select 1 from glofox_push_events e
      where e.contact_id = c.id and e.source = 'automation'
    )
  order by c.created_at asc
  limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

revoke execute on function public.glofox_backfill_eligible_count(uuid) from public, anon, authenticated;
revoke execute on function public.glofox_backfill_eligible_batch(uuid, int) from public, anon, authenticated;
```

- [ ] **Step 2: Apply via Supabase MCP** (`apply_migration`, name `278_glofox_backfill_rpcs`), then `get_advisors(security)` — confirm no NEW findings (SECURITY INVOKER + revoked execute should be clean; the function should NOT appear in the `authenticated_security_definer_function_executable` list).
- [ ] **Step 3: Commit** `git add supabase/migrations/278_glofox_backfill_rpcs.sql && git commit -m "feat(automations): mig 278 glofox backfill eligibility RPCs"`

---

### Task 2: Backfill runner lib

**Files:** Create `src/lib/automations/glofox-backfill.js` + `src/lib/automations/glofox-backfill.test.js`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi } from 'vitest'
import { summariseBackfill, runGlofoxBackfillBatch } from './glofox-backfill.js'

describe('summariseBackfill', () => {
  it('tallies statuses into created/linked/needs_review/failed', () => {
    const out = summariseBackfill([
      { status: 'created' }, { status: 'linked' }, { status: 'created' },
      { status: 'needs_review' }, { status: 'failed' }, { status: 'skipped' },
    ])
    expect(out).toEqual({ processed: 6, created: 2, linked: 1, needs_review: 1, failed: 1, skipped: 1 })
  })
  it('handles empty', () => {
    expect(summariseBackfill([])).toEqual({ processed: 0, created: 0, linked: 0, needs_review: 0, failed: 0, skipped: 0 })
  })
})

describe('runGlofoxBackfillBatch', () => {
  function makeDb(batchRows) {
    return {
      rpc: vi.fn(async (fn) => {
        if (fn === 'glofox_backfill_eligible_batch') return { data: batchRows, error: null }
        if (fn === 'glofox_backfill_eligible_count') return { data: 0, error: null }
        throw new Error(`unexpected rpc ${fn}`)
      }),
    }
  }

  it('calls findOrCreateGlofoxMember create+trial source=automation per contact, returns a summary + remaining', async () => {
    const rows = [
      { id: 'c1', email: 'a@b.com', location_id: 'loc1' },
      { id: 'c2', email: 'c@d.com', location_id: 'loc1' },
    ]
    const db = makeDb(rows)
    db.rpc = vi.fn(async (fn) => {
      if (fn === 'glofox_backfill_eligible_batch') return { data: rows, error: null }
      if (fn === 'glofox_backfill_eligible_count') return { data: 3, error: null } // 3 remain after this batch
      throw new Error(fn)
    })
    const spy = vi.fn(async () => ({ status: 'created' }))
    const res = await runGlofoxBackfillBatch({ db, locationId: 'loc1', limit: 2, _findOrCreateGlofoxMember: spy, _delayMs: 0 })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[0][0]).toMatchObject({ createIfMissing: true, attachTrial: true, source: 'automation', locationId: 'loc1' })
    expect(res.processed).toBe(2)
    expect(res.created).toBe(2)
    expect(res.remaining).toBe(3)
  })

  it('returns processed:0, remaining:0 when nothing is eligible', async () => {
    const db = {
      rpc: vi.fn(async (fn) => {
        if (fn === 'glofox_backfill_eligible_batch') return { data: [], error: null }
        if (fn === 'glofox_backfill_eligible_count') return { data: 0, error: null }
      }),
    }
    const spy = vi.fn()
    const res = await runGlofoxBackfillBatch({ db, locationId: 'loc1', limit: 20, _findOrCreateGlofoxMember: spy, _delayMs: 0 })
    expect(spy).not.toHaveBeenCalled()
    expect(res).toMatchObject({ processed: 0, remaining: 0 })
  })

  it('one contact throwing does not abort the batch', async () => {
    const rows = [{ id: 'c1', email: 'a@b.com', location_id: 'loc1' }, { id: 'c2', email: 'c@d.com', location_id: 'loc1' }]
    const db = {
      rpc: vi.fn(async (fn) => {
        if (fn === 'glofox_backfill_eligible_batch') return { data: rows, error: null }
        if (fn === 'glofox_backfill_eligible_count') return { data: 0, error: null }
      }),
    }
    const spy = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ status: 'created' })
    const res = await runGlofoxBackfillBatch({ db, locationId: 'loc1', limit: 20, _findOrCreateGlofoxMember: spy, _delayMs: 0 })
    expect(res.processed).toBe(2)
    expect(res.failed).toBe(1)
    expect(res.created).toBe(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/lib/automations/glofox-backfill.test.js` → FAIL (module not found).

- [ ] **Step 3: Write the implementation**

```js
// src/lib/automations/glofox-backfill.js
//
// Phase 2 of glofox_lead_provisioning: a one-time, resumable backfill
// that pushes existing un-linked leads into Glofox + attaches the trial.
// Eligibility comes from the mig-278 RPCs (excludes already-attempted so
// "remaining" reaches 0). The client calls the route repeatedly; each
// call processes one bounded, throttled batch.

import { logWarn } from '@/lib/log'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Pure: tally findOrCreateGlofoxMember results by status. */
export function summariseBackfill(results) {
  const out = { processed: 0, created: 0, linked: 0, needs_review: 0, failed: 0, skipped: 0 }
  for (const r of results || []) {
    out.processed += 1
    const s = r?.status
    if (s === 'created') out.created += 1
    else if (s === 'linked') out.linked += 1
    else if (s === 'needs_review') out.needs_review += 1
    else if (s === 'skipped') out.skipped += 1
    else out.failed += 1
  }
  return out
}

/**
 * Process ONE batch of eligible contacts. Returns
 * { ...summary, remaining }. Never throws (per-contact errors counted
 * as failed). `_findOrCreateGlofoxMember` + `_delayMs` are test seams.
 */
export async function runGlofoxBackfillBatch({ db, locationId, limit = 20, _findOrCreateGlofoxMember, _delayMs = 150 }) {
  const findOrCreate = _findOrCreateGlofoxMember
    || (await import('@/lib/glofox-push')).findOrCreateGlofoxMember

  const { data: rows, error } = await db.rpc('glofox_backfill_eligible_batch', {
    p_location_id: locationId,
    p_limit: limit,
  })
  if (error) {
    logWarn('automations.glofox-backfill', 'batch fetch failed', { err: error })
    return { ...summariseBackfill([]), remaining: 0, error: error.message }
  }

  const results = []
  for (const contact of rows || []) {
    try {
      const r = await findOrCreate({
        db, locationId, contact,
        source: 'automation', createIfMissing: true, attachTrial: true,
      })
      results.push(r || { status: 'failed' })
    } catch (e) {
      logWarn('automations.glofox-backfill', `contact ${contact?.id} threw`, { err: e })
      results.push({ status: 'failed' })
    }
    if (_delayMs) await sleep(_delayMs)
  }

  const summary = summariseBackfill(results)

  // Remaining AFTER this batch (eligible set shrinks as member_ids land
  // + 'automation' events are written).
  let remaining = 0
  try {
    const { data: cnt } = await db.rpc('glofox_backfill_eligible_count', { p_location_id: locationId })
    remaining = Number(cnt) || 0
  } catch (e) {
    logWarn('automations.glofox-backfill', 'remaining count failed', { err: e })
  }

  return { ...summary, remaining }
}
```

- [ ] **Step 4: Run to verify pass** — `npx vitest run src/lib/automations/glofox-backfill.test.js` → 5 PASS.
- [ ] **Step 5: Commit** `git add src/lib/automations/glofox-backfill.js src/lib/automations/glofox-backfill.test.js && git commit -m "feat(automations): glofox backfill batch runner + summary"`

---

### Task 3: Backfill API route (count + run)

**Files:** Create `src/app/api/automations/[key]/backfill/route.js` + `.../backfill/route.test.js`. Modify `src/lib/openapi.js`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn(), assertLocationAccess: vi.fn(() => null) }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/automations/glofox-backfill', () => ({ runGlofoxBackfillBatch: vi.fn() }))

import { GET, POST } from './route.js'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { runGlofoxBackfillBatch } from '@/lib/automations/glofox-backfill'

beforeEach(() => { vi.clearAllMocks(); assertLocationAccess.mockReturnValue(null) })
const params = (key = 'glofox_lead_provisioning') => ({ params: Promise.resolve({ key }) })

describe('GET /api/automations/[key]/backfill (count)', () => {
  it('403 for non-manager', async () => {
    getCurrentUser.mockResolvedValue({ role: 'staff' })
    const res = await GET(new Request('http://x/api/automations/glofox_lead_provisioning/backfill?location_id=a0000000-0000-0000-0000-000000000001'), params())
    expect(res.status).toBe(403)
  })
  it('returns the eligible count', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1', locations: [{ id: 'a0000000-0000-0000-0000-000000000001' }] })
    createServerClient.mockReturnValue({ rpc: vi.fn(async () => ({ data: 7, error: null })) })
    const res = await GET(new Request('http://x/api/automations/glofox_lead_provisioning/backfill?location_id=a0000000-0000-0000-0000-000000000001'), params())
    const body = await res.json()
    expect(body).toMatchObject({ success: true, data: { eligible: 7 } })
  })
})

describe('POST /api/automations/[key]/backfill (run batch)', () => {
  it('403 for non-manager', async () => {
    getCurrentUser.mockResolvedValue({ role: 'staff' })
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ location_id: 'a0000000-0000-0000-0000-000000000001' }) }), params())
    expect(res.status).toBe(403)
  })
  it('400 on unknown key', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1' })
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ location_id: 'a0000000-0000-0000-0000-000000000001' }) }), params('nope'))
    expect(res.status).toBe(400)
  })
  it('runs a batch and returns the summary', async () => {
    getCurrentUser.mockResolvedValue({ role: 'owner', id: 'u1' })
    createServerClient.mockReturnValue({})
    runGlofoxBackfillBatch.mockResolvedValue({ processed: 2, created: 2, linked: 0, needs_review: 0, failed: 0, skipped: 0, remaining: 5 })
    const res = await POST(new Request('http://x', { method: 'POST', body: JSON.stringify({ location_id: 'a0000000-0000-0000-0000-000000000001' }) }), params())
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({ processed: 2, remaining: 5 })
    expect(runGlofoxBackfillBatch).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run → FAIL** (`npx vitest run "src/app/api/automations/[key]/backfill/route.test.js"`).

- [ ] **Step 3: Write the route**

```js
// GET (count) + POST (run one batch) — Glofox lead-provisioning backfill.
import { z } from 'zod'
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { getAutomation } from '@/lib/automations/registry'
import { runGlofoxBackfillBatch } from '@/lib/automations/glofox-backfill'

export const runtime = 'nodejs'
export const maxDuration = 300

const BATCH = 20

function unauthorized() {
  return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
}

export async function GET(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) return unauthorized()
  const { key } = await params
  if (key !== 'glofox_lead_provisioning' || !getAutomation(key)) {
    return NextResponse.json({ success: false, error: 'unknown_automation' }, { status: 400 })
  }
  const locationId = new URL(request.url).searchParams.get('location_id')
  if (!locationId) return NextResponse.json({ success: false, error: 'missing location_id' }, { status: 400 })
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const { data, error } = await db.rpc('glofox_backfill_eligible_count', { p_location_id: locationId })
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data: { eligible: Number(data) || 0 } })
}

const PostSchema = z.object({ location_id: uuidLike })

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) return unauthorized()
  const { key } = await params
  if (key !== 'glofox_lead_provisioning' || !getAutomation(key)) {
    return NextResponse.json({ success: false, error: 'unknown_automation' }, { status: 400 })
  }
  const validation = await validateBody(request, PostSchema)
  if (!validation.ok) return validation.response
  const guard = assertLocationAccess(user, validation.data.location_id)
  if (guard) return guard

  const db = createServerClient()
  const result = await runGlofoxBackfillBatch({ db, locationId: validation.data.location_id, limit: BATCH })
  return NextResponse.json({ success: true, data: result })
}
```

- [ ] **Step 4: Run → PASS** (5 tests).
- [ ] **Step 5: openapi** — register `GET` + `POST` `/api/automations/{key}/backfill` in `src/lib/openapi.js`, matching the adjacent `registerPath` style (POST body = `{ location_id: uuidLike }`; GET query param `location_id`; `{success,data}` responses). `npm run build` after.
- [ ] **Step 6: Commit** `git add "src/app/api/automations/[key]/backfill/route.js" "src/app/api/automations/[key]/backfill/route.test.js" src/lib/openapi.js && git commit -m "feat(automations): backfill count + run-batch route"`

---

### Task 4: Card button + confirm + progress

**Files:** Modify `src/components/automations/AutomationsView.jsx`.

- [ ] **Step 1: Add backfill UI to `AutomationCard`.** Replace the Phase-2 placeholder comment block (`{/* Phase 2: "Push existing un-linked leads" button renders here when card.supportsBackfill */}`) with a real control. Add this state + handler inside `AutomationCard` (alongside the existing toggle state):

```jsx
  const [bf, setBf] = useState({ phase: 'idle', eligible: null, done: 0, created: 0, linked: 0, needs_review: 0, failed: 0, error: null })

  async function openBackfill() {
    setBf((s) => ({ ...s, phase: 'counting', error: null }))
    try {
      const res = await fetch(`/api/automations/${card.key}/backfill?location_id=${encodeURIComponent(locationId)}`)
      const j = await res.json()
      if (!res.ok || j.success === false) throw new Error(j.error || 'Count failed')
      setBf((s) => ({ ...s, phase: 'confirm', eligible: j.data.eligible }))
    } catch (e) { setBf((s) => ({ ...s, phase: 'idle', error: e.message })) }
  }

  async function runBackfill() {
    setBf((s) => ({ ...s, phase: 'running', error: null, done: 0, created: 0, linked: 0, needs_review: 0, failed: 0 }))
    try {
      // Loop bounded batches until the server reports remaining === 0.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const res = await fetch(`/api/automations/${card.key}/backfill`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ location_id: locationId }),
        })
        const j = await res.json()
        if (!res.ok || j.success === false) throw new Error(j.error || 'Backfill failed')
        const d = j.data
        setBf((s) => ({
          ...s,
          done: s.done + d.processed,
          created: s.created + d.created,
          linked: s.linked + d.linked,
          needs_review: s.needs_review + d.needs_review,
          failed: s.failed + d.failed,
          eligible: d.remaining + (s.done + d.processed),
        }))
        if (d.processed === 0 || d.remaining === 0) break
      }
      setBf((s) => ({ ...s, phase: 'done' }))
      router.refresh()
    } catch (e) { setBf((s) => ({ ...s, phase: 'done', error: e.message })) }
  }
```

Then render, inside the bottom `<div className="mt-3 border-t ...">` (after the "Recent failures" link), when `card.supportsBackfill && card.status.available`:

```jsx
        {card.supportsBackfill && card.status.available && (
          <div className="mt-2">
            {bf.phase === 'idle' && (
              <button type="button" onClick={openBackfill} disabled={!locationId}
                className="text-xs underline text-un1t-light hover:text-un1t-white">
                Push existing un-linked leads…
              </button>
            )}
            {bf.phase === 'counting' && <p className="text-[11px] text-un1t-light">Counting eligible leads…</p>}
            {bf.phase === 'confirm' && (
              <div className="text-xs text-un1t-white bg-amber-500/10 border border-amber-500/30 rounded p-2">
                This will create <b>{bf.eligible}</b> Glofox account{bf.eligible === 1 ? '' : 's'} + trial{bf.eligible === 1 ? '' : 's'} for existing un-linked leads.
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={runBackfill} disabled={!bf.eligible}
                    className="px-2 py-1 rounded bg-un1t-text text-un1t-bg font-semibold disabled:opacity-40">
                    {bf.eligible ? 'Run now' : 'Nothing to do'}
                  </button>
                  <button type="button" onClick={() => setBf((s) => ({ ...s, phase: 'idle' }))} className="px-2 py-1 underline text-un1t-light">Cancel</button>
                </div>
              </div>
            )}
            {bf.phase === 'running' && (
              <p className="text-[11px] text-un1t-light inline-flex items-center gap-1">
                <Loader2 size={11} className="animate-spin" /> Pushing… {bf.done} done{bf.eligible != null ? ` / ${bf.eligible}` : ''} (created {bf.created}, linked {bf.linked}, review {bf.needs_review})
              </p>
            )}
            {bf.phase === 'done' && (
              <p className="text-[11px] text-emerald-700">
                Done — {bf.created} created, {bf.linked} linked{bf.needs_review ? `, ${bf.needs_review} need review` : ''}{bf.failed ? `, ${bf.failed} failed` : ''}.
                {(bf.needs_review || bf.failed) ? <> See <Link href={card.reviewBase} className="underline">Review</Link>.</> : null}
              </p>
            )}
            {bf.error && <p className="text-[11px] text-red-700 mt-1">{bf.error}</p>}
          </div>
        )}
```

(`useState`, `Loader2`, `Link`, `router` are already imported/in-scope in this file.)

- [ ] **Step 2: Build** — `npm run build` completes; `npm run lint` 0 errors.
- [ ] **Step 3: Commit** `git add src/components/automations/AutomationsView.jsx && git commit -m "feat(automations): backfill button + confirm + progress on the card"`

---

### Task 5: CI + ship

- [ ] **Step 1:** `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run build` → all pass. (`check:route-guards`: the new backfill route has `getCurrentUser` → session-guarded.)
- [ ] **Step 2:** push, open PR (`feat: Automations — Glofox lead-provisioning backfill (Phase 2)`), body summarising the button + RPC + idempotency.
- [ ] **Step 3:** watch CI, squash-merge, delete branch, confirm main green.

---

## Self-Review

- **Spec coverage:** SP1 §Phase2 "push existing un-linked leads button" → Tasks 1–4. Confirm-with-count (Task 3 GET + Task 4 confirm), chunked (BATCH=20 + RPC limit cap 50), idempotent/resumable (member_id persisted + `source='automation'` exclusion), failures→Review (existing queue, linked from card). ✓
- **Placeholders:** mig number 278 resolved; openapi registration (Task 3 Step 5) follows the adjacent pattern (mechanical). No TBDs.
- **Type consistency:** `runGlofoxBackfillBatch({ db, locationId, limit, _findOrCreateGlofoxMember, _delayMs })` + return `{ processed, created, linked, needs_review, failed, skipped, remaining }` consistent across lib (Task 2), route (Task 3), card (Task 4). RPC names `glofox_backfill_eligible_count` / `glofox_backfill_eligible_batch` identical in mig (Task 1), lib (Task 2). `source: 'automation'` matches the mig-277 CHECK value.
- **Safety:** backfill only runs on explicit operator click, behind a count+confirm; gated to manager+ / assertLocationAccess / Glofox-connected card; idempotent so a closed-tab/re-click resumes; each contact attempted at most once (no re-hammering failures).
