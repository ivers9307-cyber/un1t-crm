# Staff switch for per-studio marketing consent (STAFFCONSENT.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners and managers can switch a contact's marketing email on or off for one studio from the contact page, with a required reason recorded in the consent log.

**Architecture:** The preference centre's per-studio write (`PUT /api/preferences/[token]` with `locationId`) is extracted into one lib function. The preference centre and a new staff route both call it, so a studio change has one set of rules: the studio row only (never `contact_preferences`, whose trigger fans an opt-out to every studio), opt-out propagation to linked addresses, the email-reputation rule, and the Postmark suppression lift on opt-in. The consent card gets a per-studio row with a switch and a reason dialog.

**Tech Stack:** Next.js 16 App Router, Supabase service role, zod 4, vitest, React.

**Spec:** [`docs/superpowers/specs/2026-11-14-staff-studio-consent-design.md`](../specs/2026-11-14-staff-studio-consent-design.md)

## Correction to the spec (recorded while planning)

The spec says the write goes through `applyFormMarketingConsent`. That function flips all three channels and writes the overall `contact_preferences` row too, so a staff opt-out at one studio would become an opt-out everywhere. The preference centre's scoped path is the correct model, so the shared function is extracted from it instead. Everything else in the spec stands.

## Global Constraints

- Worktree `~/code/un1t-crm-staff-consent`, branch `staff-studio-consent`. Next free migration: `831`.
- Email marketing only: the staff route never changes SMS or WhatsApp, or `contact_preferences`.
- Reasons, verbatim: `in_person`, `phone`, `email`, `signed_form`, `other`. Note at most 500 characters, required when the reason is `other`.
- `consent_log.source` for staff changes: `staff_studio`, registered in `src/lib/consent-sources.js` as voluntary.
- Who: `ADMIN_ROLES` at the studio, or master. A contact not readable at that studio, an unknown contact, or a studio with no `contact_location_preferences` row for the contact answers the ordinary not-found.
- Supabase writes: `await`, destructure `error`; the studio-row write failing is an error response, never success. A no-op returns success with no write and no log row.
- The preference centre's behaviour, response shapes and existing tests must not change.
- Commit subject `STAFFCONSENT.1 — …`, trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A staff opt-out at one studio leaving every other studio on.** The overall `contact_preferences` row must not be written. → Task 3.
2. **A re-subscribe for an address Postmark suppressed after a one-click unsubscribe.** The suppression is lifted (a manual one only), or the opt-in is recorded but mail never arrives. → Task 2.
3. **A manager at Hatch trying to change a Stillorgan contact's Stillorgan setting.** Refused as not-found. → Task 3.
4. **Reason `other` with an empty or whitespace note.** `invalid input`, nothing written. → Task 3.
5. **The same switch pressed twice.** The second press is a no-op with no extra log row. → Task 3.

---

### Task 1: Migration 831 and the source registry

**Files:** Create `supabase/migrations/831_consent_log_reason_note.sql`, `tests/migration-831-consent-log-reason-note.test.js`. Modify `src/lib/consent-sources.js` (+ its test).

- [ ] Test: the migration adds `reason text` and `note text` to `public.consent_log` with `IF NOT EXISTS`, grants nothing to `anon`/`authenticated` (the table is closed to clients since mig 662), and adds no policy. The registry classifies `staff_studio` as voluntary.
- [ ] Run → FAIL; write the migration (house header, "NOT APPLIED"); register the source; run with `npm run check:select-columns` → PASS.
- [ ] Commit `STAFFCONSENT.1 — mig 831: consent_log reason and note; staff_studio source`.

### Task 2: One per-studio consent write, shared by the preference centre

**Files:** Create `src/lib/studio-consent.js`, `src/lib/studio-consent.test.js`. Modify `src/app/api/preferences/[token]/route.js`.

**Interfaces — Produces:** `applyStudioPreferenceChange(db, { contact, locationId, changes, source, ipAddress = null, performedBy = null, reason = null, note = null }): Promise<{ ok: true, changed: string[] } | { ok: false, error: string, status: 404 | 500 }>`.
- `contact`: `{ id, email, wa_phone, email_status, location_id }`.
- `changes`: an object of channel → boolean, channels from the preference centre's six.
- Behaviour, moved from the PUT handler's `locationId` branch unchanged: read the studio row (none → `{ ok: false, status: 404 }`); diff; nothing changed → `{ ok: true, changed: [] }`; update the studio row only (error → `status: 500`); insert consent_log rows with `location_id`, `performed_by`, `reason`, `note`; propagate opt-outs; on email opt-in, the reputation normalise; then the existing Postmark rule: a scoped opt-out never suppresses at Postmark, an opt-in runs `unsuppressAtPostmark`.

- [ ] Tests: the studio row only is written (no `contact_preferences` write); log rows carry `performed_by`, `reason`, `note`, `location_id`; no-op writes nothing; a studio-row error returns `status: 500` and no log row; a missing studio row returns 404; an email opt-in calls `unsuppressAtPostmark`; an opt-out calls `propagateOptOut` and never `suppressAtPostmark`.
- [ ] Refactor the PUT `locationId` branch to call it with `source: 'preference_centre'`. Its existing test file passes unedited.
- [ ] Run `npx vitest run src/lib/studio-consent.test.js 'src/app/api/preferences' 'src/app/api/unsubscribe'` → PASS.
- [ ] Commit `STAFFCONSENT.1 — one per-studio consent write, shared with the preference centre`.

### Task 3: The staff route and the studio list

**Files:** Create `src/app/api/contacts/[id]/studio-consent/route.js` (+ test). Modify `src/app/api/contacts/[id]/marketing-preferences/route.js` GET (+ test), `src/lib/openapi.js`.

**Interfaces — Produces:**
- `POST /api/contacts/[id]/studio-consent` body `{ location_id, email_marketing: boolean, reason, note? }` → `{ success: true, data: { changed } }`. Order: session user (401) → zod (reason enum, note rule) → `ADMIN_ROLES` at `location_id` or master (else 404) → contact readable at that studio: homed there or a `contact_studios` row there (else 404) → `applyStudioPreferenceChange(db, { …, changes: { email_marketing }, source: 'staff_studio', performedBy: user.id, reason, note })` → map its result (404 / 500 / success).
- GET marketing-preferences adds `studios: [{ location_id, name, email_marketing, can_edit }]` from `contact_location_preferences` joined to `locations(name)`, `can_edit` = `ADMIN_ROLES` there or master. Existing keys unchanged.

- [ ] Tests (route): Review Focus 1, 3, 4, 5; a session-less call is 401; an OAuth bearer is refused by the proxy as today (no special code). GET: `studios` present with `can_edit` per studio; existing fields unchanged.
- [ ] Implement; register in openapi.
- [ ] Run `npx vitest run 'src/app/api/contacts/[id]/studio-consent' 'src/app/api/contacts/[id]/marketing-preferences' && npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns` → PASS.
- [ ] Commit `STAFFCONSENT.1 — staff route for per-studio marketing email consent`.

### Task 4: The consent card

**Files:** Modify `src/components/ContactMarketingPreferencesCard.jsx` (+ test).

- [ ] Tests: a "Studio lists" section lists each studio with its email state; a studio with `can_edit` has a switch, others are read-only; switching opens a dialog with the five reasons and a note, Save disabled until a reason is chosen (and a note for `other`); Save posts to the route and updates the row; a failure shows the error and leaves the row as it was; every button `type="button"`.
- [ ] Implement with the existing `@/components/ui` primitives and `bg-<c>-500/10 text-<c>-700` chips.
- [ ] Run the card's test file and `npm run check:guardrails` → PASS.
- [ ] Commit `STAFFCONSENT.1 — per-studio switch with a reason on the contact page`.

### Task 5: Docs, checks, PR

- [ ] CLAUDE.md consent bullet: name `POST /api/contacts/[id]/studio-consent` among the consent writers and `applyStudioPreferenceChange` as the one per-studio write.
- [ ] The thirteen-command CI mirror, then `npm run build` separately.
- [ ] Push, open the PR (mig 831 before the deploy; first live use: re-subscribe Richard's two test addresses at Stillorgan, reason `email`), add the changelog entry.
