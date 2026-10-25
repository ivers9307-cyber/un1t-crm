# Membership facts on the relationship row — design (2026-10-25)

**Status: implemented (ORGCONTACTS.7, plan docs/superpowers/plans/2026-10-25-membership-on-relationship-row.md).** **Decision (Richard, 25 Oct 2026):** fold `contact_memberships` into `contact_studios` now, as columns on the relationship row, and drop the table. Follows spec 2026-10-20 §2.3 (ORGCONTACTS), whose plan left the table standing because the relationship row carried no plan name and no membership end date.

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

Order inside the sync (the builder check's first question): step 7 keeps computing `best` (one subscription per contact), then reads the facts rows (`contact_studios` at the studio with `membership_status = 'active'`), then applies the three fail-closed ending guards exactly as today, so `toEnd` is known; THEN step 7a `writeContactStudios` runs once (member rows for `best`, client rows for every other linked client and for `toEnd`), THEN the facts are written: activations first (`setMembershipFacts` per contact: one UPDATE of plan/status/ended_at, plus a second guarded UPDATE `SET membership_since = :now WHERE membership_since IS NULL`, the `first_seen_at` pattern), then endings. One UPDATE per contact replaces today's chunked upsert (29 rows at Hatch; a studio ten times larger is still one short burst, and the sync already writes per client in step 7a). A member whose contact has no `un1t_clients` row still gets its relationship row from 7a's member list, so `membership_rows_missing` counts only a genuinely missing contact.

`src/lib/contact-studios.js` gains `setMembershipFacts(db, { contactId, locationId, plan, status, since, endedAt, nowIso })`: an UPDATE of the four columns on the existing relationship row, `{ ok, updated }` (zero rows = `updated: false`, logged by the caller; the row is written by `writeContactStudios` just before). `upsertContactStudio`'s payload is unchanged.

`reconcileMemberships` (un1t sync step 7) keeps every rule it has — one best subscription per contact, the fail-closed ending guards (no subscriptions pulled, unresolved clients, unreadable contacts) — and writes through `setMembershipFacts` instead of the table: active = `{ status: 'active', plan, since: coalesce(existing since, nowIso), endedAt: null }`; ending = `{ status: 'ended', endedAt: nowIso }` on rows whose `membership_status = 'active'`. The "active rows for this source" read becomes `contact_studios` at the studio with `membership_status = 'active'`. Step 7a (`writeContactStudios`) runs BEFORE the membership write so the row exists; a membership write that touched no row is counted (`membership_rows_missing`) and logged, never the run's failure. The sync is the ONLY writer of the four columns (`tests/un1t-online-write-guard.test.js`-style guard: a new writer fails a test).

### The readers (each keeps its public signature; the pure shape functions keep taking `{ contact_id, source, status, ended_at, plan_name }` rows, produced by one mapper `membershipRowsFromStudioRows`)

- `src/lib/membership/reads/un1t-online.js`: `listEndedMemberships`, `countEnded`, `MEMBERSHIP_COLS` → `contact_studios` at the studio, `membership_status = 'ended'` / columns `contact_id, membership_status, membership_ended_at, membership_plan`.
- `src/lib/membership/reads/un1t-online-radar.js`: `ENDED_COLS` + the `STATUS_SOURCES` filter → `contact_studios` rows with `membership_status = 'ended'` (`STATUS_SOURCES` goes).
- `src/lib/trial-eligibility.js`: `contact_membership_active` → a relationship row at the studio with `membership_status = 'active'`.
- `shapeFlows`, `shapeWinbackRows`, `shapePipelineSnapshot`, `shapePipelineDateEvidence`: unchanged bodies; their callers pass mapped rows.
- The contact page's Studios card shows the plan and "member since / membership ended" on a row that carries them.

### Migration 771 (applied AFTER the code deploys)

Before dropping, a **parity pass** (the builder check's second question): for every `un1t_online_api` row whose `(status, ended_at, plan_name)` differ from the columns on its relationship row, copy the row's values onto the columns (`membership_since` only where the column is null). This repairs the window between 770's apply and the deploy, in which the old code kept writing the table every 15 minutes and never the columns (a membership that ended in the window would otherwise end at the new code's first-run time, a start would get first-run time as its since), and it is the proof the migration can offer that nothing in the table is newer than the columns: the pass prints how many rows it copied, and the PR body asks the operator to apply it after at least one sync has run on the new code (the count then reads 0). Then drops `contact_memberships`. Pre-check: no view, policy or function names it (the 768 pre-check pattern); the sync's last run on prod is after the deploy (the migration cannot know; the PR body says so). Rollback record: the 722 DDL and a backfill from the four columns.

### Replay safety (the builder check's third question)

`tests/migration-648-credential-column-grants.test.js` replays every later migration over a two-column stub of `contact_memberships` (`id, source`), and the convention there is that every file is replay-safe on its own. So 770 guards its backfill on the four source columns existing (`information_schema.columns`; a stub without them backfills nothing and says so in a NOTICE), and 771 uses `DROP TABLE IF EXISTS` with pre-checks that pass when the table is already absent. The read-scope guard scans later migrations only for helper and policy re-creations; 770/771 touch neither. `CLOSED_TABLES` in `tests/helpers/sql-escapes.js` keeps `contact_memberships` as history (the guard reads the migrations, where the table still appears); the builder removes it only if that guard fails on an absent table.

### Backfill rules (the builder check's fourth question)

Fail closed: 770's pre-check lists any `un1t_online_api` row that would violate the new CHECK (`status = 'active'` with an `ended_at`, or `'ended'` without one) and aborts naming them; prod on 25 Oct 2026 has 0 such rows, 0 rows without a plan, 0 future `first_seen_at`, and every active api row's relationship row is already `kind = 'member', status = 'active'` (the sync's 7a wrote it), so the backfill does not touch `kind` and leaves it to the nightly reconcile as today.

### The one-writer guard (the builder check's fifth question)

A test pins the CALL, not the import: `setMembershipFacts(` appears in `src/lib/un1t-online-sync.js` and nowhere else under `src/`, `shared/`, `mobile/` (tests excepted), and no other `.update(` / `.upsert(` / `.insert(` whose chain names `contact_studios` carries a `membership_` key (the `un1t-online-write-guard` style, source-text level over the chain). SQL writers (770's backfill, 771's parity pass and rollback record, `private.contact_studios_upsert`, the three triggers) are pinned by the PGlite tests, not the JS guard.

### Two small calls

The mapper's `source` is `'un1t_online_api'` (the pure shapes drop any other source). `ROW_COLUMNS` in `contact-studios.js` gains the four columns, so every `studiosOfContact` reader (the contact page, the edit page, the WhatsApp webhook) carries plan names from now on: intended, the Studios card shows them; nothing else reads them.

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

Column CHECK wording, the exact mapper and helper names, the Studios card copy, test names, and whether the export artefacts are counted in the 770 NOTICE or a report column.

## My calls (Richard can overturn)

- Export-source rows are not carried into the columns (artefacts of the 16 Oct source switch).
- One plan per studio per person (the sync's "best subscription" rule stands).
- `membership_since` is the API row's `first_seen_at`, never the subscription's `remote_created_at` (that is `member_since` in the pipeline evidence, a different fact).
