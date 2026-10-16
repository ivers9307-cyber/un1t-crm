# un1t.online (Hatch Street): follow-up roadmap

**Date:** 2026-10-17
**Status:** proposed. Each workstream below gets its own spec and implementation plan when it starts. This document sets the order, the decisions and the evidence.
**Builds on:** #2068 (sync), #2069 (tab visibility), #2070 (hub Connect). Spec: `docs/superpowers/specs/2026-09-01-un1t-online-hatch-integration-design.md`. Build plan: `docs/superpowers/plans/2026-10-16-un1t-online-hatch-sync.md`.

---

## Where things stand (live, 2026-10-16 23:00 UTC)

| | |
|---|---|
| Connection | Hatch Street connected, studio `bd608fa2-…`, token "Repset CRM" (63 permissions, write-capable), expires **2027-10-16** |
| Membership source | `un1t_online`. Provider capabilities are all `false`, so no membership surface reads the data yet |
| Cron `un1t-online-sync` | 2 runs, both `ok`, averaging 8.5 s; the heartbeat is fresh with `locations_processed: 1` |
| First sync | 187 clients, 316 bookings, 138 events, 26 subscriptions, 101 transactions, 37 invoices, 17 products |
| Contacts | 172 attached by email (**52 of them belong to another studio**), 15 created, 0 failed |
| Memberships | 26 active `un1t_online_api`; 20 active `un1t_online_export`, **all 20 duplicated by an active API row** |
| History | Oldest booking 2026-09-27, oldest event 2026-09-28 (clients go back to 2026-08-19) |
| Aggregators | 0 non-direct bookings, guests or external refs so far |

---

## P0: this week (small, decisions first)

### P0.1 Marketing consent for contacts the sync creates (DECIDED 2026-10-17: leave marketing on)
**Decision (Richard, 2026-10-17):** keep the estate default. Sync-created contacts stay opted in, as Glofox-created contacts are. No code change. The analysis below is kept for the record.

**Evidence:** all 15 sync-created contacts have `email_marketing`, the location-level email flag and `whatsapp_marketing` set to **true**. The DB defaults set this when a contact is inserted; the sync writes no consent field. A un1t.online client accepted the platform's terms (`accepted_terms`), but has not consented to marketing from the CRM.
**Why it matters:** the next Hatch campaign or broadcast would reach people who never opted in (GDPR / ePrivacy). It is the same default every Glofox-created contact gets, so this is also an estate policy question.
**Options:**
1. *(Recommended)* The sync creates contacts with marketing **off**: write `contact_preferences` and `contact_location_preferences` through the existing consent path, with a `consent_log` row whose source is `un1t_online_sync`. Then backfill the 15 the same way, with the change logged.
2. Keep the estate default and rely on un1t.online's own consent capture (it has none we can see).
**Not affected:** the 172 attached contacts keep whatever consent they already had.

### P0.2 Token hygiene (DECIDED 2026-10-17: keep the current token)
**Decision (Richard, 2026-10-17):** keep "Repset CRM" as issued; no Read-only reissue. The expiry reminder still applies.

- In the un1t.online owner console, create a **Read-only** token and paste it on the tab. It is the same studio, so the connect route accepts it as a replacement. Then revoke "Repset CRM".
- Calendar the expiry. Integration health warns from **2027-09-16**. Renewing means rotating in un1t.online and pasting the new token. The fingerprint guard handles a rotated secret.

### P0.3 Tell the franchise about `reset_password_token`
`GET /users/clients` returns `reset_password_token` / `reset_password_expire` on every row (null today). When a member requests a password reset, anyone holding `users:read` can see a live reset token, which is enough to take over the account. Send it privately and keep it out of this repo. The CRM already strips the fields.

### P0.4 Retire the 20 export membership rows
All 20 active `un1t_online_export` rows have an active `un1t_online_api` row for the same contact and studio (verified). End them (`status 'ended'`, `ended_at now()`) in one migration that self-checks it touched exactly the overlapping rows. Don't delete them: ending can be undone, and member pricing reads active rows only. Once ended, the "(import)" label stops appearing on contact pages.

### P0.6 Glofox-shaped dashboards now render at Hatch (regression, added 2026-10-17)
Connecting un1t.online made Hatch `configured`. `/dashboard/studio` and `/dashboard/business` check state rather than capabilities, and the radar, snapshot, digest and briefing crons skip only `'none'`. So all of them now build Glofox-shaped zeros for Hatch. Fix: gate on `capabilities.memberships`. Detail and file references: `2026-10-17-un1t-online-p1-plan.md` §P1.0.

### P0.4 status
**Done 2026-10-17:** mig 728 applied (20 export rows ended, 26 API rows active), PR #2071.

### P0.5 Watch the first 48 hours
- `un1t_sync_runs`: every run `ok`, duration under 30 s, no growth in `contact_errors`.
- `memberships.ended` per run: a sudden jump means an upstream fault, not mass cancellations. The `no_subscriptions_pulled` guard covers only the empty-pull case.
- **History window:** re-check the oldest `remote_created_at` in `un1t_bookings` against the API on 2026-10-24. If the API's oldest booking has moved forward, `/bookings` is a rolling window, and the local mirror is the only full history (it never prunes). Record the answer in spec §0.

---

## P1: next 2–4 weeks (one spec + plan each)

**Detailed P1 plan:** `2026-10-17-un1t-online-p1-plan.md` (audits of every class-table reader, every membership surface and the dual-studio gaps; ordering; decisions).

### P1.1 Hatch classes into the shared class spine
Hatch classes live only in `un1t_events` / `un1t_bookings`. `class_occurrences` feeds about 20 readers, and several of them act on the physical studio or message customers. Audit each one, decide whether it should run for Hatch, then project `un1t_events` into `class_occurrences` with a new `source_platform` column (the external id goes into the misnamed `glofox_event_id`, as spec §3.3 already accepts).

| Reader | Effect at Hatch | Decision needed |
|---|---|---|
| TV board / idle scenes (`tv-idle-content.js`) | shows Hatch classes | likely yes |
| Class climate + bathroom climate runners, Shelly reconcile, `schedule/desired-state.js` | switches **physical devices** | only if Hatch has the devices configured |
| Hyrox reminder + publish runners | **messages customers** | explicit yes/no |
| `credit-attendance` cron, HR session linking, `auto-end-stale-hr-sessions` | attendance and HR data | needs `class_bookings` too |
| `class-bookings.js` + `send-class-booking-reminders` | **messages customers** | explicit yes/no; `glofox_booking_id NOT NULL` needs a decision |
| Timer, class categories, fleet health, bridge samples, automations schedule | display and ops | review each |

### P1.2 Turn on membership surfaces, one capability at a time
Capabilities are all `false`, so Hatch surfaces show "un1t.online does not provide membership data". Turn them on one at a time, each behind an adapter that reads `un1t_*`:
1. `memberships`: studio dashboard counts and member lists, from `contact_memberships` (source `un1t_online_api`) plus `un1t_subscriptions`. `member-validation.js` already reads `contact_memberships`, so event pricing works today.
2. `invoices`: Mia account tools (`agent/account-tools.js` gates on `capabilities.invoices`) read `un1t_invoices` / `un1t_transactions`.
3. `credits`: `un1t_clients.credit_balance` / `credit_unlimited`.
4. KPI scorecard (`shared/studio-kpis.js` reads `contacts.glofox_membership_*`) and churn radar (`glofox_invoices` PAST_DUE). Both need a un1t adapter or union, using `un1t_subscriptions.past_due_at`, `cancel_at_period_end` and `paused_*`.
5. `bookings` / `schedule`: after P1.1.

### P1.3 Dual-studio members (52 contacts)
52 linked Hatch clients are contacts whose `location_id` is another studio, which is correct (one person, one contact per organisation). But any Hatch-scoped list, audience or send that filters on `contacts.location_id = Hatch` misses them. Surfaces built on `contact_memberships.location_id` or `contact_location_preferences` don't. Audit Hatch member lists, audience filters (`applyAudienceFilter`) and the studio dashboard for the gap, and decide what "a Hatch member" means everywhere.

### P1.4 Mia at Hatch (read-only)
Once P1.2 step 2 lands, Mia can answer billing questions ("when do I renew", "what did I pay") from the `un1t_*` tables. Booking and cancelling from Mia need write access (P2.2).

---

## P2: later (triggered by evidence)

- **P2.1 Aggregator placeholder accounts.** *Trigger:* the first booking with `source` ≠ `direct`, a guest, or an external ref (0 today). Point the person-linking layer (`person_groups`, `person-detect`, the duplicates queue) at Hatch, the same pattern used for ClassPass at Stillorgan.
- **P2.2 Write-back** (book, cancel, grant credits from the CRM or Mia). Use a separate token holding only those write permissions, and give it its own spec.
- **P2.3 Push instead of poll.** If un1t.online adds outbound webhooks or `updated_since`, drop to incremental pulls.

---

## Hardening backlog (from the build reviews, all deferred as non-blocking)

| Item | Where |
|---|---|
| Managers can PATCH/DELETE the `un1t_online` registry row through the generic channels routes. Glofox has the same gap. Gate those routes per platform | `src/app/api/locations/[id]/channels/[connId]` |
| Recursive PII strip in `raw` (only top-level keys are stripped today); drop `transaction.description` | `un1t-online-map.js` |
| Tenants console omits `un1t_online` | `admin-tenants.js` `HUB_STATUS_SECTIONS` |
| A failed registry read adds "un1t.online: Unavailable" to every location's health pane | `integration-health.js` |
| Health detail hides the token-expiry text when a warning is present | `integration-health.js` |
| No guard against the cron and Sync now overlapping. A stale run's write-back is already guarded, but both runs spend the rate limit | `un1t-online-sync.js` |
| No wall-clock budget across locations (matters at 2+ studios) | `cron/un1t-online-sync/route.js` |
| Token-leak test uses a one-character token; retry and 429-exhaustion paths are untested | `un1t-online.test.js` |
| CLAUDE.md line can drop "designed to be" now that Hatch is connected | `CLAUDE.md` |

---

## Decisions needed from Richard

1. ~~**P0.1:** marketing off for sync-created contacts?~~ Decided: leave marketing on.
2. ~~**P0.2:** reissue the token as Read-only?~~ Decided: keep the current token.
3. **P0.4:** end (not delete) the 20 export rows?
4. **P1.1:** for each customer-messaging or device-switching reader, should it run for Hatch?
5. **P1.2:** which surface first? *(suggested: memberships, then invoices for Mia)*
