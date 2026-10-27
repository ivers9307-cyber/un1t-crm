# Contact card: studio lens — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/contacts/[id]` work for a person who is a member at several studios on different platforms: show every studio honestly, and let staff at any of those studios act on the person from their own studio.

**Architecture:** One server helper picks the **acting studio** for a viewer (from `?studio=`, the viewer's active studio, the contact's primary studio, then the first studio the viewer shares). The page's gates, composer, booking card and stats are judged at that studio instead of `contact.location_id`. The send routes accept an optional `location_id`, admitted only where the contact has a `contact_studios` row and the caller holds the permission there. Per-studio membership facts come from one shaper over Glofox (`contacts.*`) and un1t.online (`un1t_clients`, `contact_studios`, `loadUn1tBilling`).

**Tech Stack:** Next.js 16 App Router server components, Supabase service-role client, Vitest + RTL.

**Spec:** the 2026-10-27 contact card audit (in this session; findings 1–9) and the mockup at https://claude.ai/artifact/Qic9ojsGMc8UfDetjY5DPK.

Three PRs, each shippable alone: **A** (quick fixes), **B** (acting studio), **C** (per-studio membership + layout). **No migration in any PR**: `deals`, `notes`, `activities`, `bookings`, `whatsapp_conversations`, `email_sends`, `consent_log`, `contact_location_preferences` and `contact_studios` all carry `location_id` today (checked against prod 2026-10-27).

## Decisions to confirm (Richard) — defaults used below

1. **Who may act at a non-primary studio:** a caller who is a member of studio S, holds the route's permission at S, and the contact has a `contact_studios` row at S **of any status** (same rule as visibility, ORGCONTACTS decision 2). *Default: yes, any status.*
2. **Default lens:** the viewer's active studio if the person has a row there, else the primary studio if the viewer belongs to it, else the first shared studio by name. *"All studios" is a read-only view; acting needs one studio.*
3. **Delete and Change primary studio stay with the primary studio's admins** (ORGCONTACTS.4, unchanged).
4. **Consultations, goals, InBody, photos stay at the primary studio** in this plan (coach data has no per-studio story yet).

## Global Constraints

- CLAUDE.md invariants apply. In particular: service-role routes have no RLS, so every new `location_id` input is checked in app code; detail routes answer **404 not 403**; supabase write errors are destructured and handled (`no-unchecked-supabase-write`); a `.select()` names only real columns (`check:select-columns`).
- WhatsApp sends for studio S go from a number switched on at S and file the thread at S (`ownNumberOrRefusal(S, …)`, `getOrCreateConversation(db, contact, S)`); a studio with no number is a 409 with `WhatsAppNumberMissingError` wording, never a fallback to the primary's number. Add the new call shape to `tests/whatsapp-config-callers.test.js`.
- A un1t.online studio is never shown Glofox affordances; the CRM never pushes a contact to Glofox at a studio whose `membership_source` is not `glofox`.
- Zone maths only through `@/lib/location-time`.
- Status chips: `bg-<c>-500/10 text-<c>-700`; no dead `un1t-*` tokens; every in-form `<button>` has a `type`.
- Run the 13-command CI mirror and `npm run build` before each PR. Each PR adds one `docs/changelog/entries/<PR>.md`.

## Review Focus

1. **A forged `location_id`** on a send or note route (a studio the contact has no row at, or the caller does not belong to) → 404, nothing written, nothing sent.
2. **Acting studio has no WhatsApp number** → composer shows "WhatsApp isn't set up at Hatch Street" and the route answers 409; it never sends from the primary studio's number.
3. **`?studio=` names a studio the viewer can't act at** (garbage uuid, another org, a studio where the person has no row) → the page silently falls back to the default lens; it never 500s or shows an empty page.
4. **`contact_studios` read fails** → the page behaves exactly as today (primary studio, no strip), never "no studios".
5. **A contact with a Glofox ID whose primary studio is un1t.online** (a Hatch-primary person who also trains at Stillorgan) → the Glofox block still shows for Stillorgan; only the *push to Glofox* button is hidden.

---

## PR A — quick fixes (no behaviour change for single-studio contacts)

### Task A1: Glofox card and push only where Glofox exists

**Files:**
- Create: `src/lib/contact-platforms.js`
- Modify: `src/components/contact/ContactWhoRail.jsx`, `src/components/contact/GlofoxProfileCard.jsx`, `src/app/(sales)/contacts/[id]/page.js`, `src/app/api/contacts/[id]/push-to-glofox/route.js`
- Test: `src/lib/contact-platforms.test.js`, `src/components/contact/GlofoxProfileCard.test.jsx`, `src/app/api/contacts/[id]/push-to-glofox/route.test.js` (create if absent)

**Interfaces:**
- Produces: `glofoxCardMode({ contact, primarySource, studioRows }) -> 'linked' | 'pushable' | 'hidden'` (pure). `'linked'` when `contact.glofox_member_id`; else `'pushable'` when `primarySource === 'glofox'`; else `'hidden'`. `studioRows` is the `loadContactStudios` rows (each `location.membership_source`); B and C reuse this module.
- `GlofoxProfileCard` gains prop `mode` and renders nothing for `'hidden'`.

- [ ] Test `glofoxCardMode`: linked id → `'linked'` whatever the source; no id + `'glofox'` → `'pushable'`; no id + `'un1t_online'` → `'hidden'`; no id + `'none'` → `'hidden'`; no id + `null` (unreadable source) → `'pushable'` (fail open to today's behaviour; the route refuses anyway).
- [ ] Test the card: `mode='hidden'` renders nothing; `mode='pushable'` shows the Create-in-Glofox button.
- [ ] Route test: a contact whose location's `membership_source` is `un1t_online` → 409 `{ success:false, error:'glofox_not_used_here' }` and `findOrCreateGlofoxMember` not called.
- [ ] Implement: the page reads `membershipSourceState(db, contact.location_id)` once (also reused by B) and passes `mode` through `ContactWhoRail`; the route reads the same before any Glofox call.
- [ ] Run the three test files, then commit `CARDLENS.1 — Glofox card and push only where the studio uses Glofox`.

### Task A2: Studio tag on deals, timeline, WhatsApp threads, bookings

**Files:**
- Modify: `src/app/(sales)/contacts/[id]/page.js` (selects), `src/components/contact/ContactNextRail.jsx` (Deals), `src/components/contact/ContactTimeline.jsx`, `src/components/contact/EventRegistrationsCards.jsx`, `src/lib/contact-view.js`
- Create: `src/components/contact/StudioTag.jsx`
- Test: `src/components/contact/ContactRails-studio-cards.test.jsx`, `src/lib/contact-view.test.js`

**Interfaces:**
- Produces: `studioNameMap(rows, primary) -> Map<locationId, shortName>` in `src/lib/contact-view.js` (from `contactStudios.rows` plus the primary's name); `<StudioTag locationId map />` renders a grey pill, **nothing when the person has only one studio** (no noise for 99% of contacts).
- Selects add `location_id` to `whatsapp_conversations`; deals/notes/activities/bookings already `select('*')`.

- [ ] Tests: with two studios, a deal at Hatch shows "Hatch Street" beside its stage; a timeline note shows its studio; with one studio no tag renders.
- [ ] WhatsApp card: each conversation links to `/communications/inbox?conversation=<id>` (check the inbox reads that param; if not, `/communications/inbox` stays) and shows its studio tag.
- [ ] Remove the dead SMS branch in the Messages card (`buildMessageHistory` is email-only since TWILIO-RETIRE.1).
- [ ] Commit `CARDLENS.2 — studio tags on the contact page`.

### Task A3: Trim repeated rows

**Files:** `src/components/contact/ContactWhoRail.jsx`, `src/components/contact/ContactNextRail.jsx`, `src/components/contact/ContactHeaderBand.jsx`; tests beside each.

- [ ] Drop the Details card's Source and Created rows (the header line carries both); keep Label and Came via. Merge what is left of Details into the Identity card (one "Person" card, as in the mockup); Identity keeps the phone/email list because a linked person has several.
- [ ] Drop the Paused chip's duplicate "Paused since" line from the Glofox card only when the header chip is showing the same resume date.
- [ ] Fold Events, HR devices, App account and Admin into one `<details>` "More" section at the bottom of the right rail, closed by default. Each keeps its existing gate.
- [ ] Test: Admin buttons still render inside "More" for an owner; nothing renders for a crossover viewer.
- [ ] Commit `CARDLENS.3 — fold rarely used cards`.

---

## PR B — the acting studio

### Task B1: `resolveActingStudio`

**Files:**
- Create: `src/lib/contact-acting-studio.js`, `src/lib/contact-acting-studio.test.js`

**Interfaces:**
- Produces:
  - `actingStudioOptions({ user, contact, studioRows }) -> Array<{ locationId, name, source, primary }>`: the studios where `isMemberOfContactStudio(user, id)` AND the person has a row (the primary always counts as a row). Excludes `location.active === false` and `is_host_anchor`.
  - `pickActingStudio({ options, requested, activeLocationId, primaryLocationId }) -> string|null`: `requested` if in options; else `activeLocationId` if in options; else `primaryLocationId` if in options; else the first option by name; else `null` (a crossover viewer with no shared studio, which today's gates already handle).
  - `assertActingStudio(db, user, contact, locationId) -> null | NextResponse(404)`: for routes. `locationId` absent → `contact.location_id` (today's behaviour); present → member of it AND `hasRelationshipAt(db, contact.id, [locationId])` includes it (the primary is always admitted). A failed read → 503, never an admit.

- [ ] Tests (the Review Focus 1 and 3 table): requested studio not shared → falls back; garbage `requested` → falls back; active studio preferred over primary; only crossover → `null`; `assertActingStudio` with a studio the contact has no row at → 404; read failure → 503; no `locationId` → judges the primary exactly as the routes do today.
- [ ] Commit `CARDLENS.4 — acting studio resolver`.

### Task B2: Routes accept `location_id`

**Files:**
- Modify: `src/app/api/contacts/[id]/whatsapp/route.js`, `src/app/api/contacts/[id]/email/route.js`, `src/app/api/contacts/[id]/notes/route.js`, `src/lib/openapi.js`
- Test: each route's `route.test.js`; `tests/whatsapp-config-callers.test.js`

**Interfaces:**
- Consumes: `assertActingStudio` (B1).
- Each body schema gains `location_id: uuidLike.optional()`. Let `S = body.location_id ?? contact.location_id`. Every place the route now reads `contact.location_id` for authorisation, number/mailbox, templates, branding, the written row's `location_id` uses `S` instead. The permission check (`whatsapp` / `email` / `contacts`) runs at `S`.

- [ ] WhatsApp tests: send with `location_id` = Hatch for a Stillorgan-primary contact with a Hatch row → `ownNumberOrRefusal('hatch')`, conversation filed at Hatch, `whatsapp_messages.location_id` Hatch; Hatch with no number → 409; `location_id` the contact has no row at → 404 and no Meta call; no `location_id` → unchanged behaviour (existing tests pass untouched).
- [ ] Email tests: mailbox resolved at `S`; branding from `getLocationBranding(db, S)`; `email_sends.location_id = S`.
- [ ] Notes test: note written with `location_id = S`; permission `contacts` at `S`.
- [ ] Register the optional field in `openapi.js`; add the row to `tests/whatsapp-config-callers.test.js` ("409 on a staff route").
- [ ] Commit `CARDLENS.5 — contact send and note routes act at a chosen studio`.

### Task B3: Page and components use the acting studio

**Files:**
- Modify: `src/app/(sales)/contacts/[id]/page.js`, `src/lib/contact-page-gates.js`, `src/components/ContactComposer.jsx`, `src/components/contact-composer-send.js`, `src/components/ContactActions.jsx`, `src/components/PersonActionBar.jsx`, `src/components/ContactBookingCard.jsx` (props only)
- Create: `src/components/contact/ActingStudioBar.jsx`
- Test: `src/lib/contact-page-gates.test.js`, `src/components/ContactComposer.mail.test.jsx`, `src/components/contact/ActingStudioBar.test.jsx`

**Interfaces:**
- Consumes: B1, B2, `glofoxCardMode` (A1).
- `contactChannelFlags(user, S)`, `contactWorkGates(user, contact, { actingLocationId: S })` — the work gates for note/task/sequence/book/consent/cancel-form judge at `S`; with `actingLocationId` omitted they behave as today (existing case tables pass).
- `ContactComposer` gets `actingLocationId` and sends it as `location_id` on every WhatsApp/email send; the mailbox list fetch uses it; WhatsApp window and templates come from the latest conversation **at S** and `whatsapp_templates` **at S**.
- `ContactActions`/`PersonActionBar` task + note posts use `S` (the tasks route already takes `location_id`).
- Booking: `ContactBookingCard` renders only when `S`'s source is `glofox` (or none, for consultations); the un1t card for `S` when `S` is un1t.online and writes are on. "All studios" → no booking card, a line "Choose a studio to book".
- `ActingStudioBar`: a segmented control of `actingStudioOptions` plus "All studios" (only when more than one), each a `<Link href="?studio=<id>">`; the line under it copies the mockup: "Messages go from the {name} number, bookings through {platform}, notes file at {name}." Renders nothing when there is one option.

- [ ] Gate tests: a Hatch-only manager viewing a Stillorgan-primary Hatch member gets `canNote`, `canTask`, `whatsapp`, `email` true at Hatch and false with no `actingLocationId`.
- [ ] Composer test: `location_id` is in the POST body; with "All studios" the Send button is disabled with the hint "Choose a studio to send from".
- [ ] Bar test: links carry `?studio=`; one option → nothing rendered.
- [ ] Manual check in the browser (dev server) on a dual-studio sample contact: switch lens, send a note, confirm `notes.location_id`.
- [ ] Commit `CARDLENS.6 — contact page acts at the chosen studio`.

---

## PR C — per-studio membership view and layout

### Task C1: `studioMemberships` shaper

**Files:**
- Create: `src/lib/contact-studio-memberships.js`, `src/lib/contact-studio-memberships.test.js`

**Interfaces:**
- Consumes: `contact` row, `studioRows` (contact_studios + location), `un1tBilling.studios` (from `loadUn1tBilling`), un1t client rows (`un1t_clients`: `location_id, last_attended_at, credit_balance, credit_unlimited` — confirm names with `check:select-columns`), the `class_bookings` 30-day attended count per studio.
- Produces: `studioMemberships(input) -> Array<StudioMembership>` where `StudioMembership = { locationId, name, platform: 'glofox'|'un1t_online'|'none', primary, kind, status, plan, priceLine, creditsLine, attended30d: number|null, lastAttendedAt: string|null, owedCents: number|null, overdue: boolean, amountUnreported: boolean, syncedAt: string|null, externalUrl: string|null }`. Glofox fields only on the studio whose source is `glofox` and only when `contact.glofox_member_id`; un1t fields only from that studio's un1t rows. Unknown is `null`, never `0`.

- [ ] Tests: Stillorgan Glofox member + Hatch un1t client → two entries with the right platform each; un1t overdue with no amount → `overdue: true, owedCents: null, amountUnreported: true`; a lead-only studio → `platform` from source, plan `null`; Glofox fields never appear on the Hatch entry.
- [ ] Commit `CARDLENS.7 — per-studio membership shaper`.

### Task C2: Studios strip + membership cards replace three cards

**Files:**
- Create: `src/components/contact/StudioStrip.jsx`, `src/components/contact/StudioMembershipCard.jsx` (+ tests)
- Modify: `src/components/contact/ContactWhoRail.jsx`, `src/app/(sales)/contacts/[id]/page.js`
- Remove from the rail: `ContactStudiosCard`, `Un1tPaymentsCard` (keep its `StudioBlock` as the un1t body of `StudioMembershipCard`), `GlofoxProfileCard` (becomes the Glofox body; its push button stays under A1's mode).

- [ ] `StudioStrip` under the header: one tile per `StudioMembership` (name, Primary pill, platform pill — Glofox orange `bg-orange-500/10 text-orange-700`, un1t.online `bg-blue-500/10 text-blue-700` — kind · status, owed, plan, attended 30d, last class, synced). A tile is a `<Link href="?studio=<id>">` when it is an acting option, plain otherwise. Renders nothing for a single-studio contact.
- [ ] Left rail shows `StudioMembershipCard` for the acting studio, or one per studio under "All studios". Change primary studio moves into the card's footer for the primary.
- [ ] Tests: two tiles for the dual-studio fixture; the acting tile has `aria-current="true"`; single-studio contact → no strip and the existing Glofox card content unchanged.
- [ ] Commit `CARDLENS.8 — studios strip and per-studio membership cards`.

### Task C3: Header stats and risk follow the lens

**Files:** `src/app/(sales)/contacts/[id]/page.js`, `src/components/contact/ContactHeaderBand.jsx`, `src/lib/contact-view.js` (+ tests)

**Interfaces:**
- Produces: `headerMetricsFor(memberships, actingLocationId|null, { ltvCents, deals }) -> { attended, lastAttendedAt, arrearsCents, overdue, ltvLabel }`. One studio → that studio's figures; "All studios" → sum of known `attended30d`, latest `lastAttendedAt`, summed arrears (keep `mergeArrearsCents` semantics), LTV labelled "Glofox LTV" when only Glofox knows it.
- Risk chip: Glofox `classifyContact` only for a Glofox studio; `un1tHeaderRisk` for a un1t studio; under "All studios" the worst, with the studio named ("Payment overdue · Hatch Street").

- [ ] Tests: Hatch-only member no longer shows "Attended 0" from empty Glofox columns (shows the un1t count); all-studios sum; the risk chip names its studio.
- [ ] Journey: use the acting studio's source (replaces PULSEUN1T.2's viewer-active-studio read, so page and lens agree).
- [ ] Commit `CARDLENS.9 — header follows the studio lens`.

### Task C4: Lens filters and per-studio consent

**Files:** `src/components/contact/ContactTimeline.jsx`, `src/components/contact/ContactNextRail.jsx`, `src/components/ContactMarketingPreferencesCard.jsx`, the marketing-preferences GET route if it does not already return per-studio rows (+ tests)

- [ ] Timeline, Needs attention, Coming up and Deals filter to the acting studio; "All studios" shows everything with A2's tags.
- [ ] Consent card shows a column per studio for WhatsApp/email marketing from `contact_location_preferences` (STOP is per studio since WAORGNUMBER.3); editing stays gated by `canEditMarketingPreferences` at that studio.
- [ ] Tests: lens Hatch hides a Stillorgan note; consent shows STOP at Hatch and On at Stillorgan for the fixture.
- [ ] Commit `CARDLENS.10 — lens filters and per-studio consent`.

---

## Out of scope (follow-ups)

- The phone contact screen (`mobile/app/(staff)/contacts/[id].jsx`) is Glofox-only too; it should take `studioMemberships` through a route in a later PR (OTA).
- The pipeline drawer (`ContactDrawer` via `/api/contacts/[id]/command-centre?scope=drawer`) should take the acting studio from the board's studio once B lands.
- Per-studio LTV for un1t.online (needs a settled-transactions roll-up).
