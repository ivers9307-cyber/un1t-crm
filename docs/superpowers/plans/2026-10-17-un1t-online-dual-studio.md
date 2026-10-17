# Dual-studio members visible at Hatch (P1.3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hatch staff can see and open the Hatch members whose contact lives at another studio (52 today, all at Stillorgan) wherever they can see Hatch's own contacts, and every linked Hatch client has a Hatch marketing-preferences row.

**Architecture:**
- **Visibility:** an active `contact_memberships` row at studio X counts as "this contact is at X". This applies in three places that decide visibility today, each read by a different client:
  - the RLS read policy (`contacts_select`): phones and browser sessions;
  - the crossover RPC (`crossover_contact_ids`): the web contact list and search;
  - `canViewContact`: the web contact page.
- **Marketing:** the un1t.online sync creates the missing Hatch `contact_location_preferences` row for every linked client, through a consent-logged path, so Hatch sends reach them.

**Tech Stack:** Supabase migration (SQL, SECURITY DEFINER helper, policy change), Node, Vitest.

**Spec:** `docs/superpowers/plans/2026-10-17-un1t-online-p1-plan.md` §P1.3 and decision 3 (2026-10-17): "Hatch staff see Hatch members whose contact lives at Stillorgan: yes, scoped to studios where the person holds an active membership". Marketing default: roadmap P0.1, "leave marketing on".

## Global Constraints

- **The widening is membership-scoped AND permission-scoped.** A contact becomes readable at studio X only if (a) it has a `contact_memberships` row with `status = 'active'` and `location_id = X`, and (b) the caller already holds Contacts at X, meaning X is in `private.auth_contact_read_location_ids()`. Nothing else widens.
- **RLS form** (CLAUDE.md, mig 690): the new branch is an InitPlan array, `id = ANY ((SELECT private.auth_contact_membership_contact_ids())::uuid[])`. The `::uuid[]` cast is load-bearing. The helper is `SECURITY DEFINER`, `STABLE`, `SET search_path = ''`, because `contact_memberships` has no client privilege. The JS crossovers and the policy agree on one rule.
- **`private` function EXECUTE** (mig 678): `authenticated` + `service_role`. State `REVOKE … FROM PUBLIC, anon` explicitly. `tests/private-function-execute-guard.test.js` must pass.
- **`crossover_contact_ids`:** use `CREATE OR REPLACE`, which keeps its service-role-only ACL. Restate the revoke/grant anyway.
- **Guard tests are updated consciously, never loosened in general.** `tests/contacts-read-scope-migration-guard.test.js` must accept exactly this membership branch and still flag every other widening shape it flags today.
- **Consent:** the sync never changes an existing preference row. It only inserts a missing Hatch `contact_location_preferences` row (`ON CONFLICT DO NOTHING` semantics), with the table's defaults (marketing on, per P0.1), and writes a `consent_log` row in the same pass through the existing consent helper/vocabulary (source `un1t_online_sync`; if the vocabulary CHECK lacks it, add it in the migration). A contact that unsubscribed at Hatch already has a row and is never touched.
- Next migration number: check `ls supabase/migrations | sort -V | tail -3` (730 is used twice; expect 732).
- Nothing under `mobile/` (the phone's own directory query filters on `contacts.location_id` itself; that is out of scope here and would publish an OTA). Nothing in `shared/`.

## Review Focus

1. **A Hatch-only staff member WITH Contacts at Hatch** reads a Stillorgan contact who holds an active Hatch membership; one WITHOUT Contacts at Hatch does not. Tests in Tasks 1 and 2.
2. **An ended membership** (`status 'ended'`) grants nothing. Tests in Tasks 1 and 2.
3. **A contact who unsubscribed at Hatch** keeps the existing row unchanged; the sync inserts only missing rows. Test in Task 3.
4. **Performance:** the policy evaluates the helper once per statement (InitPlan), not per row. The migration's self-check asserts the policy text uses the `(SELECT …)::uuid[]` form.
5. **The guard still catches** `OR private.auth_is_in_location(location_id)` and `USING (true)` after its update. Test in Task 1.

---

### Task 1: Migration: membership-aware contact read + crossover RPC

**Files:**
- Create: `supabase/migrations/732_contacts_read_by_studio_membership.sql` (confirm the number)
- Modify: `tests/contacts-read-scope-migration-guard.test.js` (accept exactly the new branch)
- Test: the existing guards plus a PGlite test, if the repo has a harness for mig 690 (`tests/migration-690-contacts-read-scope.test.js`): add `tests/migration-732-contacts-read-by-membership.test.js` mirroring it.

**Interfaces:**
- Produces:
  - `private.auth_contact_membership_contact_ids() RETURNS uuid[]`: the contact ids with an active `contact_memberships` row at any location in `private.auth_contact_read_location_ids()`.
  - The `contacts_select` USING becomes the mig 690 expression `OR id = ANY ((SELECT private.auth_contact_membership_contact_ids())::uuid[])`.
  - `public.crossover_contact_ids(loc uuid)` also returns `cm.contact_id` for `contact_memberships cm JOIN contacts c` where `cm.location_id = loc AND cm.status = 'active' AND c.location_id IS DISTINCT FROM loc`. This is a `UNION` with the deal branch, distinct.

- [ ] **Step 1:** Write the migration in one transaction with `lock_timeout`, redefining the policy with `ALTER POLICY … USING (…)`. Add a catalog self-check covering:
  - the helper exists, `SECURITY DEFINER`, with `search_path` set;
  - `authenticated` can execute it, `anon` cannot;
  - `pg_policies.qual` for `contacts_select` contains both helpers in the `ANY ((SELECT …)::uuid[])` form;
  - `crossover_contact_ids` is not executable by `authenticated`/`anon`.
- [ ] **Step 2:** Update the guard detector to accept this exact branch. Add tests showing it still flags `OR private.auth_is_in_location(location_id)`, `USING (true)`, and a membership branch WITHOUT the Contacts-readable restriction (a helper that doesn't call `auth_contact_read_location_ids`, if the detector can see it; otherwise document the limit in the test).
- [ ] **Step 3:** If a PGlite harness exists for 690, add the 732 test:
  - Contacts at Hatch plus an active Hatch membership on a Stillorgan contact gives readable;
  - an ended membership gives not readable;
  - no Contacts at Hatch gives not readable;
  - the RPC returns the membership crossover.
- [ ] **Step 4:** Run `npx vitest run tests/contacts-read-scope-migration-guard.test.js tests/contacts-read-scope-guard.test.js tests/migration-690-contacts-read-scope.test.js tests/private-function-execute-guard.test.js tests/function-execute-guard.test.js` plus the new test, then `npm run check:rls-restrictive && npm run check:rpc-names`. PASS.
- [ ] **Step 5:** Commit `UN1TDUAL.1 — contacts readable at a studio where they hold an active membership (mig 732)`.

Apply to prod **before** merge (controller), then `get_advisors`.

---

### Task 2: `canViewContact` honours an active membership

**Files:**
- Modify: `src/lib/contact-crossovers.js` (`canViewContact`)
- Test: `src/lib/contact-crossovers.test.js`

**Interfaces:**
- After the owned check and before the deal probe, probe `contact_memberships` for `contact_id = contact.id`, `status = 'active'`, `location_id IN locIds`, `limit(1)`. Destructure `error` and fail closed on it.

- [ ] **Step 1: Write the failing tests:**
  - `opens a contact with an active membership at one of the user's studios`;
  - `an ended membership does not open it`;
  - `a membership read error fails closed`;
  - `owner/master/deal branches unchanged` (Review Focus 1–2).
- [ ] **Step 2:** Run `npx vitest run src/lib/contact-crossovers.test.js`. FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run: PASS. Then `npm run check:location-scoping && npm run check:guardrails`.
- [ ] **Step 5:** Commit `UN1TDUAL.2 — the contact page opens a studio member whose contact lives elsewhere`.

---

### Task 3: The sync creates missing Hatch marketing-preference rows

**Files:**
- Modify: `src/lib/un1t-online-sync.js` (after the contact resolver, for each linked contact whose `location_id` ≠ the sync's location)
- Possibly create: a small helper in `src/lib/` if no existing consent function inserts a default per-studio row with a `consent_log` entry. First read `src/lib/marketing-consent.js` (`applyFormMarketingConsent`) and mig 489 (the default row the insert trigger creates, `source 'contact_created'`) and reuse them.
- Test: `src/lib/un1t-online-sync.test.js` (+ the helper's test)

**Interfaces:**
- For a linked contact at another studio with no `contact_location_preferences` row for this location, insert one with the table defaults and `source = 'un1t_online_sync'`, plus one `consent_log` row naming the same source.
- An existing row is never updated.
- Chunked, every write's `error` checked.
- A failure is recorded in `counts.studio_preferences = { created, error? }` and never fails the run.

- [ ] **Step 1: Write the failing tests:**
  - `creates a Hatch preference row + consent_log for a Stillorgan contact linked at Hatch`;
  - `never touches an existing Hatch row (an unsubscribed member stays unsubscribed)` (Review Focus 3);
  - `does nothing for contacts already at Hatch`;
  - `a failure leaves the run ok`.
- [ ] **Step 2:** Run. FAIL.
- [ ] **Step 3:** Implement. If the `consent_log` source or action vocabulary needs `un1t_online_sync`, add it to Task 1's migration (amend before it is applied) and say so.
- [ ] **Step 4:** Run: PASS. Then `npm run check:guardrails` (arm any new file) and `tests/consent-tables-client-writes-guard.test.js`.
- [ ] **Step 5:** Commit `UN1TDUAL.3 — linked members get their Hatch marketing-preferences row`.

---

### Task 4: Verify and ship

- [ ] **Step 1:** Run the full CI mirror (13 commands) and `npm run build`.
- [ ] **Step 2 (controller):** Apply the migration to prod; `get_advisors`. After deploy and the next sync, all 52 dual members have a Hatch preference row, and the Hatch contacts list shows them.
- [ ] **Step 3:** Changelog entry after `gh pr create`.

## Out of scope

- The phone directory's own `.eq('location_id')` query: needs a mobile change (OTA). Next mobile release.
- Studio dashboard counts and sequence triggers by membership: P1.2 seam work.
- Mia routing for dual members: P1.4.
