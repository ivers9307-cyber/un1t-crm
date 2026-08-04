# CCF Autos coming-soon site (ccfautos.com) — design

**Date:** 2026-08-04 · **Status:** approved by Richard (chat) · **Scope:** one landing page + enquiry capture

## Goal

A public coming-soon page at `ccfautos.com` for information purposes: brand presence, address, phone, and a working contact form. Later the same hostname will host the car inventory driven by the CRM's `cars` section; this design deliberately lays only the routing + enquiry rails that future work will reuse.

## Decisions (made with Richard, 2026-08-04)

1. **In-CRM brand entry** — the site rides the existing multi-brand proxy (same rails as `pay.ccfautos.com` / `un1tdublin.com`), not a standalone repo. Same Vercel deployment, same Supabase project, so the future inventory pages read `cars` directly.
2. **Enquiries stored in the CRM** — new `car_enquiries` table; no email notification in v1.
3. **Design: dark premium showroom** — near-black, warm metallic accent, large confident type.
4. **Copy is hard-coded in v1** — deliberate, approved deviation from the operator-editable-copy invariant because the page exists to be replaced by the real site; copy becomes operator-editable when the inventory site ships.

## Components

### 1. Brand registry entry (`src/lib/brands.js`)

New entry `ccfautos-web`:
- `hostnames`: `ccfautos.com,www.ccfautos.com`, env-overridable via `CCF_MARKETING_HOSTNAMES` (same pattern as the other entries).
- `rootHandler: 'rewrite'` → `/ccf` — the URL bar stays `ccfautos.com/`.
- `fallbackHandler: 'rewrite'` → `/ccf` — strays land on the page, not a 404 (the `un1t-marketing` pattern; this is a public marketing host, not a buyer-payment host).
- `allowedPaths`: `['/ccf', '/api/public/ccf-enquiry']` — nothing else resolves on this hostname, so the CRM's existence isn't hinted.

### 2. Landing page (`src/app/ccf/page.js`)

Public page outside any auth-gated segment. Added to **all three** allowlists (proxy publicPaths, brand entry, AppShell publicPaths) per the legal-pages lesson.

Content (single scroll, mobile-first):
- CCF Autos wordmark + "Coming soon" hero, one-liner: quality used cars, Stillorgan.
- Phone `086 822 5779` as a `tel:+353868225779` tap-to-call link.
- Address block: First Floor Unit, Stillorgan Village Centre, Lower Kilmacud Road, Co. Dublin, A94 AC67 (with a Google Maps link).
- Contact form: name (required), phone (required), email (optional), message (optional). Client component; POSTs to the enquiry API; inline success state ("Thanks — we'll be in touch") and inline error state with the phone number as fallback. **No honeypot** — the repo already learned (on `/api/public/leads`) that browser autofill of hidden fields silently drops real signups; rate limiting is the abuse guard.

Design: dark premium showroom. Near-black background, warm metallic/champagne accent, large display type. No CRM chrome, no UN1T tokens leakage (the `un1t-*` palette is a light theme — this page uses its own scoped styles). Distinctive, not generic-AI (Richard's design bar).

### 3. Enquiry API (`POST /api/public/ccf-enquiry`)

- Zod validation via `validateBody` (name + phone required, email optional/format-checked, message ≤ 2000 chars).
- Inserts into `car_enquiries` via `createServerClient()`.
- Standard `{ success, data?, error?, issues? }` shape. Registered in `src/lib/openapi.js`.
- Genuinely public: added to the `check:route-guards` EXEMPT map with reason.
- Abuse posture: IP rate limit via the existing `checkRateLimit` helper (5 per 15 min) + payload-size caps.

### 4. Migration — `car_enquiries`

Forward-only, applied via Supabase MCP against `iyvtbjjxdggiadzwwvdj`, file committed to `supabase/migrations/`, `get_advisors` (security) after DDL, applied **before** the code deploys.

Columns: `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()`, `name text not null`, `phone text not null`, `email text`, `message text`, `source text not null default 'ccfautos.com'`, `status text not null default 'new'`.

RLS enabled with **no policies** — the tightest posture: the Supabase project is shared with the customer champ-app, so an `authenticated`-wide SELECT policy would let gym members read car enquiries via direct supabase-js. Inserts come through the service-role route (RLS-bypassing); the future staff UI reads via service-role routes too.

## Error handling

- Form: client-side required checks; server errors surface inline with the phone number as fallback contact.
- API: validation failures return `issues`; insert failure returns 500 `{ success: false }` — no partial states to reconcile.

## Testing

- Vitest: brand-resolution cases in the existing proxy/brands test suites (ccfautos.com root rewrite, fallback rewrite, allowlist isolation); enquiry route validation + honeypot behaviour (mocked DB, matching existing route-test patterns).
- `npm run build` locally (new page + route = new imports).
- Full CI mirror before push.

## Go-live (manual, after merge)

1. Migration already applied (step above).
2. Vercel: add `ccfautos.com` + `www.ccfautos.com` domains to the CRM project.
3. DNS: point apex + www at Vercel (same as pay.ccfautos.com was done).

## Out of scope (v1)

Inventory pages, operator-editable copy, email notification on enquiry, staff UI for reading enquiries (table is queryable; UI lands with the inventory work), analytics.
