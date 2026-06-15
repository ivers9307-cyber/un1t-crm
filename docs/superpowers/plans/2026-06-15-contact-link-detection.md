# Contact Link Detection (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Automatically surface duplicate-contact candidates, auto-link the high-confidence ones, and give operators a review queue for the rest — building on the Phase 1 link layer.

**Architecture:** A pure matcher (`person-match.js`) computes candidate links from `contacts` (phone clusters for real↔real, name matches for ClassPass↔real); a dry-run→commit detection route persists candidates to `person_link_suggestions` (mig 271) and auto-links HIGH-confidence ones via the Phase 1 `person-links` helpers; a `/contacts/duplicates` review queue lets operators confirm/dismiss the rest (dismissals are remembered so they never re-suggest).

**Tech Stack:** Next.js 16 App Router, Supabase + RLS, Vitest. Builds directly on Phase 1 (`person-links.js`, `person-aggregate.js`, `/api/contacts/[id]/link`, mig 270 — all merged in #533).

---

## Locked decisions carried in

- **Auto-link HIGH confidence only**; medium/low → review queue.
- **High-confidence rules:** real↔real = same normalised phone AND same normalised name AND that phone shared by exactly 2 contacts; ClassPass↔real = ClassPass contact whose normalised name matches **exactly one** non-classpass contact. Everything else → review.
- **Name is the ClassPass key** (phone is a shared placeholder — exclude it).
- **Safety:** the bulk first run is **dry-run → commit** (mirrors the arrears tool) so the operator reviews the ~316-cluster backlog before any prod mutation. No nightly cron in this PR — added as a small follow-up once the backlog is reviewed and the operator is comfortable with the auto-link volume.

## Audit numbers (Stillorgan)
0 email dupes; **316 real↔real phone clusters**; ~1,560 ClassPass shadows on **one placeholder phone** (the biggest "cluster" = 1,569). → exclude any phone shared by more than a threshold (placeholder) from phone clustering; match ClassPass on name only.

---

## File structure
- Create `supabase/migrations/271_person_link_suggestions.sql` — suggestions table + RLS (write only; apply at go-live).
- Create `src/lib/person-match.js` + `src/lib/person-match.test.js` — pure matchers + confidence.
- Create `src/lib/person-detect.js` + `src/lib/person-detect.test.js` — the detection runner (pure-ish core: takes loaded rows, returns the plan of suggestions + auto-links; IO wrapper persists).
- Create `src/app/api/contacts/duplicates/detect/route.js` (+ test) — dry-run→commit.
- Create `src/app/api/contacts/duplicates/[id]/route.js` (+ test) — PATCH confirm/dismiss a suggestion.
- Create `src/app/contacts/duplicates/page.js` + `src/components/ContactDuplicatesView.jsx` — review queue UI.
- Modify the sidebar nav array to add a "Duplicates" entry under Contacts (gated by `contact_linking`).
- Modify `src/lib/openapi.js` — register the two new routes.

---

## Task 1: Suggestions table (mig 271)

**Files:** Create `supabase/migrations/271_person_link_suggestions.sql`. **Write the file only — do NOT apply (go-live applies it with operator confirm).**

```sql
-- 271_person_link_suggestions.sql — duplicate-contact detection queue (PERSON-LINK.2)
create table public.person_link_suggestions (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  -- canonical ordering: contact_id_a < contact_id_b (enforced by the writer) so the
  -- unique constraint dedupes A↔B and B↔A to one row.
  contact_id_a uuid not null references public.contacts(id) on delete cascade,
  contact_id_b uuid not null references public.contacts(id) on delete cascade,
  match_method text not null check (match_method in ('phone','name','email','manual')),
  confidence text not null check (confidence in ('high','medium','low')),
  reason text,
  status text not null default 'pending' check (status in ('pending','linked','dismissed')),
  decided_by uuid references public.profiles(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (contact_id_a, contact_id_b)
);
create index idx_pls_location_status on public.person_link_suggestions(location_id, status);

alter table public.person_link_suggestions enable row level security;
create policy pls_loc on public.person_link_suggestions for all to authenticated
  using (private.auth_is_in_location(location_id)) with check (private.auth_is_in_location(location_id));
```

- [ ] Write the file. Verify 271 is the next free number. Verify it matches mig 270's conventions (RLS predicate, lowercase, forward-only). Commit `PERSON-LINK.2 — person_link_suggestions table (mig 271)` noting NOT applied.

## Task 2: Pure matchers — `person-match.js`

**Files:** Create `src/lib/person-match.js` + `.test.js`. Import `normalisePhone9`, `normaliseName` from `./person-links` (do NOT re-implement). TDD.

Contract:
- `CLASSPASS_STATUS = 'classpass_payg'`; `isClassPass(c)` = `c.glofox_membership_status === CLASSPASS_STATUS`.
- `placeholderPhones(contacts, { threshold = 10 })` → `Set` of normalised phones shared by **more than** `threshold` contacts (the ClassPass shared number is ~1,569 → caught). These are excluded from phone clustering.
- `detectCandidates(contacts, { dismissedPairKeys = Set, groupedContactIds = Set })` → array of `{ aId, bId, method, confidence, reason }` (with `aId < bId` canonical order), where:
  - **Phone (real↔real):** group **non-classpass** contacts by `normalisePhone9(phone || wa_phone)`, excluding placeholder phones and null/short numbers. For each cluster:
    - size exactly 2 AND same `normaliseName` → `confidence:'high', method:'phone'`.
    - size exactly 2, names differ → `confidence:'medium', method:'phone'` (reason: "Same phone, different name").
    - size ≥ 3 → emit each adjacent/representative pair at `confidence:'low', method:'phone'` (reason: "Phone shared by N accounts") — ambiguous, never auto-linked.
  - **Name (ClassPass↔real):** index non-classpass contacts by `normaliseName`. For each ClassPass contact with a non-empty normalised name:
    - exactly 1 non-classpass name match → `confidence:'high', method:'name'`.
    - ≥ 2 matches → emit each at `confidence:'medium', method:'name'` (reason: "Name matches N members").
    - 0 → no candidate.
  - Skip any pair whose canonical key (`\`${aId}:${bId}\``) is in `dismissedPairKeys`, or where both ids are already in the SAME existing group (pass `groupedContactIds` plus a same-group check — simplest: skip if either id is already grouped AND linking is redundant; for Phase 2 skip a pair if BOTH ids are already grouped together — represent existing groups as a Set of canonical pair keys, or just skip pairs where either id is grouped and rely on the link route's idempotency. Choose the simplest correct approach and test it).
  - Dedupe the output by canonical pair key (a pair found by both phone and name keeps the higher confidence).

Tests must cover: a 2-cluster same-name → high; 2-cluster diff-name → medium; 3+ cluster → low; classpass unique-name → high; classpass ambiguous-name → medium; placeholder phone excluded; dismissed pair skipped; classpass↔classpass never paired by name (only classpass↔real).

- [ ] Write failing tests → implement → green → commit `PERSON-LINK.2 — person-match candidate detection + confidence`.

## Task 3: Detection runner + route (dry-run → commit)

**Files:** Create `src/lib/person-detect.js` + `.test.js` and `src/app/api/contacts/duplicates/detect/route.js` + `.test.js`.

`person-detect.js`:
- `planDetection({ contacts, existingSuggestions, groups })` (pure) → `{ candidates, autoLink, review }` where `autoLink` = HIGH candidates not already linked/dismissed, `review` = medium/low not already present. Uses `person-match.detectCandidates`. Builds `dismissedPairKeys` from existingSuggestions with status in ('dismissed','linked').
- `runDetection(db, { locationId, commit })` (IO):
  - paginate-load contacts for the location (id, name, first_name, last_name, phone, wa_phone, glofox_membership_status, person_group_id) per the 1k-cap rule.
  - load existing `person_link_suggestions` for the location + existing `person_group_members` (to know grouped ids).
  - `planDetection(...)`.
  - **dry-run (default):** return `{ counts: { high, medium, low }, autoLinkCount, sample: [...first 25...] }` — write nothing.
  - **commit:** upsert all candidates into `person_link_suggestions` (canonical order, `on conflict (contact_id_a,contact_id_b) do nothing` so dismissed/linked stay); then for each HIGH `autoLink` candidate, link via Phase 1 `createGroup`/`addToGroup` (method/confidence from the candidate) and set that suggestion's status='linked', decided_by=actor. Return the counts + how many were auto-linked.

Route `POST /api/contacts/duplicates/detect` — master/manager + `hasPermission(user,'contact_linking')`; `assertLocationAccess`; `?commit=true` to write; standard response shape. Body/query: `location_id` (default active).

- [ ] TDD `person-detect.js` (mock db): dry-run writes nothing + returns counts; commit upserts suggestions and auto-links HIGH via the person-links helpers; dismissed pairs are not re-created; already-grouped pairs are skipped.
- [ ] TDD the route: dry-run vs commit, permission 403, cross-location guard.
- [ ] Commit `PERSON-LINK.2 — detection runner + dry-run/commit route`.

## Task 4: Review queue UI + confirm/dismiss

**Files:** Create `src/app/contacts/duplicates/page.js` (server) + `src/components/ContactDuplicatesView.jsx` ('use client') + `src/app/api/contacts/duplicates/[id]/route.js` (PATCH) + test. Modify the sidebar nav + `openapi.js`.

- Page: master/manager-gated; loads `pending` suggestions for the active location joined to both contacts' display fields (name/email/phone/status); renders `ContactDuplicatesView`.
- `ContactDuplicatesView`: a table of pending suggestions — two contacts side by side, confidence chip, reason; **Confirm** → `POST /api/contacts/{aId}/link` `{ otherContactId: bId }` (reuse Phase 1) then PATCH the suggestion status='linked'; **Dismiss** → PATCH status='dismissed'. `router.refresh()` after each. A "Run detection" button hits `/api/contacts/duplicates/detect?commit=true` (with a dry-run preview first showing counts).
- PATCH route `/api/contacts/duplicates/[id]`: master/manager + `contact_linking`; body `{ status: 'linked'|'dismissed' }`; assertLocationAccess via the suggestion's location; stamps decided_by/decided_at.
- Sidebar: add a "Duplicates" link under Contacts gated by `contact_linking` (match the existing sidebar array shape; if a count badge is trivial, show pending count, else skip).

- [ ] Build the PATCH route + test (TDD). Build the page + view. Add sidebar entry. Register routes in openapi.js.
- [ ] `npm run build` green. Commit `PERSON-LINK.2 — duplicates review queue + confirm/dismiss`.

## Task 5: Ship
- [ ] Full CI mirror + `next build` + verify no internal `<a href>`. Final holistic review. Open PR (do NOT apply mig 271 / merge without operator confirm). At go-live: apply mig 271, merge, then run the detection **dry-run** and show the operator the counts before they trigger the **commit** (the bulk auto-link).

---

## Self-review
- Coverage: detection (phone + name) ✓; auto-link HIGH only ✓; review queue confirm/dismiss with remembered dismissals ✓; placeholder-phone exclusion ✓; name-key for ClassPass ✓; dry-run→commit safety ✓; reuses Phase 1 link layer (no destructive merge) ✓.
- Deferred: nightly cron (follow-up after backlog reviewed); outreach dedup (Phase 3).
- Risk: the commit auto-links in bulk — gated behind dry-run preview + explicit `?commit=true`, operator-reviewed, and every link is reversible via the Phase 1 unlink (non-destructive).
