# Monthly Target + Status Tiers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An always-on personal progression — a gym-wide monthly UN1T-Points target + a cumulative months-hit status-tier ladder — surfaced in the champ-app dashboard and announced via the existing push loop.

**Architecture:** Event-driven banking at session-end (extends `endSession`): when this-month points cross the gym target, bank the month (idempotent table row), derive tier from the count of banked months, fire one push (tier-up supersedes target-hit). No cron. Tier ladder is a byte-synced pure module reused across repos. champ-app reads the gym target via the service client (customer RLS can't read `locations`).

**Tech Stack:** Next.js 16 / Supabase (un1t-crm), Expo/React Native + NativeWind (champ-app), Vitest, Expo push.

**Spec:** `docs/superpowers/specs/2026-06-20-tiers-monthly-target-design.md`

**Refinement from spec:** the gym target is stored at `locations.settings.customer_agent.monthly_points_target` (not top-level `settings.monthly_points_target`) — this reuses the existing Settings → Customer agent page/route AND the exact `settings.customer_agent` path `loadSessionReport` already reads, so no new operator route/page.

**Scope trim:** the spec's optional "session-report line" is **deferred** — it would couple the heavy `loadSessionReport`/`buildSessionReport` to the target; the dashboard ring is the surface for v1. Noted as a fast-follow.

**Two repos, two PRs.** un1t-crm: `tiers.js`, `customer-notifications.js`, `live-class.js`, migration, customer-agent settings. champ-app: `shared/tiers.js`, `tier-status.js`, `load-tier-status.js`, `/api/tier-status`, dashboards, `_layout.jsx`.

**Branch setup (do first, both repos; un1t-crm `main` has unrelated cookie-consent WIP — stage only named files, never `git add -A`):**
```bash
cd /Users/richardivers/code/un1t-crm && git checkout main && git pull origin main && git checkout -b engagement-tiers
cd /Users/richardivers/code/champ-app && git checkout main && git pull origin main && git checkout -b engagement-tiers
```

---

## File Structure

**un1t-crm**
- `src/lib/tiers.js` — NEW. `TIERS` ladder + pure `tierForMonths` / `nextTier`. (Byte-synced canonical.)
- `src/lib/customer-notifications.js` — add pure `buildTargetHitPush`, `buildTierUpPush`.
- `src/lib/live-class.js` — `endSession`: add `location_id` to the session SELECT; add the tier-banking best-effort block; extend imports.
- `supabase/migrations/<next>_member_monthly_targets.sql` — NEW table + RLS.
- Settings → Customer agent page + its API route — add the `monthly_points_target` number field.
- Tests: `src/lib/tiers.test.js` (NEW), `src/lib/customer-notifications.test.js`.

**champ-app**
- `shared/tiers.js` — NEW, byte-synced copy (line-1 banner differs). `src/lib/tiers.js` = `export * from '../../shared/tiers'`.
- `src/lib/tier-status.js` — NEW. Pure `buildTierStatus`.
- `src/lib/load-tier-status.js` — NEW. `loadTierStatus(supabase, {contactId, locationId, serviceSupabase, nowMs})`.
- `src/app/api/tier-status/route.js` — NEW. `GET` (mirrors the session-report route).
- `src/app/page.jsx` — add `TierCard` (web).
- `mobile/app/(tabs)/index.jsx` — add `TierCard` (native, via the API).
- `mobile/app/_layout.jsx` — add `monthly_target_hit` + `tier_up` deep-link cases.
- Tests: `shared/tiers.test.js`, `src/lib/tier-status.test.js`.

---

## Phase 1 — tier ladder (foundation, both repos)

### Task 1: `tiers.js` + tests (un1t-crm canonical + champ-app sync)

**Files:** Create `un1t-crm/src/lib/tiers.js` + `un1t-crm/src/lib/tiers.test.js`; `champ-app/shared/tiers.js` + `champ-app/shared/tiers.test.js` + `champ-app/src/lib/tiers.js`.

- [ ] **Step 1: failing test** — `un1t-crm/src/lib/tiers.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { TIERS, tierForMonths, nextTier } from './tiers.js'

describe('TIERS', () => {
  it('is the 5-rung ladder with metal colours', () => {
    expect(TIERS.map((t) => [t.slug, t.months])).toEqual([
      ['bronze', 1], ['silver', 3], ['gold', 6], ['platinum', 12], ['elite', 24],
    ])
    expect(TIERS.find((t) => t.slug === 'gold').color).toBe('#e8b931')
  })
})

describe('tierForMonths', () => {
  it('is null below Bronze', () => { expect(tierForMonths(0)).toBeNull() })
  it('maps counts to the highest reached tier', () => {
    expect(tierForMonths(1).slug).toBe('bronze')
    expect(tierForMonths(2).slug).toBe('bronze')
    expect(tierForMonths(3).slug).toBe('silver')
    expect(tierForMonths(6).slug).toBe('gold')
    expect(tierForMonths(11).slug).toBe('gold')
    expect(tierForMonths(12).slug).toBe('platinum')
    expect(tierForMonths(24).slug).toBe('elite')
    expect(tierForMonths(100).slug).toBe('elite')
  })
})

describe('nextTier', () => {
  it('points at the next rung, null at the top', () => {
    expect(nextTier(0).slug).toBe('bronze')
    expect(nextTier(1).slug).toBe('silver')
    expect(nextTier(3).slug).toBe('gold')
    expect(nextTier(6).slug).toBe('platinum')
    expect(nextTier(12).slug).toBe('elite')
    expect(nextTier(24)).toBeNull()
    expect(nextTier(100)).toBeNull()
  })
})
```
- [ ] **Step 2: run → fail.** `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/tiers.test.js` → FAIL (module missing).
- [ ] **Step 3: implement** `un1t-crm/src/lib/tiers.js`:
```js
// Status-tier ladder. Pure — months-hit count in, tier out. Byte-synced with
// champ-app/shared/tiers.js (only line 1 differs). un1t-crm uses it for the
// tier-up push (name); champ-app uses it for the dashboard badge (name+colour).
export const TIERS = [
  { slug: 'bronze',   name: 'Bronze',   months: 1,  color: '#c77b3a' },
  { slug: 'silver',   name: 'Silver',   months: 3,  color: '#c2c8ce' },
  { slug: 'gold',     name: 'Gold',     months: 6,  color: '#e8b931' },
  { slug: 'platinum', name: 'Platinum', months: 12, color: '#cfe2ea' },
  { slug: 'elite',    name: 'Elite',    months: 24, color: '#ff5a1f' },
]

/** Highest tier whose `months` threshold is <= monthsHit; null below Bronze (0). */
export function tierForMonths(monthsHit) {
  const n = Number(monthsHit) || 0
  let out = null
  for (const t of TIERS) { if (n >= t.months) out = t; else break }
  return out
}

/** The next rung above monthsHit, or null at the top (Elite). */
export function nextTier(monthsHit) {
  const n = Number(monthsHit) || 0
  for (const t of TIERS) { if (n < t.months) return t }
  return null
}
```
- [ ] **Step 4: run → pass.** `npx vitest run src/lib/tiers.test.js` → PASS.
- [ ] **Step 5: sync champ-app.** Copy the file to `champ-app/shared/tiers.js`, replacing line 1 with:
`// KEEP IN SYNC with un1t-crm/src/lib/tiers.js (verbatim copy below line 1).`
Create `champ-app/src/lib/tiers.js` with exactly: `export * from '../../shared/tiers'`
Copy the test to `champ-app/shared/tiers.test.js` (same body, import `from './tiers.js'`). Verify:
`cd /Users/richardivers/code/champ-app && npx vitest run shared/tiers.test.js` → PASS.
Confirm sync: `diff <(tail -n +2 /Users/richardivers/code/un1t-crm/src/lib/tiers.js) <(tail -n +2 /Users/richardivers/code/champ-app/shared/tiers.js)` → empty.
- [ ] **Step 6: commit (both repos + the spec/plan docs on un1t-crm).**
```bash
cd /Users/richardivers/code/un1t-crm && git add src/lib/tiers.js src/lib/tiers.test.js docs/superpowers/specs/2026-06-20-tiers-monthly-target-design.md docs/superpowers/plans/2026-06-20-tiers-monthly-target.md && git commit -m "feat(tiers): tier ladder helpers + spec/plan"
cd /Users/richardivers/code/champ-app && git add shared/tiers.js shared/tiers.test.js src/lib/tiers.js && git commit -m "feat(tiers): tier ladder helpers (sync from un1t-crm)"
```

---

## Phase 2 — data + operator setting (un1t-crm)

### Task 2: migration `member_monthly_targets`

**Files:** Create `un1t-crm/supabase/migrations/<next>_member_monthly_targets.sql`.

- [ ] **Step 1: confirm next number.** `cd /Users/richardivers/code/un1t-crm && ls supabase/migrations/ | sed -E 's/_.*//' | sort -n | tail -1` → use the next integer (expected `297`).
- [ ] **Step 2: write** `297_member_monthly_targets.sql`:
```sql
-- 297: Monthly target + tiers — durable record of months a member hit the gym's
-- monthly UN1T-Points target. Only HIT months get a row (no demotion). months_hit
-- = count(rows); tier derived in code. `target` snapshots the gym target at bank
-- time so later target edits never retroactively un-hit a month. Service-role write
-- (endSession); customer self-read + staff-at-location read.
CREATE TABLE IF NOT EXISTS public.member_monthly_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  period_month text NOT NULL,          -- 'YYYY-MM' (UTC)
  points integer NOT NULL,
  target integer NOT NULL,
  banked_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, period_month)
);
CREATE INDEX IF NOT EXISTS idx_member_monthly_targets_contact ON public.member_monthly_targets(contact_id);

ALTER TABLE public.member_monthly_targets ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Customers read own monthly targets"
  ON public.member_monthly_targets FOR SELECT TO public
  USING (contact_id = (SELECT private.auth_contact_id()));

CREATE POLICY "Staff read monthly targets at their locations"
  ON public.member_monthly_targets FOR SELECT TO public
  USING (
    (SELECT private.auth_is_master())
    OR EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = member_monthly_targets.contact_id
        AND private.auth_is_in_location(c.location_id)
    )
  );

COMMENT ON TABLE public.member_monthly_targets IS
  'Monthly target + tiers (2026-06): one row per member per month they hit the gym points target. Tier = count(rows). Service-role write, customer self-read.';
```
- [ ] **Step 3: apply** via Supabase MCP `apply_migration` (name `member_monthly_targets`, project `iyvtbjjxdggiadzwwvdj`). Then `get_advisors` type=security → confirm no new ERROR/WARN for this table. Verify with `execute_sql`: `select count(*) from member_monthly_targets;` → 0.
- [ ] **Step 4: commit.** `git add supabase/migrations/297_member_monthly_targets.sql && git commit -m "feat(db): member_monthly_targets (mig 297)"`

### Task 3: operator "Monthly points target" field

**Files:** Modify `un1t-crm/src/app/settings/customer-agent/page.js` + its API route (`src/app/api/settings/customer-agent/route.js`). READ both first to match their exact patterns.

- [ ] **Step 1: read** `src/app/settings/customer-agent/page.js` and `src/app/api/settings/customer-agent/route.js`. Identify: the `settings` state object (mirrors `locations.settings.customer_agent`), the `setField(key, val)` helper, the `inputCls` constant, and how the PUT route validates/whitelists keys before writing `settings.customer_agent`.
- [ ] **Step 2: add the field to the page** — in the same section style as existing fields (e.g. `booking_url`), add:
```jsx
<label className="block text-sm font-medium text-un1t-text">Monthly UN1T-Points target</label>
<p className="text-xs text-un1t-text-2 mb-1">Shared monthly goal that drives member tiers. Blank = tiers off.</p>
<input type="number" min={0} step={50} className={inputCls}
  value={settings.monthly_points_target ?? ''}
  onChange={(e) => setField('monthly_points_target', e.target.value === '' ? null : Number(e.target.value))} />
```
- [ ] **Step 3: allow the key in the route** — if the PUT route whitelists `customer_agent` keys (e.g. a Zod schema or an explicit pick list), add `monthly_points_target` (integer ≥ 0, nullable) so it round-trips into `locations.settings.customer_agent.monthly_points_target`. If the route stores the whole `customer_agent` object verbatim, no route change is needed — confirm by reading it.
- [ ] **Step 4: verify.** `cd /Users/richardivers/code/un1t-crm && npm run build` → succeeds. (No unit test — it's a settings field; the engine/loader that consume the value are tested separately.)
- [ ] **Step 5: commit.** `git add src/app/settings/customer-agent/page.js src/app/api/settings/customer-agent/route.js && git commit -m "feat(settings): monthly UN1T-Points target field"`

---

## Phase 3 — engine + push (un1t-crm) + deep-links (champ-app)

### Task 4: push builders `buildTargetHitPush` / `buildTierUpPush`

**Files:** Modify `un1t-crm/src/lib/customer-notifications.js` + `src/lib/customer-notifications.test.js`.

- [ ] **Step 1: failing test** — append to `customer-notifications.test.js` (add the two names to the import):
```js
describe('buildTargetHitPush', () => {
  it('names the month + months-to-next', () => {
    const r = buildTargetHitPush({ monthLabel: 'June', monthsHit: 5, next: { name: 'Gold', months: 6 } })
    expect(r.title).toBe('June target hit 🎯')
    expect(r.body).toBe('Month 5 banked — 1 to Gold.')
    expect(r.data).toEqual({ type: 'monthly_target_hit' })
  })
  it('handles the top of the ladder (no next tier)', () => {
    const r = buildTargetHitPush({ monthLabel: 'June', monthsHit: 30, next: null })
    expect(r.body).toBe('Month 30 banked — your best run yet.')
  })
})

describe('buildTierUpPush', () => {
  it('announces the new tier', () => {
    const r = buildTierUpPush({ tier: { name: 'Gold' }, monthsHit: 6 })
    expect(r.title).toBe('You reached Gold 🏆')
    expect(r.body).toBe('6 months hit. Keep the run going.')
    expect(r.data).toEqual({ type: 'tier_up' })
  })
})
```
- [ ] **Step 2: run → fail.** `npx vitest run src/lib/customer-notifications.test.js -t "TargetHit|TierUp"` → FAIL.
- [ ] **Step 3: implement** — add to `customer-notifications.js` (after `buildStreakAtRiskPush`):
```js
/** Monthly-target-hit push (no tier change this bank). `next` is the next tier or null. */
export function buildTargetHitPush({ monthLabel, monthsHit, next }) {
  const tail = next
    ? `Month ${monthsHit} banked — ${next.months - monthsHit} to ${next.name}.`
    : `Month ${monthsHit} banked — your best run yet.`
  return { title: `${monthLabel} target hit 🎯`, body: tail, data: { type: 'monthly_target_hit' } }
}

/** Tier-up push — this bank advanced the belt. */
export function buildTierUpPush({ tier, monthsHit }) {
  return {
    title: `You reached ${tier.name} 🏆`,
    body: `${monthsHit} months hit. Keep the run going.`,
    data: { type: 'tier_up' },
  }
}
```
- [ ] **Step 4: run → pass.** `npx vitest run src/lib/customer-notifications.test.js` → PASS.
- [ ] **Step 5: commit.** `git add src/lib/customer-notifications.js src/lib/customer-notifications.test.js && git commit -m "feat(notifications): target-hit + tier-up push builders"`

### Task 5: tier-banking block in `endSession`

**Files:** Modify `un1t-crm/src/lib/live-class.js` (imports, the session SELECT, and a new best-effort block).

- [ ] **Step 1: extend imports** — change the two engagement imports at the top to:
```js
import { buildSessionPush, buildGoalPush, buildTargetHitPush, buildTierUpPush, periodKey } from '@/lib/customer-notifications'
import { GOAL_DEFS, computeProgress, startOfMonth, startOfIsoWeek } from '@/lib/goals'
import { tierForMonths, nextTier } from '@/lib/tiers'
```
Add a month-name constant near the top of the file (module scope):
```js
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']
```
- [ ] **Step 2: add `location_id` to the session SELECT** — change the first query in `endSession` from
`.select('id, contact_id, max_hr_used, ended_at, class_name')` to
`.select('id, contact_id, location_id, max_hr_used, ended_at, class_name')`.
- [ ] **Step 3: add the tier block** — inside `if (session.contact_id) {`, immediately AFTER the goal-completion `try/catch` and BEFORE the `enqueueExportsForSession(...)` call:
```js
    // Best-effort: monthly target + tier banking. Banks the month the instant
    // this-month points cross the gym target; tier is derived from the count of
    // banked months. Idempotent per (contact, month) via the unique constraint.
    try {
      const { data: loc } = await db
        .from('locations').select('settings').eq('id', session.location_id).maybeSingle()
      const target = Number(loc?.settings?.customer_agent?.monthly_points_target) || 0
      if (target > 0) {
        const monthKey = periodKey('month', nowMs) // 'YYYY-MM'
        const monthStartIso = startOfMonth(new Date(nowMs)).toISOString()
        const { data: monthSessions } = await db
          .from('heart_rate_sessions')
          .select('effort_points')
          .eq('contact_id', session.contact_id)
          .not('ended_at', 'is', null)
          .gte('started_at', monthStartIso)
        const monthPoints = (monthSessions || []).reduce((a, s) => a + (Number(s.effort_points) || 0), 0)
        if (monthPoints >= target) {
          const { data: banked, error: bankErr } = await db
            .from('member_monthly_targets')
            .insert({
              contact_id: session.contact_id, location_id: session.location_id,
              period_month: monthKey, points: monthPoints, target,
            })
            .select('id')
          if (!bankErr && banked && banked.length) {
            const { count } = await db
              .from('member_monthly_targets')
              .select('id', { count: 'exact', head: true })
              .eq('contact_id', session.contact_id)
            const monthsHit = count || 1
            const newTier = tierForMonths(monthsHit)
            const oldTier = tierForMonths(monthsHit - 1)
            if (newTier && (!oldTier || newTier.slug !== oldTier.slug)) {
              // tier-up supersedes target-hit; idempotent via customer_engagement_nudges
              const { data: nins } = await db
                .from('customer_engagement_nudges')
                .insert({ contact_id: session.contact_id, type: 'tier_up', dedup_key: newTier.slug })
                .select('id')
              if (nins && nins.length) {
                await sendCustomerPush(db, session.contact_id, buildTierUpPush({ tier: newTier, monthsHit }))
              }
            } else {
              const monthLabel = MONTH_NAMES[new Date(nowMs).getUTCMonth()]
              await sendCustomerPush(
                db, session.contact_id,
                buildTargetHitPush({ monthLabel, monthsHit, next: nextTier(monthsHit) })
              )
            }
          }
        }
      }
    } catch (err) {
      logWarn('live-class', 'tier banking threw', { err, sessionId })
    }
```
- [ ] **Step 4: verify.** `cd /Users/richardivers/code/un1t-crm && npm test && npm run lint && npm run build` → tests pass, lint clean, build OK. (No endSession unit test exists; the pure pieces — tiers, push builders — are covered.)
- [ ] **Step 5: commit.** `git add src/lib/live-class.js && git commit -m "feat(live-class): monthly-target + tier banking at session-end"`

### Task 6: mobile deep-link cases

**Files:** Modify `champ-app/mobile/app/_layout.jsx`.

- [ ] **Step 1: add cases** in the `switch (data.type)` block, after `case 'streak_at_risk':`:
```js
        case 'monthly_target_hit':
          router.push('/')
          break
        case 'tier_up':
          router.push('/')
          break
```
- [ ] **Step 2: verify.** `cd /Users/richardivers/code/champ-app/mobile && npx expo export --platform ios --output-dir /tmp/exp-tiers >/tmp/e.log 2>&1; grep -i "unable to resolve" /tmp/e.log || echo "resolved"; rm -rf /tmp/exp-tiers`
- [ ] **Step 3: commit.** `cd /Users/richardivers/code/champ-app && git add mobile/app/_layout.jsx && git commit -m "feat(push): deep-link monthly_target_hit + tier_up"`

---

## Phase 4 — tier-status loader + API (champ-app)

### Task 7: pure `buildTierStatus` + tests

**Files:** Create `champ-app/src/lib/tier-status.js` + `champ-app/src/lib/tier-status.test.js`.

- [ ] **Step 1: failing test** — `src/lib/tier-status.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { buildTierStatus } from './tier-status.js'

const JUNE = new Date('2026-06-20T12:00:00Z').getTime()

describe('buildTierStatus', () => {
  it('returns null when no target set (feature off)', () => {
    expect(buildTierStatus({ monthsHit: 4, monthPoints: 900, target: 0, nowMs: JUNE })).toBeNull()
  })
  it('starter state at 0 months (no tier yet, next = Bronze)', () => {
    const r = buildTierStatus({ monthsHit: 0, monthPoints: 200, target: 1500, nowMs: JUNE })
    expect(r.tier).toBeNull()
    expect(r.next.slug).toBe('bronze')
    expect(r.monthsToNext).toBe(1)
    expect(r.periodLabel).toBe('June')
  })
  it('mid-ladder: Silver, ring + remaining', () => {
    const r = buildTierStatus({ monthsHit: 4, monthPoints: 920, target: 1500, nowMs: JUNE })
    expect(r.tier.slug).toBe('silver')
    expect(r.next.slug).toBe('gold')
    expect(r.monthsToNext).toBe(2)
    expect(r.remaining).toBe(580)
    expect(r.pct).toBeCloseTo(0.6133, 3)
  })
  it('clamps the ring at 100% once over target', () => {
    const r = buildTierStatus({ monthsHit: 24, monthPoints: 2000, target: 1500, nowMs: JUNE })
    expect(r.tier.slug).toBe('elite')
    expect(r.next).toBeNull()
    expect(r.monthsToNext).toBe(0)
    expect(r.pct).toBe(1)
  })
})
```
- [ ] **Step 2: run → fail.** `cd /Users/richardivers/code/champ-app && npx vitest run src/lib/tier-status.test.js` → FAIL.
- [ ] **Step 3: implement** `src/lib/tier-status.js`:
```js
// Pure builder for the dashboard tier card model. Runs server-side only
// (inside loadTierStatus / the API route); native gets the JSON.
import { tierForMonths, nextTier } from './tiers.js'

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

export function buildTierStatus({ monthsHit, monthPoints, target, nowMs = Date.now() }) {
  const tgt = Number(target) || 0
  if (tgt <= 0) return null // feature off
  const mh = Number(monthsHit) || 0
  const mp = Number(monthPoints) || 0
  const tier = tierForMonths(mh)
  const next = nextTier(mh)
  return {
    monthsHit: mh,
    tier,
    next,
    monthPoints: mp,
    target: tgt,
    pct: Math.min(1, mp / tgt),
    remaining: Math.max(0, tgt - mp),
    monthsToNext: next ? next.months - mh : 0,
    periodLabel: MONTH_NAMES[new Date(nowMs).getUTCMonth()],
  }
}
```
- [ ] **Step 4: run → pass** (TZ sweep). `for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run src/lib/tier-status.test.js; done` → PASS both.
- [ ] **Step 5: commit.** `git add src/lib/tier-status.js src/lib/tier-status.test.js && git commit -m "feat(tiers): pure buildTierStatus card model"`

### Task 8: `loadTierStatus` + `GET /api/tier-status`

**Files:** Create `champ-app/src/lib/load-tier-status.js` + `champ-app/src/app/api/tier-status/route.js`.

- [ ] **Step 1: implement the loader** `src/lib/load-tier-status.js`:
```js
// Loads the tier-status card model for a member. RLS client (`supabase`) for
// member-own data; service client for the gym target (customer RLS can't read
// locations). Mirrors load-session-report's service-client pattern.
import { startOfMonth } from './goals.js'
import { buildTierStatus } from './tier-status.js'

export async function loadTierStatus(supabase, { contactId, locationId, serviceSupabase = null, nowMs = Date.now() } = {}) {
  if (!contactId || !locationId) return { ok: false, error: 'missing-ids' }

  let target = 0
  if (serviceSupabase) {
    const { data: loc } = await serviceSupabase.from('locations').select('settings').eq('id', locationId).maybeSingle()
    target = Number(loc?.settings?.customer_agent?.monthly_points_target) || 0
  }
  if (target <= 0) return { ok: true, status: null } // feature off

  const monthStartIso = startOfMonth(new Date(nowMs)).toISOString()
  const [{ count }, { data: monthSessions }] = await Promise.all([
    supabase.from('member_monthly_targets').select('id', { count: 'exact', head: true }).eq('contact_id', contactId),
    supabase.from('heart_rate_sessions').select('effort_points').eq('contact_id', contactId)
      .not('ended_at', 'is', null).gte('started_at', monthStartIso),
  ])
  const monthPoints = (monthSessions || []).reduce((a, s) => a + (Number(s.effort_points) || 0), 0)
  return { ok: true, status: buildTierStatus({ monthsHit: count || 0, monthPoints, target, nowMs }) }
}
```
(`startOfMonth` is exported from champ-app `src/lib/goals.js` via the shared re-export; if `src/lib/goals.js` doesn't exist as a re-export, import from `'../../shared/goals.js'` — verify which path resolves, matching how `load-session-report.js` imports its shared helpers.)
- [ ] **Step 2: implement the route** `src/app/api/tier-status/route.js` (mirror the session-report route):
```js
// GET /api/tier-status — customer-self monthly-target + tier card model.
import { NextResponse } from 'next/server'
import { createServerClient, createServiceClient } from '@/lib/supabase-server'
import { loadTierStatus } from '@/lib/load-tier-status'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const supabase = createServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorised' }, { status: 401 })

  const { data: contact } = await supabase
    .from('contacts').select('id, location_id').eq('user_id', user.id).maybeSingle()
  if (!contact) return NextResponse.json({ status: null })

  const out = await loadTierStatus(supabase, {
    contactId: contact.id, locationId: contact.location_id, serviceSupabase: createServiceClient(),
  })
  return NextResponse.json({ status: out.ok ? out.status : null })
}
```
- [ ] **Step 3: verify.** `cd /Users/richardivers/code/champ-app && npm run build` → succeeds (imports resolve).
- [ ] **Step 4: commit.** `git add src/lib/load-tier-status.js src/app/api/tier-status/route.js && git commit -m "feat(tiers): loadTierStatus + GET /api/tier-status"`

---

## Phase 5 — dashboard TierCard

### Task 9: web TierCard

**Files:** Modify `champ-app/src/app/page.jsx`.

- [ ] **Step 1: imports + data load.** At the top add `import { createServiceClient } from '@/lib/supabase-server'` (next to `createServerClient`) and `import { loadTierStatus } from '@/lib/load-tier-status'`. Change the contact SELECT to include `location_id`: `.select('id, name, email, location_id')`. After the streak block, add:
```js
  // Tier status (monthly target + belt). Reads the gym target via the service client.
  const { status: tierStatus } = await loadTierStatus(supabase, {
    contactId: contact.id, locationId: contact.location_id, serviceSupabase: createServiceClient(),
  }).then((o) => (o.ok ? o : { status: null }))
```
- [ ] **Step 2: add the `TierCard` component** near `StreakCard`:
```jsx
function TierCard({ status }) {
  if (!status) return null
  const accent = status.tier?.color || status.next?.color || '#ff5a1f'
  const pctText = Math.round(status.pct * 100)
  return (
    <Card>
      <div className="flex items-center gap-3">
        <Icons.Award className="h-7 w-7 shrink-0" style={{ color: accent }} aria-hidden="true" />
        <div className="flex-1">
          <p className="text-2xl font-bold text-un1t-text" style={status.tier ? { color: accent } : undefined}>
            {status.tier ? status.tier.name : 'Earn Bronze'}
          </p>
          <p className="text-xs text-un1t-text-2">
            {status.tier ? `${status.monthsHit} months hit` : 'Hit this month’s target to start'}
            {status.next ? ` · ${status.monthsToNext} to ${status.next.name}` : ' · top tier'}
          </p>
        </div>
      </div>
      <div className="mt-4">
        <div className="flex justify-between text-xs text-un1t-text-2 mb-1">
          <span>{status.periodLabel} target</span>
          <span className="text-un1t-text font-medium tabular-nums">{status.monthPoints.toLocaleString()} / {status.target.toLocaleString()}</span>
        </div>
        <div className="h-2 rounded-full bg-un1t-surface-2 overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${pctText}%`, background: accent }} />
        </div>
        {status.remaining > 0 && (
          <p className="text-xs text-un1t-text-2 mt-2">{status.remaining.toLocaleString()} pts to bank {status.periodLabel}</p>
        )}
      </div>
    </Card>
  )
}
```
- [ ] **Step 3: render it** above the StreakCard slot:
```jsx
      <div className="mt-8">
        <TierCard status={tierStatus} />
      </div>
      <div className="mt-4">
        <StreakCard streak={streak} />
      </div>
```
(Change StreakCard's wrapper from `mt-8` to `mt-4` so spacing stays even; if `tierStatus` is null the TierCard renders nothing and StreakCard's `mt-4` is harmless.)
- [ ] **Step 4: verify.** `cd /Users/richardivers/code/champ-app && npm run build` → succeeds. (`Icons` is `import * as Icons from 'lucide-react'`; `Icons.Award` exists.)
- [ ] **Step 5: commit.** `git add src/app/page.jsx && git commit -m "feat(dashboard): tier card (web)"`

### Task 10: native TierCard

**Files:** Modify `champ-app/mobile/app/(tabs)/index.jsx`.

- [ ] **Step 1: imports + state.** Add `import { api } from '../../lib/api'` if not already imported (verify; the mobile session screen uses it). Add `const [tierStatus, setTierStatus] = useState(null)` near the other `useState`s.
- [ ] **Step 2: fetch in `load`.** After the `Promise.all([...])` block's `set*` calls, add a best-effort tier-status fetch (it's a service-backed API, separate from the RLS `Promise.all`):
```js
    try {
      const t = await api('/tier-status')
      setTierStatus(t?.status || null)
    } catch { setTierStatus(null) }
```
(`api()` from `mobile/lib/api.js` attaches auth headers + base URL — confirm its call shape matches the session-report fetch in `mobile/app/sessions/[id].jsx`; mirror it exactly.)
- [ ] **Step 3: add the `TierCard` component** near `StreakCard`:
```jsx
function TierCard({ status }) {
  if (!status) return null
  const accent = status.tier?.color || status.next?.color || '#ff5a1f'
  const pct = Math.round(status.pct * 100)
  return (
    <Card>
      <View className="flex-row items-center gap-3">
        <Ionicons name="ribbon" size={26} color={accent} />
        <View className="flex-1">
          <Text className="text-2xl font-bold" style={{ color: status.tier ? accent : '#f4f4f2' }}>
            {status.tier ? status.tier.name : 'Earn Bronze'}
          </Text>
          <Text className="text-xs text-un1t-text-2">
            {status.tier ? `${status.monthsHit} months hit` : 'Hit this month’s target to start'}
            {status.next ? ` · ${status.monthsToNext} to ${status.next.name}` : ' · top tier'}
          </Text>
        </View>
      </View>
      <View className="mt-4">
        <View className="flex-row justify-between mb-1">
          <Text className="text-xs text-un1t-text-2">{status.periodLabel} target</Text>
          <Text className="text-xs text-un1t-text font-medium">{status.monthPoints} / {status.target}</Text>
        </View>
        <View className="h-2 rounded-full bg-un1t-surface-2 overflow-hidden">
          <View className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: accent }} />
        </View>
        {status.remaining > 0 && (
          <Text className="text-xs text-un1t-text-2 mt-2">{status.remaining} pts to bank {status.periodLabel}</Text>
        )}
      </View>
    </Card>
  )
}
```
- [ ] **Step 4: render it** above the StreakCard slot:
```jsx
        <View className="mt-6">
          <TierCard status={tierStatus} />
        </View>
        <View className="mt-4">
          <StreakCard streak={streak} />
        </View>
```
(`Ionicons` is already imported; `ribbon` is a valid Ionicons name. If `ribbon` renders blank, fall back to `trophy`.)
- [ ] **Step 5: verify.** `cd /Users/richardivers/code/champ-app/mobile && npx expo export --platform ios --output-dir /tmp/exp-tc >/tmp/etc.log 2>&1; grep -i "unable to resolve" /tmp/etc.log || echo resolved; rm -rf /tmp/exp-tc`; then `cd /Users/richardivers/code/champ-app && npm test 2>&1 | tail -3` (stays green).
- [ ] **Step 6: commit.** `git add "mobile/app/(tabs)/index.jsx" && git commit -m "feat(dashboard): tier card (native)"`

---

## Final verification (before PRs)

- [ ] **un1t-crm:** `cd /Users/richardivers/code/un1t-crm && npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run build` → all green. (No new permission key added.)
- [ ] **champ-app:** `cd /Users/richardivers/code/champ-app && npm test && npm run build && cd mobile && npx expo export --platform ios --output-dir /tmp/exp-final >/tmp/ef.log 2>&1; grep -i "unable to resolve" /tmp/ef.log || echo resolved; rm -rf /tmp/exp-final`
- [ ] **Open two PRs** (`base=main` each) per the un1t-crm ship loop, citing mig 297 and the spec; cross-link them.
- [ ] **Post-merge smoke:** set a location's monthly target in Settings → Customer agent; end a real member-linked session whose month-to-date points cross the target → confirm a banked `member_monthly_targets` row + one push (Bronze tier-up on the first ever). Dashboard shows the tier card once `contact.location_id` has a target set.

---

## Self-review notes (author)

- **Spec coverage:** monthly target (gym-wide, operator field) → Task 3; tier ladder → Task 1; event-driven banking → Task 5; data model → Task 2; push (target-hit/tier-up, tier-up supersedes) → Tasks 4 + 5; dashboard tier card + ring → Tasks 9/10; loader/API + service-client target read → Tasks 7/8; deep-links → Task 6. Session-report line **deliberately deferred** (noted up top).
- **Type consistency:** `tierForMonths`/`nextTier` return a TIERS entry (`{slug,name,months,color}`) or null — consumed by `buildTierUpPush({tier})`, `buildTierStatus`, and the engine's `newTier.slug` dedup. `buildTierStatus` returns `{monthsHit,tier,next,monthPoints,target,pct,remaining,monthsToNext,periodLabel}` — consumed verbatim by both TierCards. `loadTierStatus` returns `{ok, status}`; the API + web both read `.status`. Engine `monthsHit` from `count` feeds `buildTargetHitPush`/`buildTierUpPush`.
- **Idempotency:** banking via `member_monthly_targets` UNIQUE(contact_id, period_month); tier-up via `customer_engagement_nudges` (type `tier_up`, dedup=slug). One push per banking (tier-up supersedes target-hit).
- **No placeholders:** every code step has complete code. The two read-first tasks (Task 3 customer-agent route, Task 8/10 `api()`/`startOfMonth` import paths) name the exact file + the pattern to mirror, with the field/fetch code given — environment-specific import paths are the only thing to confirm by reading.
