# ORGCONTACTS — One organisation, many studios: contacts and WhatsApp as shared assets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five cross-studio contact side channels (deals, `contact_memberships`, `un1t_clients`, `glofox_crossover_members`, `contact_location_preferences`) with one relationship table, `contact_studios`, that RLS, lists, the contact page, the phone directory, Mia and WhatsApp inbound routing all read; and finish the WhatsApp org-number model's leftovers.

**Architecture:**
- One table, `public.contact_studios`, one row per (contact, studio) that has ever had a relationship. Service-role only. Three SQL triggers (contact insert, deal insert/update, marketing-preferences insert) and two JS sync writers (un1t.online, Glofox) keep it current; a nightly reconcile re-derives every row from the source tables, so the rows are always reproducible.
- One JS helper module, `src/lib/contact-studios.js`, is the only reader and writer of the table from app code. Every consumer that today re-derives "is this person at studio X" calls it.
- One RLS helper branch (`id = ANY ((SELECT private.auth_contact_studio_contact_ids())::uuid[])`) and one service-role view (`public.studio_contacts`) replace the three-way UNION helper, the `crossover_contact_ids` RPC, and every `or(location_id.eq.L, id.in.(…))` filter.
- `contacts.location_id` stays and means **primary studio** only: who may delete, which studio fills the single-value columns, the fallback when a rule needs exactly one studio.
- Six PRs, one per phase of spec §4. Phases 0 to 3 are behaviour-neutral or strictly widening; Phase 4 is the one customer-visible change (per-studio pipeline stage in audiences) and is gated on a change report Richard reads first; Phase 5 drops the old paths.

**Tech Stack:** Next.js 16 App Router, Supabase (supabase-js; Postgres migrations applied via MCP), vitest, PGlite migration tests (`tests/helpers/contacts-resolvers-699-fixture.js`, `tests/helpers/member-write-sweep.js`), Expo/RN phone app in `mobile/`.

**Spec:** `docs/superpowers/specs/2026-10-20-org-shared-contacts-whatsapp-design.md`. Read it first. Section numbers below (§2.1, §3.4, decision 3 …) refer to it.

## Global Constraints

- **Richard's six decisions (spec §5), verbatim, are the rules of this plan:**
  1. *Standing rule:* people belong to the organisation, studios hold relationships. Every future source (a third studio, a new booking platform, ClassPass at Hatch) writes a `contact_studios` row and nothing else.
  2. *Visibility is any relationship, lapsed too.* Any `contact_studios` row, active or ended, makes the person visible to staff holding Contacts at that studio. `kind`/`status` matter only to Mia, routing and pricing.
  3. *Pipeline stage becomes per studio,* audiences and list filters read it per studio, *with a change report first:* before the flip, a one-off report of every existing segment whose membership changes.
  4. *Edit anywhere, delete by primary or org admin.* Staff holding Contacts at any studio with a relationship may edit the record; DELETE and "change primary studio" only by the primary studio's admins or an org admin.
  5. *Threads stay per studio.* One chat on the phone, up to two threads in the CRM; routing by "who spoke last" and Move stay.
  6. *Go-live is done:* the number is switched on at Hatch Street and mig 746 was applied. §3.3 shrinks to the sign-off date UI.
- **Lifecycle rules (spec §2.1), verbatim; the reconcile function in Task 6 is their one implementation and every writer must agree with it:**
  - `status = 'active'` while ANY of these holds at that studio: a live membership (Glofox `member`/`credit_member` not ended, or a un1t subscription in `MEMBERSHIP_ACTIVE_STATUSES`, or credits), a provider account (`un1t_clients` row, Glofox link), an open deal, or a marketing-preferences row. Otherwise `'ended'` with `ended_at`. Rows are never deleted.
  - `kind` is the strongest current relationship: `member` (live membership) > `client` (provider account, lapsed or not) > `lead` (deal or preferences only). It moves down when a membership ends and up when one starts.
  - `last_seen_at` is **last activity**, never a sync tick: attendance, a booking, a deal touch, a message in that studio's thread. Syncs stamp `first_seen_at` and `status` only, so a studio that syncs every few minutes cannot win a tie over one that syncs nightly.
  - A marketing-preferences row (`contact_location_preferences`) counts as a relationship (the lead-form writer and the backfill create a `lead` row for it), so "joined this studio" for sequence enrolment and the audience view's reach never shrink from this change.
- **Table shape (spec §2.1), verbatim:** `contact_id uuid FK contacts (cascade)`, `location_id uuid FK locations (cascade)`, `organization_id uuid` trigger-maintained from the location (never crosses org: trigger raises), `kind text 'member' | 'client' | 'lead'`, `status text 'active' | 'ended'`, `source text 'glofox' | 'un1t_online' | 'lead_form' | 'deal' | 'manual' | 'import'`, `stage_slug text`, `first_seen_at, last_seen_at, ended_at, created_at, updated_at`, `PRIMARY KEY (contact_id, location_id)`, service_role only (RLS on, no policy, mig 677 ACL stated).
- **`contact_studios` is never client-readable** (spec §2.2: "No new client-readable table, no new grant"). The phone keeps reading `contacts` through RLS.
- **Migrations:** forward-only, applied via Supabase MCP `apply_migration` on project `iyvtbjjxdggiadzwwvdj` (confirm with `list_projects`; never `tpttqakxmyxrwnqjepfm`), `get_advisors` (security) after each. Numbers below (762 to 768) were free at plan time (`ls supabase/migrations | sort -V | tail -3` → 759, 760, 761). **Re-check with that command before writing each file; another branch may have taken a number, and the guard tests pin numbers by name.** Every DDL file gets a PGlite behavioural test in the mig 731/758 style (fictional ids only; the repo is public; `tests/migration-<n>-<slug>.test.js`), self-checks the catalog never its own text, aborts as a whole, re-runs as a no-op, and carries a rollback record in its header.
- **Apply order:** a migration that ADDS is applied BEFORE its code deploys (the usual rule). A migration that DROPS a column or table the live code still touches (Tasks 5 and 24) is applied AFTER the PR that stops touching it has deployed; the file still ships in that PR.
- **New relations and functions:** a new table states `REVOKE ALL ON public.<t> FROM anon, authenticated` and `GRANT SELECT, INSERT, UPDATE, DELETE … TO service_role`; a new function states `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated` (plus `GRANT EXECUTE … TO authenticated` only for an RLS helper a signed-in session's policy calls). `CREATE OR REPLACE`, never `DROP`+`CREATE`, for an existing function (the ACL survives). A policy helper is called in the `location_id = ANY ((SELECT …)::uuid[])` InitPlan form; the cast is load-bearing.
- **Guard tests that pin this area and must be updated in the PR that changes it** (never disabled): `tests/contacts-read-scope-migration-guard.test.js` (helper bodies by migration number), `tests/closed-table-escapes-guard.test.js` via `CLOSED_TABLES` in `tests/helpers/sql-escapes.js`, `tests/table-default-acl-guard.test.js`, `tests/function-execute-guard.test.js`, `tests/private-function-execute-guard.test.js`, `tests/anon-contacts-guard.test.js`, `tests/contacts-read-scope-guard.test.js` (client reads of `contacts`), `tests/audience-view-columns-guard.test.js`, `tests/whatsapp-config-callers.test.js` (exact call counts), `tests/consent-tables-client-closed-guard.test.js` (any statement that re-creates `contact_location_audience` keeps `security_invoker = on` and REVOKEs after it), `scripts/check-location-scoping.mjs` (`SCOPING_HELPERS`), `.select-columns-allowlist.json` / `.rpc-names-allowlist.json` (dated expiries, never a disable).
- **Every PR:** branches off fresh `origin/main`; runs the 13-command CI mirror in CLAUDE.md plus `npm run build` (every PR here adds or removes an import or a route); adds `docs/changelog/entries/<PR>.md` after `gh pr create` (one row: `| #<PR> | ORGCONTACTS.<n> — … | 2026-10-DD. … |`); registers new or removed routes in `src/lib/openapi.js`; never a `console.log` in a prod path; every supabase write destructures `error`; `uuidLike` from `@/lib/schemas` for ids; customer-facing copy operator-editable where it already is (none of this plan's copy reaches a customer).
- **Copy, verbatim:**
  - Org numbers page, home studio field help (spec §3.2): "Unknown senders, Meta-made templates and chat-opener edits belong to this studio."
  - Contacts list pill tooltip (Task 3): "Primary studio: {studio}. Shown here because they have a relationship with this studio."
  - Sign-off card label (Task 4): "Sign-off until" with hint "Blasts at this studio need an organisation admin's sign-off until this date. Clear it to end the window."
- **Deviation from the spec, decided here, Richard may overrule:** §2.2 deletes the mobile `crossover-ids` route and says "the widened RLS already answers 'at this studio'". It does not for a staff member who holds Contacts at BOTH studios: `contacts_select` admits every contact at every studio they hold Contacts at, so a Hatch directory would list Stillorgan's 8k contacts too. The phone's query needs a per-studio filter it cannot express without a grant on `contact_studios`, which the spec forbids. So the route **stays**, reading `contact_studios` through `contactsAtStudio` instead of the RPC (Task 13), and §2.3's deletion list loses that one item. Everything else in §2.3 is deleted as written.

## Review Focus

1. **A contact whose primary studio was deactivated or is a host anchor.** `contact_studios` rows at an inactive location must still be written (history) but a reader listing studios for a picker must skip `active = false` and `is_host_anchor = true` locations. *Pinned in Task 7:* `contactsAtStudio` returns rows at an inactive studio; `studiosOfContact({ activeOnly: true })` omits it.
2. **Two contacts in one person group, both with an active row at the same studio** (the ClassPass placeholder and the un1t account). Mia must not count the studio twice or pick a contact id at random. *Pinned in Task 17:* `resolveMemberStudios` yields one MemberStudio for the studio with both contact ids in `contactIds`, deterministically ordered.
3. **An inbound WhatsApp from a contact with active rows at both candidate studios and equal `last_seen_at`.** The router must be deterministic. *Pinned in Task 18:* equal timestamps → the primary studio if it is one of the two, else the lower `location_id` string order.
4. **A segment at Hatch filtering `pipeline_stage_slug = 'dormant'` where the person is dormant at Stillorgan and has no stage at Hatch.** After the flip the Hatch stage is NULL, so `eq` excludes them and `neq` includes them. The change report must show this class, and `is_null` must be offered in the builder. *Pinned in Task 20:* the report counts a fixture segment before and after and lists the contact in `left`.
5. **A deal moved to another studio's board** (`deals.location_id` changes on UPDATE). The old studio's row must not keep an open-deal `active` status it no longer earns, and the new studio must gain a row. *Pinned in Task 6:* UPDATE OF `location_id` on `deals` fires the trigger for both OLD and NEW studios, and the reconcile agrees.

---

## Phase map

| Phase (spec §4) | PR | Key | Migrations | Tasks |
|---|---|---|---|---|
| 0 quick fixes | PR 1 | ORGCONTACTS.0 | 762 (RLS helper gains deals), 763 (WhatsApp leftovers) | 1–5 |
| 1 table + backfill + dual-writing writers | PR 2 | ORGCONTACTS.1 | 764 (`contact_studios`, triggers, reconcile, backfill, heartbeat row) | 6–10 |
| 2 readers | PR 3 | ORGCONTACTS.2 | 765 (RLS helper → `contact_studios`; `studio_contacts` view) | 11–15 |
| 3 Mia + routing | PR 4 | ORGCONTACTS.3 | none | 16–19 |
| 4 per-studio stage, lead source, person groups, edit rights | PR 5 | ORGCONTACTS.4 | 766 (audience view `studio_stage_slug`), 767 (`person_groups.organization_id`) | 20–23 |
| 5 drops + invariants | PR 6 | ORGCONTACTS.5 | 768 (drops) | 24–25 |

Phases 2 and 3 may be split into more than one PR each ("one area at a time", spec §4) if a reviewer prefers; the task boundaries below are the split points.

---

## PR 1 — Phase 0: quick fixes that need no model change (ORGCONTACTS.0)

### Task 1: `canViewContact` admits Glofox crossovers

**Files:**
- Modify: `src/lib/contact-crossovers.js` (`probeMembershipOrClient`)
- Test: `src/lib/contact-crossovers.test.js`

**Interfaces:**
- Produces: `canViewContact(db, user, contact)` unchanged in signature; now also returns true when `glofox_crossover_members` holds a row `(location_id ∈ contactStudioIds(user), contact_id = contact.id)`.

- [ ] **Step 1: Write the failing test** in the existing `canViewContact` describe, using that file's fake db builder:
  - `'a Glofox crossover row at a studio where the caller holds Contacts opens the contact'`: contact lives at A, caller holds Contacts at B only, `glofox_crossover_members` has `(B, 'gf-1', contact.id)`, no membership, no client, no deal → `true`.
  - `'a Glofox crossover row at a studio where the caller lacks Contacts grants nothing'` → `false`.
  - `'a failed glofox_crossover_members read is logged and falls through to the deal probe'`: read errors, a deal at B exists → `true`; no deal → `false`; `logError` called once with code.
- [ ] **Step 2: Run** `npx vitest run src/lib/contact-crossovers.test.js` → the three fail.
- [ ] **Step 3: Implement** a third probe inside `probeMembershipOrClient` after the `un1t_clients` probe: `db.from('glofox_crossover_members').select('id').eq('contact_id', contactId).in('location_id', locIds).limit(1)`, same error rule as the other two (log, never grant, fall through). Update the function's header comment (it names "membership, client and deal branches").
- [ ] **Step 4: Run** the file → PASS. Also `npx vitest run src/app/api/contacts/\[id\]/mia-purchase-intents` (it calls `canViewContact`).
- [ ] **Step 5: Commit** `ORGCONTACTS.0 — canViewContact admits a Glofox crossover (no more list-then-404)`.

### Task 2: Mig 762 — deals join the RLS helper

The spec offers "deals added to the RLS helper (or removed from the RPC, pick one)". **Pick: add deals to the helper.** Removing them from the RPC would hide deal-only crossovers from the web list, a regression; adding them to the helper fixes the phone (§1 "deal-only crossovers vanish on the phone") and is the direction Phase 2 goes anyway.

**Files:**
- Create: `supabase/migrations/762_contacts_read_by_studio_deal.sql`
- Test: `tests/migration-762-contacts-read-by-studio-deal.test.js`
- Modify: `tests/contacts-read-scope-migration-guard.test.js` (`MEMBERSHIP_HELPER_BODIES[762]`, `LATEST_MEMBERSHIP_HELPER_MIGRATION = 762`, the header comment and the `why` string `'body is not mig 731's, 732's or 758's'`)

**Interfaces:**
- Produces: `private.auth_contact_membership_contact_ids()` gains a fourth UNION branch: `SELECT d.contact_id FROM public.deals d WHERE d.contact_id IS NOT NULL AND d.location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])`. Name, signature, DEFINER, STABLE, `SET search_path = ''`, ACL (authenticated + service_role) unchanged. `contacts_select` untouched. `crossover_contact_ids(uuid)` untouched (it already returns deal holders).

- [ ] **Step 1: Write the failing test**, copying `tests/migration-758-glofox-crossover-members.test.js`'s shape (`bootProd` with `BEFORE2`, `migrate: [MIG_699, MIG_731, MIG_732, MIG_758, MIG_762]`, the same `GLOFOX_ROWS`). Cases:
  - `'before 762: a deal-only crossover (C_A, deal at B) is invisible to STAFF_B'` → `sees` false.
  - `'after 762: STAFF_B sees C_A; count is 5'`.
  - `'a deal at a studio where the caller lacks Contacts grants nothing'` (deal at D for C_C1; STAFF_B does not see a contact living at C with only that).
  - `'the helper: 762 body md5, DEFINER, STABLE, search_path pinned; authenticated + service_role only'` (compute the md5 the way 758's test does and paste it into the file's pre-check and self-check constants; the test asserts the constant is not `'@@'`).
  - `'the policy is 731's, untouched'`, `'InitPlan, loops=1'`, `'a second run changes nothing'`, abort cases (helper edited by hand, policy changed by hand, 758 never applied), and the header's rollback record (758's sections 2 and the GRANTs, verbatim).
- [ ] **Step 2: Run** `npx vitest run tests/migration-762-contacts-read-by-studio-deal.test.js` → ENOENT on the file.
- [ ] **Step 3: Write the migration** in 758's layout: header (WHY / THE FIX / WHO CHANGES / APPLY / ROLLBACK), `BEGIN; SET LOCAL lock_timeout = '5s'; SET LOCAL search_path = public;`, pre-check (policy qual is 731's; helper md5 is 758's or this file's), temp ACL capture of `contacts`, `CREATE OR REPLACE FUNCTION private.auth_contact_membership_contact_ids()` with the four branches, `COMMENT`, `REVOKE`/`GRANT`, self-check (a–g as in 758, `d` becomes "the deals ACL unchanged"), `RAISE NOTICE`, `COMMIT;`.
- [ ] **Step 4: Update the guard**: add the 762 body to `MEMBERSHIP_HELPER_BODIES`, set `LATEST_MEMBERSHIP_HELPER_MIGRATION = 762`, extend the `why` text and the header. Run `npx vitest run tests/contacts-read-scope-migration-guard.test.js tests/migration-762-contacts-read-by-studio-deal.test.js tests/migration-758-glofox-crossover-members.test.js tests/function-execute-guard.test.js tests/private-function-execute-guard.test.js` → PASS.
- [ ] **Step 5: Apply** via MCP after the PR is approved and before merge; `get_advisors` security; paste the NOTICE into the PR.
- [ ] **Step 6: Commit** `ORGCONTACTS.0 — mig 762: a deal at a studio where the caller holds Contacts admits the contact (phone directory parity)`.

### Task 3: Stale pill tooltip and the list's crossover reason

**Files:**
- Modify: `src/components/ContactsTable.jsx:56` (the `title`), `src/lib/contact-crossovers.js` header comment on `fetchCrossoverContext`
- Test: `src/components/ContactsTable.test.jsx` (create if absent; RTL)

- [ ] **Step 1: Write the failing test** `'the crossover pill names the primary studio and no reason'`: render a row with `crossoverContext = { [id]: { homeStudio: 'UN1T Stillorgan', tags: [] } }`; expect the pill's `title` to equal `"Primary studio: UN1T Stillorgan. Shown here because they have a relationship with this studio."`.
- [ ] **Step 2: Run** → FAIL on the old "deal at this studio" text.
- [ ] **Step 3: Change the `title`** to the Global Constraints copy. Keep `homeStudio` as the key name (renamed in Task 12 when the data source changes).
- [ ] **Step 4: Run** → PASS. `npm run check:guardrails` (no dead `un1t-*` token, chip contrast).
- [ ] **Step 5: Commit** `ORGCONTACTS.0 — contacts list pill: primary studio, not a deal`.

### Task 4: "Sign-off until" date on the studio WhatsApp tab (§3.3, decision 6)

**Files:**
- Create: `src/app/api/locations/[id]/whatsapp/blast-signoff/route.js`, `src/components/settings/whatsapp/BlastSignoffCard.jsx`
- Modify: the studio WhatsApp settings tab that renders `StudioWhatsAppNumbers` (find it with `grep -rn StudioWhatsAppNumbers src/app`), `src/lib/openapi.js`
- Test: `src/app/api/locations/[id]/whatsapp/blast-signoff/route.test.js`, `src/components/settings/whatsapp/BlastSignoffCard.test.jsx`

**Interfaces:**
- Produces: `GET /api/locations/[id]/whatsapp/blast-signoff` → `{ success, data: { until: 'YYYY-MM-DD' | null } }`; `PUT` body `{ until: 'YYYY-MM-DD' | null }` (Zod: `z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()`), writes `locations.settings.whatsapp_blast_signoff_until` (`SIGNOFF_SETTING_KEY` from `src/lib/whatsapp-blast-signoff.js`), merging into `settings` (read `settings` first by id, spread, write back, destructure `error`). Gate: `getCurrentUser()` → `assertLocationAccessOr404` → master or `isOrgAdmin(user, location.organization_id)` (`src/lib/org-admin.js`); a manager answers 403 (the window exists to bind managers). Read `locations` by named columns (`id, organization_id, settings`) and never hand `settings` to the client (`redactLocationSecrets` is unnecessary when only `until` leaves the route).

- [ ] **Step 1: Write the failing route tests**: `'GET returns the stored date'`, `'GET returns null when unset'`, `'PUT by an org admin stores the date and keeps the other settings keys'` (assert the update payload's `settings` still carries a sibling key), `'PUT null clears it'`, `'a manager gets 403'`, `'a bad date gets 400'`, `'another organisation's studio is 404'`.
- [ ] **Step 2: Run** → FAIL (module not found).
- [ ] **Step 3: Implement** the route in the mutation skeleton; register both methods in `openapi.js`.
- [ ] **Step 4: Write the failing component test**: renders the label "Sign-off until" and the hint copy; saving calls `PUT` with `{ until }`; the Clear button (`type="button"`) sends `null`; hidden entirely unless `canEdit` (passed by the page: master or org admin).
- [ ] **Step 5: Implement** `BlastSignoffCard` with `Card`/`Field`/`Button` from `@/components/ui`; mount it on the studio WhatsApp tab under `StudioWhatsAppNumbers`.
- [ ] **Step 6: Run** both test files, `npm run check:route-guards`, `npm run check:location-scoping`, `npm run build` → PASS.
- [ ] **Step 7: Commit** `ORGCONTACTS.0 — blast sign-off date is set on the studio WhatsApp tab (org admins)`.

### Task 5: WhatsApp leftovers — mig 763 and the code that stops touching them (§3.1, §3.2)

**Files:**
- Create: `supabase/migrations/763_wa_numbers_leftovers.sql`
- Test: `tests/migration-763-wa-numbers-leftovers.test.js`
- Modify: `src/app/api/organizations/[id]/whatsapp/numbers/route.js` (`NUMBER_COLUMNS` loses `is_default`; POST inserts the home link row itself), `src/lib/whatsapp-numbers-shape.js` (drop `is_default`), `src/components/settings/whatsapp/OrgWhatsAppNumbers.jsx:48` (`FIELD_HELP.home_location_id`), `src/lib/whatsapp-config.js` (delete `templateLocationIdFor`), `src/app/api/whatsapp/templates/route.js` (pass the thread's studio directly), `tests/whatsapp-config-callers.test.js` (remove `templateLocationIdFor` from `RESOLVING['src/lib/whatsapp-config']` and from the templates route row's `calls`; update that row's `why`), `src/lib/org-whatsapp-numbers-fake-db.test-helpers.js`, `src/lib/whatsapp-numbers-fake-db.test-helpers.js`, the route and component tests that assert `is_default`
- Grep first: `grep -rn "is_default" src --include='*.js' --include='*.jsx' | grep -v location_whatsapp_numbers` — every hit on `whatsapp_numbers.is_default` goes; hits on the LINK table's `is_default` stay (that column is the live default).

**Interfaces:**
- Produces (mig 763): `whatsapp_numbers.is_default` dropped with its partial unique index `idx_whatsapp_numbers_default` (mig 176); triggers `trg_whatsapp_numbers_fill_organization` and `trg_whatsapp_numbers_switch_on_at_home` and their functions dropped (`trg_whatsapp_numbers_org_change_guard` STAYS: it is the fence, not compatibility); the `UNIQUE (location_id, label)` constraint from mig 176 (read its name from `pg_constraint` in a `DO` block; never assume the default name) replaced by `whatsapp_numbers_organization_label_unique UNIQUE (organization_id, label)`; `move_whatsapp_conversation` untouched (it orders by the LINK table's `is_default`). Comment on `location_id` updated to: `'Home studio (WAORGNUMBER R1, ORGCONTACTS.0): unknown senders, Meta-made templates and chat-opener edits belong to this studio.'`
- Produces (code): `POST /api/organizations/[id]/whatsapp/numbers` inserts the number, then `location_whatsapp_numbers (location_id = home, whatsapp_number_id, is_default = NOT EXISTS a default at home, created_by = user.id)` itself under the same advisory-lock-free rule the trigger used (a conflict on the PK is a no-op; a conflict on the one-default index → insert with `is_default: false`). `templateLocationIdFor` is gone; the templates route uses the thread's `location_id` it already loads.

- [ ] **Step 1: Write the failing migration test** over a PGlite boot that loads 176's table shape, 743 and 745 (copy `tests/migration-743-wa-org-numbers.test.js`'s boot): `'is_default and its index are gone'`, `'the two compatibility triggers are gone; the org-change guard remains'` (`pg_trigger` by name), `'a number inserted without a link row is NOT switched on anywhere'` (the trigger no longer does it), `'label is unique per organisation, not per studio'` (same label at two studios of one org rejects; same label in two orgs allowed), `'the location_id comment names the three duties'`, `'a second run is a no-op'`, `'the file ends with the self-check and COMMIT and carries no placeholder'`.
- [ ] **Step 2: Run** → ENOENT.
- [ ] **Step 3: Write the migration.** Self-check from the catalog: column absent, index absent, triggers absent, guard trigger present, constraint present with the two columns, `location_whatsapp_numbers` ACL unchanged (temp capture).
- [ ] **Step 4: Write the failing code tests**: in the org numbers route test, `'POST switches the number on at its home studio (default when none)'` and `'POST makes it non-default when the home studio already has one'`; in `whatsapp-config.test.js` delete the `templateLocationIdFor` cases; in the templates route test assert the `?conversation_id=` path serves the thread studio's rows with no resolver call; `OrgWhatsAppNumbers.test.jsx` asserts the new hint copy.
- [ ] **Step 5: Implement** the code changes; update `tests/whatsapp-config-callers.test.js` (the templates route row: `calls` drops `templateLocationIdFor`, `why` says "ORGCONTACTS.0: the thread's studio is read off the conversation row; templateLocationIdFor (an identity kept for the count) is deleted").
- [ ] **Step 6: Run** `npx vitest run tests/migration-763 tests/whatsapp-config-callers src/app/api/organizations src/app/api/whatsapp/templates src/lib/whatsapp-config src/components/settings/whatsapp` and the full CI mirror + `npm run build` → PASS.
- [ ] **Step 7: Apply order:** merge and let Vercel deploy FIRST (the code no longer writes `is_default` or relies on the triggers), THEN `apply_migration` 763, then `get_advisors`. Say so in the PR body.
- [ ] **Step 8: Commit** `ORGCONTACTS.0 — WhatsApp leftovers: is_default dropped, compatibility triggers gone, label unique per organisation, home studio named for its duties`.

- [ ] **PR 1 close-out:** CI mirror + build; `gh pr create --base main`; `docs/changelog/entries/<PR>.md`; PR body lists: mig 762 applied before merge, mig 763 applied after deploy.

---

## PR 2 — Phase 1: `contact_studios`, backfill, triggers, reconcile, dual-writing writers (ORGCONTACTS.1)

Behaviour-neutral: nothing reads the table. The nightly reconcile and the heartbeat row are the only new runtime.

### Task 6: Mig 764 — the table, its triggers, the reconcile function, the backfill, the heartbeat row

**Files:**
- Create: `supabase/migrations/764_contact_studios.sql`
- Test: `tests/migration-764-contact-studios.test.js`
- Modify: `tests/helpers/sql-escapes.js` (`CLOSED_TABLES` gains `contact_studios: 764`)

**Interfaces (every later task relies on these names):**
- Table `public.contact_studios` exactly as Global Constraints states, plus `CHECK (kind IN ('member','client','lead'))`, `CHECK (status IN ('active','ended'))`, `CHECK (source IN ('glofox','un1t_online','lead_form','deal','manual','import'))`, `CHECK ((status = 'ended') = (ended_at IS NOT NULL))`, indexes `contact_studios_location_status (location_id, status)`, `contact_studios_location_contact (location_id, contact_id)`, `contact_studios_org (organization_id)`. Comment names the spec and this plan.
- `private.contact_studios_set_org()` BEFORE INSERT OR UPDATE: sets `NEW.organization_id` from `locations`; raises `'contact_studios: contact % and studio % are in different organisations'` (ERRCODE `23514`) when `contacts.organization_id` differs; stamps `updated_at = now()`.
- `private.contact_studios_freeze_keys()` BEFORE UPDATE: raises on a change to `contact_id` or `location_id` (a relationship is never moved; a new one is inserted).
- `public.derive_contact_studio(p_contact_id uuid, p_location_id uuid) RETURNS TABLE (kind text, status text, source text, stage_slug text, first_seen_at timestamptz, last_seen_at timestamptz)` — STABLE, INVOKER, `SET search_path = ''`, service_role EXECUTE only. **The one implementation of the lifecycle rules**, from the source rows at that studio:
  - `member` when: `contacts.location_id = p_location_id AND contacts.glofox_membership_status IN ('member','credit_member') AND coalesce(contacts.glofox_membership_state,'active') = 'active'`; or `contact_memberships(status='active')` there; or a `un1t_subscriptions` row there (joined through `un1t_clients.contact_id`) with `status` in the SQL copy of `MEMBERSHIP_ACTIVE_STATUSES` (write the list inline and pin it against `src/lib/un1t-online-map.js` in the test, the way mig 690's role lists are pinned); or `un1t_clients` there with `credit_unlimited OR credit_balance > 0`; or a `glofox_crossover_members` row there whose contact is a Glofox `member`/`credit_member`.
  - else `client` when: a `un1t_clients` row there, or `glofox_crossover_members` there, or `contacts.location_id = p_location_id AND contacts.glofox_member_id IS NOT NULL`.
  - else `lead` when: an open deal there, a `contact_location_preferences` row there, or `contacts.location_id = p_location_id`.
  - else `NULL` (no relationship: the caller writes nothing / ends the row).
  - `status`: `'active'` when any of: a live membership (the `member` tests), a provider account (the `client` tests), an open deal, a preferences row; else `'ended'`.
  - `source`: the first non-null of: `'glofox'` (Glofox link or crossover), `'un1t_online'` (`un1t_clients`), `'deal'` (any deal there), `'lead_form'` (preferences row with `source` not in `('import','manual')`), `'import'` (`contacts.created_via_import_id IS NOT NULL` at the primary studio), `'manual'`.
  - `stage_slug`: mig 736's rule applied at `p_location_id` (newest open deal on the enabled primary board there, else on any enabled board there, else NULL).
  - `first_seen_at`: `LEAST` of the earliest `deals.created_at`, `contact_memberships.first_seen_at`, `un1t_clients.created_at`, `glofox_crossover_members.created_at`, `contact_location_preferences.subscribed_at` there, and `contacts.created_at` when primary.
  - `last_seen_at`: `GREATEST` of the latest `deals.updated_at` there, `class_bookings` there (`class_date`/`updated_at`, whichever the table has: check `information_schema` first), `whatsapp_messages.created_at` of threads at that studio for the contact, and `contacts.last_attended_at` when primary; NULL when none.
- `public.reconcile_contact_studios(p_location_id uuid DEFAULT NULL) RETURNS TABLE (inserted int, updated int, ended int, unchanged int, skipped_no_primary int)` — VOLATILE, INVOKER, `SET search_path = ''`, service_role only. For every (contact, studio) pair in the union of the five sources (plus `contacts.location_id`), scoped to one studio when given, upserts `derive_contact_studio`'s answer: `first_seen_at` never moves later, `last_seen_at` never moves earlier, `ended_at` set when status becomes `'ended'` and cleared when it returns to `'active'`, `stage_slug`/`kind`/`status`/`source` overwritten. A contact with NULL `location_id` gets no primary row and is counted in `skipped_no_primary`. A pair whose organisations differ aborts the statement (the trigger raises). Rows never deleted.
- Three triggers:
  - `contact_studios_from_contact` AFTER INSERT ON `contacts`: upsert `(NEW.id, NEW.location_id)` via `derive_contact_studio` when `NEW.location_id IS NOT NULL`.
  - `contact_studios_from_deal` AFTER INSERT OR UPDATE OR DELETE ON `deals`: for `OLD.location_id` and `NEW.location_id` (each, when not null and `contact_id` not null) upsert from `derive_contact_studio`, and on INSERT/UPDATE stamp `last_seen_at = GREATEST(last_seen_at, now())` for NEW's studio (a deal touch is activity). Fires AFTER `sync_contacts_pipeline_stage_slug_trigger` (names sort: name it `zz_contact_studios_from_deal` or document the ordering in the file).
  - `contact_studios_from_preferences` AFTER INSERT ON `contact_location_preferences`: upsert `(NEW.contact_id, NEW.location_id)` from `derive_contact_studio`.
  - All three DEFINER (`contact_studios` is closed; `contact_location_preferences` writers are service-role anyway), `SET search_path = public, pg_temp`, EXECUTE revoked from PUBLIC/anon/authenticated.
- Backfill: `SELECT * FROM public.reconcile_contact_studios(NULL)` inside the file; self-check: `count(*) FROM contact_studios` equals the count of distinct pairs in the union (computed independently in the self-check), every row's `organization_id` equals its location's and its contact's, zero rows at a studio where the contact's org differs, `skipped_no_primary` printed in the NOTICE (expected small; the file does not abort on it).
- `cron_heartbeats` row `contact-studios-reconcile` (interval 1 day, grace 2 hours: the cron runs at 03:30 `PLATFORM_TZ`; size per the CLAUDE.md cron bullet).

- [ ] **Step 1: Write the failing test** on a `bootProd` fixture extended with `deals(contact_id, location_id, status, stage_id, created_at, updated_at)`, `pipelines`/`pipeline_stages` (as the 736 test builds them), `contact_memberships`, `un1t_clients(credit_balance, credit_unlimited, created_at)`, `un1t_subscriptions(location_id, un1t_user_id, status)`, `glofox_crossover_members`, `contact_location_preferences`, `class_bookings` (minimal), `whatsapp_conversations`/`whatsapp_messages` (minimal), `cron_heartbeats`. Fictional ids. Cases:
  - `'backfill: one row per (contact, studio) in the union; counts match the self-check'`.
  - `'primary studio row exists for every contact with a location_id; a NULL location_id is skipped and counted'`.
  - `'kind: member > client > lead'` (one contact each: Glofox member at primary; un1t client with lapsed status; deal only; preferences only; crossover row for a Glofox member → `member` at the crossover studio).
  - `'status: active on an open deal; ended once the deal closes and nothing else holds; ended_at set then cleared on re-open'`.
  - `'first_seen_at never moves later; last_seen_at never moves earlier across two reconciles'`.
  - `'last_seen_at is activity: a deal touch stamps it; a reconcile with a newer whatsapp message at that studio moves it; a sync-only change does not'`.
  - `'stage_slug follows mig 736's rule per studio (a Hatch deal sets Hatch's row, not Stillorgan's)'`.
  - `'deal moved to another board: old studio row re-derived, new studio row created'` (Review Focus 5).
  - `'a preferences row creates a lead row at that studio'`.
  - `'contact insert creates the primary row'`.
  - `'cross-organisation pair raises 23514 and the statement rolls back'`.
  - `'contact_id/location_id cannot change on a row'`.
  - `'closed to clients: anon/authenticated denied on SELECT/INSERT/UPDATE/DELETE; RLS on; no policy'`.
  - `'derive_contact_studio and reconcile_contact_studios are service_role only; trigger functions closed'`.
  - `'MEMBERSHIP_ACTIVE_STATUSES inline list equals src/lib/un1t-online-map.js'` (read the SQL text).
  - `'the heartbeat row exists with the planned interval and grace'`.
  - `'a second run is a no-op'`; file ends with self-check + `COMMIT`; no `@@`.
- [ ] **Step 2: Run** → ENOENT.
- [ ] **Step 3: Write the migration** in the 758 layout (header with ROLLBACK record: `DROP TRIGGER` ×3, `DROP FUNCTION` ×5, `DROP TABLE`, `DELETE FROM cron_heartbeats WHERE name = …`).
- [ ] **Step 4: Add `contact_studios: 764` to `CLOSED_TABLES`** and run `npx vitest run tests/migration-764 tests/closed-table-escapes-guard tests/table-default-acl-guard tests/function-execute-guard tests/private-function-execute-guard tests/consent-tables-client-closed-guard tests/contacts-client-writes-guard` → PASS. (`contacts-client-writes-guard` must still pass: the contact-insert trigger is a DEFINER trigger reading contacts, not a client writer.)
- [ ] **Step 5: Apply** via MCP before merge; `get_advisors`; paste the NOTICE (row count, `skipped_no_primary`) into the PR.
- [ ] **Step 6: Commit** `ORGCONTACTS.1 — mig 764: contact_studios, its triggers, reconcile_contact_studios, backfill`.

### Task 7: The JS helper module `src/lib/contact-studios.js`

**Files:**
- Create: `src/lib/contact-studios.js`
- Test: `src/lib/contact-studios.test.js`
- Modify: `scripts/check-location-scoping.mjs` (`SCOPING_HELPERS` gains `contactsAtStudio` and `studiosOfContact`, after reading that they filter on `location_id` / `contact_id`)

**Interfaces (all service-role `db`; none throws; every read error comes back as `error`; pages under the 1,000-row cap with `.range()` and a total order):**
- `KINDS = Object.freeze(['member','client','lead'])`, `STATUSES = Object.freeze(['active','ended'])`, `SOURCES = Object.freeze([...])` (the six).
- `upsertContactStudio(db, { contactId, locationId, kind, source, status = 'active', firstSeenAt = null, stageSlug = undefined, nowIso = new Date().toISOString() })` → `{ ok: true, row } | { ok: false, error }`. Upsert on `(contact_id, location_id)`; never lowers `first_seen_at` (pass `firstSeenAt` only on insert: use `.upsert(…, { onConflict, ignoreDuplicates: false })` with a payload that omits `first_seen_at`, then a second `.update({ first_seen_at })` guarded `.gt('first_seen_at', firstSeenAt)` when given); never touches `last_seen_at`; sets `ended_at` to `nowIso` when `status = 'ended'`, NULL when `'active'`; `stage_slug` only when `stageSlug !== undefined`.
- `touchContactStudio(db, { contactId, locationId, at = new Date().toISOString() })` → `{ ok, error? }`: `UPDATE … SET last_seen_at = GREATEST(last_seen_at, at)` expressed as `.update({ last_seen_at: at }).eq(...).or('last_seen_at.is.null,last_seen_at.lt.' + at)`; zero rows is `ok: true, touched: false` (no relationship yet is not an error).
- `contactsAtStudio(db, locationId, { kinds = null, status = null, contactIds = null } = {})` → `{ ok: true, rows: [{ contact_id, kind, status, source, stage_slug, first_seen_at, last_seen_at }] } | { ok: false, error }`. `contactIds` chunked at 150 (`IN_CHUNK`).
- `studiosOfContact(db, contactId, { activeOnly = false } = {})` → `{ ok: true, rows: [{ location_id, kind, status, source, stage_slug, first_seen_at, last_seen_at, location: { id, name, active, is_host_anchor, organization_id, membership_source } }] }`; `activeOnly` drops `status = 'ended'` rows AND rows at inactive or host-anchor locations (Review Focus 1).
- `studiosOfContacts(db, contactIds)` → `{ ok, byContact: Map<contactId, rows[]> }` (chunked).
- `hasRelationshipAt(db, contactId, locationIds)` → `{ ok, at: Set<locationId> }` (any status; decision 2).
- `primaryStudioOf(contact)` → `contact.location_id` (pure; exists so readers name the concept).
- `pickStudioByActivity(rows, { primaryLocationId })` (pure): among rows with `status = 'active'`, the latest `last_seen_at`; tie → `primaryLocationId` if present among them, else the lowest `location_id` by string compare; no active rows → `primaryLocationId ?? null` (Review Focus 3; Task 18 uses it).

- [ ] **Step 1: Write the failing tests** with a hand-rolled chainable fake db (as `src/lib/contact-crossovers.test.js` does): one per function incl. the first_seen_at guard, the `touch` GREATEST semantics, chunking at 151 ids (two calls), the `activeOnly` filter (ended row, inactive location, host anchor all dropped), `pickStudioByActivity` ties and the no-active fallback, and every read error returning `ok: false` without throwing.
- [ ] **Step 2: Run** → module not found.
- [ ] **Step 3: Implement** the module (header comment naming the spec and the lifecycle rules verbatim).
- [ ] **Step 4: Register** the two scoping helpers; run the file, `npm run check:location-scoping`, `npm run check:select-columns` (the module names real columns: it must resolve against mig 764) → PASS.
- [ ] **Step 5: Commit** `ORGCONTACTS.1 — contact-studios.js: the one reader and writer of contact_studios`.

### Task 8: un1t.online sync dual-writes `contact_studios` (§2.1 writers)

**Files:**
- Modify: `src/lib/un1t-online-sync.js` (`reconcileMemberships`, and the client-resolve step that writes `un1t_clients.contact_id`)
- Test: `src/lib/un1t-online-sync.test.js` (the existing step-7 describe) and `src/lib/un1t-online-sync.contact-studios.test.js` (new)

**Interfaces:**
- Consumes: `upsertContactStudio` (Task 7).
- Produces: after the `contact_memberships` upsert, for every contact in `best` → `upsertContactStudio({ kind: 'member', source: 'un1t_online', status: 'active', firstSeenAt: nowIso })`; for every `un1t_clients` row with a `contact_id` resolved this run that is NOT in `best` → `{ kind: 'client', source: 'un1t_online', status: 'active' }`; for every membership row this run ENDS → `upsertContactStudio({ kind: 'client', source: 'un1t_online', status: 'active' })` (a lapsed client keeps an active client relationship; the nightly reconcile demotes further when the un1t_clients row goes). Counts under `counts.contact_studios = { member, client, failed }`. A failed upsert is logged (`logError`, no PII) and counted, never fails the run (`contact_memberships` stays the authority until Phase 5).

- [ ] **Step 1: Write the failing tests**: `'writes a member row for every best subscription'`, `'writes a client row for a client with no live subscription'`, `'an ended membership becomes a client row, not an ended row'`, `'a failed contact_studios write is counted and the run still succeeds'`, `'first_seen_at is passed as nowIso only (never last_seen_at)'`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; keep the existing step-7 ordering and guards untouched (the two guards on endings still decide what ends).
- [ ] **Step 4: Run** `npx vitest run src/lib/un1t-online-sync` and `tests/un1t-online-write-guard.test.js` (the sync must stay fenced from write-back) → PASS.
- [ ] **Step 5: Commit** `ORGCONTACTS.1 — un1t.online sync dual-writes contact_studios (member / client)`.

### Task 9: Glofox sync and the crossover writer dual-write `contact_studios`

**Files:**
- Modify: `src/lib/glofox-sync.js` (`applyMemberSync`, after the contact write at ~2105), `src/lib/glofox-crossover.js` (`recordGlofoxCrossover`)
- Test: `src/lib/glofox-sync.contact-studios.test.js` (new), `src/lib/glofox-crossover.test.js`

**Interfaces:**
- Consumes: `upsertContactStudio`, `MEMBER_STATUSES` and `hasBookableMembership` from `src/lib/person-accounts.js`.
- Produces: `applyMemberSync` → after the contact row is written (create or update), `upsertContactStudio({ contactId, locationId, kind: hasBookableMembership(mapped) ? 'member' : (MEMBER_STATUSES.includes(mapped.glofox_membership_status) ? 'member' : 'client'), source: 'glofox', status: 'active', firstSeenAt: mapped.joined_at ?? nowIso })`; result carried as `contact_studio: { ok, error? }` on the apply result, logged on failure, never fatal. `recordGlofoxCrossover` → after the link row, the same upsert at `locationId` (the Glofox studio) with `kind` from the contact row's Glofox columns when the caller passes them (new optional arg `contactRow`), else `'client'`; `out.contact_studio` added to its return.

- [ ] **Step 1: Write the failing tests**: `'applyMemberSync writes a member row for a bookable member'`, `'… a client row for an ex-member'`, `'… at the crossover studio too, via recordGlofoxCrossover'`, `'a failed contact_studios write is logged and the apply result still succeeds'`, `'recordGlofoxCrossover skips the upsert when it skips the link (contact lives here)'`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Keep `tests/glofox-write-retry-guard.test.js` green (no new `glofoxFetch`).
- [ ] **Step 4: Run** `npx vitest run src/lib/glofox-sync src/lib/glofox-crossover src/app/api/webhooks/glofox src/app/api/glofox/crossover-backfill` → PASS.
- [ ] **Step 5: Commit** `ORGCONTACTS.1 — Glofox sync and crossover link dual-write contact_studios`.

### Task 10: Lead-form and race paths, the nightly reconcile cron, and the WhatsApp activity stamp

**Files:**
- Create: `src/app/api/cron/contact-studios-reconcile/route.js`, `src/app/api/cron/contact-studios-reconcile/route.test.js`
- Modify: `vercel.json` (`"path": "/api/cron/contact-studios-reconcile", "schedule": "30 3 * * *"`), `src/lib/race-contact-linking.js` (`findOrCreateRaceContact`: when the resolved contact's `location_id !== locationId`, `upsertContactStudio({ kind: 'lead', source: 'lead_form', status: 'active' })` at the event's studio), `src/app/api/webhooks/whatsapp/route.js` (after the inbound message is stored at `locationId` for a known contact: `touchContactStudio(db, { contactId, locationId })`, fire-and-forget in its own try/catch), `src/lib/openapi.js`
- Test: `src/lib/race-contact-linking.test.js`, `src/app/api/webhooks/whatsapp/route.contact-studios.test.js` (new)

**Interfaces:**
- Produces: `GET /api/cron/contact-studios-reconcile` (Bearer `CRON_SECRET`): `db.rpc('reconcile_contact_studios', { p_location_id: null })`, destructures `error`, logs the five counts, `stampHeartbeat('contact-studios-reconcile', outcome)` on success only; a failed RPC returns `{ success: false }` with 500 and no stamp. The public lead form (`/api/public/leads`) needs no change: its contact insert fires the contacts trigger (primary studio) and its consent write fires the preferences trigger (a sibling studio's lead row).

- [ ] **Step 1: Write the failing tests**: cron route (`'calls the rpc, stamps the heartbeat, returns the counts'`, `'a failed rpc returns 500 and never stamps'`, `'no bearer → 401'`); race linking (`'a sibling-studio contact registering at this studio's event gets a lead row here'`, `'a contact at this studio gets no upsert (the trigger made its row)'`); webhook (`'an inbound text from a known contact touches last_seen_at at the routed studio'`, `'a failed touch is logged and the webhook still answers 200'`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; add the `vercel.json` entry; register the cron in `openapi.js`; confirm `grep -L stampHeartbeat src/app/api/cron/*/route.js` lists only `health-check` and `ad-insights-backfill`.
- [ ] **Step 4: Run** the three test files, `npm run check:route-guards`, `npm run check:rpc-names` (the new rpc name resolves against mig 764) → PASS.
- [ ] **Step 5: Commit** `ORGCONTACTS.1 — lead rows from race registration, the nightly reconcile cron, WhatsApp activity stamps last_seen_at`.

- [ ] **PR 2 close-out:** CI mirror + build; mig 764 applied via MCP (before merge; confirm the heartbeat row is seeded in the same transaction and that the first cron tick after deploy stamps it: watch `cron_heartbeats` the next morning); `gh pr create`; changelog entry.

---

## PR 3 — Phase 2: readers (ORGCONTACTS.2)

Each task deletes the old path it replaces, in the same PR. Visibility widens (decision 2: any row, lapsed too); nothing narrows.

### Task 11: Mig 765 — the RLS helper reads `contact_studios`; the `studio_contacts` view

**Files:**
- Create: `supabase/migrations/765_contacts_read_by_contact_studios.sql`
- Test: `tests/migration-765-contacts-read-by-contact-studios.test.js`
- Modify: `tests/contacts-read-scope-migration-guard.test.js` (new helper name and body; see below), `tests/helpers/sql-escapes.js` (no change: the view is INVOKER and service-role only, but run the guard)

**Interfaces:**
- Produces: `private.auth_contact_studio_contact_ids() RETURNS uuid[]` — DEFINER, STABLE, `SET search_path = ''`, authenticated + service_role EXECUTE: `SELECT coalesce(array_agg(DISTINCT cs.contact_id), '{}'::uuid[]) FROM public.contact_studios cs WHERE cs.location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[])` (any status: decision 2). `contacts_select` becomes `location_id = ANY ((SELECT private.auth_contact_read_location_ids())::uuid[]) OR user_id = (SELECT auth.uid()) OR id = ANY ((SELECT private.auth_contact_studio_contact_ids())::uuid[])` (`ALTER POLICY`, under `lock_timeout`). `private.auth_contact_membership_contact_ids()` is re-created as a one-line delegate `SELECT private.auth_contact_studio_contact_ids()` (kept until Phase 5 so any cached plan or hand query keeps working; comment says DEPRECATED (mig 765)). `public.crossover_contact_ids(loc uuid)` re-created to read `contact_studios` (`WHERE cs.location_id = loc AND c.location_id IS DISTINCT FROM loc`), also DEPRECATED (mig 765), dropped in Phase 5.
- View `public.studio_contacts WITH (security_invoker = on)`: `SELECT c.*, cs.location_id AS studio_location_id, cs.kind AS studio_kind, cs.status AS studio_status, cs.source AS studio_source, cs.stage_slug AS studio_stage_slug, cs.first_seen_at AS studio_first_seen_at, cs.last_seen_at AS studio_last_seen_at, (c.location_id IS DISTINCT FROM cs.location_id) AS studio_is_crossover FROM public.contacts c JOIN public.contact_studios cs ON cs.contact_id = c.id`; `REVOKE ALL ON public.studio_contacts FROM anon, authenticated, PUBLIC; GRANT SELECT ON public.studio_contacts TO service_role`.
- Guard: `tests/contacts-read-scope-migration-guard.test.js` gains `READ_BRANCHES.studio = 'id=any((selectprivate.auth_contact_studio_contact_ids())::uuid[])'`, a `STUDIO_HELPER` constant with its single accepted body, `LATEST_STUDIO_HELPER_MIGRATION = 765`; a migration after 765 that re-creates the OLD helper with anything but the delegate body, or the new helper with any other body, or that reads `contact_studios` in a policy with any status filter, is a breaker. The 731/732/758/762 bodies stay accepted for files ≤ 764 only.

- [ ] **Step 1: Write the failing test** (758's shape; boot: `MIG_699, MIG_731, MIG_732, MIG_758, MIG_762, MIG_764, MIG_765` over the Task 6 fixture tables): `'STAFF_B sees every contact with a contact_studios row at B, ended included; not one with a row only at D'`, `'a contact with no row at any of the caller's studios and a home elsewhere is invisible'`, `'members see their own row only; master sees all'`, `'the policy qual is the 765 text; one policy'`, `'both helpers are InitPlans, loops=1'`, `'studio_contacts is security_invoker, closed to clients, readable by service_role; studio_is_crossover is true only when primary ≠ studio'`, `'crossover_contact_ids reads contact_studios and excludes the primary studio'`, `'the old helper is a delegate (md5 pinned) and carries the DEPRECATED comment'`, abort cases (764 missing; policy edited by hand), rollback record (762's helper body + 731's `ALTER POLICY` + `DROP VIEW` + `DROP FUNCTION private.auth_contact_studio_contact_ids()`), idempotent re-run.
- [ ] **Step 2: Run** → ENOENT.
- [ ] **Step 3: Write the migration** (758 layout; `ALTER POLICY` takes ACCESS EXCLUSIVE on `contacts`, say so and keep `lock_timeout = '5s'`).
- [ ] **Step 4: Update the guard** (new constants; header rewritten to describe the single-branch model and the 765 cut-over); run `npx vitest run tests/migration-765 tests/contacts-read-scope-migration-guard tests/migration-762 tests/migration-758 tests/closed-table-escapes-guard tests/function-execute-guard tests/private-function-execute-guard tests/anon-contacts-guard` → PASS. `npm run check:select-columns`: if the gate cannot resolve `studio_contacts` (a join view), add each `studio_*` column to `.select-columns-allowlist.json` with reason "view defined in mig 765; join views are skipped by the replay" and an expiry 90 days out.
- [ ] **Step 5: Apply** before merge; `get_advisors`; NOTICE into the PR.
- [ ] **Step 6: Commit** `ORGCONTACTS.2 — mig 765: contacts_select reads contact_studios (any relationship); studio_contacts view`.

### Task 12: Web contacts list and search read the view; `canViewContact` reads the table

**Files:**
- Modify: `src/app/(sales)/contacts/page.js` (the `or(location_id.eq.L, id.in.(…))` at ~78-81 → `db.from('studio_contacts').select(<named columns>).eq('studio_location_id', locationId)`; `fetchCrossoverContext` fed from `studio_is_crossover` + `location_id`), `src/app/api/contacts/search/route.js` (same; `include_crossovers` flag removed from the Zod schema and from `ContactsView.jsx:179`), `src/lib/contact-crossovers.js` (`crossoverContactIds` and `CROSSOVER_ID_CAP` deleted; `canViewContact` → `user.isMaster || hasRelationshipAt(db, contact.id, contactStudioIds(user, locIds)).at.size > 0`, fail closed on `ok: false`; `isCrossoverAt`, `crossoverIdsAt` → `contactsAtStudio` with `contactIds` and no status filter; `fetchCrossoverContext` keeps its shape, keyed on `homeStudio`), `src/lib/openapi.js` (search schema)
- Test: `src/lib/contact-crossovers.test.js`, `src/app/(sales)/contacts/page.test.js` (create if absent, server-page harness as sibling pages use), `src/app/api/contacts/search/route.test.js`, `src/components/ContactsView.test.jsx`

**Interfaces:**
- Consumes: `hasRelationshipAt`, `contactsAtStudio` (Task 7); the view (Task 11).
- Produces: `canViewContact(db, user, contact)` same signature, new rule (any relationship at a Contacts studio of the caller; owned branch and master branch unchanged; the three probes and the deal probe deleted). `isCrossoverAt(db, contactId, locationId)` → true on any row there whose contact's primary ≠ `locationId`. `crossoverIdsAt(db, contactIds, locationId)` → the subset with a row there (any status). The search route's response and the page's props keep `crossoverContext` keyed by contact id with `{ homeStudio, tags }`.

- [ ] **Step 1: Write the failing tests**: `canViewContact` (`'any row, ended included, at a caller's Contacts studio opens the contact'`, `'a row at a studio where the caller lacks Contacts does not'`, `'a failed read denies'`, `'no probes for an owned contact or a master'`); page (`'queries studio_contacts filtered on the active studio and never builds an id.in() list'`, `'a crossover row carries its primary studio name'`); search (`'no include_crossovers flag; results include relationships at the studio'`); radar routes' tests (`isCrossoverAt`/`crossoverIdsAt` callers in `src/app/api/{lead-radar,churn-radar}/*`) updated to seed `contact_studios` rows instead of memberships.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; delete the dead exports; grep `crossoverContactIds|CROSSOVER_ID_CAP|include_crossovers` → only the mobile route (Task 13) remains.
- [ ] **Step 4: Run** the files, `npm run check:location-scoping` (`studio_contacts` is a tenant relation: the page filters on `studio_location_id`; register it in the script's tenant set if the derivation from migrations misses views), `npm run build` → PASS.
- [ ] **Step 5: Commit** `ORGCONTACTS.2 — contacts list, search and canViewContact read contact_studios; the id.in() crossover list is gone`.

### Task 13: Mobile crossover-ids route reads `contact_studios`; the phone's pill reads `contacts.location_id` (deviation, see Global Constraints)

**Files:**
- Modify: `src/app/api/mobile/contacts/crossover-ids/route.js` (`contactsAtStudio(db, locationId)` → ids whose primary ≠ studio, i.e. filter on a joined `contacts.location_id`: read the view `studio_contacts` with `.eq('studio_location_id', L).eq('studio_is_crossover', true).select('id')`, paged, capped at `MOBILE_CROSSOVER_ID_CAP = 100` defined in the route with the same URL-length reason), `mobile/lib/contacts-api.js` (unchanged query shape; the header comment names `contact_studios`)
- Test: `src/app/api/mobile/contacts/crossover-ids/route.test.js`, `mobile/lib/contacts-api.test.js`

- [ ] **Step 1: Write the failing tests**: `'returns ids with a relationship here whose primary studio is elsewhere, ended included'`, `'caps at 100 and logs'`, `'a failed view read answers [] (directory falls back to owned)'`, `'403 without mobile Contacts'`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** + `npm run check:mobile-imports && npm run check:mobile-lint && npm run check:mobile-parity` → PASS.
- [ ] **Step 5: Commit** `ORGCONTACTS.2 — phone directory crossover ids come from contact_studios`.

### Task 14: PIPEEXCL, member pricing, "joined this studio", the contact page's memberships card

**Files:**
- Modify: `src/lib/membership/glofox-active-members.js` (the `contact_memberships` read → `contactsAtStudio(db, locationId, { kinds: ['member'], status: 'active' })`; the Glofox column read stays), `src/lib/membership/reads/un1t-online-radar.js` / `un1t-online.js` (where they read `contact_memberships`: same substitution), `src/lib/member-validation.js:130-141` (the `contact_memberships` probe → `contactsAtStudio` over `locationIds` with `kinds: ['member'], status: 'active', contactIds`), `src/lib/contact-studio-link.js` (`contactIdsLinkedToStudio`: the `deals`/`contact_location_preferences` loop → one `contactsAtStudio(db, locationId, { contactIds })` call, any status; header rewritten: "joined this studio" = a `contact_studios` row), `src/lib/contact-memberships.js` (`loadContactMemberships` reads `contact_memberships` still — leave until Phase 5; add `loadContactStudios(db, contactId)` → `studiosOfContact` rows for the contact page's new "Studios" card), `src/app/(sales)/contacts/[id]/page.js` (render the Studios card: studio name, kind, status, first/last seen; the memberships card stays)
- Test: each module's existing test file; `src/components/ContactStudiosCard.test.jsx` (new component `src/components/ContactStudiosCard.jsx`)

- [ ] **Step 1: Write the failing tests** per module: PIPEEXCL (`'an active member row at the other studio leaves the board; an ended row does not'`), pricing (`'an active member row at any org studio is a member; a client row is not'`), joined (`'a lead row counts as joined; a sibling with no row is refused; cross-org still refused'`), the card (`'lists each studio with kind and status, primary first'`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** the files + `npx vitest run src/lib/pipeline-reclassify src/app/api/sequences` → PASS.
- [ ] **Step 5: Commit** `ORGCONTACTS.2 — PIPEEXCL, member pricing, sequence "joined", and the contact page read contact_studios`.

### Task 15: Glofox readers read `contact_studios` (GLOFOXREADERS.1 undone)

**Files:**
- Modify: `src/app/api/cron/glofox-attendance-refresh/route.js`, `src/app/api/cron/glofox-detail-backfill/route.js`, `src/app/api/glofox/reconcile-arrears/route.js`, `src/app/api/admin/glofox-invoice-csv-import/route.js` (each: `glofoxCrossoverContactIds` + `scopeToGlofoxStudio` → `contactsAtStudio(db, locationId, { contactIds? })` ids with a Glofox link, then the same `or(location_id.eq.L, id.in.(…))` shape they already build, chunked as they already chunk), `src/lib/person-accounts.js:187-192` (`glofox_link_location_ids` ← `studiosOfContacts` rows with `source = 'glofox'`, renamed `studio_location_ids`, every status), `src/lib/glofox-crossover.js` (delete `glofoxCrossoverContactIds`, `glofoxStudioOrCrossoverFilter`, `scopeToGlofoxStudio`, `glofoxLinkLocationsByContact`, `contactAtGlofoxStudio`; keep `findGlofoxCrossoverContact`, `recordGlofoxCrossover`, `organisationOfLocation`), `src/lib/agent/member-studios.js` (`contactAtGlofoxStudio` → an inline `atStudio(c, id)` reading `studio_location_ids`; the full Mia change is Task 17), `src/lib/glofox-sync.js` (uses of the deleted names)
- Test: each route's test; `src/lib/person-accounts.test.js`; `src/lib/glofox-crossover.test.js`

- [ ] **Step 1: Write the failing tests**: for each reader `'includes a contact with a contact_studios row at the Glofox studio whose primary is elsewhere'`, `'a failed contact_studios read is an error, never "no crossovers"'`; `person-accounts` `'rows carry studio_location_ids from contact_studios'`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; `grep -rn "glofoxCrossoverContactIds\|scopeToGlofoxStudio\|glofoxLinkLocationsByContact\|contactAtGlofoxStudio\|glofox_link_location_ids" src mobile shared` → none.
- [ ] **Step 4: Run** the files + `npm run check:select-columns` → PASS.
- [ ] **Step 5: Commit** `ORGCONTACTS.2 — Glofox readers scope by contact_studios; the GLOFOXREADERS.1 seams are gone`.

- [ ] **PR 3 close-out:** CI mirror + build; mig 765 applied before merge; `gh pr create`; changelog entry naming who gains visibility (staff holding Contacts at a studio gain every lapsed relationship there; nobody loses a row).

---

## PR 4 — Phase 3: Mia and WhatsApp routing read `contact_studios` (ORGCONTACTS.3)

### Task 16: `routeInboundThread` step 4 reads the relationship rows

**Files:**
- Modify: `src/lib/whatsapp-inbound-route.js`
- Test: `src/lib/whatsapp-inbound-route.test.js`

**Interfaces:**
- Consumes: `pickStudioByActivity` (Task 7).
- Produces: `routeInboundThread(db, { …, contact, contactStudios = null })`: `contactStudios` is `[{ location_id, status, last_seen_at }]` for the contact (the webhook passes `studiosOfContact(...).rows`, or null when the read failed or the sender is unknown). Step 4 (`by: 'home'`) becomes `by: 'relationship'`: `pickStudioByActivity(contactStudios.filter(r => candidates.includes(r.location_id)), { primaryLocationId: contact?.location_id })`; when it answers null or `contactStudios` is null, fall to `contact?.location_id` if a candidate (`by: 'home'`, kept as the explicit fallback), then `number_home`. Steps 1–3 and the 7-day rule unchanged.

- [ ] **Step 1: Write the failing tests**: `'an active row at one candidate wins over the home studio'`, `'two active rows: later last_seen_at wins'`, `'equal last_seen_at: primary studio wins when it is one of them, else lower location_id'` (Review Focus 3), `'ended rows are ignored; none active → home if candidate'`, `'null contactStudios → today's home rule'`, `'a row at a non-candidate studio is ignored'`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** + `npx vitest run src/app/api/webhooks/whatsapp` → PASS.
- [ ] **Step 5: Commit** `ORGCONTACTS.3 — inbound routing step 4: the studio where the person has an active relationship, by last activity`.

### Task 17: `resolveMemberStudios` candidates come from `contact_studios`

**Files:**
- Modify: `src/lib/agent/member-studios.js` (`resolveMemberStudios`; `classifyMemberStudios` takes `studioRowsByContact`), `src/lib/person-accounts.js` (Task 15's `studio_location_ids` is the input)
- Test: `src/lib/agent/member-studios.test.js`

**Interfaces:**
- Produces: candidates = org studios with at least one `contact_studios` row for a group contact with `status = 'active'` and `kind IN ('member','client')` (via `studiosOfContacts(db, groupIds)`), plus the thread studio. The `glofox_member_id`/`glofox_link_location_ids` scan and the `un1tClients`/`un1tSubscriptions` location harvest are no longer candidate sources (they still feed `active`). `glofoxStudioFor` counts a contact at the studio when `c.location_id === location.id || studioRowsByContact.get(c.id)?.some(r => r.location_id === location.id)`. One MemberStudio per studio; `contactIds` sorted (Review Focus 2). A failed `studiosOfContacts` read → `FAILED()`.

- [ ] **Step 1: Write the failing tests**: `'candidates are the studios with an active member/client row for any group contact, plus the thread studio'`, `'a lead-only row is not a candidate'`, `'two group contacts with rows at one studio yield one MemberStudio with both ids, sorted'`, `'a failed contact_studios read is readFailed, never studios: []'`, `'active is still decided by the live Glofox/un1t checks'` (an active row with no bookable membership → `active: false`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** + `npx vitest run src/lib/agent` + `tests/mia-no-charge-no-refund-guard.test.js` → PASS.
- [ ] **Step 5: Commit** `ORGCONTACTS.3 — Mia's member studios come from contact_studios; the person-group + crossover scan is gone`.

### Task 18: `pickInboundContact` simplified; the webhook wires both

**Files:**
- Modify: `src/lib/whatsapp.js:2132` (`pickInboundContact(matches, { candidateLocationIds, studiosByContact, primaryFirst = true })`: the match with an active row at a candidate studio (latest `last_seen_at` across its rows at candidates, ties by Task 7's rule), else the match whose primary is a candidate, else the oldest `created_at`), `src/app/api/webhooks/whatsapp/route.js:300-348` (read `studiosOfContacts` for the phone matches once; pass `studiosByContact` to `pickInboundContact` and the chosen contact's rows to `routeInboundThread`)
- Test: `src/lib/whatsapp.pick-inbound-contact.test.js` (new), `src/app/api/webhooks/whatsapp/route.inbound-route.test.js`

- [ ] **Step 1: Write the failing tests**: pick (`'prefers the contact with an active row at a candidate'`, `'else the one whose primary is a candidate'`, `'else the oldest'`, `'deterministic on ties'`); webhook (`'passes the chosen contact's studio rows to the router'`, `'a failed studios read passes null and routing still 200s'`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement**; update `tests/whatsapp-config-callers.test.js`'s webhook row `why` (no call count changes; text names ORGCONTACTS.3 step 4).
- [ ] **Step 4: Run** + the callers test → PASS.
- [ ] **Step 5: Commit** `ORGCONTACTS.3 — pickInboundContact prefers the relationship; the webhook feeds the router`.

### Task 19: Status webhooks route by the message's stored studio (§3.5) — verify and pin

`handleStatusUpdate` (`src/app/api/webhooks/whatsapp/route.js:825`) already updates `whatsapp_messages` by `wa_message_id` and the broadcast recipient by `(broadcast_id, contact_id)`; it reads no number home. This task pins that.

**Files:**
- Test: `src/app/api/webhooks/whatsapp/route.status-studio.test.js` (new)

- [ ] **Step 1: Write the test** `'a delivery status touches only the message row and its broadcast recipient; never reads whatsapp_numbers or contacts, never changes location_id'`: fake db records every `.from()` table; assert the set is `{ whatsapp_messages, whatsapp_broadcast_recipients }` (plus `contacts` only on the `failed` path's undeliverable flag) and that no update payload carries `location_id`.
- [ ] **Step 2: Run** → PASS (it is a pin). If it fails, the deviation is a bug to fix in this task.
- [ ] **Step 3: Commit** `ORGCONTACTS.3 — pin: status webhooks never re-route by the number's home`.

- [ ] **PR 4 close-out:** CI mirror + build; `gh pr create`; changelog entry; **watch the first day in prod**: `by: 'relationship'` share in the webhook's routing log vs `'home'`.

---

## PR 5 — Phase 4: per-studio stage and lead source, audience join, person groups per org, edit rights (ORGCONTACTS.4) — decision-gated

The change report (Task 20) runs and is read by Richard BEFORE Task 21's flip merges. Tasks 20 and 22–23 can merge ahead of 21 if the report needs discussion.

### Task 20: Mig 766 — `studio_stage_slug` on the audience view; the segment change report

**Files:**
- Create: `supabase/migrations/766_audience_view_studio_stage.sql`, `scripts/segment-stage-change-report.mjs`
- Test: `tests/migration-766-audience-view-studio-stage.test.js`, `scripts/segment-stage-change-report.test.mjs`
- Modify: `tests/audience-view-columns-guard.test.js` (the new column is a view column, not a contacts column: add it to the guard's known view-only list with the reason "mig 766: per-studio stage from contact_studios")

**Interfaces:**
- Produces (mig 766): `contact_location_audience` re-created with `CREATE OR REPLACE VIEW … WITH (security_invoker = on)`, mig 689's column list unchanged and, appended at the END, `cs.stage_slug AS studio_stage_slug, cs.kind AS studio_kind, cs.status AS studio_status` from `LEFT JOIN public.contact_studios cs ON cs.contact_id = c.id AND cs.location_id = clp.location_id` (a person with a preferences row but no stage keeps their reach with NULL). Then `REVOKE ALL … FROM anon, authenticated, PUBLIC` and the ACL restored from the catalog capture (mig 652/689 pattern). `pipeline_stage_slug` stays as the contact-wide column for this release.
- Produces (script): `node scripts/segment-stage-change-report.mjs --org <id> [--out report.md]` (service-role env from `.env.local`; read-only): for every `contact_segments` row of the org whose `filter` references `pipeline_stage_slug`, runs `applyAudienceFilter` twice against the view scoped to the segment's `location_id` (`audience_location_id`), once as stored and once with the field rewritten to `studio_stage_slug` (`rewriteStageField(filter)` exported for the test), and prints a Markdown table: segment, studio, members before, after, `joined`, `left` (counts; ids only in `--verbose`), plus the Review Focus 4 class ("stage NULL at this studio") as its own column. Pages with `.range()`.

- [ ] **Step 1: Write the failing migration test** (689-style boot with the view and `contact_studios`): `'the 689 columns are unchanged and in order; three new columns at the end'`, `'a Hatch preferences row with a Stillorgan stage and no Hatch row: studio_stage_slug NULL, row kept'`, `'security_invoker on; closed to clients; ACL as before'`, `'idempotent'`.
- [ ] **Step 2: Run** → ENOENT. **Step 3: Write the migration.**
- [ ] **Step 4: Write the failing script test**: `rewriteStageField` rewrites only `pipeline_stage_slug` rows (nested logic groups included) and leaves `is_null`/`is_not_null` ops intact; the report lists a fixture contact who is `dormant` at A and has no row at B under `left` for a B segment `pipeline_stage_slug eq dormant` (Review Focus 4).
- [ ] **Step 5: Implement the script**; run it against prod via MCP-free service-role env (or hand Richard the command); save the output as `docs/superpowers/reports/2026-10-DD-segment-stage-change-report.md` (counts only, no PII) and link it in the PR. **Richard reads it before Task 21 merges (decision 3).**
- [ ] **Step 6: Run** both tests + `tests/audience-view-columns-guard.test.js tests/consent-tables-client-closed-guard.test.js` → PASS. Apply mig 766 before merge; `get_advisors`.
- [ ] **Step 7: Commit** `ORGCONTACTS.4 — mig 766: per-studio stage on the audience view; the segment change report`.

### Task 21: The flip — audiences, list filters and the dormant writers read/write the studio stage

**Files:**
- Modify: `src/lib/audience-filter.js` (`AUDIENCE_FIELDS.pipeline_stage_slug` gains `column: 'studio_stage_slug'` and `applyAudienceFilter` uses `cfg.column ?? field` when building the query; `is_null` is already an op), `src/components/AudienceBuilder.jsx` (`FIELD_OPTIONS` label "Pipeline stage (at this studio)"), `src/app/(sales)/contacts/page.js` and `src/app/api/contacts/search/route.js` (the stage filter → `studio_stage_slug` on the view), `src/app/api/lead-radar/cleanup/route.js:140` and `src/app/api/churn-radar/quarantine/route.js:122` (write `contact_studios.stage_slug = 'dormant'` for the radar's studio via `upsertContactStudio({ stageSlug: 'dormant', kind, source, status })` reading the row first for kind/source/status, AND keep writing `contacts.pipeline_stage_slug` only when the radar's studio is the contact's primary)
- Test: `src/lib/audience-filter.test.js`, `src/lib/audience-filter.integration.test.js`, `src/components/AudienceBuilder.test.jsx`, the two radar route tests

- [ ] **Step 1: Write the failing tests**: `'pipeline_stage_slug filters query studio_stage_slug'` (every op), `'the radar archive writes the studio row's stage and the contact column only at the primary studio'`, builder label.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** + `npx vitest run src/lib/campaign-sender src/lib/whatsapp-audience src/lib/audience-eligibility` → PASS.
- [ ] **Step 5: Commit** `ORGCONTACTS.4 — audiences, list filters and dormancy are per studio (decision 3; change report reviewed)`.

### Task 22: Lead source per studio; mig 767 person groups per organisation (§2.4, §2.5)

**Files:**
- Create: `supabase/migrations/767_person_groups_organization.sql`
- Test: `tests/migration-767-person-groups-organization.test.js`
- Modify: `src/app/api/public/leads/route.js:81-90` (write `last_lead_source`/`last_lead_source_at` only when the form's studio is the contact's primary; otherwise the preferences trigger's `lead_form` row is the record), `src/lib/person-links.js` (`createGroup` writes `organization_id` resolved from `locationId`, and still `location_id` for one release), `src/app/api/contacts/[id]/link/route.js:103-108` (the refusal becomes `otherContact.organization_id !== contact.organization_id` → `'Cannot link contacts in different organisations'`; select `organization_id` on both reads), `src/lib/pipeline-other-studio-members.js` (header's "contacts are per studio, linked by a person group" paragraph rewritten to the one-contact-per-org model), `src/lib/contact-studio-link.js` header (already the right model: confirm)
- Test: `src/app/api/public/leads/route.test.js`, `src/lib/person-links.test.js`, `src/app/api/contacts/[id]/link/route.test.js`

**Interfaces:**
- Produces (mig 767): `person_groups.organization_id uuid REFERENCES organizations(id)`, backfilled from `locations`, `SET NOT NULL`; `person_groups.location_id` kept with `COMMENT … 'DEPRECATED (mig 767): groups follow the organisation; dropped in mig 768'`; index `idx_person_groups_organization`; a BEFORE INSERT trigger fills `organization_id` from `location_id` when null (so the old code path keeps working until deploy; dropped in 768); `person_group_members` policy unchanged (681 closed the tables to clients; the policies that remain are the service-role no-ops: confirm in the test).

- [ ] **Step 1: Write the failing migration test**: backfill, NOT NULL, the fill trigger, the comment, closed to clients, idempotent.
- [ ] **Step 2: Run** → ENOENT. **Step 3: Write it.**
- [ ] **Step 4: Write the failing code tests**: leads (`'a sibling studio's form does not overwrite last_lead_source'`, `'the primary studio's form does'`), link route (`'links two contacts of one organisation at different studios'`, `'refuses across organisations with the new message'`), `createGroup` writes `organization_id`.
- [ ] **Step 5: Implement.** **Step 6: Run** + `npm run check:select-columns` → PASS. Apply mig 767 before merge.
- [ ] **Step 7: Commit** `ORGCONTACTS.4 — lead source per studio; person groups follow the organisation`.

### Task 23: Edit rights (decision 4): edit anywhere, delete and change-primary by the primary studio's admins or an org admin

**Files:**
- Create: `src/app/api/contacts/[id]/primary-studio/route.js`, its test; `src/lib/contact-edit-gates.js` (pure), its test
- Modify: `src/app/api/contacts/[id]/route.js` (PUT cookie path at ~100-112; DELETE at ~255-276), `src/lib/contact-page-gates.js` (the PUT/DELETE helper the page's buttons read), `src/app/(sales)/contacts/[id]/page.js` (a "Change primary studio" control for callers the gate admits; a `Select` of the contact's `contact_studios` studios), `src/lib/openapi.js`
- Test: `src/app/api/contacts/[id]/route.test.js`, `src/lib/contact-page-gates.test.js`

**Interfaces:**
- `canEditContact({ user, contact, relationshipStudioIds })` (pure): master; or MANAGER_ROLES at a studio in `relationshipStudioIds` where the caller also holds Contacts (`contactStudioIds`). Today's role bar (MANAGER_ROLES) is kept; the decision widens WHERE, not WHO. `relationshipStudioIds` = `studiosOfContact(db, contact.id).rows.map(r => r.location_id)` (any status).
- `canDeleteOrRehomeContact({ user, contact })` (pure): master; or MANAGER_ROLES at `contact.location_id` (the primary); or `isOrgAdmin(user, contact.organization_id)`.
- `POST /api/contacts/[id]/primary-studio` body `{ location_id: uuidLike }`: gate as delete; 404 for a contact the caller cannot view; 400 `'no_relationship'` unless a `contact_studios` row exists at the target; 400 `'other_organisation'` if the target's org differs; writes `contacts.location_id` (mig 712's trigger keeps `organization_id`; the Task 6 contact-insert trigger does not fire on UPDATE, so the route also calls `upsertContactStudio` for the new primary with `source: 'manual'` only if no row exists, which the gate already refused) and logs an audit row through the existing contacts audit trigger. Response `{ success, data: { location_id } }`.

- [ ] **Step 1: Write the failing tests**: gates (both helpers, every branch), PUT (`'a manager at a relationship studio with Contacts may edit; without Contacts 404; a manager at an unrelated studio 404'`), DELETE (`'primary studio's manager, an org admin, master: allowed; a relationship studio's manager: 403'`), primary-studio route (every refusal; success moves the column).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** + `npm run check:route-guards && npm run check:location-scoping && npm run build` → PASS.
- [ ] **Step 5: Commit** `ORGCONTACTS.4 — edit anywhere with a relationship; delete and change-primary by the primary studio's admins or an org admin`.

- [ ] **PR 5 close-out:** CI mirror + build; migs 766 and 767 applied before merge; the change report linked in the PR and acknowledged by Richard in the PR thread before Task 21's commit merges; `gh pr create`; changelog entry.

---

## PR 6 — Phase 5: drops and invariant rewrites (ORGCONTACTS.5)

### Task 24: Code stops reading the old tables; mig 768 drops them

**Files:**
- Create: `supabase/migrations/768_contact_side_channels_dropped.sql`
- Test: `tests/migration-768-contact-side-channels-dropped.test.js`
- Modify / delete:
  - delete `src/lib/contact-memberships.js` and its test; `src/app/(sales)/contacts/[id]/page.js` drops the memberships card (the Studios card from Task 14 replaces it);
  - `src/lib/un1t-online-sync.js` step 7: `contact_memberships` upsert/end replaced by the Task 8 `contact_studios` writes becoming the ONLY membership record (the two ending guards now guard the `member → client` demotion; `counts.memberships` renamed `counts.contact_studios` and the un1t sync tests updated);
  - `src/lib/glofox-crossover.js`: `recordGlofoxCrossover` writes `contact_studios` + the preferences row only; `findGlofoxCrossoverContact` step 1 reads `contact_studios` (`source = 'glofox'` at the studio joined to `contacts.glofox_member_id`) instead of the link table; delete `GLOFOX_CROSSOVER_TABLE`; `src/app/api/glofox/crossover-backfill/route.js` follows;
  - `src/lib/person-accounts.js` header; `src/lib/membership/*` readers (Task 14 already moved them: confirm no `contact_memberships` string remains: `grep -rn "contact_memberships\|glofox_crossover_members\|crossover_contact_ids\|auth_contact_membership_contact_ids" src mobile shared scripts` → none);
  - `tests/helpers/sql-escapes.js` `CLOSED_TABLES`: `glofox_crossover_members` and `contact_memberships` entries removed only if the guard requires existing tables (read its rule 4 first; otherwise leave them with a "dropped in 768" comment);
  - delete `tests/migration-731-contacts-read-by-membership.test.js`, `tests/migration-732-contacts-read-by-studio-client.test.js`, `tests/migration-758-glofox-crossover-members.test.js`, `tests/migration-762-contacts-read-by-studio-deal.test.js`: replaced by `tests/contact-studios-read-model.test.js` (one PGlite replay from the 699 fixture through 768 asserting the live model: the single helper, the policy, the view, every client denial; spec §2.3 "rewritten once against the single helper");
  - `tests/contacts-read-scope-migration-guard.test.js`: remove the 731/732/758/762 bodies and the old helper constants; the only accepted helper is `auth_contact_studio_contact_ids` with its 765 body; a migration after 768 that re-creates `auth_contact_membership_contact_ids` or `crossover_contact_ids` is a breaker.

**Interfaces:**
- Produces (mig 768): `DROP FUNCTION private.auth_contact_membership_contact_ids()`, `DROP FUNCTION public.crossover_contact_ids(uuid)`, `DROP TABLE public.glofox_crossover_members`, `DROP TABLE public.contact_memberships`, `DROP TRIGGER` + function for 767's fill trigger, `ALTER TABLE person_groups DROP COLUMN location_id` (after `DROP INDEX idx_person_groups_location`), `DROP INDEX` of 722's two indexes (go with the table). Pre-check: `contacts_select` is 765's text and names neither dropped function; nothing in `pg_depend` references the dropped objects (a policy or view still reading them aborts the file). Self-check from the catalog. Rollback record: 722's table DDL, 758's table DDL, 765's two deprecated functions, 767's column + trigger (verbatim, data not restorable: say so).

- [ ] **Step 1: Write the failing migration test** (boot through 767 with rows in both old tables; apply 768): `'the four objects and the column are gone'`, `'contacts_select and the studio helper are untouched'`, `'reconcile_contact_studios still runs after the drop'` (it must not reference the dropped tables: Task 6's function reads `contact_memberships` and `glofox_crossover_members` — **this file re-creates `derive_contact_studio` and `reconcile_contact_studios` without those two branches first** (`CREATE OR REPLACE`), and the test pins the new md5s), `'aborts while a policy or view still depends on a dropped function'`, `'idempotent'`.
- [ ] **Step 2: Run** → ENOENT. **Step 3: Write the migration.**
- [ ] **Step 4: Make the code changes**; write `tests/contact-studios-read-model.test.js`; rewrite the guard; run `npx vitest run tests/ src/lib/un1t-online-sync src/lib/glofox-crossover src/app/api/glofox` and the whole CI mirror + `npm run build` → PASS (`check:select-columns` and `check:rpc-names` fail on any surviving reference to a dropped object: that is the point).
- [ ] **Step 5: Apply order:** merge and deploy FIRST (the code no longer reads the tables), then `apply_migration` 768, then `get_advisors`. Keep PR 6 open on the branch until the migration is applied and the next nightly `contact-studios-reconcile` has stamped.
- [ ] **Step 6: Commit** `ORGCONTACTS.5 — mig 768: contact_memberships, glofox_crossover_members, the RPC and the old helper are gone`.

### Task 25: Invariants and docs rewritten

**Files:**
- Modify: `CLAUDE.md` (the **contacts** invariant bullet: "Since mig 690 (CONTACTREADSCOPE.1) that one policy admits a staff session only at studios where it holds Contacts … and since mig 765 (ORGCONTACTS.2) a contact at any studio where it holds a `contact_studios` row, any status (`private.auth_contact_studio_contact_ids()`); `contact_studios` is service-role only and written by three DEFINER triggers, the two syncs and `src/lib/contact-studios.js`; a new source writes a row and nothing else (decision 1); the nightly `contact-studios-reconcile` re-derives every row from `derive_contact_studio` (the lifecycle rules live there and in `src/lib/contact-studios.js`'s header: change both). The GLOFOXSIBLING.1/GLOFOXREADERS.1 bullet shrinks to: a Glofox member whose contact lives at a sibling studio is attached (`findGlofoxCrossoverContact`/`recordGlofoxCrossover`), never inserted, and reads at the Glofox studio go through `contactsAtStudio`. The WAORGNUMBER R4 line: "A reply files at the studio that quoted message or last outbound (7 days) belongs to, else the candidate studio where the person has an active `contact_studios` row (latest activity; tie → primary), else the home studio, else the number's home studio." The Hatch bullet's `contactAtGlofoxStudio` sentence removed.), `docs/architecture/REFERENCE.md` (table map: `contact_studios`, `studio_contacts`; remove the two dropped tables), `docs/LESSONS.md` (one entry: "five side channels, four definitions of 'at this studio'; the fix was one table, not a sixth reader"), `docs/whatsapp-setup.md` (home studio duties; sign-off date UI), `docs/BACKLOG.md` (do-not-build: a client grant on `contact_studios`; an org-level WhatsApp thread, decision 5)
- No tests: a docs commit. Run the CI mirror anyway (`tests/changelog-entries.test.js` reads the entries folder).

- [ ] **Step 1: Edit the five docs** as listed. Keep CLAUDE.md lean: one-liners in Invariants, the story in LESSONS.
- [ ] **Step 2: Run** the CI mirror → PASS.
- [ ] **Step 3: Commit** `ORGCONTACTS.5 — invariants: contacts read scope and WAORGNUMBER R4 rewritten for contact_studios`.

- [ ] **PR 6 close-out:** `gh pr create`; changelog entry; apply mig 768 after deploy; confirm with `get_advisors` and a `select count(*) from contact_studios` that nothing moved.

---

## Self-review notes (done while writing; left here for the executor)

- **Spec coverage:** §2.1 table + lifecycle → Tasks 6–7; writers table → 6 (triggers), 8, 9, 10; §2.2 readers → 11–15 (mobile route kept: deviation stated); §2.3 deletions → 12, 15, 24; §2.4 stage/lead source → 20–22; §2.5 person groups → 22; §2.6 edit rights → 23; §3.1 → 5; §3.2 → 5 (copy) and the existing home-studio picker on `OrgWhatsAppNumbers.jsx` (already a picker on create and edit: no new UI); §3.3 → 4; §3.4 → 16–18; §3.5 → 19; §4 phase gates → PR close-outs; §5 decisions → Global Constraints, Tasks 11 (2), 20–21 (3), 23 (4), 16 (5), 4 (6); §6 non-goals untouched.
- **Open question, not blocking Phase 0:** `last_seen_at`'s `class_bookings` column (`class_date` vs `updated_at`) is resolved by the Task 6 implementer against `information_schema`, as the plan says.
- **Migration numbers** are provisional; each task says to re-check.
