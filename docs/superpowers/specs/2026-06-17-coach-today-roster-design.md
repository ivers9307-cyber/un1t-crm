# Coach Today tab — month roster + self-service scheduling — Design

**Status:** approved in design dialogue 2026-06-17 (mockups web + mobile shown + approved). Goes to `writing-plans` after Richard reviews this spec.

**Goal:** Make `/dashboard/today` the **coach's complete self-service scheduling surface**, so a coach (role = `staff`) is given the Today tab **instead of** the gym-wide Schedule tab — and loses no capability in the swap. The current two-week personal roster ("This week" + "Next week" panels) becomes a **month** view, and the swap + time-off flows that today live only on `/schedule` move onto Today.

---

## The reframe (why this is more than a calendar change)

Recon (file:line in §"Verified facts") found that three coach capabilities live **only** on the Schedule tab today. Hiding Schedule from coaches removes them unless Today absorbs them:

1. **Request time off** — web: only `/schedule/time-off` (`TimeOffManager`); mobile: only the floating button on the Schedule tab.
2. **Post a shift for swap** — mobile-only (long-press a shift); **web has no UI at all**.
3. **Track requests** — Today shows swaps + time-off *read-only* and deep-links into `/schedule`, which coaches won't have.

Plus a model gap: **accepting a swap is manager-approved today** (`PUT /api/schedule/swaps/[id]` requires `MANAGER_ROLES`). The decision (below) is to add **coach self-accept**.

## Locked decisions (design dialogue)

1. **Coach self-accept, manager finalises.** A coach **claims/accepts** an offered shift themselves (self-service matching — no manager needed to express interest); the matched swap then **still requires manager approval** to finalise the roster change. New intermediate `awaiting_approval` state between claim and approval. Swaps can be **open** (any `staff` at the location can take) or **targeted** (offered to a specific colleague via a picker).
2. **Gating** — give the Today tab *instead of* Schedule by role default. **`coach` = `staff` only.** head_coach/manager/owner keep Schedule (head_coach ∈ `MANAGER_ROLES`: creates shifts + approves swaps/time-off → genuinely needs Schedule). (Confirm = open question O1.)
3. **"Team on today" strip** — bring a light "who else is on with me today" read onto Today (coaches lose the Schedule Team view).
4. **Roster view defaults** — replace the 2-week with a **Week | Month toggle, Month default**; agenda **hides days off** (per-week count instead); **calendar-month** boundary; grid caps at **2 shifts + "+N more"**; self-serve **Adjust time** stays in the shift-tap actions.

## Structure (the redesigned Today, coach view)

Two blocks (mockups approved web = calendar grid, mobile = agenda):

**Block 1 — My roster (the month).**
- Web: month **calendar grid** (Mon-start, ~5 rows). Cells: date + up to 2 shift chips (time + short label, accent), "+N more", today ringed, off-days blank, draft = amber accent, "posted for swap" = exchange icon.
- Mobile: **agenda list** grouped by week (week header + count), working days only, today highlighted, status badges (Draft / Swap posted / location).
- Header carries the primary actions: **Request time off**, **Week | Month** toggle, month nav (‹ June 2026 ›), and a summary ("17 shifts · 94h this month").
- **Tap a shift** → actions: **Post for swap**, **Adjust time** (self-serve, already allowed), with shift detail (name, time, location).
- A light **"On with you today"** strip (the agreed team read): avatars/names of other coaches working at the same location today. Read-only.

**Block 2 — My requests** (replaces the two read-only deep-link lists).
- One list combining **swaps** (posted by me + offered to me) and **time off**, each with a **status chip** + inline action:
  - Swap I posted → `Pending` + **Cancel**.
  - Swap offered to me / claimable → **Accept** (self-accept, see Phase 3) — or `Awaiting manager` if oversight is on.
  - Time off → `Pending` (+ **Cancel**) / `Approved` / `Rejected`.

Keep the existing **"Needs attention"** triage feed (most plain coaches have no queue perms → it's empty for them) and the KPI row (hours this week, inbox).

## Backend / data

- **Month roster data** — extend `fetchDashboardShifts()` (`shared/dashboard-data.js`) from its fixed 14-day window to a month; return shifts **bucketed by week** (e.g. `weeksInMonth[]`) alongside a `monthStartIso`/`monthEndIso` + `shiftsThisMonth`/`hoursThisMonth` summary. Keep `weekShifts`/`hoursThisWeek` (current-week KPI = pay period) for back-compat. Pure date-range change, no new tables. Web + mobile both consume this helper.
- **Coach claim + manager approval (new lifecycle).** `shift_swap_requests` gains an intermediate state. Flow: **post** (open `target_id=null`, or targeted `target_id=B`) → **claim/accept** by an eligible `staff` at the location (open) or by B (targeted): records the taker on `target_id` + sets `status='awaiting_approval'` → **manager approve** runs the existing assignment-reassignment (`status='swapped'`) or **reject** (back to open/`pending`). Coach can **cancel** their own post, taker can **withdraw** a claim before approval. Route change: add a coach-allowed *claim* branch to `PUT /api/schedule/swaps/[id]` (today the only coach-allowed transition is cancel-own); the manager approve/reject branch stays manager-only but now acts on `awaiting_approval`. Likely a small migration to add the `awaiting_approval` status value (CHECK/enum). No new column — `target_id` doubles as "who will take it".
- **Team-on-today** — a small per-location "who's working today" read (other coaches' shift_assignments for today, slim fields only — matches the RBAC "staff see slim roster" rule). New tiny helper in `shared/dashboard-data.js`.
- **Gating** — flip `schedule` **off in the `staff` role default** (`DEFAULT_WEB_PERMISSIONS_BY_ROLE` + the mobile `schedule`/`time_off` defaults in `shared/permissions.js`); keep `dashboard_personal` on. No migration (role defaults are code). Existing `staff` with no explicit override become Today-only; per-user/per-location overrides still win.

## Phasing (gating cutover LAST so nothing is lost mid-flight)

- **Phase 1 — Month roster** (visual only, no behaviour change): month data bucketing + web calendar grid + mobile agenda + Week|Month toggle. Shippable on its own; Schedule still present.
- **Phase 2 — Self-service actions on Today**: Request-time-off entry, post-a-shift-for-swap (web net-new UI; mobile reuse), inline cancel, shift-tap action sheet (swap/adjust), "My requests" goes live. Reuses existing `POST /api/schedule/swaps` + `/time-off` + cancel routes.
- **Phase 3 — Coach claim + targeted swaps**: swap lifecycle change (claim → `awaiting_approval` → manager approve/reject), open-pool claim + targeted swaps (colleague picker), the Accept/Claim + withdraw affordances, the "open swaps I can take" list, the live "My requests" states, and the "On with you today" strip. Manager approval retained.
- **Phase 4 — Gating cutover**: flip `schedule` off for `staff`. Only after 1–3 prove coaches have everything they need on Today.

## Web specifics
`src/app/dashboard/today/page.js` — replace the two `WeekPanel`s with the month roster (a client component for the toggle + tap actions + live request actions; the page stays the data loader). New: `MonthRoster` (calendar) + `MyRequests` (live list) components. Request-time-off reuses `TimeOffManager`'s form (extract the modal, or a slim shared one). Swap-initiate is net-new web UI calling the existing route.

## Mobile specifics
The personal roster + actions move onto the mobile **home/Personal** surface (`app/(tabs)/index.jsx` Personal segment) so it survives hiding the Schedule tab. Reuse the existing mobile swap-initiate (`createSwapRequest`) + time-off (`createTimeOffRequest`) + the time-off-new modal; add the agenda month + shift action sheet + self-accept (`respondToSwap`-style accept). Mobile parity entry handled per `shared/permissions.js`.

## Out of scope
- Manager/owner Schedule (`/schedule`, `ScheduleCalendar`) — untouched; it already has week + month.
- Roster authoring, publishing, copy-week/month, pay/budget panels — manager surfaces, stay on Schedule.
- The "Needs attention" feed logic and KPI cards — reused as-is.

## Resolved (spec review, 2026-06-17)
- **O1 — coach line:** `coach = staff` only. head_coach/manager/owner keep Schedule (head_coach manages shifts + approvals).
- **O2 — swap oversight:** **manager approval is retained.** Coach claim/accept is a new self-service step *in front of* approval, not a replacement — a coach opts to take a shift; a manager still finalises the roster change. No finalize-immediately, no per-location toggle.
- **O3 — swap style:** support **both** — open swaps (post to the pool, any eligible `staff` at the location can take) **and** targeted swaps (offer to a specific colleague via a picker).

---

## Self-review
- **Coverage:** every coach capability the recon found on Schedule (view shifts, request time off, post for swap, track/cancel requests, adjust own time, see team) has a home on the redesigned Today; gating flips last so none is lost. ✓
- **Reuse:** swap-initiate + time-off + cancel routes already exist and are coach-callable; the only net-new backend is self-accept (O2) + the month data bucketing + the team-today read. Most of Phase 2 is surfacing existing capability. ✓
- **Risk:** the head_coach gating nuance (O1) is the one regression trap — flagged; spec assumes staff-only. The swap self-accept is the one genuine lifecycle change — isolated to Phase 3 + one route.
- **Scoping:** 4 phases each independently shippable; Phase 1 is pure visual; cutover is reversible (flip the role default back).
