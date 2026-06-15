# Consultations + Duplicates-tab — Design (SP1)

**Status:** approved 2026-06-15. This spec covers **Sub-Project 1** (CRM Consultations core + the shared data model + moving Duplicates into a Contacts tab). SP2 (InBody sync) and SP3 (champ-app customer view) are scoped at the end and get their own specs.

**Goal:** Give each contact profile a **Consultations** tab for recording 1:1 consultation notes, progress photos, and goals — plus a progress lookback (photo timeline + goals + InBody metric charts). Keep the contacts area clean by moving the existing duplicate-review surface into a tab on the Contacts list.

## Decomposition (one data model, three builds)
- **SP1 (this spec, now):** schema (mig 272) + Consultations tab (notes, photos, goals, staff progress view) + Duplicates → Contacts-list tab. InBody section renders but is empty until SP2.
- **SP2 (next):** Lookin'Body Web API client + per-location credential config + backfill/sync into `inbody_scans` + the metric charts populated. Built credential-gated (dark until configured).
- **SP3 (after):** champ-app surface where the member sees their own goals, photos, and InBody charts (shared notes only).

The **data model + RLS are built in full now** so SP2/SP3 only read/write existing tables.

---

## Shared data model (mig 272)

All tables: `location_id uuid not null references locations` + RLS with **two** read paths — staff in-location (`private.auth_is_in_location(location_id)`) **and** customer-self (`contact_id = private.auth_contact_id()`, the champ-app helper from mig 110). Writes are service-role only (API routes). This mirrors the heart-rate tables.

### `consultations`
One row per 1:1 session.
- `id uuid pk`, `contact_id uuid not null → contacts`, `location_id uuid not null → locations`
- `consulted_at timestamptz not null default now()` — when the consultation happened (editable)
- `coach_id uuid → profiles` — the staff member who ran it
- `notes text` — **staff-internal** coaching notes (NOT exposed to the customer view in SP3)
- `created_by uuid → profiles`, `created_at`, `updated_at`
- index `(contact_id, consulted_at desc)`

### `consultation_photos`
Progress photos. Tied to the contact + a date; optionally to a consultation.
- `id uuid pk`, `contact_id uuid not null → contacts`, `location_id uuid not null`
- `consultation_id uuid → consultations on delete set null` (optional link)
- `storage_path text not null` — object key in the private `consultation-photos` bucket
- `taken_at timestamptz not null default now()`, `label text` (optional, e.g. "front"/"side"/"back"), `caption text`
- `created_by`, `created_at`
- index `(contact_id, taken_at desc)`
- **Shared to the customer view in SP3** (a member sees their own photos).

### `coaching_goals`
Persistent goals on the contact, reviewed/updated at consultations.
- `id uuid pk`, `contact_id uuid not null → contacts`, `location_id uuid not null`
- `title text not null`, `detail text`
- `target_value text` (free text — "75kg", "5k under 25min"), `target_date date`
- `status text not null default 'open' check (status in ('open','achieved','dropped'))`
- `achieved_at timestamptz`, `created_by`, `created_at`, `updated_at`
- index `(contact_id, status)`
- **Shared to the customer view in SP3.**

### `inbody_scans` (schema now; populated by SP2)
Body-composition scans **synced from Lookin'Body into our DB** (we own the timeline).
- `id uuid pk`, `contact_id uuid → contacts` (nullable — a scan may arrive before it's matched), `location_id uuid not null`
- `source text not null default 'lookinbody'`, `external_id text` — the Lookin'Body record id (for dedupe)
- `scanned_at timestamptz not null`
- extracted headline metrics (nullable numerics): `weight_kg`, `pbf_percent` (percent body fat), `smm_kg` (skeletal muscle mass), `bmi`, `bmr`, `body_fat_mass_kg`, `inbody_score`
- `matched_phone text` — the normalised phone used to match (audit)
- `raw jsonb` — the full scan payload (so we never lose a field)
- `created_at`
- **unique `(source, external_id)`** for idempotent sync; index `(contact_id, scanned_at desc)`
- (Exact Lookin'Body field names are confirmed against the live API in SP2; `raw` guarantees nothing is lost in the meantime.)

### InBody per-location config (no table — SP2)
Lives on `locations.settings.inbody` JSONB (`{ enabled, account, api_key, base_url }`, EU `apieur.lookinbody.com`), mirroring `settings.unifi`/`settings.glofox`. Absent/disabled → the Consultations tab's InBody section shows "InBody not connected".

### Storage
New **private** bucket `consultation-photos`. Object key `consultations/<contact_id>/<uuid>.<ext>`. Access via short-lived **signed URLs** only (the `car-documents` pattern) — staff via an API route now; the member via a champ-app route in SP3.

---

## SP1 deliverables

### 1. Duplicates → Contacts-list tab (quick reorg, first)
- Today: standalone page `src/app/contacts/duplicates/page.js` + `ContactDuplicatesView.jsx` + a sidebar "Duplicates" entry.
- Change: surface the duplicate-review UI as a **tab on the Contacts list page** (`/contacts`, `ContactsView.jsx`) — e.g. a "Contacts | Duplicates" tab strip at the top. Retire the standalone route to a redirect (→ `/contacts?tab=duplicates`) and remove the separate sidebar entry. Keep the `contact_linking` permission gate (tab hidden without it). No logic change to detection/Scan/Apply — only where the UI is mounted.

### 2. Consultations tab on the contact profile
A 5th tab in `ContactDetailTabs` on `src/app/contacts/[id]/page.js` (after Overview/Activity/Comms/Admin), gated by a new `consultations` permission. The tab contains:

- **Goals card** — list `coaching_goals` (open first, then achieved/dropped); add/edit/achieve/drop. Each: title, optional target + target date, status.
- **Consultations timeline** — list `consultations` newest-first; "New consultation" (date, coach defaulting to the current user, notes) + edit/delete own. Notes labelled *staff-internal*.
- **Progress photos** — chronological gallery from `consultation_photos` (signed-URL thumbnails); upload (drag/drop or picker) with optional label/caption + taken_at, optionally attached to a consultation. Before/after friendly (group by label or show side-by-side first/latest).
- **InBody section** — when `inbody_scans` exist for the contact: latest scan headline (weight / PBF / SMM / score) + a small line chart of each metric over `scanned_at` (reuse the lazy-loaded `recharts` pattern from `MembershipTrendChart`). When none / not configured: a muted "InBody not connected" (or "no scans yet") placeholder. (Data arrives in SP2.)

Component breakdown (compose `@/components/ui`, `un1t-*` tokens):
- `ConsultationsTab.jsx` (server-fed container) → `ConsultationsList.jsx`, `ConsultationForm.jsx` (client), `ContactGoalsCard.jsx` (client), `ProgressPhotos.jsx` (client, upload + gallery), `InBodyProgress.jsx` (client chart; empty-state until SP2).
- Pure helpers (tested): formatting + the chart-series shaping in a `consultations-view.js` (e.g. build `{metric → [{x:scanned_at,y}]}` from scans; latest-scan extraction).

### 3. API routes (mutation-route skeleton, `consultations` permission + `assertLocationAccess`, `{success,data}`)
- `consultations`: `POST /api/contacts/[id]/consultations` (create), `PUT/DELETE /api/contacts/[id]/consultations/[cid]`.
- `goals`: `POST /api/contacts/[id]/goals`, `PUT/DELETE …/goals/[gid]`.
- `photos`: `POST /api/contacts/[id]/consultation-photos` (multipart → upload to bucket + insert row), `DELETE …/[pid]` (delete row + object), and a signed-URL read (either return signed URLs in the page's server load, or a `GET …/[pid]/url`). Prefer generating signed URLs server-side in the page load to avoid an extra route.
- Register all in `src/lib/openapi.js`.

### 4. Permission + parity
- New `consultations` web permission in `shared/permissions.js` + `DEFAULT_WEB_PERMISSIONS_BY_ROLE` (on for owner/manager/head_coach + master; off for staff — operators enable per-coach via the per-location override). Add to `WEB_ONLY_OK` in `check-mobile-parity.mjs` (reason: "consultations are a web/coach surface; member-facing equivalent is champ-app, not the staff mobile app") OR a mobile counterpart later — web-only for now.

### Error handling / conventions
- Photo upload: validate content-type + size; on storage failure return a clean 400 and don't insert the row. Deleting a photo removes the object best-effort then the row.
- Fire-and-forget nothing critical; all writes are awaited with the standard shape.
- Customer-self RLS is defence-in-depth; API routes still `assertLocationAccess` (service-role bypasses RLS).

### Testing
- Pure helpers in `consultations-view.js` (chart-series shaping, latest-scan, goal sorting) — unit tested.
- Route tests (mock getCurrentUser + db) for create/edit/delete consultations + goals + photo insert; permission 403; cross-location guard.
- `next build` (new tab + components + routes).

---

## SP2 — InBody sync (own spec later)
`src/lib/inbody.js` Lookin'Body Web client (EU base, `API-KEY` + `Account` headers, lookup by `UserToken`=phone). Per-location config UI at Settings → Integrations (like `XeroLocationCard`). A backfill/sync (on-demand "Refresh InBody" + optional daily cron) that, for each contact with a real phone (via the person-group — skip the ClassPass placeholder), pulls scan history and upserts `inbody_scans` (dedupe on `(source, external_id)`). Then `InBodyProgress` lights up. Confirm exact endpoint paths + response field names against the live authenticated API docs at connect time.

## SP3 — champ-app customer view (own spec later)
In champ-app: a "My Progress" surface reading the member's own `coaching_goals` (shared), `consultation_photos` (own, via signed URLs), and `inbody_scans` (own) through customer-self RLS. Consultation **notes are NOT shown** (staff-internal) unless a future per-note "share" flag is added. Decide photo-consent copy there.

---

## Self-review
- **Placeholders:** none — every SP1 table/column/route/component is concrete; InBody field names flagged as confirm-in-SP2 with `raw` JSONB as the safety net.
- **Consistency:** notes staff-internal (consultations.notes, not in SP3) vs goals/photos shared (RLS customer-self) — matches the locked decisions. InBody synced-into-DB (own data) — matches.
- **Scope:** SP1 is one coherent plan (schema + one tab + one reorg). SP2/SP3 are separate. Good.
- **Ambiguity:** "progress" = photos + goals + InBody charts (notes are record-only, not "progress"). Goal = persistent on contact (not per-consultation snapshot). Photo = contact+date (consultation link optional). All made explicit above.
