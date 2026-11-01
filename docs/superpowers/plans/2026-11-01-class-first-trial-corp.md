# CLASSFIRST.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** /trial and /corp render the /50plus one_class layout and ask for the class before the details; the chosen class is stored and booked once the credits land.

**Architecture:** One presentation resolver (`class-first-funnel.js`) reads any of the three offer blocks for the hero, strip and step words; one client step (`ClassPickStep`) lifted out of CampaignFunnel is the date-tile picker for all three cards; the two public POSTs validate and store the class; one helper (`class-first-booking.js`) queues a funded `class_booking_requests` row after each grant and the two processors treat a funded row's empty balance as a staff card.

**Tech Stack:** Next.js 16 App Router, React client components, Supabase (service role), vitest + @testing-library/react, Zod.

**Spec:** `docs/superpowers/specs/2026-11-01-class-first-trial-corp-design.md`

## Global Constraints

- Migration 799 is applied to the un1t-crm project (`iyvtbjjxdggiadzwwvdj`) before the code deploys; `get_advisors` after.
- Public routes stay service-role, rate-limited, studio from `resolvePublicPageRequest`; PUBLIC_CLASS_KEYS only.
- The chosen `event_id` is validated against `readPublicClasses(db, locationId, 14, { blocks })`, the picker's own read.
- No new caller of `grantTrial`, `grantPromoCredits`, `book` or any `/credits/grant` op.
- The queue insert after a grant is best-effort (`logError`, structured ids), never undoing the grant.
- Customer copy: operator-editable with defaults, no em-dashes; every `<button>` in a form typed; text on the pale card is black alpha or the -700 ramp.
- `check:select-columns` / `check:rpc-names` / `check:guardrails` must stay green; new columns exist in mig 799.

## Review Focus

1. A buyer who paid while the class filled: the processor's booking refusal files a card (`booking_failed:<code>` / `un1t_booking_failed:<code>`), never a silent close. Pinned in Task 7 (processor guard tests keep the existing refusal path for a funded row).
2. A resume from a checkout (`?purchase=`) must never show the picker or lose the class: the class lives on the row, the card goes straight to `confirming`. Pinned in Task 4.
3. The timetable read fails during the POST: 503 `timetable_unavailable`, details kept, nothing inserted. Pinned in Task 5.
4. A forged `event_id` for a hidden or other-studio class: 400 `class_unavailable`, nothing inserted. Pinned in Task 5.
5. A studio page's hero card (/stillorgan) is PaidTrialFunnel with one studio: it must open on the picker with `page=stillorgan&studio=stillorgan` and the classes route must list a studio page's timetable (offer_type paid_trial). Pinned in Tasks 4 and 5.

---

### Task 1: Migration 799

**Files:**
- Create: `supabase/migrations/799_class_first_trial_corp.sql`

- [ ] Write the migration: `trial_purchases` + `corp_promo_claims` ADD `class_event_id text, class_name text, class_starts_at timestamptz`; `class_booking_requests` ADD `funded_by text CHECK (funded_by IN ('trial_purchase','corp_promo'))`, `funded_by_id uuid`; `COMMENT`s naming CLASSFIRST.1. All three tables are service-role only: no grants.
- [ ] Apply via Supabase MCP `apply_migration` on `iyvtbjjxdggiadzwwvdj`; run `get_advisors` (security).
- [ ] Commit.

### Task 2: `src/lib/class-first-funnel.js`

**Files:**
- Create: `src/lib/class-first-funnel.js`, `src/lib/class-first-funnel.test.js`
- Modify: `src/lib/landing-page-blocks.js` (PAID_TRIAL_DEFAULT, CORP_PROMO_DEFAULT gain the new keys), `src/lib/corp-promos.js` (CORP_PROMO_COPY_DEFAULT gains the step keys), `src/lib/trial-studio-view.js` (CLIENT_BLOCK_FIELDS gains them)

**Produces:**
- `CLASS_FIRST_STEP_KEYS` (frozen list): `pick_title, pick_body, details_title, details_body, no_classes_text, timetable_unavailable_text, skip_class_label, done_class_body`
- `CLASS_FIRST_HERO_KEYS`: `video_url, poster_url, video_focus, sound_default, sound_label`
- `CLASS_FIRST_EXPECT_KEYS`: `expect_eyebrow, expect_heading, expect_cards`
- `PAID_TRIAL_CLASS_FIRST_DEFAULTS`, `CORP_PROMO_CLASS_FIRST_DEFAULTS` (step words + expect strip, spec §7)
- `classFirstStepCopy(block, type)` → every step key resolved (block value else the type's default)
- `oneClassPresentation(block, { heroImageUrl = null } = {})` → `{ hero: { videoUrl, posterUrl, soundLabel, videoFocus, soundDefault, eyebrow, heading, subhead }, expect: { eyebrow, heading, cards } }` for `campaign_funnel` (via `campaignFunnelCopy`), `paid_trial`, `corp_promo`; poster falls back to `heroImageUrl` when the block has neither video nor poster; unknown focus/sound values read as the defaults.
- `classLine(template, cls, { zone })` → the done-screen line with `{class}`, `{day}`, `{time}` filled from a public class (`name`, `day_label`, `time`); `''` when no class.

- [ ] Write tests: defaults resolve; a blank block value falls back; `oneClassPresentation` for each type (poster fallback, campaign parity with `campaignFunnelCopy`); `classLine` tokens and the empty case.
- [ ] Run, see them fail. Implement. Run, pass. Commit.

### Task 3: `ClassPickStep` out of CampaignFunnel

**Files:**
- Create: `src/components/landing-page/ClassPickStep.jsx`, `ClassPickStep.test.jsx`
- Modify: `src/components/landing-page/CampaignFunnel.jsx` (renders `ClassPickStep` for its pick step; `Tile`, `cadenceGroups`, `ctaLabelFor`, `campaignFunnelClassesUrl`, `campaignFunnelTarget` move to the new file and are re-exported from CampaignFunnel for its tests and EditOfferLayout)

**Produces:** `ClassPickStep({ page, publicPath, campaign, copy, chosen, onPick, onContinue, onLoaded, onSkip = null, showClassName = false, stepLabel = 'Step 1 of 2', ctaLabel, reloadKey = 0, preview = false })`: fetches on mount (and when `reloadKey` changes) via `campaignFunnelClassesUrl`, calls `onLoaded({ classes, configured, unavailable })` (CampaignFunnel fires its funnel events from it and preselects the first slot), renders the tiles, the four empty states (`copy.not_configured_text`, `copy.timetable_unavailable_text`, `copy.no_classes_text`, loading), "More dates (n)", the CTA (`type="button"`, disabled until `chosen`), and when `onSkip` is given and the list is empty or unavailable, a typed button `copy.skip_class_label`. `Tile` takes `showName`.

- [ ] Write ClassPickStep tests: tiles from the list, the name shown when asked, the skip button only on empty/unavailable and only with `onSkip`, the CTA disabled until a pick.
- [ ] Refactor CampaignFunnel onto it. Run `CampaignFunnel.test.jsx` unchanged: PASS. Commit.

### Task 4: Class-first cards

**Files:**
- Modify: `src/components/landing-page/trial-card.js` (the /50plus recipe), `PaidTrialFunnel.jsx`, `CorpPromoFunnel.jsx`, `TrialStudioPicker.jsx` (tile look), `PaidTrialFunnel.test.jsx`, `CorpPromoFunnel.test.jsx`

**Interfaces:** PaidTrialFunnel keeps its props; CorpPromoFunnel keeps its props. Both POST bodies gain `event_id` when a class was chosen. Step words from `classFirstStepCopy(studio.block, 'paid_trial')` / `classFirstStepCopy(copy, 'corp_promo')`.

- [ ] PaidTrialFunnel: steps `choose → pick → form → …`; a preselected single studio opens on `pick`; a resume opens on `confirming`; `cancelled` opens on `pick` with the studio kept; the form shows the "You're booking" summary with Change → `pick` (a skipped class shows no summary); POST carries `event_id` when chosen; `class_unavailable` returns to `pick` with details kept and `reloadKey + 1`; the done screen shows `classLine(block.done_class_body, chosen)` when granted/paid; `preview` renders the picker disabled (no fetch, no tracking).
- [ ] CorpPromoFunnel: `pick → form → result`; same summary, same `event_id`, same class line on `granted`.
- [ ] Update tests: the fetch mock answers `/api/public/classes` with two classes; every existing flow picks the first tile before filling details; new cases: skip on an empty list posts no `event_id`; `class_unavailable` goes back to the picker with the fields kept; the class line on done; the single-studio card asks `/api/public/classes?page=stillorgan&studio=stillorgan` when `page="stillorgan"`.
- [ ] Run both test files: PASS. Commit.

### Task 5: Routes

**Files:**
- Modify: `src/app/api/public/classes/route.js` (+ `route.campaign.test.js`), `src/app/api/public/trial-purchases/route.js` (+ `route.test.js`), `src/app/api/public/corp-claims/route.js` (+ `route.test.js`)
- Create: `src/lib/class-first-choice.js` + test: `resolveChosenClass(db, { locationId, blocks, eventId })` → `{ ok: true, chosen: { event_id, name, starts_at } | null }` (null when no eventId) | `{ ok: false, code: 'timetable_unavailable' | 'class_unavailable' }`; `classColumnsFor(chosen)` → `{ class_event_id, class_name, class_starts_at }` or `{}`.

- [ ] classes route: `paid_trial` / `promo_credits` → `readPublicClasses(db, r.locationId, 14, { blocks: r.blocks })` + terms → `{ classes, terms, campaign: { configured: true, timetable_unavailable: Boolean(read.error) } }`. Test: a paid_trial page lists the studio's classes; a none page still lists nothing.
- [ ] trial-purchases POST: schema `event_id: z.string().trim().min(1).max(64).optional()`; after `locationId` is known and before eligibility: `resolveChosenClass` → 503 / 400 as the spec; the insert spreads `classColumnsFor(chosen)`. Tests: stored columns; `class_unavailable` inserts nothing; `timetable_unavailable` inserts nothing; no `event_id` behaves as today.
- [ ] corp-claims POST: the same, before the lead capture. Tests likewise (the claim insert carries the columns; `fulfilCorpPromoClaim` receives the claim with them).
- [ ] Run the four test files: PASS. Commit.

### Task 6: `class-first-booking.js` and the three grant hooks

**Files:**
- Create: `src/lib/class-first-booking.js`, `src/lib/class-first-booking.test.js`
- Modify: `src/lib/trial-purchase-processor.js` (after the granted stamp, both branches), `src/lib/trial-purchase-un1t-settle.js` (`settleRow`, after the CAS matched), `src/lib/corp-promo-claim.js` (after the granted stamp), and their tests

**Produces:** `queueFundedClassBooking(db, { fundedBy, fundedById, locationId, contactId, pageId = null, eventId, className, startsAt, customer: { name, email, phone }, terms = {} })` → `{ queued: true, id } | { queued: false, reason }`; a 23505 is `{ queued: true, deduped: true }`. `fundedBookingFromRow(row, { fundedBy })` builds the args from a `trial_purchases` or `corp_promo_claims` row (null when `class_event_id` is empty).

- [ ] Tests: insert shape (status queued, no trial pair, funded_by, terms copied), QStash nudge with dedup `class-booking-<id>`, 23505 dedupe, an insert error → `{ queued: false }` + `logError`, no class → not called.
- [ ] Hooks: each calls `fundedBookingFromRow` and, when non-null, `queueFundedClassBooking` inside its own try/catch, after the grant stamp, before the emails. Processor/settle/claim tests: one insert into `class_booking_requests` when the row carries a class; none otherwise; a failing insert leaves the outcome `granted`.
- [ ] Run: PASS. Commit.

### Task 7: Processor guards and the card copy

**Files:**
- Modify: `src/lib/class-booking-processor.js`, `src/lib/un1t-online-booking-processor.js`, `src/lib/approvals/agent-request-why.js`, their tests

- [ ] Glofox: `const funded = Boolean(request.funded_by)`; in the `!attended && !grantedTrial` branch an empty balance with `funded` → `toReview('funded_no_balance')` (before the paid-trial reply and `needs_credit_grant`); in the mint gate `funded` → `toReview('funded_no_balance')` before `readPaidTrialReply`. Test: a funded row, member with 0 credits → card `funded_no_balance`, `readPaidTrialReply` not called; a funded row with credits books.
- [ ] un1t.online: `runFunnel` passes `trialMode: request.funded_by ? 'funded' : 'normal'` and `paidTrialText: request.funded_by ? null : paidTrialText`; `un1tBookOnce` with `trialMode === 'funded'` and no credits/membership → `{ kind: 'card', reason: 'funded_no_balance' }`, `grantTrial` never called. Test both.
- [ ] `agent-request-why.js` `MACHINE_REASONS.funded_no_balance`: "They paid for a trial or claimed a promo, but no credits showed on the account when the class was booked. Check the account, add the credits if missing, then approve to book."
- [ ] Run: PASS. Commit.

### Task 8: Layout, page route, editor

**Files:**
- Modify: `src/lib/landing-page-render.js` (+ test), `src/app/(public)/[slug]/[[...rest]]/page.js` (`offerElementFor` paid_trial / promo_credits return `kind 'one_class'`, `hero`, `expect` from `oneClassPresentation(mergedOffer, { heroImageUrl })`), `src/components/landing-page/EditOfferLayout.jsx` (OneClassRegion uses `oneClassPresentation` for any pinned type; the card clone only for campaign_funnel; the expect edit keys are the same for all three), `src/components/LandingPageSettingsForm.jsx` (extract `HeroMediaFields` and `ExpectCardsFields` from CampaignFunnelEdit; PaidTrialEdit and CorpPromoEdit render them plus the step words), `src/components/landing-page/EditModeOverlay.offer.test.jsx` (a paid_trial one_class region edits the hero in place)

- [ ] `layoutFor` test: paid_trial → 'one_class', promo_credits → 'one_class', class_funnel → 'frosted'.
- [ ] Page route + editor changes; run the overlay/offer tests and `src/components/landing-pages/*.test.jsx`.
- [ ] Commit.

### Task 9: Verification

- [ ] CI mirror (all thirteen), `npm run build`.
- [ ] Browser: `/trial`, `/corp`, `/50plus`, `/stillorgan` on desktop and phone widths; the picker, the summary, a `class_unavailable` round trip against the dev server.
- [ ] Changelog entry after `gh pr create`.
