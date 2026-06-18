# Session Report — data contract + API + visual view (design spec)

- **Date:** 2026-06-18
- **Status:** Draft for review
- **Slice:** Slice 1 (foundation) of "post-class value for the member." Establishes a single, versioned, surface-agnostic **Session Report** payload that every surface renders. Later slices (cardio/strength category, book-next-class action, native push, shareable card) are drop-in renderers/fields on this contract.
- **Repos:** `un1t-crm` (canonical builder + email refactor) and `champ-app` (duplicated builder + report API + visual session view). No schema migration.

## Goal

Turn today's email-only post-class analytics into a **data product**: one pure `buildSessionReport()` that returns a complete, versioned, JSON-serialisable report, consumed identically by the post-class email, the champ-app session view (the member's visual representation today), the future native customer app, and shareable cards. The payload is shaped so each field maps to a visual element.

## Why this is the right foundation (grounded in current state)

- The analytics already exist and are structured — `buildSessionAnalytics()` (`src/lib/hr-analytics.js`) returns `{ highlight, classType, overall }`; `summariseSession()` + `zoneBreakdown()` (`src/lib/heart-rate.js`) give zones/points/avg/peak.
- But the **only** consumer is `composeEmail()` (`src/lib/hr-post-class-email.js`), which calls `buildSessionAnalytics` + `zoneBreakdown` inline and renders straight to HTML. The numbers live nowhere a customer app could read them.
- champ-app's session view (`src/app/sessions/[id]/page.jsx`) already renders header stats, an HR-over-time chart, the zone breakdown, and **achievements earned this session** (`contact_achievements` by `source_session_id`) — but it has **none of the comparisons or the highlight**. So the member's visual surface today is strictly poorer than the email.
- `loadContextForSession()` already returns `{ session, thisSession, history, eventTypeName, contact }`, with `thisSession`/`history` in exactly the shape the analytics consume. The report builder reuses this context verbatim.

So Slice 1 is mostly *consolidation*: lift the report into one builder, expose it, and make every surface render the same thing — eliminating the email-vs-app divergence before it starts.

## The contract — `buildSessionReport(ctx)` → versioned payload

A **pure** function (no IO, no `Date.now()` unless `nowMs` passed) that takes the existing context bundle (plus an optional `achievements` array the caller loads) and returns:

```jsonc
{
  "version": 1,
  "session": {
    "id": "uuid",
    "started_at": "ISO", "ended_at": "ISO", "duration_seconds": 2700,
    "source": "ble_bridge",
    "class": { "event_type_id": "uuid|null", "name": "UN1T|null", "category": null }  // category ← Slice 2
  },
  "summary": {
    "effort_points": 312,
    "avg_hr_bpm": 148, "peak_hr_bpm": 181, "max_hr_used": 190,
    "zones": [   // from zoneBreakdown(): one per zone, ready for a bar
      { "id": 1, "name": "Warm-up", "color": "#9CA3AF", "seconds": 120, "percent": 0.04 },
      { "id": 2, "name": "Easy",    "color": "#3B82F6", "seconds": 300, "percent": 0.11 },
      { "id": 3, "name": "Aerobic", "color": "#10B981", "seconds": 840, "percent": 0.31 },
      { "id": 4, "name": "Threshold","color": "#F59E0B","seconds": 900, "percent": 0.33 },
      { "id": 5, "name": "Max",     "color": "#EF4444", "seconds": 540, "percent": 0.20 }
    ]
  },
  "comparisons": {
    "vs_recent":     { "field": "effort_points", "direction": "up|flat|down", "delta_pct": 0.12, "recent_mean": 290, "prior_mean": 259, "has_enough_data": true },
    "vs_recent_peak":{ "field": "peak_hr_bpm",   "direction": "flat", "delta_pct": 0.01, "has_enough_data": true },
    "vs_this_class": { "event_type_name": "UN1T", "mean_points": 270, "percentile": 0.82, "sample_size": 9 },
    "vs_category":   null    // ← Slice 2 (cardio/strength/conditioning benchmark)
  },
  "highlight": { "id": "best_class_type_points", "message": "Personal best for UN1T — 312 UN1T Points." },  // or null
  "achievements": [ { "slug": "ten_classes", "name": "10 Classes", "icon": "Award", "earned_at": "ISO" } ], // [] if none/none-loaded
  "next_action": null     // ← Slice 3 (book next class)
}
```

Mapping to visuals: `summary.zones` → the stacked/segmented bar; `comparisons.*.direction`+`delta_pct` → up/down chips; `vs_this_class.percentile` → "top 18% of your UN1T classes"; `highlight.message` → the hero line; `achievements` → badge row. `vs_category` and `next_action` ride as `null` now so Slices 2–4 attach without reshaping the contract — bump `version` only if an existing field's meaning changes.

**Construction:** `buildSessionReport` composes the *existing* helpers — `summariseSession`/`zoneBreakdown` for `summary`, `buildSessionAnalytics` for `comparisons` + `highlight`, and maps the caller-provided `achievements`. It does not re-implement any math; it's an assembler + the version envelope.

## Architecture

**Builder placement + the drift seam.** `buildSessionReport` lives in `un1t-crm/src/lib/hr-session-report.js` (used by the email) and is **duplicated verbatim** into `champ-app/src/lib/hr-session-report.js` (used by the app) — the same pattern `heart-rate.js`/`hr-analytics.js` already follow (champ-app marked canon). Both carry the "keep in sync" header and assert against a **shared JSON fixture** (`session-report.fixture.json`, copied into both test dirs) so a divergence breaks a test on both sides. Genuinely de-duplicating cross-Vercel-project code stays on the existing future-cleanup backlog — explicitly **not** this slice.

**Surfaces (all renderers of one payload):**

1. **un1t-crm post-class email** — refactor `composeEmail()` to call `buildSessionReport(ctx)` and render from the payload, instead of calling `buildSessionAnalytics` + `zoneBreakdown` itself. Output is the same email; the source of truth becomes the shared builder. (`loadContextForSession` optionally also loads `contact_achievements` by `source_session_id` so the email can show badges — nice-to-have, may be a fast follow.)

2. **champ-app report API** — `GET /api/sessions/[id]/report` (champ-app). Customer-self: the RLS-scoped server client (`createServerClient`) only returns the session if `contact_id = private.auth_contact_id()`, else `notFound`/404. Loads session + 90-day history (mirroring `loadContextForSession`) + this-session achievements, calls `buildSessionReport`, returns the payload as JSON. **This is the "feeds a customer app" hook** — the future native app and the shareable-card renderer both consume it.

3. **champ-app session view** — `sessions/[id]/page.jsx` server-renders `buildSessionReport` and adds the missing layer: the three comparisons (recent trend, this-class percentile) + the highlight hero line, alongside the stats/chart/zones/achievements it already shows. The page builds the report server-side from the shared builder (same code the API uses).

## In scope

- `buildSessionReport()` pure builder + versioned payload (both repos + shared fixture).
- `composeEmail` refactored to consume it.
- champ-app `GET /api/sessions/[id]/report` (customer-self).
- champ-app session view rendering the comparison + highlight layer.

## Out of scope (later slices — already slotted as null fields)

- **Slice 2:** cardio/strength/conditioning class-category taxonomy → fills `session.class.category` + `comparisons.vs_category`.
- **Slice 3:** `next_action` (book-next-class CTA).
- **Slice 4:** native push notification + server-rendered shareable card image (both consume the API).
- No new HR maths, no zone/points changes, no migration. `vs_category` and `next_action` stay `null`.

## Data flow

```
session ends (endSession / stale-session cron)              [un1t-crm]
   → loadContextForSession → buildSessionReport(ctx) → composeEmail → post-class email

member opens app / native app / card renderer               [champ-app]
   → GET /api/sessions/[id]/report (RLS customer-self)
       → load session + 90d history + achievements → buildSessionReport → JSON
   → sessions/[id] page server-renders the same builder → visual report
```

## Edge cases

- **No history yet (first session):** `vs_recent.has_enough_data=false`, `vs_this_class.sample_size` small/0, `highlight` may be `first_ever`. Renderers must treat every comparison as nullable/`has_enough_data`-gated — no "down 100%" artefacts.
- **Session not ended / not owned:** API returns 404 (not 403) so ids can't be enumerated; the email path already guards `ended_at`.
- **Null-contact (walk-in) sessions** (HR-CLASS-ALLOC.2): no `auth_contact_id` owner → never returned by the customer API; no email. Out of scope by construction.
- **Missing zones/points** (summary-only device sync): `summary.zones` percents are 0; renderers already handle this (existing champ-app page does).

## Testing

- **Builder (the contract):** unit-test `buildSessionReport` hard against the shared fixture — zone mapping, each comparison shape, `has_enough_data` gating, highlight precedence, the `null` slots, the `version` envelope. Both repos run the same fixture.
- **API:** route test for customer-self scoping (own session → 200 payload; other's/unknown → 404) and the not-ended guard.
- **Renderers (email, view):** thin; covered by the builder tests + a render smoke check.

## Rollout

- No migration. Ships as two PRs (un1t-crm builder+email; champ-app builder+API+view) or one coordinated pair. Both auto-deploy on merge (un1t-crm → crm.un1tdublin.com; champ-app → app.champfitness.ie).
- Because the email already fires on session-end, the refactor is behaviour-preserving for email; the net-new member-visible change is the richer champ-app session view.

## Open questions

1. **Achievements in the email** — fold badges into the refactored email now, or leave email as-is (analytics-only) and surface badges only in-app for Slice 1? *Default: in-app only for Slice 1; email badges a fast follow.*
2. **API auth shape for the future native app** — the web view server-renders, so the endpoint is for native/cards. Confirm native will authenticate as a Supabase customer session (same as champ-app web) so the same RLS path covers it. *Default: yes, Supabase customer session.*
3. **Card image renderer placement** (Slice 4, noted only) — champ-app route via `sharp`, consuming this API. Not decided here.
