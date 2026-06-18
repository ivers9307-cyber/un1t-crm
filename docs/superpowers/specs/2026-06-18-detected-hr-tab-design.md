# Detected HR — durable detections log + linking (design spec)

- **Date:** 2026-06-18
- **Status:** Draft for review
- **Ticket:** HR-DETECT.1
- **Repo:** `un1t-crm` only (staff CRM). No champ-bridge or champ-app change — the bridge already sends everything we need; we stop discarding it.
- **Slice:** A new **"Detected"** tab on the coach live-HR page (`/live/[locationId]`) that durably records and lists every heart-rate strap the bridge detects — linked to a member or not — with per-strap appearance history and the ability to link an unknown strap to a member (per-class or permanently).

## Goal

Make every HR device the bridge picks up **visible and durable**, whether or not it belongs to a known member. Today a strap only leaves a durable trace (`heart_rate_sessions` + `hr_samples`) in three cases: a registered member's device, a manual coach pairing, or an anonymous walk-in **during a live Glofox class**. Everything else the bridge sees lives only in `ble_bridges.last_seen_straps` — an ephemeral JSONB snapshot fully overwritten every ~5 s — and its samples are counted as `dropped_unpaired` and thrown away (`src/app/api/bridge/samples/route.js`). This feature adds a recording layer so nothing the bridge detects is invisible, and turns an unknown strap into a one-click "pair for today" or "remember this member's device."

## Why this is the right shape (grounded in current state)

- **The samples stream already sees everything.** ANT+/BLE HR ingestion is connectionless — the bridge reads *all* broadcasting straps in range and POSTs them to `/api/bridge/samples`. `resolveStrapsForBatch()` (`src/lib/bridge-samples.js`) already classifies each `device_key` as override / auto / anon / unmatched and reports the unmatched ones as `dropped_unpaired`. So the data we want to record already arrives every batch — we just need to persist it before discarding.
- **The live page is a single flat view today**, not tabbed: `LiveClassClient.jsx` renders `SessionGrid`, `ClassRosterPanel`, `AvailableStrapsPanel`, `PairModal` in one column (`src/app/live/[locationId]/LiveClassClient.jsx`). Adding a tab switch is a contained change.
- **Per-class pairing already exists** — `AvailableStrapsPanel` → `PairModal` → `POST /api/live/[locationId]/pair` → `strap_assignments` (`src/lib/live-class.js → pairOverride`). The new tab reuses it for "pair for today" and adds only the *permanent registration* path.
- **Device-key + class-resolution helpers already exist** — `makeDeviceKey`/`parseDeviceKey`/`canonicaliseDeviceKey` (`src/lib/bridge-samples.js`) and `resolveCurrentOccurrence` (`src/lib/class-bookings.js`). The recording layer composes these; it invents no new HR maths.

So HR-DETECT.1 is mostly *capture what already flows + surface it + reuse pairing*.

## Architecture

### Data model — one migration (next number, ~mig 292)

**`hr_detections`** — the registry. One row per `(location_id, device_key)`, upserted on detection.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `location_id` | uuid NOT NULL → `locations(id)` | tenant scope |
| `device_key` | text NOT NULL | `ant:<n>` \| `ble:<MAC>` |
| `protocol` | text | `ant` \| `ble`, parsed from key |
| `first_seen_at` | timestamptz NOT NULL | all-time first detection |
| `last_seen_at` | timestamptz NOT NULL | most-recent detection |
| `visit_count` | integer NOT NULL DEFAULT 1 | incremented when a new visit opens |
| `last_bpm` | smallint | most-recent BPM |
| `last_name` | text | broadcast name (enriched from scan snapshot) |
| `last_rssi` | smallint | enriched from scan snapshot |
| `last_bridge_id` | uuid → `ble_bridges(id)` | which bridge last saw it (diagnostics) |
| `current_visit_id` | uuid (no FK) | denormalised pointer to the open visit, so the recording hot path decides extend-vs-new without a per-strap visit lookup |
| `created_at` / `updated_at` | timestamptz | |

`UNIQUE (location_id, device_key)`. Index: `(location_id, last_seen_at DESC)`.

**`hr_detection_visits`** — appearance history. One row per contiguous visit.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `detection_id` | uuid NOT NULL → `hr_detections(id)` ON DELETE CASCADE | |
| `location_id` | uuid NOT NULL → `locations(id)` | denormalised for RLS |
| `device_key` | text NOT NULL | denormalised for convenience |
| `started_at` | timestamptz NOT NULL | first sample of this visit |
| `last_sample_at` | timestamptz NOT NULL | keeps moving while the strap is seen |
| `peak_bpm` | smallint | max BPM in the visit |
| `last_bpm` | smallint | most-recent BPM in the visit |
| `sample_count` | integer NOT NULL DEFAULT 0 | batches counted toward the visit |
| `glofox_event_id` | text | live class during the visit, if any |
| `class_name` | text | stamped from `resolveCurrentOccurrence` |
| `created_at` / `updated_at` | timestamptz | |

Index: `(detection_id, started_at DESC)`.

**Visit boundary = gap threshold, no cron.** A visit is "open" while `now − last_sample_at ≤ DETECTION_VISIT_GAP_MS` (constant, 5 min). On each detecting batch: if the device's latest visit is still open, extend it (`last_sample_at = now`, update `peak_bpm`/`last_bpm`, `sample_count++`); otherwise insert a new visit row, `visit_count++` on the registry, and stamp the live class. Because "closed" is computed from `last_sample_at`, a visit never needs a background finalizer — it simply stops being extended when samples stop.

**RLS** mirrors `heart_rate_sessions`: **staff-at-location SELECT** (`private.auth_is_in_location(location_id)`), **service-role write only** (the bridge ingestion). **No customer-self policy** — this surface includes unknown/anonymous straps and is staff/ops-only. Both tables `ENABLE ROW LEVEL SECURITY`; run `get_advisors` after the migration.

### Recording path — `src/lib/hr-detections.js` (best-effort, never blocks the bridge)

- **Anchor — samples ingestion.** In `POST /api/bridge/samples` (`src/app/api/bridge/samples/route.js`), after `resolveStrapsForBatch()`, call `recordDetections(db, { locationId, bridgeId, samples })` for **every** `device_key` in the batch — matched *and* unmatched. It upserts the registry row and extends-or-opens the visit (above), resolving the live class via `resolveCurrentOccurrence`. This is the step that captures the straps we currently drop.
- **Enrich — scan snapshot.** In `POST /api/bridge/scan` (`src/app/api/bridge/scan/route.js`), after writing `last_seen_straps`, update `last_name` / `last_rssi` / `last_bridge_id` on the matching registry rows from the snapshot (it carries names + RSSI the samples batch doesn't).
- **Isolation.** Both calls run inside a `try { await … } catch { log + swallow }` so a recording error can never slow or fail the bridge's `200`. The bridge ack stays the authoritative fast path; detections are a side effect (same posture as the codebase's fire-and-forget convention).
- **Purity for tests.** The visit-boundary decision, registry-field merge, and link resolution are pure functions in the lib (db I/O thin around them) so they unit-test without a database.

### The tab + its API

- **Tab switch in `LiveClassClient.jsx`.** A small two-tab control at the top: **"Live board"** (the existing grid + roster + available-straps view, unchanged) and **"Detected"** (new). Tab state is local; switching does not disturb the 2 s live poll.
- **New route `GET /api/live/[locationId]/detections`.** Separate from the hot `GET /api/live/[locationId]` poll so the 2 s live path stays lean; the Detected tab polls ~10–15 s / on focus. Auth: `getCurrentUser()` + location-membership check (same guard as the existing live route). Returns registry rows enriched with:
  - **link status** — `device_key` → active `contact_devices` at the location → contact `{ id, name }`, else `null` (unlinked);
  - **live-now** — boolean, true if an open `heart_rate_sessions` row exists for the key;
  - **recent visits** — the last N `hr_detection_visits` for drill-down.
- **Tab UI.** Filter chips: **All · Unlinked only · Live now**; optional text search on name/key. Each row: name or `device_key`, protocol badge (ANT+/BLE), linked member or "Unlinked", last BPM, a "live now" dot, first-seen / last-seen, visit count → expand to visit history (with class names + times).

### Linking actions (per row)

- **"Pair for today"** (unlinked rows) → reuses `POST /api/live/[locationId]/pair` (`strap_assignments`, per-class override). No new backend logic — same call the `AvailableStrapsPanel` already makes.
- **"Remember this device"** (unlinked rows) → **new** `POST /api/live/[locationId]/register-device` → inserts a permanent `contact_devices` row (`{ contact_id, identifier: device_key, label }`, `is_active: true`), so the strap auto-routes to that member every future class with no coach action. Guarded by `getCurrentUser()` + location membership; validates the contact belongs to the location (IDOR); idempotent on `(contact_id, identifier)` (reactivate if a deactivated row exists).
- Both reuse the searchable contact picker already in `PairModal`.
- **Linked rows** show the member + a quiet **"Unregister"** that deactivates the `contact_devices` row (`is_active = false`).

## In scope

- `hr_detections` + `hr_detection_visits` tables + RLS (one migration).
- `src/lib/hr-detections.js` — `recordDetections()` (registry upsert + visit extend/open + class stamp), link resolution, pure helpers.
- Recording hooks in `/api/bridge/samples` (anchor) and `/api/bridge/scan` (enrich), best-effort.
- `GET /api/live/[locationId]/detections` (list + link status + live-now + recent visits).
- `POST /api/live/[locationId]/register-device` (permanent `contact_devices` registration) + unregister.
- "Detected" tab in `LiveClassClient.jsx` with filters, row drill-down, and both link actions.

## Out of scope (deliberate)

- **Per-second BPM persistence for unlinked straps** — we record the *fact and summary* of detection, not the full sample stream for unknown devices. (`hr_samples` continues to exist only for real sessions.)
- **Retention / prune job** — the registry is naturally bounded (only real HR devices broadcast); visits are indexed and kept indefinitely for now. A prune is a later slice if volume warrants.
- **Mobile** — web-only tab. The `/live` page + `GET /api/live` gate on **location membership** (read) and the `/pair` write on coach roles; the new routes follow the same guards. **No new permission key (the sidebar "Live HR" link's `studio_management` gate is unchanged), so no mobile-parity work.**
- **Dual-band de-duplication** — a strap broadcasting both ANT+ and BLE appears as two rows (`ant:` + `ble:`), consistent with the rest of the HR system. No cross-protocol merge.
- **New bridge/firmware behaviour** — champ-bridge already emits the data; nothing ships there.

## Data flow

```
strap broadcasts HR  →  champ-bridge  →  POST /api/bridge/samples   (every batch, ALL device_keys)
   → resolveStrapsForBatch (session routing, unchanged)
   → recordDetections(): upsert hr_detections + extend/open hr_detection_visits + stamp live class   [NEW, best-effort]

bridge scan snapshot →  POST /api/bridge/scan
   → write ble_bridges.last_seen_straps (unchanged)
   → enrich hr_detections.last_name/last_rssi/last_bridge_id   [NEW, best-effort]

coach opens /live/[locationId] → "Detected" tab
   → GET /api/live/[locationId]/detections  (registry + link status + live-now + recent visits)
   → "Pair for today"      → POST …/pair             (strap_assignments, existing)
   → "Remember this device"→ POST …/register-device   (contact_devices, NEW)
```

## Edge cases

- **Bridge `200` must stay fast/reliable** — recording is `try/await/catch-swallow`; a DB hiccup degrades to "this batch wasn't logged," never a failed ack.
- **Null BPM in a batch** — still a detection (registry `last_seen_at` updates; visit extends; `last_bpm` left unchanged).
- **Visit gap / DST** — all timestamps `timestamptz`; the 5-min gap is wall-clock-agnostic.
- **Registered strap** — still recorded (the log is a superset); the row shows its member and is filtered out of "Unlinked only."
- **Strap seen by two bridges at one location** — one registry row; `last_bridge_id` reflects the most recent; `last_seen_at` = max.
- **Race on first detection** — registry upsert keyed on `UNIQUE(location_id, device_key)` (`ON CONFLICT … DO UPDATE`) so concurrent batches can't double-insert.
- **`register-device` for a contact not at this location** — rejected (IDOR guard); deactivated prior row → reactivated rather than duplicated.

## Testing

- **Lib (pure):** visit-boundary (extend within gap vs new visit past gap), registry field-merge (don't overwrite `last_bpm` with null; advance `last_seen_at`), `visit_count` increment, link resolution (`device_key` → contact / unlinked), class-stamp via a stubbed occurrence.
- **Routes:** `GET …/detections` — auth + location scoping, link-status + live-now shaping, unknown location → 403; `register-device` — creates/reactivates `contact_devices`, validation, IDOR rejection.
- **Recording hooks:** assert `recordDetections` is invoked for matched *and* unmatched keys and that a thrown error is swallowed (bridge response unaffected). Existing `/api/bridge/samples` + `/api/bridge/scan` tests must stay green (behaviour-preserving for the ack).

## Rollout

- One migration + code; auto-deploys on merge to `crm.un1tdublin.com`. No champ-bridge/champ-app change.
- Recording begins populating the moment it deploys; the tab is empty until straps are seen (like the rest of the HR feature, it proves out on real data once classes run).
- Reversible: the feature is additive (new tables + new tab + new route); disabling = revert the PR. RLS verified via `get_advisors` post-migration.

## Open questions

1. **Visit gap constant** — 5 min assumed (one class ≈ one visit). Confirm, or make it a per-location setting later. *Default: 5 min hard-coded constant for v1.*
2. **Samples cadence assumption** — design anchors recording on the samples stream because it already reports unmatched straps. To verify (not assume) during implementation: confirm champ-bridge emits samples continuously, not only while a coach is in the pairing view. If it throttles, also record from the scan path. *Default: anchor on samples; verify before relying on it solely.*
3. **"Detected" tab default filter** — open on "Unlinked only" (the actionable set) or "All"? *Default: "All", with Unlinked/Live-now one tap away.*
