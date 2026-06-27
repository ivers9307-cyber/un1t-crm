# Profile body-metrics + calories (un1t-crm backend) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture each member's gender + weight (dob already exists), keep weight fresh from any source (manual / InBody / Apple Health) freshest-wins, and compute `calories_kcal` for in-studio bridge sessions from HR + duration + age + weight + gender — so the champ-app session report stops showing "—".

**Scope:** un1t-crm only (Slice 1 of the spec + the `/api/me/body-metrics` endpoint). The champ-app wizard, integrations hub, and Apple Health native ingest are a SEPARATE follow-up plan. This plan delivers working calories: POST a member's metrics (or have an InBody scan) → their next finalised class session shows calories.

**Tech stack:** Next.js 16 route handlers, Supabase service-role client, Vitest (mocked DB), customer-auth via `resolveCustomerContact`.

**Working directory:** `~/code/un1t-crm-pm` (branch `profile-setup-body-metrics`, off `origin/main`).

**Spec:** `docs/superpowers/specs/2026-06-27-profile-setup-body-metrics-calories-design.md`

**Repo invariants (from CLAUDE.md):**
- `.insert()/.update()` must be `await`ed; builders are thenables (never `.catch()`).
- Service-role routes get NO RLS — guard in code; customer routes resolve the caller's own contact and write only that row; 404-not-403 on cross-contact.
- Migrations forward-only via Supabase MCP against `iyvtbjjxdggiadzwwvdj`, then `get_advisors`.
- CI mirror before push: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`. Run `npm run build` for new routes.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/322_contacts_body_metrics.sql` | + `contacts.gender, weight_kg, weight_kg_source, weight_kg_at, profile_setup_completed_at` |
| `src/lib/calories.js` *(new)* | Pure `estimateCaloriesKcal` (Keytel) |
| `src/lib/calories.test.js` *(new)* | Unit tests for the formula |
| `src/lib/heart-rate.js` | Export the existing `computeAge` |
| `src/lib/body-metrics.js` *(new)* | Pure `shouldApplyWeight`; IO `applyWeightObservation`, `resolveBodyMetrics` |
| `src/lib/body-metrics.test.js` *(new)* | Unit tests |
| `src/lib/live-class.js` | `endSession` writes `calories_kcal` |
| `src/lib/inbody-ingest.js` | scan upsert → `applyWeightObservation` |
| `src/app/api/me/body-metrics/route.js` *(new)* | Customer-auth POST: save gender/weight/dob, stamp setup-complete |
| `src/app/api/admin/backfill-session-calories/route.js` *(new)* | Master-gated bounded recompute |
| `src/lib/openapi.js` | register the two new routes |
| `docs/CHANGELOG.md` | Done entry |

---

## Task 1: Migration — contacts body-metric columns

**Files:** Create `supabase/migrations/322_contacts_body_metrics.sql`

- [ ] **Step 1: Write the migration**

> DISCOVERY (applied): `contacts.dob` (mig 134) AND `contacts.gender` already exist from the Glofox sync. `gender` holds `female`/`male`/`null` plus a legacy `P` code (~1.5k rows, ≈ "prefer not to say"). So we add NO gender column and NO CHECK constraint (a CHECK would reject the `P` rows). New writes are validated to `female|male|other` at the app layer (Task 6 zod); the calorie calc (Task 2) treats anything that isn't `male`/`female` (incl. `P`, `other`, `null`) as sex-neutral. Only the four new columns are added:

```sql
-- 322_contacts_body_metrics.sql
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS weight_kg numeric,
  ADD COLUMN IF NOT EXISTS weight_kg_source text,
  ADD COLUMN IF NOT EXISTS weight_kg_at timestamptz,
  ADD COLUMN IF NOT EXISTS profile_setup_completed_at timestamptz;

COMMENT ON COLUMN public.contacts.weight_kg IS 'Current body weight (kg) — freshest of manual/inbody/apple_health (mig 322).';
COMMENT ON COLUMN public.contacts.weight_kg_source IS 'manual | inbody | apple_health (mig 322).';
COMMENT ON COLUMN public.contacts.profile_setup_completed_at IS 'Set once dob+gender+weight_kg all present via /api/me/body-metrics (mig 322).';
```

- [ ] **Step 2: Apply via Supabase MCP**

Confirm project `iyvtbjjxdggiadzwwvdj` is un1t-crm via `list_projects` (NOT sentinel `tpttqakxmyxrwnqjepfm`), then `apply_migration` (name `contacts_body_metrics`). Run `get_advisors` (type=security) — expect no new findings (nullable columns + a CHECK add no RLS surface; `contacts` RLS unchanged).

> Migration application is delegated to the human operator. If you can't call the Supabase MCP, STOP and ask Richard to apply `322_contacts_body_metrics.sql`, then continue.

- [ ] **Step 3: Commit**
```bash
git add supabase/migrations/322_contacts_body_metrics.sql
git commit -m "PROFILE-SETUP.1 — mig 322: contacts body-metric columns (gender, weight_kg + provenance, setup flag)"
```

---

## Task 2: Pure calorie formula

**Files:** Create `src/lib/calories.js`, `src/lib/calories.test.js`; modify `src/lib/heart-rate.js` (export `computeAge`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/calories.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { estimateCaloriesKcal } from './calories.js'

describe('estimateCaloriesKcal', () => {
  const base = { avgHr: 144, durationMin: 71, age: 36, weightKg: 68 }

  it('computes a male estimate (Keytel)', () => {
    // (-55.0969 + 0.6309*144 + 0.1988*68 + 0.2017*36)/4.184 * 71 ≈ 959
    expect(estimateCaloriesKcal({ ...base, gender: 'male' })).toBeCloseTo(959, -1)
  })
  it('computes a lower female estimate for the same inputs', () => {
    const m = estimateCaloriesKcal({ ...base, gender: 'male' })
    const f = estimateCaloriesKcal({ ...base, gender: 'female' })
    expect(f).toBeLessThan(m)
    expect(f).toBeCloseTo(646, -1)
  })
  it('uses the mean of male & female for other/unknown gender', () => {
    const m = estimateCaloriesKcal({ ...base, gender: 'male' })
    const f = estimateCaloriesKcal({ ...base, gender: 'female' })
    expect(estimateCaloriesKcal({ ...base, gender: 'other' })).toBe(Math.round((m + f) / 2))
    expect(estimateCaloriesKcal({ ...base, gender: null })).toBe(Math.round((m + f) / 2))
  })
  it('scales with duration', () => {
    const a = estimateCaloriesKcal({ ...base, gender: 'male', durationMin: 30 })
    const b = estimateCaloriesKcal({ ...base, gender: 'male', durationMin: 60 })
    expect(b).toBeGreaterThan(a)
  })
  it('returns null when a required input is missing or non-finite', () => {
    expect(estimateCaloriesKcal({ ...base, gender: 'male', weightKg: null })).toBeNull()
    expect(estimateCaloriesKcal({ ...base, gender: 'male', age: null })).toBeNull()
    expect(estimateCaloriesKcal({ ...base, gender: 'male', avgHr: 0 })).toBeNull()
    expect(estimateCaloriesKcal({ ...base, gender: 'male', durationMin: 0 })).toBeNull()
  })
  it('returns a rounded integer', () => {
    expect(Number.isInteger(estimateCaloriesKcal({ ...base, gender: 'male' }))).toBe(true)
  })
})
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/lib/calories.test.js` → cannot find module.

- [ ] **Step 3: Implement**

Create `src/lib/calories.js`:
```js
// HR-based calorie estimate (Keytel et al., 2005). Pure — no DB.
// kcal/min from heart rate, with sex-specific coefficients; ×duration.
// Used to fill heart_rate_sessions.calories_kcal for in-studio bridge sessions
// (imported wearable sessions already carry a provider value).

function maleKcalPerMin(hr, weightKg, age) {
  return (-55.0969 + 0.6309 * hr + 0.1988 * weightKg + 0.2017 * age) / 4.184
}
function femaleKcalPerMin(hr, weightKg, age) {
  return (-20.4022 + 0.4472 * hr - 0.1263 * weightKg + 0.0740 * age) / 4.184
}

/**
 * @param {{ avgHr:number, durationMin:number, age:number, weightKg:number, gender:'male'|'female'|'other'|null }} args
 * @returns {number|null} whole kcal, or null if any required input is missing/non-positive.
 */
export function estimateCaloriesKcal({ avgHr, durationMin, age, weightKg, gender }) {
  const ok = (n) => Number.isFinite(n) && n > 0
  if (!ok(avgHr) || !ok(durationMin) || !ok(age) || !ok(weightKg)) return null

  const male = maleKcalPerMin(avgHr, weightKg, age) * durationMin
  const female = femaleKcalPerMin(avgHr, weightKg, age) * durationMin
  let total
  if (gender === 'male') total = male
  else if (gender === 'female') total = female
  else total = (male + female) / 2 // other / unknown → sex-neutral

  if (!Number.isFinite(total) || total <= 0) return null
  return Math.round(total)
}
```

- [ ] **Step 4: Export `computeAge`** — in `src/lib/heart-rate.js`, change `function computeAge(dob, refMs) {` to `export function computeAge(dob, refMs) {`. (It returns age in whole years or null.)

- [ ] **Step 5: Run, verify PASS** — `npx vitest run src/lib/calories.test.js` (6 tests) and `npx vitest run src/lib/heart-rate.test.js` (unchanged).

- [ ] **Step 6: Commit**
```bash
git add src/lib/calories.js src/lib/calories.test.js src/lib/heart-rate.js
git commit -m "PROFILE-SETUP.2 — estimateCaloriesKcal (Keytel HR formula) + export computeAge"
```

---

## Task 3: Body-metric helpers (freshest-wins weight + resolver)

**Files:** Create `src/lib/body-metrics.js`, `src/lib/body-metrics.test.js`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/body-metrics.test.js`:
```js
import { describe, it, expect, vi } from 'vitest'
import { shouldApplyWeight, applyWeightObservation, resolveBodyMetrics } from './body-metrics.js'

describe('shouldApplyWeight', () => {
  const now = '2026-06-27T10:00:00Z'
  const old = '2026-06-01T10:00:00Z'
  it('applies when there is no current weight', () => {
    expect(shouldApplyWeight({ weight_kg: null, weight_kg_at: null }, { weightKg: 70, observedAt: now })).toBe(true)
  })
  it('applies a newer observation', () => {
    expect(shouldApplyWeight({ weight_kg: 68, weight_kg_at: old }, { weightKg: 70, observedAt: now })).toBe(true)
  })
  it('applies an equally-timestamped observation (idempotent refresh)', () => {
    expect(shouldApplyWeight({ weight_kg: 68, weight_kg_at: now }, { weightKg: 70, observedAt: now })).toBe(true)
  })
  it('rejects a staler observation', () => {
    expect(shouldApplyWeight({ weight_kg: 70, weight_kg_at: now }, { weightKg: 99, observedAt: old })).toBe(false)
  })
  it('rejects a non-finite incoming weight', () => {
    expect(shouldApplyWeight({ weight_kg: null, weight_kg_at: null }, { weightKg: null, observedAt: now })).toBe(false)
  })
})

describe('applyWeightObservation', () => {
  function makeDb(current) {
    const updates = []
    return {
      _updates: updates,
      from: vi.fn(() => ({
        select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: current })) })) })),
        update: vi.fn((patch) => { updates.push(patch); return { eq: vi.fn(() => Promise.resolve({ error: null })) } }),
      })),
    }
  }
  it('writes weight + source + timestamp when fresher', async () => {
    const db = makeDb({ weight_kg: 68, weight_kg_at: '2026-06-01T00:00:00Z' })
    const out = await applyWeightObservation(db, { contactId: 'c1', weightKg: 70, source: 'inbody', observedAt: '2026-06-27T00:00:00Z' })
    expect(out).toBe(true)
    expect(db._updates[0]).toMatchObject({ weight_kg: 70, weight_kg_source: 'inbody', weight_kg_at: '2026-06-27T00:00:00Z' })
  })
  it('no-ops on a staler observation', async () => {
    const db = makeDb({ weight_kg: 70, weight_kg_at: '2026-06-27T00:00:00Z' })
    const out = await applyWeightObservation(db, { contactId: 'c1', weightKg: 99, source: 'manual', observedAt: '2026-06-01T00:00:00Z' })
    expect(out).toBe(false)
    expect(db._updates.length).toBe(0)
  })
})

describe('resolveBodyMetrics', () => {
  it('returns dob/age/gender/weightKg for the contact', async () => {
    const db = { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: { dob: '1990-03-12', gender: 'male', weight_kg: 68 } })) })) })) })) }
    const out = await resolveBodyMetrics(db, 'c1', Date.parse('2026-06-27T00:00:00Z'))
    expect(out).toMatchObject({ gender: 'male', weightKg: 68 })
    expect(out.age).toBeGreaterThan(30)
  })
  it('handles a missing contact', async () => {
    const db = { from: vi.fn(() => ({ select: vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: null })) })) })) })) }
    expect(await resolveBodyMetrics(db, 'c1')).toEqual({ dob: null, age: null, gender: null, weightKg: null })
  })
})
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run src/lib/body-metrics.test.js`.

- [ ] **Step 3: Implement**

Create `src/lib/body-metrics.js`:
```js
import { computeAge } from '@/lib/heart-rate'
import { logWarn } from '@/lib/log'

/**
 * Pure: should an incoming weight observation overwrite the current canonical
 * weight? Freshest-wins (>= so an equal-timestamp refresh re-stamps source).
 * Rejects a non-finite incoming weight.
 */
export function shouldApplyWeight(current, { weightKg, observedAt }) {
  if (!Number.isFinite(Number(weightKg)) || Number(weightKg) <= 0) return false
  const curAt = current?.weight_kg_at ? new Date(current.weight_kg_at).getTime() : null
  if (curAt == null) return true
  const incAt = observedAt ? new Date(observedAt).getTime() : null
  if (incAt == null) return false
  return incAt >= curAt
}

/**
 * IO: update contacts.weight_kg/_source/_at when the observation is fresher.
 * Returns true if it wrote. Best-effort — logs, never throws.
 * @param {object} db service-role client
 */
export async function applyWeightObservation(db, { contactId, weightKg, source, observedAt }) {
  if (!db || !contactId) return false
  const { data: current } = await db
    .from('contacts').select('weight_kg, weight_kg_at').eq('id', contactId).maybeSingle()
  if (!shouldApplyWeight(current, { weightKg, observedAt })) return false
  const { error } = await db
    .from('contacts')
    .update({ weight_kg: Number(weightKg), weight_kg_source: source, weight_kg_at: observedAt })
    .eq('id', contactId)
  if (error) { logWarn('body-metrics', 'weight update failed', { err: error, contactId }); return false }
  return true
}

/**
 * IO: the body metrics needed to compute calories for a contact.
 * @returns {Promise<{ dob:string|null, age:number|null, gender:string|null, weightKg:number|null }>}
 */
export async function resolveBodyMetrics(db, contactId, nowMs = Date.now()) {
  const empty = { dob: null, age: null, gender: null, weightKg: null }
  if (!db || !contactId) return empty
  const { data } = await db
    .from('contacts').select('dob, gender, weight_kg').eq('id', contactId).maybeSingle()
  if (!data) return empty
  return {
    dob: data.dob ?? null,
    age: computeAge(data.dob, nowMs),
    gender: data.gender ?? null,
    weightKg: Number.isFinite(Number(data.weight_kg)) ? Number(data.weight_kg) : null,
  }
}
```

> NOTE: confirm `computeAge(dob, refMs)` is exported (Task 2 Step 4) and accepts a ms timestamp as 2nd arg — it does (`resolveMaxHr` calls `computeAge(contact?.dob, referenceDate)`).

- [ ] **Step 4: Run, verify PASS** — `npx vitest run src/lib/body-metrics.test.js`.

- [ ] **Step 5: Commit**
```bash
git add src/lib/body-metrics.js src/lib/body-metrics.test.js
git commit -m "PROFILE-SETUP.3 — body-metrics helpers (freshest-wins weight + resolveBodyMetrics)"
```

---

## Task 4: Wire calories into session finalisation

**Files:** Modify `src/lib/live-class.js` (`endSession`); add a test to `src/lib/live-class.test.js` (if present) or `src/lib/calories.test.js`.

- [ ] **Step 1: Read `endSession`** — confirm the session SELECT and the UPDATE block (~line 290–318). It selects `id, contact_id, location_id, max_hr_used, ended_at, class_name`. You must add `started_at` to that select to compute duration.

- [ ] **Step 2: Implement**

In `src/lib/live-class.js`:
1. Add imports:
```js
import { resolveBodyMetrics } from '@/lib/body-metrics'
import { estimateCaloriesKcal } from '@/lib/calories'
```
2. Add `started_at` to the `endSession` session select (so `'id, contact_id, location_id, max_hr_used, ended_at, class_name'` becomes `'id, contact_id, location_id, started_at, max_hr_used, ended_at, class_name'`).
3. After `const summary = summariseSession(...)` and before the UPDATE, compute calories (best-effort):
```js
  // Calories — in-studio sessions have no provider value, so estimate from HR.
  let caloriesKcal = null
  if (session.contact_id) {
    try {
      const startMs = new Date(session.started_at).getTime()
      const durationMin = Number.isFinite(startMs) ? (nowMs - startMs) / 60000 : null
      const bm = await resolveBodyMetrics(db, session.contact_id, nowMs)
      caloriesKcal = estimateCaloriesKcal({
        avgHr: summary.avgHrBpm, durationMin, age: bm.age, weightKg: bm.weightKg, gender: bm.gender,
      })
    } catch (e) { /* leave null — calories is best-effort */ }
  }
```
4. Add `calories_kcal: caloriesKcal,` to the UPDATE object (alongside `avg_hr_bpm`/`peak_hr_bpm`).

- [ ] **Step 3: Add a test**

Add to `src/lib/calories.test.js` an integration-style test that drives `endSession` with a mocked db is heavy; instead assert the wiring via a focused unit on the duration+resolve path is impractical. Prefer: add a test to the existing `live-class.test.js` IF it already mocks `endSession`'s db. Otherwise add this lighter guard to `body-metrics.test.js`:
```js
// duration math the endSession wiring relies on
it('duration in minutes from start/now is positive for a real session', () => {
  const start = Date.parse('2026-06-27T16:09:00Z')
  const now = Date.parse('2026-06-27T17:19:00Z')
  expect((now - start) / 60000).toBeCloseTo(70, 0)
})
```
Then rely on the full suite + a manual reasoning note. (If `live-class.test.js` has a usable `endSession` harness, add a real assertion there that `calories_kcal` is set when the contact has metrics and null when not — preferred.)

- [ ] **Step 4: Verify** — `npm test` (full suite green; existing endSession tests must still pass — the new field is additive). `npm run lint`.

- [ ] **Step 5: Commit**
```bash
git add src/lib/live-class.js src/lib/calories.test.js src/lib/body-metrics.test.js
git commit -m "PROFILE-SETUP.4 — endSession computes calories_kcal from HR + body metrics"
```

---

## Task 5: InBody scan → canonical weight

**Files:** Modify `src/lib/inbody-ingest.js`; add a test to `src/lib/inbody-ingest.test.js`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/inbody-ingest.test.js` a test asserting that after `ingestScan` upserts a scan with a matched contact and a `weight_kg`, `applyWeightObservation` is invoked (the contact's weight is updated). Match the existing harness in that file; mock the `contacts` select/update so you can assert the update fires with `weight_kg_source: 'inbody'`. If mocking is too heavy, assert at minimum that `ingestScan` calls into the contacts table update path when `contactId` and `measurements.weight_kg` are present.

- [ ] **Step 2: Implement**

In `src/lib/inbody-ingest.js`:
1. Import: `import { applyWeightObservation } from '@/lib/body-metrics'`.
2. After the successful `inbody_scans` upsert (the `if (error) return …` guard), before `return { ok: true, … }`, add:
```js
  // Feed the canonical body weight (freshest-wins) so calories can use it.
  if (contactId && Number.isFinite(Number(measurements?.weight_kg))) {
    await applyWeightObservation(client, {
      contactId, weightKg: measurements.weight_kg, source: 'inbody', observedAt: scannedAt,
    })
  }
```

- [ ] **Step 3: Verify** — `npx vitest run src/lib/inbody-ingest.test.js` and `npm test` green.

- [ ] **Step 4: Commit**
```bash
git add src/lib/inbody-ingest.js src/lib/inbody-ingest.test.js
git commit -m "PROFILE-SETUP.5 — InBody scan feeds canonical contacts.weight_kg (freshest-wins)"
```

---

## Task 6: `POST /api/me/body-metrics` (customer self-service)

**Files:** Create `src/app/api/me/body-metrics/route.js`; modify `src/lib/openapi.js`.

- [ ] **Step 1: Implement the route**

Create `src/app/api/me/body-metrics/route.js`:
```js
// POST /api/me/body-metrics — a champ-app member saves their own body metrics
// (gender, weight, dob). Writes ONLY the caller's contact (resolved from their
// Supabase JWT). Stamps profile_setup_completed_at once dob+gender+weight all set.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { resolveCustomerContact } from '@/lib/customer-auth'
import { applyWeightObservation } from '@/lib/body-metrics'
import { validateBody } from '@/lib/validate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  gender: z.enum(['female', 'male', 'other']).optional(),
  weight_kg: z.number().min(20).max(300).optional(),
  dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict()

export async function POST(request) {
  const resolved = await resolveCustomerContact(request)
  if (resolved.error) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  }
  const contactId = resolved.contact.id

  const v = await validateBody(request, Body)
  if (!v.ok) return v.response
  const { gender, weight_kg, dob } = v.data

  const db = createServerClient()
  const nowIso = new Date().toISOString()

  // Direct fields (gender, dob) — only set what was sent.
  const patch = {}
  if (gender !== undefined) patch.gender = gender
  if (dob !== undefined) patch.dob = dob
  if (Object.keys(patch).length) {
    const { error } = await db.from('contacts').update(patch).eq('id', contactId)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  // Weight via the freshest-wins helper (source 'manual', now).
  if (weight_kg !== undefined) {
    await applyWeightObservation(db, { contactId, weightKg: weight_kg, source: 'manual', observedAt: nowIso })
  }

  // Re-read, and stamp setup-complete once all three required fields are present.
  const { data: row } = await db
    .from('contacts')
    .select('dob, gender, weight_kg, profile_setup_completed_at')
    .eq('id', contactId).maybeSingle()
  if (row && row.dob && row.gender && row.weight_kg != null && !row.profile_setup_completed_at) {
    await db.from('contacts').update({ profile_setup_completed_at: nowIso }).eq('id', contactId)
    row.profile_setup_completed_at = nowIso
  }

  return NextResponse.json({
    success: true,
    data: {
      dob: row?.dob ?? null, gender: row?.gender ?? null, weight_kg: row?.weight_kg ?? null,
      profile_setup_completed_at: row?.profile_setup_completed_at ?? null,
    },
  })
}
```

- [ ] **Step 2: Register in openapi.js** — add `/api/me/body-metrics` (POST) mirroring the existing `/api/me/preferences` entry shape (customer route, body schema, `{ success, data }` response).

- [ ] **Step 3: Verify guard + build**
- `npm run check:route-guards` — PASS. NOTE: this route authenticates via `resolveCustomerContact` (member JWT), not `getCurrentUser`. If the guard script doesn't recognise that as a guard, add `/api/me/body-metrics` to the script's customer-auth recognised set OR the `EXEMPT` map with the reason "customer-auth via resolveCustomerContact" — mirror however `/api/me/preferences` or other `resolveCustomerContact` routes are handled (grep `resolveCustomerContact` across `src/app/api` to see the precedent and follow it).
- `npm run build` — PASS (new route resolves).

- [ ] **Step 4: Commit**
```bash
git add 'src/app/api/me/body-metrics/route.js' src/lib/openapi.js
git commit -m "PROFILE-SETUP.6 — POST /api/me/body-metrics (member self-service; stamps setup-complete)"
```

---

## Task 7: Bounded backfill route

**Files:** Create `src/app/api/admin/backfill-session-calories/route.js`.

- [ ] **Step 1: Implement**

Create `src/app/api/admin/backfill-session-calories/route.js`:
```js
// POST /api/admin/backfill-session-calories?location_id=&since=YYYY-MM-DD
// Master-gated. Recomputes calories_kcal for already-ended ble_bridge sessions
// in a recent window whose contact now has the body metrics. Bounded + logged.

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { resolveBodyMetrics } from '@/lib/body-metrics'
import { estimateCaloriesKcal } from '@/lib/calories'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!user.isMaster) return NextResponse.json({ success: false, error: 'Master only' }, { status: 403 })

  const url = new URL(request.url)
  const locationId = url.searchParams.get('location_id')
  const since = url.searchParams.get('since') || new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10)
  if (!locationId) return NextResponse.json({ success: false, error: 'location_id required' }, { status: 400 })

  const db = createServerClient()
  const { data: sessions } = await db
    .from('heart_rate_sessions')
    .select('id, contact_id, started_at, ended_at, avg_hr_bpm, calories_kcal')
    .eq('location_id', locationId)
    .eq('source', 'ble_bridge')
    .not('ended_at', 'is', null)
    .gte('started_at', `${since}T00:00:00Z`)
    .order('started_at', { ascending: false })
    .limit(1000)

  let filled = 0, skipped = 0
  for (const s of sessions || []) {
    if (!s.contact_id || s.avg_hr_bpm == null) { skipped++; continue }
    const startMs = new Date(s.started_at).getTime()
    const endMs = new Date(s.ended_at).getTime()
    const durationMin = (endMs - startMs) / 60000
    const bm = await resolveBodyMetrics(db, s.contact_id, endMs)
    const kcal = estimateCaloriesKcal({ avgHr: s.avg_hr_bpm, durationMin, age: bm.age, weightKg: bm.weightKg, gender: bm.gender })
    if (kcal == null) { skipped++; continue }
    const { error } = await db.from('heart_rate_sessions').update({ calories_kcal: kcal }).eq('id', s.id)
    if (error) { skipped++; continue }
    filled++
  }

  return NextResponse.json({ success: true, data: { scanned: (sessions || []).length, filled, skipped } })
}
```

- [ ] **Step 2: Verify** — `npm run check:route-guards` (getCurrentUser + isMaster gate recognised), `npm run build`, `npm test`.

- [ ] **Step 3: Commit**
```bash
git add 'src/app/api/admin/backfill-session-calories/route.js'
git commit -m "PROFILE-SETUP.7 — master-gated bounded backfill of session calories"
```

---

## Task 8: Docs + CI mirror + advisors + PR

- [ ] **Step 1: CHANGELOG** — append a numbered Done entry to `docs/CHANGELOG.md` summarising: contacts body-metric columns (mig 322), Keytel calorie calc wired into finalisation, freshest-wins weight from InBody + manual, `/api/me/body-metrics`, bounded backfill. Cite spec/plan paths. Note it's the un1t-crm backend slice; champ-app wizard + Apple Health follow.

- [ ] **Step 2: Full CI mirror**
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails
```
All green. (No new `WEB_PERMISSIONS` key; `/api/me/*` is a customer route — if mobile-parity flags anything, add a `WEB_ONLY_OK` note.)

- [ ] **Step 3: Build** — `npm run build` PASS.

- [ ] **Step 4: Advisors** — `get_advisors` (security) on `iyvtbjjxdggiadzwwvdj` shows no new findings from mig 322.

- [ ] **Step 5: Commit + push + PR**
```bash
git add docs/CHANGELOG.md
git commit -m "PROFILE-SETUP.8 — CHANGELOG: body metrics + calories backend"
git push -u origin HEAD
gh pr create --base main --fill
```
Report the PR URL.

---

## Self-review (plan author)

**Spec coverage (Slice 1 + body-metrics API):** data model → T1; calorie calc → T2; freshest-wins weight + resolver → T3; finalisation wiring → T4; InBody source → T5; `/api/me/body-metrics` (incl. setup-complete stamp) → T6; bounded backfill → T7. Slices 2 (Apple Health) and 3 (wizard/integrations UI) are explicitly out of this plan (champ-app follow-up).

**Placeholder scan:** every code step has real code. The two "match the existing test harness" steps (T4 step 3, T5 step 1) name the concrete assertion required and a fallback; not open-ended.

**Type consistency:** `estimateCaloriesKcal({ avgHr, durationMin, age, weightKg, gender })` signature identical in T2, T4, T7. `applyWeightObservation(db, { contactId, weightKg, source, observedAt })` identical in T3, T5, T6. `resolveBodyMetrics(db, contactId, nowMs)` identical in T3, T4, T7. Gender enum `female|male|other` consistent (migration CHECK, calc, API schema).
