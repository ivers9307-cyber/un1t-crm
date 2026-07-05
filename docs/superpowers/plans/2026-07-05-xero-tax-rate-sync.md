# Xero Tax-Rate Sync + Rate-Accurate Bill VAT — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync each location's Xero tax rates into the CRM and book every supplier bill under the correct VAT rate — derived from the bill, matched to that location's real Xero rates, confirmed in review, and pushed as a per-line `TaxType`.

**Architecture:** Mirror the existing `xero_accounts` cache pattern for a new `xero_tax_rates` cache (`pullTaxRates`), add a pure resolver (`resolveBillTaxType`) that maps a bill's effective rate to a location tax type, surface it as a confirmable default in the `/invoices` review UI, gate approval on a resolved rate, and have `push-xero` prefer the confirmed rate. Supersedes the interim #816 logic (kept as legacy fallback).

**Tech Stack:** Next.js 16 App Router, Supabase (Postgres, service-role routes), Vitest, Zod, Xero Accounting API (`/TaxRates`).

**Spec:** [`docs/superpowers/specs/2026-07-05-xero-tax-rate-sync-design.md`](../specs/2026-07-05-xero-tax-rate-sync-design.md)

---

## File Structure

| File | New/Mod | Responsibility |
|---|---|---|
| `supabase/migrations/375_xero_tax_rates.sql` | New | `xero_tax_rates` table + `xero_connections` stamp cols + RLS + trigger |
| `src/lib/xero/tax-rates-sync.js` | New | `pullTaxRates(locationId)` — fetch `/TaxRates` → cache with stale sweep |
| `src/lib/xero/tax-rates-sync.test.js` | New | sync mapping, EffectiveRate fallback, stale sweep, connection stamp |
| `src/lib/invoices-queue/vat.js` | New | pure `resolveBillTaxType(fields, taxRates)` |
| `src/lib/invoices-queue/vat.test.js` | New | resolver truth table |
| `src/lib/invoice-extraction.js` | Mod | add `tax_type` + `tax_type_source` to `invoiceFieldsSchema` |
| `src/lib/invoices-queue/push-xero.js` | Mod | `resolveLineTaxType` prefers confirmed `fields.tax_type` |
| `src/lib/invoices-queue/push-xero.test.js` | Mod | confirmed `tax_type` wins |
| `src/app/api/locations/[id]/xero/sync-accounts/route.js` | Mod | also run `pullTaxRates`; return its counts |
| `src/app/api/locations/[id]/xero/tax-rates/route.js` | New | GET a location's active expense-applicable rates for the picker |
| `src/app/api/xero/callback/route.js` | Mod | best-effort sync accounts + tax rates on connect |
| `src/app/api/invoices-inbox/[id]/data-approve/route.js` | Mod | gate: refuse a non-zero bill with no resolved `tax_type` |
| `src/components/invoices/XeroTaxRatePicker.jsx` | New | VAT-rate selector, derived default + override |
| `src/components/InvoicesInbox.jsx` | Mod | wire the picker into `StageTwoBlock` |
| `src/components/settings/XeroLocationCard.jsx` | Mod | button label + tax-rate freshness line |
| `src/lib/openapi.js` | Mod | register the tax-rates route |
| `docs/CHANGELOG.md` | Mod | Done entry |

---

## Task 1: Migration — `xero_tax_rates` cache

**Files:**
- Create: `supabase/migrations/375_xero_tax_rates.sql`

- [ ] **Step 1: Write the migration**

```sql
-- XERO-BILL-VAT.2 — per-location Xero tax-rate cache.
--
-- Mirrors xero_accounts (mig 186): a manual-refresh cache of the
-- location's Xero /TaxRates, so the /invoices review UI can pick the
-- exact TaxType for a bill and the push can send the right VAT rate
-- instead of letting Xero apply the account default (the ROWfit
-- 0%-booked-at-23% bug, #816).
--
-- Rates are per Xero tenant, so per location. Stale-row handling is
-- identical to xero_accounts: stamp last_synced_at on every upsert,
-- delete rows older than the sync start.

set check_function_bodies = off;

create table public.xero_tax_rates (
  id                    uuid primary key default gen_random_uuid(),
  location_id           uuid not null references public.locations (id) on delete cascade,

  -- Xero TaxType code — the stable identifier (e.g. INPUT, TAX001,
  -- NONE). This is what LineItem.TaxType must carry.
  tax_type              text not null,

  -- Human label from Xero (e.g. "VAT on Purchases (23%)").
  name                  text not null check (length(name) between 1 and 200),

  -- Total effective rate as a percentage (e.g. 23, 13.5, 0).
  effective_rate        numeric,

  -- ACTIVE | DELETED | ARCHIVED.
  status                text,

  -- Applicability flags from Xero — bills use expense-applicable
  -- rates; revenue kept for parity / future customer-invoice use.
  can_apply_to_expenses boolean,
  can_apply_to_revenue  boolean,

  last_synced_at        timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint xero_tax_rates_one_per_location unique (location_id, tax_type)
);

create index xero_tax_rates_picker_idx
  on public.xero_tax_rates (location_id, status, can_apply_to_expenses);

comment on table public.xero_tax_rates is
  'XERO-BILL-VAT.2 — cached Xero tax rates per location. Refreshed manually (with accounts) via Settings + on connect. Drives the /invoices VAT-rate picker and the ACCPAY push TaxType.';

alter table public.xero_connections
  add column if not exists tax_rates_last_synced_at timestamptz,
  add column if not exists tax_rates_sync_error text;

comment on column public.xero_connections.tax_rates_last_synced_at is
  'XERO-BILL-VAT.2 — when xero_tax_rates was last refreshed for this location. NULL means never synced.';

-- updated_at trigger (same pattern as xero_accounts).
create or replace function public.xero_tax_rates_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger xero_tax_rates_updated_at
  before update on public.xero_tax_rates
  for each row execute function public.xero_tax_rates_touch_updated_at();

-- RLS — location members read; writes are service-role only (no
-- write policy). Mirrors xero_accounts (mig 186).
alter table public.xero_tax_rates enable row level security;

create policy xero_tax_rates_member_select on public.xero_tax_rates
  for select to authenticated
  using (private.auth_is_in_location(location_id));
```

- [ ] **Step 2: Apply via Supabase MCP**

Apply with `apply_migration` (name `375_xero_tax_rates`) against project `iyvtbjjxdggiadzwwvdj` (confirm via `list_projects` it's un1t-crm, NOT sentinel `tpttqakxmyxrwnqjepfm`).

- [ ] **Step 3: Verify schema + advisors**

Run `list_tables` (confirm `xero_tax_rates` exists with the columns) and `get_advisors` (type=security). Expected: no new ERROR-level advisories introduced by this table (the `member_select` policy uses `private.auth_is_in_location`, same as `xero_accounts`).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/375_xero_tax_rates.sql
git commit -m "XERO-BILL-VAT.2 — mig 375: xero_tax_rates cache + connection stamps"
```

---

## Task 2: Sync lib — `pullTaxRates`

**Files:**
- Create: `src/lib/xero/tax-rates-sync.js`
- Test: `src/lib/xero/tax-rates-sync.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/xero/tax-rates-sync.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

const xfetchMock = vi.fn()
vi.mock('@/lib/xero/client', async () => {
  const actual = await vi.importActual('@/lib/xero/client')
  return { ...actual, withFreshToken: vi.fn(async () => ({ xfetch: xfetchMock })) }
})

const captured = { upserts: [], deletes: [], connUpdates: [] }
const makeChain = (table) => {
  const chain = {
    upsert: vi.fn((rows, opts) => { captured.upserts.push({ table, rows, opts }); return Promise.resolve({ error: null }) }),
    // delete().eq().lt() → resolves with a count
    delete: vi.fn(() => chain),
    update: vi.fn((patch) => { captured.connUpdates.push({ table, patch }); return chain }),
    eq: vi.fn(() => chain),
    lt: vi.fn(() => { captured.deletes.push({ table }); return Promise.resolve({ error: null, count: 1 }) }),
    then: undefined,
  }
  return chain
}
vi.mock('@/lib/supabase', () => ({ createServerClient: () => ({ from: (t) => makeChain(t) }) }))

let pullTaxRates
beforeEach(async () => {
  vi.resetModules()
  xfetchMock.mockReset()
  captured.upserts = []; captured.deletes = []; captured.connUpdates = []
  ;({ pullTaxRates } = await import('./tax-rates-sync'))
})

describe('pullTaxRates', () => {
  it('maps Xero /TaxRates into cache rows and stamps the connection', async () => {
    xfetchMock.mockResolvedValueOnce({ TaxRates: [
      { Name: 'VAT on Purchases', TaxType: 'INPUT', Status: 'ACTIVE', EffectiveRate: 23, CanApplyToExpenses: true, CanApplyToRevenue: false },
      { Name: 'No VAT', TaxType: 'NONE', Status: 'ACTIVE', EffectiveRate: 0, CanApplyToExpenses: true, CanApplyToRevenue: true },
    ] })
    const r = await pullTaxRates('loc1')
    expect(r.syncedCount).toBe(2)
    const up = captured.upserts.find((u) => u.table === 'xero_tax_rates')
    expect(up.rows[0]).toMatchObject({ location_id: 'loc1', tax_type: 'INPUT', name: 'VAT on Purchases', effective_rate: 23, status: 'ACTIVE', can_apply_to_expenses: true })
    expect(up.opts.onConflict).toBe('location_id,tax_type')
    expect(captured.connUpdates.some((u) => u.table === 'xero_connections' && 'tax_rates_last_synced_at' in u.patch)).toBe(true)
  })

  it('falls back to summing TaxComponents when EffectiveRate is absent', async () => {
    xfetchMock.mockResolvedValueOnce({ TaxRates: [
      { Name: 'Std', TaxType: 'TAX001', Status: 'ACTIVE', CanApplyToExpenses: true, TaxComponents: [{ Rate: 20 }, { Rate: 3 }] },
    ] })
    await pullTaxRates('loc1')
    const up = captured.upserts.find((u) => u.table === 'xero_tax_rates')
    expect(up.rows[0].effective_rate).toBe(23)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run src/lib/xero/tax-rates-sync.test.js`
Expected: FAIL — `Cannot find module './tax-rates-sync'`.

- [ ] **Step 3: Implement `pullTaxRates`**

```javascript
// src/lib/xero/tax-rates-sync.js
// XERO-BILL-VAT.2 — Xero tax-rate cache sync. Mirror of accounts-sync.js.
//
// One-shot pull of /TaxRates into xero_tax_rates. Hit manually from
// Settings (alongside accounts) + on connect. Rates change rarely, so
// no cron — same posture as the chart of accounts.

import { withFreshToken, XeroError } from './client'
import { createServerClient } from '@/lib/supabase'

// Xero returns EffectiveRate as a percentage; if it's missing (older
// orgs / composite rates) sum the TaxComponents rates.
function effectiveRateOf(tr) {
  if (typeof tr.EffectiveRate === 'number') return tr.EffectiveRate
  if (Array.isArray(tr.TaxComponents)) {
    return tr.TaxComponents.reduce((s, c) => s + (Number(c?.Rate) || 0), 0)
  }
  return null
}

/**
 * Pull the location's Xero tax rates and refresh the local cache.
 * @param {string} locationId
 * @returns {Promise<{ syncedCount: number, deletedCount: number, syncedAt: string }>}
 */
export async function pullTaxRates(locationId) {
  if (!locationId) throw new XeroError('pullTaxRates: locationId required.')

  const db = createServerClient()
  const syncStartedAt = new Date().toISOString()

  let xfetch
  try {
    ;({ xfetch } = await withFreshToken(locationId))
  } catch (e) {
    await db.from('xero_connections')
      .update({ tax_rates_sync_error: e.message || 'Unknown error' })
      .eq('location_id', locationId)
    throw e
  }

  let res
  try {
    res = await xfetch('/TaxRates')
  } catch (e) {
    await db.from('xero_connections')
      .update({ tax_rates_sync_error: e.message || 'Xero /TaxRates call failed' })
      .eq('location_id', locationId)
    throw e
  }

  const rates = Array.isArray(res?.TaxRates) ? res.TaxRates : []

  if (rates.length > 0) {
    const rows = rates.map((tr) => ({
      location_id: locationId,
      tax_type: tr.TaxType,
      name: tr.Name || '(unnamed)',
      effective_rate: effectiveRateOf(tr),
      status: tr.Status || null,
      can_apply_to_expenses: typeof tr.CanApplyToExpenses === 'boolean' ? tr.CanApplyToExpenses : null,
      can_apply_to_revenue: typeof tr.CanApplyToRevenue === 'boolean' ? tr.CanApplyToRevenue : null,
      last_synced_at: syncStartedAt,
      updated_at: new Date().toISOString(),
    })).filter((r) => r.tax_type) // a rate with no TaxType is unusable

    const { error: upErr } = await db
      .from('xero_tax_rates')
      .upsert(rows, { onConflict: 'location_id,tax_type' })
    if (upErr) {
      await db.from('xero_connections')
        .update({ tax_rates_sync_error: upErr.message })
        .eq('location_id', locationId)
      throw new XeroError(`Failed to upsert xero_tax_rates: ${upErr.message}`)
    }
  }

  const { error: delErr, count: deletedCount } = await db
    .from('xero_tax_rates')
    .delete({ count: 'exact' })
    .eq('location_id', locationId)
    .lt('last_synced_at', syncStartedAt)
  if (delErr) {
    await db.from('xero_connections')
      .update({ tax_rates_sync_error: delErr.message })
      .eq('location_id', locationId)
    throw new XeroError(`Failed to clean stale xero_tax_rates: ${delErr.message}`)
  }

  await db.from('xero_connections')
    .update({ tax_rates_last_synced_at: new Date().toISOString(), tax_rates_sync_error: null })
    .eq('location_id', locationId)

  return { syncedCount: rates.length, deletedCount: deletedCount || 0, syncedAt: syncStartedAt }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run src/lib/xero/tax-rates-sync.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/xero/tax-rates-sync.js src/lib/xero/tax-rates-sync.test.js
git commit -m "XERO-BILL-VAT.2 — pullTaxRates sync helper"
```

---

## Task 3: Resolver — `resolveBillTaxType`

**Files:**
- Create: `src/lib/invoices-queue/vat.js`
- Test: `src/lib/invoices-queue/vat.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// src/lib/invoices-queue/vat.test.js
import { describe, it, expect } from 'vitest'
import { resolveBillTaxType } from './vat'

const RATES = [
  { tax_type: 'NONE', name: 'No VAT', effective_rate: 0, status: 'ACTIVE', can_apply_to_expenses: true },
  { tax_type: 'ZEROEXP', name: 'Zero Rated Purchases', effective_rate: 0, status: 'ACTIVE', can_apply_to_expenses: true },
  { tax_type: 'RED', name: 'VAT on Purchases (13.5%)', effective_rate: 13.5, status: 'ACTIVE', can_apply_to_expenses: true },
  { tax_type: 'INPUT', name: 'VAT on Purchases (23%)', effective_rate: 23, status: 'ACTIVE', can_apply_to_expenses: true },
  { tax_type: 'OUTPUT', name: 'VAT on Sales (23%)', effective_rate: 23, status: 'ACTIVE', can_apply_to_expenses: false },
  { tax_type: 'ARCHIVED23', name: 'Old 23%', effective_rate: 23, status: 'ARCHIVED', can_apply_to_expenses: true },
]

describe('resolveBillTaxType', () => {
  it('zero VAT → NONE (status zero), offering zero-rated alternatives', () => {
    const r = resolveBillTaxType({ subtotal: 100, tax_amount: 0, total: 100 }, RATES)
    expect(r).toMatchObject({ taxType: 'NONE', status: 'zero' })
    expect(r.candidates.map((c) => c.tax_type).sort()).toEqual(['NONE', 'ZEROEXP'])
  })

  it('23% → the unique active expense rate', () => {
    const r = resolveBillTaxType({ subtotal: 100, tax_amount: 23, total: 123 }, RATES)
    expect(r).toMatchObject({ taxType: 'INPUT', status: 'matched' })
  })

  it('13.5% → the reduced rate (not the standard)', () => {
    const r = resolveBillTaxType({ subtotal: 100, tax_amount: 13.5, total: 113.5 }, RATES)
    expect(r.taxType).toBe('RED')
  })

  it('excludes revenue-only + archived rates from matching', () => {
    // Only INPUT is active+expense at 23; OUTPUT (revenue) and ARCHIVED23 excluded → unique.
    const r = resolveBillTaxType({ subtotal: 100, tax_amount: 23, total: 123 }, RATES)
    expect(r.status).toBe('matched')
  })

  it('ambiguous when two active expense rates match the derived rate', () => {
    const rates = [
      { tax_type: 'INPUT', name: 'Purchases 23', effective_rate: 23, status: 'ACTIVE', can_apply_to_expenses: true },
      { tax_type: 'IMPORT', name: 'Imports 23', effective_rate: 23, status: 'ACTIVE', can_apply_to_expenses: true },
    ]
    const r = resolveBillTaxType({ subtotal: 100, tax_amount: 23, total: 123 }, rates)
    expect(r).toMatchObject({ taxType: null, status: 'ambiguous' })
    expect(r.candidates).toHaveLength(2)
  })

  it('unmatched when no active expense rate is within tolerance', () => {
    const r = resolveBillTaxType({ subtotal: 100, tax_amount: 5, total: 105 }, RATES)
    expect(r).toMatchObject({ taxType: null, status: 'unmatched' })
  })

  it('falls back to line-item sum, then total−tax, for net', () => {
    // no subtotal → net from lines (8×3.25 + 7.2 = 33.2); tax 0 → zero
    const r = resolveBillTaxType({ tax_amount: 0, line_items: [{ quantity: 8, unit_amount: 3.25 }, { quantity: 1, unit_amount: 7.2 }] }, RATES)
    expect(r.status).toBe('zero')
  })

  it('within ±0.5pp tolerance rounds to the rate; outside does not', () => {
    expect(resolveBillTaxType({ subtotal: 100, tax_amount: 22.6, total: 122.6 }, RATES).taxType).toBe('INPUT') // 22.6% within 0.5 of 23
    expect(resolveBillTaxType({ subtotal: 100, tax_amount: 22.4, total: 122.4 }, RATES).status).toBe('unmatched') // 22.4% outside
  })
})
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `npx vitest run src/lib/invoices-queue/vat.test.js`
Expected: FAIL — `resolveBillTaxType` is not exported.

- [ ] **Step 3: Implement the resolver**

```javascript
// src/lib/invoices-queue/vat.js
// XERO-BILL-VAT.2 — derive a bill's VAT rate and map it to one of the
// location's real Xero tax types (from the xero_tax_rates cache).
//
// Pure. The push and the review UI both call this. Only three things
// are policy: the match tolerance, the zero default (NONE — Richard's
// call), and the expense-applicability filter. Everything else is
// arithmetic.

const TOLERANCE_PP = 0.5 // percentage points
const ZERO_EPS = 0.001

// Net (ex-VAT) basis for the rate: prefer subtotal, else the line-item
// sum, else total − tax.
function billNet(fields) {
  const subtotal = Number(fields?.subtotal)
  if (Number.isFinite(subtotal) && subtotal > 0) return subtotal
  if (Array.isArray(fields?.line_items) && fields.line_items.length) {
    const sum = fields.line_items.reduce(
      (s, li) => s + (Number(li?.unit_amount) || 0) * (Number(li?.quantity) ?? 1), 0)
    if (sum > 0) return sum
  }
  const total = Number(fields?.total)
  const tax = Number(fields?.tax_amount)
  if (Number.isFinite(total) && Number.isFinite(tax) && total - tax > 0) return total - tax
  return null
}

const activeExpense = (r) => r?.status === 'ACTIVE' && r?.can_apply_to_expenses === true

/**
 * @param {object} fields  extracted_fields (subtotal, tax_amount, total, line_items)
 * @param {Array}  taxRates  the location's xero_tax_rates rows
 * @returns {{ taxType: string|null, derivedRate: number|null, status: 'zero'|'matched'|'ambiguous'|'unmatched', candidates: Array }}
 */
export function resolveBillTaxType(fields, taxRates) {
  const rates = Array.isArray(taxRates) ? taxRates : []
  const taxAmount = Number(fields?.tax_amount)

  // Zero VAT → NONE default; offer the location's 0%-effective expense
  // rates (No VAT / Zero Rated / Exempt) as override candidates.
  if (Number.isFinite(taxAmount) && Math.abs(taxAmount) < ZERO_EPS) {
    const zeroCandidates = rates.filter((r) => activeExpense(r) && Math.abs(Number(r.effective_rate) || 0) < ZERO_EPS)
    return { taxType: 'NONE', derivedRate: 0, status: 'zero', candidates: zeroCandidates }
  }

  const net = billNet(fields)
  if (net == null || !Number.isFinite(taxAmount)) {
    return { taxType: null, derivedRate: null, status: 'unmatched', candidates: rates.filter(activeExpense) }
  }
  const derivedRate = (taxAmount / net) * 100

  const matches = rates
    .filter(activeExpense)
    .filter((r) => Math.abs((Number(r.effective_rate) || 0) - derivedRate) <= TOLERANCE_PP)

  if (matches.length === 1) return { taxType: matches[0].tax_type, derivedRate, status: 'matched', candidates: matches }
  if (matches.length > 1) return { taxType: null, derivedRate, status: 'ambiguous', candidates: matches }
  return { taxType: null, derivedRate, status: 'unmatched', candidates: rates.filter(activeExpense) }
}
```

- [ ] **Step 4: Run — expect PASS**

Run: `npx vitest run src/lib/invoices-queue/vat.test.js`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/invoices-queue/vat.js src/lib/invoices-queue/vat.test.js
git commit -m "XERO-BILL-VAT.2 — resolveBillTaxType (derive + match to location rates)"
```

---

## Task 4: Persist `tax_type` — extend the extraction schema

**Files:**
- Modify: `src/lib/invoice-extraction.js` (the `invoiceFields` zod object, ~line 167)

- [ ] **Step 1: Add the fields to the schema**

In `invoiceFields`, immediately before `line_items:`, add:

```javascript
  // XERO-BILL-VAT.2 — the confirmed Xero TaxType for this bill,
  // derived from the location's synced rates and confirmed by the
  // bookkeeper in review. Sent as LineItem.TaxType on push. Optional
  // so legacy rows + the car-invoice flow validate unchanged.
  tax_type: z.string().max(50).nullable().optional(),
  // 'derived' (auto-matched) | 'manual' (operator overrode). Audit only.
  tax_type_source: z.enum(['derived', 'manual']).nullable().optional(),
```

- [ ] **Step 2: Verify the schema still parses existing shapes**

Run: `npx vitest run src/lib/invoice-extraction`
Expected: PASS (existing extraction tests unaffected — the fields are optional). If no test file targets the schema directly, run `npx vitest run src/lib/invoices-queue/push-xero.test.js` to confirm nothing that imports the schema breaks.

- [ ] **Step 3: Commit**

```bash
git add src/lib/invoice-extraction.js
git commit -m "XERO-BILL-VAT.2 — allow tax_type + tax_type_source on extracted_fields"
```

---

## Task 5: Push prefers the confirmed `tax_type`

**Files:**
- Modify: `src/lib/invoices-queue/push-xero.js` (`resolveLineTaxType`, ~line 171)
- Test: `src/lib/invoices-queue/push-xero.test.js`

- [ ] **Step 1: Add the failing test** (in the existing `describe('resolveLineTaxType', ...)` block)

```javascript
  it('prefers a confirmed fields.tax_type over everything else', () => {
    // confirmed rate wins even when tax_amount is 0 (would else be NONE)
    // and even when the account cache would resolve something different
    expect(resolveLineTaxType({ tax_amount: 0, tax_type: 'ZEROEXP' }, { 400: 'INPUT' }, '400')).toBe('ZEROEXP')
    expect(resolveLineTaxType({ tax_amount: 23, tax_type: 'RED' }, { 400: 'INPUT' }, '400')).toBe('RED')
  })
```

- [ ] **Step 2: Run — expect FAIL**

Run: `npx vitest run src/lib/invoices-queue/push-xero.test.js -t "prefers a confirmed"`
Expected: FAIL — returns `NONE`/`INPUT`, not the confirmed type.

- [ ] **Step 3: Update `resolveLineTaxType`**

Replace the body of `resolveLineTaxType` with:

```javascript
export function resolveLineTaxType(fields, accountTaxTypes, code) {
  // XERO-BILL-VAT.2 — a bookkeeper-confirmed tax_type (derived from
  // the location's synced Xero rates + confirmed in review) wins for
  // every line.
  if (typeof fields?.tax_type === 'string' && fields.tax_type) return fields.tax_type
  // XERO-BILL-VAT.1 fallback for legacy rows with no confirmed type.
  const taxAmount = Number(fields?.tax_amount)
  if (Number.isFinite(taxAmount) && taxAmount === 0) return 'NONE'
  return (code != null ? accountTaxTypes?.[String(code)] : undefined) || undefined
}
```

Also update the JSDoc above it to note the confirmed-type precedence.

- [ ] **Step 4: Run — expect PASS (whole file)**

Run: `npx vitest run src/lib/invoices-queue/push-xero.test.js`
Expected: PASS — the new case plus all existing #816 cases (they don't set `tax_type`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/invoices-queue/push-xero.js src/lib/invoices-queue/push-xero.test.js
git commit -m "XERO-BILL-VAT.2 — push prefers the confirmed tax_type"
```

---

## Task 6: Fold tax-rate sync into the manual refresh

**Files:**
- Modify: `src/app/api/locations/[id]/xero/sync-accounts/route.js`

- [ ] **Step 1: Also run `pullTaxRates`**

Add the import and call. Replace the `try { const result = await pullAccounts(locationId) ... }` block with:

```javascript
import { pullTaxRates } from '@/lib/xero/tax-rates-sync'
// ...
  try {
    const result = await pullAccounts(locationId)
    // Tax rates refresh alongside accounts — same tenant, same cadence.
    // A tax-rate failure is reported but does not undo the accounts sync.
    let taxRates = null
    try {
      taxRates = await pullTaxRates(locationId)
    } catch (e) {
      taxRates = { error: e.message || 'Tax-rate sync failed' }
    }
    return NextResponse.json({
      success: true,
      syncedCount: result.syncedCount,
      deletedCount: result.deletedCount,
      syncedAt: result.syncedAt,
      taxRates,
    })
  } catch (e) {
    // ...unchanged catch...
  }
```

- [ ] **Step 2: Build check (new import + route)**

Run: `npm run build` (or rely on the Vercel PR check). Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/locations/\[id\]/xero/sync-accounts/route.js
git commit -m "XERO-BILL-VAT.2 — sync tax rates alongside accounts on manual refresh"
```

---

## Task 7: Sync on connect (best-effort)

**Files:**
- Modify: `src/app/api/xero/callback/route.js`

- [ ] **Step 1: After the connection upsert, sync both caches**

After the `xero_connections` upsert succeeds and before the success redirect, add:

```javascript
import { pullAccounts } from '@/lib/xero/accounts-sync'
import { pullTaxRates } from '@/lib/xero/tax-rates-sync'
// ...
  // Prime the caches so a freshly-connected location has accounts +
  // tax rates immediately. Best-effort — failures are recorded on the
  // connection row by the helpers; never block the connect redirect.
  try { await pullAccounts(locationId) } catch (e) { console.warn(`[xero connect] accounts sync: ${e?.message || e}`) }
  try { await pullTaxRates(locationId) } catch (e) { console.warn(`[xero connect] tax-rate sync: ${e?.message || e}`) }
```

(Use the `locationId` already resolved in the callback for the upsert — confirm its variable name and reuse it.)

- [ ] **Step 2: Build check**

Run: `npm run build`. Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/xero/callback/route.js
git commit -m "XERO-BILL-VAT.2 — prime accounts + tax-rate caches on Xero connect"
```

---

## Task 8: Read endpoint — GET tax-rates

**Files:**
- Create: `src/app/api/locations/[id]/xero/tax-rates/route.js`
- Modify: `src/lib/openapi.js`

- [ ] **Step 1: Write the route** (mirror the accounts GET, filter to active expense-applicable rates)

```javascript
// XERO-BILL-VAT.2 — GET /api/locations/[id]/xero/tax-rates
//
// Read-side endpoint for the VAT-rate picker in /invoices review.
// Returns the location's ACTIVE, expense-applicable rates from the
// xero_tax_rates cache (populated by pullTaxRates). No live Xero call.
//
// Returns: { success, taxRates: [{ tax_type, name, effective_rate, can_apply_to_expenses }], lastSyncedAt, stale }

import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const STALE_AFTER_DAYS = 30

export async function GET(_request, props) {
  const params = await props.params
  const locationId = params?.id
  if (!locationId) {
    return NextResponse.json({ success: false, error: 'location id required' }, { status: 400 })
  }

  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const isMaster = user.role === 'master'
  const userLocationIds = (user.locations || []).map((l) => l.id)
  if (!isMaster && !userLocationIds.includes(locationId)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  const db = createServerClient()
  const { data: taxRates, error } = await db
    .from('xero_tax_rates')
    .select('tax_type, name, effective_rate, can_apply_to_expenses')
    .eq('location_id', locationId)
    .eq('status', 'ACTIVE')
    .eq('can_apply_to_expenses', true)
    .order('effective_rate', { ascending: true, nullsFirst: true })
    .limit(200)
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  const { data: conn } = await db
    .from('xero_connections')
    .select('tax_rates_last_synced_at')
    .eq('location_id', locationId)
    .maybeSingle()
  const stale = !conn?.tax_rates_last_synced_at
    || (Date.now() - new Date(conn.tax_rates_last_synced_at).getTime()) > STALE_AFTER_DAYS * 86400_000

  return NextResponse.json({
    success: true,
    taxRates: taxRates || [],
    lastSyncedAt: conn?.tax_rates_last_synced_at || null,
    stale,
  })
}
```

- [ ] **Step 2: Register in openapi**

In `src/lib/openapi.js`, add a path entry for `GET /api/locations/{id}/xero/tax-rates` mirroring the existing `xero/accounts` entry (copy that block, swap the path + response field name to `taxRates`).

- [ ] **Step 3: Route-guard + build check**

Run: `npm run check:route-guards && npm run build`
Expected: route-guards passes (the route uses `getCurrentUser` + membership check); build compiles.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/locations/\[id\]/xero/tax-rates/route.js src/lib/openapi.js
git commit -m "XERO-BILL-VAT.2 — GET tax-rates read endpoint + openapi"
```

---

## Task 9: Approval gate — refuse an unresolved rate

**Files:**
- Modify: `src/app/api/invoices-inbox/[id]/data-approve/route.js`

- [ ] **Step 1: Add the gate** before the first-hop `extracted → data_approved` update (after the `!row.extracted_fields` guard, ~line 47)

```javascript
  // XERO-BILL-VAT.2 — never send a bill whose VAT rate is undetermined.
  // A confirmed tax_type is required, EXCEPT a genuine 0%-VAT bill
  // (tax_amount === 0), which push resolves to 'NONE' deterministically.
  {
    const ef = row.extracted_fields || {}
    const hasTaxType = typeof ef.tax_type === 'string' && ef.tax_type.length > 0
    const zeroVat = Number(ef.tax_amount) === 0
    if (!hasTaxType && !zeroVat) {
      return NextResponse.json({
        success: false,
        error: 'Pick a VAT rate before sending — the bill’s rate couldn’t be auto-determined. Open the bill and choose a VAT rate.',
      }, { status: 400 })
    }
  }
```

- [ ] **Step 2: Build check**

Run: `npm run build`. Expected: compiles.

- [ ] **Step 3: Manual verification note**

This is exercised end-to-end in Task 11's manual check. (No unit test — the route depends on `loadInvoiceForUser` session context.)

- [ ] **Step 4: Commit**

```bash
git add src/app/api/invoices-inbox/\[id\]/data-approve/route.js
git commit -m "XERO-BILL-VAT.2 — gate bill approval on a resolved VAT rate"
```

---

## Task 10: UI — VAT-rate picker

**Files:**
- Create: `src/components/invoices/XeroTaxRatePicker.jsx`
- Modify: `src/components/InvoicesInbox.jsx` (`StageTwoBlock`, ~line 1005–1031)

- [ ] **Step 1: Write the picker component**

```jsx
// src/components/invoices/XeroTaxRatePicker.jsx
// XERO-BILL-VAT.2 — VAT-rate selector for /invoices review. Fetches
// the location's active expense-applicable rates, defaults to the
// rate derived from the bill, and lets the bookkeeper override.
'use client'
import { useEffect, useState } from 'react'
import { resolveBillTaxType } from '@/lib/invoices-queue/vat'

export default function XeroTaxRatePicker({ locationId, fields, value, onChange }) {
  const [rates, setRates] = useState([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let live = true
    fetch(`/api/locations/${locationId}/xero/tax-rates`)
      .then((r) => r.json())
      .then((j) => { if (live && j.success) setRates(j.taxRates || []) })
      .catch(() => {})
      .finally(() => { if (live) setLoaded(true) })
    return () => { live = false }
  }, [locationId])

  // Derive a default once rates are loaded and nothing is chosen yet.
  const derived = loaded ? resolveBillTaxType(fields, rates) : null
  useEffect(() => {
    if (!value && derived && derived.taxType) {
      onChange(derived.taxType, 'derived')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, derived?.taxType])

  const hint = derived && derived.status !== 'matched' && derived.status !== 'zero'
    ? `Couldn’t auto-detect (derived ${derived.derivedRate == null ? '—' : derived.derivedRate.toFixed(1) + '%'}) — pick one`
    : null

  return (
    <label className="block">
      <span className="text-xs text-un1t-subtle">VAT rate {hint && <span className="text-amber-700">· {hint}</span>}</span>
      <select
        className="mt-1 w-full rounded-md border border-un1t-border bg-un1t-surface px-2 py-1.5 text-sm"
        value={value || ''}
        onChange={(e) => onChange(e.target.value || null, 'manual')}
      >
        <option value="">{loaded ? 'Select VAT rate…' : 'Loading…'}</option>
        {rates.map((r) => (
          <option key={r.tax_type} value={r.tax_type}>
            {r.name} — {r.effective_rate == null ? '?' : r.effective_rate}%
          </option>
        ))}
      </select>
    </label>
  )
}
```

- [ ] **Step 2: Wire it into `StageTwoBlock`**

In `src/components/InvoicesInbox.jsx`, immediately after the `<XeroAccountPicker ... />` block (ends ~line 1031), add:

```jsx
        {/* XERO-BILL-VAT.2 — VAT-rate picker. Defaults to the rate
            derived from the bill, matched against the location's real
            Xero tax rates; the bookkeeper confirms or overrides. The
            chosen TaxType is sent on every LineItem at push. */}
        <XeroTaxRatePicker
          locationId={row.location_id}
          fields={fields}
          value={strField('tax_type') || null}
          onChange={(taxType, source) => {
            setField('tax_type', taxType)
            setField('tax_type_source', taxType ? source : null)
          }}
        />
```

Add the import near the top (by the other invoices imports, ~line 28):

```jsx
import XeroTaxRatePicker from '@/components/invoices/XeroTaxRatePicker'
```

- [ ] **Step 3: Build + lint check**

Run: `npm run build && npm run lint -- src/components/invoices/XeroTaxRatePicker.jsx src/components/InvoicesInbox.jsx`
Expected: compiles; no new lint errors on the changed files.

- [ ] **Step 4: Commit**

```bash
git add src/components/invoices/XeroTaxRatePicker.jsx src/components/InvoicesInbox.jsx
git commit -m "XERO-BILL-VAT.2 — VAT-rate picker in /invoices review"
```

---

## Task 11: Settings card — label + tax-rate freshness

**Files:**
- Modify: `src/components/settings/XeroLocationCard.jsx`

- [ ] **Step 1: Reflect the combined sync**

The accounts "Refresh" now also syncs tax rates. Update the accounts panel label/help so it reads "Chart of accounts & tax rates", and add a freshness line under it:

```jsx
              Tax rates last synced: <span className="text-un1t-text">{fmtRelative(connection.tax_rates_last_synced_at)}</span>
```

(Place it beside the existing `accounts_last_synced_at` line ~line 198. `connection.tax_rates_last_synced_at` comes from the same `xero_connections` row the card already reads — confirm the card's connection query selects `*` or add the column to its select.)

- [ ] **Step 2: Manual verification (the real end-to-end check)**

Use the `/run` skill or `preview_start` to launch the app, then:
1. Settings → Xero (Stillorgan): click **Refresh** → confirm "Tax rates last synced" updates and no error shows.
2. `/invoices`: open a captured bill → the **VAT rate** selector shows a sensible default (e.g. a 23% bill → the 23% purchases rate; a 0% bill → No VAT).
3. Clear the VAT rate on a non-zero bill → **Approve** → expect the 400 "Pick a VAT rate" gate.
4. Re-select a rate → Approve → confirm the Xero draft books that rate (check `xero_total_tax` / the Xero deep link).

Record the observed results in the PR description.

- [ ] **Step 3: Commit**

```bash
git add src/components/settings/XeroLocationCard.jsx
git commit -m "XERO-BILL-VAT.2 — settings card shows tax-rate sync freshness"
```

---

## Task 12: Changelog + CI mirror + PR

**Files:**
- Modify: `docs/CHANGELOG.md`

- [ ] **Step 1: Add a CHANGELOG entry** (top of the Done log, matching the existing numbered style) summarising XERO-BILL-VAT.2.

- [ ] **Step 2: Run the full CI mirror + build**

Run:
```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && npm run build
```
Expected: tests pass (incl. the new `vat`, `tax-rates-sync`, and `push-xero` cases); guards pass; build compiles. Note: the repo has a pre-existing lint-error baseline — confirm the *changed* files are clean via `npx eslint <changed files>`.

- [ ] **Step 3: Commit + push + PR**

```bash
git add docs/CHANGELOG.md
git commit -m "XERO-BILL-VAT.2 — changelog"
git push -u origin HEAD
gh pr create --base main --title "XERO-BILL-VAT.2 — per-location Xero tax-rate sync + rate-accurate bill VAT" --fill
```

- [ ] **Step 4: Wait for checks green, then merge**

Confirm Vercel build + Test & lint pass (`gh pr checks`), then squash-merge. Sync each connected location once post-deploy (Settings → Refresh).

---

## Self-Review

- **Spec coverage:** §1 data → Task 1; §2 sync + triggers → Tasks 2/6/7; §3 resolution + read endpoint → Tasks 3/8; §4 review UI + gate → Tasks 9/10/11; §5 push → Task 5; persistence of `tax_type` → Task 4. All spec sections mapped.
- **Type consistency:** `resolveBillTaxType(fields, taxRates)` returns `{ taxType, derivedRate, status, candidates }` — used identically in the picker (Task 10). `resolveLineTaxType(fields, accountTaxTypes, code)` signature unchanged (Task 5). Cache columns (`tax_type`, `effective_rate`, `can_apply_to_expenses`, `status`) are consistent across migration, sync, resolver, and endpoint.
- **Placeholders:** none — every code step is complete.
- **Known non-unit-tested surfaces:** the two routes (data-approve gate, tax-rates GET) and the React picker are covered by the Task 11 manual E2E, not vitest, because they depend on session/DB context.
```
