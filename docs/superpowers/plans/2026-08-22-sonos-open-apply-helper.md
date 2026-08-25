# Sonos open-apply helper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One tested home for the "open a Sonos window" sequence (volume → favourite per group, stamp `last_applied` only on full success), consumed by both the reconcile cron and the run-now route.

**Architecture:** New pure-ish module `src/lib/sonos/apply.js` exporting `applyOpen(db, { token, schedule, plan, groups, groupIds, nowMs, deps })`. Sonos I/O is injected via `deps` (defaults to the client functions), the DB is passed in. Both callers drop their copy of the loop + stamp and call it; their handling of the three outcomes (`ok` / `sonos` / `stamp`) is unchanged.

**Tech Stack:** Next.js 16 App Router, supabase-js (service role), vitest. Spec: `docs/superpowers/specs/2026-08-22-sonos-open-apply-helper-design.md`.

**Repo rules that bite here** (from `CLAUDE.md`):
- supabase builders resolve `{ data, error }`, never throw — always destructure `error` on a write.
- `window_on_at` in `last_applied` must be a raw NUMBER (jsonb); a string makes `planAction`'s `===` never match and the playlist restarts every 60 s.
- Ticket prefix for commits: `SONOSAPPLY.N — summary`.
- Run from the worktree root `/Users/richardivers/code/un1t-crm/.claude/worktrees/sonos-followups`. Never `git stash`.

---

### Task 1: `applyOpen` — the helper, test-first

**Files:**
- Create: `src/lib/sonos/apply.js`
- Create: `src/lib/sonos/apply.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/lib/sonos/apply.test.js
import { describe, it, expect, vi } from 'vitest'
import { applyOpen } from './apply'

vi.mock('@/lib/log', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }))

const NOW = new Date('2026-08-24T05:00:00Z').getTime()
const WINDOW_ON_AT = NOW

const groups = [
  { id: 'GRP_A', name: 'Studio', playbackState: 'PLAYBACK_STATE_IDLE', playerIds: ['RINCON_1'] },
  { id: 'GRP_B', name: 'Reception', playbackState: 'PLAYBACK_STATE_PAUSED', playerIds: ['RINCON_2'] },
]

const schedule = { id: 's1', location_id: 'loc-1', player_ids: ['RINCON_1'] }
const plan = { action: 'open', windowOnAt: WINDOW_ON_AT, volume: 35, favoriteId: 'fv-1' }

// Records every UPDATE the helper issues. `updateError` makes the write fail
// the way a real supabase builder does: resolved, never thrown.
function makeDb({ updateError = null } = {}) {
  const updates = []
  return {
    updates,
    from(table) {
      if (table !== 'sonos_schedules') throw new Error(`unexpected table ${table}`)
      return {
        update(patch) {
          return {
            eq: async (col, val) => {
              updates.push({ col, val, patch })
              return { error: updateError }
            },
          }
        },
      }
    },
  }
}

const okDeps = () => ({
  setVolume: vi.fn(async () => ({ ok: true, statusCode: 200 })),
  loadFavorite: vi.fn(async () => ({ ok: true, statusCode: 200 })),
})

function run(db, over = {}) {
  return applyOpen(db, {
    token: 'tok',
    schedule,
    plan,
    groups,
    groupIds: ['GRP_A'],
    nowMs: NOW,
    deps: okDeps(),
    ...over,
  })
}

describe('applyOpen', () => {
  it('sets volume then loads the favourite, and stamps the open once', async () => {
    const db = makeDb()
    const deps = okDeps()
    const order = []
    deps.setVolume.mockImplementation(async () => { order.push('volume'); return { ok: true, statusCode: 200 } })
    deps.loadFavorite.mockImplementation(async () => { order.push('favorite'); return { ok: true, statusCode: 200 } })

    const out = await run(db, { deps })

    expect(out).toEqual({ ok: true })
    expect(order).toEqual(['volume', 'favorite'])
    expect(deps.setVolume).toHaveBeenCalledWith('tok', 'GRP_A', 35)
    expect(deps.loadFavorite).toHaveBeenCalledWith('tok', 'GRP_A', 'fv-1')

    expect(db.updates).toHaveLength(1)
    const { col, val, patch } = db.updates[0]
    expect(col).toBe('id')
    expect(val).toBe('s1')
    // window_on_at MUST be the raw number. A string never === the planner's
    // active.on_at, so every tick re-opens and the playlist restarts.
    expect(typeof patch.last_applied.window_on_at).toBe('number')
    expect(patch.last_applied).toEqual({
      window_on_at: WINDOW_ON_AT,
      action: 'open',
      at: new Date(NOW).toISOString(),
    })
    expect(patch.last_state).toEqual({
      group_id: 'GRP_A',
      playback_state: 'PLAYBACK_STATE_IDLE',
      at: new Date(NOW).toISOString(),
    })
    expect(patch.updated_at).toBe(new Date(NOW).toISOString())
  })

  it('uses the FIRST group id as the primary for last_state', async () => {
    const db = makeDb()
    await run(db, { groupIds: ['GRP_B', 'GRP_A'] })
    expect(db.updates[0].patch.last_state.group_id).toBe('GRP_B')
    expect(db.updates[0].patch.last_state.playback_state).toBe('PLAYBACK_STATE_PAUSED')
  })

  it('records a null playback_state when the primary group is not in the list', async () => {
    const db = makeDb()
    await run(db, { groupIds: ['GRP_GONE'] })
    expect(db.updates[0].patch.last_state.playback_state).toBeNull()
  })

  it('skips the favourite for a group whose volume failed, still tries the other group, and stamps nothing', async () => {
    const db = makeDb()
    const deps = okDeps()
    deps.setVolume.mockImplementation(async (_t, groupId) =>
      groupId === 'GRP_A' ? { ok: false, statusCode: 500 } : { ok: true, statusCode: 200 })

    const out = await run(db, { deps, groupIds: ['GRP_A', 'GRP_B'] })

    expect(out).toEqual({ ok: false, reason: 'sonos' })
    expect(deps.loadFavorite).toHaveBeenCalledTimes(1)
    expect(deps.loadFavorite).toHaveBeenCalledWith('tok', 'GRP_B', 'fv-1')
    // Deliberately unstamped: the next tick retries the window.
    expect(db.updates).toHaveLength(0)
  })

  it('stamps nothing when the favourite fails to load', async () => {
    const db = makeDb()
    const deps = okDeps()
    deps.loadFavorite.mockResolvedValue({ ok: false, statusCode: 500 })

    const out = await run(db, { deps })

    expect(out).toEqual({ ok: false, reason: 'sonos' })
    expect(db.updates).toHaveLength(0)
  })

  it('reports a failed stamp as its own outcome, distinct from a Sonos failure', async () => {
    const err = { message: 'boom' }
    const db = makeDb({ updateError: err })

    const out = await run(db)

    // Every Sonos call succeeded — the music IS playing — so the caller
    // must be able to tell this apart from `sonos` and report accordingly.
    expect(out).toEqual({ ok: false, reason: 'stamp', error: err })
    expect(db.updates).toHaveLength(1)
  })

  it('passes a null favoriteId straight through rather than refusing to open', async () => {
    // The planner documents this choice (groups.js): refusing would leave
    // the room silent with zero signal. The helper does not second-guess it.
    const db = makeDb()
    const deps = okDeps()
    await run(db, { deps, plan: { ...plan, favoriteId: null } })
    expect(deps.loadFavorite).toHaveBeenCalledWith('tok', 'GRP_A', null)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/sonos/apply.test.js`
Expected: FAIL — `Failed to resolve import "./apply"`.

- [ ] **Step 3: Write the implementation**

```js
// src/lib/sonos/apply.js
// SONOSAPPLY.1 — the one place a Sonos window is OPENED.
//
// Two callers open windows: the reconcile cron (src/lib/sonos/reconcile.js)
// and "Run now" (src/app/api/sonos/schedules/[id]/run-now/route.js). Each
// used to carry its own copy of this sequence, and the copies are where the
// stranded-close bug lived (SONOSLIVE.6): run-now had its own idea of what
// to do with last_applied. Now there is one sequence and one test.
//
// The sequence, per resolved group:
//   1. setVolume FIRST — after loadFavorite the opening seconds would play at
//      the previous window's level. A failed volume skips that group's
//      favourite (no point starting music at the wrong level).
//   2. loadFavorite.
// Then, only if EVERY group succeeded, one UPDATE stamping last_applied +
// last_state. A partial failure stamps nothing, deliberately: an unapplied
// window is retried by the next tick, which is what a transient 5xx
// deserves. Stamping it would cost the whole window.
//
// Three outcomes, kept distinct because the callers treat them differently:
//   { ok: true }
//   { ok: false, reason: 'sonos' }          ≥1 group failed; nothing written
//   { ok: false, reason: 'stamp', error }   Sonos succeeded, the UPDATE did not —
//                                           the music IS playing, only the
//                                           bookkeeping is missing. Run-now
//                                           reports success + warning; the
//                                           cron counts it as failed.

import { logWarn } from '@/lib/log'
import { sonosSetGroupVolume, sonosLoadFavorite } from './client'

const MODULE = 'sonos-apply'

export async function applyOpen(db, { token, schedule, plan, groups, groupIds, nowMs, deps = {} }) {
  const {
    setVolume = sonosSetGroupVolume,
    loadFavorite = sonosLoadFavorite,
  } = deps

  let allOk = true
  for (const groupId of groupIds) {
    const v = await setVolume(token, groupId, plan.volume)
    if (!v.ok) {
      allOk = false
      logWarn(MODULE, 'setVolume failed', { scheduleId: schedule.id, groupId, statusCode: v.statusCode })
      continue
    }
    const f = await loadFavorite(token, groupId, plan.favoriteId)
    if (!f.ok) {
      allOk = false
      logWarn(MODULE, 'loadFavorite failed', { scheduleId: schedule.id, groupId, statusCode: f.statusCode })
    }
  }
  if (!allOk) return { ok: false, reason: 'sonos' }

  const nowIso = new Date(nowMs).toISOString()
  const primary = groupIds[0]
  const group = (groups || []).find((g) => g.id === primary)
  // window_on_at MUST stay a raw number. A string makes planAction's
  // equality never match, so every tick re-opens and loadFavorite restarts
  // the playlist every sixty seconds. Pinned by apply.test.js.
  const { error } = await db
    .from('sonos_schedules')
    .update({
      last_applied: { window_on_at: plan.windowOnAt, action: 'open', at: nowIso },
      last_state: { group_id: primary, playback_state: group?.playbackState || null, at: nowIso },
      updated_at: nowIso,
    })
    .eq('id', schedule.id)
  if (error) {
    logWarn(MODULE, 'state write failed', { scheduleId: schedule.id, error: error.message })
    return { ok: false, reason: 'stamp', error }
  }
  return { ok: true }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/sonos/apply.test.js`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add src/lib/sonos/apply.js src/lib/sonos/apply.test.js
git commit -m "SONOSAPPLY.1 — applyOpen: one home for the open-window sequence" -m "Volume then favourite per group; stamp last_applied only when every group succeeded; three distinct outcomes (ok / sonos / stamp) so each caller keeps its own handling."
```

---

### Task 2: The reconcile delegates to `applyOpen`

**Files:**
- Modify: `src/lib/sonos/reconcile.js:5,107-145`
- Test: `src/lib/sonos/reconcile.test.js` (existing — must stay green unchanged)

- [ ] **Step 1: Run the existing reconcile tests to confirm the baseline**

Run: `npx vitest run src/lib/sonos/reconcile.test.js`
Expected: all pass (the suite was green at `bd9e9f08`).

- [ ] **Step 2: Replace the open branch with the helper**

In `src/lib/sonos/reconcile.js`, change the import line

```js
import { getSonosConfig, withFreshToken, sonosGetGroups, sonosSetGroupVolume, sonosLoadFavorite, sonosPause } from './client'
```

to

```js
import { getSonosConfig, withFreshToken, sonosGetGroups, sonosSetGroupVolume, sonosLoadFavorite, sonosPause } from './client'
import { applyOpen } from './apply'
```

(`sonosSetGroupVolume` / `sonosLoadFavorite` stay imported: they remain the defaults for the injected `deps`, which are passed through to the helper.)

Then replace the whole block from `let allOk = true` (line 107) through `applied++` (line 145) — i.e. everything after the `if (!groupIds.length) { … continue }` guard inside the `for (const schedule of rows)` loop — with:

```js
      if (plan.action === 'open') {
        const out = await applyOpen(db, {
          token: tok.token,
          schedule,
          plan,
          groups,
          groupIds,
          nowMs,
          deps: { setVolume, loadFavorite },
        })
        if (!out.ok) {
          // Both outcomes count as failed here. 'sonos' leaves the window
          // unapplied so the next tick retries it; 'stamp' means the music
          // is playing but the record did not save, which the next tick
          // will re-open — accepted, and loud in the log either way.
          failed++
          continue
        }
        applied++
        continue
      }

      // Close. Stays here rather than in apply.js: run-now never closes,
      // so there is nothing to share.
      let allOk = true
      for (const groupId of groupIds) {
        const p = await pause(tok.token, groupId)
        if (!pauseSucceeded(p)) { allOk = false; logWarn(MODULE, 'pause failed', { groupId, statusCode: p.statusCode }) }
      }
      if (!allOk) {
        // Deliberately do NOT stamp last_applied: leaving the close
        // unapplied means the next tick retries it.
        failed++
        continue
      }

      const primary = groupIds[0]
      const group = groups.find((g) => g.id === primary)
      const { error: upErr } = await db
        .from('sonos_schedules')
        .update({
          last_applied: { window_on_at: plan.windowOnAt, action: 'close', at: nowIso },
          last_state: { group_id: primary, playback_state: group?.playbackState || null, at: nowIso },
          updated_at: nowIso,
        })
        .eq('id', schedule.id)
      if (upErr) {
        failed++
        logWarn(MODULE, 'state write failed', { scheduleId: schedule.id, error: upErr.message })
        continue
      }
      applied++
```

The resulting loop body, in full, for reference:

```js
    for (const schedule of rows) {
      const plan = planAction(schedule, nowMs, dateStr)
      if (!plan) continue

      const groupIds = resolveGroupIds(groups, schedule.player_ids)
      if (!groupIds.length) {
        failed++
        logWarn(MODULE, 'no group for schedule players', { scheduleId: schedule.id })
        continue
      }

      if (plan.action === 'open') {
        const out = await applyOpen(db, {
          token: tok.token,
          schedule,
          plan,
          groups,
          groupIds,
          nowMs,
          deps: { setVolume, loadFavorite },
        })
        if (!out.ok) {
          // Both outcomes count as failed here. 'sonos' leaves the window
          // unapplied so the next tick retries it; 'stamp' means the music
          // is playing but the record did not save, which the next tick
          // will re-open — accepted, and loud in the log either way.
          failed++
          continue
        }
        applied++
        continue
      }

      // Close. Stays here rather than in apply.js: run-now never closes,
      // so there is nothing to share.
      let allOk = true
      for (const groupId of groupIds) {
        const p = await pause(tok.token, groupId)
        if (!pauseSucceeded(p)) { allOk = false; logWarn(MODULE, 'pause failed', { groupId, statusCode: p.statusCode }) }
      }
      if (!allOk) {
        // Deliberately do NOT stamp last_applied: leaving the close
        // unapplied means the next tick retries it.
        failed++
        continue
      }

      const primary = groupIds[0]
      const group = groups.find((g) => g.id === primary)
      const { error: upErr } = await db
        .from('sonos_schedules')
        .update({
          last_applied: { window_on_at: plan.windowOnAt, action: 'close', at: nowIso },
          last_state: { group_id: primary, playback_state: group?.playbackState || null, at: nowIso },
          updated_at: nowIso,
        })
        .eq('id', schedule.id)
      if (upErr) {
        failed++
        logWarn(MODULE, 'state write failed', { scheduleId: schedule.id, error: upErr.message })
        continue
      }
      applied++
    }
```

Note `action: 'close'` is now literal in the close stamp — it was `plan.action` before, and on this branch `plan.action` can only be `'close'`, so behaviour is identical and the intent is now readable.

- [ ] **Step 3: Run the reconcile + apply tests**

Run: `npx vitest run src/lib/sonos/`
Expected: all pass, including `sets volume BEFORE loading the favourite`, `records last_applied so the next tick is a no-op`, `does NOT mark the window applied when the favourite failed to load`, `treats a 499 on pause as benign`. These exercise the helper end to end through the reconcile's injected fakes.

- [ ] **Step 4: Commit**

```bash
git add src/lib/sonos/reconcile.js
git commit -m "SONOSAPPLY.2 — reconcile opens windows through applyOpen" -m "The close path stays in the reconcile: run-now never closes. Existing reconcile tests now exercise the helper through the injected fakes."
```

---

### Task 3: Run-now delegates to `applyOpen`

**Files:**
- Modify: `src/app/api/sonos/schedules/[id]/run-now/route.js:21-29,97-136`

- [ ] **Step 1: Replace the imports**

Change

```js
import { logWarn } from '@/lib/log'
import { getSonosConfig, withFreshToken, sonosGetGroups, sonosSetGroupVolume, sonosLoadFavorite } from '@/lib/sonos/client'
import { mapGroups, resolveGroupIds, planAction } from '@/lib/sonos/groups'
import { dublinDayStr } from '@/lib/dublin-time'
```

to

```js
import { getSonosConfig, withFreshToken, sonosGetGroups } from '@/lib/sonos/client'
import { mapGroups, resolveGroupIds, planAction } from '@/lib/sonos/groups'
import { applyOpen } from '@/lib/sonos/apply'
import { dublinDayStr } from '@/lib/dublin-time'
```

(`logWarn` is no longer used in this file once the loop moves — the helper logs.)

- [ ] **Step 2: Replace the loop + stamp**

Replace everything from `let allOk = true` (line 97) to the end of the function body (the final `return NextResponse.json({ success: true, groups: groupIds })`, line 136) with:

```js
  const out = await applyOpen(db, {
    token: tok.token,
    schedule,
    plan,
    groups,
    groupIds,
    nowMs,
  })

  if (!out.ok && out.reason === 'sonos') {
    // Nothing stamped — an unapplied window is retried by the next cron
    // tick, which is what a transient failure deserves.
    return NextResponse.json({ success: false, error: 'That did not work' }, { status: 502 })
  }
  if (!out.ok) {
    // reason === 'stamp': the music IS playing; only the bookkeeping
    // failed. Report success with a warning rather than telling the
    // operator it did not work.
    return NextResponse.json({ success: true, warning: 'applied, but the record did not save' })
  }

  return NextResponse.json({ success: true, groups: groupIds })
}
```

Also update the header comment's last paragraph (lines 16-19) from

```js
// Now it applies the window through the same volume-then-favourite path the
// reconcile uses and stamps last_applied as an open, exactly as a
// cron-driven open would. No wait, and the close's precondition is written
// rather than destroyed.
```

to

```js
// Now it applies the window through applyOpen (src/lib/sonos/apply.js) —
// the SAME function the reconcile cron calls — and so stamps last_applied as
// an open exactly as a cron-driven open would. No wait, and the close's
// precondition is written rather than destroyed. SONOSAPPLY.3 collapsed the
// two copies of that sequence into one; this file no longer carries its own.
```

- [ ] **Step 3: Lint + build-resolve check**

Run: `npx eslint 'src/app/api/sonos/schedules/[id]/run-now/route.js' src/lib/sonos/`
Expected: no errors (in particular no `no-unused-vars` for the removed `logWarn`/`sonosSetGroupVolume`/`sonosLoadFavorite` imports).

- [ ] **Step 4: Commit**

```bash
git add 'src/app/api/sonos/schedules/[id]/run-now/route.js'
git commit -m "SONOSAPPLY.3 — run-now opens the window through applyOpen" -m "Same outcome mapping as before: a Sonos failure is a 502, a stamp failure is success with a warning because the music is playing."
```

---

### Task 4: Full gate, docs, memory

**Files:**
- Modify: `docs/CHANGELOG.md:8` (insert rows after the header line)
- Modify: `docs/superpowers/specs/2026-08-22-sonos-open-apply-helper-design.md` (status line)

- [ ] **Step 1: Run the CI mirror**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```
Expected: every step exits 0. Test count: baseline 16,535 + 7 new = 16,542 (report the actual number; do not pad).

- [ ] **Step 2: Run the production build**

Run: `npm run build`
Expected: exits 0. This is the only check that catches a broken import in the route file.

- [ ] **Step 3: CHANGELOG rows**

Insert two rows directly under the `| # | Item | Notes |` / `|---|------|-------|` header in `docs/CHANGELOG.md` (latest first, so the higher number goes on top):

```markdown
| 564 | SONOSAPPLY.1-3 — one home for the Sonos open-window sequence | `src/lib/sonos/apply.js` `applyOpen`: volume → favourite per group, stamp `last_applied` only on full success, three distinct outcomes (`ok` / `sonos` / `stamp`). The reconcile cron and "Run now" each carried a copy of this loop and stamp — the copies are where the stranded-close bug (SONOSLIVE.6) lived, and the "`window_on_at` must stay a raw number" rule was two comments rather than one test. Close stays in the reconcile (run-now never closes). Spec: `docs/superpowers/specs/2026-08-22-sonos-open-apply-helper-design.md`. |
| 563 | SONOSPLAY.1 — the Sonos pause button never rendered | #1494 (merged 22 Aug, shipped without a changelog row). The control strip compared `playbackState` against `'PLAYING'`; Sonos sends `'PLAYBACK_STATE_PLAYING'`, so `isPlaying` was never true — only a play button ever rendered, and the readout printed "Playback_state_playing". Three sites had the same guess. Now one tested home: `src/lib/sonos/playback.js` (`isPlaying`, `playbackLabel`); buffering counts as playing. Reviews missed it because each checked the boundary it was handed and no test covered the enum reaching the UI. |
```

- [ ] **Step 4: Mark the spec shipped**

In `docs/superpowers/specs/2026-08-22-sonos-open-apply-helper-design.md`, change the `**Status:**` line to `**Status:** implemented (SONOSAPPLY.1-3)`.

- [ ] **Step 5: Commit**

```bash
git add docs/CHANGELOG.md docs/superpowers/specs/2026-08-22-sonos-open-apply-helper-design.md
git commit -m "SONOSAPPLY.4 — changelog (+ the missing SONOSPLAY.1 row)"
```

---

## Self-review against the spec

- **Helper signature + three outcomes** → Task 1. ✔
- **Volume first, failed volume skips that group's favourite, other groups still attempted** → Task 1 test `skips the favourite for a group whose volume failed…`. ✔
- **No stamp on partial failure** → Task 1 tests (two). ✔
- **`window_on_at` raw number** → Task 1 test asserts `typeof … === 'number'`. ✔
- **Stamp filters on `id` only** (run-now's redundant `location_id` filter dropped) → Task 1 impl + Task 3. ✔
- **Close stays in reconcile; token/groups/planAction stay with callers** → Task 2, Task 3. ✔
- **Injection passthrough from reconcile** → Task 2 (`deps: { setVolume, loadFavorite }`). ✔
- **Logging payloads preserved** → `sonos-apply` module with `{ scheduleId, groupId, statusCode }` — a superset of the old `{ groupId, statusCode }`. No reconcile test asserts the module name on these paths (verified: only the cap warning asserts `'sonos-reconcile'`, and it stays). ✔
- **`null favoriteId` passthrough** → Task 1 test. ✔
- Type consistency: `applyOpen(db, { token, schedule, plan, groups, groupIds, nowMs, deps })` identical in Tasks 1, 2, 3. Outcome shapes `{ ok: true }` / `{ ok: false, reason: 'sonos' }` / `{ ok: false, reason: 'stamp', error }` identical throughout. ✔
