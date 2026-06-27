# Profile setup → body metrics → calories (and a data-driven integrations hub)

**Date:** 2026-06-27
**Status:** Design — pending spec review
**Area:** champ-app (customer) onboarding + un1t-crm (body-metric model, calorie calc) + Apple Health ingest
**Spans two repos:** `un1t-crm` (DB, calorie calc, API, InBody) and `champ-app` (wizard, Apple Health, integrations UI)

## Problem

In-studio HR sessions show "—" for calories ([champ-app session report](../../../../champ-app/src/lib/load-session-report.js)) because `heart_rate_sessions.calories_kcal` is only ever written by wearable *imports* (Apple Health / Strava); the bridge captures HR but never computes calories. To compute it we need each member's **age, weight, and gender** — and today only `dob` exists (`contacts.dob`, from Glofox, often blank); weight lives only inside InBody scans; gender is captured nowhere. Members are never asked for these, so the inputs are missing and calories can't be produced.

Richard's framing: collect this at **first-login profile setup**, keep it fresh from a **health integration** (Apple Health now, others later — they should "seamlessly appear" in an integrations section), and **prompt** when a field is blank — so calories (and accurate zones) work from day 1 with no outstanding questions.

## Goals

- Every member has **dob + gender + weight** captured (required at setup) and kept fresh.
- In-studio (bridge) sessions show **calories**, computed from HR + duration + age + weight + gender.
- Body metrics auto-update from a connected health app (Apple Health) — no repeated asking.
- A **data-driven integrations hub** where new integrations appear by adding a registry entry, not a redesign.
- Works for **new members** (first-login wizard) and **existing members** (one-time nudge → same wizard).

## Non-goals

- No new integration *providers* built here beyond what already exists (Apple Health on-device HealthKit, Garmin/ANT+ strap device-onboarding, Strava). Whoop etc. render as "Coming soon" until separately built.
- No change to how imported (apple_health / strava) sessions get calories — those already carry a provider value.
- Operator-editable onboarding microcopy is deferred (v1 ships sensible hardcoded copy; note the [[customer-comms-editable]] invariant as a fast-follow).
- No retroactive recompute beyond a bounded recent-session backfill (see Slice 1).

## Slices (build value-first)

The feature is one coherent product, implemented in three dependency-ordered slices. Each is independently shippable.

---

### Slice 1 — Body-metric model + calorie computation (the value)

Lights up calories for anyone who has the inputs (manual entry or an existing InBody scan), with no dependency on Apple Health or the wizard.

#### Data model (un1t-crm, one migration)
Canonical body metrics on `contacts` (joins `dob`, already present):
- `gender text` — CHECK in (`'female'`,`'male'`,`'other'`) or null.
- `weight_kg numeric` — current weight (the calc input).
- `weight_kg_source text` — `'manual'|'inbody'|'apple_health'` (provenance).
- `weight_kg_at timestamptz` — when that weight was measured/entered (freshness).
- `profile_setup_completed_at timestamptz` — drives the wizard/nudge (Slice 3; column added here so the model is complete).

**Freshest-wins write rule:** every weight writer (manual, InBody, Apple Health) calls one helper `applyWeightObservation(db, { contactId, weightKg, source, observedAt })` that updates `contacts.weight_kg/_source/_at` **only when `observedAt >= weight_kg_at`** (a stale manual value never clobbers a fresh sync; a new InBody scan supersedes an old manual entry). Pure decision `shouldApplyWeight(current, incoming)` is unit-tested.

#### InBody → weight (un1t-crm)
The InBody ingest already parses `weight_kg` ([inbody-scan.js](../../../src/lib/inbody-scan.js)). Add one call to `applyWeightObservation(... source:'inbody', observedAt: scan date)` in the enrich/ingest path so a scan updates the canonical weight.

#### Calorie computation (un1t-crm)
New pure module `src/lib/calories.js`:
```
estimateCaloriesKcal({ avgHr, durationMin, age, weightKg, gender }) → number | null
```
- Keytel et al. (2005) HR-based kcal/min, ×duration:
  - male:   kcal/min = (-55.0969 + 0.6309·HR + 0.1988·weight + 0.2017·age) / 4.184
  - female: kcal/min = (-20.4022 + 0.4472·HR − 0.1263·weight + 0.0740·age) / 4.184
  - **other / null gender → mean of the male and female results** (sex-neutral).
- Returns **null** if any required input is missing/non-finite (`avgHr`, `durationMin`, `weightKg`, `age`) — so calories stays "—" rather than a wrong number.
- `age` derived from `dob` via the existing `computeAge` (`heart-rate.js`).

New resolver `resolveBodyMetrics(db, contactId) → { dob, age, gender, weightKg }` (reads `contacts`).

#### Wire into finalisation (un1t-crm)
In `endSession` ([live-class.js](../../../src/lib/live-class.js)) — where it already computes `avg_hr_bpm`/`peak_hr_bpm`/zones — compute `calories_kcal = estimateCaloriesKcal({ avgHr: summary.avgHrBpm, durationMin, age, weightKg, gender })` and include it in the session UPDATE. Duration = (ended_at − started_at) in minutes. Best-effort: a null result just leaves the column null. Same for the cron-driven `auto-end-stale-hr-sessions` path (it calls `endSession`, so this is automatic).

#### Backfill (un1t-crm, bounded)
A one-shot master-gated `POST /api/admin/backfill-session-calories?location_id=&since=` that recomputes `calories_kcal` for **already-ended `ble_bridge` sessions in a recent window** (e.g. last 30 days) whose contact now has the inputs. Logs how many it filled and how many it skipped (no inputs). No automatic global recompute.

---

### Slice 2 — Apple Health body-metric auto-fill

Keeps weight "regularly updated" and pre-fills dob/gender, reducing what we must ask.

- **champ-app:** extend the existing on-device HealthKit ingest ([[apple-health-direct]]) to read, with the member's HealthKit permission:
  - `bodyMass` (latest sample, + background delivery so it stays fresh),
  - `dateOfBirth` (characteristic),
  - `biologicalSex` (characteristic).
- **un1t-crm receiver:** the customer-authed ingest endpoint accepts an optional `body` block `{ weight_kg, weight_at, dob?, biological_sex? }` and:
  - `applyWeightObservation(... source:'apple_health')` (freshest-wins),
  - fills `contacts.dob` / `contacts.gender` **only if currently null** (never overwrite an operator/Glofox value or an explicit member choice).
- Maps HealthKit `biologicalSex` (`female|male|other|notSet`) → our gender enum (`notSet` → leave null).

After Slice 2, an Apple-Health-connected member's weight is current without any manual step.

---

### Slice 3 — First-login profile-setup wizard + integrations hub

The onboarding shell that makes it work "from day 1," plus the ongoing integrations section.

#### Wizard (champ-app)
Trigger: member is authenticated AND `contacts.profile_setup_completed_at` is null.
- **New members:** shown as a full-screen flow on first entry.
- **Existing members:** a dismissable "complete your profile" **card on the home/progress screen** that opens the same wizard; reappears until completed.

Steps (per the approved mockup — monochrome UN1T identity, Poppins, zone-colour accents only):
1. **Welcome** — why (effort/zones/calories), one CTA.
2. **About you (REQUIRED to finish)** — `dob` (pre-filled from Glofox if present), `gender` (segmented female/male/other), `weight_kg`. Pre-filled from `contacts` where known. Cannot finish setup without all three.
3. **Connect health data (optional / skippable)** — the integrations chooser (below). Skipping still completes setup.

Completing step 2 stamps `profile_setup_completed_at` (single endpoint, below). Step 3's outcome doesn't affect completion.

#### Body-metrics API (un1t-crm)
`POST /api/me/body-metrics` — customer-authed (champ-app). Resolves the caller's own contact via `private.auth_contact_id()` (service client writes after verifying ownership — `authenticated` role can't write `contacts` directly). Validates: gender enum, weight 20–300 kg, dob a sane past date. Writes `gender`, `weight_kg` (source `'manual'`, `weight_at=now`), and `dob` if provided. **When the write results in all three required fields (`dob`, `gender`, `weight_kg`) being non-null, it also stamps `profile_setup_completed_at = now()` (once; never un-sets it).** Returns the updated metrics. One endpoint serves both the wizard's "about you" save and later edits from Account.

#### Integrations hub (champ-app, data-driven)
A registry (config array) is the single source of truth, e.g.:
```
INTEGRATIONS = [
  { key:'apple_health', label:'Apple Health', status:'available', blurb:'Weight, HR, workouts', connect: <existing HealthKit flow> },
  { key:'garmin_ant',   label:'Garmin / ANT+ strap', status:'available', blurb:'Live heart rate in class', connect: <existing device onboarding> },
  { key:'strava',       label:'Strava', status:'available', blurb:'Sync outdoor activities', connect: <existing Strava OAuth> },
  { key:'whoop',        label:'Whoop', status:'coming_soon' },
]
```
Rendered in two places off the same registry: the wizard step 3 chooser, and **Account → Integrations** (ongoing — shows connected state + "synced Xm ago", lets members connect/disconnect; `status:'coming_soon'` renders disabled). Adding a future provider = append a registry entry (+ its connect handler). Connection *state* per provider comes from existing signals (HealthKit permission flag, `contact_devices` for the strap, `strava_connections` for Strava).

---

## Data flow (calories on a studio session)

```
member completes setup / connects Apple Health
  → contacts.{dob,gender,weight_kg} populated; weight kept fresh (freshest-wins)
class runs → bridge samples → session
endSession (or stale-close cron):
  summary = avg/peak/zones (existing)
  {dob,gender,weightKg} = resolveBodyMetrics(contact)
  calories_kcal = estimateCaloriesKcal({avgHr:summary.avgHrBpm, durationMin, age, weightKg, gender})  // null if inputs missing
  UPDATE heart_rate_sessions SET …, calories_kcal
champ-app session report → shows calories (or "—" if null)
```

## Security / privacy

- dob/gender/weight are health-sensitive. Stored on `contacts` (already holds `dob`). No new public exposure; never surfaced on the public TV feed or share card.
- `POST /api/me/*` are customer-authed, write **only the caller's own contact** (ownership via `private.auth_contact_id()`), service client does the write (route-guard compliant). 404-not-403 on any cross-contact attempt.
- Migration forward-only via Supabase MCP (`iyvtbjjxdggiadzwwvdj`), `get_advisors` after DDL.

## Testing

- **Pure:** `estimateCaloriesKcal` (male/female/other/null-gender, missing-input → null, a known reference value); `shouldApplyWeight` (freshest-wins, equal-timestamp, null current).
- **Calc wiring:** `endSession` writes `calories_kcal` when inputs present, leaves null when not; participation/anon sessions unaffected.
- **Sourcing:** InBody ingest updates canonical weight; Apple Health receiver fills dob/gender only-if-null and applies freshest weight; manual write sets source/time.
- **API guards:** `/api/me/body-metrics` + `/api/me/profile-setup` reject unauth / cross-contact; validation bounds.
- **champ-app:** wizard gates completion on the three required fields; existing-user nudge shows iff `profile_setup_completed_at` null; integrations list renders from the registry incl. a `coming_soon` entry.

## Defaults / decisions (confirmed with Richard)

| Decision | Value |
|---|---|
| Gender captured | Yes (female / male / other) |
| "Other" / unknown gender | sex-neutral coefficient (mean of male & female) |
| "About you" step | **required** to finish setup |
| Integration step | optional / skippable |
| Existing members | one-time dismissable "complete your profile" card → same wizard, reappears until done |
| Strava in chooser | yes (already user-connectable) |
| Whoop & future | render data-driven as "Coming soon" until built |
| Calorie formula | Keytel et al. (2005), HR-based |

## Open considerations (non-blocking)

- **Calories accuracy without weight** is impossible — if a member skips/declines and we somehow have no weight (shouldn't happen given required setup), calories stays "—". No gym-average fallback in v1 (would mislabel a real number); revisit if needed.
- **InBody `bmr`** is also parsed and could refine the estimate later (resting + active); v1 uses the standard Keytel HR model only.
- **Onboarding copy** operator-editability deferred ([[customer-comms-editable]]).
