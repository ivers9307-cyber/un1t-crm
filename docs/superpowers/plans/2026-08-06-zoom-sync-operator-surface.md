# Zoom Sync Operator Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Zoom Phone contact sync operable without a terminal — health status, run history, a report of the contacts it cannot use, and preview / run / guard-override controls.

**Architecture:** One new table (`zoom_sync_runs`) written from inside `runZoomContactSync()` so every trigger is recorded by construction. The rejected-contacts report reuses the sync's own code path via a collect mode on `buildDesiredContacts()` rather than a second query, so it cannot drift. One API route and one settings page compose those.

**Tech Stack:** Next.js 16 App Router (Node runtime), Supabase, Vitest, Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-06-zoom-sync-operator-surface-design.md`

---

## Codebase invariants

Read before writing anything. Each is in `CLAUDE.md` and each has broken production here before.

1. **Service-role routes get NO RLS.** `createServerClient()` bypasses it. Enforce access in app code — `getCurrentUser()`, a role check, and an org-membership check. "What filters this if I delete the RLS policy?" must not answer "nothing".
2. **A RESTRICTIVE `FOR ALL` policy denies SELECT too**, silently, returning an empty set rather than an error. Write denial goes per-command. `npm run check:rls-restrictive` gates it.
3. **Supabase builders are thenables, not Promises** — no `.catch()`. Use `try { await … } catch {}`.
4. **`.insert()`/`.update()` must be awaited** or the request never fires.
5. **1,000-row select cap** regardless of `.limit()`. Anything unbounded needs `.range()` paging.
6. **Every `<button>` in a `<form>` defaults to `type="submit"`** — set `type="button"` on every non-submit.
7. **Status chips are `bg-<c>-500/10 text-<c>-700`** — never the dark-theme recipe. Lint-enforced.
8. **New `WEB_PERMISSIONS` key needs a mobile counterpart or a `WEB_ONLY_OK` entry.** `check:mobile-parity` forces the choice.
9. **Register new routes in `src/lib/openapi.js`.**

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/487_zoom_sync_runs.sql` | The run-history table |
| `src/lib/zoom/desired-contacts.js` | *Modify* — optional collect mode returning rejected rows with a reason |
| `src/lib/zoom/sync-runs.js` | Record a run, read history, prune. Pure DB access, no sync logic |
| `src/lib/zoom/reconcile.js` | *Modify* — call the recorder around the existing body |
| `src/lib/integration-health.js` | *Modify* — one Zoom row |
| `src/app/api/integrations/zoom-contacts/run/route.js` | The operator action |
| `src/app/settings/integrations/zoom-contacts/page.js` | The detail page |
| `shared/permissions.js` + `src/lib/openapi.js` + `docs/CHANGELOG.md` | Registration |

---

### Task 1: `zoom_sync_runs` migration

**Files:** Create `supabase/migrations/487_zoom_sync_runs.sql`

- [ ] **Step 1: Write the migration**

```sql
-- ZOOMOPS.1 — run history for the Zoom Phone contact sync.
--
-- cron_heartbeats.last_outcome (mig 486) holds ONE row and is overwritten
-- nightly, so "did last Tuesday also trip the guard?" is unanswerable. This is
-- the history behind that single value.
--
-- Written from inside runZoomContactSync() rather than by its callers, so every
-- trigger is recorded exactly once by construction and a future third trigger
-- inherits history for free.
--
-- organization_id is populated from day one even though only one value can
-- occur today (ZOOM_SYNC_ORGANIZATION_ID). Adding a tenant column to a table
-- that already holds live history means backfilling rows whose tenant must be
-- inferred — the migration that goes wrong. It costs nothing now.

CREATE TABLE IF NOT EXISTS public.zoom_sync_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,              -- NULL on an old row = the run died mid-flight
  trigger           text NOT NULL CHECK (trigger IN ('cron','manual')),
  triggered_by      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  dry               boolean NOT NULL DEFAULT false,
  forced            boolean NOT NULL DEFAULT false,
  limit_applied     integer,
  creates           integer,
  updates           integer,
  deletes           integer,
  enqueued          integer,
  guard_tripped     boolean NOT NULL DEFAULT false,
  guard_threshold   integer,
  guard_attempted   integer,
  guard_sample      text[],
  owned_in_zoom     integer,
  stats             jsonb,
  error             text
);

CREATE INDEX IF NOT EXISTS idx_zoom_sync_runs_recent
  ON public.zoom_sync_runs (organization_id, started_at DESC);

COMMENT ON COLUMN public.zoom_sync_runs.finished_at IS
  'NULL on a row older than a few minutes means the run crashed mid-flight — otherwise invisible.';
COMMENT ON COLUMN public.zoom_sync_runs.guard_sample IS
  'First 10 numbers the deletion guard refused. Rendered in the force-override confirmation so an operator approves a list they can read, not a count.';

ALTER TABLE public.zoom_sync_runs ENABLE ROW LEVEL SECURITY;

-- Reads only, and only for staff whose profile is attached to a location in the
-- run's organisation. Writes are service-role (the sync) and therefore bypass
-- RLS entirely — deliberately NO write policy rather than a restrictive one,
-- because a RESTRICTIVE ... FOR ALL ... USING (false) would also fold away this
-- SELECT policy and silently return an empty set (mig 483/485 class).
CREATE POLICY zoom_sync_runs_select ON public.zoom_sync_runs
  FOR SELECT TO authenticated
  USING (
    organization_id IN (
      SELECT l.organization_id FROM public.locations l
      JOIN public.profile_locations pl ON pl.location_id = l.id
      WHERE pl.profile_id = (SELECT auth.uid())
    )
  );
```

- [ ] **Step 2: Verify it parses and check the referenced tables exist**

Run: `grep -c "CREATE TABLE\|CREATE POLICY" supabase/migrations/487_zoom_sync_runs.sql`
Expected: `2`

Confirm `organizations`, `profiles`, `profile_locations` and `locations` all exist by searching the migrations directory:
Run: `grep -rl "CREATE TABLE IF NOT EXISTS public.organizations\|CREATE TABLE public.organizations" supabase/migrations/ | head -1`
Expected: a filename (mig 079).

- [ ] **Step 3: Do NOT apply it**

Applying to the live database is a deploy-time step for whoever merges. Writing the file is the whole task.

- [ ] **Step 4: Run the RLS guardrail**

Run: `npm run check:rls-restrictive`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/487_zoom_sync_runs.sql
git commit -m "ZOOMOPS.1 — zoom_sync_runs table for sync history"
```

---

### Task 2: Collect mode on the desired-state builder

The rejected report must share the sync's code path. A separate query would agree on the day it was written and diverge at the first normaliser change — and a report that confidently lists the wrong contacts is worse than none, because people act on it.

**Files:**
- Modify: `src/lib/zoom/desired-contacts.js`
- Test: `src/lib/zoom/desired-contacts.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/zoom/desired-contacts.test.js` (the file already defines `stubDb` and `row` helpers — reuse them):

```javascript
describe('buildDesiredContacts — collect mode', () => {
  it('returns nothing extra when collectRejects is off', async () => {
    const res = await buildDesiredContacts(stubDb([row({ id: 'a', phone: '12345' })]))
    expect(res.rejects).toBeUndefined()
    expect(res.stats.rejected).toBe(1)
  })

  it('collects each rejection with a reason code', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'ok', phone: '+353871111111' }),
      row({ id: 'nophone', phone: null }),
      row({ id: 'junk', phone: 'boothjody@gmail.com' }),
      row({ id: 'noname', first_name: '  ', last_name: null, phone: '+353872222222' }),
    ]), { collectRejects: true })

    const byId = Object.fromEntries(res.rejects.map((r) => [r.id, r]))
    expect(byId.nophone.reason).toBe('no_phone')
    expect(byId.junk.reason).toBe('unparseable')
    expect(byId.noname.reason).toBe('no_name')
    expect(byId.ok).toBeUndefined()
  })

  it('carries the name and raw value so the report is readable', async () => {
    const res = await buildDesiredContacts(stubDb([
      row({ id: 'j', first_name: 'Aoife', last_name: 'Ryan', phone: '085143”754' }),
    ]), { collectRejects: true })
    expect(res.rejects[0]).toMatchObject({ id: 'j', name: 'Aoife Ryan', phone: '085143”754', reason: 'unparseable' })
  })

  // The test that keeps the report honest. If these ever disagree, the report
  // is lying about the sync's own behaviour.
  it('collect mode produces exactly the counts that counting mode reports', async () => {
    const rows = [
      row({ id: 'a', phone: '+353871111111' }),
      row({ id: 'b', phone: null }),
      row({ id: 'c', phone: '12345' }),
      row({ id: 'd', phone: '6978291516' }),
      row({ id: 'e', first_name: '', last_name: '', phone: '+353873333333' }),
      row({ id: 'f', phone: '+353874444444', lead_source: 'classpass' }),
    ]
    const counted = await buildDesiredContacts(stubDb(rows))
    const collected = await buildDesiredContacts(stubDb(rows), { collectRejects: true })

    expect(collected.stats).toEqual(counted.stats)
    expect(collected.rejects.filter((r) => r.reason === 'no_phone').length
      + collected.rejects.filter((r) => r.reason === 'unparseable').length)
      .toBe(counted.stats.rejected)
    expect(collected.rejects.filter((r) => r.reason === 'no_name').length)
      .toBe(counted.stats.noName)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/zoom/desired-contacts.test.js`
Expected: FAIL — `Cannot read properties of undefined (reading 'map')` on `res.rejects`.

- [ ] **Step 3: Implement collect mode**

In `src/lib/zoom/desired-contacts.js`, change the signature (currently `buildDesiredContacts(db)` at line 89) and the three skip points.

Signature:

```javascript
/**
 * @param {object} db
 * @param {object} [opts]
 * @param {boolean} [opts.collectRejects] — also return the rejected rows with a
 *   reason code. Off by default so the nightly run pays nothing for it. This is
 *   deliberately the SAME code path the sync uses: a separate "which rows would
 *   be skipped" query is a second source of truth that drifts at the first
 *   normaliser change.
 */
export async function buildDesiredContacts(db, { collectRejects = false } = {}) {
```

Immediately after the `stats` object is declared, add:

```javascript
  const rejects = collectRejects ? [] : null
  const note = (row, reason) => {
    if (rejects) rejects.push({ id: String(row.id), name: nameOf(row), phone: row.phone ?? null, reason })
  }
```

Then change the three skip points inside the row loop. The phone check currently reads `if (!e164) { stats.rejected++; continue }` — it must distinguish a missing value from an unusable one:

```javascript
      const e164 = normaliseForZoom(row.phone)
      if (!e164) {
        stats.rejected++
        note(row, String(row.phone ?? '').trim() ? 'unparseable' : 'no_phone')
        continue
      }
      if (!nameOf(row)) { stats.noName++; note(row, 'no_name'); continue }
```

And the return:

```javascript
  return { ok: true, desired, stats, ...(rejects ? { rejects } : {}) }
```

Leave the ClassPass skip alone — an excluded row is not a rejected one, and putting 1,613 placeholder rows in an operator's report would bury the ~89 that are actionable.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/zoom/desired-contacts.test.js`
Expected: PASS, all pre-existing tests still green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/zoom/desired-contacts.js src/lib/zoom/desired-contacts.test.js
git commit -m "ZOOMOPS.1 — collect mode: rejected rows with a reason, same code path"
```

---

### Task 3: The run recorder

**Files:**
- Create: `src/lib/zoom/sync-runs.js`
- Test: `src/lib/zoom/sync-runs.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/zoom/sync-runs.test.js
import { describe, it, expect, vi } from 'vitest'
import { outcomePatch, PRUNE_DAYS } from './sync-runs'

describe('outcomePatch', () => {
  it('maps a clean run', () => {
    const p = outcomePatch({
      ok: true, counts: { creates: 3, updates: 1, deletes: 0 }, enqueued: 4,
      guardTripped: false, ownedInZoom: 199, stats: { scanned: 10 },
    })
    expect(p).toMatchObject({
      creates: 3, updates: 1, deletes: 0, enqueued: 4,
      guard_tripped: false, owned_in_zoom: 199, stats: { scanned: 10 }, error: null,
    })
    expect(p.finished_at).toBeTypeOf('string')
  })

  it('carries the guard verdict and its sample when tripped', () => {
    const p = outcomePatch({
      ok: false, counts: { creates: 0, updates: 0, deletes: 0 }, enqueued: 0,
      guardTripped: true,
      guard: { threshold: 20, attempted: 400, sample: ['+353871111111', '+353872222222'] },
    })
    expect(p.guard_tripped).toBe(true)
    expect(p.guard_threshold).toBe(20)
    expect(p.guard_attempted).toBe(400)
    expect(p.guard_sample).toEqual(['+353871111111', '+353872222222'])
  })

  it('records an error result', () => {
    const p = outcomePatch({ ok: false, error: 'zoom down' })
    expect(p.error).toBe('zoom down')
    expect(p.creates).toBeNull()
  })

  it('records an unconfigured skip as a finished run, not a failure', () => {
    const p = outcomePatch({ skipped: 'unconfigured' })
    expect(p.error).toBeNull()
    expect(p.finished_at).toBeTypeOf('string')
  })

  it('prunes at 90 days', () => {
    expect(PRUNE_DAYS).toBe(90)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/zoom/sync-runs.test.js`
Expected: FAIL — `Failed to resolve import "./sync-runs"`.

- [ ] **Step 3: Implement**

```javascript
// src/lib/zoom/sync-runs.js
//
// ZOOMOPS.1 — run history for the Zoom contact sync.
//
// Pure DB access plus one pure mapper. No sync logic lives here; reconcile.js
// calls startRun() before it works and finishRun() after, so every trigger is
// recorded exactly once regardless of who invoked it.

import { logWarn } from '@/lib/log'

export const PRUNE_DAYS = 90
const HISTORY_LIMIT = 30

/** Pure: a runZoomContactSync() result → the columns that close out its row. */
export function outcomePatch(out) {
  const o = out || {}
  return {
    finished_at: new Date().toISOString(),
    creates: o.counts?.creates ?? null,
    updates: o.counts?.updates ?? null,
    deletes: o.counts?.deletes ?? null,
    enqueued: o.enqueued ?? null,
    guard_tripped: Boolean(o.guardTripped),
    guard_threshold: o.guard?.threshold ?? null,
    guard_attempted: o.guard?.attempted ?? null,
    guard_sample: o.guard?.sample ?? null,
    owned_in_zoom: o.ownedInZoom ?? null,
    stats: o.stats ?? null,
    error: o.error ?? null,
  }
}

/**
 * Best-effort throughout: history is observability, and failing to record a run
 * must never fail the run itself. Returns the row id, or null if recording
 * failed — callers pass that straight back to finishRun(), which no-ops on null.
 */
export async function startRun(db, { organizationId, trigger, triggeredBy = null, dry, forced, limit }) {
  try {
    const { data, error } = await db
      .from('zoom_sync_runs')
      .insert({
        organization_id: organizationId ?? null,
        trigger,
        triggered_by: triggeredBy,
        dry: Boolean(dry),
        forced: Boolean(forced),
        limit_applied: Number.isFinite(limit) ? limit : null,
      })
      .select('id')
      .single()
    if (error) { logWarn('zoom-sync-runs', 'startRun failed', { err: error.message }); return null }
    return data?.id ?? null
  } catch (err) {
    logWarn('zoom-sync-runs', 'startRun threw', { err: err?.message })
    return null
  }
}

export async function finishRun(db, runId, out) {
  if (!runId) return
  try {
    await db.from('zoom_sync_runs').update(outcomePatch(out)).eq('id', runId)
  } catch (err) {
    logWarn('zoom-sync-runs', 'finishRun threw', { err: err?.message })
  }
}

export async function listRuns(db, organizationId, limit = HISTORY_LIMIT) {
  try {
    const { data, error } = await db
      .from('zoom_sync_runs')
      .select('*')
      .eq('organization_id', organizationId)
      .order('started_at', { ascending: false })
      .limit(limit)
    if (error) return []
    return Array.isArray(data) ? data : []
  } catch { return [] }
}

/**
 * Runs at the end of each sync rather than on its own cron: a prune that only
 * fires when the sync fires needs no separate heartbeat, and an unconfigured
 * tenant generates no rows to prune.
 */
export async function pruneRuns(db) {
  const cutoff = new Date(Date.now() - PRUNE_DAYS * 86400_000).toISOString()
  try {
    await db.from('zoom_sync_runs').delete().lt('started_at', cutoff)
  } catch (err) {
    logWarn('zoom-sync-runs', 'prune threw', { err: err?.message })
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/zoom/sync-runs.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/zoom/sync-runs.js src/lib/zoom/sync-runs.test.js
git commit -m "ZOOMOPS.1 — run-history recorder"
```

---

### Task 4: Wire the recorder into the sync

**Files:**
- Modify: `src/lib/zoom/reconcile.js`
- Test: `src/lib/zoom/reconcile.orchestrator.test.js`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/zoom/reconcile.orchestrator.test.js`. Extend the existing `vi.mock` block set with:

```javascript
vi.mock('./sync-runs', () => ({
  startRun: vi.fn(async () => 'run-1'),
  finishRun: vi.fn(async () => {}),
  pruneRuns: vi.fn(async () => {}),
}))
```

and import them alongside the existing imports:

```javascript
import { startRun, finishRun, pruneRuns } from './sync-runs'
```

Then append:

```javascript
describe('runZoomContactSync — run recording', () => {
  it('records a run and closes it out', async () => {
    await runZoomContactSync({ trigger: 'cron' })
    expect(startRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ trigger: 'cron' }))
    expect(finishRun).toHaveBeenCalledWith(expect.anything(), 'run-1', expect.objectContaining({ ok: true }))
  })

  it('passes the manual trigger and actor through', async () => {
    await runZoomContactSync({ trigger: 'manual', triggeredBy: 'user-9', limit: 5 })
    expect(startRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      trigger: 'manual', triggeredBy: 'user-9', limit: 5,
    }))
  })

  it('closes out the row even when the run fails', async () => {
    vi.mocked(listOwnedContacts).mockResolvedValue({ ok: false, error: 'zoom down' })
    await runZoomContactSync({ trigger: 'cron' })
    expect(finishRun).toHaveBeenCalledWith(expect.anything(), 'run-1', expect.objectContaining({ error: 'zoom down' }))
  })

  it('does not record an unconfigured skip — nothing ran', async () => {
    vi.mocked(zoomConfigured).mockReturnValue(false)
    await runZoomContactSync({})
    expect(startRun).not.toHaveBeenCalled()
  })

  it('prunes after a real run but not after a dry one', async () => {
    vi.mocked(pruneRuns).mockClear()
    await runZoomContactSync({ dry: true })
    expect(pruneRuns).not.toHaveBeenCalled()
    await runZoomContactSync({})
    expect(pruneRuns).toHaveBeenCalled()
  })
})
```

Add `vi.mocked(startRun).mockClear()` and `vi.mocked(finishRun).mockClear()` to the existing `beforeEach`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/zoom/reconcile.orchestrator.test.js`
Expected: FAIL — `startRun` not called.

- [ ] **Step 3: Implement**

In `src/lib/zoom/reconcile.js`, add the import:

```javascript
import { startRun, finishRun, pruneRuns } from './sync-runs'
```

Change the signature (currently line 102) to accept the trigger metadata, and wrap the existing body. The existing body is unchanged — only the entry and the exits gain recording:

```javascript
export async function runZoomContactSync({
  db, dry = false, limit = null, force = false,
  trigger = 'cron', triggeredBy = null,
} = {}) {
  // Deliberately before startRun: an unconfigured tenant did not run, so
  // recording a row would put a permanent stream of no-ops in the history of
  // every tenant that never connects Zoom.
  if (!zoomConfigured()) return { skipped: 'unconfigured' }

  const runId = await startRun(db, {
    organizationId: process.env.ZOOM_SYNC_ORGANIZATION_ID || null,
    trigger, triggeredBy, dry, forced: force, limit,
  })

  const out = await runZoomContactSyncBody({ db, dry, limit, force })

  await finishRun(db, runId, out)
  // A dry run changed nothing; leave pruning to runs that actually did work.
  if (!dry) await pruneRuns(db)
  return out
}
```

Rename the existing function body to `runZoomContactSyncBody` — take everything from the current `const desiredRes = await buildDesiredContacts(db)` line through the final `return { … }` and move it into:

```javascript
async function runZoomContactSyncBody({ db, dry, limit, force }) {
  // …existing body, unchanged…
}
```

Leave every existing behaviour intact. The only change is where the body lives and what wraps it.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/zoom/`
Expected: PASS, every zoom test file green including the 8 pre-existing orchestrator tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/zoom/reconcile.js src/lib/zoom/reconcile.orchestrator.test.js
git commit -m "ZOOMOPS.1 — record every sync run from inside the orchestrator"
```

---

### Task 5: Pass the trigger from the cron route

**Files:**
- Modify: `src/app/api/cron/zoom-contact-sync/route.js`
- Test: `src/app/api/cron/zoom-contact-sync/route.test.js`

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe` in `src/app/api/cron/zoom-contact-sync/route.test.js`:

```javascript
  it('identifies itself as the cron trigger', async () => {
    await GET(req())
    expect(vi.mocked(runZoomContactSync).mock.calls[0][0].trigger).toBe('cron')
  })
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/cron/zoom-contact-sync/route.test.js`
Expected: FAIL — expected `'cron'`, received `undefined`.

- [ ] **Step 3: Implement**

In `src/app/api/cron/zoom-contact-sync/route.js`, change the call:

```javascript
  const out = await runZoomContactSync({ db, dry, limit, force, trigger: 'cron' })
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/app/api/cron/zoom-contact-sync/route.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/zoom-contact-sync/
git commit -m "ZOOMOPS.1 — cron identifies its trigger"
```

---

### Task 6: Permission key

**Files:**
- Modify: `shared/permissions.js`

- [ ] **Step 1: Find the registry**

Run: `grep -n "WEB_PERMISSIONS\|WEB_ONLY_OK\|DEFAULT_WEB_PERMISSIONS_BY_ROLE" shared/permissions.js | head -10`

Read the surrounding structure before editing — match the existing entry style exactly.

- [ ] **Step 2: Add the key**

Add `integrations_zoom_manage` to `WEB_PERMISSIONS` with a label matching the file's convention (something in the shape of *"Manage the Zoom phone directory sync"*), grant it to `owner` in `DEFAULT_WEB_PERMISSIONS_BY_ROLE`, and add it to `WEB_ONLY_OK` with the reason:

```
integrations_zoom_manage: 'Settings surface — no mobile equivalent; the destructive controls need a confirmation dialog the mobile app has no home for.'
```

- [ ] **Step 3: Run the parity linter**

Run: `npm run check:mobile-parity && npm run check:mobile-imports`
Expected: both PASS. If parity fails, the key is missing from one of the three registries — it must be in exactly one of `WEB_ONLY_OK`, `CROSS_PLATFORM_KEYS`, or have a mobile counterpart.

- [ ] **Step 4: Commit**

```bash
git add shared/permissions.js
git commit -m "ZOOMOPS.1 — integrations_zoom_manage permission key"
```

---

### Task 7: The operator route

**Files:**
- Create: `src/app/api/integrations/zoom-contacts/run/route.js`
- Test: `src/app/api/integrations/zoom-contacts/run/route.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/app/api/integrations/zoom-contacts/run/route.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn(() => ({})) }))
vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/permissions', () => ({ hasPermission: vi.fn() }))
vi.mock('@/lib/zoom/reconcile', () => ({ runZoomContactSync: vi.fn() }))

import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { runZoomContactSync } from '@/lib/zoom/reconcile'
import { POST } from './route'

const post = (body) => new Request('https://x.test/api/integrations/zoom-contacts/run', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

const userIn = (orgId = 'org-1') => ({
  id: 'u-1', isMaster: false,
  rolesByLocation: { 'loc-1': 'manager' },
  activeOrganization: { id: orgId },
})

beforeEach(() => {
  process.env.ZOOM_SYNC_ORGANIZATION_ID = 'org-1'
  vi.mocked(getCurrentUser).mockResolvedValue(userIn())
  vi.mocked(hasPermission).mockReturnValue(true)   // default: permitted
  vi.mocked(runZoomContactSync).mockResolvedValue({ ok: true, counts: { creates: 1, updates: 0, deletes: 0 }, enqueued: 1 })
})

describe('POST /api/integrations/zoom-contacts/run', () => {
  it('401s when unauthenticated', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(null)
    expect((await POST(post({ dry: true }))).status).toBe(401)
    expect(runZoomContactSync).not.toHaveBeenCalled()
  })

  // A preview writes nothing, so it must NOT consult the permission key.
  it('lets an unprivileged user preview', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    const res = await POST(post({ dry: true }))
    expect(res.status).toBe(200)
    expect(vi.mocked(runZoomContactSync).mock.calls[0][0]).toMatchObject({ dry: true, trigger: 'manual', triggeredBy: 'u-1' })
  })

  it('refuses a real run without the permission', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    expect((await POST(post({ dry: false }))).status).toBe(403)
    expect(runZoomContactSync).not.toHaveBeenCalled()
  })

  // force is destructive even alongside dry — it must never ride in on the
  // preview exemption.
  it('refuses the guard override without the permission, even with dry set', async () => {
    vi.mocked(hasPermission).mockReturnValue(false)
    expect((await POST(post({ dry: true, force: true }))).status).toBe(403)
    expect(runZoomContactSync).not.toHaveBeenCalled()
  })

  it('checks the right permission key', async () => {
    await POST(post({ force: true }))
    expect(hasPermission).toHaveBeenCalledWith(expect.anything(), 'integrations_zoom_manage')
  })

  it('lets a permitted user run and force', async () => {
    expect((await POST(post({ force: true }))).status).toBe(200)
    expect(vi.mocked(runZoomContactSync).mock.calls[0][0].force).toBe(true)
  })

  it('refuses a user outside the synced organisation even with the permission', async () => {
    vi.mocked(getCurrentUser).mockResolvedValue(userIn('org-other'))
    expect((await POST(post({ dry: true }))).status).toBe(403)
  })

  it('400s on a bad limit', async () => {
    expect((await POST(post({ limit: -5 }))).status).toBe(400)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/app/api/integrations/zoom-contacts/run/route.test.js`
Expected: FAIL — cannot resolve `./route`.

- [ ] **Step 3: Implement**

```javascript
// src/app/api/integrations/zoom-contacts/run/route.js
//
// ZOOMOPS.1 — the operator's trigger for the Zoom contact sync.
//
// Calls the same runZoomContactSync() the cron does. The cron route is
// unchanged and keeps its CRON_SECRET guard — this is an addition, so an
// authenticated browser session never becomes a way around cron auth.
//
// Permissions: a preview writes nothing to Zoom and is open to managers. A real
// run, and especially the guard override, can add or remove thousands of
// directory entries, so both are owner/master only.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { runZoomContactSync } from '@/lib/zoom/reconcile'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
// Matches the cron. An unlimited manual run enqueues one job per pending write
// and relies on the same bounded-concurrency publish loop.
export const maxDuration = 300

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })

  let body
  try { body = await request.json() } catch {
    return NextResponse.json({ success: false, error: 'invalid_json' }, { status: 400 })
  }

  const dry = body?.dry === true
  const force = body?.force === true
  const rawLimit = body?.limit
  if (rawLimit != null && (!Number.isFinite(rawLimit) || rawLimit <= 0)) {
    return NextResponse.json({ success: false, error: 'limit must be a positive number' }, { status: 400 })
  }
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : null

  // The sync belongs to one organisation; nobody outside it may drive it, even
  // as an owner of their own org.
  const syncOrgId = process.env.ZOOM_SYNC_ORGANIZATION_ID || null
  if (!user.isMaster && (!syncOrgId || user.activeOrganization?.id !== syncOrgId)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // A preview is safe. Anything that writes, or that overrides the deletion
  // guard, is gated on the permission key added in Task 6 — NOT on a hand-rolled
  // role check, or the key would be dead and the two would drift the first time
  // someone edited the role defaults.
  if ((!dry || force) && !hasPermission(user, 'integrations_zoom_manage')) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const out = await runZoomContactSync({
    db, dry, limit, force, trigger: 'manual', triggeredBy: user.id,
  })

  return NextResponse.json({ success: out.ok !== false, data: out })
}
```

- [ ] **Step 4: Run the tests and the route guard**

Run: `npx vitest run src/app/api/integrations/zoom-contacts/run/route.test.js`
Expected: PASS, 8 tests.

Run: `npm run check:route-guards && npm run check:location-scoping`
Expected: both PASS. If `check:location-scoping` flags this route, the org check above is the scoping — register the helper rather than reaching for `EXEMPT`.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/integrations/zoom-contacts/
git commit -m "ZOOMOPS.1 — operator run route, preview open to managers"
```

---

### Task 8: Health row

**Files:**
- Modify: `src/lib/integration-health.js`
- Test: `src/lib/integration-health.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/integration-health.test.js`:

```javascript
import { zoomSyncStatus } from './integration-health'

describe('zoomSyncStatus', () => {
  it('is unknown when the sync has never run', () => {
    expect(zoomSyncStatus(null).status).toBe('unknown')
  })

  it('is down when the last run errored', () => {
    const s = zoomSyncStatus({ error: 'zoom down', finished_at: '2026-08-06T04:30:00Z' })
    expect(s.status).toBe('down')
    expect(s.detail).toContain('zoom down')
  })

  it('is down when a run never finished', () => {
    expect(zoomSyncStatus({ started_at: '2026-08-05T04:30:00Z', finished_at: null }).status).toBe('down')
  })

  it('warns when the deletion guard tripped', () => {
    const s = zoomSyncStatus({ guard_tripped: true, guard_attempted: 400, guard_threshold: 20, finished_at: 'x' })
    expect(s.status).toBe('warn')
    expect(s.detail).toContain('400')
  })

  it('is ok after a clean run', () => {
    const s = zoomSyncStatus({ finished_at: 'x', creates: 12, updates: 1, deletes: 0, owned_in_zoom: 6330 })
    expect(s.status).toBe('ok')
    expect(s.detail).toContain('6330')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/integration-health.test.js`
Expected: FAIL — `zoomSyncStatus is not a function`.

- [ ] **Step 3: Implement the pure helper**

Add to `src/lib/integration-health.js` alongside the other pure status helpers:

```javascript
/**
 * ZOOMOPS.1 — status from the most recent zoom_sync_runs row.
 * A null finished_at is 'down' rather than 'unknown': the run started and never
 * closed out, which means it crashed, and that is otherwise invisible.
 */
export function zoomSyncStatus(lastRun) {
  if (!lastRun) return { status: 'unknown', detail: 'Never run' }
  if (lastRun.error) return { status: 'down', detail: `Last run failed: ${lastRun.error}` }
  if (!lastRun.finished_at) return { status: 'down', detail: 'Last run started but never finished' }
  if (lastRun.guard_tripped) {
    return {
      status: 'warn',
      detail: `Deletion guard tripped — ${lastRun.guard_attempted} deletions refused (threshold ${lastRun.guard_threshold})`,
    }
  }
  const c = lastRun.creates ?? 0
  const u = lastRun.updates ?? 0
  const d = lastRun.deletes ?? 0
  return {
    status: 'ok',
    detail: `${lastRun.owned_in_zoom ?? 0} in directory · last run +${c} ~${u} -${d}`,
  }
}
```

- [ ] **Step 4: Add the row to `getIntegrationHealth`**

Inside `getIntegrationHealth(db, locationId)`, after the existing rows, add:

```javascript
  // 7. Zoom contact sync — organisation-level, not per location. One directory
  //    serves every handset on the account, so the row is equally true at every
  //    location in the synced org, and absent everywhere else.
  try {
    const syncOrgId = process.env.ZOOM_SYNC_ORGANIZATION_ID || null
    if (syncOrgId) {
      const { data: loc } = await db
        .from('locations').select('organization_id').eq('id', locationId).maybeSingle()
      if (loc?.organization_id === syncOrgId) {
        const { data: runs } = await db
          .from('zoom_sync_runs')
          .select('started_at, finished_at, creates, updates, deletes, owned_in_zoom, guard_tripped, guard_attempted, guard_threshold, error')
          .eq('organization_id', syncOrgId)
          .eq('dry', false)
          .order('started_at', { ascending: false })
          .limit(1)
        const s = zoomSyncStatus((runs || [])[0] || null)
        rows.push({
          key: 'zoom-contacts',
          name: 'Zoom phone directory',
          status: s.status,
          lastSuccess: (runs || [])[0]?.finished_at || null,
          detail: s.detail,
          remedy: s.status === 'warn'
            ? 'Preview the run, read the numbers it wants to remove, then override the guard if they are genuinely gone.'
            : s.status === 'down'
              ? 'Open the sync page and preview a run to see the current error.'
              : undefined,
          href: '/settings/integrations/zoom-contacts',
        })
      }
    }
  } catch { /* health pane must never fail on one row */ }
```

Note the `.eq('dry', false)` — a preview is not a run, and letting one set the health status would mean any manager could turn the pane green by clicking Preview.

- [ ] **Step 5: Run tests and build**

Run: `npx vitest run src/lib/integration-health.test.js && npm run build 2>&1 | grep -iE "compiled successfully|failed to compile"`
Expected: tests PASS, build compiles.

- [ ] **Step 6: Commit**

```bash
git add src/lib/integration-health.js src/lib/integration-health.test.js
git commit -m "ZOOMOPS.1 — Zoom row in the integration health pane"
```

---

### Task 9: The detail page

> **This is the one task specified rather than pre-written.** Every other task
> in this plan carries its complete code. This one does not, deliberately: the
> page composes `@/components/ui` primitives and must match the visual language
> of the settings pages beside it, so code written blind here would be guessed
> markup the implementer would have to rewrite after reading those files anyway.
> Read them first (Step 1), then build to the spec below. Everything the page
> consumes — `listRuns`, `zoomSyncStatus`, `buildDesiredContacts(db, { collectRejects: true })`,
> the route contract — is fully defined in Tasks 2, 3, 7 and 8.

**Files:**
- Create: `src/app/settings/integrations/zoom-contacts/page.js`
- Create: `src/app/settings/integrations/zoom-contacts/Controls.jsx`

- [ ] **Step 1: Read two existing settings pages first**

Run: `sed -n '1,60p' src/app/settings/integration-health/page.js`

Match its server-component shape, its `getCurrentUser()` gate, its card markup and its status chip classes. **Do not invent new UI primitives** — compose `@/components/ui`. Status chips must be `bg-<c>-500/10 text-<c>-700`; the dark-theme recipe is lint-enforced against.

- [ ] **Step 2: Build the server page**

`src/app/settings/integrations/zoom-contacts/page.js` is a server component that:

1. `getCurrentUser()`; redirect if absent.
2. Resolves `process.env.ZOOM_SYNC_ORGANIZATION_ID`. If the user is not master and `user.activeOrganization?.id` differs, render a "not configured for this organisation" empty state and nothing else.
3. `createServerClient()`, then `listRuns(db, syncOrgId)` from `@/lib/zoom/sync-runs`.
4. `buildDesiredContacts(db, { collectRejects: true })` for the report. Render `res.rejects` grouped by reason; if `res.ok` is false, render the error instead of an empty report — an empty report and a broken build must not look the same.
5. Renders, in order: status header (from `zoomSyncStatus` on the newest non-dry run), the `<Controls>` client component, run history, then the rejected report.

Run history columns: started, trigger (with the actor's name when manual), a `Preview` chip when `dry`, counts as `+creates ~updates -deletes`, `enqueued`, and a red `Guard tripped` chip where applicable.

Rejected report: group by reason with counts in the heading — `unparseable` first since it is the actionable one, then `no_phone`, then `no_name`. Each row shows the contact name and the raw stored `phone` value, linking to the contact drawer at `/contacts/<id>`. Cap the rendered list at 100 per group with a "showing 100 of N" note — 219 `no_phone` rows must not push the actionable ones off the screen.

- [ ] **Step 3: Build the controls client component**

`Controls.jsx` is `'use client'` and posts to `/api/integrations/zoom-contacts/run`.

- **Preview** — always enabled, `{ dry: true }`, renders the returned counts inline.
- **Run now** — a number input **defaulting to 200, not blank**. An unlimited run enqueues thousands of jobs, so the expensive path must be chosen, not defaulted into.
- **Override guard** — disabled unless the newest run has `guard_tripped`. On click, opens a `Modal` listing that run's `guard_sample` numbers verbatim and requires confirmation before posting `{ force: true }`.

Both write controls are hidden entirely when the viewer is not owner or master — the route enforces it, and the UI should not offer a button that will 403.

Every `<button>` gets an explicit `type="button"`.

- [ ] **Step 4: Verify it renders**

Start the dev server via the preview tooling (never `npm run dev` in a raw shell), then load `/settings/integrations/zoom-contacts` and confirm: the page renders, the rejected report shows counts matching a live `?dry=1` `stats.rejected`, and no console errors.

If the counts disagree with `stats.rejected`, **stop** — collect mode has diverged from counting mode and that is the exact bug Task 2's equivalence test exists to prevent.

- [ ] **Step 5: Commit**

```bash
git add src/app/settings/integrations/zoom-contacts/
git commit -m "ZOOMOPS.1 — sync detail page: history, rejected report, controls"
```

---

### Task 10: Register and document

**Files:**
- Modify: `src/lib/openapi.js`, `docs/CHANGELOG.md`

- [ ] **Step 1: Register the route**

Add a `registry.registerPath` entry for `POST /api/integrations/zoom-contacts/run` in `src/lib/openapi.js`, matching the surrounding style. Document the three permission tiers (preview = manager, run and force = owner/master) in the description, and the 400/401/403 responses.

- [ ] **Step 2: Changelog**

Prepend to the current section of `docs/CHANGELOG.md`, matching the existing numbering:

```markdown
- **ZOOMOPS.1 — Zoom sync operator surface.** The Zoom contact sync is now
  operable without a terminal: a health row, `/settings/integrations/zoom-contacts`
  with run history and the contacts the sync cannot use, and preview / run /
  guard-override controls. Preview is open to managers; running and the guard
  override are owner and master only. Mig 487 (`zoom_sync_runs`, pruned at 90
  days by the sync itself). The rejected report shares the sync's own code path
  via a collect mode on `buildDesiredContacts()` — a separate query would drift
  at the first normaliser change and a report that lists the wrong contacts is
  worse than none.
```

- [ ] **Step 3: Full CI mirror plus build**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails
```

Then `npm run build`. Report each result individually — do not collapse them into "all green" unless every one is.

- [ ] **Step 4: Commit**

```bash
git add src/lib/openapi.js docs/CHANGELOG.md
git commit -m "ZOOMOPS.1 — register route, document"
```

---

## Deploy notes

**Migration 487 must be applied before this code deploys.** Every run insert fails otherwise — best-effort, so the sync keeps working, but history stays permanently empty and the health row reads "Never run" forever.

Nothing here is gated behind the `ZOOM_*` secrets. An unconfigured tenant sees the surfaces in an honest empty state.

## Out of scope

Per-tenant credentials, org-level connection records, and any connect flow — Project B in the spec. `zoom_sync_runs.organization_id` and the health row's org resolution exist to make that project cheaper; nothing else here anticipates it.
