# Contact Identity Linking ("Person" view) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the CRM recognise that one real person owns several Glofox/ClassPass `contacts` rows and present them as a single de-cluttered profile — without deleting any account (Glofox re-creates deletions on sync).

**Architecture:** A non-destructive **grouping layer** over `contacts` (two new tables + one denormalised column). Each account keeps its own row, invoices, bookings; a `person_group` ties them with one `primary_contact_id`. Read-side aggregation powers a redesigned contact page; a detection job proposes/auto-links matches; outreach collapses a group to its primary. Deliberately NOT the existing destructive `mergeContacts()` (it deletes the loser → next Glofox sync resurrects it).

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres + RLS), Vitest (pure-helper TDD), Tailwind (`un1t-*` tokens). Conventions per `un1t-crm/CLAUDE.md`.

---

## Audit findings that shape this (Stillorgan, 8,264 contacts)

- **Email duplicates: 0** — email is effectively unique; ignore as a match key.
- **Real↔real phone duplicates: 316 clusters / ~700 real contacts** — genuine same-person-multi-account. Match key = **normalised phone (last 9)**, excluding ClassPass.
- **ClassPass shadows: ~1,560** (`glofox_membership_status='classpass_payg'`, `@members.classpass.com` emails). All ~1,560 share **one placeholder phone** (a single 1,569-row "cluster") → **phone is useless for ClassPass**; match key = **name**. Many shadows have no real account and must stay standalone.

## Locked decisions (from Richard, 2026-06-15)

1. **Auto-link only high-confidence** matches; everything else → review queue.
2. **Unified view lives on the existing contact page**, which gets a **streamlining redesign** (it currently stacks ~10 always-open cards).
3. **Outreach dedups to the primary** linked account (Phase 3 in scope).
4. **Name is the ClassPass↔real key** (review-gated), since phone is a placeholder.

## High-confidence (auto-link) definition

- **Real↔real:** normalised phone matches **AND** normalised `first+last` name matches, and the phone is shared by exactly 2 contacts. (Phone-only, or phone shared by 3+, → review.)
- **ClassPass↔real:** normalised `first+last` matches **exactly one** non-classpass contact at the location (unambiguous 1:1). (Name matches 0 or ≥2 → standalone or review.)
- Everything else → `person_link_suggestions` review queue. Never auto-link on phone-only or fuzzy name.

---

## File structure

**Phase 1 — link layer + redesigned view (this plan, fully detailed):**
- Create `supabase/migrations/270_person_groups.sql` — 2 tables + `contacts.person_group_id` denorm column + trigger + RLS.
- Create `src/lib/person-links.js` — pure `pickPrimary()`, `normalisePhone9()`, `normaliseName()`; IO `createGroup/addToGroup/removeFromGroup/setPrimary/getPersonGroup`.
- Create `src/lib/person-links.test.js` — pure-helper tests.
- Create `src/lib/person-aggregate.js` — `aggregatePerson(db, groupId)` → unified read-model (emails, phones, memberships, arrears, attendance, deals, timeline, each tagged with source contact_id).
- Create `src/lib/person-aggregate.test.js`.
- Create `src/app/api/contacts/[id]/link/route.js` — POST link / DELETE unlink / (POST set-primary via `?action=`).
- Create `src/app/api/contacts/[id]/link/route.test.js`.
- Create `src/components/PersonHeader.jsx`, `src/components/LinkedAccountsCard.jsx`, `src/components/ContactDetailTabs.jsx`, `src/components/LinkAccountModal.jsx`.
- Modify `src/app/contacts/[id]/page.js` — redesign: header + tabbed body, fed by `aggregatePerson` when grouped.
- Modify `shared/permissions.js` — add `contact_linking` web permission (+ `WEB_ONLY_OK` or mobile decision).
- Modify `src/lib/openapi.js` — register the link route.

**Phase 2 — detection + review queue (separate plan: `2026-06-15-contact-link-detection.md`):**
- `src/lib/person-match.js` (pure matchers + confidence) + tests; `src/app/api/cron/person-link-suggestions/route.js` + `vercel.json` cron + `person_link_suggestions` table (mig 271); `/contacts/duplicates` review page + confirm/dismiss routes.

**Phase 3 — outreach dedup (separate plan: `2026-06-15-outreach-person-dedup.md`):**
- `src/lib/audience-filter.js` + `postmark.js` / `sms.js` / `whatsapp.js` audience builders: collapse a `person_group_id` to its primary contact before send. Tests asserting one-send-per-person.

> Phases 2 & 3 are scoped here but task-detailed in their own plans once Phase 1 lands (each ships working software on its own). Phase 1 alone delivers the single-view value + manual linking.

---

## Phase 1 tasks

### Task 1: Schema — person groups + denorm column

**Files:** Create `supabase/migrations/270_person_groups.sql` (apply via Supabase MCP `apply_migration`).

- [ ] **Step 1: Write the migration**

```sql
-- 270_person_groups.sql — non-destructive identity linking (PERSON-LINK.1)
create table public.person_groups (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.locations(id) on delete cascade,
  primary_contact_id uuid not null references public.contacts(id) on delete restrict,
  note text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index idx_person_groups_location on public.person_groups(location_id);

create table public.person_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.person_groups(id) on delete cascade,
  contact_id uuid not null unique references public.contacts(id) on delete cascade,
  match_method text not null check (match_method in ('manual','phone','name','email')),
  confidence text not null check (confidence in ('manual','high','medium','low')),
  added_by uuid references public.profiles(id),
  added_at timestamptz not null default now()
);
create index idx_pgm_group on public.person_group_members(group_id);

-- Denormalised pointer (mirrors the contacts.email_marketing / pipeline_stage_slug
-- pattern) so the unified view + outreach dedup are single-table queries.
alter table public.contacts add column person_group_id uuid references public.person_groups(id) on delete set null;
create index idx_contacts_person_group on public.contacts(person_group_id) where person_group_id is not null;

create or replace function private.sync_contact_person_group() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (tg_op = 'DELETE') then
    update public.contacts set person_group_id = null where id = old.contact_id;
    return old;
  end if;
  update public.contacts set person_group_id = new.group_id where id = new.contact_id;
  return new;
end $$;
create trigger trg_sync_contact_person_group
  after insert or update or delete on public.person_group_members
  for each row execute function private.sync_contact_person_group();

alter table public.person_groups enable row level security;
alter table public.person_group_members enable row level security;
create policy person_groups_loc on public.person_groups for all to authenticated
  using (private.auth_is_in_location(location_id)) with check (private.auth_is_in_location(location_id));
create policy pgm_loc on public.person_group_members for all to authenticated
  using (exists (select 1 from public.person_groups g where g.id = group_id and private.auth_is_in_location(g.location_id)))
  with check (exists (select 1 from public.person_groups g where g.id = group_id and private.auth_is_in_location(g.location_id)));
```

- [ ] **Step 2: Apply via MCP** `apply_migration(name: '270_person_groups', query: <above>)`.
- [ ] **Step 3: Verify** with `get_advisors(type: security)` — expect no new ERROR (SECURITY DEFINER fn has fixed search_path; RLS enabled on both tables).
- [ ] **Step 4: Commit** `git commit -m "PERSON-LINK.1 — person_groups schema + denorm column (mig 270)"`.

### Task 2: Pure helpers — normalisation + primary pick

**Files:** Create `src/lib/person-links.js`, `src/lib/person-links.test.js`.

- [ ] **Step 1: Write failing tests**

```js
import { describe, it, expect } from 'vitest'
import { normalisePhone9, normaliseName, pickPrimary } from './person-links'

describe('normalisePhone9', () => {
  it('reduces Irish formats to the last 9 digits', () => {
    expect(normalisePhone9('087 123 4567')).toBe('871234567')
    expect(normalisePhone9('+353 87 123 4567')).toBe('871234567')
    expect(normalisePhone9('00353871234567')).toBe('871234567')
  })
  it('returns null for unusable input', () => {
    expect(normalisePhone9('')).toBeNull()
    expect(normalisePhone9('123')).toBeNull()
  })
})

describe('normaliseName', () => {
  it('lowercases, trims, collapses spaces, strips accents', () => {
    expect(normaliseName('  Aoife   Byrne ')).toBe('aoife byrne')
    expect(normaliseName('Aoife Bﾃｺrne'.normalize())).toContain('aoife')
  })
})

describe('pickPrimary', () => {
  const real = { id: 'r', glofox_membership_status: 'member', glofox_account_active: true, last_attended_at: '2026-05-01' }
  const cp = { id: 'c', glofox_membership_status: 'classpass_payg', glofox_account_active: true }
  const dormant = { id: 'd', glofox_membership_status: 'member', glofox_account_active: false }
  it('prefers a real active member over a ClassPass shadow', () => {
    expect(pickPrimary([cp, real]).id).toBe('r')
  })
  it('prefers active over dormant when both are member-status', () => {
    expect(pickPrimary([dormant, real]).id).toBe('r')
  })
  it('never picks ClassPass when any non-classpass exists', () => {
    expect(pickPrimary([cp, dormant]).id).toBe('d')
  })
})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/person-links.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement the pure helpers**

```js
// src/lib/person-links.js — identity-link helpers (PERSON-LINK.1)
export function normalisePhone9(raw) {
  if (!raw || typeof raw !== 'string') return null
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 9) return null
  return digits.slice(-9)
}

export function normaliseName(raw) {
  if (!raw || typeof raw !== 'string') return ''
  return raw.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim().replace(/\s+/g, ' ')
}

// Primary = the account that best represents the person for display + outreach.
// Order: non-classpass beats classpass; active beats inactive; member-status
// beats lead/none; most-recent attendance breaks ties.
const STATUS_RANK = { member: 3, credit_member: 3, trial: 2, classpass_payg: 0 }
export function pickPrimary(contacts) {
  const score = (c) => {
    const isCp = c.glofox_membership_status === 'classpass_payg'
    const active = c.glofox_account_active === true
    const attendedMs = c.last_attended_at ? Date.parse(c.last_attended_at) || 0 : 0
    return [isCp ? 0 : 1, active ? 1 : 0, STATUS_RANK[c.glofox_membership_status] ?? 1, attendedMs]
  }
  return [...contacts].sort((a, b) => {
    const sa = score(a), sb = score(b)
    for (let i = 0; i < sa.length; i++) if (sb[i] !== sa[i]) return sb[i] - sa[i]
    return 0
  })[0]
}
```

- [ ] **Step 4: Run** `npx vitest run src/lib/person-links.test.js` → PASS.
- [ ] **Step 5: Commit** `git commit -m "PERSON-LINK.1 — pure helpers (normalise phone/name, pickPrimary)"`.

### Task 3: IO helpers — create / add / remove / set-primary

**Files:** Modify `src/lib/person-links.js`; add tests to `src/lib/person-links.test.js` using the chainable Supabase mock pattern from `churn-radar-data.test.js`.

- [ ] **Step 1: Failing tests** — assert: `createGroup` inserts a group + N members and sets `primary_contact_id` from `pickPrimary`; `removeFromGroup` deletes the member row and, when the group falls to 1 member, deletes the group (no orphan singletons); `setPrimary` updates `person_groups.primary_contact_id` only to a contact_id that's in the group (else throws). (Full mock + assertions written here in implementation.)

- [ ] **Step 2: Implement** `createGroup(db,{contactIds,method,confidence,actorId,locationId})`, `addToGroup`, `removeFromGroup`, `setPrimary(db,{groupId,contactId})`, `getPersonGroup(db,contactId)` → `{ group, members }`. All service-role; each `await`ed (supabase builders are thenables — never `.catch` a builder). `removeFromGroup` re-derives primary via `pickPrimary` if the removed contact was primary.

- [ ] **Step 3: Run tests → PASS. Step 4: Commit** `git commit -m "PERSON-LINK.1 — group CRUD helpers"`.

### Task 4: Read-model — `aggregatePerson`

**Files:** Create `src/lib/person-aggregate.js` + `.test.js`.

- [ ] **Step 1: Failing test** — given a group of 3 contact ids with stub rows across `glofox_invoices`, `bookings`, `deals`, `activities`, assert `aggregatePerson` returns: `emails` (deduped, each `{ value, sourceContactId, contactable }`), `phones` (deduped by `normalisePhone9`), `accounts[]` (one per member with status + glofox id), `arrearsCents` (sum of PAST_DUE across members, reusing the netting helper from `glofox-arrears.js` so settled-retries don't inflate), `attendedTotal`, `timeline[]` (merged, each tagged `sourceContactId`, newest first, capped 50).

- [ ] **Step 2: Implement** — fetch member contacts (the group's contact_ids), then per-table reads filtered `contact_id in (memberIds)` (each paginated per the 1k-cap rule), fold into the payload. Reuse `nettedOutByRetry` from `glofox-arrears.js` for arrears. Primary's membership is the headline; secondaries listed under accounts.

- [ ] **Step 3: Run → PASS. Step 4: Commit** `git commit -m "PERSON-LINK.1 — aggregatePerson read-model"`.

### Task 5: Link / unlink / set-primary API

**Files:** Create `src/app/api/contacts/[id]/link/route.js` + `.test.js`. Follow the mutation-route skeleton + `assertLocationAccess` from CLAUDE.md; guard `MANAGER_ROLES`.

- [ ] **Step 1: Failing route tests** (mock `getCurrentUser` + db): POST `{ otherContactId }` → 200, both end up in one group, primary from `pickPrimary`; POST when one is already grouped → adds the other to the existing group; DELETE → removes `[id]` from its group; cross-location link → 400; non-manager → 403.

- [ ] **Step 2: Implement** the handlers calling the Task 3 helpers; standard `{ success, data }` shape; write an `activities` row (`type:'pipeline'`-style audit `kind:'event'`, note `"Linked to <name>"`) best-effort.

- [ ] **Step 3: Run → PASS. Step 4:** register in `src/lib/openapi.js`. **Step 5: Commit** `git commit -m "PERSON-LINK.1 — link/unlink/set-primary API"`.

### Task 6: Permission key + parity

**Files:** Modify `shared/permissions.js` (add `contact_linking` to `WEB_PERMISSIONS` + `DEFAULT_WEB_PERMISSIONS_BY_ROLE`, default true for MANAGER_ROLES), and `scripts/check-mobile-parity.mjs` `WEB_ONLY_OK` (reason: "contact-merge admin action, desktop-only like contact merge").

- [ ] **Step 1: Edit. Step 2: Run** `npm run check:mobile-parity` → clean. **Step 3: Commit.**

### Task 7: Redesigned contact page — components

**Files:** Create `PersonHeader.jsx`, `LinkedAccountsCard.jsx`, `ContactDetailTabs.jsx`, `LinkAccountModal.jsx`. Markup follows the **approved mockup** (`unified_person_view_mockup`) and `un1t-*` tokens + `@/components/ui` primitives.

- [ ] **Step 1: `PersonHeader`** — avatar, name, `N linked accounts` chip (only when grouped), pipeline-stage pill, primary actions (message/edit). Props: `{ person, primaryContact }`.
- [ ] **Step 2: `LinkedAccountsCard`** — the linked-account strip (per-account status/email/glofox id, Primary badge, Make-primary / Unlink calling the Task 5 API). Hidden when the contact is standalone.
- [ ] **Step 3: `ContactDetailTabs`** — Overview / Activity / Comms / Admin. Moves the current always-open pile (Devices, MarketingPreferences, ConsentHistory, RaceHistory) into **Admin/Comms tabs** so Overview is clean. (De-clutter = the redesign ask.)
- [ ] **Step 4: `LinkAccountModal`** — search a contact by name/phone, preview, confirm link (manual path).
- [ ] **Step 5: Commit** each component.

### Task 8: Wire the redesigned page

**Files:** Modify `src/app/contacts/[id]/page.js`.

- [ ] **Step 1:** When `contact.person_group_id` is set, call `aggregatePerson(db, person_group_id)`; render `PersonHeader` + `LinkedAccountsCard` + tabbed body fed by the aggregate. When standalone, render the same layout with a single account (no linked-accounts strip) — so every contact gets the cleaner page.
- [ ] **Step 2:** Move the existing cards into tabs (no logic change, just relocation) to de-clutter Overview.
- [ ] **Step 3: Run** `npm run build` (page is a server component with new imports — build is the only thing that catches import-resolution).
- [ ] **Step 4: Commit** `git commit -m "PERSON-LINK.1 — redesigned, de-cluttered contact page with unified person view"`.

### Task 9: Ship Phase 1

- [ ] Run full CI mirror: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run build`.
- [ ] Branch `person-identity-linking-phase1`, PR to main, report URL. (Schema mig 270 already applied to prod via MCP — note in PR body.)

---

## Phase 2 — detection + auto-link + review queue (own plan)

`src/lib/person-match.js` pure matchers: (a) phone clusters via `normalisePhone9` **excluding** `classpass_payg` and the placeholder number; (b) ClassPass→real exact `normaliseName` 1:1. Confidence per the high-confidence rules above. Nightly `/api/cron/person-link-suggestions` (mig 271 `person_link_suggestions`): auto-links high-confidence via Task 3 helpers; writes the rest as suggestions. `/contacts/duplicates` review page (confirm → link, dismiss → remembered "not a match" so it never re-suggests). Seed run expectation: ~316 real-phone clusters + the ClassPass name matches.

## Phase 3 — outreach dedup to primary (own plan)

In `audience-filter.js` (+ the postmark/sms/whatsapp audience builders): after building the recipient set, collapse any `person_group_id` to its `primary_contact_id` (drop non-primary members) so one human gets one send. Tests: a group of 3 in an audience → 1 recipient (the primary); standalone contacts unaffected. This is why Phase 1 denormalises `contacts.person_group_id` — the dedup is a single-table `distinct on (coalesce(person_group_id::text, id::text))`-style pass.

---

## Self-review

- **Spec coverage:** auto-link high-confidence (Phase 2 confidence rules) ✓; unified view on existing page + redesign (Tasks 7-8) ✓; outreach→primary (Phase 3) ✓; name as ClassPass key (Phase 2 matcher) ✓; non-destructive / survives Glofox sync (no deletes; link layer only) ✓.
- **Placeholder scan:** Tasks 3 & 7 describe test/markup intent rather than full code — acceptable because they reference an established mock pattern (`churn-radar-data.test.js`) and the approved mockup respectively; expand inline at execution. All logic-bearing tasks (1,2,4,5) have full code.
- **Naming consistency:** `person_group_id`, `primary_contact_id`, `normalisePhone9`, `normaliseName`, `pickPrimary`, `aggregatePerson`, `nettedOutByRetry` (reused) used consistently across tasks.
- **Risk:** `person_groups.primary_contact_id` is `on delete restrict` — a hard contact delete must remove the member row first (the destructive-merge/delete paths must call `removeFromGroup`); note for Phase 1 Task 5 + the existing delete route.
