# Xero tax-rate sync + rate-accurate bill VAT — design

- **Date:** 2026-07-05
- **Status:** Approved (design)
- **Tag:** XERO-BILL-VAT.2
- **Builds on:** XERO-BILL-VAT.1 (#816 / squash `2a978b40`) — per-line `TaxType` stamping on ACCPAY bills.

## Context

Supplier bills are captured (`invoices_queue`), reviewed by a bookkeeper in the
`/invoices` inbox, and pushed to Xero as draft `ACCPAY` bills by
`src/lib/invoices-queue/push-xero.js`.

#816 stopped the acute bug (a 0%-VAT bill booked at the account's default 23% —
ROWfit 23967, €156.84 → €192.91) by stamping a per-line `TaxType`: `NONE` for a
zero-VAT bill, else the account's own cached `tax_type` from `xero_accounts`
(mig 186). That is correct for 0% and for standard-rated bills whose account
default already matches, but it does **not** know the bill's *actual* rate.
Reduced rates (13.5% / 9%) or any bill whose rate differs from the account
default still fall through to the account default; the F2 cross-check
(`xero_tax_mismatch`, mig 371) only flags the drift *after* the draft is booked.

## Goal

Sync each location's Xero tax rates into the CRM and use them to book every
supplier bill under the **right** VAT rate — derived from the bill itself,
matched to that location's real Xero rates, and confirmed by the bookkeeper
before send.

Tax rates are unique per location (each location authorises its own Xero tenant)
and per account (each account has its own applicable/default rates), so the sync
and the resolution are both per-location.

## Non-goals (YAGNI)

- **Mixed-rate invoices** — a single bill carrying more than one VAT rate across
  its lines. v1 resolves one invoice-level rate and applies it to all lines;
  genuinely mixed bills are flagged for manual handling in Xero, not auto-split.
  (We only capture an invoice-level `tax_amount`, not per-line tax.)
- **Per-line rate OCR** — we derive the rate from `tax_amount ÷ net`, so the
  extraction schema does not need a new rate field.
- **A cron** — rates change rarely; manual refresh (same posture as
  `xero_accounts`) plus an on-connect sync is enough.

## Architecture

Five units, each independently testable:

1. **Data** — `xero_tax_rates` cache table + two `xero_connections` stamp columns.
2. **Sync** — `pullTaxRates(locationId)` (mirror of `accounts-sync.js`), wired
   into the existing manual refresh and the OAuth connect callback.
3. **Resolution** — `resolveBillTaxType(fields, taxRates)` (pure), plus a small
   read endpoint that serves a location's rates to the UI.
4. **Review UI** — a VAT-rate selector in the `/invoices` inbox, defaulting to
   the derived rate, overridable from the location's real rates, gating approval.
5. **Push** — `push-xero` prefers the confirmed rate; #816 logic becomes the
   legacy fallback.

---

### 1. Data model

**New table `xero_tax_rates`** (new migration; RLS + grants mirror
`xero_accounts` in mig 186). Columns:

| column | type | notes |
|---|---|---|
| `location_id` | uuid FK → locations | |
| `tax_type` | text | Xero `TaxType` code — the stable id (e.g. `INPUT`, `TAX001`, `NONE`) |
| `name` | text | Xero `Name` (e.g. "VAT on Purchases (23%)") — shown in the picker |
| `effective_rate` | numeric | Xero `EffectiveRate`; fallback = Σ `TaxComponents[].Rate` |
| `status` | text | `ACTIVE` / `DELETED` / `ARCHIVED` |
| `can_apply_to_expenses` | boolean | Xero `CanApplyToExpenses` — bill (purchase) applicability |
| `can_apply_to_revenue` | boolean | Xero `CanApplyToRevenue` — kept for completeness |
| `last_synced_at` | timestamptz | drives the stale-row sweep |
| `updated_at` | timestamptz | |

- **Unique:** `(location_id, tax_type)` (upsert conflict target).
- **Index:** `(location_id)`.

**`xero_connections`** gains `tax_rates_last_synced_at timestamptz` and
`tax_rates_sync_error text` (parallel to the existing `accounts_*` columns).

Forward-only migration, applied via Supabase MCP against un1t-crm, `get_advisors`
after DDL.

---

### 2. Sync — `pullTaxRates(locationId)`

New `src/lib/xero/tax-rates-sync.js`, a near-exact mirror of `accounts-sync.js`:

1. `withFreshToken(locationId)` → `xfetch('/TaxRates')`.
2. Map each Xero `TaxRate` → a row (see table above). `effective_rate` prefers
   `EffectiveRate`; if absent, sum `TaxComponents[].Rate`.
3. Upsert on `(location_id, tax_type)` stamping `last_synced_at = syncStartedAt`.
4. Stale-row sweep: delete rows for the location with `last_synced_at < syncStartedAt`.
5. On success stamp `xero_connections.tax_rates_last_synced_at`, clear
   `tax_rates_sync_error`; on any failure record the error onto the connection
   (same best-effort pattern as accounts-sync) and rethrow `XeroError`.

`/TaxRates` returns the whole set in one response (like `/Accounts`) — no pagination.

**Triggers:**
- Fold into the existing manual refresh: `POST /api/locations/[id]/xero/sync-accounts`
  runs `pullAccounts` **then** `pullTaxRates`, returning both counts. The Settings
  → Xero card button label becomes "Sync accounts & tax rates". (Keeps one button;
  the two caches always refresh together.)
- Run both on first connect in the OAuth callback (`src/app/api/xero/callback/route.js`)
  so a freshly-connected location has rates with no manual step. Best-effort —
  a sync failure there is recorded on the connection, not fatal to the connect.

---

### 3. Resolution — `resolveBillTaxType(fields, taxRates)`

New pure module `src/lib/invoices-queue/vat.js`. Input: the row's
`extracted_fields` and the location's cached tax-rate rows. Output:

```
{ taxType: string | null, derivedRate: number | null, status: 'zero' | 'matched' | 'ambiguous' | 'unmatched', candidates: TaxRate[] }
```

Algorithm:
1. **net** = `subtotal` if > 0, else `Σ line_items[].unit_amount × quantity`,
   else `total − tax_amount`. If net ≤ 0 → `unmatched`, `taxType: null`.
2. **effective** = `tax_amount / net` (as a percentage).
3. **Zero** — `tax_amount === 0` (or effective within ε of 0): `status: 'zero'`,
   `taxType: 'NONE'` (Richard's chosen default). `candidates` = the location's
   0%-effective expense-applicable rates (`NONE`, plus any Zero-Rated / Exempt) so
   the picker can offer the alternatives.
4. **Non-zero** — consider the location's rates that are `status === 'ACTIVE'`
   **and** `can_apply_to_expenses`. Keep those whose `effective_rate` is within
   **±0.5 percentage points** of `effective`.
   - exactly one → `status: 'matched'`, `taxType` = its code.
   - more than one → `status: 'ambiguous'`, `taxType: null`, `candidates` = the matches.
   - none → `status: 'unmatched'`, `taxType: null`, `candidates` = all active
     expense rates (so the bookkeeper can still pick).

Only the tolerance, the zero default, and the applicability filter are policy;
everything else is arithmetic. Fully unit-testable with no DB.

**Read endpoint:** `GET /api/locations/[id]/xero/tax-rates` — returns the
location's `ACTIVE` rates (`tax_type`, `name`, `effective_rate`,
`can_apply_to_expenses`) for the picker. Location-member auth, same shape as the
existing accounts route.

---

### 4. Review UI — confirm / override

In the `/invoices` inbox (`src/components/InvoicesInbox.jsx`), each bill under
review gets a **VAT rate** selector:

- Options = the location's `ACTIVE`, expense-applicable rates from the read
  endpoint, labelled `"{name} — {effective_rate}%"`.
- Default = `resolveBillTaxType(...).taxType`. When `status` is `ambiguous` or
  `unmatched` the selector shows an empty "Select VAT rate" state with a hint
  ("couldn't auto-detect — derived {derivedRate}%") so the bookkeeper picks
  deliberately.
- Saving writes `extracted_fields.tax_type` (and, for audit, `tax_type_source`:
  `'derived'` | `'manual'`) via the existing `PATCH /api/invoices-inbox/[id]/fields`
  route.

**Approval gate:** `POST /api/invoices-inbox/[id]/data-approve` (and bulk-send)
refuse a row that has no resolved `extracted_fields.tax_type`, returning a clear
error. A bill can no longer reach Xero with an undetermined VAT rate. (Rows with
`tax_amount === 0` are auto-resolved to `NONE`, so this never blocks a genuine
zero-VAT bill.)

---

### 5. Push consumes the confirmed rate

`src/lib/invoices-queue/push-xero.js` — extend `resolveLineTaxType`:

1. If `fields.tax_type` is set (the confirmed value) → use it for every line.
   This is the primary path going forward.
2. Else fall back to #816 behaviour: `tax_amount === 0` → `NONE`; else the line
   account's cached `tax_type`; else omit. This keeps legacy rows (approved
   before this ships) working unchanged.

`LineAmountTypes` stays `Exclusive`. The F2 cross-check (`xero_total_tax` /
`xero_tax_mismatch`) is retained as the backstop; with confirmed rates it should
essentially always corroborate.

---

## Data flow

```
Settings "Sync accounts & tax rates"  ──► pullAccounts + pullTaxRates ──► xero_accounts / xero_tax_rates
OAuth connect callback                ──► (same, best-effort)

Bill reviewed in /invoices
  └─ GET tax-rates ─► resolveBillTaxType(fields, rates) ─► default TaxType in selector
       └─ bookkeeper confirms/overrides ─► PATCH fields.tax_type
            └─ data-approve (gated on tax_type) ─► pushQueueRowToXero
                 └─ resolveLineTaxType prefers fields.tax_type ─► /Invoices (per-line TaxType)
```

## Error handling / edge cases

- **Rates not synced yet** for a location → read endpoint returns `[]`, resolver
  reports `unmatched`, UI shows "sync tax rates in Settings first". Never sends a
  wrong default.
- **Sync failure** → recorded on `xero_connections.tax_rates_sync_error`, surfaced
  on the Settings card next to the button; the accounts half still succeeds/fails
  independently.
- **Ambiguous / unmatched** → no auto-send; bookkeeper picks (gate).
- **Legacy approved rows** without `tax_type` → #816 fallback in push.
- **Zero-VAT** → auto-`NONE`, not blocked.

## Testing

- **`vat.test.js`** — `resolveBillTaxType` truth table: 0%, 9%, 13.5%, 23%,
  just-inside/just-outside tolerance, ambiguous (two 23% expense rates), unmatched
  (no active expense rate), net-fallbacks (subtotal missing → line sum → total−tax),
  revenue-only rate excluded.
- **`tax-rates-sync.test.js`** — Xero `/TaxRates` → row mapping, `EffectiveRate`
  vs `TaxComponents` fallback, stale-row sweep, connection stamp on success /
  error.
- **`push-xero.test.js`** — new: `fields.tax_type` present wins for every line;
  absent → #816 fallback (existing cases stay green).
- **data-approve route** — rejects a row with no resolved `tax_type`; passes for
  a zero-VAT row.
- Full CI mirror (`npm test && lint && check:mobile-parity && check:mobile-imports
  && check:route-guards && check:guardrails`) plus `npm run build` (new route +
  migration) before the PR.

## Rollout

1. Apply migration (Supabase MCP, un1t-crm), `get_advisors`.
2. Deploy. Sync each connected location once (Stillorgan is the only live Xero
   today; the design is per-location for Hatch / CCF Autos when they connect).
3. Existing wrong bills (ROWfit 23967 + the 65 pre-F2 rows) are corrected by
   Richard in Xero / the queue — out of scope for this change.

## Register / conventions

New route registered in `src/lib/openapi.js`. No new `WEB_PERMISSIONS` key (the
selector lives inside the existing invoices-inbox surface). Migration
forward-only; `security_invoker` on any view; single permissive SELECT policy per
the RLS invariant.
