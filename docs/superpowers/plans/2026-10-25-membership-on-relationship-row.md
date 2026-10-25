# Membership facts on the relationship row — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `contact_studios` carries the un1t.online membership facts (plan, status, since, ended_at), the sync writes them, every reader reads them, and `contact_memberships` is dropped.

**Architecture:** Mig 770 adds four sync-owned columns and backfills them from the API rows; the un1t sync's step 7 writes them through one helper after its relationship write; the five reader sites read `contact_studios` behind one mapper that hands the pure shape functions the row shape they already take; mig 771 (applied after deploy, after one sync) copies any newer table values across and drops the table. A JS guard pins the sync as the only writer; PGlite pins the SQL.

**Tech Stack:** Next.js 16 route/lib code, supabase-js, Postgres migrations (PGlite-tested), vitest.

**Spec:** `docs/superpowers/specs/2026-10-25-membership-on-relationship-row-design.md` (approved 25 Oct 2026). Read it first; the parent spec is `docs/superpowers/specs/2026-10-20-org-shared-contacts-whatsapp-design.md` §2.

## Global Constraints

- Branch off `origin/main` after #2197-ish (the ORGCONTACTS.6 PR) merges; one PR; `ORGCONTACTS.7` ticket prefix; `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` on every commit.
- Columns, exactly: `membership_plan text`, `membership_status text CHECK (membership_status IN ('active','ended'))`, `membership_since timestamptz`, `membership_ended_at timestamptz`; CHECK `membership_status IS NULL OR ((membership_status = 'ended') = (membership_ended_at IS NOT NULL))` and CHECK `membership_status IS NOT NULL OR (membership_plan IS NULL AND membership_since IS NULL AND membership_ended_at IS NULL)`.
- Only `src/lib/un1t-online-sync.js` calls `setMembershipFacts`; `upsertContactStudio`, `touchContactStudio` and `private.contact_studios_upsert` never name a membership column.
- Mig 770 is applied to prod (project `iyvtbjjxdggiadzwwvdj`, via `apply_migration` with Richard's approval) BEFORE the PR merges; mig 771 AFTER the deploy and after one `un1t-online-sync` run (`un1t_sync_runs` newer than the deploy).
- Export-source (`un1t_online_export`) rows are never carried into the columns.
- The 13-command CI mirror + `npm run build` green before push; changelog entry `docs/changelog/entries/<PR>.md` after `gh pr create`.
- Numbers if main takes 770/771 first: renumber and update the design, the tests and this plan.

## Review Focus

1. **A member who lapsed and rejoined.** The row must go `ended` (with `membership_ended_at`) and back to `active` with `membership_ended_at` NULL and `membership_since` kept from the first activation. *Pinned in Task 3.*
2. **The window between mig 770 and the deploy.** A membership that ended, started or changed plan while the old code still wrote the table must reach the columns before the table goes. *Pinned in Task 6 (parity pass copies status, ended_at, plan; since only where null).*
3. **A facts write for a contact with no relationship row** (the contact is not in the client pull and not a subscriber this run). It is counted and logged, never a run failure. *Pinned in Task 3.*
4. **Another studio's rows.** The facts read and every write filter on the sync's `location_id`; a Stillorgan relationship row of a Hatch member is never read or written. *Pinned in Task 3.*
5. **An ended membership followed by a paid pack.** The pipeline snapshot must still classify `lead`, not `ex_member`; the mapper hands the shapes `source: 'un1t_online_api'` so they do not drop the row. *Pinned in Task 4.*

---

### Task 1: Mig 770 — the four columns, the backfill, derive and reconcile read them

**Files:**
- Create: `supabase/migrations/770_contact_studios_membership_facts.sql`
- Create: `tests/migration-770-contact-studios-membership-facts.test.js`
- Modify: `tests/helpers/contact-studios-fixture.js` (seeds: api rows for C_C1 at B active plan 'Founding Membership — Unlimited' first_seen 2026-02-01; C_D1 at A ended 2026-09-01 plan 'Monthly'; an export row for C_C1 at B ended 2026-10-16; keep `contact_memberships` created in BEFORE2)
- Modify: `tests/helpers/closed-functions.js` only if the function-execute guard asks (it should not: CREATE OR REPLACE keeps the ACL and the REVOKE lines are restated as in 768)

**Interfaces:**
- Produces: the four columns on `public.contact_studios`; `public.derive_contact_studio` whose `membership_row` is `EXISTS (SELECT 1 FROM public.contact_studios x WHERE x.contact_id = p_contact_id AND x.location_id = p_location_id AND x.membership_status = 'active')` and whose `first_seen_at` LEAST includes `(SELECT membership_since FROM public.contact_studios x WHERE …)`; `public.reconcile_contact_studios` with no `contact_memberships` in its pair union.

- [ ] **Step 1: Write the failing PGlite test** (`bootProd` as `tests/contact-studios-read-model.test.js` does, through 768, then 770):

```js
it('adds the four columns with their CHECKs; service role only, no client privilege', …)   // information_schema + pg_constraint + table_privileges
it('backfills every un1t_online_api row (plan, status, since, ended_at) and no export row', …) // C_C1@B active/'Founding Membership — Unlimited'/since 2026-02-01; C_D1@A ended/2026-09-01; export row ignored; NOTICE text contains 'skipped 1 export'
it("derive reads membership_status = 'active' as the membership (kind member) and membership_since into first_seen_at; an ended one is kind client", …)
it('contact_studios_upsert never names a membership column: the reconcile leaves plan/status/since/ended_at as they were', …)   // UPDATE a column by hand, run reconcile_contact_studios(NULL), unchanged
it('fails closed on an api row violating the CHECK, naming it, and changes nothing', …)     // boot with status active + ended_at set → abortMessage matches /violate/, columns absent
it('replay-safe: with no source columns on contact_memberships (the 648 stub) it adds the columns and backfills nothing', …)
it('idempotent: a second run passes and changes nothing (md5 of derive and reconcile unchanged)', …)
```

- [ ] **Step 2: Run** `npx vitest run tests/migration-770-contact-studios-membership-facts.test.js` — Expected: FAIL, ENOENT on the migration file.
- [ ] **Step 3: Write the migration**: header (WHY / APPLY BEFORE deploy / ROLLBACK: drop the four columns, re-run 768 §1), `BEGIN; SET LOCAL lock_timeout = '5s';` pre-checks (768 applied: `glofox_crossover_members` absent; the CHECK-violation scan over api rows when the source columns exist), `ALTER TABLE … ADD COLUMN IF NOT EXISTS` ×4 + the two CHECK constraints (`contact_studios_membership_status_check`, `contact_studios_membership_shape_check`), the guarded backfill (`UPDATE … FROM contact_memberships cm WHERE cm.source = 'un1t_online_api'`, counting api rows copied and export rows skipped into a NOTICE), `COMMENT ON COLUMN` ×4 naming the one writer, derive + reconcile re-created (768's text with the two changes; restate `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` and the reconcile GRANT to service_role), self-check (columns and CHECKs present from the catalog; derive's prosrc no longer names `contact_memberships`; reconcile's prosrc neither; every api row's relationship row carries its status), `COMMIT;`.
- [ ] **Step 4: Run** the test — Expected: 7 passed. Also `npx vitest run tests/contact-studios-read-model.test.js tests/migration-768-contact-side-channels-dropped.test.js tests/function-execute-guard.test.js tests/table-default-acl-guard.test.js tests/migration-648-credential-column-grants.test.js tests/contacts-read-scope-migration-guard.test.js` — Expected: all pass.
- [ ] **Step 5: Commit** `ORGCONTACTS.7 — mig 770: membership facts on contact_studios, backfilled from the API rows; derive and reconcile read them`.

### Task 2: `setMembershipFacts`, the row columns, and the one-writer guard

**Files:**
- Modify: `src/lib/contact-studios.js` (`ROW_COLUMNS` gains `, membership_plan, membership_status, membership_since, membership_ended_at`; new export)
- Modify: `src/lib/contact-studios.test.js`
- Create: `tests/membership-facts-writer-guard.test.js`

**Interfaces:**
- Produces: `export async function setMembershipFacts(db, { contactId, locationId, plan = null, status, endedAt = null, nowIso = new Date().toISOString() }) → Promise<{ ok: true, updated: boolean } | { ok: false, error: string }>`. `status` is `'active'` or `'ended'` (anything else → `{ ok: false }` without a write). It issues ONE update of `{ membership_plan, membership_status, membership_ended_at, updated_at }` filtered on `contact_id` + `location_id` with `.select('contact_id')`; `updated` is `rows.length > 0`. When `status === 'active'` and `updated`, a SECOND update `{ membership_since: nowIso }` filtered the same way plus `.is('membership_since', null)` (the `first_seen_at` pattern). When `status === 'ended'`, `membership_ended_at` is `endedAt ?? nowIso`; when active it is `null`. Never touches kind/status/source/stage_slug/first_seen_at/last_seen_at.
- Produces: `export const MEMBERSHIP_FACT_COLUMNS = 'membership_plan, membership_status, membership_since, membership_ended_at'`.

- [ ] **Step 1: Write the failing tests** in `contact-studios.test.js` (reuse `fakeDb`):

```js
describe('setMembershipFacts', () => {
  it('active: one update of plan/status/ended_at null, then a guarded membership_since stamp only where null', …)   // ops: ['update','update']; second has filter is('membership_since', null)
  it('ended: one update with membership_ended_at = endedAt ?? nowIso and no since stamp', …)
  it('a zero-row update is { ok: true, updated: false } with no second write; a failed write is { ok: false }; a bad status writes nothing', …)
  it('never names kind, status, source, stage_slug, first_seen_at or last_seen_at', …)
})
it('ROW_COLUMNS carries the four membership columns (studiosOfContact readers see the plan)', …)
```

- [ ] **Step 2: Run** `npx vitest run src/lib/contact-studios.test.js` — Expected: FAIL, `setMembershipFacts is not a function`.
- [ ] **Step 3: Implement** in `contact-studios.js` (JSDoc states: the un1t sync is the only caller; the row must already exist).
- [ ] **Step 4: Run** — Expected: pass.
- [ ] **Step 5: Write the guard** `tests/membership-facts-writer-guard.test.js`: walks `src/`, `shared/`, `mobile/` (skipping tests and node_modules, as `tests/un1t-online-write-guard.test.js`'s `sourceFiles` does); asserts (a) the only file containing `setMembershipFacts(` outside `src/lib/contact-studios.js` is `src/lib/un1t-online-sync.js`, (b) no file other than `contact-studios.js` has a `.from('contact_studios')` chain whose text between `.from('contact_studios')` and the next `)` of an `.update(`/`.upsert(`/`.insert(` names `membership_`, (c) `contact-studios.js` itself names `membership_` only inside `setMembershipFacts` and `ROW_COLUMNS`/`MEMBERSHIP_FACT_COLUMNS`. Also asserts the migrations after 770 never `UPDATE public.contact_studios SET membership_` except 770 and 771 (the backfill and the parity pass).
- [ ] **Step 6: Run** the guard — Expected: pass (nothing calls it yet). Add a temporary call in a scratch file to see it fail, then delete the scratch file (the RED for a guard).
- [ ] **Step 7: Commit** `ORGCONTACTS.7 — setMembershipFacts: the un1t sync's one write of the membership columns; the row columns carry them; a guard pins the one writer`.

### Task 3: The sync writes the facts (step 7 re-ordered around step 7a)

**Files:**
- Modify: `src/lib/un1t-online-sync.js:558-696` (`reconcileMemberships`), `:460-495` (the step 7 / 7a call order)
- Modify: `src/lib/un1t-online-sync.test.js:792-1010` (the membership tests)

**Interfaces:**
- Consumes: `setMembershipFacts` (Task 2); `writeContactStudios` unchanged.
- Produces: `reconcileMemberships(db, { locationId, organizationId, subscriptions, contactIdOf, resolverErrors, nowIso }) → { counts, error, memberContactIds, endedContactIds, plan: Map<contactId, planName> }` where it NO LONGER WRITES; it computes `best`, reads the facts rows (`contact_studios` at the studio, `.eq('membership_status','active')`, `select('contact_id, membership_plan')`, paged), applies the three ending guards verbatim, and returns `toEnd` contact ids as `endedContactIds`. A new `writeMembershipFacts(db, { locationId, memberContactIds, plan, endedContactIds, nowIso }) → { active, ended, rows_missing, failed }` runs AFTER `writeContactStudios`: for each member `setMembershipFacts({ status: 'active', plan: plan.get(id) })`, for each ended `setMembershipFacts({ status: 'ended' })`; `updated: false` → `rows_missing += 1` + `logError('un1t-online-sync', 'membership facts: no relationship row', …)`; `{ ok: false }` → `failed += 1` + logError. `counts.memberships` = `{ ...reconcile.counts, ...facts }`. A failed facts write is counted, never the run's failure (the relationship write already is the authority; the next run repairs).
- The run's `failure('db', …)` branch for memberships goes with the write; a failed FACTS READ (the active-rows page) stays a run failure as today's `reading active memberships` did.

- [ ] **Step 1: Rewrite the failing tests**: for each existing membership test (`a subscription gone from the pull ends its membership`, `a cancelled subscription ends the membership; a reactivated one re-activates the same row`, the ending-guard tests at 930/942/965/998, `a plan with no product title is recorded as Membership`): the fake serves `contact_studios` rows instead of `contact_memberships` and the assertions read the `contact_studios` updates (`membership_status`, `membership_plan`, `membership_ended_at`, the guarded `membership_since` stamp). Replace `export-source membership rows are untouched` with `the sync never reads or writes contact_memberships` (no op on that table in the log). Add: `a rejoin re-activates: ended_at null, since kept` (Review Focus 1); `a member with no relationship row after 7a is counted in rows_missing and logged, the run stays ok` (RF3); `every facts read and write filters on the studio's location_id` (RF4); `the facts are written AFTER writeContactStudios (op order in the log)`.
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-sync.test.js` — Expected: the rewritten tests FAIL (writes still go to contact_memberships).
- [ ] **Step 3: Implement** the split and the order in `un1t-online-sync.js`; update the step 7 / 7a header comments (7a no longer says "contact_memberships stays the authority").
- [ ] **Step 4: Run** the file — Expected: pass. Run `npx vitest run tests/un1t-online-write-guard.test.js tests/membership-facts-writer-guard.test.js` — Expected: pass.
- [ ] **Step 5: Commit** `ORGCONTACTS.7 — the un1t sync writes the membership facts onto the relationship row after its relationship write; every ending guard kept`.

### Task 4: The readers move behind one mapper

**Files:**
- Create: `src/lib/membership/membership-facts.js` — `export const MEMBERSHIP_FACT_READ_COLS = 'contact_id, membership_plan, membership_status, membership_since, membership_ended_at'`; `export function membershipRowsFromStudioRows(rows) → Array<{ contact_id, source: 'un1t_online_api', status, ended_at, plan_name }>` (rows with `membership_status == null` are dropped).
- Create: `src/lib/membership/membership-facts.test.js`
- Modify: `src/lib/membership/reads/un1t-online.js:125-131` (`listEndedMemberships` → `contact_studios`, `.eq('membership_status','ended')`, select `membership_ended_at`, mapped), `:258-267` (`countEnded` → `contact_studios`, `.eq('membership_status','ended').gte('membership_ended_at', …)`), `:636-642` and `:826-838` (the two `MEMBERSHIP_COLS` reads → `contact_studios` + `MEMBERSHIP_FACT_READ_COLS` + mapper; the second one drops `.in('source', [API_SOURCE, EXPORT_SOURCE])`), `MEMBERSHIP_COLS` and `EXPORT_SOURCE` removed if unused.
- Modify: `src/lib/membership/reads/un1t-online-radar.js:49,163` (`ENDED_COLS` → `MEMBERSHIP_FACT_READ_COLS`, the `listAt` on `contact_studios` with `.eq('membership_status','ended')`, mapped; `STATUS_SOURCES` removed).
- Modify: `src/lib/trial-eligibility.js:98-103` (`exists(db, 'contact_studios', { …, build: (q) => q.eq('contact_id', contactId).eq('membership_status', 'active') })`, reason stays `contact_membership_active`).
- Modify tests: `src/lib/membership/reads/un1t-online.test.js` (seeds and the table lists at :95, :349, :356, :724, :766, :777), `un1t-online-radar.test.js` (:95, :258-277), `src/lib/trial-eligibility.test.js`.

**Interfaces:**
- Consumes: the four columns (Task 1). The pure shapes (`shapeFlows`, `shapeWinbackRows`, `shapePipelineSnapshot`, `shapePipelineDateEvidence`) are untouched.

- [ ] **Step 1: Write the failing mapper test**: `membershipRowsFromStudioRows` maps `{ contact_id, membership_plan, membership_status, membership_ended_at }` → `{ contact_id, source: 'un1t_online_api', status, ended_at, plan_name }`, drops rows with null status, keeps order; and a shape test: `shapePipelineSnapshot({ memberships: membershipRowsFromStudioRows([ended row]), transactions: [paid pack after the end] … })` classifies `lead` (RF5) and with no pack `ex_member`.
- [ ] **Step 2: Run** — Expected: FAIL, module not found.
- [ ] **Step 3: Implement** the module.
- [ ] **Step 4: Rewrite the reader tests** so the fakes serve `contact_studios` rows carrying the four columns and assert: `membershipFlows` counts cancellations by `membership_ended_at`; the growth read's table list names `contact_studios` not `contact_memberships`; the radar's win-back reads `contact_studios` with `membership_status = 'ended'`; trial eligibility's `contact_membership_active` comes from an active facts row at the studio; every read filters on `location_id`.
- [ ] **Step 5: Run** the three reader test files — Expected: FAIL on the old table.
- [ ] **Step 6: Implement** the reader changes.
- [ ] **Step 7: Run** `npx vitest run src/lib/membership src/lib/trial-eligibility.test.js src/lib/membership/glofox-active-members.test.js` and `npm run check:select-columns` — Expected: pass; the gate resolves the four columns from 770.
- [ ] **Step 8: Commit** `ORGCONTACTS.7 — churn, growth, win-back, trial eligibility and the pipeline snapshot read the membership facts off contact_studios`.

### Task 5: The Studios card shows the membership

**Files:**
- Modify: `src/components/contact/ContactStudiosCard.jsx:34-42`, `src/components/contact/ContactStudiosCard.test.jsx`

- [ ] **Step 1: Write the failing test**: a row with `membership_status: 'active', membership_plan: 'Founding Membership — Unlimited', membership_since: '2026-02-01T00:00:00Z'` renders `Founding Membership — Unlimited · member since 1 Feb 2026`; an ended one renders `… · membership ended 1 Sep 2026`; a row with no membership facts renders neither phrase.
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement** one line under the source/since line, using the card's `formatDate`.
- [ ] **Step 4: Run** — Expected: pass. Commit `ORGCONTACTS.7 — the Studios card shows the un1t.online plan and its dates`.

### Task 6: Mig 771 — parity pass, then the drop

**Files:**
- Create: `supabase/migrations/771_contact_memberships_dropped.sql`
- Create: `tests/migration-771-contact-memberships-dropped.test.js`
- Modify: `tests/contact-studios-read-model.test.js` (replay 770 and 771 after 768; add `it('the membership facts survive the reconcile and the table is gone')`), `tests/helpers/contact-studios-fixture.js` (nothing removed: BEFORE2 still creates the table because 764 reads it; 771 drops it), `tests/migration-648-credential-column-grants.test.js` (confirm its stub replays; widen the stub only if 770/771 fail on it), `tests/helpers/sql-escapes.js` (leave `contact_memberships` unless `tests/closed-table-escapes-guard.test.js` fails on an absent table).

- [ ] **Step 1: Write the failing test**: boot through 770 with the fixture seeds, then simulate the window (`UPDATE contact_memberships SET status = 'ended', ended_at = '2026-10-20' WHERE contact = C_C1`, and a new api row for C_C2 at B active plan 'New plan' with its relationship row carrying no facts) → apply 771 → `it('copies status, ended_at and plan from newer api rows, since only where null, and reports the count', …)`, `it('drops the table; nothing references it (pg_views, pg_policies, pg_proc)', …)`, `it('pre-check refuses while a view or function still names the table', …)`, `it('replay-safe: on an absent table (the 648 stub world after 770) it passes and does nothing', …)`, `it('idempotent', …)`.
- [ ] **Step 2: Run** — Expected: FAIL, ENOENT.
- [ ] **Step 3: Write the migration**: header (APPLY AFTER deploy AND after one sync run; ROLLBACK: mig 722's DDL and a backfill from the columns), pre-checks (770 applied; no dependent view/policy/function other than the ones 770 re-created), the parity pass (an UPDATE … FROM for api rows whose `(status, ended_at, plan_name)` differ, since where null; NOTICE with the count), `DROP TABLE IF EXISTS public.contact_memberships`, self-check (table absent; the four columns present; no row with `membership_status = 'ended'` and null `membership_ended_at`), `COMMIT`.
- [ ] **Step 4: Run** the 771 test, the read-model test, the 648 test, `tests/closed-table-escapes-guard.test.js`, `tests/any-member-write-tables-guard.test.js`, `tests/member-write-sweep-guard.test.js` — Expected: pass.
- [ ] **Step 5: Commit** `ORGCONTACTS.7 — mig 771: the parity pass, then contact_memberships is dropped (apply after deploy and one sync)`.

### Task 7: Docs, mirror, PR

**Files:**
- Modify: `CLAUDE.md` (the contacts invariant: the four membership columns, the one writer, "a derived row is never its own proof: the facts are sync-owned"), `docs/architecture/REFERENCE.md:142` (table map: `contact_memberships` gone; the columns), `docs/BACKLOG.md:26` (remove the dated drop), `docs/LESSONS.md` (one sentence on the ORGCONTACTS entry: the table held no history, so the move was free), the design doc (status line: implemented).

- [ ] **Step 1: Edit the docs**; run `npx vitest run tests/changelog-entries.test.js tests/audience-view-columns-guard.test.js`.
- [ ] **Step 2: Run the mirror**: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:bundle-sql && npm run check:ota-paths && npm run build` — Expected: all green.
- [ ] **Step 3: Apply mig 770 to prod** (Richard's approval), `get_advisors` security, read back: 29 rows with `membership_status = 'active'` at Hatch, 0 export carried.
- [ ] **Step 4: Push, `gh pr create --base main`, add `docs/changelog/entries/<PR>.md`, commit, push.** PR body states the 771 apply condition.
- [ ] **Step 5: After merge and deploy and one sync run**: apply 771 (Richard's approval), `get_advisors`, read back the parity count and `to_regclass('public.contact_memberships') IS NULL`.
