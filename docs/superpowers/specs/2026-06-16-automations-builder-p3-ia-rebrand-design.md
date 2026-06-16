# Automations Builder — Phase 3: IA Rebrand (Sequences → Automations) Design

**Status:** approved in design dialogue 2026-06-16 (two open IA questions resolved). Sub-project of the umbrella [operator-authored-automations design](2026-06-16-operator-authored-automations-design.md). Goes to `writing-plans` next.

**Goal:** Unify the two automation homes into one. Today the **curated toggle hub** lives at `/automations` (gated by the `automations` permission) and the **custom flows** (sequences) live at `/communications/sequences/*` (gated by `email`). Phase 3 makes `/automations` the single home for both, re-homes the flow editor under `/automations`, redirects the old sequence paths, and renames "Sequence" → "Automation" in the UI. **No engine change, no DB change** — the tables (`email_sequences` etc.) and the runner keep their names; this is purely IA + presentation (same back-compat posture as Phase 1/2 and the earlier `/email/*` → `/communications/*` retirement).

**Locked decisions (design dialogue):**
1. **Home layout = two sections, one page.** `/automations` renders a **Quick automations** block (the curated registry toggle cards — the Glofox card + toggle + backfill) on top, then a **Your automations** list (the custom flows) below, with a "Build an automation" / "Build with AI" entry. Respects that the two interact differently (toggle vs open-the-editor) without tab friction.
2. **Keep the curated Glofox automation as-is.** It stays the instant, synchronous "simple" path (the shipped #544/#545 toggle + backfill), rendered in the Quick automations block. Custom flows are the build-your-own path. (Re-expressing it as a flow is a deferred P4 templates concern.)

---

## Current state (verified)

- **`/automations`** — `src/app/automations/page.js` loads `location_automations` + builds cards → `<AutomationsView>` (curated toggle cards). Page guard: `hasPermission(user, 'automations')` → else redirect `/dashboard`. Nav entry `{ href:'/automations', section:'automations' }` (its own sidebar section).
- **`/communications/sequences`** — list page (`src/app/communications/sequences/page.js`, guard `hasPermission(user,'email')`), editor `[id]/page.js` (the visual flow-graph builder), `templates/page.js`. Renders inside the Communications layout (`src/app/communications/layout.js` → `<CommunicationsTabs>` sub-nav, which has a **Sequences** tab). Builder components live in `src/components/sequences/*` (FlowEditor, SequenceFlowBuilder, SequenceSettings, AgentPanel, NewSequenceButton, DeleteSequenceButton) — these are route-agnostic and **do not move**.
- **`/email/sequences/*`** — already redirect stubs → `/communications/sequences` (the prior email→communications retirement; the move+redirect-stub pattern is established and proven).

## Target state

- **`/automations` = the one home**, a two-section page:
  - **Quick automations** (top) — the current `<AutomationsView>` content (curated toggle cards). Rendered only when the user has the `automations` permission.
  - **Your automations** (below) — the custom-flows list (moved from the sequences list page): each row = name, trigger label, status pill (draft/active/paused), step count → links to `/automations/[id]`; plus the "New automation" + "Build with AI" + template-install entries. Rendered when the user has `email` OR `whatsapp` (the existing sequence gate) — see Permissions.
- **Flow editor** re-homed to `/automations/[id]`; **templates** to `/automations/templates`. The page route files move; the `src/components/sequences/*` components are imported unchanged.
- **Redirect stubs** at `/communications/sequences`, `/communications/sequences/[id]`, `/communications/sequences/templates` → the new `/automations*` paths. The existing `/email/sequences/*` stubs are repointed straight to `/automations` (avoid a double-hop).
- **Terminology:** "Sequence" → "Automation" / "Flow" in user-facing strings on the moved pages + the list + buttons. **Internal names unchanged** (DB tables, the `SequencePicker` component, API routes `/api/sequences/*`, trigger/step type strings) — UI-only rename, exactly like `lead_status`→`pipeline_stage_slug` kept internals.
- **Nav:** the existing `/automations` sidebar entry stays as the home. The **Sequences sub-tab is removed from `CommunicationsTabs.jsx`** so Communications = manual sends + inbox only; Automations = anything that runs by itself.

## Permissions (no regression, no defaults change)

- The unified `/automations` **page** renders for `automations` OR `email` OR `whatsapp` (today the curated hub needs `automations`; sequences need `email`). Broadening the page gate to the union means **nobody who can use either surface today loses access** — important because `head_coach` manages sequences via `email` but has `automations=false` by default (#544).
- Within the page: the **Quick automations** section renders only with `automations`; the **Your automations** (flows) section renders only with `email`/`whatsapp`. So each operator sees exactly the sub-surfaces they could use before — just on one page.
- No change to `shared/permissions.js` defaults, no new permission key → mobile-parity unaffected.

## What moves vs. what stays

| Moves (page route files) | Stays (unchanged) |
|---|---|
| `communications/sequences/page.js` → folded into `automations/page.js` (Your-automations section) | `src/components/sequences/*` (builder components — imported by the new paths) |
| `communications/sequences/[id]/page.js` → `automations/[id]/page.js` | `src/lib/sequences/*` (engine + agent) |
| `communications/sequences/templates/page.js` → `automations/templates/page.js` | `/api/sequences/*` routes (internal API names) |
| | `email_sequences`/`sequence_steps`/`sequence_enrollments` tables |
| | `SequencePicker.jsx` (the ad-hoc enrol picker on contact/pipeline/contacts — still points at the engine; its links update to `/automations/[id]` but the component name stays) |

**Internal-link sweep (correctness-critical):** every in-app navigation to `/communications/sequences*` must be repointed to `/automations*`. Known sources to update: `NewSequenceButton`, `CloneSequenceButton`, `SequenceTemplatePicker`, `InstallTemplateButton`, `SequencePicker`, `AgentPanel`/publish redirect, the old list/editor cross-links, and any dashboard/radar deep-links. The plan must `grep -rn "/communications/sequences" src/` and convert them all; the redirect stubs are the safety net for external bookmarks, not an excuse to leave internal links stale.

## Decomposition (the plan will detail; ~3 tasks)

1. **Unified home** — extend `automations/page.js` to render the curated section (existing `<AutomationsView>`, `automations`-gated) **+** a new "Your automations" custom-flows section (load `email_sequences` for the active location; render the list + New/Build-with-AI/template entries, `email`/`whatsapp`-gated). Broaden the page gate to the union. Extract the list rendering into a small component so the page stays focused.
2. **Re-home editor + templates + redirects** — move `[id]` + `templates` page files to `/automations/*`; add redirect stubs at the three `/communications/sequences*` paths; repoint the `/email/sequences/*` stubs to `/automations`; sweep + repoint all internal `/communications/sequences` links.
3. **Terminology + nav** — "Sequence"→"Automation" UI strings on the moved/!new surfaces; remove the Sequences tab from `CommunicationsTabs.jsx`. Verify the Communications layout still renders fine without it.

Each task ships working software; build in order (the redirects in T2 depend on the home in T1 existing). Worktree-isolated (concurrent session active). Build gate = Vercel PR check (worktree symlink blocks local Turbopack), per Phase 2.

## Out of scope (deferred)
- **Templates gallery + run history** — P4.
- **Re-expressing the curated Glofox automation as a flow** — decided against for now (keep the synchronous hook).
- **Renaming DB tables / API routes / the `SequencePicker` component** — internal names stay; UI-only rebrand.
- **Mobile** — no mobile sequences/automations surface exists; nothing to mirror.

## Open question for the plan (decide at writing-plans, low-stakes)
- Whether the "Your automations" list is extracted into a new `src/components/automations/AutomationsList.jsx` (client) or rendered inline in the server page. Lean: a small server-rendered section in the page + reuse of the existing list-row markup, extracted to a component only if it exceeds ~friendly size. (The plan picks one.)

---

## Self-review
- **Placeholders:** none — every moved/added/removed file is named; the internal-link sweep is specified as a concrete grep + convert step.
- **Consistency:** "two sections, keep Glofox as-is" (the locked decisions) drive the home design; "UI-only rebrand, internals unchanged" is stated once and held across the moves/terminology sections; permissions section explicitly prevents the head_coach regression the naive `automations`-only gate would cause.
- **Scope:** one cohesive IA change, decomposed into 3 ordered shippable tasks; engine/DB/mobile explicitly out of scope.
- **Ambiguity:** "rebrand" pinned to UI strings + route moves + redirects + nav, NOT schema/API/component renames. "Unify" pinned to the two-section single page with per-section permission gating.
