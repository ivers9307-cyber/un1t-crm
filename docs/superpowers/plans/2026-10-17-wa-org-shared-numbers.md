# WAORGNUMBER — WhatsApp numbers shared across an organisation: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WhatsApp numbers belong to an organisation and be switched on per studio. A send for studio S goes from a number switched on at S and files at S, a reply lands at the studio that last spoke, and templates and consent stay per studio.

**Architecture:**
- A link table, `location_whatsapp_numbers`, records which studios have which organisation number switched on.
- Every resolver and every "does this studio have WhatsApp" reader goes through it.
- Templates carry their WABA, so a template send picks its number by WABA.
- A pure inbound router, `routeInboundThread`, decides a reply's studio.
- Six PRs, each behaviour-neutral until Richard switches the number on at Hatch (go-live), then a cleanup PR.

**Tech Stack:** Next.js 16 App Router, Supabase (supabase-js, Postgres migrations applied via MCP), vitest, PGlite migration tests, WhatsApp Cloud API (v21.0).

**Spec:** `docs/superpowers/specs/2026-10-17-wa-org-shared-numbers-design.md`. Read it first. Rule ids (R1–R8) below refer to it.

## Global Constraints

- **Never cross organisations.** A number is switched on only at a studio of its own organisation. A DB trigger enforces it, and app code checks it too.
- **Never re-open the env fallback.** `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` stay unread. `tests/whatsapp-config-callers.test.js` stays exact: every changed call count updates its row, and every row's `why` names WAORGNUMBER.
- A studio with no number switched on keeps today's refusal for each caller: 409, quiet `sent:false`, or a recorded skip.
- **Migrations:**
  - Forward-only, applied by me via Supabase MCP `apply_migration` on project `iyvtbjjxdggiadzwwvdj` BEFORE the code that reads them deploys. Run `get_advisors` (security) after DDL.
  - Next free numbers at plan time: 743–746. (18 Oct: another branch took 744, so the template migration is 745, the Hatch template move 746 and the blast sign-off 747.) Re-check `ls supabase/migrations | tail` before writing; another branch may have taken them.
  - Each migration has a PGlite behavioural test in the style of `tests/migration-723-724-wa-home-studio.test.js`, with fictional ids only (the repo is public).
- **New tables and functions:** a table states `REVOKE ALL ON public.<t> FROM anon, authenticated`. A function states `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`. `CREATE OR REPLACE` (never DROP+CREATE) for `move_whatsapp_conversation`.
- **Deprecated columns stay on disk** with `COMMENT … 'DEPRECATED (mig N)'`.
- **Customer-facing copy is operator-editable**: a settings field plus a default fallback. No em-dashes in customer copy.
- **Each PR:**
  - branches off fresh `origin/main` (PR 1 from `feat/wa-org-shared-numbers`, which holds the spec and this plan);
  - runs the 13-command CI mirror in CLAUDE.md, plus `npm run build` when it adds a route or an import;
  - adds `docs/changelog/entries/<PR>.md` (one row, `| #<PR> | WAORGNUMBER.<n> — … | 2026-10-DD. … |`) after `gh pr create`;
  - registers new routes in `src/lib/openapi.js`.
- **Copy, verbatim from the spec:**
  - Name clash: "That name is already used by {studio} on this WhatsApp account. Pick another name."
  - Sign-off: "Blasts at {studio} need sign-off from an organisation admin until {date}." (date as `16 Nov 2026`)
  - STOP ack default: "You won't get WhatsApp marketing from {studio} any more. Reply START to opt back in."
  - Block confirm: "This blocks them from messaging {display_phone} at every studio that uses it."
  - Radar refusal: "No WhatsApp number is switched on at {studio}."
- **Constants:** 7-day recent-outbound window (`RECENT_OUTBOUND_MS = 7 * 24 * 60 * 60 * 1000`). Sign-off window = go-live + 30 days.

## Review Focus

1. **A number switched OFF at a studio while threads there are still stamped with it.** Replies must refuse (409 or skip), not silently fall back to another studio's number. *Test in Task 2:* `getConversationNumberConfig` returns null for an active stamp with no link row at S, when S has its own different number switched on.
2. **A studio switches on a second number on a different WABA.** A template send must go from the number on the template's WABA, not the default. *Test in Task 9:* with S having default A (WABA 1) and B (WABA 2), a template with `business_account_id = WABA 2` resolves B.
3. **STOP arrives on a thread whose studio cannot be determined** (null `locationId`, e.g. a coexistence echo path). It must still suppress somewhere: fall back to today's contact-wide writes, never write nothing. *Test in Task 12:* a null `locationId` writes `contact_preferences` + `wa_status` exactly as today.
4. **Inbound from a member with threads at two studios where both had outbound in 7 days.** The most recent outbound wins, deterministically (tie → the newer thread id order, then the number's home). *Test in Task 18:* two candidate threads, outbound at T-1h and T-2h, picks T-1h.
5. **Template sync at a non-home studio when Meta returns a template no studio owns.** It must not be adopted there, or it would become invisible at the home studio. *Test in Task 8:* `planTemplateSync` with `isHomeStudio: false` puts it in `skipped`, not `inserts`.

---

## PR 1 — Organisation numbers, per-studio switch, resolver, admin UI (WAORGNUMBER.1)

Behaviour-neutral: the backfill reproduces today's Stillorgan setup, and the WAHOMESTUDIO sibling clause stays.

### Task 1: Migration 743 — organisation-owned numbers and the switch-on link table

**Files:**
- Create: `supabase/migrations/743_wa_org_numbers.sql`
- Test: `tests/migration-743-wa-org-numbers.test.js`

**Interfaces:**
- Produces:
  - `whatsapp_numbers.organization_id uuid NOT NULL REFERENCES organizations(id)`.
  - Table `public.location_whatsapp_numbers(location_id uuid REFERENCES locations ON DELETE CASCADE, whatsapp_number_id uuid REFERENCES whatsapp_numbers ON DELETE CASCADE, is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NULL, PRIMARY KEY (location_id, whatsapp_number_id))`, with a partial unique index `location_whatsapp_numbers_one_default ON (location_id) WHERE is_default`.
  - Trigger function `private.location_whatsapp_numbers_same_org()`, BEFORE INSERT OR UPDATE. It raises `'whatsapp number % belongs to another organisation'` when the number's org differs from the location's.
  - `move_whatsapp_conversation` re-created with `CREATE OR REPLACE`. Its unstamped-thread stamp reads `location_whatsapp_numbers` (the source studio's link default, then newest) joined to active `whatsapp_numbers`.

- [ ] **Step 1: Write the failing test.** Load 723 + 743 into PGlite over a schema with `organizations`, `locations`, `whatsapp_numbers` (the live columns incl. `is_default`, `location_id`) and `whatsapp_conversations`. Seed STILL + HATCH in ORG, OTHER in ORG2, and NUM at STILL (default). Tests:
  - `backfills one link row per number`: `select location_id, whatsapp_number_id, is_default from location_whatsapp_numbers` equals `[[STILL, NUM, true]]`.
  - `backfills organization_id`: `select organization_id from whatsapp_numbers` → ORG.
  - `refuses a link across organisations`: insert `(OTHER, NUM)` rejects, matching `/another organisation/`.
  - `one default per studio`: a second `is_default` row at STILL rejects.
  - `closed to clients`: `has_table_privilege('authenticated','public.location_whatsapp_numbers','SELECT')` is false.
  - `move stamps from the link default`: an unstamped thread at STILL moved to HATCH gets `whatsapp_number_id = NUM`.
  - `move keeps its grants`: `has_function_privilege('authenticated', 'public.move_whatsapp_conversation(uuid,uuid)', 'EXECUTE')` is false.
  - `deprecation comment`: `col_description` on `whatsapp_numbers.is_default` matches `/DEPRECATED \(mig 743\)/`.

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run tests/migration-743-wa-org-numbers.test.js` fails with ENOENT on the migration file.

- [ ] **Step 3: Write `743_wa_org_numbers.sql`.** In this order:
  1. Add the column nullable.
  2. `UPDATE … FROM locations` backfill.
  3. `SET NOT NULL` + FK + index on `organization_id`.
  4. Create the table, the trigger function (`SECURITY INVOKER`, `SET search_path = public`) and the trigger.
  5. Backfill the link rows with `INSERT … SELECT location_id, id, is_default FROM whatsapp_numbers`.
  6. `REVOKE ALL … FROM anon, authenticated`.
  7. `COMMENT ON COLUMN whatsapp_numbers.location_id IS 'Home studio: new-enquiry threads and coexistence history land here (WAORGNUMBER R1)'`.
  8. Deprecation comment on `is_default`.
  9. `CREATE OR REPLACE FUNCTION public.move_whatsapp_conversation`: copy mig 723's body verbatim, change only the stamp subquery at 723:85-89.

- [ ] **Step 4: Run, expect PASS.** Same command, all 8 pass. Also `npx vitest run tests/migration-723-724-wa-home-studio.test.js tests/function-execute-guard.test.js tests/table-default-acl-guard.test.js` passes.

- [ ] **Step 5: Commit** `git commit -m "WAORGNUMBER.1 — mig 743: organisation-owned WhatsApp numbers, switched on per studio"`

### Task 2: Resolver reads the link table

**Files:**
- Modify: `src/lib/whatsapp-config.js` (`rowToConfig`, `getLocationWhatsAppNumberConfig`, `getConversationNumberConfig`, `templateLocationIdFor`; add `getLocationNumberForWaba`, `studiosUsingNumbers`, `locationsWithWhatsApp`)
- Test: `src/lib/whatsapp-config.test.js`, `src/lib/whatsapp-reply-number.test.js`

**Interfaces:**
- Consumes: Task 1's schema.
- Produces:
  - `rowToConfig(row, forLocationId)` → today's shape, with `locationId: forLocationId`, `homeLocationId: row.location_id`, `organizationId: row.organization_id`, `viaSibling: false`.
  - `getLocationWhatsAppNumberConfig(locationId): Promise<config|null>` returns S's switched-on active numbers, ordered link `is_default` desc then link `created_at` desc, limit 1. Throws on a read error.
  - `getLocationNumberForWaba(locationId, wabaId): Promise<config|null>` is the same query filtered on `whatsapp_numbers.business_account_id = wabaId`. Throws on a read error. A null `wabaId` returns `getLocationWhatsAppNumberConfig(locationId)`.
  - `getConversationNumberConfig(locationId, conversationId): Promise<config|null>` never throws. It returns the stamped number when it is active and has a link row at S (`locationId: S`). The **transitional sibling clause**: the stamp is active, S has NO link rows, and the same organisation (`organization_id` equality) gives `{ …rowToConfig(num, S), viaSibling: true }`. Otherwise null.
  - `templateLocationIdFor(locationId, conversationId): Promise<string>` returns `thread.homeLocationId` when `thread?.viaSibling`, else `locationId`.
  - `studiosUsingNumbers(db, numberIds: string[]): Promise<string[]>` gives the distinct `location_id`s from link rows. Throws on error.
  - `locationsWithWhatsApp(db, locationIds: string[]): Promise<Set<string>>` gives the studios with at least one link row to an active number. Throws on error.

- [ ] **Step 1: Write failing tests** in `whatsapp-config.test.js`, using the existing supabase mock helpers in that file:
  - `resolves the link default before a newer non-default`.
  - `inactive number is not resolved even when switched on` returns null.
  - `config carries locationId = the studio asked for and homeLocationId = the number's home` (for HATCH switched on to STILL's number: `locationId === HATCH`, `homeLocationId === STILL`).
  - `getLocationNumberForWaba picks the number on that WABA` (Review Focus 2: default A/WABA1, B/WABA2, asked WABA2 → B).
  - `locationsWithWhatsApp returns only studios with an active switched-on number`.
  - `studiosUsingNumbers returns every studio linked to the number`.

  In `whatsapp-reply-number.test.js`:
  - `switched-off stamp is not used` (Review Focus 1).
  - `sibling clause applies only while the studio has no link rows` → `viaSibling: true`.
  - `other organisation never`.
  - `templateLocationIdFor returns the number home only via sibling`.

  Update existing expectations that read `config.locationId` as the number's studio.

- [ ] **Step 2: Run, expect FAIL.** `npx vitest run src/lib/whatsapp-config.test.js src/lib/whatsapp-reply-number.test.js`

- [ ] **Step 3: Implement.** Query shape:

  ```js
  db.from('location_whatsapp_numbers')
    .select('is_default, created_at, whatsapp_numbers!inner(*)')
    .eq('location_id', S)
    .eq('whatsapp_numbers.is_active', true)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
  ```

  `getConversationReplyConfig` keeps its signature. Its template branch becomes:
  - a thread with `viaSibling` → the thread config;
  - otherwise `pickReplyConfig(thread, await getWhatsAppConfig(S), { template: true })`, unchanged.

  Then audit every reader of a config's `.locationId`: `grep -rn "\.locationId" src/lib/whatsapp*.js src/lib/agent/followups.js src/app/api/whatsapp src/app/api/webhooks/whatsapp`. For each one, decide whether it means "for" or "home" and switch it to `homeLocationId` where it meant the number's studio. List each decision in the commit body.

- [ ] **Step 4: Run, expect PASS.** Same files, plus `npx vitest run src/lib src/app/api/whatsapp src/app/api/webhooks` stays green.

- [ ] **Step 5: Commit** `WAORGNUMBER.1 — resolver reads location_whatsapp_numbers; config says which studio it is for`

### Task 3: Every "does this studio have WhatsApp" reader uses the link table

**Files (modify each `from('whatsapp_numbers')…eq('location_id', …)` read that means "S can send"):**
- `src/lib/whatsapp-thread-location.js`: `numberlessHomeStudio` and `numberlessSiblingLocationIds` both use `locationsWithWhatsApp`.
- `src/lib/whatsapp.js`: `getOrCreateConversation`'s `sendingNumberId` uses `getLocationWhatsAppNumberConfig(locationId)?.id`.
- `src/lib/agent/followups.js`: `studioOwnsWhatsAppNumber` uses `locationsWithWhatsApp`, keeping "a failed read counts as owning one, logged".
- `src/lib/wa-studio-pick/config.js` and `src/app/api/whatsapp/studio-picker/route.js`: "siblings with their own number" uses `locationsWithWhatsApp`.
- `src/lib/event-waitlist.js`, `src/app/api/whatsapp/spend/route.js`, `src/app/communications/(hub)/page.js`, `src/lib/integration-health.js`, `src/lib/integrations-hub.js`, `src/lib/meta-capi.js`: for each, read the call. A "has WhatsApp" read moves to `locationsWithWhatsApp` or `getLocationWhatsAppNumberConfig`. A "the number row's own data" read (token, WABA, quality) stays on `whatsapp_numbers` by id. Note the choice per file in the commit body.
- Tests: the existing test file next to each module.

**Interfaces:** Consumes Task 2's `locationsWithWhatsApp`, `getLocationWhatsAppNumberConfig`.

- [ ] **Step 1: Write failing tests.** In `src/lib/whatsapp-thread-location.test.js`:
  - `home studio with the org number switched on is not numberless` → `numberlessHomeStudio` returns null.
  - `sibling with a switched-on number is not counted` → `numberlessSiblingLocationIds` excludes it.

  In `followups` tests: `a studio with a switched-on org number sends with { locationId }`. Each other file that has a test asserting on `whatsapp_numbers` mocks gets its mock moved to the link table.
- [ ] **Step 2: Run, expect FAIL.** `npx vitest run src/lib/whatsapp-thread-location.test.js src/lib/agent`
- [ ] **Step 3: Implement** the swaps above.
- [ ] **Step 4: Run, expect PASS.** `npm test`, `npm run check:select-columns`, `npm run check:location-scoping`.
- [ ] **Step 5: Commit** `WAORGNUMBER.1 — "has WhatsApp" means a number switched on at the studio`

### Task 4: Health, quality and account events fan out to every studio using the number

**Files:**
- Modify: `src/app/api/cron/refresh-whatsapp-health/route.js` (drip pause + admin push per studio), `src/lib/whatsapp-number-events.js` (`applyNumberEvent`: `pauseLocationDrips` and the returned studios), `src/app/api/webhooks/whatsapp/route.js` (`handleAccountUpdateEvent`: studios via the link table for rows on that WABA)
- Test: the existing tests beside each

**Interfaces:** Consumes `studiosUsingNumbers(db, numberIds)`.

- [ ] **Step 1: Write failing tests.**
  - `quality collapse pauses drips at every studio with the number switched on`: number linked to STILL + HATCH → `pauseLocationDrips` called for both.
  - `health push goes to admins at each studio using the number`.
  - `account_update resolves studios through link rows`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** If `studiosUsingNumbers` throws, fall back to `[n.location_id]` and `logError`. Never skip the pause.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `WAORGNUMBER.1 — quality and account events reach every studio using the number`

### Task 5: Organisation-level number admin (routes + page)

**Files:**
- Create:
  - `src/app/api/organizations/[id]/whatsapp/numbers/route.js` (GET list, masked; POST add)
  - `src/app/api/organizations/[id]/whatsapp/numbers/[numberId]/route.js` (PATCH, DELETE)
  - `src/app/api/organizations/[id]/whatsapp/embedded-signup/route.js` (GET config, POST connect)
  - `src/app/settings/whatsapp-numbers/page.js`
  - `src/components/settings/whatsapp/OrgWhatsAppNumbers.jsx`
- Modify:
  - `src/lib/whatsapp-embedded-signup.js` (`planPersistence({ existingRow, organizationId })`: conflict only when `existingRow.organization_id !== organizationId`)
  - `src/app/api/locations/[id]/whatsapp/numbers/route.js` POST and `[numberId]` PATCH/DELETE, plus `embedded-signup` POST: answer `410 { success:false, error:'WhatsApp numbers are managed at the organisation now.', moved_to:'/settings/whatsapp-numbers' }`
  - `src/components/settings/integrations/WhatsAppIntegrationTab.jsx`: move `AddNumberForm`, `EditNumberForm` and the Embedded Signup card into `OrgWhatsAppNumbers.jsx` as imports, not copies
  - `src/lib/openapi.js`, `scripts/check-route-guards*` (only if a new guard name needs registering)
- Test: `src/app/api/organizations/[id]/whatsapp/numbers/route.test.js`, `…/[numberId]/route.test.js`, `src/lib/whatsapp-embedded-signup.test.js`

**Interfaces:**
- Consumes: `assertOrganizationAdmin(user, orgId)` (`src/lib/auth.js:1096`; master passes).
- Produces:
  - **POST** body `{ label, phone_number_id, business_account_id, app_id?, access_token, display_phone?, source, home_location_id }`.
    - `home_location_id` must be a location of org `[id]`, else 400.
    - On insert, it also inserts the link row `(home_location_id, id, is_default = home has no default)` and writes `organization_id`.
  - **PATCH** may change `home_location_id` (same-org check). It does not touch links.
  - **DELETE** is a hard delete; the links cascade.

- [ ] **Step 1: Write failing route tests.**
  - `non-admin gets 403`.
  - `org admin adds a number with its home studio switched on as default`.
  - `home studio from another organisation is 400`.
  - `PATCH another organisation's number is 404`.
  - `old location POST answers 410 with moved_to`.

  `planPersistence` tests: `same organisation → update`, `another organisation → conflict`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the routes (mutation skeleton: `getCurrentUser` → `assertOrganizationAdmin` → `validateBody` → `createServerClient`), the page (gate: org admin or master, else `notFound()`) and the component.
- [ ] **Step 4: Run, expect PASS.** Plus `npm run check:route-guards && npm run check:location-scoping && npm run build`.
- [ ] **Step 5: Commit** `WAORGNUMBER.1 — numbers are added and edited at the organisation`

### Task 6: Studio switch-on (route + tab)

**Files:**
- Modify: `src/app/api/locations/[id]/whatsapp/numbers/route.js` (GET lists the org's numbers with `{ on, is_default }` for this studio; new **PUT**), `src/components/settings/integrations/WhatsAppIntegrationTab.jsx` (list + switch + default radio + link to `/settings/whatsapp-numbers`), `src/components/settings/IntegrationsHubDrawer.jsx` (same split)
- Test: `src/app/api/locations/[id]/whatsapp/numbers/route.test.js`

**Interfaces:**
- **PUT** body `{ numberId: uuid, on: boolean, isDefault?: boolean }`. The guard is `assertLocationAccess` + `hasRoleAtLocation(user, id, ADMIN_ROLES)` (403 otherwise).
  - The number must be in the location's organisation (404 otherwise).
  - `on:false` on the default promotes the newest remaining link to default.
  - `isDefault:true` clears the other default first.
  - Response: `{ success, data: { numbers: [{ id, label, display_phone, on, is_default }] } }`.

- [ ] **Step 1: Write failing tests.**
  - `head_coach gets 403`.
  - `manager switches the org number on at Hatch`.
  - `number from another organisation is 404`.
  - `switching off the default promotes the newest remaining`.
  - `switching off the last one leaves none` (no error).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS** + `npm run build`.
- [ ] **Step 5: Commit** `WAORGNUMBER.1 — studios switch organisation numbers on and off`

### Task 7: Callers table, invariant, ship PR 1

**Files:** `tests/whatsapp-config-callers.test.js`, `CLAUDE.md` (WACONFIGFALLBACK.1 line: "no WhatsApp number **switched on** (`location_whatsapp_numbers` + an active `whatsapp_numbers` row)"; add one sentence that numbers are organisation-owned since WAORGNUMBER.1; leave the WAHOMESTUDIO exception until PR 6), `docs/changelog/entries/<PR>.md`.

- [ ] **Step 1:** Run `npx vitest run tests/whatsapp-config-callers.test.js`. Update every row whose counts or `why` changed. New callers: the org routes (`own-number`) and anything Task 3 made call a resolver.
- [ ] **Step 2:** Run the full CI mirror + `npm run build`. Expect all green.
- [ ] **Step 3:** Apply mig 743 via MCP. `get_advisors` security shows no new findings. Verify: `select count(*) from location_whatsapp_numbers` = 1, and Stillorgan is the default.
- [ ] **Step 4:** Push and `gh pr create`. Add the changelog entry, commit, push. Bind the PR (`ccd_pr`).

---

## PR 2 — Templates per studio on a shared WABA (WAORGNUMBER.2)

### Task 8: Migration 745 and the pure sync planner

**Files:**
- Create: `supabase/migrations/745_wa_templates_waba.sql`, `tests/migration-745-wa-templates-waba.test.js`, `src/lib/whatsapp-template-sync.js`, `src/lib/whatsapp-template-sync.test.js`

**Interfaces:**
- Produces:
  - `whatsapp_templates.business_account_id text NULL`, backfilled from the row studio's link-default number's `business_account_id`.
  - Unique indexes `whatsapp_templates_waba_name_lang ON (business_account_id, name, language) WHERE business_account_id IS NOT NULL` and `whatsapp_templates_meta_id ON (meta_template_id) WHERE meta_template_id IS NOT NULL`.
  - The migration first raises if duplicates exist (`DO $$ … IF EXISTS (… HAVING count(*) > 1) THEN RAISE …`).
  - `planTemplateSync({ metaTemplates, rowsOnWaba, studioId, isHomeStudio, wabaId }) → { updates: [{ id, row }], inserts: [row], skipped: [{ name, language, ownerLocationId|null, reason: 'other_studio'|'unowned_not_home' }] }`. `rowsOnWaba` = every `whatsapp_templates` row with that `business_account_id`, any studio. Match key: `meta_template_id`, else `(name, language)`.

- [ ] **Step 1: Write failing tests.**
  - Migration: `backfills the WABA`, `refuses a duplicate name on one WABA across studios`, `raises when duplicates pre-exist`.
  - Planner:
    - `updates the studio's own rows`;
    - `skips a template another studio owns` (`other_studio`);
    - `adopts an unowned template only at the home studio`;
    - `does not adopt at a non-home studio` (Review Focus 5, `unowned_not_home`);
    - `matches by meta id before name`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the migration and `planTemplateSync` (pure: no db).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `WAORGNUMBER.2 — mig 745 + template sync planner: templates belong to a studio and a WABA`

### Task 9: Template routes and template sends pick the number by WABA

**Files:**
- Modify:
  - `src/app/api/whatsapp/templates/route.js`:
    - **Sync:** for each distinct WABA of S's switched-on numbers, fetch every page, `planTemplateSync`, write. `isHomeStudio` = S is that number's `location_id`.
    - **Create:** WABA of S's default. A clash is a 409 with the spec copy, naming the owner studio. Store `business_account_id`.
    - **`?conversation_id=`:** `templateLocationIdFor`, unchanged.
  - `src/app/api/whatsapp/templates/[id]/route.js`, `[id]/resubmit/route.js`, `upload-media/route.js`: the number via `getLocationNumberForWaba(tmpl.location_id, tmpl.business_account_id)`. Null is a 409 "The number this template lives on is switched off at this studio."
  - `src/lib/whatsapp.js`:
    - `getTemplates(limit, opts)` follows `paging.next` when `opts.all === true`.
    - `resolveConfig(opts)`: when `opts.businessAccountId` is given and there is no `replyInConversation`, resolve `getLocationNumberForWaba(opts.locationId, opts.businessAccountId)`, and throw `WhatsAppNumberMissingError(opts.locationId)` on null.
    - `sendTemplateMessage` passes `opts.businessAccountId` through.
  - `src/lib/whatsapp-config.js` `getConversationReplyConfig(…, { template, businessAccountId })`:
    - when `businessAccountId` is given and the thread number's WABA differs, use `getLocationNumberForWaba(S, businessAccountId)`;
    - else today's rule.
  - Every template sender that holds the template row passes `businessAccountId: tpl.business_account_id`: inbox send, broadcasts, drips, sequences `steps.js`, radar-outreach, cancellation confirm, contact composer, followups. Grep `sendTemplateMessage(` and update each.
- Test: `src/app/api/whatsapp/templates/route.own-number.test.js`, `src/lib/whatsapp-reply-number.test.js`, `src/lib/whatsapp-no-number-senders.test.js`

- [ ] **Step 1: Write failing tests.**
  - `create refuses a name used by another studio on the WABA with the owner's name`.
  - `create stores business_account_id`.
  - `sync at Hatch does not copy Stillorgan templates`.
  - `sync reads every page`.
  - `template send at a two-WABA studio goes from the template's WABA` (Review Focus 2).
  - `delete runs on the template's own WABA`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.** `npm test` + the callers table (counts of `getLocationNumberForWaba` added to the RESOLVING list for `src/lib/whatsapp-config`).
- [ ] **Step 5: Commit** `WAORGNUMBER.2 — template routes and sends use the template's WABA`

### Task 10: Per-studio purpose templates

**Files:**
- Create: `src/lib/whatsapp-purpose-templates.js`, `src/lib/whatsapp-purpose-templates.test.js`, `src/app/api/locations/[id]/whatsapp/purpose-templates/route.js` (+ test), `src/components/settings/whatsapp/PurposeTemplatesCard.jsx`
- Modify:
  - `src/lib/automations/booking-whatsapp-confirm.js` (`CLASS_CONFIRM_TEMPLATE`, `CONSULT_CONFIRM_TEMPLATE` lookups)
  - `src/app/api/public/book/route.js:259`
  - `src/lib/event-waitlist.js` (`WAITLIST_OFFER_TEMPLATE`) and `src/app/api/cron/event-waitlist-offers/route.js`
  - `src/lib/automations/meta-ad-whatsapp-welcome.js` (the `whatsappTemplate` from `src/lib/leads.js:83`)
  - `WhatsAppIntegrationTab.jsx` (mounts the card)

**Interfaces:**
- Produces:
  - `PURPOSES = { class_confirmed: { fallbackName: 'booking_class_confirmed_', categories: ['UTILITY'] }, consult_confirmed: { fallbackName: 'booking_consult_confirmed', categories: ['UTILITY'] }, event_waitlist_offer: { fallbackName: 'event_waitlist_offer', categories: ['UTILITY'] }, meta_ad_welcome: { fallbackName: 'meta_ad_whatsapp_lead', categories: ['MARKETING','UTILITY'] } }`.
  - `resolvePurposeTemplate(db, locationId, purpose): Promise<{ id, name, language, category, components, business_account_id, header_media_url } | null>`:
    1. reads `locations.settings.whatsapp_purpose_templates[purpose]`;
    2. a template id that is at the studio and APPROVED wins;
    3. an id outside the studio is ignored with `logWarn('wa-purpose-templates', 'template not at studio', …)`;
    4. else the fallback name at the studio, APPROVED, newest;
    5. else null.
  - **PUT** `/api/locations/[id]/whatsapp/purpose-templates` body `{ purpose, templateId|null }`, ADMIN_ROLES at the studio. The template must be at the studio, APPROVED, and in an allowed category (400 otherwise). It merges into `settings.whatsapp_purpose_templates`.

- [ ] **Step 1: Write failing tests.**
  - `setting wins over fallback name`.
  - `fallback name keeps Stillorgan unchanged with no setting`.
  - `template from another studio is ignored`.
  - `no template → null (sender skips as today)`.
  - Route: `head_coach 403`, `MARKETING template refused for class_confirmed`, `saves the setting`.
  - Each sender's existing test gets `uses the studio's purpose template`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement**, and switch the five senders to `resolvePurposeTemplate`.
- [ ] **Step 4: Run, expect PASS** + `npm run build`.
- [ ] **Step 5: Commit** `WAORGNUMBER.2 — each studio picks the templates its automatic messages use`

### Task 11: Ship PR 2 and move the three Hatch templates

**Files:** `supabase/migrations/746_move_hatch_templates.sql` (+ test), `tests/whatsapp-config-callers.test.js`, changelog entry.

- [ ] **Step 1:** Write the migration test `moves exactly the three ids to the Hatch location and nothing else`. Use the fictional ids in the test. The migration names the real ids from the spec §8, guarded by `WHERE id IN (…) AND name LIKE 'hatch\_%'`.
- [ ] **Step 2:** Callers table, CI mirror, `npm run build`.
- [ ] **Step 3:** Apply 745 via MCP before merge, verify `business_account_id` is non-null on all 21 rows, then merge. Do NOT apply 746 here (R10): it is applied at go-live, in the same step as switching the organisation number on at UN1T Hatch Street (Task 21 Step 2). It is idempotent and safe to apply any time. After it is applied, verify: Hatch has 3 template rows and Stillorgan has 18.
- [ ] **Step 4:** PR + changelog entry.

---

## PR 3 — Per-studio WhatsApp consent (WAORGNUMBER.3)

### Task 12: STOP and START write the thread studio's row

**Files:**
- Modify: `src/lib/whatsapp-consent.js` (`applyConsentWrites`, `applyWhatsappConsentKeyword`, ack copy), `src/app/api/webhooks/whatsapp/route.js` (passes the thread's `locationId`, already does)
- Test: `src/lib/whatsapp-consent.test.js`

**Interfaces:**
- `applyConsentWrites(db, { contactId, locationId, optingOut, source }) → { prefOk, statusOk, failures, scope: 'studio'|'contact' }`.
  - **With `locationId`:**
    - upsert `contact_location_preferences` `{ contact_id, location_id, whatsapp_marketing: !optingOut, updated_at, …(optingOut ? { unsubscribed_at: now } : { subscribed_at: now, source: 'whatsapp_keyword' }) }` with `onConflict: 'contact_id,location_id'`;
    - `consent_log` row with `location_id`;
    - `prefOk` = that upsert landed, `statusOk` = true;
    - no write to `contact_preferences` or `contacts.wa_status`.
  - **Without `locationId`** (Review Focus 3): today's three writes exactly, `scope: 'contact'`.
- Ack copy: `consentAckText(location, optingOut)` reads `location.settings.whatsapp_consent_copy.{stop_ack,start_ack}`, else the defaults:
  - STOP: "You won't get WhatsApp marketing from {studio} any more. Reply START to opt back in."
  - START: "You're back on WhatsApp messages from {studio}. Reply STOP to opt out."

  `{studio}` = `locations.name`.

- [ ] **Step 1: Write failing tests.**
  - `STOP at Hatch writes only Hatch's row and a located log row` (asserts no `contact_preferences` call, no `contacts` update).
  - `START at Hatch upserts the row to true`.
  - `STOP with no location keeps the contact-wide writes`.
  - `failed studio upsert → applied:false, no ack`.
  - `ack names the studio and honours the operator copy`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Add the two copy fields to the studio WhatsApp tab (a small `ConsentCopyCard.jsx`), saved through the existing location settings route if one covers `settings` keys. Otherwise add them to Task 10's purpose-templates route as `PUT …/whatsapp/consent-copy` with the same guard.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `WAORGNUMBER.3 — STOP and START act at the studio whose thread they arrive in`

### Task 13: Meta preference scoped to the organisation; Mia's template consent per studio

**Files:** `src/lib/whatsapp-consent.js` (`applyMetaUserPreference`: the contact lookup filtered to `location_id IN orgLocationIdsFor(db, receivingLocationId)`; it keeps contact-wide writes), `src/lib/agent/followups.js` (template consent at 518-525 and 1103-1117 reads `contact_location_preferences` for the follow-up's studio, row absent = no)
- Test: `src/lib/whatsapp-consent.test.js`, `src/lib/agent/followups*.test.js`

- [ ] **Step 1: Write failing tests.**
  - `Meta preference never touches a contact in another organisation`.
  - `follow-up template skipped when the studio row says no even though contact_preferences says yes`.
  - `follow-up template sent when the studio row says yes`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `WAORGNUMBER.3 — Mia's templates check the studio's WhatsApp consent`

### Task 14: Ship PR 3

- [ ] CLAUDE.md consent invariant: add "STOP/START on WhatsApp write the thread studio's `contact_location_preferences` row only (WAORGNUMBER.3); Meta's own preference stays contact-wide within the organisation." Update the callers-table `why` for `whatsapp-consent.js`. Run the CI mirror. PR + changelog entry.

---

## PR 4 — Shared limit, blast sign-off, staff sends (WAORGNUMBER.4)

### Task 15: The daily limit is per number

**Files:** `src/lib/whatsapp-budget.js`, `src/lib/whatsapp.js:1325,1650`, `src/lib/integrations-hub.js:1003`
- Test: `src/lib/whatsapp-budget.test.js`

**Interfaces:**
- `countBusinessInitiatedContactsLast24h(db, { numberId, locationId })` counts over `location_id IN studiosUsingNumbers(db, [numberId])`. When `numberId` is null, it uses `[locationId]`. It throws on a failed read (fail closed, as today).
- `getSendBudget(db, { numberId, locationId, tier })`.
- Callers pass `numberId: config.id`.

- [ ] **Step 1: Write failing tests.**
  - `counts template sends at every studio using the number`.
  - `a studio that does not use the number is not counted`.
  - `failed link read throws`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `WAORGNUMBER.4 — one daily limit per number, shared by its studios`

### Task 16: Migration 747 and blast sign-off

**Files:**
- Create: `supabase/migrations/747_wa_broadcast_signoff.sql` (+ test), `src/lib/whatsapp-blast-signoff.js` (+ test), `src/app/api/whatsapp/broadcasts/[id]/sign-off/route.js` (+ test)
- Modify: `src/app/api/whatsapp/broadcasts/[id]/send/route.js`, the schedule and start-drip routes under `src/app/api/whatsapp/broadcasts/` (grep `status: 'scheduled'` and the drip start), `src/lib/whatsapp.js` (`sendBroadcast`, `sendDripChunk`), the broadcast UI's send button (grep `broadcasts/${` in `src/components`)

**Interfaces:**
- Mig 747: `whatsapp_broadcasts.signed_off_by uuid NULL REFERENCES profiles(id)`, `signed_off_at timestamptz NULL`.
- `signoffWindow(location, now): { until: string } | null`. It reads `location.settings.whatsapp_blast_signoff_until`. Null when absent or past.
- `signoffMessage(locationName, until)` gives the exact spec copy, with the date formatted `d MMM yyyy` in the studio zone.
- In the routes: when `signoffWindow` is open, a non-org-admin gets 403 with that copy. An org admin's send, schedule or start also writes `signed_off_by` and `signed_off_at`.
- **POST** `…/sign-off`: org admin only. It stamps the two columns on a draft.
- `sendBroadcast` / `sendDripChunk`: window open and `signed_off_by` null →
  - a blast throws the existing refusal class before any status flip (route 409; the cron keeps the row draft and pushes managers);
  - a drip pauses with reason `needs_signoff`.

- [ ] **Step 1: Write failing tests.**
  - `manager gets 403 with the copy while the window is open`.
  - `org admin send stamps signed_off_by`.
  - `admin sign-off on a draft lets the cron send it`.
  - `cron leaves an unsigned scheduled blast draft and pushes managers`.
  - `unsigned drip pauses`.
  - `window past → no gate`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS** + `npm run build`.
- [ ] **Step 5: Commit** `WAORGNUMBER.4 — blasts at a new studio need an organisation admin's sign-off`

### Task 17: Staff sends file at the contact's home studio; copy for shared-number actions

**Files:**
- Modify:
  - `src/app/api/contacts/[id]/whatsapp/route.js` and `src/app/api/contacts/[id]/cancellation-form/route.js`: replace `getOrCreateContactConversation(db, contact)` with `getOrCreateConversation(db, contact, contact.location_id)`. The checked `{ config }` comes from `ownNumberOrRefusal(contact.location_id)`, as today.
  - `src/app/api/churn-radar/action/route.js`: the refusal copy is "No WhatsApp number is switched on at {studio}." (read `locations.name` for the radar's studio).
  - `src/app/api/whatsapp/conversational-automation/route.js`: a write needs an org admin or the number's home studio (403 otherwise).
  - Block confirm dialog in the inbox (grep `setWhatsAppUserBlockState` caller UI: `WAInbox.jsx`): the spec copy with the thread number's `display_phone`.
- Test: the route tests beside each

- [ ] **Step 1: Write failing tests.**
  - `composer files the thread at the contact's home studio even when a newer thread exists elsewhere`.
  - `radar refusal names the studio`.
  - `chat openers: manager at a non-home studio gets 403`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `WAORGNUMBER.4 — staff sends file at the contact's studio; shared-number actions say so`

### Task 17b: Ship PR 4

- [ ] Apply mig 747 before merge. Update the callers table. Run the CI mirror + build. PR + changelog entry.

---

## PR 5 — Inbound routing: who spoke last (WAORGNUMBER.5)

### Task 18: `routeInboundThread`

**Files:** Create `src/lib/whatsapp-inbound-route.js`, `src/lib/whatsapp-inbound-route.test.js`

**Interfaces:**
- `routeInboundThread(db, { numberId, numberHomeLocationId, organizationId, waPhone, bsuid, contact, contextMessageId, referral, now = Date.now() }) → Promise<{ locationId: string, conversation: { id, location_id, contact_id, ctwa_clid, studio_resolution } | null, by: 'quoted'|'ad'|'recent'|'home'|'numberless_home'|'number_home' }>`
- The steps, in order (spec R4):
  1. **Candidates** = `studiosUsingNumbers(db, [numberId])` ∪ `{numberHomeLocationId}`.
  2. **Quoted:** a `whatsapp_messages` row with `wa_message_id = contextMessageId` whose conversation is at a candidate gives `quoted`.
  3. **Ad:** `adSignal(db, referral, candidates)` (`src/lib/wa-studio-pick/signals.js`) gives `ad`.
  4. **Recent:** P's threads (`wa_phone`, or `wa_bsuid`) at candidates, with each one's latest outbound `sent_at` within `RECENT_OUTBOUND_MS`. The max wins. A tie goes to the higher `sent_at` then the thread id (Review Focus 4). Gives `recent`.
  5. **Home:** `contact.location_id` ∈ candidates gives `home`.
  6. **Transitional, deleted in PR 6:** `numberlessHomeStudio(db, contact, numberHomeLocationId)` non-null gives `numberless_home`.
  7. **Otherwise** `numberHomeLocationId` gives `number_home`.
- `conversation` = the existing thread at the winner for `waPhone` (or `bsuid`), else null.
- Any read error is logged and falls through to the next step. It never throws: the webhook must not 500.

- [ ] **Step 1: Write failing tests.** One per step, plus:
  - `outbound older than 7 days falls through to home`.
  - `home not switched on and not numberless → number home`.
  - `unknown sender → number home`.
  - `two recent threads → the later outbound` (Review Focus 4).
  - `bsuid-only sender`.
  - `read error falls through`.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `WAORGNUMBER.5 — routeInboundThread: a reply lands with whoever spoke last`

### Task 19: Webhook, coexistence ingest, studio picker and outbound stamping use it

**Files:**
- Modify:
  - `src/app/api/webhooks/whatsapp/route.js` (`handleIncomingMessage` 289-433):
    - replace the R2 `locationId`, `stampReceivingNumber`, `actingLocationId` and F1 `findMovedNumberlessThread` block with one `routeInboundThread` call;
    - stamp the receiving number when it is switched on at the winner, or `by === 'numberless_home'`;
    - every later use of `actingLocationId` becomes `locationId`.
  - `src/lib/whatsapp-coexistence-ingest.js` (84-110): the same helper decides the thread studio and the stamp.
  - `src/lib/wa-studio-pick/config.js` `readPickerConfig`: studios = those with the receiving number switched on and `wa_studio_picker.listed`.
  - `src/lib/whatsapp.js` `getOrCreateConversation`: an existing thread at the filing studio whose stamp is null **or not switched on there** gets the stamp of `getLocationWhatsAppNumberConfig(fileAt)` (logged on failure).
- Test: `src/app/api/webhooks/whatsapp/route.reply-number.test.js`, `route.test.js`, `src/lib/whatsapp-coexistence-ingest.test.js`, `src/lib/wa-studio-pick/config.test.js`, the `getOrCreateConversation` tests

- [ ] **Step 1: Write and rewrite failing tests.**
  - `Hatch member replying to a Stillorgan campaign within 7 days lands at Stillorgan`.
  - `same member with no recent outbound lands at Hatch (home)`.
  - `CTWA ad for Hatch files at Hatch for a known Stillorgan member and attributes the Lead to Hatch`.
  - `consent keyword acts at the routed studio`.
  - `getOrCreateConversation replaces a stamp that is switched off at the studio`.

  Rewrite the WAHOMESTUDIO F1/R2 cases so they expect `numberless_home` while Hatch has nothing switched on.
- [ ] **Step 2: Run, expect FAIL.** **Step 3: Implement.** **Step 4: Run, expect PASS.** `npm test` + `npm run check:guardrails`.
- [ ] **Step 5: Commit** `WAORGNUMBER.5 — the webhook and ingest route replies by who spoke last`

### Task 20: Ship PR 5

- [ ] Callers table (webhook row), CI mirror, build, PR + changelog entry.

---

## Go-live (Richard; no PR)

### Task 21: Dry-run list, switch-on, smoke

- [ ] **Step 1:** Run read-only SQL via MCP and send Richard the list of what starts sending at Hatch:
  - Hatch `email_sequences` that are active with WhatsApp steps;
  - Hatch `whatsapp_broadcasts` that are not sent;
  - Hatch purpose-template settings;
  - Hatch `customer_agent.enabled` (must be false);
  - the meta-ad welcome flag for Hatch lead sources.
- [ ] **Step 2:** Richard switches +353 1 578 9401 on at Hatch (studio WhatsApp tab). In the same step, apply mig 746 via MCP (moves the three `hatch_*` templates to Hatch; R10), then verify Hatch has 3 template rows and Stillorgan has 18. With his OK, set `locations.settings.whatsapp_blast_signoff_until` for Hatch to go-live + 30 days.
- [ ] **Step 3:** Smoke (spec §8 step 6) with Richard's test contact homed at Hatch:
  1. inbound lands at Hatch;
  2. a staff reply and a radar win-back (free text) file in the same thread;
  3. STOP leaves the Stillorgan row and `wa_status` untouched;
  4. START restores it.

  Record the results in the PR 6 description.

---

## PR 6 — Cleanup (WAORGNUMBER.6)

### Task 22: Delete the transitional numberless paths

**Files:**
- Modify:
  - `src/lib/whatsapp-config.js`: drop the sibling clause and `viaSibling`; `templateLocationIdFor` returns `locationId` (keep the export; the callers table counts it).
  - `src/lib/whatsapp-thread-location.js`: delete `numberlessHomeStudio` and `numberlessSiblingLocationIds`, and the file if it ends up empty.
  - `src/lib/whatsapp-inbound-route.js`: drop the `numberless_home` step.
  - `src/lib/whatsapp.js` `getOrCreateConversation`: drop the R1 home-studio branch.
  - `src/lib/agent/followups.js`: drop `threadCanReply`, `templateStudioFor` and the numberless branch of `sendOptsFor`.
  - `src/app/api/webhooks/whatsapp/route.js`: drop `findMovedNumberlessThread`.
  - `CLAUDE.md`: replace the WAHOMESTUDIO.1 exception paragraph with the WAORGNUMBER.1 paragraph from spec §6, verbatim.
- Test: delete the tests of the removed paths. `whatsapp-reply-number.test.js`: `a studio with nothing switched on never replies through a sibling's stamp`.

- [ ] **Step 1:** Precondition, checked via MCP: `select count(*) from locations l where not exists (select 1 from location_whatsapp_numbers x where x.location_id=l.id) and exists (select 1 from whatsapp_conversations c where c.location_id=l.id and c.whatsapp_number_id is not null)` = 0. If it is not 0, stop and tell Richard which studio still relies on a sibling.
- [ ] **Step 2: Write the failing test** above. **Step 3:** Delete the paths. **Step 4:** `npm test` + the CI mirror + build.
- [ ] **Step 5:** Callers table rows rewritten. PR + changelog entry.
