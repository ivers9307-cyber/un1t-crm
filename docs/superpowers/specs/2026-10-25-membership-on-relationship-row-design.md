# Membership facts on the relationship row — design (2026-10-25)

**Decision (Richard, 25 Oct 2026):** fold `contact_memberships` into `contact_studios` now, as columns on the relationship row, and drop the table. Follows spec 2026-10-20 §2.3 (ORGCONTACTS), whose plan left the table standing because the relationship row carried no plan name and no membership end date.

## Intent and why

Since ORGCONTACTS, `contact_studios` is the one answer to "which studios is this person at". `contact_memberships` is the last side channel: the un1t.online membership record (plan name, active or ended, ended date) that the un1t churn and growth numbers, the win-back list, trial eligibility and the pipeline snapshot still read, and that the un1t sync's step 7 still writes. Two tables answering "is this person a member at Hatch" is the shape ORGCONTACTS exists to remove.

## What is true in prod today (read 25 Oct 2026)

- `contact_memberships` is **one row per (contact, studio, source)** (`unique (contact_id, location_id, source)`, mig 722). It holds **no history**: a lapse and a rejoin reuse the row. So moving it onto the one-row-per-(contact, studio) relationship table loses nothing.
- 29 rows `un1t_online_api` / `active`, all at Hatch Street; `active_rows_without_live_sub = 0` (every one has a live `un1t_subscriptions` row).
- 20 rows `un1t_online_export` / `ended`, all ended 2026-10-16: the CSV-import rows of HATCH-MEMBERS.1, ended on the day the API sync took over. Each of those 20 contacts also holds an active API row. They are **source-switch artefacts, not churn**: the churn count already excludes them (`source = API_SOURCE`); the win-back read includes them but skips anyone holding a live subscription.
- Every membership row has its `contact_studios` row (`membership_rows_without_studio_row = 0`).

## Goals

1. The un1t sync writes membership facts onto the relationship row and nowhere else.
2. Every reader of `contact_memberships` reads the relationship row; the numbers they produce do not change (29 members, the same win-back list, the same trial refusals, the same monthly cancellations).
3. `contact_memberships` is dropped, with its drop applied after the code deploys (the 768 pattern).
4. `derive_contact_studio` treats the membership columns as **source facts the sync owns**, the way it treats `contacts.glofox_member_id`, never as something it derives — a derived row must never be its own proof (LESSONS, 25 Oct).

## Non-goals

- Membership history (periods). Nothing reads it today; the table never held it. If it is ever wanted it is a new table, not more columns.
- Glofox memberships. They stay on the `contacts.glofox_*` columns (the Glofox sync's record); only un1t.online memberships move.
- Any change to what "member" means on a board, the radar or event pricing.

## Anti-goals (a failure even if it works)

- A nightly reconcile that clears or rewrites a membership fact because it re-derived the row (the C1 class).
- `upsertContactStudio` or `touchContactStudio` ever touching a membership column.
- The 20 export artefacts appearing as 20 cancellations in October 2026 anywhere they do not today.

## The design (the how, as decided)

### Columns on `contact_studios` (mig 770, applied BEFORE the code deploys)

| column | type | meaning |
|---|---|---|
| `membership_plan` | text, null | the plan as un1t.online names it (`product_title`, else 'Membership') |
| `membership_status` | text, null, CHECK IN ('active','ended') | null = this studio's source has never recorded a membership for this person |
| `membership_since` | timestamptz, null | when the sync first saw the membership (was `first_seen_at`) |
| `membership_ended_at` | timestamptz, null | when the sync stopped seeing it (was `ended_at`) |

CHECK: `(membership_status = 'ended') = (membership_ended_at IS NOT NULL)` when `membership_status` is not null, and `membership_status IS NOT NULL OR (membership_plan IS NULL AND membership_since IS NULL AND membership_ended_at IS NULL)`.

Backfill: from `contact_memberships` rows with `source = 'un1t_online_api'` only (plan → `membership_plan`, status, `first_seen_at` → `membership_since`, `ended_at`). Export-source rows are not carried (artefacts; the migration prints how many it skipped). Self-check: every api row has a relationship row carrying its status.

`derive_contact_studio` and `reconcile_contact_studios` are re-created: `membership_row` = `EXISTS (contact_studios row with membership_status = 'active')` for the pair; `first_seen_at` LEAST includes `membership_since`; the reconcile's pair union drops the table. `private.contact_studios_upsert` keeps writing exactly the columns it writes today (it never names a membership column). Grants: none needed, the table is service-role only.

Mig 769 is the person_groups column drop (ORGCONTACTS.6); this is 770 and the drop below 771. If main takes those numbers first, renumber (duplicates are tolerated, but avoid one here).

### The writer

`src/lib/contact-studios.js` gains `setMembershipFacts(db, { contactId, locationId, plan, status, since, endedAt, nowIso })`: an UPDATE of the four columns on the existing relationship row, `{ ok, updated }` (zero rows = `updated: false`, logged by the caller; the row is written by `writeContactStudios` just before). `upsertContactStudio`'s payload is unchanged.

`reconcileMemberships` (un1t sync step 7) keeps every rule it has — one best subscription per contact, the fail-closed ending guards (no subscriptions pulled, unresolved clients, unreadable contacts) — and writes through `setMembershipFacts` instead of the table: active = `{ status: 'active', plan, since: coalesce(existing since, nowIso), endedAt: null }`; ending = `{ status: 'ended', endedAt: nowIso }` on rows whose `membership_status = 'active'`. The "active rows for this source" read becomes `contact_studios` at the studio with `membership_status = 'active'`. Step 7a (`writeContactStudios`) runs BEFORE the membership write so the row exists; a membership write that touched no row is counted (`membership_rows_missing`) and logged, never the run's failure. The sync is the ONLY writer of the four columns (`tests/un1t-online-write-guard.test.js`-style guard: a new writer fails a test).

### The readers (each keeps its public signature; the pure shape functions keep taking `{ contact_id, source, status, ended_at, plan_name }` rows, produced by one mapper `membershipRowsFromStudioRows`)

- `src/lib/membership/reads/un1t-online.js`: `listEndedMemberships`, `countEnded`, `MEMBERSHIP_COLS` → `contact_studios` at the studio, `membership_status = 'ended'` / columns `contact_id, membership_status, membership_ended_at, membership_plan`.
- `src/lib/membership/reads/un1t-online-radar.js`: `ENDED_COLS` + the `STATUS_SOURCES` filter → `contact_studios` rows with `membership_status = 'ended'` (`STATUS_SOURCES` goes).
- `src/lib/trial-eligibility.js`: `contact_membership_active` → a relationship row at the studio with `membership_status = 'active'`.
- `shapeFlows`, `shapeWinbackRows`, `shapePipelineSnapshot`, `shapePipelineDateEvidence`: unchanged bodies; their callers pass mapped rows.
- The contact page's Studios card shows the plan and "member since / membership ended" on a row that carries them.

### Migration 771 (applied AFTER the code deploys)

Drops `contact_memberships`. Pre-check: no view, policy or function names it (the 768 pre-check pattern); the sync's last run on prod is after the deploy (the migration cannot know; the PR body says so). Rollback record: the 722 DDL and a backfill from the four columns.

### Tests and guards

- `tests/migration-770-*.test.js` (PGlite over the shared fixture): columns, CHECKs, backfill (api carried, export skipped), derive's `membership_row` from the column, reconcile never clears a membership column, `contact_studios_upsert` never names one.
- `tests/migration-771-*.test.js`: drop + pre-check refusals.
- `tests/contact-studios-read-model.test.js`: extended, not replaced.
- `src/lib/un1t-online-sync.test.js`: step 7 writes the columns, ending guards unchanged, missing row counted.
- Reader tests renamed from `contact_memberships` to the new reads; `glofox-active-members.test.js`'s "never reads contact_memberships" pin stays.
- `tests/helpers/contact-studios-fixture.js` and `contacts-resolvers-699-fixture.js`: the stub table goes once 771 is in the replay.
- Guards that will fire and must be satisfied: `check:select-columns` (the four columns come from 770), `tests/closed-table-escapes-guard`, `tests/member-write-sweep-guard`, the read-scope guard (765's helper and policy untouched), `tests/function-execute-guard` (derive/reconcile re-created with REVOKE/GRANT stated).

### Docs

CLAUDE.md contacts bullet (the membership columns and their one writer), REFERENCE.md table map, BACKLOG (remove the dated drop), LESSONS (one line: the table held no history, so the move was free), changelog entry.

## Left to the builder

Column CHECK wording, the exact mapper and helper names, the Studios card copy, test names, and whether the export artefacts are counted in the 769 NOTICE or a report column.

## My calls (Richard can overturn)

- Export-source rows are not carried into the columns (artefacts of the 16 Oct source switch).
- One plan per studio per person (the sync's "best subscription" rule stands).
- `membership_since` is the API row's `first_seen_at`, never the subscription's `remote_created_at` (that is `member_since` in the pipeline evidence, a different fact).
