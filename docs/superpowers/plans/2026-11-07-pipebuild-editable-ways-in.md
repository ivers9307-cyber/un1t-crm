# PIPEBUILD ways in: operator-editable promos and lead sources

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A studio owner can add their own corporate promos and lead sources without a developer, so the Promo and Programme recipes work at any studio, and the builder's "Who enters" picker lists only that studio's values.

**Architecture:** Promos move from the frozen `CORP_PROMOS` registry to a `corp_promos` table, one row per studio and key, seeded with today's two entries; every reader that resolved a promo synchronously takes a preloaded row or an async read, and the Glofox plan binding moves onto the row. The "one live Glofox claim per contact" index stops naming a promo key and keys on a new `corp_promo_claims.platform` column stamped at claim time. Lead sources stay free text in the database (they already are); the zod enum relaxes to text, and a per-studio vocabulary (code defaults ∪ the owner's list in `locations.settings.lead_sources` ∪ values already on the studio's contacts) feeds the contact form, the audience builder and the builder's picker, with an editor card beside the Programmes rules.

**Tech Stack:** Next.js App Router, Supabase (service role; migrations via MCP `apply_migration` on `iyvtbjjxdggiadzwwvdj`, then `get_advisors`), Zod, React, Vitest.

**Spec:** Richard's decision of 7 Nov 2026 ("Both" promos and lead sources editable), after the PIPEBUILD audit (item 11). Research facts with file:line are in the controller's ledger.

## Global Constraints

- **`grantPromoCredits` keeps its ONE caller** (`src/lib/corp-promo-claim.js`) and its signature; credits and expiry arrive as arguments from the promo row (`tests/un1t-online-write-guard.test.js`, `tests/mia-no-charge-no-refund-guard.test.js` pin this). Never call it from anywhere new.
- **Every new table is closed to clients**: RLS on, no policy, `REVOKE ALL ON public.<t> FROM anon, authenticated`; a new `public` function is `REVOKE EXECUTE … FROM PUBLIC, anon, authenticated`. Run `get_advisors` (security) after each migration.
- **Migrations are forward-only and apply before the code deploys**; the seed must reproduce today's two promos exactly (`hatch-3-free`: un1t_online, Hatch, 3 credits, 7 days, live; `stillorgan-newstart`: glofox, Stillorgan, with its plan ids from `src/lib/corp-promo-glofox-plans.js`).
- **Service-role routes enforce access in code**: owner+ (`guardMasterOrOwner` at the target studio) writes; manager+ reads; another studio's promo is a 404; `assertLocationAccess`; `validateBody`; register in `src/lib/openapi.js`.
- **A failed read is never "no promos"**: every reader returns a failure the caller judges; the public claim route returns 503, never a refusal.
- **Settings writers are allowlisted** in `tests/location-settings-writers.test.js`; the lead-sources writer goes through `mergeLocationSettings`.
- **Public /corp pages keep rendering** for the two live promos with no change to their copy (copy lives in the landing block already).
- `check:select-columns`, `check:rpc-names`, `check:location-scoping`, `check:route-guards`, `check:guardrails` must pass; name columns; destructure `error`.

## Review Focus

1. **A promo key renamed or deleted while claims exist**: keys are immutable after creation and a promo with claims can only be switched off, never deleted.
2. **Two studios with the same key**: unique per `(location_id, key)`, and the public claim route resolves by the studio's row, never by key alone.
3. **A Glofox promo with no plan binding**: refused at create and at claim (`glofox_plan_missing`), never a claim that grants nothing.
4. **A lead source typed with capitals or spaces**: stored lowercased and trimmed everywhere it is written by an operator; existing data is read case-insensitively by the matcher.
5. **A failed `corp_promos` read on the public page**: 503 with the existing "try again" page, never a 404 that looks like a dead link.

---

### Task 1: The `corp_promos` table, the claims `platform` column, and the seed

**Files:**
- Create: `supabase/migrations/816_corp_promos.sql`
- Test: `tests/corp-promos-table-guard.test.js` (new: the migration closes the table to clients and seeds exactly two rows), update `tests/closed-function-regrant-guard.test.js` / `tests/table-default-acl-guard.test.js` only if they enumerate tables

**Interfaces:**
- Produces table `public.corp_promos`: `id uuid pk default gen_random_uuid()`, `location_id uuid not null references locations(id) on delete cascade`, `key text not null` (CHECK `key ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'`), `name text not null`, `platform text not null check (platform in ('un1t_online','glofox'))`, `credits integer not null check (credits between 1 and 50)`, `expires_in_days integer not null check (expires_in_days between 1 and 365)`, `live boolean not null default false`, `tag text not null`, `lead_source text not null default 'corp_promo'`, `glofox_membership_id text`, `glofox_plan_code text`, `glofox_plan_name text`, `created_by uuid references profiles(id)`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`; `UNIQUE (location_id, key)`; CHECK that `platform = 'glofox'` implies all three glofox columns non-null. RLS on, no policy, `REVOKE ALL FROM anon, authenticated`. `private.log_mutation('id','created_by')`-style audit attachment only if the repo's audit trigger convention requires it for new tables (check mig 733's pattern; if `audit_mutation` is attached per table, attach it).
- `corp_promo_claims` gains `platform text` (nullable), backfilled from the promo registry's platform by `promo_key` (`hatch-3-free` → `un1t_online`, `stillorgan-newstart` → `glofox`); index `corp_promo_claims_one_live_per_contact` is dropped and recreated as `UNIQUE (contact_id) WHERE status IN (<the same statuses as mig 811>) AND platform = 'glofox'` (read mig 811 for the exact status list; keep its semantics, drop the key literal).
- Seed: two `corp_promos` rows, `location_id` resolved by `locations.name` ('UN1T Hatch Street', 'UN1T Stillorgan'), values copied from `src/lib/corp-promos.js` and `src/lib/corp-promo-glofox-plans.js`; the DO block raises if either studio is missing.
- Self-check DO block: both rows present; `authenticated` has no privilege on `corp_promos`.

- [ ] **Step 1: Write the guard test** — replays the migration text: it contains `REVOKE ALL ON public.corp_promos FROM anon, authenticated`, `ENABLE ROW LEVEL SECURITY`, no `CREATE POLICY` on it, both seed keys, and no promo key literal in the recreated index (grep the `CREATE UNIQUE INDEX corp_promo_claims_one_live_per_contact` statement for `'stillorgan-newstart'` → must be absent).
- [ ] **Step 2: Run** `npx vitest run tests/corp-promos-table-guard.test.js` → FAIL (no migration).
- [ ] **Step 3: Write the migration.**
- [ ] **Step 4: Run** the guard, `npm run check:bundle-sql`, `npm run check:rls-restrictive` → PASS. (The controller applies the migration to prod via MCP and runs the advisors; do not apply it yourself.)
- [ ] **Step 5: Commit** `WAYSIN.1 — corp_promos table, claims.platform, seed`.

### Task 2: The promo reader and the sync readers

**Files:**
- Modify: `src/lib/corp-promos.js` (keep `CORP_PROMO_COPY_DEFAULT`, the Glofox copy variant, `corpPromoCopyFromBlocks`, `fillCorpPromoTokens`; `CORP_PROMOS`, `resolveCorpPromo`, `liveCorpPromos`, `corpPromosForStudio` become the SEED constants + async readers), `src/lib/corp-promo-glofox-plans.js` (plan ids read from the row; `glofoxCorpPromoKeys(db, locationId)` async), `src/lib/landing-page-offers.js:185-187` (`offerConfigured` takes a preloaded promo list), `src/lib/approvals/providers/corp-promo-claims.js:64` (platform from the claim row's new column, falling back to a batch promo read), `src/lib/corp-promo-stalled-sweep.js:23,81`, `src/lib/agent/trial-grant.js:152-158`, `src/lib/pipeline-entry-options.js:148-154` (`corpPromoOptions(db, locationId)` async, this studio's rows only), `src/lib/agent/board-context.js:23` (label only), `src/lib/pipeline-wizard.js:27,53` (label only)
- Test: `src/lib/corp-promos.test.js` (rewrite around the readers), the touched files' tests

**Interfaces:**
- Produces in `src/lib/corp-promos.js`:
  - `export const CORP_PROMO_SEEDS` (the two entries, same shape as today plus `glofox_*`, documented as "the seed of mig 816; the table is the truth").
  - `export async function readCorpPromo(db, { locationId, key }) -> { ok: true, promo: Row | null } | { ok: false, error }`.
  - `export async function listCorpPromos(db, { locationId, liveOnly = false }) -> { ok: true, promos: Row[] } | { ok: false, error }` (`.range()`-paged, ordered by `key`).
  - `Row` = the table row with camelCase accessors added by `promoView(row)`: `{ id, key, name, platform, credits, expiresInDays, live, tag, leadSource, glofox: { membershipId, planCode, planName } | null, locationId }` so existing fulfilment code (`promo.credits`, `promo.expiresInDays`, `promo.name`, `promo.key`, `promo.tag`, `promo.leadSource`) reads unchanged.
  - `glofoxPlanForPromo(promo)` takes the view, returns `promo.glofox` (null → the claim route refuses `glofox_plan_missing`).
  - `offerConfigured(mergedBlock, { promos })` (preloaded list of the studio's rows).
  - `corpPromoOptions` lists `{ value: key, label: name, hint: live ? '' : 'not live' }` for the studio.

- [ ] **Step 1: Failing tests** — `readCorpPromo` returns the row view (expiresInDays from `expires_in_days`), null for an unknown key at that studio, `ok: false` on a read error; `listCorpPromos({ liveOnly: true })` filters; `corpPromoOptions` lists only the given studio (a second studio's row is absent); `offerConfigured` true only when the block's key is in the preloaded list; `glofoxPlanForPromo` null without the columns.
- [ ] **Step 2: Run** `npx vitest run src/lib/corp-promos.test.js src/lib/pipeline-entry-options.test.js src/lib/landing-page-offers.test.js` → FAIL.
- [ ] **Step 3: Implement** and update every listed caller to the async reader (the stalled sweep and trial-grant read once per studio per run; the approvals provider reads `platform` off the claim row and falls back to one batch read for rows where it is null).
- [ ] **Step 4: Run** → PASS; `npm run check:select-columns`.
- [ ] **Step 5: Commit** `WAYSIN.2 — promos read from corp_promos; sync readers take a preloaded list`.

### Task 3: The claim route, fulfilment and the public page

**Files:**
- Modify: `src/app/api/public/corp-claims/route.js` (:137-157 resolve by studio row; :182 glofox plan from the view; :304 stamp `platform` on the claim insert), `src/lib/corp-promo-claim.js` and `corp-promo-claim-glofox.js` (take the view; no other change), `src/app/(public)/[slug]/[[...rest]]/page.js:359-380` (resolve by the studio's row: a failed read → the existing 503 page; unknown/not-live → the existing not-available branch), `src/lib/corp-promo-eligibility-glofox.js` (unchanged semantics; verify it keys on `promo_key` + location)
- Test: `src/app/api/public/corp-claims/route.test.js` (mock the reader instead of `resolveCorpPromo`), `src/lib/corp-promo-claim*.test.js`, the page test if one exists

**Interfaces:**
- Consumes Task 2's `readCorpPromo` / `promoView`.
- Produces: `corp_promo_claims.platform` written on every new claim; a Glofox promo without plan columns → `409 glofox_plan_missing` before any Glofox call; a failed promo read → `503`, logged, nothing written.

- [ ] **Step 1: Failing tests** — claim with a live DB-sourced promo grants with `amount: promo.credits` and `expiresInDays` from the row (assert the `grantPromoCredits` call args); a not-live promo refuses as today; a Glofox promo missing plan columns → 409 `glofox_plan_missing`; a failed read → 503 and no `corp_promo_claims` insert; the inserted claim carries `platform`.
- [ ] **Step 2: Run** the route and claim tests → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npx vitest run tests/un1t-online-write-guard.test.js tests/mia-no-charge-no-refund-guard.test.js` (both must stay green untouched).
- [ ] **Step 5: Commit** `WAYSIN.3 — claims and the public page resolve the studio's promo row`.

### Task 4: Promo settings — routes and page

**Files:**
- Create: `src/app/api/locations/[id]/corp-promos/route.js` (GET list for manager+, POST create for owner+), `src/app/api/locations/[id]/corp-promos/[promoId]/route.js` (PATCH name/credits/expires_in_days/live/tag/lead_source/glofox_*; DELETE only when no `corp_promo_claims` row references `(location_id, key)`), `src/app/settings/promos/page.js`, `src/components/settings/CorpPromosCard.jsx`
- Modify: `src/lib/schemas.js` (`corpPromoCreateSchema`, `corpPromoPatchSchema`: key per the CHECK regex, credits 1-50, expires 1-365, tag `^[a-z0-9_]{2,40}$`, lead_source text ≤ 80 lowercased, glofox fields required iff the studio's `membership_source` is glofox), `src/lib/settings-tree.js` (row `promos`, label "Promos", description "Corporate and partner promos: free classes with a claim link.", gate `{ roles: MANAGER_ROLES }`, workspace group), `src/lib/openapi.js`, `src/components/landing-pages/studio-offer-fields.jsx:179-193` (`CorpPromoFields` fetches `GET /api/locations/[id]/corp-promos?live=1` instead of the sync registry)
- Test: route tests, `src/components/settings/CorpPromosCard.test.jsx`, `src/lib/settings-tree.test.js`

**Interfaces:**
- Consumes Task 2's readers; the house skeleton from `src/app/api/locations/[id]/pipeline-programmes/route.js`.
- Produces: `{ success, data: { promos: Row[], can_edit } }` on GET; the card lists promos with Live chips (`bg-green-500/10 text-green-700` / gray), a form (name, key — shown as the claim link `/<studio path>/…` preview, credits, expiry days, tag, lead source, Glofox plan fields when the studio is on Glofox), Switch on/off, Delete (disabled with "has claims" when refused). Owner-only buttons hidden for managers.
- `key` is immutable after create (PATCH refuses `key`).

- [ ] **Step 1: Failing tests** — GET 404 for another studio, 200 for a manager; POST 403 for a manager, 400 on a bad key, 201 for an owner; PATCH cannot change `key`; DELETE 409 `has_claims` when a claim exists; the card renders rows and hides write buttons without `can_edit`; settings-tree gate test passes.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; register in openapi.
- [ ] **Step 4: Run** → PASS; `npm run check:route-guards && npm run check:location-scoping && npm run check:guardrails`.
- [ ] **Step 5: Commit** `WAYSIN.4 — promo settings: routes, page, card`.

### Task 5: Lead sources — the vocabulary, validation and editors

**Files:**
- Create: `src/lib/lead-source-vocabulary.js`, `src/app/api/locations/[id]/lead-sources/route.js` (GET vocabulary for anyone with Contacts at the studio; PUT the owner's list for owner+ via `mergeLocationSettings`)
- Modify: `src/lib/schemas.js:222-224` (`leadSourceSchema = z.string().trim().toLowerCase().min(1).max(80)`; keep the nine as `DEFAULT_LEAD_SOURCES`), `src/lib/pipeline-entry-options.js:156-158` (`leadSourceOptions(db, locationId)` async from the vocabulary), `src/components/ContactForm.jsx:23-33` and `src/components/AudienceBuilder.jsx:88-91` (options fetched from the route; `FIELD_OPTIONS` falls back to the defaults while loading), `src/lib/contact-import.js:166`, `src/components/settings/ProgrammeBoardRulesCard.jsx` (a sibling `LeadSourcesCard` beside it on Locations → [id] Details, or inside the same card: a newline list, saved via PUT), `src/lib/openapi.js`, `tests/location-settings-writers.test.js` (allowlist the new writer)
- Test: `src/lib/lead-source-vocabulary.test.js`, the route test, `src/lib/schemas.test.js` (relaxed enum), `src/components/ContactForm.test.jsx` / `AudienceBuilder.test.jsx` as they exist

**Interfaces:**
- Produces: `export const DEFAULT_LEAD_SOURCES` (the nine); `export async function leadSourceVocabulary(db, locationId) -> { ok: true, sources: [{ value, label, origin: 'default'|'studio'|'seen' }] } | { ok: false, error }` = defaults ∪ `locations.settings.lead_sources` ∪ distinct non-null `contacts.lead_source` and `last_lead_source` at the studio (paged, lowercased, deduped, sorted defaults first); `leadSourceLabel(value)` (the existing display labels for the nine, the value itself otherwise).
- `PUT /api/locations/[id]/lead-sources` body `{ sources: string[] }` (each trimmed, lowercased, `^[a-z0-9][a-z0-9_-]{0,79}$`, max 50) → `settings.lead_sources`; GET returns the vocabulary and `can_edit`.
- The offer-claims matcher (`src/lib/pipeline-offer-claims.js:277-289`) compares lowercased on both sides (it already lowercases entry values; confirm the contact side).

- [ ] **Step 1: Failing tests** — vocabulary unions the three origins without duplicates, lowercases, keeps defaults first, and returns `ok: false` on a contacts read error; the schema accepts `'Clubhouse Partner '` as `'clubhouse partner'` (or refuses spaces — choose the regex above and pin it); PUT 403 for a manager, 200 for an owner writing `settings.lead_sources`; GET lists `origin` per value; `leadSourceOptions` returns the vocabulary for the studio.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; wire ContactForm, AudienceBuilder, the import and the wizard picker to the route.
- [ ] **Step 4: Run** → PASS; `npm run check:guardrails && npm run check:mobile-parity` (no new permission key, so parity is untouched; say so in the report).
- [ ] **Step 5: Commit** `WAYSIN.5 — lead sources are a per-studio vocabulary`.

### Task 6: Builder pickers and copy

**Files:**
- Modify: `src/components/pipelines/wizard/EntryStep.jsx` (the `corp_promo` and `lead_source` empty states say where to add values, with links to `/settings/promos` and the studio's Lead sources card), `src/lib/pipeline-wizard.js` (`ENTRY_TYPE_HELP` for both), `shared/pipelines/recipes.js:204` only if the Programme description still says "lead source" at a un1t studio (leave if accurate)
- Test: `src/components/pipelines/BoardWizard.test.jsx` (empty-state copy), `src/lib/pipeline-entry-options.test.js` (promos scoped to studio — already from Task 2)

- [ ] **Step 1: Failing tests** — with no promos at the studio the entry step shows "No promos yet. Add one in Settings → Promos." with a link; with no studio lead sources beyond the defaults the help says where to add more.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `WAYSIN.6 — the builder says where ways in come from`.

## Verification (controller)

- Apply mig 816 to prod via MCP before merge; `get_advisors` security; confirm the two seed rows, `corp_promo_claims.platform` backfilled for every existing claim, and the rebuilt index.
- The 13-command CI mirror and `npm run build`.
- In the browser: `/hatch-street` (or the live /corp promo page) still renders the Hatch promo with its copy; Settings → Promos lists both promos; a manager sees no write buttons.
