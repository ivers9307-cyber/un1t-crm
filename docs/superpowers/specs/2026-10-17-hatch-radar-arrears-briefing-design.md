# Hatch Street: churn + lead radar, arrears and the briefing pulse from un1t.online

**Date:** 2026-10-17
**Status:** design, for review by Richard. Spec B of five (see "Dependencies").
**Builds on:** #2068 (sync), #2072 (UN1TCAP.1 capability gating), #2076 (membership read seam). Roadmap: `docs/superpowers/plans/2026-10-17-un1t-online-followups.md` §P1.2 step 4, `docs/superpowers/plans/2026-10-17-un1t-online-p1-plan.md` §P1.2 "Order".

---

## Intent and why

Hatch Street's members live in un1t.online. The churn radar, lead radar, arrears figures, weekly digest and the morning briefing's "Studio pulse" all read Glofox-shaped columns (`contacts.glofox_*`, `glofox_invoices`), so at Hatch they are either gated off (#2072) or, on the ungated APIs, quietly zero. Richard wants the same at-risk rules Stillorgan uses, built from un1t signals, with cancelling and past-due members at the top, and the Hatch digest and briefing going to him only. This spec routes every one of those reads through the membership seam, adds a un1t radar adapter that produces the same row shape the scorer already consumes, cleans the Glofox-shaped history Hatch accumulated, and ends with flipping `capabilities.memberships` to true for un1t.online.

## Goals

1. A un1t radar adapter whose rows go through the UNCHANGED pure scorer (`src/lib/churn-radar.js`, `src/lib/lead-radar.js`), so Stillorgan's rules are Hatch's rules.
2. Cancelling (`cancel_at_period_end`) and past-due members are the first thing on Hatch's At-risk tab.
3. Every arrears surface this spec owns (radar Overdue tab, business rail, business KPI, briefing) reads Hatch arrears through spec A's `pastDue` read; the contact page and command centre are A's own.
4. `fetchStudioPulse` reads through the seam; its comparator never compares un1t numbers with Glofox-shaped rows, and "vs last month" stays hidden until Hatch has 30 days of un1t-shaped snapshots.
5. Hatch's digest and briefing reach Richard only, by data, with no address in the repo.
6. `memberships` flips true only after every surface behind it reads the seam, with the full list of what turns on.

## Non-goals

- Spec A's work: the invoices capability, the payment-history panel, the pipeline classifier, the acquisition board. This spec consumes A's past-due read.
- Projecting bookings into `class_bookings`, fill / no-show / low-fill numbers (spec C). The radar reads `un1t_bookings` directly and does not need C.
- Any write to un1t.online (spec D). Mia (spec E): no Mia path reads the `memberships` capability (verified: `src/lib/agent/tool-capability.js:54` reads `bookings`, `account-tools.js:609` reads `invoices`).
- Reactive dunning at Hatch. `src/lib/dunning.js` is driven by Glofox `INVOICE_UPDATED` webhooks; un1t.online has no webhooks, and nothing here adds sync-driven dunning.

## Anti-goals

- No change to a single Stillorgan number, row or order. Every Glofox path stays a pass-through, and tests pin it.
- No Glofox-shaped zero ever rendered or emailed for Hatch: a read the adapter lacks says "not available from un1t.online", never 0 (§4).
- No radar, arrears or other aggregate studio number on a TV or any customer-facing screen (#2067 rule); these are staff dashboards and staff emails only.
- No new outbound WhatsApp routed through Stillorgan's number (§5).
- No new customer-facing message, sequence or push. The flip itself starts none (proved below).
- No phone OTA: every change is server-side (`mobile/app/(staff)/radar/index.jsx` already hides a null section).
- Richard's address never appears in code, tests, fixtures, migrations, PR text or logs.

---

## Current state (verified on `origin/main` d75b064d)

**Churn radar.** `fetchMembers` (`src/lib/churn-radar-data.js:192-208`) reads `contacts` at `location_id = L` with `glofox_membership_status IN ('member','credit_member')` and the columns at `:27-34`. `fetchPastDue` (`:120-162`) aggregates `glofox_invoices` PAST_DUE / PENDING into `{ ids, byId, pendingById, membershipById, chargesById }`. `loadRadar` (`:323-423`) runs `buildRadar` / `radarSummary`, overlays actions, and takes its trend from the newest `churn_radar_snapshots` row (`:413-420`). Winback reads `fetchWinbackContacts` (`:613-629`, adds `ex_member`). `loadContactArrears` (`:589-602`) sums one contact's netted PAST_DUE `glofox_invoices`.

**Scorer rules** (`src/lib/churn-radar.js`): population `MEMBER_STATUSES` (`:31`); live gate `hasLiveMembership` (`:152-175`: trial/one-off plan names out, pack live only as `credit_member` with credits, payg out, ended states out); `classifyContact` (`:203-217`: past-due → `overdue` before the live gate, `paused`, footprint = `last_attended_at` or `last_booked_at` else `quarantine`). Detectors (`:222-339`): gone quiet (14-45 days since last attended, weight 2, 3 from 28 days), disengaging (≥4 attended in 30d and 0 in 7d, 3), no-show (≥2 no-shows in 30d, 3 if more than attended), renewal cliff (expiry within 30 days and <4 attended in 30d, 3 within 14), pack low (≤2 credits, 3 at 1), payment slipping (days since `last_payment_at` beyond the billing cycle + 3, weight 3). Tier high ≥5, medium ≥3 (`:75-76`). `buildRadar` sorts score, then monthly value, then days quiet (`:443-456`). `monthlyValueCents` parses `glofox_billing_interval` like "3 months" (`:115-136`).

**Lead radar.** `fetchNonMembers` (`src/lib/lead-radar-data.js:33-49`) reads `contacts` at L with `glofox_membership_status IN NON_MEMBER_STATUSES` (`src/lib/lead-radar.js:34-37`). Sync-created and lead-form Hatch contacts have `glofox_membership_status` NULL (no default, mig 133; `src/lib/un1t-online-contacts.js:183-193` never writes it), so Hatch's lead radar is empty by construction.

**Gates today.** Pages gate on `capability="memberships"`: churn radar (`src/app/dashboard/churn-radar/page.js:39-46`), lead radar (`lead-radar/page.js:42-49`), engagement (`engagement/page.js:31`), studio radar cells (`studio/page.js:107`), business churn KPI (`src/lib/dashboard/business-kpis.js:56`). Crons skip `locationIdsWithoutCapability(db,'memberships')`: `churn-radar-snapshot` (`route.js:42`), `lead-radar-snapshot` (`:42`), `churn-radar-digest` (`:66`), `glofox-data-quality` (`:53`), morning-briefing pulse strip only (`morning-briefing/route.js:78-80,99`). `membership-snapshot` already runs Hatch through the seam by source key in any state (`membership-snapshot/route.js:68-79`), so the first un1t-shaped Hatch `membership_snapshots` row lands 2026-10-18 02:00 UTC.

**Ungated (no capability check):** `/api/churn-radar` and its sub-routes, `/api/lead-radar*`, `/api/mobile/radar` (`route.js:55-90`), `/api/mobile/today-feed` → `fetchChurn` (`src/lib/today-feed-data.js:126-148`), the command-centre and contact page `loadContactArrears` (`src/app/api/contacts/[id]/command-centre/route.js:97`, `src/app/(sales)/contacts/[id]/page.js:102`), `business-rail.js` (`src/lib/dashboard/business-rail.js:65-130`), `account-home.js:197-205`. At Hatch they compute Glofox-shaped zeros.

**Writes.** `quarantine` POST `stale` writes `contacts.pipeline_stage_slug='dormant'` (`src/app/api/churn-radar/quarantine/route.js:95-103`); lead `cleanup` `archive` does the same (`src/app/api/lead-radar/cleanup/route.js:111-118`). `action` (`churn-radar/action/route.js`) logs `churn_radar_actions`, sends WhatsApp (`winback_sent` free text `:159`, `outreach_sent` template via `src/lib/radar-outreach.js:133-166`), and `payment_reminder` enrols the dunning sequence after reading `glofox_invoices` (`:229-276`). `refresh-member` re-pulls from Glofox (`refresh-member/route.js:84-111`). Every one of these scopes the contact by `contact.location_id === activeLocation` (`action:124`, `refresh-member:74`, `lead action:80`, `quarantine:84`, `cleanup:98`), so a dual-studio member (contact at Stillorgan, membership at Hatch) is refused.

**Pulse.** `fetchStudioPulse` (`src/lib/studio-pulse-data.js:49-74`) calls `computeMembershipCounts` (Glofox) and `loadRadar` directly. `pickComparator` (`:26-44`) takes the last row before this month, else the OLDEST row. Hatch holds Glofox-shaped rows in `membership_snapshots` (daily from June until #2005 merged late on 10 Oct, then once more for 17 Oct: the 02:00 UTC run fell between #2068, merged 16 Oct 22:34 UTC, and #2072, merged 17 Oct 08:51 UTC), and in `churn_radar_snapshots` / `lead_radar_snapshots` (Mondays up to 5 Oct; no Monday fell between #2068 and #2072). `membership_snapshots` has no source marker (mig 224).

**Recipients.** Both the digest (`churn-radar-digest/route.js:79-82,124-127`) and the briefing (`morning-briefing/route.js:13-18,88-91`) send to `locations.churn_digest_recipients` (text[]). The editor is in `src/components/ChurnRadar.jsx:367-382` behind the radar page's gate, so it is unreachable at Hatch today, yet the briefing's triage email already goes to whatever Hatch's list holds (only the pulse strip is gated).

**Rail leads row.** `leadsRow` counts `contacts.pipeline_stage_slug='new_lead'` (`business-rail.js:104-108`). That column follows the location's PRIMARY board (mig 595); Hatch's primary is the manual waitlist board (mig 597), so the row never fires there, even after spec A re-enables the acquisition board.

---

## Design

### 1. Seam dispatch for radar reads (by source key, any state)

New read keys on the adapters in `src/lib/membership/reads/` (add to `READ_KEYS`, `index.js:21-23`): `radarMembers`, `winbackContacts`, `leadContacts`, `radarPastDue` (§4, on top of A's `pastDue`).

- **Glofox adapter** (`reads/glofox.js`): pure pass-throughs. Export `fetchWinbackContacts` and `fetchNonMembers` (today module-private) and forward to them; `radarMembers` → `fetchMembers`; `radarPastDue` → `fetchPastDue`.
- **Dispatcher** `radarReadsFor(db, locationId)` in `reads/index.js`: resolves by SOURCE KEY through `READS_BY_SOURCE`, in any state, exactly as `membership-snapshot` does (UN1TREAD.5). **Claude's call:** not `membershipReadsFor`, which returns `reads: null` unless `configured`; Stillorgan's radar reads stored contacts and must keep working through a Glofox credential glitch. A source key that cannot be read throws (`MEMBERSHIP_SOURCE_UNREADABLE`): routes answer 500, crons record a per-location error, the pulse returns null. Never "no members".
- `churn-radar-data.js` and `lead-radar-data.js` keep every export and signature; only the row fetch changes (`fetchMembers(db,L)` → `reads.radarMembers(db,L)` etc.). Actions, dismissals, snoozes and trend logic stay in place. `applyPersonRollup` runs only when rows carry `person_group_id` (un1t rows carry null: **Claude's call**, no aggregator accounts exist at Hatch yet; roadmap P2.1).
- `src/lib/engagement-analytics-data.js:55-59` swaps `fetchMembers` / `fetchPastDue` for the same reads.

### 2. The un1t radar adapter

New `src/lib/membership/reads/un1t-online-radar.js` (I/O) and `un1t-online-radar-shape.js` (pure). Every query filters `location_id = L` on the `un1t_*` table (membership scope, so the 52 dual-studio members count), is `.order().range()` paginated via `selectAll`, and reads only; `contacts` is read by id for `name` only.

**Inputs.** Active subscriptions with the existing stale-active guard (extract the guard from `listActiveSubs`, `reads/un1t-online.js:50-69`, into a shared helper; the radar variant also selects `contact_id, product_id, product_title, current_period_end, cancel_at_period_end, paused_at, paused_until, past_due_at, remote_created_at`). `un1t_clients` (all rows at L). Pack transactions + products (same as counts). Subscription payments: `un1t_transactions` with `type IN ('sub_initial','sub_renewal')`, `amount_cents > 0`, not refunded. Events with `starts_at` in [now − 30d, now], then `un1t_bookings` for those `event_id`s (chunked `.in()`, ≤200 ids). The newest booking `remote_created_at` per user (one paginated read of `un1t_user_id, remote_created_at`).

**Membership per un1t user (Claude's call on multi-subscription users):** live subscriptions are those in `MEMBER_STATUSES` (`un1t-online-shape.js:21`: active, past_due). Plan and value come from the subscription with the highest monthly-normalised price. Cancelling = EVERY live subscription has `cancel_at_period_end`. Paused = every live subscription has `paused_at` set and `paused_until` null or in the future. Pack holders use the exact rule `shapeCounts` uses (`un1t-online-shape.js:65-115`): extract it into one exported function so the radar's active base and the dashboard's member count can never disagree. A client with no `contact_id` is left out (nothing to act on) and counted in the build log.

**Row mapping (the scorer's existing row shape; the `glofox_` key names are the scorer's contract, not a claim about the data):**

| Scorer key | un1t value | Rule reproduced |
|---|---|---|
| `id`, `name` | `un1t_clients.contact_id`, `contacts.name` | exact |
| `glofox_membership_status` | `member` (live sub) / `credit_member` (pack holder) / `ex_member` (winback, §2b) | exact |
| `glofox_membership_type` | `time` / `num_classes` | exact; un1t has no payg |
| `glofox_membership_plan` | `product_title` (sub, or latest pack) | exact: "The UN1T Trial" is caught by `NON_MEMBER_PLAN_RE` and €0 packs never become holders |
| `glofox_membership_state` | `paused` per above, else `active` | exact; `locked`/`frozen`/`suspended` have no un1t form and are not needed (past-due is the invoice-driven branch, as at Stillorgan) |
| `glofox_membership_expiry` | `current_period_end` | **builder check**, below |
| `glofox_membership_price_cents`, `glofox_billing_interval` | `price_cents`; `glofoxInterval(billing_interval, billing_interval_count)` (`un1t-online-shape.js:48`) | exact, so `monthlyValueCents` parses it unchanged |
| `trial_credits_remaining` | `credit_balance` | exact |
| `last_attended_at` | `un1t_clients.last_attended_at` | exact (covers history before the mirror) |
| `last_booked_at` | newest `un1t_bookings.remote_created_at` for the user | exact from 2026-09-27 (mirror start); earlier is null, which only matters when `last_attended_at` is also null |
| `total_attended_30d`, `total_noshow_30d` | `un1t_clients.bookings_30d_attended`, `bookings_30d_no_show` | un1t.online's own 30-day figures; window definition **builder check** |
| `total_attended_7d` | derived: user's bookings with status `attended` on events starting in [now − 7d, now] | derived from the mirror, exact (mirror holds ≥7 days) |
| `total_bookings_30d` | derived: non-`cancelled` bookings on events in the 30-day window | derived |
| `last_payment_at` | newest subscription payment transaction | exact |
| `joined_at`, `lifetime_value_cents` | `un1t_clients.remote_created_at`, `ltv_cents` | exact |
| `cancel_at_period_end` (new optional key) | per above | new; Glofox rows never set it |

Statuses in the mirror are lowercase (`booked`, `cancelled`, `attended`, `no_show`, per the OpenAPI `UserBookingResponseDto`); the shape module compares lowercase and never reuses the uppercase Glofox constants.

**Builder checks (read-only, recorded in the PR):** (a) Renewal cliff: one query on Stillorgan's `time` members for the spread of days to `glofox_membership_expiry`. If Glofox carries the next charge date for rolling monthly plans, map `current_period_end` for every subscription. If Glofox leaves rolling plans without an expiry, map it only when `cancel_at_period_end` is true or the plan's period is longer than one month, so a monthly low-attender is not flagged every month at Hatch when they would not be at Stillorgan. (b) The 30-day counts: Hatch starts on un1t.online's own `bookings_30d_*`, and the flip does NOT wait for this check. Once the mirror covers 30 days (from 2026-10-27), compare them with the mirror-derived 30-day counts for every Hatch client; if they differ, switch both counts to mirror-derived in a follow-up PR and say why.

**2b. Winback rows (`winbackContacts`).** Live members as above, plus ex-members: a un1t user at L with NO live subscription and no pack credits now, and evidence of a past membership at L from any of: (i) a `un1t_subscriptions` row the mirror keeps whose status is not live (cancelled, ended, expired, or whatever non-live values the mirror holds), (ii) a `un1t_subscriptions` row left `active` but outside the stale-active window (the API stopped returning it; the mirror never deletes, `reads/un1t-online.js:38-46`), (iii) an `ended` `contact_memberships` row at L, source `un1t_online_api` OR `un1t_online_export`. Status `ex_member`; plan and price from their newest `un1t_subscriptions` row, else the export row's plan. An ended export row alone is NOT evidence when the person holds a live subscription: mig 728 ended the 20 export rows precisely because each was superseded by an active API row, so the "no live subscription now" test comes first. **Builder check (read-only, before PR 1):** list the distinct `un1t_subscriptions.status` values at Hatch and whether `/subscriptions` returns cancelled rows at all (`counts.history` on `un1t_sync_runs` shows rows absent from the pull); record it in the PR and in the shape module's header. Hatch's history starts 2026-08-19, so the 45-365 day window fills from early October onward.

**2c. Lead rows (`leadContacts`).** A person must be the same thing on the lead radar and on Hatch's board, so this read does not derive status itself: it calls spec A's `pipelineInputs(db, L, { now })` (A §6.2) and takes each contact's snapshot, shaped by A's pure `shapePipelineSnapshot` in `reads/un1t-online-shape.js`. That gives, unchanged:
- `glofox_membership_status` in A's order (member, credit_member, classpass_payg, trial, ex_member, lead). **Trial** is A's rule: a transaction for a product where `isTrialProduct` holds (keyed on product id), or spec D's ledger row `un1t_write_events` `op='trial'` `done` for them at L, with trial credits counted from the trial itself, never the whole credit balance. **Aggregators** are A's rule: any booking at L whose `source` is not `direct` or whose `external_member_ref` is set; Wellhub / Gympass users carry `gympass_member_id`, every other aggregator is `classpass_payg`.
- `joined_at` and `last_attended_at` from the snapshot. `last_booked_at` is the user's newest `un1t_bookings.remote_created_at` (as in §2).

Population: every snapshot whose status is in `NON_MEMBER_STATUSES` (`lead-radar.js:34-37`), so members, credit members and ex-members are out (ex-members are win-back, §2b). A snapshot with `gympass_member_id` set goes to the read-only aggregator view with the ClassPass rows, never the funnel, matching the board's Gympass pile. Membership is judged at L only (Richard, G1: status and pipeline are separate per studio, only the contact is shared), so a Stillorgan member with no Hatch membership is a Hatch lead or trial, and their Stillorgan `glofox_membership_status` is never read here. A's board population is un1t clients only; the lead radar also lists contacts OWNED by L with no `un1t_clients` row (lead forms, the August campaign) as `lead`, with `joined_at` from `contacts.joined_at`, else `contacts.created_at` (**Claude's call**: Hatch was never bulk-imported, so `created_at` is real there; the import-poisoning note in `lead-radar.js:27-30` is Stillorgan's). Those people are not on the acquisition board until the sync links an account (A §6.3), which is the one deliberate difference between the two surfaces. A test feeds the same fixtures to both A's board classifier and this read and asserts the same status for every un1t client.

**Rules that cannot be reproduced exactly:** person rollup (no grouped accounts at Hatch); `last_booked_at` before 2026-09-27; Glofox `locked` state (not needed); unpaid non-membership charges and awaiting-authorization (PENDING) charges, which un1t.online does not expose: shown as "not available from un1t.online" (§4).

### 3. Cancelling and past-due at the top

- New detector `detectCancelling` in `churn-radar.js`: fires when `contact.cancel_at_period_end === true`. Signal `{ key:'cancelling', label:'Cancelling', detail:'Membership ends on <date>', weight:6, severity:'critical', pin:true }` (weight 6 makes the tier high). `buildRadar`'s sort gets a first key: rows carrying a `pin` signal come first. A Glofox row never sets the key, so Stillorgan's order is unchanged (pinned by a test on the existing fixtures).
- Past-due stays exactly Stillorgan's rule: `classifyContact` returns `overdue`, the member counts in `overdue`, not `atRisk`, and appears on the Overdue tab with A's amount. For "top": `loadRadar` also returns `pinned`, the `buildOverdue` rows for membership arrears, when the adapter declares `pinArrears: true` (un1t studios only; **Claude's call**, see Claude's calls 3). `ChurnRadar.jsx` renders them above the At-risk list as "Payment failed" rows linking to the Overdue tab. Summary counts do not change.

### 4. Arrears surfaces (A's read)

Spec A §6.10 defines `un1tOnlineReads.pastDue(db, locationId, { contactIds? })` → `{ success, data: [{ contactId, un1tUserId, subscriptionId, productTitle, since, amountCents (null when un1t.online reports no open invoice), currency, openInvoiceIds, cancelAtPeriodEnd, pausedUntil }] }`, fresh rows only (A's `freshCutoff`). This spec adapts it, never re-derives past-due:
- **`radarPastDue`** (new, un1t adapter; Glofox adapter → `fetchPastDue`): folds A's rows into `fetchPastDue`'s shape `{ ids, byId, membershipById, chargesById, pendingById }`. Every un1t past-due row is a subscription payment, so it goes to `byId` and `membershipById`; `chargesById` and `pendingById` are not readable from un1t.online, so the adapter declares `unavailable: ['unpaidCharges','awaitingAuth']` and those two tabs, their summary badges, the digest and the briefing show "not available from un1t.online", never 0 (the summary carries `null` for those counts and every renderer maps `null` to that copy). `oldestDueAt` = `since`. **Claude's call:** when `amountCents` is null, the aggregate uses the subscription's `price_cents` and carries `amountEstimated: true`, because `bucketArrears` drops a zero amount (`churn-radar.js:549-563`) and the member would vanish from the Overdue tab; the row reads "about €X (estimate: amount not reported by un1t.online)", and every place that sums it (Overdue badge and total, business "In arrears" card and rail row, digest, briefing pulse) labels the total as including an estimate. A `success:false` throws (the radar fails, never shows "nobody owes").
- Radar Overdue tab, `ctx.pastDueIds` and the pinned "Payment failed" block (§3): `radarPastDue`.
- un1t adapter **`arrears`** read (same `{ success, data: { totalCents, memberCount } }` as `fetchArrearsSummary`, `shared/dashboard-data.js:570-589`) built on the same fold, so `business-kpis.js:77` and the business page's "In arrears" card light up through the existing `supportsRead(m,'arrears')`; estimates are included and the card sublabel says so.
- `business-rail.js` `arrearsRow`: `fetchArrearsSummary` → `radarReadsFor(...).reads.arrears` (unavailable → row omitted, as today on failure).
- **Contact page and command centre: spec A's** (`loadUn1tBilling`, A §6.11, which adds the un1t amount to the header and the command-centre response). `loadContactArrears` stays Glofox-only here so nothing is counted twice.

### 5. Routes and crons that act

- **Scope widening (all five radar write routes):** accept the contact when `contact.location_id === activeLocation` OR it is a crossover at the active location (active `contact_memberships` or a `un1t_clients` row there). New helper `isCrossoverAt(db, contactId, locationId)` in `src/lib/contact-crossovers.js`, reusing `probeMembershipOrClient` with `[locationId]` only; fails closed (any error → 404). Never the user's other studios.
- **`quarantine` stale / `cleanup` archive at a un1t studio:** write the action row only, never `contacts.pipeline_stage_slug` (**Claude's call**: the column follows Hatch's primary waitlist board, spec A's classifier owns Hatch stages, and for a crossover it belongs to another studio). The exclusion still holds: `quarantine_stale` is in `EXCLUSION_ACTIONS` (`churn-radar-data.js:49`); cleanup triage is honoured by `indexActions`.
- **`payment_reminder` at a un1t studio:** 409, "Payment reminders are not available for un1t.online studios yet." The button is hidden when the radar response's `source` is not `glofox` (**Claude's call**: the path reads `glofox_invoices` and mints a Glofox pay link).
- **`refresh-member` at a un1t studio:** 409 with the last sync time ("un1t.online data refreshes every 15 minutes, last at HH:MM"); the "Refresh from Glofox" button is hidden there.
- **Outreach (`winback_sent`, `outreach_sent`, lead `outreach_sent`):** at Hatch the send stays refused until the org-wide WhatsApp follow-up ships (Richard, G7). The route already catches `WhatsAppNumberMissingError` (`action/route.js` imports `isWhatsAppNumberMissing`); the refusal copy becomes "No WhatsApp number at this studio yet", logged once (`logInfo('churn-radar','outreach refused: studio has no WhatsApp number',{ locationId })`), no action row written. Nothing here routes a new outbound send through Stillorgan's number; `RadarOutreachButton` shows the same note instead of a template picker at a number-less studio.
- **Read APIs:** `/api/churn-radar*`, `/api/lead-radar*` answer `{ success:true, data:null, unavailable:'memberships' }` while the location's provider lacks the capability; `/api/mobile/radar` returns that section as `null`; `fetchChurn` returns null. Each logs one structured skip (`logInfo(module,'radar skipped: source lacks memberships',{ locationId, source })`). Responses gain `source` and `dataAsOf` (newest `ok` `un1t_sync_runs.finished_at` at a un1t studio) so the page can say "un1t.online data as of HH:MM".
- **`glofox-data-quality`:** iterate `listLocationsByMembershipSource(db,'glofox')` instead of the memberships capability (it checks Glofox pack sync freshness and means nothing at Hatch).
- **`leadsRow`:** when the location's primary pipeline is not `key='acquisition'`, count open deals on that location's enabled `acquisition` board at stage slug `new_lead` created over 24h ago, minus contacted ones; otherwise today's query unchanged.
- **Snapshot crons and digest:** no code change beyond the seam: once the capability flips they include Hatch and call the seam-aware `loadRadar` / `loadFunnel`.
- **`account-home.js` members:** switch the head-count to `reads.membershipCounts` by source key (one line; shows 0 for Hatch today).

### 6. Briefing pulse and the comparator

- `fetchStudioPulse`: counts from `READS_BY_SOURCE[source].membershipCounts` by source key (as `membership-snapshot`), radar from the seam-aware `loadRadar`. Still fail-soft (null on any failure).
- **Legacy rows:** one forward migration deletes Hatch's Glofox-shaped history: every `churn_radar_snapshots` and `lead_radar_snapshots` row at Hatch (all dated 5 Oct or earlier), and every `membership_snapshots` row at Hatch dated before its first un1t-shaped row. The builder confirms the boundary by reading Hatch's rows and matching the first un1t row's counts to the adapter's (expected 2026-10-18). The migration selects the location by `membership_source = 'un1t_online'`, raises if any row it would delete is on or after the boundary, and `RAISE NOTICE`s the counts. **Claude's call:** delete, not mark. The rows are Glofox readers' output for a studio with no Glofox data, carry no information, and also poison the business trend chart (`fetchMembershipTrend`) and every "latest snapshot" delta (`loadRadar:413`, digest history, `today-feed`, `business-rail` churnRow, `business-kpis` churnPrev, `account-home`). One migration fixes all eleven readers; a source column would mean touching each.
- **Comparator rule** (`pickComparator`): read the location's oldest row first. If it is younger than 30 days, return null (the delta and its "vs" label are hidden: `shapePulseMetrics` already drops a null delta, `src/lib/morning-briefing.js:55`). Otherwise keep today's rule. Stillorgan's oldest row is from June, so its output is unchanged; Hatch's "vs last month" first appears on 2026-11-17. Applies to both families (membership and churn).
- **Schema / grants:** no new table, column, view or function, so no grant decision. The migration is DML only; run `get_advisors` anyway per CLAUDE.md.

### 7. Recipients: Richard only, by data

Both emails read `locations.churn_digest_recipients`, so the narrowest change is that one value for Hatch. Steps (Richard, G8): at rollout the builder reads Hatch's current list (read-only) and reports how many addresses it holds, sets it to exactly Richard's address with a Supabase MCP UPDATE (`.eq('id', Hatch)`), reads it back, and puts the address nowhere in the repo, tests, PR or logs. Do this FIRST: the briefing's triage email already goes to that list today. After the flip the editor on Hatch's radar page shows the list, and anyone with `churn_radar` at Hatch could add to it (unchanged behaviour; Stillorgan's list is untouched).

### 8. Flipping `memberships`

The flip is one line in `src/lib/membership/sources/un1t-online.js:16`, plus its test. `bookings`, `credits`, `invoices`, `schedule` are untouched (`bookings` must stay false per spec C).

**What turns on at Hatch** (every reader of the capability, from a repo-wide grep):

| Reader | Turns on |
|---|---|
| `/dashboard/churn-radar`, `/dashboard/lead-radar` | full pages, incl. digest + dunning settings cards |
| `/dashboard/engagement` | `loadEngagementChurn` cross-tab |
| `/dashboard/studio` (`radarOk`), `business-kpis.js:56` | radar-derived cells, Churn risk KPI and briefing labels |
| crons `churn-radar-snapshot`, `lead-radar-snapshot` | weekly Hatch rows (Mon 06:00 / 06:30 UTC) |
| cron `churn-radar-digest` | Monday email to Hatch's list |
| cron `morning-briefing` | the pulse strip in Hatch's email |
| cron `glofox-data-quality` | nothing, after §5 |
| `membershipStatePayload` (`state-for-page.js:143`) | `provides_memberships` true on the phone: business dashboard and `studio-contacts` drop the "does not provide membership data" note (the funnel stages there are spec A's) |
| radar read APIs, `/api/mobile/radar`, today-feed churn row | un1t data instead of the skip |

**Customer-facing:** nothing starts automatically. No sequence, trigger, push or Mia path reads the capability; reactive dunning is Glofox-webhook-only; `notify-winback` runs off `heart_rate_sessions`, which Hatch does not have. What becomes reachable is staff-initiated only: radar outreach (fails at Hatch, no number), and payment reminders (refused at un1t studios by §5). Flagged for Richard regardless.

**Order:** A's `pastDue` read live AND A's `invoices` flip shipped (a hard prerequisite, so arrears agree on the contact page, Mia and the radar) → PR 1 (§1-2, read APIs gated; Stillorgan identical) → PR 2 (§4-6 and the migration, after the 2026-10-18 row exists) → PR 3 (§3, §5) → §7 done → PR 4 (the flip). Flip only when every row in the table above reads the seam.

### Failure modes and logging

- Any un1t read fails: the adapter throws; same handling as a failed Glofox read today (route 500, cron per-location error, pulse null, digest skips that location). Never an empty radar.
- Sync stalled: numbers freeze; `dataAsOf` shows it on the page; integration health owns the alert.
- A client without a contact, or an event without `starts_at`: excluded and counted.
- Build log per location: `logInfo('churn-radar','un1t radar built',{ locationId, members, packHolders, unlinkedClients, pinned })`. No names, emails or ids beyond the location.

---

## Decided (Richard, 17 Oct)

- At-risk rules are Stillorgan's, built from un1t signals; cancelling and past-due go to the top (decision 5).
- Hatch's churn digest and morning briefing go to Richard only (decision 6).
- Invoices same as Glofox; the radars read the same past-due data as the contact page (decision 2, via spec A).
- No HR sessions, rewards or attendance pushes at Hatch (decision 7); nothing here adds any.
- Membership status and the pipeline are separate per studio; only the contact is shared (G1). The Hatch lead radar judges membership at Hatch only.
- WhatsApp will be shared across the organisation by a separate follow-up (G7). Until it ships, Hatch radar outreach is refused with a clear "no WhatsApp number at this studio yet" message, and nothing routes a new send through Stillorgan's number.
- Hatch's digest and briefing recipient is Richard's address, set in the database at rollout via Supabase MCP and read back, never in the repo (G8).
- No fill, no-show or other aggregate studio number on a TV or customer-facing screen (G9).
- Spec A's `invoices` flip ships before this spec's `memberships` flip (A-7).

## Claude's calls (for Richard to check)

1. Claude's call: radar reads dispatch by source key in any state, not only when "configured", so Stillorgan's radar survives a Glofox credential glitch.
2. Claude's call: multi-subscription users take plan and value from the dearest live subscription, and count as cancelling only when every live subscription is cancelling, because a member dropping one of two plans is not leaving.
3. Claude's call: the cancelling and past-due pins apply at un1t.online studios only, because Richard asked for Stillorgan's rules and the pin is an extra; extending the past-due pin to Stillorgan is one flag (`pinArrears`) if he wants it (Glofox rows carry no cancel-at-period-end signal, so the cancelling pin never fires there).
4. Claude's call: win-back ex-members come from subscription history the mirror keeps plus ended API and export membership rows, checked against "no live subscription now", because the mirror never deletes and mig 728's ended export rows belong to current members.
5. Claude's call: Hatch-owned contacts use `created_at` when no other join date exists, because Hatch was never bulk-imported.
6. Claude's call: quarantine "stale" and cleanup "archive" at a un1t studio log only, with no pipeline write, because spec A's classifier owns Hatch stages.
7. Claude's call: payment reminder and Glofox refresh are refused and hidden at un1t studios, because both read Glofox data and mint Glofox links.
8. Claude's call: Hatch's Glofox-shaped snapshot rows are deleted, not marked, because they carry no information and one migration fixes all eleven readers.
9. Claude's call: the 30-day comparator rule is global, because it changes nothing at Stillorgan.
10. Claude's call: person rollup is skipped for un1t rows, because Hatch has no grouped accounts yet.
11. Claude's call: a past-due member whose amount un1t.online does not report shows the subscription price, labelled as an estimate everywhere, because dropping them would hide a real debt.
12. Claude's call: reads un1t.online cannot supply (Unpaid charges, Awaiting authorization) show "not available from un1t.online" on the page, badges, digest and briefing, never 0, because a zero would claim nobody owes.
13. Claude's call: the flip does not wait for the 30-day window check; Hatch starts on un1t.online's own `bookings_30d_*`, switched later only if the check shows a difference.
14. Claude's call: the "active base = Total members" acceptance check passes when every difference is itemised and explained, because the two counts legitimately differ on unlinked clients and trial-shaped plans.

## Left to the builder

The read-only checks in §2 (renewal-cliff expiry before PR 1; subscription statuses the mirror keeps before PR 1; the 30-day window after 2026-10-27, not blocking the flip); the exact names of A's reads; the copy of the 409 messages and the "Payment failed" block (staff-facing, no em-dashes); whether `dataAsOf` reads `un1t_sync_runs` or the registry row's `last_ok_at`.

## Tests

- `un1t-online-radar-shape.test.js`: every row of the mapping table; paused, cancelling, past-due; two subscriptions; trial and €0 packs excluded; pack-holder set identical to `shapeCounts`; unlinked client excluded; lowercase statuses; 7-day boundary.
- `churn-radar.test.js`: cancelling signal tier and pin; the existing Glofox fixtures produce identical `buildRadar` / `radarSummary` output (deep-equal against today's results).
- `radarPastDue` fold: A's rows to the Map shape, null amount becomes the price with `amountEstimated`, `success:false` throws; Unpaid/Awaiting are `null` and render "not available from un1t.online" in page, badges, digest and briefing (never 0); an estimated total carries its label.
- Win-back: an ex-member from a non-live subscription row, from a stale-active row, and from an ended export row; a current member with an ended export row is NOT an ex-member.
- Lead radar: a Stillorgan member with no Hatch membership appears as a Hatch lead/trial (G1); status comes from A's `shapePipelineSnapshot` (trial from the trial purchase or D's `op='trial'` ledger row, not the credit balance; aggregator source or `external_member_ref` goes to the aggregator view); same status as A's board for every shared fixture.
- Outreach at a number-less studio: refused with the "No WhatsApp number at this studio yet" copy, logged, no action row, no Meta call.
- `churn-radar-data.test.js` / `lead-radar-data.test.js`: dispatch by source key in every state; unreadable source throws; Glofox calls forward the same arguments; `pinned` only with `pinArrears`.
- `studio-pulse-data.test.js`: comparator null while the oldest row is <30 days; unchanged with June history; counts via the seam.
- Routes: capability false → `data:null` + skip log; crossover accepted at its membership studio and refused at any other (404); `payment_reminder` and `refresh-member` 409 at un1t; `quarantine` stale at un1t performs no `contacts` update.
- Crons: snapshot and digest include a un1t location once its provider has the capability; `glofox-data-quality` skips non-Glofox sources; digest sends only to the list (fixtures use example.com).
- `business-rail.test.js`: `leadsRow` on a manual-primary location reads acquisition deals; arrears row via the seam.
- `sources/un1t-online.test.js`: `memberships` true, `bookings` still false.
- `check:select-columns` / `check:guardrails` green.

## Rollout and live verification

1. §7 recipients first (read, set, read back).
2. PR 1 on a Vercel preview (previews read the live database; local dev has none): Stillorgan's `/api/churn-radar`, `/winback`, `/overdue`, `/api/lead-radar` JSON identical to production before merge.
3. PR 2: apply the migration via Supabase MCP after confirming the boundary; re-read Hatch's three tables (only un1t-shaped rows remain); `get_advisors`.
4. PR 4's preview shows Hatch with the flag on: radar active base equals the business page's Total members, or every difference is itemised and explained (a client with no contact, a trial-shaped plan, a credit-unlimited holder); a known dual-studio member appears; any cancelling member is first; Overdue matches A's contact-page figures. Richard looks before merge.
5. After merge, the Monday 06:00 / 06:30 UTC crons write Hatch's first radar rows; the 07:00 digest and the 06:00 briefing reach one address (Postmark outbound search by tag, read-only). The pulse shows Hatch numbers with no "vs" until 2026-11-17.

## Dependencies on sibling specs

- **A** `2026-10-17-hatch-pipeline-and-invoices-design.md`: HARD. `pastDue` and `freshCutoff` (§4); `pipelineInputs` / `shapePipelineSnapshot`, which carry the trial and aggregator rules the lead radar reuses (§2c); the Hatch acquisition board that `leadsRow` counts (§5); the contact page and command-centre arrears. The flip waits for A's `pastDue` and for A's `invoices` flip. Per A §12, any studio-KPI acquisition number at a un1t location counts acquisition-board deals, never `pipeline_stage_slug`: the scorecard's `fetchAcquisition` stays Glofox-only here (`studio/page.js:117`), so it is null at Hatch rather than wrong.
- **C** `2026-10-17-hatch-bookings-projection-design.md`: none required (the radar reads `un1t_bookings`). Low-fill and fill numbers in the briefing are C's. This spec never flips `bookings`.
- **D** `2026-10-17-un1t-online-write-back-design.md`: indirect only: its `un1t_write_events` `op='trial'` ledger row, read through A's snapshot, marks a trial granted by `/credits/grant`.
- **E** `2026-10-17-mia-at-hatch-design.md`: none; the rail's "Glofox action failed" wording for Hatch Mia requests is E's to adjust.
- **Org-wide WhatsApp follow-up** (separate task, G7): Hatch radar outreach turns on only when it ships; this spec builds nothing for it.
