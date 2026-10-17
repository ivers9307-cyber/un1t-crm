# un1t.online (Hatch Street): P1 plan

**Date:** 2026-10-17
**Status:** decisions made 2026-10-17 (last section); implementation plans follow per workstream, P1.0 first.
**Parent:** `docs/superpowers/plans/2026-10-17-un1t-online-followups.md` (roadmap). This document turns its P1 into ordered, evidence-backed workstreams. Each workstream below becomes its own implementation plan (writing-plans format) once its decisions are made.

**Evidence:** three code audits of `main` at `a54175cd`, plus live database reads on 2026-10-17. File references are to `main`.

---

## Hatch today (facts the plan rests on)

| | |
|---|---|
| Membership source | `un1t_online`, state **configured**, provider capabilities all `false` |
| Devices | 6 Shelly switches, **all disabled, `schedule_mode 'none'`**; no AC units, no `location_automations`, no BLE/HR bridge, no HYROX block, no class timers or categories |
| TVs | 2 active displays (`hatch-tv1`, `hatch-tv2`) |
| Shared class tables | 0 rows in `class_occurrences` / `class_bookings` (Stillorgan: 764 / 10,511) |
| Synced | 187 clients, 138 events, 316 bookings, 26 active memberships |
| Dual-studio members | 52 linked clients whose contact lives at **Stillorgan**: 39 have Hatch marketing preferences, 12 have a Hatch deal, 10 hold an active Hatch membership |

**No provider-agnostic read seam exists.** A membership provider is only `{ key, label, capabilities, isConfigured }` (`src/lib/membership/source.js`), and every membership surface reads `contacts.glofox_*`, `glofox_invoices`, `glofox_memberships`, `membership_transitions`, `class_occurrences` or `class_bookings` directly. Only four files read `un1t_*` or `contact_memberships`.

---

## P1.0 Fix first: Glofox-shaped surfaces now render at Hatch (regression from #2068)

Connecting un1t.online made Hatch's state `configured`. Several surfaces check **state**, not **capabilities**, so they now render for Hatch on Glofox data Hatch doesn't have:

| Surface | Gate today | Effect at Hatch |
|---|---|---|
| `/dashboard/studio` (`page.js:101-113`) | `state === 'configured'` | full KPI scorecard of zeros or misleading numbers |
| `/dashboard/business` (`page.js:47-68`, `:128-140`) | state only | KPI row and membership panel render |
| `/dashboard/engagement` | gated, but `loadEngagementChurn` still runs (`:31`) | wasted work |
| Crons `churn-radar-snapshot`, `membership-snapshot`, `churn-radar-digest`, `lead-radar-snapshot` | skip only `'none'` (`noSourceLocationIds`, `locations-for-source.js:106`) | write zero-filled snapshots and digests for Hatch |
| `morning-briefing` (`fetchStudioPulse`) | no source check | Hatch pulse built from Glofox-shaped zeros |
| Ungated APIs: `/api/churn-radar*`, `/api/lead-radar`, `/api/mobile/radar`, `/api/mobile/today-feed`, contact command-centre arrears, `business-rail.js` | none | the same empty or misleading data on phone and web |

**Fix:** one helper, `membershipCapability(db, locationId, key)` in `src/lib/membership/`. Pages gate with `MembershipSourceGate` on the capability. Crons and APIs skip a location whose capability is `false` and log a structured skip, never a silent empty result. Tests: a `configured` source with `memberships:false` renders the gate on both dashboards, and every listed cron skips it. **Small. Do it before any P1 work.**

---

## P1.1 Hatch classes into the shared class tables

### What happens when rows appear (from the reader audit)

| Reader | Effect | At Hatch |
|---|---|---|
| **TV board**: `resolveCurrentClassForTv`, `tv-idle-content.js` "Up next" | display | **acts**: 2 active TVs show Hatch classes (intended) |
| `fetchTodayOps` (business dashboard "today's classes") | display | acts |
| `class-categories.js` (settings mapping list) | display | acts (harmless) |
| `campaign_outcome_stats` RPC | display | acts |
| `/api/automations/[key]/schedule` (climate cards) | display | acts when opened |
| Class climate / bathroom climate runners | **device** | inert: no `location_automations` rows |
| Shelly reconcile (`shelly/reconcile.js`) | **device** | inert: all 6 devices disabled, mode `none`. **Becomes live the day someone sets a device to class mode** |
| Fleet health "bridge blind", HR session linking, bridge samples, detections, auto-end-stale HR | data and staff alert | inert: no bridge |
| HYROX publish and coach reminder | display and staff push | inert: no active block, and needs "hyrox" in the class name |
| `glofox-trainers` route, Glofox sync internals | none | Glofox-gated, never runs |

`class_bookings` adds **customer-facing and data-writing readers that act automatically**:

| Reader | Effect |
|---|---|
| `send-class-booking-reminders` (every 5 min) | **push "class starting soon"** to members with the app installed |
| `credit-attendance` (daily) | creates participation HR sessions, then `finalizeSessionRewards`: achievements, **session/goal/tier pushes**, monthly targets |
| Studio KPI floor (`fetchFloor`) | fill / no-show / per-coach (needs `raw.booked` and uppercase `BOOKED`) |
| Coach live roster, claim search, journey lanes | display |

### Data-shape traps found
- **Status case:** Glofox rows are uppercase (`BOOKED`, `CANCELLED`). un1t sends lowercase (`booked`, `cancelled`, `attended`, `no_show`). Readers filter `!= 'CANCELLED'` and `=== 'BOOKED'`, so lowercase rows would be **reminded even when cancelled** and counted wrongly. The projection must uppercase: `booked→BOOKED`, `cancelled→CANCELLED`, `attended→ATTENDED` with `attended=true`, `no_show→NO_SHOW` with `attended=false`.
- **Unscoped id lookups:** `credit-attendance` (`:141-144`), `auto-end-stale-hr-sessions` (`:92`) and the climate `automation_fire_log` reads match `glofox_event_id` with no location filter. Namespace the projected ids, e.g. `un1t:<uuid>`, so they can never collide with a Glofox id.
- **`glofox_member_id` matching:** roster, bridge and wearable matching join `class_bookings.glofox_member_id` to `contacts.glofox_member_id`. un1t users have none, so roster names come from `contact_id` / `member_name` only. That is acceptable at Hatch, which has no bridge.
- **Fill %** needs `raw.booked`; un1t gives `bookings_count`. Map it into `raw.booked` or teach `fetchFloor` the column.

### Plan
- **P1.1a: occurrences only.** Add `class_occurrences.source_platform` (`'glofox'` default, `'un1t_online'`). The sync projects `un1t_events` with id `un1t:<un1t_id>`, `name=title`, `capacity=clients_limit`, `raw.booked=bookings_count`, and `cancelled_at` from status. Never delete, same as the sync. Effect: TVs and dashboards show Hatch's timetable. **No customer messages, no devices** (verified above).
  - Guard for the Shelly risk: add a test, plus a note on the Shelly device form, that class mode at a un1t studio follows un1t.online's timetable.
- **P1.1b: bookings, behind an explicit per-location switch.** Project `un1t_bookings` with the status mapping above, `glofox_booking_id = 'un1t:<id>'`, and `contact_id` from the sync's map. It is **off by default**: a `locations.settings.un1t_online.project_bookings` flag that `send-class-booking-reminders` and `credit-attendance` also honour per location. It turns on only after decision 1.

---

## P1.2 Turn on membership surfaces through a real read seam

**Status (2026-10-17):** P1.2a is in #2076: the read seam (`src/lib/membership/reads/`), the Glofox pass-through adapter, and the un1t.online adapter (counts, billing-only MRR, flows, growth, engagement, revenue; no arrears or radar). The business and studio dashboards and the phone business route read through it, and membership snapshots include un1t.online. Capabilities stay false, so radars, the engagement page and Mia are unchanged. Plan: `2026-10-17-un1t-online-membership-reads.md`. Next: the radar adapter, the classifier fed from the seam (decision 4), then `memberships` flips true.

### Seam
Add `src/lib/membership/reads/`, a per-source adapter with only the reads the surfaces need:

```
memberRoster(db, locationId)   → [{ contactId, status: member|credit_member|trial|lapsed, planName, priceCents, interval, periodEnd, pastDue, cancelAtPeriodEnd, pausedUntil }]
membershipCounts(db, locationId) → { members, creditMembers, trials, ... }   // what computeMembershipCounts returns today
pastDue(db, locationId)        → [{ contactId, amountCents, since }]
attendanceSummary(db, locationId, contactIds) → { lastAttendedAt, attended30d, noShow30d }
```

The **Glofox adapter** wraps today's queries unchanged, and surfaces switch to the seam one at a time without changing output. The **un1t adapter** reads `contact_memberships` (source `un1t_online_api`), `un1t_subscriptions` (`past_due_at`, `cancel_at_period_end`, `paused_*`, `price_cents`, `billing_interval`) and `un1t_clients` (`last_attended_at`, `bookings_30d_*`, `credit_balance`). It scopes by **membership `location_id`**, not `contacts.location_id`, so the 52 dual-studio members count.

### Order (flip a capability only when everything behind it reads the seam)
1. **`memberships`**: `computeMembershipCounts` (business and studio membership panels, studio pulse), the studio KPI MRR, and the member lists. Growth and revenue churn need start/cancel events: derive them from `un1t_subscriptions` (`remote_created_at`; status moving to cancelled) into `membership_transitions`, or have the adapter compute them. *Decide in the implementation plan.*
2. **`invoices`**: Mia `get_my_payment_reminder` (`account-tools.js:606-608` already gates on the capability) and arrears (`un1t_invoices.status`, `un1t_subscriptions.past_due_at`).
3. **`credits`**: `un1t_clients.credit_balance` / `credit_unlimited`.
4. **`bookings` / `schedule`**: after P1.1.

### Pipeline classifier (Hatch funnel)
`shared/pipeline-classifier.js` places a contact as member or converted only if `glofox_membership_status ∈ {member, credit_member}`. The first-class through trial-done stages need `recent_bookings` / `last_attended_at` **on contacts**, which the un1t sync never writes. **So every Hatch contact sits at new_lead or dormant.** Fix: feed the classifier from the seam (membership status plus attendance summary) for un1t locations. Without that, the Hatch pipeline board and the funnel-based sequences are wrong.

---

## P1.3 Dual-studio members (the 52)

| Surface | Today, for the 52 | Fix |
|---|---|---|
| Email / WhatsApp campaigns (`contact_location_audience` → clp) | 39 reachable, 13 not | the sync creates a Hatch clp row for every linked client (marketing stays on, per the 2026-10-17 decision) |
| Contact list / search (`contacts.location_id` OR Hatch deal) | 12 visible, 40 hidden | widen the crossover set (`crossover_contact_ids` RPC, `canViewContact`) to "active membership at this studio" |
| **RLS for Hatch-only staff** (`contacts_select`, `private.auth_contact_read_location_ids`, migs 690/699) | cannot read 40 of them on the phone | add an active-`contact_memberships` branch to the read helper (migration; mirror in JS; guard test `contacts-read-scope-migration-guard`) |
| Studio dashboard and KPI counts (`contacts.location_id`) | missed | fixed by the P1.2 seam (membership-scoped) |
| Sequence triggers and segments (`cron-triggers.js`, `segment-sync.js`, `audience-eligibility.js:58`) | missed | membership-aware audience join, after the seam |
| Mia / WhatsApp routing (`contact.location_id`) | answered as Stillorgan, from Glofox data | P1.4 |

---

## P1.4 Mia at Hatch (read-only)

| Tool | un1t source |
|---|---|
| `get_my_membership` | `un1t_subscriptions` + `un1t_products` |
| `get_my_next_class`, `list_my_upcoming_bookings` | `un1t_bookings` ⨝ `un1t_events` |
| `get_my_recent_attendance` | `un1t_clients` (no 7-day column; say so) |
| `list_upcoming_classes` | `un1t_events` (full / not full only; never show capacity numbers to customers) |
| `get_my_payment_reminder` | `un1t_invoices`, `un1t_subscriptions.past_due_at` (after P1.2 step 2) |

The tools dispatch on the **member's** provider, not the conversation's. For one of the 52 messaging Stillorgan's number, Mia needs a rule for which studio's membership answers. Recommend: the studio where they hold an active membership, and both if both. `book_class` and `cancel_class_booking` already hand off "not connected"; they stay that way until P2.2 (write token).

---

## Order of work

1. **P1.0** dashboard and cron gating regression *(small; first)*
2. **P1.2 seam** + Glofox adapter (no behaviour change) + un1t adapter + flip `memberships`
3. **P1.1a** occurrences projection (TVs and dashboards)
4. **P1.3** dual-studio visibility (clp rows, crossover, RLS)
5. **P1.2** classifier + `invoices` → **P1.4** Mia read-only tools
6. **P1.1b** bookings projection, with CRM class reminders and attendance pushes hard-off for un1t.online locations (decision 1)

---

## Decisions (Richard, 2026-10-17)

1. **Class reminders and attendance pushes at Hatch: the CRM must NOT send them.** The un1t.online app already sends its own reminders, so CRM pushes would duplicate them. Consequence for P1.1b: bookings may be projected only with `send-class-booking-reminders` and `credit-attendance` (its session, achievement, goal and tier pushes) **off for every un1t.online location**, enforced in code per location, not by an optional setting. If that cannot be guaranteed, bookings stay unprojected.
2. **TVs and dashboards from Hatch's timetable (P1.1a): yes, needed.**
3. **Hatch staff see Hatch members whose contact lives at Stillorgan: yes**, scoped to studios where the person holds an active membership (RLS helper + crossover + `canViewContact`).
4. **Hatch pipeline driven by un1t.online data: yes.**
5. **Mia answers dual-studio members from the studio where they hold an active membership: yes.**

P1.0 needs no decision and goes first.
