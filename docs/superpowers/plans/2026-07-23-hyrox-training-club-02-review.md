# Hyrox Training Club — Plan 02: coach review + generate-a-block

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps use `- [ ]`.

**Goal:** Turn the Plan 01 library into a usable coach workflow: a manager can generate a 12-week block (arc + the first weeks of sessions written to the DB), review/edit/approve/regenerate each session in a new `/admin/hyrox` planner, and see pending sessions in the approvals inbox — all before anything publishes to a TV.

**Architecture:** No new tables (Plan 01's `hyrox_blocks`/`hyrox_sessions` + a `hyrox` key on `locations.settings` for the operator-editable charter). New service-role `/api/hyrox/*` routes (the tables are SELECT-only for browsers, so all writes go through routes, per the estate's route-skeleton). A new approvals **provider** surfaces `draft` sessions. Generation is metered through `anthropicMessages`. Pure helpers (settings resolve, block/session row builders, provider item mapping) are unit-tested; route/DB IO is thin.

**Tech stack:** Next.js 16 App Router · Supabase (service-role routes) · zod ^4 · vitest ^4 · `anthropicMessages` wrapper.

**Spec coverage:** §5 (coach review/approve + `/admin/hyrox` planner + provider + permission), the "generate a block" trigger, §4.1 (arc up front + expand a rolling window — here the initial window), §4.4 (charter operator-editable via `locations.settings.hyrox.charter`), §8.2/§8.3 (dial + `auto_tune_enabled` as block inputs; auto-tune signal still a no-op). Deferred to Plan 03: the auto-publish cron, the `generated` portrait TV board, and the rolling-expansion cron that fills weeks beyond the initial window.

**Before you start:** you are on branch `hyrox-training-club-02-review` (worktree `~/code/un1t-crm-hyrox`), already off merged `main` (Plan 01 present in `src/lib/hyrox/`). No migration in this plan. Register every new route in `src/lib/openapi.js`. Run the six-check CI mirror + `npm run build` before finishing (a new route/page needs the build).

---

## File structure

| File | Responsibility |
|---|---|
| `shared/permissions.js` (edit) | New `approvals_hyrox_sessions` grant: `WEB_PERMISSIONS`, `APPROVAL_CATEGORY_PERMISSION`, all 6 role blocks |
| `scripts/check-mobile-parity.mjs` (edit) | Parity coverage for the new key (mirror the existing `approvals_*` keys) |
| `src/lib/hyrox/settings.js` (+test) | `resolveHyroxSettings(loc)` → charter with code default |
| `src/lib/hyrox/plan-block.js` (+test) | Pure builders: `weeksToExpand`, `blockRowFrom`, `sessionRowFrom`, `slotsForWeek` |
| `src/lib/hyrox/generate.js` (edit +test) | Add optional injectable `caller` (so the route can meter via `anthropicMessages`) |
| `src/lib/hyrox/generate-block.js` | Server orchestration: arc → insert block → expand window → insert sessions (thin IO) |
| `src/lib/anthropic.js` (edit) | Add `'hyrox_generation'` to the `source` enum |
| `src/app/api/hyrox/blocks/route.js` | `POST` generate + persist a block |
| `src/app/api/hyrox/sessions/[id]/route.js` | `PUT` edit/approve a session |
| `src/app/api/hyrox/sessions/[id]/regenerate/route.js` | `POST` regenerate one session |
| `src/lib/approvals/providers/hyrox-sessions.js` (+test) | Approvals provider for `draft` sessions |
| `src/lib/approvals/registry.js` (edit) | Register the provider |
| `src/lib/openapi.js` (edit) | Register the 3 routes |
| `src/app/admin/hyrox/page.js` | Planner loader (Server Component) |
| `src/app/admin/hyrox/HyroxPlanner.jsx` | Planner client: grid + generate form + review drawer |
| `src/lib/nav-items.js` (edit) | Sidebar entry under Studio Management |
| `src/app/admin/layout.js` (edit) | Add key to `ADMIN_CHILD_PERMS` |
| `src/app/admin/page.js` (edit) | Studio-tools hub tile |

---

## Task 1: the `approvals_hyrox_sessions` permission grant

**Files:** `shared/permissions.js`, `scripts/check-mobile-parity.mjs`

- [ ] **Step 1: Add the grant to `shared/permissions.js`.** Three edits, mirroring the existing `approvals_agent_requests` key exactly:
  1. In `WEB_PERMISSIONS`, next to the other `group: 'approvals'` entries (~lines 160-165), add:
     ```js
     { key: 'approvals_hyrox_sessions', group: 'approvals', label: '⋯ Hyrox sessions', hint: 'Review and approve AI-generated Hyrox Training Club sessions before they publish to the studio TV.' },
     ```
  2. In `APPROVAL_CATEGORY_PERMISSION` (~lines 216-223), add: `hyrox_sessions: 'approvals_hyrox_sessions',` (this auto-flows into `APPROVAL_SUBPERMISSION_KEYS` and the `approvals_inbox` derivation).
  3. In **every** role block of `DEFAULT_WEB_PERMISSIONS_BY_ROLE` add `approvals_hyrox_sessions: <bool>` — `master: true`, `owner: true`, `manager: true`, `head_coach: true`, `staff: false`, `reception: false` (coach-facing; same defaults as `approvals_agent_requests`).

- [ ] **Step 2: Satisfy `check:mobile-parity`.** Grep how the existing `approvals_agent_requests` key passes the parity linter:
  ```bash
  grep -n "approvals_agent_requests\|approvals_" scripts/check-mobile-parity.mjs
  ```
  Add `approvals_hyrox_sessions` the **same way** the other `approvals_*` per-category keys are covered (they are web-only surfaces, so almost certainly a `WEB_ONLY_OK` entry — add `approvals_hyrox_sessions: 'Coach review of AI-generated Hyrox sessions lives in the /admin/hyrox desktop planner; the mobile app has no counterpart yet.'`). Whatever mechanism covers the sibling keys, mirror it.

- [ ] **Step 3: Run the permission + parity checks.**
  Run: `npx vitest run shared/ && npm run check:mobile-parity`
  Expected: PASS. (The permission tests iterate every role × key, so a missing role entry fails — that's your coverage that Step 1 is complete.)

- [ ] **Step 4: Commit.**
  ```bash
  git add shared/permissions.js scripts/check-mobile-parity.mjs
  git commit -m "HYROX-TC.2 — approvals_hyrox_sessions permission grant"
  ```

---

## Task 2: charter settings resolver (operator-editable, with default)

**Files:** `src/lib/hyrox/settings.js`, `src/lib/hyrox/settings.test.js`

- [ ] **Step 1: Write the failing test.**
  ```js
  import { describe, it, expect } from 'vitest'
  import { resolveHyroxSettings } from './settings'
  import { DEFAULT_CHARTER } from './constants'

  describe('resolveHyroxSettings', () => {
    it('falls back to the default charter when unset', () => {
      expect(resolveHyroxSettings({}).charter).toBe(DEFAULT_CHARTER)
      expect(resolveHyroxSettings(null).charter).toBe(DEFAULT_CHARTER)
      expect(resolveHyroxSettings({ settings: {} }).charter).toBe(DEFAULT_CHARTER)
    })
    it('uses a non-empty operator override', () => {
      const loc = { settings: { hyrox: { charter: 'Be brutal but brief.' } } }
      expect(resolveHyroxSettings(loc).charter).toBe('Be brutal but brief.')
    })
    it('ignores a blank override', () => {
      const loc = { settings: { hyrox: { charter: '   ' } } }
      expect(resolveHyroxSettings(loc).charter).toBe(DEFAULT_CHARTER)
    })
  })
  ```

- [ ] **Step 2: Run — expect fail** (`npx vitest run src/lib/hyrox/settings.test.js`).

- [ ] **Step 3: Write `settings.js`.**
  ```js
  // HYROX-TC.2 — operator-editable Hyrox settings on locations.settings.hyrox,
  // resolved with a code default (estate "settings field + default fallback").
  import { DEFAULT_CHARTER } from './constants'

  export function resolveHyroxSettings(loc) {
    const h = loc?.settings?.hyrox || {}
    const charter = typeof h.charter === 'string' && h.charter.trim() ? h.charter : DEFAULT_CHARTER
    return { charter }
  }
  ```

- [ ] **Step 4: Run — expect pass.**

- [ ] **Step 5: Commit** (`HYROX-TC.2 — hyrox settings resolver (charter default fallback)`).

---

## Task 3: pure block/session row builders

**Files:** `src/lib/hyrox/plan-block.js`, `src/lib/hyrox/plan-block.test.js`

- [ ] **Step 1: Write the failing test.**
  ```js
  import { describe, it, expect } from 'vitest'
  import { weeksToExpand, slotsForWeek, blockRowFrom, sessionRowFrom } from './plan-block'

  const arc = { weeks: 12, dial: 'mixed', plan: [
    { week_no: 1, phase: 'base', stimulus: 'Aerobic base', is_benchmark: true, progression: 'RPE 6-7' },
    { week_no: 2, phase: 'base', stimulus: 'Volume', is_benchmark: false, progression: 'add a round' },
    { week_no: 3, phase: 'build', stimulus: 'Threshold', is_benchmark: false, progression: 'heavier sled' },
  ] }

  describe('plan-block builders', () => {
    it('weeksToExpand returns the first N week plans, clamped', () => {
      expect(weeksToExpand(arc, 2).map(w => w.week_no)).toEqual([1, 2])
      expect(weeksToExpand(arc, 99).map(w => w.week_no)).toEqual([1, 2, 3])
    })
    it('slotsForWeek returns 1..sessions_per_week', () => {
      expect(slotsForWeek(2)).toEqual([1, 2])
    })
    it('blockRowFrom builds a persistable block', () => {
      const row = blockRowFrom({ location_id: 'loc1', starts_on: '2026-08-03', weeks: 12, sessions_per_week: 2, session_weekdays: [3, 7], difficulty_dial: 'mixed', auto_tune_enabled: false, title: 'Autumn' }, arc, 'user1', 'claude-x')
      expect(row).toMatchObject({ location_id: 'loc1', starts_on: '2026-08-03', session_weekdays: [3, 7], difficulty_dial: 'mixed', auto_tune_enabled: false, status: 'active', generated_by: 'claude-x' })
      expect(row.arc).toEqual(arc)
    })
    it('sessionRowFrom maps an expanded session into a draft row', () => {
      const expanded = { week_no: 1, slot: 1, phase: 'base', focus: 'Engine', is_benchmark: true, full_session: { warmup: 'w', main: 'm', cues: [], why: 'y' }, board: { location_label: 'X', week_label: 'W1', focus: 'ENGINE', format: '4 RFT', cap_minutes: 45, stations: [{ name: 'Run', performance: '400m', elite: '500m' }], target: 'sub-32' } }
      const row = sessionRowFrom('block1', 'loc1', expanded)
      expect(row).toMatchObject({ block_id: 'block1', location_id: 'loc1', week_no: 1, slot: 1, phase: 'base', focus: 'Engine', is_benchmark: true, status: 'draft' })
      expect(row.full_session).toEqual(expanded.full_session)
      expect(row.board).toEqual(expanded.board)
    })
  })
  ```

- [ ] **Step 2: Run — expect fail.**

- [ ] **Step 3: Write `plan-block.js`.**
  ```js
  // HYROX-TC.2 — pure builders that turn generated output into persistable rows.
  // No IO. The route inserts what these return.

  export function weeksToExpand(arc, window) {
    const plan = Array.isArray(arc?.plan) ? arc.plan : []
    const n = Math.max(0, Math.min(window ?? plan.length, plan.length))
    return plan.slice(0, n)
  }

  export function slotsForWeek(sessionsPerWeek) {
    const n = Math.max(1, Number(sessionsPerWeek) || 1)
    return Array.from({ length: n }, (_, i) => i + 1)
  }

  export function blockRowFrom(input, arc, userId, modelId) {
    return {
      location_id: input.location_id,
      title: input.title ?? null,
      starts_on: input.starts_on,
      weeks: input.weeks ?? 12,
      sessions_per_week: input.sessions_per_week ?? 2,
      session_weekdays: input.session_weekdays,
      difficulty_dial: input.difficulty_dial ?? 'mixed',
      auto_tune_enabled: Boolean(input.auto_tune_enabled),
      arc,
      status: 'active',
      generated_by: modelId ?? null,
    }
  }

  export function sessionRowFrom(blockId, locationId, expanded) {
    return {
      block_id: blockId,
      location_id: locationId,
      week_no: expanded.week_no,
      slot: expanded.slot,
      phase: expanded.phase,
      focus: expanded.focus ?? null,
      is_benchmark: Boolean(expanded.is_benchmark),
      full_session: expanded.full_session,
      board: expanded.board,
      status: 'draft',
    }
  }
  ```

- [ ] **Step 4: Run — expect pass.**

- [ ] **Step 5: Commit** (`HYROX-TC.2 — pure block/session row builders`).

---

## Task 4: injectable metered caller in generate.js

**Files:** `src/lib/hyrox/generate.js` (edit), `src/lib/hyrox/generate.test.js` (edit), `src/lib/anthropic.js` (edit)

> Why: the route must meter tokens per tenant via `anthropicMessages`. `generate.js` currently hardcodes its raw-fetch `callClaude`. Make the caller injectable (default unchanged) so the route can pass a metered caller and tests can pass a fake.

- [ ] **Step 1: Add a failing test** to `generate.test.js` proving an injected `caller` is used instead of `fetchImpl`:
  ```js
  it('uses an injected caller when provided (bypasses fetch)', async () => {
    const calls = []
    const caller = async ({ system, user, maxTokens }) => { calls.push({ system, user, maxTokens }); return { ok: true, text: goodArc } }
    const noFetch = () => { throw new Error('fetch must not be called') }
    const res = await generateArc({ weeks: 12, sessionsPerWeek: 2, dial: 'mixed' }, { caller, fetchImpl: noFetch, apiKey: 'k' })
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].system).toContain('tough, challenging, but doable, and always fun')
  })
  ```

- [ ] **Step 2: Run — expect fail** (caller ignored today).

- [ ] **Step 3: Edit `generate.js`** so `generateValidated` prefers an injected caller:
  In `generateValidated`, replace `const call = await callClaude({ system, user, maxTokens, ...opts })` with:
  ```js
  const call = opts.caller
    ? await opts.caller({ system, user, maxTokens })
    : await callClaude({ system, user, maxTokens, ...opts })
  ```
  (Leave `callClaude` and its `fetchImpl`/`apiKey` path exactly as-is for the default/test cases.)

- [ ] **Step 4: Run — expect pass** (this test + all existing generate tests).

- [ ] **Step 5: Add the meter source.** In `src/lib/anthropic.js`, add `'hyrox_generation'` to the `source` enum comment/type near line 28 (a comment-level enum — just add the literal so the call site is documented). Confirm `anthropicMessages(body, meta)` accepts `{ apiKey, locationId, source }`.

- [ ] **Step 6: Commit** (`HYROX-TC.2 — injectable metered caller for hyrox generation`).

---

## Task 5: generate-block orchestration (server, thin IO)

**Files:** `src/lib/hyrox/generate-block.js`

> Not unit-tested (it does IO); the pure pieces it composes are already tested (Tasks 3-4). Keep it thin.

- [ ] **Step 1: Write `generate-block.js`.**
  ```js
  // HYROX-TC.2 — server orchestration: arc -> insert block -> expand the initial
  // window of sessions -> insert draft sessions. `caller` is the metered
  // anthropic caller injected by the route. Returns { ok, block, sessionsCreated } | { ok:false, error }.
  import { generateArc, expandSession } from './generate'
  import { HYROX_MODEL } from './generate'
  import { weeksToExpand, slotsForWeek, blockRowFrom, sessionRowFrom } from './plan-block'

  export async function generateBlock(db, { input, charter, caller, expandWeeks = 2 }) {
    const arcRes = await generateArc(
      { weeks: input.weeks ?? 12, sessionsPerWeek: input.sessions_per_week ?? 2, dial: input.difficulty_dial ?? 'mixed', charter },
      { caller },
    )
    if (!arcRes.ok) return { ok: false, error: 'arc_generation_failed' }
    const arc = arcRes.data

    const { data: block, error: blockErr } = await db
      .from('hyrox_blocks')
      .insert(blockRowFrom(input, arc, input.created_by, HYROX_MODEL))
      .select('*')
      .single()
    if (blockErr || !block) return { ok: false, error: blockErr?.message || 'block_insert_failed' }

    const rows = []
    for (const week of weeksToExpand(arc, expandWeeks)) {
      for (const slot of slotsForWeek(input.sessions_per_week ?? 2)) {
        const sRes = await expandSession(
          { week, slot, dial: input.difficulty_dial ?? 'mixed', locationLabel: input.location_label || 'UN1T', charter, autoTuneSignal: null },
          { caller },
        )
        if (sRes.ok) rows.push(sessionRowFrom(block.id, input.location_id, { ...sRes.data, week_no: week.week_no, slot }))
      }
    }
    if (rows.length) {
      const { error: sessErr } = await db.from('hyrox_sessions').insert(rows)
      if (sessErr) return { ok: false, error: sessErr.message, block }
    }
    return { ok: true, block, sessionsCreated: rows.length }
  }
  ```
  (Export `HYROX_MODEL` from `generate.js` if it is not already exported — add `export` to its declaration.)

- [ ] **Step 2: Commit** (`HYROX-TC.2 — generate-block server orchestration`).

---

## Task 6: `POST /api/hyrox/blocks`

**Files:** `src/app/api/hyrox/blocks/route.js`, `src/lib/openapi.js` (edit)

- [ ] **Step 1: Write the route** (mirror `src/app/api/schedule/blocks/route.js` skeleton).
  ```js
  import { NextResponse } from 'next/server'
  import { z } from 'zod'
  import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
  import { createServerClient } from '@/lib/supabase'
  import { validateBody } from '@/lib/validate'
  import { uuidLike, isoDate, MANAGER_ROLES } from '@/lib/schemas'
  import { anthropicMessages } from '@/lib/anthropic'
  import { resolveHyroxSettings } from '@/lib/hyrox/settings'
  import { generateBlock } from '@/lib/hyrox/generate-block'
  import { DIFFICULTY_DIALS } from '@/lib/hyrox/constants'

  export const dynamic = 'force-dynamic'
  export const maxDuration = 300

  const BlockCreateSchema = z.object({
    location_id: uuidLike,
    starts_on: isoDate,
    title: z.string().max(120).optional(),
    weeks: z.number().int().min(1).max(24).optional(),
    sessions_per_week: z.number().int().min(1).max(7).optional(),
    session_weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    difficulty_dial: z.enum(DIFFICULTY_DIALS).optional(),
    auto_tune_enabled: z.boolean().optional(),
    charter: z.string().max(8000).optional(),
    expand_weeks: z.number().int().min(1).max(12).optional(),
  })

  export async function POST(request) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    if (!MANAGER_ROLES.includes(user.role)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

    const v = await validateBody(request, BlockCreateSchema)
    if (!v.ok) return v.response
    const body = v.data

    const guard = assertLocationAccess(user, body.location_id)
    if (guard) return guard

    const db = createServerClient()
    const { data: loc } = await db.from('locations').select('id, name, settings').eq('id', body.location_id).single()
    const charter = body.charter?.trim() || resolveHyroxSettings(loc).charter

    const caller = async ({ system, user: userMsg, maxTokens }) => {
      const { res, data } = await anthropicMessages(
        { model: undefined, max_tokens: maxTokens, system, messages: [{ role: 'user', content: userMsg }] },
        { locationId: body.location_id, source: 'hyrox_generation' },
      )
      if (!res.ok) return { ok: false, error: `anthropic_${res.status}` }
      const text = (data?.content || []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
      return { ok: true, text }
    }

    const out = await generateBlock(db, {
      input: { ...body, created_by: user.id, location_label: (loc?.name || 'UN1T').toUpperCase() },
      charter,
      caller,
      expandWeeks: body.expand_weeks ?? 2,
    })
    if (!out.ok) return NextResponse.json({ success: false, error: out.error }, { status: 502 })
    return NextResponse.json({ success: true, data: { block: out.block, sessionsCreated: out.sessionsCreated } }, { status: 201 })
  }
  ```
  Note: `anthropicMessages` needs a real `model`. Pass the hyrox model explicitly — import `HYROX_MODEL` from `@/lib/hyrox/generate` and use it as `model` instead of `undefined`.

- [ ] **Step 2: Register in `src/lib/openapi.js`** following the existing `registry.registerPath({...})` pattern (method `post`, path `/api/hyrox/blocks`, tag `Hyrox`, the `BlockCreateSchema` as request body, a `{ success, data }` response).

- [ ] **Step 3: Verify guards + build.**
  Run: `npm run check:route-guards && npm run build`
  Expected: route-guards passes (the route has `getCurrentUser`); build compiles the new route.

- [ ] **Step 4: Commit** (`HYROX-TC.2 — POST /api/hyrox/blocks (generate + persist)`).

---

## Task 7: `PUT /api/hyrox/sessions/[id]` + regenerate

**Files:** `src/app/api/hyrox/sessions/[id]/route.js`, `src/app/api/hyrox/sessions/[id]/regenerate/route.js`, `src/lib/openapi.js` (edit)

- [ ] **Step 1: Write the edit/approve route** (mirror `src/app/api/agent/membership-requests/[id]/route.js`).
  ```js
  import { NextResponse } from 'next/server'
  import { z } from 'zod'
  import { getCurrentUser, hasPermissionForLocation } from '@/lib/auth' // hasPermissionForLocation is in @/lib/permissions — import from there
  import { createServerClient } from '@/lib/supabase'
  import { validateBody } from '@/lib/validate'
  import { APPROVAL_CATEGORY_PERMISSION } from '@shared/permissions'

  export const dynamic = 'force-dynamic'

  const UpdateSchema = z.object({
    focus: z.string().max(200).nullish(),
    full_session: z.record(z.any()).optional(),
    board: z.record(z.any()).optional(),
    status: z.enum(['draft', 'approved']).optional(),
  })

  export async function PUT(request, { params }) {
    const { id } = await params
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

    const db = createServerClient()
    const { data: row } = await db.from('hyrox_sessions').select('id, location_id, status').eq('id', id).single()
    if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

    if (!hasPermissionForLocation(user, row.location_id, APPROVAL_CATEGORY_PERMISSION.hyrox_sessions)) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    }
    if (row.status === 'published') return NextResponse.json({ success: false, error: 'Already published' }, { status: 409 })

    const v = await validateBody(request, UpdateSchema)
    if (!v.ok) return v.response
    const b = v.data

    const patch = {}
    if (b.focus !== undefined) patch.focus = b.focus
    if (b.full_session !== undefined) patch.full_session = b.full_session
    if (b.board !== undefined) patch.board = b.board
    if (b.status === 'approved') { patch.status = 'approved'; patch.approved_by = user.id; patch.approved_at = new Date().toISOString() }
    if (b.status === 'draft') { patch.status = 'draft'; patch.approved_by = null; patch.approved_at = null }

    const { data, error } = await db.from('hyrox_sessions').update(patch).eq('id', id).select('*').single()
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
    return NextResponse.json({ success: true, data })
  }
  ```
  Correctness note: `hasPermissionForLocation` lives in `@/lib/permissions` (not `@/lib/auth`) — import it from the right module (the map showed `src/lib/permissions.js:126`). Verify before running.

- [ ] **Step 2: Write the regenerate route** — loads the session + its block (for the week's arc plan + dial), rebuilds the metered caller (same closure as Task 6), calls `expandSession` for that `week_no`/`slot`, and on success updates `full_session` + `board`, forcing `status: 'draft'`. Same auth/permission/404 gates as Step 1. Returns `{ success, data }`.
  ```js
  // key body after the same auth+404+permission gates:
  const { data: block } = await db.from('hyrox_blocks').select('arc, difficulty_dial').eq('id', row.block_id).single()
  const week = (block?.arc?.plan || []).find((w) => w.week_no === row.week_no)
  if (!week) return NextResponse.json({ success: false, error: 'No arc week' }, { status: 409 })
  const caller = /* same metered closure as blocks route, locationId = row.location_id */
  const sRes = await expandSession({ week, slot: row.slot, dial: block.difficulty_dial, locationLabel: 'UN1T', charter: resolveHyroxSettings(loc).charter, autoTuneSignal: null }, { caller })
  if (!sRes.ok) return NextResponse.json({ success: false, error: 'regeneration_failed' }, { status: 502 })
  const { data, error } = await db.from('hyrox_sessions').update({ full_session: sRes.data.full_session, board: sRes.data.board, status: 'draft', approved_by: null, approved_at: null }).eq('id', id).select('*').single()
  ```
  (Load `row` with `block_id, week_no, slot, location_id, status` in the initial select; load `loc` settings for the charter.)

- [ ] **Step 3: Register both routes in `src/lib/openapi.js`.**

- [ ] **Step 4: Verify** (`npm run check:route-guards && npm run build`).

- [ ] **Step 5: Commit** (`HYROX-TC.2 — session edit/approve + regenerate routes`).

---

## Task 8: approvals provider

**Files:** `src/lib/approvals/providers/hyrox-sessions.js`, `src/lib/approvals/providers/hyrox-sessions.test.js`, `src/lib/approvals/registry.js` (edit)

- [ ] **Step 1: Write the failing test** (mock `db` returning draft rows; assert the ApprovalItem shape).
  ```js
  import { describe, it, expect } from 'vitest'
  import { hyroxSessionsProvider } from './hyrox-sessions'

  function fakeDb(rows) {
    const q = { _f: {}, select() { return this }, eq() { return this }, order() { return this }, limit() { return Promise.resolve({ data: rows, error: null }) } }
    return { from() { return q } }
  }
  const user = { activeLocation: { id: 'loc1' } }

  describe('hyroxSessionsProvider', () => {
    it('has the right config', () => {
      expect(hyroxSessionsProvider.key).toBe('hyrox_sessions')
      expect(hyroxSessionsProvider.permissionKey).toBe('approvals_hyrox_sessions')
      expect(hyroxSessionsProvider.reviewBase).toBe('/admin/hyrox')
    })
    it('maps draft sessions to approval items', async () => {
      const db = fakeDb([{ id: 's1', week_no: 5, slot: 1, phase: 'build', focus: 'Engine', created_at: '2026-08-01T00:00:00Z' }])
      const { count, items } = await hyroxSessionsProvider.fetchPending(db, user)
      expect(count).toBe(1)
      expect(items[0]).toMatchObject({ id: 's1', reviewUrl: '/admin/hyrox?focus=s1' })
      expect(items[0].title).toContain('Week 5')
    })
    it('returns empty with no active location', async () => {
      const { count, items } = await hyroxSessionsProvider.fetchPending(fakeDb([]), {})
      expect(count).toBe(0); expect(items).toEqual([])
    })
  })
  ```

- [ ] **Step 2: Run — expect fail.**

- [ ] **Step 3: Write the provider** (mirror `contractor-invoices.js`).
  ```js
  import { viewerActiveLocationId } from '../registry'

  export const hyroxSessionsProvider = {
    key: 'hyrox_sessions',
    permissionKey: 'approvals_hyrox_sessions',
    label: 'Hyrox sessions',
    reviewBase: '/admin/hyrox',

    async fetchPending(db, user) {
      const activeId = viewerActiveLocationId(user)
      if (!activeId) return { count: 0, items: [] }
      const { data, error } = await db
        .from('hyrox_sessions')
        .select('id, week_no, slot, phase, focus, created_at, location_id')
        .eq('status', 'draft')
        .eq('location_id', activeId)
        .order('week_no', { ascending: true })
        .limit(50)
      if (error) throw new Error(`hyrox_sessions: ${error.message}`)
      const items = (data || []).map((r) => ({
        id: r.id,
        title: `Week ${r.week_no} · session ${r.slot}${r.focus ? ` — ${r.focus}` : ''}`,
        subtitle: `${r.phase} phase · awaiting coach approval`,
        meta: 'Hyrox Training Club',
        submittedAt: r.created_at,
        amount: null,
        currency: null,
        reviewUrl: `/admin/hyrox?focus=${r.id}`,
      }))
      return { count: items.length, items }
    },

    async countPending(db, user) {
      const activeId = viewerActiveLocationId(user)
      if (!activeId) return 0
      const { count, error } = await db
        .from('hyrox_sessions')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'draft')
        .eq('location_id', activeId)
      if (error) throw new Error(`hyrox_sessions count: ${error.message}`)
      return count || 0
    },
  }
  ```

- [ ] **Step 4: Register** in `src/lib/approvals/registry.js`: import `hyroxSessionsProvider` and add it to the `APPROVALS_PROVIDERS` array (end is fine).

- [ ] **Step 5: Run — expect pass** (`npx vitest run src/lib/approvals/`).

- [ ] **Step 6: Commit** (`HYROX-TC.2 — hyrox-sessions approvals provider`).

---

## Task 9: the `/admin/hyrox` planner page

**Files:** `src/app/admin/hyrox/page.js`, `src/app/admin/hyrox/HyroxPlanner.jsx`, `src/lib/nav-items.js` (edit), `src/app/admin/layout.js` (edit), `src/app/admin/page.js` (edit)

- [ ] **Step 1: Write the loader** `src/app/admin/hyrox/page.js` (mirror `admin/tv-displays/page.js`).
  ```js
  import { createServerClient } from '@/lib/supabase'
  import { getCurrentUser } from '@/lib/auth'
  import { hasPermission } from '@/lib/permissions'
  import { redirect } from 'next/navigation'
  import HyroxPlanner from './HyroxPlanner'

  export const dynamic = 'force-dynamic'

  export default async function HyroxAdmin() {
    const user = await getCurrentUser()
    if (!user) redirect('/login')
    if (!hasPermission(user, 'approvals_hyrox_sessions')) {
      return <div className="p-6"><p className="text-sm text-un1t-subtle">You don&apos;t have access to Hyrox planning.</p></div>
    }
    const locationId = user.activeLocation?.id
    if (!locationId) redirect('/')

    const db = createServerClient()
    const { data: block } = await db.from('hyrox_blocks').select('*').eq('location_id', locationId).eq('status', 'active').order('starts_on', { ascending: false }).limit(1).maybeSingle()
    const { data: sessions } = block
      ? await db.from('hyrox_sessions').select('*').eq('block_id', block.id).order('week_no', { ascending: true }).order('slot', { ascending: true })
      : { data: [] }

    return <HyroxPlanner initialBlock={block || null} initialSessions={sessions || []} locationId={locationId} canManage={['owner','manager','head_coach','master'].includes(user.role)} />
  }
  ```

- [ ] **Step 2: Write the client** `src/app/admin/hyrox/HyroxPlanner.jsx` (`'use client'`). Follow the `TVAdmin.jsx` shape (props → state, `createBrowserClient` for reads). It must render:
  1. **Header** with the block title / "Week 1 of 12 · <starts_on>" and, if `!initialBlock` and `canManage`, a **"Generate a 12-week block"** form: `starts_on` (date), `session_weekdays` (default Wed+Sun = [3,7]), `difficulty_dial` (select from `DIFFICULTY_DIALS`), `auto_tune_enabled` (checkbox, default off), optional `charter` textarea (prefilled empty = use default), `expand_weeks` (default 2). Submit → `POST /api/hyrox/blocks` → on success reload sessions.
  2. **A weeks × slots grid** — one row per week (1..`block.weeks`), a cell per slot; each cell shows the session's status chip (`draft`/`approved`/`published` — use the light-theme chip recipe `bg-*-500/10 text-*-700`) + focus, or "not generated". Clicking a generated cell opens the review drawer. Rows for weeks beyond the expanded window show "not generated yet" (Plan 03's rolling cron fills them).
  3. **Review drawer** — shows the session's `full_session` (warmup/strength/main/finisher/cues/why) and the `board` (stations table with performance/elite). Editable fields (focus, and the board station values) post to `PUT /api/hyrox/sessions/[id]`. Buttons: **Approve** (`PUT` with `status:'approved'`), **Send back to draft** (`status:'draft'`), **Regenerate** (`POST /api/hyrox/sessions/[id]/regenerate`). Respect `?focus=<id>` from the URL to auto-open a session (the approvals inbox links here). All buttons in forms get `type="button"` (estate invariant).
  4. **Batch-approve week** — a per-week "Approve all drafts" that `PUT`s each draft session in that week to `approved`.
  Keep chips on the light theme recipe (lint-enforced). Use existing `@/components/ui` primitives (`Button`, `Modal`/drawer, `Field`, `Table`).

- [ ] **Step 3: Register nav + gates.**
  1. `src/lib/nav-items.js` — add to the Studio Management `children` array: `{ href: '/admin/hyrox', label: 'Hyrox Training Club', icon: <an lucide icon, e.g. Dumbbell>, permission: 'approvals_hyrox_sessions' }` (import the icon).
  2. `src/app/admin/layout.js` — add `'approvals_hyrox_sessions'` to `ADMIN_CHILD_PERMS` (else the layout blocks the page before its own gate runs — this is the documented gotcha).
  3. `src/app/admin/page.js` — add a `studioTools` tile `{ perm: 'approvals_hyrox_sessions', href: '/admin/hyrox', icon: <icon>, title: 'Hyrox Training Club', desc: 'Generate + review the 12-week Hyrox block.' }`.

- [ ] **Step 4: Verify build + guards + lint.**
  Run: `npm run build && npm run lint && npm run check:guardrails`
  Expected: build compiles the new page/route; guardrails passes (chips use the `-700` recipe; no banned date patterns).

- [ ] **Step 5: Commit** (`HYROX-TC.2 — /admin/hyrox planner page + nav + gates`).

---

## Task 10: full CI mirror + build

- [ ] **Step 1: Run the six-check mirror + build.**
  Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && npm run build`
  Expected: all green.

- [ ] **Step 2: Commit any fixups** (`HYROX-TC.2 — Plan 02 CI fixups`).

---

## Self-review notes (author)

- **Spec coverage:** §5 provider + planner + approve/regenerate (Tasks 8-9, 7) ✓ · generate-a-block trigger (Tasks 5-6) ✓ · §4.1 arc + initial-window expansion (Task 5; rolling cron deferred to Plan 03) ✓ · §4.4 charter operator-editable + used in generation (Tasks 2, 6) ✓ · §8.2/§8.3 dial + auto_tune_enabled as block inputs; auto-tune signal still null (Tasks 3, 5, 6) ✓ · permission wiring (Task 1) ✓.
- **No migration in this plan** — `locations.settings.hyrox` is JSONB; the two tables already exist (mig 440).
- **Deferred (Plan 03):** the auto-publish cron, the `generated` portrait TV renderer, the rolling-expansion cron for weeks beyond the initial window, and the "which TV" targeting.
- **Verify-before-relying flags carried in:** `hasPermissionForLocation` import path (`@/lib/permissions`, not `@/lib/auth`); how existing `approvals_*` keys satisfy `check:mobile-parity` (mirror them); `anthropicMessages` must be passed a real `model` (`HYROX_MODEL`). All three are called out inline in the relevant tasks.
- **Route tests:** the pure helpers + provider are unit-tested; the three routes are covered by `check:route-guards` + `next build` + manual. If time allows, add a `route.test.js` mirroring an existing one under `src/app/api/**`.
