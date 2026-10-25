# Find Me a Team Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Find me a team" choice, first among the team sizes on a race event's signup, that registers and charges one person as a team of one flagged for placement, with staff placing or pairing solos from the Teams page.

**Architecture:** No new table. `race_registrations` gains `looking_for_team`, `placed_into_registration_id`, `placed_at`, `placed_by` and a `placed` status; `race_events.find_team` jsonb holds the switch and copy. The public register route accepts `find_team: true` and reuses every existing step (contact, team, registration, pricing, payment, confirmation). In `teams` capacity mode an unplaced solo is excluded from wave counts by one helper used at every count site. Two staff routes move people: place into a team, pair solos into a new team.

**Tech Stack:** as the donations plan.

**Spec:** `docs/superpowers/specs/2026-10-24-charity-donations-design.md` §6b. Ships as its own PR on a branch off `origin/main` after the donations PR merges (the two touch `RaceSignupWidget.jsx` and `RaceEventForm.jsx` in different places; rebase if both are open).

## Global Constraints

- Same CLAUDE.md rules as the donations plan (service role, 404 on misses, destructured errors, `check:select-columns`, operator-editable copy with defaults).
- `race_registrations` has no client privilege (mig 682): new columns carry `-- column-grant: withheld` notes.
- `placed` is NOT in `LIVE_REGISTRATION_STATUSES` (`['pending_payment', 'confirmed']`) and is never written by anything but the two staff routes.
- Payments are never re-pointed: `race_payments.race_registration_id` stays on the solo's row.
- Migration number **766**.
- Ticket prefix `FINDTEAM.<n>`.

## Review Focus

1. A solo whose payment is still `pending_payment` must not be placeable (Task 5 test: 409 `not_paid`).
2. A solo already `placed` or `cancelled` sent to place or pair → 409, no second `team_members` row (Task 5 test).
3. Pairing solos from two different waves → 400 `mixed_waves` unless `wave_id` is given, in which case the new team lands in that wave (Task 5 test).
4. A race whose `find_team` is switched off after a solo registered: the solo still shows in the staff list and can still be placed (Task 5: the routes never read the switch).
5. `find_team: true` on a non-race kind → 400 `find_team_unavailable` (Task 3 test).

---

### Task 1: Migration 766 — registration columns, `placed` status, event copy

**Files:**
- Create: `supabase/migrations/766_find_me_a_team.sql`
- Test: `tests/migration-766-find-me-a-team.test.js`

**Interfaces:**
- Produces: `race_registrations.looking_for_team boolean not null default false`, `placed_into_registration_id uuid references race_registrations(id) on delete set null`, `placed_at timestamptz`, `placed_by uuid references profiles(id) on delete set null`; status CHECK `('pending_payment', 'confirmed', 'cancelled', 'no_show', 'placed')`; `race_events.find_team jsonb`; partial index `idx_race_registrations_looking (race_event_id) where looking_for_team and status = 'confirmed'`.

- [ ] **Step 1: Write the failing guard test** asserting each `add column if not exists`, the five-value CHECK, the four `column-grant: withheld` notes, and no `grant` to `anon`/`authenticated` in the file.
- [ ] **Step 2: Run** → FAIL (ENOENT).
- [ ] **Step 3: Write the migration** (DROP/ADD the status constraint as mig 084 does).
- [ ] **Step 4: Run** the test, `npm run check:select-columns`, `npm run check:rls-restrictive` → PASS.
- [ ] **Step 5: Commit** — `FINDTEAM.1 — mig 766: looking_for_team, placed status, race_events.find_team`.

---

### Task 2: `src/lib/find-team.js` — settings, copy, capacity rule

**Files:**
- Create: `src/lib/find-team.js`
- Modify: `src/lib/event-signups.js` (`loadForMode` excludes unplaced solos in `teams` mode)
- Test: `src/lib/find-team.test.js`, extend `src/lib/event-signups.test.js`

**Interfaces:**
- Produces:
  - `FIND_TEAM_DEFAULTS`: `{ enabled: false, label: 'Find me a team', blurb: "No team? No problem. Book your place and we'll put you with a team in your wave. We'll email you once you're placed.", confirmation_paragraph: "You booked a solo place. We'll put you with a team in your wave and email you once you're placed.", placed_subject: "You're on a team for {{event_name}}", placed_intro: "Good news, {{first_name}}: you've been placed with team {{team_name}} in the {{when}} wave." }`
  - `FindTeamSettingsSchema` (Zod, all optional strings ≤ 2000 plus `enabled` boolean).
  - `resolveFindTeamSettings(race) → settings` (defaults ⊕ `race.find_team`, nulls dropped).
  - `soloTeamName(fullName) → '<name> (looking for a team)'`.
  - `countsTowardTeamCapacity(reg) → boolean`: `reg.status === 'confirmed' && !reg.looking_for_team`.
  - In `event-signups.js`: `loadForMode(registrations, mode)` in `teams` mode counts only `countsTowardTeamCapacity` rows; `people` mode unchanged. `computeSignupCounts` unchanged (it reports headcount; a solo is a person).

- [ ] **Step 1: Write the failing tests**: `loadForMode([{status:'confirmed', looking_for_team:true}, {status:'confirmed'}], 'teams') === 1`; same rows in `'people'` mode → 2 (sizes default 1); `wouldFit(2, thoseRows, 'teams')` → true; `soloTeamName('Sarah Byrne')`; `resolveFindTeamSettings({ find_team: { enabled: true } }).label === 'Find me a team'`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/lib/find-team.test.js src/lib/event-signups.test.js` → PASS.
- [ ] **Step 5: Commit** — `FINDTEAM.2 — find-team settings and the teams-mode capacity rule`.

---

### Task 3: Register route accepts `find_team`

**Files:**
- Modify: `src/app/api/public/events/[slug]/register/route.js` (schema; the size/members validation block around lines 271–290; the teams-mode wave count around line 328 adds `.eq('looking_for_team', false)`; the registration insert around line 649 adds `looking_for_team`)
- Modify: `src/app/api/public/events/[slug]/route.js` (teams-mode `is_full` count adds `.eq('looking_for_team', false)`; response gains `find_team: { enabled, label, blurb }` for race kind when enabled, absent otherwise; add `find_team` to the select)
- Modify: `src/lib/race-confirmations.js` (`sendRaceConfirmations`: when the registration row has `looking_for_team`, the confirmation ctx gets `findTeamParagraph` from `resolveFindTeamSettings(race).confirmation_paragraph`; `buildConfirmationDefaults` renders it as a paragraph after the intro when present; add `looking_for_team` to the registration select there)
- Test: extend `src/app/api/public/events/[slug]/register/route.test.js` (or the nearest existing test for that route), `src/app/api/public/events/[slug]/route.test.js`, `src/lib/race-confirmations.test.js`

**Interfaces:**
- Consumes: Task 2.
- Produces: body `find_team: z.boolean().optional()`. When true: kind must be `race` (else 400 `find_team_unavailable`), `race.find_team?.enabled` must be true (else 400 `find_team_disabled`), `team_size` is forced to 1 and not checked against `allowed_team_sizes`, `members` must be empty (else 400), `team_name` is ignored and replaced by `soloTeamName(captainName)`, the teams-mode wave count is skipped (a solo takes no team slot; people mode checks `wouldFit(…, 'people', 1)` as today), and the inserted registration carries `looking_for_team: true`. Pricing, member check, promo, payment and confirmation unchanged.

- [ ] **Step 1: Write the failing tests**: `find_team: true` on sizes `[2,4]` → accepted, insert has `looking_for_team: true`, `team_size` 1, team name `'Sarah Byrne (looking for a team)'`; with `members: [{…}]` → 400; kind `workshop` → `find_team_unavailable`; event with `find_team: null` → `find_team_disabled`; a full teams-mode wave (count = capacity) still accepts a solo; public GET: `is_full` ignores solos (the count query carries `looking_for_team = false`) and `find_team` block present only when enabled and kind race; confirmation defaults include the paragraph when `findTeamParagraph` is set.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three test files + `npm run check:select-columns` → PASS.
- [ ] **Step 5: Commit** — `FINDTEAM.3 — register route: find_team solo entries; public read exposes the option and excludes solos from team capacity`.

---

### Task 4: The widget — first option, hidden fields

**Files:**
- Modify: `src/components/RaceSignupWidget.jsx` (size selector around line 904; submit body around line 436; team-name/members blocks)
- Test: `src/components/RaceSignupWidget.find-team.test.jsx`

**Interfaces:**
- Consumes: `race.find_team` from Task 3.
- Produces: state `findTeam` (boolean). When `race.find_team?.enabled`, the size selector renders `find_team.label` as the FIRST option, then the sorted allowed sizes; selecting it sets `findTeam = true`, `teamSize = 1`, hides the team-name field and the teammate rows, shows `find_team.blurb` under the selector, and the POST body carries `find_team: true` with no `members` and no `team_name`. Price and button label follow `teamSize = 1`. Selecting a size clears `findTeam`.

- [ ] **Step 1: Write the failing tests** (price-box test style): option order `['Find me a team', '2-people', '4-people']`; clicking it hides `Team name *` and `Your teammates`, shows the blurb, the button reads `Register and pay €50.00` with `non_member_fee_cents: 5000`; submitting POSTs `find_team: true` and no `members`; with `find_team` absent the selector is unchanged.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** this and every `RaceSignupWidget.*.test.jsx` → PASS.
- [ ] **Step 5: Commit** — `FINDTEAM.4 — signup widget: Find me a team first`.

---

### Task 5: Staff routes — place, pair

**Files:**
- Create: `src/lib/registration-placement.js`
- Create: `src/app/api/registrations/[id]/place/route.js` (POST)
- Create: `src/app/api/events/[id]/pair-solos/route.js` (POST)
- Modify: `src/lib/race-confirmations.js` (`sendPlacedEmail({ db, registrationId })`, kind `placed`, subject/intro from `resolveFindTeamSettings(race)` passed as `placed_email_subject`/`placed_email_intro` on the race-like object to `resolveEventEmail`; merge tags `event_name, team_name, when, location, first_name`)
- Test: `src/lib/registration-placement.test.js`, both route tests, extend `src/lib/race-confirmations.test.js`

**Interfaces:**
- Consumes: Task 2; `getCurrentUser`, `assertLocationAccessOr404`, `hasPermissionForLocation(…, 'races')`, `hasRoleAtLocation(…, MANAGER_ROLES)`, `wouldFit`.
- Produces:
  - `placeSoloIntoTeam(db, { soloRegistrationId, teamRegistrationId, byProfileId, now }) → { ok, error?: 'not_found'|'not_solo'|'not_paid'|'already_placed'|'wrong_event'|'target_not_live'|string }`: reads both rows (same `race_event_id`; solo `status = 'confirmed'`, `looking_for_team`; target `status = 'confirmed'`, not `looking_for_team`); inserts a `team_members` row on the target team from the solo's captain member row (`name, email, contact_id, role: 'member', is_member, member_validation_status`); `teams.size + 1`; updates the solo `status: 'placed', placed_into_registration_id, placed_at, placed_by`. Order: member insert, size, then the status flip, so a crash leaves a visible duplicate rather than a lost person.
  - `pairSolos(db, { raceEventId, registrationIds, teamName, waveId, force, byProfileId, now }) → { ok, registrationId?, error?: 'too_few'|'mixed_waves'|'wave_full'|… }`: ≥ 2 solos, all `confirmed` + `looking_for_team` + same event; wave = `waveId` or the solos' common wave (else `mixed_waves`); in `teams` mode `wouldFit(wave.capacity, confirmedRegsInWave, 'teams')` unless `force`; creates the `teams` row (`location_id`, `name: teamName`, `size: n`, `captain_contact_id` = first solo's `contact_id`; on a 23505 name clash append ` (2)`), the `team_members` rows, one `race_registrations` row `{ status: 'confirmed', wave_id, team_composition }` (`all_members` / `mixed` / `all_non_members` from the solos' member flags), then flips each solo to `placed` into it.
  - Routes: `POST /api/registrations/[id]/place` body `{ team_registration_id: uuidLike }` → `{ success, data: { placed: true } }`; errors map `not_found`/`wrong_event` → 404, `not_paid`/`already_placed`/`not_solo`/`target_not_live` → 409. `POST /api/events/[id]/pair-solos` body `{ registration_ids: uuidLike[] (2..8), team_name: string(1..80), wave_id?: uuidLike, force?: boolean }` → `{ success, data: { registration_id } }`; `mixed_waves`/`too_few` → 400, `wave_full` → 409 `{ code: 'wave_full' }`. Both then `sendPlacedEmail` per placed person, fire-and-forget.

- [ ] **Step 1: Write the failing tests** covering the Review Focus items 1–4, the happy paths (member row shape, `size` bump, `placed` flip with `placed_by`), `pairSolos` composition and the name-clash retry, and `sendPlacedEmail` rendering `{{team_name}}` and `{{when}}`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** + `npm run check:route-guards && npm run check:location-scoping && npm run check:guardrails` → PASS.
- [ ] **Step 5: Commit** — `FINDTEAM.5 — place a solo into a team; pair solos into a new team; placed email`.

---

### Task 6: Teams page — "Looking for a team" group

**Files:**
- Modify: `src/app/api/events/[id]/teams/route.js` (select adds `looking_for_team, placed_into_registration_id, placed_at`)
- Modify: `src/components/RaceTeamsManager.jsx` (group at the top; `TeamCard` for a `placed` row shows a `Placed → team {name}` chip and no actions)
- Modify: `src/components/RaceEventForm.jsx` (a "Find me a team" section: switch, label, blurb, confirmation paragraph, placed email subject/intro via `EventEmailFields showTemplate={false}`), `src/app/api/events/[id]/route.js` + `src/app/api/events/route.js` (`find_team: FindTeamSettingsSchema.nullable().optional()`)
- Test: `src/components/RaceTeamsManager.find-team.test.jsx`, `src/components/RaceEventForm.find-team.test.jsx`

**Interfaces:**
- Consumes: Task 5 routes.
- Produces: the group lists `confirmed` + `looking_for_team` rows (wave, name, email, phone from `contact`, paid from the attached payment) with per-row **Place in team** (a select of the event's `confirmed`, non-solo registrations, same wave first, other waves labelled with their time) and a checkbox; a **Pair up** button above the group enabled at ≥ 2 ticked, opening a name field (default `Team <first names joined by &>`), wave select when the ticked solos differ, and a confirm. A `wave_full` answer offers "Place anyway" which retries with `force: true`.

- [ ] **Step 1: Write the failing tests**: the group renders two solos and no group when none; Place posts `{ team_registration_id }` to `/api/registrations/<id>/place` and reloads; Pair up with two ticked posts `{ registration_ids, team_name, wave_id }` to `/api/events/<id>/pair-solos`; a placed row shows the chip. Form: section loads and saves `find_team.enabled` and `find_team.label`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** + `npm run check:guardrails` (button types inside forms, chip contrast) → PASS.
- [ ] **Step 5: Commit** — `FINDTEAM.6 — Teams page: Looking for a team group; event form section`.

---

### Task 7: Registration, docs, CI mirror, build

- [ ] **Step 1:** `src/lib/openapi.js` entries for the two staff routes and the `find_team` field on register; `docs/events.md` subsection "Find me a team" (the capacity rule, the `placed` status, the two routes).
- [ ] **Step 2:** CI mirror (CLAUDE.md's thirteen commands) and `npm run build` → green.
- [ ] **Step 3: Commit** — `FINDTEAM.7 — openapi, events.md`.
- [ ] **Step 4: PR body checklist:** apply mig 766 via Supabase MCP before merge + `get_advisors`; switch the option on for `stillorgan-nov21-0900`.
