# Coach Today roster — Phase 2 (self-service actions) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. **Work from the worktree `/Users/richardivers/code/un1t-crm-ct` on branch `feat/coach-today-actions`** — every task's first step is the branch guard (`git -C /Users/richardivers/code/un1t-crm-ct branch --show-current` → `feat/coach-today-actions`, else STOP).

**Goal:** Put the coach's scheduling **actions** on the Today dashboard so they no longer need the Schedule tab to *do* anything: **request time off**, **post a shift for swap**, **adjust their own shift time**, and **cancel/track their own requests**. All of these reuse routes that already exist and are coach-callable — Phase 2 is **UI wiring only: no new API route, no migration, no permission change, no swap-lifecycle change** (coach self-accept + targeted swaps are Phase 3; the `schedule`-off gating is Phase 4).

**Spec:** `docs/superpowers/specs/2026-06-17-coach-today-roster-design.md`. **Builds on Phase 1** (merged #562): `MonthRoster.jsx` (web), the mobile agenda in `PersonalDashboard.jsx`, and the month data from `fetchPersonalDashboardData`.

---

## Verified facts (routes + payloads — confirmed from source)
- **Post a shift for swap (open):** `POST /api/schedule/swaps` body `{ requester_shift_id }` (= the shift's `shift_assignments.id`, which is the `id` already on each roster shift). `target_id`/`target_shift_id` omitted → open swap; the route derives `location_id` from the assignment and notifies managers. Coach-callable (verifies the caller owns the assignment).
- **Cancel my swap:** `PUT /api/schedule/swaps/[id]` body `{ status: 'cancelled' }` — allowed for the requester while pending.
- **Request time off:** `POST /api/schedule/time-off` body `{ type: 'holiday'|'sick'|'unpaid'|'other', start_date, end_date, reason? }` (ISO dates). Coach-callable.
- **Cancel my time-off:** `PUT /api/schedule/time-off/[id]` body `{ status: 'cancelled' }` — allowed for own pending request.
- **Adjust my shift time:** `PUT /api/schedule/assignments/[id]` (the route the mobile `adjustShiftAssignment` helper already calls) — body has start/end override + reason. **Confirm the exact field names** in `src/app/api/schedule/assignments/[id]/route.js` before wiring (likely `start_time_override`/`end_time_override`/`reason`); self-adjust is allowed.
- **Mobile helpers already exist** in `mobile/lib/schedule-api.js`: `createSwapRequest({requesterShiftId,...})`, `cancelTimeOffRequest(id, locationId)`, `createTimeOffRequest({type,startDate,endDate,reason,locationId})`, `adjustShiftAssignment(assignmentId,{startTime,endTime,reason,locationId})`, `getMyTimeOff(...)`. There's no swap-cancel helper yet — add one (`cancelSwapRequest(id, locationId)` → `PUT /api/schedule/swaps/:id {status:'cancelled'}`) mirroring `cancelTimeOffRequest`.
- Web has no api-wrapper lib for these — web components `fetch()` the routes directly (see `TimeOffManager.jsx` / `SwapRequestsManager.jsx` for the established pattern + toast/error handling).
- Today's `today/page.js` already shows read-only `pendingSwapsForMe` + `myPendingTimeOff` ListCards that deep-link to `/schedule` (lines ~382–410) — Phase 2 replaces those with a live component.

---

## Task 1: Shared data — `myPostedSwaps`

**File:** Modify `shared/dashboard-data.js`.

- [ ] **Step 1: Branch guard.**
- [ ] **Step 2:** In `fetchPersonalDashboardData`, add a query for **swaps the user posted that are still open** — `shift_swap_requests` where `requester_id = profileId` AND `status = 'pending'`, selecting `id, status, reason, created_at, target_id, requester_shift_id, requester_shift:shift_assignments!requester_shift_id(shift_blocks!block_id(block_date), shift_templates(name))` (mirror the embed shape the existing `pendingSwapsForMe` query uses; disambiguate the `shift_assignments` FK). Return it as `myPostedSwaps` alongside the existing fields. Keep everything else. (No pure logic → no new unit test; covered by the CI mirror + review.)
- [ ] **Step 3: Commit** — `git add shared/dashboard-data.js && git commit -m "feat(today): fetch myPostedSwaps for the self-service requests list"`

---

## Task 2: Web — shift-tap actions (post for swap + adjust time) + Request time off

**Files:** Modify `src/components/dashboard/MonthRoster.jsx`; create `src/components/dashboard/RequestTimeOffModal.jsx`.

- [ ] **Step 1: Branch guard.**
- [ ] **Step 2 — shift action menu:** in `MonthRoster.jsx`, make each shift (calendar chip in Month mode + the row in Week-mode panels) **clickable** → open a small popover/modal anchored to that shift showing its name + time + location and actions:
  - **Post for swap** — `fetch('/api/schedule/swaps', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ requester_shift_id: shift.id }) })`. On success: a confirmation ("Posted for swap — your manager will confirm it") + refresh the page data (`router.refresh()` from `next/navigation`). Disable/hide for **past** shifts and shifts already `status==='swapped'` or already posted (if a posted-swap set is available; otherwise allow + let the route be idempotent-ish). Follow `SwapRequestsManager.jsx` for fetch/error/toast conventions.
  - **Adjust time** — opens a tiny inline form (two `HH:MM` inputs prefilled from the shift's effective start/end + optional reason) → `PUT /api/schedule/assignments/${shift.id}` with the **confirmed** payload field names (read `src/app/api/schedule/assignments/[id]/route.js` first). Success → confirmation + `router.refresh()`. A "Clear override" affordance if the shift has overrides (mirror mobile `AdjustSheet`).
  - Keep it keyboard-accessible + dismissable; reuse `src/components/ui` primitives (`Modal`/`Button`) where natural.
- [ ] **Step 3 — Request time off:** create `RequestTimeOffModal.jsx` (client) — type select (holiday/sick/unpaid/other), start + end date, optional reason → `POST /api/schedule/time-off`. Reuse the field set + validation messaging from `TimeOffManager.jsx` (extract or mirror; don't import the whole manager). Add a **"Request time off"** button to the `MonthRoster` header (per the approved mock) that opens it; on success → confirmation + `router.refresh()`.
- [ ] **Step 4:** `npx eslint` the changed files + `npx next lint 2>&1 | tail -15` (catches `no-html-link-for-pages` if any internal `<a>` slipped in — use `<Link>`/buttons). Commit: `git commit -am "feat(today): web shift-tap actions (post for swap, adjust time) + request time off"`

---

## Task 3: Web — live "My requests"

**Files:** Create `src/components/dashboard/MyRequests.jsx`; modify `src/app/dashboard/today/page.js`.

- [ ] **Step 1: Branch guard.**
- [ ] **Step 2:** Create `MyRequests.jsx` (client) taking `{ postedSwaps, swapsForMe, timeOff }` (initial server data). Renders one "My requests" section (replaces the two read-only ListCards):
  - **Swaps I posted** (`postedSwaps` = `myPostedSwaps`): label + shift + `Pending` chip + **Cancel** (`PUT /api/schedule/swaps/${id} {status:'cancelled'}` → refresh).
  - **Swaps offered to me** (`swapsForMe` = `pendingSwapsForMe`): read-only with an `Awaiting manager` chip (self-accept is Phase 3 — do NOT add an Accept button here).
  - **Time off** (`timeOff` = `myPendingTimeOff`): label + dates + status chip; **Cancel** on pending (`PUT /api/schedule/time-off/${id} {status:'cancelled'}` → refresh).
  - Empty state when all three are empty. Match the mock's "My requests" card (status chips: amber `Awaiting manager`, neutral `Pending`, green `Approved`). Light-theme `-700` text ramp; no raw hex.
- [ ] **Step 3:** In `today/page.js`, destructure `myPostedSwaps` from `res.data`; replace the two `<SectionHeader>`+`<ListCard>` blocks ("Swap requests for you" + "Your time-off requests") with `<MyRequests postedSwaps={myPostedSwaps} swapsForMe={pendingSwapsForMe} timeOff={myPendingTimeOff} />`. Leave the KPI row + "Needs attention" feed + the roster (MonthRoster) untouched.
- [ ] **Step 4:** `npx eslint` + `npx next lint | tail -15`; commit `git commit -am "feat(today): live My requests (cancel own swap/time-off; statuses) replacing read-only lists"`

---

## Task 4: Mobile — shift-tap actions + request time off + My-requests cancel

**Files:** Modify `mobile/components/dashboard/PersonalDashboard.jsx`; `mobile/lib/schedule-api.js` (add `cancelSwapRequest`).

- [ ] **Step 1: Branch guard.**
- [ ] **Step 2:** Add `cancelSwapRequest(id, locationId)` to `schedule-api.js` (mirror `cancelTimeOffRequest`).
- [ ] **Step 3:** In the agenda (`PersonalDashboard.jsx`): make a shift row **tappable** → an action sheet (`Alert.alert` or a bottom-sheet, matching the existing `requestSwapForShift`/`AdjustSheet` patterns on `schedule.jsx`) with **Post for swap** (`createSwapRequest({ requesterShiftId: shift.id, locationId })`) and **Adjust time** (reuse the adjust flow → `adjustShiftAssignment`). Guard past shifts. On success: refresh (`load()`).
- [ ] **Step 4:** Add a **Request time off** entry on the roster surface — push the existing modal route `router.push('/schedule/time-off-new')` (it's a standalone screen, navigable even once the Schedule tab is later hidden). 
- [ ] **Step 5:** Make the **My-requests** lists live: my posted swaps (from `data.myPostedSwaps`) + my time-off get a **Cancel** action (`cancelSwapRequest` / `cancelTimeOffRequest` → `load()`); swaps-offered-to-me stay read-only "Awaiting manager". 
- [ ] **Step 6:** Commit `git commit -am "feat(today): mobile shift-tap actions + request time off + cancel own requests"`

---

## Task 5: Review + CI + PR

- [ ] **Step 1: Branch guard.**
- [ ] **Step 2: Full CI mirror** (report each): `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards`
- [ ] **Step 3: Spec + quality review** (subagent): actions reuse existing routes only (no new route/migration/permission/swap-lifecycle change); post-for-swap = open swap; no Accept button (Phase 3); cancel limited to own requests; light-theme ramp; mobile `cancelSwapRequest` goes through `authHeaders()` (per the mobile-Bearer rule); `router.refresh()` actually re-renders the server data.
- [ ] **Step 4:** Fix issues; push; open PR (base main). Body: Phase 2 of the coach-Today spec; UI wiring to existing routes; Vercel build = gate.

---

## Definition of done
A coach can, from Today (web + mobile): request time off, post a shift for swap, adjust their own shift time, and cancel/track their own requests — without opening Schedule. **No new route, migration, permission, or swap-lifecycle change.** CI mirror green; Vercel PR check is the build gate.

## Self-review
- **Spec coverage:** request time off, post-for-swap, adjust-own-time, live My-requests with cancel — all from the spec's Phase 2; coach-accept + targeted swaps deferred to Phase 3 (explicitly excluded here). ✓
- **Reuse:** every action hits an existing coach-callable route; mobile reuses existing helpers (+ one new `cancelSwapRequest`); web follows the `TimeOffManager`/`SwapRequestsManager` fetch pattern. Only data addition = `myPostedSwaps`. ✓
- **No scope creep:** no Accept/claim (Phase 3), no targeted-swap picker (Phase 3), no `schedule` gating (Phase 4), no "team on today" strip (Phase 3 per spec). 
- **Risk:** the web `assignments/[id]` adjust payload must be confirmed against the route before wiring (flagged in T2); `router.refresh()` is the refresh mechanism for the server-rendered Today page after a client mutation.
