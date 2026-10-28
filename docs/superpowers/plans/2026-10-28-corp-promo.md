# /corp corporate promos (CORPPROMO.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A public `/corp` page where anyone with the link who has never trained at Hatch Street, and whose email or mobile was never used for a free trial, gets 3 un1t.online credits that expire in 7 days.

**Architecture:** The `/trial` Hatch leg with the checkout swapped for a new ledgered write primitive `grantPromoCredits` (`POST /credits/grant`, op `promo_grant`). A code registry names each promo; its words live on a `corp_promo` landing block. A service-role `corp_promo_claims` table records every attempt, and an approvals provider shows the ones staff must handle.

**Tech Stack:** Next.js 16 App Router, Supabase (service role), Vitest, the un1t.online write layer (`src/lib/un1t-online-write*.js`).

**Spec:** `docs/superpowers/specs/2026-10-28-corp-promo-design.md`

## Global Constraints

- Promo `hatch-3-free`: studio `hatch` (public path `hatch-street`), `credits: 3`, `expiresInDays: 7`, lead tag `hatch-corp-promo`, lead source `corp_promo`, `live: true`. Amount and expiry come only from the registry.
- Origin on every ledger row: `corp_promo`.
- `POST /credits/grant` may stand only inside `regrantTrialCredits` and `grantPromoCredits` (ops module) and the transport `ENDPOINTS`; `grantPromoCredits` is called only from `src/lib/corp-promo-claim.js`.
- Stops: email OR mobile previously used for a free trial (Hatch `op` `trial`/`trial_regrant`/`promo_grant` ledger rows in done/sent/unknown, or a mirrored transaction for the studio's `trialProductId`); OR trained at Hatch (non-cancelled `un1t_bookings`, any `un1t_subscriptions`, a Hatch `contact_studios` row with `membership_status` in active/ended, a non-cancelled Hatch `class_bookings` row). Paid packs / paid `/trial` alone are not a stop. Only Hatch's `location_id`.
- Any failed read → 503 "try again", never eligible. Never "you're in" before the grant is `done` or the credits read shows them.
- New table: RLS on, no policy, `REVOKE ALL … FROM anon, authenticated, PUBLIC`. Migration `787_corp_promo.sql`, self-checking from the catalog.
- All four public allowlists for `/corp`; noindex; `check:location-scoping`, `check:route-guards`, `check:select-columns`, `no-unchecked-supabase-write` (arm the new lib files) green.

## Review Focus

1. Double submit / two tabs: the second request must not grant twice → unique open/done index on `(location_id, un1t_user_id, target)` for `promo_grant`, and the claim resumes the ledger row. Test in Task 2.
2. Same mobile, different email (person retries with a second address) → refused `free_trial_used`. Test in Task 4.
3. un1t.online 5xx / no reply on the grant → never re-sent; credits read decides; else staff card, page says "the team will be in touch". Test in Task 2 and Task 5.
4. Promo switched off / unknown promo key → page shows "not available right now", route 400 `not_available`, never 404/500. Test in Task 6.
5. Writes off at Hatch, or settings unreadable → 503/`not_available`, nothing captured to un1t.online. Test in Task 6.

---

### Task 1: Migration 787

**Files:** Create `supabase/migrations/787_corp_promo.sql`; Test `tests/corp-promo-migration.test.js`

- [ ] Write a test that reads the file and asserts: the op CHECK lists the ten ops (`… 'move', 'promo_grant'`), the origin CHECK lists the eight origins (`… 'fee_run', 'corp_promo'`), `CHECK (op <> 'promo_grant' OR (un1t_user_id IS NOT NULL AND target IS NOT NULL))`, unique index `un1t_write_events_one_promo_grant ON (location_id, un1t_user_id, target) WHERE op = 'promo_grant' AND stage IN ('done','sent','unknown')`, `create table … corp_promo_claims`, `revoke all on public.corp_promo_claims from anon, authenticated, public`, a `DO $$` self-check.
- [ ] Write the migration. `corp_promo_claims`: `id uuid pk`, `location_id uuid not null → locations`, `contact_id uuid → contacts on delete set null`, `promo_key text not null`, `first_name`, `last_name`, `customer_email text not null`, `customer_phone`, `status text not null check in ('processing','granted','ineligible','help_requested','handled','failed')`, `reason text`, `un1t_user_id text`, `un1t_ledger_id uuid`, `credits integer`, `expires_at timestamptz`, `terms_accepted_at`, `terms_source`, `terms_version`, `attribution jsonb`, `lead_event_id text`, `handled_by uuid → profiles`, `handled_at`, `created_at`, `updated_at` (+ `update_updated_at` trigger); indexes on `(location_id, status, created_at desc)` and `(contact_id)`; partial unique `(location_id, contact_id, promo_key) WHERE status = 'granted'`.
- [ ] Run `npx vitest run tests/corp-promo-migration.test.js` → PASS. Commit.

### Task 2: The `promo_grant` write op and `grantPromoCredits`

**Files:** Modify `src/lib/un1t-online-write.js` (`UN1T_OP_POLICY` `promo_grant: 'never'`; ENDPOINTS `/credits/grant` ops `['trial_regrant','promo_grant']`), `src/lib/un1t-online-write-judge.js` (`UN1T_WRITE_OPS` + `promo_grant`, `REQUIRED_PERMISSIONS.promo_grant = ['credits:create','credits:read']`, judge case shares `trial_regrant`'s), `src/lib/un1t-online-write-ledger.js` (`ledgerKey.promo(loc, un1tUserId, promoKey)` → `promo_grant:<loc>:<user>:<promo>`; `beginAttempt` requires user + target for it), `src/lib/un1t-online-write-ops.js`; guard tests `tests/un1t-online-write-guard.test.js`, `tests/mia-no-charge-no-refund-guard.test.js`, `src/lib/un1t-online-write-judge.test.js`, `src/lib/un1t-online-write.transport.test.js`; new `src/lib/un1t-online-write.promo.test.js`.

**Produces:** `grantPromoCredits(db, { locationId, un1tUserId, contactId, promoKey, amount, expiresInDays, originRef }, deps?)` →
`{ outcome: 'granted', ledgerId, batchId, expiresAt }` | `{ outcome: 'ineligible', reason: 'holds_credits' }` | `{ outcome: 'needs_staff', reason, ledgerId? }` | `{ outcome: 'retry', code }`. Exported constant `UN1T_PROMO_ORIGIN = 'corp_promo'`.

- [ ] Tests (promo test file, fakes from `un1t-fakes.test-helpers.js` as `un1t-online-write.regrant.test.js` does): sends `{ userId, amount: 3, expiresInDays: 7 }` with idempotency-key `promo_grant:<loc>:<user>:hatch-3-free`, policy never; done → granted with `batchId`/`expiresAt` from the body; a prior done row → granted, nothing sent; a prior sent row < `UN1T_IN_FLIGHT_MS` → retry `attempt_in_flight`; prior unknown + credits show → granted and row settled done; prior unknown + none → needs_staff `un1t_promo_unverified`; credits show before sending → ineligible `holds_credits`, nothing sent; unknown answer (502) → never re-sent, credits read decides; refusal → needs_staff `un1t_promo_failed:<code>`; writes off → needs_staff `un1t_promo_failed:writes_off` (from `opRefusal`); amount/expiry not positive integers → TypeError.
- [ ] Judge/transport/ops-list tests updated for the tenth op; both guard tests allow `grantPromoCredits` as a second home and fence its callers to `src/lib/corp-promo-claim.js`.
- [ ] Implement, `npx vitest run src/lib/un1t-online-write* tests/un1t-online-write-guard.test.js tests/mia-no-charge-no-refund-guard.test.js` → PASS. Commit.

### Task 3: Promo registry and the `corp_promo` block

**Files:** Create `src/lib/corp-promos.js` (+ test); Modify `src/lib/landing-page-blocks.js` (`CORP_PROMO_DEFAULT`, registry entry), `src/components/LandingPageSettingsForm.jsx` (`CorpPromoEdit`), `src/components/landing-page/BlockRenderers.jsx` (`corp_promo` renders nothing on the landing page), `src/lib/consent-sources.js` (`corp_promo: VOLUNTARY`).

**Produces:** `CORP_PROMOS`, `resolveCorpPromo(key) → promo|null`, `liveCorpPromos() → promo[]`, `corpPromoCopyFromBlocks(blocks, promoKey) → { eyebrow, heading, subhead, ticks[], cta_label, consent_label, done_title, done_body, not_eligible_text, trial_used_text, help_text, unavailable_text, email_subject, email_body }` (block with matching `promo_key`, else the first `corp_promo` block, every blank on its default; tokens `{first_name}`, `{credits}`, `{expires_on}`, `{studio_name}`).

- [ ] Tests: unknown key → null; `hatch-3-free` has `credits 3`, `expiresInDays 7`; blank block fields fall back to defaults; a block for another promo key is not used when a matching one exists.
- [ ] Implement; editor shows each text field, mirroring `PaidTrialEdit`. Run tests → PASS. Commit.

### Task 4: Eligibility read

**Files:** Create `src/lib/corp-promo-eligibility.js` (+ test).

**Produces:** `corpPromoEligibility(db, { locationId, organizationId, contactId, email, phone, trialProductId }) → { ok: true, eligible: true } | { ok: true, eligible: false, reason: 'free_trial_used'|'trained' } | { ok: false }`.

- [ ] Tests: person contacts = `contactId` ∪ org contacts with the same email (`escapeLikePattern` ilike) ∪ org contacts with `wa_phone = waPhoneFromPhone(phone)`; un1t users = their Hatch `un1t_clients`. Cases: clean → eligible; ledger `trial` done by a phone-matched contact → `free_trial_used`; `promo_grant` unknown → `free_trial_used`; transaction for `trialProductId` → `free_trial_used`; `un1t_bookings` status `attended` → `trained`; only `cancelled` → eligible; a `un1t_subscriptions` row → `trained`; `contact_studios` ended at Hatch → `trained`; the same at Stillorgan → eligible; a paid-pack transaction alone → eligible; any read error → `{ ok: false }`; paginated reads (`.range`) past 1,000 rows.
- [ ] Implement with `selectAllByKeys`-style chunked reads (`.in`, `.order('id')`, `.range`). PASS. Commit.

### Task 5: Fulfilment

**Files:** Create `src/lib/corp-promo-claim.js` (+ test), `src/lib/corp-promo-emails.js` (+ test).

**Consumes:** Tasks 2-4, `ensureUn1tAccount`, `sendOpsAlert`.
**Produces:** `fulfilCorpPromoClaim(db, { claim, location, contact, promo, copy }) → { kind: 'granted', expiresAt } | { kind: 'ineligible', reason } | { kind: 'help_filed' } | { kind: 'unavailable' }`; `sendCorpPromoEmail(db, { claim, copy, studioName }) → { status }`.

- [ ] Tests: account `card` → claim `help_requested` + ops alert, `help_filed`; account `retry` / settings unreadable → claim `failed`, `unavailable`; eligibility re-run with the account's `executingContactId` (catches a linked account's history) → `ineligible`; grant `granted` → claim `granted` with `un1t_user_id`, `un1t_ledger_id`, `credits`, `expires_at`, email sent; grant `retry` → `failed`/`unavailable`; `needs_staff` → `help_requested` + alert; `holds_credits` → claim `ineligible` reason `holds_credits`; a failed claim stamp is logged with `logError`, never swallowed.
- [ ] Implement; email copy from the block with tokens, admin-consent / bounced checks as `sendTrialPurchaseEmail`. PASS. Commit.

### Task 6: Route

**Files:** Create `src/app/api/public/corp-claims/route.js` (+ test); Modify `scripts/check-route-guards.*` EXEMPT, `src/lib/openapi.js`.

- [ ] Tests: body `{ promo, first_name, last_name, email, phone, consent: true, terms_accepted, attribution?, lead_event_id?, visit? }`; unknown/off promo → 400 `not_available`; writes off → 400 `not_available`; rate limit `corpclaim:<promo>:<ip>` 8/15 min; no terms tick → 400 `terms_required` with the terms payload; lead captured exactly as `/trial` (contact, tag, lead source, consent `corp_promo`, deal, Meta Lead); an active Hatch member → 200 `active_member` before any claim row; ineligible → 200 `{ success:false, code:'free_trial_used'|'trained', error }`; granted → 200 `{ success:true, data:{ credits:3, expires_at } }`; help → 200 `help_filed`; unavailable → 503.
- [ ] Implement, reusing the trial route's helpers (`findOrCreateRaceContact`, `writeContactTag`, `applyFormMarketingConsent`, `placeWaitlistEntry`, `sendWebsiteConversion`, `hatchActiveMembership`, `un1tTermsPayload`, `readUn1tLegalDocs`). Run tests, `npm run check:route-guards`. Commit.

### Task 7: Page, allowlists, approvals tab

**Files:** Create `src/app/corp/page.js`, `src/app/corp/[promo]/page.js`, `src/components/landing-page/CorpPromoFunnel.jsx`, `src/lib/approvals/providers/corp-promo-claims.js` (+ test, registered in `registry.js`), `src/app/api/approvals/corp-promo-claims/[id]/route.js` (mark handled, owner/manager at the claim's studio, 404 elsewhere); Modify `src/proxy.js`, `src/components/AppShell.jsx`, `src/lib/brands.js`, `src/lib/tenant-domains-edge.js`, `src/public-compliance-paths.test.jsx`.

- [ ] Tests: `/corp` on all four allowlists; provider lists `help_requested` claims at the viewer's active location only; handled route 404s for another studio.
- [ ] Page: `/trial`'s layout (hero, frosted card, content blocks from Hatch's landing row), card from `corpPromoCopyFromBlocks`, `/corp` = the first live promo, `/corp/<key>` that one, none → not-available card; noindex; visit origin capture. Card states: form → granted (done title/body with credits and expiry date in Hatch's zone) / ineligible / help / try again.
- [ ] Commit.

### Task 8: Ship

- [ ] CLAUDE.md invariant on `/credits/grant` names `grantPromoCredits` + its one caller; changelog entry file.
- [ ] Full CI mirror (13 commands) and `npm run build` → green.
- [ ] Push, open PR, add `docs/changelog/entries/<PR>.md`.
- [ ] Hand-off: apply mig 787 before merge (Supabase MCP, project `iyvtbjjxdggiadzwwvdj`, then `get_advisors`); confirm the Hatch token holds `credits:create`.
