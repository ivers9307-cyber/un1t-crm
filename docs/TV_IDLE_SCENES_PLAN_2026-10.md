# TV Idle Scenes Implementation Plan (TVSCENE.1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the studio TV board something worth looking at during the ~80% of the day when no band is connected, without touching the live tile path.

**Architecture:** A scene layer owns the screen only when `tiles.length === 0`. Three scenes (Up next, Earned this week, Operator card) rotate on a 30s dwell. The scene index is a **pure function of elapsed time**, not a timer — the board already re-renders every second for its header clock, so `Math.floor(elapsed / 30000) % n` advances itself. Scene data rides the existing `/api/public/tv-live/[token]` payload, built only in the branch that already early-returns when there are no sessions.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase (service role), vitest + @testing-library/react, Tailwind utility classes with inline style tokens.

**Spec:** [`docs/TV_IDLE_SCENES_DESIGN_2026-10.md`](TV_IDLE_SCENES_DESIGN_2026-10.md)

**Plan location note:** the repo keeps dated design/plan docs in `docs/` (`TV_STYLE_RUNS_DESIGN_2026-07.md`), so this sits beside the spec rather than under the skill's default `docs/superpowers/plans/`.

## Global Constraints

- 🔴 **No aggregate studio metrics, ever.** Individual member moments yes; a count of them never. No "80 first classes this month", no session totals, no member counts, no class capacity or headcount.
- 🔴 **Unlinked bands stay visible and compete on equal terms.** Nothing in this work may filter sessions, podium entries or scenes by "has a linked member".
- 🔴 **Viewport is 1280×720 CSS px.** `main` is `h-screen overflow-hidden`; every new row is `shrink-0` and budgeted at 720. jsdom cannot see layout — verify in a real browser.
- **Scene content is data-driven, never deploy-driven.** A kiosk runs one bundle for days; changing what the room sees must not need a Chromium restart.
- **Dwell is 30s**, one named constant (`SCENE_DWELL_MS`).
- **Privacy floor:** first name + last initial, never a full name, never a contact id, never a full BLE MAC.
- **Opt-out:** `contacts.hr_leaderboard_opt_out = true` is excluded from any named scene.
- Commit subject style: `TVSCENE.1 — <summary>`; body cites files and tradeoffs.
- CI mirror (all thirteen) must pass before the PR: see CLAUDE.md "Build, test & ship".

## Review Focus

1. **A deleted or null contact behind an achievement** — `contact_achievements.contact_id` can point at a contact that no longer resolves (erasure is routine). The row must be dropped, not rendered as "Member" or crash the join. Pinned in Task 2.
2. **DST boundary on "up next" labels** — Irish summer time ends **2026-10-25**, ten days out. A 06:00 class the morning after the change must still read `06:00`. `timeLabelIn` with the studio zone handles it; a test must prove it. Pinned in Task 2.
3. **A cancelled or already-started occurrence** — `class_occurrences` carries `cancelled_at`, and an occurrence that has already begun is not "next". Both must be excluded or the board advertises a class nobody can attend. Pinned in Task 2.
4. **Every scene empty at once** — a studio with no upcoming class, no recent achievement and nothing pushed must fall through to `EmptyBoard`, never a blank screen or a crash on `eligible[0]`. Pinned in Task 1.
5. **Eligible-scene list shrinking mid-cycle** — content expiring between polls changes `eligible.length` while the rotation index is mid-cycle; the modulo must never index past the end. Pinned in Task 1.

---

### Task 1: Scene contract and rotation (pure)

Pure logic only — no DOM, no IO. This is the piece the other three depend on.

**Files:**
- Create: `src/lib/tv-scenes.js`
- Test: `src/lib/tv-scenes.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SCENE_DWELL_MS: number` (30000)
  - `SCENE_KEYS: string[]` — `['up-next', 'earned', 'operator']`, rotation order
  - `eligibleScenes(idle: object|null|undefined): string[]` — the subset of `SCENE_KEYS` with content, in order
  - `sceneAt(eligible: string[], elapsedMs: number): string|null` — the scene showing now, `null` when `eligible` is empty

- [ ] **Step 1: Write the failing test**

```js
// src/lib/tv-scenes.test.js
import { describe, it, expect } from 'vitest'
import { SCENE_DWELL_MS, SCENE_KEYS, eligibleScenes, sceneAt } from './tv-scenes.js'

const full = {
  up_next: [{ starts_at: '2026-10-16T05:00:00Z', starts_at_label: '06:00', class_name: 'BU1LD' }],
  earned: [{ display_name: 'Saoirse M.', achievement: '50 classes', tier: 4 }],
  operator: { source_type: 'storage', source_ref: 'x.png' },
}

describe('eligibleScenes', () => {
  it('returns every scene that has content, in rotation order', () => {
    expect(eligibleScenes(full)).toEqual(SCENE_KEYS)
  })

  it('skips a scene whose list is empty', () => {
    expect(eligibleScenes({ ...full, earned: [] })).toEqual(['up-next', 'operator'])
  })

  it('skips the operator card when nothing is pushed', () => {
    expect(eligibleScenes({ ...full, operator: null })).toEqual(['up-next', 'earned'])
  })

  // Review Focus 4 — every scene empty must be representable, not a crash.
  it('returns an empty list when nothing has content', () => {
    expect(eligibleScenes({ up_next: [], earned: [], operator: null })).toEqual([])
  })

  it('tolerates a missing or malformed idle block', () => {
    expect(eligibleScenes(null)).toEqual([])
    expect(eligibleScenes(undefined)).toEqual([])
    expect(eligibleScenes({})).toEqual([])
    expect(eligibleScenes({ up_next: 'nope', earned: 7, operator: 'x' })).toEqual([])
  })
})

describe('sceneAt', () => {
  it('holds each scene for SCENE_DWELL_MS then advances', () => {
    const e = ['up-next', 'earned', 'operator']
    expect(sceneAt(e, 0)).toBe('up-next')
    expect(sceneAt(e, SCENE_DWELL_MS - 1)).toBe('up-next')
    expect(sceneAt(e, SCENE_DWELL_MS)).toBe('earned')
    expect(sceneAt(e, SCENE_DWELL_MS * 2)).toBe('operator')
  })

  it('wraps after the last scene', () => {
    const e = ['up-next', 'earned', 'operator']
    expect(sceneAt(e, SCENE_DWELL_MS * 3)).toBe('up-next')
    expect(sceneAt(e, SCENE_DWELL_MS * 4)).toBe('earned')
  })

  it('stays put when only one scene is eligible', () => {
    expect(sceneAt(['earned'], 0)).toBe('earned')
    expect(sceneAt(['earned'], SCENE_DWELL_MS * 99)).toBe('earned')
  })

  it('returns null for an empty list', () => {
    expect(sceneAt([], 0)).toBeNull()
    expect(sceneAt([], SCENE_DWELL_MS * 5)).toBeNull()
  })

  // Review Focus 5 — the list shrinking mid-cycle must never index past the end.
  it('never indexes past a list that just shrank', () => {
    const late = SCENE_DWELL_MS * 2 + 10 // was showing index 2 of three
    expect(sceneAt(['up-next', 'earned'], late)).toBe('up-next')
    expect(sceneAt(['up-next'], late)).toBe('up-next')
  })

  it('treats a negative or non-finite elapsed as the first scene', () => {
    const e = ['up-next', 'earned']
    expect(sceneAt(e, -5)).toBe('up-next')
    expect(sceneAt(e, NaN)).toBe('up-next')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/tv-scenes.test.js`
Expected: FAIL — `Failed to resolve import "./tv-scenes.js"`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/lib/tv-scenes.js
//
// TVSCENE.1 — which idle scene is on screen, and when.
//
// Pure on purpose. The scene index is a FUNCTION OF ELAPSED TIME, not a
// timer: the board already re-renders every second for its header clock, so
// `sceneAt` advances itself with no setTimeout to reset. That is deliberate —
// a dwell timer in this file's sibling component is exactly the shape of
// TVTOAST.1 (#2066), where an effect depending on a callback identity that
// changed every second meant the timeout never fired. No timer, no bug.

/** How long one scene holds the screen. Richard's call, 2026-10-15. */
export const SCENE_DWELL_MS = 30000

/** Rotation order. A scene with no content is skipped, never shown empty. */
export const SCENE_KEYS = ['up-next', 'earned', 'operator']

const HAS_CONTENT = {
  'up-next': (idle) => Array.isArray(idle?.up_next) && idle.up_next.length > 0,
  earned: (idle) => Array.isArray(idle?.earned) && idle.earned.length > 0,
  operator: (idle) => Boolean(idle?.operator && typeof idle.operator === 'object'),
}

/**
 * The scenes that currently have something to say, in rotation order.
 * A scene with nothing is skipped entirely — no "nothing this week" card.
 *
 * @param {object|null|undefined} idle  the payload's `idle` block
 * @returns {string[]}
 */
export function eligibleScenes(idle) {
  return SCENE_KEYS.filter((key) => HAS_CONTENT[key](idle))
}

/**
 * Which eligible scene is showing, given how long the board has been idle.
 * Tolerates the list shrinking between polls: the modulo is taken against the
 * CURRENT length, so an expiring scene can never leave the index out of range.
 *
 * @param {string[]} eligible
 * @param {number} elapsedMs
 * @returns {string|null} null when nothing is eligible
 */
export function sceneAt(eligible, elapsedMs) {
  const list = Array.isArray(eligible) ? eligible : []
  if (list.length === 0) return null
  const ms = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  return list[Math.floor(ms / SCENE_DWELL_MS) % list.length]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/tv-scenes.test.js`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/tv-scenes.js src/lib/tv-scenes.test.js
git commit -m "TVSCENE.1 — scene eligibility and time-derived rotation

Pure module. sceneAt is a function of elapsed time rather than a
setTimeout, because the board already re-renders at 1 Hz for its clock —
which removes the TVTOAST.1 (#2066) failure shape entirely instead of
guarding against it. The modulo is taken against the CURRENT eligible
length so a scene expiring between polls cannot leave the index out of
range."
```

---

### Task 2: The `idle` payload block

Three reads, added to the branch of `buildLiveBoardPayload` that already early-returns when there are no open sessions. Each fails to absent.

**Files:**
- Create: `src/lib/tv-idle-content.js`
- Test: `src/lib/tv-idle-content.test.js`
- Modify: `src/lib/live-board.js` (the `if (!sessions || sessions.length === 0)` early return, ~line 107)
- Modify: `src/app/api/public/tv-live/[token]/route.js` (select `id` from `tv_displays`, pass `displayId`)
- Test: `src/app/api/public/tv-live/[token]/route.board.test.js` (extend)

**Interfaces:**
- Consumes: nothing from Task 1 (the payload is independent of rotation).
- Produces: `buildIdleContent(db, { locationId, displayId, zone, nowMs }): Promise<{ up_next: Array, earned: Array, operator: object|null }>`
  - `up_next` entries: `{ starts_at: string, starts_at_label: string, class_name: string|null, program: string|null }`
  - `earned` entries: `{ display_name: string, achievement: string, tier: number|null, earned_at: string }`
  - `operator`: `{ source_type: string, source_ref: string|null, label: string|null, template_values: object|null }` or `null`
  - The `idle` key appears on the payload **only** in the no-sessions branch.

- [ ] **Step 1: Write the failing test**

```js
// src/lib/tv-idle-content.test.js
import { describe, it, expect, vi } from 'vitest'
import { buildIdleContent, EARNED_WINDOW_MS, UP_NEXT_LIMIT } from './tv-idle-content.js'

const ZONE = 'Europe/Dublin'
const LOC = 'a0000000-0000-0000-0000-000000000001'
const NOW = Date.parse('2026-10-16T04:00:00Z') // 05:00 Dublin, IST

// Minimal supabase-shaped stub: each table answers with a canned result.
function dbWith({ occurrences = [], achievements = [], content = null, fail = {} } = {}) {
  const table = (rows, shouldFail) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      gte: () => chain,
      lte: () => chain,
      is: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve(shouldFail
        ? { data: null, error: new Error('boom') }
        : { data: rows[0] ?? null, error: null }),
      then: (resolve) => resolve(shouldFail
        ? { data: null, error: new Error('boom') }
        : { data: rows, error: null }),
    }
    return chain
  }
  return {
    from: (name) => {
      if (name === 'class_occurrences') return table(occurrences, fail.occurrences)
      if (name === 'contact_achievements') return table(achievements, fail.achievements)
      if (name === 'tv_content') return table(content ? [content] : [], fail.content)
      throw new Error(`unexpected table ${name}`)
    },
  }
}

describe('buildIdleContent — up_next', () => {
  it('returns future, non-cancelled occurrences with a studio-zone label', async () => {
    const db = dbWith({ occurrences: [
      { name: 'BU1LD — Strength', program: 'BU1LD', starts_at: '2026-10-16T05:00:00Z' },
      { name: 'The 50+ Club', program: null, starts_at: '2026-10-16T10:00:00Z' },
    ] })
    const out = await buildIdleContent(db, { locationId: LOC, displayId: 'd1', zone: ZONE, nowMs: NOW })
    expect(out.up_next).toEqual([
      { starts_at: '2026-10-16T05:00:00Z', starts_at_label: '06:00', class_name: 'BU1LD — Strength', program: 'BU1LD' },
      { starts_at: '2026-10-16T10:00:00Z', starts_at_label: '11:00', class_name: 'The 50+ Club', program: null },
    ])
  })

  // Review Focus 2 — Irish summer time ends 2026-10-25.
  it('labels a class on the morning after the DST change in studio local time', async () => {
    const afterDst = Date.parse('2026-10-26T04:00:00Z') // 04:00 Dublin, GMT
    const db = dbWith({ occurrences: [
      { name: 'BU1LD — Strength', program: null, starts_at: '2026-10-26T06:00:00Z' },
    ] })
    const out = await buildIdleContent(db, { locationId: LOC, displayId: 'd1', zone: ZONE, nowMs: afterDst })
    expect(out.up_next[0].starts_at_label).toBe('06:00')
  })

  it('never returns more than UP_NEXT_LIMIT entries', async () => {
    const many = Array.from({ length: UP_NEXT_LIMIT + 4 }, (_, i) => ({
      name: `Class ${i}`, program: null, starts_at: new Date(NOW + (i + 1) * 3600_000).toISOString(),
    }))
    const out = await buildIdleContent(db0(many), { locationId: LOC, displayId: 'd1', zone: ZONE, nowMs: NOW })
    expect(out.up_next).toHaveLength(UP_NEXT_LIMIT)
  })

  it('is empty, not an error, when the occurrence read fails', async () => {
    const db = dbWith({ fail: { occurrences: true } })
    const out = await buildIdleContent(db, { locationId: LOC, displayId: 'd1', zone: ZONE, nowMs: NOW })
    expect(out.up_next).toEqual([])
  })
})

function db0(occurrences) { return dbWith({ occurrences }) }

describe('buildIdleContent — earned', () => {
  const row = (over = {}) => ({
    earned_at: '2026-10-15T18:00:00Z',
    achievement_rules: { name: '50 classes', tier: 4 },
    contacts: { name: 'Saoirse Murphy', location_id: LOC, hr_leaderboard_opt_out: false },
    ...over,
  })

  it('renders first name + last initial only', async () => {
    const out = await buildIdleContent(dbWith({ achievements: [row()] }),
      { locationId: LOC, displayId: 'd1', zone: ZONE, nowMs: NOW })
    expect(out.earned).toEqual([
      { display_name: 'Saoirse M.', achievement: '50 classes', tier: 4, earned_at: '2026-10-15T18:00:00Z' },
    ])
  })

  it('uses the bare first name when there is no surname', async () => {
    const out = await buildIdleContent(dbWith({ achievements: [row({ contacts: { name: 'Cher', location_id: LOC, hr_leaderboard_opt_out: false } })] }),
      { locationId: LOC, displayId: 'd1', zone: ZONE, nowMs: NOW })
    expect(out.earned[0].display_name).toBe('Cher')
  })

  it('drops an opted-out member', async () => {
    const out = await buildIdleContent(dbWith({ achievements: [row({ contacts: { name: 'Opt Out', location_id: LOC, hr_leaderboard_opt_out: true } })] }),
      { locationId: LOC, displayId: 'd1', zone: ZONE, nowMs: NOW })
    expect(out.earned).toEqual([])
  })

  // Review Focus 1 — contact erasure is routine; the join can come back null.
  it('drops a row whose contact no longer resolves', async () => {
    const out = await buildIdleContent(dbWith({ achievements: [row({ contacts: null })] }),
      { locationId: LOC, displayId: 'd1', zone: ZONE, nowMs: NOW })
    expect(out.earned).toEqual([])
  })

  it('drops a row whose rule no longer resolves', async () => {
    const out = await buildIdleContent(dbWith({ achievements: [row({ achievement_rules: null })] }),
      { locationId: LOC, displayId: 'd1', zone: ZONE, nowMs: NOW })
    expect(out.earned).toEqual([])
  })

  it('drops a contact belonging to another studio', async () => {
    const out = await buildIdleContent(dbWith({ achievements: [row({ contacts: { name: 'Hatch Person', location_id: 'b0000000-0000-0000-0000-000000000002', hr_leaderboard_opt_out: false } })] }),
      { locationId: LOC, displayId: 'd1', zone: ZONE, nowMs: NOW })
    expect(out.earned).toEqual([])
  })

  it('is empty, not an error, when the achievement read fails', async () => {
    const out = await buildIdleContent(dbWith({ fail: { achievements: true } }),
      { locationId: LOC, displayId: 'd1', zone: ZONE, nowMs: NOW })
    expect(out.earned).toEqual([])
  })

  it('exports a 7-day window', () => {
    expect(EARNED_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

describe('buildIdleContent — operator', () => {
  it('returns the pushed content row', async () => {
    const out = await buildIdleContent(dbWith({ content: { source_type: 'storage', source_ref: 'a.png', label: 'Offer', template_values: null, pushed_at: '2026-10-15T09:00:00Z' } }),
      { locationId: LOC, displayId: 'd1', zone: ZONE, nowMs: NOW })
    expect(out.operator).toEqual({ source_type: 'storage', source_ref: 'a.png', label: 'Offer', template_values: null })
  })

  it('is null when nothing is pushed', async () => {
    const out = await buildIdleContent(dbWith({}), { locationId: LOC, displayId: 'd1', zone: ZONE, nowMs: NOW })
    expect(out.operator).toBeNull()
  })

  it('is null when there is no display id', async () => {
    const out = await buildIdleContent(dbWith({ content: { source_type: 'storage', source_ref: 'a.png', label: null, template_values: null } }),
      { locationId: LOC, displayId: null, zone: ZONE, nowMs: NOW })
    expect(out.operator).toBeNull()
  })

  it('is null, not an error, when the content read fails', async () => {
    const out = await buildIdleContent(dbWith({ fail: { content: true } }),
      { locationId: LOC, displayId: 'd1', zone: ZONE, nowMs: NOW })
    expect(out.operator).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/tv-idle-content.test.js`
Expected: FAIL — `Failed to resolve import "./tv-idle-content.js"`.

- [ ] **Step 3: Write minimal implementation**

```js
// src/lib/tv-idle-content.js
//
// TVSCENE.1 — the three idle scenes' data, read only when the board has no
// open sessions. Every read FAILS TO ABSENT: a scene with no content is
// skipped by the scheduler, which is correct; a stack trace on a studio
// floor is not. Nothing here may return an aggregate COUNT — individual
// member moments only (see the spec's constraint 1).

import { timeLabelIn } from '@/lib/location-time'

/** How far back "earned this week" looks. 65 rows / 61 people at Stillorgan. */
export const EARNED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
/** Rows the Up next scene can show at 720px without crowding. */
export const UP_NEXT_LIMIT = 6
/** Rows the Earned scene can show at 720px without crowding. */
export const EARNED_LIMIT = 5

/** First name + last initial — the board's privacy floor, as live-board.js. */
function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]
  return `${parts[0]} ${parts[parts.length - 1][0]}.`
}

async function readUpNext(db, { locationId, zone, nowMs }) {
  try {
    const { data, error } = await db
      .from('class_occurrences')
      .select('name, program, starts_at')
      .eq('location_id', locationId)
      .is('cancelled_at', null)
      .gte('starts_at', new Date(nowMs).toISOString())
      .order('starts_at', { ascending: true })
      .limit(UP_NEXT_LIMIT)
    if (error) return []
    return (data || []).slice(0, UP_NEXT_LIMIT).map((o) => ({
      starts_at: o.starts_at,
      starts_at_label: timeLabelIn(o.starts_at, zone),
      class_name: o.name || null,
      program: o.program || null,
    }))
  } catch {
    return []
  }
}

async function readEarned(db, { locationId, nowMs }) {
  try {
    const { data, error } = await db
      .from('contact_achievements')
      .select('earned_at, achievement_rules!rule_id(name, tier), contacts!contact_id(name, location_id, hr_leaderboard_opt_out)')
      .gte('earned_at', new Date(nowMs - EARNED_WINDOW_MS).toISOString())
      .order('earned_at', { ascending: false })
      .limit(100)
    if (error) return []
    const out = []
    for (const row of data || []) {
      const c = row?.contacts
      const r = row?.achievement_rules
      // A contact can be erased (CASCADE) or belong to another studio; a rule
      // can be deleted. Any of those is a row we drop, never a "Member" tile.
      if (!c || !r) continue
      if (c.location_id !== locationId) continue
      if (c.hr_leaderboard_opt_out) continue
      const name = shortName(c.name)
      if (!name) continue
      out.push({
        display_name: name,
        achievement: r.name,
        tier: r.tier ?? null,
        earned_at: row.earned_at,
      })
      if (out.length >= EARNED_LIMIT) break
    }
    return out
  } catch {
    return []
  }
}

async function readOperator(db, { displayId }) {
  if (!displayId) return null
  try {
    const { data, error } = await db
      .from('tv_content')
      .select('source_type, source_ref, label, template_values')
      .eq('tv_display_id', displayId)
      .maybeSingle()
    if (error || !data) return null
    return {
      source_type: data.source_type,
      source_ref: data.source_ref ?? null,
      label: data.label ?? null,
      template_values: data.template_values ?? null,
    }
  } catch {
    return null
  }
}

/**
 * Build the idle block. Called ONLY from the no-sessions branch of
 * buildLiveBoardPayload, so a live class pays nothing for it.
 *
 * @param {object} db  service-role Supabase client
 * @param {object} opts
 * @param {string} opts.locationId
 * @param {string|null} opts.displayId
 * @param {string} opts.zone       IANA zone of the studio
 * @param {number} opts.nowMs
 * @returns {Promise<{ up_next: Array, earned: Array, operator: object|null }>}
 */
export async function buildIdleContent(db, { locationId, displayId = null, zone, nowMs = Date.now() } = {}) {
  const [up_next, earned, operator] = await Promise.all([
    readUpNext(db, { locationId, zone, nowMs }),
    readEarned(db, { locationId, nowMs }),
    readOperator(db, { displayId }),
  ])
  return { up_next, earned, operator }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/tv-idle-content.test.js`
Expected: PASS.

- [ ] **Step 5: Wire it into the payload**

In `src/lib/live-board.js`, add the import beside the others:

```js
import { buildIdleContent } from '@/lib/tv-idle-content'
```

Change the signature's opts to accept the display id — find:

```js
export async function buildLiveBoardPayload(db, { location, nowMs = Date.now() } = {}) {
```

and make it:

```js
export async function buildLiveBoardPayload(db, { location, displayId = null, nowMs = Date.now() } = {}) {
```

Then in the early-return branch (`if (!sessions || sessions.length === 0) {`), build the block and add one key. The branch becomes:

```js
  if (!sessions || sessions.length === 0) {
    // TVSCENE.1 — idle scenes. Built ONLY here, so a live class pays nothing
    // for these three reads. Each one fails to absent, never to an error.
    const idle = await buildIdleContent(db, {
      locationId,
      displayId,
      zone,
      nowMs,
    })
    return {
      ok: true,
      server_time: new Date().toISOString(),
      timezone: zone,
      location: { id: location.id, name: location.name },
      bridge,
      sessions: [],
      available_straps: availableStraps,
      timer: timerRun || null,
      current_class: currentClass,
      idle,
    }
  }
```

Leave the final return (the live branch) untouched — it must NOT carry an `idle` key.

- [ ] **Step 6: Pass the display id from the route**

In `src/app/api/public/tv-live/[token]/route.js`, the display read currently selects two columns. Change:

```js
    .select('location_id, active')
```

to:

```js
    .select('id, location_id, active')
```

and the payload call to pass it:

```js
  const payload = await buildLiveBoardPayload(db, { location, displayId: display.id })
```

- [ ] **Step 7: Write the payload-shape test**

Append to `src/app/api/public/tv-live/[token]/route.board.test.js`, using that file's own
`makeDb({ samples, sessions })` and `callRoute(db)` helpers:

```js
describe('TVSCENE.1 — idle block', () => {
  it('carries an idle block when there are no open sessions', async () => {
    const db = makeDb({ samples: [], sessions: [] })
    const res = await callRoute(db)
    const body = await res.json()

    expect(body.sessions).toEqual([])
    expect(body.idle).toBeDefined()
    expect(body.idle).toHaveProperty('up_next')
    expect(body.idle).toHaveProperty('earned')
    expect(body.idle).toHaveProperty('operator')
  })

  // Fail-to-absent, end to end: this stub serves no class_occurrences,
  // contact_achievements or tv_content, so every read inside buildIdleContent
  // throws and is caught. The block must still arrive, empty — a scene the
  // scheduler skips is correct; a 500 on a studio TV is not. Content
  // correctness is covered by src/lib/tv-idle-content.test.js.
  it('returns an empty idle block rather than failing when the reads cannot be served', async () => {
    const db = makeDb({ samples: [], sessions: [] })
    const res = await callRoute(db)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.ok).toBe(true)
    expect(body.idle.up_next).toEqual([])
    expect(body.idle.earned).toEqual([])
    expect(body.idle.operator).toBeNull()
  })

  it('omits idle entirely while a session is open', async () => {
    const db = makeDb({ samples: [] }) // the file's default fixture carries one session
    const res = await callRoute(db)
    const body = await res.json()

    expect(body.sessions.length).toBeGreaterThan(0)
    expect(body.idle).toBeUndefined()
  })
})
```

- [ ] **Step 8: Run the affected suites**

Run: `npx vitest run src/lib/tv-idle-content.test.js 'src/app/api/public/tv-live/[token]' src/lib/live-board.test.js`
Expected: PASS. Then `npm run check:select-columns` — every column named above must resolve against the migrations.

- [ ] **Step 9: Commit**

```bash
git add src/lib/tv-idle-content.js src/lib/tv-idle-content.test.js src/lib/live-board.js 'src/app/api/public/tv-live/[token]/route.js' 'src/app/api/public/tv-live/[token]/route.board.test.js'
git commit -m "TVSCENE.1 — idle content block on the live board payload

Three reads in the branch that already early-returns with no open
sessions, so a live class pays nothing for them. Each fails to absent:
a scene the scheduler skips is correct, a stack trace on a studio floor
is not.

Achievements are scoped through contacts.location_id (the table has no
location of its own) and drop an erased contact, a deleted rule and an
opted-out member. Class times are labelled with timeLabelIn in the
studio zone, which is what keeps 06:00 reading 06:00 across the
2026-10-25 DST change."
```

---

### Task 3: The idle stage and three scenes

**Files:**
- Create: `src/app/tv/live/[token]/IdleStage.jsx`
- Test: `src/app/tv/live/[token]/IdleStage.test.jsx`
- Modify: `src/app/tv/live/[token]/LiveTvClient.jsx` (the `tiles.length === 0` branch, ~line 388)

**Interfaces:**
- Consumes: `SCENE_DWELL_MS`, `eligibleScenes`, `sceneAt` from `src/lib/tv-scenes.js` (Task 1); the `idle` block shape from Task 2.
- Produces: `default export IdleStage({ idle, nowMs, idleSinceMs, fonts })` — renders one scene, or `null` when nothing is eligible so the caller can fall back to `EmptyBoard`.

- [ ] **Step 1: Write the failing test**

```jsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { SCENE_DWELL_MS } from '@/lib/tv-scenes'
import IdleStage from './IdleStage.jsx'

const fonts = { display: 'sans-serif', body: 'sans-serif', mono: 'monospace' }
const idle = {
  up_next: [{ starts_at: '2026-10-16T05:00:00Z', starts_at_label: '06:00', class_name: 'BU1LD — Strength', program: 'BU1LD' }],
  earned: [{ display_name: 'Saoirse M.', achievement: '50 classes', tier: 4, earned_at: '2026-10-15T18:00:00Z' }],
  operator: null,
}

afterEach(cleanup)

const at = (ms, over = {}) => render(
  <IdleStage idle={{ ...idle, ...over }} nowMs={1000 + ms} idleSinceMs={1000} fonts={fonts} />,
)

describe('IdleStage', () => {
  it('shows Up next first', () => {
    at(0)
    expect(screen.getByText('06:00')).toBeTruthy()
    expect(screen.getByText('BU1LD — Strength')).toBeTruthy()
  })

  it('advances to Earned after one dwell', () => {
    at(SCENE_DWELL_MS)
    expect(screen.getByText('Saoirse M.')).toBeTruthy()
    expect(screen.getByText('50 classes')).toBeTruthy()
  })

  it('wraps back to Up next after the last eligible scene', () => {
    at(SCENE_DWELL_MS * 2)
    expect(screen.getByText('06:00')).toBeTruthy()
  })

  it('renders null when nothing is eligible, so the caller can fall back', () => {
    const { container } = render(
      <IdleStage idle={{ up_next: [], earned: [], operator: null }} nowMs={1000} idleSinceMs={1000} fonts={fonts} />,
    )
    expect(container.firstChild).toBeNull()
  })

  // Constraint 1 — no aggregate studio metrics anywhere on screen.
  it('never renders a count of achievements', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      display_name: `P${i} X.`, achievement: 'First class', tier: 1, earned_at: '2026-10-15T18:00:00Z',
    }))
    const { container } = render(
      <IdleStage idle={{ up_next: [], earned: many, operator: null }} nowMs={1000} idleSinceMs={1000} fonts={fonts} />,
    )
    expect(container.textContent).not.toMatch(/\b5\b/)
    expect(container.textContent).not.toMatch(/this month|in total|members/i)
  })

  // Constraint: time and name only — never capacity.
  it('never renders capacity or headcount on Up next', () => {
    const { container } = render(
      <IdleStage idle={{ ...idle, earned: [] }} nowMs={1000} idleSinceMs={1000} fonts={fonts} />,
    )
    expect(container.textContent).not.toMatch(/spaces|places|booked|\bfull\b|\d+\s*\/\s*\d+/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run 'src/app/tv/live/[token]/IdleStage.test.jsx'`
Expected: FAIL — cannot resolve `./IdleStage.jsx`.

- [ ] **Step 3: Write the component**

```jsx
// src/app/tv/live/[token]/IdleStage.jsx
'use client'

// TVSCENE.1 — what the board shows when nothing is live.
//
// Stateless on purpose: the scene is derived from (nowMs - idleSinceMs), and
// the board already re-renders every second for its header clock, so the
// rotation advances with no timer of its own. See src/lib/tv-scenes.js.
//
// 720px budget: this component is the flex child that YIELDS (min-h-0), the
// same contract as the tile grid it replaces. Nothing here is fixed-height.

import { eligibleScenes, sceneAt } from '@/lib/tv-scenes'

const BONE = '#F1EEE7'
const BONE_2 = '#B1AEA6'
const BONE_3 = '#75726B'
const VOLT = '#D6FF3D'
const VOLT_INK = '#2A3305'
const SURFACE = '#1C1C21'
const HAIRLINE = '#30303A'

function Kicker({ children, fonts }) {
  return (
    <p
      className="shrink-0 text-[11px] uppercase tracking-[0.2em]"
      style={{ fontFamily: fonts.mono, color: BONE_3 }}
    >
      {children}
    </p>
  )
}

function UpNextScene({ rows, fonts }) {
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <Kicker fonts={fonts}>Up next</Kicker>
      <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
        {rows.map((r, i) => (
          <div key={`${r.starts_at}-${i}`} className="flex shrink-0 items-baseline gap-6">
            <span
              className="tabular-nums"
              style={{ fontFamily: fonts.display, fontWeight: 800, fontSize: 40, color: i === 0 ? VOLT : BONE }}
            >
              {r.starts_at_label}
            </span>
            <span style={{ fontFamily: fonts.body, fontWeight: 600, fontSize: 26, color: i === 0 ? BONE : BONE_2 }}>
              {r.class_name || 'Class'}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function EarnedScene({ rows, fonts }) {
  return (
    <div className="flex min-h-0 flex-col gap-4">
      <Kicker fonts={fonts}>Earned this week</Kicker>
      <div className="flex min-h-0 flex-col gap-3 overflow-hidden">
        {rows.map((r, i) => {
          const top = Number(r.tier) >= 4
          return (
            <div key={`${r.display_name}-${r.achievement}-${i}`} className="flex shrink-0 items-center gap-6">
              <span style={{ fontFamily: fonts.body, fontWeight: 700, fontSize: 30, color: BONE, minWidth: 260 }}>
                {r.display_name}
              </span>
              <span
                className="rounded-full px-5 py-1.5"
                style={{
                  fontFamily: fonts.display, fontWeight: 700, fontSize: 20,
                  background: top ? VOLT : SURFACE,
                  color: top ? VOLT_INK : BONE,
                  border: `1px solid ${top ? VOLT : HAIRLINE}`,
                }}
              >
                {r.achievement}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function OperatorScene({ operator, fonts }) {
  // Images are the common push; a template renders through the cast canvas in
  // a later pass. Until then an unrenderable type shows its label only, which
  // is still operator-editable copy rather than a hard-coded string.
  const isImage = operator.source_type === 'storage' || operator.source_type === 'url'
  if (isImage && operator.source_ref) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={operator.source_ref}
          alt={operator.label || ''}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    )
  }
  if (!operator.label) return null
  return (
    <div className="flex min-h-0 flex-1 items-center">
      <p style={{ fontFamily: fonts.display, fontWeight: 800, fontSize: 52, color: BONE, letterSpacing: '-0.02em' }}>
        {operator.label}
      </p>
    </div>
  )
}

/**
 * One idle scene, chosen by elapsed time. Returns null when nothing is
 * eligible so the caller can fall back to its own empty board.
 */
export default function IdleStage({ idle, nowMs, idleSinceMs, fonts }) {
  const eligible = eligibleScenes(idle)
  const key = sceneAt(eligible, Number(nowMs) - Number(idleSinceMs))
  if (!key) return null

  let body = null
  if (key === 'up-next') body = <UpNextScene rows={idle.up_next} fonts={fonts} />
  else if (key === 'earned') body = <EarnedScene rows={idle.earned} fonts={fonts} />
  else if (key === 'operator') body = <OperatorScene operator={idle.operator} fonts={fonts} />
  if (!body) return null

  return (
    <div key={key} className="flex min-h-0 flex-1 flex-col justify-center px-10 py-6">
      {body}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run 'src/app/tv/live/[token]/IdleStage.test.jsx'`
Expected: PASS, 6 tests.

- [ ] **Step 5: Wire it into the board**

In `LiveTvClient.jsx`, add the import beside the other local ones:

```js
import IdleStage from './IdleStage'
```

Track when the board went idle, so the rotation starts at scene one each time rather than mid-cycle. Add beside the other refs (near `prevSnapshotRef`):

```js
  // TVSCENE.1 — when the board last became idle. The scene rotation is derived
  // from this, so a board that has just emptied starts at the first scene.
  const idleSinceRef = useRef(Date.now())
  const wasIdleRef = useRef(true)
```

and immediately before the return, after `tiles` is known:

```js
  const isIdle = tiles.length === 0
  if (isIdle && !wasIdleRef.current) idleSinceRef.current = Date.now()
  wasIdleRef.current = isIdle
```

Then replace the idle branch. Find:

```jsx
      {tiles.length === 0 ? (
        data?.timer
          ? <TimerBanner placement="hero" portrait={portrait} timer={data?.timer} serverTime={data?.server_time} />
          : <EmptyBoard />
      ) : (
```

and make it:

```jsx
      {tiles.length === 0 ? (
        data?.timer
          ? <TimerBanner placement="hero" portrait={portrait} timer={data?.timer} serverTime={data?.server_time} />
          : (
            <IdleStage
              idle={data?.idle}
              nowMs={now.getTime()}
              idleSinceMs={idleSinceRef.current}
              fonts={{ display: FONT_DISPLAY, body: FONT_BODY, mono: FONT_MONO }}
            />
            ?? <EmptyBoard />
          )
      ) : (
```

`??` does not work on JSX, so write the fallback as a small local instead — put this just above the return:

```js
  const idleStage = isIdle && !data?.timer
    ? (
      <IdleStage
        idle={data?.idle}
        nowMs={now.getTime()}
        idleSinceMs={idleSinceRef.current}
        fonts={{ display: FONT_DISPLAY, body: FONT_BODY, mono: FONT_MONO }}
      />
    )
    : null
```

and make the branch:

```jsx
      {tiles.length === 0 ? (
        data?.timer
          ? <TimerBanner placement="hero" portrait={portrait} timer={data?.timer} serverTime={data?.server_time} />
          : (idleStage ?? <EmptyBoard />)
      ) : (
```

`IdleStage` returns `null` when nothing is eligible, and `null ?? <EmptyBoard />` yields `<EmptyBoard />`, so the floor is never worse than today.

- [ ] **Step 6: Write the yield-to-live test**

This is the load-bearing guarantee of the whole approach — it is why the rotation lives
inside the board rather than in a separate app. Create
`src/app/tv/live/[token]/LiveTvClient.idle.test.jsx`:

```jsx
// @vitest-environment jsdom
//
// TVSCENE.1 — the scene layer must hand the screen to the live tiles the
// instant a band connects: same component, same render pass, no URL change.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, screen, act, waitFor } from '@testing-library/react'

vi.mock('@/fonts/repset', () => ({
  repsetDisplay: { style: { fontFamily: 'sans-serif' } },
  repsetBody: { style: { fontFamily: 'sans-serif' } },
  repsetMono: { style: { fontFamily: 'monospace' } },
}))
vi.mock('@/lib/supabase', () => ({ createBrowserClient: vi.fn(() => null) }))

import LiveTvClient from './LiveTvClient.jsx'

const BASE = {
  ok: true,
  server_time: '2026-10-16T05:00:00Z',
  timezone: 'Europe/Dublin',
  location: { id: 'loc-1', name: 'UN1T Stillorgan' },
  bridge: { online: true },
  available_straps: [],
  timer: null,
  current_class: null,
}

const IDLE = {
  ...BASE,
  sessions: [],
  idle: {
    up_next: [{ starts_at: '2026-10-16T05:00:00Z', starts_at_label: '06:00', class_name: 'BU1LD — Strength', program: null }],
    earned: [],
    operator: null,
  },
}

// Exactly the tile shape live-board.js emits.
const LIVE = {
  ...BASE,
  sessions: [{
    id: 's1',
    displayName: 'Strap 49931',
    currentBpm: 150,
    currentZone: { id: 4, label: 'Z4', color: '#E8913C' },
    zonesSeconds: { 1: 0, 2: 0, 3: 0, 4: 60, 5: 0 },
    effortPoints: 12,
    peakBpm: 161,
    avgBpm: 148,
    startedAt: '2026-10-16T05:05:00Z',
    stale: false,
  }],
}

function serve(payload) {
  global.fetch = vi.fn(() => Promise.resolve({
    ok: true, status: 200, json: () => Promise.resolve(payload),
  }))
}

beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { cleanup(); delete global.fetch })

describe('idle stage ↔ live tiles', () => {
  it('shows a scene while no band is connected', async () => {
    serve(IDLE)
    render(<LiveTvClient endpoint="/api/public/tv-live/tok-1" device={null} />)
    await waitFor(() => expect(screen.getByText('BU1LD — Strength')).toBeTruthy())
    expect(screen.queryByText('Waiting for class to start')).toBeNull()
  })

  it('yields the screen to the tiles the moment a session appears', async () => {
    serve(IDLE)
    const { rerender } = render(<LiveTvClient endpoint="/api/public/tv-live/tok-1" device={null} />)
    await waitFor(() => expect(screen.getByText('BU1LD — Strength')).toBeTruthy())

    // Next poll carries a live session.
    serve(LIVE)
    await act(async () => {
      rerender(<LiveTvClient endpoint="/api/public/tv-live/tok-1" device={null} />)
    })

    await waitFor(() => expect(screen.getByText('Strap 49931')).toBeTruthy())
    expect(screen.queryByText('BU1LD — Strength')).toBeNull()
  })

  it('falls back to the empty board when no scene has content', async () => {
    serve({ ...BASE, sessions: [], idle: { up_next: [], earned: [], operator: null } })
    render(<LiveTvClient endpoint="/api/public/tv-live/tok-1" device={null} />)
    await waitFor(() => expect(screen.getByText('Waiting for class to start')).toBeTruthy())
  })

  it('falls back to the empty board when the payload has no idle block at all', async () => {
    serve({ ...BASE, sessions: [] })
    render(<LiveTvClient endpoint="/api/public/tv-live/tok-1" device={null} />)
    await waitFor(() => expect(screen.getByText('Waiting for class to start')).toBeTruthy())
  })
})
```

If `LiveTvClient`'s props differ from `{ endpoint, device }`, read the prop names off
`src/app/tv/live/[token]/page.jsx` (which constructs it) and use those — the assertions
are unchanged.

- [ ] **Step 7: Run the suite**

Run: `npx vitest run 'src/app/tv/live/[token]'`
Expected: PASS, including the existing toast and page tests.

- [ ] **Step 8: Commit**

```bash
git add 'src/app/tv/live/[token]/IdleStage.jsx' 'src/app/tv/live/[token]/IdleStage.test.jsx' 'src/app/tv/live/[token]/LiveTvClient.jsx'
git commit -m "TVSCENE.1 — idle stage with three rotating scenes

Up next, Earned this week and the operator card, one at a time on a 30s
dwell derived from elapsed time rather than a timer. IdleStage returns
null when no scene has content, and null ?? <EmptyBoard /> means the
floor is never worse than today.

The live tiles still win on the same condition as before
(tiles.length === 0), so a band connecting takes the screen in the same
render pass — no URL change and no second page, which is the whole
reason the rotation lives in the board."
```

---

### Task 4: Layout verification and ship

jsdom cannot see layout, and a row that overflows 720px pushes the countdown off a real TV. This task is the only one whose evidence comes from a browser.

**Files:**
- Modify: whichever scene overflows (expect `IdleStage.jsx` only)
- Create: `docs/changelog/entries/<PR>.md` (after `gh pr create`)

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: a merged PR.

- [ ] **Step 1: Run the full CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: all thirteen green. `check:select-columns` is the one most likely to bite — it replays the migrations and will reject any column named in Task 2 that does not exist.

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: success. This task adds a new import and a new component file, which is exactly the case the repo's own guidance says vitest cannot catch.

- [ ] **Step 3: Verify at 1280×720 in a real browser**

Start the dev server and open the board. Local dev has no database, so use a **Vercel preview** of the PR branch for real data (see `local-dev-login`), or stub the payload locally.

Set the viewport to exactly 1280×720, then for each of the three scenes confirm:

```js
// In the browser console, with a scene on screen:
document.documentElement.scrollHeight <= 720   // must be true — no vertical overflow
document.body.scrollWidth <= 1280              // must be true — no horizontal scroll
```

And confirm by eye: the header, the scene and the signature footer are all visible, nothing is clipped mid-row, and the next-class row is readable from across a room.

- [ ] **Step 4: Fix any overflow**

If a scene exceeds 720px, reduce its row count (`UP_NEXT_LIMIT` / `EARNED_LIMIT` in `src/lib/tv-idle-content.js`) rather than shrinking type — the board is read from across a room, so row count is the right lever. Re-run step 3.

- [ ] **Step 5: Commit any fix and push**

```bash
git add -A
git commit -m "TVSCENE.1 — row budgets verified at 1280x720"
git push -u origin HEAD
```

- [ ] **Step 6: Open the PR**

```bash
gh pr create --base main --fill
```

Report the URL. Pushing is not shipping.

- [ ] **Step 7: Add the changelog entry**

Create `docs/changelog/entries/<PR>.md` — ONE markdown table row keyed `#<PR>`, no header,
never editing another PR's file:

```markdown
| #<PR> | TVSCENE.1 — idle scenes on the studio TV board | 2026-10-15. The board showed `EmptyBoard` ("Waiting for class to start") whenever no band was connected — ~80% of the day, and much of class time too (112 bridge sessions in 30 days, so a strapless class looked like an empty studio). Adds a scene layer that owns the screen only when `tiles.length === 0`, leaving the live tile path and `OutroPodium` untouched: Up next (`class_occurrences`, time + name only), Earned this week (`contact_achievements` scoped through `contacts.location_id`, first name + last initial, opt-out respected) and an Operator card reusing the existing `tv_content` push. 30s dwell, and 🔴 the scene index is a PURE FUNCTION OF ELAPSED TIME rather than a timer — the board already re-renders at 1 Hz for its clock, so there is no `setTimeout` to be reset by a changing callback identity (the TVTOAST.1 #2066 shape). Three reads live in the branch that already early-returns with no sessions, so a live class pays nothing; each fails to absent, and a scene with no content is skipped rather than rendered empty, with `EmptyBoard` still the floor. 🔴 Two standing rules written into the spec: no aggregate studio metrics EVER (a "room this month" scene showing session and member counts was cut — that is studio volume on a screen anyone can photograph), and unlinked bands stay visible and compete on equal terms. Spec `docs/TV_IDLE_SCENES_DESIGN_2026-10.md`, plan `docs/TV_IDLE_SCENES_PLAN_2026-10.md`. |
```

Commit and push it.

- [ ] **Step 8: After merge, restart the kiosks**

🔴 A merge is not a fix on a kiosk. There is no auto-reload in `LiveTvClient`, so a Pi serves the bundle it loaded until Chromium restarts, and restarting *before* the deploy lands just reloads the old one. Order is merge → Vercel production READY → restart:

```bash
pi run stillorgan-tv1 "pkill -f 'usr/lib/chromiu[m]'"
pi run stillorgan-tv2 "pkill -f 'usr/lib/chromiu[m]'"
```

Check `class_occurrences` for the location first — the launcher relaunches in ~5s but the screen is black for 10-15s. Then confirm `fleet_devices.last_render_at` is advancing for both.
