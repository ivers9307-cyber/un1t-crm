# WhatsApp Tech Provider (Embedded Signup v4) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Self-serve "Connect WhatsApp" (Embedded Signup v4) in the CRM: Meta dialog → code exchange → business token stored in `whatsapp_numbers` → app subscribed to the WABA → number live in existing send/receive machinery — plus webhook hardening so unknown numbers can't leak into UN1T's inbox.

**Architecture:** Per approved spec `docs/WHATSAPP_TECH_PROVIDER_DESIGN_2026-07.md`. Option A: extend `whatsapp_numbers` (no new tables). New location-scoped route orchestrates the Meta calls; pure logic lives in `src/lib/whatsapp-embedded-signup.js` (testable with `globalThis.fetch` swap, the repo's pattern). Frontend is a new card in `WhatsAppIntegrationTab`. **The live Stillorgan env-token path is never touched.**

**Tech Stack:** Next.js 16 App Router route handlers, Supabase (service-role client), Zod via `validateBody`, Vitest (pure-lib, no DB), Facebook JS SDK (client-side only, loaded on demand), Graph API v21.0 (`META_API_URL` from `src/lib/whatsapp-config.js`).

**Worktree:** `~/code/un1t-crm-watech`, branch `whatsapp-tech-provider` (already created, spec committed as WA-TECHPROV.0).

**Conventions that apply here** (from CLAUDE.md — executor must follow):
- Migrations forward-only, applied via Supabase MCP `apply_migration` against project `iyvtbjjxdggiadzwwvdj` (NOT the sentinel project). `get_advisors` (security) after DDL.
- supabase-js builders are thenables: `try/await/catch`, never `.catch()`. Always `await` inserts/updates.
- Response shape `{ success, data?, error? }`. Detail conflicts return explicit statuses; no silent env fallbacks in mutation paths.
- No new `console.log` in prod paths (`console.warn`/`console.error` OK).
- zsh: bracketed route paths (`[id]`) are globs — single-quote paths in git/shell commands.

---

### Task 1: Migration 405 — embedded-signup columns

**Files:**
- Create: `supabase/migrations/405_whatsapp_numbers_embedded_signup.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- 405 — WA-TECHPROV.1: Embedded Signup support on whatsapp_numbers.
--
-- Additive only. Existing rows (manually-entered System User tokens)
-- keep their meaning via the defaults. See
-- docs/WHATSAPP_TECH_PROVIDER_DESIGN_2026-07.md §4.3.

ALTER TABLE public.whatsapp_numbers
  ADD COLUMN IF NOT EXISTS token_type TEXT NOT NULL DEFAULT 'system_user'
    CHECK (token_type IN ('system_user', 'business')),
  ADD COLUMN IF NOT EXISTS connected_via TEXT NOT NULL DEFAULT 'manual'
    CHECK (connected_via IN ('manual', 'embedded_signup')),
  ADD COLUMN IF NOT EXISTS signup_meta JSONB;

COMMENT ON COLUMN public.whatsapp_numbers.token_type IS
  'system_user = manually-minted permanent token; business = Embedded Signup business token (WA-TECHPROV)';
COMMENT ON COLUMN public.whatsapp_numbers.connected_via IS
  'manual = operator-entered row; embedded_signup = created by the ES v4 flow (WA-TECHPROV)';
COMMENT ON COLUMN public.whatsapp_numbers.signup_meta IS
  'Raw ES session payload, probe snapshot, generated 2FA PIN (WA-TECHPROV)';
```

- [ ] **Step 2: Apply via Supabase MCP**

Use `mcp__…__apply_migration` with name `whatsapp_numbers_embedded_signup` and the SQL above, against the **un1t-crm** project (`iyvtbjjxdggiadzwwvdj` — confirm with `list_projects` first; NOT sentinel `tpttqakxmyxrwnqjepfm`).

- [ ] **Step 3: Verify columns exist in prod** (memory rule: never drive a column you haven't seen in `information_schema`)

Run via `execute_sql`:
```sql
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'whatsapp_numbers'
  AND column_name IN ('token_type', 'connected_via', 'signup_meta');
```
Expected: 3 rows.

- [ ] **Step 4: Run security advisors**

`get_advisors` (type=security). Expected: no NEW findings (the 2 known intentional SECURITY DEFINER warnings may appear — those are documented as intentional, do not "fix" them).

- [ ] **Step 5: Commit**

```bash
cd ~/code/un1t-crm-watech
git add supabase/migrations/405_whatsapp_numbers_embedded_signup.sql
git commit -m "WA-TECHPROV.1 — mig 405: token_type/connected_via/signup_meta on whatsapp_numbers"
```

---

### Task 2: Lib — `whatsapp-embedded-signup.js` (pure helpers, TDD)

**Files:**
- Create: `src/lib/whatsapp-embedded-signup.js`
- Test: `src/lib/whatsapp-embedded-signup.test.js`

Mirrors `src/lib/whatsapp-number-health.js`: module-level `fetch`, Meta errors re-thrown with `metaCode`/`metaType`; tests swap `globalThis.fetch` (see `whatsapp-number-health.test.js:134` for the exact pattern).

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/whatsapp-embedded-signup.test.js
import { describe, it, expect, afterEach } from 'vitest'
import {
  exchangeCodeForBusinessToken, subscribeAppToWaba, probeNumber,
  needsRegistration, generatePin, registerNumber, planPersistence,
} from './whatsapp-embedded-signup.js'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

function mockFetch(json) {
  const calls = []
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return { json: async () => json } }
  return calls
}

describe('exchangeCodeForBusinessToken', () => {
  it('returns the business token on success', async () => {
    const calls = mockFetch({ access_token: 'BIZ_TOKEN', token_type: 'bearer' })
    const token = await exchangeCodeForBusinessToken({ code: 'abc', appId: '123', appSecret: 'sec' })
    expect(token).toBe('BIZ_TOKEN')
    expect(calls[0].url).toContain('/oauth/access_token')
    expect(calls[0].url).toContain('client_id=123')
    expect(calls[0].url).toContain('code=abc')
  })
  it('throws with meta metadata on error', async () => {
    mockFetch({ error: { message: 'bad code', code: 100, type: 'OAuthException' } })
    await expect(exchangeCodeForBusinessToken({ code: 'x', appId: '1', appSecret: 's' }))
      .rejects.toMatchObject({ message: 'bad code', metaCode: 100 })
  })
  it('throws when the response has no token and no error (defensive)', async () => {
    mockFetch({})
    await expect(exchangeCodeForBusinessToken({ code: 'x', appId: '1', appSecret: 's' }))
      .rejects.toThrow(/exchange failed/i)
  })
})

describe('subscribeAppToWaba', () => {
  it('POSTs to /{waba}/subscribed_apps with the business token', async () => {
    const calls = mockFetch({ success: true })
    await subscribeAppToWaba({ wabaId: '555', token: 'T' })
    expect(calls[0].url).toContain('/555/subscribed_apps')
    expect(calls[0].opts.method).toBe('POST')
    expect(calls[0].opts.headers.Authorization).toBe('Bearer T')
  })
  it('throws on error payloads', async () => {
    mockFetch({ error: { message: 'no perm', code: 200 } })
    await expect(subscribeAppToWaba({ wabaId: '5', token: 'T' })).rejects.toMatchObject({ metaCode: 200 })
  })
})

describe('probeNumber + needsRegistration', () => {
  it('already-registered Cloud API number needs no registration', async () => {
    mockFetch({ status: 'CONNECTED', platform_type: 'CLOUD_API', display_phone_number: '+353 1 234 5678', verified_name: 'UN1T Hatch' })
    const probe = await probeNumber({ phoneNumberId: '999', token: 'T' })
    expect(needsRegistration(probe)).toBe(false)
  })
  it('fresh ES number (NOT_APPLICABLE platform) needs registration', () => {
    expect(needsRegistration({ status: 'PENDING', platform_type: 'NOT_APPLICABLE' })).toBe(true)
  })
  it('missing/odd probe data defaults to needing registration', () => {
    expect(needsRegistration(null)).toBe(true)
    expect(needsRegistration({})).toBe(true)
  })
})

describe('generatePin', () => {
  it('returns a 6-digit numeric string', () => {
    for (let i = 0; i < 20; i++) expect(generatePin()).toMatch(/^\d{6}$/)
  })
})

describe('registerNumber', () => {
  it('POSTs register with messaging_product + pin', async () => {
    const calls = mockFetch({ success: true })
    await registerNumber({ phoneNumberId: '999', token: 'T', pin: '123456' })
    expect(calls[0].url).toContain('/999/register')
    expect(JSON.parse(calls[0].opts.body)).toEqual({ messaging_product: 'whatsapp', pin: '123456' })
  })
  it('surfaces the register rate-limit error verbatim', async () => {
    mockFetch({ error: { message: 'Too many register attempts', code: 133016 } })
    await expect(registerNumber({ phoneNumberId: '9', token: 'T', pin: '000000' }))
      .rejects.toMatchObject({ metaCode: 133016 })
  })
})

describe('planPersistence', () => {
  it('no existing row → insert', () => {
    expect(planPersistence({ existingRow: null, locationId: 'L1' })).toEqual({ action: 'insert' })
  })
  it('existing row in the same location → update (reconnect refresh)', () => {
    expect(planPersistence({ existingRow: { id: 'row1', location_id: 'L1' }, locationId: 'L1' }))
      .toEqual({ action: 'update', id: 'row1' })
  })
  it('existing row owned by ANOTHER location → conflict, never reassign', () => {
    expect(planPersistence({ existingRow: { id: 'row1', location_id: 'L2' }, locationId: 'L1' }))
      .toEqual({ action: 'conflict', owningLocationId: 'L2' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
cd ~/code/un1t-crm-watech && npx vitest run src/lib/whatsapp-embedded-signup.test.js
```
Expected: FAIL — cannot resolve `./whatsapp-embedded-signup.js`.

- [ ] **Step 3: Implement the lib**

```js
// src/lib/whatsapp-embedded-signup.js
//
// WA-TECHPROV.2 — Embedded Signup v4 server-side helpers.
//
// Pure Graph-API wrappers + pure decision functions for the
// exchange route (src/app/api/locations/[id]/whatsapp/embedded-signup).
// Design: docs/WHATSAPP_TECH_PROVIDER_DESIGN_2026-07.md §4.2.
// Meta error style mirrors whatsapp-number-health.js (metaCode/metaType).

import { META_API_URL } from './whatsapp-config'

function metaError(json, fallback) {
  const err = new Error(json?.error?.message || fallback)
  err.metaCode = json?.error?.code ?? null
  err.metaType = json?.error?.type || null
  return err
}

/**
 * ES v4 step 1 — exchange the dialog's response code for a
 * long-lived business token (server-side only; needs the app secret).
 */
export async function exchangeCodeForBusinessToken({ code, appId, appSecret }) {
  const url = `${META_API_URL}/oauth/access_token` +
    `?client_id=${encodeURIComponent(appId)}` +
    `&client_secret=${encodeURIComponent(appSecret)}` +
    `&code=${encodeURIComponent(code)}`
  const res = await fetch(url)
  const json = await res.json()
  if (json.error || !json.access_token) throw metaError(json, 'Embedded Signup code exchange failed')
  return json.access_token
}

/**
 * ES v4 step 2 — subscribe our app to the client WABA so its
 * webhooks flow to /api/webhooks/whatsapp.
 */
export async function subscribeAppToWaba({ wabaId, token }) {
  const res = await fetch(`${META_API_URL}/${wabaId}/subscribed_apps`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
  const json = await res.json()
  if (json.error || !json.success) throw metaError(json, 'WABA webhook subscription failed')
  return true
}

/** Probe registration state before calling /register (10-per-72h limit). */
export async function probeNumber({ phoneNumberId, token }) {
  const res = await fetch(
    `${META_API_URL}/${phoneNumberId}?fields=status,platform_type,display_phone_number,verified_name`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  const json = await res.json()
  if (json.error) throw metaError(json, 'Phone number probe failed')
  return json
}

/** Registered iff already CONNECTED on Cloud API; anything else registers. */
export function needsRegistration(probe) {
  return !(probe?.platform_type === 'CLOUD_API' && probe?.status === 'CONNECTED')
}

/** 6-digit two-step PIN for /register; persisted in signup_meta. */
export function generatePin() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

export async function registerNumber({ phoneNumberId, token, pin }) {
  const res = await fetch(`${META_API_URL}/${phoneNumberId}/register`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
  })
  const json = await res.json()
  if (json.error || !json.success) throw metaError(json, 'Phone number registration failed')
  return true
}

/**
 * Insert vs token-refresh vs conflict, keyed on the globally-unique
 * phone_number_id. A number owned by a DIFFERENT location is a
 * conflict surfaced to the operator — never silently reassigned.
 */
export function planPersistence({ existingRow, locationId }) {
  if (!existingRow) return { action: 'insert' }
  if (existingRow.location_id === locationId) return { action: 'update', id: existingRow.id }
  return { action: 'conflict', owningLocationId: existingRow.location_id }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
npx vitest run src/lib/whatsapp-embedded-signup.test.js
```
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/whatsapp-embedded-signup.js src/lib/whatsapp-embedded-signup.test.js
git commit -m "WA-TECHPROV.2 — embedded-signup lib: exchange/subscribe/probe/register + persistence planner"
```

---

### Task 3: Shared row shape + exchange route

**Files:**
- Create: `src/lib/whatsapp-numbers-shape.js` (extract `redactToken`/`publicShape` — DRY with the CRUD route)
- Modify: `src/app/api/locations/[id]/whatsapp/numbers/route.js` and `src/app/api/locations/[id]/whatsapp/numbers/[numberId]/route.js` (import the extracted helpers, delete local copies)
- Create: `src/app/api/locations/[id]/whatsapp/embedded-signup/route.js`
- Test: `src/lib/whatsapp-numbers-shape.test.js`

- [ ] **Step 1: Write the failing shape test**

```js
// src/lib/whatsapp-numbers-shape.test.js
import { describe, it, expect } from 'vitest'
import { redactToken, publicShape } from './whatsapp-numbers-shape.js'

describe('redactToken', () => {
  it('shows only the last 6 chars', () => {
    expect(redactToken('EAAG1234567890abcdef')).toBe('••••abcdef')
  })
  it('fully masks short/absent tokens', () => {
    expect(redactToken('short')).toBe('••••')
    expect(redactToken(null)).toBe(null)
  })
})

describe('publicShape', () => {
  it('never leaks access_token or signup_meta (holds the 2FA PIN)', () => {
    const shaped = publicShape({
      id: 'r1', location_id: 'L1', label: 'x', phone_number_id: '1',
      access_token: 'EAAGtechprovSECRETzz',           // 20 chars → redacts to last 6
      signup_meta: { pin: '123456' }, token_type: 'business', connected_via: 'embedded_signup',
      business_account_id: 'w', app_id: 'a', display_phone: 'd', source: 'cloud_api',
      is_default: true, is_active: true, created_at: 'c', updated_at: 'u',
    })
    expect(JSON.stringify(shaped)).not.toContain('EAAGtechprovSECRETzz')
    expect(JSON.stringify(shaped)).not.toContain('123456')
    expect(shaped.access_token_redacted).toBe('••••CRETzz')
    expect(shaped.token_type).toBe('business')
    expect(shaped.connected_via).toBe('embedded_signup')
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/lib/whatsapp-numbers-shape.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create the shape lib**

Move `redactToken` + `publicShape` out of `src/app/api/locations/[id]/whatsapp/numbers/route.js` verbatim into the new lib, extending `publicShape` with the two new safe columns:

```js
// src/lib/whatsapp-numbers-shape.js
//
// WA-TECHPROV.3 — shared public projection of whatsapp_numbers rows.
// The full access_token (and signup_meta, which carries the 2FA PIN)
// must never reach the browser; every route that returns rows uses this.

export function redactToken(token) {
  if (!token || typeof token !== 'string') return null
  if (token.length <= 8) return '••••'
  return `••••${token.slice(-6)}`
}

export function publicShape(row) {
  return {
    id: row.id,
    location_id: row.location_id,
    label: row.label,
    phone_number_id: row.phone_number_id,
    business_account_id: row.business_account_id,
    app_id: row.app_id,
    display_phone: row.display_phone,
    source: row.source,
    token_type: row.token_type,
    connected_via: row.connected_via,
    is_default: row.is_default,
    is_active: row.is_active,
    access_token_redacted: redactToken(row.access_token),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}
```

Then in BOTH numbers CRUD routes: delete the local `redactToken`/`publicShape` definitions and add
`import { publicShape } from '@/lib/whatsapp-numbers-shape'` (also `redactToken` if referenced directly).

- [ ] **Step 4: Run shape test + existing suite slice to verify pass and no regression**

```bash
npx vitest run src/lib/whatsapp-numbers-shape.test.js && npx vitest run src/lib/whatsapp-config.test.js
```
Expected: PASS.

- [ ] **Step 5: Create the exchange route**

```js
// src/app/api/locations/[id]/whatsapp/embedded-signup/route.js
//
// WA-TECHPROV.3 — Embedded Signup v4 exchange, location-scoped.
//
// GET  → launch config for the "Connect with WhatsApp" button:
//        { configured, app_id, config_id }. Reports configured:false
//        instead of throwing (deliberate: the button renders a
//        "not configured" state; the no-silent-fallback rule applies
//        to the mutation path below, which DOES throw).
// POST → body { code, waba_id, phone_number_id } from the ES dialog.
//        Orchestrates: code→business-token exchange, WABA webhook
//        subscription, conditional number registration, then upsert
//        into whatsapp_numbers. Nothing persists unless every Meta
//        call succeeded — safe to re-run with a fresh code.
//
// Master-or-owner gated, matching the numbers CRUD route.
// Design: docs/WHATSAPP_TECH_PROVIDER_DESIGN_2026-07.md §4.2.

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/validate'
import { publicShape } from '@/lib/whatsapp-numbers-shape'
import {
  exchangeCodeForBusinessToken, subscribeAppToWaba, probeNumber,
  needsRegistration, generatePin, registerNumber, planPersistence,
} from '@/lib/whatsapp-embedded-signup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function guardMasterOrOwner(user, locationId) {
  if (user.profileRole === 'master') return null
  const role = user.rolesByLocation?.[locationId]
  if (role === 'owner') return null
  return NextResponse.json({ success: false, error: 'Master or owner role required.' }, { status: 403 })
}

const ExchangeSchema = z.object({
  code: z.string().min(1),
  waba_id: z.string().regex(/^\d+$/, 'waba_id must be a numeric Meta id'),
  phone_number_id: z.string().regex(/^\d+$/, 'phone_number_id must be a numeric Meta id'),
})

export async function GET(_request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const guard = assertLocationAccess(user, params.id)
  if (guard) return guard

  const appId = process.env.WHATSAPP_APP_ID || null
  const configId = process.env.WHATSAPP_ES_CONFIG_ID || null
  return NextResponse.json({
    success: true,
    data: { configured: Boolean(appId && configId), app_id: appId, config_id: configId },
  })
}

export async function POST(request, props) {
  const params = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorised' }, { status: 401 })
  const access = assertLocationAccess(user, params.id)
  if (access) return access
  const guard = guardMasterOrOwner(user, params.id)
  if (guard) return guard

  const result = await validateBody(request, ExchangeSchema)
  if (!result.ok) return result.response
  const { code, waba_id, phone_number_id } = result.data

  const appId = process.env.WHATSAPP_APP_ID
  const appSecret = process.env.WHATSAPP_APP_SECRET
  const configId = process.env.WHATSAPP_ES_CONFIG_ID
  if (!appId || !appSecret || !configId) {
    return NextResponse.json(
      { success: false, error: 'Embedded Signup not configured (WHATSAPP_APP_ID / WHATSAPP_APP_SECRET / WHATSAPP_ES_CONFIG_ID).' },
      { status: 500 },
    )
  }

  // 1. code → business token. Nothing persists before step 4.
  let token
  try {
    token = await exchangeCodeForBusinessToken({ code, appId, appSecret })
  } catch (e) {
    return NextResponse.json({ success: false, error: `Code exchange failed: ${e.message}` }, { status: 502 })
  }

  // 2. Route the client WABA's webhooks to us.
  try {
    await subscribeAppToWaba({ wabaId: waba_id, token })
  } catch (e) {
    return NextResponse.json({ success: false, error: `WABA subscription failed: ${e.message}` }, { status: 502 })
  }

  // 3. Register only when needed (register is limited to 10/number/72h).
  let probe
  try {
    probe = await probeNumber({ phoneNumberId: phone_number_id, token })
  } catch (e) {
    return NextResponse.json({ success: false, error: `Number probe failed: ${e.message}` }, { status: 502 })
  }
  let pin = null
  if (needsRegistration(probe)) {
    pin = generatePin()
    try {
      await registerNumber({ phoneNumberId: phone_number_id, token, pin })
    } catch (e) {
      return NextResponse.json({ success: false, error: `Number registration failed: ${e.message}` }, { status: 502 })
    }
  }

  // 4. Persist. phone_number_id is globally unique (mig 176).
  const db = createServerClient()
  const { data: existingRow, error: lookupError } = await db
    .from('whatsapp_numbers')
    .select('*')
    .eq('phone_number_id', phone_number_id)
    .maybeSingle()
  if (lookupError) {
    return NextResponse.json({ success: false, error: lookupError.message }, { status: 500 })
  }

  const plan = planPersistence({ existingRow, locationId: params.id })
  if (plan.action === 'conflict') {
    return NextResponse.json(
      { success: false, error: 'This phone number is already connected to a different location.' },
      { status: 409 },
    )
  }

  const signupMeta = {
    waba_id,
    pin,
    connected_by: user.id,
    connected_at: new Date().toISOString(),
    probe: { status: probe.status ?? null, platform_type: probe.platform_type ?? null },
  }

  if (plan.action === 'update') {
    const { data: updated, error } = await db
      .from('whatsapp_numbers')
      .update({
        access_token: token,
        token_type: 'business',
        connected_via: 'embedded_signup',
        signup_meta: signupMeta,
        business_account_id: waba_id,
        is_active: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', plan.id)
      .select('*')
      .single()
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    return NextResponse.json({ success: true, data: publicShape(updated) })
  }

  const { data: defaults } = await db
    .from('whatsapp_numbers')
    .select('id')
    .eq('location_id', params.id)
    .eq('is_default', true)
    .limit(1)

  const { data: inserted, error: insertError } = await db
    .from('whatsapp_numbers')
    .insert({
      location_id: params.id,
      label: probe.verified_name || `WhatsApp ${probe.display_phone_number || phone_number_id}`,
      phone_number_id,
      business_account_id: waba_id,
      app_id: appId,
      access_token: token,
      display_phone: probe.display_phone_number || null,
      source: 'cloud_api',
      token_type: 'business',
      connected_via: 'embedded_signup',
      signup_meta: signupMeta,
      is_default: !(defaults?.length),
      is_active: true,
    })
    .select('*')
    .single()
  if (insertError) return NextResponse.json({ success: false, error: insertError.message }, { status: 500 })

  return NextResponse.json({ success: true, data: publicShape(inserted) })
}
```

- [ ] **Step 6: Align the spec with the final route path + gate**

The approved spec (§4.2) says `POST /api/whatsapp/embedded-signup/exchange` with a `MANAGER_ROLES` check; implementation follows the repo's location-scoped WA-config convention instead. Edit `docs/WHATSAPP_TECH_PROVIDER_DESIGN_2026-07.md` §4.2 heading/first sentence to read:

> ### 4.2 API — `POST /api/locations/[id]/whatsapp/embedded-signup`
>
> Standard mutation-route skeleton (`getCurrentUser()` → **master-or-owner gate,
> matching the numbers CRUD route** → `validateBody` → `assertLocationAccess` → …

- [ ] **Step 7: Run route-guard check + full test suite**

```bash
npm run check:route-guards && npm test
```
Expected: route-guards passes (route calls `getCurrentUser`); all tests pass.

- [ ] **Step 8: Commit**

```bash
git add 'src/lib/whatsapp-numbers-shape.js' 'src/lib/whatsapp-numbers-shape.test.js' \
  'src/app/api/locations/[id]/whatsapp/numbers/route.js' \
  'src/app/api/locations/[id]/whatsapp/numbers/[numberId]/route.js' \
  'src/app/api/locations/[id]/whatsapp/embedded-signup/route.js' \
  docs/WHATSAPP_TECH_PROVIDER_DESIGN_2026-07.md
git commit -m "WA-TECHPROV.3 — ES exchange route + shared whatsapp_numbers public shape"
```

---

### Task 4: Webhook hardening — drop unknown phone_number_ids (TDD)

**Files:**
- Modify: `src/lib/whatsapp-config.js` (add pure classifier)
- Modify: `src/app/api/webhooks/whatsapp/route.js` (`handleIncomingMessage`, the WA-MULTI.1 fallback block around lines 171–195)
- Test: `src/lib/whatsapp-config.test.js` (append)

**Behaviour change:** today an inbound for an UNKNOWN `phone_number_id` falls back to first-location — a cross-tenant leak once client numbers exist. New rules:
- resolves to a DB row → that row's location (unchanged)
- resolves to the env config (Stillorgan path — `source: 'env'`, no locationId) → first-location fallback (unchanged; **this is the Stillorgan-safety guarantee**)
- resolver **returns null** (genuinely unknown) → warn + drop the message, envelope still 200s
- resolver **throws** (transient DB error) → keep the historical first-location fallback (never drop real traffic on a blip)

- [ ] **Step 1: Write the failing classifier tests** (append to `src/lib/whatsapp-config.test.js`)

```js
import { classifyInboundOwner } from './whatsapp-config.js'

describe('classifyInboundOwner — WA-TECHPROV.4 webhook hardening', () => {
  it('unknown phone_number_id (resolver returned null) → drop', () => {
    expect(classifyInboundOwner(null)).toEqual({ action: 'drop' })
  })
  it('env config (Stillorgan path) → first-location fallback, unchanged', () => {
    expect(classifyInboundOwner({ source: 'env', phoneNumberId: '1233588839827698' }))
      .toEqual({ action: 'first_location' })
  })
  it('db row with a location → route to that location', () => {
    expect(classifyInboundOwner({ source: 'db', locationId: 'L9' }))
      .toEqual({ action: 'location', locationId: 'L9' })
  })
  it('db row somehow missing locationId → first-location, never drop', () => {
    expect(classifyInboundOwner({ source: 'db', locationId: null }))
      .toEqual({ action: 'first_location' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

```bash
npx vitest run src/lib/whatsapp-config.test.js
```
Expected: FAIL — `classifyInboundOwner` not exported.

- [ ] **Step 3: Implement the classifier** (append to `src/lib/whatsapp-config.js`)

```js
/**
 * WA-TECHPROV.4 — inbound routing decision for the webhook.
 *
 * Once Tech Provider clients exist, an unknown phone_number_id must
 * NOT fall back to first-location (cross-tenant leak: a client's
 * customer messages landing in UN1T's inbox). The env config keeps
 * the historical first-location fallback — that's the live
 * Stillorgan path and its behaviour is unchanged.
 */
export function classifyInboundOwner(owningNumber) {
  if (!owningNumber) return { action: 'drop' }
  if (owningNumber.source === 'env' || !owningNumber.locationId) return { action: 'first_location' }
  return { action: 'location', locationId: owningNumber.locationId }
}
```

- [ ] **Step 4: Run classifier tests to verify pass**

```bash
npx vitest run src/lib/whatsapp-config.test.js
```
Expected: PASS.

- [ ] **Step 5: Wire it into the webhook**

In `src/app/api/webhooks/whatsapp/route.js`, `handleIncomingMessage`, replace the WA-MULTI.1 resolution + first-location fallback block (the code from `let phoneOwnerLocationId = null` through the `if (!defaultLocationId)` fallback) with:

```js
  // WA-MULTI.1 / WA-TECHPROV.4 — route inbound to the location that
  // owns the recipient phone_number_id. Unknown ids are DROPPED
  // (cross-tenant protection); the env-config number and resolver
  // errors keep the historical first-location fallback.
  let routing = { action: 'first_location' }   // no phone_number_id in payload = legacy behaviour
  if (phoneNumberId) {
    try {
      const owningNumber = await resolveWhatsAppNumberByPhoneNumberId(phoneNumberId)
      routing = classifyInboundOwner(owningNumber)
    } catch (e) {
      console.warn('[wa-webhook] phone_number_id resolution failed (falling back):', e.message)
    }
  }
  if (routing.action === 'drop') {
    console.warn(`[wa-webhook] dropping inbound for unknown phone_number_id ${phoneNumberId}`)
    return
  }

  let defaultLocationId = routing.action === 'location' ? routing.locationId : null
  if (!defaultLocationId) {
    const { data: locations } = await db.from('locations').select('id').limit(1)
    if (locations?.length) defaultLocationId = locations[0].id
  }
```

Add `classifyInboundOwner` to the existing `whatsapp-config` import at the top of the file. `handleIncomingMessage` is called per message, so `return` drops exactly one message; the envelope handler still returns 200 (Meta must not retry/disable).

- [ ] **Step 6: Full test suite**

```bash
npm test
```
Expected: PASS (~2950 tests).

- [ ] **Step 7: Commit**

```bash
git add src/lib/whatsapp-config.js src/lib/whatsapp-config.test.js src/app/api/webhooks/whatsapp/route.js
git commit -m "WA-TECHPROV.4 — drop inbound for unknown phone_number_id (cross-tenant hardening; env path unchanged)"
```

---

### Task 5: Frontend — "Connect with WhatsApp" card

**Files:**
- Modify: `src/components/settings/integrations/WhatsAppIntegrationTab.jsx`

No unit test (component; repo tests are pure-lib). Verification = lint + build + manual E2E (§Post-merge). Match the file's existing idiom: `Card`/`Button` primitives from `@/components/ui`, chip colours `bg-*-500/10 text-*-700`, `type="button"` on every non-submit button.

- [ ] **Step 1: Add the SDK loader + card component** (place near `ChatOpenersCard`, same file)

```jsx
// WA-TECHPROV.5 — Embedded Signup v4 launcher. The FB JS SDK is
// loaded on demand (never globally); the session-info listener
// captures waba_id/phone_number_id, FB.login's callback supplies the
// response code, and the server does the rest.
// NOTE (implementation-time check): confirm the current extras /
// sessionInfoVersion field names against Meta's ES v4 docs — the
// behaviour contract is fixed in the spec, the field names drift.

function loadFacebookSdk(appId) {
  return new Promise((resolve, reject) => {
    if (window.FB) return resolve(window.FB)
    window.fbAsyncInit = () => {
      window.FB.init({ appId, autoLogAppEvents: false, xfbml: false, version: 'v21.0' })
      resolve(window.FB)
    }
    const s = document.createElement('script')
    s.src = 'https://connect.facebook.net/en_US/sdk.js'
    s.async = true
    s.defer = true
    s.onerror = () => reject(new Error('Facebook SDK failed to load'))
    document.body.appendChild(s)
  })
}

function ConnectWhatsAppCard({ location, canEdit, onConnected }) {
  const [launch, setLaunch] = useState(null)      // { configured, app_id, config_id }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [connectedLabel, setConnectedLabel] = useState(null)
  const sessionInfo = useRef({})                  // { waba_id, phone_number_id }

  useEffect(() => {
    let cancelled = false
    fetch(`/api/locations/${location.id}/whatsapp/embedded-signup`)
      .then(r => r.json())
      .then(j => { if (!cancelled && j.success) setLaunch(j.data) })
      .catch(() => { /* card renders the not-configured state */ })
    return () => { cancelled = true }
  }, [location.id])

  useEffect(() => {
    function onMessage(event) {
      if (typeof event.origin !== 'string' || !event.origin.endsWith('facebook.com')) return
      try {
        const data = JSON.parse(event.data)
        if (data?.type === 'WA_EMBEDDED_SIGNUP') {
          sessionInfo.current = {
            waba_id: data.data?.waba_id ?? sessionInfo.current.waba_id,
            phone_number_id: data.data?.phone_number_id ?? sessionInfo.current.phone_number_id,
          }
        }
      } catch { /* FB widgets also postMessage non-JSON — ignore */ }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  async function connect() {
    setError(null)
    setBusy(true)
    try {
      const FB = await loadFacebookSdk(launch.app_id)
      const authCode = await new Promise((resolve) => {
        FB.login(
          (response) => resolve(response?.authResponse?.code || null),
          {
            config_id: launch.config_id,
            response_type: 'code',
            override_default_response_type: true,
            extras: { setup: {}, sessionInfoVersion: '3' },
          },
        )
      })
      if (!authCode) { setBusy(false); return }   // dialog abandoned = no-op

      const { waba_id, phone_number_id } = sessionInfo.current
      if (!waba_id || !phone_number_id) {
        throw new Error('Signup finished but no WABA/number details arrived — close the dialog and retry.')
      }

      const res = await fetch(`/api/locations/${location.id}/whatsapp/embedded-signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: authCode, waba_id, phone_number_id }),
      })
      const json = await res.json()
      if (!json.success) throw new Error(json.error || 'Connection failed')
      setConnectedLabel(json.data.label)
      sessionInfo.current = {}
      onConnected?.()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-medium">Connect with WhatsApp</h3>
          <p className="text-sm text-un1t-grey-600 mt-1">
            Onboard a WhatsApp Business account and number through Meta&apos;s
            guided signup. The number lands in the list above, ready to send.
          </p>
          {connectedLabel && (
            <span className="inline-block mt-2 px-2 py-0.5 rounded text-xs bg-green-500/10 text-green-700">
              Connected: {connectedLabel}
            </span>
          )}
          {error && (
            <span className="inline-block mt-2 px-2 py-0.5 rounded text-xs bg-red-500/10 text-red-700">
              {error}
            </span>
          )}
          {launch && !launch.configured && (
            <span className="inline-block mt-2 px-2 py-0.5 rounded text-xs bg-amber-500/10 text-amber-700">
              Embedded Signup isn&apos;t configured yet (WHATSAPP_ES_CONFIG_ID).
            </span>
          )}
        </div>
        <Button type="button" onClick={connect} disabled={!canEdit || busy || !launch?.configured}>
          {busy ? 'Connecting…' : 'Connect'}
        </Button>
      </div>
    </Card>
  )
}
```

(Adjust `Card`/`Button` usage, class tokens, and copy to match what the file already imports and renders — the existing numbers card is the style reference. If the file lacks a `Card` import, reuse whatever container the sibling cards use.)

- [ ] **Step 2: Render it in the tab**

In `WhatsAppIntegrationTab`'s JSX, directly after the numbers list card, add:

```jsx
<ConnectWhatsAppCard location={location} canEdit={canEdit} onConnected={load} />
```

(`load` is the existing numbers-list refresh at the top of the component — a successful connect makes the new row appear immediately.)

- [ ] **Step 3: Lint + guardrails**

```bash
npm run lint && npm run check:guardrails
```
Expected: clean (chip classes use the -700 text ramp; the non-submit button is `type="button"`).

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/integrations/WhatsAppIntegrationTab.jsx
git commit -m "WA-TECHPROV.5 — Connect with WhatsApp card (Embedded Signup v4 launcher)"
```

---

### Task 6: OpenAPI registration + integration docs

**Files:**
- Modify: `src/lib/openapi.js`
- Modify: `docs/architecture/INTEGRATIONS.md`

- [ ] **Step 1: Register both methods in openapi.js**

Find the existing `/api/whatsapp/card-sets` entries (~line 1755) and replicate their exact structure for:
- `GET /api/locations/{id}/whatsapp/embedded-signup` — summary: "Embedded Signup launch config (app_id, config_id, configured)".
- `POST /api/locations/{id}/whatsapp/embedded-signup` — summary: "Exchange an Embedded Signup code and connect the WABA/number to this location"; request body `{ code: string, waba_id: string, phone_number_id: string }`; responses 200/401/403/409/502.

Match the file's registration idiom exactly (same helper, same zod-to-schema shape as the neighbouring whatsapp entries) — do not invent a new format.

- [ ] **Step 2: Document the env var**

In `docs/architecture/INTEGRATIONS.md`, WhatsApp section, add to the env-var table/list:

```
| WHATSAPP_ES_CONFIG_ID | Facebook Login for Business configuration id driving Embedded Signup v4 ("Connect with WhatsApp"). Unset = the connect button renders a not-configured state; the exchange route 500s. |
```

- [ ] **Step 3: Build check** (openapi.js changes are exactly the import-shaped risk vitest can't catch)

```bash
npm run build
```
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/lib/openapi.js docs/architecture/INTEGRATIONS.md
git commit -m "WA-TECHPROV.6 — register embedded-signup routes in OpenAPI + document WHATSAPP_ES_CONFIG_ID"
```

---

### Task 7: Meta console runbook + App Review drafts

**Files:**
- Modify: `docs/whatsapp-setup.md` (append a new top-level section)

No code. This is the Track-1 deliverable the operator (Richard) executes in the Meta console — each step there is confirmed with him before it's taken.

- [ ] **Step 1: Append the Tech Provider section**

```markdown
## 9. Tech Provider — Embedded Signup v4 (WA-TECHPROV, 2026-07)

Design: `docs/WHATSAPP_TECH_PROVIDER_DESIGN_2026-07.md`. Meta approved the
testing/configuring phase 2026-07-16. Everything below is additive to the
live app — the Stillorgan number, env token, and webhook are untouched.

### 9.1 App preflight (App Review blocks without these)
App Dashboard → Settings → Basic: confirm privacy policy URL, app icon
(1024×1024), category, and that the app is connected to the verified UN1T
business portfolio. Record anything missing and fix before review.

### 9.2 Create the Embedded Signup configuration
1. App Dashboard → Facebook Login for Business → Configurations → Create.
2. Choose the WhatsApp Embedded Signup (v4) template; login variation "General".
3. Assets: WhatsApp Business accounts; permissions: whatsapp_business_management,
   whatsapp_business_messaging.
4. Save → copy the **Configuration ID** → set `WHATSAPP_ES_CONFIG_ID` in Vercel
   (Production) and redeploy.
5. Facebook Login for Business → Settings: add `https://crm.un1tdublin.com` to
   Allowed Domains for the JavaScript SDK; enable "Login with the JavaScript SDK".

### 9.3 In-house E2E (standard access)
Standard access onboards businesses the app's own portfolio admins — i.e. UN1T.
Settings → Locations → (Hatch or a test location) → Integrations → WhatsApp →
**Connect with WhatsApp** → complete the dialog with a spare/test number.
Verify: row appears with `connected_via=embedded_signup`; send + receive works;
inbound lands in THAT location's inbox; Stillorgan traffic unaffected.
Record the screen during this run — it becomes the App Review screencast.

### 9.4 App Review submission
App Review → Permissions and Features → request **Advanced Access** for:
- `whatsapp_business_messaging` — screencast: a message sent from the CRM
  arriving in a WhatsApp client (from 9.3).
- `whatsapp_business_management` — screencast: template creation via the CRM's
  template builder (or WhatsApp Manager as fallback).

Draft justifications (edit to taste before submitting):

> **whatsapp_business_messaging:** UN1T CRM is a gym-management platform
> (crm.un1tdublin.com). Businesses onboard their own WhatsApp Business
> accounts via Embedded Signup and use the platform to reply to member
> conversations from a shared inbox, send class reminders and booking
> confirmations (utility templates), and run opt-in marketing sends. Messages
> are sent exclusively on behalf of the onboarded business to its own
> customers, who have opted in via the business's booking/consent flows.
>
> **whatsapp_business_management:** The platform manages onboarded customers'
> WABA assets on their behalf: creating and submitting message templates,
> reading template status/quality webhooks, monitoring phone-number quality
> ratings and messaging limits, and subscribing the app to the WABA's
> webhooks at onboarding. All management is scoped to WABAs connected through
> Embedded Signup by the business itself.

### 9.5 After approval
- Access Verification (Business Settings prompt) — lifts the onboarding cap
  from 10 to 200 clients/week. Defer until external clients are imminent.
- Onboarded clients must add a payment method to their own WABA (they pay
  Meta directly) — surface this in onboarding copy when SaaS clients arrive.

### 9.6 Traps
- **Build v4 only** — ES v2 is deprecated 2026-10-15.
- ES business tokens are long-lived — NOT the API-Setup 24h temp tokens that
  killed agent sends before (docs/LESSONS.md). Health polling still covers
  revocation.
- `/register` is limited to 10 calls/number/72h (err 133016) — the exchange
  route probes before registering; don't hand-retry in the console.
```

- [ ] **Step 2: Commit**

```bash
git add docs/whatsapp-setup.md
git commit -m "WA-TECHPROV.7 — Tech Provider console runbook + App Review justification drafts"
```

---

### Task 8: CI mirror, build, PR

- [ ] **Step 1: Full CI mirror + build**

```bash
cd ~/code/un1t-crm-watech
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && npm run build
```
Expected: all green. (`check:mobile-parity`: no new `WEB_PERMISSIONS` key was added — the flow inherits the settings-integrations guard — so no parity entry is needed. If a key WAS added during implementation, add a `WEB_ONLY_OK` entry: ES requires the Facebook JS SDK in a browser.)

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin whatsapp-tech-provider
gh pr create --base main --title "WA-TECHPROV — Embedded Signup v4 (Tech Provider onboarding)" --body "$(cat <<'EOF'
Implements docs/WHATSAPP_TECH_PROVIDER_DESIGN_2026-07.md:

- mig 405: token_type / connected_via / signup_meta on whatsapp_numbers (applied via MCP)
- src/lib/whatsapp-embedded-signup.js: code exchange, WABA subscribe, probe/register, persistence planner (TDD)
- POST/GET /api/locations/[id]/whatsapp/embedded-signup: ES v4 exchange, master-or-owner gated, nothing persists unless all Meta calls succeed; 409 on cross-location number
- Webhook hardening: unknown phone_number_id → warn + drop (env/Stillorgan path unchanged: still first-location)
- Connect with WhatsApp card in WhatsAppIntegrationTab (FB SDK on demand, ES v4 dialog)
- OpenAPI registration, WHATSAPP_ES_CONFIG_ID documented, Meta console runbook + App Review drafts in docs/whatsapp-setup.md

Live-integration safety: all changes additive; Stillorgan env-token send path and webhook routing behaviour unchanged (regression-tested classifier).

Follow-ups (operator, post-merge): create the ES configuration in the Meta console (runbook §9.2), set WHATSAPP_ES_CONFIG_ID in Vercel, run the in-house E2E (§9.3), submit App Review (§9.4).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Report the PR URL** to Richard. Pushing is not shipping.

---

## Post-merge (operator + assistant together — NOT part of this plan's execution)

1. Meta console: runbook §9.1–9.2 (each state-changing step confirmed with Richard).
2. Vercel: set `WHATSAPP_ES_CONFIG_ID`, redeploy.
3. In-house E2E (§9.3) — this is Meta's "testing and configuring" phase; record for App Review.
4. Submit App Review (§9.4).
5. Update memory `wa-tech-provider-onboarding` with outcomes.

## Self-review notes (already applied)

- Spec §4.2 route path/gate updated in Task 3 Step 6 (location-scoped route, master-or-owner gate) — deliberate deviation toward the repo's numbers-CRUD convention.
- Types consistent: `planPersistence` returns `{action:'insert'|'update'|'conflict'}` and Task 3 consumes exactly those; classifier returns `{action:'drop'|'first_location'|'location'}` and Task 4 Step 5 consumes exactly those.
- Every spec §6 error row has a task: exchange/subscribe/probe/register failures (Task 3 route, Task 2 tests), 409 (Tasks 2+3), unknown-webhook drop (Task 4), token revocation (existing health machinery — no new code, per spec).
