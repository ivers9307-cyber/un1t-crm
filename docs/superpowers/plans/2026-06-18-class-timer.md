# Class Timer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Myzone-style class interval timer — authored as reusable flexible-segment templates, driven from web + mobile, displayed as an info-rich banner on the gym TV above the HR board.

**Architecture:** A pure timer engine (`src/lib/class-timer.js`) holds all logic; the server stores authoritative run state (`started_at` + pause/skip offsets) and never streams the clock — every display computes the live tick locally and corrects on its existing ~2s poll. Two tables: reusable `class_timer_templates` + a single-live-run `class_timer_runs` per location.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + RLS), Vitest, React (web) + React Native/Expo (mobile control, OTA). Pure engine shared by web + mobile.

**Design spec:** `docs/superpowers/specs/2026-06-18-class-timer-design.md`

**Ships as 4 PRs:**
- **PR1** — engine + schema + control/read APIs + **TV banner + basic web control** (deployable slice).
- **PR2** — rich segment-editor authoring UI.
- **PR3** — mobile control screen + `timer_control` permission.
- **PR4** — Glofox-class auto-link + display polish.

> **Migration number:** plan assumes 290. Confirm at execution (`ls supabase/migrations | sort | tail -1`).

---

## File structure (PR1)

| File | Responsibility |
|---|---|
| `src/lib/class-timer.js` | pure engine: `validateStructure`, `buildTimeline`, `computeEffectiveElapsedMs`, `resolveTimerState`, `applySkip`, `nextRunState`, `TIMER_SEGMENT_TYPES` |
| `src/lib/class-timer.test.js` | exhaustive unit tests |
| `supabase/migrations/290_class_timer.sql` | `class_timer_templates` + `class_timer_runs` + RLS + one-live-run index |
| `src/app/api/timer/templates/route.js` | GET list / POST create |
| `src/app/api/timer/templates/[id]/route.js` | GET / PUT / DELETE |
| `src/app/api/timer/runs/route.js` | POST start |
| `src/app/api/timer/runs/[id]/control/route.js` | POST `{action: pause\|resume\|skip\|stop, direction?}` |
| `src/app/api/timer/active/route.js` | GET active run for control UIs |
| `src/app/api/public/live/[locationId]/route.js` | add `timer` to the response (modify) |
| `src/app/tv/[locationId]/LiveTvClient.jsx` | timer banner (modify) |
| `src/app/studio-management/timer/page.js` + client | basic web control (pick template, start/pause/skip/stop) + minimal create |

---

# PR1 — Engine + deployable TV slice

### Task 1: The pure timer engine

**Files:**
- Create: `src/lib/class-timer.js`
- Test: `src/lib/class-timer.test.js`

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest'
import {
  validateStructure, buildTimeline, computeEffectiveElapsedMs,
  resolveTimerState, applySkip, nextRunState, TIMER_SEGMENT_TYPES,
} from './class-timer'

// A template: 2s prep, then 2 rounds of (3s work, 1s rest), then 2s cool.
const STRUCTURE = [
  { kind: 'segment', label: 'Prep', type: 'prep', seconds: 2 },
  { kind: 'round', count: 2, segments: [
    { label: 'Work', type: 'work', seconds: 3 },
    { label: 'Rest', type: 'rest', seconds: 1 },
  ] },
  { kind: 'segment', label: 'Cool', type: 'prep', seconds: 2 },
]

describe('class-timer: validateStructure', () => {
  it('accepts a valid structure', () => {
    expect(validateStructure(STRUCTURE).ok).toBe(true)
  })
  it('rejects empty / non-array', () => {
    expect(validateStructure([]).ok).toBe(false)
    expect(validateStructure(null).ok).toBe(false)
  })
  it('rejects a bad segment type / seconds', () => {
    expect(validateStructure([{ kind: 'segment', label: 'x', type: 'nope', seconds: 5 }]).ok).toBe(false)
    expect(validateStructure([{ kind: 'segment', label: 'x', type: 'work', seconds: 0 }]).ok).toBe(false)
    expect(validateStructure([{ kind: 'segment', label: 'x', type: 'work', seconds: 99999 }]).ok).toBe(false)
  })
  it('rejects a round with bad count / no segments', () => {
    expect(validateStructure([{ kind: 'round', count: 0, segments: [{ label: 'w', type: 'work', seconds: 5 }] }]).ok).toBe(false)
    expect(validateStructure([{ kind: 'round', count: 2, segments: [] }]).ok).toBe(false)
  })
  it('exposes the segment types', () => {
    expect(TIMER_SEGMENT_TYPES).toContain('work')
    expect(TIMER_SEGMENT_TYPES).toContain('rest')
  })
})

describe('class-timer: buildTimeline', () => {
  it('expands rounds into a flat step list with offsets', () => {
    const { steps, totalMs } = buildTimeline(STRUCTURE)
    // prep, (work,rest)x2, cool = 6 steps
    expect(steps.map((s) => s.label)).toEqual(['Prep', 'Work', 'Rest', 'Work', 'Rest', 'Cool'])
    expect(totalMs).toBe((2 + (3 + 1) * 2 + 2) * 1000) // 12s
    expect(steps[0]).toMatchObject({ index: 0, startMs: 0, endMs: 2000, roundIndex: null, roundCount: null })
    expect(steps[1]).toMatchObject({ label: 'Work', startMs: 2000, endMs: 5000, roundIndex: 1, roundCount: 2 })
    expect(steps[3]).toMatchObject({ label: 'Work', roundIndex: 2, roundCount: 2 })
    expect(steps[5]).toMatchObject({ label: 'Cool', startMs: 10000, endMs: 12000 })
  })
})

describe('class-timer: computeEffectiveElapsedMs', () => {
  const started = Date.parse('2026-06-18T18:00:00Z')
  it('running: elapsed = now - started (+offset, -pausedAccum)', () => {
    const run = { status: 'running', started_at: new Date(started).toISOString(), paused_accum_ms: 0, elapsed_offset_ms: 0, paused_at: null }
    expect(computeEffectiveElapsedMs(run, started + 4000)).toBe(4000)
  })
  it('paused: freezes at the pause point', () => {
    const run = { status: 'paused', started_at: new Date(started).toISOString(), paused_accum_ms: 0, elapsed_offset_ms: 0, paused_at: new Date(started + 3000).toISOString() }
    expect(computeEffectiveElapsedMs(run, started + 9999)).toBe(3000)
  })
  it('subtracts accumulated pause + adds skip offset', () => {
    const run = { status: 'running', started_at: new Date(started).toISOString(), paused_accum_ms: 1000, elapsed_offset_ms: 2000, paused_at: null }
    expect(computeEffectiveElapsedMs(run, started + 4000)).toBe(4000 - 1000 + 2000)
  })
  it('never negative', () => {
    const run = { status: 'running', started_at: new Date(started).toISOString(), paused_accum_ms: 0, elapsed_offset_ms: -9999, paused_at: null }
    expect(computeEffectiveElapsedMs(run, started + 1000)).toBe(0)
  })
})

describe('class-timer: resolveTimerState', () => {
  const tl = buildTimeline(STRUCTURE)
  it('locates the current step mid-work', () => {
    const s = resolveTimerState(tl, 3000) // 1s into the first Work (2000..5000)
    expect(s.currentStep.label).toBe('Work')
    expect(s.segmentRemainingMs).toBe(2000)
    expect(s.roundIndex).toBe(1)
    expect(s.nextStep.label).toBe('Rest')
    expect(s.finished).toBe(false)
    expect(s.totalRemainingMs).toBe(9000)
  })
  it('clamps past the end to finished', () => {
    const s = resolveTimerState(tl, 99999)
    expect(s.finished).toBe(true)
    expect(s.totalRemainingMs).toBe(0)
  })
})

describe('class-timer: applySkip', () => {
  const tl = buildTimeline(STRUCTURE)
  const started = Date.parse('2026-06-18T18:00:00Z')
  const run = { status: 'running', started_at: new Date(started).toISOString(), paused_accum_ms: 0, elapsed_offset_ms: 0, paused_at: null }
  it('skip next jumps to the next segment boundary', () => {
    // at 3000ms (mid first Work, ends 5000) → next offset lands effective at 5000
    const off = applySkip(run, tl, 'next', started + 3000)
    expect(computeEffectiveElapsedMs({ ...run, elapsed_offset_ms: off }, started + 3000)).toBe(5000)
  })
  it('skip prev restarts the current segment', () => {
    const off = applySkip(run, tl, 'prev', started + 3500) // mid first Work (starts 2000)
    expect(computeEffectiveElapsedMs({ ...run, elapsed_offset_ms: off }, started + 3500)).toBe(2000)
  })
})

describe('class-timer: nextRunState', () => {
  const started = Date.parse('2026-06-18T18:00:00Z')
  it('pause sets status + paused_at', () => {
    const run = { status: 'running', started_at: new Date(started).toISOString(), paused_accum_ms: 0, elapsed_offset_ms: 0, paused_at: null }
    const patch = nextRunState(run, 'pause', started + 3000, {})
    expect(patch).toMatchObject({ status: 'paused', paused_at: new Date(started + 3000).toISOString() })
  })
  it('resume accumulates pause + clears paused_at', () => {
    const run = { status: 'paused', started_at: new Date(started).toISOString(), paused_accum_ms: 500, elapsed_offset_ms: 0, paused_at: new Date(started + 3000).toISOString() }
    const patch = nextRunState(run, 'resume', started + 5000, {})
    expect(patch).toMatchObject({ status: 'running', paused_at: null, paused_accum_ms: 500 + 2000 })
  })
  it('stop sets stopped; pause-when-paused is a no-op ({})', () => {
    const run = { status: 'paused', started_at: new Date(started).toISOString(), paused_accum_ms: 0, elapsed_offset_ms: 0, paused_at: new Date(started + 1000).toISOString() }
    expect(nextRunState(run, 'stop', started + 9000, {})).toMatchObject({ status: 'stopped' })
    expect(nextRunState(run, 'pause', started + 9000, {})).toEqual({})
  })
})
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run src/lib/class-timer.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `src/lib/class-timer.js`**

```js
// CLASS-TIMER — the pure interval-timer engine. No IO. The server stores
// authoritative run state (started_at + pause/skip offsets) and never streams
// the clock; every display computes the live tick locally via these functions
// and corrects on its existing ~2s poll. Shared by web + mobile (no web-only deps).

export const TIMER_SEGMENT_TYPES = ['prep', 'work', 'rest', 'station', 'custom']

const MAX_BLOCKS = 50
const MAX_ROUND_SEGMENTS = 20
const MAX_SECONDS = 3600
const MAX_COUNT = 99

function validSegment(s) {
  return s && typeof s === 'object'
    && typeof s.label === 'string' && s.label.length >= 1 && s.label.length <= 40
    && TIMER_SEGMENT_TYPES.includes(s.type)
    && Number.isInteger(s.seconds) && s.seconds >= 1 && s.seconds <= MAX_SECONDS
}

/** Pure: validate a template structure. Returns { ok, error? }. */
export function validateStructure(structure) {
  if (!Array.isArray(structure) || structure.length < 1 || structure.length > MAX_BLOCKS) {
    return { ok: false, error: 'Structure must be 1–50 blocks' }
  }
  for (const block of structure) {
    if (!block || typeof block !== 'object') return { ok: false, error: 'Invalid block' }
    if (block.kind === 'segment') {
      if (!validSegment(block)) return { ok: false, error: `Invalid segment "${block.label}"` }
    } else if (block.kind === 'round') {
      if (!Number.isInteger(block.count) || block.count < 1 || block.count > MAX_COUNT) {
        return { ok: false, error: 'Round count must be 1–99' }
      }
      if (!Array.isArray(block.segments) || block.segments.length < 1 || block.segments.length > MAX_ROUND_SEGMENTS) {
        return { ok: false, error: 'Round must have 1–20 segments' }
      }
      for (const s of block.segments) if (!validSegment(s)) return { ok: false, error: `Invalid round segment "${s?.label}"` }
    } else {
      return { ok: false, error: 'Block kind must be segment or round' }
    }
  }
  return { ok: true }
}

/** Pure: expand a structure into a flat, offset-stamped step list. */
export function buildTimeline(structure) {
  const steps = []
  let cursor = 0
  let index = 0
  const push = (label, type, seconds, roundIndex, roundCount) => {
    const startMs = cursor
    const endMs = cursor + seconds * 1000
    steps.push({ index, label, type, seconds, roundIndex, roundCount, startMs, endMs })
    cursor = endMs
    index += 1
  }
  for (const block of structure || []) {
    if (block?.kind === 'round') {
      for (let r = 1; r <= block.count; r++) {
        for (const s of block.segments) push(s.label, s.type, s.seconds, r, block.count)
      }
    } else if (block?.kind === 'segment') {
      push(block.label, block.type, block.seconds, null, null)
    }
  }
  return { steps, totalMs: cursor }
}

/** Pure: ms into the timeline for a run at nowMs (handles running/paused/skip). */
export function computeEffectiveElapsedMs(run, nowMs) {
  if (!run?.started_at) return 0
  const started = new Date(run.started_at).getTime()
  let elapsed = nowMs - started - (Number(run.paused_accum_ms) || 0) + (Number(run.elapsed_offset_ms) || 0)
  if (run.status === 'paused' && run.paused_at) {
    elapsed -= (nowMs - new Date(run.paused_at).getTime())
  }
  return Math.max(0, elapsed)
}

/** Pure: resolve the display state for a timeline at elapsedMs. */
export function resolveTimerState(timeline, elapsedMs) {
  const { steps, totalMs } = timeline
  const clamped = Math.max(0, Math.min(elapsedMs, totalMs))
  const finished = elapsedMs >= totalMs
  let currentStep = steps[steps.length - 1] || null
  if (!finished) {
    currentStep = steps.find((s) => clamped >= s.startMs && clamped < s.endMs) || steps[0] || null
  }
  const idx = currentStep ? currentStep.index : -1
  const nextStep = (!finished && idx >= 0) ? (steps[idx + 1] || null) : null
  return {
    finished,
    currentStep,
    nextStep,
    segmentElapsedMs: currentStep ? clamped - currentStep.startMs : 0,
    segmentRemainingMs: currentStep && !finished ? currentStep.endMs - clamped : 0,
    roundIndex: currentStep ? currentStep.roundIndex : null,
    roundCount: currentStep ? currentStep.roundCount : null,
    totalElapsedMs: clamped,
    totalRemainingMs: Math.max(0, totalMs - clamped),
    totalMs,
  }
}

/** Pure: the new elapsed_offset_ms after a skip next/prev. */
export function applySkip(run, timeline, direction, nowMs) {
  const eff = computeEffectiveElapsedMs(run, nowMs)
  const st = resolveTimerState(timeline, eff)
  const cur = st.currentStep
  if (!cur) return Number(run.elapsed_offset_ms) || 0
  let target
  if (direction === 'next') {
    target = cur.endMs
  } else {
    // prev: if >1s into the segment, restart it; else jump to the previous segment.
    target = (eff - cur.startMs > 1000) ? cur.startMs : (timeline.steps[cur.index - 1]?.startMs ?? 0)
  }
  const delta = target - eff
  return (Number(run.elapsed_offset_ms) || 0) + delta
}

/** Pure: the DB patch for a run control action. {} = no-op. */
export function nextRunState(run, action, nowMs, { direction, timeline } = {}) {
  const nowIso = new Date(nowMs).toISOString()
  if (action === 'pause') {
    if (run.status !== 'running') return {}
    return { status: 'paused', paused_at: nowIso }
  }
  if (action === 'resume') {
    if (run.status !== 'paused') return {}
    const extra = run.paused_at ? (nowMs - new Date(run.paused_at).getTime()) : 0
    return { status: 'running', paused_at: null, paused_accum_ms: (Number(run.paused_accum_ms) || 0) + extra }
  }
  if (action === 'stop') {
    if (run.status === 'stopped' || run.status === 'finished') return {}
    return { status: 'stopped' }
  }
  if (action === 'skip') {
    if (!timeline) return {}
    return { elapsed_offset_ms: applySkip(run, timeline, direction === 'prev' ? 'prev' : 'next', nowMs) }
  }
  return {}
}
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run src/lib/class-timer.test.js` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "CLASS-TIMER PR1 — pure interval-timer engine"`

---

### Task 2: Migration

**Files:**
- Create: `supabase/migrations/290_class_timer.sql`

- [ ] **Step 1: Write**

```sql
-- 290: CLASS-TIMER — reusable interval-timer templates + the single live run
-- per location. The server stores authoritative state; displays compute the
-- tick locally (see src/lib/class-timer.js).
CREATE TABLE IF NOT EXISTS public.class_timer_templates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id    uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  name           text NOT NULL,
  structure      jsonb NOT NULL,
  total_seconds  int,
  glofox_program text,
  is_active      boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_class_timer_templates_loc
  ON public.class_timer_templates (location_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS public.class_timer_runs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  template_id        uuid REFERENCES public.class_timer_templates(id) ON DELETE SET NULL,
  structure_snapshot jsonb NOT NULL,
  name               text,
  status             text NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running','paused','finished','stopped')),
  started_at         timestamptz,
  paused_at          timestamptz,
  paused_accum_ms    bigint NOT NULL DEFAULT 0,
  elapsed_offset_ms  bigint NOT NULL DEFAULT 0,
  started_by         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
-- At most one live (running|paused) run per location.
CREATE UNIQUE INDEX IF NOT EXISTS idx_class_timer_runs_one_live
  ON public.class_timer_runs (location_id) WHERE status IN ('running','paused');
CREATE INDEX IF NOT EXISTS idx_class_timer_runs_loc_status
  ON public.class_timer_runs (location_id, status);

ALTER TABLE public.class_timer_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.class_timer_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "class_timer_templates_read" ON public.class_timer_templates
  FOR SELECT TO authenticated USING (private.auth_is_in_location(location_id));
CREATE POLICY "class_timer_runs_read" ON public.class_timer_runs
  FOR SELECT TO authenticated USING (private.auth_is_in_location(location_id));

COMMENT ON TABLE public.class_timer_templates IS 'CLASS-TIMER (mig 290): reusable interval-timer templates.';
COMMENT ON TABLE public.class_timer_runs IS 'CLASS-TIMER (mig 290): the live timer run per location; one running/paused row at a time.';
```

- [ ] **Step 2: Apply** via Supabase MCP (`apply_migration`, project `iyvtbjjxdggiadzwwvdj`, name `class_timer`). Run `get_advisors type=security` → no new issues (both tables have a read policy; service-role writes need none).
- [ ] **Step 3: Verify** the 2 tables + the partial unique index exist (`execute_sql`).
- [ ] **Step 4: Commit** — `git commit -am "CLASS-TIMER PR1 — templates + runs schema (mig 290)"`

---

### Task 3: Template CRUD API

**Files:**
- Create: `src/app/api/timer/templates/route.js` (GET list, POST create)
- Create: `src/app/api/timer/templates/[id]/route.js` (GET, PUT, DELETE)

- [ ] **Step 1:** Write `templates/route.js` following the mutation-route skeleton in CLAUDE.md (manager-gated via `MANAGER_ROLES`, `assertLocationAccess`, `validateBody`). GET lists active templates for `?location_id=`. POST validates `{ location_id, name, structure }` — call `validateStructure(structure)`; on `!ok` return 400 with the error; compute `total_seconds = Math.round(buildTimeline(structure).totalMs / 1000)`; insert with `created_by: user.id`.

```js
import { validateStructure, buildTimeline } from '@/lib/class-timer'
// ... POST body { location_id, name, structure, glofox_program? }
const v = validateStructure(body.structure)
if (!v.ok) return NextResponse.json({ success: false, error: v.error }, { status: 400 })
const total_seconds = Math.round(buildTimeline(body.structure).totalMs / 1000)
```

- [ ] **Step 2:** Write `templates/[id]/route.js` — GET one (location-access checked against the row), PUT (re-validate structure + recompute total_seconds), DELETE (soft: `is_active=false`). All manager-gated; load the row first and `assertLocationAccess(user, row.location_id)`; return 404 (not 403) on a missing/foreign row per the IDOR rule in CLAUDE.md.

- [ ] **Step 3:** `npm run check:route-guards` → both routes session-guarded. Add a small Zod schema for the body in `src/lib/schemas.js` only if it helps; inline `z.object` is fine.

- [ ] **Step 4: Commit** — `git commit -am "CLASS-TIMER PR1 — template CRUD API"`

---

### Task 4: Run control API

**Files:**
- Create: `src/app/api/timer/runs/route.js` (POST start)
- Create: `src/app/api/timer/runs/[id]/control/route.js` (POST action)
- Create: `src/app/api/timer/active/route.js` (GET active run)

- [ ] **Step 1: `runs/route.js` (start).** Manager-gated. Body `{ location_id, template_id }`. Load the template (assert location). Finalise any live run for the location (`update status='stopped' where location_id=… and status in ('running','paused')`). Insert a new run: `structure_snapshot = template.structure`, `name = template.name`, `status='running'`, `started_at = now`, `started_by = user.id`. Return the run row. (The partial unique index guarantees only one live run; the finalise-first makes the insert safe.)

- [ ] **Step 2: `runs/[id]/control/route.js`.** Manager-gated. Body `{ action: 'pause'|'resume'|'skip'|'stop', direction?: 'next'|'prev' }`. Load the run (assert location, 404 if foreign). Build the timeline only when needed: `const timeline = action === 'skip' ? buildTimeline(run.structure_snapshot) : null`. `const patch = nextRunState(run, action, Date.now(), { direction, timeline })`. If `Object.keys(patch).length`, `update({ ...patch, updated_at: now }).eq('id', run.id)`. Return the updated run (re-read or merge).

```js
import { nextRunState, buildTimeline } from '@/lib/class-timer'
```

- [ ] **Step 3: `active/route.js` (GET).** Session-gated (any staff at location — mirror `/api/live/[locationId]`'s `getUserLocationIds` check). `?location_id=`. Return the single `running|paused` run for the location (or null). The control UIs poll this.

- [ ] **Step 4:** `npm run check:route-guards` clean. **Commit** — `git commit -am "CLASS-TIMER PR1 — run control + active API"`

---

### Task 5: Public read (TV gets the run)

**Files:**
- Modify: `src/app/api/public/live/[locationId]/route.js`

- [ ] **Step 1:** After the existing sessions query, fetch the live run and add it to the response (no PII — structure + timestamps only):

```js
const { data: timerRun } = await db
  .from('class_timer_runs')
  .select('id, name, status, started_at, paused_at, paused_accum_ms, elapsed_offset_ms, structure_snapshot')
  .eq('location_id', locationId)
  .in('status', ['running', 'paused'])
  .order('created_at', { ascending: false })
  .limit(1)
  .maybeSingle()
// ...add `timer: timerRun || null` to the NextResponse.json({...}) body (both the
// early-empty-sessions return AND the main return).
```

- [ ] **Step 2:** `npm run build` (route change). **Commit** — `git commit -am "CLASS-TIMER PR1 — expose live timer run on the public TV poll"`

---

### Task 6: TV banner

**Files:**
- Modify: `src/app/tv/[locationId]/LiveTvClient.jsx`

- [ ] **Step 1: Read** `LiveTvClient.jsx` — learn its poll loop + `server_time` handling + styling.
- [ ] **Step 2:** Capture `timer` + `server_time` from the poll into state. Add a `<TimerBanner timer={data.timer} serverTime={data.server_time} />` above the leaderboard. The banner:
  - imports `buildTimeline`, `computeEffectiveElapsedMs`, `resolveTimerState` from `@/lib/class-timer`,
  - memoises `timeline = buildTimeline(timer.structure_snapshot)`,
  - runs a local `setInterval(250ms)` that recomputes `resolveTimerState(timeline, computeEffectiveElapsedMs(timer, base + (Date.now() - polledAt)))` where `base = Date.parse(serverTime)` captured at poll time (anchor on server clock, interpolate locally),
  - renders the command strip: `timer.name` · current segment label + `mm:ss` countdown + a segment progress bar (`segmentElapsedMs/segment total`) · `Round {roundIndex}/{roundCount}` (when set) · `next: {nextStep.label} {mm:ss}` · total `{elapsed} / {remaining}`,
  - returns `null` when `!timer` or `timer.status` is terminal.
  Use `mm:ss` formatting (`Math.floor(ms/60000)`, `Math.floor((ms%60000)/1000)`); colour the segment pill by type (work/rest/prep) consistent with the design mockup.
- [ ] **Step 3:** `npm run build`. **Commit** — `git commit -am "CLASS-TIMER PR1 — TV timer banner"`

---

### Task 7: Basic web control + minimal create

**Files:**
- Create: `src/app/studio-management/timer/page.js` (server: auth + active-location) + a client component `TimerControlClient.jsx`

- [ ] **Step 1:** Server page resolves `getCurrentUser()` + active location (mirror an existing `/studio-management` page), passes `locationId` to the client.
- [ ] **Step 2:** `TimerControlClient.jsx`:
  - lists templates (`GET /api/timer/templates?location_id=`),
  - a **minimal create** form for PR1: name + a few preset structures (e.g. "Tabata 8×(20/10)", "EMOM 10", "Intervals 10×(45/15)") built as ready-made `structure` arrays, POSTed to `/api/timer/templates`. (The rich block editor is PR2 — keep PR1's create to presets + name so there's something to run.)
  - a control panel: pick a template → Start (`POST /api/timer/runs`); once a run is active (poll `GET /api/timer/active?location_id=` every 2s) show Pause/Resume, Skip ◀/▶ (`/control` with `{action:'skip',direction}`), Stop, plus the same computed countdown as the TV (reuse the engine).
- [ ] **Step 3:** Link the page from the `/studio-management` hub (one nav entry). Use `<Link>` + `npx next lint` (no-html-link rule).
- [ ] **Step 4:** `npm run build`. **Commit** — `git commit -am "CLASS-TIMER PR1 — basic web control + preset templates"`

---

### Task 8: Permissions + ship PR1

- [ ] **Step 1:** Add a `WEB_PERMISSIONS` key (e.g. `timer` / `studio_timer`) in `shared/permissions.js` + `DEFAULT_WEB_PERMISSIONS_BY_ROLE`; gate the page + APIs. Decide the mobile counterpart now: add `timer_control` to `WEB_ONLY_OK` in `scripts/check-mobile-parity.mjs` with reason "mobile control ships in PR3" (PR3 replaces it with a real `MOBILE_PERMISSIONS` entry). Run `npm run check:mobile-parity`.
- [ ] **Step 2:** Full CI mirror — `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards`.
- [ ] **Step 3:** `npm run build`.
- [ ] **Step 4:** Branch `feat-class-timer` → PR `base=main` → squash-merge. mig 290 already applied; advisor clean.
- [ ] **Step 5:** Prod verify: create a preset template at `/studio-management/timer`, Start it, open `/tv/<location>` → the banner counts down and Pause/Skip/Stop reflect within ~2s.

---

# PR2 — Rich segment editor (outline)

- Replace PR1's preset-only create with a block editor in `TimerControlClient` (or a dedicated `/studio-management/timer/templates/[id]` editor): add/reorder/delete **segment** and **round** blocks; per-block label, type (segmented control over `TIMER_SEGMENT_TYPES`), seconds; live `buildTimeline` total + a visual timeline preview. PUT/DELETE wired to the existing `templates/[id]` API. Validation mirrors `validateStructure`. Tests: a pure `structure`-builder helper if any non-trivial transform is added.

# PR3 — Mobile control (outline)

- `MOBILE_PERMISSIONS` entry `timer_control` (+ defaults) replacing the PR1 `WEB_ONLY_OK` stub; a control screen under `mobile/app/(tabs)/` or a studio sub-screen reusing `../../src/lib/class-timer.js` (pure — imports cleanly into RN); calls the same `/api/timer/*` routes via the shared `api()`/`authHeaders()` helper (per CLAUDE.md mobile-header rule). Poll `GET /api/timer/active`. OTA ship. `check:mobile-imports` + parity gates.

# PR4 — Glofox-class auto-link + polish (outline)

- `glofox_program` editing on a template; control UIs call `resolveCurrentOccurrence` and pre-select the matching template ("DR1VE is live — load DR1VE intervals?"). Display polish: per-type colours, an end-of-class "Complete" state, optional audio cue on segment change (TV only, behind a toggle). No schema change (column exists from mig 290).

---

## Self-review

**Spec coverage:** flexible-segment engine → Task 1 ✓; templates+runs schema (one-live-run, snapshot) → Task 2 ✓; template CRUD → Task 3 ✓; run control (start/pause/resume/skip/stop) + active read → Task 4 ✓; server-authoritative + client countdown → engine (Task 1) + TV banner (Task 6) + public read (Task 5) ✓; TV banner on top → Task 6 ✓; web control → Task 7 ✓; reusable templates + manual start → Tasks 3/4/7 ✓; mobile control → PR3 ✓; optional Glofox link (`glofox_program` column shipped in mig 290) → PR4 ✓; 4-PR phasing with PR1 deployable → matches ✓.

**Placeholder scan:** PR2–4 are outlines by design (the spec's phasing) with concrete files/interfaces, not blank TODOs; PR1 tasks carry full engine code + real SQL + concrete route logic. Integration tasks (6,7) say "read the file first" — real existing-code edits where line numbers shift; each names the exact file, the functions to import, and the behaviour.

**Type consistency:** engine exports (`validateStructure`, `buildTimeline`, `computeEffectiveElapsedMs`, `resolveTimerState`, `applySkip`, `nextRunState`, `TIMER_SEGMENT_TYPES`) are used consistently across Tasks 3/4/6/7. Run fields (`paused_accum_ms`, `elapsed_offset_ms`, `structure_snapshot`, `status`) match the migration (Task 2) and the engine signatures. `nextRunState` returns a patch consumed verbatim by Task 4's update.
