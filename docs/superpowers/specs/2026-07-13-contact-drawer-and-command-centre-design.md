# Contact slide-over drawer (pipeline) + contact page command-centre redesign

**Date:** 2026-07-13
**Status:** Approved direction (Richard, 2026-07-13) — mockups at the two Claude artifacts referenced in the session; option A (slide-over) + option 1 (command centre) chosen, Note-first composer.
**Scope:** two related surfaces, shipped as separate PRs sharing extracted components.

## Problem

1. Clicking a deal card on `/pipeline` hard-navigates to `/contacts/[id]` (programmatic `router.push` in `DealCard.jsx`), so the operator loses board position every time they check a contact.
2. The contact page itself is cluttered and disjointed (Richard's words): five tabs spread one relationship across Overview / Activity / Consultations / Comms / Admin — metrics sit mid-scroll, the composer is hidden in Comms while the timeline lives in Activity, and "what happens next" (tasks, sequences, next class) is scattered across three tabs.

## Decisions (locked)

- **Pipeline:** slide-over drawer from the right (option A mockup). Board stays mounted and keeps scroll position; drawer is driven by a `?contact=<id>` search param on `/pipeline` so back-button, refresh, and shared links restore it. Closes via ✕, Esc, scrim click. ‹ › footer arrows step through the current column's deals. "Open full profile →" goes to `/contacts/[id]`.
- **Contact page:** command-centre layout (option 1 mockup). **No tabs.** Header band (identity line + status chips + health stats + quick actions), then three columns:
  - **Left — who they are:** Identity, Details, Glofox membership card, Linked accounts.
  - **Centre — what happened:** composer on top, unified timeline underneath with filter pills (All / Classes / Messages / Notes / System).
  - **Right — what happens next:** Needs attention, Open tasks, Active sequences, Upcoming (bookings/events), Admin actions at the bottom.
- **Composer tab order: Note first (default), then WhatsApp, SMS, Email.** Note mode saves a staff-visible note ("Save note", no send-window copy); message modes keep the existing window/consent behaviour. Applies wherever the shared composer renders (contact page and drawer).
- **Consultations:** keeps its permission gate (`consultations`); renders as a full-width section below the three-column grid (not a tab). Content unchanged.
- **Build order:** extract shared section components → ship the drawer (PR 1) → re-lay-out the contact page (PR 2). The full `/contacts/[id]` page keeps working throughout PR 1.

## Architecture

### Shared section components (extraction, part of PR 1)

Extract from the current `src/app/contacts/[id]/page.js` (1,356 lines, tab JSX built inline) into `src/components/contact/`:

- `ContactHeaderBand` — avatar, name, contact line, status chips (stage, no-class-booked, credits, task-due), health stats (LTV, arrears, attended-30d, first-90), quick actions (PersonActionBar + Book class). Grows from `PersonHeader`.
- `ContactTimeline` — the unified timeline (single-account and grouped-person variants), plus client-side filter pills. Filtering is presentational (type → pill group mapping); no query changes.
- `ContactComposerPanel` — wraps the existing `ContactComposer` + `StartWhatsAppButton`, adds the Note tab as the first/default channel. Note submission reuses `POST /api/contacts/[id]/notes` (the ContactActions flow), which carries the Glofox note-push behaviour — NOT the `/api/notes` import path, which deliberately skips the push (see glofox-notes-sync).
- `ContactNextRail` — needs-attention derivation (no next class + credits remaining, arrears > 0, overdue task), open tasks, active sequences, upcoming bookings/event registrations.
- `ContactWhoRail` — Identity card, Details card, `GlofoxProfileCard` (exists), `LinkedAccountsCard` (exists).

Each component takes plain props (data assembled server-side); no component fetches for itself on the page. This keeps the page a single server component with the existing query set.

### PR 1 — pipeline drawer

- `DealCard` click sets `?contact=<id>` (router.replace with scroll: false) instead of `router.push('/contacts/[id]')`. Kebab menu (PersonActionBar) unchanged.
- New client component `ContactDrawer` rendered by `/pipeline` page; reads the param, fetches a trimmed summary from a new route `GET /api/contacts/[id]/summary`.
- The summary route follows the mutation-route skeleton: `getCurrentUser()` → `hasPermission(user, 'pipeline') || hasPermission(user, 'contacts')` → contact fetched with location scoping → **404 (not 403) when not found / not accessible** → `{ success, data }`. Registered in `src/lib/openapi.js`. Payload: header-band fields, key stats, last ~20 timeline items, open tasks, active sequences, wa-window state for the composer.
- Drawer composes the shared components: `ContactHeaderBand` (compact variant), `ContactComposerPanel`, `ContactTimeline` (capped), `ContactNextRail` (condensed), footer with "Open full profile →" + ‹ › column navigation (drawer receives the ordered deal→contact id list for the open column from the board).
- Esc/scrim/✕ close by clearing the param. `PersonActionBar`'s "Message" action inside the drawer focuses the drawer composer instead of deep-linking `#message`.
- Every non-submit `<button>` inside the drawer gets `type="button"` (composer is a form).

### PR 2 — contact page command centre

- `/contacts/[id]/page.js` re-laid out: `ContactHeaderBand` full variant, then `grid` (who-rail / centre feed / next-rail), then Consultations section (gated), keeping all existing data assembly, permission gates (`MANAGER_ROLES` for edit/delete, master/owner for password override), and the Glofox/linked-account logic.
- The five tabs and `ContactDetailTabs` usage on this page are removed; `#message` anchor is kept (points at the composer panel) because `PersonActionBar` deep-links to it from elsewhere.
- Responsive: three columns ≥ xl; below that the rails stack (header → needs-attention → composer+timeline → who-rail → admin), preserving mobile usability of the web page.

## Invariants that apply (checked against CLAUDE.md)

- Summary route: service-role client ⇒ **no RLS protection** — location scoping + 404-not-403 in app code; `check:route-guards` must pass; register in `openapi.js`.
- Chips use the light-theme ramp `bg-*-500/10 text-*-700` (lint-enforced).
- No `new Date(...Z)` / UTC-today patterns in the next-class and window logic — reuse the server-derived `next_class_at` and `dublinTodayStr()` helpers.
- `npm run build` locally before pushing (new imports + a new route).
- Mobile parity: new web permission keys are **not** added (drawer reuses `pipeline`/`contacts`), so no parity entry needed; if that changes, add `WEB_ONLY_OK` with reason.

## Out of scope

- Any change to the pipeline board itself (columns, classifier, read-only rule stay as-is).
- Mobile app screens (web only; mobile contact screen untouched).
- Option B "pin the panel" docked mode — possible follow-up on the same component.
- Consultations content redesign.

## Testing

- Unit: needs-attention derivation, timeline filter mapping, column-navigation order helper (pure lib functions, vitest).
- Route: summary route auth/404/scoping tests following existing route-test patterns.
- Manual: drawer open/close/Esc/back-button on /pipeline (both views), Note-first composer save, full-page layout at xl and stacked widths, permission-gated sections (consultations, admin actions) for a staff-role user.
