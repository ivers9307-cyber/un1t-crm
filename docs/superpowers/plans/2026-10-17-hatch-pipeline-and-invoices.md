# Hatch Street acquisition pipeline from un1t.online data, and invoices: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hatch Street gets back an automatic acquisition board classified from un1t.online data only, every contact's `pipeline_stage_slug` comes from its own studio's boards, Hatch staff see un1t.online payments and overdue on the contact page and command centre, and `un1tOnlineSource.capabilities.invoices` flips true.

**Architecture:** The unchanged `classifyContact` is fed per-contact snapshots that a new seam read (`un1tOnlineReads.pipelineInputs`) builds from `un1t_*` rows of one location, never from `contacts` columns; a second board module `acquisition_un1t` tells the orchestrator to take that path, so Stillorgan's Glofox path stays byte-for-byte the same. Migration A1 rewrites the slug trigger to an own-studio rule and a fence in `triggerSequencesForDealPlacement` stops cross-studio enrolments; migration A2 re-enables Hatch's board. Billing reads (`pastDue`, `paymentsFor`) live in the same seam and drive a new contact-page card, header band and command-centre field.

**Tech Stack:** Next.js 16 App Router, Supabase (service role, Postgres triggers), vitest (jsdom for components), PGlite for migration behaviour tests.

**Spec:** `docs/superpowers/specs/2026-10-17-hatch-pipeline-and-invoices-design.md` (spec A). Sibling specs B (`…-hatch-radar-arrears-briefing-design.md`), C, D (`…-un1t-online-write-back-design.md`) and E (`…-mia-at-hatch-design.md`) consume `pastDue`, `paymentsFor`, `pipelineInputs`, `shapePipelineSnapshot`, `trialEligibility` and `freshCutoff` exactly as named here.

## Global Constraints

- No un1t-derived value is ever written to a `contacts` column (`glofox_*`, `last_attended_at`, `recent_bookings`, `joined_at`, `converted_at`, `pack_customer_at`, `trial_credits_remaining` included). Nothing in this plan sends a customer message, starts a sequence or schedules a Mia follow-up. No Glofox API call for a Hatch location.
- The Hatch acquisition board is never classified from `contacts` columns: un1t state `unknown`, unconfigured, missing `pipelineInputs`, or a failed adapter read skips the board for that run (`status:'failed'`, `error_message:'un1t inputs unavailable: <state>'`).
- Every location without a un1t-input board (Stillorgan included) runs the same queries in the same order as today; no membership-state read.
- Slug rule (A1): own studio's enabled primary board, else own studio's other enabled board, else **unchanged**; never NULL as a side effect; keep the `IS DISTINCT FROM` guard.
- Overdue with no surviving open invoice shows "amount not reported by un1t.online", never a number. Unknown invoice status is shown verbatim, never owed.
- Money is integer cents; currency is upper-cased in every shaper; amounts are summed only across like currencies (Glofox arrears count as `EUR`).
- A viewer sees a studio's un1t payments only with location access to that studio.
- Hatch: location `28c78d6b-f7b3-4edf-8c7c-840bd047b3f4`; Supabase project `iyvtbjjxdggiadzwwvdj`.
- Migrations are forward-only. Numbers are placeholders `NNN` (A1) and `MMM` (A2): take the next free number at build time (`ls supabase/migrations`; 733-735 are taken on main and siblings B-E also allocate). Implementer subagents have no MCP access: the **controller applies via Supabase MCP `apply_migration` on project iyvtbjjxdggiadzwwvdj before the PR merges, then `get_advisors` security**. Every new relation/function states its grant decision in the file.
- Each PR: fresh branch off `git fetch origin main && git checkout -b <branch> origin/main`; run the full CI mirror (`npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:bundle-sql && npm run check:ota-paths`) plus `npm run build` when imports or routes change; `gh pr create --base main --fill`; then add `docs/changelog/entries/<PR>.md` (one row `| #<PR> | KEY — title | 2026-10-DD. … |`) and push it.
- Edits under `shared/` publish an OTA (no-op group) on merge: only Task 8 touches `shared/`. Nothing touches `mobile/`.
- Logs carry ids and reason codes only, no PII: `logWarn('pipeline-reclassify', 'inputs unavailable', { locationId, source, state, reason })`, `logWarn('sequences', 'stage_trigger_skipped', { reason, dealLocationId })`, `logWarn('un1t-billing', 'unknown invoice status', { locationId, status })`.
- Supabase builders are thenables: destructure and check `error` on every read and write; `.range()`-paginate with explicit `.order()` (`selectAll` / `selectAllByKeys` from `@/lib/select-all`).
- Staff chips `bg-<c>-500/10 text-<c>-700`. Tests use fictional ids.

## Review Focus

1. **A cancelled subscription that still carries `past_due_at`** (un1t.online often leaves the stamp): a reasonable person expects no overdue flag unless an open invoice survives. The subscription signal counts only when its status is not an ended status. Test in Task 4 (`shapePastDue`).
2. **Lower-case currency from Stripe (`eur`)**: the card must show `€`, and the header sum must add it to Glofox EUR arrears. Test in Task 4 (shapers upper-case) and Task 12 (`mergeArrearsCents`).
3. **A dual-studio member whose Stillorgan `contacts` row is full of Glofox values** must be classified at Hatch only from Hatch rows (no member status, no recent bookings leak). Test in Task 6.
4. **A Hatch-only staff viewer opens a Stillorgan-owned contact who is also a Hatch member, and a Stillorgan-only manager opens the same person**: the Hatch card shows for the first and not the second. Test in Task 12.
5. **The post-sync reclassify throws or hangs on a bad row**: the sync's result, tenant heartbeat and cron heartbeat are unchanged. Test in Task 10.

## PR map

| PR | Branch | Tasks | Migration | OTA |
|---|---|---|---|---|
| 1 HATCHPIPE.1: own-studio slug rule (A1) + sequence fence | `hatchpipe-1-slug-own-studio` | 1-3 | **A1 `NNN_contacts_stage_slug_own_studio.sql`** | no |
| 2 HATCHPIPE.2: un1t pipeline inputs, billing seam, contact page, account-tools fix (board still disabled, inert) | `hatchpipe-2-un1t-inputs-billing` | 4-15 | none | **yes** (Task 8, `shared/pipelines/`) |
| 3 HATCHPIPE.3: re-enable Hatch acquisition board (A2) | `hatchpipe-3-hatch-board-on` | 16 | **A2 `MMM_hatch_acquisition_board_enable.sql`** | no |
| 4 HATCHINV.1: flip `invoices` | `hatchinv-1-invoices-flip` | 17 | none | no |

PR 4 must be live before spec B flips `memberships`. Task 14's account-tools fix (PR 2) must be live before spec D flips `bookings`.

## File map

- `supabase/migrations/NNN_contacts_stage_slug_own_studio.sql` (A1), `supabase/migrations/MMM_hatch_acquisition_board_enable.sql` (A2), tests `tests/migration-NNN-stage-slug-own-studio.test.js`, `tests/migration-MMM-hatch-acquisition-board.test.js`.
- `src/lib/sequences/triggers.js` (fence) and callers `src/lib/glofox-sync.js`, `src/app/api/deals/[id]/stage/route.js`, `src/app/api/deals/[id]/route.js`, `src/app/api/contacts/[id]/pipeline-status/route.js`.
- `src/lib/membership/reads/un1t-online-shape.js` (pure: invoice normaliser, past-due, snapshot, eligibility), `src/lib/membership/reads/un1t-online.js` (`freshCutoff` + four reads), `src/lib/membership/reads/index.js` (`READ_KEYS`).
- `shared/pipelines/acquisition-un1t.js` (new), `shared/pipelines/index.js`.
- `src/lib/pipeline-reclassify.js`, `src/app/api/admin/pipeline-reclassify/route.js`.
- `src/lib/un1t-pipeline-cadence.js` (new), `src/app/api/cron/un1t-online-sync/route.js`.
- `src/lib/pipeline-board.js`, `src/app/(sales)/pipeline/page.js`, `src/app/api/pipeline/deals/route.js`.
- `src/lib/contact-un1t-billing.js` (new), `src/components/contact/Un1tPaymentsCard.jsx` (new), `src/components/contact/ContactWhoRail.jsx`, `src/lib/contact-view.js`, `src/app/(sales)/contacts/[id]/page.js`, `src/app/api/contacts/[id]/command-centre/route.js`.
- `src/lib/agent/account-tools.js`, `src/lib/membership/sources/un1t-online.js`, `tests/invoices-capability-readers.test.js` (new).
- `docs/superpowers/specs/2026-09-01-un1t-online-hatch-integration-design.md` §0 (status spellings, Task 4).

---

## PR 1: HATCHPIPE.1 (A1 + fence)

### Task 1: Migration A1, own-studio slug rule

**Files:**
- Create: `supabase/migrations/NNN_contacts_stage_slug_own_studio.sql`
- Test: `tests/migration-NNN-stage-slug-own-studio.test.js`

**Interfaces:**
- Consumes: mig 595's `public.sync_contacts_pipeline_stage_slug()` (SECURITY DEFINER, `search_path public`), trigger from mig 155.
- Produces: the same function name/signature with the own-studio rule; file layout with the marker line `-- ─── 2. Recompute` separating section 1 (the `CREATE OR REPLACE FUNCTION`) from section 2 (recompute + self-check), so the test can run section 1 alone.

- [ ] **Step 0 (controller, Supabase MCP read-only):** compute, for every contact holding any open deal, `new_slug` by the A1 rule (CTE: open deals ⨝ stages ⨝ pipelines where `p.location_id = c.location_id AND p.enabled`, rank primary first then `d.created_at desc`), keep rows where `new_slug IS NOT NULL AND new_slug IS DISTINCT FROM c.pipeline_stage_slug`, and count them as (a) contact not at Hatch holding an open Hatch deal, (b) contact at Hatch, (c) contact at a location with no enabled board, (d) the rest. Expect (a) ≤ 12, (b)=(c)=(d)=0. Hand the four numbers to the implementer and keep them for the PR body. If (b), (c) or (d) is non-zero, stop and report to Richard.

- [ ] **Step 1: Write the failing tests** (PGlite: minimal `locations`, `pipelines(id, location_id, key, enabled, is_primary)`, `pipeline_stages(id, location_id, pipeline_id, slug)`, `deals(id, contact_id, location_id, stage_id, pipeline_id, status, created_at)`, `contacts(id, location_id, pipeline_stage_slug)`, the mig-155 trigger `AFTER INSERT OR UPDATE OR DELETE ON deals FOR EACH ROW`, then section 1 of the file):

```js
it('primary deal at own studio wins over a newer deal on another own-studio board')
it('no own-studio primary deal → newest open deal on another enabled own-studio board')
it('a newer open deal at another studio never sets the slug (Stillorgan member with a Hatch waitlist deal keeps their Stillorgan stage)')
it('no own-studio open deal → slug unchanged (not NULL, not the other studio\'s)')
it('closing the last open deal leaves the slug unchanged')
it('a disabled own-studio board is ignored')
it('section 2 recompute gives the same slug as the trigger for every fixture contact')
// static, on the file text:
it('every SELECT branch filters p.location_id = v_loc and p.enabled')
it('no branch assigns NULL to pipeline_stage_slug (no "= NULL", no v_slug := NULL before the UPDATE)')
it('keeps IS DISTINCT FROM on the UPDATE and states "-- grant: none"')
it('declares the four expected-count constants and raises when any differs')
it('post-check raises when a contact with an own-studio open deal holds a slug different from the rule')
```

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run tests/migration-NNN-stage-slug-own-studio.test.js` · Expected: FAIL (file missing).

- [ ] **Step 3: Write the migration.** Section 1: `CREATE OR REPLACE FUNCTION public.sync_contacts_pipeline_stage_slug()` with `v_loc := (SELECT location_id FROM contacts WHERE id = v_contact_id)`, two ordered SELECTs (enabled primary at `v_loc`; any other enabled board at `v_loc`, newest `d.created_at`), and `IF v_slug IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;` before the guarded UPDATE. Header comment cites spec A §6.6 and mig 595, and `-- grant: none (function body only, CREATE OR REPLACE keeps the ACL)`. Section 2 (`-- ─── 2. Recompute`): one `DO $$` block with `v_expect_a/b/c/d constant int := <Step 0 numbers>`; computes the four counts with the Step 0 CTE, `RAISE EXCEPTION` on any mismatch, applies one `UPDATE contacts … FROM (cte) WHERE … IS DISTINCT FROM`, then the post-check of the last test.

- [ ] **Step 4: Run to verify pass.** Run: `npx vitest run tests/migration-NNN-stage-slug-own-studio.test.js` · Expected: PASS.

- [ ] **Step 5: Commit.** `git add supabase/migrations/NNN_contacts_stage_slug_own_studio.sql tests/migration-NNN-stage-slug-own-studio.test.js && git commit -m "HATCHPIPE.1 — mig NNN: contacts.pipeline_stage_slug from the contact's own studio, never NULLed"`

### Task 2: Sequence fence on deal placement

**Files:**
- Modify: `src/lib/sequences/triggers.js:299-312`, `src/lib/glofox-sync.js:491-560` (move result) and `:2292-2296`, `src/app/api/deals/[id]/stage/route.js:120-135`, `src/app/api/deals/[id]/route.js:36-40,110-125`, `src/app/api/contacts/[id]/pipeline-status/route.js:110-115`
- Test: `src/lib/sequences/triggers.test.js`, `src/lib/glofox-sync.test.js`, `src/app/api/deals/[id]/stage/route.test.js`, `src/app/api/deals/[id]/route.test.js`, `src/app/api/contacts/[id]/pipeline-status/route.test.js`

**Interfaces:**
- Produces: `triggerSequencesForDealPlacement(contactId, dealResult, { dealLocationId, pipelineId } = {}) → Promise<void>`; never throws. Gate order: `action==='move'` and slugs differ (unchanged) → `dealLocationId` and `pipelineId` both present (else skip `missing_board`) → re-read `contacts.select('id, location_id, pipeline_stage_slug').eq('id', contactId).maybeSingle()` → `location_id === dealLocationId` (else `cross_location`) → `pipeline_stage_slug === to_slug` (else `not_slug_source`) → `triggerSequencesForPipelineStageChange(contactId, from, to)`. Each skip logs `logWarn('sequences', 'stage_trigger_skipped', { reason, dealLocationId })`. A failed contact read skips with reason `contact_unreadable`.
- Produces: `ensureDealForContact` move result gains `pipeline_id` and `location_id` (additive): `{ action: 'move', deal_id, from_slug, to_slug, pipeline_id, location_id }`.

- [ ] **Step 1: Write the failing tests.**

```js
// triggers.test.js
it('refuses with missing_board when dealLocationId or pipelineId is absent', …)   // enrolContacts not called; logWarn reason 'missing_board'
it('refuses cross_location when the deal is at another studio than the contact', …)
it('refuses not_slug_source when the re-read slug differs from to_slug', …)
it('own-studio move that is the slug source enrols at that studio', …)        // email_sequences queried with .eq('location_id', contact.location_id)
it('leave/create/equal slugs still never enrol', …)
// glofox-sync.test.js
it('ensureDealForContact move result carries pipeline_id and location_id of the primary board', …)
// deals/[id]/stage/route.test.js
it('passes { dealLocationId: deal.location_id, pipelineId: deal.pipeline_id } to the trigger', …)
// deals/[id]/route.test.js
it('PUT selects pipeline_id and passes { dealLocationId: existing.location_id, pipelineId: existing.pipeline_id }', …)
// pipeline-status/route.test.js
it('Cold route passes the board ensureDealForContact used', …)
```

- [ ] **Step 2: Run to verify failure.** Run: `npx vitest run src/lib/sequences/triggers.test.js src/lib/glofox-sync.test.js 'src/app/api/deals/[id]' 'src/app/api/contacts/[id]/pipeline-status'` · Expected: FAIL on the new cases.

- [ ] **Step 3: Implement** the fence and the four call sites (`glofox-sync.js` and the Cold route pass `{ dealLocationId: dealResult?.location_id, pipelineId: dealResult?.pipeline_id }`; the PUT route's `existing` select becomes `'location_id, contact_id, stage_id, pipeline_id'`).

- [ ] **Step 4: Run to verify pass.** Same command · Expected: PASS. Then `npm run check:select-columns && npm run check:guardrails` · Expected: exit 0.

- [ ] **Step 5: Commit.** `git commit -am "HATCHPIPE.1 — fence pipeline_stage_change enrolment to own-studio slug-source moves"` (single-quote bracketed paths in any `git add`).

### Task 3: Ship PR 1

- [ ] **Step 1:** Run the full CI mirror (Global Constraints) · Expected: every command exits 0.
- [ ] **Step 2:** `git push -u origin HEAD && gh pr create --base main --fill`; PR body carries the Step 0 counts (a)-(d).
- [ ] **Step 3 (controller):** `apply_migration` A1 on iyvtbjjxdggiadzwwvdj, then `get_advisors` type=security · Expected: migration applies (its self-check passes), no new advisor finding.
- [ ] **Step 4 (controller, Supabase MCP read-only):** re-run the Step 0 query · Expected: 0 rows would change; the (a) contacts now carry their own studio's slug (list ids only in the PR).
- [ ] **Step 5:** add `docs/changelog/entries/<PR>.md` (`| #<PR> | HATCHPIPE.1 — slug from own studio (mig NNN) + sequence fence | 2026-10-DD. … |`), commit, push; `npx vitest run tests/changelog-entries.test.js` · Expected: PASS.

---

## PR 2: HATCHPIPE.2 (inputs, billing seam, contact page; board disabled)

### Task 4: `freshCutoff`, invoice normaliser, past-due shaping

**Files:**
- Modify: `src/lib/membership/reads/un1t-online.js` (extract `freshCutoff`, use it in `listActiveSubs`), `src/lib/membership/reads/un1t-online-shape.js`, `docs/superpowers/specs/2026-09-01-un1t-online-hatch-integration-design.md` §0
- Test: `src/lib/membership/reads/un1t-online-shape.test.js`, `src/lib/membership/reads/un1t-online.test.js`

**Interfaces:**
- Produces (`un1t-online.js`, exported): `freshCutoff(db, table, locationId) → Promise<string|null>`; `table` ∈ `'un1t_subscriptions' | 'un1t_invoices' | 'un1t_clients'` (anything else throws); ISO of newest `synced_at` minus `STALE_WINDOW_MS` (10 min), `null` when the table has no rows there; throws on a read error.
- Produces (`un1t-online-shape.js`): `UN1T_ENDED_SUB_STATUSES` (frozen array, starting `['canceled','cancelled','ended','expired','incomplete_expired']`, adjusted by Step 0); `normaliseUn1tInvoiceStatus(raw) → 'paid'|'open'|'void'|'refunded'|'unknown'`; `shapePastDue({ subs, invoices }) → PastDueRow[]` where `PastDueRow = { contactId, un1tUserId, subscriptionId, productTitle, since, amountCents, currency, openInvoiceIds, cancelAtPeriodEnd, pausedUntil }`, sorted by `since` ascending.
- Netting: an `open` invoice is netted out by a `paid` invoice on the same `subscription_id` with the same `amount_cents` and a later `remote_created_at`; each paid invoice nets at most one open invoice (the latest earlier one). Rows group by `(un1t_user_id, subscription_id)`.

- [ ] **Step 0 (controller, Supabase MCP read-only):** `select status, count(*) from un1t_invoices group by 1` and the same for `un1t_subscriptions` (all locations). Give the implementer the lists; they adjust the normaliser table and `UN1T_ENDED_SUB_STATUSES` and record the answer with the date in the integration spec §0.

- [ ] **Step 1: Write the failing tests.**

```js
it.each([
  ['paid','paid'], ['PAID','paid'], ['open','open'], ['past_due','open'], ['unpaid','open'], ['failed','open'],
  ['uncollectible','open'], ['void','void'], ['draft','void'], ['deleted','void'], ['refunded','refunded'],
  ['weird','unknown'], [null,'unknown'],
])('normaliseUn1tInvoiceStatus(%s) → %s', …)
it('past_due subscription with no open invoice → amountCents null, since = past_due_at')
it('open invoice netted by a later paid invoice of the same amount on the same subscription → no row')
it('a paid invoice of a different amount does not net')
it('one paid invoice nets only one of two equal open invoices → amountCents = one amount, since = the surviving one')
it('since = earliest of past_due_at and oldest surviving open invoice; openInvoiceIds lists survivors')
it('a canceled subscription carrying past_due_at and no open invoice → no row')            // Review Focus 1
it('unknown invoice status is never owed')
it('currency is upper-cased: eur → EUR')                                                   // Review Focus 2
// un1t-online.test.js
it('freshCutoff returns newest synced_at minus 10 min, per location; null with no rows; throws on error; refuses other tables')
it('listActiveSubs behaviour unchanged (existing UN1TREAD.7 staleness tests stay green untouched)')
```

- [ ] **Step 2:** Run: `npx vitest run src/lib/membership/reads/un1t-online-shape.test.js src/lib/membership/reads/un1t-online.test.js` · Expected: FAIL on new cases.
- [ ] **Step 3:** Implement the three exports and the `freshCutoff` refactor.
- [ ] **Step 4:** Same command · Expected: PASS.
- [ ] **Step 5:** `git commit -am "HATCHPIPE.2 — freshCutoff, un1t invoice status normaliser, past-due shaping"`

### Task 5: `pastDue` and `paymentsFor` reads

**Files:**
- Modify: `src/lib/membership/reads/un1t-online.js`, `src/lib/membership/reads/index.js` (`READ_KEYS`)
- Test: `src/lib/membership/reads/un1t-online.test.js`, `src/lib/membership/reads/index.test.js`

**Interfaces:**
- Consumes: `freshCutoff`, `shapePastDue`, `normaliseUn1tInvoiceStatus`, `glofoxInterval` (Task 4 / existing).
- Produces on `un1tOnlineReads`:
  - `pastDue(db, locationId, { contactIds } = {}) → Promise<{ success: true, data: PastDueRow[] } | { success: false, error }>`: fresh `un1t_subscriptions` + fresh `un1t_invoices` at `locationId`, `.in('contact_id', chunk)` via `selectAllByKeys` when `contactIds` given. Reads no `contacts`.
  - `paymentsFor(db, locationId, contactIds, { limit = 25 } = {}) → Promise<{ success: true, data: { subscriptions, transactions, invoices, pastDue } } | { success: false, error }>` with `subscriptions: [{ productTitle, status, priceCents, currency, interval, periodEnd, cancelAtPeriodEnd, pausedUntil, pastDueAt }]` (fresh rows), `transactions: [{ at, productTitle, type, amountCents, currency, refunded }]` (newest `limit` by `remote_created_at`), `invoices: [{ at, status, rawStatus, amountCents, currency }]` (fresh, newest `limit`), `pastDue: PastDueRow|null` (earliest `since`). Empty `contactIds` → `success:true` with empty lists and no query.
  - Each distinct unknown invoice status logs once per call: `logWarn('un1t-billing', 'unknown invoice status', { locationId, status })`.
- `READ_KEYS` becomes `['membershipCounts','mrr','membershipFlows','growth','engagement','revenueMtd','arrears','pastDue','paymentsFor','pipelineInputs','trialEligibility']` (Task 7 adds the last two functions; the keys land here).

- [ ] **Step 1: Write the failing tests.**

```js
it('pastDue and paymentsFor filter .eq("location_id", loc) on every table and never read contacts')
it('pastDue honours contactIds (only those contacts), paginates past 1,000 rows with range + order')
it('pastDue ignores a stale past_due subscription row (older than the freshness window)')
it('paymentsFor returns the documented shape; transactions newest first, capped at limit; refunded flag kept')
it('paymentsFor invoices carry normalised status and rawStatus; an unknown status logs once with { locationId, status }')
it('a failed page returns { success:false, error }, never throws')
// index.test.js: READ_KEYS equals the new list; glofox adapter supports the original seven and none of the four new keys;
//               un1t adapter supportsRead pastDue and paymentsFor
```

- [ ] **Step 2:** Run: `npx vitest run src/lib/membership/reads/` · Expected: FAIL on new cases.
- [ ] **Step 3:** Implement both reads; update the module header (no `arrears`, but `pastDue`).
- [ ] **Step 4:** Same command · Expected: PASS. `npm run check:select-columns` · Expected: exit 0.
- [ ] **Step 5:** `git commit -am "HATCHPIPE.2 — un1tOnlineReads.pastDue and paymentsFor"`

### Task 6: `shapePipelineSnapshot` and `shapeTrialEligibility` (pure)

**Files:**
- Modify: `src/lib/membership/reads/un1t-online-shape.js`
- Test: `src/lib/membership/reads/un1t-online-shape.test.js`

**Interfaces:**
- Consumes: `isTrialProduct`, `MEMBER_STATUSES`, `UN1T_ENDED_SUB_STATUSES`; `classifyContact` from `@shared/pipeline-classifier` in tests only.
- Produces:
  - `UN1T_AGGREGATOR_GYMPASS_SOURCES = ['wellhub','gympass']`, `UN1T_AGGREGATOR_MARKER = 'un1t:aggregator'`.
  - `shapePipelineSnapshot({ client, contact, locationId, freshSubs = [], transactions = [], productsById = new Map(), bookings = [], memberships = [], ledgerTrials = [], now = Date.now() }) → Snapshot` where `client` = un1t_clients row (`un1t_user_id, credit_balance, credit_unlimited, last_attended_at, remote_created_at`), `contact` = `{ id, location_id, pipeline_dismissed_at, last_lead_source_at }`, `bookings` = `[{ status, source, credit_charged, external_member_ref, remote_created_at, starts_at }]`, `memberships` = contact_memberships rows at this location with source `un1t_online_api`, `ledgerTrials` = `[{ at, product_id }]` (spec D's `op='trial'` `done` rows; always `[]` in this plan, see Task 7). `Snapshot` has exactly the classifier keys: `glofox_membership_status, glofox_membership_state, glofox_membership_expiry, last_attended_at, total_attended_7d, total_attended_30d, last_payment_at, joined_at, created_at, trial_credits_remaining, recent_bookings, converted_at, pack_customer_at, pipeline_dismissed_at, last_lead_source_at, gympass_member_id`.
  - `shapeTrialEligibility({ transactions = [], productsById = new Map(), ledgerTrials = [], subscriptions = [], memberships = [] }) → { eligible: boolean, reasons: Array<'trial_used'|'membership_history'|'paid_pack'> }` (reasons in that order, de-duplicated; `memberships` here = sources `un1t_online_api` and `un1t_online_export`, any status; `subscriptions` = every row, no freshness).
- Rules (spec §6.2, verbatim decisions): status order member → credit_member → classpass_payg → trial → ex_member → lead. Took a trial = a transaction whose product `isTrialProduct` (by `product_id`) or a ledger trial. Trial credits remaining = trial product `credits_per_period` − `credit_charged` bookings with `remote_created_at` ≥ trial time, floored 0, capped at `credit_balance`. Paid pack = `product_type='pack'`, `amount_cents > 0`, `refunded !== true`, product not a trial product. Paid credits = `credit_balance − trial credits remaining` only when a paid pack exists. `trial_credits_remaining` = null when `credit_unlimited`, `credit_balance` with a paid pack, else trial credits remaining. `recent_bookings` = 10 latest by `starts_at` (`{ attended: status==='attended', status: upper(status), time_start: floor(ms/1000) }`, bookings without `starts_at` dropped). Aggregator = any booking with `source !== 'direct'` or `external_member_ref`; gympass sources set `gympass_member_id` (`external_member_ref` else the marker); other aggregators get `classpass_payg`. `pipeline_dismissed_at`/`last_lead_source_at` only when `contact.location_id === locationId`.

- [ ] **Step 1: Write the failing table tests** (each asserts the snapshot field and `classifyContact(snapshot, NOW)`):

```js
it('fresh active subscription → member'); it('fresh past_due subscription → member')
it('paused subscription not ended → member'); it('fresh trialing → trial')
it('trial with 3 credits is trial, trial_credits_remaining 3, stage not pack_member')
it('€0 trial pack transaction is not a pack customer (pack_customer_at null)')
it('paid pack, 0 credits → pack_customer_at set, stage pack_member')
it('ended membership, nothing since → ex_member, stage dormant')
it('ex member who bought a paid pack after ending → pack_member')
it('ex member holding paid credits → credit_member')
it('ex member who attended after ending → placed by attendance (first_class)')
it('trial credits 3 and no paid pack → trial, not credit_member')
it('trial then a 5-pack, balance 7, one credit used since the trial → credit_member, trial left 2, paid 5, trial_credits_remaining 7')
it('ledger trial with no transaction → trial (ledgerTrials [{ at, product_id: TRIAL }])')
it('non-direct booking source → classpass_payg, stage classpass')
it('wellhub source → gympass_member_id = external_member_ref, stage gympass; no ref → "un1t:aggregator"')
it('aggregator who is also a fresh member → member')
it('1 / 2 / 3 attended within the window → first_class / second_class / trial_done')
it('upcoming booked class, nothing attended → new_lead'); it('lead aged out (joined 90 days ago) → dormant')
it('stale subscription row is not passed in freshSubs and never makes a member')        // via Task 7 test too
it('joined_at = later of client.remote_created_at and the newest trial')
it('dual-studio contact: pipeline_dismissed_at and last_lead_source_at are null when contact.location_id differs')
it('a contacts row full of Glofox values passed as `contact` never reaches the snapshot')  // Review Focus 3
it('unlimited credits → trial_credits_remaining null')
// eligibility
it('new person → { eligible: true, reasons: [] }'); it('any trial product used → trial_used'); it('ledger trial → trial_used')
it('ended or export-only membership → membership_history'); it('recurring transaction with no subscription row → membership_history')
it('any subscription row, any status → membership_history'); it('paid pack → paid_pack')
```

- [ ] **Step 2:** Run: `npx vitest run src/lib/membership/reads/un1t-online-shape.test.js` · Expected: FAIL.
- [ ] **Step 3:** Implement both shapers.
- [ ] **Step 4:** Same command · Expected: PASS.
- [ ] **Step 5:** `git commit -am "HATCHPIPE.2 — shapePipelineSnapshot and shapeTrialEligibility"`

### Task 7: `pipelineInputs` and `trialEligibility` reads

**Files:**
- Modify: `src/lib/membership/reads/un1t-online.js`
- Test: `src/lib/membership/reads/un1t-online.test.js`

**Interfaces:**
- Consumes: Task 4 `freshCutoff`, Task 6 shapers.
- Produces on `un1tOnlineReads`:
  - `pipelineInputs(db, locationId, { now = Date.now() } = {}) → Promise<{ success: true, data: { contacts: Array<{ id, name, email, location_id }>, snapshots: Map<contactId, Snapshot>, unlinked: number } } | { success: false, error }>`. Population = fresh `un1t_clients` at `locationId` with `contact_id` not null (`unlinked` = fresh rows with null `contact_id`). Reads, all `location_id = locationId`, paginated: fresh `un1t_subscriptions`, all `un1t_transactions`, `un1t_products`, `un1t_bookings` + `un1t_events` (`event_id = un1t_id`, `starts_at`), `contact_memberships` (source `un1t_online_api`); `contacts` by id via `selectAllByKeys` selecting only `id, name, email, location_id, pipeline_dismissed_at, last_lead_source_at`.
  - `trialEligibility(db, locationId, { un1tUserId, contactId } = {}) → Promise<{ success: true, data: { eligible, reasons } } | { success: false, error }>`. Needs at least one id (else `success:false`). With `un1tUserId`: all `un1t_transactions` and all `un1t_subscriptions` for that user at the location, plus `un1t_products`; with `contactId`: `contact_memberships` at the location, sources `un1t_online_api` and `un1t_online_export`, any status. Any failed read → `success:false` (never eligible).
  - **Ledger:** `un1t_write_events` does not exist until spec D. Neither read queries it; both pass `ledgerTrials: []`. Spec D adds a `listLedgerTrials(db, locationId)` reader here in the PR that creates the table.

- [ ] **Step 1: Write the failing tests.**

```js
it('pipelineInputs: population is fresh un1t_clients with a contact; unlinked counts null contact_id')
it('pipelineInputs: every un1t table filtered by location_id; contacts read by id only, with the six named columns, no Glofox column')
it('pipelineInputs: a dual-studio contact (contacts.location_id = Stillorgan) is in the population')
it('pipelineInputs: a stale subscription row does not make a member')
it('pipelineInputs: any failed read → { success:false }')
it('pipelineInputs: paginates past 1,000 bookings with range + order')
it('trialEligibility: history older than the freshness window still counts (stale subscription row → membership_history)')
it('trialEligibility: a failed read → { success:false }, never eligible')
it('trialEligibility: neither id → { success:false }')
it('neither read queries un1t_write_events')
```

- [ ] **Step 2:** Run: `npx vitest run src/lib/membership/reads/un1t-online.test.js` · Expected: FAIL.
- [ ] **Step 3:** Implement both reads; extend `un1tOnlineReads` (surface test now lists ten functions, still no `arrears`).
- [ ] **Step 4:** Same command · Expected: PASS. `npm run check:select-columns` · Expected: exit 0.
- [ ] **Step 5:** `git commit -am "HATCHPIPE.2 — un1tOnlineReads.pipelineInputs and trialEligibility"`

### Task 8: `acquisition_un1t` board module (touches `shared/`: OTA on merge)

**Files:**
- Create: `shared/pipelines/acquisition-un1t.js`
- Modify: `shared/pipelines/index.js`
- Test: `shared/pipelines/index.test.js`

**Interfaces:**
- Produces: `getBoardModule('acquisition_un1t') → { stages, requiredFields: ['id','name','email','location_id'], classify, inputSource: 'un1t_online' }`; `stages` and `classify` are the same references as `acquisition`'s. `acquisition` gains no `inputSource` (absent means `contacts`). Pure; no `src/lib` import.

- [ ] **Step 1: Write the failing tests:** `it('registers acquisition_un1t with inputSource un1t_online')`, `it('acquisition_un1t shares acquisition stages and classify by reference')`, `it('acquisition_un1t requires only id, name, email, location_id')`, `it('acquisition declares no inputSource')`.
- [ ] **Step 2:** Run: `npx vitest run shared/pipelines/index.test.js` · Expected: FAIL.
- [ ] **Step 3:** Implement and register.
- [ ] **Step 4:** Same command · Expected: PASS. `npm run check:ota-paths && npm run check:mobile-imports` · Expected: exit 0.
- [ ] **Step 5:** `git add shared/pipelines && git commit -m "HATCHPIPE.2 — acquisition_un1t board module (un1t.online inputs)"`

### Task 9: Orchestrator un1t path and Hatch dry run

**Files:**
- Modify: `src/lib/pipeline-reclassify.js`, `src/app/api/admin/pipeline-reclassify/route.js`
- Test: `src/lib/pipeline-reclassify.test.js`

**Interfaces:**
- Consumes: `membershipReadsFor`, `supportsRead` (`src/lib/membership/reads/index.js`), `pipelineInputs` (Task 7), `getBoardModule` (Task 8).
- Produces: `reclassifyAllContacts(db, { locationId, dryRun, source, userId, includeDisabled = [] })`. `includeDisabled` (array of pipeline keys) is honoured only when `dryRun`: one extra query for disabled rows with those keys at the location, each treated as `{ mode: 'derived', module: 'acquisition_un1t' }`. Result additions: `input_source: 'un1t_online' | 'contacts'`, `unlinked` (un1t path), and `stage_histogram: { [slug]: n }` on dry runs only.
- Behaviour after step 1b: if any active board's module has `inputSource === 'un1t_online'`: a location also running a contacts-input board drops the un1t boards (`pipelines_skipped`, `logWarn` reason `mixed_input_sources`); else resolve `membershipReadsFor(db, locationId)` and require `source==='un1t_online' && state==='configured' && supportsRead(r,'pipelineInputs')`; otherwise, or when `pipelineInputs` fails, close the audit row `{ status:'failed', error_message: 'un1t inputs unavailable: <state|read_failed>' }`, `logWarn('pipeline-reclassify','inputs unavailable',{ locationId, source, state, reason })`, return `{ ok:false, … }` with no deal write. On success `contacts` = the adapter's list, classification uses `snapshots.get(c.id)` (missing snapshot = `errors++`), new-deal title fallback `'Member'`. Admin route schema gains `include_disabled: z.array(z.literal('acquisition')).optional()` passed only when `dry_run`.

- [ ] **Step 1: Write the failing tests** (mock `./membership/reads/index.js`):

```js
it('Stillorgan (contacts-input board): exact from() call sequence and writes unchanged; membershipReadsFor never called; result has input_source "contacts"')
it('un1t location: uses pipelineInputs, never selects from contacts, issues no contacts write, creates deals titled from name or "Member"')
it('un1t location: dual-studio contact gets a deal with location_id = Hatch and pipeline_id = Hatch acquisition')
it('state unknown → audit row failed "un1t inputs unavailable: unknown", no deal write')
it('unconfigured un1t → skipped the same way'); it('pipelineInputs { success:false } → skipped the same way')
it('a location with a contacts board and a un1t board refuses the un1t board (mixed_input_sources) and runs the contacts board')
it('a pipelines row naming an unregistered module is skipped and reported')
it('the manual waitlist board is never read or written on the un1t path')
it('includeDisabled is ignored without dryRun; with dryRun it classifies the disabled acquisition row as acquisition_un1t and returns stage_histogram')
// existing reclassifyAllContacts tests stay green untouched
```

- [ ] **Step 2:** Run: `npx vitest run src/lib/pipeline-reclassify.test.js` · Expected: FAIL on new cases.
- [ ] **Step 3:** Implement; the contacts path's code and call order stay as they are.
- [ ] **Step 4:** Same command · Expected: PASS. `npm run check:guardrails && npm run check:route-guards` · Expected: exit 0.
- [ ] **Step 5:** `git commit -am "HATCHPIPE.2 — reclassify un1t boards from pipelineInputs; dry run of a disabled board"`

### Task 10: Hourly reclassify after a good sync

**Files:**
- Create: `src/lib/un1t-pipeline-cadence.js`
- Modify: `src/app/api/cron/un1t-online-sync/route.js:87-90`
- Test: `src/lib/un1t-pipeline-cadence.test.js`, `src/app/api/cron/un1t-online-sync/route.test.js`

**Interfaces:**
- Produces: `RECLASSIFY_MIN_GAP_MS = 55 * 60 * 1000`; `maybeReclassifyAfterSync(db, locationId, { now = Date.now() } = {}) → Promise<{ ran: false, reason: 'no_un1t_board'|'recent_run'|'error' } | { ran: true, result }>`; never throws. Steps: enabled `pipelines` at the location whose module has `inputSource==='un1t_online'` (none → `no_un1t_board`); newest `pipeline_classification_runs` by `started_at` for the location with `finished_at` within the gap → `recent_run`; else `reclassifyAllContacts(db, { locationId, source: 'cron' })`.
- The route calls it after `stampTenantHeartbeat` for each ok location, inside its own `try/catch`; the outcome and heartbeat shape are unchanged.

- [ ] **Step 1: Write the failing tests:** `it('no un1t board → no_un1t_board, no audit read')`, `it('a run finished 54 min ago → recent_run')`, `it('a run finished 56 min ago → runs with source cron')`, `it('reclassify throwing → { ran:false, reason:"error" }, logged')`; route: `it('ok location calls maybeReclassifyAfterSync after its tenant heartbeat')`, `it('a not-ok or in_progress location does not call it')`, `it('maybeReclassifyAfterSync rejecting leaves the outcome, tenant heartbeat and stampHeartbeat unchanged')` (Review Focus 5).
- [ ] **Step 2:** Run: `npx vitest run src/lib/un1t-pipeline-cadence.test.js src/app/api/cron/un1t-online-sync/route.test.js` · Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command · Expected: PASS.
- [ ] **Step 5:** `git add src/lib/un1t-pipeline-cadence* src/app/api/cron/un1t-online-sync && git commit -m "HATCHPIPE.2 — hourly reclassify after a successful un1t.online sync"`

### Task 11: Next-class badge off on un1t boards

**Files:**
- Modify: `src/lib/pipeline-board.js`, `src/app/(sales)/pipeline/page.js:72-83,128`, `src/app/api/pipeline/deals/route.js:40-59`
- Test: `src/lib/pipeline-board.test.js`

**Interfaces:**
- Produces: `boardDealMapper({ badge = true } = {}) → (deal) => BoardDeal` (1-arg, safe in `.map`); `toBoardDeal` stays as `boardDealMapper()`; `badgeEnabledForModule(moduleName) → boolean` = `getBoardModule(moduleName)?.inputSource !== 'un1t_online'`. The page selects `module` with the pipelines row; the deals route reads the stage's pipeline (`pipeline_stages.select('id, pipeline_id')` then `pipelines.select('module')` by that id, still location-scoped).

- [ ] **Step 1: Write the failing tests:** `it('boardDealMapper({ badge:false }) sets next_class_at null and still strips recent_bookings')`, `it('toBoardDeal unchanged')`, `it('badgeEnabledForModule: acquisition true, acquisition_un1t false, unknown true')`.
- [ ] **Step 2:** Run: `npx vitest run src/lib/pipeline-board.test.js` · Expected: FAIL.
- [ ] **Step 3:** Implement and wire both callers.
- [ ] **Step 4:** Same command · Expected: PASS. `npm run check:location-scoping && npm run check:select-columns` · Expected: exit 0.
- [ ] **Step 5:** `git commit -am "HATCHPIPE.2 — hide the next-class badge on un1t.online boards"`

### Task 12: Contact page billing card, header band, needs-attention

**Files:**
- Create: `src/lib/contact-un1t-billing.js`, `src/components/contact/Un1tPaymentsCard.jsx`
- Modify: `src/components/contact/ContactWhoRail.jsx:23,69-71`, `src/lib/contact-view.js:35-55`, `src/app/(sales)/contacts/[id]/page.js:89-102,165-172,342-366,412-419`
- Test: `src/lib/contact-un1t-billing.test.js`, `src/components/contact/Un1tPaymentsCard.test.jsx`, `src/components/contact/ContactRails-studio-cards.test.jsx`, `src/lib/contact-view.test.js`

**Interfaces:**
- Consumes: `membershipReadsFor`, `supportsRead`, `paymentsFor` (Task 5), `assertLocationAccess` (`@/lib/auth`), `formatMoney`, `formatDate` (`src/components/contact/format.js`).
- Produces:
  - `loadUn1tBilling(db, user, contactId) → Promise<{ studios: Array<{ locationId, locationName, subscriptions, transactions, invoices, pastDue }>, overdue: boolean, arrearsCentsByCurrency: Record<string, number> }>`; never throws (failure → empty result, `logWarn('un1t-billing', 'load failed', { contactId })`). Locations = this contact's `un1t_clients.location_id`s; kept when `source==='un1t_online'`, `state==='configured'`, `capabilities.invoices === true`, `supportsRead(r,'paymentsFor')` and `assertLocationAccess(user, loc) === null`; names from `locations.select('id, name')`; a failed `paymentsFor` drops that studio.
  - `un1tHeaderRisk(billing) → { label: 'Payment overdue', cls: 'bg-red-50 text-red-700 border-red-200', title } | null`, title `Payment overdue on un1t.online at <locationName> since <formatDate(since)>` (earliest `since`).
  - `mergeArrearsCents(glofoxCents, billing) → number` = `glofoxCents + (arrearsCentsByCurrency.EUR || 0)`.
  - `deriveNeedsAttention({ …, overdue = false })`: the arrears item is pushed when `arrearsCents > 0 || overdue`.
  - `<Un1tPaymentsCard studios={…} />` (server component): per studio, the overdue band (`Payment overdue since <date>` and the amount, or `amount not reported by un1t.online`), current subscriptions, the last 10 transactions (date, product, amount, `Refunded` chip `bg-amber-500/10 text-amber-700`), invoice statuses (paid green, open red, void/unknown zinc showing `rawStatus` for unknown); `No payments recorded` when a studio has no transactions; renders nothing for `studios=[]`.
  - `ContactWhoRail` takes `un1tBilling = { studios: [] }` and renders the card between `StudioMembershipsCard` and `GlofoxProfileCard`.
  - Page: `loadUn1tBilling(db, user, id)` joins the existing `Promise.all`; `risk` = Glofox's Payment overdue when set, else `un1tHeaderRisk` when non-null, else the churn tiers; `metricArrearsCents = mergeArrearsCents(<today's value>, billing)`; `deriveNeedsAttention` gets `overdue: billing.overdue`.

- [ ] **Step 1: Write the failing tests.**

```js
// contact-un1t-billing.test.js
it('Hatch member past due: overdue true, EUR amount summed, studio listed')
it('null amount: overdue true, arrearsCentsByCurrency empty')
it('Stillorgan-only viewer of a dual-studio member: no Hatch studio returned')              // Review Focus 4
it('Hatch-only viewer of a Stillorgan-owned Hatch member: Hatch studio returned')           // Review Focus 4
it('capabilities.invoices false (today) → no studios, paymentsFor not called')
it('Glofox-only contact (no un1t_clients rows) → empty result, no seam call')
it('paymentsFor failing → that studio dropped, logged, never throws')
it('un1tHeaderRisk title "Payment overdue on un1t.online at UN1T Hatch Street since 3 Oct 2026"')
it('mergeArrearsCents adds EUR only; a GBP amount is not added')                            // Review Focus 2
// Un1tPaymentsCard.test.jsx
it('renders nothing without studios'); it('shows amount and since in the overdue band')
it('shows "amount not reported by un1t.online" when amountCents is null')
it('Refunded chip on a refunded payment; unknown invoice status shown verbatim'); it('lists at most 10 payments')
it('"No payments recorded" for a paid member with no transactions')
// ContactRails-studio-cards.test.jsx
it('Un1tPaymentsCard sits between StudioMembershipsCard and GlofoxProfileCard'); it('Glofox-only contact renders exactly as before')
// contact-view.test.js
it('overdue true with arrearsCents 0 still raises the Payment overdue item')
```

- [ ] **Step 2:** Run: `npx vitest run src/lib/contact-un1t-billing.test.js src/components/contact/ src/lib/contact-view.test.js` · Expected: FAIL.
- [ ] **Step 3:** Implement the loader, helpers, card, rail prop and page wiring.
- [ ] **Step 4:** Same command · Expected: PASS. `npm run check:location-scoping && npm run check:select-columns && npm run check:guardrails && npm run build` · Expected: exit 0.
- [ ] **Step 5:** `git add src/lib/contact-un1t-billing* src/components/contact src/lib/contact-view* 'src/app/(sales)/contacts/[id]/page.js' && git commit -m "HATCHPIPE.2 — un1t.online payments and overdue on the contact page"`

### Task 13: Command centre `un1t_billing`

**Files:**
- Modify: `src/app/api/contacts/[id]/command-centre/route.js:86-130`
- Test: `src/app/api/contacts/[id]/command-centre/route.test.js`

**Interfaces:**
- Consumes: `loadUn1tBilling` (Task 12).
- Produces: response gains `un1t_billing: { overdue: boolean, arrears_cents: number, studios: [{ location_id, since }] }` (`arrears_cents` = EUR sum, 0 when none reported; `studios` only those with a `pastDue`); `churnLabel` is `'Payment overdue'` when `un1t_billing.overdue`. The existing `assertLocationAccess(user, contact.location_id)` 404 stays as is (spec §9, last bullet: record in the PR body that a Hatch-only viewer of a Stillorgan-owned contact still 404s here; P1.3 owners decide).

- [ ] **Step 1: Write the failing tests:** `it('loadUn1tBilling joins the Promise.all and the response carries un1t_billing')`, `it('overdue with null amount → churnLabel Payment overdue, arrears_cents 0')`, `it('no un1t billing → un1t_billing { overdue:false, arrears_cents:0, studios:[] } and churnLabel as before')`.
- [ ] **Step 2:** Run: `npx vitest run 'src/app/api/contacts/[id]/command-centre/route.test.js'` · Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command · Expected: PASS.
- [ ] **Step 5:** `git commit -am "HATCHPIPE.2 — command centre carries un1t_billing"`

### Task 14: `get_my_payment_reminder` Glofox-only

**Files:**
- Modify: `src/lib/agent/account-tools.js:605-613`
- Test: `src/lib/agent/account-tools-payment-reminder.test.js`

**Interfaces:**
- Produces: after `resolveMembershipSource`, the Glofox overdue check runs only when `provider.key === 'glofox' && provider.capabilities.invoices`; any other provider returns `result` (`still_overdue: 'unknown'`) unchanged.

- [ ] **Step 1: Write the failing test:** `it('a un1t_online provider with invoices:true never calls glofoxCredentialsForLocation or getGlofoxOverdueInvoices and returns still_overdue "unknown"')`.
- [ ] **Step 2:** Run: `npx vitest run src/lib/agent/account-tools-payment-reminder.test.js` · Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command · Expected: PASS.
- [ ] **Step 5:** `git commit -am "HATCHPIPE.2 — payment reminder overdue check is Glofox-only"`

### Task 15: Ship PR 2 and dry-run Hatch's board

- [ ] **Step 1:** Full CI mirror plus `npm run build` · Expected: every command exits 0.
- [ ] **Step 2:** `git push -u origin HEAD && gh pr create --base main --fill`; body states: board still disabled (inert), card dark until PR 4, OTA no-op group from `shared/pipelines/`, the command-centre 404 finding (Task 13). Add `docs/changelog/entries/<PR>.md` (`HATCHPIPE.2 — …`), commit, push.
- [ ] **Step 3 (controller, after deploy):** from a master session, `POST /api/admin/pipeline-reclassify` with `{ "location_id": "28c78d6b-f7b3-4edf-8c7c-840bd047b3f4", "dry_run": true, "include_disabled": ["acquisition"] }` · Expected: `ok:true`, `input_source:'un1t_online'`, `errors:0`, `deals_created` ≈ linked un1t clients. Paste `stage_histogram` and `unlinked` into the PR and review the histogram with Richard before PR 3.

---

## PR 3: HATCHPIPE.3 (A2, board on)

### Task 16: Migration A2, re-enable Hatch's acquisition board

**Files:**
- Create: `supabase/migrations/MMM_hatch_acquisition_board_enable.sql`
- Test: `tests/migration-MMM-hatch-acquisition-board.test.js`

**Interfaces:**
- Consumes: `shared/pipelines/acquisition.js` `stages` (11 slugs, names, `display_order`, `color`, `is_dormant`); Task 8's module name `acquisition_un1t`.
- Produces: Hatch `pipelines` row `key='acquisition'`: `enabled=true, is_primary=false, mode='derived', module='acquisition_un1t', display_order=1`; its 11 stages upserted `on conflict (location_id, slug)` with `archived=false`, `pipeline_id` = that row. `-- grant: none (no new relation)`.

- [ ] **Step 0 (controller, Supabase MCP read-only), all before writing the file:** (1) Hatch's archived acquisition stage rows: all 11 slugs present, names unique per pipeline; (2) active `email_sequences` and scheduled `campaigns` at Hatch with an audience on `pipeline_stage_slug` or `trigger_type='pipeline_stage_change'` (any that would match an acquisition stage goes to Richard; stop until he answers); (3) the "later effect" count = Hatch-owned contacts linked in `un1t_clients` at Hatch with no open waitlist deal; (4) Hatch's open waitlist deal count. Hand (3) and (4) to the implementer.
- [ ] **Step 1: Write the failing tests** (static on the file, plus PGlite with `pipelines`, `pipeline_stages` and a Hatch fixture):

```js
it('sets module acquisition_un1t, enabled, not primary, derived, display_order 1 on Hatch acquisition only')
it('upserts exactly the 11 stage slugs of shared/pipelines/acquisition.js with on conflict (location_id, slug), archived false')
it('waitlist stays Hatch\'s enabled primary; exactly one enabled primary at Hatch')
it('self-check raises when Hatch open waitlist deal count differs from the measured constant')
it('creates no deals and writes no contacts')
it('states -- grant: none')
```

- [ ] **Step 2:** Run: `npx vitest run tests/migration-MMM-hatch-acquisition-board.test.js` · Expected: FAIL.
- [ ] **Step 3:** Write the migration (one transaction, guarded `DO $$` self-checks per spec §6.8, measured waitlist count as a constant).
- [ ] **Step 4:** Same command · Expected: PASS. Full CI mirror · Expected: exit 0.
- [ ] **Step 5:** Commit `HATCHPIPE.3 — mig MMM: re-enable Hatch's acquisition board (acquisition_un1t)`, push, `gh pr create --base main --fill` (body: Step 0 numbers, Richard's sequence/campaign answer), changelog entry `<PR>.md`, push.
- [ ] **Step 6 (controller):** `apply_migration` A2 on iyvtbjjxdggiadzwwvdj, then `get_advisors` security, then merge · Expected: applies, no new finding.
- [ ] **Step 7 (controller, Supabase MCP read-only), first hourly run:** Hatch's newest `pipeline_classification_runs` row `status='success'`, `errors=0`, `deals_created` ≈ the dry run's; Hatch-owned contacts with no waitlist deal now carry an acquisition slug and their number equals Step 0 (3); Hatch waitlist deal count unchanged; Stillorgan's next 03:30 run shows the same `deals_moved` pattern as prior nights. `/pipeline` at Hatch shows Waitlist then Acquisition, no next-class badges.
- [ ] **Step 8 (Richard + controller):** spot-check 3 Hatch members against un1t.online admin (stage, last payment, subscription); once spec D has given MIA TEST a trial booking and attendance is marked, it moves new_lead → 1st Class. No payment (G4).

---

## PR 4: HATCHINV.1 (flip `invoices`)

### Task 17: Flip `invoices` and guard its readers

**Files:**
- Modify: `src/lib/membership/sources/un1t-online.js:1-16`
- Create: `tests/invoices-capability-readers.test.js`
- Test: `src/lib/membership/sources/un1t-online.test.js:22`

**Interfaces:**
- Consumes: Task 14 (Glofox-only reminder), Task 12 (`loadUn1tBilling` reads `capabilities.invoices`).
- Produces: `un1tOnlineSource.capabilities = { memberships: false, bookings: false, credits: false, invoices: true, schedule: false }`; header comment says invoices are read from `un1t_invoices` through `pastDue`/`paymentsFor`. Guard test: scans non-test `src/`, `shared/`, `mobile/` (skipping `node_modules`) for `capabilities.invoices`, `capabilities?.invoices`, `capabilities['invoices']`, `providesCapability(<x>, 'invoices')`, `locationIdsWithoutCapability(<x>, 'invoices')`, `capability="invoices"` / `capability: 'invoices'`, and requires the set of files found to equal a manifest `{ 'src/lib/agent/account-tools.js': 'Glofox-only, gated on provider.key', 'src/lib/contact-un1t-billing.js': 'un1t: paymentsFor' }`, each with a reason.

- [ ] **Step 1: Write the failing tests:** source test expects `invoices: true` (others false, frozen); guard test `it('every reader of capabilities.invoices is classified')` and `it('a manifest entry that no longer matches fails as stale')`.
- [ ] **Step 2:** Run: `npx vitest run src/lib/membership/sources/un1t-online.test.js tests/invoices-capability-readers.test.js` · Expected: FAIL.
- [ ] **Step 3:** Flip the flag and update the comment.
- [ ] **Step 4:** Same command · Expected: PASS. Full CI mirror · Expected: exit 0.
- [ ] **Step 5:** Commit `HATCHINV.1 — un1t.online declares invoices`, push, `gh pr create --base main --fill`, changelog entry `<PR>.md`, push.
- [ ] **Step 6 (controller, Supabase MCP read-only, after deploy):** find a fresh `past_due` subscription or surviving open invoice at Hatch; if one exists open that contact's page (pill, amount or "amount not reported", card band); if none, open a paid member's page and confirm the card shows subscription and payments with no overdue band. Report to the session that spec B's `memberships` flip is now unblocked.
