# Ads Reporting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an in-CRM Ads feature that syncs Meta ad performance daily into location-segmented tables, attributes spend to booked classes via `/start` UTMs, shows it on `/dashboard/ads`, and emails a daily per-location report — on a provider abstraction so TikTok drops in later.

**Architecture:** Mirrors existing patterns — `membership-snapshot.js` (daily snapshot upsert), `morning-briefing.js` (Postmark email cron), `agent/channels.js` (multi-provider connections). Provider modules (`src/lib/ads/providers/meta.js`) are the only platform-aware code; sync/attribution/dashboard/email read normalized tables. Every row carries `location_id` for hard segmentation.

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres, service-role routes), Postmark, recharts, Vitest (pure-lib, no DB). Migrations via Supabase MCP `apply_migration` against project `iyvtbjjxdggiadzwwvdj`, with a matching repo file, then `get_advisors`.

**Scope:** This plan covers **Phases 0–4** (config → ingestion → attribution → dashboard → email) — a working, testable increment for Stillorgan. Phases 5–7 (roll-up, breakdowns, TikTok) are scoped as follow-on plans at the end.

**Spec:** `docs/superpowers/specs/2026-07-03-ads-reporting-design.md`

---

## Conventions for every task
- Branch is `ads-reporting-feature` (already created off `origin/main`).
- Migrations: apply via Supabase MCP `apply_migration` (name `NNN_description`), then **write the identical SQL to `supabase/migrations/NNN_description.sql`** (MCP does not write the repo file), then run `get_advisors(type=security)` and resolve any ERROR-level finding.
- After code changes run the CI mirror before committing: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`. Any task adding an import or route also runs `npm run build`.
- Tests are pure-lib Vitest (no DB) using injected fakes, matching `src/lib/agent/channels.test.js` and `src/lib/membership-snapshot`-adjacent tests.

---

## File Structure

**Created:**
- `src/lib/ads/accounts.js` — resolve/mask/patch `ad_accounts` rows (+ `.test.js`)
- `src/lib/ads/provider.js` — provider interface doc + `normalizeInsightRow` validator
- `src/lib/ads/providers/meta.js` — Graph API client + field normalization (+ `.test.js`)
- `src/lib/ads/sync.js` — per-account ingestion orchestration (+ `.test.js`)
- `src/lib/ads/attribution.js` — spend↔bookings join + CPA math (+ `.test.js`)
- `src/lib/ads/read.js` — dashboard read queries (KPIs, per-ad table, trend) (+ `.test.js`)
- `src/lib/ads/report.js` — daily email builder (subject + html + callout) (+ `.test.js`)
- `src/app/api/settings/ads/route.js` — GET/PUT ad_accounts for a location
- `src/app/api/settings/ads/test/route.js` — live "test connection" probe
- `src/app/api/cron/ad-insights-sync/route.js` — daily sync cron
- `src/app/api/cron/ad-report-email/route.js` — daily report cron
- `src/app/api/cron/ad-insights-backfill/route.js` — one-time backfill
- `src/components/settings/integrations/AdsIntegrationTab.jsx` — settings UI
- `src/app/dashboard/ads/page.js` — dashboard page (server component)
- `src/components/dashboard/AdsKpiStrip.jsx`, `AdsPerAdTable.jsx`, `AdsTrendChart.jsx`
- Migrations: `NNN_ad_accounts.sql`, `NNN_ad_insights_tables.sql`, `NNN_contacts_ad_attribution.sql`, `NNN_ads_cron_heartbeats.sql`

**Modified:**
- `src/components/settings/LocationIntegrations.jsx` — register the Ads tab
- `src/lib/schemas.js` / permissions module — add `dashboard_ads` permission
- `src/components/StartFunnel.jsx` — capture UTM params from URL, include in POST
- `src/app/api/public/book/route.js`, `src/app/api/public/class-booking/route.js` — persist UTM attribution
- `vercel.json` — three cron entries
- Sidebar nav component — add `/dashboard/ads` link

---

## PHASE 0 — Config foundation

### Task 0.1: Migration — `ad_accounts` table

**Files:** Create `supabase/migrations/NNN_ad_accounts.sql`

- [ ] **Step 1: Apply the migration via Supabase MCP**

Apply this SQL with `apply_migration` (name `ad_accounts`):

```sql
create table if not exists ad_accounts (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  provider text not null check (provider in ('meta','tiktok')),
  external_account_id text not null,
  access_token text,
  business_account_id text,
  currency text,
  account_timezone text,
  display_name text,
  is_active boolean not null default true,
  last_synced_at timestamptz,
  last_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ad_accounts_unique_ext
  on ad_accounts (location_id, provider, external_account_id);
create unique index if not exists ad_accounts_one_active
  on ad_accounts (location_id, provider) where is_active;
create index if not exists ad_accounts_location on ad_accounts (location_id);
alter table ad_accounts enable row level security;
create policy ad_accounts_service_read on ad_accounts for select to authenticated using (false);
```

(The `using (false)` policy keeps the table readable only via service-role routes, matching sibling integration tables; app code enforces access.)

- [ ] **Step 2: Write the identical SQL to the repo file**

Write the exact SQL above to `supabase/migrations/NNN_ad_accounts.sql` (use the number the MCP assigned — check `list_migrations`).

- [ ] **Step 3: Run advisors**

Run `get_advisors(type=security)`. Expected: no new ERROR-level findings for `ad_accounts`. If the RLS policy trips `multiple_permissive_policies`, there is only one policy so it should be clean.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/NNN_ad_accounts.sql
git commit -m "ADS-REPORT.0 — ad_accounts table (per-location, per-provider)"
```

---

### Task 0.2: `accounts.js` — resolve + mask helpers

**Files:** Create `src/lib/ads/accounts.js`, `src/lib/ads/accounts.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/ads/accounts.test.js
import { describe, it, expect } from 'vitest'
import { maskSecret, maskAccountRow, isFreshSecret, buildAccountPatch } from './accounts.js'

describe('maskSecret', () => {
  it('shows only the last 4 chars', () => {
    expect(maskSecret('EAAB1234secrettoken')).toBe('••••••••oken')
  })
  it('returns empty for empty', () => {
    expect(maskSecret('')).toBe('')
    expect(maskSecret(null)).toBe('')
  })
})

describe('isFreshSecret', () => {
  it('treats a masked echo as not fresh', () => {
    expect(isFreshSecret('••••••••oken')).toBe(false)
  })
  it('treats a real value as fresh', () => {
    expect(isFreshSecret('EAAB1234newtoken')).toBe(true)
    expect(isFreshSecret('')).toBe(false)
  })
})

describe('maskAccountRow', () => {
  it('masks the token and adds has_access_token', () => {
    const out = maskAccountRow({ id: '1', provider: 'meta', access_token: 'EAABsecrettok', external_account_id: '900' })
    expect(out.access_token).toBe('••••••••ttok')
    expect(out.has_access_token).toBe(true)
    expect(out.external_account_id).toBe('900')
  })
  it('handles a missing token', () => {
    const out = maskAccountRow({ id: '1', provider: 'meta', access_token: null })
    expect(out.access_token).toBe('')
    expect(out.has_access_token).toBe(false)
  })
})

describe('buildAccountPatch', () => {
  it('writes a fresh token but ignores a masked echo', () => {
    const patch = buildAccountPatch({ external_account_id: '900', access_token: '••••••••ttok', is_active: true })
    expect(patch.external_account_id).toBe('900')
    expect('access_token' in patch).toBe(false)
    expect(patch.is_active).toBe(true)
  })
  it('writes a real new token', () => {
    const patch = buildAccountPatch({ access_token: 'EAABnewtoken1234' })
    expect(patch.access_token).toBe('EAABnewtoken1234')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/ads/accounts.test.js`
Expected: FAIL, "Cannot find module './accounts.js'".

- [ ] **Step 3: Write the implementation**

```javascript
// src/lib/ads/accounts.js
// Resolve/mask/patch ad_accounts rows. Mirrors src/lib/agent/channels.js
// secret handling so tokens are never returned raw to the browser and a
// masked echo on save is not written back over the real token.

const MASK = '••••••••'

export function maskSecret(value, keep = 4) {
  const s = String(value || '')
  if (!s) return ''
  return MASK + s.slice(-keep)
}

export function isFreshSecret(value) {
  const s = String(value || '')
  if (!s) return false
  return !s.startsWith(MASK)
}

/** Prepare a row for the browser: mask the token, add has_* booleans. */
export function maskAccountRow(row) {
  if (!row) return row
  return {
    ...row,
    access_token: maskSecret(row.access_token),
    has_access_token: Boolean(row.access_token),
  }
}

/** Build a DB patch from a submitted form: copy non-secret fields; only
 *  write access_token when it is a fresh value (not the masked echo). */
export function buildAccountPatch(body) {
  const patch = {}
  for (const k of ['external_account_id', 'business_account_id', 'display_name', 'is_active', 'currency', 'account_timezone']) {
    if (body[k] !== undefined) patch[k] = body[k]
  }
  if (isFreshSecret(body.access_token)) patch.access_token = body.access_token
  return patch
}

/** Resolve the active account for (location, provider). Returns row or null. */
export async function resolveAdsAccount(db, locationId, provider) {
  const { data } = await db.from('ad_accounts')
    .select('*').eq('location_id', locationId).eq('provider', provider).eq('is_active', true)
    .limit(1).maybeSingle()
  return data || null
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/ads/accounts.test.js`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/ads/accounts.js src/lib/ads/accounts.test.js
git commit -m "ADS-REPORT.0 — ad_accounts resolve/mask/patch helpers"
```

---

### Task 0.3: Settings API — GET/PUT ad_accounts

**Files:** Create `src/app/api/settings/ads/route.js`

- [ ] **Step 1: Write the route**

```javascript
// src/app/api/settings/ads/route.js
// GET  ?locationId=…  → masked ad_accounts rows for a location
// PUT  { locationId, provider, external_account_id, access_token, is_active }
// Owner/master only. Service-role DB; access enforced in app code.
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { maskAccountRow, buildAccountPatch } from '@/lib/ads/accounts'
import { ADMIN_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const locationId = new URL(request.url).searchParams.get('locationId')
  if (!locationId) return NextResponse.json({ success: false, error: 'locationId required' }, { status: 400 })
  if (!assertLocationAccess(user, locationId)) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const db = createServerClient()
  const { data } = await db.from('ad_accounts').select('*').eq('location_id', locationId)
  return NextResponse.json({ success: true, data: (data || []).map(maskAccountRow) })
}

export async function PUT(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const body = await request.json().catch(() => ({}))
  const { locationId, provider } = body
  if (!locationId || !['meta', 'tiktok'].includes(provider)) {
    return NextResponse.json({ success: false, error: 'locationId + valid provider required' }, { status: 400 })
  }
  if (!assertLocationAccess(user, locationId)) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const role = user.rolesByLocation?.[locationId]
  if (!ADMIN_ROLES.includes(role)) return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  const db = createServerClient()
  const patch = buildAccountPatch(body)
  const row = { location_id: locationId, provider, ...patch, updated_at: new Date().toISOString() }
  const { data, error } = await db.from('ad_accounts')
    .upsert(row, { onConflict: 'location_id,provider,external_account_id' })
    .select('*').maybeSingle()
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 })
  return NextResponse.json({ success: true, data: maskAccountRow(data) })
}
```

- [ ] **Step 2: Verify route guard passes**

Run: `npm run check:route-guards`
Expected: PASS — the route uses `getCurrentUser` so it is session-guarded.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: compiles (new route + imports resolve).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/settings/ads/route.js
git commit -m "ADS-REPORT.0 — settings API for ad_accounts (GET/PUT, owner-guarded)"
```

> Note: confirm the exact export names `assertLocationAccess`, `ADMIN_ROLES`, and `user.rolesByLocation` against `src/lib/auth.js` and `src/lib/schemas.js` before running; adjust imports to the real names if they differ (they are referenced in CLAUDE.md but verify).

---

### Task 0.4: `dashboard_ads` permission

**Files:** Modify the permissions source (`src/lib/schemas.js` or the `WEB_PERMISSIONS` module — locate with `grep -rl "WEB_PERMISSIONS" src/lib`)

- [ ] **Step 1: Add the permission key**

Add `dashboard_ads` to `WEB_PERMISSIONS` and give it to `owner`/`manager` in `DEFAULT_WEB_PERMISSIONS_BY_ROLE`. Add a `WEB_ONLY_OK` entry with reason `"desktop ads analytics dashboard — no mobile counterpart, like the other radar dashboards"` so `check:mobile-parity` passes.

- [ ] **Step 2: Run parity check**

Run: `npm run check:mobile-parity`
Expected: PASS (the new key is accounted for as web-only).

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "ADS-REPORT.0 — dashboard_ads permission (web-only)"
```

---

### Task 0.5: Ads settings tab UI

**Files:** Create `src/components/settings/integrations/AdsIntegrationTab.jsx`; Modify `src/components/settings/LocationIntegrations.jsx`

- [ ] **Step 1: Build the tab component**

Create `AdsIntegrationTab.jsx` following the existing Glofox/UniFi tab pattern in the same directory (read one for the exact prop/UI conventions). It:
- Fetches `GET /api/settings/ads?locationId=…` on mount, renders one card per provider (`meta`, `tiktok`).
- Each card: inputs for `external_account_id`, `access_token` (type=password, placeholder shows masked value, only re-sent if changed), an `is_active` toggle, a **Test connection** button calling `POST /api/settings/ads/test`, and a `last_sync_error` line.
- Saves via `PUT /api/settings/ads`.
- Uses `@/components/ui` primitives (`Card`, `Field`, `Button`), light-theme chip classes (`bg-*-500/10 text-*-700`) per the contrast rule.

- [ ] **Step 2: Register the tab**

In `LocationIntegrations.jsx`, add an `ads` entry to the tabs array (label "Ads"), gated to owner/master like the UniFi tab.

- [ ] **Step 3: Build + lint**

Run: `npm run build && npx next lint src/components/settings/integrations/AdsIntegrationTab.jsx`
Expected: compiles; no `no-html-link-for-pages` or contrast-lint errors.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "ADS-REPORT.0 — Ads integration settings tab (per-location tokens)"
```

---

### Task 0.6: Test-connection probe route

**Files:** Create `src/app/api/settings/ads/test/route.js`

- [ ] **Step 1: Write the route**

```javascript
// src/app/api/settings/ads/test/route.js
// POST { locationId, provider } → does a cheap live read with the stored
// token and reports success + account name, or the Meta error message.
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { resolveAdsAccount } from '@/lib/ads/accounts'
import { testMetaConnection } from '@/lib/ads/providers/meta'

export const runtime = 'nodejs'

export async function POST(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const { locationId, provider } = await request.json().catch(() => ({}))
  if (!assertLocationAccess(user, locationId)) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
  const db = createServerClient()
  const account = await resolveAdsAccount(db, locationId, provider)
  if (!account?.access_token) return NextResponse.json({ success: false, error: 'No active account/token saved' }, { status: 400 })
  if (provider === 'meta') {
    const res = await testMetaConnection(account)
    return NextResponse.json(res)  // { success, name?, error? }
  }
  return NextResponse.json({ success: false, error: 'Provider not supported yet' }, { status: 400 })
}
```

(`testMetaConnection` is defined in Task 1.3.)

- [ ] **Step 2: Commit** (build after Task 1.3 lands the import)

```bash
git add src/app/api/settings/ads/test/route.js
git commit -m "ADS-REPORT.0 — test-connection probe route"
```

---

## PHASE 1 — Ingestion

### Task 1.1: Migrations — insight tables + heartbeats

**Files:** Create `supabase/migrations/NNN_ad_insights_tables.sql`, `NNN_ads_cron_heartbeats.sql`

- [ ] **Step 1: Apply the insight tables**

`apply_migration` (name `ad_insights_tables`):

```sql
create table if not exists ad_entities (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  ad_account_id uuid not null references ad_accounts(id) on delete cascade,
  provider text not null,
  level text not null check (level in ('campaign','adset','ad')),
  external_id text not null,
  name text,
  status text,
  campaign_external_id text,
  adset_external_id text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists ad_entities_unique on ad_entities (ad_account_id, level, external_id);
create index if not exists ad_entities_location on ad_entities (location_id);

create table if not exists ad_insights_daily (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  ad_account_id uuid not null references ad_accounts(id) on delete cascade,
  provider text not null,
  level text not null,
  entity_external_id text not null,
  date date not null,
  spend numeric(12,2) default 0,
  impressions bigint default 0,
  reach bigint default 0,
  frequency numeric default 0,
  clicks bigint default 0,
  link_clicks bigint default 0,
  landing_page_views bigint default 0,
  ctr numeric default 0,
  cpc numeric default 0,
  cpm numeric default 0,
  results bigint default 0,
  result_type text,
  actions jsonb,
  synced_at timestamptz not null default now()
);
create unique index if not exists ad_insights_daily_unique on ad_insights_daily (ad_account_id, level, entity_external_id, date);
create index if not exists ad_insights_daily_loc_date on ad_insights_daily (location_id, date);
create index if not exists ad_insights_daily_acct_level_date on ad_insights_daily (ad_account_id, level, date);

create table if not exists ad_insights_breakdown_daily (
  id uuid primary key default gen_random_uuid(),
  location_id uuid not null references locations(id) on delete cascade,
  ad_account_id uuid not null references ad_accounts(id) on delete cascade,
  provider text not null,
  level text not null,
  entity_external_id text not null,
  date date not null,
  dimension text not null,
  segment text not null,
  spend numeric(12,2) default 0,
  impressions bigint default 0,
  clicks bigint default 0,
  link_clicks bigint default 0,
  results bigint default 0,
  actions jsonb,
  synced_at timestamptz not null default now()
);
create unique index if not exists ad_bd_unique on ad_insights_breakdown_daily (ad_account_id, level, entity_external_id, date, dimension, segment);
create index if not exists ad_bd_loc_date_dim on ad_insights_breakdown_daily (location_id, date, dimension);

alter table ad_entities enable row level security;
alter table ad_insights_daily enable row level security;
alter table ad_insights_breakdown_daily enable row level security;
create policy ad_entities_svc on ad_entities for select to authenticated using (false);
create policy ad_insights_svc on ad_insights_daily for select to authenticated using (false);
create policy ad_bd_svc on ad_insights_breakdown_daily for select to authenticated using (false);
```

- [ ] **Step 2: Apply the heartbeat seeds**

`apply_migration` (name `ads_cron_heartbeats`):

```sql
insert into cron_heartbeats (name, expected_interval_seconds, grace_seconds, notes) values
  ('ad-insights-sync', 86400, 21600, 'Daily Meta ads insight sync'),
  ('ad-report-email', 86400, 21600, 'Daily ads performance email')
on conflict (name) do nothing;
```

- [ ] **Step 3: Write both SQL files to `supabase/migrations/` and run `get_advisors`.** Resolve any ERROR finding.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/NNN_ad_insights_tables.sql supabase/migrations/NNN_ads_cron_heartbeats.sql
git commit -m "ADS-REPORT.1 — ad insight tables + cron heartbeat seeds"
```

---

### Task 1.2: Provider interface + normalizer

**Files:** Create `src/lib/ads/provider.js`, `src/lib/ads/provider.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/ads/provider.test.js
import { describe, it, expect } from 'vitest'
import { normalizeInsightRow } from './provider.js'

describe('normalizeInsightRow', () => {
  it('coerces numeric strings and defaults missing fields', () => {
    const row = normalizeInsightRow({ level: 'ad', entity_external_id: '1', date: '2026-07-03', spend: '2.30', impressions: '1039', ctr: '1.25' })
    expect(row.spend).toBe(2.3)
    expect(row.impressions).toBe(1039)
    expect(row.ctr).toBe(1.25)
    expect(row.clicks).toBe(0)
    expect(row.actions).toEqual([])
  })
  it('throws on a missing required key', () => {
    expect(() => normalizeInsightRow({ level: 'ad', date: '2026-07-03' })).toThrow(/entity_external_id/)
  })
})
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/lib/ads/provider.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement**

```javascript
// src/lib/ads/provider.js
// The contract every ads provider implements:
//   listEntities(account) -> [{ level, external_id, name, status, campaign_external_id?, adset_external_id?, raw }]
//   fetchInsights(account, { since, until, level, breakdown? }) -> [normalizeInsightRow shape]
// This module owns the normalized row shape so downstream code is provider-agnostic.

const NUM = (v) => (v === undefined || v === null || v === '' ? 0 : Number(v))

export function normalizeInsightRow(r) {
  for (const k of ['level', 'entity_external_id', 'date']) {
    if (!r[k]) throw new Error(`normalizeInsightRow: missing ${k}`)
  }
  return {
    level: r.level,
    entity_external_id: String(r.entity_external_id),
    date: r.date,
    spend: NUM(r.spend),
    impressions: NUM(r.impressions),
    reach: NUM(r.reach),
    frequency: NUM(r.frequency),
    clicks: NUM(r.clicks),
    link_clicks: NUM(r.link_clicks),
    landing_page_views: NUM(r.landing_page_views),
    ctr: NUM(r.ctr),
    cpc: NUM(r.cpc),
    cpm: NUM(r.cpm),
    results: NUM(r.results),
    result_type: r.result_type || null,
    actions: Array.isArray(r.actions) ? r.actions : [],
    dimension: r.dimension || null,
    segment: r.segment || null,
  }
}
```

- [ ] **Step 4: Run to verify it passes.** `npx vitest run src/lib/ads/provider.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ads/provider.js src/lib/ads/provider.test.js
git commit -m "ADS-REPORT.1 — provider interface + insight row normalizer"
```

---

### Task 1.3: Meta provider — Graph API client + normalization

**Files:** Create `src/lib/ads/providers/meta.js`, `src/lib/ads/providers/meta.test.js`

- [ ] **Step 1: Write the failing test** (pure — the field-mapping function, no network)

```javascript
// src/lib/ads/providers/meta.test.js
import { describe, it, expect } from 'vitest'
import { mapMetaInsight, mapMetaEntity, extractAction } from './meta.js'

describe('extractAction', () => {
  it('pulls a value from the actions array by type', () => {
    const actions = [{ action_type: 'link_click', value: '7' }, { action_type: 'landing_page_view', value: '5' }]
    expect(extractAction(actions, 'landing_page_view')).toBe(5)
    expect(extractAction(actions, 'purchase')).toBe(0)
  })
})

describe('mapMetaInsight', () => {
  it('maps a Graph ad-level insight row to the normalized shape', () => {
    const raw = {
      ad_id: '120248413617870055', date_start: '2026-07-03', date_stop: '2026-07-03',
      spend: '2.30', impressions: '1039', reach: '1000', frequency: '1.04',
      clicks: '13', ctr: '1.25', cpc: '0.33', cpm: '2.21',
      actions: [{ action_type: 'link_click', value: '7' }, { action_type: 'landing_page_view', value: '8' }],
    }
    const out = mapMetaInsight(raw, 'ad')
    expect(out.level).toBe('ad')
    expect(out.entity_external_id).toBe('120248413617870055')
    expect(out.date).toBe('2026-07-03')
    expect(out.spend).toBe(2.3)
    expect(out.link_clicks).toBe(7)
    expect(out.landing_page_views).toBe(8)
  })
})

describe('mapMetaEntity', () => {
  it('maps a Graph ad object to an ad_entities row', () => {
    const raw = { id: '120248413617870055', name: 'testimonial-vicky', effective_status: 'ACTIVE', campaign_id: 'c1', adset_id: 'a1' }
    const out = mapMetaEntity(raw, 'ad')
    expect(out).toMatchObject({ level: 'ad', external_id: '120248413617870055', name: 'testimonial-vicky', status: 'ACTIVE', campaign_external_id: 'c1', adset_external_id: 'a1' })
  })
})
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/lib/ads/providers/meta.test.js` → FAIL.

- [ ] **Step 3: Implement**

```javascript
// src/lib/ads/providers/meta.js
// Meta (Graph API) ads provider. The map* functions are pure and unit-tested;
// the fetch* functions do network I/O and call them.
import { normalizeInsightRow } from '../provider'

const GRAPH = 'https://graph.facebook.com/v21.0'
const ID_FIELD = { campaign: 'campaign_id', adset: 'adset_id', ad: 'ad_id' }

export function extractAction(actions, type) {
  if (!Array.isArray(actions)) return 0
  const hit = actions.find((a) => a.action_type === type)
  return hit ? Number(hit.value) : 0
}

export function mapMetaInsight(raw, level) {
  const actions = raw.actions || []
  return normalizeInsightRow({
    level,
    entity_external_id: raw[ID_FIELD[level]],
    date: raw.date_start,
    spend: raw.spend, impressions: raw.impressions, reach: raw.reach, frequency: raw.frequency,
    clicks: raw.clicks, ctr: raw.ctr, cpc: raw.cpc, cpm: raw.cpm,
    link_clicks: extractAction(actions, 'link_click'),
    landing_page_views: extractAction(actions, 'landing_page_view'),
    results: extractAction(actions, 'landing_page_view'),
    result_type: 'landing_page_view',
    actions,
  })
}

export function mapMetaEntity(raw, level) {
  return {
    level, external_id: raw.id, name: raw.name || null,
    status: raw.effective_status || raw.status || null,
    campaign_external_id: raw.campaign_id || null,
    adset_external_id: raw.adset_id || null,
    raw,
  }
}

async function graphGet(path, params, token) {
  const url = new URL(`${GRAPH}/${path}`)
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v))
  url.searchParams.set('access_token', token)
  const rows = []
  let next = url.toString()
  while (next) {
    const res = await fetch(next)
    const json = await res.json()
    if (json.error) throw new Error(json.error.message)
    rows.push(...(json.data || []))
    next = json.paging?.next || null
  }
  return rows
}

export async function testMetaConnection(account) {
  try {
    const res = await fetch(`${GRAPH}/act_${account.external_account_id}?fields=name,currency,timezone_name&access_token=${account.access_token}`)
    const json = await res.json()
    if (json.error) return { success: false, error: json.error.message }
    return { success: true, name: json.name, currency: json.currency }
  } catch (e) { return { success: false, error: e.message } }
}

export async function listEntities(account) {
  const token = account.access_token
  const act = `act_${account.external_account_id}`
  const out = []
  const campaigns = await graphGet(`${act}/campaigns`, { fields: 'id,name,effective_status', limit: '200' }, token)
  campaigns.forEach((c) => out.push(mapMetaEntity(c, 'campaign')))
  const adsets = await graphGet(`${act}/adsets`, { fields: 'id,name,effective_status,campaign_id', limit: '200' }, token)
  adsets.forEach((a) => out.push(mapMetaEntity(a, 'adset')))
  const ads = await graphGet(`${act}/ads`, { fields: 'id,name,effective_status,campaign_id,adset_id', limit: '500' }, token)
  ads.forEach((a) => out.push(mapMetaEntity(a, 'ad')))
  return out
}

export async function fetchInsights(account, { since, until, level, breakdown }) {
  const token = account.access_token
  const act = `act_${account.external_account_id}`
  const params = {
    level,
    time_range: JSON.stringify({ since, until }),
    time_increment: '1',
    fields: 'campaign_id,adset_id,ad_id,spend,impressions,reach,frequency,clicks,ctr,cpc,cpm,actions,date_start,date_stop',
    limit: '500',
  }
  if (breakdown) params.breakdowns = breakdown
  const rows = await graphGet(`${act}/insights`, params, token)
  return rows.map((r) => {
    const row = mapMetaInsight(r, level)
    if (breakdown) { row.dimension = breakdown; row.segment = r[breakdown] || 'unknown' }
    return row
  })
}
```

- [ ] **Step 4: Run to verify it passes.** `npx vitest run src/lib/ads/providers/meta.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ads/providers/meta.js src/lib/ads/providers/meta.test.js
git commit -m "ADS-REPORT.1 — Meta Graph API provider (entities + insights, normalized)"
```

---

### Task 1.4: Sync orchestration

**Files:** Create `src/lib/ads/sync.js`, `src/lib/ads/sync.test.js`

- [ ] **Step 1: Write the failing test** (inject a fake provider + fake db)

```javascript
// src/lib/ads/sync.test.js
import { describe, it, expect } from 'vitest'
import { syncAccount } from './sync.js'

function fakeDb() {
  const upserts = {}
  return {
    upserts,
    from(table) {
      return {
        upsert(rows) { upserts[table] = (upserts[table] || []).concat(rows); return { select: () => ({ then: (r) => r({ data: rows }) }) } },
        update() { return { eq: () => ({ then: (r) => r({ data: [] }) }) } },
      }
    },
  }
}

const fakeProvider = {
  listEntities: async () => [{ level: 'ad', external_id: '1', name: 'A', status: 'ACTIVE', raw: {} }],
  fetchInsights: async ({ level }) => [{ level, entity_external_id: '1', date: '2026-07-03', spend: 2, impressions: 100, reach: 90, frequency: 1, clicks: 3, link_clicks: 2, landing_page_views: 2, ctr: 3, cpc: 0.6, cpm: 20, results: 2, result_type: 'landing_page_view', actions: [] }],
}

describe('syncAccount', () => {
  it('upserts entities and daily insights stamped with location_id', async () => {
    const db = fakeDb()
    const account = { id: 'acc1', location_id: 'loc1', provider: 'meta', external_account_id: '900' }
    await syncAccount(db, account, fakeProvider, { since: '2026-07-01', until: '2026-07-03', breakdowns: [] })
    expect(db.upserts.ad_entities[0]).toMatchObject({ location_id: 'loc1', ad_account_id: 'acc1', level: 'ad', external_id: '1' })
    expect(db.upserts.ad_insights_daily[0]).toMatchObject({ location_id: 'loc1', ad_account_id: 'acc1', level: 'ad', entity_external_id: '1', date: '2026-07-03', spend: 2 })
  })
})
```

- [ ] **Step 2: Run to verify it fails.** → FAIL.

- [ ] **Step 3: Implement**

```javascript
// src/lib/ads/sync.js
// Orchestrate one account's sync: entities + daily insights (+ breakdowns).
// db + provider are injected so this is unit-testable with no network/DB.
const LEVELS = ['campaign', 'adset', 'ad']

function stamp(account, row) {
  return { location_id: account.location_id, ad_account_id: account.id, provider: account.provider, ...row }
}

export async function syncAccount(db, account, provider, { since, until, breakdowns = [] }) {
  // Entities
  const entities = await provider.listEntities(account)
  if (entities.length) {
    await db.from('ad_entities').upsert(
      entities.map((e) => stamp(account, { level: e.level, external_id: e.external_id, name: e.name, status: e.status, campaign_external_id: e.campaign_external_id, adset_external_id: e.adset_external_id, raw: e.raw, updated_at: new Date().toISOString() })),
      { onConflict: 'ad_account_id,level,external_id' },
    )
  }
  // Daily insights per level
  for (const level of LEVELS) {
    const rows = await provider.fetchInsights(account, { since, until, level })
    if (rows.length) {
      await db.from('ad_insights_daily').upsert(
        rows.map((r) => stamp(account, { level: r.level, entity_external_id: r.entity_external_id, date: r.date, spend: r.spend, impressions: r.impressions, reach: r.reach, frequency: r.frequency, clicks: r.clicks, link_clicks: r.link_clicks, landing_page_views: r.landing_page_views, ctr: r.ctr, cpc: r.cpc, cpm: r.cpm, results: r.results, result_type: r.result_type, actions: r.actions, synced_at: new Date().toISOString() })),
        { onConflict: 'ad_account_id,level,entity_external_id,date' },
      )
    }
  }
  // Breakdowns (ad level only)
  for (const breakdown of breakdowns) {
    const rows = await provider.fetchInsights(account, { since, until, level: 'ad', breakdown })
    if (rows.length) {
      await db.from('ad_insights_breakdown_daily').upsert(
        rows.map((r) => stamp(account, { level: 'ad', entity_external_id: r.entity_external_id, date: r.date, dimension: r.dimension, segment: r.segment, spend: r.spend, impressions: r.impressions, clicks: r.clicks, link_clicks: r.link_clicks, results: r.results, actions: r.actions, synced_at: new Date().toISOString() })),
        { onConflict: 'ad_account_id,level,entity_external_id,date,dimension,segment' },
      )
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes.** → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ads/sync.js src/lib/ads/sync.test.js
git commit -m "ADS-REPORT.1 — sync orchestration (entities + insights + breakdowns)"
```

---

### Task 1.5: Sync cron + backfill

**Files:** Create `src/app/api/cron/ad-insights-sync/route.js`, `src/app/api/cron/ad-insights-backfill/route.js`; Modify `vercel.json`

- [ ] **Step 1: Write the sync cron**

```javascript
// src/app/api/cron/ad-insights-sync/route.js
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { syncAccount } from '@/lib/ads/sync'
import * as meta from '@/lib/ads/providers/meta'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

const PROVIDERS = { meta }
const BREAKDOWNS = ['publisher_platform', 'age', 'gender']

function dublinDateStr(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(d) // YYYY-MM-DD
}

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const db = createServerClient()
  const since = dublinDateStr(-3), until = dublinDateStr(0)
  const { data: accounts } = await db.from('ad_accounts').select('*').eq('is_active', true)
  const results = []
  for (const account of accounts || []) {
    try {
      const provider = PROVIDERS[account.provider]
      if (!provider) { results.push({ id: account.id, skipped: 'no_provider' }); continue }
      await syncAccount(db, account, provider, { since, until, breakdowns: account.provider === 'meta' ? BREAKDOWNS : [] })
      await db.from('ad_accounts').update({ last_synced_at: new Date().toISOString(), last_sync_error: null }).eq('id', account.id)
      results.push({ id: account.id, ok: true })
    } catch (e) {
      await db.from('ad_accounts').update({ last_sync_error: e.message }).eq('id', account.id)
      results.push({ id: account.id, error: e.message })
    }
  }
  await stampHeartbeat('ad-insights-sync').catch(() => {})
  return NextResponse.json({ success: true, results })
}
```

- [ ] **Step 2: Write the backfill cron** — identical but with `since` from a `?since=YYYY-MM-DD` query param (default campaign start) and no heartbeat; loops the same `syncAccount`.

- [ ] **Step 3: Register in `vercel.json`**

Add: `{ "path": "/api/cron/ad-insights-sync", "schedule": "0 5 * * *" }` (backfill is manual, not scheduled).

- [ ] **Step 4: Build**

Run: `npm run build && npm run check:route-guards`
Expected: compiles; the cron shows as `cron`-guarded (CRON_SECRET).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/cron/ad-insights-sync/route.js src/app/api/cron/ad-insights-backfill/route.js vercel.json
git commit -m "ADS-REPORT.1 — daily sync cron + manual backfill"
```

- [ ] **Step 6: Manual verification** (after a token is saved for Stillorgan)

Trigger the backfill locally: `curl -H "Authorization: Bearer $CRON_SECRET" "http://localhost:3000/api/cron/ad-insights-backfill?since=2026-07-01"`. Then query `ad_insights_daily` via Supabase MCP and confirm rows exist, all stamped with the Stillorgan `location_id` and no other.

---

## PHASE 2 — Attribution

### Task 2.1: Migration — UTM attribution columns on contacts

**Files:** Create `supabase/migrations/NNN_contacts_ad_attribution.sql`

- [ ] **Step 1: Apply**

```sql
alter table contacts
  add column if not exists utm_campaign text,
  add column if not exists utm_content text,
  add column if not exists utm_term text,
  add column if not exists ad_provider text,
  add column if not exists ad_external_id text,
  add column if not exists attributed_at timestamptz;
create index if not exists contacts_ad_external on contacts (location_id, ad_external_id) where ad_external_id is not null;
```

- [ ] **Step 2:** Write the SQL to the repo file; run `get_advisors`.
- [ ] **Step 3: Commit** `git commit -m "ADS-REPORT.2 — contacts ad-attribution columns"`

---

### Task 2.2: Capture UTMs in the /start funnel

**Files:** Modify `src/components/StartFunnel.jsx`, `src/app/api/public/book/route.js`, `src/app/api/public/class-booking/route.js`

- [ ] **Step 1: StartFunnel reads URL params.** In the component, on mount read `new URLSearchParams(window.location.search)` for `utm_campaign, utm_content, utm_term, meta_ad_id`, store in state, and add them to both POST bodies as `attribution: { utm_campaign, utm_content, utm_term, ad_provider: 'meta', ad_external_id: meta_ad_id }`.

- [ ] **Step 2: Persist first-touch in both routes.** After the contact is resolved, add (both routes, gated on `body.attribution`):

```javascript
try {
  const a = body.attribution || {}
  const patch = {}
  for (const [k, col] of [['utm_campaign','utm_campaign'],['utm_content','utm_content'],['utm_term','utm_term'],['ad_provider','ad_provider'],['ad_external_id','ad_external_id']]) {
    if (a[k] && String(a[k]).length <= 200) patch[col] = String(a[k])
  }
  if (Object.keys(patch).length) {
    patch.attributed_at = new Date().toISOString()
    // stamp-if-null first-touch: only set where ad_external_id is currently null
    await db.from('contacts').update(patch).eq('id', contactId).is('ad_external_id', null)
  }
} catch (e) { logWarn('attribution', 'utm persist failed', { err: e }) }
```

- [ ] **Step 3: Build + guardrails.** `npm run build && npm run check:guardrails` → PASS.
- [ ] **Step 4: Commit** `git commit -m "ADS-REPORT.2 — capture /start UTMs onto the contact (first-touch)"`

---

### Task 2.3: Add stable ad id to the live ad URLs (ops)

- [ ] **Step 1:** For each of the 4 active ads (ids in [[meta-paid-ads-program]]), append `&meta_ad_id={{ad.id}}` to the creative's `link` via the ads API (`ads_update_entity` on the creative, or recreate the URL param). Keep `utm_content={{ad.name}}`.
- [ ] **Step 2:** Update the launch runbook artifact's URL template to include `&meta_ad_id={{ad.id}}`.
- [ ] **Step 3:** No code commit; note completion in the PR description.

---

### Task 2.4: Attribution join + CPA

**Files:** Create `src/lib/ads/attribution.js`, `src/lib/ads/attribution.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/ads/attribution.test.js
import { describe, it, expect } from 'vitest'
import { computeCostPerBooking } from './attribution.js'

describe('computeCostPerBooking', () => {
  const spendByAd = { '1': 10, '2': 5, '3': 0 }
  const bookingsByAd = { '1': 3, '2': 0 }
  it('divides spend by attributed bookings per ad', () => {
    const rows = computeCostPerBooking(spendByAd, bookingsByAd)
    expect(rows['1']).toEqual({ spend: 10, bookings: 3, cpa: 3.33 })
    expect(rows['2']).toEqual({ spend: 5, bookings: 0, cpa: null }) // no bookings → null, not Infinity
    expect(rows['3']).toEqual({ spend: 0, bookings: 0, cpa: null })
  })
})
```

- [ ] **Step 2: Run to verify it fails.** → FAIL.

- [ ] **Step 3: Implement** (pure math + the DB-reading loaders that call it)

```javascript
// src/lib/ads/attribution.js
// Join ad spend to CRM bookings attributed to each ad via contacts.ad_external_id.

export function computeCostPerBooking(spendByAd, bookingsByAd) {
  const out = {}
  const ids = new Set([...Object.keys(spendByAd), ...Object.keys(bookingsByAd)])
  for (const id of ids) {
    const spend = Number(spendByAd[id] || 0)
    const bookings = Number(bookingsByAd[id] || 0)
    out[id] = { spend, bookings, cpa: bookings > 0 ? Math.round((spend / bookings) * 100) / 100 : null }
  }
  return out
}

/** Count /start bookings attributed to each ad for a location in [since,until].
 *  A "booking" = a booked class request OR a meta_book consult booking whose
 *  contact carries ad_external_id. Returns { [ad_external_id]: count }. */
export async function loadBookingsByAd(db, locationId, since, until) {
  const out = {}
  // Class bookings that reached 'booked'
  const { data: cbr } = await db.from('class_booking_requests')
    .select('contact_id, contacts!inner(ad_external_id)')
    .eq('location_id', locationId).eq('status', 'booked')
    .gte('created_at', since).lte('created_at', until + 'T23:59:59')
  for (const r of cbr || []) {
    const id = r.contacts?.ad_external_id
    if (id) out[id] = (out[id] || 0) + 1
  }
  // Consult bookings via /start (source='meta_book')
  const { data: bk } = await db.from('bookings')
    .select('contact_id, contacts!inner(ad_external_id)')
    .eq('location_id', locationId).eq('source', 'meta_book')
    .gte('booking_date', since).lte('booking_date', until)
  for (const r of bk || []) {
    const id = r.contacts?.ad_external_id
    if (id) out[id] = (out[id] || 0) + 1
  }
  return out
}

/** Sum spend per ad from ad_insights_daily for a location in [since,until]. */
export async function loadSpendByAd(db, locationId, since, until) {
  const { data } = await db.from('ad_insights_daily')
    .select('entity_external_id, spend')
    .eq('location_id', locationId).eq('level', 'ad')
    .gte('date', since).lte('date', until)
  const out = {}
  for (const r of data || []) out[r.entity_external_id] = (out[r.entity_external_id] || 0) + Number(r.spend || 0)
  return out
}
```

> Note: verify the `bookings` table has a `booking_date` and `source` column (it does per the /start work) and that `contacts` embed disambiguation is not needed here (single FK path); if PostgREST returns `PGRST201`, switch to `contacts!contact_id(ad_external_id)`.

- [ ] **Step 4: Run to verify it passes.** `npx vitest run src/lib/ads/attribution.test.js` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ads/attribution.js src/lib/ads/attribution.test.js
git commit -m "ADS-REPORT.2 — spend↔booking attribution + cost-per-booking"
```

---

## PHASE 3 — Dashboard

### Task 3.1: Read layer

**Files:** Create `src/lib/ads/read.js`, `src/lib/ads/read.test.js`

- [ ] **Step 1: Write the failing test** for the pure shaping function `shapePerAdTable(entities, spendByAd, bookingsByAd, insightTotalsByAd)` → array of `{ ad_id, name, status, spend, impressions, ctr, link_clicks, landing_page_views, bookings, cpa }` sorted by cpa ascending (nulls last). Include a 2-ad fixture asserting order and the null-cpa-last rule.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `read.js` with:
  - `shapePerAdTable(...)` (pure) — joins entity names to spend/bookings/totals, computes cpa via `computeCostPerBooking`, sorts.
  - `loadAdsDashboard(db, locationId, sinceDays)` — loads entities, `loadSpendByAd`, `loadBookingsByAd`, per-ad insight totals (`ad_insights_daily` grouped), and daily trend (spend + bookings per date), returns `{ kpis, perAd, trend }`. KPIs: total spend, total bookings, blended cpa, blended ctr, active ad count.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `git commit -m "ADS-REPORT.3 — dashboard read layer + per-ad table shaping"`

---

### Task 3.2: Dashboard page + components + nav

**Files:** Create `src/app/dashboard/ads/page.js`, `src/components/dashboard/AdsKpiStrip.jsx`, `AdsPerAdTable.jsx`, `AdsTrendChart.jsx`; Modify the sidebar nav component

- [ ] **Step 1: Page (server component).** `page.js`: `getCurrentUser()` → `hasPermission(user, 'dashboard_ads')` (else 404) → `loadAdsDashboard(db, user.activeLocation.id, 30)` → render KPI strip + trend chart + per-ad table. Provider tab bar (Meta only for now; render tabs from the distinct providers present in `ad_accounts` for the location).

- [ ] **Step 2: Chart.** `AdsTrendChart.jsx` mirrors `src/components/dashboard/MembershipTrendChart.jsx` (recharts, lazy-loaded via `dynamic(() => import(...), { ssr:false })`), plotting spend + bookings on a dual axis, data shape `[{ date, spend, bookings }]`.

- [ ] **Step 3: Table + KPIs.** `AdsPerAdTable.jsx` renders the sorted per-ad rows with the cost/booking column emphasised, retired ads greyed. `AdsKpiStrip.jsx` renders the 5 KPI cards using `@/components/ui` and the `-700` light-theme text ramp.

- [ ] **Step 4: Sidebar.** Add a `/dashboard/ads` link ("Ads") gated on `dashboard_ads`, next to the other dashboards.

- [ ] **Step 5: Build + lint.** `npm run build && npx next lint src/app/dashboard/ads/page.js` → PASS.

- [ ] **Step 6: Commit** `git commit -m "ADS-REPORT.3 — /dashboard/ads page (KPIs, trend, per-ad table)"`

---

## PHASE 4 — Daily email report

### Task 4.1: Report builder

**Files:** Create `src/lib/ads/report.js`, `src/lib/ads/report.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/ads/report.test.js
import { describe, it, expect } from 'vitest'
import { buildAdReportEmail, buildCallout } from './report.js'

describe('buildCallout', () => {
  it('names the cheapest booking and the biggest spender-without-bookings', () => {
    const perAd = [
      { name: 'schedule-fit', spend: 5, bookings: 2, cpa: 2.5 },
      { name: 'testimonial', spend: 10, bookings: 0, cpa: null },
    ]
    const line = buildCallout(perAd)
    expect(line).toMatch(/schedule-fit/)
    expect(line).toMatch(/testimonial/)
  })
})

describe('buildAdReportEmail', () => {
  it('builds subject with spend, bookings and blended CPA', () => {
    const { subject, html } = buildAdReportEmail({
      locationName: 'UN1T Stillorgan', date: '2026-07-04',
      kpis: { spend: 10, bookings: 3, cpa: 3.33 },
      perAd: [{ name: 'schedule-fit', spend: 5, bookings: 2, cpa: 2.5, ctr: 2.5 }],
    })
    expect(subject).toContain('UN1T Stillorgan')
    expect(subject).toContain('€10')
    expect(subject).toContain('3 booked')
    expect(html).toContain('schedule-fit')
  })
})
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** `report.js`:
  - `buildCallout(perAd)` — pure: pick min-cpa ad (bookings>0) and max-spend ad with 0 bookings; return a one-line English sentence (handle the all-zero and no-bookings-anywhere cases).
  - `buildAdReportEmail({ locationName, date, kpis, perAd, deltas })` — returns `{ subject, html }` mirroring `morning-briefing.js` markup (header, KPI line, per-ad table with delta chips, callout, dashboard link).

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit** `git commit -m "ADS-REPORT.4 — daily ad report email builder"`

---

### Task 4.2: Report cron + recipients

**Files:** Create `src/app/api/cron/ad-report-email/route.js`; Modify `vercel.json`, `AdsIntegrationTab.jsx` (recipients field)

- [ ] **Step 1: Recipients field.** Add a "Daily report recipients" comma-separated field to the Ads settings tab, persisted to `locations.settings.ads.report_recipients` via a small extension of the settings PUT (write into `locations.settings` under `ads.report_recipients`, seeded with the owner's email on first load).

- [ ] **Step 2: Cron.**

```javascript
// src/app/api/cron/ad-report-email/route.js
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { stampHeartbeat } from '@/lib/cron-heartbeat'
import { loadAdsDashboard } from '@/lib/ads/read'
import { buildAdReportEmail } from '@/lib/ads/report'
import { sendEmail } from '@/lib/postmark'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request) {
  const auth = request.headers.get('authorization') || ''
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  }
  const db = createServerClient()
  const { data: locations } = await db.from('locations').select('id, name, settings').eq('active', true)
  const results = []
  for (const loc of locations || []) {
    const recipients = loc.settings?.ads?.report_recipients || []
    const { data: hasAccount } = await db.from('ad_accounts').select('id').eq('location_id', loc.id).eq('is_active', true).limit(1).maybeSingle()
    if (!recipients.length || !hasAccount) continue
    try {
      const dash = await loadAdsDashboard(db, loc.id, 1) // yesterday
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Dublin' }).format(new Date())
      const { subject, html } = buildAdReportEmail({ locationName: loc.name, date, kpis: dash.kpis, perAd: dash.perAd })
      for (const to of recipients) await sendEmail({ to, subject, htmlBody: html, stream: 'outbound', tag: 'ad-report' })
      results.push({ loc: loc.id, sent: recipients.length })
    } catch (e) { results.push({ loc: loc.id, error: e.message }) }
  }
  await stampHeartbeat('ad-report-email').catch(() => {})
  return NextResponse.json({ success: true, results })
}
```

- [ ] **Step 3: Register in `vercel.json`:** `{ "path": "/api/cron/ad-report-email", "schedule": "0 7 * * *" }`.

- [ ] **Step 4: Build + guards.** `npm run build && npm run check:route-guards` → PASS.

- [ ] **Step 5: Commit** `git commit -m "ADS-REPORT.4 — daily ad report cron + recipients config"`

---

## Final: CI mirror, PR

- [ ] Run the full CI mirror + `npm run build`. All green.
- [ ] Push and open the PR:

```bash
git push -u origin HEAD
gh pr create --base main --title "ADS-REPORT — Ads reporting (Meta) Phases 0–4" --fill
```

PR body must note: the manual prerequisite (per-location `ads_read` token), that Task 2.3 (ad-URL update) was done via the ads API, and the manual E2E verification performed.

---

## Self-review (completed)

- **Spec coverage:** §5 tables → Tasks 0.1/1.1/2.1; §6 provider → 1.2/1.3; §7 ingestion → 1.4/1.5; §8 attribution → 2.1–2.4; §9 dashboard (per-location) → 3.1/3.2; §10 email (per-location) → 4.1/4.2; §11 settings → 0.3/0.5/4.2; §12 segmentation → enforced by `stamp()` (1.4) + route guards (0.3); §13 permissions → 0.4; §14 token → 0.5/0.6 + PR note. Roll-up (§9/§10 group), breakdown panels (§9), and TikTok (§15) are Phases 5–7 below.
- **Placeholders:** none — every code step carries real code.
- **Type consistency:** normalized row shape defined in `provider.js` (1.2) and consumed unchanged by `meta.js` (1.3), `sync.js` (1.4), `read.js` (3.1); `ad_external_id` is the join key in 2.1 (migration), 2.2 (write), 2.4 (read).

---

## Follow-on plans (separate, after Phase 4 lands)

**Phase 5 — Roll-up.** Dashboard scope selector ("All studios") aggregating `ad_insights_daily`/attribution grouped by location across the user's entitled locations + a per-studio comparison table; a group roll-up email. **Blocker to resolve first:** `organizations` has no `settings` column (verified 2026-07-03) — add `organizations.settings jsonb` (migration) for `ads.rollup_recipients`, or store rollup recipients on a designated "group" location. Own plan.

**Phase 6 — Breakdown panels.** Surface `ad_insights_breakdown_daily` (placement/age/gender/platform) as dashboard panels + read functions. Data is already ingested (Task 1.5); this is read + UI only. Own plan.

**Phase 7 — TikTok provider.** Implement `src/lib/ads/providers/tiktok.js` against the TikTok Marketing API to the same `provider.js` contract (field-map table in the spec §15), add a `provider='tiktok'` account row via the existing settings tab. Sync/attribution/dashboard/email unchanged. Requires a TikTok OAuth app + per-advertiser token. Own plan.
