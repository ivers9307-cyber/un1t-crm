# Spec — `/start` straight-to-class (drop the consult/class choice)

**Date:** 2026-07-10 · **Status:** Approved (design) · **Repo:** un1t-crm · **Location:** Stillorgan only

## Goal

Cut friction from the paid-traffic booking funnel. Today `/start` opens by asking the
lead to choose **"book a free class"** vs **"start with a free consultation"** before it
captures anything. That choice is a barrier to entry — and slightly incoherent, since
the ad they clicked promises *"3 free classes."* Send everyone **straight to a class**:
capture details → pick a class time → confirmed. Offer the consultation **after** the
class is booked, as a skippable one-tap upsell (we already hold their details).

Same simplification applies to the **WhatsApp in-chat Flow** (`book_first_visit`), which
mirrors the same PATH (class/consult) screen — done as a **fast-follow after `/start`**.

This supersedes the choice step from [2026-06-29-start-booking-wizard-design.md](2026-06-29-start-booking-wizard-design.md).
Nothing about how a class or a consult is *booked* changes — only the path into it.

## Non-goals

- No backend/API changes. The class path (`POST /api/public/class-booking` → drain cron)
  and the consult path (`GET /api/public/bookings/free-un1t-consultation` + `/slots`,
  `POST /api/public/book`) are reused **unchanged**.
- No change to WhatsApp confirmations, ad-click attribution capture, or the Ads dashboard.
- Not making `/start` copy operator-editable (real, but a separate task — flagged below).
- No capacity/spaces-left ever shown to customers (unchanged invariant).

## Part 1 — `/start` web funnel (ship first)

Single component: `src/components/StartFunnel.jsx`. Pure front-end reflow of its
state machine; no new steps invented, the consult steps are re-entered from a new point.

**Before:** `choose → details → { classpick | calendar } → { classdone | done }`
**After:** `details → classpick → classdone → (optional) calendar → done`

### State machine changes

- Initial `step` becomes `'details'` (was `'choose'`); initial `path` becomes `'class'`
  (was `null`). `detailsNext()` already routes `path === 'class'` to `classpick`, so
  details → class picker works with no other change.
- **Delete** the `choose` step JSX (the two big path buttons) and the `chooseClass()` /
  `chooseConsult()` handlers.
- **Class success (`classdone`)** gains a secondary, skippable CTA — e.g.
  *"Want a coach in your corner? Add a free consult →"*. Tapping it sets
  `path='consultation'` and `step='calendar'`, which triggers the **existing** consult
  effects (load `free-un1t-consultation` event + availability). The user's name / email /
  phone / consent are already in `form` state — **nothing is re-entered**. They then pick
  a day+time → `book()` (existing) → `done`.
- The `done` screen (consult confirmation) is reached only via the upsell now; its copy
  already fits ("You'll get a WhatsApp confirming your consultation").

### One race to guard

Entering `calendar` flips `path` and `step` in the same handler. The consult **event**
loads off the `path` effect while the **days** load off the `step` effect — days can
resolve first. `book()` already guards `if (!event)`, but to avoid a confusing error we
also **disable the slot buttons until `event` is set** (small `disabled={!event || submitting}`).

### Copy (hard-coded, matching the rest of the funnel)

- Details heading unchanged. The old hero line ("Your first 3 classes are free / how do
  you want to start?") moves onto the details step so the value prop still leads.
- Class success line unchanged ("That's the first of your 3 free classes…").
- New upsell CTA copy: **"Want a coach in your corner? Add a free consult →"** plus a
  sub-line ("Meet a coach, talk goals, get a plan — on us."). Operator-editable copy is
  a noted follow-up, not in scope.

## Part 2 — Telemetry cleanup

The "Chose a path" funnel stage is meaningless once there's no choice.

- `src/components/StartFunnel.jsx`: stop firing `path_class` / `path_consult`.
- `src/lib/ads/funnel.js`: drop the `path` stage from `FUNNEL_STAGES`. New model:
  **`view → details → slots → booked`**. `booked` counts **`booked_class` only** — every
  completed funnel is a class booking, so that is the funnel's success metric. (The old
  model summed `booked_class + booked_consult`, which was safe when the paths were
  mutually exclusive; now the consult fires *after* a class in the same session, so
  summing would double-count. The consult-add is a post-funnel bonus, not a funnel stage —
  a "% who added a consult" tile is a possible later add, out of scope.)
- `src/lib/ads/funnel.test.js`: update expectations to the 4-stage model.
- `src/lib/funnel-events.js`: **keep** `path_class` / `path_consult` in `VALID_STEPS`
  (historical rows + the public endpoint stay valid); we simply stop emitting them.

## Part 3 — WhatsApp Flow (fast-follow, after Part 1 ships)

Surface: the `book_first_visit` in-chat Flow sent by `meta-ad-whatsapp-welcome.js` when
`locations.settings.whatsapp_flow.enabled`. Handler: `src/lib/whatsapp-flow/handler.js`.

- **`INIT` returns the class Day screen directly** instead of `pathScreen()`. `path` is
  always `'class'` thereafter; the PATH-screen branch is bypassed. Day → Slot → Details →
  Confirm (class) → completion, all existing.
- **Meta-side:** the Flow JSON is hosted at Meta and is **live + smoke-tested**. Making
  Day the entry screen (and removing/orphaning PATH) needs a **Flow version bump +
  republish + re-smoke** — the careful, gated part. This is why Part 3 lands after Part 1.
- **Consult-after on WhatsApp = Mia, not a Flow screen.** A Flow is a linear screen
  sequence that ends in a terminal completion; you can't cleanly branch back afterwards.
  Instead, after the Flow completes a class booking, **Mia offers the free consult
  conversationally** (a light nudge in `src/lib/agent/prompt.js`). This is the WhatsApp
  analog of the `/start` upsell and is more natural on chat. In-scope but small; droppable.

## Rollout & risk

1. **Part 1 + Part 2** ship together (one PR): front-end only, low risk, reversible.
2. **Part 3** is a second PR gated on the Meta Flow republish + smoke.
3. Risk surface is small — no DB, no API, no auth. Main watch items: the consult-event
   race (guarded above) and not regressing the ad-attribution capture (untouched).

## Verification

- `npm test` (funnel.test.js updated) + full CI mirror + `npm run build` (component change).
- Manual `/start`: details → book a class → see the consult upsell → add a consult →
  both confirmations arrive. And the skip path (book class, ignore upsell) ends cleanly.
- After a day of ad traffic, the Ads dashboard funnel panel shows the 4-stage model with
  no dead "path" row.
