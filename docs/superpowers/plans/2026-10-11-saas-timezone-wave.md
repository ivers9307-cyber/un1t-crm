# SaaS Timezone Wave — Per-location timezone — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every decision the platform makes on behalf of one studio ("what day is today here", quiet hours, send windows, reminder offsets, booking wall-clock, schedules, week and month buckets, crons that act "today") is taken in that studio's own IANA timezone (`locations.timezone`). The timezone is chosen when the location is created and managed in the location's settings. UN1T, whose six locations are all `Europe/Dublin`, sees byte-identical behaviour.

**Architecture:** One canonical module lands first and everything else consumes it. `shared/zoned-time.js` is the pure, dependency-free zone maths: a zone-parameterised twin of every `dublin-time` export plus the DST-safe solver that `src/lib/tz-time.js` already proved (SHELLY.1), and it is safe on Hermes. `src/lib/location-time.js` re-exports it and adds the DB side: resolving and caching a location's zone, a batch resolver for crons, and the `PLATFORM_TZ` constant for the few decisions that legitimately stay on Dublin. The column is hardened (NOT NULL, validated against `pg_timezone_names`, client UPDATE revoked) and changes go through one route that runs a hazard preflight. Then seventeen PR-sized sweeps (TZ.4–TZ.17, with TZ.15 for SQL), grouped by area, move each consumer from `dublin*()`/`'Europe/Dublin'` to `*In(zone)`. Each sweep is test-first: a DST test in `America/New_York` plus a byte-identity test in `Europe/Dublin`. A guardrail rule with a shrinking baseline makes the sweep mechanical and stops regressions. Migrations are forward-only and applied by the orchestrator via the Supabase MCP before merge.

**Tech Stack:** Next.js 16 App Router (JavaScript), Supabase (service-role client; RLS and column GRANTs bind only the browser and phone), Zod, Vitest (4 CI shards; `process.env.TZ` set at the top of `*.tz-us.test.js` files), ESLint guardrails (`eslint.guardrails.config.mjs` + `eslint-rules/index.mjs`), Expo SDK 57 (`mobile/`, OTA via `eas-update.yml`, Hermes `Intl`), champ-app (Next.js web, `shared/` mirror).

**Source review:** `docs/SAAS_READINESS_REVIEW_2026-10-09.md`: §1 "Time zone and locale" (:60-61), §3 theme D (:304-305), "Open after Wave 1" (:284-289). Format precedent: `docs/superpowers/plans/2026-10-10-saas-wave1-identity.md`.

---

## Binding decision (Richard, 10 Oct 2026; do not reopen, do not card)

> **A location's timezone is set when the location is created and managed in that location's settings**, and every per-tenant decision that today assumes Europe/Dublin must use the location's own timezone. (Not "Ireland/UK only".) All six live locations are Europe/Dublin, so UN1T must see NO behaviour change: every task needs a test proving byte-identical output for Europe/Dublin.

What this rules out: the review's alternative of declaring v1 "Ireland/UK only" (theme D, :305) and `TenantWizard.jsx:183`'s "Ireland-only v1 (settled)" comment. Both are superseded.

**⚠️ policy for this wave.** A task is marked ⚠️ only if it changes something UN1T staff or customers can see or receive. Done as designed, **no sweep task is ⚠️**: every one ships with a Europe/Dublin byte-identity test. The plan has 23 tasks (23 un1t-crm PRs plus the champ-app legs of TZ.13 and TZ.17). Three groups are ⚠️ only because they correct live behaviour or change who can do something, and each is a separate card:
- **TZ.2 and TZ.3.** Owners stop saving the timezone straight from the browser. The field moves behind a route, so an owner sees a searchable picker and a confirm step. This changes the settings UI only.
- **TZ.6b.** Only if Richard picks option A of D6 (daily nudges at a fixed local hour instead of a fixed UTC hour). The recommended option B changes nothing for UN1T.
- **TZ.17.** Corrects zone-less server renders that print UTC during Irish summer time.


---

## Live facts (verified from the repo at `origin/main` 697f468d, 11 Oct 2026)

The DB was **not** queried while writing this plan. Every DB-side row below says what the migrations imply. The read-only SQL after the table confirms them, and the orchestrator runs it before TZ.2 and pastes the answers into the TZ.2 PR body.

| Fact | Value (source) |
|---|---|
| Latest migration | `718_tenant_email_domains_webhooks.sql`. **This wave starts at 719.** Duplicate prefixes are allowed by convention; take the next free number at execution time. |
| `locations.timezone` | `TEXT DEFAULT 'Europe/Dublin'`, **nullable, no CHECK, no trigger** (`supabase/migrations/004_auth_multi_tenant.sql:15`). No later migration alters it. It is free text: a typo is storable. |
| `locations.country` | `CHAR(2) NOT NULL DEFAULT 'IE'` + `CHECK (country ~ '^[A-Z]{2}$')` (`018_location_country.sql:12-20`). It drives bank holidays (`src/lib/bank-holidays.js`). It is independent of the timezone and stays so. |
| Live values | The review says all six locations are `IE` / `Europe/Dublin` (`docs/SAAS_READINESS_REVIEW_2026-10-09.md:38`; Wave 1 live facts, 10 Oct). **Confirm with SQL Q1.** |
| Client grants on `locations` | `authenticated` holds column SELECT incl. `timezone` and column **UPDATE incl. `timezone`** (`648_credential_column_grants.sql:149-150`). The row policy `locations_upd` admits master or the location's owner (`320_perf_consolidate_multiple_permissive_policies.sql:190`). **Today an owner changes the timezone with a direct browser UPDATE, with no validation and no hazard check** (`src/components/LocationForm.jsx:101-129`). |
| Creation | `POST /api/locations` (master only): `timezone: z.string().trim().min(1).max(64).default('Europe/Dublin')` with **no IANA validation** (`src/app/api/locations/route.js:49`), inserted at `:88`. `seedLocationDefaults` (`src/lib/location-seed.js`) does not read the zone. |
| Tenant wizard | `TenantWizard.jsx:183` ("Ireland-only v1 (settled): timezone/country use the route defaults") sends neither field. **Superseded by the binding decision.** |
| Settings form | `LocationForm.jsx:21` state, `:110` (edit payload), `:150` (create body), `:276-293`: a 12-zone `<select>` (Dublin, London, Berlin, Malta, Nicosia, Cairo, Kuwait, five Australian zones). The page is `src/app/settings/locations/[id]/page.js`; the form's Details tab owns the field. |
| User object | `timezone` is in `CLIENT_LOCATION_COLUMNS` (`src/lib/location-secrets.js:46`), so `user.activeLocation.timezone` is on every web page through `getCurrentUser`. **`/api/mobile/me` drops it** (`src/app/api/mobile/me/route.js:80-115` maps `id, name, slug, country, features, …`). |
| Existing zone-aware helpers | `src/lib/tz-time.js` (SHELLY.1: `resolveTz`, `isValidTz`, `dayStrInTz`, `wallMsInTz`, `dayStartMsInTz`, `nextLocalMidnightMs`; a two-pass solver measured at 0 errors in 12 zones, 2025-2027) with **16 importers**. `src/lib/staff-push-hours.js` (`resolveStaffTimeZone`, `inStaffPushHours`, `staffWallClockHHMM`) holds the staff quiet band. **These are "the pattern" the review means** (Shelly, checklists, push reminders, geofence, roster runway, qualification digest). TZ.1 makes `tz-time`'s maths the canonical core. |
| Private zone solvers that bypass tz-time | `src/lib/push-reminders.js:42` `localToUtc` (one pass), `src/lib/checklist-instances.js:125/139` (`parseLocalToUtcMs`, `tzOffsetMs`), `src/lib/staff-attendance.js:71` `resolveScheduledAt`, `src/lib/send-quiet-hours.js:147-190` (Dublin only), `shared/working-time.js:114-147` `dublinWallMs`, `src/lib/bridge-samples.js:644` `dublinWallClockToMs`, `src/lib/host-schedule-time.js:45/97`, `src/lib/agent/core.js:58` `minutesOfDayInTz`, `src/lib/agent/followups.js:146-153` `withinDublinDaytime`, `src/lib/agent/event-date-label.js:20`, `src/lib/ads/read.js:5` + three cron copies of `dublinDateStr`, `src/lib/class-climate.js:18-37` `slotKey`, `src/lib/hr-attribution-sweep.js:25`, `src/lib/roster-compare-format.js:43-53`. TZ.1b and the sweeps retire them. |
| `dublin-time` consumers | `src/lib/dublin-time.js` + `shared/dublin-time.js`: **135 non-test importers** across `src/`, `shared/`, `mobile/`. A literal `'Europe/Dublin'` appears on **282 lines in 148 non-test files**. Together with the tz-time importers that is **244 files; 241 excluding the three helper modules themselves; 214 of them carry 409 code sites** (the rest mention Dublin only in comments). The review's "113 files" counted only `src/lib/dublin-time` importers under `src/`. |
| SQL | **14 migration/operator files** mention `Europe/Dublin` outside comments. **Live functions/policies that pin Dublin:** `wallet_apply` (420), `rollup_usage_for_day`, `org_ai_spend_month_cents`, `org_email_sends_month` (421), `hyrox_coaches_on_shift` (448), `list_health_monthly_stats` (517), `email_sends_monthly_stats` (521), `tombstone_staff_profile` (622), the `challenges_read` RLS policy (686). Plus `whatsapp_broadcasts.send_window_tz DEFAULT 'Europe/Dublin'` (253) and `claim_shift_offer` (641), which compares wall clocks across studios. `challenge_standings` (310/347) takes instants from the caller and is zone-neutral. |
| Crons | `vercel.json` has **81 entries** (80 routes; `receipt-coverage-weekly` runs twice). Fixed-UTC-hour crons that act for a studio are listed in TZ.6. Every-N-minute crons that compute "now in window" are swept with their area. |
| Wall-clock columns (location-local, no zone stored) | `bookings.booking_date DATE` + `start_time/end_time TIME`; `shift_blocks.block_date` + `start_time/end_time`; `shift_assignments.start_time_override/end_time_override`; `race_events.race_date` + `start_time`; `race_waves.start_time`; `staff_unavailability.start_date/end_date/start_time/end_time`; `time_off_requests.start_date/end_date`; `hyrox_blocks.starts_on` + `session_weekdays`; `checklist_instances.date`; `equipment_inspections.due_on`; `sonos_schedules.windows` and `shelly_*` schedule jsonb (`HH:MM`); `company_settings.send_quiet_hours_start/end` (hours); `email_sequences` send window (`{start_hour,end_hour,skip_days}`, mig 089); Mia `settings.customer_agent.quiet_hours` (`{start,end,tz}`); `whatsapp_broadcasts.send_window_start/end` + `send_window_tz`. **Rule: each is wall clock in the owning row's location zone. Convert with `zonedWallClockToInstant(date, time, zoneOf(location))` at read time; never store an instant derived from one.** |
| Instants (timestamptz, zone-free) | `class_occurrences.starts_at/ends_at` (Glofox `time_start` is unix seconds, `src/lib/class-occurrences.js:16-23`), `class_bookings.starts_at`, `sequence_enrollments.next_step_at`, `campaigns.scheduled_at`, `whatsapp_broadcasts.scheduled_at`, `heart_rate_sessions.started_at`, `race_events.registration_opens_at/closes_at`, all `*_at`. **Rule: an instant is never re-zoned. Only its rendering and its day bucket take a zone.** |
| Calendar keys (derived day/month, stored) | `membership_snapshots.snapshot_date`, `usage_rollups_daily.day`, `wallets.period_start`, `shelly_energy_daily.day` (already `locations.timezone`, mig 562:150), push idempotency keys (`customer-notifications` period keys). **Rule: the key is computed in the owning location's zone at write time; a later zone change does not rewrite history.** |
| champ-app | `/Users/richardivers/code/champ-app` (`origin/main` 40dfcb5 at fetch): **18 non-test files** use `dublin-time`/`Europe/Dublin` (`shared/`: challenge-wrapped, challenges, coach-kudos, customer-notifications, dublin-time, format, goals, hr-analytics, month-wrapped, progress-analytics, session-history, share-card, tier-window, week-digest; `src/`: app/sessions/[id]/page.jsx, app/sessions/page.jsx, lib/claim-candidates.js, lib/load-social.js). Under the mirror rule they move in the same session as TZ.13. |
| Hermes | Nothing in `mobile/` or `shared/` calls `Intl.supportedValuesOf`, and there is no Intl polyfill. `shared/zoned-time.js` validates a zone by constructing an `Intl.DateTimeFormat` in try/catch, and builds formatters lazily. `shared/month-wrapped.js:27` and `shared/working-time.js:114` build zone formatters at module load today. |

### Read-only SQL for the orchestrator (run before TZ.2; paste the answers into the TZ.2 PR body)

```sql
-- Q1 live zone + country per location
select id, name, slug, timezone, country, active, is_host_anchor from public.locations order by name;
select coalesce(timezone,'<NULL>') as tz, count(*) from public.locations group by 1;

-- Q2 column shape, constraints, triggers
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema='public' and table_name='locations' and column_name in ('timezone','country');
select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid='public.locations'::regclass;
select tgname, pg_get_triggerdef(oid) from pg_trigger where tgrelid='public.locations'::regclass and not tgisinternal;

-- Q3 who can write the column from a client (expect authenticated: UPDATE on timezone, no table-level UPDATE)
select grantee, privilege_type, column_name from information_schema.column_privileges
 where table_schema='public' and table_name='locations' and column_name='timezone' and grantee in ('anon','authenticated');
select grantee, privilege_type from information_schema.table_privileges
 where table_schema='public' and table_name='locations' and grantee in ('anon','authenticated');

-- Q4 every live function / view / policy / default that pins Dublin
select n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where p.prokind='f' and n.nspname in ('public','private') and pg_get_functiondef(p.oid) ilike '%Europe/Dublin%' order by 1,2;
select schemaname, viewname from pg_views where schemaname='public' and definition ilike '%Europe/Dublin%';
select tablename, policyname from pg_policies
 where coalesce(qual,'') ilike '%Europe/Dublin%' or coalesce(with_check,'') ilike '%Europe/Dublin%';
select table_name, column_name, column_default from information_schema.columns
 where table_schema='public' and column_default ilike '%Europe/Dublin%';

-- Q5 the database clock and zone catalogue
show timezone;                                   -- expect UTC
select count(*) from pg_timezone_names;
select name from pg_timezone_names where name in ('Europe/Dublin','Europe/London','America/New_York','Australia/Sydney','Asia/Kolkata');

-- Q6 stored zone strings elsewhere (should all be Europe/Dublin)
select send_window_tz, count(*) from public.whatsapp_broadcasts group by 1;
select l.name, l.settings->'customer_agent'->'quiet_hours'->>'tz' as mia_tz from public.locations l;

-- Q7 future wall-clock data per location: the D2 hazard size today
select l.name,
  (select count(*) from public.bookings b where b.location_id=l.id and b.booking_date >= current_date) as future_bookings,
  (select count(*) from public.shift_blocks s where s.location_id=l.id and s.block_date >= current_date) as future_blocks,
  (select count(*) from public.race_events r where r.location_id=l.id and r.race_date >= current_date) as future_races,
  (select count(*) from public.sonos_schedules x where x.location_id=l.id) as sonos_schedules
from public.locations l order by 1;

-- Q8 any climate/Sonos fixed window with a 23:xx boundary (the SHELLY.2 class; must be 0 rows to call TZ.10 invisible)
select id, location_id, windows from public.sonos_schedules where windows::text ~ '"2[3]:[0-5][0-9]"';
```


---

## Decisions TAKEN (Richard, 11 Oct 2026, by card; these override the recommendations below)

| Card | Answer | Effect on tasks |
|---|---|---|
| D1 | **A**: any IANA zone, fixed offsets rejected | TZ.2 as written |
| D2 | **A** (NOT the recommended B): owners may change the zone **any time**, after a preflight with counts and typing the location name to confirm | TZ.3 implements option A: no "future data" refusal, no master-only force path. Wall-clock rows keep their local meaning; stored instants/keys are not rewritten; pending `next_step_at` re-clamped by the next scheduler pass; audit row + cache bust as written |
| D3 | **A**: the record's studio zone, abbreviation suffix only when it differs from the viewer's zone | TZ.14, TZ.16 as written |
| D4 | **A**: `PLATFORM_TZ = 'Europe/Dublin'` | TZ.11a, TZ.16 as written |
| D5 | **B**: platform calendar (`PLATFORM_TZ`) | **TZ.11b and mig 722 are DROPPED.** The 22 billing rows become `PLATFORM_TZ` references (in TZ.11a for JS, TZ.15 for the 42x SQL functions, which keep `Europe/Dublin` with a comment naming D5). Tenant UIs state the reset in local time |
| D6 | **B**: Dublin-zoned locations stay on the legacy UTC hour (byte-identical); other zones fire at the local target hour | TZ.6 as written; no ⚠️ |
| D7 | **A**: the member's home location zone | TZ.13, TZ.14 as written |
| D8 | **A + country-mismatch warning** | TZ.2 as written |
| TZ.17 | **Yes**: fix the ~20 UTC-day bugs in this wave (visible to UN1T only 00:00-01:00 IST) | TZ.17 as written |

Live facts confirmed by the orchestrator on 11 Oct (Q1-Q8): six locations, all `Europe/Dublin`, all `country = IE`; `locations.timezone` is `text NULL DEFAULT 'Europe/Dublin'`; `authenticated` holds column SELECT + UPDATE on it; DB clock `UTC`; 1,196 zones in `pg_timezone_names`; functions pinning Dublin: `wallet_apply`, `rollup_usage_for_day`, `org_ai_spend_month_cents`, `org_email_sends_month`, `list_health_monthly_stats`, `email_sends_monthly_stats`, `hyrox_coaches_on_shift`, `tombstone_staff_profile`; no views; policy `challenges.challenges_read`; defaults on `whatsapp_broadcasts.send_window_tz` (31 rows, all Dublin) and `locations.timezone`; Mia quiet-hours `tz` unset everywhere; 0 Sonos windows with a 23:xx boundary.

## Decisions needed from Richard (the orchestrator turns each into a card before execution)

Each is a real behavioural choice the binding decision leaves open. The recommendation is what the tasks below implement if Richard takes it. A task that depends on a card says so in its header, and **no task that depends on an unanswered card merges**.

**D1. Which zones may a location use?** (TZ.2)
- A. Any IANA zone, validated in the app (`Intl`) and in the DB (`pg_timezone_names`). Fixed offsets (`+05:30`, `Etc/GMT-5`) are rejected because they have no DST. The picker is searchable and lists the common zones first.
- B. A curated list, as today (`LocationForm.jsx:276-293`: 12 zones). It grows by a code change.
- C. Ireland/UK only (`Europe/Dublin`, `Europe/London`).
- **Recommend A.** The binding decision rules out C. B makes every new market a deploy. A costs nothing more, because the validator is the same one the code needs anyway.

**D2. Can a location's timezone change after go-live, and what happens to existing data?** (TZ.3)
Hazards found:
- (1) Wall-clock rows: `bookings`, `shift_blocks` and assignments overrides, `race_events`/`race_waves`, `staff_unavailability`, `hyrox_blocks`, Sonos/Shelly windows, quiet hours, the sequence send window, Mia quiet hours, and `whatsapp_broadcasts.send_window_tz`, which carries its OWN zone copy.
- (2) Instants already computed from the old zone and stored: `sequence_enrollments.next_step_at` (clamped to the old send window), `class_bookings.starts_at` (comes from Glofox, so it is unaffected), `checklist_instances.deadline_at`, `equipment_inspections.due_on`, and push idempotency keys.
- (3) Calendar keys already written: `membership_snapshots.snapshot_date`, `usage_rollups_daily.day`, `shelly_energy_daily.day`, `wallets.period_start`.
- (4) Caches: the TZ.1 resolver's 60 s TTL.

Options:
- A. Allowed any time. Wall-clock rows keep their LOCAL meaning (a 09:00 class stays 09:00 in the new zone). Stored instants and keys are not rewritten. Pending `next_step_at` values are re-clamped by the next scheduler pass. A preflight shows the counts, and the owner types the location name to confirm.
- B. Allowed only while the location has no future wall-clock data (no future bookings, shift blocks, races or enrolments pending). Otherwise the change is refused with the counts. Master can force it, with A's semantics.
- C. Master only, through support. Owners never change it.
- D. Frozen once set at creation.
- **Recommend B.** It keeps the real hazard (a studio with live bookings silently shifting its customers' reminders) behind master, while a studio being set up can still fix a wrong pick. A's semantics are the right ones whenever a change does happen. They are also the only ones that need no data migration.

**D3. Which zone do staff see times in when they view a studio's records?** (TZ.16, TZ.14)
- A. Always the record's studio zone. When it differs from the viewer's device zone, the zone abbreviation is appended ("09:00 EST").
- B. The viewer's device or browser zone.
- C. The viewer's active-location zone, for every record.
- **Recommend A.** A class at 09:00 in New York is "09:00" to everyone who runs it. For Dublin staff looking at Dublin studios nothing changes: no suffix, same text.

**D4. What zone do platform-level reports and ops digests use** (master-only consoles, cross-tenant canaries, platform heartbeats, the HR attribution sweep, the audit log)? (TZ.11a, TZ.16)
- A. Stay `Europe/Dublin` (the platform operator's zone), through the `PLATFORM_TZ` constant, so the choice is visible and greppable.
- B. UTC.
- C. Each recipient's location zone.
- **Recommend A.** These are Richard's own tools. UTC would make every one of them read an hour off in summer.

**D5. Wallet, plan, usage-cap and usage-rollup month and day: the tenant's local calendar, or the platform's?** (TZ.11b, TZ.15 functions from migs 420/421)
- A. Tenant-local. Each location's AI and email caps, wallet period and daily rollup turn over at its own midnight. This needs `wallet_apply`, `rollup_usage_for_day`, `org_ai_spend_month_cents` and `org_email_sends_month` rewritten per location, plus 13 JS files (Appendix TZ.11b).
- B. The platform calendar (`Europe/Dublin`, `PLATFORM_TZ`). One ledger. VAT invoices are issued by an Irish entity (`wallet-topup.js:395`). Tenant UIs say "resets on the 1st, 00:00 Irish time" in the tenant's own local time.
- C. UTC for the platform ledger.
- **Recommend B.** The wallet is the platform's billing relationship with the tenant, not a decision the platform makes inside the tenant's business. The review listed "wallet/usage month" under theme D, and B answers it explicitly rather than by omission. If Richard picks A, TZ.11b and the two 42x SQL functions run. If B, those 22 rows become `PLATFORM_TZ` constants and nothing else changes.

**D6. Daily crons that act at a fixed UTC hour on a studio's behalf** (`notify-winback` 10:00, `notify-onboarding-pace` 10:30, `notify-streak-at-risk` 11:00, `run-challenge-events` 08:00, `event-reminders` 09:00, `contract-reminders` 08:00, `equipment-inspection-reminder` 06:00, `equipment-inspection-sweep` 19:00, `morning-briefing` Mon 06:00, `churn-radar-digest` Mon 07:00, `ad-report-email` 07:00, `run-scheduled-reports` 07:00, `receipt-coverage-weekly` Fri 07:00 and 08:00). (TZ.6)
- A. Every one runs hourly and acts for a location when the location's LOCAL hour equals the target. ⚠️ For UN1T the nudges then land at the same local hour all year: during Irish summer time that is one hour earlier than today.
- B. Every one runs hourly. A location whose zone is `Europe/Dublin` stays anchored to the legacy UTC hour (byte-identical for UN1T). Every other zone acts at the target LOCAL hour. Switching UN1T to local anchoring later is its own ⚠️ card.
- C. Leave them on the fixed UTC hour for everyone. A Sydney studio gets its 10:00 UTC winback at 21:00 local.
- **Recommend B.** It is the only option that honours both halves of the binding decision. Each converted cron keeps a per-location, per-local-day claim, so an hourly schedule can never send twice. The `cron_heartbeats` row moves to `expected_interval_seconds = 3600` in the same migration.

**D7. A member's zone** (streaks, challenges, goals, weekly digests, month wrapped, member push idempotency keys, the countdown on the phone's Home tab). (TZ.13, TZ.14)
- A. The member's home location (`contacts.location_id`).
- B. The phone's device zone.
- C. `Europe/Dublin` platform-wide until a champ-app rework.
- **Recommend A.** The member trains at a studio, and the challenge windows are already that studio's (`challenges.location_id`). B splits one member's streak between two clocks when they travel. C fails the binding decision.

**D8. Default and prompt when creating a location.** (TZ.2)
- A. The wizard and `/settings/locations/new` REQUIRE a choice, pre-filled from the creating browser's zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) and shown next to the country.
- B. Pre-filled from the country (IE→Dublin, GB→London, …). Countries with more than one zone (AU, US) must choose.
- C. Default `Europe/Dublin` silently (today's behaviour).
- **Recommend A, with B's country hint as a warning** ("Country is AU but the timezone is Europe/Dublin: is that right?"). Master creates locations today, usually from Dublin, so A alone would pre-fill Dublin for a Sydney gym. The mismatch warning catches that.


---

## PR ritual (every task ends with this; as Waves 0 and 1)

Repo conventions:
- A fresh worktree for every task; never share one. Never `git stash` in a worktree.
- One changelog file per PR.
- CI runs the required checks `Test & lint` and `Next build`, with 4 vitest shards (~5 min).
- Quote `[id]`/`[slug]` paths with single quotes in zsh.
- **Never run the whole vitest suite locally on this 8 GB machine.** Run targeted files with `--maxWorkers=2`, plus the `check:*` gates.
- **The scratchpad is shared between parallel tasks: name every scratch file `tz-<task>-…`** (e.g. `tz-4-pr-body.md`), never a bare `pr-body.md`.

```bash
# 1. Fresh worktree from main (never cd into /Users/richardivers/code/un1t-crm itself)
git -C /Users/richardivers/code/un1t-crm-w1plan fetch origin main -q
git -C /Users/richardivers/code/un1t-crm-w1plan worktree add -q /Users/richardivers/code/un1t-crm-tz-<slug> -b tz-<slug> origin/main
cd /Users/richardivers/code/un1t-crm-tz-<slug> && npm ci --silent
# 2. ... task steps (test first, then code) ...
# 3. Gates that run locally in seconds
npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns && npm run check:guardrails
npm run check:ota-paths && npm run check:mobile-imports   # when shared/ or mobile/ changed
npx vitest run --maxWorkers=2 <changed test files> tests/changelog-entries.test.js tests/shared-pair-sync.test.js tests/dublin-zone-baseline.test.js
# 4. PR (body file named per task; body ends with the 🤖 line)
git push -u origin tz-<slug>
gh pr create --base main --title "TZ.<n> <title>" --body-file "$SCRATCH/tz-<n>-pr-body.md"
# 5. Changelog entry AFTER the PR number exists: ONE file, ONE row
printf '| #%s | TZ.<n> — <title> | %s. <what and why> |\n' "$PR" "$(date +%F)" > docs/changelog/entries/$PR.md
git add docs/changelog/entries/$PR.md && git commit -m "TZ.<n> — changelog entry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && git push
# 6. Migration (if any): the ORCHESTRATOR applies it via Supabase MCP apply_migration on
#    iyvtbjjxdggiadzwwvdj BEFORE merge, then get_advisors(type=security), then re-runs the task's verify SQL.
# 7. ⚠️ tasks: the orchestrator shows Richard the card and waits. Others: CI green, self-review the diff once more.
gh pr update-branch $PR && gh pr checks $PR --watch && gh pr merge $PR --squash --auto --delete-branch
# 8. OTA tasks (shared/** or mobile/** bundle paths): before merging, `eas update:list` shows no 1–99% group
#    on the runtime lane (mobile/docs/ota-rollout.md). A merge PUBLISHES at 100%.
# 9. Remove the worktree
git -C /Users/richardivers/code/un1t-crm-w1plan worktree remove /Users/richardivers/code/un1t-crm-tz-<slug>
```

Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Every PR body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. champ-app legs (TZ.13) run the same ritual in `/Users/richardivers/code/champ-app` (worktree `champ-app-tz-<slug>`, remote `ivers9307-cyber/champ-app`). champ-app has no changelog-entries convention, so the PR body carries the row.

### The two tests every sweep task writes first

Every sweep PR (TZ.4–TZ.16) starts with the same two tests for the functions it changes, then code. Place them next to the module (`<module>.tz.test.js`, the house pattern of `report-generator.period.tz-us.test.js`):

```js
// <module>.tz.test.js — TZ.<n>
process.env.TZ = 'America/Los_Angeles'   // host zone is neither of the zones under test: proves nothing reads the host clock
import { describe, it, expect } from 'vitest'
const M = await import('./<module>.js')

const NY = 'America/New_York'
// US DST 2026: spring forward Sun 8 Mar 02:00 → 03:00; fall back Sun 1 Nov 02:00 → 01:00.
// EU DST 2026: spring forward Sun 29 Mar 01:00 UTC; fall back Sun 25 Oct 01:00 UTC.
const SAMPLES = [
  '2026-03-07T04:30:00Z', '2026-03-08T06:59:00Z', '2026-03-08T07:00:00Z', // NY around spring-forward
  '2026-03-28T23:30:00Z', '2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', // Dublin around spring-forward
  '2026-10-24T23:30:00Z', '2026-10-25T00:59:00Z', '2026-10-25T01:00:00Z', // Dublin around fall-back
  '2026-11-01T04:59:00Z', '2026-11-01T05:00:00Z', '2026-11-01T06:00:00Z', // NY around fall-back
  '2026-06-30T22:59:00Z', '2026-06-30T23:00:00Z', '2026-12-31T23:30:00Z', // month/year edges
]

describe('TZ.<n> Europe/Dublin is byte-identical', () => {
  // `legacy` is the pre-change function, kept for this test only as
  // `<fn>LegacyDublin` (exported from the test helpers, deleted by TZ.18b).
  it.each(SAMPLES)('%s', (iso) => {
    expect(M.<fn>({ ...ARGS, nowMs: Date.parse(iso), zone: 'Europe/Dublin' }))
      .toStrictEqual(LEGACY.<fn>({ ...ARGS, nowMs: Date.parse(iso) }))
  })
})

describe('TZ.<n> America/New_York follows New York across DST', () => {
  it('the local day flips at New York midnight, not Dublin midnight', () => { /* task-specific expectation */ })
  it('a 09:00 wall clock is 13:00Z in summer and 14:00Z in winter', () => { /* task-specific */ })
})
```

How each sweep keeps `LEGACY`: before editing, the task copies the function's current body into `<module>.legacy-dublin.test-helpers.js`, unchanged. The byte-identity test diffs the new code against that frozen copy over the samples above, plus every Dublin day of 2026 where the function takes a date. **TZ.18b deletes the legacy helpers once the whole wave is merged.**


---

## Task map, order and migrations

| # | Task | Depends on | Migration | Card | OTA | ⚠️ |
|---|---|---|---|---|---|---|
| TZ.1 | Canonical helper: `shared/zoned-time.js` + `src/lib/location-time.js`; `tz-time.js` becomes a shim | — | — | — | yes (new `shared/` file: no-op publish) | no |
| TZ.18a | Guard rule `no-hardcoded-dublin-zone` with a shrinking baseline | TZ.1 | — | — | no | no |
| TZ.1b | Retire the private solvers (`push-reminders`, `checklist-instances`, `staff-attendance`) | TZ.1 | — | — | no | no |
| TZ.2 | Column hardened; creation and settings choose the zone; client UPDATE revoked | TZ.1 | **719** `locations_timezone_hardening` | D1, D8 | no | ⚠️ settings UI only (owners save the zone through a route) |
| TZ.3 | Changing a timezone: preflight route, rule per D2, audit, cache bust | TZ.2 | — | D2 | no | ⚠️ settings UI only |
| TZ.4 | Sequences, send quiet hours, drip broadcasts | TZ.1 | — | — | no | no |
| TZ.5 | Mia, staff assistant, WhatsApp Flow, cancellation form | TZ.1 | — | — | no | no |
| TZ.6 | Daily-slot gate; fixed-UTC crons act per location | TZ.1 | **720** `cron_heartbeats_hourly_daily_slots` | D6 | no | no if D6=B (⚠️ if D6=A) |
| TZ.7 | Bookings and classes | TZ.1 | — | — | no | no |
| TZ.8a | Rostering, shifts, swaps, availability, staff push | TZ.1, TZ.1b | — | — | yes (`shared/working-time.js`) | no |
| TZ.8b | Time off, attendance, contracts, equipment, qualifications, checklists | TZ.1, TZ.1b | — | — | no | no |
| TZ.9 | Events, races, hyrox, host | TZ.1 | — | — | yes (`shared/events.js`) | no |
| TZ.10 | Climate, Sonos, Shelly, AC | TZ.1 | — | — | no | no |
| TZ.11a | Reports, dashboards, briefings, snapshots, cars | TZ.1 | — | D4 | yes (`shared/dashboard-data.js`) | no |
| TZ.11b | Billing month per tenant | TZ.1, TZ.15 | **722** (only if D5=A) | D5 | no | no |
| TZ.11c | External zones: Meta ad account, Xero | TZ.1 | — | — | no | no |
| TZ.12 | TV and live boards | TZ.1 | — | — | no | no |
| TZ.13 | Member seam (`shared/` + `src/lib` twins) + champ-app mirror | TZ.1 | — | D7 | yes | no |
| TZ.14 | Mobile screens + `/api/mobile/me` carries `timezone` | TZ.1, TZ.13 | — | D3, D7 | yes | no |
| TZ.15 | SQL functions, policies, column comments | TZ.2 (`private.location_tz`) | **721** `zone_aware_sql_functions` | D5 (two 421 functions) | no | no |
| TZ.16 | Web display-only sweep | TZ.1 | — | D3 | no | no |
| TZ.17 | ⚠️ Midnight-hour corrections and zone-less server renders | TZ.1 | — | — | yes (`mobile/app/(member)/(tabs)/home.jsx`, `shared/progress-analytics.js`) | **⚠️** |
| TZ.18b | Guard final: baseline empty, legacy test helpers deleted, `dublin-time` imports banned outright | all above | — | — | no | no |

**Order.** TZ.1 lands first. TZ.18a lands straight after it: from then on each sweep's first step is "remove my files from the baseline → lint fails". TZ.2 and TZ.3 run in parallel with the sweeps. The sweeps are independent of each other except TZ.14 after TZ.13 (the phone imports the shared signatures) and TZ.11b after TZ.15. Merge OTA tasks one at a time (TZ.1, TZ.8a, TZ.9, TZ.11a, TZ.13, TZ.14, TZ.17), never two inside one ramp.

**Status (11 Oct 2026):** every task merged except TZ.18b. TZ.1 #2018 · TZ.18a #2019 · TZ.1b #2020 · TZ.2 #2021 · TZ.7 #2024 · TZ.4 #2025 · TZ.5 #2026 · TZ.3 #2027 · TZ.10 #2028 · TZ.12 #2030 · TZ.9 #2031 · TZ.6 #2032 · TZ.11c #2033 · TZ.8a #2034 · TZ.11a #2035 · TZ.15 #2036 · TZ.13 #2037 · TZ.16 #2038 · TZ.14 #2039 · TZ.8b #2040 · TZ.17 #2041 · TZ.18b #2042 (open). TZ.11b dropped (D5 = B).

**Migrations in prefix order:** 719 (TZ.2), 720 (TZ.6), 721 (TZ.15), 722 (TZ.11b, conditional). All are forward-only. The orchestrator applies each via `apply_migration` on `iyvtbjjxdggiadzwwvdj` BEFORE its PR merges, then runs `get_advisors(type=security)` and the task's verify SQL. If a concurrent PR takes a number first, take the next free one; duplicate prefixes are allowed by convention.

## File structure (what changes where)

| Task | Files |
|---|---|
| TZ.1 | new `shared/zoned-time.js` (+`shared/zoned-time.test.js`, `shared/zoned-time.parity.test.js`); new `src/lib/location-time.js` (+test); `src/lib/tz-time.js` (shim onto `@shared/zoned-time`; its existing test stays green unchanged) |
| TZ.18a | `eslint-rules/index.mjs` (rule), `tests/guardrails-rules.test.js` (cases), `eslint.guardrails.config.mjs` (block), new `eslint-rules/dublin-zone-baseline.json`, new `tests/dublin-zone-baseline.test.js` |
| TZ.1b | `src/lib/push-reminders.js`, `src/lib/checklist-instances.js`, `src/lib/staff-attendance.js` (+ their tests) |
| TZ.2 | mig 719; `src/app/api/locations/route.js` (+test); new `src/lib/timezone-options.js` (+test); `src/components/LocationForm.jsx`; new `src/components/settings/TimezoneSelect.jsx` (+test); `src/components/admin/TenantWizard.jsx` (+test); `tests/helpers/credential-column-grants.js`; `src/lib/openapi.js` |
| TZ.3 | new `src/app/api/locations/[id]/timezone/route.js` (+test); new `src/lib/timezone-change.js` (+test); `src/components/LocationForm.jsx`; `src/lib/openapi.js` |
| TZ.4–TZ.17 | per Appendix A (one section per task: every file:line, its current behaviour, class and target rule) |
| TZ.6 | + `vercel.json`, mig 720 |
| TZ.15 | mig 721 (and 722 if D5=A) |
| TZ.18b | `eslint.guardrails.config.mjs`, `eslint-rules/dublin-zone-baseline.json` (deleted), `tests/dublin-zone-baseline.test.js`, every `*.legacy-dublin.test-helpers.js` (deleted), `CLAUDE.md` "Timezones" bullet |

---

## Track 0 — The canonical helper

### Task TZ.1: `shared/zoned-time.js` + `src/lib/location-time.js` (the one place zone maths lives)

**Why:** 409 code sites use `dublin*()` or the literal. The proven solver (`src/lib/tz-time.js`, SHELLY.1) lives in `src/lib`, so the phone and `shared/` cannot import it. And it has no twin for half of `dublin-time`'s exports (week keys, month starts, ranges, labels). This task builds the one module every later task consumes. It is a **drop-in for each `dublin*` export**: same inputs and edge behaviour, plus a `zone` argument, and byte-identical for `Europe/Dublin`.

**Files:**
- Create: `shared/zoned-time.js`
- Create: `shared/zoned-time.test.js` (DST behaviour in five zones)
- Create: `shared/zoned-time.parity.test.js` (Europe/Dublin byte-identity against `shared/dublin-time.js` + `src/lib/dublin-time.js`)
- Create: `src/lib/location-time.js`, `src/lib/location-time.test.js`
- Modify: `src/lib/tz-time.js` (whole file becomes a shim, below)

**Name map (the sweep uses this table verbatim):**

| `dublin-time` (today) | `zoned-time` (zone last, defaulting to `DEFAULT_TZ`) |
|---|---|
| `dublinDayStr(instant)` | `dayStrIn(instant, zone)` |
| `dublinTodayStr()` | `todayStrIn(zone, nowMs?)` |
| `dublinMonthStr(instant)` | `monthStrIn(instant, zone)` |
| `dublinNowMinutes()` | `nowMinutesIn(zone, nowMs?)` |
| `dublinTimeLabel(iso)` | `timeLabelIn(iso, zone)` |
| `dublinDateKey(x)` | `dateKeyIn(x, zone)` |
| `dublinDayStartMs(date)` | `dayStartMsIn(date, zone)` |
| `dublinDayRangeMs(a, b)` | `dayRangeMsIn(a, b, zone)` |
| `dublinAddDays(key, n)` | `addDaysIn(key, n, zone)` |
| `dublinIsoWeekKey(x)` | `isoWeekKeyIn(x, zone)` |
| `dublinMonthKey(x)` | `monthKeyIn(x, zone)` |
| `dublinWeekStartMs(x)` | `weekStartMsIn(x, zone)` |
| `dublinMonthStartMs(x)` | `monthStartMsIn(x, zone)` |
| `addDaysISO(d, n)` | `addDaysISO(d, n)` (re-exported, zone-free) |
| `DUBLIN_DAY_MS` | `DAY_MS` |
| `tz-time` `wallMsInTz(d, hhmm, tz)` | `zonedWallClockToInstant(d, time, zone)` (also accepts `HH:MM:SS`) |
| `tz-time` `dayStrInTz` / `dayStartMsInTz` / `nextLocalMidnightMs` / `resolveTz` / `isValidTz` | `strictDayStrIn` / `strictDayStartMsIn` / `nextLocalMidnightMs` / `resolveZone` / `isValidZone` |
| new | `instantToZonedParts(instant, zone)` → `{ y, mo, d, h, mi, s, weekday (1=Mon…7=Sun), dateKey, minuteOfDay }` |
| new | `formatInZone(instant, zone, intlOptions, locale = 'en-IE')` |
| new | `resolveZoneWithFallback(tz)` → `{ zone, fallback }` (`fallback` true only for a non-null invalid value; replaces `resolveStaffTimeZone`'s `warn`) |
| new | `PLATFORM_TZ` (= `'Europe/Dublin'`, for class-c decisions), `DEFAULT_TZ` (= `PLATFORM_TZ`, the floor for a NULL column) |

- [ ] **Step 1: Write the failing parity test** (`shared/zoned-time.parity.test.js`). It is the contract that makes every later task safe:

```js
// TZ.1 — every zoned-time twin is byte-identical to its dublin-time original
// for Europe/Dublin, over every hour of 2025-2027 and every calendar day.
process.env.TZ = 'America/Los_Angeles' // the host zone must not matter
import { describe, it, expect, vi } from 'vitest'
const Z = await import('./zoned-time.js')
const S = await import('./dublin-time.js')
const W = await import('../src/lib/dublin-time.js')
const D = 'Europe/Dublin'

const HOURS = []
for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2028, 0, 1); t += 3600_000) HOURS.push(t)
// plus every DST-edge minute in Dublin 2025-2027
for (const edge of ['2025-03-30T01:00:00Z', '2025-10-26T01:00:00Z', '2026-03-29T01:00:00Z',
  '2026-10-25T01:00:00Z', '2027-03-28T01:00:00Z', '2027-10-31T01:00:00Z']) {
  for (let m = -90; m <= 90; m++) HOURS.push(Date.parse(edge) + m * 60_000)
}
const DAYS = []
for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2028, 0, 1); t += 86_400_000) DAYS.push(new Date(t).toISOString().slice(0, 10))
const ODD_INPUTS = [null, 0, '2026-07-01T23:30:00+01:00', new Date('2026-10-25T00:30:00Z'), '2026-02-30', 'not a date']

const same = (a, b) => {
  let ea, eb, ra, rb
  try { ra = a() } catch (e) { ea = e.constructor.name }
  try { rb = b() } catch (e) { eb = e.constructor.name }
  expect(ea).toBe(eb)
  expect(ra).toStrictEqual(rb)
}

describe('instant → key twins', () => {
  it('dayStrIn ≡ dublinDayStr', () => { for (const t of [...HOURS, ...ODD_INPUTS]) same(() => Z.dayStrIn(t, D), () => W.dublinDayStr(t)) })
  it('dateKeyIn ≡ dublinDateKey (both copies)', () => {
    for (const t of [...HOURS, ...ODD_INPUTS]) { same(() => Z.dateKeyIn(t, D), () => S.dublinDateKey(t)); same(() => Z.dateKeyIn(t, D), () => W.dublinDateKey(t)) }
  })
  it('monthStrIn ≡ dublinMonthStr, monthKeyIn ≡ dublinMonthKey', () => {
    for (const t of HOURS) { same(() => Z.monthStrIn(t, D), () => W.dublinMonthStr(t)); same(() => Z.monthKeyIn(t, D), () => S.dublinMonthKey(t)) }
  })
  it('isoWeekKeyIn ≡ dublinIsoWeekKey', () => { for (const t of HOURS) same(() => Z.isoWeekKeyIn(t, D), () => S.dublinIsoWeekKey(t)) })
  it('weekStartMsIn ≡ dublinWeekStartMs, monthStartMsIn ≡ dublinMonthStartMs', () => {
    for (const t of HOURS) { same(() => Z.weekStartMsIn(t, D), () => S.dublinWeekStartMs(t)); same(() => Z.monthStartMsIn(t, D), () => S.dublinMonthStartMs(t)) }
  })
  it('timeLabelIn ≡ dublinTimeLabel', () => {
    for (const t of HOURS) same(() => Z.timeLabelIn(new Date(t).toISOString(), D), () => W.dublinTimeLabel(new Date(t).toISOString()))
    for (const v of [null, '', 'garbage']) same(() => Z.timeLabelIn(v, D), () => W.dublinTimeLabel(v))
  })
  it('nowMinutesIn ≡ dublinNowMinutes at every sampled instant', () => {
    vi.useFakeTimers()
    for (const t of HOURS) {
      vi.setSystemTime(t)
      same(() => Z.nowMinutesIn(D), () => W.dublinNowMinutes())
    }
    vi.useRealTimers()
  })
})

describe('day → instant twins', () => {
  it('dayStartMsIn ≡ dublinDayStartMs (string and parts input, incl. rollover dates)', () => {
    for (const d of [...DAYS, '2026-02-30', '2026-13-01']) { same(() => Z.dayStartMsIn(d, D), () => S.dublinDayStartMs(d)); same(() => Z.dayStartMsIn(d, D), () => W.dublinDayStartMs(d)) }
    same(() => Z.dayStartMsIn({ y: 2026, mo: 10, d: 25 }, D), () => S.dublinDayStartMs({ y: 2026, mo: 10, d: 25 }))
  })
  it('dayRangeMsIn ≡ dublinDayRangeMs, addDaysIn ≡ dublinAddDays', () => {
    for (const d of DAYS) {
      same(() => Z.dayRangeMsIn(d, d, D), () => S.dublinDayRangeMs(d, d))
      for (const n of [-400, -7, -1, 1, 7, 31]) same(() => Z.addDaysIn(d, n, D), () => S.dublinAddDays(d, n))
    }
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --maxWorkers=2 shared/zoned-time.parity.test.js`
Expected: FAIL with `Cannot find module './zoned-time.js'`.

- [ ] **Step 3: Write `shared/zoned-time.js`**

```js
// shared/zoned-time.js — TZ.1. THE zone maths for web, server, phone and champ-app.
// Pure: no IO, no imports, no host-zone reads. Safe on Hermes (never calls
// Intl.supportedValuesOf unguarded; builds every formatter lazily, so importing
// this module can never throw on a build without full ICU).
//
// Contract:
//   • every `*In(…, zone)` is a DROP-IN for the dublin-time export of the same
//     shape (same inputs, same edge behaviour incl. what throws) and is
//     byte-identical to it for Europe/Dublin (shared/zoned-time.parity.test.js).
//   • the wall-clock solver is tz-time's (SHELLY.1): two correction passes,
//     0 errors in 12 zones 2025-2027. GAP (spring forward): a nonexistent
//     wall-clock resolves EARLIER, except a day START, which resolves LATER (the
//     first instant of the day). OVERLAP (fall back): one deterministic instant.
//   • `zone` is an IANA name. Callers resolve a location's column through
//     resolveZone()/getLocationZone() first; a raw invalid string reaching a
//     formatter throws RangeError, as Intl does.

export const PLATFORM_TZ = 'Europe/Dublin'
export const DEFAULT_TZ = PLATFORM_TZ
export const DAY_MS = 24 * 3600 * 1000

// ── zone validation ────────────────────────────────────────────────────────
// Fixed offsets have no DST, so accepting one is silently an hour wrong for half
// the year: rejected by shape before Intl ever sees them.
const FIXED_OFFSET = /^(?:[+-]\d|(?:Etc\/)?GMT[+-]\d|UTC[+-]\d)/i
let _supported // undefined = not built; null = runtime has no supportedValuesOf (Hermes)
function supportedZones() {
  if (_supported === undefined) {
    _supported = typeof Intl.supportedValuesOf === 'function' ? new Set(Intl.supportedValuesOf('timeZone')) : null
  }
  return _supported
}
const _canon = new Map() // lower-cased input → canonical name (positive results only)
export function canonicalZone(tz) {
  if (typeof tz !== 'string') return null
  const raw = tz.trim()
  if (!raw || raw.length > 64 || FIXED_OFFSET.test(raw)) return null
  const key = raw.toLowerCase()
  const hit = _canon.get(key)
  if (hit !== undefined) return hit
  let canon
  try { canon = new Intl.DateTimeFormat('en-GB', { timeZone: raw }).resolvedOptions().timeZone } catch { return null }
  if (!canon || FIXED_OFFSET.test(canon)) return null
  const list = supportedZones()
  if (list && canon !== 'UTC' && !list.has(canon)) return null
  _canon.set(key, canon)
  return canon
}
export const isValidZone = (tz) => canonicalZone(tz) !== null
export const resolveZone = (tz) => canonicalZone(tz) ?? DEFAULT_TZ
export function resolveZoneWithFallback(tz) {
  const canon = canonicalZone(tz)
  return canon ? { zone: canon, fallback: false } : { zone: DEFAULT_TZ, fallback: tz != null }
}

// ── formatter caches (lazy: nothing is built at import) ─────────────────────
const _fmts = new Map()
function fmt(kind, zone, locale, opts) {
  const k = `${kind}|${locale}|${zone}`
  let f = _fmts.get(k)
  if (!f) { f = new Intl.DateTimeFormat(locale, { ...opts, timeZone: zone }); _fmts.set(k, f) }
  return f
}
const dayFmt = (z) => fmt('day', z, 'sv-SE', { year: 'numeric', month: '2-digit', day: '2-digit' })    // = dublinDayStr
const keyFmt = (z) => fmt('key', z, 'en-CA', {})                                                       // = dublinDateKey
const hmFmt = (z) => fmt('hm', z, 'en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })      // = dublinNowMinutes / dublinTimeLabel
const partsFmt = (z) => fmt('parts', z, 'en-GB', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  weekday: 'short', hourCycle: 'h23',
})
const WEEKDAY = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }

// ── instant → parts / keys ─────────────────────────────────────────────────
export function instantToZonedParts(instant, zone = DEFAULT_TZ) {
  const ms = instant instanceof Date ? instant.getTime() : (typeof instant === 'string' ? Date.parse(instant) : instant)
  const p = {}
  for (const { type, value } of partsFmt(zone).formatToParts(new Date(ms))) p[type] = value
  const h = p.hour === '24' ? 0 : Number(p.hour)
  const out = { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h, mi: Number(p.minute), s: Number(p.second), weekday: WEEKDAY[p.weekday] }
  out.dateKey = `${p.year}-${p.month}-${p.day}`
  out.minuteOfDay = h * 60 + out.mi
  return out
}
export function dayStrIn(instant = Date.now(), zone = DEFAULT_TZ) {
  return dayFmt(zone).format(instant instanceof Date ? instant : new Date(instant))
}
export const todayStrIn = (zone = DEFAULT_TZ, nowMs = Date.now()) => dayStrIn(new Date(nowMs), zone)
export const monthStrIn = (instant = Date.now(), zone = DEFAULT_TZ) => dayStrIn(instant, zone).slice(0, 7)
export function nowMinutesIn(zone = DEFAULT_TZ, nowMs = Date.now()) {
  const parts = hmFmt(zone).formatToParts(new Date(nowMs))
  return Number(parts.find((x) => x.type === 'hour').value) * 60 + Number(parts.find((x) => x.type === 'minute').value)
}
export function timeLabelIn(iso, zone = DEFAULT_TZ) {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return null
  return hmFmt(zone).format(new Date(t))
}
export const dateKeyIn = (isoOrMs, zone = DEFAULT_TZ) => keyFmt(zone).format(new Date(isoOrMs))
export const monthKeyIn = (isoOrMs, zone = DEFAULT_TZ) => dateKeyIn(isoOrMs, zone).slice(0, 7)
export function formatInZone(instant, zone = DEFAULT_TZ, options = {}, locale = 'en-IE') {
  const k = `fmt|${locale}|${zone}|${JSON.stringify(options)}`
  let f = _fmts.get(k)
  if (!f) { f = new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }); _fmts.set(k, f) }
  return f.format(instant instanceof Date ? instant : new Date(instant))
}

// ── the solver (tz-time's, verbatim in behaviour) ──────────────────────────
function naiveWallMs(ms, zone) {
  const p = instantToZonedParts(ms, zone)
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi)
}
const offsetMsAt = (ms, zone) => naiveWallMs(ms, zone) - Math.floor(ms / 60_000) * 60_000
function solveWallMs(want, zone, gapPrefer) {
  const ms1 = want - offsetMsAt(want, zone)
  const ms2 = want - offsetMsAt(ms1, zone)
  if (ms1 === ms2) return ms1
  if (naiveWallMs(ms2, zone) === want) return ms2
  return gapPrefer === 'later' ? Math.max(ms1, ms2) : Math.min(ms1, ms2)
}
function parseYmd(dateStr) {
  const m = String(dateStr ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const back = new Date(Date.UTC(y, mo - 1, d))
  if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== mo || back.getUTCDate() !== d) return null
  return { y, mo, d }
}

// Wall clock 'HH:MM' or 'HH:MM:SS' (a Postgres TIME) on a calendar date in `zone`
// → UTC ms. null for a malformed or nonexistent date/time: callers skip, never roll over.
export function zonedWallClockToInstant(dateStr, time, zone = DEFAULT_TZ) {
  const t = String(time ?? '').match(/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/)
  if (!t) return null
  const ymd = parseYmd(dateStr)
  if (!ymd) return null
  const want = Date.UTC(ymd.y, ymd.mo - 1, ymd.d, Number(t[1]), Number(t[2]))
  return solveWallMs(want, zone, 'earlier') + Number(t[3] || 0) * 1000
}

// DROP-IN for dublinDayStartMs: same lenient parse (a rollover date rolls over, as
// Date.UTC does), same {y,mo,d} input. Strict callers use strictDayStartMsIn.
export function dayStartMsIn(date, zone = DEFAULT_TZ) {
  let y, mo, d
  if (typeof date === 'string') [y, mo, d] = date.split('-').map(Number)
  else ({ y, mo, d } = date)
  return solveWallMs(Date.UTC(y, mo - 1, d, 0, 0, 0), zone, 'later')
}
export function strictDayStartMsIn(dateStr, zone = DEFAULT_TZ) {
  const ymd = parseYmd(dateStr)
  return ymd ? solveWallMs(Date.UTC(ymd.y, ymd.mo - 1, ymd.d, 0, 0), zone, 'later') : null
}
export function strictDayStrIn(instant = Date.now(), zone = DEFAULT_TZ) {
  let ms
  if (instant instanceof Date) ms = instant.getTime()
  else if (typeof instant === 'number') ms = instant
  else if (typeof instant === 'string' && instant.trim()) ms = Date.parse(instant)
  else ms = NaN
  if (!Number.isFinite(ms)) throw new RangeError('strictDayStrIn: invalid instant')
  return instantToZonedParts(ms, zone).dateKey
}
export function addDaysIn(dateKey, n, zone = DEFAULT_TZ) {
  return dateKeyIn(dayStartMsIn(dateKey, zone) + 12 * 3600 * 1000 + n * DAY_MS, zone)
}
export function dayRangeMsIn(startDate, endDate, zone = DEFAULT_TZ) {
  return { startMs: dayStartMsIn(startDate, zone), endMs: dayStartMsIn(addDaysIn(endDate, 1, zone), zone) }
}
export function isoWeekKeyIn(isoOrMs, zone = DEFAULT_TZ) {
  const [y, m, d] = dateKeyIn(isoOrMs, zone).split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  const dayNum = (date.getUTCDay() + 6) % 7
  date.setUTCDate(date.getUTCDate() - dayNum + 3)
  const isoYear = date.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const ftDayNum = (firstThursday.getUTCDay() + 6) % 7
  const week = 1 + Math.round(((date - firstThursday) / DAY_MS - 3 + ftDayNum) / 7)
  return `${isoYear}-W${String(week).padStart(2, '0')}`
}
export function weekStartMsIn(isoOrMs, zone = DEFAULT_TZ) {
  const key = dateKeyIn(isoOrMs, zone)
  const [y, m, d] = key.split('-').map(Number)
  const dayNum = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
  return dayStartMsIn(addDaysIn(key, -dayNum, zone), zone)
}
export function monthStartMsIn(isoOrMs, zone = DEFAULT_TZ) {
  const [y, m] = dateKeyIn(isoOrMs, zone).split('-').map(Number)
  return dayStartMsIn({ y, mo: m, d: 1 }, zone)
}
export function addDaysISO(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
export function nextLocalMidnightMs(instant = Date.now(), zone = DEFAULT_TZ) {
  return strictDayStartMsIn(addDaysISO(strictDayStrIn(instant, zone), 1), zone)
}
```

Note for the implementer: `offsetMsAt` floors `ms` to the minute because `naiveWallMs` is minute-resolution. tz-time's version relied on minute-aligned inputs, and this floor keeps the solver exact for the seconds-carrying instants `dayStartMsIn` never produces anyway. If the parity test shows any `dayStartMsIn` mismatch, compare against `dublinDayStartMs`'s one-pass result before changing the solver. The SHELLY.1 measurement says two passes equal one pass for Dublin.

- [ ] **Step 4: Write `shared/zoned-time.test.js`** (behaviour in other zones; the oracle is `tz-time.test.js`'s independent read-back enumerator, copied, not re-derived):

```js
import { describe, it, expect, vi } from 'vitest'
import * as Z from './zoned-time.js'
const NY = 'America/New_York'
describe('America/New_York across 2026 DST', () => {
  it('todayStrIn flips at New York midnight', () => {
    expect(Z.todayStrIn(NY, Date.parse('2026-07-01T03:59:00Z'))).toBe('2026-06-30')
    expect(Z.todayStrIn(NY, Date.parse('2026-07-01T04:00:00Z'))).toBe('2026-07-01')
    expect(Z.todayStrIn(NY, Date.parse('2026-12-01T04:59:00Z'))).toBe('2026-11-30')
    expect(Z.todayStrIn(NY, Date.parse('2026-12-01T05:00:00Z'))).toBe('2026-12-01')
  })
  it('09:00 wall clock is 13:00Z in EDT and 14:00Z in EST', () => {
    expect(new Date(Z.zonedWallClockToInstant('2026-07-01', '09:00:00', NY)).toISOString()).toBe('2026-07-01T13:00:00.000Z')
    expect(new Date(Z.zonedWallClockToInstant('2026-12-01', '09:00', NY)).toISOString()).toBe('2026-12-01T14:00:00.000Z')
  })
  it('spring-forward gap 02:30 resolves EARLIER; the day still starts at 00:00 EST', () => {
    expect(new Date(Z.zonedWallClockToInstant('2026-03-08', '02:30', NY)).toISOString()).toBe('2026-03-08T06:30:00.000Z')
    expect(new Date(Z.dayStartMsIn('2026-03-08', NY)).toISOString()).toBe('2026-03-08T05:00:00.000Z')
  })
  it('the 25-hour fall-back day has a non-empty range of 25h', () => {
    const { startMs, endMs } = Z.dayRangeMsIn('2026-11-01', '2026-11-01', NY)
    expect(endMs - startMs).toBe(25 * 3600 * 1000)
  })
  it('isoWeekKeyIn / weekStartMsIn / monthStartMsIn use the New York calendar', () => {
    expect(Z.isoWeekKeyIn(Date.parse('2026-01-05T03:00:00Z'), NY)).toBe('2026-W01')  // still Sun 4 Jan in NY
    expect(new Date(Z.weekStartMsIn(Date.parse('2026-07-08T12:00:00Z'), NY)).toISOString()).toBe('2026-07-06T04:00:00.000Z')
    expect(new Date(Z.monthStartMsIn(Date.parse('2026-11-01T03:00:00Z'), NY)).toISOString()).toBe('2026-10-01T04:00:00.000Z')
  })
  it('instantToZonedParts gives the local weekday and minute of day', () => {
    expect(Z.instantToZonedParts('2026-07-06T03:30:00Z', NY)).toMatchObject({ dateKey: '2026-07-05', weekday: 7, h: 23, mi: 30, minuteOfDay: 1410 })
  })
})
describe('validation', () => {
  it.each([['europe/dublin', 'Europe/Dublin'], ['UTC', 'UTC'], ['America/New_York', 'America/New_York']])('%s → %s', (i, o) => expect(Z.canonicalZone(i)).toBe(o))
  it.each(['+05:30', 'Etc/GMT-5', 'GMT+1', 'Mars/Olympus', '', null, 42])('rejects %s', (v) => expect(Z.canonicalZone(v)).toBeNull())
  it('resolveZoneWithFallback flags only a non-null invalid value', () => {
    expect(Z.resolveZoneWithFallback(null)).toEqual({ zone: 'Europe/Dublin', fallback: false })
    expect(Z.resolveZoneWithFallback('Europe/Dubln')).toEqual({ zone: 'Europe/Dublin', fallback: true })
  })
  it('works when Intl.supportedValuesOf is missing (Hermes)', async () => {
    const saved = Intl.supportedValuesOf
    try { delete Intl.supportedValuesOf; vi.resetModules(); const Z2 = await import('./zoned-time.js'); expect(Z2.canonicalZone('Asia/Kolkata')).toBe('Asia/Kolkata') }
    finally { Intl.supportedValuesOf = saved }
  })
})
// Oracle: tz-time.test.js lines 12-49 copied VERBATIM above this block
// (stampFmt, localStamp, naiveOf, wallClockExists, daysOf2026): a different
// algorithm (enumerate offsets, filter by read-back), so this is not the solver testing itself.
describe('the tz-time oracle, all 2026 quarter-hours in five zones', () => {
  const ZONES = ['Europe/Dublin', 'America/New_York', 'Australia/Sydney', 'Australia/Lord_Howe', 'America/Santiago']
  const QUARTERS = []
  for (let m = 0; m < 1440; m += 15) QUARTERS.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`)
  it.each(ZONES)('%s: every existing wall clock reads back exactly', (zone) => {
    let bad = 0
    for (const d of daysOf2026()) for (const hhmm of QUARTERS) {
      if (!wallClockExists(d, hhmm, zone)) continue
      if (localStamp(Z.zonedWallClockToInstant(d, hhmm, zone), zone) !== `${d} ${hhmm}`) bad++
    }
    expect(bad).toBe(0)
  })
})
```

- [ ] **Step 5: Write `src/lib/location-time.js`** (the server side):

```js
// src/lib/location-time.js — TZ.1. Web/server import path for the zone maths
// (re-exported from @shared/zoned-time) plus the DB side: a location's zone.
export * from '@shared/zoned-time'
import { resolveZoneWithFallback, DEFAULT_TZ } from '@shared/zoned-time'
import { logWarn } from '@/lib/log'

// locations.timezone is NOT NULL and trigger-validated after mig 719, but a
// stale lambda or a pre-719 row must never throw inside a cron: invalid → the
// Dublin floor + ONE warning per (instance, location).
const TTL_MS = 60_000
const _cache = new Map() // locationId → { zone, at }
const _warned = new Set()
function remember(id, raw, nowMs) {
  const { zone, fallback } = resolveZoneWithFallback(raw)
  if (fallback && !_warned.has(id)) {
    _warned.add(id)
    logWarn('location-time', 'invalid locations.timezone; using Europe/Dublin', { locationId: id, timezone: raw })
  }
  _cache.set(id, { zone, at: nowMs })
  return zone
}
/** Zone of a location row already in hand ({ id, timezone }). No IO. */
export function zoneOfLocation(loc) {
  if (!loc) return DEFAULT_TZ
  return loc.id ? remember(loc.id, loc.timezone, Date.now()) : resolveZoneWithFallback(loc.timezone).zone
}
/** One location's zone; cached 60 s per instance. A read error is the Dublin floor, logged, NOT cached. */
export async function getLocationZone(db, locationId, { nowMs = Date.now() } = {}) {
  if (!locationId) return DEFAULT_TZ
  const hit = _cache.get(locationId)
  if (hit && nowMs - hit.at < TTL_MS) return hit.zone
  const { data, error } = await db.from('locations').select('id, timezone').eq('id', locationId).maybeSingle()
  if (error) {
    logWarn('location-time', 'locations.timezone unreadable; using Europe/Dublin', { locationId, err: error.message })
    return DEFAULT_TZ
  }
  return remember(locationId, data?.timezone ?? null, nowMs)
}
/** Many zones in one query (chunks of 500 ids: under the 1k row cap and the URL limit). Map id → zone. */
export async function getLocationZones(db, locationIds, { nowMs = Date.now() } = {}) {
  const out = new Map()
  const need = []
  for (const id of new Set((locationIds || []).filter(Boolean))) {
    const hit = _cache.get(id)
    if (hit && nowMs - hit.at < TTL_MS) out.set(id, hit.zone)
    else need.push(id)
  }
  for (let i = 0; i < need.length; i += 500) {
    const ids = need.slice(i, i + 500)
    const { data, error } = await db.from('locations').select('id, timezone').in('id', ids).order('id')
    if (error) {
      logWarn('location-time', 'locations.timezone batch unreadable; using Europe/Dublin', { count: ids.length, err: error.message })
      for (const id of ids) out.set(id, DEFAULT_TZ)
      continue
    }
    const rows = new Map((data || []).map((r) => [r.id, r.timezone]))
    for (const id of ids) out.set(id, remember(id, rows.get(id) ?? null, nowMs))
  }
  return out
}
/** Drop this instance's cached zone (TZ.3 calls it after a change). */
export function resetLocationZoneCache(locationId) {
  if (locationId) { _cache.delete(locationId); _warned.delete(locationId) } else { _cache.clear(); _warned.clear() }
}
```

`src/lib/location-time.test.js` covers, with a fake `db` built from the house helper `tests/helpers/supabase-mock` (or the inline builder pattern used in `src/lib/membership/source.test.js`):
- a hit within 60 s makes no second query;
- an error returns `Europe/Dublin`, logs once, and is NOT cached (the next call queries again);
- an invalid stored value returns `Europe/Dublin` and warns once per location;
- `getLocationZones` with 1,200 ids issues 3 `.in()` queries of ≤500, each `.order('id')`;
- `resetLocationZoneCache(id)` forces a re-read.

- [ ] **Step 6: Make `src/lib/tz-time.js` a shim** (its own test file stays unchanged and must stay green):

```js
// src/lib/tz-time.js — SHELLY.1's module, now a compatibility shim onto
// @shared/zoned-time (TZ.1). The solver, the DST contract and the 12-zone
// measurement live there. Do not add exports here; import @/lib/location-time.
import { zonedWallClockToInstant } from '@shared/zoned-time'
export {
  DEFAULT_TZ, isValidZone as isValidTz, resolveZone as resolveTz,
  strictDayStrIn as dayStrInTz, strictDayStartMsIn as dayStartMsInTz, nextLocalMidnightMs,
} from '@shared/zoned-time'
export function wallMsInTz(dateStr, hhmm, tz) {
  // tz-time accepted HH:MM only; keep that strictness for its 16 callers.
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(hhmm ?? '')) ? zonedWallClockToInstant(dateStr, hhmm, tz) : null
}
```

- [ ] **Step 7: Run all of it**

Run: `npx vitest run --maxWorkers=2 shared/zoned-time.parity.test.js shared/zoned-time.test.js src/lib/location-time.test.js src/lib/tz-time.test.js src/lib/dublin-time.test.js shared/dublin-time.test.js tests/shared-pair-sync.test.js`
Expected: all PASS. The parity file reports 0 mismatches across ~26k instants and ~1.1k days. `npm run check:mobile-imports && npm run check:ota-paths` stay green (`shared/zoned-time.js` is a new bundle-path file: **the merge publishes a no-op OTA**, so follow PR ritual step 8).

- [ ] **Step 8: Commit and PR ritual.** Changelog row: `TZ.1 — one zone-maths module (shared/zoned-time + src/lib/location-time); tz-time becomes a shim; Europe/Dublin byte-identical to dublin-time over 2025-2027`.

### Task TZ.1b: Retire the three private solvers that bypass tz-time

**Files:** `src/lib/push-reminders.js:42` (`localToUtc`, one pass: wrong for a band of times on DST days in any zone whose standard offset is not 0), `src/lib/checklist-instances.js:50-139` (`todayInTimezone`, `parseLocalToUtcMs`, `tzOffsetMs`), `src/lib/staff-attendance.js:71` (`resolveScheduledAt`). Their tests: `src/lib/push-reminders.test.js`, `src/lib/checklist-instances.test.js`, `src/lib/staff-attendance.test.js`.

- [ ] **Step 1:** Freeze the three current functions into `src/lib/tz-1b.legacy-dublin.test-helpers.js` (bodies copied verbatim). Write `src/lib/tz-1b.tz.test.js` from the template:
  - (a) For `Europe/Dublin`, every 2026 day × every quarter-hour: new === legacy.
  - (b) For `America/New_York`, the four DST-edge cases of `shared/zoned-time.test.js`. These assert the CORRECT instant: legacy `localToUtc` fails at least one of them, which is the bug being retired.
  - (c) For `checklist-instances`, `computeDeadlineAt` for a 23:30 deadline on 29 Mar 2026 in Dublin equals legacy.
- [ ] **Step 2:** `npx vitest run --maxWorkers=2 src/lib/tz-1b.tz.test.js` → FAIL ((b) fails on legacy).
- [ ] **Step 3:** Replace each body with a one-line delegation:
  - `localToUtc(d, t, tz) → new Date(zonedWallClockToInstant(d, t, resolveZone(tz)))`, keeping the function's current return type. Check whether it returns a `Date` or ms and keep that.
  - `parseLocalToUtcMs(iso, tz)` → split `iso` into date and time, then `zonedWallClockToInstant`.
  - `todayInTimezone(now, tz)` → `{ date: todayStrIn(resolveZone(tz), now.getTime()), dow: instantToZonedParts(now, resolveZone(tz)).weekday % 7 }`. Keep its current Sunday=0 dow convention: check the caller's `day_of_week` usage at `checklist-instances.js:225`.
  - `resolveScheduledAt(d, t, tz='UTC')` → `zonedWallClockToInstant(d, t, tz)`. Keep its `'UTC'` default: callers pass the location zone.

  Delete `tzOffsetMs`.
- [ ] **Step 4:** `npx vitest run --maxWorkers=2 src/lib/tz-1b.tz.test.js src/lib/push-reminders.test.js src/lib/checklist-instances.test.js src/lib/staff-attendance.test.js` → PASS. PR ritual. Changelog: `TZ.1b — push reminders, checklist deadlines and attendance resolve wall clock through the one solver (Dublin unchanged; DST-correct elsewhere)`.

### Task TZ.18a: Guardrail `no-hardcoded-dublin-zone`, with a baseline that only shrinks

**Why:** The sweeps are mechanical only if a machine says which files are left, and the class must not regrow while they run. Pattern: the existing `no-utc-today` rule (`eslint-rules/index.mjs:171-197`), tested in `tests/guardrails-rules.test.js:79`.

**Files:** `eslint-rules/index.mjs`, `tests/guardrails-rules.test.js`, `eslint.guardrails.config.mjs`, new `eslint-rules/dublin-zone-baseline.json`, new `tests/dublin-zone-baseline.test.js`.

- [ ] **Step 1: Failing rule tests** (append to `tests/guardrails-rules.test.js`):

```js
ruleTester.run('no-hardcoded-dublin-zone', plugin.rules['no-hardcoded-dublin-zone'], {
  valid: [
    "import { todayStrIn } from '@/lib/location-time'",
    "const z = PLATFORM_TZ",
    "const s = 'Times are shown in Europe/Dublin for this studio'", // prose, not a zone value
    "f({ timeZone: zone })",
  ],
  invalid: [
    { code: "f({ timeZone: 'Europe/Dublin' })", errors: [{ messageId: 'literal' }] },
    { code: "const tz = loc.timezone || 'Europe/Dublin'", errors: [{ messageId: 'literal' }] },
    { code: 'const tz = `Europe/Dublin`', errors: [{ messageId: 'literal' }] },
    { code: "import { dublinTodayStr } from '@/lib/dublin-time'", errors: [{ messageId: 'import' }] },
    { code: "import { dublinDateKey } from './dublin-time.js'", errors: [{ messageId: 'import' }] },
    { code: "import { dublinDateKey } from 'shared/dublin-time'", errors: [{ messageId: 'import' }] },
    { code: "const m = await import('./dublin-time.js')", errors: [{ messageId: 'import' }] },
  ],
})
```

- [ ] **Step 2:** `npx vitest run --maxWorkers=2 tests/guardrails-rules.test.js` → FAIL (`rule not found`).
- [ ] **Step 3: The rule** (add to `eslint-rules/index.mjs` and register it in `rules`):

```js
// TZ.18 — a studio's clock is its locations.timezone. A bare 'Europe/Dublin' or a
// dublin-time import is a per-tenant decision pinned to UN1T's zone. Use
// @/lib/location-time (zone from the location) or PLATFORM_TZ (a platform-level
// decision, class c). Exact-value match only: prose that mentions the zone is fine.
const DUBLIN_IMPORT = /(^|\/)dublin-time(\.js)?$/
const noHardcodedDublinZone = {
  meta: {
    type: 'problem',
    docs: { description: "Disallow the literal 'Europe/Dublin' and dublin-time imports outside the zone helpers." },
    schema: [],
    messages: {
      literal: "'Europe/Dublin' hard-codes UN1T's zone. Use the location's zone (@/lib/location-time: getLocationZone / zoneOfLocation) or PLATFORM_TZ for a platform-level decision.",
      import: 'dublin-time pins Europe/Dublin. Import the zone-taking twin from @/lib/location-time (web) or shared/zoned-time (phone, shared).',
    },
  },
  create(context) {
    const lit = (node, value) => { if (value === 'Europe/Dublin') context.report({ node, messageId: 'literal' }) }
    const imp = (node, src) => { if (typeof src === 'string' && DUBLIN_IMPORT.test(src)) context.report({ node, messageId: 'import' }) }
    return {
      Literal(node) { lit(node, node.value) },
      TemplateLiteral(node) { if (node.expressions.length === 0) lit(node, node.quasis[0].value.cooked) },
      ImportDeclaration(node) { imp(node, node.source.value) },
      ImportExpression(node) { if (node.source.type === 'Literal') imp(node, node.source.value) },
      ExportAllDeclaration(node) { imp(node, node.source && node.source.value) },
      ExportNamedDeclaration(node) { if (node.source) imp(node, node.source.value) },
    }
  },
}
```

Note: the `Literal` visitor also sees an import's source string, but `'…/dublin-time'` is not `'Europe/Dublin'`, so nothing reports twice.

- [ ] **Step 4: The baseline and the config block.** Generate the baseline from main:

```bash
npx eslint --no-eslintrc --rule '{"guardrails/no-hardcoded-dublin-zone":"error"}' --plugin ./eslint-rules/index.mjs -f json 'src/**/*.{js,jsx}' 'shared/**/*.js' 'mobile/**/*.{js,jsx}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).filter(f=>f.messages.length&&!/\.test\.|test-helpers/.test(f.filePath)).map(f=>require("path").relative(process.cwd(),f.filePath)).sort();console.log(JSON.stringify(r,null,2))})' > eslint-rules/dublin-zone-baseline.json
```

(If flat config rejects the `--no-eslintrc` form, write a 10-line `scratch/tz-18a-config.mjs` that registers only this rule, and use `--config` instead. Name the scratch file per task.) Expect about 215 files.

Add to `eslint.guardrails.config.mjs`:

```js
import { readFileSync } from 'node:fs'
const DUBLIN_ZONE_BASELINE = JSON.parse(readFileSync(new URL('./eslint-rules/dublin-zone-baseline.json', import.meta.url), 'utf8'))
// Permanent allowlist, each with its reason:
const DUBLIN_ZONE_ALLOW = [
  'src/lib/dublin-time.js',      // legacy module; kept because champ-app mirrors shared/dublin-time (CLAUDE.md sync rule)
  'shared/dublin-time.js',       // same
  'shared/zoned-time.js',        // defines PLATFORM_TZ / DEFAULT_TZ: the ONE literal
]
// … in the exported array:
{
  files: ['src/**/*.{js,jsx}', 'shared/**/*.js', 'mobile/**/*.{js,jsx}'],
  ignores: [...NO_TESTS, ...DUBLIN_ZONE_ALLOW, ...DUBLIN_ZONE_BASELINE],
  plugins: { guardrails },
  rules: { 'guardrails/no-hardcoded-dublin-zone': 'error' },
},
```

Also widen `check:guardrails` in `package.json` to lint `'mobile/**/*.{js,jsx}'`. Check first that the existing blocks do not start failing on `mobile/` (they are scoped by `files`). If they would, give this rule its own script, `check:dublin-zone`, wired into the CI step that runs `check:guardrails`.

- [ ] **Step 5: The ratchet test** `tests/dublin-zone-baseline.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
const baseline = JSON.parse(readFileSync('eslint-rules/dublin-zone-baseline.json', 'utf8'))
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
describe('dublin-zone baseline only shrinks', () => {
  it('is sorted and has no duplicates', () => expect([...new Set(baseline)].sort()).toStrictEqual(baseline))
  it.each(baseline)('%s still exists and still needs its entry (else delete the entry)', (f) => {
    expect(existsSync(f)).toBe(true)
    expect(/'Europe\/Dublin'|"Europe\/Dublin"|`Europe\/Dublin`|dublin-time/.test(strip(readFileSync(f, 'utf8')))).toBe(true)
  })
  it('never grows past the TZ.18a count', () => expect(baseline.length).toBeLessThanOrEqual(/* TZ.18a's count, written in */ 215))
})
```

The last assertion's number is set to the generated count in this PR. Every sweep PR lowers it to its new length in the same commit that removes its files.

- [ ] **Step 6:** `npx vitest run --maxWorkers=2 tests/guardrails-rules.test.js tests/dublin-zone-baseline.test.js && npm run check:guardrails` → PASS. PR ritual. Changelog: `TZ.18a — guardrail bans new 'Europe/Dublin' literals and dublin-time imports; a baseline of today's files only shrinks`.

**As built (TZ.18a, supersedes Steps 3-5 where they differ):** the baseline is `eslint-rules/dublin-zone-baseline.txt` (one path per line, sorted, `#` header; 210 files), not JSON, so parallel sweeps that delete different lines never conflict. There is no count to lower: shrink-only is enforced by `eslint-rules/dublin-zone-baseline.tz18a-snapshot.txt` (frozen, never edited; the baseline must stay a subset of it). The gate is `scripts/check-dublin-zone.mjs`, chained onto `npm run check:guardrails` (also `npm run check:dublin-zone`), not a block in `eslint.guardrails.config.mjs`: it lints `src/`, `shared/` and `mobile/` with `noInlineConfig`, holds the allowlist with reasons, and fails on a stale baseline line.

**How every sweep uses it (Step 1 of TZ.4–TZ.17):** delete the task's lines from `eslint-rules/dublin-zone-baseline.txt` (nothing else in that file or the snapshot) and run `npm run check:guardrails`. It FAILS and lists exactly the lines the appendix section names. That failure, plus the two tests in "The two tests every sweep task writes first", is the test-first step. Class-c sites in those files change `'Europe/Dublin'` to `PLATFORM_TZ` and class-d sites to the provider's zone. Neither changes behaviour.


---

## Track L — The column, creation and settings (the binding decision's first half)

### Task TZ.2 ⚠️ (settings UI only): `locations.timezone` hardened; creation and settings choose it; the browser can no longer write it

**Card (D1, D8):** this PR implements D1=A (any IANA zone) and D8=A+hint. If Richard picks D1=B, `TIMEZONE_OPTIONS` below becomes the whole allowed list and the validator checks membership. **What UN1T sees:** on `/settings/locations/[id]` the timezone `<select>` becomes a searchable picker, and saving a changed zone goes through TZ.3's confirm step. Until TZ.3 merges, the field is read-only with "Change timezone (coming next)". No schedule, send or customer-facing behaviour changes.

**Files:**
- Create: `supabase/migrations/719_locations_timezone_hardening.sql`
- Modify: `src/app/api/locations/route.js:49,88` (+ `src/app/api/locations/route.test.js`)
- Create: `src/lib/timezone-options.js` (+test)
- Create: `src/components/settings/TimezoneSelect.jsx` (+test)
- Modify: `src/components/LocationForm.jsx:21,101-129,150,276-293`
- Modify: `src/components/admin/TenantWizard.jsx:173-195` (+ its test)
- Modify: `tests/helpers/credential-column-grants.js:21` (drop `timezone` from the client `update` list)
- Modify: `src/lib/openapi.js` (`LocationCreate` schema: the `timezone` description)

- [ ] **Step 1: The migration** (written first; its verify block is the DB test):

```sql
-- 719_locations_timezone_hardening.sql — TZ.2 (SaaS timezone wave)
-- A location's timezone is chosen at creation and managed in its settings
-- (Richard, 10 Oct 2026). Before this it was nullable free text any owner could
-- set from the browser. After: NOT NULL, a real IANA zone (no fixed offsets),
-- written only by the service role (POST /api/locations, PUT …/timezone).
BEGIN;

-- 1. No live row may be NULL or invalid before the constraint lands (Q1 says all six are Europe/Dublin).
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad FROM public.locations l
   WHERE l.timezone IS NULL
      OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names n WHERE n.name = l.timezone);
  IF bad > 0 THEN
    RAISE EXCEPTION 'TZ.2: % location(s) have a NULL or unknown timezone; fix them by hand first (Q1)', bad;
  END IF;
END $$;

ALTER TABLE public.locations ALTER COLUMN timezone SET DEFAULT 'Europe/Dublin';
ALTER TABLE public.locations ALTER COLUMN timezone SET NOT NULL;

-- 2. Validation trigger (a CHECK cannot read pg_timezone_names).
CREATE OR REPLACE FUNCTION private.locations_timezone_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.timezone ~* '^([+-]\d|(etc/)?gmt[+-]\d|utc[+-]\d)' THEN
    RAISE EXCEPTION 'locations.timezone % is a fixed offset; use an IANA zone such as Europe/Dublin', NEW.timezone
      USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'locations.timezone % is not an IANA zone', NEW.timezone USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS locations_timezone_guard ON public.locations;
CREATE TRIGGER locations_timezone_guard
  BEFORE INSERT OR UPDATE OF timezone ON public.locations
  FOR EACH ROW EXECUTE FUNCTION private.locations_timezone_guard();

-- 3. The browser stops writing the column (owners change it through PUT /api/locations/[id]/timezone,
--    which runs the D2 preflight). Mig 648 granted column UPDATE and NO table-level UPDATE, so a
--    column REVOKE takes effect (the CLAUDE.md trap is a column REVOKE under a TABLE grant). Verified below.
REVOKE UPDATE (timezone) ON public.locations FROM authenticated;

-- 4. The SQL twin of zoneOfLocation, for TZ.15's functions and policies.
CREATE OR REPLACE FUNCTION private.location_tz(p_location_id uuid)
RETURNS text LANGUAGE sql STABLE SET search_path = '' AS $$
  SELECT COALESCE((SELECT l.timezone FROM public.locations l WHERE l.id = p_location_id), 'Europe/Dublin')
$$;
REVOKE ALL ON FUNCTION private.location_tz(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.location_tz(uuid) TO authenticated, service_role;

COMMENT ON COLUMN public.locations.timezone IS
  'TZ.2 (mig 719): the studio''s IANA zone. Every per-location wall-clock column (bookings, shift_blocks, '
  'race_events, quiet hours, schedules) is local time in this zone. Chosen at creation; changed only via '
  'PUT /api/locations/[id]/timezone (D2 preflight). NOT NULL, validated against pg_timezone_names by '
  'private.locations_timezone_guard; no client UPDATE.';

-- 5. Self-check: the REVOKE really bit (column_privileges, never the migration text).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.column_privileges
              WHERE table_schema='public' AND table_name='locations' AND column_name='timezone'
                AND grantee='authenticated' AND privilege_type='UPDATE') THEN
    RAISE EXCEPTION 'TZ.2: authenticated still holds UPDATE(timezone); a table-level grant must exist';
  END IF;
END $$;
COMMIT;
```

Verify SQL (orchestrator, after `apply_migration`):

```sql
select is_nullable from information_schema.columns where table_schema='public' and table_name='locations' and column_name='timezone'; -- NO
begin; update public.locations set timezone='Mars/Olympus' where id='9e069256-…'; rollback;  -- ERROR 22023 (Test Studio id from Q1)
begin; update public.locations set timezone='+05:30' where id='9e069256-…'; rollback;          -- ERROR 22023
select private.location_tz('a0000000-0000-0000-0000-000000000001');                              -- Europe/Dublin
```

(The MCP rolls back a `begin;` without a commit, per the memory note. That is what the two probes want.)

- [ ] **Step 2: Failing route tests** (`src/app/api/locations/route.test.js`, extending the W1.W1 file):

```js
it('canonicalises a valid zone', async () => {
  const res = await POST(req({ name: 'NY', organization_id: ORG, timezone: 'america/new_york' }))
  expect(res.status).toBe(200)
  expect(insertedRow().timezone).toBe('America/New_York')
})
it.each(['Mars/Olympus', '+05:30', 'Etc/GMT-5', ''])('refuses %s with 400 and inserts nothing', async (tz) => {
  const res = await POST(req({ name: 'X', organization_id: ORG, timezone: tz }))
  expect(res.status).toBe(400)
  expect(insertCalls()).toBe(0)
})
it('defaults to Europe/Dublin only when the field is absent (D8 makes the UI always send it)', async () => {
  await POST(req({ name: 'Y', organization_id: ORG }))
  expect(insertedRow().timezone).toBe('Europe/Dublin')
})
```

- [ ] **Step 3:** `npx vitest run --maxWorkers=2 src/app/api/locations/route.test.js` → FAIL (`Mars/Olympus` is accepted today).
- [ ] **Step 4: Route change** (`src/app/api/locations/route.js:49`):

```js
import { canonicalZone, PLATFORM_TZ } from '@/lib/location-time'
// …
timezone: z.string().trim().max(64).default(PLATFORM_TZ)
  .refine((v) => canonicalZone(v) !== null, { message: 'Choose a real timezone, such as Europe/Dublin or America/New_York.' })
  .transform((v) => canonicalZone(v)),
```

- [ ] **Step 5: `src/lib/timezone-options.js`** (pure; the picker's data and the D8 hint):

```js
import { canonicalZone } from '@shared/zoned-time'
// Shown first in the picker, then every other zone the runtime knows.
export const COMMON_ZONES = Object.freeze([
  'Europe/Dublin', 'Europe/London', 'Europe/Berlin', 'Europe/Malta', 'Asia/Nicosia', 'Africa/Cairo', 'Asia/Kuwait',
  'Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Perth', 'Australia/Adelaide',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles',
])
export function allZones() {
  const rest = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  return [...COMMON_ZONES, ...rest.filter((z) => !COMMON_ZONES.includes(z))]
}
// D8 hint: the zones a country plausibly uses. A miss is a WARNING, never a block.
const COUNTRY_ZONES = { IE: ['Europe/Dublin'], GB: ['Europe/London'], DE: ['Europe/Berlin'], MT: ['Europe/Malta'],
  CY: ['Asia/Nicosia'], EG: ['Africa/Cairo'], KW: ['Asia/Kuwait'], AU: ['Australia/'], US: ['America/'] }
export function countryZoneMismatch(country, zone) {
  const want = COUNTRY_ZONES[String(country || '').toUpperCase()]
  const canon = canonicalZone(zone)
  if (!want || !canon) return null
  return want.some((p) => (p.endsWith('/') ? canon.startsWith(p) : canon === p))
    ? null
    : `Country is ${country} but the timezone is ${canon}. Is that right?`
}
export function browserZone() {
  try { return canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone) } catch { return null }
}
```

Test it: `countryZoneMismatch('AU','Europe/Dublin')` warns; `('AU','Australia/Perth')` and `('IE','Europe/Dublin')` are null; `allZones()` starts with `COMMON_ZONES` and has no duplicates.

- [ ] **Step 6: `TimezoneSelect.jsx`.** A searchable list from `allZones()` with the current UTC offset beside each name (`formatInZone(Date.now(), z, { timeZoneName: 'shortOffset' })`), plus the mismatch hint from `countryZoneMismatch`. Every `<button>` inside it gets `type="button"` (the `no-untyped-button-in-form` guardrail). Test: typing "york" filters to `America/New_York`; choosing it calls `onChange('America/New_York')`; country `AU` + Dublin renders the hint text.
- [ ] **Step 7: Wire the forms.**
  - **`LocationForm.jsx`, create:** swap the 12-option `<select>` (`:276-293`) for `<TimezoneSelect>`. The initial state for a NEW location is `browserZone() || 'Europe/Dublin'` (D8=A). Keep sending `timezone` in the POST body (`:150`).
  - **`LocationForm.jsx`, edit:** REMOVE `timezone` from the browser `update` payload (`:110`). After mig 719 it would fail the WHOLE update with 42501. Show the zone read-only with a "Change timezone" button that opens TZ.3's dialog. Until TZ.3 merges, the button is disabled with "coming next".
  - **`TenantWizard.jsx` `LocationStep`:** add `<TimezoneSelect>` and the country `<select>` (the same 8 countries as `LocationForm.jsx:265-274`). Pre-fill the zone with `browserZone()`, send both, and delete the "Ireland-only v1" comment at `:183`.
  - **`tests/helpers/credential-column-grants.js:21`:** drop `'timezone'` from the client `update` list so the SECFIX.3c guard matches mig 719.
- [ ] **Step 8:** `npx vitest run --maxWorkers=2 src/app/api/locations/route.test.js src/lib/timezone-options.test.js src/components/settings/TimezoneSelect.test.jsx src/components/admin/TenantWizard.test.jsx tests/credential-column-grants.test.js` → PASS; `npm run check:guardrails` (`LocationForm.jsx` and `route.js` leave the baseline: their only literal is now `PLATFORM_TZ`). The orchestrator applies mig 719 BEFORE merge. PR ritual. Changelog: `TZ.2 — locations.timezone is NOT NULL, validated (IANA, no fixed offsets) and service-role-only; creation and the tenant wizard choose it (browser zone pre-filled, country hint)`.

### Task TZ.3 ⚠️ (settings UI only): Changing a location's timezone, with a hazard preflight

**Card (D2):** this implements D2=B (owners blocked while future wall-clock data exists; master may force, with A semantics). For D2=A, drop the `blocked` branch. For C, the role gate becomes master-only. For D, the route returns 409 `frozen` for everyone except a location with `created_at` within the last hour.

**Files:**
- Create: `src/lib/timezone-change.js` (+test): `timezoneChangePreflight(db, locationId, { nowMs })`
- Create: `src/app/api/locations/[id]/timezone/route.js` (+test): `GET` = preflight, `PUT` = change
- Modify: `src/components/LocationForm.jsx` (the dialog), `src/lib/openapi.js`

- [ ] **Step 1: Failing tests.**
  - `src/lib/timezone-change.test.js`: with a fake `db` returning counts, `preflight` returns `{ future: { bookings, shift_blocks, race_events, staff_unavailability, hyrox_blocks, pending_enrolments, sonos_schedules, shelly_schedules, drip_broadcasts }, hasFutureData }`. "Future" is judged against **the location's CURRENT zone's today** (`todayStrIn(currentZone)`), never UTC.
  - Route test cases:
    - (a) a manager → 403;
    - (b) a non-member → 404 (`assertLocationAccessOr404` first, the membership-source order);
    - (c) an owner with `hasFutureData` → 409 `{ code: 'future_data', future }` and nothing written;
    - (d) an owner, no future data, valid zone → 200; `update` called with `{ timezone }`; `logAuditEvent` called with `{ category: 'location', action: 'timezone_changed', details: { from, to, future } }`; `resetLocationZoneCache` called;
    - (e) master with `force: true` and future data → 200;
    - (f) the same zone → 200 no-op, nothing written;
    - (g) an invalid zone → 400;
    - (h) `whatsapp_broadcasts` rows of this location still `scheduled`, whose `send_window_tz` equals the OLD zone, are updated to the new zone in the same request (they carry a zone copy). Rows with an explicit different zone are left alone, and the response lists them.
- [ ] **Step 2:** `npx vitest run --maxWorkers=2 src/lib/timezone-change.test.js 'src/app/api/locations/[id]/timezone/route.test.js'` → FAIL.
- [ ] **Step 3: Implement.**
  - **Route gate:** the membership-source route's gate, verbatim (`src/app/api/locations/[id]/membership-source/route.js:72-89`).
  - **Body:** `z.object({ timezone: z.string().max(64), force: z.boolean().optional(), confirm_name: z.string().optional() })`. `confirm_name` must equal `location.name` when `hasFutureData` and `force`: the typed confirmation.
  - **Preflight counts:** one `count: 'exact', head: true` query per table, filtered by `location_id` and by the local-today date column (`booking_date`, `block_date`, `race_date`, `end_date`, `starts_on + 7*weeks`). `sequence_enrollments` are scoped through `sequences.location_id` with `status='active'` and `next_step_at > now()`.
  - **Write:** the service-role update of `{ timezone, updated_at }`, then the `whatsapp_broadcasts` follow-up, then `resetLocationZoneCache(locationId)`, then the audit.
  - **Never rewritten:** stored instants and calendar keys (Live facts "Rule" rows). The pending sequence steps re-clamp on the next `run-sequences` pass, because TZ.4 reads the zone at clamp time.
  - **The dialog in `LocationForm.jsx`:** GET the preflight, then show "This studio has N future bookings, M shift blocks … Their times stay as written (09:00 stays 09:00 in the new timezone). Reminders and sends already scheduled will follow the new timezone." An owner who is blocked sees "Ask the platform team to change it". Master sees a typed-name confirm.
- [ ] **Step 4:** the tests → PASS. `npm run check:route-guards && npm run check:location-scoping`. Register the route in `openapi.js`. PR ritual. Changelog: `TZ.3 — PUT /api/locations/[id]/timezone: preflight of future wall-clock data, owner blocked when any exists (master may force with typed confirm), audit, cache bust, drip broadcasts follow`.


---

## Track S — The sweeps (mechanical, driven by Appendix A; one PR each)

**Common shape of every sweep PR** (each task lists only what is specific to it):
1. Delete the task's lines from `eslint-rules/dublin-zone-baseline.txt` (never edit the snapshot). `npm run check:guardrails` → FAIL on exactly the appendix lines.
2. Freeze each changed function's current body into `<area>.legacy-dublin.test-helpers.js`. Write `<area>.tz.test.js` from the template: Dublin byte-identical to the frozen copy, plus `America/New_York` across both 2026 DST edges with the task's specific assertions below. `npx vitest run --maxWorkers=2 <area>.tz.test.js` → FAIL.
3. Apply the appendix rule per row:
   - `LZ-*` → the `*In` twin with the location's zone. Get the zone from the row in scope (`zoneOfLocation(row.locations)` when the select already embeds `locations(timezone)`; otherwise add `timezone` to that embed, never a second query per row), from `getLocationZone(db, id)`, or from `getLocationZones` for a fan-out.
   - `MEMBER-zone` → the member's home `contacts.location_id` zone.
   - `PLATFORM` → `PLATFORM_TZ`.
   - `EXT:*` → the provider's zone.
   - `ALREADY` → import from `@/lib/location-time` and replace the literal fallback (`|| 'Europe/Dublin'`) with `zoneOfLocation` / `resolveZone`.
   - Class `b` sites use `formatInZone(instant, zone, sameOptions)`, keeping their exact Intl options so the Dublin text is unchanged.
4. Steps 1–2 tests → PASS; the area's existing tests → PASS unchanged (a changed existing assertion means a behaviour change: stop and card it); `npm run check:guardrails`, `check:select-columns`, `check:location-scoping`.
5. PR ritual (OTA step 8 where marked).

**Rule for a cron or loop that iterates locations** (TZ.4, TZ.5, TZ.6, TZ.8a, TZ.10, TZ.11a): resolve every zone ONCE per run with `getLocationZones(db, ids)` before the loop. Compute "today", "now in window" and "this week" INSIDE the loop from that zone. A computation that sits outside the loop today, with one Dublin day for all studios, moves inside. Several rows of the appendix are exactly this: `agent/followups.js:491,782`, `shift-reminders.js:477`, `roster-runway-notify.js:129`, `qualification-digest.js:238`, `sonos/reconcile.js:63`, `recon/finalize.js:295`, and the two equipment crons.

### Task TZ.4: Sequences, send quiet hours, drip broadcasts

**Files (Appendix TZ.4):** `src/components/AudienceBuilder.jsx:531`, `src/components/communications/UnifiedSendComposer.jsx:266,345,689`, `src/components/settings/SendQuietHoursCard.jsx:118`, `src/app/api/whatsapp/broadcasts/route.js:144`, `src/lib/send-quiet-hours.js:35,130,163,207,224,227,243,244`, `src/lib/sequences/cron-triggers.js:238,248`, `src/lib/sequences/scheduler.js:115`, `supabase/migrations/089_sequence_send_window.sql:28`, `supabase/migrations/253_whatsapp_drip_broadcast.sql:12`, `supabase/migrations/514_company_settings_send_quiet_hours.sql:83,85`

Specifics:
- **`src/lib/send-quiet-hours.js`:** every exported time function gains a trailing `zone = DEFAULT_TZ` (`isQuietHour` stays hour-only). That covers `evaluateSendTime({ at, now, config, zone })`, `nextAcceptableSend(candidate, config, zone)` and the label helpers.
  - Replace `dublinParts`/`dublinHour`/`dublinOffsetMs`/`dublinWallClockMs` (`:127-190`) with `instantToZonedParts(…, zone).h` and `zonedWallClockToInstant(dateKey, 'HH:00', zone)`. Delete the four private functions.
  - The "tonight/tomorrow" wording (`:238-246`) compares `dateKeyIn(at, zone)` with `todayStrIn(zone, now)`.
- **`src/lib/sequences/scheduler.js`:**
  - `clampToSendWindow(t, sendWindow, zone)` (`:114-115`) reads hour and weekday with `instantToZonedParts`.
  - At `:650-652`, resolve `const zone = await getLocationZone(db, sequence.location_id)` once per sequence (the scheduler already batches by sequence). Pass it to both the clamp and `nextAcceptableSend`.
- **`src/lib/sequences/cron-triggers.js`:**
  - `:238` anniversary year and `:248` birthday day become `todayStrIn(zone)` and `addDaysIn(…, -N, zone)` (calendar arithmetic replaces now − N×24h). This is identical for Dublin except on the two DST days; the byte-identity test pins those two days and asserts the legacy answer.
  - `:578` `isInsideSendWindow(…, zone)`, with `seq.location_id` at `:508`.
- **`src/app/api/whatsapp/broadcasts/route.js:144`:** `send_window_tz: body.send_window_tz || await getLocationZone(db, locationId)`.
- **`src/app/api/locations/[id]/send-quiet-hours/route.js` GET:** add `timezone` to the payload. `SendQuietHoursCard.jsx:118` and `UnifiedSendComposer.jsx:266,345,689` render or store it. The composer gets a `locationTimeZone` prop from its page (`user.activeLocation.timezone`).
- **Mig 089/514 column comments:** handled in TZ.15's migration (no migration here).
- **DST assertions (NY):**
  - Quiet hours 21→8. A candidate at `2026-07-01T01:30Z` (21:30 EDT) moves to `2026-07-01T12:00Z` (08:00 EDT); in winter, `2026-12-02T02:30Z` → `2026-12-02T13:00Z`.
  - A send window `{start_hour: 9, end_hour: 17, skip_days: [6,7]}` with a candidate on Sat `2026-11-07T15:00Z` moves to Mon `2026-11-09T14:00Z`, across the NY fall-back.
- Changelog: `TZ.4 — sequence send windows, send quiet hours and drip broadcast windows are judged on the sequence's studio clock (Dublin unchanged)`.

### Task TZ.5: Mia, the staff assistant, WhatsApp Flow, the cancellation form

**Files (Appendix TZ.5):** `src/app/settings/customer-agent/CustomerAgentClient.jsx:145,635`, `src/app/api/assistant/chat/route.js:516`, `src/app/api/public/cancellation-form/[token]/route.js:92,132`, `src/lib/agent/auto-reply.js:795`, `src/lib/agent/core.js:92`, `src/lib/agent/dublin-format.js:11`, `src/lib/agent/event-date-label.js:6,22`, `src/lib/agent/followups.js:147,381`, `src/lib/agent/review.js:44,48,49,226`, `src/lib/agent/settings-contract.js:126`, `src/lib/whatsapp-flow/handler.js:20,24`

Specifics:
- **`src/lib/agent/followups.js`:** `withinDublinDaytime` (`:146-153`) becomes `withinLocalDaytime(nowMs, zone)`. The gate applied ONCE before the per-location loop in `runAgentFollowups` (`:491`) and `runFirstClassCheckins` (`:782`) moves INSIDE the loop, with `getLocationZones` resolved up front.
- **`src/lib/agent/settings-contract.js:126`:** the `quiet_hours.tz` schema default `'Europe/Dublin'` becomes `null` ("the studio's zone").
  - **`core.js:92`:** resolve `quiet_hours.tz ?? zoneOfLocation(location)`.
  - **`CustomerAgentClient.jsx:145`:** stop writing `'Europe/Dublin'` when unset. `GET /api/settings/customer-agent` adds `location.timezone` for the display at `:635`.
  - **No data migration:** stored `quiet_hours.tz = 'Europe/Dublin'` values stay (Q6 lists them) and still mean Dublin.
- **`src/lib/agent/review.js:44-49,226`:** the nightly window and the Monday check are computed per location inside the review loop.
- **`src/lib/agent/dublin-format.js`:** add a `zone` parameter to its formatter, keep the file name (renaming it is churn), and pass the conversation's location zone from `auto-reply.js:795`. `event-date-label.js:6,22` likewise.
- **`src/app/api/assistant/chat/route.js:516`:** "Today" becomes `todayStrIn(zoneOfLocation(user.activeLocation))`.
- **`src/lib/whatsapp-flow/handler.js:20,24`:** the location zone. (The `starts_at.slice(0,10)` UTC-day bug at `:40,:58` is TZ.17.)
- **`src/app/api/public/cancellation-form/[token]/route.js:92,132`:** the token's contact location zone.
- **DST assertions:**
  - A NY studio at `2026-07-01T23:30Z` (19:30 EDT) is inside 09:00–19:59; a Dublin studio at the same instant (00:30) is not. Both studios in one `runAgentFollowups` call get their own answers.
  - At `2026-11-01T13:30Z`, NY is 08:30 EST (outside) and Dublin is 13:30 (inside).
- Changelog: `TZ.5 — Mia's daytime gate, quiet hours, nightly review and date labels follow each studio's timezone (Dublin unchanged)`.

### Task TZ.6: Daily crons act per location (the daily-slot gate)

**Card (D6).** As written this implements D6=B. For D6=A, `LEGACY_UTC_ANCHORED` below is the empty set (⚠️ UN1T's nudges then move an hour earlier in local terms during Irish summer time). For D6=C, skip Step 3 and the migration, and do only the per-location "today" inside each loop.

**Files (Appendix TZ.6):** `src/app/api/cron/equipment-inspection-reminder/route.js:38`, `src/app/api/cron/equipment-inspection-sweep/route.js:50`, `src/app/api/cron/event-reminders/route.js:26`, `src/app/api/cron/race-timing-events/route.js:104`, `src/app/api/cron/receipt-coverage-weekly/route.js:57,59`, `src/app/api/cron/run-challenge-events/route.js:141`, `src/app/api/cron/send-class-booking-reminders/route.js:140`, `src/app/api/cron/send-push-reminders/route.js:111`, `src/app/api/cron/notify-winback/route.js:34,35`, `src/app/api/cron/notify-streak-at-risk/route.js:42,45`. Also `vercel.json`, `supabase/migrations/720_cron_heartbeats_hourly_daily_slots.sql`, `src/lib/location-time.js` (the gate), and the routes of the D6 list: `notify-winback`, `notify-onboarding-pace`, `notify-streak-at-risk`, `run-challenge-events`, `event-reminders`, `contract-reminders`, `equipment-inspection-reminder`, `equipment-inspection-sweep`, `morning-briefing`, `churn-radar-digest`, `ad-report-email`, `run-scheduled-reports`, `receipt-coverage-weekly`.

- [ ] **Step 1: Failing gate test** (`src/lib/location-time.daily-slot.test.js`):

```js
import { dailySlotDue } from './location-time'
const at = (iso) => Date.parse(iso)
it('Europe/Dublin keeps the legacy UTC anchor (byte-identical schedule)', () => {
  expect(dailySlotDue('Europe/Dublin', at('2026-07-01T10:00:00Z'), 10)).toBe(true)   // 11:00 IST, as today
  expect(dailySlotDue('Europe/Dublin', at('2026-07-01T09:00:00Z'), 10)).toBe(false)
  expect(dailySlotDue('Europe/Dublin', at('2026-12-01T10:00:00Z'), 10)).toBe(true)
})
it('America/New_York acts at 10:00 local in both seasons', () => {
  expect(dailySlotDue('America/New_York', at('2026-07-01T14:00:00Z'), 10)).toBe(true)
  expect(dailySlotDue('America/New_York', at('2026-12-01T15:00:00Z'), 10)).toBe(true)
  expect(dailySlotDue('America/New_York', at('2026-12-01T14:00:00Z'), 10)).toBe(false)
})
it('weekday-scoped slots read the LOCAL weekday', () => {
  // Mon 06:00 local in Sydney is Sun 19:00/20:00 UTC
  expect(dailySlotDue('Australia/Sydney', at('2026-07-05T20:00:00Z'), 6, { weekday: 1 })).toBe(true)
})
```

- [ ] **Step 2: The gate** (append to `src/lib/location-time.js`):

```js
// TZ.6 / D6=B: Europe/Dublin locations keep the cron's legacy UTC hour, so UN1T's
// sends do not move. Every other zone acts at the target LOCAL hour. Switching UN1T
// to local anchoring later is a ⚠️ card: empty this set.
export const LEGACY_UTC_ANCHORED = new Set(['Europe/Dublin'])
export function dailySlotDue(zone, nowMs, hour, { weekday } = {}) {
  const z = resolveZone(zone)
  if (LEGACY_UTC_ANCHORED.has(z)) {
    const d = new Date(nowMs)
    return d.getUTCHours() === hour && (weekday == null || ((d.getUTCDay() + 6) % 7) + 1 === weekday)
  }
  const p = instantToZonedParts(nowMs, z)
  return p.h === hour && (weekday == null || p.weekday === weekday)
}
```

(import `resolveZone`, `instantToZonedParts` from `@shared/zoned-time` at the top).

- [ ] **Step 3: Each cron in the D6 list:**
  - change its `vercel.json` schedule to hourly, keeping the minute: `0 10 * * *` → `0 * * * *`, `30 10 * * *` → `30 * * * *`, `0 6 * * 1` → `0 * * * *` with `{ weekday: 1 }`, `0 7 * * 5` + `0 8 * * 5` → one `0 * * * *` with `{ weekday: 5 }`, and so on;
  - resolve zones once;
  - skip a location unless `dailySlotDue(zone, now, H)`;
  - compute its "today" and dedup keys with `todayStrIn(zone, now)`/`monthKeyIn`/`isoWeekKeyIn` INSIDE the loop.

  **Idempotency:** every one of these already claims per (location or contact, day) before sending: `customer-nudge-claim`, `push_event_sends`, `event_reminder_sends`, `scheduled_reports.next_run_at`. Verify each in the PR body, one line per cron. A cron without a claim gets one keyed on `(location_id, todayStrIn(zone))` in the same PR. Without it, an hourly schedule can repeat on a fall-back day in a non-Dublin zone.

  **`run-scheduled-reports`:** keeps reading `next_run_at <= now`. TZ.11a computes `next_run_at` as 07:00 in the schedule's location zone. The hourly schedule is what lets a non-Dublin 07:00 fire.

  **`receipt-coverage-weekly`:** the gate and "already ran" check move inside the loop over Xero connections, keyed per connection's location.

- [ ] **Step 4: Migration 720** (heartbeat cadence; names verified first with `select name, expected_interval_seconds from public.cron_heartbeats order by 1`):

```sql
-- 720_cron_heartbeats_hourly_daily_slots.sql — TZ.6: these crons run hourly and act
-- per location when its daily slot is due; their heartbeat is stamped every run.
UPDATE public.cron_heartbeats
   SET expected_interval_seconds = 3600, grace_seconds = 900,
       notes = trim(both ' ' from coalesce(notes, '') || ' TZ.6 (mig 720): hourly, per-location daily slot.')
 WHERE name IN ('notify-winback','notify-onboarding-pace','notify-streak-at-risk','run-challenge-events','event-reminders',
                'contract-reminders','equipment-inspection-reminder','equipment-inspection-sweep','morning-briefing',
                'churn-radar-digest','ad-report-email','run-scheduled-reports','receipt-coverage-weekly');
DO $$ BEGIN
  IF (SELECT count(*) FROM public.cron_heartbeats WHERE expected_interval_seconds = 3600 AND notes LIKE '%TZ.6%') <> 13 THEN
    RAISE EXCEPTION 'TZ.6: expected 13 heartbeat rows; a cron_heartbeats name differs from its route name. Fix the list.';
  END IF;
END $$;
```

(If a route has no heartbeat row, drop it from both lists and say so in the PR body. CLAUDE.md lists the two heartbeat-less crons.)

- [ ] **Step 5: ALREADY rows:** `send-push-reminders:111`, `send-class-booking-reminders:140`, `race-timing-events:104` swap their `|| 'Europe/Dublin'` for `zoneOfLocation`.
- [ ] **Step 6: Per-cron tests.** Each converted cron's route test gains two cases:
  - a Dublin location at the legacy UTC hour acts, and at any other hour does not;
  - a NY location acts only at its local hour.

  `npx vitest run --maxWorkers=2 src/lib/location-time.daily-slot.test.js src/app/api/cron/{notify-winback,notify-streak-at-risk,run-challenge-events,event-reminders,equipment-inspection-reminder,equipment-inspection-sweep,morning-briefing,receipt-coverage-weekly}/route*.test.js`. The orchestrator applies mig 720 BEFORE merge. PR ritual. Changelog: `TZ.6 — 13 daily crons run hourly and act for each studio at its own hour (Dublin keeps its UTC anchor: unchanged)`.

### Task TZ.7: Bookings and classes

**Files (Appendix TZ.7):** `src/app/(members)/bookings/event-types/[id]/page.js:53`, `src/app/(members)/bookings/page.js:16,61`, `src/app/(sales)/contacts/[id]/page.js:301`, `src/components/BookingSkipReminderToggle.jsx:35`, `src/components/BookingWidget.jsx:73,75,411`, `src/lib/booking-confirmations.js:48`, `src/lib/booking-slots.js:73,107,111,122`, `src/lib/bridge-samples.js:654`, `src/lib/class-booking-processor.js:20`, `src/lib/manual-booking-confirm-copy.js:28`, `src/lib/manual-timetable.js:13,191,211`, `src/lib/public-classes.js:12`

Specifics:
- **`src/lib/booking-slots.js:73,107,111,122`:** `isPast`/today use `todayStrIn(zone)` + `nowMinutesIn(zone)`, where zone = the event type's location (`event_types.location_id`; the slots API already loads the event type).
- **`BookingWidget.jsx:73,75,411`:** the footer names the STUDIO zone, from `GET /api/public/bookings/[slug]` (`locations.timezone` is already in that select, `route.js:41`), not the visitor's browser zone. **Dublin text check:** today's footer shows the visitor's own zone. For a Dublin visitor that is "Europe/Dublin" either way. For a visitor abroad it was wrong and becomes right. This is the only text that changes, and only for non-Dublin visitors, so no ⚠️.
- **`src/lib/bridge-samples.js:644,654`:** the private `dublinWallClockToMs` becomes `zonedWallClockToInstant` with the booking's location.
- **`src/lib/manual-timetable.js:13,191,211`:** zone from the timetable's location. (Its spring-forward 23:xx bug at `:188` is TZ.17: here keep its output identical by delegating only the non-buggy path, and let TZ.17 switch the solver.)
- `public-classes.js`, `class-booking-processor.js`, `booking-confirmations.js`, `manual-booking-confirm-copy.js`, the two bookings pages and `contacts/[id]/page.js:301`, `BookingSkipReminderToggle.jsx`: as listed.
- `class-reminders.js:83`: ALREADY.
- **DST assertion (NY):** at `2026-07-01T13:30Z` (09:30 EDT) the 09:00 slot is past and the 10:00 slot is open; at `2026-12-01T14:30Z` (09:30 EST) the same; a Dublin event type at those instants is byte-identical to legacy.
- Changelog: `TZ.7 — booking slots, public classes and booking copy use the studio's clock (Dublin unchanged)`.

### Task TZ.8a: Rostering, shifts, swaps, availability, staff push (OTA: `shared/working-time.js`)

**Files (Appendix TZ.8a):** `shared/working-time.js:114`, `src/app/(team)/schedule/availability/page.js:24`, `src/app/api/calendar-feed/[file]/route.js:69`, `src/app/api/schedule/availability/route.js:47,85`, `src/app/api/schedule/blocks/[id]/offer/route.js:52`, `src/app/api/schedule/blocks/[id]/route.js:266`, `src/app/api/schedule/swaps/[id]/route.js:211,314`, `src/app/api/schedule/swaps/route.js:189,219`, `src/app/api/schedule/templates/[id]/route.js:129,509`, `src/lib/availability-move-notice.js:83`, `src/lib/availability-notify.js:101,203`, `src/lib/block-edit-notify.js:142`, `src/lib/block-edit.js:228,243`, `src/lib/roster-change-format.js:241,254,255,257,266`, `src/lib/roster-change-notify.js:139`, `src/lib/roster-compare-format.js:44`, `src/lib/roster-compare.js:244`, `src/lib/roster-notify.js:245`, `src/lib/roster-publish.js:402,442,966`, `src/lib/roster-runway-data.js:41`, `src/lib/roster-runway-notify.js:51,91,129,152`, `src/lib/roster-staffing.js:57`, `src/lib/shift-arrivals.js:120,168`, `src/lib/shift-reminders.js:95,213,286,290,363,465,477`, `src/lib/shift-replace-notify.js:72,109`, `src/lib/staff-calendar-feed.js:63,64,66,98`, `src/lib/staff-push-hours.js:29,71`, `src/lib/swap-cover-server.js:199,208`, `src/lib/swap-cover.js:252`

Specifics: 31 rows are ALREADY per-location (import swap only). The real work:
- **`block-edit.js:228,243` + `block-edit-notify.js:142`:** these read the studio clock but a DUBLIN "today". Make both `todayStrIn(zone)` with the block's zone.
- **The `todayIso` defaults that no caller overrides:** `roster-publish.js:402,442,966`, `roster-runway-data.js:41`, `roster-staffing.js:57`, `roster-change-notify.js:139`, `roster-notify.js:245`, `shift-replace-notify.js:72`. Make the zone a required argument, passed by each caller from the roster's location.
- **`shift-reminders.js:477`:** the cron read range is per location (today..tomorrow in each studio's zone; the query spans min..max over the studios). The push copy at `:363` ("today/tomorrow") is per studio.
- **`roster-runway-notify.js:129`, `qualification-digest.js:238`:** the day moves inside the per-location loop.
- **`staff-push-hours.js`:** `resolveStaffTimeZone` becomes a thin wrapper over `resolveZoneWithFallback` (same `{ timeZone, warn }` shape). `STAFF_PUSH_DEFAULT_TZ = DEFAULT_TZ`. It keeps its own exports (11 importers).
- **`shared/working-time.js:114-147`:** the private `dublinWallMs` becomes `zonedWallClockToInstant` with the assignment's location zone, passed in by its callers. Its module-scope Intl formatter goes (Hermes-safe).
- **`roster-compare-format.js:43-53`:** the private `dublinParts` becomes `instantToZonedParts`.
- **`shift-offer-server.js:107-111` (`claim_shift_offer`):** the SQL leg is TZ.15. Here, remove the comment's assumption once TZ.15 lands.
- **DST assertion:** a NY studio's 06:00 shift on Sun 1 Nov 2026 (fall-back) reminds at the right instant; "today" for a NY block at `2026-07-01T03:30Z` is 30 Jun.
- OTA: `shared/working-time.js` is a bundle path, so merge alone.
- Changelog: `TZ.8a — roster, shift, swap and availability decisions use each studio's clock end to end; staff quiet band unchanged`.

### Task TZ.8b: Time off, attendance, contracts, equipment, qualifications, checklists

**Files (Appendix TZ.8b):** `src/components/AttendanceReportClient.jsx:26,27`, `src/components/ExpensesManager.jsx:474`, `src/components/TimeOffManager.jsx:947,958`, `src/components/maintenance/EquipmentTab.jsx:79`, `src/app/api/attendance/geofence-checkin/route.js:107`, `src/app/api/attendance/route.js:68,83`, `src/app/api/equipment/due/route.js:25,29`, `src/app/api/equipment/inspections/[id]/submit/route.js:134,270`, `src/app/api/equipment/route.js:77`, `src/app/api/qualifications/route.js:32`, `src/app/api/schedule/time-off/[id]/cancel-request/route.js:108`, `src/app/api/schedule/time-off/[id]/route.js:120`, `src/app/api/schedule/time-off/[id]/unassign-clashes/route.js:67`, `src/app/api/schedule/time-off/route.js:115,535,609`, `src/lib/allowance-year.js:16`, `src/lib/approvals/providers/time-off-cancellations.js:91,124`, `src/lib/approvals/providers/time-off.js:42,90`, `src/lib/attendance-report.js:129`, `src/lib/checklist-instances.js:51,79`, `src/lib/contract-pdf.js:255`, `src/lib/contracts.js:81`, `src/lib/qualification-digest.js:238,277`, `src/lib/time-off-cancel.js:294,296`, `src/lib/contractor-invoice-email.js:123,135`, `src/lib/contracts-email.js:278`

Specifics:
- **`equipment/due` and `equipment-inspections/[id]/submit`:** "due today" and the inspection date use the equipment's location zone. These are equipment reminders; the crons themselves are in TZ.6.
- **Time-off routes and approvals providers:** "past/started" checks use the request's location zone. `allowance-year.js:16` takes the location zone (the leave year turns at local midnight).
- **`attendance/route.js:68`:** the default range moves to the location's today; it reads the location first (it already does, at `:75-83`).
- **Contract and invoice emails** (`contract-pdf.js:255`, `contractor-invoice-email.js:123,135`, `contracts-email.js:278`, `contracts.js:81`): pass the contract's location zone to `formatFullDateTimeInTZ` instead of the implicit Dublin default.
- **`checklist-instances.js:51,79`:** ALREADY (TZ.1b did the solver).
- **DST assertion:** a NY equipment item due `2026-11-01` is "due today" from `2026-11-01T04:00Z` to `2026-11-02T04:59Z` (25-hour day); Dublin identical to legacy.
- Changelog: `TZ.8b — leave, attendance, contracts, equipment and qualification dates use the studio's clock (Dublin unchanged)`.

### Task TZ.9: Events, races, hyrox, host (OTA: `shared/events.js`)

**Files (Appendix TZ.9):** `shared/events.js:48`, `src/app/api/public/entry/[token]/move-options/route.js:47`, `src/app/api/public/entry/[token]/move/route.js:97`, `src/app/api/public/entry/[token]/route.js:104`, `src/app/api/public/events/[slug]/waitlist/route.js:73`, `src/lib/event-attendee-reminders.js:122,219`, `src/lib/event-waitlist.js:168,616`, `src/lib/host-move-session.js:64`, `src/lib/host-schedule-time.js:19,37,42`, `src/lib/hyrox/expand-runner.js:13`, `src/lib/hyrox/mapping.js:15`, `src/lib/hyrox/reminder-runner.js:117`, `src/lib/public-events.js:26`, `src/lib/registration-move.js:63,287,373,437`, `src/lib/race-confirmations.js:34`

Specifics:
- **`shared/events.js:41-59`:** `todayIsoDublin()` becomes `todayIsoIn(zone)` (keep `todayIsoDublin` as a deprecated alias calling it with `DEFAULT_TZ` until TZ.18b). `src/app/api/events/route.js:223` passes each event's zone. The comment at `:9` stays true: the server computes "today", so the phone carries no zone maths.
- **`src/lib/host-schedule-time.js:19-97`:** the private `dublinParts` / `dublinLocalToIso` become `instantToZonedParts` / `zonedWallClockToInstant` with the host anchor location's zone.
- **`registration-move.js`, the three `public/entry/[token]` routes, the event waitlist and `event-attendee-reminders.js:219`:** use the race's `location_id` zone (`race_events.location_id`). The date labels at `event-attendee-reminders.js:122`, `event-waitlist.js:168` and `race-confirmations.js:34` pass that zone to `formatWeekdayLongDateInTZ`.
- **`hyrox/expand-runner.js:13`, `hyrox/mapping.js:15`, `hyrox/reminder-runner.js:117`:** the hyrox block's location zone. `hyrox_blocks.starts_on` is a local Monday.
- **DST assertion:** a NY race on `2026-11-01` at 09:00 starts `2026-11-01T14:00Z` (EST); the move-options route lists sessions by NY day.
- OTA: merge alone.
- Changelog: `TZ.9 — event, race, entry-move, waitlist, hyrox and host schedule dates use the event's studio clock (Dublin unchanged)`.

### Task TZ.10: Climate, Sonos, Shelly, AC

**Files (Appendix TZ.10):** `src/app/(marketing)/automations/shelly/page.js:68`, `src/components/automations/ShellyDeviceCard.jsx:134,135`, `src/components/automations/SonosScheduleClient.jsx:49,120,176,177,178`, `src/app/api/shelly/devices/[id]/energy/route.js:96`, `src/app/api/shelly/devices/[id]/toggle/route.js:298`, `src/app/api/sonos/schedules/[id]/run-now/route.js:77`, `src/lib/schedule/desired-state.js:66,75,145,155`, `src/lib/class-climate.js:19`, `src/lib/fleet-health.js:340`, `src/lib/shelly/device-load.js:86`, `src/lib/shelly/reconcile.js:187,219,220,221,419,854`, `src/lib/sonos/reconcile.js:63`

Specifics:
- **`src/lib/sonos/reconcile.js:63`:** one Dublin `dateStr` for all locations becomes a per-location `todayStrIn(zone)` (the select embeds `locations(timezone)`, as `shelly/reconcile.js:747` already does).
- **`src/lib/sonos/groups.js:89`:** `planAction` passes `tz` to `resolveServeWindows`; today it omits it, so the engine falls back to Dublin. `sonos/schedules/[id]/run-now/route.js:77` likewise.
- **`SonosScheduleClient.jsx:49,120,176-178`:** `GET /api/sonos/schedules` returns `timezone`. The health check and "off until midnight" use `nextLocalMidnightMs(now, zone)`.
- **`src/lib/class-climate.js:18-37`:** the private `slotKey` becomes `instantToZonedParts` (weekday + `HH:MM`) in the location zone.
- **`schedule/desired-state.js:66,75,145,155`:** ALREADY. The default `tz` stays `DEFAULT_TZ`, but every caller now passes one, and the test asserts no caller omits it (grep test over `src/lib/sonos`, `src/lib/shelly`).
- **`fleet-health.js:340`:** keep `PLATFORM_TZ` (a fleet ops label, D4).
- **Shelly:** ALREADY, import swap only.
- **Q8 must return 0 rows** before this is called invisible. If it returns rows, SHELLY.2's 23:xx-IST fix already changed those boundaries for Shelly. For Sonos, moving onto the solver changes a 23:xx boundary, so card it.
- **DST assertion:** a NY Sonos window 06:00–22:00 on Sun 8 Mar 2026 resolves to `10:00Z`–`02:00Z` (EST→EDT inside the window); a Dublin schedule is identical to legacy over 2026.
- Changelog: `TZ.10 — Sonos windows and class-climate slots follow each studio's clock (Shelly already did; Dublin unchanged)`.

### Task TZ.11a: Reports, dashboards, briefings, snapshots, cars (OTA: `shared/dashboard-data.js`)

**Files (Appendix TZ.11a):** `shared/dashboard-data.js:533,535,536,542,599,600,687,689,695,696`, `src/app/dashboard/today/page.js:164`, `src/components/TasksPage.jsx:340`, `src/app/api/cron/ad-report-email/route.js:26`, `src/app/api/cron/morning-briefing/route.js:57`, `src/app/api/dashboard/studio-contacts/route.js:69`, `src/lib/labour-month-model.js:50,56`, `src/lib/account-home.js:77,213`, `src/lib/invoices-queue/enqueue.js:125`, `src/lib/membership-flows.js:55,89,95`, `src/lib/membership-snapshot.js:94,109`, `src/lib/today-feed-data.js:166`, `src/lib/report-generator.js:590,602,603,666,668`, `src/lib/cars.js:307,308,388`, `src/app/api/cars/reports/export/route.js:64`

Specifics:
- **`src/lib/report-generator.js:585-680`:** `calculatePeriodForSchedule(frequency, zone, nowMs)` and `calculateNextRun(…, zone, nowMs)` derive "yesterday", "last month" and "07:00 on the target day" from `todayStrIn(zone)` / `addDaysIn` / `zonedWallClockToInstant(target, '07:00', zone)`. Today they use host-local getters, which are UTC on Vercel. Callers pass the schedule's `location_id` zone.
  - **Dublin check:** periods are identical, since the 07:00 UTC run is the same calendar day in Dublin.
  - **`next_run_at`:** anchor it with TZ.6's rule. A schedule whose location zone is in `LEGACY_UTC_ANCHORED` keeps today's 07:00 **UTC**, so UN1T's reports go out exactly when they do now. Every other zone gets 07:00 local. Without this, a Dublin schedule would move to 06:00 UTC in summer under the hourly cron, which is a visible change.
  - The existing tests `report-generator.period.tz.test.js` / `.tz-us.test.js` must pass unchanged.
- **`membership-snapshot.js:94,109`, `membership-flows.js:55,89,95`:** the snapshot and flow day is the location's today. The cron (02:00 UTC) is unchanged: for every zone, the location-local date of a 02:00 UTC run is a complete-day boundary (Live facts "Calendar keys" rule).
- **`shared/dashboard-data.js:533-697`:** every exported fetcher gains `zone` (the dashboard's location, which `mobile/lib/dashboard-api.js` and the web pages already pass as `locationId`). `loadDublinTime()` becomes a static import of `./zoned-time.js`. Lines `641,643` (ads) are TZ.11c's rule: ad-account zone.
- **`morning-briefing/route.js:57`, `today/page.js:164`, `TasksPage.jsx:340`, `today-feed-data.js:166`, `account-home.js:77,213`, `studio-contacts/route.js:69`, `labour-month-model.js:50,56`, `invoices-queue/enqueue.js:125`:** the location's zone. (`today-feed-data.js:41` `isoToday` host-local is TZ.17.)
- **`cars.js:307,308,388` and `cars/reports/export/route.js:64`:** CCF Autos's location zone. This is identical at any hour except 23:00–24:00 UTC in Irish summer time, which is why these four rows are also listed in TZ.17's card. Do them THERE, not here.
- **D4:** `hr-attribution-sweep.js` and `admin-tenants.js` stay `PLATFORM_TZ`.
- OTA: merge alone.
- Changelog: `TZ.11a — scheduled report periods, membership snapshots, dashboards and briefings use each studio's calendar (Dublin unchanged)`.

### Task TZ.11b (only if D5 = A): The billing month per tenant

**Files (Appendix TZ.11b):** `src/app/settings/billing/page.js:58`, `src/app/api/cron/usage-rollup/route.js:39`, `src/app/api/cron/wallet-monthly-reset/route.js:50`, `src/app/api/cron/wallet-overage-draws/route.js:87`, `src/lib/admin-tenants.js:119,341,397,470,551`, `src/lib/billing-page.js:81,230,232`, `src/lib/integrations-hub.js:1291`, `src/lib/plans.js:97,198`, `src/lib/usage-caps.js:24`, `src/lib/wallet-enforcement.js:196,197,307`, `src/lib/wallet-topup.js:395`, `src/lib/wallet.js:81`, `supabase/migrations/420_wallets.sql:129`, plus `supabase/migrations/722_wallet_period_per_location.sql`.

If D5 = B (recommended), this task does ONE thing: every row's literal becomes `PLATFORM_TZ` with a comment `// D5: the platform billing calendar`. The tenant billing page and integrations strip say "resets on the 1st at 00:00 Irish time (HH:MM your time)", rendered with `formatInZone(monthStartMsIn(next, PLATFORM_TZ), locationZone, {hour,minute})`. No migration.

If D5 = A: `wallet.js:81`, `wallet-enforcement.js:196-197,307`, `usage-caps.js:24`, `billing-page.js`, `integrations-hub.js:1291` and the three crons take the wallet's location zone. Mig 722 rewrites `wallet_apply` (420:129) to seed `period_start` with `date_trunc('month', now() AT TIME ZONE private.location_tz(p_location_id))`. The 421 functions are in TZ.15's migration under the same card. Byte-identity: the SQL tests in TZ.15 run each function for Stillorgan before and after and compare.

### Task TZ.11c: External zones (Meta ad account, Xero)

**Files (Appendix TZ.11c):** `shared/dashboard-data.js:641,643`, `src/app/api/accounting/payables/route.js:51,52`, `src/app/api/cron/ad-insights-backfill/route.js:18`, `src/app/api/cron/ad-insights-sync/route.js:18`, `src/app/api/dashboard/ads/refresh/route.js:22`, `src/lib/ads/read.js:7`, `src/lib/recon/finalize.js:295`, `src/lib/recon/pull.js:77,106`

Specifics:
- **`ads/read.js:5-7` and the three cron copies of `dublinDateStr`** (`ad-insights-sync:18`, `ad-insights-backfill:18`, `dashboard/ads/refresh:22`): replace all four with ONE `adAccountDay(account, nowMs)` in `src/lib/ads/account-day.js`. It returns `todayStrIn(canonicalZone(account.account_timezone) ?? locationZone, nowMs)`. Meta's insight `date` is in the ad account's zone (`ad_accounts.account_timezone`, mig 358, filled by `src/lib/ads/providers/meta.js:59`).
  - **Dublin check:** UN1T's ad account zone. Read it with `select account_timezone from ad_accounts`. If it is `Europe/Dublin` this is identical. If it is anything else (e.g. `Europe/London`, which matches Dublin all year), the parity test runs with that value.
  - `shared/dashboard-data.js:641,643` take the same helper.
- **`recon/pull.js:77,106`, `accounting/payables/route.js:51,52`:** Xero's date fields are org-local. With one Xero org per location (memory: xero-one-org-per-location), use the location zone.
- **DST assertion:** an ad account in `America/New_York` asks Meta for `since/until` = NY dates around `2026-11-01`.
- Changelog: `TZ.11c — ad insight windows use the ad account's own timezone; Xero windows the studio's (Dublin unchanged)`.

### Task TZ.12: TV and live boards

**Files (Appendix TZ.12):** `src/app/live/[locationId]/DetectedTab.jsx:329`, `src/lib/live-board.js:99`, `src/lib/live-poll.js:27`, `src/lib/tv-class-intro.js:78`

Specifics:
- **`tv-class-intro.js:78`, `live-board.js:99`, `live-poll.js:25-27`** (private `dublinHour`) and **`live/[locationId]/DetectedTab.jsx:329`:** the board's location zone. TV routes resolve token → location (`src/app/tv/live/[token]`), and the zone travels in the board payload.
- **Kiosk note:** a deploy needs a kiosk reload to pick up the code (memory: tv-kiosk-viewport). Not an OTA.
- **DST assertion:** the class-intro clock for a NY board at `2026-03-08T07:00Z` reads 03:00 (just after spring-forward).
- Changelog: `TZ.12 — TV and live boards tell their own studio's time (Dublin unchanged)`.

### Task TZ.13: The member seam + the champ-app mirror (OTA)

**Card (D7):** a member's zone is their home location (`contacts.location_id`).

**Files (Appendix TZ.13):** `shared/challenges.js:40,47,56`, `shared/coach-kudos.js:75`, `shared/customer-notifications.js:110,111,133,134`, `shared/format.js:32`, `shared/goals.js:16,19,97,98,101,104`, `shared/hr-analytics.js:264,265,270,301,309,311,361,365,367`, `shared/month-wrapped.js:27`, `shared/progress-analytics.js:97,102,111`, `shared/session-history.js:65`, `shared/share-card.js:66`, `shared/tier-window.js:37`, `shared/week-digest.js:29,63,64,70,73`, `src/components/ConsultationForm.jsx:28,30`, `src/lib/challenges.js:42,49,58`, `src/lib/customer-notifications.js:110,111,133,134`, `src/lib/hr-analytics.js:264,265,270,301,309,311,361,365,367`, `src/lib/live-class.js:677`, `src/lib/onboarding-journey.js:83`, `src/lib/hr-post-class-email.js:522`. The champ-app twins are listed in Live facts (18 files).

Specifics:
- **Every `shared/` module here** (`challenges`, `customer-notifications`, `goals`, `hr-analytics`, `progress-analytics`, `week-digest`, `session-history`, `share-card`, `format`, `tier-window`, `coach-kudos`, `month-wrapped`): each exported function gains a trailing `zone = DEFAULT_TZ`. Calls become the `*In` twins.
  - `shared/month-wrapped.js:27`: the module-scope formatter becomes lazy (Hermes-safe).
  - The `src/lib` twins (`challenges.js`, `customer-notifications.js`, `hr-analytics.js`) change identically. **`tests/shared-pair-sync.test.js` must stay green:** `identical` pairs change byte-for-byte together. The `goals` pair is `diverged`, so update its `drifted` list only if a newly drifted export appears; the UTC-vs-Dublin goals split itself is TZ.17.
- **Callers pass the member zone.** Server: `getLocationZone(db, contact.location_id)` (`live-class.js:677`, `onboarding-journey.js:83`, `hr-post-class-email.js:522`, the crons TZ.6 converted). Phone: TZ.14's `useMemberZone()`.
- **`challenges.js:42-58`:** windows are computed in the CHALLENGE's location zone (`challenges.location_id`), so every participant shares one window. The comment's "must match `challenge_standings`" stays true: that RPC takes the instants this computes.
- **`ConsultationForm.jsx:28,30`:** the consultation's location zone. (`:31`'s UTC day is TZ.17.)
- **champ-app leg (same session, mirror rule):** apply the identical edits to champ-app `shared/` (the canon copies) and pass the member zone in `src/app/sessions/page.jsx`, `src/app/sessions/[id]/page.jsx`, `src/lib/claim-candidates.js` and `src/lib/load-social.js`, from the contact's `location_id` via champ-app's `loadBrandForContact` (W1.B2: it already resolves the location). Open the champ-app PR in the same session and merge it after the un1t-crm PR.
- **DST assertions:**
  - A NY member's streak counts a 23:30 EDT session on the NY day.
  - A 7-day challenge in a NY studio, ending `2026-11-01`, has `endMs - startMs = 7 days + 1 hour`.
  - Dublin: the parity test over each module's exported functions against the frozen legacy copies, over 2026.
- OTA: merge alone.
- Changelog: `TZ.13 — member streaks, challenges, goals, digests and member push keys use the member's home studio clock (Dublin unchanged); champ-app mirrored`.

### Task TZ.14: Phone screens; `/api/mobile/me` and the brand payload carry the zone (OTA)

**Card (D3, D7).**

**Files (Appendix TZ.14):** `mobile/app/(member)/(tabs)/home.jsx:123,124,335,549`, `mobile/app/(member)/(tabs)/sessions.jsx:212,303`, `mobile/app/(member)/sessions/[id].jsx:304`, `mobile/app/(staff)/contracts/[id].jsx:66`, `mobile/app/(staff)/contracts/index.jsx:27`, `mobile/app/(staff)/policies/[slug].jsx:22`, `mobile/app/(staff)/policies/index.jsx:17`, `mobile/components/AcDeviceList.jsx:67`, `mobile/lib/dates.js:98`, `mobile/lib/invoice-review.js:57`, plus `src/app/api/mobile/me/route.js:80-115`, `src/app/api/public/branding/route.js`, `mobile/lib/brand.js` (+test), `mobile/lib/auth-context.jsx`.

Specifics:
- **`/api/mobile/me`:** add `timezone: l.timezone` to each location and to `activeLocation`. Web-side, so it ships with the deploy BEFORE the OTA reads it. The phone falls back to `DEFAULT_TZ` while the field is absent (an old binary against a new server, or the reverse).
- **`/api/public/branding?location_id=`:** add `timezone` (public, not sensitive). `mobile/lib/brand.js` exposes it, and a `useMemberZone()` hook reads it for member screens (the member's home studio from `contact-context`'s `location_id`).
- **Staff screens** (`contracts`, `AcDeviceList`, `mobile/lib/dates.js:98`, `invoice-review.js:57`): the record's location zone (D3=A), from `activeLocation.timezone` when the record is the active studio's.
- **Policies** (`policies/index.jsx:17`, `policies/[slug].jsx:22`): format `effective_date`, a `date` column. Pin these to `'UTC'`, not the location zone: a date-only string read as UTC midnight shows the previous day in any zone behind UTC. Correct for Dublin too (identical text).
- **Member screens** (`home.jsx:123,124,335,549`, `sessions.jsx:212,303`, `sessions/[id].jsx:304`): `useMemberZone()`. (`home.jsx:538`'s UTC "today" is TZ.17.)
- **Tests:** `mobile/lib/brand.test.js` (the zone is read, with a fallback when absent) and the pure helpers in `mobile/lib/` with the NY/Dublin pair. **No RN component test runner exists** (memory: phone-mail-reader), so decisions live in `mobile/lib/`.
- OTA: merge alone, after TZ.13.
- Changelog: `TZ.14 — the phone shows each record in its studio's timezone and member stats in the member's home studio's (Dublin unchanged)`.

### Task TZ.16: Web display-only sweep

**Card (D3).**

**Files (Appendix TZ.16):** `src/app/(team)/contracts/[id]/page.js:35,212`, `src/app/(team)/contracts/page.js:41`, `src/app/(team)/contracts/templates/[id]/page.js:23`, `src/app/account/contracts/[id]/page.js:26,178`, `src/app/account/contracts/page.js:33`, `src/app/communications/(marketing-era)/list-health/page.js:69`, `src/app/welcome/[location]/status/page.js:88`, `src/components/AcControlPanel.jsx:74`, `src/components/CalendarFeedCard.jsx:20`, `src/components/DealCard.jsx:134`, `src/components/InvoicesManager.jsx:880`, `src/components/OfferSalesList.jsx:16`, `src/components/OrderDetail.jsx:412`, `src/components/OrdersTable.jsx:239,464`, `src/components/automations/BathroomClimateCard.jsx:23`, `src/components/automations/ClassClimateCard.jsx:23`, `src/components/contact/ContactDrawer.jsx:212`, `src/components/contact/ContactHeaderBand.jsx:187`, `src/components/dashboard/AdsRefreshButton.jsx:13`, `src/components/host/HostEmailReport.jsx:48`, `src/lib/dates.js:158`, `src/lib/email-forward.js:139`, `src/lib/mail/reply-quote.js:95`, `src/lib/sale-offers.js:47`

Specifics:
- **Each class-b site** becomes `formatInZone(instant, zoneOfRecord, <the same Intl options>)`. Server pages have `user.activeLocation.timezone` or the record's `locations(timezone)` embed. Client components get the zone from their API payload: the appendix row names the endpoint that must add `timezone`.
- **D3=A suffix:** `formatInZone` callers append the short zone name (`timeZoneName: 'short'`) ONLY when `zone !== browserZone()`. For Dublin staff on Dublin records nothing changes.
- **`src/lib/dates.js:158`:** `DEFAULT_EMAIL_TZ` stays as the floor. TZ.8b and TZ.9 made every caller pass a zone; this task adds a test that greps for `InTZ(` calls with one argument and fails on any.
- **`AuditLogTable.jsx:74`:** stays `PLATFORM_TZ` (D4, master only).
- Changelog: `TZ.16 — staff screens render each record's time in its studio's timezone (Dublin unchanged)`.

### Task TZ.17 ⚠️: Midnight-hour corrections and zone-less server renders

**Card:** "These fixes correct dates that were computed in UTC instead of Dublin. They change what UN1T sees ONLY between 00:00 and 01:00 Irish summer time (and at New Year for `{{current_year}}`). Each item names the surface."

**Why it is separate:** fixing these is right, but it is a visible change, so it must not hide inside a "byte-identical" sweep.

**Files (Appendix TZ.17):** `src/lib/postmark.js:539`, `src/app/api/cars/[id]/issue-deposit-link/route.js:134`, `src/lib/external-export.js:257`, `src/lib/hr-post-class-email.js:524`, `mobile/app/(member)/(tabs)/home.jsx:538`, `src/components/ConsultationForm.jsx:31`, `src/lib/today-feed-data.js:41`, `src/lib/goals.js:37`, `src/lib/live-class.js:645,696`, `src/lib/whatsapp-flow/handler.js:40,58`, `src/lib/sequences/cron-triggers.js:112,113,121`, `src/app/api/cron/run-challenge-events/route.js:140`, `shared/progress-analytics.js:18,45`, `src/lib/manual-timetable.js:188`, `src/lib/ads/read.js:80`

Specifics:
- **Member side (D7 zone):**
  - `home.jsx:538` countdown;
  - `goals.js:37` + `live-class.js:645,696` month (the bank key and the sum agree on the member's month);
  - `progress-analytics.js:18,45` UTC weeks and months: phone OTA + champ-app mirror for `progress-analytics`.
- **Studio side:**
  - `ConsultationForm.jsx:31`;
  - `today-feed-data.js:41`;
  - `whatsapp-flow/handler.js:40,58` (use `c.day`, the studio day it already computes);
  - `sequences/cron-triggers.js:112,113,121` (booking-reminder bounds and the `…Z` wall clock become `dayRangeMsIn` / `zonedWallClockToInstant`; delete the lint-disable);
  - `run-challenge-events/route.js:140`;
  - `manual-timetable.js:188` (spring-forward 23:xx);
  - `ads/read.js:80` (`T23:59:59` becomes `dayRangeMsIn`).
- **Zone-less server renders:** `postmark.js:539` `{{current_year}}` (sending location), `issue-deposit-link/route.js:134`, `external-export.js:257`, `hr-post-class-email.js:524` (the catch fallback).
- **cars.js rows** (from TZ.11a).
- **Tests:** each item gets one test at `2026-07-01T23:30:00Z` (00:30 IST on 2 Jul) asserting the Dublin answer (`2026-07-02` / July), which FAILS on main. Plus the NY pair.
- OTA: merge alone; champ-app mirror PR for `progress-analytics`.
- Changelog: `TZ.17 — fixes dates computed in UTC instead of the studio's or member's day (visible only 00:00-01:00 Irish summer time)`.


### Task TZ.15: SQL functions, policies and column comments

**Files (Appendix TZ.15):** `supabase/migrations/421_usage_rollup_and_caps.sql:55,66,77,89,110,125`, `supabase/migrations/448_hyrox_class_reminder.sql:51,52,53`, `supabase/migrations/517_list_health_monthly_stats.sql:189,212,215,237`, `supabase/migrations/521_email_source_and_campaign_recipient_stats.sql:107,125,128`, `supabase/migrations/622_staff_tombstone.sql:438,439`, `supabase/migrations/686_challenges_member_wrapped_window.sql:84,106`, `supabase/migrations/641_shift_offers.sql:240`. The migration is `supabase/migrations/721_zone_aware_sql_functions.sql`, plus a new `tests/sql/tz-721.sql` (verify script).

**Rule:** a function or policy that turns an instant into a studio's date or wall clock uses `AT TIME ZONE private.location_tz(<the row's location_id>)` (mig 719). For Dublin rows that is the same expression with the same zone, so the result is byte-identical by construction. The verify script proves it on live data.

**How to write each `CREATE OR REPLACE`:** dump the LIVE body with `select pg_get_functiondef('public.<fn>'::regproc)` (never re-type it from the old migration: later migrations may have changed it), then change ONLY these expressions:

| Function / policy | Before | After |
|---|---|---|
| `public.hyrox_coaches_on_shift` (448:51-53) | `(p_start AT TIME ZONE 'Europe/Dublin')`, `(p_end AT TIME ZONE 'Europe/Dublin')` | `(p_start AT TIME ZONE private.location_tz(p_location))`, same for `p_end` |
| `public.list_health_monthly_stats` (517:189,212,215,237) | every `at time zone 'Europe/Dublin'` | `at time zone v_tz`, with `v_tz text := private.location_tz(p_location_id);` declared (convert to plpgsql if it is `language sql`, or inline `private.location_tz(p_location_id)` in a CTE `tz` joined once) |
| `public.email_sends_monthly_stats` (521:107,125,128) | as above | as above |
| `public.tombstone_staff_profile` (622:438-439, used at 476-477 and 508-509) | `v_today`/`v_time` from `p_now AT TIME ZONE 'Europe/Dublin'`, compared against every block | per block: `(b.block_date + COALESCE(a.start_time_override, b.start_time)) > (p_now AT TIME ZONE private.location_tz(b.location_id))`, both at 476-477 and 508-509; drop `v_today`/`v_time` if nothing else reads them (check `v_today_kept` at :517) |
| `challenges_read` policy (686:84) | `((now() AT TIME ZONE 'Europe/Dublin')::date - 14)` | `((now() AT TIME ZONE private.location_tz(challenges.location_id))::date - 14)`, written with `ALTER POLICY` exactly as mig 686 did, keeping its catalog self-check (686:90-110) updated to the new text |
| `public.claim_shift_offer` (641:240) | `ob.block_date = v_block.block_date` + wall-clock overlap | overlap on instants: `(ob.block_date + ob.start_time) AT TIME ZONE private.location_tz(ob.location_id) < (v_block.block_date + v_block.end_time) AT TIME ZONE private.location_tz(v_block.location_id)` and the mirror condition; keep the same-date pre-filter widened to ±1 day |
| `rollup_usage_for_day`, `org_ai_spend_month_cents`, `org_email_sends_month` (421) | `'Europe/Dublin'` | **D5=B (recommended):** unchanged; add `COMMENT ON FUNCTION … 'D5: the platform billing calendar (Europe/Dublin) by decision'`. **D5=A:** `AT TIME ZONE private.location_tz(<row>.location_id)` |
| Column comments | 089 `email_sequences.send_window`, 514 `company_settings.send_quiet_hours_start/end` | `COMMENT ON COLUMN … 'Hours on the studio''s wall clock (locations.timezone), TZ.15.'` |
| `whatsapp_broadcasts.send_window_tz` default (253:12) | `DEFAULT 'Europe/Dublin'` | keep (writers set it from the location since TZ.4); add a comment saying so |

- [ ] **Step 1: The verify script first** (`tests/sql/tz-721.sql`; the orchestrator runs it read-only before AND after applying). It saves the results of each function for Stillorgan (`a0000000-…-0001`) and Hatch (`28c78d6b-…`) into temp tables before the migration, and diffs after:

```sql
-- before (run once, results pasted into the PR body) / after (must be identical)
select * from public.list_health_monthly_stats('a0000000-0000-0000-0000-000000000001');
select * from public.email_sends_monthly_stats('a0000000-0000-0000-0000-000000000001');
select * from public.hyrox_coaches_on_shift('a0000000-0000-0000-0000-000000000001', now(), now() + interval '1 hour');
select count(*) from public.challenges c
 where (c.ends_on >= ((now() AT TIME ZONE private.location_tz(c.location_id))::date - 14)) <>
       (c.ends_on >= ((now() AT TIME ZONE 'Europe/Dublin')::date - 14));          -- must be 0
select pg_get_expr(polqual, polrelid) from pg_policy where polname = 'challenges_read';
```

`tombstone_staff_profile` and `claim_shift_offer` are write functions: test them in a `begin; … rollback;` on Test Studio with a fabricated block at `now() + 30 min`, before and after. The MCP rolls back a `begin;` without a commit.
- [ ] **Step 2:** write mig 721 with the "after" bodies. Its last block is a self-check that `select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','private') and p.prokind = 'f' and pg_get_functiondef(p.oid) ilike '%Europe/Dublin%'` equals the number expected to remain: 0 for D5=A; for D5=B, the three 421 functions + `wallet_apply` + `private.location_tz` (its own fallback literal).
- [ ] **Step 3:** the orchestrator applies 721 BEFORE merge, runs `get_advisors(type=security)` and re-runs Step 1's script. Every result must be identical. PR ritual. Changelog: `TZ.15 — SQL functions and the challenges policy read each studio's zone through private.location_tz (Dublin unchanged)`.

### Task TZ.18b: The guard goes final

**Files:** `eslint.guardrails.config.mjs`, `eslint-rules/dublin-zone-baseline.json` (deleted), `tests/dublin-zone-baseline.test.js` (deleted), every `*.legacy-dublin.test-helpers.js` and the `<area>.tz.test.js` cases that import them (the byte-identity half is retired; the NY half stays), `shared/events.js` (`todayIsoDublin` alias deleted), `CLAUDE.md`.

- [x] **Step 1:** `grep -cv '^#' eslint-rules/dublin-zone-baseline.txt` is 0 (then delete it, the `.tz18a-snapshot.txt` and `scripts/check-dublin-zone.mjs`'s baseline handling). If it is not, a sweep is unfinished: stop.
- [x] **Step 2:** delete the baseline and its test; the config block keeps only `DUBLIN_ZONE_ALLOW`. `npm run check:guardrails` → PASS.
- [x] **Step 3:** CLAUDE.md "Timezones" bullet (`:77`) becomes:

  > **A studio's clock is `locations.timezone`.** Wall-clock columns (`bookings.booking_date/start_time`, `shift_blocks`, `race_events`, quiet hours, schedules) are local time in their row's location zone. Convert with `zonedWallClockToInstant(date, time, zone)` from `@/lib/location-time` (phone and shared: `shared/zoned-time`). "Today" is `todayStrIn(zone)`. Platform-level decisions use `PLATFORM_TZ`. `guardrails/no-hardcoded-dublin-zone` bans the literal and `dublin-time` imports; `no-utc-today`/`no-zulu-template-date` still apply.

  Update the `no-utc-today` message in `eslint-rules/index.mjs:177` to name `todayStrIn(zone)`.
- [x] **Step 4:** `npx vitest run --maxWorkers=2 tests/guardrails-rules.test.js tests/shared-pair-sync.test.js` → PASS. PR ritual. Changelog: `TZ.18b — the Dublin-zone baseline is empty: the literal and dublin-time imports are banned outright; CLAUDE.md timezone rule rewritten`.

**As built (TZ.18b, 11 Oct 2026; supersedes the steps where they differ):**
- The 7 lines no sweep claimed were fixed here, so the baseline reached 0 and was deleted with its frozen snapshot: `cron/agent-followups/route.js` (the platform-wide check-in rollup row's day key → `dayStrIn(…, PLATFORM_TZ)`, D4), `class-occurrences.js` (the 04:00 Glofox trainer-lookup ops throttle → `timeLabelIn(…, PLATFORM_TZ)`), `approvals/event-move-card.js` (a DATE column formatted in UTC at noon UTC: zone-free, same text), and `schedule/week-cost/route.js`, `recon/hunt-queries.js`, `report-period.js`, `roster-grid-data.js` (zone-free `addDaysISO` from zoned-time). Dublin pinned in `src/lib/tz-18b.tz.test.js` and the agent-followups route test.
- `scripts/check-dublin-zone.mjs` has no baseline handling. Non-test files: the literal and `dublin-time` imports fail. Test files (and `tests/**`, now linted too) run the rule with `{ literals: false }`: they may name the zone, never import `dublin-time`. Allowlist: `shared/zoned-time.js`, the two `dublin-time` modules (champ-app mirrors `shared/dublin-time`), their own tests, `shared/zoned-time.parity.test.js`. `tests/dublin-zone-baseline.test.js` became `tests/dublin-zone-guard.test.js`.
- All 31 `*.legacy-dublin.test-helpers.js` files deleted (incl. `shared/__tests__/tz-13/`'s 14 frozen copies). Each `<area>.tz.test.js` kept its New York/DST half; its byte-identity half became a short "Europe/Dublin pinned values" block (fixed literals around both 2026 EU changes, read off the code the identity tests had just proven). zoned-time ≡ dublin-time stays proven by `shared/zoned-time.parity.test.js`. TZ.7's and TZ.13's TZ.17 exclusions went with their identity blocks.
- Aliases removed (no callers left in `src/`, `shared/`, `mobile/`, or champ-app `origin/main`): `todayIsoDublin` (shared/events, OTA), `isoToDublinInputs`/`dublinLocalToIso`/`dublinScheduleLabel`, `dublinDateStr`/`dublinWeekday`, `dublinWeekWindow`, `dublinDaysBetween`; `dublinMonthStartStr` renamed `platformMonthStartStr` (D5).
- Not done here (follow-up): merging `mobile/lib/studio-zone.js` with `src/lib/record-time.js`'s suffix helper into `shared/` (not in this task's scope).

---

## Verification at the end of the wave

1. **Inventory:** `npm run check:guardrails` passes with no baseline. `git grep -n "'Europe/Dublin'" -- src shared mobile ':!*.test.*'` lists only `shared/zoned-time.js` and the two legacy `dublin-time.js` files.
2. **SQL:** Q4 returns only the D5-sanctioned functions and `private.location_tz`.
3. **A rehearsal tenant** (Test Studio, `9e069256-…`; never a live studio):
   - (a) master sets its zone to `America/New_York` through TZ.3. The preflight shows the counts. There is no future data, so it applies.
   - (b) create a booking type, a shift block, a race, a Sonos window and a sequence with a send window there. Check that each lands at New York wall clock (the booking slot list, the shift reminder push time, the race start in the confirmation email, the Sonos plan, the sequence `next_step_at`).
   - (c) the daily crons (TZ.6) act for Test Studio at New York's hour and for Stillorgan at the legacy UTC hour (read `cron_heartbeats` and the claims tables).
   - (d) set it back to `Europe/Dublin`.
4. **UN1T:** the week after the last merge, compare per-day counts of `email_sends`, `push_event_sends`, `whatsapp_messages` (outbound) and `sequence_enrollments.next_step_at` hour histograms for Stillorgan and Hatch against the week before. The shapes must match. The only expected differences are TZ.17's midnight-hour items, which Richard approved on their card.
5. **Phone:** after each OTA, a device check that Home (member) and Today/Studio (staff) show the same times as before for a Dublin user.

## What this wave leaves open (for the record, not for this wave)

- **Locale and currency.** `en-IE` and `€` are hard-coded (review §1 :61, "Minors"). A US studio sees DD/MM dates and euros. This is its own wave: a `locations.locale`, an org currency, and Stripe/Revolut currency checks.
- **Bank holidays.** These are per `locations.country` and cover IE/GB/DE/AU/MT (+ KW/EG/CY in the form). A US studio needs a US list.
- **Per-member travel zones** (D7=B) are not modelled.
- **Glofox branch timezone.** Glofox returns instants (unix seconds), so no conversion is needed. If a non-Dublin studio ever uses Glofox, check its branch-level "today" API parameters (`src/lib/class-occurrences.js:161`'s 04:00 trainer refresh is an ops throttle: any zone works).
- **D5=A**, if not chosen now.
- **Switching UN1T's daily crons from UTC anchoring to local anchoring** (D6 option A), if Richard wants year-round local send times. That is a one-line change (empty `LEGACY_UTC_ANCHORED`) plus a ⚠️ card.

---

## Appendix A — Timezone consumer inventory (the sweep deliverable)

**Method:**
- Every non-test file under `src/`, `shared/` and `mobile/` that imports `dublin-time` or `tz-time`, or contains the literal `Europe/Dublin`: 244 files.
- Every code line in those files that calls a `dublin*`/`tz-time` helper or carries the literal, excluding comments, import lines and the three helper modules: **409 lines in 214 files**.
- Plus `supabase/` SQL outside comments: 31 rows in 14 files.
- Plus 44 rows found by hand: implicit `DEFAULT_EMAIL_TZ` callers, host-local getters (UTC on Vercel), zone-less server renders, UTC-day bugs next to Dublin code, and UTC-keyed nudge crons.

Six parallel reviewers read each line in its function and classified it against one rubric. The rows were then merged, deduplicated and re-tagged for D5. Total: **484 rows across 244 distinct files (code + SQL)**.

**Classes (rows / distinct files):**
- **a** per-tenant decision: 295 / 147, of which 51 rows are already per-location (`ALREADY`: import swap only);
- **b** display-only: 94 / 75;
- **c** platform-level (Dublin stays, via `PLATFORM_TZ`): 40 / 21;
- **d** external API zone: 10 / 7;
- **x** no zone decision: 45 / 24.

A file can hold rows of several classes.

**Rules:** the codes are defined in "Name map" (TZ.1) and "Common shape of every sweep PR". "Zone source" says where the location is at that site: `row.location_id`, `arg`, `fan-out`, `member`, `NS` (none in scope: the row says what to thread).


### TZ.1b — private solvers retired (3 rows, 3 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| src/lib/checklist-instances.js:125 | `parseLocalToUtcMs` private solver | a | LZ-wall | arg |
| src/lib/push-reminders.js:42 | `localToUtc` private ONE-pass solver (wrong near DST in non-UTC-anchored zones) | a | LZ-wall (replace with `zonedWallClockToInstant`) | arg |
| src/lib/staff-attendance.js:71 | `resolveScheduledAt(date, time, tz = 'UTC')` private solver | a | LZ-wall | arg |

### TZ.2 — column, creation, settings (3 rows, 3 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| src/app/api/locations/route.js:49 | new location timezone defaults to Europe/Dublin | c | PLATFORM default; TZ.2 makes the field explicit (D8) | n/a |
| src/components/LocationForm.jsx:21 | new-location timezone field defaults to Europe/Dublin | c | PLATFORM default; TZ.2 makes the field explicit (D8) | n/a |
| supabase/migrations/004_auth_multi_tenant.sql:15 | `locations.timezone TEXT DEFAULT 'Europe/Dublin'`, nullable, no CHECK | x | column default; TZ.2 hardens (NOT NULL + validation trigger), keeps the default | n/a |

### TZ.4 — sequences, send quiet hours, broadcasts (21 rows, 10 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| src/app/api/whatsapp/broadcasts/route.js:144 | drip send_window_tz defaults to Europe/Dublin | a | LZ default: getLocationZone(locationId) when body omits it | arg (locationId) |
| src/components/AudienceBuilder.jsx:531 | date-filter default value is Dublin today ? input default only | a | LZ-today | NS: callers pass zone prop alongside locationId |
| src/components/communications/UnifiedSendComposer.jsx:266 | drip broadcast stored with send_window_tz Europe/Dublin | a | LZ-parts (send_window_tz = location zone) | NS: page passes location timezone prop with locationId |
| src/components/communications/UnifiedSendComposer.jsx:345 | drip confirmation says window is Europe/Dublin | b | LZ-fmt (render location zone name) | NS: page passes location timezone prop |
| src/components/communications/UnifiedSendComposer.jsx:689 | drip window hint says Europe/Dublin time | b | LZ-fmt (render location zone name) | NS: page passes location timezone prop |
| src/components/settings/SendQuietHoursCard.jsx:118 | copy says quiet-hours times are Europe/Dublin | b | LZ-fmt (render location zone name) | NS: add timezone to GET /api/locations/[id]/send-quiet-hours payload |
| src/lib/send-quiet-hours.js:35 | DUBLIN_TZ pins the whole quiet-hours window maths | a | LZ-parts + LZ-wall (zone param on evaluateSendTime/nextAcceptableSend) | NS (scheduler has sequence.location_id; notice needs route to return timezone) |
| src/lib/send-quiet-hours.js:130 | private Dublin parts formatter for hour and offset | a | LZ-parts | NS (caller passes zone) |
| src/lib/send-quiet-hours.js:163 | private Dublin-only wall-clock → instant (`hour:00` Dublin) | a | LZ-wall | arg (to add) |
| src/lib/send-quiet-hours.js:207 | next-slot search starts on Dublin day of candidate | a | LZ-day | NS (caller passes zone) |
| src/lib/send-quiet-hours.js:224 | advisory HH:MM label in Dublin | b | LZ-fmt | NS (same zone as the window) |
| src/lib/send-quiet-hours.js:227 | advisory "Wed 12 Aug" label in Dublin | b | LZ-fmt | NS (same zone as the window) |
| src/lib/send-quiet-hours.js:243 | today/tomorrow wording: Dublin day of send instant | b | LZ-day | NS (same zone as the window) |
| src/lib/send-quiet-hours.js:244 | today/tomorrow wording: Dublin day of now | b | LZ-today | NS (same zone as the window) |
| src/lib/sequences/cron-triggers.js:238 | anniversary dedup source_ref year = Dublin year | a | LZ-today (year slice) | fan-out (seq.location_id) |
| src/lib/sequences/cron-triggers.js:248 | birthday target day = Dublin day of now minus N*24h | a | LZ-range (addDaysIn(todayStrIn(zone), -N)) | fan-out (seq.location_id) |
| src/lib/sequences/scheduler.js:115 | sequence send_window hour and weekday read in Dublin | a | LZ-parts | row.location_id (sequence.location_id at runner; seq.location_id in isInsideSendWindow caller) |
| supabase/migrations/089_sequence_send_window.sql:28 | `email_sequences` send window documented as Dublin hours | a | COMMENT ON: window is the sequence location's wall clock | row.location_id |
| supabase/migrations/253_whatsapp_drip_broadcast.sql:12 | `whatsapp_broadcasts.send_window_tz` NOT NULL DEFAULT 'Europe/Dublin' | a | keep column; writers default it from the location zone (TZ.4); DB default left as the safe floor | row.location_id |
| supabase/migrations/514_company_settings_send_quiet_hours.sql:83 | COMMENT: quiet-hours start is Dublin wall clock | a | COMMENT ON: the location's wall clock | row.location_id |
| supabase/migrations/514_company_settings_send_quiet_hours.sql:85 | COMMENT: quiet-hours end is Dublin wall clock | a | as :83 | row.location_id |

### TZ.5 — Mia, staff assistant, WhatsApp Flow, cancellation form (19 rows, 11 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| src/app/api/assistant/chat/route.js:516 | staff assistant system prompt "Today" uses Dublin date | a | LZ-today | row.location_id (user.activeLocation) |
| src/app/api/public/cancellation-form/[token]/route.js:92 | form date options built from Dublin today | a | LZ-today | row.location_id (link.location_id) |
| src/app/api/public/cancellation-form/[token]/route.js:132 | submitted dates validated against Dublin today | a | LZ-today | row.location_id (link.location_id) |
| src/app/settings/customer-agent/CustomerAgentClient.jsx:145 | saves Mia quiet_hours.tz defaulting to Europe/Dublin | a | LZ-parts (default quiet_hours.tz to location zone) | NS: add timezone to GET /api/settings/customer-agent `location` payload (now {id,name}) |
| src/app/settings/customer-agent/CustomerAgentClient.jsx:635 | hard-coded "Europe/Dublin" quiet-hours label | b | LZ-fmt (render stored tz / location zone name) | NS: add timezone to GET /api/settings/customer-agent `location` payload |
| src/lib/agent/auto-reply.js:795 | Mia system prompt "today" = Dublin date | a | LZ-today | row.location_id (loc in scope) |
| src/lib/agent/core.js:92 | quiet-hours minute-of-day in settings tz, falls back to Dublin | a | ALREADY-ish: default to location zone not Dublin; LZ-parts | arg (quiet.tz; caller has location) |
| src/lib/agent/dublin-format.js:11 | Mia class-time label rendered in Dublin for customer replies | b | LZ-fmt | NS (caller passes toolCtx location zone) |
| src/lib/agent/event-date-label.js:6 | DATE label via noon-UTC anchor in Dublin (shifts at UTC+12) | b | PURE: format DATE in UTC, zone-free | n/a |
| src/lib/agent/event-date-label.js:22 | private Dublin "today" gates event past/open for Mia tools | a | LZ-today | NS (caller passes event's location zone) |
| src/lib/agent/followups.js:147 | proactive Mia sends gated to 09-19:59 Dublin hour | a | LZ-parts | row.location_id (settings/location per candidate) |
| src/lib/agent/followups.js:381 | follow-up system prompt "today" = Dublin date | a | LZ-today | row.location_id (location in scope) |
| src/lib/agent/review.js:44 | nightly reviewer "today" = Dublin date across all locations | a | LZ-today | NS (cross-location query; fan-out per location) |
| src/lib/agent/review.js:48 | review window start = Dublin midnight of yesterday | a | LZ-range | NS (cross-location query; fan-out per location) |
| src/lib/agent/review.js:49 | review window end = Dublin midnight today | a | LZ-range | NS (cross-location query; fan-out per location) |
| src/lib/agent/review.js:226 | Monday digest gate uses Dublin weekday for per-location push | a | LZ-parts (weekday) | fan-out (byLocation loop) |
| src/lib/agent/settings-contract.js:126 | quiet_hours.tz schema default 'Europe/Dublin' | a | default to location zone (resolve at read, not schema) | arg (settings belong to location) |
| src/lib/whatsapp-flow/handler.js:20 | Flow day-screen title for a date key, noon-UTC anchored | b | LZ-fmt (or timeZone UTC for a date key) | arg (locationId) |
| src/lib/whatsapp-flow/handler.js:24 | Flow slot HH:MM label in Dublin | b | LZ-fmt | arg (locationId) |

### TZ.6 — cron routes (13 rows, 10 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| src/app/api/cron/equipment-inspection-reminder/route.js:38 | inspection weekday + due compare on Dublin today, once for all | a | LZ-today per iteration | fan-out (settings.location_id loop) |
| src/app/api/cron/equipment-inspection-sweep/route.js:50 | overdue chase computed on Dublin today, once for all | a | LZ-today per iteration | fan-out (settings.location_id loop) |
| src/app/api/cron/event-reminders/route.js:26 | 3d/1d event reminder offsets from Dublin today | a | LZ-today per event (lib must widen race_date query) | row.location_id (race_events.location_id in lib) |
| src/app/api/cron/notify-streak-at-risk/route.js:42 | "today" = the UTC day at 11:00 UTC | a | MEMBER-zone todayStrIn | fan-out (contact.location_id) |
| src/app/api/cron/notify-streak-at-risk/route.js:45 | daily dedup key = UTC day | a | MEMBER-zone dayStrIn | fan-out |
| src/app/api/cron/notify-winback/route.js:34 | "today" = the UTC day at 10:00 UTC (same date as Dublin at that hour) | a | MEMBER-zone todayStrIn (identical for Dublin at 10:00 UTC) | fan-out (contact.location_id) |
| src/app/api/cron/notify-winback/route.js:35 | monthly dedup key = UTC month | a | MEMBER-zone monthKeyIn | fan-out |
| src/app/api/cron/race-timing-events/route.js:104 | race_date+wave start_time wall-clock to instant in Dublin | a | LZ-wall | row.location_id (race.location_id; embed locations.timezone) |
| src/app/api/cron/receipt-coverage-weekly/route.js:57 | already-ran-today check on Dublin day, global run | a | LZ-day ? global gate before fan-out | NS (gate precedes xero_connections loop; move per conn/org) |
| src/app/api/cron/receipt-coverage-weekly/route.js:59 | Friday 08:00 Dublin minute-of-day gate for org recon | a | LZ-parts ? org-facing ops report | NS (gate precedes xero_connections loop; move per conn/org) |
| src/app/api/cron/run-challenge-events/route.js:141 | end-announce retry floor from Dublin day | a | LZ-day per challenge (also line 140 uses UTC day) | row.location_id (challenges.location_id) |
| src/app/api/cron/send-class-booking-reminders/route.js:140 | class reminder push time label in location tz, Dublin fallback | b | ALREADY; fallback to PLATFORM_TZ/resolveTz | fan-out (locById per booking) |
| src/app/api/cron/send-push-reminders/route.js:111 | per-location tz for lead-time windows, Dublin fallback | a | ALREADY; fallback to PLATFORM_TZ/resolveTz | fan-out (locations loop) |

### TZ.7 — bookings and classes (20 rows, 12 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| src/app/(members)/bookings/event-types/[id]/page.js:53 | splits upcoming bookings by Dublin today | a | LZ-today | row.location_id (event.location_id) |
| src/app/(members)/bookings/page.js:16 | upcoming/past booking query filter by Dublin today | a | LZ-today | arg (locationId; user.activeLocation.timezone already loaded) |
| src/app/(members)/bookings/page.js:61 | isPast/isToday booking row flags by Dublin today | a | LZ-today | arg (user.activeLocation.timezone already loaded) |
| src/app/(sales)/contacts/[id]/page.js:301 | contact upcoming/past bookings split by Dublin today | a | LZ-today | row.location_id (contact/booking location_id) |
| src/components/BookingSkipReminderToggle.jsx:35 | hides toggle for bookings before Dublin today | a | LZ-today | NS: bookings page passes today/zone prop (user.activeLocation.timezone) |
| src/components/BookingWidget.jsx:73 | detects viewer zone, Dublin fallback, for footer label only | b | LZ-fmt (use event.locations.timezone; slots are studio wall-clock) | row.location_id (timezone already in GET /api/public/bookings/[slug] payload) |
| src/components/BookingWidget.jsx:75 | Dublin fallback when Intl zone detection throws | b | LZ-fmt (use event.locations.timezone) | row.location_id (already in public bookings payload) |
| src/components/BookingWidget.jsx:411 | footer claims slots shown in viewer zone, Dublin fallback | b | LZ-fmt (label location zone; slots are not converted) | row.location_id (already in public bookings payload) |
| src/lib/booking-confirmations.js:48 | booking email weekday/date label, noon-UTC anchor in Dublin | b | PURE: format DATE in UTC (or LZ-fmt) | n/a |
| src/lib/booking-slots.js:73 | public/Mia slot range check vs Dublin today | a | LZ-today | row.location_id (event_types.location_id) |
| src/lib/booking-slots.js:107 | today's past slots filtered by Dublin minute-of-day | a | LZ-parts (nowMinutesIn) | row.location_id (event_types.location_id) |
| src/lib/booking-slots.js:111 | available-day label, noon-UTC anchor in Dublin | b | PURE: format DATE in UTC (or LZ-fmt) | n/a |
| src/lib/booking-slots.js:122 | available-days horizon starts at Dublin today | a | LZ-today | row.location_id (event_types.location_id) |
| src/lib/bridge-samples.js:654 | private Dublin wall-clock to instant for booking match | a | LZ-wall | arg (locationId in caller) |
| src/lib/class-booking-processor.js:20 | class label for approval card/customer copy in Dublin | b | LZ-fmt | row.location_id (request.location_id) |
| src/lib/manual-booking-confirm-copy.js:28 | {class_time} in manual-booking confirm email, Dublin wall clock | b | LZ-fmt | arg (sendManualBookingConfirmEmail has locationId; pass zone to formatClassTime) |
| src/lib/manual-timetable.js:13 | DUBLIN constant feeds slot wall-clock solve and day labels | a | LZ-wall + LZ-fmt (zone param) | NS (readManualClasses has locationId; pass zone into manualClassOccurrences) |
| src/lib/manual-timetable.js:191 | private Dublin wall-clock to instant for operator timetable slots | a | LZ-wall | NS (same: caller passes zone) |
| src/lib/manual-timetable.js:211 | timetable window starts on Dublin today | a | LZ-today | NS (same: caller passes zone) |
| src/lib/public-classes.js:12 | public class day/time/day_label formatted Dublin ? day groups picker | b | LZ-fmt (shapePublicClass takes zone) | arg (readPublicClasses locationId) |

### TZ.8a — rostering, shifts, swaps, availability, staff push (57 rows, 29 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| shared/working-time.js:114 | private Dublin wall-clock→instant for rest-gap/48h advisories | a | LZ-wall zonedWallClockToInstant | row.location_id (assignment row, optional today) |
| src/app/(team)/schedule/availability/page.js:24 | availability editor 'today' (first editable day) is Dublin day | a | LZ-today | arg (user.activeLocation.timezone already loaded; or resolveStaffTimeZone) |
| src/app/api/calendar-feed/[file]/route.js:69 | staff ICS feed window centred on Dublin today ? edge-days only | a | LZ-today | NS (person feed spans studios; use staff home zone via resolveStaffTimeZone) |
| src/app/api/schedule/availability/route.js:47 | own availability read from Dublin today | a | LZ-today | NS (personal, cross-studio; staff home zone via resolveStaffTimeZone) |
| src/app/api/schedule/availability/route.js:85 | started/ended availability rules judged on Dublin today | a | LZ-today | NS (personal, cross-studio; staff home zone via resolveStaffTimeZone) |
| src/app/api/schedule/blocks/[id]/offer/route.js:52 | offer refusal past-check on Dublin today; tz already in scope | a | LZ-today (use block.locations.timezone) | arg (tz from block.locations) |
| src/app/api/schedule/blocks/[id]/route.js:266 | past-shift confirm gate on Dublin today | a | LZ-today | row.location_id (locations.timezone already embedded) |
| src/app/api/schedule/swaps/[id]/route.js:211 | drop on past block stamped notified, Dublin today | a | LZ-today | row.location_id (block.location_id) |
| src/app/api/schedule/swaps/[id]/route.js:314 | swap move logs: past-block check on Dublin today | a | LZ-today | row.location_id (e.block.location_id) |
| src/app/api/schedule/swaps/route.js:189 | refuses swap of a shift dated before Dublin today | a | LZ-today | row.location_id (shift_blocks.location_id) |
| src/app/api/schedule/swaps/route.js:219 | refuses target shift dated before Dublin today | a | LZ-today | row.location_id (shift_blocks.location_id) |
| src/app/api/schedule/templates/[id]/route.js:129 | future-block regeneration cutoff on Dublin today | a | LZ-today | arg (priorTemplate.location_id) |
| src/app/api/schedule/templates/[id]/route.js:509 | clears empty future blocks from Dublin today | a | LZ-today | arg (locationId) |
| src/lib/availability-move-notice.js:83 | log text only; quiet hours already per studio zone | a | ALREADY (staff-push-hours; migrate import) | fan-out |
| src/lib/availability-notify.js:101 | log text only; studio band already per-location zone | a | ALREADY (staff-push-hours; migrate import) | fan-out |
| src/lib/availability-notify.js:203 | "changes from" day of availability save = Dublin day | a | LZ-day | row (coach's studios list; home studio) |
| src/lib/block-edit-notify.js:142 | time-change read block_date >= Dublin today; wall clock per studio | a | LZ-day (per location; read from min day) | fan-out |
| src/lib/block-edit.js:228 | notice day = Dublin today mixed with studio wall clock | a | LZ-day | arg (timeZone already passed) |
| src/lib/block-edit.js:243 | shift-over check: Dublin today vs studio wall clock | a | LZ-day | arg (timeZone already passed) |
| src/lib/roster-change-format.js:241 | stamp means told? block_date vs Dublin day of notified_at | a | LZ-day | row.location_id |
| src/lib/roster-change-format.js:254 | "told 14:02" time label in Dublin | b | LZ-fmt | row.location_id |
| src/lib/roster-change-format.js:255 | told day for label in Dublin | b | LZ-fmt | row.location_id |
| src/lib/roster-change-format.js:257 | same-day check deciding label wording only | b | LZ-fmt | row.location_id |
| src/lib/roster-change-format.js:266 | change byline date + time in Dublin | b | LZ-fmt | row.location_id |
| src/lib/roster-change-notify.js:139 | past/future change split vs Dublin today; callers omit todayStr | a | LZ-today | arg (locationId → getLocationZone) |
| src/lib/roster-compare-format.js:44 | publish instant label via private Dublin parts formatter | b | LZ-fmt | NS (caller passes roster's location zone) |
| src/lib/roster-compare.js:244 | resolveTz(locations.timezone) for ended-shift judgement | a | ALREADY (tz-time; migrate import) | arg |
| src/lib/roster-notify.js:245 | renotify skips past blocks vs Dublin today; callers omit | a | LZ-today | arg (locationId → getLocationZone) |
| src/lib/roster-publish.js:402 | budget impact today split, Dublin default; callers omit | a | LZ-today | arg (locationId → getLocationZone) |
| src/lib/roster-publish.js:442 | batch budget impact today, Dublin default; callers omit | a | LZ-today | fan-out (byLocation map) |
| src/lib/roster-publish.js:966 | trimmed remnant past/future vs Dublin today; callers omit | a | LZ-today | NS (caller passes roster's location zone) |
| src/lib/roster-runway-data.js:41 | runway weeks from Dublin today; web callers omit | a | LZ-today | fan-out (locationIds) |
| src/lib/roster-runway-notify.js:51 | own fallback zone constant for bad location tz | a | ALREADY (own resolver → resolveTz/PLATFORM_TZ) | fan-out |
| src/lib/roster-runway-notify.js:91 | invalid/null location tz falls back to Dublin | a | ALREADY (own resolver → resolveTz) | fan-out |
| src/lib/roster-runway-notify.js:129 | runway cron "today" = Dublin day for every studio | a | LZ-day | fan-out |
| src/lib/roster-runway-notify.js:152 | log text only; send window already per location | a | ALREADY | fan-out |
| src/lib/roster-staffing.js:57 | Today chip week window from Dublin today; callers omit | a | LZ-today (+ week end) | fan-out (locationIds) |
| src/lib/shift-arrivals.js:120 | resolveTz per location from facts.timezones | a | ALREADY (tz-time; migrate import) | row.location_id |
| src/lib/shift-arrivals.js:168 | arrival local date via dayStrInTz per location | a | ALREADY (→ dayStrIn) | row.location_id |
| src/lib/shift-reminders.js:95 | fallback zone for unknown location tz | a | ALREADY (→ PLATFORM_TZ fallback) | fan-out |
| src/lib/shift-reminders.js:213 | shift window in location tz, Dublin fallback | a | ALREADY | row.location_id |
| src/lib/shift-reminders.js:286 | quiet-hours zones per location in play | a | ALREADY | row.location_id |
| src/lib/shift-reminders.js:290 | reminder plan in run's location tz | a | ALREADY | row.location_id |
| src/lib/shift-reminders.js:363 | "today/tomorrow" push wording vs Dublin day | a | LZ-day | row.location_id (run[0]) |
| src/lib/shift-reminders.js:465 | log text only; zone per location | a | ALREADY | fan-out |
| src/lib/shift-reminders.js:477 | reads shifts Dublin today..tomorrow for all studios | a | LZ-day (span min..max over zones) | fan-out |
| src/lib/shift-replace-notify.js:72 | held replace rows block_date >= Dublin today; cron omits | a | LZ-today | row.location_id (widen read, filter per row) |
| src/lib/shift-replace-notify.js:109 | log text only; band/started already per location | a | ALREADY | row.location_id |
| src/lib/staff-calendar-feed.js:63 | '24:00' end validated via dayStartMsInTz, location zone | a | ALREADY (tz-time; migrate import) | arg (location) |
| src/lib/staff-calendar-feed.js:64 | '24:00' end = next local day start, location zone | a | ALREADY (tz-time; migrate import) | arg (location) |
| src/lib/staff-calendar-feed.js:66 | ICS shift instant via wallMsInTz in location zone | a | ALREADY (tz-time; migrate import) | arg (location) |
| src/lib/staff-calendar-feed.js:98 | resolveTz(location.timezone) for feed events | a | ALREADY (tz-time; migrate import) | arg (location) |
| src/lib/staff-push-hours.js:29 | fallback zone constant for staff quiet hours | a | ALREADY (→ PLATFORM_TZ) | n/a |
| src/lib/staff-push-hours.js:71 | invalid/null tz resolves to Dublin fallback | a | ALREADY (parallel resolver → resolveTz) | arg |
| src/lib/swap-cover-server.js:199 | log text only; zones read per studio | a | ALREADY | fan-out |
| src/lib/swap-cover-server.js:208 | log text only; invalid zone warned per studio | a | ALREADY | fan-out |
| src/lib/swap-cover.js:252 | shift start via wallMsInTz in studio zone | a | ALREADY (tz-time; migrate import) | arg |

### TZ.8b — time off, attendance, contracts, equipment, qualifications, checklists (38 rows, 25 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| src/app/api/attendance/geofence-checkin/route.js:107 | reads location.timezone, literal Dublin fallback | a | ALREADY; swap fallback for resolveTz/getLocationZone | row.location_id (location row read) |
| src/app/api/attendance/route.js:68 | default report date range anchored on Dublin today | a | LZ-today (read location before parsing query) | arg (locationId from withAuth) |
| src/app/api/attendance/route.js:83 | resolveTz(location.timezone) turns shift wall-clock into instants | a | ALREADY; migrate import to location-time | arg (locationId) |
| src/app/api/equipment/due/route.js:25 | today echoed for dormant location, Dublin | a | LZ-today | arg (locationId from withAuth) |
| src/app/api/equipment/due/route.js:29 | due-list cutoff on Dublin today | a | LZ-today | arg (locationId from withAuth) |
| src/app/api/equipment/inspections/[id]/submit/route.js:134 | next due date rolled forward from Dublin today | a | LZ-today | row.location_id (inspection/withAuth locationId) |
| src/app/api/equipment/inspections/[id]/submit/route.js:270 | last_inspected_on stamped with Dublin date | a | LZ-today | row.location_id (inspection/withAuth locationId) |
| src/app/api/equipment/route.js:77 | first due date snapped from Dublin today | a | LZ-today | arg (locationId) |
| src/app/api/qualifications/route.js:32 | qualification expiry judged against Dublin today | a | LZ-today | arg (location_id param) |
| src/app/api/schedule/time-off/[id]/cancel-request/route.js:108 | open cancel-ask check vs Dublin today | a | LZ-today | row.location_id (time_off_requests.location_id) |
| src/app/api/schedule/time-off/[id]/route.js:120 | self-cancel mode / ended leave on Dublin today | a | LZ-today | row.location_id (existing.location_id) |
| src/app/api/schedule/time-off/[id]/unassign-clashes/route.js:67 | leave clashes from Dublin today onward | a | LZ-today | row.location_id (leave.location_id) |
| src/app/api/schedule/time-off/route.js:115 | expired/pending leave list filter on Dublin today | a | LZ-today ? multi-studio list filter | arg (locationId when given; else viewer's zone) |
| src/app/api/schedule/time-off/route.js:535 | clash lookup for approved leave from Dublin today | a | LZ-today per row (compute inside loop) | row.location_id (approved row) |
| src/app/api/schedule/time-off/route.js:609 | own published shifts in leave preview from Dublin today | a | LZ-today | arg (locationId filed against) |
| src/components/AttendanceReportClient.jsx:26 | default attendance period start from Dublin today | a | LZ-today | NS: page passes user.activeLocation.timezone as prop |
| src/components/AttendanceReportClient.jsx:27 | default attendance period end from Dublin today | a | LZ-today | NS: page passes user.activeLocation.timezone as prop |
| src/components/ExpensesManager.jsx:474 | expense item date defaults to Dublin today ? input default only | a | LZ-today | row.location_id (claim location; locations prop carries timezone) |
| src/components/TimeOffManager.jsx:947 | time-off start min date is Dublin today | a | LZ-today | arg (user prop; user.activeLocation.timezone already loaded) |
| src/components/TimeOffManager.jsx:958 | time-off end min date is Dublin today | a | LZ-today | arg (user prop; user.activeLocation.timezone already loaded) |
| src/components/maintenance/EquipmentTab.jsx:79 | equipment "due today" uses Dublin day | a | LZ-today | NS: add timezone to GET /api/equipment payload (or page prop) |
| src/lib/allowance-year.js:16 | default allowance year = Dublin calendar year | a | LZ-today (year slice) | NS (caller passes staff member's studio zone) |
| src/lib/approvals/providers/time-off-cancellations.js:91 | open cancel-ask queue filtered against Dublin today | a | LZ-today | arg (viewer activeId → getLocationZone) |
| src/lib/approvals/providers/time-off-cancellations.js:124 | cancel-ask count filtered against Dublin today | a | LZ-today | arg (viewer activeId → getLocationZone) |
| src/lib/approvals/providers/time-off.js:42 | pending leave queue + clash count from Dublin today | a | LZ-today | arg (viewer activeId → getLocationZone) |
| src/lib/approvals/providers/time-off.js:90 | pending leave count end_date >= Dublin today | a | LZ-today | arg (viewer activeId → getLocationZone) |
| src/lib/attendance-report.js:129 | resolveTz(locations.timezone) for shift windows | a | ALREADY (tz-time; migrate import to location-time) | arg |
| src/lib/checklist-instances.js:51 | private todayInTimezone(location.timezone); null → Dublin | a | ALREADY (own Intl resolver → todayStrIn/instantToZonedParts) | arg (location.timezone) |
| src/lib/checklist-instances.js:79 | private wall→UTC solver for deadline; null → Dublin | a | ALREADY (own solver → LZ-wall) | arg (location.timezone) |
| src/lib/contract-pdf.js:255 | signature timestamp printed Dublin wall-clock in PDF | b | LZ-fmt | NS (thread contract's location zone into PDF) |
| src/lib/contractor-invoice-email.js:123 | invoice "Approved at" via the implicit Dublin default | b | LZ-fmt (inv.location_id) | row.location_id |
| src/lib/contractor-invoice-email.js:135 | text twin of :123 | b | LZ-fmt | row.location_id |
| src/lib/contracts-email.js:278 | "signed on" via the implicit Dublin default | b | LZ-fmt (contract.location_id) | row.location_id |
| src/lib/contracts.js:81 | {{today}} contract variable = Dublin today | a | LZ-today | NS (caller passes issuing location zone) |
| src/lib/qualification-digest.js:238 | digest day, week key, expiry window = Dublin day | a | LZ-day (week key per org) | fan-out (org's studios' zone) |
| src/lib/qualification-digest.js:277 | log text only; quiet hours already per location | a | ALREADY (staff-push-hours) | fan-out |
| src/lib/time-off-cancel.js:294 | re-ask retry label time in Dublin | b | LZ-fmt | row.location_id (time_off_requests) |
| src/lib/time-off-cancel.js:296 | re-ask retry label date in Dublin | b | LZ-fmt | row.location_id (time_off_requests) |

### TZ.9 — events, races, hyrox, host (22 rows, 15 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| shared/events.js:48 | todayIsoDublin: events upcoming/past split, races today | a | LZ-today | NS (callers pass zone: welcome location, host location, viewer for /api/events) |
| src/app/api/public/entry/[token]/move-options/route.js:47 | past-event move block uses Dublin today | a | LZ-today | row.location_id (reg.race.location_id) |
| src/app/api/public/entry/[token]/move/route.js:97 | past-event move block uses Dublin today | a | LZ-today | row.location_id (reg.race.location_id) |
| src/app/api/public/entry/[token]/route.js:104 | entry page move block uses Dublin today | a | LZ-today | row.location_id (race.location_id selected) |
| src/app/api/public/events/[slug]/waitlist/route.js:73 | refuses waitlist join if race_date before Dublin today | a | LZ-today | row.location_id (race_events row) |
| src/lib/event-attendee-reminders.js:122 | reminder date label via the implicit Dublin default | b | LZ-fmt (race.location_id) | row.location_id |
| src/lib/event-attendee-reminders.js:219 | event reminder D-3/D-1 targets from Dublin today | a | LZ-today | row.location_id (per event; widen date query, filter per zone) |
| src/lib/event-waitlist.js:168 | waitlist offer date label via the implicit Dublin default | b | LZ-fmt (race.location_id) | row.location_id |
| src/lib/event-waitlist.js:616 | waitlist offers/expiry use Dublin today for every event | a | LZ-today | row.location_id (per race_event) |
| src/lib/host-move-session.js:64 | host move targets fenced to race_date >= Dublin today | a | LZ-today | NS (host anchor location or per-event zone) |
| src/lib/host-schedule-time.js:19 | module zone constant for host scheduled sends | a | LZ-wall (whole module zone-parameterised) | NS (caller passes host location zone; browser + route) |
| src/lib/host-schedule-time.js:37 | private Dublin parts reader for wall-clock to instant | a | LZ-wall / LZ-parts | NS (caller passes host location zone) |
| src/lib/host-schedule-time.js:42 | weekday label for scheduled-send display in Dublin | b | LZ-fmt | NS (caller passes host location zone) |
| src/lib/hyrox/expand-runner.js:13 | hyrox expansion "today" = Dublin, computed once for all blocks | a | LZ-today | fan-out (blocks loop, block.location_id) |
| src/lib/hyrox/mapping.js:15 | occurrence instant to Dublin date for week/slot mapping | a | LZ-day | NS (callers pass block location zone) |
| src/lib/hyrox/reminder-runner.js:117 | coach push class time rendered in Dublin | b | LZ-fmt | row.location_id (block.location_id) |
| src/lib/public-events.js:26 | "registration opens" date label in Dublin | b | LZ-fmt | row.location_id (race_events row) |
| src/lib/race-confirmations.js:34 | race confirmation date via the implicit Dublin default | b | LZ-fmt (race.location_id) | row.location_id |
| src/lib/registration-move.js:63 | evaluateMove refuses target race_date before Dublin today | a | LZ-today | row.location_id (targetEvent.location_id) |
| src/lib/registration-move.js:287 | move-target list filters race_date >= Dublin today (cross-studio) | a | LZ-today (per target row) | row.location_id (race_events.location_id; post-filter per row) |
| src/lib/registration-move.js:373 | checkMove default today; no caller passes it | a | LZ-today | row.location_id (target event) |
| src/lib/registration-move.js:437 | moveRegistration default today; no caller passes it | a | LZ-today | row.location_id (target event) |

### TZ.10 — climate, Sonos, Shelly, AC (25 rows, 12 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| src/app/(marketing)/automations/shelly/page.js:68 | passes location.timezone to Shelly client, DEFAULT_TZ fallback | a | ALREADY (swap DEFAULT_TZ import for PLATFORM_TZ from location-time) | row.location_id (location.timezone already read) |
| src/app/api/shelly/devices/[id]/energy/route.js:96 | energy day range end in active location tz | a | ALREADY (requestTz reads activeLocation.timezone); migrate import | row.location_id (user.activeLocation) |
| src/app/api/shelly/devices/[id]/toggle/route.js:298 | override expiry = next local midnight in location tz | a | ALREADY (requestTz); migrate import | row.location_id (user.activeLocation) |
| src/app/api/sonos/schedules/[id]/run-now/route.js:77 | run-now window day in Dublin; planAction windows also Dublin | a | LZ-day + thread zone into planAction/resolveServeWindows | arg (user.activeLocation / schedule.location_id) |
| src/components/automations/ShellyDeviceCard.jsx:134 | override "until" label today via location tz | b | ALREADY (migrate dayStrInTz import to location-time dayStrIn) | arg (locationTz) |
| src/components/automations/ShellyDeviceCard.jsx:135 | override "until" label day via location tz | b | ALREADY (migrate dayStrInTz import to location-time dayStrIn) | arg (locationTz) |
| src/components/automations/SonosScheduleClient.jsx:49 | Sonos last-acted/window times rendered in Dublin | b | LZ-fmt | NS: add timezone to GET /api/sonos/schedules payload (or page prop) |
| src/components/automations/SonosScheduleClient.jsx:120 | health check resolves today's serve windows on Dublin day | a | LZ-day (must mirror sonos cron's zone) | NS: add timezone to GET /api/sonos/schedules payload |
| src/components/automations/SonosScheduleClient.jsx:176 | "off until midnight" override: today key in Dublin | a | LZ-range (nextLocalMidnightMs) | NS: add timezone to GET /api/sonos/schedules payload |
| src/components/automations/SonosScheduleClient.jsx:177 | adds one day to Dublin today key | a | LZ-range (addDaysIn; fold into nextLocalMidnightMs) | NS: add timezone to GET /api/sonos/schedules payload |
| src/components/automations/SonosScheduleClient.jsx:178 | override until = Dublin midnight instant | a | LZ-range (dayStartMsIn / nextLocalMidnightMs) | NS: add timezone to GET /api/sonos/schedules payload |
| src/lib/class-climate.js:19 | recurring excluded-slot key from Dublin weekday+HH:MM | a | LZ-parts | row.location_id (occurrence; browser card needs zone too) |
| src/lib/fleet-health.js:340 | fleet alert line shows class start in Dublin | b | LZ-fmt | row.location_id (occurrence) |
| src/lib/schedule/desired-state.js:66 | null/'' tz → Dublin, else caller's zone | a | ALREADY (tz-time DEFAULT_TZ → PLATFORM_TZ) | arg |
| src/lib/schedule/desired-state.js:75 | window boundary via tz-time in passed zone | a | ALREADY (tz-time; migrate import) | arg |
| src/lib/schedule/desired-state.js:145 | default used: sonos/groups.js:89 omits tz → Dublin windows | a | ALREADY engine; Sonos caller must pass zone | NS (Sonos schedule → location zone) |
| src/lib/schedule/desired-state.js:155 | overnight-tail day start via tz-time in zone | a | ALREADY (tz-time; migrate import) | arg |
| src/lib/shelly/device-load.js:86 | request zone resolved from activeLocation.timezone | a | ALREADY (migrate tz-time import to location-time) | arg (user.activeLocation) |
| src/lib/shelly/reconcile.js:187 | locationTz resolves locations.timezone with warn on invalid | a | ALREADY (migrate import) | row.location_id (conn.locations.timezone) |
| src/lib/shelly/reconcile.js:219 | location's local day for today's occurrences | a | ALREADY (migrate import) | arg (tz) |
| src/lib/shelly/reconcile.js:220 | location-local day start bound | a | ALREADY (migrate import) | arg (tz) |
| src/lib/shelly/reconcile.js:221 | location-local next-midnight end bound | a | ALREADY (migrate import) | arg (tz) |
| src/lib/shelly/reconcile.js:419 | location's local dateStr for device planning | a | ALREADY (migrate import) | fan-out (per connection tz) |
| src/lib/shelly/reconcile.js:854 | location's local dateStr for forced single-device apply | a | ALREADY (migrate import) | row.location_id (conn) |
| src/lib/sonos/reconcile.js:63 | one Dublin dateStr for every location's Sonos schedules | a | LZ-today (per location; also thread tz into planAction/resolveServeWindows) | fan-out (byLocation loop) |

### TZ.11a — reports, dashboards, briefings, snapshots, cars (35 rows, 15 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| shared/dashboard-data.js:533 | revenue MTD lazily loads Dublin calendar helpers | a | LZ-range (load location-time + getLocationZone) | arg (locationId) |
| shared/dashboard-data.js:535 | revenue MTD: today's Dublin y/m/d | a | LZ-today | arg (locationId) |
| shared/dashboard-data.js:536 | revenue MTD: Dublin month start for invoice_date filter | a | LZ-range monthStartMsIn | arg (locationId) |
| shared/dashboard-data.js:542 | revenue MTD: last month same-day-window range in Dublin | a | LZ-range dayRangeMsIn | arg (locationId) |
| shared/dashboard-data.js:599 | funnel counts lazily load Dublin month start | a | LZ-range (load location-time) | arg (locationId) |
| shared/dashboard-data.js:600 | funnel entered/converted since Dublin month start | a | LZ-range monthStartMsIn | arg (locationId) |
| shared/dashboard-data.js:687 | today-ops strip lazily loads Dublin helpers | a | LZ-range (load location-time) | arg (locationId) |
| shared/dashboard-data.js:689 | today-ops: Dublin today for bookings.booking_date | a | LZ-today | arg (locationId) |
| shared/dashboard-data.js:695 | today-ops: Dublin day range for class_occurrences.starts_at | a | LZ-range dayRangeMsIn | arg (locationId) |
| shared/dashboard-data.js:696 | today-ops: Dublin week start for labour week | a | LZ-range weekStartMsIn | arg (locationId) |
| src/app/api/cars/reports/export/route.js:64 | cars export year floor, host-local (UTC) | a | LZ-range | row.location_id |
| src/app/api/cron/ad-report-email/route.js:26 | report date label in ad email subject, Dublin | b | LZ-fmt (per loc; or EXT:Meta account day) | fan-out (loc loop; select timezone) |
| src/app/api/cron/morning-briefing/route.js:57 | briefing email date label, Dublin, hoisted outside location loop | b | LZ-fmt per location | fan-out (loc loop; select timezone) |
| src/app/api/dashboard/studio-contacts/route.js:69 | "this week" contact counts start at Dublin Monday | a | LZ-range (weekStartMsIn) | arg (location_id query param) |
| src/app/dashboard/today/page.js:164 | personal dashboard "today" (shifts/tasks) is Dublin day | a | LZ-today | arg (user.activeLocation.timezone already loaded) |
| src/components/TasksPage.jsx:340 | task overdue flag vs Dublin today | a | LZ-today | NS: page passes zone prop with locationId (user.activeLocation.timezone) |
| src/lib/account-home.js:77 | 7-day bookings window end = Dublin today, shared by every studio | a | LZ-today (compute window per studio) | fan-out (assembleAccountHome maps locations) |
| src/lib/account-home.js:213 | pending time-off counted unless end_date before Dublin today | a | LZ-today | arg (locationId) |
| src/lib/cars.js:307 | CCF Autos year-to-date floor, host-local (UTC) | a | LZ-range (car location) | row.location_id |
| src/lib/cars.js:308 | CCF Autos month-to-date floor, host-local (UTC) | a | LZ-range | row.location_id |
| src/lib/cars.js:388 | CCF Autos monthly buckets, host-local (UTC) | a | LZ-key | row.location_id |
| src/lib/invoices-queue/enqueue.js:125 | receiptless expense Xero bill date falls back to Dublin today | a | LZ-today (bill date for location's Xero org) | row.location_id (claim.location_id in caller; thread zone into syntheticFieldsForReceiptlessItem) |
| src/lib/labour-month-model.js:50 | labour month = Dublin month holding now | a | LZ-day + LZ-key | NS (caller passes active studio/org zone) |
| src/lib/labour-month-model.js:56 | month start/end instants + elapsed fraction in Dublin | a | LZ-range | NS (same zone as :50) |
| src/lib/membership-flows.js:55 | current month for 12-month sales/cancels series = Dublin today | a | LZ-today | arg (locationId) |
| src/lib/membership-flows.js:89 | new-sale invoice bucketed into Dublin month | a | LZ-key (monthKeyIn) | arg (locationId) |
| src/lib/membership-flows.js:95 | cancellation bucketed into Dublin month | a | LZ-key (monthKeyIn) | arg (locationId) |
| src/lib/membership-snapshot.js:94 | daily snapshot_date (upsert idempotency key) = Dublin day | a | LZ-day | arg (locationId; cron fan-out) |
| src/lib/membership-snapshot.js:109 | trend window start N months before Dublin today; default never passed | a | LZ-today | arg (fetchMembershipTrend locationId; pass todayStr) |
| src/lib/report-generator.js:590 | scheduled report "yesterday" from host-local Date (UTC on Vercel) | a | LZ-today then `addDaysIn(-1)` | row.location_id (schedule) |
| src/lib/report-generator.js:602 | monthly report period from host-local month (UTC on Vercel) | a | LZ-key monthKeyIn | row.location_id |
| src/lib/report-generator.js:603 | monthly report period end, host-local | a | LZ-range | row.location_id |
| src/lib/report-generator.js:666 | next monthly run, host-local month length | a | LZ-wall (07:00 local on the target day) | row.location_id |
| src/lib/report-generator.js:668 | next run "07:00 local" is 07:00 UTC on Vercel | a | LZ-wall | row.location_id |
| src/lib/today-feed-data.js:166 | low-fill class time label in Dublin | b | LZ-fmt | arg (locationId) |

### TZ.11b — billing month (only if D5 = A) (22 rows, 13 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| src/app/api/cron/usage-rollup/route.js:39 | platform usage rollup + cap-notice month on Dublin day | c (D5) | PLATFORM (operator usage ledger) | n/a |
| src/app/api/cron/wallet-monthly-reset/route.js:50 | wallet billing-month boundary on Dublin today ? platform billing month | c (D5) | PLATFORM (billing ledger; else LZ-key per wallet) | fan-out (wallet.location_id) if reclassed |
| src/app/api/cron/wallet-overage-draws/route.js:87 | overage draw billing month from Dublin today | c (D5) | PLATFORM (must match usage_rollups_daily Dublin days) | n/a |
| src/app/settings/billing/page.js:58 | wallet ledger/invoice timestamps in Dublin ? platform billing ledger | c (D5) | PLATFORM (wallet month-end expiry is Dublin) | n/a |
| src/lib/admin-tenants.js:119 | top-ups bucketed into Dublin billing month (master tenants console) | c (D5) | PLATFORM | n/a |
| src/lib/admin-tenants.js:341 | master roster default today = Dublin, drives platform billing month | c (D5) | PLATFORM | n/a |
| src/lib/admin-tenants.js:397 | AI usage events filtered to Dublin billing month, master console | c (D5) | PLATFORM | n/a |
| src/lib/admin-tenants.js:470 | master tenant detail default today = Dublin billing date | c (D5) | PLATFORM | n/a |
| src/lib/admin-tenants.js:551 | AI usage events filtered to Dublin billing month, master console | c (D5) | PLATFORM | n/a |
| src/lib/billing-page.js:81 | wallet lapse warning days-left in Dublin billing month ? platform ledger | c (D5) | PLATFORM | n/a |
| src/lib/billing-page.js:230 | tenant billing page today = Dublin, billing month boundary ? platform ledger | c (D5) | PLATFORM | n/a |
| src/lib/billing-page.js:232 | MTD usage start = Dublin midnight of billing month ? platform ledger | c (D5) | PLATFORM | n/a |
| src/lib/integrations-hub.js:1291 | plan/wallet strip billing month from Dublin today ? platform ledger | c (D5) | PLATFORM | n/a |
| src/lib/plans.js:97 | platform plan-version effective date picked on Dublin today | c (D5) | PLATFORM | n/a |
| src/lib/plans.js:198 | platform plan catalogue feature lookup on Dublin today | c (D5) | PLATFORM | n/a |
| src/lib/usage-caps.js:24 | org hard-cap month start from Dublin today ? platform metering month | c (D5) | PLATFORM | n/a |
| src/lib/wallet-enforcement.js:196 | billing-month start instant at Dublin midnight | c (D5) | PLATFORM | n/a |
| src/lib/wallet-enforcement.js:197 | billing-month end instant at Dublin midnight | c (D5) | PLATFORM | n/a |
| src/lib/wallet-enforcement.js:307 | billing window anchored on Dublin today | c (D5) | PLATFORM | n/a |
| src/lib/wallet-topup.js:395 | VAT invoice date (Irish issuer Champ Fitness Ltd) in Dublin | c (D5) | PLATFORM | n/a |
| src/lib/wallet.js:81 | wallet period reset decided on Dublin today | c (D5) | PLATFORM | n/a |
| supabase/migrations/420_wallets.sql:129 | `wallet_apply` seeds `period_start` to the Dublin calendar month | c (D5) | if D5=A: `date_trunc('month', now() AT TIME ZONE <location tz>)` | row.location_id (p_location_id) |

### TZ.11c — external zones (Meta ad account, Xero) (11 rows, 8 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| shared/dashboard-data.js:641 | ads summary lazily loads Dublin helpers | d | EXT:Meta (ad account tz for ad_insights_daily.date) | arg (locationId → ad account) |
| shared/dashboard-data.js:643 | ads since = Dublin today minus 7 vs ad_insights_daily.date | d | EXT:Meta (ad account tz) | arg (locationId → ad account) |
| src/app/api/accounting/payables/route.js:51 | ages Xero unpaid bills against Dublin today | d | EXT:Xero org-local due dates (1 org = 1 location, so location zone) | row.location_id (user.activeLocation) |
| src/app/api/accounting/payables/route.js:52 | asOf date returned with aged payables, Dublin today | d | EXT:Xero same zone as line 51 | row.location_id (user.activeLocation) |
| src/app/api/cron/ad-insights-backfill/route.js:18 | manual backfill since/until dates in Dublin | d | EXT:Meta ad_accounts.account_timezone, per account | fan-out (per ad account loop) |
| src/app/api/cron/ad-insights-sync/route.js:18 | yesterday+today Meta insights window in Dublin dates | d | EXT:Meta ad_accounts.account_timezone, per account | fan-out (per ad account loop) |
| src/app/api/dashboard/ads/refresh/route.js:22 | manual Meta refresh since/until in Dublin dates | d | EXT:Meta ad_accounts.account_timezone, per account | row.location_id (accounts at locationId) |
| src/lib/ads/read.js:7 | private Dublin YYYY-MM-DD for ads dashboard since/until window ? Meta account tz | d | EXT:Meta (ad account timezone_name; insights `date` is account-tz) | NS (ad account tz not stored; locationId arg for fallback) |
| src/lib/recon/finalize.js:295 | coverage report date label: one Dublin day for every org | b | LZ-fmt (todayStrIn per bucket, move inside loop) | row.location_id (bucket.locationId) |
| src/lib/recon/pull.js:77 | Xero bank-line window floor from Dublin today | d | EXT:Xero (org timezone; equals location zone) | arg (locationId) |
| src/lib/recon/pull.js:106 | Xero BankTransactions toDate = Dublin today (inclusive) | d | EXT:Xero (org timezone; equals location zone) | arg (locationId) |

### TZ.12 — TV and live boards (4 rows, 4 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| src/app/live/[locationId]/DetectedTab.jsx:329 | detection appearance time rendered in Dublin | b | LZ-fmt | NS: add timezone to GET /api/live/[locationId]/detections payload (or page prop) |
| src/lib/live-board.js:99 | TV current-class starts_at_label rendered Dublin HH:MM | b | LZ-fmt | arg (locationId) |
| src/lib/live-poll.js:27 | board overnight idle back-off 22-06 on Dublin hour; fleet-health quiet reuses | a | LZ-parts | NS (live payloads must carry location timezone; fleet-health passes Pi location zone) |
| src/lib/tv-class-intro.js:78 | preview stand-in class label HH:MM in Dublin | b | LZ-fmt | NS (caller passes TV location zone) |

### TZ.13 — member seam (shared + src/lib twins, champ-app mirror) (57 rows, 19 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| shared/challenges.js:40 | challenge date → Dublin midnight instant (window start) [champ-mirror] | a | LZ-range dayStartMsIn | row.location_id (challenges.location_id) |
| shared/challenges.js:47 | challengePhase end-exclusive = Dublin midnight after ends_on [champ-mirror] | a | LZ-range dayStartMsIn/addDaysIn | row.location_id (challenges.location_id) |
| shared/challenges.js:56 | windowIso end-exclusive feeding standings RPC p_to [champ-mirror] | a | LZ-range dayStartMsIn/addDaysIn | row.location_id (challenges.location_id) |
| shared/coach-kudos.js:75 | kudos older than a month: day+month label in Dublin | b | LZ-fmt | row.location_id (coach_kudos.location_id) |
| shared/customer-notifications.js:110 | goal push once-per-month idempotency key on Dublin calendar [champ-mirror] | a | LZ-key monthKeyIn | member |
| shared/customer-notifications.js:111 | goal push once-per-week idempotency key (Dublin ISO week) [champ-mirror] | a | LZ-key isoWeekKeyIn | member |
| shared/customer-notifications.js:133 | streakAtRisk: yesterday's Dublin date key [champ-mirror] | a | LZ-day + LZ-range | member |
| shared/customer-notifications.js:134 | streakAtRisk: Dublin midnight of yesterday vs lastDayMs [champ-mirror] | a | LZ-range dayStartMsIn | member |
| shared/format.js:32 | sessionDate "Fri, 19 Jun" in Dublin [champ-mirror] | b | MEMBER-zone (formatInZone) | NS (caller passes member zone) |
| shared/goals.js:16 | goal week period start = Dublin Monday [champ-mirror] | a | MEMBER-zone weekStartMsIn | member |
| shared/goals.js:19 | goal month period start = Dublin 1st [champ-mirror] | a | MEMBER-zone monthStartMsIn | member |
| shared/goals.js:97 | periodEnd week: Dublin date 7 days on [champ-mirror] | a | MEMBER-zone LZ-day | member |
| shared/goals.js:98 | periodEnd week: Dublin midnight of next Monday [champ-mirror] | a | MEMBER-zone dayStartMsIn | member |
| shared/goals.js:101 | periodEnd month: Dublin y/m of period start [champ-mirror] | a | MEMBER-zone LZ-day | member |
| shared/goals.js:104 | periodEnd month: Dublin midnight on next 1st [champ-mirror] | a | MEMBER-zone dayStartMsIn | member |
| shared/hr-analytics.js:264 | computeStreak: this session's Dublin day [champ-mirror] | a | MEMBER-zone LZ-day | member |
| shared/hr-analytics.js:265 | computeStreak: history sessions bucketed by Dublin day [champ-mirror] | a | MEMBER-zone LZ-day | member |
| shared/hr-analytics.js:270 | computeStreak cursor starts on session's Dublin day [champ-mirror] | a | MEMBER-zone LZ-day | member |
| shared/hr-analytics.js:301 | currentStreak buckets sessions by Dublin day [champ-mirror] | a | MEMBER-zone LZ-day | member |
| shared/hr-analytics.js:309 | lastDayMs = Dublin midnight of latest day [champ-mirror] | a | MEMBER-zone dayStartMsIn | member |
| shared/hr-analytics.js:311 | currentStreak "today" = Dublin date [champ-mirror] | a | MEMBER-zone LZ-today | member |
| shared/hr-analytics.js:361 | weeklyStreak buckets sessions by Dublin week start [champ-mirror] | a | MEMBER-zone weekStartMsIn | member |
| shared/hr-analytics.js:365 | weeklyStreak this week = Dublin Monday [champ-mirror] | a | MEMBER-zone weekStartMsIn | member |
| shared/hr-analytics.js:367 | previous Dublin week start via mid-week step [champ-mirror] | a | MEMBER-zone weekStartMsIn | member |
| shared/month-wrapped.js:27 | module-scope Dublin y/m formatter picks last completed month | a | MEMBER-zone monthKeyIn | member |
| shared/progress-analytics.js:97 | activity heatmap "today" = Dublin date [champ-mirror] | a | MEMBER-zone LZ-today | member |
| shared/progress-analytics.js:102 | heatmap buckets sessions by Dublin day [champ-mirror] | a | MEMBER-zone LZ-day | member |
| shared/progress-analytics.js:111 | heatmap cell dayMs = Dublin midnight [champ-mirror] | a | MEMBER-zone dayStartMsIn | member |
| shared/session-history.js:65 | history sections grouped by Dublin month | a | MEMBER-zone monthKeyIn | member |
| shared/share-card.js:66 | share card session date "19 Jun" in Dublin [champ-mirror] | b | MEMBER-zone (formatInZone) | member (or session's location) |
| shared/tier-window.js:37 | tier decay window anchored on Dublin month key [champ-mirror] | a | MEMBER-zone monthKeyIn | arg (location.settings already in hand) |
| shared/week-digest.js:29 | digest range label day from Dublin date | b | MEMBER-zone LZ-day (label) | member |
| shared/week-digest.js:63 | digest window upper bound = Dublin Monday | a | MEMBER-zone weekStartMsIn | member |
| shared/week-digest.js:64 | digest window lower bound = last Dublin Monday | a | MEMBER-zone weekStartMsIn | member |
| shared/week-digest.js:70 | digest seen-flag key = Dublin ISO week | a | MEMBER-zone isoWeekKeyIn | member |
| shared/week-digest.js:73 | digest "28 Jun–4 Jul" label from Dublin days | b | MEMBER-zone LZ-day (label) | member |
| src/components/ConsultationForm.jsx:28 | new consultation date defaults to Dublin today | a | MEMBER-zone (LZ-today) | NS: ConsultationsList passes contact's home location zone |
| src/components/ConsultationForm.jsx:30 | invalid date falls back to Dublin today; valid uses UTC day | a | MEMBER-zone (LZ-today; also line 31 toISOString UTC day -> LZ-day) | NS: ConsultationsList passes contact's home location zone |
| src/lib/challenges.js:42 | challenge day start = Dublin midnight (must match SQL RPC) | a | LZ-range | row.location_id (challenges.location_id) |
| src/lib/challenges.js:49 | challenge phase end-exclusive = Dublin midnight after ends_on | a | LZ-range (addDaysIn) | row.location_id (challenges.location_id) |
| src/lib/challenges.js:58 | challenge window end-exclusive = Dublin midnight after ends_on | a | LZ-range (addDaysIn) | row.location_id (challenges.location_id) |
| src/lib/customer-notifications.js:110 | goal push idempotency key = Dublin month | a | MEMBER-zone LZ-key | member |
| src/lib/customer-notifications.js:111 | goal push idempotency key = Dublin ISO week | a | MEMBER-zone LZ-key | member |
| src/lib/customer-notifications.js:133 | streak-at-risk yesterday = previous Dublin day | a | MEMBER-zone LZ-day | member |
| src/lib/customer-notifications.js:134 | yesterday anchor = Dublin midnight | a | MEMBER-zone LZ-range | member |
| src/lib/hr-analytics.js:264 | post-class streak days bucketed by Dublin date | a | MEMBER-zone LZ-day | member |
| src/lib/hr-analytics.js:265 | history sessions bucketed by Dublin date | a | MEMBER-zone LZ-day | member |
| src/lib/hr-analytics.js:270 | streak cursor starts at session's Dublin date | a | MEMBER-zone LZ-day | member |
| src/lib/hr-analytics.js:301 | live streak sessions bucketed by Dublin date | a | MEMBER-zone LZ-day | member |
| src/lib/hr-analytics.js:309 | lastDayMs = Dublin midnight of latest day | a | MEMBER-zone LZ-range | member |
| src/lib/hr-analytics.js:311 | streak "today" = Dublin date | a | MEMBER-zone LZ-day | member |
| src/lib/hr-analytics.js:361 | weekly streak buckets by Dublin Monday | a | MEMBER-zone LZ-range | member |
| src/lib/hr-analytics.js:365 | this week = Dublin Monday | a | MEMBER-zone LZ-range | member |
| src/lib/hr-analytics.js:367 | previous Dublin Monday via mid-week step | a | MEMBER-zone LZ-range | member |
| src/lib/hr-post-class-email.js:522 | post-class email start label via the implicit Dublin default | b | LZ-fmt (session.location_id) | row.location_id |
| src/lib/live-class.js:677 | member tier-decay "current month" keyed on Dublin month | a | MEMBER-zone (LZ-key monthStrIn) | row.location_id (session.location_id) |
| src/lib/onboarding-journey.js:83 | first-N-days journey day index counted in Dublin calendar days | a | MEMBER-zone (LZ-day diff) | member (contact home location) |

### TZ.14 — mobile screens (14 rows, 10 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| mobile/app/(member)/(tabs)/home.jsx:123 | last-week digest window: this week's Dublin Monday for session query | a | LZ-range weekStartMsIn | member (contact.location_id in contact-context) |
| mobile/app/(member)/(tabs)/home.jsx:124 | last-week digest lower bound via Dublin week start | a | LZ-range weekStartMsIn | member (contact.location_id in contact-context) |
| mobile/app/(member)/(tabs)/home.jsx:335 | this-week pips filter sessions since Dublin Monday | a | LZ-range weekStartMsIn | member (contact.location_id in contact-context) |
| mobile/app/(member)/(tabs)/home.jsx:549 | buckets sessions by Dublin day to pick member's usual weekday nudge | a | LZ-day | member (contact.location_id in contact-context) |
| mobile/app/(member)/(tabs)/sessions.jsx:212 | session row start time HH:MM rendered in Dublin | b | MEMBER-zone (formatInZone) | member |
| mobile/app/(member)/(tabs)/sessions.jsx:303 | Strava activity row start time HH:MM rendered in Dublin | b | MEMBER-zone (formatInZone) | member |
| mobile/app/(member)/sessions/[id].jsx:304 | session detail start time HH:MM rendered in Dublin | b | MEMBER-zone (formatInZone) | member |
| mobile/app/(staff)/contracts/[id].jsx:66 | contract issued/signed timestamp shown date+time in Dublin | b | LZ-fmt | row.location_id (contract's issuing studio) |
| mobile/app/(staff)/contracts/index.jsx:27 | contract list issued/signed date shown in Dublin | b | LZ-fmt | row.location_id (contract's issuing studio) |
| mobile/app/(staff)/policies/[slug].jsx:22 | formats date-only effective_date; Dublin pin harmless? date col, not instant | x | PURE (date col: pin timeZone UTC, NOT LZ-fmt) | n/a |
| mobile/app/(staff)/policies/index.jsx:17 | formats date-only effective_date; Dublin pin harmless? date col, not instant | x | PURE (date col: pin timeZone UTC, NOT LZ-fmt) | n/a |
| mobile/components/AcDeviceList.jsx:67 | AC reading "as of HH:MM" in Dublin | b | LZ-fmt | arg (locationId prop) |
| mobile/lib/dates.js:98 | dublinTodayIso: studio "today" for roster grid, availability, time-off minDate | a | LZ-today | NS (caller passes active location / block location zone) |
| mobile/lib/invoice-review.js:57 | "as approved on" invoice snapshot date in Dublin | b | LZ-fmt | NS (payload must carry invoice location zone) |

### TZ.15 — SQL functions, policies, defaults (21 rows, 7 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| supabase/migrations/421_usage_rollup_and_caps.sql:55 | `rollup_usage_for_day`: usage_events bucketed by Dublin day | c (D5) | if D5=A: join locations, `AT TIME ZONE l.timezone` | row.location_id |
| supabase/migrations/421_usage_rollup_and_caps.sql:66 | `rollup_usage_for_day`: email_sends bucketed by Dublin day | c (D5) | as :55 | row.location_id |
| supabase/migrations/421_usage_rollup_and_caps.sql:77 | `rollup_usage_for_day`: agent actions bucketed by Dublin day | c (D5) | as :55 | row.location_id |
| supabase/migrations/421_usage_rollup_and_caps.sql:89 | `rollup_usage_for_day`: whatsapp_messages bucketed by Dublin day | c (D5) | as :55 | row.location_id |
| supabase/migrations/421_usage_rollup_and_caps.sql:110 | `org_ai_spend_month_cents`: month floor on Dublin date | c (D5) | if D5=A: per-location month floor | row.location_id |
| supabase/migrations/421_usage_rollup_and_caps.sql:125 | `org_email_sends_month`: month floor on Dublin date | c (D5) | as :110 | row.location_id |
| supabase/migrations/448_hyrox_class_reminder.sql:51 | `hyrox_coaches_on_shift`: block_date = Dublin date of p_start | a | `(p_start AT TIME ZONE l.timezone)::date`, join `locations l` on b.location_id | row.location_id |
| supabase/migrations/448_hyrox_class_reminder.sql:52 | shift end wall clock compared in Dublin | a | as :51 | row.location_id |
| supabase/migrations/448_hyrox_class_reminder.sql:53 | shift start wall clock compared in Dublin | a | as :51 | row.location_id |
| supabase/migrations/517_list_health_monthly_stats.sql:189 | `list_health_monthly_stats` last month = Dublin month | a | `AT TIME ZONE v_tz` where v_tz = the location's zone (p_location_id) | arg (p_location_id) |
| supabase/migrations/517_list_health_monthly_stats.sql:212 | month grid lower bound in Dublin | a | as :189 | arg |
| supabase/migrations/517_list_health_monthly_stats.sql:215 | sends bucketed by Dublin month | a | as :189 | arg |
| supabase/migrations/517_list_health_monthly_stats.sql:237 | consent log bucketed by Dublin month | a | as :189 | arg |
| supabase/migrations/521_email_source_and_campaign_recipient_stats.sql:107 | `email_sends_monthly_stats` last month = Dublin month | a | as 517:189 | arg (p_location_id) |
| supabase/migrations/521_email_source_and_campaign_recipient_stats.sql:125 | month grid lower bound in Dublin | a | as 517:189 | arg |
| supabase/migrations/521_email_source_and_campaign_recipient_stats.sql:128 | sends bucketed by Dublin month | a | as 517:189 | arg |
| supabase/migrations/622_staff_tombstone.sql:438 | `tombstone_staff_profile`: "not started" cut-off day in Dublin | a | per assignment: `(p_now AT TIME ZONE l.timezone)` joined via the block's location | row.location_id |
| supabase/migrations/622_staff_tombstone.sql:439 | `tombstone_staff_profile`: "not started" cut-off time in Dublin | a | as :438 | row.location_id |
| supabase/migrations/641_shift_offers.sql:240 | `claim_shift_offer` double-booking check compares block_date + wall clock across studios | a | compare instants: `(block_date + start_time) AT TIME ZONE l.timezone` per block | row.location_id |
| supabase/migrations/686_challenges_member_wrapped_window.sql:84 | `challenges_read` RLS: member sees ended challenges for 14 Dublin days | a | `AT TIME ZONE` the challenge location's zone via `private.location_tz(location_id)` | row.location_id |
| supabase/migrations/686_challenges_member_wrapped_window.sql:106 | same expression, in the policy text self-check | a | as :84 | row.location_id |

### TZ.16 — web display-only (27 rows, 24 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| src/app/(team)/contracts/[id]/page.js:35 | contract issued/declined/revoked timestamps in Dublin | b | LZ-fmt | row.location_id (contracts.location_id nullable; fallback org/viewer) |
| src/app/(team)/contracts/[id]/page.js:212 | signature timestamp rendered in Dublin | b | LZ-fmt | row.location_id (contracts.location_id nullable) |
| src/app/(team)/contracts/page.js:41 | contracts list issued date in Dublin | b | LZ-fmt | row.location_id (add location_id + zone to select; cross-studio list else VIEW-fmt) |
| src/app/(team)/contracts/templates/[id]/page.js:23 | template version created_at in Dublin | b | VIEW-fmt | NS (template is org-scoped, no location; viewer's active location zone) |
| src/app/account/contracts/[id]/page.js:26 | staff's own contract dates in Dublin | b | LZ-fmt | row.location_id (contracts.location_id nullable) |
| src/app/account/contracts/[id]/page.js:178 | signature timestamp rendered in Dublin | b | LZ-fmt | row.location_id (contracts.location_id nullable) |
| src/app/account/contracts/page.js:33 | staff's contract list dates in Dublin | b | LZ-fmt | row.location_id (add location_id to select) |
| src/app/communications/(marketing-era)/list-health/page.js:69 | list-health dates rendered as Dublin day | b | LZ-fmt | arg (user.activeLocation.timezone already loaded) |
| src/app/welcome/[location]/status/page.js:88 | public status page "updated" time in Dublin | b | LZ-fmt | row.location_id (add timezone to loadLocation select) |
| src/components/AcControlPanel.jsx:74 | AC reading "as of HH:MM" in Dublin | b | LZ-fmt | NS: add timezone to GET /api/studio-management/ac/devices payload |
| src/components/CalendarFeedCard.jsx:20 | personal calendar feed last-fetched stamp in Dublin | b | VIEW-fmt | NS: staff's active location zone prop (user.activeLocation.timezone) |
| src/components/DealCard.jsx:134 | pipeline card next class date in Dublin | b | LZ-fmt | row.location_id (contact.location_id) |
| src/components/InvoicesManager.jsx:880 | invoice approval day rendered in Dublin | b | LZ-fmt | arg (user prop; user.activeLocation.timezone already loaded) |
| src/components/OfferSalesList.jsx:16 | offer purchase times rendered in Dublin | b | LZ-fmt | NS: offer-sales page passes active location timezone prop |
| src/components/OrderDetail.jsx:412 | order timestamps rendered in Dublin | b | LZ-fmt | NS: add location timezone to GET /api/orders/[id] payload |
| src/components/OrdersTable.jsx:239 | order row created_at in Dublin | b | LZ-fmt (VIEW-fmt when master sees all studios) | NS: add location timezone to GET /api/orders payload |
| src/components/OrdersTable.jsx:464 | mobile order card created_at in Dublin | b | LZ-fmt (VIEW-fmt when unscoped) | NS: add location timezone to GET /api/orders payload |
| src/components/automations/BathroomClimateCard.jsx:23 | climate schedule/history times rendered in Dublin | b | LZ-fmt | NS: page passes location timezone prop with locationId |
| src/components/automations/ClassClimateCard.jsx:23 | climate schedule/history times rendered in Dublin | b | LZ-fmt | NS: page passes location timezone prop with locationId |
| src/components/contact/ContactDrawer.jsx:212 | next class date chip in Dublin | b | LZ-fmt | row.location_id (contact.location_id) |
| src/components/contact/ContactHeaderBand.jsx:187 | next class date chip in Dublin | b | LZ-fmt | row.location_id (contact.location_id) |
| src/components/dashboard/AdsRefreshButton.jsx:13 | ads last-synced stamp in Dublin | b | LZ-fmt | NS: page passes location timezone prop with locationId |
| src/components/host/HostEmailReport.jsx:48 | host email recipient send times in Dublin | b | LZ-fmt (host's location zone) | NS: add timezone to GET /api/host/emails/[id]/recipients payload |
| src/lib/dates.js:158 | email/PDF formatter tz default Dublin; callers never pass one | b | LZ-fmt | NS (callers pass record's location zone) |
| src/lib/email-forward.js:139 | forwarded-mail header timestamp rendered in Dublin | b | LZ-fmt | NS (caller passes mailbox location zone) |
| src/lib/mail/reply-quote.js:95 | reply attribution "On <date> at HH:MM" in Dublin | b | LZ-fmt | row.location_id (mailbox/conversation location) |
| src/lib/sale-offers.js:47 | sale deadline copy "MONDAY 10 AUGUST, 23:59" in Dublin | b | LZ-fmt | row.location_id (sale_offers.location_id) |

### TZ.17 — ⚠️ midnight-hour corrections and zone-less renders (20 rows, 15 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| mobile/app/(member)/(tabs)/home.jsx:538 | challenge countdown "today" from the UTC date (one day too many 00:00-01:00 IST) | a | MEMBER-zone `todayStrIn(zone)` | member |
| shared/progress-analytics.js:18 | best-week points bucketed by UTC week | a | MEMBER-zone `weekStartMsIn` | member |
| shared/progress-analytics.js:45 | `monthlyRecap` bucketed by UTC month | a | MEMBER-zone `monthKeyIn` | member |
| src/app/api/cars/[id]/issue-deposit-link/route.js:134 | car note "expires …" rendered with no zone (UTC on Vercel) | b | LZ-fmt (car.location_id) | row.location_id |
| src/app/api/cron/run-challenge-events/route.js:140 | challenge start compared to the UTC day | a | LZ-today (challenge.location_id) | row.location_id |
| src/components/ConsultationForm.jsx:31 | existing `consulted_at` shown as its UTC day | a | LZ-day | row.location_id |
| src/lib/ads/read.js:80 | booking-request end bound `until + 'T23:59:59'` is UTC | a | LZ-range (`dayRangeMsIn`) | row.location_id |
| src/lib/external-export.js:257 | Strava activity title date with no zone (UTC on Vercel) | b | LZ-fmt (session.location_id) | row.location_id |
| src/lib/goals.js:37 | `startOfMonth` is a UTC month; the bank key beside it is a Dublin month | a | MEMBER-zone `monthStartMsIn` | member |
| src/lib/hr-post-class-email.js:524 | fallback start label with no zone (only if the Intl call throws) | b | LZ-fmt | row.location_id |
| src/lib/live-class.js:645 | month points summed from the UTC month start | a | MEMBER-zone `monthStartMsIn` | member |
| src/lib/live-class.js:696 | month label from `getUTCMonth()` | b | MEMBER-zone `monthKeyIn` | member |
| src/lib/manual-timetable.js:188 | private one-pass solver: a 23:xx slot on the spring-forward day lands a day late | a | LZ-wall | arg |
| src/lib/postmark.js:539 | `{{current_year}}` merge tag, host-local (UTC) | b | LZ-fmt (sending location) | row.location_id |
| src/lib/sequences/cron-triggers.js:112 | booking-date lower bound as a UTC date | a | LZ-day | fan-out (seq.location_id) |
| src/lib/sequences/cron-triggers.js:113 | booking-date upper bound as a UTC date | a | LZ-day | fan-out |
| src/lib/sequences/cron-triggers.js:121 | booking wall clock read as UTC (`…Z`, lint-disabled) | a | LZ-wall | fan-out |
| src/lib/today-feed-data.js:41 | `isoToday()` from host-local getters (UTC on Vercel) | a | LZ-today | arg (locationId) |
| src/lib/whatsapp-flow/handler.js:40 | Flow groups classes by UTC day (`starts_at.slice(0,10)`) | a | LZ-day (`c.day` is already the studio day) | arg (locationId) |
| src/lib/whatsapp-flow/handler.js:58 | Flow filters a day's classes by UTC day | a | LZ-day | arg |

### none — no change (class c/x, or already correct) (52 rows, 26 files)

| File:line | Current behaviour | Class | Target rule | Zone source |
|---|---|---|---|---|
| shared/dashboard-data.js:644 | rolling 7x24h attributed_at window; constant only | x | PURE | n/a |
| shared/dashboard-data.js:697 | week end = week start date string +6 | x | PURE | n/a |
| shared/hr-analytics.js:273 | step date-string back one day (zone-agnostic) [champ-mirror] | x | PURE | n/a |
| shared/hr-analytics.js:312 | yesterday = date string minus one (zone-agnostic) [champ-mirror] | x | PURE | n/a |
| shared/hr-analytics.js:320 | previous date string step (zone-agnostic) [champ-mirror] | x | PURE | n/a |
| shared/hr-analytics.js:328 | best-run previous date string step (zone-agnostic) [champ-mirror] | x | PURE | n/a |
| shared/progress-analytics.js:98 | heatmap start = date string minus N-1 (zone-agnostic) [champ-mirror] | x | PURE | n/a |
| shared/progress-analytics.js:112 | next heatmap date string (zone-agnostic) [champ-mirror] | x | PURE | n/a |
| src/app/api/cron/agent-followups/route.js:89 | heartbeat check-in rollup keyed by Dublin day | c | PLATFORM (global heartbeat row) | n/a |
| src/app/api/schedule/swaps/[id]/route.js:282 | log text naming Dublin fallback; resolver already per-studio | x | PURE (enclosing resolver ALREADY; could use getLocationZone) | n/a |
| src/app/api/shelly/shelly-routes.test-helpers.js:39 | test fixture location with Europe/Dublin timezone | x | PURE | n/a |
| src/components/AuditLogTable.jsx:74 | audit log timestamps in Dublin ? master-only page | c | PLATFORM | n/a |
| src/components/LocationForm.jsx:284 | Europe/Dublin option in timezone select list | x | PURE | n/a |
| src/components/automations/ShellyDeviceCard.jsx:121 | overrideUntilLabel tz param defaults to DEFAULT_TZ, caller passes | x | PURE (default param; callers pass location zone) | arg |
| src/components/automations/ShellyDeviceCard.jsx:142 | locationTz prop defaults to DEFAULT_TZ, page passes it | x | PURE (default param; page passes location.timezone) | arg |
| src/lib/agent/review.js:45 | yesterday key = calendar step back one day | x | PURE (addDaysISO) | n/a |
| src/lib/approvals/event-move-card.js:27 | formats DATE column anchored noon UTC; zone-invariant output | x | PURE (could be a UTC formatter) | n/a |
| src/lib/class-occurrences.js:161 | once-a-day Glofox trainer lookup at 04:00 Dublin ? ops throttle, any zone | c | PLATFORM | n/a |
| src/lib/class-reminders.js:83 | label tz default Dublin; only caller passes loc.timezone | x | ALREADY (caller passes locations.timezone) | arg |
| src/lib/hr-analytics.js:273 | cursor steps back one calendar day | x | PURE (addDaysISO) | n/a |
| src/lib/hr-analytics.js:312 | yesterday key = calendar step back | x | PURE (addDaysISO) | n/a |
| src/lib/hr-analytics.js:320 | previous key = calendar step back | x | PURE (addDaysISO) | n/a |
| src/lib/hr-analytics.js:328 | previous key = calendar step back | x | PURE (addDaysISO) | n/a |
| src/lib/hr-attribution-sweep.js:26 | weekly attribution report gated to Dublin Sunday ? cross-tenant ops canary | c | PLATFORM | n/a |
| src/lib/hr-attribution-sweep.js:45 | daily canary today = Dublin, all locations ? cross-tenant ops canary | c | PLATFORM | n/a |
| src/lib/hr-attribution-sweep.js:46 | canary visit window = Dublin day ? cross-tenant ops canary | c | PLATFORM | n/a |
| src/lib/hr-attribution-sweep.js:144 | weekly report week = Dublin Monday ? cross-tenant ops canary | c | PLATFORM | n/a |
| src/lib/hr-attribution-sweep.js:145 | previous Dublin week start ? cross-tenant ops canary | c | PLATFORM | n/a |
| src/lib/hr-attribution-sweep.js:165 | ops email week label in Dublin dates | c | PLATFORM | n/a |
| src/lib/manual-timetable.js:217 | noon-anchored calendar step over date keys | x | PURE (equivalent to addDaysISO) | n/a |
| src/lib/openapi.js:1057 | doc string: race-day "today" is Europe/Dublin (reword with TZ.9) | x | PURE | n/a |
| src/lib/openapi.js:1060 | doc string: server-side Dublin "today" boundary (reword with TZ.9) | x | PURE | n/a |
| src/lib/openapi.js:5018 | doc string: quiet-hours default 21-08 Dublin (reword with TZ.4) | x | PURE | n/a |
| src/lib/openapi.js:5032 | doc string: quiet-hours are Dublin wall clock (reword with TZ.4) | x | PURE | n/a |
| src/lib/openapi.js:5117 | doc string: attendance default range in Dublin (reword with TZ.8) | x | PURE | n/a |
| src/lib/openapi.js:8461 | doc string: leads since Dublin Monday (reword with TZ.11) | x | PURE | n/a |
| src/lib/openapi.js:9643 | doc string: host portal converts schedule from Dublin (reword with TZ.9) | x | PURE | n/a |
| src/lib/roster-runway-notify.js:67 | default param; sole caller passes resolved tz | x | PURE | arg |
| src/lib/schedule/desired-state.js:87 | default param; only internal callers, always pass zone | x | PURE | arg |
| src/lib/schedule/desired-state.js:165 | default param; no production caller | x | PURE | n/a |
| src/lib/send-quiet-hours.js:216 | calendar step to next date key | x | PURE | n/a |
| src/lib/send-quiet-hours.js:246 | calendar step for "tomorrow" key | x | PURE | n/a |
| src/lib/shelly/plan.js:98 | tz default param; both callers pass the location tz | x | PURE (ALREADY; DEFAULT_TZ import moves) | arg |
| src/lib/shift-reminders.js:71 | import of staff-push fallback zone | x | PURE (import) | n/a |
| src/lib/shift-reminders.js:109 | default param; every caller passes location tz | x | PURE | arg |
| src/lib/shift-reminders.js:135 | default param; every caller passes location tz | x | PURE | arg |
| src/lib/staff-push-hours.js:75 | default param; all callers pass tz | x | PURE | arg |
| src/lib/staff-push-hours.js:83 | default param; all callers pass tz | x | PURE | arg |
| supabase/migrations/610_backfill_arrival_stamps.sql:70 | one-off backfill, already `COALESCE(l.timezone,'Europe/Dublin')` | x | none (historical, already per-location) | row.location_id |
| supabase/migrations/610_backfill_arrival_stamps.sql:77 | one-off backfill, already per-location | x | none | row.location_id |
| supabase/migrations/611_backfill_block_min_coaches.sql:34 | one-off backfill cut-off on Dublin today | x | none (ran once, all locations Dublin) | n/a |
| supabase/operator-scripts/703_run_move_unavailable_time_off.sql:44 | operator script runs move with Dublin today | c | keep (one-off operator script, UN1T only) | n/a |
