# Per-funnel trial product ("credits") override — `class_funnel` block

**Date:** 2026-07-22
**Status:** Design approved (brainstorming), pending spec review
**Branch / worktree:** `class-funnel-trial-product` @ `~/code/un1t-crm-trial` (off `origin/main`, which has #1050 + #1051)

## Problem

The Glofox Class Booking Funnel block grants a **single fixed trial membership per
location** to a newly-created member on booking — read from
`locations.settings.glofox.trial_membership_id` / `trial_plan_code` and purchased
via `purchaseGlofoxMembership(...)` inside `findOrCreateGlofoxMember({ attachTrial: true })`.

Operators want a funnel (block) to grant a **different trial product** than the
location default — e.g. a "1 free class" intro on one campaign page and "3 free
classes" on another. In Glofox there is no "set N credits" API: "N free classes"
is a `num_classes` **membership product**. So "customise the credits" =
**"let this funnel block pick which trial membership/plan it grants."**

## Goals

- The `class_funnel` block gets an optional **trial-product picker**. Empty →
  today's per-location default (zero behaviour change). Set → that block's funnel
  grants the chosen Glofox membership + plan instead.
- The chosen product is **captured at booking time** onto the queued booking, so
  a later block edit can't change what an already-submitted lead receives.
- Operator picks from the location's real Glofox membership catalogue in the
  editor (no free-typing of IDs unless the catalogue can't load).

## Non-goals (explicitly out of scope — user-confirmed)

- **No** change to the existing-member-with-no-credit path: it still routes to
  staff review (`routeToReview('needs_credit_grant')`). The override only affects
  which product a **newly created** member is granted — the sole place a trial is
  auto-purchased today (`class-booking-processor.js:104`, `createIfMissing:true`,
  `attachTrial:true`).
- **No** arbitrary integer "credits" — not representable in Glofox; it's product
  selection.
- **No** other funnel-flow changes (no payment step, no redirect, nothing else).
- **No** auto-grant to existing no-credit members.

## Architecture — four seams, all existing patterns

### 1. Block config (`src/lib/landing-page-blocks.js`)
Add two fields to `CLASS_FUNNEL_DEFAULT`, defaulting to empty:
```js
  trial_membership_id: '', // '' ⇒ use the location's default trial product
  trial_plan_code:     '',
```
No Zod change (BlockBaseSchema is passthrough; enum already includes
`class_funnel`). Empty strings mean "no override".

### 2. Editor (`src/components/LandingPageSettingsForm.jsx`)
Reuse the **existing** trial-picker machinery rather than a new server-side load:
- `GET /api/locations/[id]/glofox-memberships` (auth-guarded, returns
  `{ memberships }`) already exists and powers the Settings → Glofox trial picker.
- `buildTrialOptions(memberships, trialKey)` (`src/lib/glofox-trial-options.js`,
  exported + unit-tested) already turns the catalogue into
  `[{ value: '<membershipId>:<planCode>', label }]` options and keeps a stale
  saved value visible.
- **Plumb `locationId`:** `BlockEditPanel` is not currently passed `locationId`.
  Add it at the call site (the `BlockCard`), thread it through `BlockCard`'s
  props, and pass to `BlockEditPanel` → `ClassFunnelEdit`. `locationId` is
  already a top-level prop of `LandingPageSettingsForm`.
- **`ClassFunnelEdit`:** add a "Trial product granted on booking" field that
  **lazily** fetches `/api/locations/${locationId}/glofox-memberships` on mount
  (client-side, only when a `class_funnel` block is actually being edited — so no
  Glofox call on every settings render), mirroring the fetch in
  `GlofoxIntegrationTab.jsx`. Build the dropdown with `buildTrialOptions`; the
  current value is `` `${block.trial_membership_id}:${block.trial_plan_code}` ``
  when both set, else `''`. First option: `— Use location default —` (value `''`).
  On change: `const [mid, pc] = value ? value.split(':') : ['', '']` →
  `onUpdate({ trial_membership_id: mid || '', trial_plan_code: pc || '' })`.
  While loading or if the fetch fails/returns empty, fall back to a free-text
  `"<membershipId>:<planCode>"` input (same graceful degradation `BookingEdit`
  uses) so the field is never a dead end.
- **`summaryFor`:** append trial info to the class_funnel summary when set — e.g.
  `` `${base} · trial: ${block.trial_membership_id}` ``.

### 3. Capture at booking time
- **Helper** (`src/lib/public-landing.js`): extend `classFunnelConfigFromBlocks`
  to also return the trial override from the same resolved `class_funnel` block:
  ```js
  const trialMembershipId = override(cf?.trial_membership_id)  // null when unset
  const trialPlanCode     = override(cf?.trial_plan_code)
  ```
  Return them alongside `{ tag, leadSource, eventSourceUrl }`. Both must be
  present to count as an override; if only one is set, treat as no override
  (return both null) — guard against a half-configured block.
- **Route** (`src/app/api/public/class-booking/route.js`): it already calls
  `classFunnelConfigFromBlocks(page.blocks, landingPath)`. Persist the two values
  on the `class_booking_requests` insert (new columns below). No new DB read.
- **Migration** (forward-only, Supabase MCP against un1t-crm
  `iyvtbjjxdggiadzwwvdj`): add nullable `trial_membership_id text` and
  `trial_plan_code text` to `class_booking_requests`. Additive; run `get_advisors`
  (security) after. Apply the migration BEFORE the code that reads/writes them
  deploys.

### 4. Fulfillment (`src/lib/glofox-push.js` + `src/lib/class-booking-processor.js`)
- **`findOrCreateGlofoxMember`** gains one optional param
  `trialOverride = null` (shape `{ membershipId, planCode }`). In the `attachTrial`
  block (glofox-push.js ~203-219): if `trialOverride?.membershipId &&
  trialOverride?.planCode`, use it; else fall back to
  `getLocationTrialConfig(location)` exactly as today. Everything else unchanged
  (still records `trialPurchaseError` on failure; still fire-and-forget).
- **Processor** (`class-booking-processor.js:104`): pass
  `trialOverride: request.trial_membership_id && request.trial_plan_code ? {
  membershipId: request.trial_membership_id, planCode: request.trial_plan_code } :
  null` into the `createIfMissing:true` call. (`request` is the
  `class_booking_requests` row — ensure the row `select` includes the two new
  columns.)

## Data flow

```
Editor: pick trial product → block.trial_membership_id + trial_plan_code
   (public page render is unaffected — client never sees/sends these)
Booking POST /api/public/class-booking
   → classFunnelConfigFromBlocks(page.blocks, path) → {..., trialMembershipId, trialPlanCode}
   → INSERT class_booking_requests { …, trial_membership_id, trial_plan_code }
Async worker/cron → processClassBookingRequest(request)
   → findOrCreateGlofoxMember({ …, attachTrial:true, trialOverride })
       → purchaseGlofoxMembership(creds, newGlofoxId,
            trialOverride?.membershipId ?? locationDefault.membershipId,
            trialOverride?.planCode     ?? locationDefault.planCode)
```

## Backwards compatibility
- Block with no trial fields set → helper returns nulls → row columns null →
  processor passes `trialOverride:null` → `getLocationTrialConfig` used → identical
  to today. Existing `/start` (the Stillorgan funnel) is unchanged.
- Existing queued `class_booking_requests` rows (pre-migration) read null → default
  path. No backfill needed.

## Security / invariants
- Trial IDs are operator config stored server-side on the block; the client never
  sends them (consistent with tag/lead_source/CAPI in #1051). No new client input.
- The editor catalogue is scoped to the selected location's Glofox branch creds,
  so an operator only sees their own products.
- Migration additive + forward-only; `get_advisors` after DDL. Deploy order:
  migration first.
- No new `/api` route; existing route stays guarded/rate-limited as-is.

## Testing
- **Unit** (`src/lib/public-landing.test.js`): `classFunnelConfigFromBlocks`
  returns `{ trialMembershipId, trialPlanCode }` = the block values when both set;
  null when unset; null when only one set (half-configured guard); unchanged
  `tag/leadSource/eventSourceUrl` behaviour preserved.
- **Unit** (glofox-push): with `trialOverride` set, `purchaseGlofoxMembership` is
  called with the override pair; without it, with the location default. (Mock
  `purchaseGlofoxMembership`; assert args.)
- **Manual (Stillorgan):** set a distinct trial product on a funnel block, book as
  a brand-new lead, confirm that product is purchased in Glofox; then a block with
  no override still grants the location default.
- CI mirror (all six) + `npm run build` (migration is applied via MCP, not in the
  build).

## Rollout
1. Apply migration (MCP) to un1t-crm.
2. Merge code (additive; no feature flag). Vercel auto-deploys.
3. Manual Stillorgan smoke on the deployed build.

## Open questions
None. (Override = trial product only; existing-no-credit path unchanged; no other
flow changes — all user-confirmed.)
