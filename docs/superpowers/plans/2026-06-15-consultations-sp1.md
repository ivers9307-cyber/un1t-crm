# Consultations SP1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a **Consultations** tab to each contact profile (notes, progress photos, goals, and a progress view incl. an InBody section that's empty until SP2), plus move the Duplicates review into a tab on the Contacts list.

**Architecture:** New schema (mig 272) for `consultations` / `consultation_photos` / `coaching_goals` / `inbody_scans` with staff + customer-self RLS (the latter for SP3). A private `consultation-photos` Storage bucket (signed-URL access). New API routes follow the repo's mutation-route skeleton. The contact page loads the data server-side, generates signed photo URLs, and renders a new tab via the existing `ContactDetailTabs`. Pure view-logic lives in a tested `consultations-view.js`.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + RLS + Storage), Vitest, Tailwind `un1t-*` tokens, `recharts` (lazy) for the InBody chart. Spec: `docs/superpowers/specs/2026-06-15-consultations-and-duplicates-tab-design.md`.

---

## File structure
- Create `supabase/migrations/272_consultations.sql` — 4 tables + RLS + indexes + the private storage bucket (file only; apply at go-live).
- Create `src/lib/consultations-view.js` (+ `.test.js`) — pure helpers (goal sort, latest scan, chart series).
- Create `src/app/api/contacts/[id]/consultations/route.js` (POST) + `…/consultations/[cid]/route.js` (PUT, DELETE) (+ tests).
- Create `src/app/api/contacts/[id]/goals/route.js` (POST) + `…/goals/[gid]/route.js` (PUT, DELETE) (+ tests).
- Create `src/app/api/contacts/[id]/consultation-photos/route.js` (POST) + `…/consultation-photos/[pid]/route.js` (DELETE) (+ test).
- Create `src/components/ContactGoalsCard.jsx`, `ConsultationsList.jsx`, `ConsultationForm.jsx`, `ProgressPhotos.jsx`, `InBodyProgress.jsx`.
- Modify `src/app/contacts/[id]/page.js` — load consultations data + signed URLs, add the gated Consultations tab.
- Modify the Contacts list page (`src/app/contacts/page.js` / `ContactsView.jsx`) — add a Contacts|Duplicates tab strip; mount `ContactDuplicatesView`. Convert `src/app/contacts/duplicates/page.js` to a redirect; remove the sidebar "Duplicates" entry.
- Modify `shared/permissions.js` (+ `scripts/check-mobile-parity.mjs`, `src/lib/openapi.js`) — `consultations` permission.

---

## Task 1: Move Duplicates into a Contacts-list tab

**Files:** Modify the Contacts list page + `ContactDuplicatesView` mount + `src/app/contacts/duplicates/page.js` + the sidebar nav array.

- [ ] **Step 1:** Read `src/app/contacts/page.js` + `src/components/ContactsView.jsx` + `src/app/contacts/duplicates/page.js` + the sidebar nav file to learn how the list page + duplicates view + nav are structured.
- [ ] **Step 2:** Add a simple tab strip at the top of the Contacts list page — **Contacts** (the existing list) and **Duplicates** (only when `hasPermission(user,'contact_linking')`). Drive it off a `?tab=duplicates` search param (server-readable) so the redirect target works. Render `ContactDuplicatesView` under the Duplicates tab (move, don't duplicate, the data-loading the standalone page did — call the same loaders).
- [ ] **Step 3:** Convert `src/app/contacts/duplicates/page.js` to `redirect('/contacts?tab=duplicates')` (server redirect).
- [ ] **Step 4:** Remove the standalone "Duplicates" entry from the sidebar nav array.
- [ ] **Step 5:** `npm run build` (route/redirect change). Commit `CONSULTATIONS — move duplicates review into a Contacts tab`.

## Task 2: Schema — mig 272

**Files:** Create `supabase/migrations/272_consultations.sql`. **Write the file only — do NOT apply (go-live applies it).** Verify 272 is the next number (271 is latest).

- [ ] **Step 1: Write the migration**

```sql
-- 272_consultations.sql — CONSULTATIONS SP1 (consultations + photos + goals + inbody_scans)
create table public.consultations (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  consulted_at timestamptz not null default now(),
  coach_id uuid references public.profiles(id),
  notes text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_consultations_contact on public.consultations(contact_id, consulted_at desc);

create table public.consultation_photos (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  consultation_id uuid references public.consultations(id) on delete set null,
  storage_path text not null,
  taken_at timestamptz not null default now(),
  label text,
  caption text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now()
);
create index idx_consultation_photos_contact on public.consultation_photos(contact_id, taken_at desc);

create table public.coaching_goals (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.contacts(id) on delete cascade,
  location_id uuid not null references public.locations(id) on delete cascade,
  title text not null,
  detail text,
  target_value text,
  target_date date,
  status text not null default 'open' check (status in ('open','achieved','dropped')),
  achieved_at timestamptz,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_coaching_goals_contact on public.coaching_goals(contact_id, status);

create table public.inbody_scans (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references public.contacts(id) on delete set null,
  location_id uuid not null references public.locations(id) on delete cascade,
  source text not null default 'lookinbody',
  external_id text,
  scanned_at timestamptz not null,
  weight_kg numeric, pbf_percent numeric, smm_kg numeric, bmi numeric,
  bmr numeric, body_fat_mass_kg numeric, inbody_score numeric,
  matched_phone text,
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (source, external_id)
);
create index idx_inbody_scans_contact on public.inbody_scans(contact_id, scanned_at desc);

-- RLS: staff in-location (read+write via authenticated is N/A — writes are service-role) + customer-self read.
alter table public.consultations enable row level security;
alter table public.consultation_photos enable row level security;
alter table public.coaching_goals enable row level security;
alter table public.inbody_scans enable row level security;

-- staff in-location (mirrors existing data tables)
create policy consultations_loc on public.consultations for all to authenticated
  using (private.auth_is_in_location(location_id)) with check (private.auth_is_in_location(location_id));
create policy consultation_photos_loc on public.consultation_photos for all to authenticated
  using (private.auth_is_in_location(location_id)) with check (private.auth_is_in_location(location_id));
create policy coaching_goals_loc on public.coaching_goals for all to authenticated
  using (private.auth_is_in_location(location_id)) with check (private.auth_is_in_location(location_id));
create policy inbody_scans_loc on public.inbody_scans for all to authenticated
  using (private.auth_is_in_location(location_id)) with check (private.auth_is_in_location(location_id));

-- customer-self read (champ-app, SP3) — goals + photos + scans shared; NOT consultation notes.
create policy coaching_goals_self on public.coaching_goals for select to public
  using (contact_id = private.auth_contact_id());
create policy consultation_photos_self on public.consultation_photos for select to public
  using (contact_id = private.auth_contact_id());
create policy inbody_scans_self on public.inbody_scans for select to public
  using (contact_id = private.auth_contact_id());

-- Private storage bucket for progress photos (signed-URL access only).
insert into storage.buckets (id, name, public) values ('consultation-photos','consultation-photos', false)
  on conflict (id) do nothing;
```

- [ ] **Step 2:** Verify against repo conventions (compare to mig 270/271: `private.auth_is_in_location`, `private.auth_contact_id` exists from mig 110, lowercase, forward-only). Confirm `storage.buckets` insert is the pattern used elsewhere (grep migrations for `storage.buckets`; if the repo creates buckets a different way, match it). Adjust + note any change.
- [ ] **Step 3:** Commit `CONSULTATIONS — schema (consultations/photos/goals/inbody_scans + bucket, mig 272)` noting NOT applied.

## Task 3: Pure view helpers

**Files:** Create `src/lib/consultations-view.js` + `.test.js`. TDD.

- [ ] **Step 1: Failing tests**

```js
import { describe, it, expect } from 'vitest'
import { sortGoals, latestScan, scanSeries } from './consultations-view'

describe('sortGoals', () => {
  it('orders open first, then by created_at desc within status', () => {
    const g = [
      { id: 'a', status: 'achieved', created_at: '2026-01-01' },
      { id: 'b', status: 'open', created_at: '2026-02-01' },
      { id: 'c', status: 'open', created_at: '2026-03-01' },
    ]
    expect(sortGoals(g).map((x) => x.id)).toEqual(['c', 'b', 'a'])
  })
})

describe('latestScan', () => {
  it('returns the most recent by scanned_at, null when empty', () => {
    expect(latestScan([])).toBeNull()
    const s = [{ scanned_at: '2024-01-01', weight_kg: 80 }, { scanned_at: '2026-06-01', weight_kg: 75 }]
    expect(latestScan(s).weight_kg).toBe(75)
  })
})

describe('scanSeries', () => {
  it('builds an ascending {x,y} series for a metric, skipping null y', () => {
    const s = [
      { scanned_at: '2026-06-01', pbf_percent: 22 },
      { scanned_at: '2026-01-01', pbf_percent: null },
      { scanned_at: '2026-03-01', pbf_percent: 25 },
    ]
    expect(scanSeries(s, 'pbf_percent')).toEqual([
      { x: '2026-03-01', y: 25 },
      { x: '2026-06-01', y: 22 },
    ])
  })
})
```

- [ ] **Step 2:** Run → fail. **Step 3: Implement**

```js
// src/lib/consultations-view.js — pure view helpers for the Consultations tab
const STATUS_RANK = { open: 0, achieved: 1, dropped: 2 }
export function sortGoals(goals) {
  return [...(goals || [])].sort((a, b) => {
    const r = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9)
    if (r !== 0) return r
    return String(b.created_at || '').localeCompare(String(a.created_at || ''))
  })
}
export function latestScan(scans) {
  if (!scans || scans.length === 0) return null
  return [...scans].sort((a, b) => String(b.scanned_at).localeCompare(String(a.scanned_at)))[0]
}
export function scanSeries(scans, metric) {
  return (scans || [])
    .filter((s) => s[metric] != null)
    .map((s) => ({ x: s.scanned_at, y: Number(s[metric]) }))
    .sort((a, b) => String(a.x).localeCompare(String(b.x)))
}
```

- [ ] **Step 4:** Run → pass. **Step 5:** Commit `CONSULTATIONS — pure view helpers (sortGoals/latestScan/scanSeries)`.

## Task 4: Goals API

**Files:** Create `src/app/api/contacts/[id]/goals/route.js` (POST) + `…/goals/[gid]/route.js` (PUT, DELETE) + tests. Follow the mutation-route skeleton (`getCurrentUser`, `hasPermission(user,'consultations')` → 403, load contact for `location_id`, `assertLocationAccess`, `validateBody`, `createServerClient`, `{success,data}`). Read an existing contact subroute (e.g. `src/app/api/contacts/[id]/link/route.js`) for the exact pattern.

- [ ] **Step 1:** TDD tests (mock getCurrentUser + db, mirror `link/route.test.js`): POST creates a goal (`{title}` required; optional detail/target_value/target_date) with `contact_id`/`location_id`/`created_by` set; PUT updates fields incl. status→'achieved' stamps `achieved_at`; DELETE removes; non-permission → 403; missing contact → 404; cross-location → guarded.
- [ ] **Step 2:** Implement. Zod: `{ title: z.string().min(1), detail: z.string().optional(), target_value: z.string().optional(), target_date: isoDate.optional(), status: z.enum(['open','achieved','dropped']).optional() }`. On status='achieved' set `achieved_at = now-iso` (clear it otherwise). 
- [ ] **Step 3:** Tests pass. Register in `openapi.js`. Commit `CONSULTATIONS — goals API`.

## Task 5: Consultations API

**Files:** Create `src/app/api/contacts/[id]/consultations/route.js` (POST) + `…/consultations/[cid]/route.js` (PUT, DELETE) + tests. Same skeleton as Task 4.

- [ ] **Step 1:** TDD: POST creates a consultation (`consulted_at` default now, `coach_id` default current user, `notes`) with contact/location/created_by; PUT edits consulted_at/coach_id/notes; DELETE removes; 403 without `consultations` perm; 404 missing contact.
- [ ] **Step 2:** Implement. Zod: `{ consulted_at: isoDate.optional(), coach_id: uuidLike.optional(), notes: z.string().optional() }` (coach_id defaults to `user.id`).
- [ ] **Step 3:** Tests pass. Register in `openapi.js`. Commit `CONSULTATIONS — consultations API`.

## Task 6: Progress-photos API

**Files:** Create `src/app/api/contacts/[id]/consultation-photos/route.js` (POST multipart) + `…/[pid]/route.js` (DELETE) + test.

- [ ] **Step 1:** TDD (mock db + a stubbed storage client): POST validates content-type (image/*) + size (≤ ~10MB), uploads to `consultation-photos` at `consultations/<contactId>/<uuid>.<ext>` via the service-role client, inserts a `consultation_photos` row (storage_path, taken_at, optional label/caption/consultation_id, created_by); on storage failure returns 400 and inserts nothing. DELETE removes the row + best-effort removes the object. 403 without perm.
- [ ] **Step 2:** Implement. Read the request as `formData()`; pull `file` + optional fields. Use `createServerClient().storage.from('consultation-photos')`. (Read `car-documents` upload code for the exact storage API usage + signed-URL generation.) `export const runtime = 'nodejs'`.
- [ ] **Step 3:** Tests pass. Register in `openapi.js`. Commit `CONSULTATIONS — progress-photos upload/delete API`.

## Task 7: Permission + parity

**Files:** Modify `shared/permissions.js` + `scripts/check-mobile-parity.mjs`.

- [ ] **Step 1:** Add `consultations` to `WEB_PERMISSIONS` (label "Consultations") + `DEFAULT_WEB_PERMISSIONS_BY_ROLE` (master/owner/manager/head_coach → true; staff → false). Add to `WEB_ONLY_OK` in `check-mobile-parity.mjs` (reason: "coach/web surface; member-facing equivalent is champ-app (SP3), not the staff mobile app").
- [ ] **Step 2:** `npm run check:mobile-parity` clean; permissions tests pass. Commit `CONSULTATIONS — consultations permission + parity`.

## Task 8: Components

**Files:** Create the 5 components. Compose `@/components/ui`, `un1t-*` tokens, `-700` status ramp, `type="button"` on non-submit buttons. Read `ContactGoalsCard`-adjacent existing cards + `MembershipTrendChart.jsx` (lazy recharts) for patterns.

- [ ] **Step 1: `ContactGoalsCard.jsx`** ('use client', props `{ contactId, goals }`) — render `sortGoals(goals)`; add-goal form; per-goal edit + Achieve/Drop buttons → the goals API; `router.refresh()` on success; inline errors.
- [ ] **Step 2: `ConsultationForm.jsx`** ('use client') — new/edit a consultation (date, coach select [staff list passed in or current user], notes textarea labelled *Staff-internal*) → consultations API.
- [ ] **Step 3: `ConsultationsList.jsx`** ('use client', props `{ contactId, consultations, coaches }`) — newest-first list (date, coach name, notes) with edit/delete + a "New consultation" trigger rendering `ConsultationForm`.
- [ ] **Step 4: `ProgressPhotos.jsx`** ('use client', props `{ contactId, photos }` where each photo has a pre-signed `url`) — chronological gallery (thumbnails) + an upload control (file + optional label/caption) → photos API; delete; `router.refresh()`.
- [ ] **Step 5: `InBodyProgress.jsx`** ('use client', props `{ scans }`) — if `scans.length`: latest headline (`latestScan`) + lazy line charts (`scanSeries(scans, metric)` for weight_kg / pbf_percent / smm_kg); else a muted empty state "InBody not connected — scans appear here once the integration is set up." (No fetching; data comes from the page.)
- [ ] **Step 6:** `npx eslint` the new components clean. Commit `CONSULTATIONS — tab components`.

## Task 9: Wire the Consultations tab

**Files:** Modify `src/app/contacts/[id]/page.js`.

- [ ] **Step 1:** In the page server load, when `hasPermission(user,'consultations')`, fetch (service-role): `consultations` (+ join coach name or pass the location staff list), `coaching_goals`, `consultation_photos` (then generate a short-lived **signed URL** per photo via `storage.from('consultation-photos').createSignedUrl(path, 600)`), and `inbody_scans` — all for `contact.id`, newest-first, paginated per the 1k rule if needed.
- [ ] **Step 2:** Build a `consultationsTab` node (GoalsCard + ConsultationsList + ProgressPhotos + InBodyProgress) and add `{ id:'consultations', label:'Consultations', content: consultationsTab }` to the `ContactDetailTabs` array — only when the permission is held (else omit the tab).
- [ ] **Step 3:** `npm run build` (page + new imports). Commit `CONSULTATIONS — Consultations tab on the contact profile`.

## Task 10: Ship
- [ ] Full CI mirror: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run build`.
- [ ] Final holistic review (RLS correctness on the 4 tables, customer-self policies, IDOR on the routes, signed-URL handling, no large `.in()`).
- [ ] PR to main. **Apply mig 272 to prod (confirmed) before merge** (additive; 4 tables + bucket). Do not merge without operator say-so.

---

## Self-review
- **Spec coverage:** consultations notes ✓ (Task 5, staff-internal); photos ✓ (Task 6, private bucket + signed URLs); goals ✓ (Task 4, shared via RLS); InBody table + empty section ✓ (Task 2 schema, Task 8 InBodyProgress); progress view ✓ (Task 9); customer-self RLS for SP3 ✓ (Task 2); duplicates→tab ✓ (Task 1); permission ✓ (Task 7).
- **Placeholder scan:** logic-bearing tasks (2,3,4) have full code; routes give Zod + key logic referencing the established skeleton + a sibling route to copy (acceptable in this codebase); components give contracts + behaviour referencing existing patterns (the repo doesn't unit-test React — `next build` + the pure helpers are the gates).
- **Consistency:** field names (`consulted_at`, `coach_id`, `pbf_percent`, `smm_kg`, `weight_kg`, `scanned_at`, `status`) consistent across schema/helpers/components; `consultations` permission key consistent; helpers `sortGoals`/`latestScan`/`scanSeries` used as defined.
- **Deferred:** InBody sync (SP2) writes `inbody_scans`; champ-app (SP3) reads via the customer-self policies. Both are separate specs/plans.
