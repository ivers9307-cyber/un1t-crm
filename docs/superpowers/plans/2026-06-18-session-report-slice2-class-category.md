# Session Report Slice 2 — class category Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the report's `session.class.category` + `comparisons.vs_category` null slots from an operator-editable, class-name-keyed category mapping, and realign `vs_this_class` onto the class name so both comparisons populate correctly for bridge-tracked class sessions.

**Architecture:** A new per-location `class_categories` table (name-keyed) + a manager-gated Settings page to tag the distinct class names seen. The two report loaders (champ-app `load-session-report.js`, un1t-crm `loadContextForSession`) resolve each session's class name (`heart_rate_sessions.class_name` → booking `event_type.name`), attach a `category` from the mapping, and pass `class_name` + `category` on every row. The pure, byte-identical builder (`hr-analytics.js` + `hr-session-report.js` in both repos) groups `vs_this_class` by normalized class name and computes `vs_category` by category. `SESSION_REPORT_VERSION` stays 1.

**Tech Stack:** Next.js 16, Supabase (Postgres), Vitest, Tailwind (`un1t-*` tokens), lucide-react. Two repos: `un1t-crm` (`/Users/richardivers/code/un1t-crm`) + `champ-app` (`/Users/richardivers/code/champ-app`).

**Spec:** `docs/superpowers/specs/2026-06-18-session-report-slice2-class-category-design.md`

---

## File structure

**un1t-crm — create:**
- `supabase/migrations/293_class_categories.sql` — the table + RLS.
- `src/lib/class-categories.js` — `loadSeenClassCategories(db, locationId)` (distinct seen names ∪ mappings); shared by the Settings page + GET route.
- `src/lib/class-categories.test.js` — unit tests for the seen-names merge.
- `src/app/api/settings/class-categories/route.js` — `GET` (seen + mappings) + `PUT` (upsert/delete).
- `src/app/api/settings/class-categories/route.test.js` — route auth/validation tests.
- `src/app/settings/class-categories/page.js` — server page (manager-gated).
- `src/components/ClassCategoriesManager.jsx` — client editor.

**un1t-crm — modify:**
- `src/lib/hr-analytics.js` — add `normalizeClassName`, `sameClass`, `sameCategory`; key `vs_this_class` + highlight on class name; compute `category` in `buildSessionAnalytics`.
- `src/lib/hr-session-report.js` — fill `session.class.category` + `comparisons.vs_category`.
- `src/lib/__fixtures__/session-report.fixture.json` — add `class_name` + `category` to rows.
- `src/lib/hr-session-report.test.js` / `src/lib/hr-analytics.test.js` — assert the new outputs.
- `src/lib/hr-post-class-email.js` — `loadContextForSession`: select `class_name`, fetch the category map, attach `class_name` + `category`.
- `src/app/settings/page.js` — add the "Class categories" nav card.

**champ-app — modify (byte-identical libs + loader + view):**
- `src/lib/hr-analytics.js`, `src/lib/hr-session-report.js` — mirror the un1t-crm changes verbatim (keep each file's own 1-line header).
- `src/lib/__fixtures__/session-report.fixture.json` — mirror.
- `src/lib/hr-session-report.test.js` (+ `hr-analytics.test.js` if present) — mirror.
- `src/lib/load-session-report.js` — select `location_id` + `class_name`, fetch the category map, attach `class_name` + `category`.
- `src/app/sessions/[id]/page.jsx` — render the `vs_category` line.

**No new permission key** (Settings page role-gated via `MANAGER_ROLES`); no champ-bridge change.

---

### Task 1: Migration — `class_categories`

**Files:**
- Create: `un1t-crm/supabase/migrations/293_class_categories.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 293: SESSION-REPORT.2 — operator-editable cardio/strength/conditioning category
-- per class type, keyed by the (normalized) class NAME so it covers bridge-tracked
-- Glofox sessions (heart_rate_sessions.class_name) as well as CRM bookings. Drives
-- the post-class report's session.class.category + comparisons.vs_category.

CREATE TABLE IF NOT EXISTS public.class_categories (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id            uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  class_name             text NOT NULL,
  class_name_normalized  text NOT NULL,
  category               text NOT NULL CHECK (category IN ('cardio','strength','conditioning')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, class_name_normalized)
);

CREATE INDEX IF NOT EXISTS idx_class_categories_location
  ON public.class_categories (location_id);

ALTER TABLE public.class_categories ENABLE ROW LEVEL SECURITY;

-- Non-sensitive class labels: readable by ANY authenticated user (the customer
-- app's report loader needs them, and customers aren't staff-at-location). Writes
-- are service-role only (via the manager-gated settings API).
CREATE POLICY "class_categories_read_all_authenticated" ON public.class_categories
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE public.class_categories IS
  'SESSION-REPORT.2 (mig 293): per-location class-name → cardio/strength/conditioning map. Keyed by class_name_normalized = lower(btrim(class_name)). SELECT open to authenticated (non-sensitive labels read by both the CRM and the customer app); writes service-role only.';
```

- [ ] **Step 2: Commit**

```bash
cd /Users/richardivers/code/un1t-crm
git add 'supabase/migrations/293_class_categories.sql'
git commit -m "SESSION-REPORT.2 — mig 293: class_categories table + RLS

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

(Migration is applied to prod in Task 8, before the merges.)

---

### Task 2: Analytics + builder (un1t-crm) — category + class-name keying

**Files:**
- Modify: `un1t-crm/src/lib/hr-analytics.js`
- Modify: `un1t-crm/src/lib/hr-session-report.js`
- Modify: `un1t-crm/src/lib/__fixtures__/session-report.fixture.json`
- Modify: `un1t-crm/src/lib/hr-analytics.test.js`, `un1t-crm/src/lib/hr-session-report.test.js`

- [ ] **Step 1: Update the shared fixture (add class_name + category)**

In `un1t-crm/src/lib/__fixtures__/session-report.fixture.json`, add `"class_name": "RIDE"` to the `session` and `thisSession` objects and to EACH of the 5 `history` rows; add `"category": "cardio"` to `thisSession` and each `history` row. The file becomes:

```json
{
  "nowMs": 1781784000000,
  "ctx": {
    "eventTypeName": "RIDE",
    "session": {
      "id": "s-now",
      "started_at": "2026-06-18T11:00:00.000Z",
      "ended_at": "2026-06-18T11:30:00.000Z",
      "source": "ble_bridge",
      "class_name": "RIDE",
      "effort_points": 300, "avg_hr_bpm": 150, "peak_hr_bpm": 180, "max_hr_used": 190,
      "zones_seconds": { "1": 60, "2": 240, "3": 600, "4": 600, "5": 300 }
    },
    "thisSession": {
      "id": "s-now", "started_at": "2026-06-18T11:00:00.000Z", "event_type_id": "et-ride",
      "class_name": "RIDE", "category": "cardio",
      "effort_points": 300, "peak_hr_bpm": 180, "avg_hr_bpm": 150,
      "zones_seconds": { "1": 60, "2": 240, "3": 600, "4": 600, "5": 300 }
    },
    "history": [
      { "id": "r1", "started_at": "2026-06-10T11:00:00.000Z", "event_type_id": "et-ride", "class_name": "RIDE", "category": "cardio", "effort_points": 200, "peak_hr_bpm": 170, "avg_hr_bpm": 145, "zones_seconds": { "1": 600, "2": 600, "3": 600, "4": 0, "5": 0 } },
      { "id": "r2", "started_at": "2026-06-03T11:00:00.000Z", "event_type_id": "et-ride", "class_name": "RIDE", "category": "cardio", "effort_points": 250, "peak_hr_bpm": 175, "avg_hr_bpm": 148, "zones_seconds": { "1": 300, "2": 600, "3": 600, "4": 300, "5": 0 } },
      { "id": "r3", "started_at": "2026-05-27T11:00:00.000Z", "event_type_id": "et-ride", "class_name": "RIDE", "category": "cardio", "effort_points": 260, "peak_hr_bpm": 178, "avg_hr_bpm": 149, "zones_seconds": { "1": 300, "2": 600, "3": 600, "4": 300, "5": 0 } },
      { "id": "p1", "started_at": "2026-05-05T11:00:00.000Z", "event_type_id": "et-ride", "class_name": "RIDE", "category": "cardio", "effort_points": 180, "peak_hr_bpm": 165, "avg_hr_bpm": 140, "zones_seconds": { "1": 600, "2": 600, "3": 300, "4": 0, "5": 0 } },
      { "id": "p2", "started_at": "2026-04-28T11:00:00.000Z", "event_type_id": "et-ride", "class_name": "RIDE", "category": "cardio", "effort_points": 200, "peak_hr_bpm": 168, "avg_hr_bpm": 142, "zones_seconds": { "1": 600, "2": 600, "3": 300, "4": 0, "5": 0 } }
    ],
    "achievements": [
      { "slug": "first_red", "name": "Into the Red", "icon": "Flame", "earned_at": "2026-06-18T11:30:05.000Z" }
    ]
  }
}
```

- [ ] **Step 2: Add the failing builder assertions**

In `un1t-crm/src/lib/hr-session-report.test.js`, update the existing `class` assertion and add a `vs_category` assertion. Change the existing test:

```js
  it('builds the session block with duration + class', () => {
    expect(report.session.id).toBe('s-now')
    expect(report.session.duration_seconds).toBe(1800)
    expect(report.session.source).toBe('ble_bridge')
    expect(report.session.class).toEqual({ event_type_id: 'et-ride', name: 'RIDE', category: 'cardio' })
  })
```

And add a new test after the `vs_this_class` test:

```js
  it('maps the category comparison (all history is cardio)', () => {
    expect(report.comparisons.vs_category).toEqual({
      category: 'cardio', mean_points: 237, percentile: 1, sample_size: 3,
    })
  })
```

- [ ] **Step 3: Run to verify failure**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/hr-session-report.test.js`
Expected: FAIL — `class.category` is currently `null`, `vs_category` is currently `null`.

- [ ] **Step 4: Add the analytics helpers + category computation**

In `un1t-crm/src/lib/hr-analytics.js`:

(a) Update the input-shape header comment block — change the row shape list to include `class_name` + `category`:

```js
//   {
//     id, started_at, ended_at, event_type_id, class_name, category,
//     effort_points, peak_hr_bpm, avg_hr_bpm, zones_seconds,
//   }
```

(b) Add these exports just after the existing `sameClassType` function:

```js
/** Normalised class-name key — the single source of truth for class identity
 *  + the class_categories match key. Used by the loaders, the settings API,
 *  and the grouping below so the write key and read key can never diverge. */
export function normalizeClassName(name) {
  return String(name ?? '').trim().toLowerCase()
}

/** Same class as `className`, matched by normalized name (covers bridge-tracked
 *  Glofox sessions, which have class_name but no event_type_id). */
export function sameClass(sessions, className) {
  const key = normalizeClassName(className)
  if (!key) return []
  return (sessions || []).filter((s) => normalizeClassName(s.class_name) === key)
}

/** Same category (cardio/strength/conditioning) as `category`. */
export function sameCategory(sessions, category) {
  if (!category) return []
  return (sessions || []).filter((s) => s.category === category)
}
```

(c) In `pickHighlight`, change the same-class line from `event_type_id` to class name:

```js
  const sameTypeExclThis = sameClass(historyExclThis, thisSession.class_name)
```

(d) Replace `buildSessionAnalytics` with the class-name-keyed version that also computes `category`:

```js
export function buildSessionAnalytics({ thisSession, history, eventTypeName, nowMs = Date.now() }) {
  const historyExclThis = (history || []).filter((s) => s.id !== thisSession.id)
  const sameType = sameClass(historyExclThis, thisSession.class_name)
  const sameTypeRecent = withinDays(sameType, RECENT_DAYS, nowMs).slice(0, 8)

  const overallPointsTrend = trendDelta(historyExclThis, 'effort_points', nowMs)
  const overallPeakTrend = trendDelta(historyExclThis, 'peak_hr_bpm', nowMs)
  const classTypeMean = meanField(sameTypeRecent, 'effort_points')
  const classTypePercentile = percentileOf(Number(thisSession.effort_points), sameTypeRecent, 'effort_points')

  // vs_category — identical maths over same-CATEGORY history (cardio/strength/…).
  // Null when this session's class is unmapped.
  const category = thisSession.category || null
  const sameCat = sameCategory(historyExclThis, category)
  const sameCatRecent = withinDays(sameCat, RECENT_DAYS, nowMs).slice(0, 8)
  const categoryMean = meanField(sameCatRecent, 'effort_points')
  const categoryPercentile = percentileOf(Number(thisSession.effort_points), sameCatRecent, 'effort_points')

  const highlight = pickHighlight({ thisSession, history: historyExclThis, eventTypeName, nowMs })

  return {
    highlight,
    classType: {
      eventTypeId: thisSession.event_type_id,
      eventTypeName,
      recentCount: sameTypeRecent.length,
      meanPoints: classTypeMean != null ? Math.round(classTypeMean) : null,
      thisPoints: Number.isFinite(thisSession.effort_points) ? thisSession.effort_points : null,
      percentile: classTypePercentile,
    },
    category: category ? {
      categoryName: category,
      recentCount: sameCatRecent.length,
      meanPoints: categoryMean != null ? Math.round(categoryMean) : null,
      percentile: categoryPercentile,
    } : null,
    overall: {
      pointsTrend: overallPointsTrend,
      peakTrend: overallPeakTrend,
    },
  }
}
```

(`sameClassType` stays exported + its existing test stays green; it's just no longer used internally.)

- [ ] **Step 5: Fill the builder slots**

In `un1t-crm/src/lib/hr-session-report.js` `buildSessionReport`:

(a) `session.class.category` — change `category: null,` to:

```js
        category: thisSession?.category ?? null,
```

(b) `comparisons.vs_category` — change `vs_category: null,` to:

```js
      vs_category: analytics.category ? {
        category: analytics.category.categoryName,
        mean_points: Number.isFinite(analytics.category.meanPoints) ? analytics.category.meanPoints : null,
        percentile: Number.isFinite(analytics.category.percentile) ? analytics.category.percentile : null,
        sample_size: Number.isFinite(analytics.category.recentCount) ? analytics.category.recentCount : 0,
      } : null,
```

- [ ] **Step 6: Add a mixed-category analytics test (filtering + null path)**

Append to `un1t-crm/src/lib/hr-analytics.test.js`:

```js
describe('buildSessionAnalytics — category grouping', () => {
  const base = (over) => ({ id: 'x', started_at: day(2), class_name: 'RIDE', category: 'cardio', effort_points: 100, peak_hr_bpm: 170, avg_hr_bpm: 140, zones_seconds: { 1: 60, 2: 600, 3: 1200, 4: 600, 5: 0 }, ...over })

  it('groups vs_category by category, not class, and ignores other categories', () => {
    const thisSession = base({ id: 'now', startedDaysAgo: 0, started_at: day(0), effort_points: 300 })
    const history = [
      base({ id: 'c1', started_at: day(3), class_name: 'RIDE', category: 'cardio', effort_points: 200 }),
      base({ id: 'c2', started_at: day(5), class_name: 'TEMPO', category: 'cardio', effort_points: 220 }),
      base({ id: 's1', started_at: day(4), class_name: 'LIFT', category: 'strength', effort_points: 999 }),
    ]
    const a = buildSessionAnalytics({ thisSession, history, eventTypeName: 'RIDE', nowMs: NOW })
    // category = cardio over c1 + c2 (the strength row excluded)
    expect(a.category).toMatchObject({ categoryName: 'cardio', recentCount: 2, meanPoints: 210 })
    expect(a.category.percentile).toBe(1) // 300 beats both 200 + 220
    // vs_this_class = RIDE only (c1), not TEMPO/LIFT
    expect(a.classType.recentCount).toBe(1)
    expect(a.classType.meanPoints).toBe(200)
  })

  it('returns null category when this session has none', () => {
    const thisSession = base({ id: 'now', started_at: day(0), category: null })
    const a = buildSessionAnalytics({ thisSession, history: [], eventTypeName: 'RIDE', nowMs: NOW })
    expect(a.category).toBeNull()
  })
})
```

- [ ] **Step 7: Run to verify pass**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/hr-session-report.test.js src/lib/hr-analytics.test.js`
Expected: PASS (existing + new tests green; `vs_this_class` still `{ event_type_name: 'RIDE', mean_points: 237, percentile: 1, sample_size: 3 }`).

- [ ] **Step 8: Commit**

```bash
cd /Users/richardivers/code/un1t-crm
git add src/lib/hr-analytics.js src/lib/hr-session-report.js src/lib/__fixtures__/session-report.fixture.json src/lib/hr-analytics.test.js src/lib/hr-session-report.test.js
git commit -m "SESSION-REPORT.2 — vs_category + class-name-keyed vs_this_class (un1t-crm builder)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Mirror the builder to champ-app (byte-identical)

**Files:**
- Modify: `champ-app/src/lib/hr-analytics.js`, `src/lib/hr-session-report.js`
- Modify: `champ-app/src/lib/__fixtures__/session-report.fixture.json`
- Modify: `champ-app/src/lib/hr-session-report.test.js` (+ `hr-analytics.test.js` if it exists)

- [ ] **Step 1: Create the champ-app branch**

```bash
cd /Users/richardivers/code/champ-app
git checkout main && git pull origin main
git checkout -b session-report-slice2-class-category
```

- [ ] **Step 2: Copy the changed function bodies verbatim from un1t-crm**

Apply the SAME edits from Task 2 steps 1, 4, 5 to the champ-app copies — `src/lib/hr-analytics.js` (header comment, `normalizeClassName`/`sameClass`/`sameCategory`, `pickHighlight` same-class line, `buildSessionAnalytics`), `src/lib/hr-session-report.js` (`session.class.category` + `vs_category`), and `src/lib/__fixtures__/session-report.fixture.json` (add `class_name` + `category`). **Keep each champ-app file's existing 1-line header comment** (champ-app's `hr-analytics.js` line 1 is `// KEEP IN SYNC with un1t-crm…`); everything below the header must match un1t-crm byte-for-byte. Verify with:

```bash
diff <(tail -n +2 /Users/richardivers/code/un1t-crm/src/lib/hr-analytics.js) <(tail -n +2 /Users/richardivers/code/champ-app/src/lib/hr-analytics.js)
```
Expected: no output (identical below line 1). Run the same diff for `hr-session-report.js`. For the fixture, it should be byte-identical (no header):
```bash
diff /Users/richardivers/code/un1t-crm/src/lib/__fixtures__/session-report.fixture.json /Users/richardivers/code/champ-app/src/lib/__fixtures__/session-report.fixture.json
```
Expected: no output.

- [ ] **Step 3: Mirror the test assertions**

Apply the same test edits from Task 2 steps 2 + 6 to champ-app's `src/lib/hr-session-report.test.js` and `src/lib/hr-analytics.test.js` (create/extend to match). If champ-app's test files differ in structure, match the new assertions (`class.category: 'cardio'`, the `vs_category` equality, the mixed-category + null-category cases).

- [ ] **Step 4: Run champ-app tests**

Run: `cd /Users/richardivers/code/champ-app && npx vitest run src/lib/hr-session-report.test.js src/lib/hr-analytics.test.js`
Expected: PASS.

- [ ] **Step 5: Commit (champ-app)**

```bash
cd /Users/richardivers/code/champ-app
git add src/lib/hr-analytics.js src/lib/hr-session-report.js src/lib/__fixtures__/session-report.fixture.json src/lib/hr-session-report.test.js src/lib/hr-analytics.test.js
git commit -m "SESSION-REPORT.2 — mirror vs_category + class-name keying (champ-app builder)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Loaders attach `class_name` + `category`

**Files:**
- Modify: `champ-app/src/lib/load-session-report.js`
- Modify: `un1t-crm/src/lib/hr-post-class-email.js` (`loadContextForSession`)

- [ ] **Step 1: champ-app `load-session-report.js`**

Make these edits (the file is quoted in full in the spec/extraction; apply precisely):

(a) Add the import:
```js
import { normalizeClassName } from './hr-analytics.js'
```

(b) Session select — add `location_id, class_name` to the `heart_rate_sessions` columns (the first select), keeping the `booking.event_type(id, name)` embed.

(c) After `const eventType = session.booking?.event_type || null`, add:
```js
  const className = session.class_name ?? eventType?.name ?? null

  const { data: catRows } = await supabase
    .from('class_categories')
    .select('class_name_normalized, category')
    .eq('location_id', session.location_id)
  const catMap = new Map((catRows || []).map((c) => [c.class_name_normalized, c.category]))
  const categoryFor = (name) => catMap.get(normalizeClassName(name)) ?? null
```

(d) History select — add `class_name` to the `heart_rate_sessions` columns and change the booking embed to fetch the event-type name:
```js
    .select(`id, started_at, effort_points, peak_hr_bpm, avg_hr_bpm, zones_seconds, class_name,
             booking:bookings!heart_rate_sessions_booking_id_fkey ( event_type:event_types!bookings_event_type_id_fkey ( name ) )`)
```

(e) History row mapping — resolve name + category:
```js
  const history = (historyRows || []).map((r) => {
    const name = r.class_name ?? r.booking?.event_type?.name ?? null
    return {
      id: r.id, started_at: r.started_at,
      event_type_id: r.booking?.event_type?.id || null,
      class_name: name, category: categoryFor(name),
      effort_points: r.effort_points, peak_hr_bpm: r.peak_hr_bpm,
      avg_hr_bpm: r.avg_hr_bpm, zones_seconds: r.zones_seconds,
    }
  })
```
(Note: `event_type_id` is no longer selected on history rows since grouping is by name; setting it from the embed is optional — drop it or keep `null`. Keep `null` to avoid an extra embed field.)

Simplify to:
```js
  const history = (historyRows || []).map((r) => {
    const name = r.class_name ?? r.booking?.event_type?.name ?? null
    return {
      id: r.id, started_at: r.started_at,
      class_name: name, category: categoryFor(name),
      effort_points: r.effort_points, peak_hr_bpm: r.peak_hr_bpm,
      avg_hr_bpm: r.avg_hr_bpm, zones_seconds: r.zones_seconds,
    }
  })
```

(f) `thisSession` — add `class_name` + `category`:
```js
  const thisSession = {
    id: session.id, started_at: session.started_at,
    event_type_id: eventType?.id || null,
    class_name: className, category: categoryFor(className),
    effort_points: session.effort_points, peak_hr_bpm: session.peak_hr_bpm,
    avg_hr_bpm: session.avg_hr_bpm, zones_seconds: session.zones_seconds,
  }
```

(g) The `buildSessionReport` call — pass the resolved class name as `eventTypeName`:
```js
  const report = buildSessionReport(
    { session, thisSession, history, eventTypeName: className, achievements: achRows || [] },
    { nowMs },
  )
```

- [ ] **Step 2: un1t-crm `hr-post-class-email.js` `loadContextForSession`**

Same shape (service-role `db`; the session select already has `location_id`):

(a) Add to the file's imports:
```js
import { normalizeClassName } from '@/lib/hr-analytics'
```

(b) Session select — add `class_name` to the `heart_rate_sessions` columns (it already selects `location_id`).

(c) After `const eventTypeName = session.booking?.event_type?.name || null`, add:
```js
  const className = session.class_name ?? eventTypeName ?? null
  const { data: catRows } = await db
    .from('class_categories')
    .select('class_name_normalized, category')
    .eq('location_id', session.location_id)
  const catMap = new Map((catRows || []).map((c) => [c.class_name_normalized, c.category]))
  const categoryFor = (name) => catMap.get(normalizeClassName(name)) ?? null
```

(d) History select — add `class_name`, and the booking embed already has `event_type_id`; add the name for fallback:
```js
    .select(`id, started_at, ended_at, effort_points, peak_hr_bpm, avg_hr_bpm, zones_seconds, class_name,
             booking:bookings!heart_rate_sessions_booking_id_fkey ( event_type:event_types!bookings_event_type_id_fkey ( name ) )`)
```

(e) History mapping — resolve name + category:
```js
  const history = (historyRows || []).map((r) => {
    const name = r.class_name ?? r.booking?.event_type?.name ?? null
    return {
      id: r.id,
      started_at: r.started_at,
      class_name: name,
      category: categoryFor(name),
      effort_points: r.effort_points,
      peak_hr_bpm: r.peak_hr_bpm,
      avg_hr_bpm: r.avg_hr_bpm,
      zones_seconds: r.zones_seconds,
    }
  })
```

(f) `thisSession` — add `class_name` + `category`:
```js
  const thisSession = {
    id: session.id,
    started_at: session.started_at,
    event_type_id: eventTypeId,
    class_name: className,
    category: categoryFor(className),
    effort_points: session.effort_points,
    peak_hr_bpm: session.peak_hr_bpm,
    avg_hr_bpm: session.avg_hr_bpm,
    zones_seconds: session.zones_seconds,
  }
```

(g) Update the returned `eventTypeName` to the resolved class name:
```js
  return {
    ok: true,
    session,
    thisSession,
    history,
    eventTypeName: className,
    contact: session.contact,
  }
```

- [ ] **Step 3: Verify the existing email test still passes**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/hr-post-class-email.test.js`
Expected: PASS (the loader change is additive; `composeEmail` is tested on a context object and is unaffected until Task 7 adds the render line). If the email test stubs the DB, confirm the new `class_categories` select degrades to `[]` (no category) without breaking — it should, since `catRows` defaults to `[]`.

- [ ] **Step 4: Commit (both repos)**

```bash
cd /Users/richardivers/code/un1t-crm && git add src/lib/hr-post-class-email.js && git commit -m "SESSION-REPORT.2 — email loader attaches class_name + category

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
cd /Users/richardivers/code/champ-app && git add src/lib/load-session-report.js && git commit -m "SESSION-REPORT.2 — report loader attaches class_name + category

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Settings API — `GET`/`PUT /api/settings/class-categories`

**Files:**
- Create: `un1t-crm/src/lib/class-categories.js`
- Create: `un1t-crm/src/lib/class-categories.test.js`
- Create: `un1t-crm/src/app/api/settings/class-categories/route.js`
- Create: `un1t-crm/src/app/api/settings/class-categories/route.test.js`

- [ ] **Step 1: Write the failing lib test**

`un1t-crm/src/lib/class-categories.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { mergeSeenWithMappings, CLASS_CATEGORY_VALUES } from './class-categories'

describe('mergeSeenWithMappings', () => {
  it('dedupes seen names by normalized form, attaches category, sorts by name', () => {
    const seen = ['RIDE', 'ride', 'TEMPO', 'DR1VE 45']
    const mappings = [{ class_name_normalized: 'ride', category: 'cardio' }, { class_name_normalized: 'tempo', category: 'strength' }]
    const out = mergeSeenWithMappings(seen, mappings)
    expect(out).toEqual([
      { class_name: 'DR1VE 45', category: null },
      { class_name: 'RIDE', category: 'cardio' },
      { class_name: 'TEMPO', category: 'strength' },
    ])
  })
  it('includes mapped names even if not currently seen', () => {
    const out = mergeSeenWithMappings([], [{ class_name_normalized: 'spin', category: 'cardio' }])
    expect(out).toEqual([{ class_name: 'spin', category: 'cardio' }])
  })
  it('exposes the category enum', () => {
    expect(CLASS_CATEGORY_VALUES).toEqual(['cardio', 'strength', 'conditioning'])
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/class-categories.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the lib**

`un1t-crm/src/lib/class-categories.js`:
```js
// SESSION-REPORT.2 — class category helpers (un1t-crm only). The match key
// (normalizeClassName) lives in hr-analytics.js so the report builder, the
// loaders, and this settings surface all derive the same key.

import { normalizeClassName } from '@/lib/hr-analytics'

export const CLASS_CATEGORY_VALUES = ['cardio', 'strength', 'conditioning']

/**
 * Merge a list of seen class-name strings with the saved mappings into the
 * settings-page shape: one row per distinct normalized name, category attached
 * (null when unmapped). Mapped-but-not-seen names are included so an operator
 * can re-categorise a class that's gone quiet. Pure.
 * @returns {Array<{ class_name: string, category: string|null }>}
 */
export function mergeSeenWithMappings(seenNames = [], mappings = []) {
  const catByKey = new Map((mappings || []).map((m) => [m.class_name_normalized, m.category]))
  const display = new Map() // normalized -> display name

  for (const raw of seenNames || []) {
    const key = normalizeClassName(raw)
    if (!key) continue
    if (!display.has(key)) display.set(key, String(raw).trim())
  }
  // Mapped-but-unseen: synthesize a display name from the normalized key.
  for (const [key] of catByKey) {
    if (!display.has(key)) display.set(key, key)
  }

  return [...display.entries()]
    .map(([key, name]) => ({ class_name: name, category: catByKey.get(key) ?? null }))
    .sort((a, b) => a.class_name.localeCompare(b.class_name))
}

/**
 * Load the seen class names (heart_rate_sessions.class_name ∪ class_occurrences.name)
 * at a location, merged with saved mappings. The distinct set of class names is
 * tiny, so the per-table 1000-row cap captures every name in practice.
 */
export async function loadSeenClassCategories(db, locationId) {
  const [{ data: hrRows }, { data: occRows }, { data: mappings }] = await Promise.all([
    db.from('heart_rate_sessions').select('class_name').eq('location_id', locationId).not('class_name', 'is', null).limit(1000),
    db.from('class_occurrences').select('name').eq('location_id', locationId).limit(1000),
    db.from('class_categories').select('class_name_normalized, category').eq('location_id', locationId),
  ])
  const seen = [
    ...(hrRows || []).map((r) => r.class_name),
    ...(occRows || []).map((r) => r.name),
  ].filter(Boolean)
  return mergeSeenWithMappings(seen, mappings || [])
}
```

- [ ] **Step 4: Run to verify the lib test passes**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/class-categories.test.js`
Expected: PASS.

- [ ] **Step 5: Write the failing route test**

`un1t-crm/src/app/api/settings/class-categories/route.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({ getCurrentUser: vi.fn() }))
vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/class-categories', async (orig) => {
  const actual = await orig()
  return { ...actual, loadSeenClassCategories: vi.fn(async () => [{ class_name: 'RIDE', category: 'cardio' }]) }
})

import { GET, PUT } from './route'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

beforeEach(() => vi.clearAllMocks())
const LOC = '00000000-0000-0000-0000-000000000001'

function req(url, body) {
  return new Request(url, body ? { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
}

describe('GET /api/settings/class-categories', () => {
  it('403 for a non-manager', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'staff', activeLocation: { id: LOC }, rolesByLocation: { [LOC]: 'staff' } })
    const res = await GET(req(`http://x/api/settings/class-categories?location_id=${LOC}`))
    expect(res.status).toBe(403)
  })
  it('200 returns seen + mappings for a manager', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: LOC }, rolesByLocation: { [LOC]: 'manager' } })
    createServerClient.mockReturnValue({})
    const res = await GET(req(`http://x/api/settings/class-categories?location_id=${LOC}`))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.seen[0]).toMatchObject({ class_name: 'RIDE', category: 'cardio' })
  })
})

describe('PUT /api/settings/class-categories', () => {
  it('upserts set categories + deletes cleared ones', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: LOC }, rolesByLocation: { [LOC]: 'manager' } })
    const upserts = []; const deletes = []
    createServerClient.mockReturnValue({
      from: () => ({
        upsert: (rows, opts) => { upserts.push({ rows, opts }); return Promise.resolve({ error: null }) },
        delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }),
      }),
    })
    // capture deletes via a from() that records the table op
    createServerClient.mockReturnValue({
      from: (t) => ({
        upsert: (rows, opts) => { upserts.push({ rows, opts }); return Promise.resolve({ error: null }) },
        delete: () => ({ eq: () => ({ eq: (col, val) => { deletes.push(val); return Promise.resolve({ error: null }) } }) }),
      }),
    })
    const res = await PUT(req('http://x/api/settings/class-categories', {
      location_id: LOC,
      entries: [{ class_name: 'RIDE', category: 'cardio' }, { class_name: 'OLD', category: null }],
    }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.success).toBe(true)
    expect(upserts[0].rows[0]).toMatchObject({ location_id: LOC, class_name: 'RIDE', class_name_normalized: 'ride', category: 'cardio' })
    expect(upserts[0].opts).toEqual({ onConflict: 'location_id,class_name_normalized' })
    expect(deletes).toContain('old') // normalized 'OLD'
  })
  it('400 on an invalid category', async () => {
    getCurrentUser.mockResolvedValue({ id: 'u', role: 'manager', activeLocation: { id: LOC }, rolesByLocation: { [LOC]: 'manager' } })
    createServerClient.mockReturnValue({ from: () => ({}) })
    const res = await PUT(req('http://x/api/settings/class-categories', { location_id: LOC, entries: [{ class_name: 'X', category: 'bogus' }] }))
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 6: Run to verify failure**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/app/api/settings/class-categories/route.test.js`
Expected: FAIL — route module not found.

- [ ] **Step 7: Write the route**

`un1t-crm/src/app/api/settings/class-categories/route.js`:
```js
// GET  /api/settings/class-categories?location_id= — seen class names + their categories
// PUT  /api/settings/class-categories — upsert set categories / delete cleared ones
//
// SESSION-REPORT.2 — operator tags each class type cardio/strength/conditioning.
// Manager+ gated; service-role writes (RLS on class_categories is SELECT-only for
// authenticated). The match key is normalizeClassName (shared with the report).

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { validateBody } from '@/lib/validate'
import { uuidLike, MANAGER_ROLES } from '@/lib/schemas'
import { normalizeClassName } from '@/lib/hr-analytics'
import { loadSeenClassCategories, CLASS_CATEGORY_VALUES } from '@/lib/class-categories'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const { searchParams } = new URL(request.url)
  const locationId = searchParams.get('location_id') || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const seen = await loadSeenClassCategories(db, locationId)
  return NextResponse.json({ success: true, seen })
}

const PutSchema = z.object({
  location_id: uuidLike.optional(),
  entries: z.array(z.object({
    class_name: z.string().min(1).max(120),
    category: z.enum(CLASS_CATEGORY_VALUES).nullable(),
  })).max(500),
})

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }
  const validation = await validateBody(request, PutSchema)
  if (!validation.ok) return validation.response
  const body = validation.data
  const locationId = body.location_id || user.activeLocation?.id
  const guard = assertLocationAccess(user, locationId)
  if (guard) return guard

  const db = createServerClient()
  const toUpsert = []
  const toDelete = []
  for (const e of body.entries) {
    const key = normalizeClassName(e.class_name)
    if (!key) continue
    if (e.category) {
      toUpsert.push({
        location_id: locationId,
        class_name: e.class_name.trim(),
        class_name_normalized: key,
        category: e.category,
        updated_at: new Date().toISOString(),
      })
    } else {
      toDelete.push(key)
    }
  }

  if (toUpsert.length > 0) {
    const { error } = await db.from('class_categories').upsert(toUpsert, { onConflict: 'location_id,class_name_normalized' })
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }
  for (const key of toDelete) {
    const { error } = await db.from('class_categories').delete().eq('location_id', locationId).eq('class_name_normalized', key)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  }

  return NextResponse.json({ success: true })
}
```

- [ ] **Step 8: Run to verify pass**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/class-categories.test.js src/app/api/settings/class-categories/route.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
cd /Users/richardivers/code/un1t-crm
git add src/lib/class-categories.js src/lib/class-categories.test.js src/app/api/settings/class-categories/route.js src/app/api/settings/class-categories/route.test.js
git commit -m "SESSION-REPORT.2 — class-categories settings API + seen-names lib

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Settings page + nav link

**Files:**
- Create: `un1t-crm/src/app/settings/class-categories/page.js`
- Create: `un1t-crm/src/components/ClassCategoriesManager.jsx`
- Modify: `un1t-crm/src/app/settings/page.js`

- [ ] **Step 1: Write the server page**

`un1t-crm/src/app/settings/class-categories/page.js`:
```js
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import { MANAGER_ROLES } from '@/lib/schemas'
import { loadSeenClassCategories } from '@/lib/class-categories'
import ClassCategoriesManager from '@/components/ClassCategoriesManager'

export const dynamic = 'force-dynamic'

export default async function ClassCategoriesSettingsPage() {
  const user = await getCurrentUser()
  if (!user || !MANAGER_ROLES.includes(user.role)) redirect('/')
  const locationId = user.activeLocation?.id
  if (!locationId) redirect('/settings')

  const db = createServerClient()
  const seen = await loadSeenClassCategories(db, locationId)

  return (
    <div className="p-8 max-w-3xl">
      <Link href="/settings" className="inline-flex items-center gap-1.5 text-sm text-un1t-subtle hover:text-un1t-text mb-4">
        <ArrowLeft size={16} /> Back to Settings
      </Link>
      <h2 className="text-2xl font-bold mb-1">Class categories</h2>
      <p className="text-sm text-un1t-subtle mb-6">
        Tag each class as cardio, strength or conditioning. Members&apos; post-class reports use this to compare a session to their typical classes of the same kind.
      </p>
      <ClassCategoriesManager locationId={locationId} initialSeen={seen} />
    </div>
  )
}
```

- [ ] **Step 2: Write the client editor**

`un1t-crm/src/components/ClassCategoriesManager.jsx`:
```jsx
'use client'

import { useState } from 'react'

const CATEGORIES = ['cardio', 'strength', 'conditioning']

export default function ClassCategoriesManager({ locationId, initialSeen }) {
  const [rows, setRows] = useState(initialSeen || [])
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [error, setError] = useState(null)

  function setCategory(className, category) {
    setRows((prev) => prev.map((r) => (r.class_name === className ? { ...r, category: category || null } : r)))
  }

  async function save() {
    setSaving(true); setError(null)
    try {
      const res = await fetch('/api/settings/class-categories', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ location_id: locationId, entries: rows.map((r) => ({ class_name: r.class_name, category: r.category })) }),
      })
      const json = await res.json()
      if (!res.ok || !json.success) throw new Error(json.error || 'Save failed')
      setSavedAt(Date.now())
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  if (rows.length === 0) {
    return <p className="text-sm text-un1t-subtle">No classes detected yet. Once the bridge sees classes (or Glofox occurrences sync), they&apos;ll appear here to tag.</p>
  }

  return (
    <div>
      <ul className="divide-y divide-un1t-border rounded-2xl border border-un1t-border bg-white">
        {rows.map((r) => (
          <li key={r.class_name} className="flex items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.class_name}</span>
            <div className="flex items-center gap-1.5">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(r.class_name, r.category === c ? null : c)}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium capitalize ${r.category === c ? 'bg-un1t-accent text-white' : 'border border-un1t-border text-un1t-subtle hover:bg-un1t-surface'}`}
                >
                  {c}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>

      {error && <p className="mt-3 text-sm text-red-700">{error}</p>}

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-un1t-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save categories'}
        </button>
        {savedAt && !saving && <span className="text-xs text-emerald-700">Saved</span>}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Add the Settings nav card**

In `un1t-crm/src/app/settings/page.js`, inside the **Communications** section's `<div className="space-y-2">` (after the existing notification/customer-agent `<Link>`s), add a new card (use an icon already imported in that file, e.g. `Activity` or `Heart`; if not imported, add `Activity` to the lucide-react import at the top):

```jsx
          <Link
            href="/settings/class-categories"
            className="bg-un1t-surface border border-un1t-border hover:border-un1t-subtle rounded-lg p-4 flex items-center justify-between text-sm group transition-colors"
          >
            <div className="flex items-center gap-3">
              <Activity size={16} className="text-un1t-subtle shrink-0" />
              <div>
                <div className="text-un1t-text">Class categories</div>
                <div className="text-xs text-un1t-subtle mt-0.5">
                  Tag each class cardio / strength / conditioning — powers the post-class report comparisons.
                </div>
              </div>
            </div>
            <ChevronRight size={16} className="text-un1t-subtle group-hover:text-un1t-text shrink-0" />
          </Link>
```

(If a "Studio"/"HR" section fits better than "Communications", place it there — match whichever section the live-HR/studio settings live in. Verify `Activity` + `ChevronRight` are imported.)

- [ ] **Step 4: Run the production build (catches imports + JSX)**

Run: `cd /Users/richardivers/code/un1t-crm && npm run build`
Expected: compiles with no errors referencing `class-categories` / `ClassCategoriesManager`.

- [ ] **Step 5: Commit**

```bash
cd /Users/richardivers/code/un1t-crm
git add 'src/app/settings/class-categories/page.js' src/components/ClassCategoriesManager.jsx src/app/settings/page.js
git commit -m "SESSION-REPORT.2 — Class categories settings page + nav

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Render `vs_category` (champ-app view + email)

**Files:**
- Modify: `champ-app/src/app/sessions/[id]/page.jsx`
- Modify: `un1t-crm/src/lib/hr-post-class-email.js` (`composeEmail`)

- [ ] **Step 1: champ-app session view — add the category line**

In `champ-app/src/app/sessions/[id]/page.jsx`, inside the `<ul>` of the "How this compares" section, after the `vs_this_class` `<li>` block, add:

```jsx
      {report.comparisons.vs_category && report.comparisons.vs_category.percentile != null && report.comparisons.vs_category.sample_size >= 2 && (
        <li className="text-neutral-700 dark:text-neutral-300">
          {(() => {
            const c = report.comparisons.vs_category
            const pct = Math.round(c.percentile * 100)
            if (pct >= 100) return `Personal best — top of your last ${c.sample_size} ${c.category} classes.`
            return pct >= 50
              ? `Top ${100 - pct}% of your last ${c.sample_size} ${c.category} classes.`
              : `Below your usual for ${c.category} classes (avg ${c.mean_points} pts over your last ${c.sample_size}).`
          })()}
        </li>
      )}
```

- [ ] **Step 2: un1t-crm email — add the category line**

In `un1t-crm/src/lib/hr-post-class-email.js` `composeEmail`, find where the `vs_this_class` comparison line is rendered into the HTML + text body and add a parallel `vs_category` line immediately after it. Mirror the existing line's exact markup/phrasing; gate it on `report.comparisons.vs_category && vs_category.percentile != null && vs_category.sample_size >= 2`. Example (adapt to the file's actual render style — match the `vs_this_class` block it sits beside):

```js
  const vc = report.comparisons.vs_category
  const vcLine = (vc && vc.percentile != null && vc.sample_size >= 2)
    ? `${Math.round(vc.percentile * 100) >= 50
        ? `Top ${100 - Math.round(vc.percentile * 100)}% of your last ${vc.sample_size} ${vc.category} classes.`
        : `Building back up in your ${vc.category} classes — avg ${vc.mean_points} pts over your last ${vc.sample_size}.`}`
    : null
  // …include vcLine in the HTML + text bodies right after the vs_this_class line, when non-null…
```

- [ ] **Step 3: Verify the email test still passes**

Run: `cd /Users/richardivers/code/un1t-crm && npx vitest run src/lib/hr-post-class-email.test.js`
Expected: PASS (the category line is additive + null-gated; if the test asserts on exact body text, extend the fixture/assertion to include the new line when a category is present, or confirm the test's context has no category so the line is omitted).

- [ ] **Step 4: champ-app build**

Run: `cd /Users/richardivers/code/champ-app && npm run build`
Expected: compiles clean.

- [ ] **Step 5: Commit (both repos)**

```bash
cd /Users/richardivers/code/un1t-crm && git add src/lib/hr-post-class-email.js && git commit -m "SESSION-REPORT.2 — post-class email renders vs_category line

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
cd /Users/richardivers/code/champ-app && git add 'src/app/sessions/[id]/page.jsx' && git commit -m "SESSION-REPORT.2 — session view renders vs_category line

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Ship — apply migration, CI, PRs, merge

**Files:** none (release).

- [ ] **Step 1: Apply the migration to prod (before merges)**

Apply `un1t-crm/supabase/migrations/293_class_categories.sql` via the Supabase MCP `apply_migration` tool (project `iyvtbjjxdggiadzwwvdj`). Additive table, RLS'd; safe before the code merges.

- [ ] **Step 2: Security advisor**

`get_advisors` (type=security). Expected: no new ERROR for `class_categories`. The `SELECT USING (true)` policy is intentional (a non-sensitive label table) and won't error; if it surfaces as an INFO, that's acceptable and noted in the table comment.

- [ ] **Step 3: un1t-crm full CI mirror + build**

```bash
cd /Users/richardivers/code/un1t-crm
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run build
```
Expected: all green. (No new permission key → parity clean; the new route uses `getCurrentUser` → route-guards clean.)

- [ ] **Step 4: champ-app checks**

```bash
cd /Users/richardivers/code/champ-app
npm test && npm run build
```
Expected: green (lint too if champ-app has a lint script — run `npm run lint` if present).

- [ ] **Step 5: Push + open both PRs (base=main)**

```bash
cd /Users/richardivers/code/un1t-crm && git push -u origin session-report-slice2-class-category
gh pr create --base main --head session-report-slice2-class-category \
  --title "SESSION-REPORT.2 — class category (cardio/strength) comparison" \
  --body "Fills session.class.category + comparisons.vs_category from an operator-editable, class-name-keyed class_categories map (mig 293), and realigns vs_this_class onto the class name so both comparisons populate for bridge-tracked class sessions. New Settings → Class categories page (manager+, no new permission key). Builder byte-identical in champ-app (PR linked). Version stays 1.

Spec: docs/superpowers/specs/2026-06-18-session-report-slice2-class-category-design.md
Plan: docs/superpowers/plans/2026-06-18-session-report-slice2-class-category.md

Verified: vitest + lint + parity + mobile-imports + route-guards + next build green; mig 293 applied to prod + advisor clean before merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"

cd /Users/richardivers/code/champ-app && git push -u origin session-report-slice2-class-category
gh pr create --base main --head session-report-slice2-class-category \
  --title "SESSION-REPORT.2 — class category comparison (champ-app)" \
  --body "Mirrors the byte-identical report builder (vs_category + class-name-keyed vs_this_class), the report loader (attaches class_name + category from class_categories), and the session view's 'How this compares' category line. Pairs with un1t-crm SESSION-REPORT.2.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 6: Watch CI, then merge both**

```bash
cd /Users/richardivers/code/un1t-crm && gh pr checks --watch && gh pr merge --squash
cd /Users/richardivers/code/champ-app && gh pr checks --watch && gh pr merge --squash
```
Confirm each squash landed on its `origin/main`. Both auto-deploy (un1t-crm → crm.un1tdublin.com, champ-app → app.champfitness.ie); the table already exists from Step 1.

---

## Self-review notes

- **Spec coverage:** `class_categories` table + RLS (Task 1) ✓; operator settings page + GET/PUT (Tasks 5–6) ✓; loaders resolve class name + attach category (Task 4) ✓; `vs_this_class` re-keyed on class name + `vs_category` + `session.class.category`, version 1 (Tasks 2–3) ✓; byte-identical builder + shared fixture both repos (Tasks 2–3) ✓; render on view + email (Task 7) ✓; no new permission key (Task 6) ✓; non-sensitive SELECT-all RLS (Task 1) ✓.
- **Type consistency:** `normalizeClassName` is the single key derivation (hr-analytics.js) used by analytics grouping, both loaders, the settings lib, and the route. Rows carry `class_name` + `category`; `buildSessionAnalytics` reads `thisSession.class_name`/`.category` + history rows' same fields; `vs_category` shape `{category, mean_points, percentile, sample_size}` matches builder ↔ view ↔ email. `class_categories` columns (`class_name`, `class_name_normalized`, `category`) match the upsert (`onConflict: 'location_id,class_name_normalized'`) and the loader map (`class_name_normalized → category`).
- **Gotchas honoured:** `noglob`/quoted bracket paths in git adds; `next build` is its own step in both repos (vitest+eslint miss import/JSX errors); the fixture stays all-cardio so existing `vs_this_class` assertions (237/1/3) don't break, with mixed-category filtering tested separately; the per-table 1000-row cap on seen-names is acceptable (distinct class names ≪ 1000) and commented; `class_categories` SELECT is open-to-authenticated by design (customer app reads it).
