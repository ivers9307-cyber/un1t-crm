# Phone contact screen: studio lens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the staff phone's contact screen (`mobile/app/(staff)/contacts/[id].jsx`) work for a person who is a member at several studios on different platforms (Glofox at UN1T Stillorgan, un1t.online at UN1T Hatch Street): open for every viewer the web admits, show each studio's membership honestly, and act (WhatsApp, email, notes, tasks, cancel form) at one chosen studio.

**Architecture:** The phone keeps no permission or studio logic of its own (ROLEUI.1: the server decides, the phone renders). The drawer bundle `GET /api/contacts/[id]/command-centre?scope=drawer` gains an optional `studio=<id>` and returns the lens: `acting_studio`, `studio_options`, per-studio `studios` (the web plan's `studioMemberships` shaper, C1) and `permissions` judged at the acting studio. The phone shows a studio strip, a membership card per platform for the acting studio, studio tags on threads/bookings/timeline, and passes `location_id` on every send/note/task, using the routes the web plan's PR B opens (`resolveRouteStudio`).

**Status (2026-10-27):** M-A shipped as #2231 (CARDLENS-M.1–M.4; M-A5 dropped, see finding 11). M-B is CARDLENS-M.6–M.9, built on the helpers web PR B actually shipped (`actingStudioOptions`, `pickActingStudio`, `resolveRouteStudio` in `src/lib/contact-acting-studio.js`). Two departures from the text below: the cancellation form stays at the primary studio (the web page keeps it there), so M-B2 changed only the messaging route; and the Task button reuses the New task screen (`mobile/app/(staff)/tasks/new.jsx`) with the contact passed in. M-C is next.

**Tech Stack:** Expo / React Native (NativeWind), `mobile/lib` pure helpers (vitest from the repo root), Next.js route handlers, Vitest.

**Matches:** the web plan `docs/superpowers/plans/2026-10-27-contact-card-studio-lens.md` (PRs A, B, C, branch `cardlens-a-quick-fixes`). Same decisions (any-status relationship row admits acting; default lens = viewer's active studio, then primary, then first shared by name; "All studios" is view-only; Delete / Change primary studio stay on the web with the primary's admins; coach data, i.e. kudos, stays at the primary).

Three phone PRs: **M-A** (open + honest, needs no web PR), **M-B** (acting studio, needs web PR B merged and deployed), **M-C** (per-studio membership cards, needs web PR C1 merged and deployed). **No migration in any PR.**

---

## Findings: what the phone gets wrong today

Checked against `origin/main` `1f00a088` (mobile/ and shared/ identical to this checkout's HEAD).

**Blocking**

1. **A crossover viewer gets a screen with no timeline and no buttons.** `GET /api/contacts/[id]/command-centre` gates on `assertLocationAccess(user, contact.location_id)` (`src/app/api/contacts/[id]/command-centre/route.js:53-56`), so a Hatch-only coach opening one of the 10 Stillorgan-primary Hatch members gets a 404. The contact row itself loads (direct RLS read, mig 765 admits the relationship: `mobile/lib/contacts-api.js:131-140`), so the screen renders, then the timeline shows "Contact not found" (`mobile/app/(staff)/contacts/[id].jsx:221-236`) and `permissions` stays null, which hides every action (`mobile/lib/contact-actions.js:21-25`, `[id].jsx:189`). The web page uses `canViewContact` (`src/app/(sales)/contacts/[id]/page.js:77-79`); the bundle route never followed.
2. **Every action is judged at the primary studio.** WhatsApp (`src/app/api/contacts/[id]/whatsapp/route.js:90-114`: number, thread, templates), email (`email/route.js:102-166`: mailbox, branding, `email_sends.location_id`), notes (`notes/route.js:68-84`), cancel form (`cancellation-form/route.js:122-239`) and the composer's window/templates (`messaging/route.js:48-74`) all read `contact.location_id`. The phone's email Mail path loads mailboxes at `contact.location_id` too (`[id].jsx:361`, `ContactComposeModal.jsx:121-130`). A Hatch coach can never message a Stillorgan-primary Hatch member from the Hatch number.

**Misleading**

3. **The Glofox card shows for everyone, and tells a Hatch-only member's viewer to link them to Glofox.** `ContactGlofoxCard` renders unconditionally (`[id].jsx:321`); unlinked it says "Not linked to Glofox yet. Link this contact from the web CRM." (`mobile/components/ContactGlofoxCard.jsx:88-91`), which is wrong advice at a un1t.online studio. When linked it carries no studio name, so a Hatch viewer cannot tell it is Stillorgan's membership (`ContactGlofoxCard.jsx:76-86`).
4. **There is no un1t.online membership anywhere on the phone.** Plan, credits, last class, attended and overdue for Hatch live in `un1t_clients` / `contact_studios` / `loadUn1tBilling`; the phone reads none of it. The bundle already returns `un1t_billing` and `signals` (`command-centre/route.js:146-154, 236-246`) and the phone ignores both.
5. **Header chip and stats are Glofox-only.** The header chip is `glofox_membership_state` only (`[id].jsx:257-259, 284-292`), so a un1t.online overdue never shows; the card's attended/last attended/LTV are Glofox columns (`ContactGlofoxCard.jsx:61-66, 132-149`), so a Hatch-only member shows nothing and a dual member shows Stillorgan's numbers unlabelled; "LTV" is Glofox LTV.
6. **The header stage is the primary studio's funnel stage.** `[id].jsx:279-283` shows `pipeline_stage_slug`; the directory does the same (`mobile/app/(staff)/contacts/index.jsx:95-98`) although the search route already returns `studio_stage_slug` for the active studio (`src/app/api/mobile/contacts/search/route.js:36`).
7. **The WhatsApp row and the composer can point at different studios.** The row is the latest conversation RLS admits at any studio, with no `location_id` selected and no label (`mobile/lib/contacts-api.js:207-216`, `[id].jsx:328-333`); the WhatsApp action sends on the primary studio's thread and number. A Stillorgan-primary member who last wrote to Hatch shows the Hatch thread above a composer that answers from Stillorgan.
8. **Event bookings carry no studio.** `listBookingsForContact` selects no `location_id` (`mobile/lib/contacts-api.js:188-198`); rows render unlabelled (`[id].jsx:82-131`).
9. **The note hint can lie.** The composer says "Also posts to the member's Glofox timeline" whenever `glofox_member_id` is set (`[id].jsx:338`, `ContactTimelineSection.jsx:66`), but `pushNoteToGlofox` uses the PRIMARY studio's Glofox credentials (`src/lib/glofox-note-push.js:27-33`), so for a Hatch-primary person with a Stillorgan Glofox id nothing is posted. Once notes can file at Hatch (web B2), a Hatch note for a Stillorgan-primary member would still be pushed into Stillorgan's Glofox. **Server-side, affects web too.**
10. **The note composer has no gate.** It always renders (`ContactTimelineSection.jsx:143`) while the route needs the web `contacts` key at the primary (`notes/route.js:71`); a coach without it types a note and gets an error.
11. ~~Cancel form is offered where it cannot act.~~ **Withdrawn (2026-10-27, while building M-A).** `cancelGlofoxMembership` runs only where the studio opted in to `glofox_auto_cancel_memberships` (`src/lib/agent/execute-membership-cancellation.js:1-4`); everywhere else an approved answer is actioned by hand from Approvals, so the form is a valid intake for a un1t.online member too. Only the outcome copy's `{{plan}}` falls back to "current" for them (`src/lib/cancellation-form/confirm.js:84`), which is cosmetic. The cancel form is judged at the primary studio, which M-B2 still covers.

**For the web plan (heads-up to the CARDLENS session)**

12. **`POST /api/activities/tasks` refuses a task at a non-primary studio.** `taskLinksRefusal` 404s unless `contact.location_id === body.location_id` (`src/lib/activity-web-writes.js:55-56`). Web plan B3 says "the tasks route already takes `location_id`"; it takes it but will refuse Hatch for a Stillorgan-primary contact. B2 needs to admit a studio where the contact has a `contact_studios` row (via `resolveRouteStudio`), or B3's task button breaks at a non-primary lens.
13. **The phone has no Task or Book action on the contact screen** today, so "acting studio for tasks and booking" is new phone surface, not a fix (M-B adds Task; Book stays a follow-up, see Out of scope).

Fine as is: kudos (coach data stays at the primary, decision 4); the WhatsApp thread screen already acts at the thread's studio (INBOXLOC.1); Edit/Delete/Change primary are web-only on the phone already.

---

## Global Constraints

- CLAUDE.md invariants apply. In particular: the phone cannot import `src/lib`; anything both sides need goes in `shared/` (imported as `shared/<module>`, never `../shared`) or comes from a route. `npm run check:mobile-imports` and `check:mobile-lint` must pass.
- **Every PR here touches bundle paths (`mobile/app`, `mobile/components`, `mobile/lib`, and `shared/` for M-A) and publishes an OTA at 100% to every phone on runtime 2.3.0 (staff and members) on merge.** The server half of each PR must be deployed before or with the merge, and the bundle must tolerate an older server: a payload without the new keys renders exactly today's screen (same pattern as `readMembershipSource()` in `mobile/lib/membership-source-copy.js`).
- Service-role routes have no RLS: every new `studio` / `location_id` input is checked in app code with the web plan's `resolveRouteStudio`; detail routes answer 404 not 403; a failed read is 503, never an admit.
- WhatsApp sends for studio S go from a number switched on at S (`ownNumberOrRefusal(S, …)`); no number → the phone shows "WhatsApp isn't set up at {studio}" and never falls back to the primary's number.
- A un1t.online studio is never shown Glofox affordances; the phone never pushes a contact to Glofox (it never did; keep it that way).
- Phone keeps no tier logic: buttons come from the bundle's `permissions` (ROLEUI.1). New pure helpers live in `mobile/lib/*.js` with no react-native imports, tested by the repo's vitest.
- Status chips `bg-<c>-500/10 text-<c>-700`; no dead `un1t-*` tokens; copy carries no em-dashes (phone staff-screen convention).
- Run the 13-command CI mirror and `npm run build` before each PR. Each PR adds one `docs/changelog/entries/<PR>.md`.

## Review Focus

1. **Crossover viewer** (Hatch-only coach, Stillorgan-primary Hatch member): timeline loads, buttons judged at Hatch, nothing from Stillorgan's private cards leaks (consent history, Glofox arrears amount stay hidden unless the viewer is a member there).
2. **Forged `studio=`** on the bundle (a studio the contact has no row at, another org, garbage): silently falls back to the default lens, never 404s the bundle the screen needs.
3. **Old server, new bundle** (OTA lands before the deploy): no `studios`/`acting_studio` keys → today's screen exactly, Glofox card included; sends carry no `location_id`.
4. **New server, old bundle** (a phone that has not taken the OTA): no `studio` param → default lens = active studio. Old phones post no `location_id`, so routes act at the primary as today; the bundle's `permissions` must then still describe the PRIMARY when no `studio` param is sent, or old phones show buttons the route refuses. (So: lens-judged permissions only when `studio` is passed; see M-B1.)
5. **Acting studio has no WhatsApp number** → button shows, composer explains, route 409s, nothing sent from another studio's number.

---

## PR M-A — open for every viewer, honest about platforms (OTA; no dependency on web PRs)

### Task M-A1: Bundle admits crossover viewers

**Files:**
- Modify: `src/app/api/contacts/[id]/command-centre/route.js`
- Test: `src/app/api/contacts/[id]/command-centre/route.test.js` (create if absent)

**Interfaces:**
- Consumes: `canViewContact(db, user, contact)` (`src/lib/contact-crossovers.js:62`), `isMemberOfContactStudio`.
- The 404 gate becomes `canViewContact` (owned ∪ crossover ∪ master), the web page's rule. For a crossover viewer who is not a member of the primary: `event_types`, `latestNote`, arrears amounts and the composer templates are not returned (the web hides the matching cards through `contactWorkGates`); `permissions` stays the primary-judged decision (all false for them until M-B).

- [ ] Tests: stranger (no row at any of the caller's studios) → 404, no sub-reads issued; crossover viewer → 200 with `notes`/`activities`, `permissions` all false, no `composer_templates`; member of primary → unchanged payload (snapshot the existing keys).
- [ ] Commit `CARDLENS-M.1 — contact bundle opens for crossover viewers`.

### Task M-A2: Glofox card only where Glofox is the story

**Files:**
- Modify: `src/app/api/contacts/[id]/command-centre/route.js` (adds `glofox_card`), `mobile/components/ContactGlofoxCard.jsx`, `mobile/app/(staff)/contacts/[id].jsx`
- Create: `mobile/lib/contact-platform-cards.js`, `mobile/lib/contact-platform-cards.test.js`

**Interfaces:**
- Server: drawer scope adds `glofox_card: { mode: 'linked'|'pushable'|'hidden', studio_name: string|null }` using the web plan's `glofoxCardMode` (A1, `src/lib/contact-platforms.js`) and the name of the org's Glofox studio (the studio whose `membership_source` is `glofox`; one per org today).
- Phone: `glofoxCardView(bundle, contact) -> { show: boolean, linked: boolean, title: string }`. No `glofox_card` key (old server) → `{ show: true, linked: Boolean(contact.glofox_member_id), title: 'Glofox membership' }`, today's behaviour. `'hidden'` → no card. `'pushable'` → the unlinked hint, reworded "Not in Glofox yet. Add them from the web CRM." `'linked'` → title "Glofox · {studio_name}".
- [ ] Tests for `glofoxCardView`: old server; hidden; pushable; linked with and without a studio name.
- [ ] Commit `CARDLENS-M.2 — phone Glofox card only where Glofox is used`.

### Task M-A3: Studio tags on the WhatsApp row, bookings and timeline

**Files:**
- Create: `shared/contact-studio-labels.js`, `shared/contact-studio-labels.test.js`
- Modify: `src/lib/contact-view.js` (re-export `studioNameMap` from shared, PAIRSYNC `reexport` mode; coordinate with web A2 which creates it: if A2 has merged, move it; if not, A2 imports it from shared), `tests/shared-pair-sync.test.js` manifest if a pair results, `mobile/lib/contacts-api.js`, `mobile/app/(staff)/contacts/[id].jsx`, `mobile/components/ContactTimelineSection.jsx`, `src/app/api/contacts/[id]/command-centre/route.js`

**Interfaces:**
- `shared/contact-studio-labels.js`: `studioNameMap(rows, primary) -> Map<locationId, shortName>` (web A2's function, moved), `studioTagFor(map, locationId) -> string|null` (null when the map has one studio, so single-studio contacts see no tag), `PLATFORM_LABELS = { glofox: 'Glofox', un1t_online: 'un1t.online', none: null }`. Pure, no imports.
- Server: drawer scope adds `studio_names: [{ location_id, name, primary }]` from `loadContactStudios` (a failed read → `[]`, which means "no tags", never an error).
- Phone: `listBookingsForContact` and `getWhatsAppThreadForContact` select `location_id`. The WhatsApp section lists up to three threads (one per studio, latest first), each with its tag, instead of one unlabelled row. Booking rows and timeline items (notes/activities carry `location_id`) show the tag.
- [ ] Shared tests: one studio → no tag; two → short names; unknown id → null.
- [ ] Commit `CARDLENS-M.3 — studio tags on the phone contact screen`.

### Task M-A4: Truthful note hint and gated composer

**Files:**
- Modify: `src/app/api/contacts/[id]/command-centre/route.js` (adds `permissions.note`, `glofox_note_push`), `mobile/lib/contact-actions.js` (+ test), `mobile/components/ContactTimelineSection.jsx`, `mobile/app/(staff)/contacts/[id].jsx`

**Interfaces:**
- Server: `permissions.note = canAddContactNote(user, contact.location_id)`; `glofox_note_push: boolean` = the contact is Glofox-linked AND the studio the note files at has Glofox credentials (today: the primary). Read once with `glofoxCredentialsForLocation` presence only, no secret leaves the server.
- Phone: `contactActionFlags` gains `note`; the composer renders only when `note` is true; the "Also posts to Glofox" line reads `glofox_note_push` (absent key → today's `Boolean(glofox_member_id)`).
- [ ] Tests: `contactActionFlags` with and without `note`; an old payload keeps the composer visible (absent `note` key → true, the pre-change behaviour; only an explicit `false` hides it).
- [ ] Commit `CARDLENS-M.4 — note composer gated and its Glofox hint truthful`.

### ~~Task M-A5: Cancel form only for a Glofox member~~ (dropped, see finding 11)

**Files:** `src/lib/contact-page-gates.js` (`canSendCancellationForm` gains the contact: needs `glofox_member_id`), its test, `src/app/api/contacts/[id]/cancellation-form/route.js` (409 `cancel_form_needs_glofox`), the bundle's `permissions.cancel_form`, `mobile/lib/contact-actions.js` (+ test).

- [ ] Gate tests: un1t-only member → false; Glofox member → as today. Route test: un1t-only member → 409, no link minted.
- [ ] Phone: `cancelForm` follows `permissions.cancel_form` when present, else today's channel rule.
- [ ] Commit `CARDLENS-M.5 — cancellation form only where it can act`. **Tell the web session**: the same gate change fixes the web button (finding 11).

---

## PR M-B — the acting studio (OTA; after web PR B is merged and deployed)

### Task M-B1: Bundle takes `studio=` and judges permissions there

**Files:**
- Modify: `src/app/api/contacts/[id]/command-centre/route.js`, `src/lib/openapi.js`
- Test: the route test from M-A1

**Interfaces:**
- Consumes: web B1 `actingStudioOptions`, `pickActingStudio`, `membershipSourceState`.
- `?scope=drawer&studio=<id>`: `S = pickActingStudio({ options, requested: studio, activeLocationId: user.activeLocation?.id, primaryLocationId })`. Adds `acting_studio: { location_id, name, platform } | null` and `studio_options: [{ location_id, name, platform, primary }]`.
- **When `studio` is passed** (only M-B phones and later send it, `studio=default` included), `permissions`, `wa` window, `composer_templates` and `glofox_note_push` are judged at `S`, and `permissions.task = canAddContactTask(user, S)`. **When it is absent**, everything stays primary-judged (Review Focus 4: old phones post no `location_id`).
- `studio=all` → `acting_studio: null`, every action permission false (view-only).
- [ ] Tests: Hatch coach, Stillorgan-primary Hatch member, `studio=default` → `acting_studio` Hatch, `permissions.whatsapp` true at Hatch; forged studio → default lens; no `studio` param → primary-judged as today; `studio=all` → all false; options read fails → behaves as no param.
- [ ] Commit `CARDLENS-M.6 — contact bundle judges the acting studio`.

### Task M-B2: Messaging context and cancel form take `location_id`

**Files:** `src/app/api/contacts/[id]/messaging/route.js`, `src/app/api/contacts/[id]/cancellation-form/route.js` (+ tests), `tests/whatsapp-config-callers.test.js`, `src/lib/openapi.js`

- [ ] Both accept optional `location_id` (query on GET, body on POST), admitted by `resolveRouteStudio`; window, templates, number, thread and copy at `S`. The cancel form at a non-Glofox `S` → 409 (M-A5's rule, judged at `S`).
- [ ] Tests: forged studio → 404, no Meta call; Hatch without a number → 409 with the `WhatsAppNumberMissingError` wording; no `location_id` → unchanged.
- [ ] Register the new call shapes in `tests/whatsapp-config-callers.test.js` ("409 on a staff route").
- [ ] Commit `CARDLENS-M.7 — composer context and cancel form act at a chosen studio`.

### Task M-B3: Phone studio switcher and acting sends

**Files:**
- Create: `mobile/lib/contact-studio-lens.js`, `mobile/lib/contact-studio-lens.test.js`, `mobile/components/ContactStudioSwitcher.jsx`
- Modify: `mobile/app/(staff)/contacts/[id].jsx`, `mobile/lib/contacts-api.js` (`getContactCommandCentre(id, { studio })`, `createContactNote(id, content, { locationId })`), `mobile/lib/messaging-api.js` (`getMessagingContext`, `sendContactWhatsApp`, `sendContactEmail`, `sendCancellationForm` take `locationId` and send it as `location_id`), `mobile/components/ContactComposeModal.jsx`, `mobile/components/ContactComposer.jsx`, `mobile/components/ContactTimelineSection.jsx`

**Interfaces:**
- `lensView(bundle) -> { options, acting, isAll, canAct, footer }`, pure: no `studio_options` (old server) → `{ options: [], acting: null, canAct: true }` and the screen sends no `location_id` (today). `footer` is the web line, phone-sized: "Sends from the {name} number. Notes file at {name}." (no booking clause until a Book action exists).
- `ContactStudioSwitcher`: a horizontal pill row under the name (one pill per option plus "All studios" when more than one), `accessibilityRole="tab"`, selected pill `accessibilityState={{ selected: true }}`. Renders nothing for one option. Switching re-fetches the bundle with `studio=<id>` (screen state, not a route param, so the back stack is not polluted). The initial fetch sends `studio=default`.
- The acting studio's id goes into every send, the note, the Mail mailbox list (`listMail(S)`) and the compose modal's `contactLocationId`. Under "All studios" the action row shows one line "Choose a studio to act" instead of buttons.
- [ ] Lens tests: old server; one option; two options with active studio preselected; `all` → `canAct: false`.
- [ ] `contactActionFlags` test: flags follow the bundle's acting-studio permissions; a refetch for another studio clears flags to hidden until it lands (same rule as the `id` reset at `[id].jsx:183`).
- [ ] Manual check on the iOS simulator against a dev server with a dual-studio sample contact: switch to Hatch, send a note, confirm `notes.location_id` is Hatch; WhatsApp at a studio with no number shows the explanation.
- [ ] Commit `CARDLENS-M.8 — phone contact screen acts at the chosen studio`.

### Task M-B4: Add task from the contact

**Files:** `mobile/lib/tasks-api.js` (`createContactTask({ locationId, contactId, subject, dueDate })` via `api('/api/activities/tasks')`, not the direct insert), `mobile/app/(staff)/contacts/[id].jsx` (a "Task" action button opening the existing task form or an `Alert.prompt`-style sheet), `mobile/lib/contact-actions.js` (+ tests)

- [ ] **Precondition (web):** `POST /api/activities/tasks` admits a non-primary studio where the contact has a `contact_studios` row (finding 12). If web B2 does not take it, add it there first: replace the `contact.location_id !== locationId` test in `taskLinksRefusal` with `resolveRouteStudio`.
- [ ] Button shows only when `permissions.task`; posts `location_id = acting`.
- [ ] Commit `CARDLENS-M.9 — add a task from the phone contact screen`.

---

## PR M-C — per-studio membership cards and header (OTA; after web PR C1 is merged and deployed)

### Task M-C1: Bundle carries `studios`

**Files:** `src/app/api/contacts/[id]/command-centre/route.js` (+ test), `src/lib/openapi.js`

**Interfaces:**
- Consumes: web C1 `studioMemberships(input)` and C3 `headerMetricsFor(...)`.
- Drawer scope adds `studios: StudioMembership[]` (web C1 shape, snake_cased for the wire: `location_id, name, platform, primary, kind, status, plan, price_line, credits_line, attended_30d, last_attended_at, owed_cents, overdue, amount_unreported, synced_at`) narrowed to studios where the viewer holds Contacts (as `loadUn1tBilling` already does), and `header: { attended, last_attended_at, arrears_cents, overdue, risk_label, risk_studio }` for the acting studio (or all, under "All studios"). Unknown is `null`, never `0`. Glofox class history (`recent_bookings`) stays on the contact row the phone already reads.
- [ ] Tests: Stillorgan Glofox + Hatch un1t fixture → two entries; a viewer without Contacts at Stillorgan gets only Hatch; header under Hatch shows the un1t attended count, not Glofox's 0.
- [ ] Commit `CARDLENS-M.10 — contact bundle carries per-studio memberships`.

### Task M-C2: Studio strip and membership cards

**Files:**
- Create: `mobile/components/ContactStudioStrip.jsx`, `mobile/components/ContactUn1tCard.jsx`, `mobile/lib/contact-studio-cards.js` (+ test)
- Modify: `mobile/components/ContactGlofoxCard.jsx` (takes a `membership` for its header line and studio name; body unchanged), `mobile/components/ContactStudioSwitcher.jsx` (the strip replaces the plain pills once `studios` is present), `mobile/app/(staff)/contacts/[id].jsx`

**Interfaces:**
- `studioCardView(membership) -> { title, platformChip, statusChip, lines: string[] }`, pure. Platform chips: Glofox `bg-orange-500/10 text-orange-700`, un1t.online `bg-blue-500/10 text-blue-700` (the web C2 colours). Overdue with no amount → "Overdue · amount not reported", never "€0".
- `ContactStudioStrip`: a horizontal `ScrollView` of compact tiles (name, Primary pill, platform chip, kind · status, owed, attended 30d); tapping a tile that is an acting option switches the lens. Nothing for a single-studio contact.
- Below the strip, the acting studio's card: `ContactGlofoxCard` for a Glofox studio, `ContactUn1tCard` (plan, credits, last class, attended 30d, overdue, synced) for a un1t.online studio, a short "Lead at {name}" line for a studio with no platform. "All studios" stacks one card per studio.
- [ ] Tests for `studioCardView`: Glofox entry, un1t overdue without amount, lead-only studio; Glofox fields never on the Hatch card.
- [ ] Commit `CARDLENS-M.11 — studio strip and per-studio membership cards on the phone`.

### Task M-C3: Header follows the lens

**Files:** `mobile/app/(staff)/contacts/[id].jsx`, `mobile/lib/contact-command-centre.js` (+ test)

- [ ] The header chip uses `header.risk_label` (naming the studio under "All studios": "Payment overdue · Hatch Street"); absent `header` → today's Glofox state chip.
- [ ] Stage chip: the acting studio's `studio_stage_slug` when the bundle returns it (add `studio_stage_slug` to the drawer scope from `studio_contacts` at `S`), else `pipeline_stage_slug`. Same for the directory row (`index.jsx:95-98`): prefer `studio_stage_slug`, which the search route already returns.
- [ ] Timeline, bookings and WhatsApp threads filter to the acting studio; "All studios" shows everything with M-A3's tags.
- [ ] Commit `CARDLENS-M.12 — phone header and lists follow the studio lens`.

---

## OTA summary

| PR | Bundle paths | Ships an OTA | Server must deploy first |
|---|---|---|---|
| M-A | `mobile/app`, `mobile/components`, `mobile/lib`, `shared/` | Yes, 100%, every phone on 2.3.0 | Its own route changes (same PR: Vercel deploys on merge in about the same window as the OTA; the bundle tolerates the old payload either way) |
| M-B | `mobile/app`, `mobile/components`, `mobile/lib` | Yes | Web PR B (routes accept `location_id`) merged and live, plus M-B1/M-B2 |
| M-C | `mobile/app`, `mobile/components`, `mobile/lib` | Yes | Web PR C1 merged and live, plus M-C1 |

Each OTA reaches the member fleet too (runtime 2.3.0 is the public lane); every change here is behind staff routes, so members see no difference, but a crash in a shared module would reach them. Keep the `shared/` change in M-A pure and tested.

## Out of scope (follow-ups)

- **Book from the phone contact screen** at the acting studio (Glofox classes via `/api/glofox/classes/book`, un1t.online via `/api/un1t-online/classes/book`). The phone has no Book action today; add it after M-B as its own PR once staff ask for it.
- **Glofox note push by the Glofox studio, not the primary** (`src/lib/glofox-note-push.js:33`): push a note to Glofox only when it files at the org's Glofox studio, using that studio's credentials. Server-only; fixes finding 9 for web and phone. Can ride web B2.
- Consent per studio on the phone (the phone shows no consent today).
- Coach data (kudos, consultations) per studio: stays at the primary (decision 4).
