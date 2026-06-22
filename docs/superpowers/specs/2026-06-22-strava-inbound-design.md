# Strava inbound — personal-only activity ingestion via OpenWearables

**Date:** 2026-06-22
**Repos:** un1t-crm (ingestion/webhook), champ-app (connect + display), OpenWearables (OW, the Strava connector), shared Supabase `iyvtbjjxdggiadzwwvdj`.

**Goal:** Let a champ-app member connect their Strava account and see **their own** Strava activities on **their own** dashboard/progress — and nowhere else.

**Locked decisions (Richard, 2026-06-22):**
- **Ingest via OpenWearables** — OW's built-in Strava provider does the OAuth + activity sync + webhook + token refresh; we don't build a direct Strava OAuth/webhook for inbound.
- **Personal-only** — Strava data appears ONLY on the member's own views. It does NOT enter points / challenges / leaderboards / feed / friend-boards — none of the community/cross-user surfaces.
- Strava app credentials with `activity:read` are **ready**.
- Strava's §6.1 "9,999 athletes" email is **unanswered** → strict personal-only (relaxing it later is a separate effort).

**Non-negotiable constraint (Strava API Policy §5.4):** data *derived from* Strava data may not be displayed to other members, with no consent exception. A points total or leaderboard rank computed from a member's Strava activity is "derived data" and is forbidden from cross-user display.

---

## Core design principle: personal-only by architecture, not by filtering

Routing via OW means Strava activities arrive as `workout.created` on the existing IB5 webhook — whose normal job is to insert a `heart_rate_sessions` row, run `finalizeSessionRewards` (points), and class-correlate. That pipeline feeds the **community** points/leaderboard/challenge system, which are deliberately source-agnostic.

If Strava rode that pipeline, a single forgotten `WHERE source != 'strava'` anywhere (a leaderboard, the consistency board, the feed, a future query) would leak derived Strava data cross-user — a ToS violation.

**Therefore Strava data never enters `heart_rate_sessions` or any community table.** The webhook branches on `provider === 'strava'` and lands those into a dedicated **`strava_activities`** table that only the member's own views read. The personal-only guarantee is structural: Strava data is not in the tables the community queries read, so it cannot appear there.

---

## Phase 0 — Spike (the gate, before the full build)

Mirror the Apple spike. Verify against the live OW + a real Strava account BEFORE building the UI/ingestion in full:

1. **Configure OW's Strava provider** — `PUT /api/v1/oauth/providers/strava` on `un1t-ow-backend.fly.dev` with the `client_id` / `client_secret` (from `service_integrations`).
2. **Resolve the callback-domain limit** — Strava apps allow ONE "Authorization Callback Domain." The export app uses `app.champfitness.ie`; OW's OAuth callback is `un1t-ow-backend.fly.dev`. Confirm whether (a) the existing app can add/observe OW's domain, or (b) inbound needs its **own Strava app** (callback = OW's domain). Record the answer; it sets the connect URLs.
3. **Connect a real Strava account through OW** (Richard) and confirm OW **syncs activities** and **fires `workout.created`** with `data.source.provider === 'strava'` — capturing the real payload shape (type, distance, duration, start/end, avg/max HR if present). This pins the mapper, exactly as the Apple `workout.created` shape was pinned.

If OW can't deliver Strava activities or the callback can't be resolved, stop and reconsider (e.g., fall back to a direct Strava integration). The full build below assumes the spike passes.

---

## Components (post-spike)

### 1. `strava_activities` table — mig 308
Personal store. Never read by any community/cross-user query.

```sql
CREATE TABLE strava_activities (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  strava_activity_id text NOT NULL,           -- OW/Strava activity id (dedup key)
  activity_type     text,                     -- run / ride / swim / …
  name              text,
  started_at        timestamptz,
  duration_seconds  numeric,
  distance_meters   numeric,
  calories_kcal     numeric,
  avg_hr_bpm        numeric,
  max_hr_bpm        numeric,
  raw_metadata      jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, strava_activity_id)
);
ALTER TABLE strava_activities ENABLE ROW LEVEL SECURITY;
-- Member reads own only (NO staff cross-read — it's the member's private Strava data).
CREATE POLICY "Customers view own strava activities" ON strava_activities
  FOR SELECT TO public USING (contact_id = (SELECT private.auth_contact_id()));
-- service-role writes only.
```
No `location_id`, no staff policy, no points columns — it is structurally a private, personal store.

### 2. Connect flow (champ-app, via OW)
A "Connect Strava" entry on the existing integrations screen. Because OW runs Strava OAuth server-side, champ-app: ensures the member's OW user (reuse the IB4 `ensureUser` path), gets OW's Strava authorize URL for that user, redirects the member to Strava; OW handles the callback, stores tokens, backfills + syncs activities, and refreshes tokens. Disconnect revokes via OW. Exact authorize/return URLs are pinned by the spike (step 2).

### 3. IB5 webhook branch (un1t-crm)
In `/api/webhooks/openwearables`, after resolving the member and `provider`: if `connectionProvider === 'strava'`, map the payload to a `strava_activities` row, upsert (dedup on `strava_activity_id`), and **return** — do NOT insert a `heart_rate_sessions` row, do NOT call `finalizeSessionRewards`, do NOT class-correlate. A pure `mapStravaActivity(payload)` lib (fixture-tested) does the field mapping. Everything for the existing providers (apple/fitbit/whoop/garmin) is unchanged.

### 4. Display (champ-app, member-own only)
A "Your Strava activities" section on the member's dashboard/progress: list of activities (type, date, distance, duration, HR if present), read from `strava_activities` under RLS. Rendered ONLY on the member's own surfaces — never a leaderboard, feed, friend-board, or challenge.

---

## Explicitly out of scope
- Any Strava data in points, challenges, leaderboards, the consistency board, the activity feed, friend boards, or cross-user display (forbidden by §5.4 until/unless the §6.1 reply permits it — a separate effort).
- Consolidating the existing export (`activity:write`) connection with this inbound one — they stay separate for now.
- Strava data visible to staff/coaches (it's the member's private data; no staff RLS).

## Testing
- **Pure, no DB:** `mapStravaActivity(payload)` (Strava `workout.created` payload → `strava_activities` row; defensive).
- **Route:** IB5 branch — a `provider:'strava'` event upserts into `strava_activities` and does NOT touch `heart_rate_sessions` / `finalizeSessionRewards` / class-correlation (assert the existing mocks are NOT called).
- **Guardrail test:** assert no community/leaderboard/challenge/feed query reads `strava_activities` (it has no `location_id` and no staff policy, which structurally enforces this; the route test pins the no-points behaviour).
- champ-app display lib unit-tested.

## Open questions
- The callback-domain resolution (Phase 0 step 2) and the exact OW Strava authorize/return URLs — pinned by the spike, then reflected in the plan.
- Whether OW exposes Strava activity HR (avg/max) in the `workout.created` payload or only via a separate fetch — confirmed in the spike; the mapper stores whatever's present.
