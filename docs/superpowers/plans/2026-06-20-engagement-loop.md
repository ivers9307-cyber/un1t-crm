# Engagement notification loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn on the dopamine/retention loop — push members when an achievement unlocks, when a goal completes, and when a streak is about to break, and surface the streak counter in the app.

**Architecture:** Achievement + goal-completion fire inline at session-end (reusing detection that already runs); streak-at-risk fires from a daily cron. A shared `customer-notifications.js` holds pure payload builders + thin send/record IO. Streak maths is a new exported `currentStreak()` in the byte-synced `hr-analytics.js`. Idempotency: achievements reuse `contact_achievements.notified_at`; goals + nudges use a new `customer_engagement_nudges` table.

**Tech Stack:** Next.js 16 / Supabase (un1t-crm), Expo/React Native + NativeWind (champ-app), Vitest, Expo push, Vercel cron.

**Spec:** `docs/superpowers/specs/2026-06-20-engagement-loop-design.md`

**Two repos, two PRs.** un1t-crm: `hr-analytics.js`, `achievements.js`, `customer-notifications.js`, `live-class.js`, `goals.js`, the cron, `vercel.json`, the migration. champ-app: `shared/hr-analytics.js` (sync), `src/app/page.jsx`, `mobile/app/(tabs)/index.jsx`, `mobile/app/_layout.jsx`. The migration applies to the shared Supabase project (`iyvtbjjxdggiadzwwvdj`).

**Branch setup (do first, both repos):**
```bash
cd /Users/richardivers/code/un1t-crm && git checkout main && git pull origin main && git checkout -b engagement-loop
cd /Users/richardivers/code/champ-app && git checkout main && git pull origin main && git checkout -b engagement-loop
```
(un1t-crm `main` has unrelated cookie-consent WIP in the working tree — do NOT `git add -A`; stage only the files each task names. Also commit the spec + this plan on the un1t-crm branch in Task 0's commit.)

---

## File Structure

**un1t-crm**
- `src/lib/hr-analytics.js` — add exported `currentStreak(sessions, nowMs)` (private `computeStreak` untouched).
- `src/lib/customer-notifications.js` — NEW. Pure builders (`buildSessionPush`, `buildGoalPush`, `buildStreakAtRiskPush`, `periodKey`, `goalsToCelebrate`, `streakAtRisk`) + nothing IO (callers do IO).
- `src/lib/achievements.js` — extend rule select with `name, icon`; add pure `summariseUnlocked(fired)`; return it.
- `src/lib/goals.js` — NEW. Byte-synced copy of `champ-app/shared/goals.js`.
- `src/lib/live-class.js` — `endSession`: consolidated achievement push + goal-completion push.
- `src/app/api/cron/notify-streak-at-risk/route.js` — NEW cron.
- `vercel.json` — one new cron entry.
- `supabase/migrations/<next>_customer_engagement_nudges.sql` — NEW table + RLS + heartbeat row.
- Tests: `src/lib/hr-analytics.test.js`, `src/lib/customer-notifications.test.js` (NEW), `src/lib/achievements.test.js`, `src/lib/goals.test.js` (NEW).

**champ-app**
- `shared/hr-analytics.js` — add the same `currentStreak` (verbatim, only line-1 banner differs).
- `shared/hr-analytics.test.js` — same `currentStreak` test.
- `src/app/page.jsx` — streak query + `StreakCard`.
- `mobile/app/(tabs)/index.jsx` — streak query + `StreakCard`.
- `mobile/app/_layout.jsx` — deep-link cases.

---

## Phase 0 — streak maths (foundation for A + B)

### Task 0: `currentStreak()` in hr-analytics.js (both copies)

**Files:**
- Modify: `un1t-crm/src/lib/hr-analytics.js` (add export after `computeStreak`, ~line 245)
- Modify: `champ-app/shared/hr-analytics.js` (same addition)
- Test: `un1t-crm/src/lib/hr-analytics.test.js`, `champ-app/shared/hr-analytics.test.js`

- [ ] **Step 1: Write the failing test** (append to `un1t-crm/src/lib/hr-analytics.test.js`; add `currentStreak` to the import list at top)

```js
describe('currentStreak', () => {
  const N = new Date('2026-06-20T18:00:00Z').getTime()
  const dayAgo = (n) => new Date(N - n * 24 * 3600 * 1000).toISOString()

  it('returns 0/0 for no sessions', () => {
    expect(currentStreak([], N)).toEqual({ current: 0, best: 0, lastDayMs: null })
  })
  it('counts consecutive days ending today', () => {
    const ss = [{ started_at: dayAgo(0) }, { started_at: dayAgo(1) }, { started_at: dayAgo(2) }]
    expect(currentStreak(ss, N).current).toBe(3)
  })
  it('is live with a one-day gap (trained yesterday, not today)', () => {
    const ss = [{ started_at: dayAgo(1) }, { started_at: dayAgo(2) }]
    expect(currentStreak(ss, N).current).toBe(2)
  })
  it('is broken if last session is 2+ days ago', () => {
    const ss = [{ started_at: dayAgo(2) }, { started_at: dayAgo(3) }]
    expect(currentStreak(ss, N).current).toBe(0)
  })
  it('dedupes multiple sessions on the same day', () => {
    const ss = [{ started_at: dayAgo(0) }, { started_at: dayAgo(0) }, { started_at: dayAgo(1) }]
    expect(currentStreak(ss, N).current).toBe(2)
  })
  it('reports best run even when current streak is broken', () => {
    const ss = [{ started_at: dayAgo(5) }, { started_at: dayAgo(6) }, { started_at: dayAgo(7) }, { started_at: dayAgo(8) }]
    const r = currentStreak(ss, N)
    expect(r.current).toBe(0)
    expect(r.best).toBe(4)
  })
})
```

- [ ] **Step 2: Run it — verify it fails**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/hr-analytics.test.js -t currentStreak`
Expected: FAIL — `currentStreak is not a function` / `not exported`.

- [ ] **Step 3: Implement** — add to `un1t-crm/src/lib/hr-analytics.js` immediately after the `computeStreak` function (~line 245):

```js
/**
 * Live consecutive-day training streak as of `nowMs`.
 *
 * `current` = the run of consecutive UTC days ending today OR yesterday
 * (one-day gap tolerance, so a member who hasn't trained YET today still
 * sees yesterday's streak). 0 if the most recent session is older than
 * yesterday. `best` = the longest consecutive-day run anywhere in the input.
 *
 * Distinct from the private `computeStreak(thisSession, history)` above:
 * this takes a plain sessions array and is anchored on `nowMs`, not on a
 * "this session" row.
 *
 * @param {Array<{started_at?:string, ended_at?:string}>} sessions
 * @param {number} nowMs
 * @returns {{current:number, best:number, lastDayMs:number|null}}
 */
export function currentStreak(sessions, nowMs = Date.now()) {
  const DAY = 24 * 3600 * 1000
  const dayMs = (iso) => {
    const d = new Date(iso)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  }
  const days = new Set()
  for (const s of sessions || []) {
    const iso = s && (s.started_at || s.ended_at)
    if (iso) days.add(dayMs(iso))
  }
  if (days.size === 0) return { current: 0, best: 0, lastDayMs: null }

  const sorted = [...days].sort((a, b) => b - a) // unique day-ms, most recent first
  const lastDayMs = sorted[0]

  const n = new Date(nowMs)
  const todayMs = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())

  let current = 0
  if (lastDayMs === todayMs || lastDayMs === todayMs - DAY) {
    current = 1
    let cursor = lastDayMs
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === cursor - DAY) { current++; cursor -= DAY } else break
    }
  }

  let best = 1
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] - DAY) { run++; if (run > best) best = run } else { run = 1 }
  }
  if (current > best) best = current

  return { current, best, lastDayMs }
}
```

- [ ] **Step 4: Run it — verify pass**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/hr-analytics.test.js -t currentStreak`
Expected: PASS (6 tests). Then run under two timezones (date-test rule):
`for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run src/lib/hr-analytics.test.js -t currentStreak; done`
Expected: PASS in both (the function is UTC-anchored).

- [ ] **Step 5: Sync the champ-app copy** — paste the identical `currentStreak` function into `champ-app/shared/hr-analytics.js` at the same spot (after `computeStreak`). Add the same `describe('currentStreak', …)` block to `champ-app/shared/hr-analytics.test.js` and add `currentStreak` to its import list. Verify:

Run: `cd /Users/richardivers/code/champ-app && npx vitest run shared/hr-analytics.test.js -t currentStreak`
Expected: PASS. Confirm the two files still differ only by line 1:
`diff <(tail -n +2 /Users/richardivers/code/un1t-crm/src/lib/hr-analytics.js) <(tail -n +2 /Users/richardivers/code/champ-app/shared/hr-analytics.js)`
Expected: no output.

- [ ] **Step 6: Commit (both repos)**

```bash
cd /Users/richardivers/code/un1t-crm && git add src/lib/hr-analytics.js src/lib/hr-analytics.test.js docs/superpowers/specs/2026-06-20-engagement-loop-design.md docs/superpowers/plans/2026-06-20-engagement-loop.md && git commit -m "feat(hr): currentStreak() helper + engagement-loop spec/plan"
cd /Users/richardivers/code/champ-app && git add shared/hr-analytics.js shared/hr-analytics.test.js && git commit -m "feat(hr): currentStreak() helper (sync from un1t-crm)"
```

---

## Phase 1 — Component A: achievement push + streak chip

### Task 1: `summariseUnlocked` + name/icon in detection (un1t-crm)

**Files:**
- Modify: `src/lib/achievements.js` (select ~line 373, return ~line 417, add helper)
- Test: `src/lib/achievements.test.js`

- [ ] **Step 1: Write the failing test** (append to `src/lib/achievements.test.js`; add `summariseUnlocked` to imports)

```js
describe('summariseUnlocked', () => {
  it('maps fired rules to {slug, ruleId, name, icon}', () => {
    const fired = [{ rule: { id: 'r1', slug: 'first_z5', name: 'First Z5', icon: 'flame' }, metadata: {} }]
    expect(summariseUnlocked(fired)).toEqual([{ slug: 'first_z5', ruleId: 'r1', name: 'First Z5', icon: 'flame' }])
  })
  it('returns [] for empty input', () => {
    expect(summariseUnlocked([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/achievements.test.js -t summariseUnlocked`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement** — three edits in `src/lib/achievements.js`:

(a) Add the pure helper near the top of the "Orchestrator" section (just above `runDetectionForSession`):
```js
/** Map runDetectors() output to the push-friendly unlocked summary. */
export function summariseUnlocked(fired) {
  return (fired || []).map(({ rule }) => ({
    slug: rule.slug, ruleId: rule.id, name: rule.name, icon: rule.icon,
  }))
}
```
(b) Extend the rules select (~line 373) to include `name, icon`:
```js
db.from('achievement_rules').select('id, slug, name, icon, rule_type, rule_config, is_active').eq('is_active', true),
```
(c) Replace the return's `unlocked` mapping (~line 417):
```js
      unlocked: summariseUnlocked(fired),
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/achievements.test.js`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add src/lib/achievements.js src/lib/achievements.test.js && git commit -m "feat(achievements): return name+icon on unlocked (summariseUnlocked)"
```

### Task 2: `customer-notifications.js` push builders (un1t-crm)

**Files:**
- Create: `src/lib/customer-notifications.js`
- Test: `src/lib/customer-notifications.test.js`

- [ ] **Step 1: Write the failing test** (`src/lib/customer-notifications.test.js`)

```js
import { describe, it, expect } from 'vitest'
import { buildSessionPush, buildGoalPush, buildStreakAtRiskPush, periodKey } from './customer-notifications.js'

describe('buildSessionPush', () => {
  const base = { effortPoints: 280, className: 'Conditioning', sessionId: 'sess-1' }
  it('no achievement → session-ready copy', () => {
    expect(buildSessionPush({ ...base, unlocked: [] })).toEqual({
      title: 'Your session is ready',
      body: '280 UN1T Points · Conditioning',
      data: { type: 'session_report', session_id: 'sess-1' },
    })
  })
  it('one achievement → leads with the name', () => {
    const r = buildSessionPush({ ...base, unlocked: [{ name: 'First Z5' }] })
    expect(r.title).toBe('New achievement — First Z5')
    expect(r.body).toBe('280 UN1T Points · Conditioning. Tap to see your stats.')
    expect(r.data).toEqual({ type: 'achievement', session_id: 'sess-1', count: 1 })
  })
  it('two+ achievements → counts them', () => {
    const r = buildSessionPush({ ...base, unlocked: [{ name: 'A' }, { name: 'B' }] })
    expect(r.title).toBe('You unlocked 2 achievements')
    expect(r.data.count).toBe(2)
  })
  it('missing points → fallback phrase, missing class → no suffix', () => {
    const r = buildSessionPush({ effortPoints: null, className: null, sessionId: 's', unlocked: [] })
    expect(r.body).toBe('Tap to see your stats')
  })
})

describe('buildGoalPush', () => {
  it('weekly goal copy', () => {
    const r = buildGoalPush({ goal: { id: 'g1', target_value: 500 }, def: { unit: 'points', period: 'week' } })
    expect(r.title).toBe('Goal smashed — 500 points this week')
    expect(r.body).toBe('Weekly target complete. Nice work.')
    expect(r.data).toEqual({ type: 'goal', goal_id: 'g1' })
  })
  it('monthly goal copy', () => {
    const r = buildGoalPush({ goal: { id: 'g2', target_value: 16 }, def: { unit: 'classes', period: 'month' } })
    expect(r.title).toBe('Goal smashed — 16 classes this month')
    expect(r.body).toBe('Monthly target complete. Nice work.')
  })
})

describe('buildStreakAtRiskPush', () => {
  it('names the streak length', () => {
    const r = buildStreakAtRiskPush({ streak: 5 })
    expect(r.title).toBe('Keep the 5-day streak alive')
    expect(r.body).toBe("Train today so you don't lose it.")
    expect(r.data).toEqual({ type: 'streak_at_risk' })
  })
})

describe('periodKey', () => {
  it('month key', () => {
    expect(periodKey('month', new Date('2026-06-20T12:00:00Z').getTime())).toBe('2026-06')
  })
  it('ISO week key', () => {
    expect(periodKey('week', new Date('2026-06-20T12:00:00Z').getTime())).toBe('2026-W25')
  })
})
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/customer-notifications.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — create `src/lib/customer-notifications.js`:

```js
// Pure builders for the customer engagement-loop notifications + the
// streak-at-risk predicate. No IO — callers (endSession, the cron) load
// data and call sendCustomerPush. Kept pure so the copy + logic are
// fixture-testable.

import { currentStreak } from '@/lib/hr-analytics'

function pointsPhrase(effortPoints) {
  return Number.isFinite(effortPoints) ? `${effortPoints} UN1T Points` : 'Tap to see your stats'
}

/** One consolidated session-end push. Leads with the achievement if any unlocked. */
export function buildSessionPush({ effortPoints, className, sessionId, unlocked }) {
  const pts = pointsPhrase(effortPoints)
  const cls = className ? ` · ${className}` : ''
  const n = (unlocked || []).length
  if (n === 1) {
    return {
      title: `New achievement — ${unlocked[0].name}`,
      body: `${pts}${cls}. Tap to see your stats.`,
      data: { type: 'achievement', session_id: sessionId, count: 1 },
    }
  }
  if (n >= 2) {
    return {
      title: `You unlocked ${n} achievements`,
      body: `${pts}${cls}. Tap to see your stats.`,
      data: { type: 'achievement', session_id: sessionId, count: n },
    }
  }
  return {
    title: 'Your session is ready',
    body: `${pts}${cls}`,
    data: { type: 'session_report', session_id: sessionId },
  }
}

/** Goal-completion push. `def` is the GOAL_DEFS entry (has unit + period). */
export function buildGoalPush({ goal, def }) {
  const word = def.period === 'month' ? 'this month' : 'this week'
  const cap = def.period === 'month' ? 'Monthly' : 'Weekly'
  return {
    title: `Goal smashed — ${goal.target_value} ${def.unit} ${word}`,
    body: `${cap} target complete. Nice work.`,
    data: { type: 'goal', goal_id: goal.id },
  }
}

/** Streak-at-risk nudge push. */
export function buildStreakAtRiskPush({ streak }) {
  return {
    title: `Keep the ${streak}-day streak alive`,
    body: "Train today so you don't lose it.",
    data: { type: 'streak_at_risk' },
  }
}

/** Idempotency key for a goal/period: YYYY-MM (month) or YYYY-Www (ISO week). */
export function periodKey(period, nowMs = Date.now()) {
  const d = new Date(nowMs)
  if (period === 'month') {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  }
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dayNum = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - dayNum + 3) // Thursday of this ISO week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4))
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ftDayNum) / 7)
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/**
 * Streak-at-risk: returns the streak length if the member trained YESTERDAY
 * (not today) and the run ending yesterday is >= minStreak; else 0.
 */
export function streakAtRisk(sessions, nowMs = Date.now(), minStreak = 3) {
  const DAY = 24 * 3600 * 1000
  const n = new Date(nowMs)
  const today = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())
  const st = currentStreak(sessions, nowMs)
  if (st.lastDayMs === today - DAY && st.current >= minStreak) return st.current
  return 0
}
```

- [ ] **Step 4: Run — verify pass** (incl. timezone sweep for `periodKey`)

Run: `cd /Users/richardivers/code/un1t-crm && for tz in Europe/Dublin America/Los_Angeles Asia/Tokyo; do TZ=$tz npx vitest run src/lib/customer-notifications.test.js; done`
Expected: PASS in all three.

- [ ] **Step 5: Commit**

```bash
git add src/lib/customer-notifications.js src/lib/customer-notifications.test.js && git commit -m "feat(notifications): pure builders + streakAtRisk predicate"
```

### Task 3: wire consolidated achievement push into `endSession` (un1t-crm)

**Files:**
- Modify: `src/lib/live-class.js` (imports + lines ~306–318 inside `endSession`)

- [ ] **Step 1: Add the import** at the top of `src/lib/live-class.js` (next to the existing `customer-push` import):

```js
import { buildSessionPush } from '@/lib/customer-notifications'
```

- [ ] **Step 2: Replace** the current session-ready push + fire-and-forget detection block (the `sendCustomerPush({ title: 'Your session is ready', … })` call AND the `runDetectionForSession(db, sessionId).catch(…)` call, ~lines 306–318) with:

```js
    // Best-effort: achievement detection + ONE consolidated session push.
    // Leads with any achievement unlocked this session, else the session-
    // ready summary. Never blocks/fails finalisation.
    try {
      const det = await runDetectionForSession(db, sessionId)
      const unlocked = det && det.ok && Array.isArray(det.unlocked) ? det.unlocked : []
      await sendCustomerPush(
        db,
        session.contact_id,
        buildSessionPush({
          effortPoints: summary.effortPoints,
          className: session.class_name,
          sessionId,
          unlocked,
        })
      )
      if (unlocked.length) {
        await db
          .from('contact_achievements')
          .update({ notified_at: new Date(nowMs).toISOString() })
          .eq('source_session_id', sessionId)
          .is('notified_at', null)
      }
    } catch (err) {
      logWarn('live-class', 'engagement notify threw', { err, sessionId })
    }
```

- [ ] **Step 3: Verify nothing breaks** (no unit test for the IO orchestrator; the pure builder is covered in Task 2)

Run: `cd /Users/richardivers/code/un1t-crm && npm test && npm run lint`
Expected: PASS / clean.
Run: `npm run build`
Expected: build succeeds (catches the new import resolving).

- [ ] **Step 4: Commit**

```bash
git add src/lib/live-class.js && git commit -m "feat(live-class): consolidated achievement push at session-end + stamp notified_at"
```

### Task 4: streak chip on the web dashboard (champ-app)

**Files:**
- Modify: `champ-app/src/app/page.jsx`

- [ ] **Step 1: Add the streak query.** In the data-loading section of `page.jsx` (after the `recent` query), add:

```js
  // Streak source — distinct training days over the last 120 days.
  const streakSinceIso = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString()
  const { data: streakSessions } = await supabase
    .from('heart_rate_sessions')
    .select('started_at')
    .not('ended_at', 'is', null)
    .gte('started_at', streakSinceIso)
    .order('started_at', { ascending: false })
  const streak = currentStreak(streakSessions || [])
```

- [ ] **Step 2: Add the import.** At the top of `page.jsx` add:

```js
import { currentStreak } from '@/lib/hr-analytics'
```
Inspect how the file imports its icon set (it already uses `Icons.HeartPulse`). If `Icons` is a local map that lacks `Flame`, add `Flame` to that map's export; if icons are imported directly from `lucide-react` elsewhere, `import { Flame } from 'lucide-react'` and use `<Flame .../>` below instead of `<Icons.Flame .../>`.

- [ ] **Step 3: Add the `StreakCard` component** (near the other card components in `page.jsx`). Uses the dark UN1T tokens + ember flame to match the approved mock:

```jsx
function StreakCard({ streak }) {
  if (!streak || streak.current < 1) return null
  return (
    <Card>
      <div className="flex items-center gap-3">
        <Icons.Flame className="h-7 w-7 shrink-0 text-[#ff5a1f]" aria-hidden="true" />
        <div>
          <p className="text-2xl font-bold text-un1t-text">{streak.current}-day streak</p>
          <p className="text-xs text-un1t-text-2">Best: {streak.best} {streak.best === 1 ? 'day' : 'days'}</p>
        </div>
      </div>
    </Card>
  )
}
```

- [ ] **Step 4: Render it** at the top of the dashboard, above the first card grid in the main `return`:

```jsx
      <div className="mt-8">
        <StreakCard streak={streak} />
      </div>
```
(If `StreakCard` returns null the wrapper div is empty and harmless; if you prefer, guard the wrapper with `{streak.current >= 1 && (…)}`.)

- [ ] **Step 5: Verify**

Run: `cd /Users/richardivers/code/champ-app && npm run build`
Expected: build succeeds (icon import + `currentStreak` resolve).

- [ ] **Step 6: Commit**

```bash
git add src/app/page.jsx && git commit -m "feat(dashboard): streak chip (web)"
```

### Task 5: streak chip on the native dashboard (champ-app)

**Files:**
- Modify: `champ-app/mobile/app/(tabs)/index.jsx`

- [ ] **Step 1: Add the import** (with the other `../../../shared/*` imports):

```js
import { currentStreak } from '../../../shared/hr-analytics'
```

- [ ] **Step 2: Add streak state + query.** Add a `const [streak, setStreak] = useState({ current: 0, best: 0, lastDayMs: null })` near the other `useState`s. In the `load` callback's `Promise.all`, add a 7th query:

```js
        // 4. Streak source — distinct training days, last 120d
        supabase
          .from('heart_rate_sessions')
          .select('started_at')
          .not('ended_at', 'is', null)
          .gte('started_at', new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString())
          .order('started_at', { ascending: false }),
```
Destructure its result as `{ data: streakRows }` in the array, and after the existing `set*` calls add:
```js
      setStreak(currentStreak(streakRows || []))
```

- [ ] **Step 3: Add the `StreakCard`** component (near `AchievementChip`), NativeWind + Ionicons flame:

```jsx
function StreakCard({ streak }) {
  if (!streak || streak.current < 1) return null
  return (
    <Card>
      <View className="flex-row items-center gap-3">
        <Ionicons name="flame" size={26} color="#ff5a1f" />
        <View>
          <Text className="text-2xl font-bold text-un1t-text">{streak.current}-day streak</Text>
          <Text className="text-xs text-un1t-text-2">Best: {streak.best} {streak.best === 1 ? 'day' : 'days'}</Text>
        </View>
      </View>
    </Card>
  )
}
```

- [ ] **Step 4: Render it** at the top of the `ScrollView`, just after the header `Text`s:

```jsx
        <View className="mt-6">
          <StreakCard streak={streak} />
        </View>
```

- [ ] **Step 5: Verify** the mobile bundle exports + imports resolve:

Run: `cd /Users/richardivers/code/champ-app && npx expo export --platform ios --output-dir /tmp/expo-export-check 2>&1 | tail -5`
Expected: export completes without "Unable to resolve" errors. (Then `rm -rf /tmp/expo-export-check`.)

- [ ] **Step 6: Commit**

```bash
git add mobile/app/\(tabs\)/index.jsx && git commit -m "feat(dashboard): streak chip (native)"
```

### Task 6: mobile deep-link case `achievement` (champ-app)

**Files:**
- Modify: `champ-app/mobile/app/_layout.jsx`

- [ ] **Step 1: Add the case** to the `switch (data.type)` block in `NotificationRouter`, after `case 'session_report':`:

```js
        case 'achievement':
          router.push('/account/achievements')
          break
```

- [ ] **Step 2: Verify** the route exists: `ls mobile/app/account/achievements.jsx` (present). If tapping doesn't navigate at runtime, register `<Stack.Screen name="account/achievements" />` in the root `Stack` — but file-based routing resolves it without that.

- [ ] **Step 3: Commit**

```bash
git add mobile/app/_layout.jsx && git commit -m "feat(push): deep-link achievement notifications to achievements screen"
```

> **Phase 1 is independently shippable.** You can open both PRs here for the core loop (achievement push + streak chips) and add Phases 2–4 in a follow-up, or continue.

---

## Phase 2 — migration (shared by C + B)

### Task 7: `customer_engagement_nudges` table + heartbeat row (un1t-crm)

**Files:**
- Create: `supabase/migrations/<next>_customer_engagement_nudges.sql`

- [ ] **Step 1: Confirm the next migration number**

Run: `cd /Users/richardivers/code/un1t-crm && ls supabase/migrations/ | sort -t_ -k1 -n | tail -3`
Use the next integer (expected `296`). Name the file `296_customer_engagement_nudges.sql` (adjust if 296 is taken).

- [ ] **Step 2: Write the migration**

```sql
-- 296: Engagement loop — idempotency log for goal-completion + streak-at-risk
-- notifications. Achievements reuse contact_achievements.notified_at; this table
-- covers the two periodic notifications. Service-role writes (endSession + cron);
-- customers read their own (cheap seed for a future in-app feed).
CREATE TABLE IF NOT EXISTS public.customer_engagement_nudges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('streak_at_risk','goal_complete')),
  dedup_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, type, dedup_key)
);
CREATE INDEX IF NOT EXISTS idx_customer_engagement_nudges_contact
  ON public.customer_engagement_nudges(contact_id, type);

ALTER TABLE public.customer_engagement_nudges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Customers read own engagement nudges"
  ON public.customer_engagement_nudges FOR SELECT TO public
  USING (contact_id = (SELECT private.auth_contact_id()));

CREATE POLICY "Staff read engagement nudges at their locations"
  ON public.customer_engagement_nudges FOR SELECT TO public
  USING (
    (SELECT private.auth_is_master())
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = customer_engagement_nudges.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

COMMENT ON TABLE public.customer_engagement_nudges IS
  'Engagement loop (2026-06): idempotency log for goal_complete + streak_at_risk pushes. Service-role write, customer self-read.';

-- Heartbeat for the streak-at-risk cron (daily 11:00 UTC).
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES ('notify-streak-at-risk', 86400, 7200, 'Daily 11:00 UTC — streak-at-risk push nudge. 2h grace.')
ON CONFLICT (name) DO NOTHING;
```

- [ ] **Step 3: Apply to the project** (via Supabase MCP `apply_migration`, name `customer_engagement_nudges`, project `iyvtbjjxdggiadzwwvdj`). Then run the security advisor (`get_advisors` type=security) and confirm no new ERROR/WARN for this table. Verify:

Run a quick check via MCP `execute_sql`: `select count(*) from customer_engagement_nudges;` → expect `0`. And `select name from cron_heartbeats where name='notify-streak-at-risk';` → one row.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/296_customer_engagement_nudges.sql && git commit -m "feat(db): customer_engagement_nudges + streak-at-risk heartbeat (mig 296)"
```

---

## Phase 3 — Component C: goal-completion

### Task 8: port `goals.js` into un1t-crm (byte-synced)

**Files:**
- Create: `src/lib/goals.js`
- Test: `src/lib/goals.test.js`

- [ ] **Step 1: Create `src/lib/goals.js`** — verbatim copy of `champ-app/shared/goals.js` with a sync banner as line 1:

```js
// KEEP IN SYNC with champ-app/shared/goals.js (verbatim copy below line 1).
const MS_DAY = 24 * 3600 * 1000

export function startOfIsoWeek(now = new Date()) {
  const d = new Date(now)
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() - day)
  return d
}
export function startOfMonth(now = new Date()) {
  const d = new Date(now)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}

export const GOAL_DEFS = {
  weekly_points: { label: 'UN1T points this week', unit: 'points', suggested: [200, 500, 1000, 1500, 2500], period: 'week', field: 'effort_points' },
  weekly_classes: { label: 'Classes this week', unit: 'classes', suggested: [2, 3, 4, 5, 6], period: 'week', field: 'classes' },
  monthly_points: { label: 'UN1T points this month', unit: 'points', suggested: [1000, 2500, 5000, 10000], period: 'month', field: 'effort_points' },
  monthly_classes: { label: 'Classes this month', unit: 'classes', suggested: [8, 12, 16, 20, 24], period: 'month', field: 'classes' },
}

export const GOAL_KINDS = Object.keys(GOAL_DEFS)

export function computeProgress(goal, sessions, now = new Date()) {
  const def = GOAL_DEFS[goal.kind]
  if (!def) return { current: 0, target: goal.target_value, pct: 0, periodStart: null }
  const periodStart = def.period === 'week' ? startOfIsoWeek(now) : startOfMonth(now)
  const startMs = periodStart.getTime()
  let current = 0
  for (const s of sessions || []) {
    const t = new Date(s.started_at || s.ended_at).getTime()
    if (t < startMs) continue
    if (def.field === 'classes') current += 1
    else if (def.field === 'effort_points') current += Number(s.effort_points) || 0
  }
  const target = goal.target_value
  const pct = target > 0 ? Math.min(1, current / target) : 0
  return { current, target, pct, periodStart, def }
}

export function periodEnd(periodStart) {
  const d = new Date(periodStart)
  return d
}
```
> Note `MS_DAY` is carried verbatim from the source even though unused (keeps the copies byte-aligned below line 1).

- [ ] **Step 2: Write the contract test** (`src/lib/goals.test.js`)

```js
import { describe, it, expect } from 'vitest'
import { GOAL_DEFS, GOAL_KINDS, computeProgress } from './goals.js'

describe('GOAL_DEFS contract', () => {
  it('has the four kinds with period + field', () => {
    expect(GOAL_KINDS).toEqual(['weekly_points', 'weekly_classes', 'monthly_points', 'monthly_classes'])
    expect(GOAL_DEFS.weekly_points).toMatchObject({ period: 'week', field: 'effort_points', unit: 'points' })
    expect(GOAL_DEFS.monthly_classes).toMatchObject({ period: 'month', field: 'classes', unit: 'classes' })
  })
})

describe('computeProgress', () => {
  const now = new Date('2026-06-20T12:00:00Z') // Saturday, ISO week 25
  it('sums effort_points within the week', () => {
    const sessions = [
      { started_at: '2026-06-16T10:00:00Z', effort_points: 200 }, // Mon (in week)
      { started_at: '2026-06-20T10:00:00Z', effort_points: 150 }, // Sat (in week)
      { started_at: '2026-06-14T10:00:00Z', effort_points: 999 }, // prior Sun (out)
    ]
    expect(computeProgress({ kind: 'weekly_points', target_value: 500 }, sessions, now).current).toBe(350)
  })
  it('counts classes within the month', () => {
    const sessions = [
      { started_at: '2026-06-02T10:00:00Z', effort_points: 100 },
      { started_at: '2026-06-19T10:00:00Z', effort_points: 100 },
      { started_at: '2026-05-30T10:00:00Z', effort_points: 100 }, // prior month (out)
    ]
    expect(computeProgress({ kind: 'monthly_classes', target_value: 16 }, sessions, now).current).toBe(2)
  })
})
```

- [ ] **Step 3: Run — verify pass** (TZ sweep)

Run: `cd /Users/richardivers/code/un1t-crm && for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run src/lib/goals.test.js; done`
Expected: PASS both.

- [ ] **Step 4: Confirm byte-sync below line 1**

Run: `diff <(tail -n +2 src/lib/goals.js) <(tail -n +2 /Users/richardivers/code/champ-app/shared/goals.js)`
Expected: no output. (If the champ-app source has whitespace your single-line `GOAL_DEFS` entries don't match, instead copy champ-app's exact formatting — the byte-sync is the requirement, the formatting in this plan is illustrative.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/goals.js src/lib/goals.test.js && git commit -m "feat(goals): port goals.js into un1t-crm (synced from champ-app)"
```

### Task 9: goal-completion detection + push in `endSession` (un1t-crm)

**Files:**
- Modify: `src/lib/live-class.js` (imports + add a block in `endSession` after the achievement block)

- [ ] **Step 1: Add imports** at the top of `src/lib/live-class.js`:

```js
import { buildSessionPush, buildGoalPush, periodKey } from '@/lib/customer-notifications'
import { GOAL_DEFS, computeProgress, startOfMonth } from '@/lib/goals'
```
(Merge the `buildSessionPush` import added in Task 3 into this single line.)

- [ ] **Step 2: Add the goal-completion block** in `endSession`, immediately after the achievement `try/catch` from Task 3 (still inside `if (session.contact_id) { … }`):

```js
    // Best-effort: celebrate any active goal completed (this period) by this
    // session. Idempotent per (goal, period) via customer_engagement_nudges.
    try {
      const { data: goals } = await db
        .from('contact_goals')
        .select('id, kind, target_value')
        .eq('contact_id', session.contact_id)
        .eq('is_active', true)
        .is('archived_at', null)
      if (goals && goals.length) {
        // This month's sessions cover both weekly and monthly periods.
        const sinceIso = startOfMonth(new Date(nowMs)).toISOString()
        const { data: gSessions } = await db
          .from('heart_rate_sessions')
          .select('started_at, effort_points')
          .eq('contact_id', session.contact_id)
          .not('ended_at', 'is', null)
          .gte('started_at', sinceIso)
        for (const goal of goals) {
          const def = GOAL_DEFS[goal.kind]
          if (!def) continue
          const { current } = computeProgress(goal, gSessions || [], new Date(nowMs))
          if (current < goal.target_value) continue
          const dedupKey = `${goal.id}:${periodKey(def.period, nowMs)}`
          const { data: ins, error: insErr } = await db
            .from('customer_engagement_nudges')
            .insert({ contact_id: session.contact_id, type: 'goal_complete', dedup_key: dedupKey })
            .select('id')
          if (insErr || !ins || !ins.length) continue // already celebrated this period, or insert failed
          await sendCustomerPush(db, session.contact_id, buildGoalPush({ goal, def }))
        }
      }
    } catch (err) {
      logWarn('live-class', 'goal-completion notify threw', { err, sessionId })
    }
```

- [ ] **Step 3: Verify**

Run: `cd /Users/richardivers/code/un1t-crm && npm test && npm run lint && npm run build`
Expected: PASS / clean / build OK.

- [ ] **Step 4: Commit**

```bash
git add src/lib/live-class.js && git commit -m "feat(live-class): goal-completion celebration push at session-end"
```

### Task 10: mobile deep-link case `goal` (champ-app)

**Files:**
- Modify: `champ-app/mobile/app/_layout.jsx`

- [ ] **Step 1: Add the case** after `case 'achievement':`:

```js
        case 'goal':
          router.push('/account/goals')
          break
```

- [ ] **Step 2: Commit**

```bash
cd /Users/richardivers/code/champ-app && git add mobile/app/_layout.jsx && git commit -m "feat(push): deep-link goal notifications to goals screen"
```

---

## Phase 4 — Component B: streak-at-risk cron

### Task 11: `streakAtRisk` predicate test (un1t-crm)

> The `streakAtRisk` function was implemented in Task 2. Add its dedicated tests now (kept separate so Phase 4 can stand alone).

**Files:**
- Modify: `src/lib/customer-notifications.test.js`

- [ ] **Step 1: Add the test** (add `streakAtRisk` to the import line):

```js
describe('streakAtRisk', () => {
  const N = new Date('2026-06-20T18:00:00Z').getTime()
  const dayAgo = (n) => new Date(N - n * 24 * 3600 * 1000).toISOString()
  it('flags a >=3 run ending yesterday with nothing today', () => {
    const ss = [{ started_at: dayAgo(1) }, { started_at: dayAgo(2) }, { started_at: dayAgo(3) }]
    expect(streakAtRisk(ss, N, 3)).toBe(3)
  })
  it('does not flag if they already trained today', () => {
    const ss = [{ started_at: dayAgo(0) }, { started_at: dayAgo(1) }, { started_at: dayAgo(2) }]
    expect(streakAtRisk(ss, N, 3)).toBe(0)
  })
  it('does not flag a run below the threshold', () => {
    const ss = [{ started_at: dayAgo(1) }, { started_at: dayAgo(2) }]
    expect(streakAtRisk(ss, N, 3)).toBe(0)
  })
  it('does not flag a streak already broken (last session 2 days ago)', () => {
    const ss = [{ started_at: dayAgo(2) }, { started_at: dayAgo(3) }, { started_at: dayAgo(4) }]
    expect(streakAtRisk(ss, N, 3)).toBe(0)
  })
})
```

- [ ] **Step 2: Run — verify pass**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/customer-notifications.test.js -t streakAtRisk`
Expected: PASS (4).

- [ ] **Step 3: Commit**

```bash
git add src/lib/customer-notifications.test.js && git commit -m "test(notifications): streakAtRisk predicate"
```

### Task 12: the cron route (un1t-crm)

**Files:**
- Create: `src/app/api/cron/notify-streak-at-risk/route.js`

- [ ] **Step 1: Implement the route**

```js
// Vercel cron — daily 11:00 UTC (~midday Dublin).
// Pushes a loss-aversion nudge to members whose streak (>= MIN_STREAK days,
// ending YESTERDAY) will break unless they train today. Idempotent per member
// per day via customer_engagement_nudges. Reachable members only (push token).
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { sendCustomerPush } from '@/lib/customer-push'
import { streakAtRisk, buildStreakAtRiskPush } from '@/lib/customer-notifications'
import { logInfo, logWarn } from '@/lib/log'
import { stampHeartbeat } from '@/lib/cron-heartbeat'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const MIN_STREAK = 3
const PAGE = 1000

export async function POST(request) { return GET(request) }

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
  }
  const db = createServerClient()
  const nowMs = Date.now()
  const DAY = 24 * 3600 * 1000
  const n = new Date(nowMs)
  const todayMs = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate())
  const todayIso = new Date(todayMs).toISOString()
  const yestIso = new Date(todayMs - DAY).toISOString()
  const dedupKey = new Date(todayMs).toISOString().slice(0, 10) // YYYY-MM-DD

  // 1. Candidates = contacts who trained YESTERDAY (only they can have a streak
  //    "ending yesterday"). Paginate defensively.
  const candidateIds = new Set()
  for (let from = 0; ; from += PAGE) {
    const { data: rows, error } = await db
      .from('heart_rate_sessions')
      .select('contact_id')
      .not('contact_id', 'is', null)
      .not('ended_at', 'is', null)
      .gte('started_at', yestIso)
      .lt('started_at', todayIso)
      .order('contact_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) { logWarn('cron-streak-risk', 'candidate query failed', { err: error }); break }
    for (const r of rows || []) candidateIds.add(r.contact_id)
    if (!rows || rows.length < PAGE) break
  }
  if (candidateIds.size === 0) {
    await stampHeartbeat('notify-streak-at-risk').catch(() => {})
    return NextResponse.json({ ok: true, candidates: 0, nudged: 0 })
  }

  const ids = [...candidateIds]

  // 2. Their last-10-day sessions (for streak computation), batched.
  const sinceIso = new Date(todayMs - 10 * DAY).toISOString()
  const byContact = new Map()
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)
    const { data: rows } = await db
      .from('heart_rate_sessions')
      .select('contact_id, started_at')
      .in('contact_id', chunk)
      .not('ended_at', 'is', null)
      .gte('started_at', sinceIso)
    for (const r of rows || []) {
      if (!byContact.has(r.contact_id)) byContact.set(r.contact_id, [])
      byContact.get(r.contact_id).push({ started_at: r.started_at })
    }
  }

  // 3. At-risk members.
  const atRisk = []
  for (const cid of ids) {
    const streak = streakAtRisk(byContact.get(cid) || [], nowMs, MIN_STREAK)
    if (streak > 0) atRisk.push({ cid, streak })
  }
  if (atRisk.length === 0) {
    await stampHeartbeat('notify-streak-at-risk').catch(() => {})
    return NextResponse.json({ ok: true, candidates: ids.length, at_risk: 0, nudged: 0 })
  }

  // 4. Keep only reachable (has a push token).
  const reachable = new Set()
  const atRiskIds = atRisk.map((a) => a.cid)
  for (let i = 0; i < atRiskIds.length; i += 200) {
    const chunk = atRiskIds.slice(i, i + 200)
    const { data: toks } = await db.from('champ_push_tokens').select('contact_id').in('contact_id', chunk)
    for (const t of toks || []) reachable.add(t.contact_id)
  }

  // 5. Record (idempotent) + push.
  let nudged = 0
  for (const { cid, streak } of atRisk) {
    if (!reachable.has(cid)) continue
    const { data: ins, error: insErr } = await db
      .from('customer_engagement_nudges')
      .insert({ contact_id: cid, type: 'streak_at_risk', dedup_key: dedupKey })
      .select('id')
    if (insErr || !ins || !ins.length) continue // already nudged today, or error
    try {
      await sendCustomerPush(db, cid, buildStreakAtRiskPush({ streak }))
      nudged++
    } catch (err) {
      logWarn('cron-streak-risk', 'push threw', { err, cid })
    }
  }

  logInfo('cron-streak-risk', 'tick', { candidates: ids.length, at_risk: atRisk.length, nudged })
  await stampHeartbeat('notify-streak-at-risk').catch((err) =>
    logWarn('cron-streak-risk', 'heartbeat failed', { err }))
  return NextResponse.json({ ok: true, candidates: ids.length, at_risk: atRisk.length, nudged })
}
```

- [ ] **Step 2: Verify** (route compiles + guard present)

Run: `cd /Users/richardivers/code/un1t-crm && npm run build && npm run check:route-guards`
Expected: build OK; route-guard check passes (the `CRON_SECRET` bearer check is the recognised cron guard).

- [ ] **Step 3: Commit**

```bash
git add src/app/api/cron/notify-streak-at-risk/route.js && git commit -m "feat(cron): streak-at-risk daily nudge"
```

### Task 13: register the cron + mobile deep-link (un1t-crm + champ-app)

**Files:**
- Modify: `un1t-crm/vercel.json`
- Modify: `champ-app/mobile/app/_layout.jsx`

- [ ] **Step 1: Add the cron entry** to the `crons` array in `vercel.json` (append before the closing `]`):

```json
    ,{
      "path": "/api/cron/notify-streak-at-risk",
      "schedule": "0 11 * * *"
    }
```
(Place it as a proper array element — add the leading comma to the previous last element instead if your formatter prefers; the result must be valid JSON.)

- [ ] **Step 2: Validate JSON**

Run: `cd /Users/richardivers/code/un1t-crm && node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('valid')"`
Expected: `valid`.

- [ ] **Step 3: Add the mobile deep-link case** in `champ-app/mobile/app/_layout.jsx` after `case 'goal':`:

```js
        case 'streak_at_risk':
          router.push('/')
          break
```

- [ ] **Step 4: Commit (both repos)**

```bash
cd /Users/richardivers/code/un1t-crm && git add vercel.json && git commit -m "feat(cron): schedule notify-streak-at-risk daily 11:00 UTC"
cd /Users/richardivers/code/champ-app && git add mobile/app/_layout.jsx && git commit -m "feat(push): deep-link streak-at-risk to dashboard"
```

---

## Final verification (before PRs)

- [ ] **un1t-crm full CI mirror:**
```bash
cd /Users/richardivers/code/un1t-crm && npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run build
```
Expected: all green. (No new `WEB_PERMISSIONS` were added, so parity should be unaffected; if the linter complains, this feature adds no permission key — investigate, don't add one.)

- [ ] **champ-app:**
```bash
cd /Users/richardivers/code/champ-app && npm test && npm run build && npx expo export --platform ios --output-dir /tmp/exp 2>&1 | tail -3 && rm -rf /tmp/exp
```
Expected: tests pass, web build OK, expo export resolves.

- [ ] **Open two PRs** (`base=main` each) per the un1t-crm ship loop, citing mig 296 and the spec. champ-app changes OTA via the eas-update workflow on merge to its `main`; the un1t-crm cron goes live on Vercel deploy.

- [ ] **Post-merge smoke:** end a real (member-linked) session and confirm one push arrives leading with any achievement; check `contact_achievements.notified_at` is stamped. Goal/streak paths stay dormant until a member sets a goal / builds a 3-day streak.

---

## Self-review notes (author)

- **Spec coverage:** Component A → Tasks 1–6; Component B → Tasks 7,11,12,13; Component C → Tasks 7,8,9,10; data model → Task 7; streak surfacing → Tasks 0,4,5; copy table → Task 2; testing → Tasks 0,2,8,11. All spec sections map to a task.
- **One-push-per-class:** enforced in Task 3 (single `buildSessionPush`); goal completion (Task 9) can add a 2nd push only when a goal completes the same session — matches spec §A1 exception.
- **Byte-sync:** `hr-analytics.js` edited in both repos (Task 0 step 5); `goals.js` synced + diff-checked (Task 8 step 4).
- **Type consistency:** `unlocked` items carry `{slug,ruleId,name,icon}` (Task 1) and `buildSessionPush` reads `.name` (Task 2). `streakAtRisk` returns a number used directly as `buildStreakAtRiskPush({streak})` (Tasks 2,12). `currentStreak` returns `{current,best,lastDayMs}` consumed by the chips (4,5) and `streakAtRisk` (2).
- **No placeholders:** every code step has complete code; the only "inspect existing pattern" note is the web icon import (Task 4 step 2), which is environment-specific and given a concrete fallback.
