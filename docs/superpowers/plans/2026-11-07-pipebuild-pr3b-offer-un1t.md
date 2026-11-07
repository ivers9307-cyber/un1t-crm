# PIPEBUILD PR 3b: offer boards at un1t.online studios

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Builder-made offer boards work at a un1t.online studio (Hatch Street) through a new board module `offer_un1t` and a new way in, `un1t_product`, placed by the hourly un1t pass with the same silent switch-on and follow-ups as offer boards at Glofox studios.

**Architecture:** `offer_un1t` is the `offer` module with `inputSource = 'un1t_online'`, so the un1t gates (hourly cadence, card signals, the un1t input path of `reclassifyAllContacts`) admit it. Its claims come from a new loader that reads `un1t_transactions` (the `un1t_product` way in) and reuses the existing `trial_purchase` / `corp_promo` loaders, and the un1t path hands them to the router as `claims.offers`, which today it never does. Board create/enable picks the module from `locations.membership_source` and refuses an entry type that cannot work at that studio. No migration: mig 814 already allows `module IN ('offer','offer_un1t')` when `board_type` is set, and `create_configured_pipeline` (mig 815) takes `p_module` as a parameter.

**Tech Stack:** Next.js App Router, Supabase (service role), Vitest, plain ESM in `shared/`.

**Spec:** `docs/superpowers/specs/2026-11-06-self-service-pipelines-design.md` (PR 3 "Modules" and "Entry rules", PR 5 "The wizard picks `offer` vs `offer_un1t` from `locations.membership_source` and refuses to mix them at one studio").

## Global Constraints

- **Today's boards do not change.** Hatch's `acquisition_un1t` and `paid_trial_un1t` boards, and every board at a Glofox studio, route exactly as before. `reclassifyAllContacts({ dryRun: true })` at Hatch and Stillorgan with no `offer_un1t` board shows zero changes.
- **At a un1t.online studio the hourly un1t pass is the one writer** (HATCH39). `ensureDealForContact` keeps returning `leave` / `un1t_board` there; no event path places on an `offer_un1t` board.
- **Ways in for `offer_un1t`:** `un1t_product`, `trial_purchase`, `corp_promo` (the source row is the claim). `lead_source`, `glofox_plan` and `tag` stay `offer`-only: they need contact columns the un1t path does not load.
- **Ways in for `offer`:** unchanged (`trial_purchase`, `corp_promo`, `lead_source`, `glofox_plan`, `tag`); `un1t_product` is refused there.
- **A failed read places nobody on that board that run** (held, never "no claims"), as for every offer board today.
- **Silent switch-on and the 50-per-stage guard apply unchanged:** an unbaselined `offer_un1t` board's first pass places silently and stamps `baseline_at`; creates then fire like an `offer` board's.
- **One studio, one input kind:** an `offer` board at a un1t.online studio, or an `offer_un1t` board at any other studio, is refused on create and enable, and held by the pass.
- `un1t_product` values are `un1t_products.un1t_id` text, **case kept** (like `trial_purchase`).
- No new `console.log`; `{ success, data?, error? }` responses; `check:select-columns` must resolve every column named.

## Review Focus

1. **A refunded transaction** (`refunded = true`) never makes a claim; the newest non-refunded one wins.
2. **A transaction with `contact_id` null but a `un1t_user_id` linked through `un1t_clients`** belongs to that client's contact (the snapshot loader's ownership rule), never dropped.
3. **A €0 transaction** on the chosen product counts (a free offer is still an offer); the €39 board's "amount paid" rule is not copied here.
4. **A studio whose `membership_source` changed after the board was built** (or is unreadable): enable is refused (`409 module_mismatch` / `503`), and the pass holds the board.
5. **A product id with capitals** survives parsing and matches `un1t_transactions.product_id` exactly.

---

### Task 1: The `offer_un1t` module and the `un1t_product` entry type

**Files:**
- Create: `shared/pipelines/offer-un1t.js`
- Modify: `shared/pipelines/index.js` (register), `shared/pipelines/router.js:46` (`OFFER_MODULES`), `shared/pipelines/offer-config.js`
- Test: `shared/pipelines/offer-config.test.js`, `shared/pipelines/index.test.js`, `shared/pipelines/router.test.js` (or the router's existing test file)

**Interfaces:**
- Produces:
  - `shared/pipelines/offer-un1t.js` exports `inputSource = 'un1t_online'`, `stages = []`, `requiredFields = ['id','name','email','location_id']`, and re-exports `stagesFor`, `classify`, `offerClaimLive` from `./offer.js`.
  - `BOARD_MODULES.offer_un1t`; `OFFER_MODULES = ['offer', 'offer_un1t']` (exported from `router.js` as today).
  - `offer-config.js`: `ENTRY_TYPES` gains `'un1t_product'`; new `export const ENTRY_TYPES_BY_MODULE = { offer: ['trial_purchase','corp_promo','lead_source','glofox_plan','tag'], offer_un1t: ['un1t_product','trial_purchase','corp_promo'] }`; new `export function moduleForMembershipSource(source) -> 'offer' | 'offer_un1t'` (`'un1t_online'` or `'un1t'` → `'offer_un1t'`, anything else → `'offer'`); `parseOfferConfig(raw, { boardKey, module })` refuses an entry type not in `ENTRY_TYPES_BY_MODULE[module]` with the message `entry.type <type> does not work at this studio` (when `module` is omitted, any `ENTRY_TYPES` value is accepted, so existing callers keep working). `un1t_product` values keep their case.

- [ ] **Step 1: Write the failing tests**

In `offer-config.test.js`, replace the two pins that call `un1t_product` invalid (`:48`, `:70-72`) and add:

```js
it('un1t_product keeps case and is allowed on offer_un1t', () => {
  const r = parseOfferConfig({ ...BASE, entry: { type: 'un1t_product', values: ['AbC123'] } }, { boardKey: 'o_x', module: 'offer_un1t' })
  expect(r.ok).toBe(true)
  expect(r.config.entry).toEqual({ type: 'un1t_product', values: ['AbC123'] })
})
it('refuses un1t_product on an offer board and lead_source on an offer_un1t board', () => {
  expect(parseOfferConfig({ ...BASE, entry: { type: 'un1t_product', values: ['a'] } }, { boardKey: 'o_x', module: 'offer' }).ok).toBe(false)
  const r = parseOfferConfig({ ...BASE, entry: { type: 'lead_source', values: ['meta'] } }, { boardKey: 'o_x', module: 'offer_un1t' })
  expect(r.ok).toBe(false)
  expect(r.errors.join(' ')).toContain('does not work at this studio')
})
it('moduleForMembershipSource', () => {
  expect(moduleForMembershipSource('un1t_online')).toBe('offer_un1t')
  expect(moduleForMembershipSource('un1t')).toBe('offer_un1t')
  expect(moduleForMembershipSource('glofox')).toBe('offer')
  expect(moduleForMembershipSource('none')).toBe('offer')
})
```

(`BASE` = whatever valid config fixture the file already uses; match its return shape — if `parseOfferConfig` returns `{ ok, value }` rather than `{ ok, config }`, use that.)

In `index.test.js`: the empty-`stages` exemption covers `offer_un1t` too; add `expect(getBoardModule('offer_un1t').inputSource).toBe('un1t_online')` and keep `offer` without one. In the router test: a descriptor `{ key: 'o_x', module: 'offer_un1t', board_type: 'offer', priority: 50, config }` with a live claim in `claims.offers` routes to `o_x_new`, exactly as the same descriptor with `module: 'offer'` does.

- [ ] **Step 2: Run them to see them fail** — `npx vitest run shared/pipelines/` → FAIL (`moduleForMembershipSource` not exported, `offer_un1t` unknown).
- [ ] **Step 3: Implement** the module file, the registry entry, `OFFER_MODULES`, and the `offer-config.js` changes above (`keepCase` becomes `type === 'trial_purchase' || type === 'un1t_product'`; only `trial_purchase` requires `match`).
- [ ] **Step 4: Run** `npx vitest run shared/pipelines/` → PASS.
- [ ] **Step 5: Commit** `PIPEBUILD.3b-1 — offer_un1t module and the un1t_product way in`.

### Task 2: Claims for `offer_un1t` boards

**Files:**
- Modify: `src/lib/pipeline-offer-claims.js`
- Test: `src/lib/pipeline-offer-claims.test.js`

**Interfaces:**
- Consumes: Task 1's `ENTRY_TYPES_BY_MODULE`, `OFFER_MODULES`.
- Produces:
  - `export function un1tProductOfferClaim(transactions, config, now) -> { start, end } | null` — pure. Over rows `{ product_id, refunded, remote_created_at }`: keep rows whose `product_id` is in `config.entry.values` (exact match), `refunded !== true`, and a readable `remote_created_at`; the newest wins; `start` = its epoch ms, `end = start + config.duration_days * DAY_MS`. Amount is not read.
  - `export async function loadUn1tOfferClaims(db, { locationId, boards, contactIds, now }) -> { ok: true, offersByContact: Map<contactId, Map<boardKey, claim>>, skipped } | { ok: false, reason, err }` — `boards` are pipeline rows; only enabled `board_type = 'offer'` rows of module `offer_un1t` with a parseable config count (the rest go to `skipped`, as `splitOfferBoards` does). Claim shape is the existing `{ start, end, source, claimedAt }` with `source: 'un1t_product'` and `claimedAt` = start as ISO. For `trial_purchase` / `corp_promo` boards it reuses the existing private `loadOffers` path (same claim rules, same reads), passing contacts as `contactIds.map((id) => ({ id }))`.
  - The `un1t_product` read: `un1t_transactions` columns `un1t_user_id, contact_id, product_id, refunded, remote_created_at` at `location_id = locationId` and `product_id IN (<union of every un1t_product board's values>)`, `.range()`-paginated with `.order('un1t_id')` (copy `selectAll`), plus `un1t_clients` `un1t_user_id, contact_id` at the location. Owner of a row = the client's `contact_id` for its `un1t_user_id`, else the row's own `contact_id` — the ownership rule `src/lib/membership/reads/un1t-online.js` uses for pipeline rows (reuse its helper if one is exported; otherwise mirror it and say so in a comment). Rows owned by nobody, or by a contact not in `contactIds`, are ignored. Any read error → `{ ok: false, reason: 'un1t_transactions_unreadable' | 'un1t_clients_unreadable', err }`.

- [ ] **Step 1: Write the failing tests** (`describe('un1t offer claims (PIPEBUILD.3b)')`):
  - `un1tProductOfferClaim` — newest non-refunded matching row wins; a refunded newer row is skipped; an `amount_cents: 0` row counts (the function never reads amount); `'AbC123'` matches only `'AbC123'`; no match → `null`; `end - start === 14 * DAY_MS` for `duration_days: 14`.
  - `loadUn1tOfferClaims` with a fake db: a row with `contact_id: null` and `un1t_user_id: 'u1'` where `un1t_clients` maps `u1 → c1` yields a claim for `c1` keyed by the board key with `source: 'un1t_product'`; a contact outside `contactIds` gets nothing; a transactions read error returns `{ ok: false, reason: 'un1t_transactions_unreadable' }`; a disabled or non-`offer_un1t` board is in `skipped` and never read; a `trial_purchase` `offer_un1t` board gets its claim from `trial_purchases` exactly as the contacts path does.
- [ ] **Step 2: Run** `npx vitest run src/lib/pipeline-offer-claims.test.js` → FAIL.
- [ ] **Step 3: Implement** the two exports.
- [ ] **Step 4: Run** → PASS; also `npm run check:select-columns`.
- [ ] **Step 5: Commit** `PIPEBUILD.3b-2 — claims for offer_un1t boards`.

### Task 3: The hourly un1t pass places `offer_un1t` boards

**Files:**
- Modify: `src/lib/pipeline-reclassify.js` (refusals at `:357`, the mixed rule `:364-372`, `needsOfferClaims` / `triggerPipelineIds` at `:444-449`, `routeFromSnapshot` at `:742-755`, the create-fire condition at `:961-963`), `src/lib/pipeline-claims.js:346-356` (keep `offersRefused` only for `offer`-module boards)
- Test: `src/lib/pipeline-reclassify.test.js`, `src/lib/pipeline-claims.test.js`

**Interfaces:**
- Consumes: Task 1 (`offer_un1t` has `inputSource 'un1t_online'`), Task 2 (`loadUn1tOfferClaims`).
- Produces: no new exports. Behaviour:
  - At a un1t.online studio: `offer`-module offer boards are refused (`un1t_online_studio`, as today); `offer_un1t` boards are admitted alongside the studio's un1t boards (they are un1t input, so they never trip `mixed_input_sources`).
  - At any other studio: `offer_un1t` boards are refused with the new reason `'contacts_input_studio'` (pushed to `pipelinesSkipped`/`heldPipelines` like the others).
  - On the un1t input path, when any `offer_un1t` board is active, `loadUn1tOfferClaims(db, { locationId, boards: activeOfferUn1tRows, contactIds: [...snapshots.keys()], now })` runs once per pass. `ok: false` holds every `offer_un1t` board for the run (nothing placed or moved on them, their existing deals untouched), exactly like a failed offer-claims read on the contacts path. `routeFromSnapshot` passes `claims.offers = offersByContact.get(contactId) ?? new Map()`.
  - `triggerPipelineIds` on the un1t path = the ids of active `offer_un1t` boards (empty otherwise, so Hatch's existing boards keep today's "creates do not fire"), so `createsToApply` fires `null → slug` for them under the existing `offerPipelineIds` / `silentIds` / 50-per-stage rules. Whatever claim-date filter the contacts path applies to offer-board creates after baseline applies identically here.
  - `baseline_at` stamping is unchanged (it already works off `offerPipelines`); assert it.
  - `pipeline-claims.js`: `offersRefused` is set only when the studio is un1t.online AND the board being loaded is module `offer`; `offer_un1t` boards are never loaded on single-contact paths (no event path places at a un1t studio).

- [ ] **Step 1: Write the failing tests.** Update the four refusal tests listed below so they still pass with `module: 'offer'`, then add (`describe('offer_un1t on the un1t path (PIPEBUILD.3b)')`, reusing the file's un1t-path fixtures):
  - `admitsOfferUn1tBesideUn1tBoards` — Hatch-like studio (`membership_source 'un1t_online'`), boards `acquisition_un1t` + `offer_un1t` (enabled, baselined): no `mixed_input_sources`, the offer board is active.
  - `placesFromUn1tProductClaim` — a snapshot contact with a matching transaction lands on `o_x_new` (dry run reports the create on the offer board); a contact with only a refunded one stays where the router put them before.
  - `unbaselinedOfferUn1tIsSilentThenStamped` — first real pass: creates on the board, no sequence trigger fired, `baseline_at` stamped; second pass, a new claimant's create fires `null → o_x_new`.
  - `claimsReadFailureHoldsOnlyOfferUn1t` — `loadUn1tOfferClaims` → `ok:false`: the offer board is held, its deals untouched, Hatch's `acquisition_un1t`/`paid_trial_un1t` placements proceed exactly as without it.
  - `existingUn1tBoardsUnchanged` — the same Hatch fixture with no `offer_un1t` board gives byte-identical moves/creates/fires to `main` (golden: snapshot the result object before your change, assert after).
  - `offerUn1tRefusedAtGlofoxStudio` — `membership_source 'glofox'`, an `offer_un1t` board → `pipelinesSkipped` with reason `contacts_input_studio`.
  - Existing tests to keep green (module stays `'offer'`): `:760-778` mixed, `:2198-2210`, `:2213-2224`, `:2240-2256`; `pipeline-claims.test.js:319-325`, `:427`, `:478`; `glofox-sync.test.js:3254`.
- [ ] **Step 2: Run** `npx vitest run src/lib/pipeline-reclassify.test.js src/lib/pipeline-claims.test.js src/lib/glofox-sync.test.js` → the new cases FAIL.
- [ ] **Step 3: Implement** the behaviour above.
- [ ] **Step 4: Run** the same command → PASS; then `npx vitest run src/lib/un1t-pipeline-cadence.test.js src/lib/pipeline-offer-claims.test.js shared/pipelines/`.
- [ ] **Step 5: Commit** `PIPEBUILD.3b-3 — the hourly un1t pass places offer_un1t boards`.

### Task 4: Create, edit and switch on at a un1t.online studio

**Files:**
- Modify: `src/lib/pipeline-boards.js` (`refuseUn1tStudio` `:97-102` and its callers `:350`, `:783`; the RPC call `:379-380`; `updateBoard`'s config parse), `src/lib/pipeline-board-dry-run.js` if it refuses un1t studios
- Test: `src/lib/pipeline-boards.test.js`, `src/app/api/locations/[id]/pipelines/route.test.js`

**Interfaces:**
- Consumes: Task 1 (`moduleForMembershipSource`, `parseOfferConfig(raw, { boardKey, module })`).
- Produces:
  - `refuseUn1tStudio` is replaced by `async function studioModule(db, locationId) -> { ok: true, module } | failure` — reads the membership source (existing `readMembershipSource`); an unreadable source → `fail(503, 'Could not read this studio\'s membership source.', { code: 'membership_source_unreadable' })`.
  - `createBoard` passes `p_module: <studio module>` (board type stays `'offer'`) and parses the config with that module, so `un1t_product` at Stillorgan or `lead_source` at Hatch is a 400 with the parse error.
  - `updateBoard` parses with the board row's own `module`.
  - `setBoardEnabled(…, true)` refuses with `fail(409, 'This board was built for a different kind of studio.', { code: 'module_mismatch' })` when the row's `module` is not the studio's module now.
  - `UN1T_STUDIO_ERROR` and its export are removed (Task 5 removes the wizard's copy of it).

- [ ] **Step 1: Write the failing tests:** replace `refusesUn1tStudio` (`:119-124`) with `createsOfferUn1tAtUn1tStudio` (RPC called with `p_module: 'offer_un1t'`, `p_board_type: 'offer'`); add `refusesLeadSourceAtUn1tStudio` (400, no RPC), `refusesUn1tProductAtGlofoxStudio` (400), `unreadableSourceIs503`; replace the enable case (`:636-640`) with `enableRefusesModuleMismatch` (an `offer` row at a un1t studio → 409 `module_mismatch`) and `enablesOfferUn1tAtUn1tStudio`. Update the route test's mocked 409 (`:119-122`) to the new codes.
- [ ] **Step 2: Run** `npx vitest run src/lib/pipeline-boards.test.js 'src/app/api/locations/[id]/pipelines'` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm run check:route-guards && npm run check:location-scoping`.
- [ ] **Step 5: Commit** `PIPEBUILD.3b-4 — build and switch on offer boards at un1t.online studios`.

### Task 5: The wizard and entry pickers at a un1t.online studio

**Files:**
- Modify: `src/lib/pipeline-entry-options.js` (new `un1t_product` lister in `listEntryOptions`), `src/lib/pipeline-wizard.js` (drop `UN1T_STUDIO_NOTICE`; entry types by studio), `src/components/pipelines/BoardWizard.jsx` (`:145` notice removed; entry step offers only the studio's types), the entry step component under `src/components/pipelines/wizard/`, `src/components/pipelines/BoardSettings.jsx` if it lists entry types
- Test: `src/lib/pipeline-entry-options.test.js`, `src/lib/pipeline-wizard.test.js`, `src/components/pipelines/BoardWizard.test.jsx`

**Interfaces:**
- Consumes: Task 1 (`ENTRY_TYPES_BY_MODULE`, `moduleForMembershipSource`).
- Produces:
  - `listEntryOptions(db, { locationId, type: 'un1t_product' })` → `{ ok: true, options: [{ value: un1t_id, label: '<title> · €<price>' }] }` from `un1t_products` at the location, `status` active only (check the column's real values with `information_schema`/the sync's writer before filtering; if unsure, no status filter), ordered by `title`; `price_cents` null → label is the title alone; a read error → the lister's existing failure shape. Match the shape the other listers return.
  - `pipeline-wizard.js`: `entryTypesFor(membershipSource) -> string[]` = `ENTRY_TYPES_BY_MODULE[moduleForMembershipSource(membershipSource)]`; `isUn1tStudio` may stay if other code uses it.
  - Entry-type labels: `un1t_product` → "A un1t.online product" (help text: "People who buy this product enter the board.").
  - The wizard at a un1t.online studio no longer shows a notice; its entry step lists `entryTypesFor(membershipSource)`; a recipe whose default entry type is not allowed there starts on the first allowed type.

- [ ] **Step 1: Write the failing tests:** entry options — two products, one inactive (if filtered), labels and ordering; wizard lib — `entryTypesFor('un1t_online')` equals `['un1t_product','trial_purchase','corp_promo']`, `entryTypesFor('glofox')` has no `un1t_product`; `BoardWizard` — replace `un1tStudioShowsNotice` (`:22-25`) with `un1tStudioOffersUn1tProduct` (no notice; the entry step shows "A un1t.online product" and not "A Glofox plan"). Remove the `UN1T_STUDIO_NOTICE` pin (`pipeline-wizard.test.js:202-206`).
- [ ] **Step 2: Run** `npx vitest run src/lib/pipeline-entry-options.test.js src/lib/pipeline-wizard.test.js src/components/pipelines/` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm run lint` on the touched files and `npm run check:guardrails`.
- [ ] **Step 5: Commit** `PIPEBUILD.3b-5 — wizard and entry pickers at un1t.online studios`.

## Verification (controller, after Task 5)

- The 13-command CI mirror and `npm run build`.
- Prod read-only: `reclassifyAllContacts({ dryRun: true })` at Hatch (via the admin reclassify dry-run route in the browser, or the existing tool used for PR 3) shows zero changes with no `offer_un1t` board.
- Building a real board at Hatch is Richard's call (boards cannot be deleted); the PR says so.
