# Hyrox Training Club — Plan 01: Foundation (data model + AI generation)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the two Hyrox tables and a pure, tested generation library that turns block inputs into a validated 12-week arc and validated per-session workouts — with the workout design charter baked in — before any UI or TV wiring exists.

**Architecture:** Follow the estate's `class-occurrences.js` shape — **pure mappers/validators/prompt-builders are exported and unit-tested; the one IO function (the Anthropic call) is thin and injectable.** New tables mirror the `class_occurrences` RLS pattern (mig 284): `authenticated` SELECT via `private.auth_is_in_location(location_id)`, all writes service-role. Structured model output is validated with `zod` and retried once on failure, never trusted raw.

**Tech Stack:** Next.js 16 · Supabase (Postgres, migration via Supabase MCP) · zod ^4 · vitest ^4 · Anthropic Messages API (reuse the estate fetch pattern; no OpenAI).

**Spec:** `2026-07-23-hyrox-training-club-design.md`. This plan covers spec **§3 (data model), §4 (generation), §4.4 (charter), §8.2 (block dial)**, and lands the **§8.3 auto-tune toggle column + a no-op signal param** so later phases need no schema change. Deferred to later plans: §5 review UI (Plan 02), §6 publish cron + §7 TV renderer + §8.1 tier rendering (Plan 03).

**Before you start:** create the worktree per `superpowers:using-git-worktrees` (fresh branch off `origin/main`), and drop the spec + this plan into `docs/superpowers/{specs,plans}/`. Migrations apply via Supabase MCP `apply_migration` against project ref `iyvtbjjxdggiadzwwvdj` (confirm with `list_projects` — NOT the sentinel project); run `get_advisors(type=security)` after the DDL.

---

## File structure

| File | Responsibility |
|---|---|
| `supabase/migrations/<NNN>_hyrox_training_club.sql` | `hyrox_blocks` + `hyrox_sessions` tables, RLS, comments |
| `src/lib/hyrox/constants.js` | Stations, tiers, phases, dials, the default charter |
| `src/lib/hyrox/schema.js` | zod schemas for the arc, a week plan, a full session, a board |
| `src/lib/hyrox/mapping.js` | Dublin-safe `week_no` / `slot` date mapping (pure) |
| `src/lib/hyrox/prompt.js` | Pure builders: arc prompt + session-expansion prompt (charter embedded) |
| `src/lib/hyrox/generate.js` | IO: the Anthropic call + `generateArc` / `expandSession` (validate + retry) |
| `src/lib/hyrox/*.test.js` | Unit tests for schema, mapping, prompt, and generate (mocked fetch) |

`src/lib/hyrox/` is a new focused folder so the whole feature's pure logic sits together, mirroring how `src/lib/agent/*` is grouped.

---

## Task 1: Migration — the two tables

**Files:**
- Create: `supabase/migrations/<NNN>_hyrox_training_club.sql` (use the next free number — run `ls supabase/migrations | sort | tail -3` to find it)

- [ ] **Step 1: Write the migration**

```sql
-- <NNN>: HYROX-TC.1 — Hyrox Training Club. Two tables:
--   hyrox_blocks   — one AI-designed 12-week periodised arc per location/intake.
--   hyrox_sessions — each planned session under a block (coach-facing detail +
--                    TV board + review status). Maps to a real HYROX class at
--                    publish time by location_id + week_no + slot (weekday), NOT
--                    by glofox_event_id (which Glofox re-mints per attempt).
-- RLS mirrors class_occurrences (mig 284): authenticated SELECT for own
-- locations; all writes are service-role.

BEGIN;

CREATE TABLE IF NOT EXISTS public.hyrox_blocks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id        uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  title              text,
  starts_on          date NOT NULL,                 -- week 1 Monday (Dublin calendar date)
  weeks              int  NOT NULL DEFAULT 12,
  sessions_per_week  int  NOT NULL DEFAULT 2,        -- Stillorgan runs 2/week
  session_weekdays   smallint[] NOT NULL,            -- ISO weekday per slot (Mon=1..Sun=7); Stillorgan {3,7}
  difficulty_dial    text NOT NULL DEFAULT 'mixed'
    CHECK (difficulty_dial IN ('beginner_heavy','mixed','competitive')),
  auto_tune_enabled  boolean NOT NULL DEFAULT false, -- §8.3 toggle: when true, the auto-tune signal feeds generation (signal computation is Phase 2)
  arc                jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','archived')),
  generated_by       text,                           -- model id + prompt version for provenance
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_hyrox_blocks_loc_active
  ON public.hyrox_blocks (location_id, status);

CREATE TABLE IF NOT EXISTS public.hyrox_sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  block_id       uuid NOT NULL REFERENCES public.hyrox_blocks(id) ON DELETE CASCADE,
  location_id    uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE, -- denormalised for RLS/scoping
  week_no        int  NOT NULL,
  slot           int  NOT NULL,
  phase          text NOT NULL CHECK (phase IN ('base','build','peak','taper')),
  focus          text,
  is_benchmark   boolean NOT NULL DEFAULT false,
  full_session   jsonb NOT NULL DEFAULT '{}'::jsonb,  -- coach-facing: warmup/strength/main/finisher/cues/why
  board          jsonb NOT NULL DEFAULT '{}'::jsonb,  -- TV-facing: title/format/cap/stations(per-tier)/target
  status         text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','approved','published')),
  approved_by    uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  approved_at    timestamptz,
  published_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hyrox_sessions_unique UNIQUE (block_id, week_no, slot)
);

CREATE INDEX IF NOT EXISTS idx_hyrox_sessions_loc_status
  ON public.hyrox_sessions (location_id, status);

ALTER TABLE public.hyrox_blocks   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hyrox_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hyrox_blocks_location_scoped_select" ON public.hyrox_blocks;
CREATE POLICY "hyrox_blocks_location_scoped_select" ON public.hyrox_blocks
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

DROP POLICY IF EXISTS "hyrox_sessions_location_scoped_select" ON public.hyrox_sessions;
CREATE POLICY "hyrox_sessions_location_scoped_select" ON public.hyrox_sessions
  FOR SELECT TO authenticated
  USING (private.auth_is_in_location(location_id));

COMMENT ON TABLE public.hyrox_blocks IS
  'Hyrox Training Club 12-week periodised arc per location/intake (HYROX-TC.1). arc holds the AI-designed weekly phase/stimulus map. Writes service-role only.';
COMMENT ON TABLE public.hyrox_sessions IS
  'Planned Hyrox sessions under a block (HYROX-TC.1). full_session = coach-facing; board = TV-facing. Maps to a HYROX class by location_id + week_no + slot. Writes service-role only.';

COMMIT;
```

- [ ] **Step 2: Apply via Supabase MCP**

Apply with `apply_migration` (name `hyrox_training_club`) against ref `iyvtbjjxdggiadzwwvdj`. Then run `get_advisors(type=security)` and confirm **no new** ERROR/WARN rows for these two tables (expect none — the SELECT-only RLS mirrors the cleared `class_occurrences` pattern).

- [ ] **Step 3: Verify the tables exist**

Run `list_tables` (or `execute_sql: select column_name,data_type from information_schema.columns where table_name='hyrox_blocks' order by ordinal_position`). Expected: all columns above present, `session_weekdays` = `ARRAY`, `auto_tune_enabled` = `boolean`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/<NNN>_hyrox_training_club.sql
git commit -m "HYROX-TC.1 — hyrox_blocks + hyrox_sessions tables (RLS, service-role writes)"
```

---

## Task 2: Constants + charter

**Files:**
- Create: `src/lib/hyrox/constants.js`

- [ ] **Step 1: Write the constants module**

```js
// HYROX-TC.1 — domain constants + the operator-editable workout design charter.
// The charter is the default; the generator accepts an override read from
// settings in a later plan (spec §4.4 "operator-editable").

export const HYROX_STATIONS = [
  'SkiErg', 'Sled push', 'Sled pull', 'Burpee broad jump',
  'Row', 'Farmers carry', 'Sandbag lunge', 'Wall balls',
]

export const TIERS = ['performance', 'elite']       // spec: no Foundation
export const PHASES = ['base', 'build', 'peak', 'taper']
export const DIFFICULTY_DIALS = ['beginner_heavy', 'mixed', 'competitive']

export const DEFAULT_CAP_MINUTES = 45

// No em-dashes anywhere the model might echo into member-facing strings
// (estate rule: em-dash = AI tell in customer copy).
export const DEFAULT_CHARTER = [
  'Every session must be tough, challenging, but doable, and always fun.',
  '',
  'Tough and challenging: a real stimulus for the week\'s phase and energy system,',
  'genuine Hyrox work (running plus stations, compromised running), honest intensity,',
  'and week-on-week progressive overload so the block visibly builds. Never a token session.',
  '',
  'But doable: completable inside the 45-minute cap by BOTH tiers; movements that are safe',
  'and coachable for a mixed drop-in class; volume and pacing that let people finish strong,',
  'not get buried. Performance must be achievable for a committed regular; Elite stretches',
  'the strong. Every session names a realistic target or stimulus.',
  '',
  'Always fun: this is the retention lever, so it is non-negotiable. Vary the format and',
  'stations week to week, lean on formats that create energy in the room (partners, relays,',
  'teams, ladders, races against the clock, the occasional novelty station), and keep a',
  'competitive spark. A member should leave wanting the next one.',
].join('\n')
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/hyrox/constants.js
git commit -m "HYROX-TC.1 — hyrox domain constants + default workout charter"
```

---

## Task 3: zod schemas (validate the model's output)

**Files:**
- Create: `src/lib/hyrox/schema.js`
- Test: `src/lib/hyrox/schema.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { arcSchema, sessionSchema, parseArc, parseSession } from './schema'

const validWeek = { week_no: 1, phase: 'base', stimulus: 'Aerobic base', is_benchmark: false, progression: 'RPE 6-7, build volume' }
const validArc = { weeks: 12, dial: 'mixed', plan: [validWeek] }

const validSession = {
  week_no: 5, slot: 1, phase: 'build', focus: 'Engine', is_benchmark: false,
  full_session: { warmup: 'row + drills', main: '4 RFT', cues: ['brace'], why: 'engine block; race energy' },
  board: {
    location_label: 'UN1T STILLORGAN', week_label: 'WEEK 5 / 12', focus: 'ENGINE',
    format: '4 ROUNDS FOR TIME', cap_minutes: 45,
    stations: [{ name: 'Run', performance: '400m', elite: '500m' }],
    target: 'Target sub-32:00',
  },
}

describe('arcSchema', () => {
  it('accepts a valid arc and defaults wordmark on the board', () => {
    expect(parseArc(validArc).ok).toBe(true)
    const s = parseSession(validSession)
    expect(s.ok).toBe(true)
    expect(s.data.board.wordmark).toBe('HYROX TRAINING CLUB')
  })
  it('rejects an unknown phase', () => {
    const bad = { ...validSession, phase: 'endurance' }
    expect(parseSession(bad).ok).toBe(false)
  })
  it('rejects a station missing the elite tier', () => {
    const bad = { ...validSession, board: { ...validSession.board, stations: [{ name: 'Run', performance: '400m' }] } }
    expect(parseSession(bad).ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `npx vitest run src/lib/hyrox/schema.test.js`
Expected: FAIL — `./schema` has no export `parseArc`.

- [ ] **Step 3: Write the schema module**

```js
// HYROX-TC.1 — zod schemas for the model's structured output. Never trust the
// model raw; parse* returns {ok, data} | {ok:false, error} so callers can retry.
import { z } from 'zod'
import { PHASES, DIFFICULTY_DIALS, DEFAULT_CAP_MINUTES } from './constants'

export const stationSchema = z.object({
  name: z.string().min(1),
  performance: z.string().min(1),
  elite: z.string().min(1),
})

export const boardSchema = z.object({
  wordmark: z.string().min(1).default('HYROX TRAINING CLUB'),
  location_label: z.string().min(1),
  week_label: z.string().min(1),
  focus: z.string().min(1),
  format: z.string().min(1),
  cap_minutes: z.number().int().positive().default(DEFAULT_CAP_MINUTES),
  stations: z.array(stationSchema).min(1),
  target: z.string().min(1),
})

export const fullSessionSchema = z.object({
  warmup: z.string().min(1),
  strength: z.string().nullish(),
  main: z.string().min(1),
  finisher: z.string().nullish(),
  cues: z.array(z.string()).default([]),
  why: z.string().min(1),
})

export const sessionSchema = z.object({
  week_no: z.number().int().min(1),
  slot: z.number().int().min(1),
  phase: z.enum(PHASES),
  focus: z.string().min(1),
  is_benchmark: z.boolean().default(false),
  full_session: fullSessionSchema,
  board: boardSchema,
})

export const weekPlanSchema = z.object({
  week_no: z.number().int().min(1),
  phase: z.enum(PHASES),
  stimulus: z.string().min(1),
  is_benchmark: z.boolean().default(false),
  progression: z.string().min(1),
})

export const arcSchema = z.object({
  weeks: z.number().int().positive(),
  dial: z.enum(DIFFICULTY_DIALS),
  plan: z.array(weekPlanSchema).min(1),
})

function wrap(schema, value) {
  const r = schema.safeParse(value)
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error }
}
export const parseArc = (v) => wrap(arcSchema, v)
export const parseSession = (v) => wrap(sessionSchema, v)
```

- [ ] **Step 4: Run it — expect pass**

Run: `npx vitest run src/lib/hyrox/schema.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/hyrox/schema.js src/lib/hyrox/schema.test.js
git commit -m "HYROX-TC.1 — zod schemas + parse helpers for arc/session output"
```

---

## Task 4: Dublin-safe date mapping

**Files:**
- Create: `src/lib/hyrox/mapping.js`
- Test: `src/lib/hyrox/mapping.test.js`

> The estate invariant: `class_occurrences.starts_at` is UTC ISO; block `starts_on` is a Dublin calendar date. Compute weekday/week in **Dublin**, and test under both `TZ=Europe/Dublin` and a US TZ. If `@/lib/dublin-time` already exports a Dublin-weekday or day-diff helper, reuse it instead of the private copies below (DRY) — check first.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { dublinDateStr, dublinWeekday, weekNoFor, slotFor } from './mapping'

describe('hyrox mapping (Dublin-safe)', () => {
  // 2026-07-22 is a Wednesday. 21:30 UTC is still Wed in Dublin (BST +1).
  it('reads the Dublin weekday for an evening instant', () => {
    expect(dublinDateStr('2026-07-22T21:30:00Z')).toBe('2026-07-22')
    expect(dublinWeekday('2026-07-22T21:30:00Z')).toBe(3) // Wed
  })
  // 2026-07-26 is a Sunday.
  it('maps weekday to slot via session_weekdays', () => {
    expect(slotFor([3, 7], '2026-07-22T18:00:00Z')).toBe(1) // Wed -> slot 1
    expect(slotFor([3, 7], '2026-07-26T10:00:00Z')).toBe(2) // Sun -> slot 2
    expect(slotFor([3, 7], '2026-07-24T18:00:00Z')).toBe(null) // Fri -> not a session day
  })
  it('computes week_no from the block start Monday', () => {
    // Block starts Mon 2026-07-20. Wed of week 1:
    expect(weekNoFor('2026-07-20', '2026-07-22T18:00:00Z', 12)).toBe(1)
    // Sun 2026-08-02 is 13 days after the Mon 2026-07-20 start: floor(13/7)+1 = week 2.
    expect(weekNoFor('2026-07-20', '2026-08-02T10:00:00Z', 12)).toBe(2)
    expect(weekNoFor('2026-07-20', '2026-07-19T10:00:00Z', 12)).toBe(null) // before start
    expect(weekNoFor('2026-07-20', '2026-11-01T10:00:00Z', 12)).toBe(null) // past week 12
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `TZ=America/New_York npx vitest run src/lib/hyrox/mapping.test.js`
Expected: FAIL — `./mapping` not implemented.

- [ ] **Step 3: Write the mapping module**

```js
// HYROX-TC.1 — pure Dublin-safe mapping from a class occurrence (UTC ISO) to
// (week_no, slot) within a block. No mutation, no IO. See @/lib/dublin-time —
// reuse its helpers if present rather than these copies.

const DUBLIN = 'Europe/Dublin'

/** YYYY-MM-DD in Dublin for an ISO instant, or null. */
export function dublinDateStr(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DUBLIN, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

/** ISO weekday 1..7 (Mon..Sun) for a YYYY-MM-DD string (pure calendar math). */
export function isoWeekdayOf(ymd) {
  const [y, m, day] = ymd.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, day, 12)).getUTCDay() // 0..6 Sun..Sat, noon avoids DST edges
  return dow === 0 ? 7 : dow
}

/** Dublin ISO weekday (1..7) for an ISO instant, or null. */
export function dublinWeekday(iso) {
  const ymd = dublinDateStr(iso)
  return ymd ? isoWeekdayOf(ymd) : null
}

/** Whole-day difference b - a between two YYYY-MM-DD strings. */
export function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000)
}

/** 1-based week number for an occurrence; null if before start or past `weeks`. */
export function weekNoFor(startsOn, occurrenceIso, weeks) {
  const ymd = dublinDateStr(occurrenceIso)
  if (!ymd) return null
  const diff = daysBetween(startsOn, ymd)
  if (diff < 0) return null
  const wk = Math.floor(diff / 7) + 1
  if (weeks && wk > weeks) return null
  return wk
}

/** 1-based slot from session_weekdays (e.g. [3,7]); null if not a session day. */
export function slotFor(sessionWeekdays, occurrenceIso) {
  const wd = dublinWeekday(occurrenceIso)
  if (wd == null) return null
  const idx = sessionWeekdays.indexOf(wd)
  return idx === -1 ? null : idx + 1
}
```

- [ ] **Step 4: Run under both timezones — expect pass**

Run: `TZ=America/New_York npx vitest run src/lib/hyrox/mapping.test.js && TZ=Europe/Dublin npx vitest run src/lib/hyrox/mapping.test.js`
Expected: PASS in both.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hyrox/mapping.js src/lib/hyrox/mapping.test.js
git commit -m "HYROX-TC.1 — Dublin-safe week_no/slot mapping"
```

---

## Task 5: Prompt builders (charter as hard constraints)

**Files:**
- Create: `src/lib/hyrox/prompt.js`
- Test: `src/lib/hyrox/prompt.test.js`

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { buildArcPrompt, buildExpansionPrompt } from './prompt'
import { DEFAULT_CHARTER } from './constants'

const input = { weeks: 12, sessionsPerWeek: 2, dial: 'mixed', locationLabel: 'UN1T STILLORGAN', charter: DEFAULT_CHARTER }

describe('prompt builders', () => {
  it('arc prompt embeds the charter, dial, and a JSON-only instruction', () => {
    const { system, user } = buildArcPrompt(input)
    expect(system).toContain('tough, challenging, but doable, and always fun')
    expect(user).toContain('mixed')
    expect(system.toLowerCase()).toContain('json')
    expect(system).not.toContain('—') // no em-dashes leak into member-facing strings
  })
  it('expansion prompt carries the week stimulus and the two tiers only', () => {
    const week = { week_no: 5, phase: 'build', stimulus: 'Engine', progression: 'add a round', is_benchmark: false }
    const { system, user } = buildExpansionPrompt({ ...input, week, slot: 1, autoTuneSignal: null })
    expect(user).toContain('Engine')
    expect(system.toLowerCase()).toContain('performance')
    expect(system.toLowerCase()).toContain('elite')
    expect(system.toLowerCase()).not.toContain('foundation')
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `npx vitest run src/lib/hyrox/prompt.test.js`
Expected: FAIL — no `buildArcPrompt` export.

- [ ] **Step 3: Write the prompt module**

```js
// HYROX-TC.1 — pure prompt builders. Return { system, user } content strings
// for the Anthropic Messages API. The charter is stated as HARD constraints and
// the model is told to self-check against it and return JSON only.
import { HYROX_STATIONS, TIERS, PHASES, DEFAULT_CAP_MINUTES, DEFAULT_CHARTER } from './constants'

const JSON_ONLY = 'Return ONLY valid JSON matching the requested shape. No prose, no code fences.'
const NO_EMDASH = 'Never use em-dashes or en-dashes in any member-facing string (title, focus, target). Use plain punctuation.'

function charterBlock(charter) {
  return ['WORKOUT DESIGN CHARTER (hard constraints — self-check every session against all three before returning):', charter || DEFAULT_CHARTER].join('\n')
}

export function buildArcPrompt({ weeks = 12, sessionsPerWeek = 2, dial = 'mixed', charter } = {}) {
  const system = [
    'You are a Hyrox strength-and-conditioning coach designing a periodised training block for a gym class.',
    `Design a ${weeks}-week arc across the phases: ${PHASES.join(' -> ')} (base -> build -> peak -> taper).`,
    `The Hyrox stations available: ${HYROX_STATIONS.join(', ')}, plus running and compromised running.`,
    charterBlock(charter),
    'Include benchmark weeks (a Hyrox-style test) so progress is measurable.',
    'Output shape: { "weeks": number, "dial": string, "plan": [ { "week_no", "phase", "stimulus", "is_benchmark", "progression" } ] }.',
    NO_EMDASH,
    JSON_ONLY,
  ].join('\n\n')
  const user = `Design the arc. weeks=${weeks}, sessions_per_week=${sessionsPerWeek}, difficulty_dial=${dial}.`
  return { system, user }
}

export function buildExpansionPrompt({ week, slot = 1, dial = 'mixed', locationLabel = 'UN1T', charter, autoTuneSignal = null } = {}) {
  const capLine = `Every session MUST be completable within a ${DEFAULT_CAP_MINUTES}-minute cap by both tiers.`
  const tuneLine = autoTuneSignal
    ? `Auto-tune signal for this week (adjust difficulty accordingly): ${JSON.stringify(autoTuneSignal)}.`
    : 'No auto-tune signal; build difficulty from the phase, stimulus, and dial only.'
  const system = [
    'You are a Hyrox coach writing ONE class session that fits an existing periodised arc.',
    `Scale to exactly two tiers: ${TIERS.join(' and ')} (no Foundation tier). Performance is achievable for a committed regular; Elite stretches the strong.`,
    `Stations available: ${HYROX_STATIONS.join(', ')}, plus running and compromised running.`,
    capLine,
    charterBlock(charter),
    'Output shape: a single session object { week_no, slot, phase, focus, is_benchmark, full_session:{warmup,strength,main,finisher,cues[],why}, board:{location_label,week_label,focus,format,cap_minutes,stations:[{name,performance,elite}],target} }.',
    'The "why" must state both the training stimulus AND what makes the session engaging.',
    NO_EMDASH,
    JSON_ONLY,
  ].join('\n\n')
  const user = [
    `Location label: ${locationLabel}. Dial: ${dial}. Slot: ${slot}.`,
    `Week ${week?.week_no} (${week?.phase}) stimulus: ${week?.stimulus}. Progression target: ${week?.progression}. Benchmark week: ${Boolean(week?.is_benchmark)}.`,
    tuneLine,
  ].join('\n')
  return { system, user }
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `npx vitest run src/lib/hyrox/prompt.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/hyrox/prompt.js src/lib/hyrox/prompt.test.js
git commit -m "HYROX-TC.1 — arc + expansion prompt builders (charter as hard constraints)"
```

---

## Task 6: Generation IO (call + validate + retry)

**Files:**
- Create: `src/lib/hyrox/generate.js`
- Test: `src/lib/hyrox/generate.test.js`

> Model the Anthropic call on `src/lib/agent/auto-reply.js` (`ANTHROPIC_API_URL`, header `x-api-key: process.env.ANTHROPIC_API_KEY`, `anthropic-version: 2023-06-01`, body `{ model, max_tokens, system, messages }`). Keep it injectable (`fetchImpl`) so tests never hit the network. **Confirm the model id** against the current model list (see the `claude-api` skill) before relying on it — generation is batch, so a higher tier than Mia's chat model is acceptable (spec §9). Reuse the estate's model constant if one is exported rather than hardcoding a new literal.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect, vi } from 'vitest'
import { generateArc, expandSession } from './generate'

function fakeFetch(payloadText) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: payloadText }] }),
  }))
}

const goodArc = JSON.stringify({ weeks: 12, dial: 'mixed', plan: [{ week_no: 1, phase: 'base', stimulus: 'base', is_benchmark: false, progression: 'build volume' }] })

describe('generateArc', () => {
  it('parses and returns a validated arc', async () => {
    const res = await generateArc({ weeks: 12, sessionsPerWeek: 2, dial: 'mixed' }, { fetchImpl: fakeFetch(goodArc), apiKey: 'k' })
    expect(res.ok).toBe(true)
    expect(res.data.plan[0].phase).toBe('base')
  })
  it('retries once on invalid JSON then fails cleanly', async () => {
    const f = fakeFetch('not json at all')
    const res = await generateArc({ weeks: 12, sessionsPerWeek: 2, dial: 'mixed' }, { fetchImpl: f, apiKey: 'k' })
    expect(res.ok).toBe(false)
    expect(f).toHaveBeenCalledTimes(2) // one retry
  })
})
```

- [ ] **Step 2: Run it — expect fail**

Run: `npx vitest run src/lib/hyrox/generate.test.js`
Expected: FAIL — no `generateArc` export.

- [ ] **Step 3: Write the generation module**

```js
// HYROX-TC.1 — the ONE IO seam. Calls the Anthropic Messages API, extracts the
// text, parses JSON, validates with the hyrox schema, retries ONCE on failure.
// fetchImpl + apiKey are injectable so this is testable without a network.
import { buildArcPrompt, buildExpansionPrompt } from './prompt'
import { parseArc, parseSession } from './schema'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'
// Confirm against the current model list (claude-api skill). Batch generation
// can afford a higher tier than Mia's chat model (spec §9).
const HYROX_MODEL = 'claude-sonnet-4-6'

async function callClaude({ system, user, maxTokens = 1500, fetchImpl = fetch, apiKey = process.env.ANTHROPIC_API_KEY }) {
  if (!apiKey) return { ok: false, error: new Error('missing ANTHROPIC_API_KEY') }
  const res = await fetchImpl(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: HYROX_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  })
  if (!res.ok) return { ok: false, error: new Error(`anthropic ${res.status}`) }
  const data = await res.json()
  const text = Array.isArray(data?.content) ? data.content.filter((b) => b?.type === 'text').map((b) => b.text).join('') : ''
  return { ok: true, text }
}

function tryJson(text) {
  try { return JSON.parse(text) } catch { return null }
}

// Generic: build -> call -> parse-json -> validate, with ONE retry.
async function generateValidated({ system, user, maxTokens, validate, opts }) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const call = await callClaude({ system, user, maxTokens, ...opts })
    if (!call.ok) { if (attempt === 1) return call; continue }
    const parsed = validate(tryJson(call.text) ?? {})
    if (parsed.ok) return parsed
    if (attempt === 1) return { ok: false, error: parsed.error }
  }
  return { ok: false, error: new Error('unreachable') }
}

export async function generateArc(input, opts = {}) {
  const { system, user } = buildArcPrompt(input)
  return generateValidated({ system, user, maxTokens: 1500, validate: parseArc, opts })
}

export async function expandSession(input, opts = {}) {
  const { system, user } = buildExpansionPrompt(input)
  return generateValidated({ system, user, maxTokens: 2000, validate: parseSession, opts })
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `npx vitest run src/lib/hyrox/generate.test.js`
Expected: PASS (2 tests) — the retry test proves `fetchImpl` was called twice.

- [ ] **Step 5: Commit**

```bash
git add src/lib/hyrox/generate.js src/lib/hyrox/generate.test.js
git commit -m "HYROX-TC.1 — Anthropic generation IO with validate-and-retry"
```

---

## Task 7: Full suite + CI mirror

- [ ] **Step 1: Run the whole hyrox suite**

Run: `TZ=Europe/Dublin npx vitest run src/lib/hyrox/`
Expected: PASS (all files).

- [ ] **Step 2: Run the six-check CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`
Expected: all pass. (No new API route yet, so route-guards is unaffected; `src/lib/hyrox` is not imported by `mobile/`, so parity/imports are unaffected.)

- [ ] **Step 3: Final commit if the mirror produced any fixups**

```bash
git commit -am "HYROX-TC.1 — foundation: lint/format fixups" --allow-empty
```

---

## Self-review notes (author)

- **Spec coverage:** §3 tables (Task 1) ✓ · §4.1 arc+expansion strategy (Tasks 5-6) ✓ · §4.2 Anthropic pattern reuse (Task 6) ✓ · §4.4 charter embedded + operator-editable default (Tasks 2, 5) ✓ · §8.2 dial as generation input (Tasks 1, 5, 6) ✓ · §8.3 `auto_tune_enabled` column + no-op `autoTuneSignal` param (Tasks 1, 5, 6) ✓. Deferred by design: §5 (Plan 02), §6/§7/§8.1 (Plan 03).
- **Type consistency:** the session/board/arc field names in the zod schema (Task 3), the prompt "output shape" (Task 5), and the DB jsonb columns (Task 1) all use the same keys (`full_session`, `board`, `stations[].performance/elite`, `week_no`, `slot`, `phase`, `is_benchmark`).
- **Open build decision carried in:** the model id (`HYROX_MODEL`, Task 6) — confirm via the claude-api skill; reuse the estate's exported constant if there is one.
- **Not yet wired (correct for Plan 01):** nothing writes `hyrox_blocks`/`hyrox_sessions` rows yet — persistence, the `/admin/hyrox` planner, and the generate-a-block trigger are Plan 02. This plan delivers a tested pure library + the tables it will fill.
