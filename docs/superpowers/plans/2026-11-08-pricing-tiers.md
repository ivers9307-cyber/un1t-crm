# Pricing tiers, early bird and group price (TIERS.1) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An event can price "the first 20 at €25, then €35", "€30 until 1 Dec" and "3+ people €28 each", with the public page, the charge, the receipt and the host's revenue all agreeing.

**Architecture:** Tiers are an ordered jsonb array on `race_events.pricing_tiers`; the registration stamps the tier it bought (`race_registrations.pricing_tier_id`). One pure resolver picks the tier for a booking (open window, room left, group size); one `applyTierPricing` helper swaps the event's non-member fee for the tier price before the existing `computeTeamPricing`, so the charge, the per-head breakdown on `race_payments`, receipts and host revenue change nothing downstream. The public API exposes the current and next tier with no counts; both forms share a `PricingTiersEditor`. The legacy `/api/public/races/[slug]/register` file is deleted so the rewrite to the events route takes over (one booking door).

**Tech Stack:** Next.js 16 App Router, supabase-js (service role), Zod, Vitest (+ jsdom), PGlite for the migration test.

**Spec:** `docs/superpowers/specs/2026-11-08-host-event-features-design.md` § 2 and Builder-check decisions 1, 3, 4.

## Global Constraints

- Branch `host-pricing-tiers` in `/Users/richardivers/code/un1t-crm-hostseries`, stacked on `host-events-series` (PR #2322). Migration `818_pricing_tiers.sql` (main's highest is 816; 817 is PR 1's; re-check before applying).
- Apply the migration with the Supabase MCP on `iyvtbjjxdggiadzwwvdj` before the PR merges; `get_advisors` after.
- Tier counts are **operator-only**: nothing public carries `spots_left`, `sold` or a capacity (decision 1). Tiers count **people**, whatever the event's `capacity_mode`; only entries with a `pricing_tier_id` consume tier seats (decision 4). One tier per entry.
- Every booking door prices the same way: the public register route and `race-register-solo.js` both call `applyTierPricing` (decision 3). The legacy races register route is deleted.
- Tiers replace the **non-member** fee only; member pricing is untouched.
- Money stays in cents; copy with euros uses the existing `fmtMoney`/`EUR` helpers.
- Every supabase write destructures `error`; `logError`/`logWarn` from `@/lib/log`; `.select()` column names must exist in migrations (`check:select-columns`).
- Commit messages `TIERS.1 — <what>`, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. **The last early-bird seat with a 4-person team**: the team does not fit the tier's remaining room → the next tier applies to the WHOLE entry, never a split (Task 2 test "a group that does not fit moves whole to the next tier").
2. **A tier whose window closed one second ago** must not price the booking (Task 2 test "a closed window is skipped"); the widget copy says "then €35" when the current tier has an end.
3. **A free event with tiers** (base null, tier €25): the tier price applies while it is open; after it, base null = free (Task 2 test "base null stays free after the tiers").
4. **A tier change on a published host event** re-reviews it (Task 6 test), because it is a price change.
5. **Mia's solo booking quotes the tier price**, not the base (Task 3 test on `registerSoloEventEntry` → `requires_payment` with the tier total).

---

### Task 1: Migration 818

**Files:** Create `supabase/migrations/818_pricing_tiers.sql`, `tests/migration-818-pricing-tiers.test.js` (PGlite, like 817's).

**Produces:** `race_events.pricing_tiers jsonb null` (comment: TIERS.1, Zod-validated array, null = none), `race_registrations.pricing_tier_id text null` (comment: the tier id the entry bought; only such entries consume tier seats), index `race_registrations_tier_idx on race_registrations (race_event_id, pricing_tier_id) where pricing_tier_id is not null`.

- [ ] Test: both columns exist with the right types; the index exists; re-applies cleanly. Run → FAIL (file missing). Write the migration. Run → PASS. `check:select-columns` still green. Commit `TIERS.1 — mig 818: pricing_tiers + pricing_tier_id`.

### Task 2: Tier lib

**Files:** Create `src/lib/pricing-tiers.js`, `src/lib/pricing-tiers.test.js`.

**Produces:**
- `PricingTierSchema = z.object({ id: z.string().min(1).max(40), name: z.string().trim().min(1).max(60), price_cents: z.number().int().min(0).max(1_000_000), capacity: z.number().int().min(1).max(100000).nullable().optional(), starts_at: z.string().datetime().nullable().optional(), ends_at: z.string().datetime().nullable().optional(), min_people: z.number().int().min(2).max(50).nullable().optional() }).strict()`; `PricingTiersSchema = z.array(PricingTierSchema).max(8).superRefine(unique ids; ends_at after starts_at when both)`.
- `resolvePricingTiers(race) → Tier[]` (null/invalid → []).
- `tierIsOpen(tier, nowMs)` pure.
- `resolveTier({ tiers, nowMs, headcount, soldByTier }) → Tier|null`: first tier in order that is open, has room (`capacity == null || sold + headcount <= capacity`) and fits (`min_people == null || headcount >= min_people`).
- `loadSoldByTier(db, { eventId, race, nowMs }) → { ok: true, soldByTier: Record<string, number> } | { ok: false, error }`: `race_registrations` where `race_event_id = eventId`, `pricing_tier_id` not null, `status in LIVE_REGISTRATION_STATUSES`, selecting `id, status, registered_at, pricing_tier_id, team:teams ( size )`, paged 1000 by id (`.range`, `.order('id')`), filtered by `holdingPlaces(rows, nowMs, race)`, summing `team.size || 1` per tier.
- `applyTierPricing(db, { race, headcount, nowMs = Date.now() }) → { ok: true, race, tier: Tier|null } | { ok: false, error: 'load_failed' }`: no tiers → `{ race, tier: null }` with no read; else `loadSoldByTier` → `resolveTier` → `race = { ...race, non_member_fee_cents: tier.price_cents }` when a tier applies. A failed read is `load_failed` (the caller answers 503: never price blind).
- `publicPricing({ race, nowMs, soldByTier })`: `{ base_cents, current: { id, name, price_cents, ends_at, limited: boolean } | null, next: { name, price_cents, starts_at } | null, group: { min_people, price_cents } | null }` — `current` is the tier for headcount 1 that applies now; `limited` = it has a capacity (never the count); `next` = the first tier after `current` in order that is not a group tier, else null; `group` = the first open tier with `min_people` that has room for `min_people`.
- `tierPriceLabel(pricing)` → `"Early bird €25 (limited), then €35"` / `"€30 until Mon 1 Dec"` / `"€35 per person"` / `"Free"`; and `groupPriceLabel(pricing)` → `"3+ people: €28 each"` or ''.

- [ ] Tests (write first, run → FAIL): schema accepts a valid list, rejects duplicate ids / 9 tiers / ends before starts; `resolveTier`: capacity tier then standard; "a group that does not fit moves whole to the next tier" (capacity 20, sold 18, headcount 4 → next); "a closed window is skipped"; group tier needs `min_people`; nothing applies → null; "base null stays free after the tiers" via `applyTierPricing` with no tier applying; `loadSoldByTier` sums team sizes only for rows holding a place, pages with `.range`, `load_failed` on error; `applyTierPricing` with no tiers makes no read; `publicPricing` never carries counts (`JSON.stringify` has no `sold`/`spots`); labels. Implement. Run → PASS. Commit `TIERS.1 — pricing-tiers lib`.

### Task 3: Booking doors price the tier

**Files:** Modify `src/app/api/public/events/[slug]/register/route.js` (select `pricing_tiers`; after the roster is built and BEFORE `computeTeamPricing`: `const priced = await applyTierPricing(db, { race, headcount: validatedRoster.length })`; `load_failed` → 503 `{ error: 'pricing_unavailable' }` (discard a find-team solo team as the other refusals do); `computeTeamPricing({ validatedRoster, race: priced.race })`; insert `pricing_tier_id: priced.tier?.id ?? null`; response `pricing.tier: priced.tier ? { id, name } : null`), `src/lib/race-register-solo.js` (same, before its `computeTeamPricing`; `load_failed` → `{ ok: false, reason: 'pricing_unavailable' }`; stamp `pricing_tier_id` on its insert), `src/lib/agent/event-tools.js` (`formatEventPrice` gains an optional `pricing` arg: when `pricing?.current` exists, prefix `"${current.name} ${euro(current.price_cents)}${next ? `, then ${euro(next.price_cents)}` : ''}"`; the two listing sites pass `publicPricing({ race, nowMs, soldByTier })` only if cheap — ruling allowed: skip the sold read there and pass `soldByTier: {}` with a comment that Mia's label may show an early bird that just sold out; the booking itself re-resolves).
- Delete `src/app/api/public/races/[slug]/register/route.js`; remove its `openapi.js` entry; update `src/app/api/public/rate-limit-tenant-keys.test.js` (its `raceRegisterPOST` import → the events route), `src/lib/customer-link-paths.test.js` (drop the file from both lists), `src/public-compliance-paths.test.jsx` and `tests/un1t-literal-sweep.test.js` (check what they name; drop the path), the comment in `host-list/[slug]/subscribe/route.js`.
- Tests: register route test (find the existing one under `src/app/api/public/events/[slug]/register/`; add "stamps the tier and charges its price" and "503 when the tier read fails, nothing inserted"); `race-register-solo` test "quotes the tier total for requires_payment"; `event-tools` label test. Run all touched + `check:route-guards` + `check:rpc-names`. Commit `TIERS.1 — every booking door prices the tier; the legacy races register route is gone`.

### Task 4: Public API and widget

**Files:** Modify `src/app/api/public/events/[slug]/route.js` (select `pricing_tiers`; strip it from `racePublic`; add `pricing: publicPricing({ race: data, nowMs, soldByTier })` where `soldByTier` comes from `loadSoldByTier` only when the event has tiers; a failed read → `pricing` with `current: null` + `logWarn`, never a failed page), `src/components/RaceSignupWidget.jsx` (price row: `tierPriceLabel(race.pricing)` when `race.pricing?.current || race.pricing?.next`, else today's copy; a second row for `groupPriceLabel`; the live total uses `effectiveNonMemberFee(race.pricing, headcount)` exported from the lib: group tier price when `headcount >= group.min_people`, else `current.price_cents`, else base), `src/lib/public-events.js` `eventPriceLabel(e)` → "From €25" when `e.pricing_tiers` has a cheaper open tier (pure, uses `tierIsOpen` with `Date.now()`), `src/lib/registration-move.js` targets gain `has_tiers: boolean` and `MoveEntryDialog` shows "Tier pricing is not reflected in this difference." when the source or target has tiers.
- Tests: public route test asserts `pricing` present, no `pricing_tiers`, no counts; widget test (jsdom, existing file pattern) renders the tier label and the group label; `eventPriceLabel`; move-targets `has_tiers`. Commit `TIERS.1 — public pricing block, widget copy, browse labels`.

### Task 5: Shared editor and the two forms

**Files:** Create `src/components/PricingTiersEditor.jsx` (+ `.test.jsx`): props `{ value: Tier[], onChange, dark }`; rows: name, price (€), limit (people), from (datetime-local), until, min people; add (≤8) / remove / move up-down; ids minted `tier-<random>` client-side; emits cents and ISO strings. Modify `src/components/host/HostEventForm.jsx` (Tickets section: "Standard price" + the editor; body `pricing_tiers`), `src/components/RaceEventForm.jsx` (beside the non-member fee; payload `pricing_tiers`), `src/lib/host-events.js` (`HostEventSchema.pricing_tiers: PricingTiersSchema.nullable().optional()`; `computeEditTransition` re-reviews when `JSON.stringify(current.pricing_tiers ?? null) !== JSON.stringify(changes.pricing_tiers ?? null)` and the key is present), `src/lib/event-save-schemas.js` (both field sets), `src/app/api/host/events/route.js` + `[id]/route.js` (write/read `pricing_tiers`; GET returns it), `src/app/api/events/route.js` + `[id]/route.js` (write; the `[id]` select lists it), the host edit page `initial.pricing_tiers`.
- Tests: editor emits the shape; host form posts `pricing_tiers`; `computeEditTransition` re-reviews on a tier change and not on an identical list; host route round-trips. Commit `TIERS.1 — tier editor on the host and staff forms`.

### Task 6: Gates, migration, review, PR

- [ ] Touched suites green; thirteen-command mirror; `npm run build`. Apply 818 (`apply_migration`, project confirmed by `list_projects`), `get_advisors`. Whole-branch review (fresh reviewer, most capable model) → fix pass → push, `gh pr create --base host-events-series` is NOT right for the repo's merge rule (CI needs main as base): open the PR against `main` and say in the body it is stacked on #2322 and must merge after it; `docs/changelog/entries/<PR>.md`.
