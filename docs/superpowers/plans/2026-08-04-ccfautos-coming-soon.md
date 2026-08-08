# CCF Autos Coming-Soon Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a coming-soon landing page with enquiry capture at ccfautos.com via the CRM's existing multi-brand proxy.

**Architecture:** One new brand entry (`ccfautos-web`) routes the hostname to a self-contained dark-showroom page at `/ccf`; its contact form POSTs to `/api/public/ccf-enquiry`, which rate-limits and inserts into a new `car_enquiries` table (mig 479). Follows the `un1t-marketing` brand pattern and the `/api/public/leads` route pattern (rate-limit, **no honeypot** — autofill of hidden fields silently dropped real signups there; spec updated accordingly).

**Tech Stack:** Next.js 16 App Router · Tailwind 3.4 + scoped styles · Zod v4 · Supabase (service-role insert) · Vitest.

**Worktree:** `~/code/un1t-crm-ccf-landing`, branch `ccf-coming-soon-site` off fresh `origin/main`.

---

### Task 1: Migration 479 — `car_enquiries`

**Files:**
- Create: `supabase/migrations/479_car_enquiries.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- 479 — car_enquiries: public enquiries from the ccfautos.com
-- coming-soon site (CCF-WEB.1, spec 2026-08-04). Inserted ONLY by the
-- service-role route /api/public/ccf-enquiry; staff read arrives with
-- the future cars-section UI (service-role routes too). RLS is enabled
-- with NO policies on purpose: anon/authenticated get nothing — the
-- CRM's Supabase project is shared with the customer champ-app, so an
-- authenticated-wide SELECT policy would let gym members read car
-- enquiries via direct supabase-js.

create table car_enquiries (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  phone text not null,
  email text,
  message text,
  source text not null default 'ccfautos.com',
  status text not null default 'new'
);

alter table car_enquiries enable row level security;
```

- [ ] **Step 2: Apply via Supabase MCP** — `apply_migration` against project `iyvtbjjxdggiadzwwvdj` (confirm via `list_projects` first; NOT the sentinel project), name `car_enquiries`, same SQL.

- [ ] **Step 3: Run `get_advisors` (type=security)** — expect no new ERROR-level findings (an INFO "RLS enabled no policy" note is the deliberate posture above).

- [ ] **Step 4: Commit** — `git add supabase/migrations/479_car_enquiries.sql && git commit -m "CCF-WEB.1 — car_enquiries table (mig 479)"`

### Task 2: Brand entry (TDD)

**Files:**
- Modify: `src/lib/brands.js` (append to `BRANDS` before the "Adding another brand" comment)
- Test: `src/lib/brands.test.js`

- [ ] **Step 1: Write failing tests** — append to `src/lib/brands.test.js`:

```js
describe('ccfautos-web brand', () => {
  const brand = BRANDS.find((b) => b.id === 'ccfautos-web')

  it('exists and covers apex + www', () => {
    expect(brand).toBeTruthy()
    expect(brand.hostnames).toContain('ccfautos.com')
    expect(brand.hostnames).toContain('www.ccfautos.com')
  })

  it('resolves from the hostname, with and without a port', () => {
    expect(resolveBrand('ccfautos.com')).toBe(brand)
    expect(resolveBrand('www.ccfautos.com:443')).toBe(brand)
  })

  it('rewrites root and strays to the landing page', () => {
    expect(brand.rootHandler).toBe('rewrite')
    expect(brand.rootRewriteTo).toBe('/ccf')
    expect(brand.fallbackHandler).toBe('rewrite')
    expect(brand.fallbackRewriteTo).toBe('/ccf')
  })

  it('allows ONLY the landing page + its enquiry API', () => {
    expect(brand.allowedPaths).toEqual(['/ccf', '/api/public/ccf-enquiry'])
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/lib/brands.test.js` → the new describe fails (`brand` undefined).

- [ ] **Step 3: Add the registry entry** in `src/lib/brands.js`, after the `un1t-hosts` entry:

```js
  // ─── CCF Autos — public marketing site (coming soon) ───────────
  // Apex + www. "/" rewrites to /ccf (the coming-soon landing page,
  // src/app/ccf) so the URL bar stays clean. Strays rewrite back to
  // the landing rather than 404 — public marketing host, the
  // un1t-marketing pattern, not the buyer-payment 'reject' pattern.
  // Only the landing + its enquiry API resolve on this hostname, so
  // nothing hints at the CRM. In-code (not a tenant_domains row)
  // because it's deployment-critical brand infrastructure like the
  // pay subdomain above. (CCF-WEB.1)
  {
    id: 'ccfautos-web',
    description: 'CCF Autos public marketing site (apex + www)',
    hostnames: (process.env.CCF_MARKETING_HOSTNAMES || 'ccfautos.com,www.ccfautos.com')
      .split(',').map((s) => s.trim()).filter(Boolean),
    allowedPaths: [
      '/ccf',                    // coming-soon landing page (src/app/ccf)
      '/api/public/ccf-enquiry', // contact-form capture
    ],
    rootHandler: 'rewrite',
    rootRewriteTo: '/ccf',
    fallbackHandler: 'rewrite',
    fallbackRewriteTo: '/ccf',
  },
```

- [ ] **Step 4: Run tests** — `npx vitest run src/lib/brands.test.js` → PASS (including the pre-existing shape tests, which validate the new entry too).

- [ ] **Step 5: Commit** — `git commit -am "CCF-WEB.1 — ccfautos-web brand entry"`

### Task 3: The other two public-path gates

**Files:**
- Modify: `src/proxy.js:169` (publicPaths array — add `'/ccf'`; `/api/public/` already covers the API)
- Modify: `src/components/AppShell.jsx:46` (PUBLIC_PATHS — add `'/ccf'`)

- [ ] **Step 1: Add `'/ccf'`** to both arrays (append after `'/technical'` in each to keep the marketing-page grouping).
- [ ] **Step 2: Run the proxy tests** — `npx vitest run src/proxy.test.js` → PASS.
- [ ] **Step 3: Commit** — `git commit -am "CCF-WEB.1 — /ccf on proxy + AppShell public paths"`

### Task 4: Enquiry schema + API route (TDD)

**Files:**
- Modify: `src/lib/schemas.js` (new `ccfEnquirySchema`, reusing the shared `email` block)
- Create: `src/app/api/public/ccf-enquiry/route.js`
- Test: `src/app/api/public/ccf-enquiry/route.test.js`

- [ ] **Step 1: Write failing route tests**

```js
// Route tests for the public ccfautos.com enquiry capture (CCF-WEB.1).
// Contract: validation 400s before any DB touch, rate limiting 429s
// before the insert, inserts normalise empty optionals to null, and a
// DB failure 500s with the phone number as the fallback contact.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({ createServerClient: vi.fn() }))
vi.mock('@/lib/rate-limit', () => ({
  getClientIp: vi.fn(() => '1.2.3.4'),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(() => Response.json({ success: false }, { status: 429 })),
}))

import { POST } from './route.js'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit } from '@/lib/rate-limit'

function makeDb({ insertError = null } = {}) {
  const inserts = []
  return {
    from: (table) => ({
      insert: async (row) => { inserts.push({ table, row }); return { error: insertError } },
    }),
    _inserts: inserts,
  }
}
const makeReq = (body) => ({ json: async () => body, headers: { get: () => null } })

beforeEach(() => {
  vi.clearAllMocks()
  checkRateLimit.mockResolvedValue({ allowed: true })
})

describe('POST /api/public/ccf-enquiry', () => {
  it('missing name → 400 before any DB', async () => {
    const res = await POST(makeReq({ phone: '0868225779' }))
    expect(res.status).toBe(400)
    expect(createServerClient).not.toHaveBeenCalled()
  })

  it('rate limited → 429, no insert', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    checkRateLimit.mockResolvedValue({ allowed: false })
    const res = await POST(makeReq({ name: 'Aoife', phone: '0861234567' }))
    expect(res.status).toBe(429)
    expect(db._inserts).toHaveLength(0)
  })

  it('valid enquiry inserts, empty optionals become null', async () => {
    const db = makeDb()
    createServerClient.mockReturnValue(db)
    const res = await POST(makeReq({ name: 'Aoife', phone: '0861234567', email: '', message: '' }))
    expect(res.status).toBe(200)
    expect(db._inserts).toEqual([
      { table: 'car_enquiries', row: { name: 'Aoife', phone: '0861234567', email: null, message: null } },
    ])
  })

  it('insert failure → 500 with the phone number as fallback', async () => {
    createServerClient.mockReturnValue(makeDb({ insertError: { message: 'boom' } }))
    const res = await POST(makeReq({ name: 'Aoife', phone: '0861234567' }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('086 822 5779')
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run 'src/app/api/public/ccf-enquiry/route.test.js'` → FAIL (route module missing).

- [ ] **Step 3: Add the schema** to `src/lib/schemas.js` (near the other standalone schemas; reuse the shared `email` block defined at the top of the file):

```js
// CCF-WEB.1 — public enquiry from the ccfautos.com coming-soon page.
// email/message accept '' so the form can send its fields verbatim;
// the route normalises '' → null before insert.
export const ccfEnquirySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  phone: z.string().trim().min(5, 'Phone is required').max(40),
  email: email.or(z.literal('')).optional(),
  message: z.string().trim().max(2000).optional(),
})
```

- [ ] **Step 4: Write the route** — `src/app/api/public/ccf-enquiry/route.js`:

```js
// POST /api/public/ccf-enquiry — contact-form capture for the
// ccfautos.com coming-soon page (CCF-WEB.1, spec 2026-08-04).
//
// Anonymous by design (/api/public/** is route-guards-exempt); the
// abuse guard is the rate limit — deliberately NO honeypot, because
// browser autofill of hidden fields silently dropped real signups on
// /api/public/leads. Writes land in car_enquiries (mig 479), read
// later by the CRM cars section via service-role routes.

import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { checkRateLimit, getClientIp, rateLimitResponse } from '@/lib/rate-limit'
import { validateBody } from '@/lib/validate'
import { ccfEnquirySchema } from '@/lib/schemas'

export const runtime = 'nodejs'

export async function POST(request) {
  const validation = await validateBody(request, ccfEnquirySchema)
  if (!validation.ok) return validation.response
  const { name, phone, email, message } = validation.data

  const db = createServerClient()
  const ip = getClientIp(request)
  const limit = await checkRateLimit(db, `ccf-enquiry:${ip}`, { max: 5, windowMs: 15 * 60_000 })
  if (!limit.allowed) {
    return rateLimitResponse(limit, 'Too many enquiries from this connection. Please call us on 086 822 5779 instead.')
  }

  const { error } = await db.from('car_enquiries').insert({
    name,
    phone,
    email: email || null,
    message: message || null,
  })
  if (error) {
    return NextResponse.json(
      { success: false, error: 'Could not send your enquiry. Please call us on 086 822 5779.' },
      { status: 500 }
    )
  }
  return NextResponse.json({ success: true })
}
```

- [ ] **Step 5: Run tests** — `npx vitest run 'src/app/api/public/ccf-enquiry/route.test.js'` → PASS. (If `validateBody`'s import path or result shape differs from `{ ok, response, data }`, mirror `/api/public/leads/route.js` exactly.)

- [ ] **Step 6: Commit** — `git add -A && git commit -m "CCF-WEB.1 — public ccf-enquiry route + schema"`

### Task 5: Landing page

**Files:**
- Create: `src/app/ccf/page.js` (server component: metadata, fonts, layout, styles)
- Create: `src/app/ccf/EnquiryForm.jsx` (client component: the form)

Design: dark premium showroom. Barlow Condensed display over Barlow body (`next/font/google`, self-hosted at build — first use in this repo, deliberate). Near-black `#0b0b0d`, champagne accent `#c8a860`, showroom-spotlight radial glow, plate-style eircode chip, staggered fade-up reveal honouring `prefers-reduced-motion`. Self-contained — no CRM chrome, no `un1t-*` tokens (light-theme palette). Full code is written at execution against this brief; the structural contract:

- [ ] **Step 1: `EnquiryForm.jsx`** — `'use client'`; fields name (required), phone (required), email, message; POSTs JSON to `/api/public/ccf-enquiry`; disabled/sending state; success replaces the card content ("Thanks — we'll be in touch."); failure shows the API error (which carries the phone number) or a generic line with the phone number. Non-submit buttons: none (single submit button, `type="submit"`).
- [ ] **Step 2: `page.js`** — `metadata` export (title `CCF Autos — Quality Used Cars, Stillorgan · Coming Soon`, description with address + phone); header (wordmark + tap-to-call phone); hero (eyebrow `STILLORGAN · DUBLIN`, display `CCF AUTOS`, `COMING SOON` accent line, one-liner); info row (Visit / Call / Opening); enquiry form section ("Looking for a particular car?"); footer with full address. Phone renders `086 822 5779`, links `tel:+353868225779`. Address: First Floor Unit, Stillorgan Village Centre, Lower Kilmacud Road, Co. Dublin, A94 AC67, with a Google Maps link.
- [ ] **Step 3: Visual verify** — `npm run dev`, open `http://localhost:3000/ccf`, screenshot desktop + mobile widths; check form success + error states end-to-end against the real route (dev DB insert).
- [ ] **Step 4: Commit** — `git add src/app/ccf && git commit -m "CCF-WEB.1 — /ccf coming-soon landing page"`

### Task 6: OpenAPI registration

**Files:**
- Modify: `src/lib/openapi.js` (after the `/api/public/leads` registration)

- [ ] **Step 1: Register the route** (import `ccfEnquirySchema` from `./schemas` at the top with the other schema imports):

```js
registry.registerPath({
  method: 'post',
  path: '/api/public/ccf-enquiry',
  tags: ['Public'],
  summary: 'CCF Autos coming-soon page enquiry capture',
  description: 'Anonymous. Rate-limited to 5 requests per IP per 15 min. Inserts into car_enquiries.',
  request: { body: { content: { 'application/json': { schema: ccfEnquirySchema.extend({}).openapi('CcfEnquiry') } } } },
  responses: {
    200: { description: 'Enquiry captured' },
    400: { description: 'Validation failed', content: { 'application/json': { schema: ErrorResponse } } },
    429: { description: 'Rate limited', content: { 'application/json': { schema: ErrorResponse } } },
  },
})
```

- [ ] **Step 2: Commit** — `git commit -am "CCF-WEB.1 — openapi registration for ccf-enquiry"`

### Task 7: CI mirror, build, changelog, PR

- [ ] **Step 1: Full CI mirror** — `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails` → all green.
- [ ] **Step 2: `npm run build`** — mandatory here (new page + route + first `next/font` usage = new import resolution).
- [ ] **Step 3: Changelog** — add a CCF-WEB.1 entry to `docs/CHANGELOG.md` (what shipped, mig 479, go-live steps: Vercel domains + DNS).
- [ ] **Step 4: Push + PR** — `git push -u origin HEAD && gh pr create --base main --fill` — pushing is NOT shipping; report the PR URL.

## Self-review notes

- Spec coverage: brand entry (T2), three allowlists (T2+T3), page (T5), API (T4), migration (T1), openapi (T6), tests throughout, go-live documented (T7 changelog). Spec's honeypot replaced by rate-limit-only — spec updated to match (repo lesson).
- `car_enquiries` has no anon INSERT policy on purpose: the insert path is the service-role route, so RLS-with-no-policies is the tightest posture in a Supabase project shared with the customer app.
- Mobile parity: no new `WEB_PERMISSIONS` key (public page, no staff surface) — parity linter unaffected.
