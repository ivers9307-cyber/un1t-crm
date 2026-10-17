# Hatch bookings into `class_bookings` (spec C)

**Date:** 2026-10-17 (revised after Richard's answers and the builder checks, same day)
**Status:** design, for planning. Builds on the unmerged branch `un1t-online-bookings` (§ "The existing branch"); nothing is applied or merged.
**Supersedes:** P1.1b in `docs/superpowers/plans/2026-10-17-un1t-online-p1-plan.md` (its per-location `project_bookings` switch is dropped).
**Siblings:** A `2026-10-17-hatch-pipeline-and-invoices-design.md`, B `2026-10-17-hatch-radar-arrears-briefing-design.md`, D `2026-10-17-un1t-online-write-back-design.md`, E `2026-10-17-mia-at-hatch-design.md`. Suggested build order A, C, B, D, E.

---

## Intent and why

Hatch Street's class bookings live in `un1t_bookings` / `un1t_events` (mig 726), which nothing outside the sync reads. The CRM's shared booking roster is `class_bookings` (mig 288). Copying Hatch bookings into it gives Hatch what Richard asked for (decision 7): the coach's "who's coming" list, and honest fill and no-show numbers on the staff studio dashboard.

The same table feeds code that **messages customers and hands out rewards automatically**: a reminder push 30 minutes before every class, and a nightly job that turns attendance into points, achievements, pushes and a post-class email. un1t.online sends its own reminders, so those must never fire for a Hatch booking. Richard's rule: a hard rule in code, guaranteed by a test, independent of any capability flag or setting.

## Goals

1. The sync writes one `class_bookings` row per Hatch booking, straight after it writes `un1t_bookings`.
2. Two guards, in one predicate, stop every customer-messaging and reward path from acting on those rows: the row's `source_platform`, and the location's `membership_source`. Neither depends on `capabilities.bookings` or `notification_config`.
3. A guard test fails when a new reader or writer of `class_bookings` appears without a classification, or a messaging/reward path reads the table without the predicate.
4. Coaches see who is booked into the next class on `/live/<Hatch>`, under a new `class_roster` permission that does not carry door unlock.
5. The staff studio dashboard shows Hatch's no-show rate and attended visits from un1t.online's own attendance marks; fill keeps coming from un1t.online's booked count.
6. Rows D writes straight after a CRM booking and rows the sync writes are the same rows, with a fixed rule for which one wins.

## Non-goals

- Flipping `capabilities.bookings` for un1t.online. It turns on Mia's booking tools (`providerTakesBookings`, `src/lib/agent/tool-capability.js:53-55`) and lifts credit-attendance's capability skip (`src/app/api/cron/credit-attendance/route.js:60`). D flips it when D and E are ready; by then this spec's guards are what keep credit-attendance off Hatch.
- Booking or cancelling through the API (D). Mia's read tools (E). Pipeline stages from attendance (A).
- A phone "who's coming" screen (decided out of scope). Aggregator placeholder accounts (follow-ups P2.1).
- The Glofox low-fill card on Today (`src/lib/today-feed-data.js:177`): it reads the Glofox API, not this table.

## Anti-goals (must never happen)

- A CRM push, email or WhatsApp to anyone because of a Hatch booking, including a dual-studio member whose contact lives at Stillorgan and who has the app installed.
- A `heart_rate_sessions` row, points, an achievement, a goal or tier push, or a post-class email from a Hatch booking.
- A plausible-looking wrong number: 100% no-show because attendance was never marked.
- Deleting a `class_bookings` row, or a sync run failing because the projection failed.
- Fill, no-show or any aggregate studio metric on a TV or other customer-facing screen (#2067 rule).

---

## Current state (verified on `main` at `d75b064d`, plus live facts of 17 Oct)

**Table.** `supabase/migrations/288_class_bookings.sql:6-22`: `glofox_event_id`, `glofox_booking_id` NOT NULL, `UNIQUE (location_id, glofox_booking_id)` (:21), `glofox_member_id`, `contact_id`, `member_name`, `class_name`, `starts_at`, `status`, `attended NOT NULL DEFAULT false`, `raw`, `synced_at`. Staff-at-location RLS read (:34), no write policy, not column-granted. **Live:** Stillorgan holds only `BOOKED` (10,551) and `WAITING` (24); no `CANCELLED`, `CANCELED`, `ATTENDED` or `NO_SHOW` row has ever been stored; 0 `un1t:` rows; `source_platform` does not exist in prod. So no reader has ever met any status but those two.

**Glofox writer.** `src/lib/class-bookings.js:28-49` uppercases Glofox's status and sets `attended`; upsert on `location_id,glofox_booking_id` (:67), called from `applyMemberSync` (`src/lib/glofox-sync.js:2112-2127`) and the master backfill route.

**The occurrences pattern.** `src/lib/un1t-online-occurrences.js`: `un1t:<uuid>` ids (:8-11), `source_platform='un1t_online'`, never deletes, never throws, writes nothing if its pre-read fails (:94-103). Called in sync step 6b only where `membership_source = 'un1t_online'` (`src/lib/un1t-online-sync.js:409-424`). `un1t_bookings` is upserted last (:117-125) with `contact_id` from the resolver (:366, :394), which resolves dual-studio clients to their Stillorgan contact.

**un1t.online data.** Statuses `booked | cancelled | attended | no_show` (OpenAPI snapshot, `UserBookingResponseDto`); `user_id` nullable (guests, aggregators). Live 17 Oct: 231 attended, 24 booked, 61 cancelled, 10 no_show; none with a null `contact_id` or `event_id`. Fill already works: `bookings_count` → `class_occurrences.raw.booked` (`un1t-online-occurrences.js:62-63`) → `fetchFloor` (`shared/studio-kpis.js:321-328`). The studio page nulls no-show, activation and attended visits for non-Glofox sources (`src/app/dashboard/studio/page.js:93-102`, :119, :128).

**Capabilities.** All five un1t.online capabilities are false (`src/lib/membership/sources/un1t-online.js:16`); `locationIdsWithoutCapability` reads that static table (`src/lib/membership/locations-for-source.js:128-138`).

### Every reader and writer of `class_bookings`

From `grep -rn class_bookings src shared mobile scripts`, the SQL functions, and the champ-app checkout. Not this table: `class_booking_requests` (the /start queue and its crons/webhooks) and legacy `bookings` (phone Bookings tab, `fetchTodayOps` `shared/dashboard-data.js:706`, sequence triggers `src/lib/sequences/cron-triggers.js:114`, :490).

| # | Reader | Kind | With a Hatch row, no guards |
|---|---|---|---|
| 1 | `send-class-booking-reminders` (`route.js:56-59` reads every location's config, no source gate; default lead 30 min, `src/lib/class-reminders.js:16`; query :83-97) | **customer-messaging** | **pushes every Hatch member with a token**, dual-studio included |
| 2 | `credit-attendance` (`route.js:72-80`; participation session :172; `finalizeSessionRewards` :184 → push `src/lib/live-class.js:559`, post-class email :545; unscoped occurrence lookup :141-145) | **reward + data-writing** | off only by the capability; **on the day D flips `bookings`** |
| 3 | `onboarding-journey-data.js:fetchAttendanceByContact` (:129-150) → `notify-onboarding-pace` push (Glofox studios only, `route.js:83`) and `/pulse` lane | **customer-messaging** + staff display | inert by two gates unrelated to the row |
| 4 | `onboarding-journey-data.js:loadContactJourney` (:228-262, no location filter :249-254) → `/api/me/journey`, contact page | customer + staff display | a dual-studio member's Hatch classes count toward their Stillorgan journey; the lane (#3) disagrees |
| 5 | `class-bookings.js:lookupBookedMember` (:98-109) ← `bridge-samples.js:430`, `live-class.js:215`, Apple Health ingest `:102` | **reward linking** (class points, post-class email) | inert while un1t rows carry no `glofox_member_id` |
| 6 | `class-bookings.js:resolveBookedOccurrenceForMember` (:217-239) ← `bridge-samples.js:423`, `live-class.js:210` | **reward linking** | same |
| 7 | `class-bookings.js:getClassRoster` (:166-176) → `/api/live/[locationId]` roster (:33-40), claim picker (`…/contacts/route.js:45-52`, `hr-claim.js:26-44`) | staff display | **wanted**: the who's coming list |
| 8 | `shared/studio-kpis.js:fetchFloor` (:274-334) → `/dashboard/studio` | staff display | **wanted**, but `computeFloor`/`computeActivation` count only `status === 'BOOKED'` (`shared/studio-kpi-math.js:227`, :277) |
| 9 | `public.campaign_outcome_stats` (mig 513:95-99) | staff display | filters lowercase `'cancelled'`, so cancelled (and no-show) rows would count as "class attendances" |
| 10 | `upsertClassBookings` + `glofox-sync.js:2117` + `/api/admin/backfill-class-bookings` | writer (Glofox) | unchanged |
| 11 | champ-app `src/lib/claim-candidates.js:200-207` (other repo) | customer display (strap-claim nudge) | any studio by `contact_id`; drops `*CANCEL*` only (:126-127) |

Checked and not readers: `auto-end-stale-hr-sessions` (sessions + occurrences, `route.js:88-93`; acts only on sessions this spec keeps from existing); TV boards (`live-board.js`, `tv-idle-content.js`, occurrences only); sequence triggers and segments; every file under `mobile/`; device runners (occurrences only).

**Status re-check (C-2).** Because no stored row has ever carried `CANCELLED`, `ATTENDED` or `NO_SHOW`, each reader was re-read for them: #1, #3, #4, #5, #6 exclude `CANCELLED` by `.not('status','eq','CANCELLED')`, and the guards keep un1t rows out anyway. #7 (`mergeRosterWithSessions` :130, `rankClaimCandidates` :32) skips `CANCELLED` and lists `ATTENDED`/`NO_SHOW` as booked: right for a roster. #8 drops `ATTENDED`/`NO_SHOW`: fixed in §5. #9 counts everything but lowercase `cancelled`: fixed in §1. #11 would treat a `NO_SHOW` class as the member's class for strap matching: a champ-app follow-up (Left to the builder 4).

### The existing branch `un1t-online-bookings`

Worktree `~/code/un1t-crm-bookings`, read only. Six commits on top of `61d0af06` (#2080), last 17 Oct 18:15, from an archived session; never applied (live facts above). Its plan is `docs/superpowers/plans/2026-10-17-un1t-online-bookings.md`.

| Commit | What it does |
|---|---|
| UN1TBOOK (plan) | the reader audit (matches the table above) and five tasks |
| .1 | `supabase/migrations/733_class_bookings_source_platform.sql`: `source_platform text NOT NULL DEFAULT 'glofox'` + CHECK, one namespace CHECK tying `un1t_online` to the `un1t:` prefix on both ids (added `NOT VALID`, then validated), `campaign_outcome_stats` re-created with `upper(coalesce(b.status,'')) <> 'CANCELLED'`, a catalog self-check; PGlite test `tests/migration-733-…test.js` |
| .2 | `CRM_CLASS_MESSAGING_PLATFORM = 'glofox'` in `class-bookings.js`. Reminders and credit-attendance filter `.eq('source_platform', …)` **and** drop rows at any `un1t_online` location (`skipped_un1t_online`); a failed location read logs and keeps reminding Stillorgan, but makes credit-attendance answer 500. Both journey reads filtered. Guard `tests/class-bookings-readers-guard.test.js` (file-level manifest, `HARD_OFF` list, update/delete rule, SQL objects) |
| .3 | `src/lib/un1t-online-bookings.js` + sync wiring: Glofox-shape statuses (`booked`/`attended`/`no_show` all `BOOKED`, attendance only in `attended`), unknown event skipped, names read failure writes rows without `member_name`, upsert only |
| .4 | studio page: `attendanceKpis` for glofox and un1t_online, activation still unavailable; no `shared/` change |
| .5 | `un1t-online-bookings.floor.test.js` pins "an unmarked past un1t booking is a no-show"; the migration refreshes three stale comments |

**What this plan changes on the branch:**
1. **Rebase on main.** 12 commits behind (#2077 to #2094); only `src/lib/un1t-online-sync.js` conflicts (UN1THARD.1-4 changed it). **Renumber mig 733**: main has `733_org_settings_audit.sql`, and 734/735 are taken; use the next free number at build time. Its comments say "mig 730" for the occurrences column, now file 734 (#2081).
2. **Statuses:** replace the Glofox shape with explicit `ATTENDED`/`NO_SHOW`, and a past un1t `BOOKED` counts as undecided (§3, §5). This adds a `shared/` edit (and so an OTA), accepted. Rewrite the .5 floor test to pin the opposite outcome.
3. **Guards:** keep both of the branch's guards and move them into one predicate (§2); add the row filter to rows 5 and 6.
4. **Campaign stats:** keep the `CANCELLED` fix and also exclude `NO_SHOW` (§1).
5. **New:** the D tie-break (§7), the pre-read it needs, `raw.un1t` fields for it, `class_roster` and the roster route (§4), and the two-PR split (Rollout).

---

## Design

### 1. Migration (the branch's 733, renumbered)

Keep the branch's file and self-check, with these differences:
- `campaign_outcome_stats`: the bookings join becomes `upper(coalesce(b.status,'')) NOT IN ('CANCELLED','NO_SHOW')`. No Glofox number moves: no Glofox row is `CANCELLED` or `NO_SHOW` today. `WAITING` keeps counting, as today. Restate `security invoker`, `REVOKE … FROM public, anon, authenticated`, `GRANT … TO service_role`; the self-check looks for the new filter text in `pg_proc.prosrc`.
- Grant decision as the branch says: none needed, `class_bookings` is not column-granted; say so in a comment and check `information_schema.column_privileges`.
- Refresh the comments that the projection makes wrong (`class_bookings`, `class_occurrences.source_platform`, `un1t_events`, `un1t_bookings`), as .5 does.
- Apply through Supabase MCP on `iyvtbjjxdggiadzwwvdj` before the code that names the column (a filter on a missing column fails the whole query, which would stop Stillorgan's reminders); `get_advisors` (security) after.

### 2. The predicate: `src/lib/class-booking-platform.js`

One module holds the rule (the branch's constant moves here; `class-bookings.js` re-exports it so nothing else breaks):

```js
export const CRM_CLASS_MESSAGING_PLATFORM = 'glofox'
// Rows the CRM may remind, credit or reward from. Both guards, always:
// the row says glofox AND its studio is not a un1t.online studio.
// A row with no source_platform (the select forgot it) is false.
export function crmMayActOnClassBooking(row, { un1tOnlineLocationIds }) { … }
// .eq('source_platform', CRM_CLASS_MESSAGING_PLATFORM) on a class_bookings query.
export function scopeToCrmActionable(query) { … }
// One read per tick: listLocationsByMembershipSource(db, 'un1t_online').
export async function readUn1tOnlineLocationIds(db) { … }
```

No capability, setting, `notification_config` or env flag is consulted. Applied:
- **Reminders** and **credit-attendance**: the query filter, then `crmMayActOnClassBooking` on every row before anything is chosen; dropped rows counted as `skipped_un1t_online` (branch). Location read failure: the branch's rules (reminders log and continue on the row guard alone, which the namespace CHECK backs; credit-attendance answers 500 with no heartbeat).
- **Both journey reads** (branch): query filter; their location gates already exist.
- **`lookupBookedMember`, `resolveBookedOccurrenceForMember`**: query filter (not in the branch). They are location-scoped, so the location guard is their caller's location.
- Not `getClassRoster`, not `fetchFloor`, not the campaign RPC: those are meant to see Hatch.

### 3. The projection: `src/lib/un1t-online-bookings.js` (branch .3, changed)

Kept from the branch: ids `un1t:` + booking id / event id; `source_platform 'un1t_online'`; `glofox_member_id` null; `contact_id` from `un1t_bookings`; `member_name` from `contacts.name` (and on a failed names read, rows written without the key so existing names stay); `class_name` / `starts_at` from the run's events, else `un1t_events` at the location (a failed read writes nothing); a booking with an unknown event skipped and counted; chunks 200 / 100; never deletes, never throws; counts on the run row; gated on `membership_source = 'un1t_online'` like 6b.

Changed:

| un1t.online | `status` | `attended` | rank |
|---|---|---|---|
| `booked` | `BOOKED` | false | 0 |
| `attended` | `ATTENDED` | true | 1 |
| `no_show` | `NO_SHOW` | false | 1 |
| `cancelled` | `CANCELLED` | false | 1 |
| anything else | not projected, `skipped_unknown_status` + one `logWarn` naming the value | | |

- `member_name` is `'Guest'` when there is no contact and un1t.online says there is a guest, so the coach's count is right.
- `raw = { un1t: { status, source, credit_charged, has_guest, updated_at, written_by: 'sync' } }`, where `updated_at` is un1t.online's own `updated_at` for the booking. Nothing else; no names or guest details.
- Before upserting, read the stored rows for these ids (location-scoped, chunks of 100) and apply §7's rule; a failed read writes nothing. Count `kept_stored`.

### 4. Who's coming: `/live/<id>` roster under `class_roster`

- **Permission.** New web key `class_roster` in `WEB_PERMISSIONS` (`shared/permissions.js`), on by default for `staff`, `head_coach`, `manager`, `owner` (master always), off for `reception`. Same shape as `class_timer`'s split from `studio_management` (:108-113): a coach gains the list, never door unlock. Phone parity: a `WEB_ONLY_OK` entry in `scripts/check-mobile-parity.mjs` with the reason "web /live roster only; phone screen out of scope". No migration (a web-only key has no phone-defaults row).
- **Route.** `GET /api/live/[locationId]/roster`: resolved at the target location (as SEC-LIVE-API.2 does), refuses without `class_roster` there, returns `{ occurrence, roster, has_bridge }` from `getClassRoster` + `mergeRosterWithSessions` with no sessions and no strap data. Service role; names only for that studio's current class.
- **Page.** `/live/<id>` admits `studio_management` OR `class_roster`. Without `studio_management` it renders only the Class roster panel polling the new route; the HR grid, straps, pairing, Detected tab and test mode stay behind `studio_management` exactly as today (`src/app/live/[locationId]/page.js:39`, `src/lib/live-access.js:177-195`).
- **Window** unchanged: from 20 minutes before the start to 10 after the end (`src/lib/class-occurrences.js:497-498`).
- **Header.** "`{present}/{booked} booked here`" (`LiveClassClient.jsx:375`) reads "0/8 booked here" without straps; with `has_bridge` false show "`{booked} booked`".
- Every booked member is listed by `member_name`, including `ATTENDED`/`NO_SHOW` once marked.

### 5. Fill and no-show at Hatch (staff dashboard only)

- **Fill** stays `class_occurrences.raw.booked` = un1t.online's `bookings_count`, the provider's own count, as at Glofox.
- **No-show and attended visits.** Add `bookingOutcome(row)` to `shared/studio-kpi-math.js`: `CANCELLED` → excluded; a `un1t_online` row: `ATTENDED` → attended, `NO_SHOW` → no-show, `BOOKED` → undecided (out of numerator and denominator); a Glofox row: `BOOKED` → attended or no-show by `attended`, exactly as today. `computeFloor` and `computeActivation` use it; `fetchFloor` selects `source_platform`. Glofox numbers must not move.
- **Studio page:** the branch's `attendanceKpis` (glofox and un1t_online); activation stays unavailable at Hatch because its cohort is `contacts.converted_at`, which only the Glofox sync stamps. All undecided gives `null` ("unavailable"), never 0%.
- **TVs and every customer-facing screen:** nothing. **Business dashboard and phone:** unchanged.

### 6. Logging

`counts.class_bookings = { upserted, kept_stored, skipped_no_event, skipped_unknown_status, names?, error? }` on `un1t_sync_runs`, counts only. The two crons report `skipped_un1t_online`; the reminders cron `logError`s if its JS guard ever drops a row the query filter should have removed. Projection errors carry `code` and `message` only.

### 7. Interaction with D (write-through), and who wins

D writes the mirror row straight after a CRM book or cancel, using this spec's exported `mapUn1tBookingToClassBooking` on the API's response, upserting on `location_id,glofox_booking_id`, with `raw.un1t.written_by: 'crm'` and `raw.un1t.updated_at` set **only** from the response (null if absent). Same key, so the sync's next write is an update of the same row, never a second row.

Rule, applied by the projection's pre-read (step in §3):
1. A **terminal** status from the sync (`ATTENDED`, `NO_SHOW`, `CANCELLED`, rank 1) always overwrites a stored `BOOKED` (rank 0), whoever wrote it.
2. A lower rank never overwrites a higher one: a sync `BOOKED` pulled just before a CRM cancel does not undo D's `CANCELLED`.
3. Same rank: the newer un1t.online `updated_at` wins. If either side has no un1t.online timestamp, the sync's row wins. Our clock is never compared with un1t.online's.

The namespace CHECK means D cannot write a `un1t:` row tagged `glofox`.

---

## Decided (Richard, 17 Oct)

- **Decision 7.** Hatch bookings serve the who's coming list and dashboard fill and no-show. No HR sessions, rewards or achievement pushes at Hatch. No CRM class reminders or attendance pushes at any un1t.online studio; hard rule in code, test-guaranteed. `bookings` is not flipped here (D owns it).
- **G1.** Membership status and the pipeline are separate per location; only the contact is shared. The projection writes Hatch's `location_id` and the shared `contact_id`.
- **G5.** Who's coming gets its own `class_roster` permission, on for coaching roles (staff, head coach and above), separate from `studio_management` so coaches do not gain door unlock.
- **G7.** Nothing in this spec sends anything, and nothing routes a new outbound send through Stillorgan's number.
- **G9.** No fill, no-show or other aggregate studio metric on a TV or customer-facing screen; staff dashboards only.
- **G4 / decision 11.** Live testing uses the MIA TEST account; no payment is involved in this spec.
- G2, G3, G6, G8, G10 do not touch this spec.

## Claude's calls (for Richard to check)

1. **Claude's call (C-1): build on branch `un1t-online-bookings`, rebased and with its migration renumbered.** Most of the work exists and its audit matches this one.
2. **Claude's call (C-1): explicit `ATTENDED` / `NO_SHOW` statuses, a past un1t `BOOKED` is undecided.** un1t.online marks attendance explicitly, so an unmarked booking must not read as a no-show; costs a `shared/` edit and an OTA.
3. **Claude's call (C-1): both guards, row and location, in one predicate.** Belt and braces for a customer-messaging rule; the row guard survives a change of source and dual-studio contacts, the location guard survives a writer bug.
4. **Claude's call (C-1): keep the branch's campaign-stats `CANCELLED` fix, and also exclude `NO_SHOW`.** A no-show is not an attendance; no Glofox number moves.
5. **Claude's call (C-2): every reader re-checked for the new statuses** (table above), since no stored row has ever carried them.
6. **Claude's call (C-3): the roster stays on `/live/<id>`, behind `class_roster`, with its 20-minute window; no phone screen.** Smallest change that gives coaches the list without door unlock.
7. **Claude's call (C-4): terminal sync statuses beat a CRM `BOOKED`; newer-wins only within a rank, on un1t.online's clock only.** Avoids clock-skew bugs on the statuses that matter.
8. **Claude's call: no per-location projection switch.** A switch beside the code rule would read as a second safety it is not; rollback is a revert, and leftover rows are inert.
9. **Claude's call: the journey reads exclude Hatch rows** (as the branch does), so the member's journey and the coach's lane agree.
10. **Claude's call: `glofox_member_id` stays null on un1t rows**, so strap linking and Apple Health class linking stay inert at Hatch on top of the guards.
11. **Claude's call: unknown un1t statuses are skipped and counted**, not uppercased as the branch does, because the roster cannot know whether they mean "coming".
12. **Claude's call: two PRs, guards first.** Vercel previews use the production database, so a preview carrying the projection could write Hatch rows while production's reminder cron lacks the guards.

## Left to the builder

1. Read-only: how many past un1t bookings are still `booked`. If many, Hatch's no-show reads "unavailable" until staff mark attendance in un1t.online; tell Richard.
2. Read-only: whether every Glofox `glofox_booking_id` is 24-hex. If so, add `CHECK (source_platform <> 'glofox' OR glofox_booking_id ~ '^[0-9a-f]{24}$')`.
3. Whether spec A stamps `contacts.converted_at` for Hatch members; if so, switch activation on at Hatch in the same change.
4. champ-app `claim-candidates` (if still on champ-app `origin/main`): filter `source_platform = 'glofox'` or the member's location, in that repo.
5. With MIA TEST, whether un1t.online reuses a booking id when someone cancels and re-books. If it does, allow a sync `BOOKED` to replace a sync `CANCELLED` when un1t.online's `updated_at` is newer (rule 2 of §7 relaxed for sync-written rows only).

## Tests

- Branch tests kept and updated: the migration test (new filter text, new number), `route.un1t-off.test.js`, `route.membership-source.test.js` (fixtures gain `source_platform: 'glofox'`), journey tests, sync tests (replace main's "class_bookings is never written", `src/lib/un1t-online-sync.test.js:555`, :582-587).
- `un1t-online-bookings.test.js`: every row of the status table; unknown status skipped; `raw` holds only the listed keys; dual-studio booking keeps its Stillorgan `contact_id` and Hatch `location_id`; the three §7 rules, including a sync `BOOKED` against a CRM `CANCELLED` and a CRM row with no un1t.online timestamp; failed pre-read writes nothing.
- `class-booking-platform.test.js`: glofox row at a Glofox studio true; un1t row false; glofox-tagged row at a un1t studio false; missing column false.
- Behaviour, with a fake db that **ignores** query filters: reminders send nothing for a due un1t row with lead times set at Hatch and `capabilities.bookings` mocked true; credit-attendance creates no session for an attended un1t row with the capability mocked true; Glofox rows unchanged.
- `shared/studio-kpi-math.test.js` and a rewritten `un1t-online-bookings.floor.test.js`: Glofox numbers unchanged; un1t `ATTENDED`/`NO_SHOW` counted, past `BOOKED` excluded, all undecided gives `null`.
- `/live`: a `class_roster`-only user gets the roster route and panel, and 403s on `/api/live/<id>` and every strap route; `studio_management` unchanged; `check:mobile-parity` passes with the `WEB_ONLY_OK` entry.
- **Guard `tests/class-bookings-readers-guard.test.js`** (branch file, extended): kinds add `reward` and `conversational-read`; `HARD_OFF` files must call `crmMayActOnClassBooking(` and `scopeToCrmActionable(` or the constant filter; the two `class-bookings.js` HR helpers must carry the filter; the new roster route is listed as `display`; the projection and D's writer as `data-writing`. As the branch says, a floor, not a proof.

## Rollout and live verification

1. Apply the renumbered migration; advisors clean; self-check passed; `select source_platform, count(*) from class_bookings group by 1` gives only `glofox`.
2. **PR 1:** migration file, predicate, the four reader changes, `class_roster` + roster route + page, `shared/` outcome helper (an OTA), studio page, guard. Merge and wait for the production deploy. Next morning: reminders `sent` normal at Stillorgan with `skipped_un1t_online: 0`; the 03:00 credit run normal.
3. **PR 2:** projection, sync wiring, §7 rule. Update CLAUDE.md line 64 ("its bookings are NOT" becomes: projected with `source_platform='un1t_online'`; the CRM never reminds, rewards or pushes for them; `src/lib/class-booking-platform.js` is the rule). First run: `upserted` near 326 (17 Oct), about `ATTENDED` 231, `BOOKED` 24, `CANCELLED` 61, `NO_SHOW` 10, every `skipped_*` explained.
4. Read-only proof a day later: no `customer_engagement_nudges` row keyed on a `un1t_online` booking id; no `heart_rate_sessions` with `glofox_event_id LIKE 'un1t:%'`; both crons' `skipped_un1t_online` 0.
5. Fill: for past Hatch events compare `raw.booked` with non-cancelled projected rows; if `bookings_count` includes cancellations, switch the occurrence's `raw.booked` to the projected count (small follow-up).
6. MIA TEST: booked into a Hatch class 40+ minutes ahead in un1t.online, it appears as `BOOKED` within 15 minutes; a `class_roster`-only coach sees it on `/live/<Hatch>` from 20 minutes before; the reminder cron's tick does not include it (the proof is the tick and the nudge ledger, not the phone, unless the MIA TEST contact has a push token). Marked attended in un1t.online, it becomes `ATTENDED` on the next run, with no participation session the next morning.

## Dependencies on sibling specs

- **D** writes `class_bookings` with this spec's mapper and the §7 fields, and flips `bookings`; it lands after PR 1. Recommend D applies the same rank rule to its immediate `un1t_bookings` write.
- **E**: Mia's next-class answers should read `un1t_bookings` ⨝ `un1t_events`. If E reads `class_bookings`, it registers as `conversational-read` (a reply the member asked for is not a reminder), which the guard allows.
- **A**: if the Hatch classifier reads attendance from `class_bookings`, it registers as `data-writing`. A may stamp `converted_at` (Left to the builder 3).
- **B**: none.

## Open questions

None left: TVs (G9), the phone screen (C-3) and the roster permission (G5) are decided above.
