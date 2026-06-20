# Challenges + Leaderboards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operator-created challenges (individual-ranked + collective-goal, 3 metrics) + an always-on gym leaderboard, surfaced in the member app AND on a public gym TV board (portrait + landscape, auto-rolling top-25), with date-driven notifications.

**Architecture:** One leaderboard engine — pure helpers byte-synced across repos; standings computed on read (no stored-standings table); a `challenges` table holds definitions. Member API in champ-app (own-rank view, service client), operator CRUD + public TV endpoint + daily cron in un1t-crm. Reuses the engagement loop, the live-TV public-route pattern, the race/event CRUD pattern, and `achievements.sessionMetric`.

**Tech Stack:** Next.js 16 / Supabase (un1t-crm), Expo/React Native + NativeWind (champ-app), Vitest, Expo push, Vercel cron.

**Spec:** `docs/superpowers/specs/2026-06-20-challenges-leaderboards-design.md`

**Two repos, two PRs.** un1t-crm: engine (pure + io), migration, operator CRUD + permission, public TV route + endpoint, cron. champ-app: byte-synced `shared/challenges.js`, `load-challenges.js`, member `/api/challenges`, Challenges screen (web + native), dashboard teaser, deep-link case.

**Branch setup (both repos; un1t-crm `main` has unrelated cookie-consent WIP — stage only named files, never `git add -A`):**
```bash
cd /Users/richardivers/code/un1t-crm && git checkout main && git pull origin main && git checkout -b engagement-challenges
cd /Users/richardivers/code/champ-app && git checkout main && git pull origin main && git checkout -b engagement-challenges
```

**A few tasks say "read file X, mirror its idiom"** (the public-endpoint auth/projection, the race-CRUD auth/validation, the permission registry, the native tab layout). Those name the exact reference file and provide the full new code; the read is only to match the surrounding convention.

---

## File Structure

**un1t-crm**
- `src/lib/challenges.js` — NEW, byte-synced pure: `metricValue`, `rankStandings`, `challengePhase`, `windowIso`, `shortName`.
- `src/lib/challenges-io.js` — NEW, IO: `computeStandings(db, …)`, `computeCollective(db, …)` (used by operator API, TV endpoint, cron).
- `src/lib/achievements.js` — add `z4plus_minutes` case to `sessionMetric` (defensive; `challenges.js` has its own `metricValue` but keep parity).
- `supabase/migrations/<next>_challenges.sql` — NEW `challenges` table + RLS.
- `src/app/api/challenges/route.js` + `src/app/api/challenges/[id]/route.js` — operator CRUD.
- `src/app/challenges/page.js` + `src/components/ChallengeForm.jsx` — operator UI; sidebar link.
- `shared/permissions.js` + `scripts/check-mobile-parity.mjs` — new `challenges` web-only permission.
- `src/app/tv/[locationId]/challenges/page.jsx` + `ChallengeTvClient.jsx` — public TV board.
- `src/app/api/public/challenges/[locationId]/route.js` — public standings endpoint.
- `src/app/api/cron/run-challenge-events/route.js` + `vercel.json` + heartbeat migration row.

**champ-app**
- `shared/challenges.js` — byte-synced pure helpers; `src/lib/challenges.js` re-export.
- `src/lib/load-challenges.js` — member IO (service client + own-rank).
- `src/app/api/challenges/route.js` — member `GET`.
- `src/app/challenges/page.jsx` (web) + `mobile/app/challenges.jsx` (native) + dashboard teaser in `src/app/page.jsx` + `mobile/app/(tabs)/index.jsx`.
- `mobile/app/_layout.jsx` — `challenge` deep-link case.

---

## Phase 1 — engine + table

### Task 1: pure `challenges.js` helpers (byte-synced) + tests

**Files:** Create `un1t-crm/src/lib/challenges.js` + `.test.js`; `champ-app/shared/challenges.js` + `.test.js` + `champ-app/src/lib/challenges.js` (re-export).

- [ ] **Step 1: failing test** `un1t-crm/src/lib/challenges.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { metricValue, rankStandings, challengePhase, windowIso, shortName } from './challenges.js'

const sess = (o) => ({ effort_points: 0, zones_seconds: {}, ...o })

describe('metricValue', () => {
  it('points = effort_points', () => { expect(metricValue(sess({ effort_points: 240 }), 'points')).toBe(240) })
  it('classes = 1 per session', () => { expect(metricValue(sess({}), 'classes')).toBe(1) })
  it('z4plus_minutes = (z4+z5)/60', () => {
    expect(metricValue(sess({ zones_seconds: { 4: 300, 5: 120 } }), 'z4plus_minutes')).toBe(7)
  })
  it('unknown metric → 0', () => { expect(metricValue(sess({ effort_points: 9 }), 'nope')).toBe(0) })
})

describe('rankStandings', () => {
  it('sorts desc and shares ranks on ties', () => {
    const r = rankStandings([
      { contactId: 'a', value: 100 }, { contactId: 'b', value: 300 },
      { contactId: 'c', value: 300 }, { contactId: 'd', value: 50 },
    ])
    expect(r.map((x) => [x.contactId, x.rank])).toEqual([['b', 1], ['c', 1], ['d', 4], ['a', undefined]].filter(Boolean) ? [['b',1],['c',1],['a',3],['d',4]] : [])
  })
})

describe('challengePhase', () => {
  const at = (iso) => new Date(iso).getTime()
  const ch = { starts_on: '2026-06-10', ends_on: '2026-06-20' }
  it('upcoming before start', () => { expect(challengePhase(ch, at('2026-06-09T12:00:00Z'))).toBe('upcoming') })
  it('active within window incl. end day', () => {
    expect(challengePhase(ch, at('2026-06-10T00:00:00Z'))).toBe('active')
    expect(challengePhase(ch, at('2026-06-20T23:00:00Z'))).toBe('active')
  })
  it('ended after end day', () => { expect(challengePhase(ch, at('2026-06-21T00:00:00Z'))).toBe('ended') })
})

describe('windowIso', () => {
  it('inclusive day range → [start 00:00Z, end+1 00:00Z)', () => {
    expect(windowIso({ starts_on: '2026-06-10', ends_on: '2026-06-20' }))
      .toEqual({ fromIso: '2026-06-10T00:00:00.000Z', toIso: '2026-06-21T00:00:00.000Z' })
  })
})

describe('shortName', () => {
  it('first name + last initial', () => { expect(shortName('Sarah Kelly')).toBe('Sarah K.') })
  it('single name → first only', () => { expect(shortName('Sarah')).toBe('Sarah') })
  it('empty → Member', () => { expect(shortName('')).toBe('Member') })
  it('multi-part → last-token initial', () => { expect(shortName('Mary Jane Watson')).toBe('Mary W.') })
})
```
(Fix the `rankStandings` assertion to the clean form below in step 3's test — written simply:)
```js
// replace the rankStandings test body with:
    const r = rankStandings([
      { contactId: 'a', value: 100 }, { contactId: 'b', value: 300 },
      { contactId: 'c', value: 300 }, { contactId: 'd', value: 50 },
    ])
    expect(r.map((x) => [x.contactId, x.rank])).toEqual([['b', 1], ['c', 1], ['a', 3], ['d', 4]])
```
- [ ] **Step 2: run → fail.** `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/challenges.test.js` → FAIL.
- [ ] **Step 3: implement** `un1t-crm/src/lib/challenges.js`:
```js
// Challenge leaderboard pure helpers. Byte-synced with champ-app/shared/challenges.js
// (only line 1 differs). No IO — standings DB reads live in challenges-io.js
// (un1t-crm) / load-challenges.js (champ-app).

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

/** Per-session contribution for a challenge metric. */
export function metricValue(session, metric) {
  const z = session?.zones_seconds || {}
  const sec = (n) => Number(z[n] ?? z[String(n)]) || 0
  if (metric === 'points') return Number(session?.effort_points) || 0
  if (metric === 'classes') return 1
  if (metric === 'z4plus_minutes') return (sec(4) + sec(5)) / 60
  return 0
}

/** Sort rows by value desc; ties share a rank (1,2,2,4…). Rows: {contactId, value, ...}. */
export function rankStandings(rows) {
  const sorted = [...(rows || [])].sort((a, b) => (b.value || 0) - (a.value || 0))
  let lastVal = null
  let lastRank = 0
  return sorted.map((row, i) => {
    const v = row.value || 0
    const rank = v === lastVal ? lastRank : i + 1
    lastVal = v
    lastRank = rank
    return { ...row, rank }
  })
}

function dayMsUtc(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/** 'upcoming' | 'active' | 'ended' from inclusive day window, UTC. */
export function challengePhase(challenge, nowMs = Date.now()) {
  const DAY = 24 * 3600 * 1000
  const start = dayMsUtc(challenge.starts_on)
  const endExclusive = dayMsUtc(challenge.ends_on) + DAY
  if (nowMs < start) return 'upcoming'
  if (nowMs < endExclusive) return 'active'
  return 'ended'
}

/** Inclusive day range → ISO window [start 00:00Z, (end+1) 00:00Z). */
export function windowIso(challenge) {
  const DAY = 24 * 3600 * 1000
  return {
    fromIso: new Date(dayMsUtc(challenge.starts_on)).toISOString(),
    toIso: new Date(dayMsUtc(challenge.ends_on) + DAY).toISOString(),
  }
}

/** Full contact name → "First L." privacy projection. `contacts` has a single
 * `name` column (NOT first_name/last_name) — this mirrors /api/public/live's split. */
export function shortName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'Member'
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0]
}

export { MONTH_NAMES }
```
- [ ] **Step 4: run → pass** (TZ sweep): `for tz in Europe/Dublin America/Los_Angeles; do TZ=$tz npx vitest run src/lib/challenges.test.js; done` → PASS both.
- [ ] **Step 5: sync champ-app.** Copy to `champ-app/shared/challenges.js`, line 1 → `// KEEP IN SYNC with un1t-crm/src/lib/challenges.js (verbatim copy below line 1).` Create `champ-app/src/lib/challenges.js` = `export * from '../../shared/challenges'`. Copy the test to `champ-app/shared/challenges.test.js`. Verify `cd /Users/richardivers/code/champ-app && npx vitest run shared/challenges.test.js` → PASS; `diff <(tail -n +2 …un1t-crm/src/lib/challenges.js) <(tail -n +2 …champ-app/shared/challenges.js)` → empty.
- [ ] **Step 6: commit (both repos + spec/plan docs on un1t-crm):**
```bash
cd /Users/richardivers/code/un1t-crm && git add src/lib/challenges.js src/lib/challenges.test.js docs/superpowers/specs/2026-06-20-challenges-leaderboards-design.md docs/superpowers/plans/2026-06-20-challenges-leaderboards.md && git commit -m "feat(challenges): pure leaderboard helpers + spec/plan"
cd /Users/richardivers/code/champ-app && git add shared/challenges.js shared/challenges.test.js src/lib/challenges.js && git commit -m "feat(challenges): pure leaderboard helpers (sync)"
```

### Task 2: migration `challenges`

**Files:** Create `un1t-crm/supabase/migrations/<next>_challenges.sql`.

- [ ] **Step 1: confirm number.** `ls supabase/migrations/ | sed -E 's/_.*//' | sort -n | tail -1` → next integer (expected `299`).
- [ ] **Step 2: write** `299_challenges.sql`:
```sql
-- 299: Challenges — operator-created leaderboard/collective competitions.
-- Standings are computed on read (no standings table). announced_* = cron idempotency.
CREATE TABLE IF NOT EXISTS public.challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  name text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('individual','collective')),
  metric text NOT NULL CHECK (metric IN ('points','classes','z4plus_minutes')),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  target integer,
  created_by uuid REFERENCES public.profiles(id),
  announced_start_at timestamptz,
  announced_end_at timestamptz,
  announced_target_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_challenges_location_ends ON public.challenges(location_id, ends_on);

ALTER TABLE public.challenges ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Staff manage challenges at their locations"
  ON public.challenges FOR ALL TO public
  USING ((SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id))
  WITH CHECK ((SELECT private.auth_is_master()) OR private.auth_is_in_location(location_id));

CREATE POLICY "Customers read active challenges at their location"
  ON public.challenges FOR SELECT TO public
  USING (
    ends_on >= (now() AT TIME ZONE 'utc')::date
    AND EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = (SELECT private.auth_contact_id()) AND c.location_id = challenges.location_id
    )
  );

COMMENT ON TABLE public.challenges IS 'Challenges (2026-06): operator leaderboard/collective competitions; standings computed on read.';
```
- [ ] **Step 3: apply** via Supabase MCP `apply_migration` (name `challenges`, project `iyvtbjjxdggiadzwwvdj`); run `get_advisors` security → confirm `challenges` not flagged (it has policies). Verify `select count(*) from challenges;` → 0.
- [ ] **Step 4: commit.** `git add supabase/migrations/299_challenges.sql && git commit -m "feat(db): challenges (mig 299)"`

### Task 3: standings IO `challenges-io.js` + `z4plus_minutes` + tests

**Files:** Create `un1t-crm/src/lib/challenges-io.js`; modify `src/lib/achievements.js`; test `src/lib/challenges-io.test.js`.

- [ ] **Step 1: add `z4plus_minutes`** to `achievements.js` `sessionMetric` switch (after `z3plus_minutes`): `case 'z4plus_minutes': return (z4 + z5) / 60`.
- [ ] **Step 2: failing test** `src/lib/challenges-io.test.js` — tests the pure aggregation seam by stubbing `db`. Implement `computeStandings`/`computeCollective` to take an injectable session-fetcher OR test via a fake supabase. Use a fake `db` with a chainable query returning fixed rows:
```js
import { describe, it, expect } from 'vitest'
import { computeStandings, computeCollective } from './challenges-io.js'

function fakeDb(rows) {
  const q = {
    select: () => q, eq: () => q, not: () => q, gte: () => q, lt: () => q,
    order: () => q, range: async () => ({ data: rows, error: null }),
  }
  return { from: () => q }
}
const rows = [
  { contact_id: 'a', effort_points: 300, zones_seconds: {}, contacts: { name: 'Sarah Kelly' } },
  { contact_id: 'a', effort_points: 200, zones_seconds: {}, contacts: { name: 'Sarah Kelly' } },
  { contact_id: 'b', effort_points: 450, zones_seconds: {}, contacts: { name: 'Mike Doyle' } },
]

describe('computeStandings', () => {
  it('aggregates points per contact, ranked, projected', async () => {
    const out = await computeStandings(fakeDb(rows), { locationId: 'L', metric: 'points', fromIso: 'x', toIso: 'y' })
    expect(out.map((r) => [r.name, r.value, r.rank])).toEqual([['Mike D.', 450, 1], ['Sarah K.', 500, 2]].sort((a,b)=>b[1]-a[1]) ? [['Sarah K.', 500, 1], ['Mike D.', 450, 2]] : [])
  })
})
describe('computeCollective', () => {
  it('sums all + pct', async () => {
    const out = await computeCollective(fakeDb(rows), { locationId: 'L', metric: 'points', fromIso: 'x', toIso: 'y', target: 1000 })
    expect(out).toEqual({ total: 950, target: 1000, pct: 0.95 })
  })
})
```
(Clean the `computeStandings` assertion to `expect(out.map((r) => [r.name, r.value, r.rank])).toEqual([['Sarah K.', 500, 1], ['Mike D.', 450, 2]])`.)
- [ ] **Step 3: run → fail.**
- [ ] **Step 4: implement** `src/lib/challenges-io.js`:
```js
// Standings IO for challenges (un1t-crm side: operator API, TV endpoint, cron).
// Paginated read of ended, contact-bound sessions in the window at the location;
// aggregates the pure metricValue per contact; ranks + projects names.
import { metricValue, rankStandings, shortName } from '@/lib/challenges'

const PAGE = 1000

async function loadWindowSessions(db, { locationId, fromIso, toIso }) {
  const out = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('heart_rate_sessions')
      .select('contact_id, effort_points, zones_seconds, contacts!heart_rate_sessions_contact_id_fkey(name)')
      .eq('location_id', locationId)
      .not('contact_id', 'is', null)
      .not('ended_at', 'is', null)
      .gte('started_at', fromIso)
      .lt('started_at', toIso)
      .order('contact_id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) break
    out.push(...(data || []))
    if (!data || data.length < PAGE) break
  }
  return out
}

export async function computeStandings(db, { locationId, metric, fromIso, toIso }) {
  const sessions = await loadWindowSessions(db, { locationId, fromIso, toIso })
  const byContact = new Map()
  for (const s of sessions) {
    const cur = byContact.get(s.contact_id) || { contactId: s.contact_id, value: 0, c: s.contacts }
    cur.value += metricValue(s, metric)
    byContact.set(s.contact_id, cur)
  }
  const rows = [...byContact.values()].map((r) => ({
    contactId: r.contactId,
    value: Math.round(r.value * 100) / 100,
    name: shortName(r.c?.name),
  }))
  return rankStandings(rows)
}

export async function computeCollective(db, { locationId, metric, fromIso, toIso, target }) {
  const sessions = await loadWindowSessions(db, { locationId, fromIso, toIso })
  const total = Math.round(sessions.reduce((a, s) => a + metricValue(s, metric), 0) * 100) / 100
  const tgt = Number(target) || 0
  return { total, target: tgt, pct: tgt > 0 ? Math.min(1, total / tgt) : 0 }
}
```
- [ ] **Step 5: run → pass.** `npx vitest run src/lib/challenges-io.test.js src/lib/achievements.test.js` → PASS.
- [ ] **Step 6: commit.** `git add src/lib/challenges-io.js src/lib/challenges-io.test.js src/lib/achievements.js && git commit -m "feat(challenges): standings IO (computeStandings/Collective) + z4plus_minutes"`

---

## Phase 2 — operator CRUD (un1t-crm)

### Task 4: `challenges` permission

**Files:** `shared/permissions.js`, `scripts/check-mobile-parity.mjs`.

- [ ] **Step 1: read** `shared/permissions.js` — find `WEB_PERMISSIONS` (array of `{ key, label, … }`) + `DEFAULT_WEB_PERMISSIONS_BY_ROLE`. Add a `challenges` entry mirroring an existing operator key (e.g. `automations`): add `{ key: 'challenges', label: 'Challenges' }` to `WEB_PERMISSIONS`, and `challenges: true` for `master`/`owner`/`manager`, `false` for `head_coach`/`staff` in `DEFAULT_WEB_PERMISSIONS_BY_ROLE` (match the shape of `automations`).
- [ ] **Step 2: read** `scripts/check-mobile-parity.mjs` — find `WEB_ONLY_OK` (a map of key→reason). Add `challenges: 'operator challenge admin; web/operator surface, no mobile counterpart'`.
- [ ] **Step 3: verify.** `cd /Users/richardivers/code/un1t-crm && npm run check:mobile-parity` → passes.
- [ ] **Step 4: commit.** `git add shared/permissions.js scripts/check-mobile-parity.mjs && git commit -m "feat(perms): challenges web-only permission"`

### Task 5: operator CRUD API

**Files:** Create `src/app/api/challenges/route.js` + `src/app/api/challenges/[id]/route.js`. **Read** `src/app/api/races/route.js` first to mirror its auth/validate/location-scope idiom.

- [ ] **Step 1: read** `src/app/api/races/route.js` (auth gate via `getCurrentUser` + `MANAGER_ROLES`, `validateBody` + Zod, `assertLocationAccess`, `createServerClient`, `{success,data}` response).
- [ ] **Step 2: implement** `src/app/api/challenges/route.js` mirroring that idiom:
  - `POST` (manager+, `assertLocationAccess(body.location_id)`): validate `{ location_id, name, mode∈[individual,collective], metric∈[points,classes,z4plus_minutes], starts_on (isoDate), ends_on (isoDate), target (int≥1, required iff mode='collective') }`; insert; return `{success, data}`.
  - `GET ?location_id=`: list challenges at the location (manager+), ordered `ends_on desc`.
  Use the shared schema helpers (`uuidLike`, `isoDate`, `MANAGER_ROLES`). Register in `src/lib/openapi.js` (mirror races).
- [ ] **Step 3: implement** `src/app/api/challenges/[id]/route.js`: `PUT` (manager+, location-scoped) — if `challengePhase(existing, Date.now()) !== 'upcoming'`, allow only `name` + `target`; else allow all fields. `DELETE` (manager+). 
- [ ] **Step 4: verify.** `npm run build && npm run check:route-guards` → both green (the `getCurrentUser`/MANAGER_ROLES guard is recognised).
- [ ] **Step 5: commit.** `git add src/app/api/challenges src/lib/openapi.js && git commit -m "feat(challenges): operator CRUD API"`

### Task 6: operator UI page + form + sidebar link

**Files:** Create `src/app/challenges/page.js` + `src/components/ChallengeForm.jsx`; modify `src/lib/nav-items.js`. **Read** `src/components/RaceEventForm.jsx` + `src/lib/nav-items.js` first.

- [ ] **Step 1: read** `RaceEventForm.jsx` (form layout, `inputCls`, the save `fetch` pattern, the role gate) + `src/lib/nav-items.js` (the entry shape is `{ href, label, icon, permission, section }` — e.g. the events entry uses `permission: 'races', section: 'gym'`; add a challenges entry `{ href: '/challenges', label: 'Challenges', icon: <pick a lucide icon e.g. Trophy>, permission: 'challenges', section: 'gym' }`).
- [ ] **Step 2: implement** `ChallengeForm.jsx` — fields: name, mode (select individual/collective), metric (select points/classes/z4plus_minutes), starts_on/ends_on (date inputs), target (number, shown only when mode='collective'); saves via `POST/PUT /api/challenges`; mirror `RaceEventForm`'s styling + save flow.
- [ ] **Step 3: implement** `src/app/challenges/page.js` — list active/upcoming/past challenges at the active location + a "New challenge" button opening `ChallengeForm`; manager-gated.
- [ ] **Step 4: add the sidebar link** ("Challenges", under the Gym/Studio group) gated by `hasPermission(user, 'challenges')`.
- [ ] **Step 5: verify.** `npx next lint && npm run build` → clean (use `<Link>` for the nav link).
- [ ] **Step 6: commit.** `git add src/app/challenges/page.js src/components/ChallengeForm.jsx <sidebar file> && git commit -m "feat(challenges): operator page + form + sidebar link"`

---

## Phase 3 — member API + app screen (champ-app)

### Task 7: member IO `load-challenges.js` + `GET /api/challenges`

**Files:** Create `champ-app/src/lib/load-challenges.js` + `src/app/api/challenges/route.js`. **Read** `src/lib/load-tier-status.js` + `src/app/api/tier-status/route.js` to mirror (service client + getUser→contact).

- [ ] **Step 1: implement** `src/lib/load-challenges.js` — `loadChallenges(supabase, { contactId, locationId, serviceSupabase, nowMs })`:
  - Read active+upcoming `challenges` at `locationId` (RLS `supabase`, `ends_on >= today`).
  - For each: `windowIso` + (individual → `computeStandings` / collective → `computeCollective`) using `serviceSupabase` (cross-member) + the byte-synced pure helpers. (Port the same `loadWindowSessions` aggregation here — champ-app can't import un1t-crm's `challenges-io.js`; reuse `metricValue`/`rankStandings`/`shortName` from `./challenges.js`.)
  - For individual: return top 10 + the member's own `{rank, value}` (find `contactId === contactId`).
  - Plus the gym board: `computeStandings` over the current UTC month, metric `points`, top 10 + own rank.
  Returns `{ ok, challenges: [...], gymBoard: {...} }`.
- [ ] **Step 2: implement** `src/app/api/challenges/route.js` — `GET` mirroring the tier-status route: `createServerClient` → getUser (401) → contact `{id, location_id}` → `loadChallenges(supabase, {contactId, locationId, serviceSupabase: createServiceClient()})` → return JSON.
- [ ] **Step 3: verify.** `cd /Users/richardivers/code/champ-app && npm run build` → succeeds.
- [ ] **Step 4: commit.** `git add src/lib/load-challenges.js src/app/api/challenges/route.js && git commit -m "feat(challenges): member loader + GET /api/challenges"`

### Task 8: member Challenges screen (web + native) + dashboard teaser + deep-link

**Files:** `champ-app/src/app/challenges/page.jsx` (web), `mobile/app/challenges.jsx` (native), teaser in `src/app/page.jsx` + `mobile/app/(tabs)/index.jsx`, `mobile/app/_layout.jsx`.

- [ ] **Step 1: web screen** `src/app/challenges/page.jsx` — server component: getUser→contact, call `loadChallenges` (service client), render each challenge (individual → leaderboard list with the member's row highlighted in ember + podium metals; collective → progress bar) + the gym board. Dark UN1T styling matching the approved mock.
- [ ] **Step 2: native screen** `mobile/app/challenges.jsx` — fetch `api('/api/challenges')`; render the same (NativeWind). Reached from the dashboard teaser (a pushed route, not a tab).
- [ ] **Step 3: dashboard teaser** — in web `src/app/page.jsx` + native `(tabs)/index.jsx`, add a `ChallengeTeaser` card (top active challenge: member's rank or collective %); links to `/challenges`. Hidden when none.
- [ ] **Step 4: deep-link** — `mobile/app/_layout.jsx` switch: add `case 'challenge': router.push('/challenges'); break`.
- [ ] **Step 5: verify.** `npm run build` (web) + `cd mobile && npx expo export --platform ios …` (resolves) + `npm test`.
- [ ] **Step 6: commit.** Stage the named files; `git commit -m "feat(challenges): member screen + dashboard teaser + deep-link"`.

---

## Phase 4 — public TV board (un1t-crm)

### Task 9: public standings endpoint

**Files:** Create `src/app/api/public/challenges/[locationId]/route.js`. **Read** `src/app/api/public/live/[locationId]/route.js` to mirror (no-auth public, projection, response shape, `export const dynamic`).

- [ ] **Step 1: implement** — public `GET` (capability = locationId, no auth — middleware allow-lists `/api/public/`): load active challenges at the location (`createServerClient` service role); for the primary active challenge (and/or all active), `computeStandings` (top 25) / `computeCollective`; if none active, the gym board (current-month points, top 25). Return `{ challenges: [{ id, name, mode, metric, endsOn, standings: top25 | null, collective: {...} | null }], gymBoard }`, all projected (first-name + last-initial; the IO already projects).
- [ ] **Step 2: verify.** `npm run build && npm run check:route-guards` (it'll be EXEMPT/public — add to the public allow-list/EXEMPT map with a reason if the checker requires, mirroring `/api/public/live`).
- [ ] **Step 3: commit.** `git add "src/app/api/public/challenges/[locationId]/route.js" <route-guard exempt file if touched> && git commit -m "feat(challenges): public TV standings endpoint"`

### Task 10: TV board route + rolling client

**Files:** Create `src/app/tv/[locationId]/challenges/page.jsx` + `ChallengeTvClient.jsx`. **Read** `src/app/tv/[locationId]/LiveTvClient.jsx` for the kiosk/poll pattern.

- [ ] **Step 1: page shell** `tv/[locationId]/challenges/page.jsx` — mirror the live `page.jsx`: `export const dynamic='force-dynamic'`; `<ChallengeTvClient locationId={params.locationId} />`.
- [ ] **Step 2: client** `ChallengeTvClient.jsx` (`'use client'`): poll `/api/public/challenges/${locationId}` every ~45s; **auto-page through the top 25** (page size 8 landscape / 12 portrait, ~2.6s/page, looping) with a page indicator; **CSS-orientation-responsive** (`@media (orientation: portrait)` taller list) + accept `?orientation=portrait|landscape` (read `useSearchParams`) to force; podium ranks 1–3 in tier metals (`#e8b931/#c2c8ce/#c77b3a`); collective challenge → big progress bar; black kiosk background like `LiveTvClient`. Extract the paging math into a pure `pageSlice(items, pageIndex, size)` helper + a quick unit test.
- [ ] **Step 3: verify.** `npm run build` → succeeds.
- [ ] **Step 4: commit.** `git add "src/app/tv/[locationId]/challenges" && git commit -m "feat(challenges): rolling TV board (portrait + landscape)"`

---

## Phase 5 — notifications cron (un1t-crm)

### Task 11: `run-challenge-events` cron + heartbeat + schedule

**Files:** Create `src/app/api/cron/run-challenge-events/route.js`; migration for the heartbeat row; `vercel.json`. **Read** `src/app/api/cron/notify-streak-at-risk/route.js` to mirror (CRON_SECRET, maxDuration, stampHeartbeat, `{ok}` shape, push fan-out).

- [ ] **Step 1: heartbeat migration** `<next>_challenge_events_heartbeat.sql`: `INSERT INTO public.cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) VALUES ('run-challenge-events', 86400, 7200, 'Daily — challenge start/end/target announcements.') ON CONFLICT (name) DO NOTHING;` Apply via MCP.
- [ ] **Step 2: implement** the cron (daily): mirror the streak cron's auth + heartbeat. Three passes (each best-effort, idempotent):
  - **Start:** `challenges` where `starts_on = today` AND `announced_start_at IS NULL` → push `{title:'New challenge: '+name, body:'You're in — see the leaderboard.', data:{type:'challenge'}}` to app-linked members at the location (`champ_push_tokens` joined to contacts at location) → stamp `announced_start_at`.
  - **End:** `ends_on < today` AND `announced_end_at IS NULL` → compute final standings (`computeStandings`/`computeCollective` via `challenges-io.js`); individual → push winner + (best-effort) per-member finish; collective → "We hit {target}!" or "We reached {pct}%" → stamp `announced_end_at`.
  - **Collective target:** active collective where `computeCollective.total >= target` AND `announced_target_at IS NULL` → celebrate → stamp `announced_target_at`.
  Use `sendCustomerPush`; pure copy builders (`buildChallengeStartPush` etc.) in a small `challenge-notifications.js` with unit tests, mirroring `customer-notifications.js`.
- [ ] **Step 3: schedule** — add `{ "path": "/api/cron/run-challenge-events", "schedule": "0 8 * * *" }` to `vercel.json` (validate JSON).
- [ ] **Step 4: verify.** `npm test && npm run build && npm run check:route-guards` → green.
- [ ] **Step 5: commit.** `git add src/app/api/cron/run-challenge-events supabase/migrations/<n>_*.sql vercel.json src/lib/challenge-notifications.js src/lib/challenge-notifications.test.js && git commit -m "feat(challenges): daily start/end/target notification cron"`

---

## Final verification (before PRs)
- [ ] un1t-crm: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run build` (ignore the stale `.claude/worktrees` lint noise — confirm no NEW errors in src/).
- [ ] champ-app: `npm test && npm run build && (cd mobile && npx expo export --platform ios --output-dir /tmp/x && rm -rf /tmp/x)`.
- [ ] Open two PRs (`base=main`), cross-linked, citing mig 299 + the heartbeat mig.
- [ ] Post-merge smoke: create a challenge (operator), point the gym TV at `/tv/<loc>/challenges` (try `?orientation=portrait`), confirm the board rolls; end a session in-window → appears on standings; the start push fires next cron tick.

## Self-review notes (author)
- **Spec coverage:** engine §6 → Tasks 1/3; table §5 → Task 2; operator CRUD §7 → Tasks 4/5/6; member API+screen §8 → Tasks 7/8; gym board §9 → Tasks 7/8 (engine reuse); TV board §10 → Tasks 9/10; cron §11 → Task 11; privacy §12 → projection in Task 3 (`shortName`) used everywhere.
- **Type consistency:** `metricValue(session, metric)`, `rankStandings(rows)→{...,rank}`, `challengePhase`, `windowIso→{fromIso,toIso}`, `shortName` defined in Task 1, consumed by Tasks 3/7/9/10/11. `computeStandings→[{contactId,value,name,rank}]` / `computeCollective→{total,target,pct}` consumed by 5/9/11 (un1t) and re-implemented over the same pure helpers in champ-app Task 7.
- **No placeholders:** pure engine + migration + IO have full code; the route/UI/cron tasks name the exact reference file to mirror and specify fields/shape/copy — the read is only to match the house auth/validation/styling idiom (same approach that executed cleanly for the tiers operator-field task).
- **Two test-assertion cleanups** are flagged inline in Task 1 + Task 3 (write the simple `toEqual` form, not the messy ternary).
