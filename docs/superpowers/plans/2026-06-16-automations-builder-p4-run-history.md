# Automations Builder — Phase 4: Run History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`). **Work from the worktree `/Users/richardivers/code/un1t-crm-ab` on branch `feat/automations-builder-p4`** — every command `cd` there first; first step of every task is the branch guard (`git branch --show-current` → `feat/automations-builder-p4`).

**Goal:** A **Performance** section on the automation editor (`/automations/[id]`) — enrolment funnel + per-step email stats (surface the existing `/api/sequences/[id]/stats`) + a "Recent activity" list (new `/api/sequences/[id]/runs`).

**Architecture:** One pure helper + one thin endpoint + one isolated client component mounted below the existing builder. No engine/DB change. Manager+ gated (mirrors `/stats`).

**Tech Stack:** Next.js 16 App Router, React, lucide-react, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-16-automations-builder-p4-run-history-design.md`.

---

## Verified facts (don't re-derive)
- `/api/sequences/[id]/stats` returns `{ enrolments:{total,active,completed,exited,paused}, exit_reasons:{<reason>:n}, per_step:{<sequence_step_id>:{sent,opened,clicked,bounced,complained,failed}} }`. Manager+ + assertLocationAccess; 404 if seq missing, 403 if cross-tenant.
- `sequence_enrollments` columns: `id, sequence_id, contact_id, current_step_order (0-based; 0 = before step 1), status ('active'|'completed'|'exited'|'paused'), exit_reason ('goal_met' etc.), last_error, error_count, source_type, source_ref, created_at, last_processed_at`. Single FK to `contacts` (contact_id) → a bare `contacts(...)` embed is safe.
- The editor page `src/app/automations/[id]/page.js` loads `sequence` (`*, sequence_steps(*)`) and renders `<SequenceFlowBuilder graph sequence isDraft />`. `describeNode({type,config})` from `@/lib/sequences/graph` gives a step label.

---

## Task 1: `/runs` endpoint + `run-history.js` pure helper + tests

**Files:**
- Create: `src/lib/sequences/run-history.js`
- Create: `src/lib/sequences/run-history.test.js`
- Create: `src/app/api/sequences/[id]/runs/route.js`

- [ ] **Step 1: Write the failing test for the pure helper**

Create `src/lib/sequences/run-history.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { summariseEnrolmentRun } from './run-history.js'

describe('summariseEnrolmentRun', () => {
  it('active → in-progress with 1-based step of N', () => {
    expect(summariseEnrolmentRun({ status: 'active', current_step_order: 1 }, 4))
      .toEqual({ state: 'active', stepLabel: 'Step 2 of 4', outcome: 'In progress' })
  })
  it('active with no step count → omits "of N"', () => {
    expect(summariseEnrolmentRun({ status: 'active', current_step_order: 0 }, 0))
      .toEqual({ state: 'active', stepLabel: 'Step 1', outcome: 'In progress' })
  })
  it('completed', () => {
    expect(summariseEnrolmentRun({ status: 'completed', current_step_order: 3 }, 4).outcome).toBe('Completed')
  })
  it('exited with goal_met → friendly', () => {
    expect(summariseEnrolmentRun({ status: 'exited', exit_reason: 'goal_met' }, 4).outcome).toBe('Exited: goal met')
  })
  it('exited with an arbitrary reason → passes it through', () => {
    expect(summariseEnrolmentRun({ status: 'exited', exit_reason: 'Contact deleted' }, 4).outcome).toBe('Exited: Contact deleted')
  })
  it('exited with no reason', () => {
    expect(summariseEnrolmentRun({ status: 'exited' }, 4).outcome).toBe('Exited')
  })
  it('paused surfaces last_error when present', () => {
    expect(summariseEnrolmentRun({ status: 'paused', last_error: 'Bad email' }, 4).outcome).toBe('Paused: Bad email')
  })
  it('unknown status falls back', () => {
    expect(summariseEnrolmentRun({ status: 'weird' }, 4).outcome).toBe('weird')
  })
})
```

- [ ] **Step 2: Run it — expect FAIL** (`module not found`)

Run: `cd /Users/richardivers/code/un1t-crm-ab && npx vitest run src/lib/sequences/run-history.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement the helper**

Create `src/lib/sequences/run-history.js`:
```js
// Pure mapping of a sequence_enrollments row → a display summary for the
// automation Performance view's "Recent activity" list. No IO.

const REASON_LABELS = { goal_met: 'goal met' }

/**
 * @param {object} e         enrollment row ({ status, current_step_order, exit_reason, last_error })
 * @param {number} stepCount total steps in the automation (0 → omit "of N")
 * @returns {{ state: string, stepLabel: string, outcome: string }}
 */
export function summariseEnrolmentRun(e, stepCount) {
  const status = e?.status || 'unknown'
  const stepNum = (Number(e?.current_step_order) || 0) + 1
  const stepLabel = stepCount > 0 ? `Step ${stepNum} of ${stepCount}` : `Step ${stepNum}`

  let outcome
  switch (status) {
    case 'active': outcome = 'In progress'; break
    case 'completed': outcome = 'Completed'; break
    case 'exited': {
      const r = e?.exit_reason
      outcome = r ? `Exited: ${REASON_LABELS[r] || r}` : 'Exited'
      break
    }
    case 'paused': outcome = e?.last_error ? `Paused: ${e.last_error}` : 'Paused'; break
    default: outcome = status
  }
  return { state: status, stepLabel, outcome }
}
```

- [ ] **Step 4: Run it — expect PASS**

Run: `cd /Users/richardivers/code/un1t-crm-ab && npx vitest run src/lib/sequences/run-history.test.js`
Expected: PASS (8 cases).

- [ ] **Step 5: Create the `/runs` route**

Create `src/app/api/sequences/[id]/runs/route.js` (mirror the `/stats` guard pattern exactly):
```js
// GET /api/sequences/[id]/runs — last 50 enrolments (per-contact run log)
// for the automation Performance view's "Recent activity". Manager+ at the
// sequence's location. Mirrors the /stats route's guards.
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { summariseEnrolmentRun } from '@/lib/sequences/run-history'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: seq, error: seqErr } = await db
    .from('email_sequences')
    .select('id, location_id')
    .eq('id', params.id)
    .single()
  if (seqErr || !seq) {
    return NextResponse.json({ success: false, error: 'Sequence not found' }, { status: 404 })
  }
  const guard = assertLocationAccess(user, seq.location_id)
  if (guard) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })

  // Total step count for the "Step X of N" label.
  const { count: stepCount } = await db
    .from('sequence_steps')
    .select('id', { count: 'exact', head: true })
    .eq('sequence_id', params.id)

  // sequence_enrollments has a single FK to contacts → bare embed is safe.
  const { data: rows, error } = await db
    .from('sequence_enrollments')
    .select('id, status, current_step_order, exit_reason, last_error, source_type, created_at, last_processed_at, contacts(first_name, last_name, email)')
    .eq('sequence_id', params.id)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  const runs = (rows || []).map((r) => {
    const c = r.contacts || {}
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || c.email || 'Unknown contact'
    return {
      id: r.id,
      contact_name: name,
      contact_email: c.email || null,
      source_type: r.source_type || null,
      created_at: r.created_at,
      last_processed_at: r.last_processed_at,
      ...summariseEnrolmentRun(r, stepCount || 0),
    }
  })

  return NextResponse.json({ success: true, data: { runs, step_count: stepCount || 0 } })
}
```

- [ ] **Step 6: Verify + commit**

Run: `cd /Users/richardivers/code/un1t-crm-ab && npx eslint src/lib/sequences/run-history.js src/app/api/sequences/[id]/runs/route.js && npx vitest run src/lib/sequences/run-history.test.js`
Expected: lint clean, tests PASS.

Run the route-guard check (a new `/api` route must pass it): `cd /Users/richardivers/code/un1t-crm-ab && npm run check:route-guards 2>&1 | tail -3`
Expected: passes (the route uses `getCurrentUser` — a recognised session guard).

```bash
cd /Users/richardivers/code/un1t-crm-ab
git add src/lib/sequences/run-history.js src/lib/sequences/run-history.test.js 'src/app/api/sequences/[id]/runs/route.js'
git commit -m "feat(automations): /runs endpoint + run-history summary helper for the Performance view"
```

---

## Task 2: `AutomationPerformance` component + mount on the editor page

**Files:**
- Create: `src/components/automations/AutomationPerformance.jsx`
- Modify: `src/app/automations/[id]/page.js`

- [ ] **Step 1: Create the component**

Create `src/components/automations/AutomationPerformance.jsx`:
```jsx
'use client'

// Performance / run-history section on the automation editor (/automations/[id]).
// Fetches the existing /stats (funnel + per-step email perf) + the new /runs
// (recent per-contact activity). Manager+ only — both endpoints 403 otherwise,
// in which case this section quietly hides. Isolated from the builder.
import { useEffect, useState } from 'react'
import { BarChart3, Users, CheckCircle2, LogOut, PauseCircle } from 'lucide-react'
import { describeNode } from '@/lib/sequences/graph'

function Chip({ icon: Icon, label, value, tone = 'text-un1t-subtle' }) {
  return (
    <div className="flex items-center gap-2 bg-un1t-surface border border-un1t-border rounded-lg px-3 py-2">
      <Icon size={15} className={tone} />
      <span className="text-sm font-semibold text-un1t-text">{value}</span>
      <span className="text-xs text-un1t-subtle">{label}</span>
    </div>
  )
}

export default function AutomationPerformance({ sequenceId, steps = [] }) {
  const [stats, setStats] = useState(null)
  const [runs, setRuns] = useState(null)
  const [loading, setLoading] = useState(true)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    let alive = true
    async function load() {
      try {
        const [sRes, rRes] = await Promise.all([
          fetch(`/api/sequences/${sequenceId}/stats`),
          fetch(`/api/sequences/${sequenceId}/runs`),
        ])
        if (sRes.status === 403 || rRes.status === 403) { if (alive) setHidden(true); return }
        const s = await sRes.json().catch(() => ({}))
        const r = await rRes.json().catch(() => ({}))
        if (!alive) return
        if (s?.success) setStats(s.data)
        if (r?.success) setRuns(r.data?.runs || [])
      } catch {
        /* network error — leave nulls, show the empty/error state */
      } finally {
        if (alive) setLoading(false)
      }
    }
    load()
    return () => { alive = false }
  }, [sequenceId])

  if (hidden) return null

  const stepById = new Map(steps.map((st) => [st.id, st]))
  const en = stats?.enrolments
  const exitReasons = stats?.exit_reasons || {}
  const perStep = stats?.per_step || {}

  return (
    <section className="mt-8 max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold text-un1t-text mb-1 flex items-center gap-2">
        <BarChart3 size={18} className="text-un1t-subtle" /> Performance
      </h2>
      <p className="text-xs text-un1t-subtle mb-4">How this automation has run — enrolments, per-step email results, and recent activity.</p>

      {loading && <p className="text-sm text-un1t-subtle">Loading…</p>}

      {!loading && en && (
        <>
          {/* Funnel */}
          <div className="flex flex-wrap gap-2 mb-5">
            <Chip icon={Users} label="enrolled" value={en.total} />
            <Chip icon={Users} label="active" value={en.active} tone="text-blue-600" />
            <Chip icon={CheckCircle2} label="completed" value={en.completed} tone="text-emerald-600" />
            <Chip icon={LogOut} label="exited" value={en.exited} tone="text-un1t-subtle" />
            {en.paused > 0 && <Chip icon={PauseCircle} label="paused" value={en.paused} tone="text-amber-600" />}
          </div>

          {Object.keys(exitReasons).length > 0 && (
            <p className="text-xs text-un1t-subtle mb-5">
              Exits: {Object.entries(exitReasons).map(([r, n]) => `${r.replace(/_/g, ' ')} (${n})`).join(' · ')}
            </p>
          )}

          {/* Per-step email performance */}
          {Object.keys(perStep).length > 0 && (
            <div className="bg-un1t-surface border border-un1t-border rounded-xl divide-y divide-un1t-border mb-6">
              {Object.entries(perStep).map(([stepId, m]) => {
                const st = stepById.get(stepId)
                const label = st ? describeNode({ type: st.step_type, config: st.config }).summary : 'Step'
                const isEmail = st?.step_type === 'email'
                return (
                  <div key={stepId} className="flex items-center justify-between px-4 py-2.5 text-sm">
                    <span className="text-un1t-text truncate">{label}</span>
                    <span className="text-xs text-un1t-subtle shrink-0">
                      {m.sent} sent{isEmail ? ` · ${m.opened} opened · ${m.clicked} clicked` : ''}
                      {m.failed > 0 ? ` · ${m.failed} failed` : ''}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* Recent activity */}
      {!loading && (
        <div>
          <h3 className="text-sm font-semibold text-un1t-text mb-2">Recent activity</h3>
          {(!runs || runs.length === 0) ? (
            <p className="text-sm text-un1t-subtle">No runs yet — this automation hasn’t enrolled anyone.</p>
          ) : (
            <div className="bg-un1t-surface border border-un1t-border rounded-xl divide-y divide-un1t-border">
              {runs.map((r) => (
                <div key={r.id} className="flex items-center justify-between px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm text-un1t-text truncate">{r.contact_name}</p>
                    <p className="text-xs text-un1t-subtle">{r.outcome}{r.state === 'active' ? ` · ${r.stepLabel}` : ''}</p>
                  </div>
                  <span className="text-xs text-un1t-subtle shrink-0">{new Date(r.created_at).toLocaleDateString()}</span>
                </div>
              ))}
              {runs.length >= 50 && <p className="text-[11px] text-un1t-subtle px-4 py-2">Showing the 50 most recent.</p>}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
```
NOTE: `new Date(r.created_at).toLocaleDateString()` is a plain date (no time-of-day, so the Dublin-wall-clock booking caveat doesn't apply — `created_at` is a real UTC timestamptz). Confirm `describeNode` is exported from `@/lib/sequences/graph` (it is — used by `SequenceFlowBuilder`); if the import path differs, match what `SequenceFlowBuilder.jsx` uses.

- [ ] **Step 2: Mount it on the editor page**

In `src/app/automations/[id]/page.js`, import the component and render it below the builder. Change the return so it wraps both:
```jsx
import AutomationPerformance from '@/components/automations/AutomationPerformance'
// ...
  return (
    <>
      <SequenceFlowBuilder graph={graph} sequence={sequence} isDraft={sequence.draft_graph != null} />
      <AutomationPerformance sequenceId={sequence.id} steps={sequence.sequence_steps || []} />
    </>
  )
```
(Read the current return first — it's a single `<SequenceFlowBuilder .../>`. Wrap in a fragment + add the section. Keep the existing props exactly.)

- [ ] **Step 3: Verify + commit**

Run: `cd /Users/richardivers/code/un1t-crm-ab && npx eslint src/components/automations/AutomationPerformance.jsx 'src/app/automations/[id]/page.js'`
Expected: no errors (watch for the apostrophe in "hasn’t" — it's a curly `’` inside a JSX text node, which is valid; if eslint/jsx complains, use `hasn&apos;t` or plain "has not").
Run: `npx vitest run src/lib/sequences/` → PASS.

```bash
cd /Users/richardivers/code/un1t-crm-ab
git add src/components/automations/AutomationPerformance.jsx 'src/app/automations/[id]/page.js'
git commit -m "feat(automations): Performance section on the editor — funnel, per-step results, recent activity"
```

---

## Definition of done (CI mirror from the worktree)
```bash
cd /Users/richardivers/code/un1t-crm-ab
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards
```
All green. No migration, no `shared/permissions.js` change (no new permission key — both endpoints reuse manager+ / assertLocationAccess) → parity unaffected. **`next build` not runnable under the worktree symlink — Vercel PR check is the build gate** (this adds a new route + a new component import).

**What this delivers:** opening any automation at `/automations/[id]` now shows a **Performance** section — the enrolment funnel, per-step email results, and the last 50 contacts it touched with their outcome. Completes P4 (the templates gallery was already shipped).

---

## Self-review
- **Spec coverage:** funnel + per-step (surface `/stats`) → component Task 2; recent runs (`/runs` + helper) → Task 1 + the component's recent-activity block; manager+ gating + graceful 403-hide → route guard + the component's `hidden` state. ✓
- **Placeholders:** none — helper, route, and component are complete; `/stats` shape + enrollment columns are the verified real ones.
- **Type consistency:** `summariseEnrolmentRun(e, stepCount)` defined in Task 1, imported + called identically in the route; the component reads `{ runs, step_count }` from `/runs` and `{ enrolments, exit_reasons, per_step }` from `/stats` — matching both routes' actual response shapes. `describeNode({type,config})` matches its real signature.
- **Ambiguity:** "run history" pinned to the three concrete blocks; `current_step_order` 0-based → +1 for display is explicit in the helper + tested; the contacts embed is bare (justified: single FK).
