# Automations Builder — Phase 3: IA Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax. **Work from the worktree `/Users/richardivers/code/un1t-crm-ab` on branch `feat/automations-builder-p3`** — every command `cd` there first; first step of every task is the branch guard `git -C /Users/richardivers/code/un1t-crm-ab branch --show-current` → must be `feat/automations-builder-p3`.

**Goal:** Make `/automations` the single home for both curated toggle-automations and custom flows; re-home the flow editor to `/automations/[id]`; redirect the old `/communications/sequences/*` paths; rename "Sequence" → "Automation" in the UI. No engine/DB/API change.

**Architecture:** Pure IA + presentation. Page route files move; `src/components/sequences/*` + `src/lib/sequences/*` + `/api/sequences/*` + DB tables keep their names. Same move+redirect-stub pattern as the earlier `/email/sequences/*` retirement.

**Tech Stack:** Next.js 16 App Router, React, lucide-react.

**Spec:** `docs/superpowers/specs/2026-06-16-automations-builder-p3-ia-rebrand-design.md`. Base: `feat/automations-builder-p3` off `main` (Phases 1+2 merged).

---

## Verified current state (don't re-derive)
- `src/app/automations/page.js` — curated hub: guard `hasPermission(user,'automations')`→redirect `/dashboard`; loads `location_automations`→cards→`<AutomationsView>`.
- `src/app/communications/sequences/page.js` — list: guard `hasPermission(user,'email')`; loads `email_sequences` `select('*, sequence_steps(id)')` ordered by created_at desc; renders header (Browse-templates link + `<SequenceTemplatePicker>` + `<NewSequenceButton>`) + list rows (each a `<Link href="/communications/sequences/${id}">` with name, `triggerLabels[trigger_type]` · step count, `total_enrolled`, status pill, `<CloneSequenceButton>`, `<DeleteSequenceButton>`) + empty state. `triggerLabels` + `statusConfig` maps defined at top.
- `src/app/communications/sequences/[id]/page.js` — editor: auth + `assertLocationAccess` only (**no `email` perm check**); loads sequence + steps, `resolveSequenceGraph`, renders `<SequenceFlowBuilder graph sequence isDraft />`.
- `src/app/communications/sequences/templates/page.js` — server gallery of `SEQUENCE_TEMPLATES` + `<InstallTemplateButton>`; has a back link.
- `src/components/communications/CommunicationsTabs.jsx` — sub-nav; line ~32 `canEmail && { id:'sequences', label:'Sequences', href:'/communications/sequences' }`.
- Internal links to repoint (full sweep): `email/sequences/page.js`, `email/sequences/new/page.js`, `email/sequences/[id]/page.js` (redirect targets); `communications/page.js:192`; `CloneSequenceButton.jsx:36`; `InstallTemplateButton.jsx:30`; `SequencePicker.jsx:218`; `SequenceTemplatePicker.jsx:55`; `sequences/SequenceFlowBuilder.jsx:146`; `sequences/NewSequenceButton.jsx:26`; `automations/AutomationsView.jsx:24`; `CommunicationsTabs.jsx:32`.

---

## Task 1: Unified `/automations` home (two sections)

**Files:**
- Create: `src/components/automations/AutomationsFlowList.jsx`
- Modify: `src/app/automations/page.js`

- [ ] **Step 1: Create the custom-flows list section component**

Create `src/components/automations/AutomationsFlowList.jsx` (server component — renders the existing client buttons). It's the "Your automations" section, lifted from the sequences list page with links pointing at `/automations/[id]`:

```jsx
// "Your automations" — the custom flow list on the /automations home.
// Lifted from the retired /communications/sequences list page; rows link
// to the re-homed editor at /automations/[id]. Server component; the
// action buttons it renders are client components.
import Link from 'next/link'
import { Zap, Play, Pause, FileEdit, LayoutTemplate } from 'lucide-react'
import SequenceTemplatePicker from '@/components/SequenceTemplatePicker'
import NewSequenceButton from '@/components/sequences/NewSequenceButton'
import CloneSequenceButton from '@/components/CloneSequenceButton'
import DeleteSequenceButton from '@/components/sequences/DeleteSequenceButton'

const triggerLabels = {
  manual: 'Manual enrollment', booking_created: 'Booking created', first_booking: 'First booking',
  status_change: 'Status change', pipeline_stage_change: 'Pipeline stage change',
  membership_state_change: 'Membership state change', contact_created: 'New lead created',
  event_reminder: 'Event reminder', tag_added: 'Tag added',
  segment_added: 'Segment entered', segment_removed: 'Segment exited',
  race_registered: 'Race registered', race_finished: 'Race finished',
  order_completed: 'Order completed', order_failed: 'Order failed', order_abandoned: 'Order abandoned',
  anniversary: 'Anniversary', inactivity: 'Inactivity', webhook: 'Webhook (inbound)',
}
const statusConfig = {
  draft:  { label: 'Draft',  color: 'bg-un1t-border/40 text-un1t-subtle', icon: FileEdit },
  active: { label: 'Active', color: 'bg-emerald-500/15 text-emerald-700', icon: Play },
  paused: { label: 'Paused', color: 'bg-amber-500/15 text-amber-700', icon: Pause },
}

export default function AutomationsFlowList({ sequences }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold text-un1t-text">Your automations</h2>
          <p className="text-xs text-un1t-subtle mt-0.5">Custom flows triggered by events — build your own with steps + branches</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/automations/templates"
            className="inline-flex items-center gap-2 border border-un1t-border text-un1t-subtle text-sm font-medium px-4 py-2 rounded-lg hover:text-un1t-text hover:border-un1t-muted transition-colors"
          >
            <LayoutTemplate size={16} />
            Browse templates
          </Link>
          <SequenceTemplatePicker />
          <NewSequenceButton className="flex items-center gap-2 bg-un1t-text text-un1t-bg text-sm font-medium px-4 py-2 rounded-lg hover:bg-un1t-accent transition-colors disabled:opacity-60" />
        </div>
      </div>

      {(!sequences || sequences.length === 0) ? (
        <div className="bg-un1t-surface border border-un1t-border rounded-2xl p-10 text-center">
          <Zap size={32} className="mx-auto mb-3 text-un1t-subtle" />
          <h3 className="text-base font-semibold mb-2">No automations yet</h3>
          <p className="text-sm text-un1t-subtle mb-4">Build a flow that triggers on bookings, new leads, stage changes, or tags.</p>
          <NewSequenceButton label="Build an automation" className="inline-flex items-center gap-2 bg-un1t-text text-un1t-bg text-sm font-medium px-4 py-2 rounded-lg hover:bg-un1t-accent transition-colors disabled:opacity-60" />
        </div>
      ) : (
        <div className="bg-un1t-surface border border-un1t-border rounded-2xl divide-y divide-un1t-border">
          {sequences.map(seq => {
            const config = statusConfig[seq.status] || statusConfig.draft
            const StatusIcon = config.icon
            const stepsCount = seq.sequence_steps?.length || 0
            return (
              <div key={seq.id} className="flex items-center justify-between px-5 py-4 hover:bg-un1t-border/20 transition-colors">
                <Link href={`/automations/${seq.id}`} className="flex items-center gap-4 flex-1 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-un1t-border/30 flex items-center justify-center shrink-0">
                    <Zap size={18} className="text-un1t-subtle" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{seq.name}</p>
                    <p className="text-xs text-un1t-subtle mt-0.5">
                      {triggerLabels[seq.trigger_type] || seq.trigger_type} · {stepsCount} step{stepsCount !== 1 ? 's' : ''}
                    </p>
                  </div>
                </Link>
                <div className="flex items-center gap-3 shrink-0">
                  {seq.total_enrolled > 0 && (<span className="text-xs text-un1t-subtle">{seq.total_enrolled} enrolled</span>)}
                  <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${config.color}`}>
                    <StatusIcon size={10} />{config.label}
                  </span>
                  <CloneSequenceButton sequenceId={seq.id} sequenceName={seq.name} />
                  <DeleteSequenceButton sequenceId={seq.id} sequenceName={seq.name} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Rewrite `src/app/automations/page.js` to render both sections**

Replace the page with the two-section version (broadened gate + load flows when permitted). Read the current file first to copy the exact card-building block (the `AUTOMATIONS.map(...)` → `cards`), then:

```js
// src/app/automations/page.js — Automations home (curated toggles + custom flows).
import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { hasPermission } from '@/lib/permissions'
import { createServerClient } from '@/lib/supabase'
import { AUTOMATIONS, automationStatus } from '@/lib/automations/registry'
import AutomationsView from '@/components/automations/AutomationsView'
import AutomationsFlowList from '@/components/automations/AutomationsFlowList'

export const dynamic = 'force-dynamic'

export default async function AutomationsPage() {
  const user = await getCurrentUser()
  if (!user) redirect('/login')

  const canCurated = hasPermission(user, 'automations')
  const canFlows = hasPermission(user, 'email') || hasPermission(user, 'whatsapp')
  if (!canCurated && !canFlows) redirect('/dashboard')

  const location = user.activeLocation
  const db = createServerClient()

  // Curated toggle cards (only when the user has the automations perm).
  let cards = []
  if (canCurated) {
    const { data: rows } = await db
      .from('location_automations')
      .select('automation_key, enabled')
      .eq('location_id', location?.id || '00000000-0000-0000-0000-000000000000')
    const enabledByKey = Object.fromEntries((rows || []).map((r) => [r.automation_key, r.enabled]))
    cards = AUTOMATIONS.map((a) => ({
      key: a.key, label: a.label, description: a.description,
      supportsBackfill: a.supportsBackfill, reviewBase: a.reviewBase,
      enabled: Boolean(enabledByKey[a.key]),
      status: automationStatus(a.key, location),
    }))
  }

  // Custom flows (only when the user has email/whatsapp).
  let sequences = []
  if (canFlows) {
    const { data } = await db
      .from('email_sequences')
      .select('*, sequence_steps(id)')
      .eq('location_id', location?.id)
      .order('created_at', { ascending: false })
    sequences = data || []
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-10">
      <div>
        <h1 className="text-2xl font-bold text-un1t-text mb-1">Automations</h1>
        <p className="text-sm text-un1t-subtle">Things that run by themselves for {location?.name || 'your studio'}</p>
      </div>
      {canCurated && (
        <AutomationsView locationId={location?.id || null} locationName={location?.name || ''} cards={cards} />
      )}
      {canFlows && <AutomationsFlowList sequences={sequences} />}
    </div>
  )
}
```

NOTE: read the **current** `AutomationsView` props (Phase 1 passed `{ locationId, locationName, cards }`) and match them exactly. If `AutomationsView` already renders its own `<h1>Automations</h1>` header, drop the page-level `<h1>` to avoid a double header — verify by reading `AutomationsView.jsx` and adjust (keep ONE page title).

- [ ] **Step 3: Lint + build-sanity + commit**

Run: `cd /Users/richardivers/code/un1t-crm-ab && npx eslint src/app/automations/page.js src/components/automations/AutomationsFlowList.jsx` → no errors.
Run: `npx vitest run src/lib/sequences/ src/lib/automations/` → PASS (no regression; these are unaffected but confirm nothing imported breaks).

```bash
cd /Users/richardivers/code/un1t-crm-ab
git add src/app/automations/page.js src/components/automations/AutomationsFlowList.jsx
git commit -m "feat(automations): unified /automations home — curated toggles + custom-flow list (two sections)"
```

---

## Task 2: Re-home editor + templates, redirect stubs, internal-link sweep

**Files:** moves + stubs + edits across `src/app/...` and `src/components/...` (enumerated below).

- [ ] **Step 1: Move the editor + templates pages into `/automations`**

```bash
cd /Users/richardivers/code/un1t-crm-ab
git mv 'src/app/communications/sequences/[id]/page.js' 'src/app/automations/[id]/page.js'
git mv 'src/app/communications/sequences/templates/page.js' 'src/app/automations/templates/page.js'
```
The `[id]` editor content is route-agnostic (auth + `assertLocationAccess` only) — no edits needed beyond the link sweep in Step 4. The `templates` page has a back-link + may reference `/communications/sequences` in comments/links — fix those in Step 4.

- [ ] **Step 2: Replace the old list page with a redirect stub + add stubs at the moved paths**

The old list path becomes a stub (its content now lives in the home). Overwrite `src/app/communications/sequences/page.js`:
```js
import { redirect } from 'next/navigation'
export const dynamic = 'force-dynamic'
export default function SequencesListRedirect() {
  redirect('/automations')
}
```
Create stub `src/app/communications/sequences/[id]/page.js` (the editor moved to `/automations/[id]`):
```js
import { redirect } from 'next/navigation'
export const dynamic = 'force-dynamic'
export default async function SequenceEditorRedirect(props) {
  const params = await props.params
  redirect(`/automations/${params.id}`)
}
```
Create stub `src/app/communications/sequences/templates/page.js`:
```js
import { redirect } from 'next/navigation'
export const dynamic = 'force-dynamic'
export default function SequenceTemplatesRedirect() {
  redirect('/automations/templates')
}
```

- [ ] **Step 3: Repoint the `/email/sequences/*` stubs straight to `/automations`**

Overwrite `src/app/email/sequences/page.js` and `src/app/email/sequences/new/page.js` to `redirect('/automations')`, and `src/app/email/sequences/[id]/page.js` to `redirect(\`/automations/${params.id}\`)` (keep their `await props.params` shape for the `[id]` one). Example for the `[id]` one:
```js
import { redirect } from 'next/navigation'
export const dynamic = 'force-dynamic'
export default async function LegacySequenceRedirect(props) {
  const params = await props.params
  redirect(`/automations/${params.id}`)
}
```

- [ ] **Step 4: Sweep + repoint every internal `/communications/sequences` link**

Apply these exact edits (functional links — repoint to `/automations`):
- `src/components/CloneSequenceButton.jsx` line ~36: `router.push(\`/communications/sequences/${j.data.sequence_id}\`)` → `router.push(\`/automations/${j.data.sequence_id}\`)`
- `src/components/InstallTemplateButton.jsx` line ~30: `router.push(\`/communications/sequences/${j.data.sequence_id}\`)` → `router.push(\`/automations/${j.data.sequence_id}\`)`
- `src/components/SequenceTemplatePicker.jsx` line ~55: `router.push(\`/communications/sequences/${j.data.sequence_id}\`)` → `router.push(\`/automations/${j.data.sequence_id}\`)`
- `src/components/sequences/NewSequenceButton.jsx` line ~26: `router.push(\`/communications/sequences/${j.sequence.id}\`)` → `router.push(\`/automations/${j.sequence.id}\`)`
- `src/components/SequencePicker.jsx` line ~218: `<Link href="/communications/sequences" …>` → `href="/automations"`
- `src/components/sequences/SequenceFlowBuilder.jsx` line ~146: `<Link href="/communications/sequences" …>← All sequences</Link>` → `href="/automations"` + label `← All automations`
- `src/app/communications/page.js` line ~192: `href="/communications/sequences"` → `href="/automations"`
- `src/app/automations/templates/page.js` (moved file): any `href="/communications/sequences"` back-link → `/automations`; any `/communications/sequences/${id}` → `/automations/${id}`.
- `src/components/automations/AutomationsView.jsx` line ~24: the "See also" footer links to `/communications/sequences` ("Sequences (message automations)") — the flows are now on this same page, so **remove that link** from the footer (keep the `/settings/customer-agent` link). Read the footer and excise just the Sequences anchor cleanly.

- [ ] **Step 5: Verify the sweep is complete**

Run: `cd /Users/richardivers/code/un1t-crm-ab && grep -rn "communications/sequences" src/ --include='*.js' --include='*.jsx' | grep -vE "app/communications/sequences/(page|\[id\]/page|templates/page)\.js"`
Expected: **only comment references remain** (e.g. doc comments in CloneSequenceButton/InstallTemplateButton/SequenceTemplatePicker/the moved editor). NO `href=` / `router.push(` to `/communications/sequences` outside the three redirect-stub files. Update any stragglers. (Comment-only references are acceptable but tidy the obvious ones.)

- [ ] **Step 6: Lint + build + commit**

Run: `cd /Users/richardivers/code/un1t-crm-ab && npx next lint` (catches `no-html-link-for-pages` on any new internal `<a>` — these are all `<Link>` already, but confirm) and `npx vitest run src/lib/sequences/` → PASS.

```bash
cd /Users/richardivers/code/un1t-crm-ab
git add -A
git commit -m "feat(automations): re-home flow editor + templates to /automations, redirect old sequence paths, sweep internal links"
```

---

## Task 3: Terminology + remove the Communications Sequences tab

**Files:** `src/components/communications/CommunicationsTabs.jsx` + terminology in the moved/new surfaces.

- [ ] **Step 1: Remove the Sequences sub-tab from Communications**

In `src/components/communications/CommunicationsTabs.jsx`, delete the line:
```js
    canEmail    && { id: 'sequences',  label: 'Sequences',  href: '/communications/sequences' },
```
Leave the rest (Send / Sends / Inbox / Templates / Segments) intact.

- [ ] **Step 2: Terminology pass — "Sequence" → "Automation" in user-facing strings**

Update visible copy ONLY (not component/file/var names, not `/api/sequences`, not DB columns):
- `src/components/sequences/NewSequenceButton.jsx` — default button label "New sequence" / "Create Sequence" → "New automation" (check its `label` default + any hardcoded text).
- `src/app/automations/templates/page.js` — page heading/intro that says "sequence(s)" → "automation(s)" (e.g. "flow templates" copy; the gallery title).
- `src/components/SequenceTemplatePicker.jsx` + `src/components/CloneSequenceButton.jsx` + `src/components/DeleteSequenceButton.jsx` — any visible button text / confirm() copy that says "sequence" → "automation" (keep `sequenceId`/`sequenceName` prop names).
- `AutomationsFlowList.jsx` already uses "automation" copy (Task 1) — no change.

Be conservative: change strings a user reads; do NOT rename identifiers, routes, or the `email_sequences` references.

- [ ] **Step 3: Verify the Communications layout still renders without the tab**

Run: `cd /Users/richardivers/code/un1t-crm-ab && npx eslint src/components/communications/CommunicationsTabs.jsx && npx vitest run src/lib/` → PASS. (CommunicationsTabs is a client component with no unit test; the lint + build are the gate.)

- [ ] **Step 4: Commit**

```bash
cd /Users/richardivers/code/un1t-crm-ab
git add -A
git commit -m "feat(automations): drop Sequences tab from Communications + rename Sequence→Automation in UI copy"
```

---

## Definition of done (CI mirror from the worktree)

```bash
cd /Users/richardivers/code/un1t-crm-ab
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards
```
All green. **`next build` (Turbopack) can't run under the worktree's symlinked node_modules — the Vercel PR check is the build gate.** This phase adds new route files (`automations/[id]`, `automations/templates`) + a new component import; the Vercel build is the real verification that all moves + imports resolve. Also run `npx next lint` (catches `no-html-link-for-pages`).

**What this delivers:** `/automations` is the single home — curated toggles + custom flows, two sections, per-section permission-gated (no head_coach regression). The flow editor lives at `/automations/[id]`; every old `/communications/sequences/*` and `/email/sequences/*` URL redirects in; Communications is manual-sends + inbox only. Combined with Phases 1–2, "Automations" is the complete operator-facing home for everything that runs by itself.

---

## Self-review
- **Spec coverage:** two-section home (T1); editor/templates re-home + redirects + link sweep (T2); terminology + nav tab removal (T3); permission union gate `automations||email||whatsapp` with per-section gating (T1 Step 2). ✓
- **Placeholders:** none — new component + page + stubs shown in full; the sweep is an exact enumerated list + a grep verification with the precise expected residue.
- **Consistency:** rows link to `/automations/[id]` in the new list AND the editor moved there AND every push/Link repointed there — one canonical path. "UI strings only" rebrand is stated in T3 and bounded (no identifier/route/DB renames). Permission union matches the spec's head_coach safeguard.
- **Ambiguity:** the double-header risk (page `<h1>` vs `AutomationsView`'s own header) is called out with a "read + keep ONE" instruction. The sweep's acceptable residue (comments + the 3 stub files) is made explicit so the verifier knows when it's done.
