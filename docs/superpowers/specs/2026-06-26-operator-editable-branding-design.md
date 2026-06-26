# P1-3 — Operator-editable branding (de-hard-code "UN1T" / "Tesla")

**Date:** 2026-06-26 · **Status:** approved design, pre-implementation
**Source:** 2026-06-25 estate audit, cross-cutting theme #8 + roadmap row P1-3
**Invariant enforced:** *"Customer-facing copy/labels must be operator-editable (settings + default fallback), not hard-coded."*

## Problem

Server-side send paths hard-code the brand name `'UN1T'` and the car make `'Tesla'`
into **customer-facing** messages. Concretely, today:

- A CCF Autos car buyer receives WhatsApp/SMS/email signed **"UN1T"**.
- A buyer of a **non-Tesla** car receives an SMS reading **"Tesla Car Deposit"** even
  though the vehicle label in the same string is their actual car (e.g. a BMW).

This breaks correctness for CCF Autos *today* and is a prerequisite for any real second
tenant. The per-location operator-editable branding store **already exists**
(`company_settings`); the defect is that the send paths don't read it.

## What already exists (reuse, do not reinvent)

- **`company_settings`** table — `{ id, location_id, logo_url, favicon_url, company_name, updated_at, updated_by }`, one row per location, operator-editable. This is the canonical brand store.
- **`GET /api/public/branding`** (`src/app/api/public/branding/route.js`) already reads
  `company_settings.select('logo_url, favicon_url, company_name')`, optionally filtered by
  `location_id`. The login + reset-password screens consume it with the exact
  `company_name || 'UN1T'` fallback this invariant wants.
- The car side already has its own brand notion: `deposit-receipts.js:147` does
  `location?.name || 'CCF Autos'`.

So the gym-brand mechanism is built — it is simply not threaded into the server-side
agent / WhatsApp / churn send paths.

## Approach (chosen)

**Thread the existing mechanism via one server-side helper.** No new tables or columns.

Rejected alternatives:
- *Full operator-editable message-template system* (every string in a DB table) — overkill
  for P1-3; that is the `customer-comms-editable` direction, a future enhancement.
- *Org-level branding inheritance* — explicitly deferred to **P2-3** in the roadmap.

## Scope

In: **A** (gym brand name, un1t-crm) + **B** (de-Tesla car copy, un1t-crm, *excluding Xero*) + **C** (champ-app support email).
Out: Xero line-item copy (operator chose to leave accounting untouched); STOP/START ACK
(already brand-neutral); org-level inheritance (P2-3); the two latent bugs noted below.

---

## Component 1 — `src/lib/location-branding.js` (new, un1t-crm)

A single server-side resolver over `company_settings`, owned by this module and reused by
the public route.

```
getLocationBranding(db, locationId) -> { companyName, logoUrl, faviconUrl }
```

- One query: `db.from('company_settings').select('company_name, logo_url, favicon_url').eq('location_id', locationId).limit(1).single()`.
- `companyName` defaults to `'UN1T'` when the row is missing or `company_name` is null/empty.
- `logoUrl` / `faviconUrl` default to `null`.
- Defensive: `try { await … } catch` — supabase-js builders are thenables (no `.catch`);
  on any error return the defaults rather than throwing into a send path.
- **Refactor `GET /api/public/branding` to call this helper** (single source of truth).
  Preserve its existing "no `location_id` → first row" behaviour for the unauthenticated
  case by keeping that branch in the route; the helper itself always takes an explicit
  `locationId` (every server caller has one).

Unit tests: row present → `companyName` from data; row absent → `'UN1T'`; empty string →
`'UN1T'`; query throws → defaults.

## Component 2 — Class A: thread `companyName` (un1t-crm)

Each site already has the location (object or `location_id`) and a `db` client in scope.

| Site | Current | Fix |
|---|---|---|
| `src/lib/agent/auto-reply.js:291` | `businessName: 'UN1T'` (in `buildCachedSystem`, `loc` in scope) | `businessName: (await getLocationBranding(db, loc.id)).companyName` |
| `src/lib/agent/followups.js:272` | `businessName: 'UN1T'` (`composeAgentText(location, …)`) | resolve branding at the nearest scope holding `db` + `location.id`; pass `companyName` into `buildCachedSystem` |
| `src/lib/agent/prompt.js:195-196` | already `businessName \|\| 'UN1T'` | no change — receives the real value once callers pass it |
| `src/app/api/churn-radar/action/route.js:137` | `…team at UN1T — …` | `…team at ${companyName} — …` (resolve for the row's location) |
| `src/lib/churn-radar-digest.js:140` | `opts.locationName \|\| 'UN1T'` | caller passes `companyName`; keep `'UN1T'` as the last-resort default (staff-facing digest, low blast radius but cheap) |
| `src/lib/whatsapp.js:831` | `location_name = 'UN1T'` (inside `resolveTemplateVariableValues`, **no location in signature**) | see below |

**WhatsApp threading (the one non-trivial change).** `resolveTemplateVariableValues(template,
contact, variableMapping)` is sync and has no location. Add an optional 4th arg:
`resolveTemplateVariableValues(template, contact, variableMapping, opts = {})` and resolve
`location_name` to `opts.companyName || 'UN1T'`. The callers
(`buildTemplateComponents` send-time path **and** the rendered-body persist path) resolve
branding once via `getLocationBranding(db, location_id)` — `location_id` is already in scope
at every call (`broadcast.location_id`, etc.) — and pass `{ companyName }` in. Keeps the
function sync; no behavioural change when `companyName` is absent.

**Cache note (agents).** `businessName` sits in the *cached stable prefix* of
`buildCachedSystem`. Swapping the `'UN1T'` literal for a per-location `companyName` keeps the
prefix location-stable (it already varies `locationName` per location), so there is no
prompt-cache fragmentation beyond what exists today. Intentional and safe.

## Component 3 — Class B: de-Tesla, use the real vehicle (un1t-crm, **no Xero**)

No gym branding here — the fix is to use the actual car make/label plus the existing
`'CCF Autos'` / generic fallback.

| Site | Current | Fix |
|---|---|---|
| `src/app/api/cars/[id]/issue-deposit-link/route.js:119` | ``Hi …, your €${amount} Tesla Car Deposit for ${carLabel}: …`` | ``…your €${amount} deposit for ${carLabel}: …`` — `carLabel` is already `make model irish_reg`; drop the literal "Tesla" (**the real bug**) |
| `src/app/deposit/[token]/return/page.js:12` | `title: 'Tesla Car Deposit'` | `title: 'Car Deposit'` |
| `src/app/api/public/deposit/[token]/accept-and-pay/route.js:131` | `… join(' ') \|\| 'Tesla'` | fallback → `'your car'` |
| `src/app/api/cars/[id]/issue-deposit-link/route.js:113` | `… join(' ').trim() \|\| 'your Tesla'` | fallback → `'your car'` |
| `src/lib/deposit-receipts.js:135` | `… 'your Tesla'` | fallback → `'your car'` |

**Explicitly left untouched:**
- **The whole `src/lib/xero/` module** (operator decision — "leave Xero untouched"):
  `xero/invoices.js:242,271` (line descriptions) and `xero/bills-email.js:137`
  (`car.make || 'Tesla'` in the bill-forwarding email) both stay as-is.
- **`src/app/api/cars/route.js:129`** (`make: body.make || 'Tesla'`) — this is a **data
  default on car-record creation**, not customer-facing copy, and dropping it risks inserting
  null makes that downstream copy then has to handle. Outside this invariant's scope; leave it.

## Component 4 — Class C: champ-app support email (champ-app repo)

One customer-facing occurrence: `src/app/page.jsx:47` — *"…drop us a line at
hello@champfitness.ie."* champ-app has no settings table; config is env/constants.

- New `shared/brand.js` exporting `SUPPORT_EMAIL` (default `'hello@champfitness.ie'`,
  overridable via `process.env.EXPO_PUBLIC_SUPPORT_EMAIL`). `shared/` is the web↔mobile
  seam, so a future mobile screen can reuse it.
- Consume it at `src/app/page.jsx:47`.
- (`app.config.js:66` / `integrations.jsx:13` reference `app.champfitness.ie` as the **API/web
  URL** — infrastructure, not support copy — left as-is.)

---

## Out of scope — latent bugs found en route (file as separate follow-ups)

1. `src/lib/contracts-email.js:33` reads a **non-existent `company_branding` table** and
   silently falls back to null (the table is not in the DB; the real table is
   `company_settings`).
2. `src/lib/contractor-invoice-email.js:66` embeds `logo_url, company_name` off **`locations`**,
   where those columns do not exist (they live on `company_settings`) — the values come back
   undefined and fall to `|| 'UN1T'`.

Both are pre-existing and unrelated to the threading work; flag them, do not fix them here.

## Testing & delivery

- **Unit:** `getLocationBranding` (4 cases above); `resolveTemplateVariableValues` resolves
  `location_name` from `opts.companyName` and falls back to `'UN1T'`; the de-Tesla SMS body
  renders the car label without "Tesla".
- **CI mirror (all 6):** `npm test && npm run lint && npm run check:mobile-parity &&
  npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails`.
- **`next build`** (import/route changes; Vercel PR check is the real gate).
- **Delivery — two PRs:**
  - **un1t-crm** — Components 1–3 on branch `p1-3-operator-editable-branding` (off fresh `origin/main`).
  - **champ-app** — Component 4 (tiny) on its own branch.

## Success criteria

- A non-Tesla car buyer's deposit SMS reads "…deposit for {their actual car}…" with no "Tesla".
- Mia / WhatsApp / churn copy for a location renders that location's `company_settings.company_name`
  (and `'UN1T'` only when unset) — verifiable by setting `company_name` for the Stillorgan row
  and confirming the agent system prompt + a WhatsApp `location_name` substitution reflect it.
- champ-app support email comes from `SUPPORT_EMAIL`, defaulting unchanged to `hello@champfitness.ie`.
- No new migrations; Xero untouched; the two latent bugs filed but not fixed.
