# Phase 3c — Payments Settings + Stripe Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Let an operator choose the class-funnel payment rail per location (Revolut or Stripe) and fully onboard a location's Stripe Connect account in-app — making the Phase-3b Stripe rail actually selectable and completing the paid-intro feature.

**Architecture:** A new `PaymentsIntegrationTab` in the location integration settings writes `locations.settings.payments` via the browser-client merge pattern (like `GlofoxIntegrationTab`). Authed per-location Stripe-Connect routes mirror the existing `hosts/[id]/stripe/connect` flow (create account → hosted onboarding link → charges-enabled status). No new payment logic — 3b already handles charging/release.

**Tech Stack:** Next.js App Router, React, Supabase, Stripe Connect, Vitest.

**Worktree:** `~/code/un1t-crm-p3c` (branch `class-funnel-pay-p3c`, off `origin/main` — has Phases 1/2/3a/3b).

**Spec:** `docs/superpowers/specs/2026-07-23-class-funnel-stripe-rail-design.md` (§ "3c — payments settings + Stripe onboarding").

**No migration** (`settings.payments` is JSONB on `locations`). Additive.

---

## File Structure
- **Modify:** `src/lib/payments/stripe-connect.js` (generalize `createConnectedAccount` to accept `locationId`).
- **Create:** `src/app/api/locations/[id]/stripe-connect/connect/route.js` (POST — ensure account + onboarding link), `src/app/api/locations/[id]/stripe-connect/status/route.js` (GET — charges-enabled).
- **Create:** `src/components/settings/integrations/PaymentsIntegrationTab.jsx`.
- **Modify:** `src/components/settings/LocationIntegrations.jsx` (register the tab).

---

## Task 1: Generalize `createConnectedAccount` for a location

**Files:** Modify `src/lib/payments/stripe-connect.js`.

- [ ] **Step 1: Edit** — the function currently is:
```js
export async function createConnectedAccount({ name, email, hostId, country = 'IE' }) {
  const stripe = getStripe()
  const account = await stripe.accounts.create({
    type: 'standard',
    country,
    email: email || undefined,
    business_profile: name ? { name } : undefined,
    metadata: { un1t_host_id: hostId || '' },
  })
  return account.id
}
```
Change the signature + metadata to also carry a location id (keep `hostId` working):
```js
export async function createConnectedAccount({ name, email, hostId, locationId, country = 'IE' }) {
  const stripe = getStripe()
  const account = await stripe.accounts.create({
    type: 'standard',
    country,
    email: email || undefined,
    business_profile: name ? { name } : undefined,
    metadata: { un1t_host_id: hostId || '', un1t_location_id: locationId || '' },
  })
  return account.id
}
```

- [ ] **Step 2: Lint** — `cd ~/code/un1t-crm-p3c && npm run lint 2>&1 | tail -3`. Expected: 0 errors. (No behavioural change for existing host callers — they don't pass `locationId`, so it's `''`.)

- [ ] **Step 3: Commit**
```bash
cd ~/code/un1t-crm-p3c
git add src/lib/payments/stripe-connect.js
git commit -m "PAID-INTRO-P3C.1 — createConnectedAccount carries un1t_location_id metadata"
```

---

## Task 2: `POST /api/locations/[id]/stripe-connect/connect`

Ensure the location has a Stripe connected account (create on first call, store on `settings.payments.stripe_connected_account_id`) and return a hosted onboarding link. Mirrors `hosts/[id]/stripe/connect`, gated by location access.

**Files:** Create `src/app/api/locations/[id]/stripe-connect/connect/route.js`.

- [ ] **Step 1: Create the route**:
```js
// POST /api/locations/[id]/stripe-connect/connect
// Ensures this location has a Stripe Connect (Standard) account and returns a
// hosted-onboarding Account Link URL. Account Links MUST be presented in an
// authenticated session (Stripe's rule) — this is a Manager+ operator action.
// Completes Phase 3c of the paid class-funnel intro.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { getAppUrl } from '@/lib/app-url'
import { createConnectedAccount, createOnboardingLink } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(_request, props) {
  const { id: locationId } = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!['master', 'owner', 'manager'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  // assertLocationAccessOr404 returns a NextResponse (error) or null when allowed.
  const denied = assertLocationAccessOr404(user, locationId)
  if (denied) return denied

  const db = createServerClient()
  const { data: loc, error: readErr } = await db.from('locations').select('id, name, settings').eq('id', locationId).maybeSingle()
  if (readErr || !loc) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })

  try {
    const payments = loc.settings?.payments || {}
    let accountId = payments.stripe_connected_account_id
    if (!accountId) {
      accountId = await createConnectedAccount({ name: loc.name, locationId })
      const nextSettings = { ...(loc.settings || {}), payments: { ...payments, stripe_connected_account_id: accountId } }
      const { error: upErr } = await db.from('locations').update({ settings: nextSettings, updated_at: new Date().toISOString() }).eq('id', locationId)
      if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 })
    }
    const base = getAppUrl()
    const url = await createOnboardingLink({
      accountId,
      refreshUrl: `${base}/api/locations/${locationId}/stripe-connect/connect`,
      returnUrl: `${base}/settings/integrations?tab=payments&stripe=return`,
    })
    return NextResponse.json({ success: true, data: { url } })
  } catch (e) {
    return NextResponse.json({ success: false, error: `Stripe onboarding failed: ${e.message || 'unknown'}` }, { status: 502 })
  }
}
```
NOTE: `refreshUrl` points back at this POST route — Stripe hits it (GET) when a link expires; App Router routes only export POST here, so a GET to it 405s, which Stripe treats as "regenerate". If that's undesirable, the plan can add a tiny GET that 302s to the settings tab; keep POST-only for v1 and verify the returnUrl (the success path) is what the operator actually lands on. (`assertLocationAccessOr404` VERIFIED: sync, returns a NextResponse on deny or `null` when allowed — hence the `const denied = ...; if (denied) return denied` pattern above.)

- [ ] **Step 2: route-guards + build + lint**
```bash
cd ~/code/un1t-crm-p3c
npm run check:route-guards 2>&1 | tail -3
npm run build 2>&1 | tail -6
npm run lint 2>&1 | tail -3
node scripts/check-location-scoping.mjs 2>&1 | tail -3
```
Expected: route-guards passes (session-guarded via `getCurrentUser`); build succeeds; 0 lint; location-scoping passes (the `assertLocationAccess` call is recognised scoping evidence).

- [ ] **Step 3: Commit**
```bash
cd ~/code/un1t-crm-p3c
git add "src/app/api/locations/[id]/stripe-connect/connect/route.js"
git commit -m "PAID-INTRO-P3C.2 — per-location Stripe connect route (create account + onboarding link)"
```

---

## Task 3: `GET /api/locations/[id]/stripe-connect/status`

**Files:** Create `src/app/api/locations/[id]/stripe-connect/status/route.js`.

- [ ] **Step 1: Create the route**:
```js
// GET /api/locations/[id]/stripe-connect/status — charges-enabled status of the
// location's Stripe connected account, for the payments settings tab.
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase'
import { getCurrentUser, assertLocationAccessOr404 } from '@/lib/auth'
import { retrieveAccountStatus } from '@/lib/payments/stripe-connect'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(_request, props) {
  const { id: locationId } = await props.params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!['master', 'owner', 'manager'].includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Manager+ required' }, { status: 403 })
  }
  const denied = assertLocationAccessOr404(user, locationId)
  if (denied) return denied

  const db = createServerClient()
  const { data: loc } = await db.from('locations').select('settings').eq('id', locationId).maybeSingle()
  const accountId = loc?.settings?.payments?.stripe_connected_account_id
  if (!accountId) return NextResponse.json({ success: true, data: { connected: false, charges_enabled: false } })

  try {
    const s = await retrieveAccountStatus(accountId)
    return NextResponse.json({ success: true, data: { connected: true, charges_enabled: s.chargesEnabled, details_submitted: s.detailsSubmitted } })
  } catch (e) {
    return NextResponse.json({ success: false, error: `Stripe status failed: ${e.message || 'unknown'}` }, { status: 502 })
  }
}
```

- [ ] **Step 2: route-guards + build + lint + scoping** (same commands as Task 2 Step 2). Expected: all pass.

- [ ] **Step 3: Commit**
```bash
cd ~/code/un1t-crm-p3c
git add "src/app/api/locations/[id]/stripe-connect/status/route.js"
git commit -m "PAID-INTRO-P3C.3 — per-location Stripe status route (charges-enabled)"
```

---

## Task 4: `PaymentsIntegrationTab` component

**Files:** Create `src/components/settings/integrations/PaymentsIntegrationTab.jsx`.

- [ ] **Step 1: Create the component** (mirrors `GlofoxIntegrationTab`'s state + browser-client merge-save; adds provider select + Stripe connect/status):
```jsx
'use client'

// PaymentsIntegrationTab — per-location payment rail for the class funnel.
// Writes locations.settings.payments = { provider, stripe_connected_account_id }.
// Revolut = UN1T is the merchant (works out of the box). Stripe = a direct charge
// on THIS location's connected account (must finish Stripe onboarding first).
import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase'
// NB: match GlofoxIntegrationTab — it uses PLAIN <label>/<select>/<input> with
// un1t-* classes, NOT a Field/Input kit. Do not import from '@/components/ui'.

export default function PaymentsIntegrationTab({ location, canEdit }) {
  const router = useRouter()
  const initial = location.settings?.payments || {}
  const [provider, setProvider] = useState(initial.provider || 'revolut')
  const [status, setStatus] = useState(null) // { connected, charges_enabled }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [savedAt, setSavedAt] = useState(null)

  const hasStripeAccount = !!initial.stripe_connected_account_id

  useEffect(() => {
    if (!hasStripeAccount) return
    let alive = true
    fetch(`/api/locations/${location.id}/stripe-connect/status`, { cache: 'no-store' })
      .then((r) => r.ok ? r.json() : null)
      .then((j) => { if (alive && j?.success) setStatus(j.data) })
      .catch(() => {})
    return () => { alive = false }
  }, [location.id, hasStripeAccount])

  async function save() {
    if (!canEdit) return
    // Guard: don't let an operator commit Stripe as the active rail until it can charge.
    if (provider === 'stripe_connect' && !(status?.charges_enabled)) {
      setError('Finish Stripe onboarding (charges must be enabled) before switching this location to Stripe.')
      return
    }
    setBusy(true); setError(null)
    const db = createBrowserClient()
    const { data: row, error: readErr } = await db.from('locations').select('settings').eq('id', location.id).single()
    if (readErr) { setError(readErr.message); setBusy(false); return }
    const prevPayments = row?.settings?.payments || {}
    const nextSettings = { ...(row?.settings || {}), payments: { ...prevPayments, provider } }
    const { error: upErr } = await db.from('locations').update({ settings: nextSettings, updated_at: new Date().toISOString() }).eq('id', location.id)
    setBusy(false)
    if (upErr) { setError(upErr.message); return }
    setSavedAt(new Date()); router.refresh()
  }

  async function connectStripe() {
    if (!canEdit) return
    setBusy(true); setError(null)
    try {
      const r = await fetch(`/api/locations/${location.id}/stripe-connect/connect`, { method: 'POST' })
      const j = await r.json()
      if (!r.ok || !j.success) throw new Error(j.error || 'Could not start Stripe onboarding')
      window.open(j.data.url, '_blank', 'noopener')
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  async function refreshStatus() {
    setBusy(true)
    try {
      const r = await fetch(`/api/locations/${location.id}/stripe-connect/status`, { cache: 'no-store' })
      const j = await r.json()
      if (j?.success) setStatus(j.data)
    } catch { /* ignore */ } finally { setBusy(false) }
  }

  return (
    <div className="space-y-4 max-w-lg">
      <div>
        <label className="block text-sm font-medium text-un1t-text mb-1">Payment rail</label>
        <p className="text-xs text-un1t-subtle mb-1.5">Which processor takes the class-funnel intro payment for this location.</p>
        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          disabled={!canEdit}
          className="w-full bg-un1t-bg border border-un1t-border rounded-md px-3 py-2 text-sm text-un1t-text"
        >
          <option value="revolut">Revolut (UN1T)</option>
          <option value="stripe_connect">Stripe (this location)</option>
        </select>
      </div>

      {provider === 'stripe_connect' && (
        <div className="rounded-md border border-un1t-border p-3 space-y-2">
          <div className="text-sm text-un1t-text">Stripe Connect</div>
          <div className="text-xs text-un1t-subtle">
            {status?.charges_enabled
              ? '✓ Ready — charges enabled.'
              : hasStripeAccount
                ? 'Onboarding not finished — charges not yet enabled.'
                : 'Not connected yet.'}
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={connectStripe} disabled={busy || !canEdit}
              className="text-sm bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md font-medium disabled:opacity-50">
              {hasStripeAccount ? 'Finish setup' : 'Connect Stripe'}
            </button>
            {hasStripeAccount && (
              <button type="button" onClick={refreshStatus} disabled={busy}
                className="text-sm border border-un1t-border text-un1t-text px-3 py-1.5 rounded-md disabled:opacity-50">
                Refresh status
              </button>
            )}
          </div>
        </div>
      )}

      {error && <p className="text-sm text-red-700">{error}</p>}
      {canEdit && (
        <button type="button" onClick={save} disabled={busy}
          className="text-sm bg-un1t-text text-un1t-bg px-3 py-1.5 rounded-md font-medium disabled:opacity-50">
          Save
        </button>
      )}
      {savedAt && <span className="text-xs text-un1t-muted ml-2">Saved.</span>}
    </div>
  )
}
```
IMPORTANT: READ `GlofoxIntegrationTab.jsx` first and MATCH its real imports for `Field`/`Input`/`createBrowserClient`/`useRouter` + its `un1t-*` classes and `canEdit` handling. If `Field`/`Input` are imported from a specific path there, use the same. If those primitives aren't used there, use plain `<label>`/`<select>` with the same `un1t-*` classes the file uses. Do not invent a UI kit path.

- [ ] **Step 2: Build + lint** — `cd ~/code/un1t-crm-p3c && npm run build 2>&1 | tail -6 && npm run lint 2>&1 | tail -3`. Expected: succeeds; 0 errors; `check:guardrails` chip/contrast not triggered (no chips here).

- [ ] **Step 3: Commit**
```bash
cd ~/code/un1t-crm-p3c
git add src/components/settings/integrations/PaymentsIntegrationTab.jsx
git commit -m "PAID-INTRO-P3C.4 — PaymentsIntegrationTab (rail select + Stripe onboarding)"
```

---

## Task 5: Register the Payments tab in `LocationIntegrations`

**Files:** Modify `src/components/settings/LocationIntegrations.jsx`.

- [ ] **Step 1: Import** — with the other tab imports:
```js
import PaymentsIntegrationTab from './integrations/PaymentsIntegrationTab'
```
Also add an icon to the existing lucide import group (e.g. `CreditCard`) if the file imports icons there.

- [ ] **Step 2: Push the tab** — after the Glofox `tabs.push({...})` block, add (gate to owner/master, like other config tabs — match the file's `isOwnerOrMaster` variable name):
```js
  if (isOwnerOrMaster) {
    tabs.push({
      key: 'payments',
      label: 'Payments',
      Icon: CreditCard,
      status: location.settings?.payments?.provider === 'stripe_connect'
        ? (location.settings?.payments?.stripe_connected_account_id ? 'connected' : 'not-configured')
        : 'connected',
    })
  }
```
(Match the exact `status` string values the tab strip expects — read a sibling push; if it uses `'connected'|'not-configured'`, use those.)

- [ ] **Step 3: Render** — in the active-tab render block (where `{activeKey === 'glofox' && <GlofoxIntegrationTab .../>}` etc. are), add:
```jsx
            {activeKey === 'payments' && <PaymentsIntegrationTab location={location} canEdit={isOwnerOrMaster} />}
```
(Match the exact wrapper syntax the siblings use.)

- [ ] **Step 4: Build + lint** — `cd ~/code/un1t-crm-p3c && npm run build 2>&1 | tail -6 && npm run lint 2>&1 | tail -3`. Expected: succeeds; 0 errors.

- [ ] **Step 5: Commit**
```bash
cd ~/code/un1t-crm-p3c
git add src/components/settings/LocationIntegrations.jsx
git commit -m "PAID-INTRO-P3C.5 — register the Payments settings tab"
```

---

## Task 6: Full verification + PR

- [ ] **Step 1: Full suite** — `cd ~/code/un1t-crm-p3c && npm test 2>&1 | tail -6`. Expected: all pass.
- [ ] **Step 2: CI mirror + scoping** — `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && node scripts/check-location-scoping.mjs`. Expected: all exit 0.
- [ ] **Step 3: Build** — `npm run build 2>&1 | tail -12`. Expected: success; the two new routes present.
- [ ] **Step 4: Manual smoke (Stripe test mode)** — Settings → Integrations → Payments: pick Stripe → Connect → complete Stripe's hosted onboarding (test) → Refresh status shows Ready → Save. Then run the paid funnel on that location → the embedded Stripe checkout mounts → test-pay → booking releases + grants+books. Revolut location unchanged. Document what needed live creds.
- [ ] **Step 5: Push + PR**
```bash
cd ~/code/un1t-crm-p3c
git push -u origin class-funnel-pay-p3c
gh pr create --base main --fill
```
Report the PR URL. Body: Phase 3c — payments settings + Stripe onboarding; completes the paid-intro feature (operator picks Revolut/Stripe per location). No migration. Vercel preview + Stripe test mode is the real gate.

---

## Self-review notes (spec coverage — 3c)
- `createConnectedAccount` location-aware → Task 1. ✅
- Connect route (create account + onboarding link, stores on settings.payments) → Task 2. ✅
- Status route (charges-enabled) → Task 3. ✅
- Settings tab (provider select + Stripe connect/status, merge-save) → Task 4. ✅
- Tab registration → Task 5. ✅
- Guard: can't commit Stripe until charges-enabled → Task 4 `save()`. The booking-route `locationCanTakePayments` gate (3b) remains the server belt. ✅
- Auth: master/owner/manager + location access on both routes → Tasks 2/3. ✅

**Naming/type consistency:** `settings.payments.provider` (`'revolut'|'stripe_connect'`) + `settings.payments.stripe_connected_account_id` written by the tab (Task 4) + connect route (Task 2), read by the status route (Task 3) and by `resolveLocationPaymentProvider` (Phase 1, unchanged). `retrieveAccountStatus` returns `{ chargesEnabled, detailsSubmitted, ... }` → surfaced as `charges_enabled`/`details_submitted` in Task 3, read as `status.charges_enabled` in Task 4. Routes under `/api/locations/[id]/stripe-connect/{connect,status}` referenced identically in the tab (Task 4) and defined in Tasks 2/3. ✅

**Verify-before-implement flags:** (a) `assertLocationAccess` contract (sync bool vs async/throw) — read `@/lib/auth`; (b) `Field`/`Input`/`createBrowserClient` real import paths + `un1t-*` classes — read `GlofoxIntegrationTab.jsx`; (c) tab `status` string values + render wrapper — read a sibling in `LocationIntegrations.jsx`. All three are called out in the relevant tasks.
