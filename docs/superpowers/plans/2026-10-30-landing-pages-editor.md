# Landing pages: every public page its own record (PAGES.1) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every public marketing page (the two studio pages and every campaign page) becomes a row in `landing_pages`, with its per-studio offer in `landing_page_studios`, rendered by one route, gated from the database, and edited from one Pages list.

**Architecture:** Two new service-role-only tables replace the one-row-per-studio `landing_page_settings`; a backfill carries the five live URLs across by value. One App Router route (`[slug]/[[...rest]]`) renders every row, choosing its layout by `offer_type`; the public API routes resolve `(page, studio)` instead of `(public_path, campaign)` through one helper, and the existing per-type config functions keep working because the studio half is merged back onto the offer block before they run. The four public-path gates read page slugs from an edge-cached module with the in-code list as fallback. The editor becomes a Pages list plus the existing form generalised to a page row.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres, service role), Zod, Vitest, the existing `BlockRenderer` / `EditModeOverlay` / `LandingPageSettingsForm` components.

**Spec:** `docs/superpowers/specs/2026-10-30-landing-pages-editor-design.md`

Three PRs, each green with the live site unchanged for visitors:

- **PR1 (Tasks 1–12):** tables + backfill, the pure modules, the `[slug]` route rendering the three campaign pages from rows, public API routes on `(page, studio)`, gates reading the DB, old campaign routes deleted. Studio pages still render from `landing_page_settings` via `/welcome/[location]`.
- **PR2 (Tasks 13–20):** the Pages list, create/edit/publish API, the editor generalised (header card, pinned offer block with studio rows, preview studio switch, offer-layout overlay), media by page.
- **PR3 (Tasks 21–27):** studio pages and their sub-pages on the `[slug]` route, chooser and logo from `landing_pages`, every studio-only reader moved, `/welcome/[location]` redirecting, `landing_page_settings` deprecated, in-code path entries removed.

## Global Constraints

- New tables: RLS on, `REVOKE ALL … FROM anon, authenticated`, no policy; every read and write is a service-role route (CLAUDE.md, mig 677).
- `audit_mutation` trigger on both new tables: `private.log_mutation('id', 'updated_by')` on `landing_pages`, `private.log_mutation('page_id', 'updated_by')` on `landing_page_studios` (mig 733 pattern).
- Migrations forward-only in `supabase/migrations/`, applied through the Supabase MCP (project `iyvtbjjxdggiadzwwvdj`) **before** the code deploys; `get_advisors` (security) after.
- Slug: `[a-z0-9-]`, 2..40 chars, no leading/trailing `-`, unique per organisation, never in `RESERVED_PAGE_SLUGS`.
- Public routes keep `checkRateLimit`, never return a capacity figure (PUBCAP.1), hand the browser only client fields; attribution and platform ids come from the row, never the request body.
- The browser never sees `landing_page_studios.offer` raw: only the merged block filtered by the type's client fields (`campaignFunnelClientCopy`, `clientTrialBlock`, `paidTrialCopyFromBlock`, `corpPromoCopyFromBlocks`).
- `check:select-columns` and `check:rpc-names` read `supabase/migrations`, so the migration lands in the same PR as the first code that names the new tables.
- Every `<button>` in a form typed; status chips `bg-<c>-500/10 text-<c>-700`; `un1t-*` tokens; no new `console.log`; customer-facing strings are block fields with defaults.
- No em-dashes in customer copy.
- Commit style: `PAGES.1 — <summary>`; end every commit with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Run the CI mirror before each push (CLAUDE.md "Build, test & ship"); never run the full suite beside `next build`.
- The repo's `src/lib/landing-page-blocks.js` block type names (`paid_trial`, `class_funnel`, `campaign_funnel`, `corp_promo`) are **kept** as block types; `offer_type` is the page-level enum that maps onto them (`OFFER_BLOCK_TYPE` in Task 2). This is the plan's call so the renderer and config functions do not churn.

## Review Focus

1. `?studio=hatch-street` on an all-studios page where Hatch's row is `enabled=false` → the picker, never Hatch's offer (Task 3 test `resolvePageStudio ignores a disabled studio`).
2. Creating or renaming a page to `settings`, `api`, `contacts` (a route-group segment) or an existing slug → refused with `reserved` / `taken`, nothing written (Task 1 and Task 14 tests).
3. `/start/hatch-street?utm_campaign=x` after `start` is retired → 307 to `/trial?studio=stillorgan&utm_campaign=x` (Task 6 test `a retired slug redirects anything under it and keeps the query`).
4. A `class-booking` POST for a one-studio page with `studio=hatch-street` → 404 `not_found`, no Glofox call (Task 7 test).
5. Edge read of `landing_pages` fails → `listPublicPageSlugs` answers the fallback list, so `/trial` stays public (Task 5 test `fallback when the read throws`).

---

## PR1 — foundation and the campaign pages

### Task 1: Slug rules and the reserved list

**Files:**
- Create: `src/lib/page-slug.js`
- Test: `src/lib/page-slug.test.js`

**Interfaces:**
- Produces: `normaliseSlug(raw: unknown) → string | null` (lowercase, trimmed, `null` when it fails `SLUG_RE`); `SLUG_RE`; `RESERVED_PAGE_SLUGS: Set<string>`; `slugProblem(slug: string) → null | 'invalid' | 'reserved'`; `appRouteSegments(appDir: string) → string[]` (every top-level route segment under `src/app`, descending into `(group)` directories, skipping `api`? no: `api` is included; skipping `[dynamic]` and `[[...rest]]` segments and files).

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { normaliseSlug, slugProblem, RESERVED_PAGE_SLUGS, appRouteSegments } from './page-slug.js'

describe('page-slug', () => {
  it('normalises case and whitespace and refuses bad shapes', () => {
    expect(normaliseSlug(' 50Plus ')).toBe('50plus')
    expect(normaliseSlug('a')).toBeNull()                 // 1 char
    expect(normaliseSlug('-trial')).toBeNull()
    expect(normaliseSlug('trial-')).toBeNull()
    expect(normaliseSlug('x'.repeat(41))).toBeNull()
    expect(normaliseSlug('with space')).toBeNull()
    expect(normaliseSlug(null)).toBeNull()
  })
  it('reserves every top-level app route segment, route groups walked', () => {
    const segs = appRouteSegments(path.resolve(__dirname, '../app'))
    for (const s of segs) expect(RESERVED_PAGE_SLUGS.has(s), s).toBe(true)
    expect(segs).toContain('settings')
    expect(segs).toContain('contacts') // lives under a (group) directory
    expect(segs).not.toContain('[slug]')
  })
  it('reserves the fixed names and judges a slug', () => {
    for (const s of ['api', '_next', 'welcome', 'login', 'settings', 'admin', 'offers', 'embed', 'tv', 'present', 'host', 'h', 'book', 'event', 'race', 'deposit', 'legal', 'privacy', 'terms']) expect(RESERVED_PAGE_SLUGS.has(s), s).toBe(true)
    expect(slugProblem('settings')).toBe('reserved')
    expect(slugProblem('Bad Slug')).toBe('invalid')
    expect(slugProblem('january')).toBeNull()
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/page-slug.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/page-slug.js`**

`RESERVED_PAGE_SLUGS` = the fixed list above ∪ `appRouteSegments(path.join(process.cwd(), 'src/app'))` computed at module load when `fs` is available (server), and the fixed list alone in the browser (`typeof window !== 'undefined'`); the API route is the authority, the editor only pre-checks. `appRouteSegments` uses `fs.readdirSync` with `withFileTypes`, recursing only into names matching `/^\(.+\)$/`, and returns directory names not starting with `[`, `_` or `.`.

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/lib/page-slug.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/page-slug.js src/lib/page-slug.test.js
git commit -m "PAGES.1 — page slugs: shape, reserved app segments"
```

---

### Task 2: The offers module: splitting and merging offer blocks

**Files:**
- Create: `src/lib/landing-page-offers.js`
- Test: `src/lib/landing-page-offers.test.js`

**Interfaces:**
- Consumes: `paidTrialConfigFromBlocks` (`@/lib/paid-trial`), `campaignFunnelConfig` (`@/lib/campaign-funnel`), `classFunnelConfigFromBlocks` (`@/lib/public-landing`), `manualTimetableConfigFromBlocks` (`@/lib/manual-timetable`), `resolveCorpPromo` (`@/lib/corp-promos`).
- Produces:
  - `OFFER_TYPES = Object.freeze(['paid_trial', 'class_funnel', 'one_class', 'promo_credits', 'none'])`
  - `OFFER_BLOCK_TYPE = Object.freeze({ paid_trial: 'paid_trial', class_funnel: 'class_funnel', one_class: 'campaign_funnel', promo_credits: 'corp_promo' })` and `offerTypeOfBlock(blockType) → string | null` (the inverse).
  - `ATTRIBUTION_KEYS = Object.freeze(['tag', 'lead_source', 'event_source_url'])`
  - `STUDIO_OFFER_KEYS = Object.freeze({ paid_trial: ['membership_id', 'plan_code', 'un1t_product_id', 'price_cents', 'currency', 'duration_days', 'product_name', 'studio_label'], class_funnel: ['trial_membership_id', 'trial_plan_code', 'price_cents', 'currency', 'consult_slug', 'timetable', 'timetable_start_date', 'min_notice_hours'], campaign_funnel: ['trial_membership_id', 'trial_plan_code', 'class_keywords'], corp_promo: ['promo_key'] })` (keyed by **block** type)
  - `DROPPED_BLOCK_KEYS = Object.freeze({ campaign_funnel: ['campaign', 'show_sections'] })`
  - `splitOfferBlock(block) → { page: object, studio: { offer: object, attribution: object } }` — `page` keeps `id`, `type` and every key not in the three lists; `offer` gets the `STUDIO_OFFER_KEYS[block.type]` present on the block; `attribution` gets the `ATTRIBUTION_KEYS` present (empty strings dropped).
  - `mergeOfferBlock(pageBlock, studioRow) → object` — `{ ...pageBlock, ...studioRow.offer, ...studioRow.attribution }`; `null` when `pageBlock` is null.
  - `studioOfferSchema(blockType) → ZodObject` (strict; strings max 200; `price_cents` int 0..50_000; `duration_days` int 1..365; `timetable` max 4000; `promo_key` max 64) and `attributionSchema` (`tag` max 80, `lead_source` max 80, `event_source_url` url max 500, all optional).
  - `defaultAttribution({ publicPath, slug }) → { tag: \`${publicPath}-${slug}\`, lead_source: \`meta_${slug}\` }`
  - `offerConfigured(blockType, mergedBlock, { landingPath, product = null }) → boolean`: `paid_trial` → `paidTrialConfigFromBlocks([mergedBlock], landingPath, { product }) !== null`; `campaign_funnel` → `campaignFunnelConfig(mergedBlock, { landingPath }).configured && allowKeywords.length > 0`; `class_funnel` → `classFunnelConfigFromBlocks([mergedBlock], landingPath).trialMembershipId !== null || manualTimetableConfigFromBlocks([mergedBlock]) !== null`; `corp_promo` → `resolveCorpPromo(mergedBlock.promo_key) !== null`; anything else `false`.

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { splitOfferBlock, mergeOfferBlock, offerConfigured, STUDIO_OFFER_KEYS, defaultAttribution, offerTypeOfBlock, studioOfferSchema } from './landing-page-offers.js'

const CAMPAIGN = { id: 'b1', type: 'campaign_funnel', campaign: '50plus', class_keywords: '50+', trial_membership_id: 'm', trial_plan_code: 'p', tag: 'stillorgan-50plus', lead_source: 'meta_50plus', event_source_url: '', heading: 'A free trial', show_sections: ['stats'], video_url: 'https://x/v.mp4' }

describe('landing-page-offers', () => {
  it('splits a campaign_funnel block into its page half and studio half, dropping the campaign key and sections', () => {
    const { page, studio } = splitOfferBlock(CAMPAIGN)
    expect(page).toEqual({ id: 'b1', type: 'campaign_funnel', heading: 'A free trial', video_url: 'https://x/v.mp4' })
    expect(studio.offer).toEqual({ class_keywords: '50+', trial_membership_id: 'm', trial_plan_code: 'p' })
    expect(studio.attribution).toEqual({ tag: 'stillorgan-50plus', lead_source: 'meta_50plus' })
  })
  it('merges back to a block the existing config functions read', () => {
    const { page, studio } = splitOfferBlock(CAMPAIGN)
    const merged = mergeOfferBlock(page, studio)
    expect(merged.trial_plan_code).toBe('p')
    expect(merged.tag).toBe('stillorgan-50plus')
    expect(mergeOfferBlock(null, studio)).toBeNull()
  })
  it('judges readiness per block type', () => {
    const { page, studio } = splitOfferBlock(CAMPAIGN)
    expect(offerConfigured('campaign_funnel', mergeOfferBlock(page, studio), { landingPath: 'stillorgan' })).toBe(true)
    expect(offerConfigured('campaign_funnel', mergeOfferBlock(page, { offer: { ...studio.offer, class_keywords: '' }, attribution: {} }), { landingPath: 'stillorgan' })).toBe(false)
    expect(offerConfigured('paid_trial', { type: 'paid_trial', membership_id: 'm', plan_code: 'p', price_cents: 3900 }, { landingPath: 'stillorgan' })).toBe(true)
    expect(offerConfigured('paid_trial', { type: 'paid_trial', membership_id: '', plan_code: '', price_cents: 3900 }, { landingPath: 'stillorgan' })).toBe(false)
    expect(offerConfigured('corp_promo', { type: 'corp_promo', promo_key: 'no-such-promo' }, {})).toBe(false)
    expect(offerConfigured('class_funnel', { type: 'class_funnel', timetable: 'Mon 07:00 S&C' }, { landingPath: 'hatch-street' })).toBe(true)
  })
  it('names every studio key the migration strips (pinned by the migration test)', () => {
    expect(STUDIO_OFFER_KEYS.corp_promo).toEqual(['promo_key'])
    expect(offerTypeOfBlock('campaign_funnel')).toBe('one_class')
    expect(offerTypeOfBlock('hero')).toBeNull()
    expect(defaultAttribution({ publicPath: 'stillorgan', slug: 'january' })).toEqual({ tag: 'stillorgan-january', lead_source: 'meta_january' })
  })
  it('refuses an unknown key and a price out of range on the studio half', () => {
    expect(studioOfferSchema('paid_trial').safeParse({ membership_id: 'm', plan_code: 'p', price_cents: 3900, extra: 1 }).success).toBe(false)
    expect(studioOfferSchema('paid_trial').safeParse({ price_cents: 60_000 }).success).toBe(false)
    expect(studioOfferSchema('corp_promo').safeParse({ promo_key: 'hatch-3-free' }).success).toBe(true)
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/landing-page-offers.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/landing-page-offers.js`** with the interfaces above. Pure, no IO; importable from the client bundle (the editor uses `splitOfferBlock` and `STUDIO_OFFER_KEYS`).

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/lib/landing-page-offers.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/landing-page-offers.js src/lib/landing-page-offers.test.js
git commit -m "PAGES.1 — offers module: split and merge the studio half of an offer block"
```

---

### Task 3: Migration 792: the two tables, the backfill, the request columns

**Files:**
- Create: `supabase/migrations/792_landing_pages.sql`
- Test: `tests/migration-792-landing-pages.test.js`

**Interfaces:**
- Produces the schema in spec §1, with these exact names: `public.landing_pages (id uuid pk default gen_random_uuid(), organization_id uuid not null references organizations(id) on delete cascade, slug text not null, title text not null, kind text not null check (kind in ('studio','campaign')), scope text not null check (scope in ('one','all')), primary_location_id uuid references locations(id) on delete restrict, offer_type text not null default 'none' check (offer_type in ('paid_trial','class_funnel','one_class','promo_credits','none')), blocks jsonb not null default '[]', chrome jsonb not null default '{}', publish_state text not null default 'draft' check (publish_state in ('draft','live','coming_soon','retired')), redirect_to text, created_by uuid references profiles(id) on delete set null, updated_by uuid references profiles(id) on delete set null, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`; `unique (organization_id, slug)`; partial unique `landing_pages_one_studio_page on (primary_location_id) where kind = 'studio'`; check `(scope = 'one') = (primary_location_id is not null)`; check `(publish_state = 'retired') or (redirect_to is null)`.
- `public.landing_page_studios (page_id uuid not null references landing_pages(id) on delete cascade, location_id uuid not null references locations(id) on delete cascade, enabled boolean not null default false, offer jsonb not null default '{}', attribution jsonb not null default '{}', sort_order int not null default 0, updated_by uuid references profiles(id) on delete set null, updated_at timestamptz not null default now(), primary key (page_id, location_id))`; trigger `landing_page_studios_same_org` (BEFORE INSERT OR UPDATE) raising when `locations.organization_id` ≠ the page's `organization_id` (copy the shape of mig 743's cross-organisation refusal on `location_whatsapp_numbers`).
- `page_id uuid references landing_pages(id) on delete set null` added to `class_booking_requests`, `trial_purchases`, `corp_promo_claims`, `funnel_events` (the builder confirms each table exists in `supabase/migrations` with `grep -l "create table if not exists public.<t>"`; one that does not is left out and noted in the migration header).
- Both tables: `enable row level security`, `revoke all on … from anon, authenticated`, the two `audit_mutation` triggers (Global Constraints), `update_updated_at` triggers.
- `comment on table public.landing_page_settings is 'DEPRECATED (mig 792): replaced by landing_pages + landing_page_studios. Read by the studio pages until PR3; dropped by a later migration.'`

**Backfill** (idempotent: every insert `on conflict (organization_id, slug) do nothing`; studio rows `on conflict do nothing`):

1. For each `landing_page_settings` row with a non-null `public_path` and a `locations` row: a `landing_pages` row `kind='studio', scope='one', slug=public_path, title=locations.name, primary_location_id=location_id, organization_id=locations.organization_id, blocks = <blocks with every offer block replaced by its page half>, offer_type = <offer type of the first paid_trial block, else first class_funnel, else 'none'>, chrome = jsonb_build_object('logo_url', logo_url, 'logo_alt', logo_alt, 'logo_width_px', logo_width_px, 'show_instagram_feed', coalesce(show_instagram_feed, true), 'chooser_label', chooser_label, 'chooser_cta_text', chooser_cta_text, 'chooser_image_url', chooser_image_url, 'noindex', false, 'tone', 'dark'), publish_state = case publish_state when 'live' then 'live' when 'coming_soon' then 'coming_soon' else 'draft' end`, `created_at`/`updated_at` copied. One `landing_page_studios` row `(page_id, location_id, enabled=true, offer = <studio half of that offer block>, attribution = <its attribution>)`.
   The "page half" is `block - STUDIO_OFFER_KEYS[type] - ATTRIBUTION_KEYS - DROPPED_BLOCK_KEYS[type]`, written in SQL as a `jsonb - 'k1' - 'k2' …` chain per type inside a `CASE b->>'type'`. **Only the first offer block of the page's `offer_type` is kept in `blocks`; the other offer blocks (`class_funnel` hidden switch, every `campaign_funnel`, `corp_promo`) are removed from the studio page's blocks** (their content moves to the campaign pages below). `lead_form`, `booking`, `event` stay.
2. `/trial`: one row `kind='campaign', scope='all', slug='trial', title='14 Day Reset', offer_type='paid_trial', primary_location_id=null, organization_id = UN1T Group's id (the organisation of the `stillorgan` row), publish_state='live', chrome = the stillorgan row's chrome with `noindex=true`, blocks = [page half of Stillorgan's `paid_trial` block] ‖ Stillorgan's content blocks (`hero` excluded, `lead_form`/`class_funnel`/`paid_trial`/`campaign_funnel`/`corp_promo` excluded)`. Two studio rows: Stillorgan from its `paid_trial` block's studio half, `enabled = true`; Hatch Street from its `paid_trial` block's studio half, `enabled = true`; `sort_order` 0 and 1.
3. `/50plus`: `kind='campaign', scope='one', slug='50plus', title='The 50+ Club', offer_type='one_class', primary_location_id = stillorgan`, blocks = [page half of the `campaign_funnel` block where `campaign='50plus'`] ‖ the Stillorgan content blocks whose type is in that block's `show_sections` (default all three: `stats`, `video_testimonials`, `reviews`), chrome `noindex=true, tone='light'`, `publish_state='live'`; one studio row (Stillorgan, `enabled=true`, offer + attribution from the block, attribution defaulting to `tag='stillorgan-50plus', lead_source='meta_50plus'` when the block's are blank).
4. `/corp`: `kind='campaign', scope='one', slug='corp', title='Corporate promo', offer_type='promo_credits', primary_location_id = hatch-street`, blocks = [page half of Hatch's `corp_promo` block] ‖ Hatch's content blocks (same exclusions as `/trial`), chrome `noindex=true`, `publish_state='live'`; studio row Hatch `enabled=true`, `offer = {promo_key: coalesce(block.promo_key, 'hatch-3-free')}`.
5. `start` and `free-class`: `kind='campaign', scope='one', primary_location_id = stillorgan, offer_type='none', publish_state='retired', redirect_to='/trial?studio=stillorgan', blocks='[]'`, titles `Start (retired)`, `Free class (retired)`.

- [ ] **Step 1: Write the failing test** — a text-level guard in the repo's style (`tests/helpers/sql-code.js`):

```js
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sqlCode } from './helpers/sql-code.js'
import { STUDIO_OFFER_KEYS, ATTRIBUTION_KEYS, DROPPED_BLOCK_KEYS } from '../src/lib/landing-page-offers.js'

const SQL = sqlCode(readFileSync(path.resolve(import.meta.dirname, '../supabase/migrations/792_landing_pages.sql'), 'utf8'))

describe('mig 792 landing_pages', () => {
  it('creates both tables closed to clients, RLS on, audited', () => {
    for (const t of ['landing_pages', 'landing_page_studios']) {
      expect(SQL).toMatch(new RegExp(`create table if not exists public\\.${t}\\b`, 'i'))
      expect(SQL).toMatch(new RegExp(`alter table public\\.${t} enable row level security`, 'i'))
      expect(SQL).toMatch(new RegExp(`revoke all on public\\.${t} from anon, authenticated`, 'i'))
      expect(SQL).toMatch(new RegExp(`audit_mutation after insert or update or delete on public\\.${t}`, 'i'))
    }
    expect(SQL).not.toMatch(/create policy/i)
  })
  it('strips exactly the studio half the JS module names, per block type', () => {
    for (const [type, keys] of Object.entries(STUDIO_OFFER_KEYS)) {
      for (const k of [...keys, ...ATTRIBUTION_KEYS, ...(DROPPED_BLOCK_KEYS[type] || [])]) {
        expect(SQL, `${type}.${k}`).toMatch(new RegExp(`'${type}'[\\s\\S]{0,1200}- '${k}'`))
      }
    }
  })
  it('backfills the five campaign slugs and deprecates the old table', () => {
    for (const slug of ['trial', '50plus', 'corp', 'start', 'free-class']) expect(SQL).toMatch(new RegExp(`'${slug}'`))
    expect(SQL).toMatch(/on conflict \(organization_id, slug\) do nothing/i)
    expect(SQL).toMatch(/redirect_to[\s\S]{0,200}'\/trial\?studio=stillorgan'/)
    expect(SQL).toMatch(/comment on table public\.landing_page_settings is 'DEPRECATED \(mig 792\)/i)
  })
  it('adds page_id to the request tables', () => {
    for (const t of ['class_booking_requests', 'trial_purchases', 'corp_promo_claims']) {
      expect(SQL).toMatch(new RegExp(`alter table public\\.${t} add column if not exists page_id uuid references public\\.landing_pages\\(id\\) on delete set null`, 'i'))
    }
  })
})
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/migration-792-landing-pages.test.js`
Expected: FAIL, file not found.

- [ ] **Step 3: Write the migration** per the interface above. Header comment: the PAGES.1 story in six lines and a pointer to the spec. Wrap in `BEGIN; … COMMIT;`. The backfill reads `landing_page_settings` joined to `locations`; UN1T Group's id is read as `(select organization_id from locations where id = (select location_id from landing_page_settings where public_path = 'stillorgan'))`, never hard-coded.

- [ ] **Step 4: Run the guard, then the schema checks**

Run: `npx vitest run tests/migration-792-landing-pages.test.js && npm run check:select-columns && npm run check:rls-restrictive`
Expected: PASS; both checks green (the checker now knows both tables).

- [ ] **Step 5: Apply to prod and verify** (the operator step; Richard confirms the project):

Run through the Supabase MCP: `list_projects` (confirm `iyvtbjjxdggiadzwwvdj`), `apply_migration` with the file, then `execute_sql`:

```sql
select slug, kind, scope, offer_type, publish_state, jsonb_array_length(blocks) as n_blocks from landing_pages order by slug;
select p.slug, l.name, s.enabled, s.offer, s.attribution from landing_page_studios s join landing_pages p on p.id = s.page_id join locations l on l.id = s.location_id order by p.slug, s.sort_order;
```

Expected: 7 pages (`stillorgan`, `hatch-street`, `trial`, `50plus`, `corp`, `start`, `free-class`); `trial` has 2 studio rows both enabled; `50plus` has `offer->>'trial_plan_code'` non-empty and `attribution->>'tag' = 'stillorgan-50plus'`. Then `get_advisors` (security): no new ERROR.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/792_landing_pages.sql tests/migration-792-landing-pages.test.js
git commit -m "PAGES.1 — mig 792: landing_pages + landing_page_studios, backfill from landing_page_settings"
```

---

### Task 4: Server readers: `src/lib/landing-pages.js`

**Files:**
- Create: `src/lib/landing-pages.js`
- Test: `src/lib/landing-pages.test.js`

**Interfaces:**
- Consumes: Task 2's `mergeOfferBlock`, `OFFER_BLOCK_TYPE`, `offerConfigured`; `TRIAL_STUDIOS` (`@/lib/trial-studios`: `[{ key: 'stillorgan', publicPath: 'stillorgan' }, { key: 'hatch', publicPath: 'hatch-street' }]`) for the `?studio=` alias; `hasPermissionForLocation` (`@/lib/permissions`), `isOrgAdmin` (`@/lib/org-admin`), `getUserLocationIds` (`@/lib/auth`); `resolveTenantOrgId` (`@/lib/tenant-domains-edge`), `resolveBrand`, `UN1T_GROUP_ORG_ID` (`@/lib/brands`).
- Produces:
  - `PAGE_PUBLISH_STATES = ['draft', 'live', 'coming_soon', 'retired']`; `isPageVisible(state) → state === 'live'`; `isPageReachable(state) → ['live', 'coming_soon', 'retired'].includes(state)`.
  - `PAGE_COLUMNS = 'id, organization_id, slug, title, kind, scope, primary_location_id, offer_type, blocks, chrome, publish_state, redirect_to, updated_at'`; `STUDIO_ROW_COLUMNS = 'page_id, location_id, enabled, offer, attribution, sort_order, locations:location_id ( id, name, membership_source, settings )'`.
  - `loadPageBySlug(db, { orgId, slug }) → Promise<{ page, studios } | null>` (studios ordered by `sort_order`; a `landing_pages` read error throws `PageReadError`).
  - `loadPageById(db, id) → Promise<{ page, studios } | null>`.
  - `publicOrgIdForHost(hostname) → Promise<string>`: in-code brand with an `organizationId` → it; else `resolveTenantOrgId(hostname)`; else `UN1T_GROUP_ORG_ID`.
  - `studioParamToPublicPath(raw) → string | null`: `'hatch'` → `'hatch-street'`, `'stillorgan'` → `'stillorgan'` (via `TRIAL_STUDIOS`), any other value normalised with `normaliseSlug`.
  - `resolvePageStudio({ page, studios, studioLocationId }) → { studio: row | null, picker: row[] }`: `scope='one'` → `studio` = the primary's row (or null when it is missing), `picker = []`; `scope='all'` → `picker` = enabled rows in `sort_order`; `studio` = the enabled row whose `location_id` equals `studioLocationId`, else `null` (a disabled or unknown id is `null`). Rows carry no public path: the caller resolves the `?studio=` value to a `location_id` first with `locationIdForPublicPath` (below).
  - `locationIdForPublicPath(db, orgId, publicPath) → Promise<string | null>`: the `kind='studio'` page with that slug in the org → its `primary_location_id`; **in PR1 falls back to `landing_page_settings.public_path`** when no studio page row exists (the studio pages are backfilled by Task 3, so this is belt and braces).
  - `studioPublicPath(db, locationId) → Promise<string | null>` (the studio page's slug; PR1 fallback to `landing_page_settings.public_path`).
  - `mergedBlocksFor({ page, studio }) → object[]`: the offer block (type `OFFER_BLOCK_TYPE[page.offer_type]`, first match in `page.blocks`) merged with `studio` through `mergeOfferBlock`, in place; every other block as is. With no `studio`, the page half alone.
  - `offerReady({ page, studio, landingPath, product = null }) → boolean`: `offerConfigured(OFFER_BLOCK_TYPE[page.offer_type], mergedBlocksFor({ page, studio })[0], { landingPath, product })`; `landingPath` is the studio's public path, passed by the caller.
  - `canViewPage(user, page) → boolean`: master, or `isOrgAdmin(user, page.organization_id)`, or `scope='one'` and `getUserLocationIds(user).includes(page.primary_location_id)`.
  - `canEditPage(user, page) → boolean`: `scope='one'` → `hasPermissionForLocation(user, page.primary_location_id, 'landing_page')`; `scope='all'` → `isOrgAdmin(user, page.organization_id)` (master passes both through the helpers).
  - `class PageReadError extends Error`.

- [ ] **Step 1: Write the failing test** (a fake `db` in the style of `src/app/api/public/classes/route.campaign.test.js`):

```js
describe('landing-pages', () => {
  it('loadPageBySlug returns the page with its studio rows ordered, null on a miss, throws on a read error')
  it('resolvePageStudio: scope one → the primary row and an empty picker')
  it('resolvePageStudio ignores a disabled studio and lists only enabled rows in the picker')   // Review Focus 1
  it('studioParamToPublicPath maps hatch → hatch-street and refuses junk')
  it('mergedBlocksFor merges the studio half onto the offer block only')
  it('canEditPage: scope one needs landing_page at the studio; scope all needs an org admin; a studio manager is refused on an all-studios page')
  it('publicOrgIdForHost: un1tdublin.com → UN1T Group; a tenant host → its org; the CRM host → UN1T Group')
})
```

Write each with concrete rows: a page `{ id: 'p1', scope: 'all', offer_type: 'paid_trial', blocks: [{ id: 'o', type: 'paid_trial', heading: 'H' }, { id: 'h', type: 'hero' }] }` and studios `[{ location_id: 'loc-s', enabled: true, sort_order: 0, offer: { membership_id: 'm', plan_code: 'p', price_cents: 3900 } }, { location_id: 'loc-h', enabled: false, sort_order: 1, offer: {} }]`; assert `resolvePageStudio({ page, studios, studioLocationId: 'loc-h' }).studio` is `null` and `.picker.map(r => r.location_id)` is `['loc-s']`; assert `mergedBlocksFor({ page, studio: studios[0] })[0].plan_code === 'p'` and `[1]` is unchanged.

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run src/lib/landing-pages.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/lib/landing-pages.js`** per the interface. Server-only (`import 'server-only'` is **not** used elsewhere in this repo; just do not import it from client files).

- [ ] **Step 4: Run it to see it pass**

Run: `npx vitest run src/lib/landing-pages.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/landing-pages.js src/lib/landing-pages.test.js
git commit -m "PAGES.1 — landing-pages readers: page by slug, studio resolution, merged blocks, edit rights"
```

---

### Task 5: Public page slugs at the edge, and the four gates

**Files:**
- Create: `src/lib/public-pages-edge.js`
- Modify: `src/proxy.js` (the `publicPaths` block and the brand `allowed` check), `src/lib/brands.js` (un1t-marketing `allowedPaths` consumer), `src/lib/tenant-domains-edge.js` (`brandFromRow` allowedPaths), `src/app/layout.js` + `src/components/AppShellServer.jsx` + `src/components/AppShell.jsx` (the `x-public-page` header → `isPublicPage` prop)
- Test: `src/lib/public-pages-edge.test.js`, extend `src/public-compliance-paths.test.jsx`

**Interfaces:**
- Produces: `PUBLIC_PAGES_CACHE_TTL_MS = 60_000`; `PUBLIC_PAGE_SLUGS_FALLBACK = Object.freeze({ [UN1T_GROUP_ORG_ID]: Object.freeze(['stillorgan', 'hatch-street', 'trial', '50plus', 'corp', 'start', 'free-class']) })`; `listPublicPageSlugs(orgId, { db = null, nowMs = Date.now() } = {}) → Promise<string[]>` (rows where `publish_state in ('live','coming_soon','retired')`, per-org cache; a thrown or errored read answers the fallback for that org, `[]` for an unknown org, and caches that answer for the TTL); `isPublicPagePath(pathname, slugs) → boolean` (first path segment ∈ slugs; `/` and framework assets false); `_resetPublicPagesCache()`.
- The proxy: after `isPublic` on the CRM host, `|| isPublicPagePath(pathname, await listPublicPageSlugs(await publicOrgIdForHost(hostname)))` — **but** `publicOrgIdForHost` lives in a server module (Task 4) that imports `permissions`/`auth`; the proxy must not import it. Put `publicOrgIdForHost` in `public-pages-edge.js` instead (edge-safe: `resolveBrand`, `resolveTenantOrgId`, `UN1T_GROUP_ORG_ID`) and have Task 4 re-export it from there. On a hit the proxy returns `NextResponse.next({ request: { headers: withPublicPageHeader(request.headers) } })` where `withPublicPageHeader` sets `x-public-page: 1`.
- For brand hosts: `brand.allowedPaths.some(startsWith) || isPublicPagePath(path, slugs)` where `slugs = await listPublicPageSlugs(brand.organizationId)`.
- `AppShellServer` reads `(await headers()).get('x-public-page') === '1'` and passes `isPublicPage` to `AppShell`, whose `isPublic` becomes `pathname === '/' || isPublicPage || PUBLIC_PATHS.some(...)`.

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/public-pages-edge.test.js
it('lists live, coming_soon and retired slugs for the org, cached for 60s')
it('fallback when the read throws: UN1T Group answers the seven known slugs, an unknown org answers []')   // Review Focus 5
it('isPublicPagePath matches the first segment only: /trial, /trial/x true; /trialx, /, /_next/a false')
it('publicOrgIdForHost: www.un1tdublin.com → UN1T Group; crm.un1tdublin.com → UN1T Group; a tenant host → its org')
```

And in `src/public-compliance-paths.test.jsx`, a new `describe('page slugs are public from the database')`: mock `@/lib/public-pages-edge` `listPublicPageSlugs` to return `['january']`; assert the proxy admits `/january` and `/january/anything` anonymously on the CRM host and sets `x-public-page: 1`; assert the marketing host does not rewrite `/january` to `/welcome`; assert a tenant host whose org's list is `[]` still rewrites `/january`; assert `AppShell` with `isPublicPage` renders children with no user.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/public-pages-edge.test.js src/public-compliance-paths.test.jsx`
Expected: FAIL (module not found; proxy redirects `/january` to `/login`).

- [ ] **Step 3: Implement the module and wire the four gates** as in the interface. The edge client is `makeEdgeClient()`'s shape from `tenant-domains-edge.js` (export it from there, or duplicate the three lines). The proxy's existing in-code lists stay untouched in PR1.

- [ ] **Step 4: Run them to see them pass, then the proxy suite**

Run: `npx vitest run src/lib/public-pages-edge.test.js src/public-compliance-paths.test.jsx src/proxy.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/public-pages-edge.js src/lib/public-pages-edge.test.js src/proxy.js src/lib/brands.js src/lib/tenant-domains-edge.js src/app/layout.js src/components/AppShellServer.jsx src/components/AppShell.jsx src/public-compliance-paths.test.jsx
git commit -m "PAGES.1 — public page slugs read at the edge; proxy, brands, tenant defaults and AppShell admit them"
```

---

### Task 6: The `[slug]` route and the three layouts

**Files:**
- Create: `src/app/(public)/[slug]/[[...rest]]/page.js`, `src/components/landing-page/PageLayout.jsx` (exports `FrostedCardLayout`, `OneClassLayout`, `BlocksLayout`), `src/lib/landing-page-render.js` (pure helpers)
- Test: `src/app/(public)/[slug]/[[...rest]]/page.test.jsx`, `src/lib/landing-page-render.test.js`

**Interfaces:**
- Consumes: Task 4 (`loadPageBySlug`, `resolvePageStudio`, `locationIdForPublicPath`, `studioParamToPublicPath`, `mergedBlocksFor`, `offerReady`, `isPageVisible`, `isPageReachable`), Task 5 `publicOrgIdForHost`; existing `BlockRenderer`, `SiteHeader`, `SiteFooter`, `RevealManager`, `RevealArmScript`, `VisitOriginCapture`, `PaidTrialFunnel`, `CampaignHero`, `CampaignFunnel`, `ExpectStrip`, `CorpPromoFunnel`, `trialStudioView`, `campaignFunnelCopy`/`campaignFunnelClientCopy`, `corpPromoCopyFromBlocks`, `un1tTermsPayload`, `resolveOrgChrome`, `resolveLocationBrand`, `getLandingLogo`.
- Produces (`landing-page-render.js`): `layoutFor(offerType) → 'frosted' | 'one_class' | 'blocks'` (`paid_trial`, `class_funnel`, `promo_credits` → `frosted`; `one_class` → `one_class`; `none` → `blocks`); `redirectTarget(page, rest, searchParams) → string` for a retired page (`redirect_to` + the original query string, `rest` dropped); `pageSubpath(page, rest) → { kind: 'root' } | { kind: 'promo', key } | { kind: 'events' } | { kind: 'status' } | { kind: 'unknown' }` (`promo` only for `offer_type='promo_credits'` with one segment; `events`/`status` only for `kind='studio'`; **PR1 returns `unknown` for `events`/`status` and the route 404s them**; PR3 lights them up).
- The route: `generateMetadata` (title `page.chrome.meta_title || page.title`, description `page.chrome.meta_description`, `robots: { index: !page.chrome.noindex, follow: !page.chrome.noindex }`) and the default export per spec §2 steps 1–5. In PR1 the route **serves `kind='campaign'` only**: a `studio` page row returns `notFound()` so `/stillorgan` keeps rendering through `next.config`'s rewrite to `/welcome/[location]` (static rewrite beats the dynamic segment).
- Props to the existing components keep today's shapes: `PaidTrialFunnel({ studios: picker.map(r => trialStudioView(entryFor(r), brand)), initialStudio, resumePurchaseId, cancelled, hatchTerms, returnPath: \`/${page.slug}\` })`; `CampaignFunnel({ publicPath: studio slug, campaign: page.slug, copy: campaignFunnelClientCopy(campaignFunnelCopy(mergedOffer, { brand })), locationName })`; `CorpPromoFunnel` as `corp-page.jsx` builds it today, with `promo` from `pageSubpath` or the row's `promo_key`.
- `entryFor(studioRow)` builds the `loadTrialStudios` entry shape (`{ key, publicPath, locationId, membershipSource, block: mergedOffer, product, sellable, config }`) from a studio row: move the per-entry body of `loadTrialStudios` into an exported `trialEntryFromRow(db, { row, publicPath, mergedBlock })` in `src/lib/trial-studios.js` and have `loadTrialStudios` call it (behaviour unchanged, pinned by its existing tests).

- [ ] **Step 1: Write the failing tests**

`landing-page-render.test.js`:
```js
it('layoutFor maps the five offer types')
it('redirectTarget keeps the query and drops the sub-path: /start/hatch-street?utm_campaign=x → /trial?studio=stillorgan&utm_campaign=x')   // Review Focus 3
it('pageSubpath: /corp/hatch-3-free is a promo; /50plus/x is unknown; /stillorgan/events is unknown in PR1')
```

`page.test.jsx` (mock `@/lib/supabase`, `@/lib/landing-pages` readers, `@/lib/host-brand`, `@/lib/landing-logo`, the funnel components as `data-testid` stubs, as `src/app/50plus/page.test.jsx` does):
```js
it('a live one_class page renders CampaignHero, the funnel with client-safe copy only (no trial ids, no keywords), the expect strip and its own content blocks in light tone')
it('a live paid_trial all-studios page with no ?studio renders the picker over enabled rows only; ?studio=hatch preselects Hatch; ?studio=<disabled> falls back to the picker')
it('a draft page 404s; a retired page redirects with the query kept; coming_soon 404s')
it('a studio-kind page 404s in PR1 (left to /welcome/[location])')
it('an unreadable landing_pages read renders nothing but still never throws: notFound()')
it('?edit=1 mounts EditModeOverlay with the merged blocks')
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/landing-page-render.test.js 'src/app/(public)/[slug]/[[...rest]]/page.test.jsx'`
Expected: FAIL.

- [ ] **Step 3: Implement** `landing-page-render.js`, `PageLayout.jsx` (lift the JSX of `src/app/trial/page.js` lines 54–89 into `FrostedCardLayout`, of `src/app/50plus/page.js` into `OneClassLayout`, and the content-only shape into `BlocksLayout`; each takes `{ page, blocks, header, footer, offer, tone }`), the `trialEntryFromRow` refactor, and the route. The route reads the org with `publicOrgIdForHost((await headers()).get('host'))`, and on `?edit=1` with a signed-in user uses `getCurrentUser().activeOrganization.id` instead (spec §2 step 1).

- [ ] **Step 4: Run them to see them pass; run `npm run build`** (a new route and new imports: the only check that catches a bad import)

Run: `npx vitest run src/lib/landing-page-render.test.js 'src/app/(public)/[slug]/[[...rest]]/page.test.jsx' src/lib/trial-studios.test.js && npm run build`
Expected: PASS; build green.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/(public)' src/components/landing-page/PageLayout.jsx src/lib/landing-page-render.js src/lib/landing-page-render.test.js src/lib/trial-studios.js
git commit -m "PAGES.1 — the [slug] route: one render for every campaign page, three layouts by offer type"
```

---

### Task 7: Public API routes resolve `(page, studio)`

**Files:**
- Modify: `src/app/api/public/classes/route.js`, `src/app/api/public/class-booking/route.js`, `src/app/api/public/trial-purchases/route.js` (+ `help/route.js` if it reads the row), `src/app/api/public/corp-claims/route.js`, `src/app/api/public/leads/route.js`, `src/app/api/public/funnel-event/route.js`; `src/lib/landing-pages.js` (add the request resolver); `src/components/landing-page/CampaignFunnel.jsx`, `PaidTrialFunnel.jsx`, `CorpPromoFunnel.jsx`, `src/components/WaitlistWidget.jsx`, `src/components/ClassFunnel.jsx` (send `page` + `studio`)
- Test: `src/lib/landing-pages.request.test.js`, the existing route tests updated (`route.campaign.test.js` ×2, trial-purchases, corp-claims, leads, funnel-event)

**Interfaces:**
- Produces (in `landing-pages.js`): `resolvePublicPageRequest(db, { hostname, page, studio, legacyPath }) → Promise<{ ok: true, pageId, page, studioRow, locationId, publicPath, blocks, attribution } | { ok: false, reason: 'not_found' | 'not_configured' | 'studio_required' | 'unreadable' }>`.
  - `page` present: `orgId = publicOrgIdForHost(hostname)`; `loadPageBySlug`; not reachable/visible → `not_found`; `scope='one'` → the primary row (a `studio` param naming another studio → `not_found`, Review Focus 4); `scope='all'` → `studio` required (`studio_required` when missing), resolved via `studioParamToPublicPath` + `locationIdForPublicPath`, disabled → `not_found`; `blocks = mergedBlocksFor`; `attribution = { ...defaultAttribution({ publicPath, slug }), ...studioRow.attribution }`.
  - `page` absent (legacy): `legacyPath` through `resolveLandingPath`; **PR1 reads `landing_page_settings` exactly as today** and returns `pageId: null`, `attribution` from the blocks as today (`leadConfigFromBlocks` / per-type config). PR3 deletes this branch.
- Each route: `page` (query or body, `z.string().max(40).optional()`) and `studio` (`z.string().max(40).optional()`) added to its schema; the old `path`/`location_path`/`public_path`/`landing_path`/`campaign` fields kept and routed to `legacyPath`; `campaign` ignored when `page` is present. Where the route wrote `tag`/`lead_source`, it now takes `attribution`; where it inserted a request row, it adds `page_id: pageId`. `LEAD_CAMPAIGNS` stays for the legacy branch only.
- Browser components send `{ page: pageSlug, studio: studioPublicPath }` when given a `page` prop (the `[slug]` route passes it), else today's fields (the `/welcome/[location]` page still passes `publicPath` only).

- [ ] **Step 1: Write the failing tests**

`landing-pages.request.test.js`:
```js
it('a one-studio page ignores studio when it names the primary and refuses another studio with not_found')   // Review Focus 4
it('an all-studios page needs a studio: missing → studio_required; disabled → not_found; enabled → merged blocks + attribution with defaults filled')
it('a draft page is not_found; a retired page is not_found for the API')
it('legacy: no page → landing_page_settings by path, pageId null')
```

Route tests: in `classes/route.campaign.test.js` add `lists the campaign page's allow-listed class with ?page=50plus and reports configured`; in `class-booking` add `books only within the page's allow-list and stamps page_id; a forged studio on a one-studio page is 404`; in `trial-purchases` add `?page=trial&studio=hatch-street buys Hatch's product and stamps page_id`; in `corp-claims` add `page=corp claims the row's promo_key; a body promo_key is ignored`; in `leads` add `page+studio sets tag/lead_source from the row's attribution; the body cannot set them`; in `funnel-event` add `page+studio resolves location_id and stamps page_id`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/lib/landing-pages.request.test.js src/app/api/public`
Expected: the new tests FAIL; the old ones PASS.

- [ ] **Step 3: Implement** the resolver and thread it through the six routes and five components. Keep every rate-limit key tenant-keyed on `publicPath`. Keep `check:route-guards` happy (these are `/api/public/`, auto-classified).

- [ ] **Step 4: Run them to see them pass, then the guards**

Run: `npx vitest run src/lib/landing-pages.request.test.js src/app/api/public src/components/landing-page src/components/WaitlistWidget.test.jsx && npm run check:route-guards && npm run check:location-scoping && npm run check:select-columns`
Expected: PASS; `check:location-scoping` may flag the new reads of `landing_pages` in public routes: register `resolvePublicPageRequest(` in `SCOPING_HELPERS` (it filters `organization_id` and `slug`, then the studio row by `location_id`) with its file named in the comment.

- [ ] **Step 5: Commit**

```bash
git add src/lib/landing-pages.js src/lib/landing-pages.request.test.js src/app/api/public src/components/landing-page src/components/WaitlistWidget.jsx src/components/ClassFunnel.jsx scripts/check-location-scoping.mjs
git commit -m "PAGES.1 — public routes resolve (page, studio); attribution and ids from the row, never the body"
```

---

### Task 8: `one_class` and `promo_credits` end to end on rows; the old campaign routes deleted

**Files:**
- Delete: `src/app/50plus/page.js`, `src/app/50plus/page.test.jsx`, `src/app/trial/page.js`, `src/app/corp/page.js`, `src/app/corp/[promo]/page.js`, `src/app/corp/corp-page.jsx`, `src/app/start/page.js`, `src/app/start/[path]/page.js`, `src/app/free-class/page.js` (and their tests)
- Modify: `src/proxy.js` `publicPaths`, `src/components/AppShell.jsx` `PUBLIC_PATHS`, `src/lib/brands.js` un1t-marketing `allowedPaths` (remove `/free-class`, `/start`, `/trial`, `/50plus`, `/corp`); `src/public-compliance-paths.test.jsx` (`TENANT_PINNED_OFF` loses those five; the page-slug describe from Task 5 covers them); `tests/usage-features-coverage.test.js` (`WEB_NOT_STAFF` loses `50plus`, `trial`, `corp`, `start`, `free-class` if listed); `src/lib/meta-pixel-paths.js` (`/corp` stays listed for the Hatch pixel until Task 24 reads it from the page; leave as is); `src/lib/trial-return-path.js` (`TRIAL_RETURN_PATHS` unchanged in PR1)
- Test: the `[slug]` page test gains the two concrete cases

- [ ] **Step 1: Write the failing tests** in `page.test.jsx`: `the backfilled /50plus row renders the same hero copy, video and tiles the old route did` (fixture: the row shape Task 3 produces for `50plus`) and `the backfilled /corp row renders the promo copy with {credits} filled from the registry, and /corp/hatch-3-free selects that promo`.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run 'src/app/(public)/[slug]/[[...rest]]/page.test.jsx'`
Expected: the two new tests FAIL.

- [ ] **Step 3: Make them pass**, then delete the nine route files and their tests, trim the three in-code lists and the two pinned-path tests. `/start/[path]` and `/free-class` are now served by the retired rows (Task 6's redirect).

- [ ] **Step 4: Verify** 

Run: `npx vitest run src/public-compliance-paths.test.jsx tests/usage-features-coverage.test.js 'src/app/(public)' && npm run build`
Expected: PASS; build green with the routes gone.

- [ ] **Step 5: Commit**

```bash
git add -A src/app/50plus src/app/trial src/app/corp src/app/start src/app/free-class src/proxy.js src/components/AppShell.jsx src/lib/brands.js src/public-compliance-paths.test.jsx tests/usage-features-coverage.test.js 'src/app/(public)'
git commit -m "PAGES.1 — /trial, /50plus, /corp, /start, /free-class render from rows; code routes and allowlist entries removed"
```

---

### Task 9: Stamp `page_id` on requests and read confirmation copy from the page

**Files:**
- Modify: `src/lib/un1t-online-booking-processor.js`, `src/app/api/agent/membership-requests/[id]/route.js`, `src/lib/trial-purchase-un1t-settle.js` (if it reads the row), `src/lib/landing-pages.js` (add `copySourceForRequest`)
- Test: `src/lib/landing-pages.copy-source.test.js`, the processor's existing tests extended

**Interfaces:**
- Produces: `copySourceForRequest(db, { pageId, locationId }) → Promise<{ blocks: object[], publicPath: string | null }>`: with `pageId` → `loadPageById`, the studio row for `locationId`, `mergedBlocksFor`; without → `studioPageBlocksFor(db, locationId)` (the `kind='studio'` page's merged blocks; **PR1 fallback: `landing_page_settings` by `location_id`** as today), and `publicPath` = `studioPublicPath`.
- The processor and Mia's membership-request route read `page_id` off `class_booking_requests` and call `copySourceForRequest` where they read `landing_page_settings` today.

- [ ] **Step 1: Write the failing test**

```js
it('with a page_id the copy comes from that page merged with its studio row')
it('without one it comes from the studio page (PR1: landing_page_settings) and never throws on a miss (defaults)')
```

- [ ] **Step 2: Run to see it fail** · **Step 3: Implement** · **Step 4: Run** `npx vitest run src/lib/landing-pages.copy-source.test.js src/lib/un1t-online-booking-processor.test.js 'src/app/api/agent/membership-requests'` → PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "PAGES.1 — confirmation copy reads the page a request came from"
```

---

### Task 10: Before/after diff of the live URLs

**Files:**
- Create: `scripts/diff-public-pages.mjs`
- Docs: `docs/superpowers/plans/2026-10-30-landing-pages-editor.md` (this file: tick the step with the run's output summary)

**Interfaces:**
- `node scripts/diff-public-pages.mjs --before https://crm.un1tdublin.com --after http://localhost:3000 /trial /50plus /corp "/trial?studio=hatch" "/start?utm_campaign=x" /free-class` prints, per URL, the final status and location, and a diff of visible text (tags stripped, whitespace folded) and of every `src`, `poster`, `href` attribute. Exit 1 on any difference other than the `?edit`-only attributes.

- [x] **Step 1: Write the script** (pure helpers unit-tested in `tests/diff-public-pages.test.js`, 9 tests; CLI smoke-run against local stub servers only). Step 2 is the controller's Task 11 run.
- [ ] **Step 2: Run it** with `npm run dev` on the branch against prod (read-only GETs).
Expected: zero text and media differences on `/trial`, `/50plus`, `/corp`; `/start` and `/free-class` 307 to the same target with the query kept. Paste the summary into the PR description.
- [ ] **Step 3: Commit**

```bash
git add scripts/diff-public-pages.mjs
git commit -m "PAGES.1 — before/after diff script for the public pages"
```

---

### Task 11: CI mirror, changelog, PR

- [ ] **Step 1:** Run the thirteen-command CI mirror from CLAUDE.md. Expected: all green. Fix anything red in place (`check:select-columns` allowlist entries need a reason and an expiry; prefer fixing the column).
- [ ] **Step 2:** `docs/changelog/entries/<PR>.md` after `gh pr create` (one row keyed `#<PR>`).
- [ ] **Step 3:** Push, open the PR with the diff summary, bind it (`mcp__ccd_pr__get_status` / `bind_pr`), report the URL. Migration 792 must already be applied (Task 3 step 5) before merge.

---

### Task 12: PR1 memory note

- [ ] Write a memory file `landing-pages-pages1-in-progress.md` (type `project`) recording: mig 792 applied (date), PR1 URL, "studio pages still read `landing_page_settings` until PR3", and add its line to `MEMORY.md`.

---

## PR2 — the Pages list and the editor

### Task 13: Pages API: list, create, read, update, publish, studio rows

**Files:**
- Create: `src/app/api/landing-pages/route.js` (GET list, POST create), `src/app/api/landing-pages/[id]/route.js` (GET, PUT), `src/app/api/landing-pages/[id]/publish/route.js` (POST), `src/app/api/landing-pages/[id]/studios/[locationId]/route.js` (PUT), `src/app/api/landing-pages/slug-check/route.js` (GET)
- Modify: `src/lib/schemas.js` (add `landingPageCreateSchema`, `landingPageUpdateSchema`, `landingPageStudioSchema`, `landingPagePublishSchema`), `src/lib/openapi.js` (register the five), `src/lib/landing-pages.js` (`listPagesForUser`, `createPage`, `renameSlug`)
- Test: one `route.test.js` beside each route

**Interfaces:**
- Schemas (`src/lib/schemas.js`):
  - `landingPageCreateSchema = z.object({ title: z.string().trim().min(1).max(120), slug: z.string().trim().min(2).max(40), kind: z.literal('campaign'), scope: z.enum(['one', 'all']), primary_location_id: uuidLike.nullable().optional(), offer_type: z.enum(OFFER_TYPES), start_from_page_id: uuidLike.nullable().optional() })` (a `studio` kind is never created by hand: one exists per studio from the backfill, and a new studio gets one from Task 22's creation hook).
  - `landingPageUpdateSchema = z.object({ title: …optional, slug: …optional, blocks: BlocksArraySchema.optional(), chrome: z.object({ logo_url: z.string().url().nullable(), logo_alt: z.string().max(120).nullable(), logo_width_px: z.number().int().min(40).max(600).nullable(), tone: z.enum(['light', 'dark']), noindex: z.boolean(), meta_title: z.string().max(120).nullable(), meta_description: z.string().max(300).nullable(), show_instagram_feed: z.boolean(), chooser_label: …, chooser_cta_text: …, chooser_image_url: … }).partial().optional() })`.
  - `landingPageStudioSchema = z.object({ enabled: z.boolean(), offer: z.record(z.unknown()), attribution: attributionSchema, sort_order: z.number().int().min(0).max(99).optional() })` — the route then parses `offer` with `studioOfferSchema(OFFER_BLOCK_TYPE[page.offer_type])`.
  - `landingPagePublishSchema = z.object({ publish_state: z.enum(PAGE_PUBLISH_STATES), redirect_to: z.string().regex(/^\/[a-z0-9\-\/?=&._%]*$/i).max(300).nullable().optional() })`.
- Route rules: `getCurrentUser()` → 401; load the page by id (404 outside the caller's view, `canViewPage`); `canEditPage` → 403 for writes; `validateBody`; `createServerClient()`; `{ success, data }`. Create: `scope='one'` requires `landing_page` at `primary_location_id`; `scope='all'` requires `isOrgAdmin` of `user.activeOrganization.id`; `slugProblem` → 400 `{ error: 'reserved' | 'invalid' }`; unique violation (23505) → 409 `{ error: 'taken' }`; one studio row per active studio of the org is created (`enabled = scope === 'one'` for the primary, else false); `start_from_page_id` copies that page's **content** blocks (never its offer block) with fresh ids, only when the caller can view it. Update: a `slug` change on a page that has ever been `live` (`chrome.was_live = true`, set by publish) writes a `retired` row for the old slug with `redirect_to = /<new slug>`; `offer_type` is not updatable. Publish: `live` requires at least one enabled studio row with `offerReady` (else 409 `not_ready`) unless `offer_type='none'`; `retired` requires `redirect_to`. The studio-row PUT re-validates `location_id` belongs to the page's rows and parses `offer` with the type's schema. `slug-check?slug=&org=` returns `{ available, problem }` for the caller's org only.
- `listPagesForUser(db, user)` → rows the caller `canViewPage`, each with `studios: [{ location_id, name, enabled, ready }]` and `offer_summary` (type label + the studio's plan/product name where `scope='one'`, `'per studio'` where `all`).

- [ ] **Step 1: Write the failing tests** (one file per route; the repo's `vi.mock('@/lib/supabase')` + `@/lib/auth` pattern):
```js
// route.test.js (list + create)
it('GET lists only pages the caller can view: a Stillorgan manager sees stillorgan, 50plus, trial (read-only flag), not corp')
it('POST refuses a reserved slug (400 reserved), a taken slug (409 taken), an all-studios page from a non-admin (403)')   // Review Focus 2
it('POST creates a draft with one studio row per active studio and copies only content blocks from start_from_page_id')
// [id]/route.test.js
it('PUT by a studio manager on an all-studios page is 403; by an org admin saves blocks and chrome')
it('PUT renaming a page that was live writes a retired redirect row for the old slug')
// publish/route.test.js
it('live is refused with not_ready when no enabled studio row is configured; granted when one is; retired needs redirect_to')
// studios/[locationId]/route.test.js
it('parses offer with the page type schema, refuses an unknown key, 404s a location not on the page')
// slug-check/route.test.js
it('answers available/problem for the caller org')
```

- [ ] **Step 2: Run to see them fail** · **Step 3: Implement** · **Step 4:** `npx vitest run src/app/api/landing-pages && npm run check:route-guards && npm run check:location-scoping` → PASS (register `canViewPage(`/`canEditPage(` in `SCOPING_HELPERS` after verifying they compare the row's `organization_id`/`primary_location_id`).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/landing-pages src/lib/schemas.js src/lib/openapi.js src/lib/landing-pages.js scripts/check-location-scoping.mjs
git commit -m "PAGES.1 — pages API: list, create, update, publish, studio rows, slug check"
```

---

### Task 14: The Pages list and the New page form

**Files:**
- Modify: `src/app/settings/landing-page/page.js` (becomes the list; `?page=chooser` keeps the chooser editor)
- Create: `src/components/landing-pages/PagesList.jsx`, `src/components/landing-pages/NewPageDialog.jsx`
- Test: `src/components/landing-pages/PagesList.test.jsx`, `src/components/landing-pages/NewPageDialog.test.jsx`

**Interfaces:**
- `PagesList({ pages, canCreate, studios })`: the table from the mockup (columns Page · Path · Studios · Offer · Status · Updated · Edit); chips `Live` (`bg-green-500/10 text-green-700`), `Draft` (`bg-gray-500/10 text-gray-700`), `Coming soon` (`bg-amber-500/10 text-amber-700`), `Retired` (`bg-gray-500/10 text-gray-700`); scope chip `All studios · n of m on`; "Front page" link to `?page=chooser` for org admins; "+ New page" opens `NewPageDialog`.
- `NewPageDialog({ studios, canCreateAll, onCreated })`: title, path (debounced `GET /api/landing-pages/slug-check`, shows `taken`/`reserved`/`invalid`), scope radio, studio select (when `one`), offer type select with the `BLOCK_TYPES` descriptions, "Start from" select of viewable pages; `POST /api/landing-pages`; on success `router.push(/settings/landing-page/${id})`. Every `<button>` typed.

- [ ] **Step 1: Write the failing tests**: `renders a row per page with the right chips and Edit links`; `hides + New page without canCreate`; dialog: `shows taken/reserved from slug-check and disables Create until the slug is clean`, `posts the body and navigates to the editor`.
- [ ] **Step 2–4:** fail → implement → `npx vitest run src/components/landing-pages src/app/settings/landing-page` → PASS.
- [ ] **Step 5: Commit** `PAGES.1 — Settings → Landing pages: the Pages list and New page`.

---

### Task 15: The editor page and the form generalised to a page row

**Files:**
- Create: `src/app/settings/landing-page/[id]/page.js`
- Modify: `src/components/LandingPageSettingsForm.jsx` (props `{ page, studios, availableBookingTypes, availableEvents, brand, canEdit }`; saves `PUT /api/landing-pages/[id]` with `{ title, blocks, chrome }`; `previewSrc = /${page.slug}?edit=1${previewStudio ? `&studio=${previewStudio}` : ''}`; `liveUrl = /${page.slug}`; the logo fields read `page.chrome`), `src/components/landing-page/PageSwitcher.jsx` (deleted: the list replaces it)
- Create: `src/components/landing-pages/PageHeaderCard.jsx` (title, path with rename, status + Publish/Unpublish/Retire buttons calling `POST …/publish`, scope read-only)
- Test: `src/components/LandingPageSettingsForm.page.test.jsx`, `src/components/landing-pages/PageHeaderCard.test.jsx`

- [ ] **Step 1: Write the failing tests**: form `saves to /api/landing-pages/<id> with title, blocks and chrome, and the preview iframe src is /<slug>?edit=1`; `read-only when canEdit is false (no Save, inputs disabled)`; header `Publish posts live and shows not_ready from the API as a message naming the studio`; `Retire asks for a redirect path`.
- [ ] **Step 2–4:** fail → implement → `npx vitest run src/components/LandingPageSettingsForm.page.test.jsx src/components/landing-pages src/components/LandingPageSettingsForm.test.jsx` → PASS (the existing form tests keep passing with the new props: adapt their fixtures, not the assertions).
- [ ] **Step 5: Commit** `PAGES.1 — the page editor: header card, form on a page row`.

---

### Task 16: The pinned offer block with studio rows

**Files:**
- Create: `src/components/landing-pages/OfferBlockEditor.jsx`, `src/components/landing-pages/StudioOfferRow.jsx`
- Modify: `src/components/LandingPageSettingsForm.jsx` (the offer block renders through `OfferBlockEditor` at index 0, not draggable, not deletable; `CampaignFunnelEdit`, the `paid_trial`, `class_funnel`, `corp_promo` editors lose their studio-half fields, `campaign` and `show_sections`; the "+ Add section" library hides offer types), `src/lib/landing-page-blocks.js` (`BLOCK_TYPES` entries for the four offer blocks gain `offer: true`; `defaultBlocks()` unchanged)
- Test: `src/components/landing-pages/OfferBlockEditor.test.jsx`, `src/components/landing-pages/StudioOfferRow.test.jsx`, update `src/components/CampaignFunnelEdit.test.jsx`

**Interfaces:**
- `OfferBlockEditor({ page, block, studios, onUpdateBlock, onSaveStudio, canEdit })`: page-half fields (the existing per-type editor components, now receiving only page keys) then one `StudioOfferRow` per studio row.
- `StudioOfferRow({ page, row, onSave, canEdit })`: switch (`enabled`), the type's studio fields (paid_trial: Glofox plan picker **or** un1t product select by the studio's `membership_source`, price, duration, product name; class_funnel: trial plan, consult slug, timetable fields; campaign_funnel: trial plan picker + class keywords; corp_promo: promo key select from `liveCorpPromos()`), tag + lead source inputs placeholdered with `defaultAttribution`, a readiness chip (`Ready` green / `Needs a plan` amber / `No platform` gray) from `offerConfigured` on the merged block, its own Save (`PUT …/studios/<locationId>`).
- The existing Glofox plan picker in `CampaignFunnelEdit` (the `<select aria-label="Glofox trial plan">` fed by the form's plan list) is lifted into `StudioOfferRow`; the plan list is loaded per studio from the same endpoint the form uses today.

- [ ] **Step 1: Write the failing tests**: `renders a row per studio with switch, type fields and a readiness chip`; `the campaign_funnel editor no longer shows Page, Sections shown or the duplicate warning`; `saving a row PUTs offer and attribution for that studio only`; `the offer block cannot be dragged or deleted and the library hides offer types`.
- [ ] **Step 2–4:** fail → implement → `npx vitest run src/components/landing-pages src/components/CampaignFunnelEdit.test.jsx src/components/LandingPageSettingsForm.test.jsx` → PASS.
- [ ] **Step 5: Commit** `PAGES.1 — the pinned offer block: page half, one row per studio`.

---

### Task 17: Preview studio switch and the overlay on offer layouts

**Files:**
- Modify: `src/components/LandingPageSettingsForm.jsx` (preview bar: `Previewing: <select>` over enabled studio rows + "Choose on page" for `scope='all'`; reloads the iframe with `&studio=`), `src/components/landing-page/EditModeOverlay.jsx` (accepts `offerLayout` and renders the page's `PageLayout` with the pinned block selectable: clicking the hero posts `block-clicked` for the offer block id; `EditableText` on `heading`, `subhead`, `eyebrow`, `pick_title`, `pick_body`, `done_title`, `done_body`; the booking card not intercepted), `src/app/(public)/[slug]/[[...rest]]/page.js` (`?edit=1` passes `offerLayout`, the merged offer and the resolved/preview studio to the overlay)
- Test: `src/components/landing-page/EditModeOverlay.offer.test.jsx`, extend `LandingPageSettingsForm.page.test.jsx`

- [ ] **Step 1: Write the failing tests**: `the preview select lists enabled studios and sets &studio= on the iframe`; overlay: `clicking the one_class hero selects the offer block and the headline is editable in place`; `the frosted card renders the trial card as preview (disabled), never a live POST`.
- [ ] **Step 2–4:** fail → implement → `npx vitest run src/components/landing-page/EditModeOverlay.offer.test.jsx src/components/landing-page/EditModeOverlay.test.jsx src/components/LandingPageSettingsForm.page.test.jsx` → PASS.
- [ ] **Step 5: Commit** `PAGES.1 — preview: choose the studio, edit the offer hero in place`.

---

### Task 18: Media uploads by page

**Files:**
- Modify: `src/app/api/landing-page-settings/media/route.js`, `…/media/signed-upload/route.js`, `hero-image`, `hero-video`, `gallery-photo`, `pillar-photo` routes (accept `page_id` as the alternative to `location_id`: path `pages/<page_id>/<uuid>.<ext>`; auth = `canEditPage` on the page), `src/components/landing-page/EditableImage.jsx`, `HeroMediaTools.jsx`, the form's upload helpers (send `page_id`), `EditModeOverlay` state (`pageId` beside `locationId`)
- Test: `src/app/api/landing-page-settings/media/route.page.test.js`; `tests/branding-bucket-guard.test.js` learns the new path prefix

- [ ] **Step 1: Write the failing tests**: `page_id upload lands under pages/<id>/ and needs canEditPage`; `a caller who cannot edit the page is 403`; bucket guard: the new writer accepts only the bucket's types and sizes.
- [ ] **Step 2–4:** fail → implement → `npx vitest run src/app/api/landing-page-settings tests/branding-bucket-guard.test.js` → PASS.
- [ ] **Step 5: Commit** `PAGES.1 — media uploads attributed to a page`.

---

### Task 19: Permission copy, nav and parity

**Files:**
- Modify: `shared/permissions.js` (`landing_page` hint → 'Edit the public landing pages: the studio page and campaign pages at this studio.'), `src/lib/settings-tree.js` (label `Landing pages`), `src/lib/hub-index-chains.js` (comment only)
- Test: existing permission tests; `npm run check:mobile-parity`

- [ ] Run `npx vitest run shared src/lib/settings-tree.test.js && npm run check:mobile-parity && npm run check:mobile-imports` → PASS. Commit `PAGES.1 — permission copy and nav label`.

---

### Task 20: PR2 ship

- [ ] CI mirror; `npm run build`; a manual pass on the dev server: open the list, create a draft `january` page (`scope='all'`, `paid_trial`, start from `trial`), set Stillorgan's row, see `Ready`, publish, open `/january`, see the picker with one studio; retire it with `redirect_to=/trial`. Changelog entry; PR; bind; report.

---

## PR3 — studio pages, chooser and readers on `landing_pages`; old table deprecated

### Task 21: Studio pages and their sub-pages on the `[slug]` route

**Files:**
- Modify: `src/app/(public)/[slug]/[[...rest]]/page.js` (serve `kind='studio'`: `BlocksLayout` with TRIALFIRST's trial card in the hero when `offer_type='paid_trial'` and the row is sellable, `pageCtas`, JSON-LD, `events` and `status` sub-paths), `src/lib/landing-page-render.js` (`pageSubpath` lights `events`/`status`), `src/app/welcome/[location]/page.js`, `events/page.js`, `status/page.js` (each becomes `redirect('/<slug>…')` with the query kept), `next.config.*` (the four pretty-path rewrites removed), `src/lib/trial-return-path.js` (`TRIAL_RETURN_PATHS` validated against `['/trial', '/stillorgan', '/hatch-street']` still; comment updated)
- Move the bodies of `events/page.js` and `status/page.js` into `src/components/landing-page/StudioEventsPage.jsx` and `StudioStatusPage.jsx`, reading the studio from the page row.
- Test: page test gains `a studio page renders hero + blocks with the trial card and pageCtas`, `/stillorgan/events renders the events page for that studio; /stillorgan/status the status page; /stillorgan/x 404s`, `/welcome/stillorgan redirects to /stillorgan with the query`.

- [ ] Steps: failing tests → implement → `npx vitest run 'src/app/(public)' src/app/welcome src/public-compliance-paths.test.jsx && npm run build` → PASS → commit `PAGES.1 — studio pages, events and status on the [slug] route; /welcome/<path> redirects`.

- Note (final review of PR1, 31 Oct 2026). Before PR3: redesign how AppShell learns a DB page is public on soft navigation (the `x-public-page` header is read once in the root layout and does not update on client-side navigation; a `<Link>` from an in-code public page to a DB page bounces an anonymous visitor to /login once the studio paths leave `PUBLIC_PATHS`). Options: a client-readable public slug list, or no client redirect when the server already admitted the page. PR1 also restricts the edge slug tier to `kind = 'campaign'` (`listPublicPageSlugs` and `PUBLIC_PAGE_SLUGS_FALLBACK` in `src/lib/public-pages-edge.js`): this task lifts that, adding `stillorgan` and `hatch-street` back to the fallback.
- Before cutover: re-sync `landing_page_settings` → the two `kind='studio'` rows (blocks, chrome.un1t_terms, publish_state) with a printed diff, and insert missing `landing_page_studios` rows for studios created since mig 792; PR2 made studio pages read-only in the row editor for this reason.

---

### Task 22: Chooser, logo, front page and new-studio hook read `landing_pages`

**Files:**
- Modify: `src/app/welcome/page.js`, `src/lib/welcome-front-page.js` (`loadFrontPage` tiles from `landing_pages where kind='studio'`: `chrome.chooser_*`, `publish_state` mapped through `tileModeFor` with `draft` → `hidden`), `src/app/api/chooser-settings/route.js` + `tile-image/route.js` (write `chrome.chooser_image_url` on the studio page), `src/lib/landing-logo.js` (`getLandingLogo(publicPath)` → the studio page's `chrome.logo_url`), `src/lib/host-brand.js` (`public_path` map from studio pages), `src/app/api/settings/status-page/route.js`, `src/app/legal/un1t/[slug]/[doc]/page.js`, `src/lib/landing-page-visibility.js` (`PUBLISH_STATES` gains the page states; `isPubliclyVisible` unchanged for the old three), the location-create path (`src/app/api/locations/route.js` POST: after a new active location, insert its `kind='studio'` page as `draft` with `slug = slugify(name)` made unique, `defaultBlocks()`, `offer_type='none'`, one studio row)
- Test: each touched module's existing test file gets a case on the new read; `src/app/api/locations/route.test.js` gains `creating a location creates its draft studio page`.

- [ ] Steps: failing tests → implement → `npx vitest run src/app/welcome src/lib/welcome-front-page.test.js src/app/api/chooser-settings src/lib/landing-logo.test.js src/lib/host-brand.test.js src/app/api/locations` → PASS → commit `PAGES.1 — chooser, logo, host brand and new studios on landing_pages`.

---

### Task 23: Studio-only readers move; the legacy branch goes

**Files:**
- Modify: `src/lib/landing-pages.js` (`locationIdForPublicPath`, `studioPublicPath`, `copySourceForRequest`, `resolvePublicPageRequest` lose their `landing_page_settings` fallbacks; the legacy `path` branch resolves the **studio page** by slug and returns its merged blocks, so `/stillorgan`'s own forms keep working), `src/lib/un1t-online-funnel-copy.js` callers (`classes`, `class-booking`, `trial-purchases` routes already go through the resolver; `src/lib/whatsapp-flow/handler.js` → `studioPageBlocksFor(db, locationId)`), `src/lib/public-classes.js` `readNoGlofoxClasses` (blocks from the page the request named, passed in by the caller: signature gains `{ blocks }`; the `/api/public/classes` route passes the merged blocks), `src/lib/leads.js` (`LEAD_CAMPAIGNS` and `resolveCampaign` deleted; the `campaign` field dropped from `LeadSchema`), `src/lib/public-landing.js` (`resolveLandingPath` kept for the legacy param), `src/lib/trial-studios.js` (`loadTrialStudios` reads the `trial` page's studio rows: `loadPageBySlug(db, { orgId: UN1T_GROUP_ORG_ID, slug: 'trial' })` then `trialEntryFromRow` per row; `readPaidTrialAccountEmailCopy` reads the studio page), `src/lib/un1t-online-booking-processor.js`, `src/app/api/agent/membership-requests/[id]/route.js` (through `copySourceForRequest`, already), `src/app/welcome/preview/page.js` (delete or point at the list), `scripts/_lp*-commit.mjs` (delete: one-off scripts naming the old table)
- Test: `tests/landing-page-settings-readers-guard.test.js`: no file under `src/`, `shared/`, `scripts/` (except `scripts/check-location-scoping.mjs`'s table list) names `landing_page_settings`; each moved reader's test gets a case.

- [ ] Steps: write the guard (fails on the current readers) → move each reader, running its tests → `npx vitest run tests/landing-page-settings-readers-guard.test.js src/lib src/app/api/public` → PASS → commit `PAGES.1 — every reader on landing_pages; landing_page_settings unread`.

---

### Task 24: Meta pixel and return paths from the page

**Files:**
- Modify: `src/lib/meta-pixel-paths.js` (`metaPixelIdsForPath(pathname, { primaryLocationId })`: the Hatch dataset when the page's primary studio is Hatch, else the path table as today; the `[slug]` route passes it through the root layout's existing pixel island by a `data-` attribute or the `x-public-page-location` header), `src/lib/trial-return-path.js` (`TRIAL_RETURN_PATHS` = `/trial` + the studio page slugs read at call time; `normalizeTrialReturnPath` async or given the list)
- Test: `src/lib/meta-pixel-paths.test.js`, `src/lib/trial-return-path.test.js` extended.

- [ ] Steps: failing tests → implement → PASS → commit `PAGES.1 — Hatch pixel and trial return paths follow the page's studio`.

---

### Task 25: In-code public path entries and pinned tests trimmed

**Files:**
- Modify: `src/proxy.js` `publicPaths` (remove `/welcome`'s pretty siblings? no: `/welcome` stays for the chooser; remove nothing else in PR3 beyond Task 8), `src/components/AppShell.jsx` `PUBLIC_PATHS` (remove `/stillorgan`, `/hatch-street`), `src/lib/brands.js` (remove `/stillorgan`, `/hatch-street`), `src/lib/public-pages-edge.js` (`PUBLIC_PAGE_SLUGS_FALLBACK` is the fallback; keep the seven), `src/public-compliance-paths.test.jsx` (the two studio paths move into the page-slug describe), `tests/usage-features-coverage.test.js`
- [ ] `npx vitest run src/public-compliance-paths.test.jsx src/proxy.test.js tests/usage-features-coverage.test.js` → PASS → commit `PAGES.1 — studio paths public from the database only`.

---

### Task 26: Deprecate for real: migration 79x

**Files:**
- Create: `supabase/migrations/79x_landing_page_settings_deprecated.sql` (next free number): `revoke all on public.landing_page_settings from anon, authenticated` (if any grant remains), drop its policies, keep the table and data, comment `DEPRECATED (mig 792): unread since PR3 <date>; drop in a later migration after 2026-12-01`.
- Test: `tests/landing-page-settings-readers-guard.test.js` (Task 23) already pins no reader; add `the migration names no reader-visible grant`.
- [ ] Apply through the MCP after PR3 deploys; `get_advisors`. Commit `PAGES.1 — landing_page_settings closed and dated for drop`.

---

### Task 27: PR3 ship and the before/after diff again

- [ ] Run `scripts/diff-public-pages.mjs` for `/stillorgan`, `/hatch-street`, `/stillorgan/events`, `/hatch-street/events`, `/welcome`, `/trial`, `/50plus`, `/corp`: zero text and media differences; `/welcome/stillorgan` 307s to `/stillorgan`.
- [ ] CI mirror; `npm run build`; changelog entry; PR; bind; report. Update the memory note: PAGES.1 shipped, old table dated for drop.

---

## Self-review notes (done while writing)

- Spec §1 tables → Task 3; §2 route → Tasks 6, 8, 21; §3 offer types and the location-only readers → Tasks 2, 7, 9, 23; §4 layouts → Task 6; §5 gates and reserved slugs → Tasks 1, 5, 8, 25; §6 migration and the diff → Tasks 3, 10, 27; §7 editor → Tasks 13–18; §8 permissions → Tasks 4, 13, 19; §9 Meta/attribution → Tasks 7, 24. The chooser non-goal is respected (Task 22 only changes where it reads).
- Names used across tasks: `loadPageBySlug`, `resolvePageStudio({ page, studios, studioLocationId })`, `mergedBlocksFor`, `offerConfigured(blockType, mergedBlock, ctx)`, `OFFER_BLOCK_TYPE`, `STUDIO_OFFER_KEYS`, `splitOfferBlock`, `mergeOfferBlock`, `publicOrgIdForHost` (lives in `public-pages-edge.js`, re-exported by `landing-pages.js`), `listPublicPageSlugs`, `isPublicPagePath`, `resolvePublicPageRequest`, `copySourceForRequest`, `canViewPage`, `canEditPage`, `trialEntryFromRow`.
- Review Focus 1–5 each has a named test (Tasks 4, 1/13, 6, 7, 5).
- Proportion: the plan is roughly twice the spec; code appears only as test assertions and SQL shape, never as bodies.
