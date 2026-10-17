# Hatch staff open every Hatch client (P1.3b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff who hold Contacts at a studio can read and open every contact that studio's un1t.online account lists as a client (a `un1t_clients` row at that studio with that `contact_id`), not only those with an active membership. Visibility then matches the studio's marketing reach. At Hatch that is 52 people whose contact lives at Stillorgan; 10 are visible today.

**Architecture:** This builds on mig 731 (#2079). It is the same three surfaces with one more source of "this contact is at this studio":
- `private.auth_contact_membership_contact_ids()` gains a `UNION` over `un1t_clients`. The name is kept, so `contacts_select` and its guard branch are unchanged; the comment says what it now covers.
- `public.crossover_contact_ids(loc)` gains a third `UNION` branch.
- `canViewContact` gains a `un1t_clients` probe.

**Tech Stack:** Supabase migration, PGlite test, Node, Vitest.

**Spec:** Richard, 2026-10-17, after #2079 merged: lapsed Hatch clients get Hatch marketing (39 of 52 already had a Hatch preference row), so "widen staff" — staff visibility should match. Decision 3 of `docs/superpowers/plans/2026-10-17-un1t-online-p1-plan.md` stands for everything else.

## Global Constraints

- **Migration 732** (`supabase/migrations/732_contacts_read_by_studio_client.sql`). Check `ls supabase/migrations | sort -V | tail -3` first.
- **The rule:** a contact is readable at studio X when `un1t_clients.location_id = X AND un1t_clients.contact_id = contacts.id`, for any `un1t_clients.status`, AND X is in `private.auth_contact_read_location_ids()`. This is in addition to 731's active-membership rule. Nothing else widens.
- **Same helper name and signature**, `CREATE OR REPLACE` (keeps the ACL: authenticated + service_role). It stays SECURITY DEFINER, STABLE, `SET search_path = ''`. The body:
  `SELECT coalesce(array_agg(DISTINCT x.contact_id), '{}'::uuid[]) FROM (SELECT cm.contact_id FROM public.contact_memberships cm WHERE cm.status = 'active' AND cm.location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[]) UNION SELECT uc.contact_id FROM public.un1t_clients uc WHERE uc.contact_id IS NOT NULL AND uc.location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])) x`.
  The resolver is called in the InitPlan form once per branch.
- **`contacts_select` is NOT altered.** The self-check asserts its qual is still exactly 731's.
- **Pre-checks** (abort on mismatch):
  - the helper body and `crossover_contact_ids` body match 731's normalised md5, or 732's on a re-run (compute both, the way 731 did);
  - `un1t_clients` has `contact_id` and `location_id`, has RLS on, and grants no client privilege (`has_any_column_privilege` for anon/authenticated).
- **`crossover_contact_ids`:** add `UNION SELECT uc.contact_id FROM public.un1t_clients uc JOIN public.contacts c ON c.id = uc.contact_id WHERE uc.location_id = loc AND c.location_id IS DISTINCT FROM loc`. Restate the REVOKE/GRANT (service_role only).
- **`canViewContact`:** after the membership probe and before the deal probe, probe `un1t_clients` (`contact_id = contact.id`, `location_id IN locIds`, `limit(1)`). A returned error is logged with `logError` (no PII) and falls through, exactly like the membership probe. It never grants on an error.
- **Guards:**
  - `tests/contacts-read-scope-migration-guard.test.js` pins the helper body. Update it to accept 732's body as the latest definition and to still reject a body that drops the Contacts restriction from EITHER branch. Add a negative test for an unrestricted `un1t_clients` branch.
  - `tests/rls-active-staff-gate.test.js` and `tests/helpers/closed-functions.js` need updates only if they key on the migration number.
- **Tests:** `tests/migration-732-contacts-read-by-studio-client.test.js` builds on the same PGlite fixture as the 731 test (`tests/helpers/contacts-resolvers-699-fixture.js` plus 731), then applies 732. It must cover:
  - a contact linked by `un1t_clients` at B is readable by B staff with Contacts, and not by B staff without Contacts;
  - an unlinked `un1t_clients` row (null `contact_id`) grants nothing;
  - 731's membership cases still pass;
  - the RPC returns the client crossover;
  - EXPLAIN shows InitPlans run once;
  - running the file twice is safe;
  - abort cases, and the rollback (back to 731's two bodies).
- Nothing under `mobile/` or `shared/`. The controller applies the migration to prod before merge.

## Review Focus

1. A `un1t_clients` row at a studio where the caller lacks Contacts grants nothing.
2. The policy text is unchanged, so 731's guard branch and the InitPlan form still hold.
3. A `un1t_clients` read error on the web gate never grants, and never hides a deal or membership crossover.
4. The un1t sync relinks `contact_id` (merge/relink), so the visibility follows the current link, not a stale one. This works by construction, because it reads the live row.

---

### Task 1: Mig 732 + `canViewContact` + guards + tests

**Files:**
- Create: `supabase/migrations/732_contacts_read_by_studio_client.sql`, `tests/migration-732-contacts-read-by-studio-client.test.js`
- Modify: `src/lib/contact-crossovers.js` (+ test), `tests/contacts-read-scope-migration-guard.test.js`, comments in `src/app/(sales)/contacts/[id]/page.js` if they enumerate the rule.

- [ ] **Step 1:** Write the failing tests (migration test cases above; `canViewContact` cases: `opens a contact linked as a un1t client at one of the user's studios`, `a un1t_clients read error falls through to the deal probe and never grants`, `a client row at another studio does not open it`).
- [ ] **Step 2:** Run them. Expect FAIL.
- [ ] **Step 3:** Implement the migration (header with WHY, the rollback record, pre-checks, the catalog self-check), the gate and the guard update.
- [ ] **Step 4:** Run `npm test`, `npm run lint`, and the 11 `check:*` commands from CLAUDE.md's CI mirror. Expect PASS.
- [ ] **Step 5:** Commit `UN1TDUAL.4 — staff open every client their studio's un1t.online lists (mig 732)`.

### Task 2: Ship (controller)

- [ ] Apply 732 to prod; `get_advisors`. Then expect `crossover_contact_ids(Hatch)` to include all 52 linked clients.
- [ ] PR, changelog entry, merge when green.
