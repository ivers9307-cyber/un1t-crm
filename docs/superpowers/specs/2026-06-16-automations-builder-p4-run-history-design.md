# Automations Builder — Phase 4: Run History Design

**Status:** approved in design dialogue 2026-06-16. Sub-project of the umbrella [operator-authored-automations design](2026-06-16-operator-authored-automations-design.md). Goes to `writing-plans` next.

**Goal:** Give the operator a **Performance** view on the automation editor (`/automations/[id]`) answering "did it fire, for whom, and what happened" — the enrolment funnel + per-step email performance (surface the **already-built** `/api/sequences/[id]/stats`) plus a **Recent activity** list of the last contacts the automation touched (one new thin endpoint).

**Scope finding (verified):** P4's "templates gallery" is **already shipped** — `src/lib/sequence-templates.js` has 22 installable templates (incl. operational ones: trial-engaged→pipeline-move, trial-ended win-back, converted-welcome, Glofox welcome+passcode) at `/automations/templates`. So P4 = **run history only**. **Decision (locked): Performance panel + recent runs.**

---

## What exists vs. what's missing
- **`GET /api/sequences/[id]/stats`** EXISTS (manager+ / assertLocationAccess) and returns `{ enrolments: {total, active, completed, exited, paused}, exit_reasons: {<reason>: count}, per_step: {<sequence_step_id>: {sent, opened, clicked, bounced, complained, failed}} }` (per-step is **email-only** by design — SMS/WA carry no open/click signal). **Nothing in the UI renders it** — that's the gap.
- **No per-contact run log.** `sequence_enrollments` has the data (`contact_id, status, current_step_order, exit_reason, last_error, error_count, source_type, created_at, last_processed_at`) but no endpoint/UI surfaces it.

## Architecture (no engine/DB change)
1. **New `GET /api/sequences/[id]/runs`** — manager+ + `assertLocationAccess`, mirrors the `/stats` guard exactly. Returns the last 50 `sequence_enrollments` for the sequence, `order by created_at desc`, with a `contacts(first_name,last_name,email)` embed (sequence_enrollments has a single FK to contacts → a bare embed is safe). Maps each row through a pure helper to a display shape.
2. **Pure helper `src/lib/sequences/run-history.js`** — `summariseEnrolmentRun(enrollment, stepCount)` → `{ state, stepLabel, outcome }` (e.g. active→"On step 2 of 4"; completed→"Completed"; exited→"Exited: goal met" / the exit_reason; paused→"Paused: <last_error>"). Pure + unit-tested; keeps the route thin and the mapping covered without DB mocking.
3. **New client component `src/components/automations/AutomationPerformance.jsx`** — fetches `/stats` + `/runs` on mount, renders three blocks: **funnel** (enrolled / active / completed / exited[+reason breakdown] / paused chips), **per-step performance** (a row per step — label each via the passed `steps` array; email steps show sent/open/click, non-email steps show sent only), and **recent activity** (the `/runs` list: contact name, outcome from the helper, relative time). Handles 403 (non-manager) + empty + error states by hiding/condensing gracefully.
4. **Mount** `<AutomationPerformance sequenceId={sequence.id} steps={sequence.sequence_steps} />` on `src/app/automations/[id]/page.js` **below** `<SequenceFlowBuilder>` — keeps the complex builder component untouched; the performance view is an isolated, lazy section.

## Permissions
Both endpoints are manager+ + `assertLocationAccess` (the existing `/stats` contract; `/runs` mirrors it). The component degrades gracefully if the fetch 403s (a head_coach/staff who can open the editor but isn't manager+ simply doesn't see the performance section). No new permission key → no parity impact.

## Out of scope
- Templates gallery (already shipped — 22 templates).
- SMS/WhatsApp per-step open/click (no provider signal; those steps show "sent" only).
- Real-time/live updates (fetch on mount; operator refreshes the page for fresh numbers).
- Charts/graphs — plain chips + a table + a list (the data's small; recharts would be overkill).
- Pagination of runs beyond the latest 50 (a "showing last 50" note if the cap is hit; full history is a later concern if ever needed).

## Decomposition (2 tasks)
1. **`/runs` endpoint + `run-history.js` pure helper + tests.** Helper first (TDD), then the thin route consuming it.
2. **`AutomationPerformance.jsx` + mount on the editor page.** Consumes `/stats` + `/runs`; render funnel + per-step + recent activity; mount below the builder.

Worktree-isolated (concurrent session active); Vercel PR check = build gate (worktree symlink blocks local Turbopack). Build in order (the component consumes the endpoint).

---

## Self-review
- **Placeholders:** none — `/stats` shape is quoted verbatim from the live route; the helper signature + `/runs` shape are concrete; enrollment columns are the real ones.
- **Consistency:** `/runs` reuses the exact `/stats` guard (manager+ / assertLocationAccess / 404-not-found-then-403). The component is isolated + mounted on the page (no `SequenceFlowBuilder` surgery), matching how P3 kept the builder untouched.
- **Scope:** templates explicitly out (already shipped); run-history split into a testable backend task + a UI task. Small, single-plan.
- **Ambiguity:** "run history" pinned to funnel + per-step (from `/stats`) + a last-50 per-contact activity list (from `/runs`) — not charts, not real-time, not full pagination.
