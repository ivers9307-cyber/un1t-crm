# Hyrox House Style + Example Sessions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]`.

**Goal:** Make the Hyrox generator produce sessions in UN1T's own style by feeding it an operator-editable house-style playbook + real example sessions (few-shot), all per-location and prompt-cached.

**Architecture:** Pure context injection — no model tech, no migration. Two new keys on `locations.settings.hyrox` (`house_style`, `style_examples[]`); a `styleBlock` folds house style into the arc + session prompts and example sessions into the session prompt as few-shot (capped); a `/admin/hyrox` panel + `PUT /api/hyrox/settings` manage them; a "Save as style example" button snapshots a generated session into the example library.

**Tech stack:** Next.js 16 · Supabase (service-role routes) · zod ^4 · vitest ^4 · Anthropic Messages API (prompt-cached).

**Spec:** `docs/superpowers/specs/2026-07-23-hyrox-house-style-design.md`. Branch `hyrox-house-style` off `main`. No migration; no new permission (reuses `approvals_hyrox_sessions`).

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/hyrox/constants.js` (edit) | `MAX_STYLE_EXAMPLES`, `MAX_EXAMPLE_CHARS`, `MAX_STORED_EXAMPLES` |
| `src/lib/hyrox/settings.js` (edit +test) | `resolveHyroxSettings` → `{ charter, houseStyle, styleExamples }` |
| `src/lib/hyrox/example-text.js` (+test) | `sessionToExampleText(session)` — render a session to compact coaching text |
| `src/lib/hyrox/prompt.js` (edit +test) | `styleBlock`; house style in arc+session prompts; examples few-shot in session prompt (capped) |
| `src/lib/hyrox/generate.js` (edit) | thread `houseStyle`/`styleExamples` from input into the prompt builders |
| `src/lib/hyrox/generate-block.js` (edit) | thread `houseStyle`/`styleExamples` through create/expand |
| `src/app/api/hyrox/blocks/route.js` (edit) | pass resolved houseStyle/styleExamples down |
| `src/app/api/hyrox/blocks/[id]/expand/route.js` (edit) | same |
| `src/app/api/hyrox/sessions/[id]/regenerate/route.js` (edit) | same |
| `src/app/api/hyrox/settings/route.js` (create) | `PUT` house style + charter + examples |
| `src/app/api/hyrox/sessions/[id]/exemplar/route.js` (create) | `POST` snapshot session → style_examples |
| `src/lib/openapi.js` (edit) | register the 2 routes |
| `src/app/admin/hyrox/HyroxPlanner.jsx` (edit) | "House style & examples" panel + "Save as style example" |

---

## Task 1: caps + settings resolver

**Files:** `src/lib/hyrox/constants.js`, `src/lib/hyrox/settings.js`, `src/lib/hyrox/settings.test.js`

- [ ] **Step 1: Add caps to `constants.js`** (append):
```js
// House-style example limits (HYROX-STYLE): how many/how long examples feed a
// generation, and the max stored so the settings blob can't grow unbounded.
export const MAX_STYLE_EXAMPLES = 3
export const MAX_EXAMPLE_CHARS = 2500
export const MAX_STORED_EXAMPLES = 20
```

- [ ] **Step 2: Extend the failing test** — add to `src/lib/hyrox/settings.test.js`:
```js
import { resolveHyroxSettings } from './settings'

describe('resolveHyroxSettings house style + examples', () => {
  it('defaults house style to empty and examples to []', () => {
    const s = resolveHyroxSettings({})
    expect(s.houseStyle).toBe('')
    expect(s.styleExamples).toEqual([])
  })
  it('reads house style and a well-formed examples array', () => {
    const loc = { settings: { hyrox: { house_style: 'Partner relays, loud cueing.', style_examples: [
      { id: 'a', source: 'pasted', label: 'Wed engine', text: 'run 500m then...', added_at: '2026-07-01T00:00:00Z' },
    ] } } }
    const s = resolveHyroxSettings(loc)
    expect(s.houseStyle).toBe('Partner relays, loud cueing.')
    expect(s.styleExamples).toHaveLength(1)
    expect(s.styleExamples[0].text).toContain('run 500m')
  })
  it('drops malformed example entries (no text)', () => {
    const loc = { settings: { hyrox: { style_examples: [{ id: 'x' }, { text: 'ok text', source: 'pasted' }] } } }
    expect(resolveHyroxSettings(loc).styleExamples).toHaveLength(1)
  })
})
```

- [ ] **Step 3: Run — expect fail** (`npx vitest run src/lib/hyrox/settings.test.js`).

- [ ] **Step 4: Rewrite `settings.js`:**
```js
// HYROX-TC.2 / HYROX-STYLE — operator-editable Hyrox settings on
// locations.settings.hyrox, resolved with code defaults.
import { DEFAULT_CHARTER } from './constants'

export function resolveHyroxSettings(loc) {
  const h = loc?.settings?.hyrox || {}
  const charter = typeof h.charter === 'string' && h.charter.trim() ? h.charter : DEFAULT_CHARTER
  const houseStyle = typeof h.house_style === 'string' ? h.house_style.trim() : ''
  const styleExamples = Array.isArray(h.style_examples)
    ? h.style_examples.filter((e) => e && typeof e.text === 'string' && e.text.trim())
    : []
  return { charter, houseStyle, styleExamples }
}
```

- [ ] **Step 5: Run — expect pass.**

- [ ] **Step 6: Commit** (`HYROX-STYLE — settings resolver: house style + examples`).

---

## Task 2: `sessionToExampleText`

**Files:** `src/lib/hyrox/example-text.js`, `src/lib/hyrox/example-text.test.js`

- [ ] **Step 1: Write the failing test:**
```js
import { describe, it, expect } from 'vitest'
import { sessionToExampleText } from './example-text'

const session = {
  week_no: 5, slot: 1, phase: 'build', focus: 'Engine',
  full_session: { warmup: 'row 500m + drills', strength: null, main: '4 rounds for time', finisher: '200m cool down', cues: ['brace', 'smooth pace'], why: 'engine block' },
  board: { format: '4 ROUNDS FOR TIME', cap_minutes: 45, target: 'sub-32', stations: [{ name: 'Run', performance: '400m', elite: '500m' }, { name: 'Wall balls', performance: '9kg x 20', elite: '9kg x 25' }] },
}

describe('sessionToExampleText', () => {
  it('renders a compact readable coaching text block', () => {
    const t = sessionToExampleText(session)
    expect(t).toContain('Engine')
    expect(t).toContain('Warmup: row 500m')
    expect(t).toContain('Main: 4 rounds for time')
    expect(t).toContain('brace')
    expect(t).toContain('Run: Performance 400m / Elite 500m')
    expect(t).not.toContain('{')  // not JSON
  })
  it('skips empty optional sections', () => {
    const t = sessionToExampleText(session)
    expect(t).not.toContain('Strength:')  // strength was null
  })
})
```

- [ ] **Step 2: Run — expect fail.**

- [ ] **Step 3: Write `example-text.js`:**
```js
// HYROX-STYLE — render a generated session into a compact plain-text block used
// as a few-shot "style example". Pure; no JSON, coaching-readable.
export function sessionToExampleText(session) {
  const fs = session?.full_session || {}
  const b = session?.board || {}
  const lines = []
  lines.push(`Week ${session?.week_no} session ${session?.slot} (${session?.phase || ''}) — ${session?.focus || ''}`.trim())
  if (fs.warmup) lines.push(`Warmup: ${fs.warmup}`)
  if (fs.strength) lines.push(`Strength: ${fs.strength}`)
  if (fs.main) lines.push(`Main: ${fs.main}`)
  if (fs.finisher) lines.push(`Finisher: ${fs.finisher}`)
  if (Array.isArray(fs.cues) && fs.cues.length) lines.push(`Cues: ${fs.cues.join('; ')}`)
  if (b.format || b.cap_minutes || b.target) {
    lines.push(`Board: ${[b.format, b.cap_minutes ? `cap ${b.cap_minutes} min` : null, b.target].filter(Boolean).join(' · ')}`)
  }
  if (Array.isArray(b.stations) && b.stations.length) {
    lines.push('Stations:')
    for (const st of b.stations) lines.push(`  ${st.name}: Performance ${st.performance} / Elite ${st.elite}`)
  }
  if (fs.why) lines.push(`Why: ${fs.why}`)
  return lines.join('\n')
}
```

- [ ] **Step 4: Run — expect pass.**

- [ ] **Step 5: Commit** (`HYROX-STYLE — sessionToExampleText renderer`).

---

## Task 3: prompt injection (style block + few-shot)

**Files:** `src/lib/hyrox/prompt.js`, `src/lib/hyrox/prompt.test.js`

- [ ] **Step 1: Add failing tests** to `prompt.test.js`:
```js
it('folds house style into both arc and expansion prompts', () => {
  const houseStyle = 'We run partner relays and cue loudly.'
  expect(buildArcPrompt({ weeks: 12, sessionsPerWeek: 2, dial: 'mixed', houseStyle }).system).toContain('partner relays')
  const week = { week_no: 5, phase: 'build', stimulus: 'Engine', progression: 'x', is_benchmark: false }
  expect(buildExpansionPrompt({ week, houseStyle }).system).toContain('partner relays')
})
it('injects capped few-shot example sessions into the expansion prompt', () => {
  const week = { week_no: 5, phase: 'build', stimulus: 'Engine', progression: 'x', is_benchmark: false }
  const styleExamples = [
    { text: 'EXAMPLE-ONE run 500m' }, { text: 'EXAMPLE-TWO sled push' }, { text: 'EXAMPLE-THREE wall balls' }, { text: 'EXAMPLE-FOUR should be dropped' },
  ]
  const { system } = buildExpansionPrompt({ week, styleExamples })
  expect(system).toContain('EXAMPLE-ONE')
  expect(system).toContain('EXAMPLE-THREE')
  expect(system).not.toContain('EXAMPLE-FOUR')  // capped at MAX_STYLE_EXAMPLES=3
})
it('truncates an over-long example', () => {
  const week = { week_no: 1, phase: 'base', stimulus: 's', progression: 'p', is_benchmark: false }
  const long = 'x'.repeat(5000)
  const { system } = buildExpansionPrompt({ week, styleExamples: [{ text: long }] })
  expect(system).not.toContain('x'.repeat(3000))  // truncated below MAX_EXAMPLE_CHARS=2500
})
```

- [ ] **Step 2: Run — expect fail.**

- [ ] **Step 3: Edit `prompt.js`.** Add the import + `styleBlock` and thread the params.
  - Import: `import { HYROX_STATIONS, TIERS, PHASES, DEFAULT_CAP_MINUTES, DEFAULT_CHARTER, MAX_STYLE_EXAMPLES, MAX_EXAMPLE_CHARS } from './constants'`
  - Replace `charterBlock` usage with a combined `styleBlock`:
```js
function styleBlock(charter, houseStyle) {
  const parts = ['WORKOUT DESIGN CHARTER (hard constraints, self-check every session against all three before returning):', charter || DEFAULT_CHARTER]
  if (houseStyle && houseStyle.trim()) {
    parts.push('UN1T HOUSE STYLE (follow this — how this gym actually runs its classes):', houseStyle.trim())
  }
  return parts.join('\n')
}
function examplesBlock(styleExamples) {
  const items = (Array.isArray(styleExamples) ? styleExamples : [])
    .slice(0, MAX_STYLE_EXAMPLES)
    .map((e) => String(e?.text || '').slice(0, MAX_EXAMPLE_CHARS))
    .filter((t) => t.trim())
  if (!items.length) return null
  return ['EXAMPLE SESSIONS in UN1T\'s style — match their structure, format, and coaching voice; do not copy them verbatim:', items.join('\n\n---\n\n')].join('\n\n')
}
```
  - `buildArcPrompt({ weeks, sessionsPerWeek, dial, charter, houseStyle })` — replace `charterBlock(charter)` with `styleBlock(charter, houseStyle)`.
  - `buildExpansionPrompt({ week, slot, dial, locationLabel, charter, houseStyle, styleExamples, autoTuneSignal })` — replace `charterBlock(charter)` with `styleBlock(charter, houseStyle)`, and add the examples block into the `system` array when non-null (place it after the charter/style block, before JSON_ONLY):
```js
    styleBlock(charter, houseStyle),
    ...(examplesBlock(styleExamples) ? [examplesBlock(styleExamples)] : []),
```
  Keep the existing `charterBlock` function only if still referenced; otherwise remove it (replaced by `styleBlock`). Remove the now-unused `charterBlock` to avoid a lint warning.

- [ ] **Step 4: Run — expect pass** (`npx vitest run src/lib/hyrox/prompt.test.js`; the existing charter/no-em-dash tests must still pass).

- [ ] **Step 5: Commit** (`HYROX-STYLE — styleBlock + few-shot example injection`).

---

## Task 4: thread through generation

**Files:** `src/lib/hyrox/generate.js`, `src/lib/hyrox/generate-block.js`

- [ ] **Step 1: `generate.js`** — `generateArc(input)` and `expandSession(input)` already spread their prompt inputs. Confirm `buildArcPrompt`/`buildExpansionPrompt` receive `houseStyle`/`styleExamples` when present on `input`: `generateArc` calls `buildArcPrompt(input)` — pass `houseStyle` via input. `expandSession` calls `buildExpansionPrompt(input)` — pass `houseStyle` + `styleExamples` via input. No code change needed if they already forward `input` verbatim; **verify** buildArcPrompt is called with the whole input object (it is: `const { system, user } = buildArcPrompt(input)`), so callers just need to include the new keys in `input`. No edit here beyond confirming.

- [ ] **Step 2: `generate-block.js`** — thread the fields:
  - `createBlockWithArc(db, { input, charter, houseStyle, caller })` — pass `houseStyle` into the `generateArc({ ..., charter, houseStyle }, { caller })` call.
  - `expandBlockWeek(db, { block, weekNo, charter, houseStyle, styleExamples, caller, locationLabel })` — pass `houseStyle` + `styleExamples` into `expandSession({ ..., charter, houseStyle, styleExamples }, { caller })`.

- [ ] **Step 3: Run the hyrox suite** (`TZ=Europe/Dublin npx vitest run src/lib/hyrox/`) — all pass (existing generate-block tests still pass; new fields are optional).

- [ ] **Step 4: Commit** (`HYROX-STYLE — thread house style + examples through generation`).

---

## Task 5: routes read + pass settings

**Files:** `src/app/api/hyrox/blocks/route.js`, `src/app/api/hyrox/blocks/[id]/expand/route.js`, `src/app/api/hyrox/sessions/[id]/regenerate/route.js`

- [ ] **Step 1:** In each route, where it already does `const charter = resolveHyroxSettings(loc).charter` (or similar), change to destructure all three and pass them down:
  - `blocks/route.js`: `const { charter, houseStyle } = resolveHyroxSettings(loc)` → `createBlockWithArc(db, { input: {...}, charter, houseStyle, caller })`.
  - `blocks/[id]/expand/route.js`: `const { charter, houseStyle, styleExamples } = resolveHyroxSettings(loc)` → `expandBlockWeek(db, { block, weekNo, charter, houseStyle, styleExamples, caller, locationLabel })`.
  - `sessions/[id]/regenerate/route.js`: `const { charter, houseStyle, styleExamples } = resolveHyroxSettings(loc)` → pass `houseStyle` + `styleExamples` into its `expandSession(...)` call.

- [ ] **Step 2: Verify** (`npm run check:route-guards && npm run build`).

- [ ] **Step 3: Commit** (`HYROX-STYLE — routes thread house style into generation`).

---

## Task 6: `PUT /api/hyrox/settings`

**Files:** `src/app/api/hyrox/settings/route.js`, `src/lib/openapi.js`

- [ ] **Step 1: Write the route** (mirror `src/app/api/settings/scoring/route.js` read-modify-write + the per-location grant gate from the hyrox session routes):
```js
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { uuidLike } from '@/lib/schemas'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { MAX_STORED_EXAMPLES, MAX_EXAMPLE_CHARS } from '@/lib/hyrox/constants'

export const dynamic = 'force-dynamic'

const ExampleSchema = z.object({
  id: z.string().max(64).optional(),
  source: z.enum(['pasted', 'generated']).default('pasted'),
  label: z.string().max(120).optional(),
  text: z.string().min(1).max(MAX_EXAMPLE_CHARS),
  added_at: z.string().optional(),
})
const SettingsSchema = z.object({
  location_id: uuidLike,
  charter: z.string().max(8000).nullish(),
  house_style: z.string().max(8000).nullish(),
  style_examples: z.array(ExampleSchema).max(MAX_STORED_EXAMPLES).optional(),
})

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const v = await validateBody(request, SettingsSchema)
  if (!v.ok) return v.response
  const body = v.data
  if (!hasPermissionForLocation(user, body.location_id, APPROVAL_CATEGORY_PERMISSION.hyrox_sessions)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const db = createServerClient()
  const { data: loc } = await db.from('locations').select('id, settings').eq('id', body.location_id).single()
  const settings = { ...(loc?.settings || {}) }
  const hyrox = { ...(settings.hyrox || {}) }
  if (body.charter !== undefined) hyrox.charter = body.charter || null
  if (body.house_style !== undefined) hyrox.house_style = body.house_style || null
  if (body.style_examples !== undefined) hyrox.style_examples = body.style_examples
  settings.hyrox = hyrox
  const { error } = await db.from('locations').update({ settings }).eq('id', body.location_id).select('id').single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: { hyrox } })
}
```

- [ ] **Step 2: Register in `openapi.js`** (post `/api/hyrox/settings`, tag `Hyrox`, the SettingsSchema body, `{ success, data }`).

- [ ] **Step 3: Verify** (`npm run check:route-guards && npm run build`).

- [ ] **Step 4: Commit** (`HYROX-STYLE — PUT /api/hyrox/settings`).

---

## Task 7: `POST /api/hyrox/sessions/[id]/exemplar`

**Files:** `src/app/api/hyrox/sessions/[id]/exemplar/route.js`, `src/lib/openapi.js`

- [ ] **Step 1: Write the route** (mirror the session detail routes' auth/404 posture; renders the session server-side + appends, dedupe by session id, cap):
```js
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { hasPermissionForLocation } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'
import { sessionToExampleText } from '@/lib/hyrox/example-text'
import { MAX_STORED_EXAMPLES } from '@/lib/hyrox/constants'

export const dynamic = 'force-dynamic'

export async function POST(request, { params }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()
  const { data: session } = await db.from('hyrox_sessions').select('*').eq('id', id).maybeSingle()
  if (!session) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  if (!hasPermissionForLocation(user, session.location_id, APPROVAL_CATEGORY_PERMISSION.hyrox_sessions)) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  }
  const { data: loc } = await db.from('locations').select('id, name, settings').eq('id', session.location_id).single()
  const settings = { ...(loc?.settings || {}) }
  const hyrox = { ...(settings.hyrox || {}) }
  const existing = Array.isArray(hyrox.style_examples) ? hyrox.style_examples : []
  const exampleId = `session:${session.id}`
  if (existing.some((e) => e?.id === exampleId)) {
    return NextResponse.json({ success: true, data: { added: false, reason: 'already_saved' } })
  }
  const entry = { id: exampleId, source: 'generated', label: `Week ${session.week_no} session ${session.slot}${session.focus ? ` — ${session.focus}` : ''}`, text: sessionToExampleText(session), added_at: new Date().toISOString() }
  hyrox.style_examples = [entry, ...existing].slice(0, MAX_STORED_EXAMPLES)
  settings.hyrox = hyrox
  const { error } = await db.from('locations').update({ settings }).eq('id', session.location_id).select('id').single()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  return NextResponse.json({ success: true, data: { added: true } })
}
```

- [ ] **Step 2: Register in `openapi.js`.**

- [ ] **Step 3: Verify** (`npm run check:route-guards && npm run build`).

- [ ] **Step 4: Commit** (`HYROX-STYLE — POST .../exemplar (star as style example)`).

---

## Task 8: planner UI — panel + star button

**Files:** `src/app/admin/hyrox/HyroxPlanner.jsx` (loader `page.js` passes `initialSettings` from `resolveHyroxSettings`)

- [ ] **Step 1:** In `src/app/admin/hyrox/page.js`, load the location settings and pass `initialSettings={resolveHyroxSettings(loc)}` (fetch `locations.select('settings')` for `locationId`) to `<HyroxPlanner>`.

- [ ] **Step 2:** In `HyroxPlanner.jsx`, add a collapsible **"House style & examples"** section (shown when `canManage`), above the grid:
  - A `house_style` textarea + a `charter` textarea (seeded from `initialSettings`), and an example list (label + snippet + remove ×) with an "Add example" paste box (label + text) that appends a `{ source:'pasted' }` entry client-side.
  - A **Save** button → `PUT /api/hyrox/settings` with `{ location_id: locationId, charter, house_style, style_examples }`.
  - Every non-submit `<button>` gets `type="button"`. Use `@/components/ui` primitives; chips (if any) use `bg-*-500/10 text-*-700`.
- [ ] **Step 3:** In the review drawer footer, add a **"Save as style example"** button (`type="button"`, not shown when the session is unusable) → `POST /api/hyrox/sessions/${focusedSession.id}/exemplar`; on success show a brief confirmation and refresh settings.

- [ ] **Step 4: Verify** (`npm run build && npm run lint && npm run check:guardrails`).

- [ ] **Step 5: Commit** (`HYROX-STYLE — /admin/hyrox house-style panel + save-as-example`).

---

## Task 9: full CI mirror + build

- [ ] **Step 1:** `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && npm run build` — all green.
- [ ] **Step 2:** (Optional, needs a key) `npm run eval:agent` — confirm a generation with a house style + examples still parses and reflects the style.
- [ ] **Step 3: Commit** any fixups.

---

## Self-review notes (author)
- **Spec coverage:** §3 data model (Tasks 1) ✓ · §4 prompt injection + caps (Tasks 3-5) ✓ · §5 operator surface + PUT route (Tasks 6, 8) ✓ · §6 star-as-example (Tasks 2, 7, 8) ✓ · §7 guardrails (Tasks 1, 3, 6, 7) ✓. Approvals-learning + AI-distilled profile correctly out of scope.
- **No migration; no new permission** (reuses `approvals_hyrox_sessions`).
- **Type consistency:** `resolveHyroxSettings` returns `{ charter, houseStyle, styleExamples }` (camelCase) everywhere in code; the JSONB keys are snake_case (`house_style`, `style_examples`) — the resolver is the single translation point. Example entry shape `{ id, source, label, text, added_at }` is consistent across the settings route, exemplar route, and the resolver filter.
- **Verify-before-relying:** confirm each generation route's current `resolveHyroxSettings(...)` call site before editing; confirm `@shared/permissions` alias (used by the existing session routes).
