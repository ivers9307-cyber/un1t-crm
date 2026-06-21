# Win-back nudge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** A daily cron that pushes a win-back nudge to app-linked members whose HR-class attendance has dropped below their personal baseline.

**Architecture:** Sibling of `notify-streak-at-risk` — pure detector + builder in the byte-synced `customer-notifications.js`, a `notify-winback` cron mirroring streak-at-risk, idempotent via `customer_engagement_nudges` (`type:'winback'`, monthly dedup). Spec: `docs/superpowers/specs/2026-06-21-winback-nudge-design.md`.

**Branch:** `engagement-winback` (un1t-crm, created). Do NOT stage the cookie-consent WIP. champ-app branch created at Task 4.

---

### Task 1: Detector + push builder + tests (un1t-crm)

**Files:** Modify `src/lib/customer-notifications.js` + `src/lib/customer-notifications.test.js`.

- [ ] **Write tests first** (append to `customer-notifications.test.js`), then run to fail:
```js
import { attendanceDrop, buildWinbackPush } from './customer-notifications.js'
const DAY = 24*3600*1000
const now = Date.parse('2026-06-21T12:00:00Z')
const sAt = (daysAgo) => ({ started_at: new Date(now - daysAgo*DAY).toISOString() })

describe('attendanceDrop', () => {
  it('fires when a regular halves their rate but is still current', () => {
    // baseline ~2/wk over weeks 3-12 (≈20 sessions days 15-83), recent ~0 but 1 session 10d ago (still current)
    const base = []; for (let d = 15; d <= 83; d += 3.5) base.push(sAt(d))
    const sessions = [...base, sAt(10)]
    expect(attendanceDrop(sessions, now).dropping).toBe(true)
  })
  it('does NOT fire when attendance is steady', () => {
    const all = []; for (let d = 1; d <= 83; d += 3.5) all.push(sAt(d)) // ~2/wk throughout
    expect(attendanceDrop(all, now).dropping).toBe(false)
  })
  it('does NOT fire for a non-regular (baseline below threshold)', () => {
    expect(attendanceDrop([sAt(20), sAt(40), sAt(10)], now).dropping).toBe(false) // ~0.2/wk baseline
  })
  it('does NOT fire when long-gone (no session within stillCurrentDays)', () => {
    const base = []; for (let d = 15; d <= 83; d += 3) base.push(sAt(d)) // strong baseline, nothing recent
    expect(attendanceDrop(base, now).dropping).toBe(false) // last session > 42d ago
  })
  it('empty + future-dated sessions are safe', () => {
    expect(attendanceDrop([], now).dropping).toBe(false)
    expect(attendanceDrop([{ started_at: new Date(now + DAY).toISOString() }], now).dropping).toBe(false)
  })
})

describe('buildWinbackPush', () => {
  it('returns the winback push shape', () => {
    const p = buildWinbackPush()
    expect(p.data.type).toBe('winback')
    expect(p.title).toBeTruthy(); expect(p.body).toBeTruthy()
  })
})
```
Run `npx vitest run src/lib/customer-notifications.test.js` → new tests fail.

- [ ] **Implement** (append to `customer-notifications.js`, matching its style):
```js
// Personalized HR-attendance drop detector for win-back nudges.
// baseline window [now-baselineDays, now-recentDays); recent window [now-recentDays, now).
export function attendanceDrop(sessions, nowMs = Date.now(), {
  baselineDays = 84, recentDays = 14, minBaselinePerWeek = 1.0,
  dropFraction = 0.5, stillCurrentDays = 42,
} = {}) {
  const DAY = 24 * 3600 * 1000
  const recentStart = nowMs - recentDays * DAY
  const baselineStart = nowMs - baselineDays * DAY
  let recentCount = 0, baselineCount = 0, lastMs = 0
  for (const s of sessions || []) {
    const t = Date.parse(s?.started_at)
    if (!Number.isFinite(t) || t >= nowMs) continue
    if (t > lastMs) lastMs = t
    if (t >= recentStart) recentCount++
    else if (t >= baselineStart) baselineCount++
  }
  const baselineRate = baselineCount / ((baselineDays - recentDays) / 7)
  const recentRate = recentCount / (recentDays / 7)
  const dropping =
    baselineRate >= minBaselinePerWeek &&
    recentRate <= dropFraction * baselineRate &&
    lastMs >= nowMs - stillCurrentDays * DAY
  return {
    dropping,
    baselineRate: Math.round(baselineRate * 100) / 100,
    recentRate: Math.round(recentRate * 100) / 100,
  }
}

export function buildWinbackPush() {
  return { title: "We've missed you 👋", body: 'Fancy getting back in this week?', data: { type: 'winback' } }
}
```
Run tests → pass. Commit `src/lib/customer-notifications.js` + test only.

### Task 2: Migration — nudge CHECK + heartbeat

**Files:** Create `supabase/migrations/<NNN>_winback_nudge.sql` (next number after the latest in `supabase/migrations/`).

- [ ] Write:
```sql
-- NNN: win-back nudge — allow type='winback' in the engagement-nudge log + cron heartbeat.
ALTER TABLE public.customer_engagement_nudges DROP CONSTRAINT IF EXISTS customer_engagement_nudges_type_check;
ALTER TABLE public.customer_engagement_nudges ADD CONSTRAINT customer_engagement_nudges_type_check
  CHECK (type IN ('streak_at_risk','goal_complete','tier_up','reaction','winback'));
INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes)
VALUES ('notify-winback', 86400, 7200, 'Daily 10:00 UTC — win-back push to members with declining HR attendance.')
ON CONFLICT (name) DO NOTHING;
```
- [ ] Commit the migration file. (Controller applies via Supabase MCP + runs advisors.)

### Task 3: `notify-winback` cron + vercel.json

**Files:** Create `src/app/api/cron/notify-winback/route.js`; modify `vercel.json`.

- [ ] Create the cron — **mirror `src/app/api/cron/notify-streak-at-risk/route.js` exactly**, with these differences:
  - imports `attendanceDrop, buildWinbackPush` (not streakAtRisk/buildStreakAtRiskPush).
  - `const dedupKey = new Date(todayMs).toISOString().slice(0, 7)` → `YYYY-MM` (monthly).
  - **Candidates** = contacts with ≥1 ended session in the last 84 days: paginate `heart_rate_sessions` `.select('contact_id').not('contact_id','is',null).not('ended_at','is',null).gte('started_at', new Date(todayMs - 84*DAY).toISOString()).order('contact_id')`.
  - **Per-candidate sessions:** load their ended sessions over the last 84 days (batched `.in('contact_id', chunk)` of 200), group `{ started_at }` by contact.
  - **Detect:** `const { dropping } = attendanceDrop(byContact.get(cid) || [], nowMs)` → collect dropping cids.
  - Reachable filter (`champ_push_tokens`) — same as streak.
  - Idempotent insert `{ contact_id: cid, type: 'winback', dedup_key: dedupKey }` → on success `sendCustomerPush(db, cid, buildWinbackPush())`, best-effort. Log + heartbeat `'notify-winback'`. `maxDuration=300`, CRON_SECRET gate, `POST→GET`.
- [ ] Add to `vercel.json` crons: `{ "path": "/api/cron/notify-winback", "schedule": "0 10 * * *" }`.
- [ ] Verify `grep -L stampHeartbeat src/app/api/cron/notify-winback/route.js` returns nothing (heartbeat present). Commit both files.

### Task 4: champ-app byte-sync + deep-link

**Files (champ-app):** `git checkout -b engagement-winback` off main. Update `champ-app/shared/customer-notifications.js` (byte-synced copy — add `attendanceDrop` + `buildWinbackPush`, identical to un1t-crm below line 1); confirm `champ-app/src/lib/customer-notifications.js` re-export covers them. Add `case 'winback':` → home in `champ-app/mobile/app/_layout.jsx` (mirror an existing case like `streak_at_risk`).

- [ ] Byte-sync: `diff <(tail -n +2 un1t-crm/src/lib/customer-notifications.js) <(tail -n +2 champ-app/shared/customer-notifications.js)` → empty.
- [ ] champ-app: `npm test` (builders picked up), `npm run lint`, `npm run build`, `cd mobile && npx expo export --platform ios`. Commit.

---

## Final verification
- un1t-crm: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run build` (the new cron route is CRON_SECRET-guarded → route-guards passes).
- Controller applies the migration + advisors; champ-app OTA after merge.
- finishing-a-development-branch → 2 PRs (base=main), stop before merge.

## Self-review
- Spec coverage: detector (T1), push (T1), mig+heartbeat (T2), cron+vercel (T3), byte-sync+deep-link (T4). ✓
- Type consistency: `attendanceDrop`→`{dropping,baselineRate,recentRate}`, `dedup_key` YYYY-MM, `type:'winback'`, `data.type:'winback'` consistent across tasks. ✓
- No placeholders: detector + builder + mig SQL + cron diffs are concrete. ✓
