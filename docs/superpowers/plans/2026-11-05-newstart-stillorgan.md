# NEWSTART.1 /newstart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the /corp promo mechanism grant through Glofox, so Stillorgan can run `/newstart`: 3 free classes for 7 days, class picked on the page.

**Architecture:** The promo registry gains a `platform`. The public claim route keeps today's un1t.online path untouched and adds a Glofox branch: its own eligibility (current members, people holding a live plan, once per person), its own fulfilment (find/create the Glofox account, write-ahead complimentary purchase of a €0 plan, funded class booking, PIPE3 placement, email), and a stalled-claim sweeper arm on an existing cron.

**Tech Stack:** Next.js 16 route handlers, Supabase (service role), vitest, the existing Glofox helpers in `src/lib/glofox.js` / `src/lib/glofox-push.js`.

**Spec:** `docs/superpowers/specs/2026-11-05-newstart-stillorgan-design.md`

**Worktree:** `/Users/richardivers/code/un1t-crm-newstart`, branch `newstart-stillorgan-promo` (off `origin/main` 1ea0d99fb). Run `npm ci` first (empty node_modules in a fresh worktree).

## Global Constraints

- Ticket prefix `NEWSTART.1` on every commit subject; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Promo key `stillorgan-newstart`; studio `stillorgan`; publicPath `stillorgan`; platform `glofox`; credits `3`; expiresInDays `7`; tag `stillorgan-newstart`; leadSource `corp_promo`; name `New Start (Stillorgan)`; ships `live: false`.
- The Hatch promo `hatch-3-free` gets `platform: 'un1t_online'`, `name: 'Corporate trial (Hatch Street)'` and NO behaviour change.
- Glofox purchase body is `TRIAL_PURCHASE_BODY` (`{ payment_method: 'complimentary' }`) from `src/lib/trial-purchase-processor.js`; never re-sent; judged by `purchaseGlofoxMembership`'s `ok` / `outcome_unknown`.
- `findOrCreateGlofoxMember` with `source: 'corp_promo'`, `createIfMissing: true`, `attachTrial: false`, `phoneMatchPolicy: 'review'`.
- A failed read is never a refusal and never "nothing there": in the route it is 503; inside fulfilment it is a help card.
- Logs carry ids and codes only (never email, phone, name, password).
- Migrations: `810` (columns + index; apply BEFORE merge), `811` (heartbeat row; apply RIGHT AFTER deploy). Re-check the next free number after any main sync.
- Every new supabase write destructures `error`; add the new lib files to the `no-unchecked-supabase-write` path list in `eslint.guardrails.config.mjs`.
- No new terms tick: Stillorgan's /trial has none, so a Glofox promo renders with `terms = null` and the route does not require `terms_accepted` for it (correction to the spec §2, which assumed one existed).

## Review Focus

1. **Double submit / two tabs:** two concurrent claims for the same contact must buy at most once (the unique index in Task 1 makes the second insert fail `23505`; the route answers `help_text`). Test in Task 4.
2. **Contact already linked to a Glofox member:** `findOrCreateGlofoxMember` returns `status: 'skipped'` with the id; fulfilment must use that id AND still run the live-plan check. Test in Task 3.
3. **A live plan only visible in Glofox** (CRM row stale): the live-plan check reads Glofox, not just `contacts`. Test in Task 3 (member status `trial` from Glofox, CRM says nothing).
4. **Hatch /corp unchanged:** a `hatch-3-free` claim still calls `fulfilCorpPromoClaim`, still needs the terms tick, still uses `placeWaitlistEntry`, and never touches the Glofox modules. Test in Task 4.
5. **Promo marked live with no plan ids:** answers `not_available`, inserts nothing. Test in Task 4.

---

### Task 1: Registry, Glofox plan map, migration 810

**Files:**
- Modify: `src/lib/corp-promos.js` (registry entries, `corpPromosForStudio`, Glofox copy defaults)
- Create: `src/lib/corp-promo-glofox-plans.js` (server-only)
- Create: `supabase/migrations/810_corp_promo_glofox.sql`
- Test: `src/lib/corp-promos.test.js`, `src/lib/corp-promo-glofox-plans.test.js`

**Interfaces:**
- Produces: `CorpPromo` gains `platform: 'un1t_online'|'glofox'` and `name: string`.
- Produces: `corpPromosForStudio(publicPath: string): CorpPromo[]` (live promos at that studio, registry order).
- Produces: `CORP_PROMO_GLOFOX_COPY_DEFAULT` (same keys as `CORP_PROMO_COPY_DEFAULT`) and `corpPromoCopyFromBlocks(blocks, promoKey, { platform } = {})` choosing that default set when `platform === 'glofox'`.
- Produces: `glofoxPlanForPromo(key: string): { membershipId: string, planCode: string, planName: string } | null` (null when unknown or either id blank).
- Produces: `corp_promo_claims.glofox_member_id text`, `corp_promo_claims.grant jsonb`, unique partial index `corp_promo_claims_one_live_per_contact`.

- [ ] **Step 1: Write failing tests**

```js
it('the newstart promo is a glofox promo at stillorgan, off until its plan exists', () => {
  const p = resolveCorpPromo('stillorgan-newstart')
  expect(p).toMatchObject({ studio: 'stillorgan', publicPath: 'stillorgan', platform: 'glofox', credits: 3, expiresInDays: 7, tag: 'stillorgan-newstart', leadSource: 'corp_promo', live: false })
  expect(resolveCorpPromo('hatch-3-free').platform).toBe('un1t_online')
})
it('corpPromosForStudio lists only that studio', () => {
  expect(corpPromosForStudio('hatch-street').map((p) => p.key)).toEqual(['hatch-3-free'])
})
it('glofox copy defaults never mention un1t.online', () => {
  expect(JSON.stringify(CORP_PROMO_GLOFOX_COPY_DEFAULT)).not.toMatch(/un1t\.online/i)
  expect(corpPromoCopyFromBlocks([], 'stillorgan-newstart', { platform: 'glofox' }).heading).toBe(CORP_PROMO_GLOFOX_COPY_DEFAULT.heading)
})
// corp-promo-glofox-plans.test.js
it('a promo with blank plan ids has no plan', () => { expect(glofoxPlanForPromo('stillorgan-newstart')).toBeNull() })
it('an unknown promo has no plan', () => { expect(glofoxPlanForPromo('nope')).toBeNull() })
```

- [ ] **Step 2: Run** `npx vitest run src/lib/corp-promos.test.js src/lib/corp-promo-glofox-plans.test.js` → FAIL (missing exports).

- [ ] **Step 3: Implement.** Registry fields per Global Constraints. `CORP_PROMO_GLOFOX_PLANS = { 'stillorgan-newstart': { membershipId: '', planCode: '', planName: 'New Start' } }` in the new server-only module (it is never imported by a client component). Glofox copy default, exact words:

```js
title: 'New Start at {studio_name}',
eyebrow: '',
heading: '3 free classes at {studio_name}',
subhead: 'Coach-led strength and conditioning. Your first three classes are on us: pick your first class, claim in under a minute.',
ticks: ['3 coach-led classes, free', 'Use them within 7 days of your first class', 'Book the rest in the UN1T app'],
cta_label: 'Claim my 3 free classes',
consent_label: (same as CORP_PROMO_COPY_DEFAULT),
done_title: "You're in 🎉",
done_body: 'Your {credits} free classes are on your account. Use them within 7 days of your first class. Check your email for how to log in to the UN1T app and book.',
trained_text: (unused for glofox; same as un1t default),
already_claimed_text: "You've already claimed this offer, so your free classes are on your account. Book them in the UN1T app; if they're not there, reply to our email.",
trial_used_text: (same as un1t default),
active_member_text: "It looks like you're already a member at {studio_name}, so your classes are covered. If that's not right, ask at the front desk.",
help_text: "Thanks, we've got your details. Something needs a quick check on our side, so the team will be in touch shortly to get your classes on your account.",
unavailable_text: 'This offer is not available right now.',
email_subject: 'Your {credits} free classes at {studio_name}',
email_body: 'Hi {first_name}, your {credits} free classes at {studio_name} are on your account. Use them within 7 days of your first class. Log in to the UN1T app with this email (tap "Forgot password" if you have not set one) and book your classes there. Reply to this email if anything looks off.',
```

Migration 810: `ADD COLUMN IF NOT EXISTS glofox_member_id text`, `ADD COLUMN IF NOT EXISTS grant jsonb`, a `COMMENT` on each (NEWSTART.1, write-ahead marker same shape as `trial_purchases.grant`), `CREATE UNIQUE INDEX IF NOT EXISTS corp_promo_claims_one_live_per_contact ON public.corp_promo_claims (promo_key, contact_id) WHERE status IN ('processing','granted','help_requested')`, `-- grant: none (no new relation)`, and a self-check DO block asserting both columns and the index exist. Verified 5 Nov: one claim row in prod, no duplicates.

- [ ] **Step 4: Run the tests** → PASS. Run `npm run check:select-columns` → clean.
- [ ] **Step 5: Apply 810** via Supabase MCP `apply_migration` on `iyvtbjjxdggiadzwwvdj`; run `get_advisors` (security); confirm the columns in `information_schema.columns`.
- [ ] **Step 6: Commit** `NEWSTART.1a — glofox promo registry, plan map, mig 810`.

### Task 2: Glofox eligibility

**Files:**
- Modify: `src/lib/corp-promo-eligibility.js` (export `personContactIds`)
- Create: `src/lib/corp-promo-eligibility-glofox.js`
- Test: `src/lib/corp-promo-eligibility-glofox.test.js`

**Interfaces:**
- Consumes: `personContactIds(db, { organizationId, contactId, email, phone }): Promise<string[]>` (now exported, unchanged).
- Produces: `glofoxCorpPromoEligibility(db, { locationId, organizationId, contactId, email, phone, promoKey }): Promise<{ ok: true, eligible: true } | { ok: true, eligible: false, reason: 'active_member'|'already_claimed'|'in_progress' } | { ok: false }>`

Rules, in order: any person contact with `contact_studios` at the location with `membership_status = 'active'`, or a `contacts` row with `glofox_membership_status = 'member'` and that contact's `location_id`/studio row at the location → `active_member`. Then `corp_promo_claims` for `promoKey` across the person's contacts: any `granted` or `help_requested` → `already_claimed`; any `processing` → `in_progress`. Prior trials and training never refuse. Any read error → `{ ok: false }` (logWarn, ids and codes).

- [ ] **Step 1: Write failing tests:** eligible with no rows; `active_member` from `contact_studios`; `already_claimed` from a granted row on a SIBLING contact matched by mobile; `in_progress` from a processing row; a person with a `class_bookings` history and a `trial_purchases` granted row is still eligible; a read error on `corp_promo_claims` → `{ ok: false }`.
- [ ] **Step 2: Run** `npx vitest run src/lib/corp-promo-eligibility-glofox.test.js` → FAIL.
- [ ] **Step 3: Implement** with `selectAllByKeys` (1,000-row cap, explicit `.order`), as the un1t module does.
- [ ] **Step 4: Run** → PASS; `npx vitest run src/lib/corp-promo-eligibility.test.js` still PASS.
- [ ] **Step 5: Commit** `NEWSTART.1b — glofox promo eligibility`.

### Task 3: Glofox fulfilment

**Files:**
- Create: `src/lib/corp-promo-claim-glofox.js`
- Modify: `src/lib/corp-promo-emails.js` (accept a `copy` whose `email_body` has no un1t app section: `appLinks` stays null for glofox)
- Modify: `eslint.guardrails.config.mjs` (arm the three new lib files)
- Test: `src/lib/corp-promo-claim-glofox.test.js`

**Interfaces:**
- Consumes: `glofoxPlanForPromo` (Task 1); `findOrCreateGlofoxMember`, `glofoxCredentialsForLocation`, `missingGlofoxCredentialsForLocation`, `fetchMemberResult`, `fetchUserCreditsResult`, `purchaseGlofoxMembership`, `mapMembershipStatus`, `computeCreditsRemaining` (`src/lib/glofox-sync.js`), `TRIAL_PURCHASE_BODY`, `queueFundedClassBooking` + `fundedBookingFromRow` + `FUNDED_BY.corpPromo`, `placeContactNow`, `sendCorpPromoEmail`, `sendOpsAlert`.
- Produces: `fulfilGlofoxCorpPromoClaim(db, { claim, location, contact, promo, copy, zone }, deps = {}): Promise<{ kind: 'granted', credits: number, expiresAt: null } | { kind: 'help_filed' } | { kind: 'unavailable' }>` — same shape as `fulfilCorpPromoClaim`.
- Produces: help reasons written to `corp_promo_claims.reason`: `glofox_not_configured`, `account_needs_review: <msg>`, `account_create_failed: <msg>`, `live_plan: <status>|credits`, `glofox_read_failed`, `grant_unrecorded`, `grant_refused: <code>`, `grant_unverified`, `stalled` (Task 6).

Order (mirror `processTrialPurchase`, `src/lib/trial-purchase-processor.js:141-235`):
1. Plan: `glofoxPlanForPromo(promo.key)` null → `unavailable` (row → `failed`, reason `plan_missing`).
2. Credentials: `readError` → row `failed`, `unavailable`; missing → help `glofox_not_configured`.
3. Account: linked `contact.glofox_member_id` used as is; else `findOrCreateGlofoxMember` per Global Constraints; `skipped` with an id → use it; `needs_review` → help; `failed` or no id → help `account_create_failed`. Track `created = res.status === 'created'`.
4. Live plan (skip when `created`): `fetchMemberResult` not ok → help `glofox_read_failed`; `mapMembershipStatus(member)` in `member|trial|credit_member|classpass_payg` → help `live_plan: <status>`; `fetchUserCreditsResult` not ok → help `glofox_read_failed`; `computeCreditsRemaining(credits) > 0` → help `live_plan: credits`.
5. Write-ahead: stamp `{ grant: { stage: 'purchasing', at, glofox_member_id, membership_id, plan_code }, glofox_member_id }` guarded `.eq('status','processing').is('grant', null)` and judged on rows touched (`.select('id')`); 0 rows or error → help `grant_unrecorded`, no purchase.
6. Purchase: ok → stamp `status 'granted'`, `grant { ok: true, at, invoice_id, purchase_status }`, `credits: promo.credits`, `expires_at: null`; `outcome_unknown` → help `grant_unverified` (grant keeps the marker + `outcome_unknown: true`); else help `grant_refused: <message_code>`.
7. After grant, each in its own try/catch: `queueFundedClassBooking(db, fundedBookingFromRow({ ...claim, contact_id: contact.id }, { fundedBy: FUNDED_BY.corpPromo }))` when non-null; `placeContactNow(db, { locationId, contactId })`; `sendCorpPromoEmail(db, { claim, copy, studioName: location.name, zone, appLinks: null })`.
8. Help = stamp `status 'help_requested', reason` (+ grant when known) and `sendOpsAlert` to the organisation, html escaped, naming the claim id and reason, never the password.

- [ ] **Step 1: Write failing tests** (mock the helpers via `deps` or `vi.mock`):
  - new account → no live-plan read, purchase called once with `TRIAL_PURCHASE_BODY`, row granted, booking queued, placement and email called.
  - linked account (`skipped`) with Glofox member status `trial` (CRM contact says nothing) → help `live_plan: trial`, purchase never called.
  - credits remaining 2 → help `live_plan: credits`, no purchase.
  - `fetchMemberResult` `{ ok: false }` → help `glofox_read_failed`, no purchase.
  - marker stamp touches 0 rows → help `grant_unrecorded`, no purchase.
  - purchase `outcome_unknown` → help `grant_unverified`, purchase called exactly once (no retry).
  - purchase refused `YOU_HAVE_NO_CREDITS_LEFT` → help `grant_refused: YOU_HAVE_NO_CREDITS_LEFT`.
  - `queueFundedClassBooking` throws → still `granted`.
  - `needs_review` from `findOrCreateGlofoxMember` → help `account_needs_review: <error>`.
- [ ] **Step 2: Run** `npx vitest run src/lib/corp-promo-claim-glofox.test.js` → FAIL.
- [ ] **Step 3: Implement** per the order above.
- [ ] **Step 4: Run** → PASS; `npm run check:guardrails` clean.
- [ ] **Step 5: Commit** `NEWSTART.1c — glofox promo fulfilment`.

### Task 4: Claim route branch, page and editor

**Files:**
- Modify: `src/app/api/public/corp-claims/route.js`
- Modify: `src/app/(public)/[slug]/[[...rest]]/page.js` (lines ~366-379: `terms = null` and glofox copy for a glofox promo)
- Modify: `src/components/landing-pages/studio-offer-fields.jsx` (`CorpPromoFields` lists `corpPromosForStudio(<page studio publicPath>)`; keep the saved-but-unlisted option)
- Modify: `src/lib/public-pages-edge.js` (`'newstart'` in `PUBLIC_PAGE_SLUGS_FALLBACK[UN1T_GROUP_ORG_ID]`)
- Test: `src/app/api/public/corp-claims/route.test.js`, `src/lib/public-pages-edge.test.js`

**Interfaces:**
- Consumes: Tasks 1-3.

Route, for `promo.platform === 'glofox'` only: copy via `corpPromoCopyFromBlocks(..., { platform: 'glofox' })`; `glofoxPlanForPromo` null → `notAvailable` before any write; gate on `glofoxCredentialsForLocation` instead of `un1tWriteSettingsFrom` (readError → 503; missing → `notAvailable(copy.unavailable_text)`); no `terms_accepted` requirement and no `readUn1tLegalDocs` (`terms_source: null`); skip `placeWaitlistEntry` (placement happens in fulfilment after the grant); after lead capture run `glofoxCorpPromoEligibility`: `{ ok: false }` → 503, `active_member` → `refused('active_member', ...)`, `already_claimed` → `refused('already_claimed', ...)`, `in_progress` → `refused('help_filed', say(copy.help_text))`; insert as today with no `terms_*` values; insert error `23505` → `refused('help_filed', say(copy.help_text))`; then `fulfilGlofoxCorpPromoClaim`. Done message: `fillCorpPromoTokens(copy.done_body, …)` (no `{expires_on}` in the glofox copy). The un1t branch is unchanged line for line.

- [ ] **Step 1: Write failing route tests** (extend the existing mock setup; mock the three new modules): glofox promo set live in the test → granted path calls `fulfilGlofoxCorpPromoClaim` and not `fulfilCorpPromoClaim` or `placeWaitlistEntry`, and does not need `terms_accepted`; glofox promo with null plan → 400 `not_available`, `m.inserted` not called; eligibility `in_progress` → 200 `help_filed`; insert `23505` → 200 `help_filed`; eligibility `{ ok: false }` → 503; and the Hatch regression: `hatch-3-free` without `terms_accepted` → 400 `terms_required`, with it → `fulfilCorpPromoClaim` and `placeWaitlistEntry` called, glofox modules not called.
- [ ] **Step 2: Run** `npx vitest run src/app/api/public/corp-claims/route.test.js` → FAIL.
- [ ] **Step 3: Implement** the branch, the page change, the editor filter, the fallback slug.
- [ ] **Step 4: Run** the route tests, `npx vitest run src/lib/public-pages-edge.test.js src/public-compliance-paths.test.jsx` → PASS; `npm run check:route-guards && npm run check:location-scoping` clean.
- [ ] **Step 5: Commit** `NEWSTART.1d — /corp claims grant through Glofox; /newstart slug`.

### Task 5: Approvals card for Glofox claims

**Files:**
- Modify: `src/lib/approvals/providers/corp-promo-claims.js` (COLS gains `glofox_member_id, grant`; `whyText` covers every Task 3 reason; item gains `glofoxMemberId`, `platform` from `resolveCorpPromo(promo_key)?.platform`)
- Modify: `src/components/CorpPromoClaimCard.jsx` (shows "Glofox member <id>" when set; for `grant_unverified`/`stalled` with a marker, the line "Check the member's €0 New Start invoice in Glofox before adding the plan by hand.")
- Test: `src/lib/approvals/providers/corp-promo-claims.test.js`

- [ ] **Step 1: Write failing tests:** each Glofox reason maps to a sentence that names Glofox and says whether anything was bought (`live_plan` and `glofox_read_failed`: "Nothing was bought."; `grant_unverified`: "may have gone through"); a un1t reason still maps as today.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `npm run check:select-columns` clean.
- [ ] **Step 5: Commit** `NEWSTART.1e — approvals card reads Glofox claims`.

### Task 6: Stalled-claim sweeper arm + migration 811

**Files:**
- Create: `src/lib/corp-promo-stalled-sweep.js`
- Modify: `src/app/api/cron/process-trial-purchases/route.js` (a new arm after the checkout sweep, own try/catch, own `stampHeartbeat('corp-promo-stalled-sweep', …)` only when the sweep returned `ok`)
- Create: `supabase/migrations/811_corp_promo_stalled_sweep_heartbeat.sql` (copy 806's shape: 120s interval, 600s grace, notes naming this arm)
- Test: `src/lib/corp-promo-stalled-sweep.test.js`, the cron route's test

**Interfaces:**
- Produces: `sweepStalledGlofoxCorpClaims(db, { now = Date.now() } = {}): Promise<{ ok: boolean, checked: number, filed: number, failed: number }>`

Selects `corp_promo_claims` with `status = 'processing'` and `created_at` older than 15 minutes, ordered by `created_at`, limit 100; keeps only promos whose registry `platform` is `glofox`; for each: CAS update `.eq('status','processing')` to `help_requested`, reason `stalled`, judged on rows touched; then `sendOpsAlert`. A read error → `ok: false`. Never calls Glofox.

- [ ] **Step 1: Write failing tests:** a 20-minute-old glofox processing row is filed once; a 5-minute-old row is left; a un1t processing row is left; a CAS that touches 0 rows sends no alert; a read error → `ok: false` and the route does not stamp the arm.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS; `grep -L stampHeartbeat src/app/api/cron/*/route.js` unchanged.
- [ ] **Step 5: Commit** `NEWSTART.1f — stalled /newstart claims go to the team`. (811 is applied after deploy, Task 8.)

### Task 7: Trial history rules

**Files:**
- Modify: `src/lib/agent/trial-grant.js` (a check beside `trialOnAnotherCard`/`trialAtMint`, line ~260)
- Modify: `src/lib/trial-eligibility.js` (`stillorganTrialHistory`)
- Test: `src/lib/agent/trial-grant.test.js`, `src/lib/trial-eligibility.test.js`

Rules (Richard, 5 Nov): a New Start claim counts as the free trial, never as a reason to refuse the €39 Reset.
- `grantTrialBeforeBooking`: a `corp_promo_claims` row at the location with `glofox_member_id = memberId` and (`status = 'granted'` or `grant->>'stage' = 'purchasing'`) and a promo whose registry platform is `glofox` → `stop(TRIAL_ALREADY_GRANTED, { prior_corp_claim_id })`; read error → the same `{ ok: false }` handling its siblings use.
- `stillorganTrialHistory`: when the contact's `glofox_membership_plan` equals a Glofox promo's `planName` (from `corp-promo-glofox-plans.js`), drop the `membership_status=trial` reason that plan caused. Nothing else changes, so the €39 pre-check and its help route both let them buy.

- [ ] **Step 1: Write failing tests:** trial grant stops with `TRIAL_ALREADY_GRANTED` for a member with a granted New Start claim, and proceeds for a member with only a `failed` one; `stillorganTrialHistory` on `{ glofox_membership_status: 'trial', glofox_membership_plan: 'New Start' }` → `hadTrial: false`; on `'The UN1T 14 Day Reset Trial'` → still `hadTrial: true`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `NEWSTART.1g — a New Start claim is the free trial, not a bar to the €39 Reset`.

### Task 8: Ship

- [ ] **Step 1:** Full CI mirror from CLAUDE.md (all thirteen), then `npm run build`. Do not re-run the suite beside the build (8 GB Mac).
- [ ] **Step 2:** `git push -u origin HEAD`; `gh pr create --base main` (body: what, migs 810 applied / 811 after deploy, the rollout steps from the spec, no customer names); add `docs/changelog/entries/<PR>.md`; commit and push.
- [ ] **Step 3:** After merge and deploy: apply 811, `get_advisors`.
- [ ] **Step 4 (waits on Richard):** he creates the €0 New Start plan in Glofox (3 classes, 1 week, private, trial-type if offered, no "trial" in the name, complimentary allowed) and sends the ids → follow-up PR filling `CORP_PROMO_GLOFOX_PLANS` and `live: true`.
- [ ] **Step 5 (after that deploys):** Richard (or I, with his OK) creates the `/newstart` page at `/settings/landing-page`: campaign, offer "Free classes (promo code)", studio Stillorgan, promo "New Start (Stillorgan)"; a test claim on a staff email shows the €0 invoice in Glofox and the class books. After the next Glofox sync, check the test contact's `glofox_membership_status` and board: it must read `trial` and sit in the free trial board's trial column (spec §3c). If it reads `member`, open a follow-up to map the New Start plan to `trial` before the link goes to the partner.
