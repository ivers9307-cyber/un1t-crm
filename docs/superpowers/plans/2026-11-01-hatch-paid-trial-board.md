# Hatch €39 Trial Board + Waitlist Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give UN1T Hatch Street a €39 Trial board identical to Stillorgan's, fed from the un1t.online mirror, retire the hand-moved Waitlist, make Acquisition the primary, show form-only enquiries on Acquisition, and stop a €39 purchase reading as a Class Pack anywhere at Hatch.

**Architecture:** The un1t.online read adapter resolves the studio's paid-trial product ids once per read and hands them to the pure shapers, whose pack predicate excludes them; the pipeline snapshot gains `paid_trial_at` / `paid_trial_expires_at`, which the PIPE3 router turns into the paid claim. `pipelineInputs` also emits a minimal snapshot for every Hatch-home contact with no un1t account. The orchestrator's un1t path routes per contact like the contacts path does. One cutover migration retires the Waitlist, moves or closes its cards and flips the primary; a second enables the new board after the dry run.

**Tech Stack:** Next.js 16, Supabase (service role in `/api`), Zod, Vitest (+ PGlite for migrations).

**Spec:** `docs/superpowers/specs/2026-11-01-hatch-paid-trial-board-design.md` (and the live PIPE3 spec it builds on, `docs/superpowers/specs/2026-10-31-stillorgan-three-pipelines-design.md`).

## Global Constraints

- Hatch location id `28c78d6b-f7b3-4edf-8c7c-840bd047b3f4`; Stillorgan `a0000000-0000-0000-0000-000000000001` must be untouched by every migration (hash self-check).
- The €39 product today: `un1t_products.un1t_id = '674d62bf-4d4b-4231-b1ba-d53543657bea'` (type `one_time`, `price_cents 3900`, `credits_per_period -1`, `raw.expire_credits_in_days '14'`); its transactions carry `product_type 'pack'`.
- New board: `pipelines.key 'paid_trial'`, `name '€39 Trial'`, `module 'paid_trial_un1t'`, `display_order 1`, seeded **disabled**; stage rows = `shared/pipelines/paid-trial.js` `stages` (slugs `paid_trial_*`, 601–605, colours as there). Waitlist → `display_order 2`, `enabled false`, `is_primary false`; Acquisition → `is_primary true`.
- Settings path `locations.settings.pipelines.paid_trial.un1t_product_ids: string[]`, seeded `['674d62bf-4d4b-4231-b1ba-d53543657bea']` when absent.
- The paid-trial product set for a location = that setting ∪ the `/trial` page's `paid_trial` block `un1t_product_id` for the studio (`loadTrialStudios` entry whose `locationId` matches). A failed read of either **fails the un1t read** (never "no paid trials").
- Time rules, exits and the pack-from-end rule are PIPE3's: `shared/pipelines/paid-trial.js` is reused, not copied. The paid claim from a snapshot: `start = Date.parse(paid_trial_at)`, `end = Date.parse(paid_trial_expires_at) ?? start + 14 × DAY_MS`.
- Form-only snapshot: `glofox_membership_status 'lead'`, `joined_at = the later of contact.created_at and contact.last_lead_source_at`, `recent_bookings []`, everything else null; Cold / `last_lead_source_at` lent only when the contact's home is the studio (as the full snapshot does).
- Every supabase write destructures `{ error }`. Builders are thenables. `.single()` only on a pk.
- Commit after every task; messages end `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Branch `hatch-paid-trial-board` off fresh `origin/main`.
- `shared/**` changes publish a no-op OTA; `mobile/` is untouched.

## Review Focus

1. **A €39 buyer with leftover unlimited credits on day 15**: must be Trial Done on the €39 board (then Dormant after 60 quiet days), never `credit_member`/`pack_member`, never Converted by their own purchase. Pinned in Task 1.
2. **A form-only enquiry whose contact row is old but whose latest form submission is recent**: New Leads, dated at the submission. Pinned in Task 3.
3. **The cutover leaves exactly one open deal per Waitlist person** (108 closed as duplicates, 27 moved, 45 race signups closed, none left open), and `contacts.pipeline_stage_slug` re-derives off the acquisition deal. Pinned in Task 6.
4. **`ensureDealForContact` at Hatch after the primary flip** writes nothing (fence on the primary module's `inputSource`); the Cold route still re-places through `reclassifyUn1tBoardNow`. Pinned in Task 5.
5. **Free-trial eligibility for a €39 buyer is unchanged** (still ineligible, reason `paid_trial`), and Mia's trial-done runner still treats them as a purchaser. Pinned in Task 2.

---

### Task 1: The paid-trial product set in the shapers

**Files:**
- Modify: `src/lib/membership/reads/un1t-online-shape.js` (`isPaidPack`, `splitUn1tCredits`, `shapePipelineSnapshot`, `packHolderIds`, `shapeCounts`, `shapeTrialEligibility`; new `isPaidTrialProduct`, `paidTrialOf`, `shapeFormOnlySnapshot`)
- Modify: `shared/pipelines/paid-trial.js` (new `paidClaimFromSnapshot`)
- Create: `shared/pipelines/paid-trial-un1t.js`
- Modify: `shared/pipelines/index.js` (register `paid_trial_un1t`)
- Test: `src/lib/membership/reads/un1t-online-shape.test.js`, `shared/pipelines/paid-trial.test.js`, `shared/pipelines/index.test.js`

**Interfaces:**
- `export const isPaidTrialProduct = (p, paidTrialProductIds) => Boolean(p?.un1t_id) && paidTrialProductIds instanceof Set && paidTrialProductIds.has(p.un1t_id)` — also true when given a transaction's `product_id` via `paidTrialProductIds.has(t.product_id)` (the helper `isPaidTrialTx(t, ids)`).
- `isPaidPack(t, productsById, paidTrialProductIds = EMPTY_SET)` — false for a paid-trial transaction.
- `shapePipelineSnapshot({ …, paidTrialProductIds = new Set() })` — output gains `paid_trial_at: string|null` (newest non-refunded paid-trial transaction's `remote_created_at`) and `paid_trial_expires_at: string|null` (that + product `expire_credits_in_days` × 24 h, null when no positive expiry). `pack_customer_at`, `credit_member`, `ex_member`'s `packSince` all use the new predicate. Default argument ⇒ today's output exactly.
- `shapeFormOnlySnapshot({ contact, locationId, studioDismissedAt = null })` → the snapshot keys with: status `'lead'`, `joined_at` = latest of `contact.created_at` / `contact.last_lead_source_at` (null if neither parses), `recent_bookings []`, `pipeline_dismissed_at` via `dismissalAtStudio(contact, locationId, studioDismissedAt)`, `last_lead_source_at` lent when owned, all else null, `trial_expires_at null`, `paid_trial_at null`, `paid_trial_expires_at null`.
- `packHolderIds({ …, paidTrialProductIds = new Set() })` — a paid-trial transaction is skipped when picking the latest pack. `shapeCounts` passes it through.
- `shapeTrialEligibility({ …, paidTrialProductIds = new Set() })` → reasons may include `'paid_trial'` (a paid-trial transaction, not refunded); `'paid_pack'` only for real packs.
- `shared/pipelines/paid-trial.js`: `export function paidClaimFromSnapshot(snapshot)` → `{ start, end, paidAt: start, grantedAt: start, durationDays }` or null (null `paid_trial_at`); `end = Date.parse(paid_trial_expires_at)` when finite else `start + DEFAULT_DURATION_DAYS × DAY_MS`; `durationDays = Math.round((end − start) / DAY_MS)`.
- `shared/pipelines/paid-trial-un1t.js`: `export { stages } from './paid-trial.js'`, `export { classify } from './paid-trial.js'`, `export const inputSource = 'un1t_online'`, `export const requiredFields = Object.freeze(['id', 'name', 'email', 'location_id'])`.
- `BOARD_MODULES.paid_trial_un1t` registered.

- [ ] **Step 1: Write the failing tests**

In `un1t-online-shape.test.js` (reuse `snap`, `tx`, `PRODUCTS_BY_ID`, `daysAgo`, `NOW`; add `PAID_TRIAL = 'prod-paid-trial'` to `PRODUCTS_BY_ID` as `{ un1t_id: PAID_TRIAL, type: 'one_time', price_cents: 3900, credits_per_period: -1, title: 'The UN1T Trial', expire_credits_in_days: '14' }`, and `paidTrialTx = (over) => tx({ product_id: PAID_TRIAL, amount_cents: 3900, ...over })`, `IDS = new Set([PAID_TRIAL])`):

```js
describe('paid-trial product (Hatch €39)', () => {
  it('without the set, a €39 transaction is a paid pack (today)', () => {
    const s = snap({ transactions: [paidTrialTx({ remote_created_at: daysAgo(2) })], client: pclient({ credit_unlimited: true }) })
    expect(s.pack_customer_at).toBe(daysAgo(2))
    expect(s.paid_trial_at).toBeNull()
  })
  it('with the set: not a pack, paid_trial_at and paid_trial_expires_at set (+14 days), status lead', () => {
    const s = snap({ transactions: [paidTrialTx({ remote_created_at: daysAgo(2) })], client: pclient({ credit_unlimited: true }), paidTrialProductIds: IDS })
    expect(s.pack_customer_at).toBeNull()
    expect(s.glofox_membership_status).toBe('lead')
    expect(s.paid_trial_at).toBe(daysAgo(2))
    expect(Date.parse(s.paid_trial_expires_at)).toBe(Date.parse(daysAgo(2)) + 14 * DAY)
  })
  it('day 15 with unlimited credits left: still not a pack, not credit_member; the €39 classify says Trial Done', () => {
    const s = snap({ transactions: [paidTrialTx({ remote_created_at: daysAgo(15) })], client: pclient({ credit_unlimited: true }), paidTrialProductIds: IDS })
    expect(s.glofox_membership_status).toBe('lead')
    const claim = paidClaimFromSnapshot(s)
    expect(classifyPaid(s, NOW, claim)).toBe('paid_trial_done')
  })
  it('a refunded €39 purchase is no claim', () => {
    const s = snap({ transactions: [paidTrialTx({ refunded: true })], paidTrialProductIds: IDS })
    expect(s.paid_trial_at).toBeNull()
  })
  it('a real 5-pack beside the €39 trial is still a pack', () => {
    const s = snap({ transactions: [paidTrialTx({ remote_created_at: daysAgo(20) }), tx({ remote_created_at: daysAgo(3) })], client: pclient({ credit_balance: 5 }), paidTrialProductIds: IDS })
    expect(s.pack_customer_at).toBe(daysAgo(3))
  })
  it('the snapshot carries the two new keys (and nothing else new)', () => {
    expect(Object.keys(snap()).sort()).toEqual([...SNAPSHOT_KEYS, 'paid_trial_at', 'paid_trial_expires_at'].sort())
  })
})
describe('shapeFormOnlySnapshot', () => {
  it('a fresh enquiry is a lead joined at the enquiry; an old row with a fresh form submission too', () => {
    const a = shapeFormOnlySnapshot({ contact: pcontact({ created_at: daysAgo(3), last_lead_source_at: null }), locationId: HATCH })
    expect(a).toMatchObject({ glofox_membership_status: 'lead', joined_at: daysAgo(3), recent_bookings: [], paid_trial_at: null, trial_expires_at: null })
    expect(classifyContact(a, NOW)).toBe('new_lead')
    const b = shapeFormOnlySnapshot({ contact: pcontact({ created_at: daysAgo(400), last_lead_source_at: daysAgo(1) }), locationId: HATCH })
    expect(b.joined_at).toBe(daysAgo(1))
    expect(classifyContact(b, NOW)).toBe('new_lead')
    const c = shapeFormOnlySnapshot({ contact: pcontact({ created_at: daysAgo(90), last_lead_source_at: daysAgo(80) }), locationId: HATCH })
    expect(classifyContact(c, NOW)).toBe('dormant')
  })
  it('lends Cold and the touch only for an owned contact', () => {
    const own = shapeFormOnlySnapshot({ contact: pcontact({ created_at: daysAgo(3), pipeline_dismissed_at: daysAgo(1) }), locationId: HATCH })
    expect(own.pipeline_dismissed_at).toBe(daysAgo(1))
    const other = shapeFormOnlySnapshot({ contact: pcontact({ location_id: STILLORGAN, created_at: daysAgo(3), pipeline_dismissed_at: daysAgo(1) }), locationId: HATCH, studioDismissedAt: daysAgo(2) })
    expect(other.pipeline_dismissed_at).toBe(daysAgo(2))
    expect(other.last_lead_source_at).toBeNull()
  })
})
describe('packHolderIds / shapeCounts / shapeTrialEligibility with the paid-trial set', () => {
  it('a client whose latest pack transaction is the €39 trial is not a pack holder; an older real pack still counts', …)
  it('shapeTrialEligibility: €39 buyer → reasons [paid_trial], not paid_pack; still ineligible', …)
  it('a real pack buyer → paid_pack as before', …)
})
```

In `shared/pipelines/paid-trial.test.js`: `paidClaimFromSnapshot` returns null without `paid_trial_at`; builds `{ start, end }` from the two fields; falls back to +14 days when `paid_trial_expires_at` is null; `durationDays` 14. In `shared/pipelines/index.test.js`: `getBoardModule('paid_trial_un1t').inputSource === 'un1t_online'`, its `stages` is the same reference as `paid_trial`'s, `classify` the same function, `requiredFields` `['id','name','email','location_id']`.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/membership/reads/un1t-online-shape.test.js shared/pipelines`
Expected: the new tests FAIL (missing exports / keys); everything else passes.

- [ ] **Step 3: Implement** per Interfaces. `shapePipelineSnapshot` computes `paidTrialOf(transactions, productsById, ids)` = the newest non-refunded transaction whose `product_id ∈ ids` → `{ at, expiresAt }`.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/lib/membership/reads shared/pipelines tests/shared-pair-sync.test.js`
Expected: PASS.

- [ ] **Step 5: Commit** — `HATCH39.1 — the paid-trial product set: a €39 purchase is never a pack in the shapers`.

---

### Task 2: The adapter resolves the set and uses it everywhere

**Files:**
- Modify: `src/lib/membership/reads/un1t-online.js` (`paidTrialProductIdsFor`, `pipelineInputs`, `trialEligibility`, `membershipCounts`; `PIPE_CONTACT_COLS` gains `created_at`)
- Modify: `src/lib/membership/reads/un1t-online-radar.js` (`loadRadarInputs` passes the set) and `un1t-online-radar-shape.js` (`radarCore` → `packHolderIds` + `latestPack` skip)
- Modify: `src/lib/agent/trial-done.js:41` (`PURCHASE_REASONS` adds `'paid_trial'`)
- Test: `src/lib/membership/reads/un1t-online.test.js`, `un1t-online-radar-shape.test.js`, `src/lib/agent/trial-done.test.js`

**Interfaces:**
- `export async function paidTrialProductIdsFor(db, locationId)` → `Set<string>`; throws on a failed settings read or a trial-page read marked `unreadable`. Reads `locations.settings` (`.eq('id', locationId).maybeSingle()`) → `settings?.pipelines?.paid_trial?.un1t_product_ids` (strings, trimmed, non-empty) ∪ `loadTrialStudios(db)` entry with `locationId === locationId` → `block?.un1t_product_id`. (Import `loadTrialStudios` from `@/lib/trial-studios`.)
- `pipelineInputs`: resolves the set once; passes `paidTrialProductIds` into `shapePipelineSnapshot`; **form-only contacts**: reads `contacts` `.eq('location_id', locationId)` with `PIPE_CONTACT_COLS` (now `id, name, email, location_id, pipeline_dismissed_at, last_lead_source_at, created_at`), keeps those not in `clientsByContact`, pushes each to `contacts` and sets `snapshots` via `shapeFormOnlySnapshot` and `evidence` to `{ client_created_at: snapshot.joined_at, attended_starts: [], attended_ends: [], member_since: null, classpass_since: null, gympass_since: null, membership_ended_at: null, dismissed_at: snapshot.pipeline_dismissed_at, trial_expires_at: null }`. Result gains `form_only: n`.
- `trialEligibility` and `membershipCounts` pass the set to their shapers; `loadRadarInputs` returns `paidTrialProductIds` and `radarCore` passes it to `packHolderIds` and skips paid-trial transactions in its own `latestPack`.

- [ ] **Step 1: Write the failing tests** — in `un1t-online.test.js` (the `makeDb(world())` fixture): (a) `pipelineInputs` reads `locations` (settings) and the trial page (mock `@/lib/trial-studios` `loadTrialStudios` to return one Hatch entry with the product id) and the snapshot for a €39 buyer has `paid_trial_at` set and `pack_customer_at` null; (b) a Hatch-home contact with no client row appears in `contacts` with a `lead` snapshot and `evidence.client_created_at = created_at`, counted in `form_only`; a Stillorgan-home contact with no client does not; (c) the pinned "contacts read by id only" test becomes "contacts read by id for linked clients AND by location_id for form-only; seven named columns; no Glofox column"; (d) `trialEligibility` for a €39 buyer answers `{ eligible: false, reasons: ['paid_trial'], regrant: false }`; (e) a failed settings read fails `pipelineInputs` (`success: false`). In `un1t-online-radar-shape.test.js`: a user whose latest pack is the paid-trial product is not `credit_member`. In `trial-done.test.js`: `paid_trial` in `eligibilityReasons` suppresses the offer like `paid_pack`.

- [ ] **Step 2: Run to verify they fail** — `npx vitest run src/lib/membership/reads src/lib/agent/trial-done.test.js`.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** — same command plus `npm run check:select-columns && npm run check:guardrails`. Expected: PASS.

- [ ] **Step 5: Commit** — `HATCH39.2 — the un1t read adapter resolves the paid-trial products and emits form-only snapshots`.

---

### Task 3: The orchestrator routes on the un1t path

**Files:**
- Modify: `shared/pipelines/router.js` (`routeContact(contact, claims, now, boards, { classifyAcquisition } = {})`)
- Modify: `src/lib/pipeline-reclassify.js` (un1t path routing, `activeModules` → board keys, `boardHistogram` on the un1t path, `DRY_RUN_SELF_MODULES`, `EXCLUDING_MODULES`)
- Test: `shared/pipelines/router.test.js`, `src/lib/pipeline-reclassify.test.js`

**Interfaces:**
- `routeContact(contact, claims, now, boards, { classifyAcquisition = classifyContact } = {})`: `acq = classifyAcquisition(contact, now)`; `boards` is the set of enabled board **keys** (documented; Stillorgan's keys equal its modules).
- Orchestrator un1t path: `acqMod` = the active board whose module has `inputSource 'un1t_online'` and key `acquisition` (else the first un1t board); per contact `routeContact(snapshot, { paid: paidClaimFromSnapshot(snapshot), programme: null }, nowMs, activeBoardKeys, { classifyAcquisition: acqMod.mod.classify })`. `activeBoardKeys = new Set(activePipelines.map((p) => p.key))` on both paths. `boardHistogram` is emitted on every dry run. `DRY_RUN_SELF_MODULES = ['paid_trial', 'programmes', 'paid_trial_un1t']` replaces the `CLAIM_BOARD_MODULES.includes` check. `EXCLUDING_MODULES` adds `'paid_trial_un1t'`.

- [ ] **Step 1: Write the failing tests** — router: `classifyAcquisition` option is used for the fallback and the Cold/Gympass check (a stub returning `'trial_done'`). Reclassify (the HATCH fixtures, `seamWith(pipelineInputs)`): with boards `acquisition_un1t` + `paid_trial_un1t` and a snapshot carrying `paid_trial_at` 2 days ago → the deal moves to `paid_trial_new_lead` with `pipeline_id` of the paid board (cross-board update), `boards_moved: 1`; a snapshot without → today's placement; a dry run reports `board_histogram`; `includeDisabled: ['paid_trial']` on a disabled `paid_trial_un1t` row dry-runs it as itself; the existing HATCH tests unchanged.

- [ ] **Step 2: Run to verify they fail.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run** `npx vitest run shared/pipelines src/lib/pipeline-reclassify.test.js src/lib/pipeline-other-studio-members.test.js src/app/api/admin/pipeline-reclassify` → PASS. — [ ] **Step 5: Commit** — `HATCH39.3 — the un1t pass routes each person to Acquisition or the €39 board`.

---

### Task 4: Fence the webhook placement at un1t studios

**Files:**
- Modify: `src/lib/deal-lookup.js` (`findPrimaryPipeline` selects `id, mode, module`)
- Modify: `src/lib/glofox-sync.js` (`ensureDealForContact`: after the primary check, `if (getBoardModule(primary.module)?.inputSource === 'un1t_online') return { action: 'leave', deal_id: null, stage_slug: null, reason: 'un1t_board' }`; `targetBoard` lookup by `b.key`)
- Test: `src/lib/glofox-sync.test.js`, `src/lib/deal-lookup.test.js`

- [ ] **Step 1: Write the failing tests** — a location whose primary is `{ mode: 'derived', module: 'acquisition_un1t' }` → `leave` with `reason 'un1t_board'` and no `deals` read or write; the manual-primary case unchanged; `findPrimaryPipeline`'s select string.
- [ ] **Step 2–4:** RED → implement → `npx vitest run src/lib/glofox-sync.test.js src/lib/deal-lookup.test.js 'src/app/api/contacts/[id]/pipeline-status' src/lib/pipeline-place-now.test.js` PASS.
- [ ] **Step 5: Commit** — `HATCH39.4 — ensureDealForContact leaves a un1t.online primary to the hourly pass`.

---

### Task 5: Cutover migration 803 and enable migration 804

**Files:**
- Create: `supabase/migrations/803_hatch_paid_trial_board_waitlist_retired.sql`
- Create: `supabase/migrations/804_hatch_paid_trial_board_enable.sql`
- Create: `tests/migration-803-hatch-paid-trial-board.test.js` (PGlite, the 797 harness: `locations(settings)`, `pipelines`, `pipeline_stages`, `contacts(location_id, pipeline_stage_slug)`, `deals(contact_id, location_id, pipeline_id, stage_id, status, updated_at)`, `trial_purchases`; fixture: Hatch acquisition (enabled, not primary, 0) with stages `new_lead` etc., Hatch waitlist (manual, primary, 1) with `waitlist_new_enquiry`, Stillorgan rows; contacts A (waitlist + acquisition deal), B (waitlist only, form-only), C (waitlist only, account holder — same treatment as B); contacts with `pipeline_stage_slug 'waitlist_new_enquiry'`)

**803, one transaction, Hatch only:**
1. Insert `paid_trial` board disabled + its 5 stage rows (conflict-target slug; count = 5); `UPDATE pipelines SET display_order = 2 WHERE key = 'waitlist'`.
2. Settings seed when absent.
3. Waitlist open deals: close `lost` where the contact holds an open acquisition deal; else `UPDATE deals SET pipeline_id = <acq>, stage_id = <acq new_lead> WHERE id IN (…)`. Count both into `v_closed`, `v_moved`; raise if any waitlist deal remains open.
4. `UPDATE pipelines SET is_primary = false, enabled = false WHERE key = 'waitlist'`; then `SET is_primary = true WHERE key = 'acquisition'`.
5. Clear `contacts.pack_customer_at` for Hatch-home contacts (best effort: those with no `trial_purchases`-independent evidence is unknowable in SQL; clear where a `trial_purchases` row at Hatch is `granted` and the stamp falls inside its window, as 797 did).
6. Self-check: acquisition the one enabled primary; `paid_trial` disabled, derived, 5 stages; zero open waitlist deals; every moved deal on acquisition `new_lead`; Stillorgan `pipelines` hash unchanged; no deal outside Hatch changed.

**804:** `UPDATE pipelines SET enabled = true WHERE location_id = Hatch AND key = 'paid_trial'`; self-check: acquisition still primary, exactly `acquisition` + `paid_trial` enabled at Hatch, raise when the row is missing.

- [ ] **Step 1: Write the PGlite tests** (static: one `BEGIN`/`COMMIT`, ≥5 `RAISE EXCEPTION`, no Stillorgan id, `is_primary` assigned only to acquisition true / waitlist false; behaviour: A's waitlist deal closed `lost` and acquisition deal untouched; B's and C's moved to acquisition `new_lead`; primary flipped; `paid_trial` seeded disabled with 5 stages at 601–605; settings seeded once; idempotent; rollback when a waitlist deal cannot be placed (fixture without an acquisition `new_lead` stage); 800 enables, raises without 799).
- [ ] **Step 2: RED.** — [ ] **Step 3: Write both migrations.** — [ ] **Step 4:** `npx vitest run tests/migration-803-hatch-paid-trial-board.test.js tests/table-default-acl-guard.test.js && npm run check:select-columns && npm run check:rls-restrictive` PASS.
- [ ] **Step 5: Commit** — `HATCH39.5 — migs 803/804: Waitlist retired, Acquisition primary, €39 board seeded then enabled`.

---

### Task 6: Docs, mirror, PR, rollout

- `docs/architecture/REFERENCE.md`: a paragraph after the PIPE3 one (Hatch: two boards, the paid-trial product set, form-only leads, Waitlist retired 1 Nov 2026). `CLAUDE.md`: one line appended to the PIPE3 invariant: at a un1t.online studio a paid-trial product (`paidTrialProductIdsFor`) is never a pack on any read, and `ensureDealForContact` never places at a studio whose primary is a un1t board.
- Commit spec + plan + docs. CI mirror (expect the same three local-only guard failures), `npm run build`. Push, `gh pr create`, changelog entry `docs/changelog/entries/<PR>.md`.
- Rollout: merge/deploy FIRST (a no-op on pre-cutover data), then apply 803 (`get_advisors`); dry run `POST /api/admin/pipeline-reclassify { location_id: Hatch, dry_run: true, include_disabled: ['paid_trial'] }` → Richard reads `board_histogram` / `movement_matrix`; on his go apply 804; the next hourly un1t pass moves the cards.

## Self-review notes

- Spec coverage: board + module (T1), product set and "never a pack" on every read incl. eligibility label, dashboard, radar, trial-done (T1–T2), form-only snapshots (T1–T2), routing on the un1t path (T3), fence (T4), cutover + enable (T5), docs/rollout (T6). Web labels/colours and the phone picker exist from PIPE3.
- Interfaces: `paidTrialProductIds: Set<string>` everywhere; `paidClaimFromSnapshot(snapshot)` consumed by T3; `routeContact`'s 5th argument from T3 is optional so Stillorgan's callers are unchanged.
