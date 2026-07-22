# Paid Intro Offer — Phase 2 (Funnel Payment UI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the paid class funnel usable end-to-end — an inline embedded Revolut checkout step in `ClassFunnel`, an editor price field, and the `/class-pay/[id]` return page — on top of Phase 1's backend.

**Architecture:** Extract the Revolut Embedded SDK loader from `RaceCheckoutPage` into a shared client lib, build an isolated `ClassFunnelCheckout` component (mount SDK against the Phase-1 checkout token + poll the Phase-1 status route), and slot a `payment` step into `ClassFunnel` between `classpick` and `classdone`. Editor gains a euros↔cents price field. A minimal public `/class-pay/[id]` page covers the redirect/3DS return.

**Tech Stack:** Next.js 16 App Router, React 19, Revolut Embedded Checkout SDK, Vitest.

**Worktree:** `~/code/un1t-crm-payui` (branch `class-funnel-pay-ui`, off `origin/main` — has Phase 1 #1056).

**Spec:** `docs/superpowers/specs/2026-07-22-class-funnel-paid-intro-phase2-ui-design.md`

**No migration.** Additive UI. A block's `price_cents` stays 0 until an operator sets it, so nothing changes for existing funnels on deploy. Needs `NEXT_PUBLIC_REVOLUT_MODE` + `NEXT_PUBLIC_REVOLUT_PUBLIC_KEY` (already set in prod for RaceCheckoutPage).

---

## File Structure

**Create:**
- `src/lib/revolut-embed.js` (+ `.test.js`) — shared Revolut Embedded SDK loader + env readers.
- `src/lib/price-format.js` (+ `.test.js`) — euros↔cents helpers.
- `src/components/landing-page/ClassFunnelCheckout.jsx` — isolated embedded-checkout + poll component.
- `src/app/class-pay/[id]/page.js` — public return page.
- `src/components/ClassPayStatus.jsx` — client island for the return page (poll + render status).

**Modify:**
- `src/components/RaceCheckoutPage.jsx` — import the loader from `revolut-embed` (behaviour-preserving).
- `src/components/ClassFunnel.jsx` — `payment` step (bookClass branch + render `ClassFunnelCheckout`).
- `src/components/LandingPageSettingsForm.jsx` — price field in `ClassFunnelEdit` + `summaryFor`.
- `src/proxy.js` + `src/components/AppShell.jsx` — allowlist `/class-pay/`.

---

## Task 1: Shared Revolut embed loader

Extract from `RaceCheckoutPage` so the SDK loader has one home; refactor RaceCheckoutPage to use it (behaviour-preserving).

**Files:** Create `src/lib/revolut-embed.js` (+ `.test.js`); Modify `src/components/RaceCheckoutPage.jsx`.

- [ ] **Step 1: Write the failing test** — `src/lib/revolut-embed.test.js`:
```js
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { revolutMode, revolutSdkUrl } from './revolut-embed'

describe('revolut-embed config', () => {
  beforeEach(() => { delete process.env.NEXT_PUBLIC_REVOLUT_MODE })
  it('defaults to sandbox mode', () => {
    expect(revolutMode()).toBe('sandbox')
  })
  it('uses prod mode only when explicitly set', () => {
    process.env.NEXT_PUBLIC_REVOLUT_MODE = 'prod'
    expect(revolutMode()).toBe('prod')
  })
  it('maps mode → SDK url', () => {
    expect(revolutSdkUrl('prod')).toBe('https://merchant.revolut.com/embed.js')
    expect(revolutSdkUrl('sandbox')).toBe('https://sandbox-merchant.revolut.com/embed.js')
    expect(revolutSdkUrl('anything-else')).toBe('https://sandbox-merchant.revolut.com/embed.js')
  })
})
```

- [ ] **Step 2: Run — verify fail** — `cd ~/code/un1t-crm-payui && npx vitest run src/lib/revolut-embed.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement** — `src/lib/revolut-embed.js`:
```js
// Revolut Embedded Checkout SDK loader — shared by RaceCheckoutPage and the
// class-funnel checkout. Loads the merchant embed.js once and resolves the
// global RevolutCheckout. Browser-only.
const SDK_URLS = {
  sandbox: 'https://sandbox-merchant.revolut.com/embed.js',
  prod: 'https://merchant.revolut.com/embed.js',
}

export function revolutMode() {
  return process.env.NEXT_PUBLIC_REVOLUT_MODE === 'prod' ? 'prod' : 'sandbox'
}

export function revolutPublicKey() {
  return process.env.NEXT_PUBLIC_REVOLUT_PUBLIC_KEY || ''
}

export function revolutSdkUrl(mode) {
  return SDK_URLS[mode] || SDK_URLS.sandbox
}

let sdkPromise = null
export function loadRevolutSdk(mode = revolutMode()) {
  if (typeof window === 'undefined') return Promise.reject(new Error('SSR'))
  if (window.RevolutCheckout) return Promise.resolve(window.RevolutCheckout)
  if (sdkPromise) return sdkPromise
  sdkPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = revolutSdkUrl(mode)
    script.async = true
    script.onload = () => resolve(window.RevolutCheckout)
    script.onerror = () => reject(new Error('Failed to load Revolut SDK'))
    document.head.appendChild(script)
  })
  return sdkPromise
}
```

- [ ] **Step 4: Run — verify pass.**

- [ ] **Step 5: Refactor RaceCheckoutPage to use it** — in `src/components/RaceCheckoutPage.jsx`, delete the local `SDK_URLS`, `loadRevolutSdk`, `sdkPromise`, and the `REVOLUT_MODE`/`REVOLUT_PUBLIC_KEY` consts; import instead:
```js
import { loadRevolutSdk, revolutMode, revolutPublicKey } from '@/lib/revolut-embed'
```
Then replace uses: `REVOLUT_MODE` → `revolutMode()`, `REVOLUT_PUBLIC_KEY` → `revolutPublicKey()`, and `loadRevolutSdk(REVOLUT_MODE)` → `loadRevolutSdk(revolutMode())`. Leave the Stripe path and all race routing untouched.

- [ ] **Step 6: Build + verify RaceCheckoutPage unchanged in behaviour**
`cd ~/code/un1t-crm-payui && npm run build 2>&1 | tail -8 && npm run lint 2>&1 | tail -3`
Expected: build succeeds; 0 lint errors. (No behavioural change — same SDK, same URLs.)

- [ ] **Step 7: Commit**
```bash
cd ~/code/un1t-crm-payui
git add src/lib/revolut-embed.js src/lib/revolut-embed.test.js src/components/RaceCheckoutPage.jsx
git commit -m "PAID-INTRO-P2.1 — shared revolut-embed SDK loader (extracted from RaceCheckoutPage)"
```

---

## Task 2: euros↔cents helper (TDD)

**Files:** Create `src/lib/price-format.js` (+ `.test.js`).

- [ ] **Step 1: Write the failing test** — `src/lib/price-format.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { centsToEuros, eurosToCents } from './price-format'

describe('price-format', () => {
  it('centsToEuros formats for display (empty when 0/unset)', () => {
    expect(centsToEuros(2900)).toBe('29')
    expect(centsToEuros(2950)).toBe('29.5')
    expect(centsToEuros(0)).toBe('')
    expect(centsToEuros(null)).toBe('')
    expect(centsToEuros(undefined)).toBe('')
  })
  it('eurosToCents parses input to integer cents (0 for blank/invalid)', () => {
    expect(eurosToCents('29')).toBe(2900)
    expect(eurosToCents('29.50')).toBe(2950)
    expect(eurosToCents('29.999')).toBe(3000) // rounds
    expect(eurosToCents('')).toBe(0)
    expect(eurosToCents('abc')).toBe(0)
    expect(eurosToCents('-5')).toBe(0) // clamp negative
  })
})
```

- [ ] **Step 2: Run — verify fail.**

- [ ] **Step 3: Implement** — `src/lib/price-format.js`:
```js
// euros ↔ integer cents for the operator price field. Storage is cents
// (price_cents on the class_funnel block); display is euros.
export function centsToEuros(cents) {
  const n = Number(cents)
  if (!Number.isFinite(n) || n <= 0) return ''
  const euros = n / 100
  return String(Number(euros.toFixed(2))) // trim trailing zeros: 29 / 29.5
}

export function eurosToCents(input) {
  const n = Number(String(input).trim())
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.round(n * 100)
}
```

- [ ] **Step 4: Run — verify pass.**

- [ ] **Step 5: Commit**
```bash
cd ~/code/un1t-crm-payui
git add src/lib/price-format.js src/lib/price-format.test.js
git commit -m "PAID-INTRO-P2.2 — euros<->cents helpers for the funnel price field"
```

---

## Task 3: `ClassFunnelCheckout` component (embed + poll)

An isolated client component: mount the Revolut embed against the Phase-1 checkout token, poll the Phase-1 status route as a fallback, call `onPaid` when done. Styled with the funnel card language.

**Files:** Create `src/components/landing-page/ClassFunnelCheckout.jsx`.

- [ ] **Step 1: Create the component**:
```jsx
'use client'

// ClassFunnelCheckout — inline embedded Revolut checkout for a PAID class-funnel
// booking. The class_booking_requests row + Revolut order were created by
// /api/public/class-booking (Phase 1); this only mounts the SDK against the
// existing order token and watches for completion. Styled to sit inside the
// funnel's frosted card.
import { useEffect, useRef, useState } from 'react'
import { loadRevolutSdk, revolutMode, revolutPublicKey } from '@/lib/revolut-embed'

export default function ClassFunnelCheckout({ paymentId, checkout, priceLabel, onPaid, onCancel }) {
  const targetRef = useRef(null)
  const instanceRef = useRef(null)
  const paidRef = useRef(false)
  const [error, setError] = useState(null)

  const markPaid = () => { if (!paidRef.current) { paidRef.current = true; onPaid?.() } }

  // Mount the Revolut embed once.
  useEffect(() => {
    if (checkout?.provider !== 'revolut') { setError('This payment method is not available yet.'); return }
    if (!revolutPublicKey()) { setError('Payment is not configured.'); return }
    if (!checkout?.token || !targetRef.current || instanceRef.current) return
    let destroyed = false
    loadRevolutSdk(revolutMode())
      .then((RC) => {
        if (destroyed) return
        instanceRef.current = RC.embeddedCheckout({
          publicToken: revolutPublicKey(),
          mode: revolutMode(),
          locale: 'auto',
          target: targetRef.current,
          createOrder: async () => ({ publicId: checkout.token }),
          onSuccess: () => { if (!destroyed) markPaid() },
          onError: ({ error }) => { if (!destroyed) setError(error?.message || 'Payment failed. Please try again.') },
          onCancel: () => { if (!destroyed) onCancel?.() },
        })
      })
      .catch((e) => { if (!destroyed) setError(e.message || 'Could not load the payment widget.') })
    return () => {
      destroyed = true
      try { instanceRef.current?.destroy?.() } catch {}
      instanceRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout])

  // Poll the status route as a fallback (some methods don't fire onSuccess inline).
  useEffect(() => {
    if (!paymentId) return
    let stopped = false
    const tick = async () => {
      if (stopped || paidRef.current) return
      try {
        const r = await fetch(`/api/public/class-booking-payments/${paymentId}`, { cache: 'no-store' })
        const j = await r.json().catch(() => ({}))
        if (!stopped && j?.data?.paid) { markPaid(); return }
      } catch { /* keep polling */ }
      if (!stopped) setTimeout(tick, 3000)
    }
    const t = setTimeout(tick, 3000)
    return () => { stopped = true; clearTimeout(t) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentId])

  return (
    <div>
      <div className="mb-4 text-center">
        <h1 className="font-display font-extrabold uppercase text-2xl mb-1">Secure checkout</h1>
        {priceLabel && <p className="text-white/60 text-sm">{priceLabel}</p>}
      </div>
      {error ? (
        <p className="text-sm text-red-300 text-center">{error}</p>
      ) : (
        <div ref={targetRef} className="min-h-[320px]" />
      )}
      {onCancel && !error && (
        <button type="button" onClick={onCancel} className="mt-4 w-full text-white/50 text-sm hover:text-white/80">← Back</button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Build + lint** — `cd ~/code/un1t-crm-payui && npm run build 2>&1 | tail -6 && npm run lint 2>&1 | tail -3`. Expected: succeeds, 0 errors.

- [ ] **Step 3: Commit**
```bash
cd ~/code/un1t-crm-payui
git add src/components/landing-page/ClassFunnelCheckout.jsx
git commit -m "PAID-INTRO-P2.3 — ClassFunnelCheckout: inline embedded Revolut checkout + status poll"
```

---

## Task 4: Wire the payment step into `ClassFunnel`

**Files:** Modify `src/components/ClassFunnel.jsx`.

- [ ] **Step 1: Import + state** — add the import near the top:
```js
import ClassFunnelCheckout from '@/components/landing-page/ClassFunnelCheckout'
```
Add a `payment` state next to the other `useState`s (near `const [step, setStep]`):
```js
  const [payment, setPayment] = useState(null) // { paymentId, checkout } when requiresPayment
```
Update the `step` comment to include `payment`:
```js
  const [step, setStep] = useState('details') // details | calendar | classpick | payment | done | classdone
```

- [ ] **Step 2: Branch in `bookClass`** — replace the success tail of `bookClass`:
```js
      if (!r.ok || j.success === false) { setError(j.error || 'Something went wrong — please try again.'); return }
      fireStep('booked_class')
      setStep('classdone')
```
with:
```js
      if (!r.ok || j.success === false) { setError(j.error || 'Something went wrong — please try again.'); return }
      if (j.data?.requiresPayment) {
        setPayment({ paymentId: j.data.paymentId, checkout: j.data.checkout })
        fireStep('payment_view')
        setStep('payment')
        return
      }
      fireStep('booked_class')
      setStep('classdone')
```

- [ ] **Step 3: Render the payment step** — add this block next to the other step renders (e.g. right before the `{step === 'classdone' && (` block):
```jsx
      {step === 'payment' && payment && (
        <ClassFunnelCheckout
          paymentId={payment.paymentId}
          checkout={payment.checkout}
          priceLabel={payment.checkout?.amountLabel || null}
          onPaid={() => { fireStep('booked_class'); setStep('classdone') }}
          onCancel={() => { setStep('classpick') }}
        />
      )}
```
(Note: `amountLabel` isn't in the Phase-1 checkout payload; `priceLabel` will just be null → the heading shows without a price line. Leaving the hook in place is fine; a follow-up can thread a formatted amount through the booking response. Do NOT invent a client-derived amount.)

- [ ] **Step 4: Build + lint** — `npm run build 2>&1 | tail -6 && npm run lint 2>&1 | tail -3`. Expected: succeeds; 0 errors (the checkout component's two effects carry their own `eslint-disable` for exhaustive-deps).

- [ ] **Step 5: Commit**
```bash
cd ~/code/un1t-crm-payui
git add src/components/ClassFunnel.jsx
git commit -m "PAID-INTRO-P2.4 — ClassFunnel: payment step (paid bookings mount inline checkout)"
```

---

## Task 5: Editor price field

**Files:** Modify `src/components/LandingPageSettingsForm.jsx`.

- [ ] **Step 1: Import the helper** — near the top:
```js
import { centsToEuros, eurosToCents } from '@/lib/price-format'
```

- [ ] **Step 2: Add the price field to `ClassFunnelEdit`** — place a new `<Field>` right after the "Trial product granted on booking" field (and before the consult-upsell field):
```jsx
      <Field
        label="Price (€)"
        hint="Leave blank for a FREE trial (today's behaviour). If set, the funnel charges this for the chosen trial product — the location's payment rail must be configured."
      >
        <Input
          value={centsToEuros(block.price_cents)}
          onChange={(v) => onUpdate({ price_cents: eurosToCents(v) })}
          maxLength={10}
          placeholder="e.g. 29"
        />
      </Field>
```

- [ ] **Step 3: Extend `summaryFor`** — the `class_funnel` case currently returns `${base}` / `${base} · trial set`. Append a price marker. Replace the `case 'class_funnel':` block with:
```js
    case 'class_funnel': {
      let base = block.consult_slug ? `consult: ${block.consult_slug}` : 'no consult upsell'
      if (block.trial_membership_id) base = `${base} · trial set`
      if (Number(block.price_cents) > 0) base = `${base} · €${centsToEuros(block.price_cents)}`
      return base
    }
```

- [ ] **Step 4: Build + lint** — `npm run build 2>&1 | tail -6 && npm run lint 2>&1 | tail -3`.

- [ ] **Step 5: Commit**
```bash
cd ~/code/un1t-crm-payui
git add src/components/LandingPageSettingsForm.jsx
git commit -m "PAID-INTRO-P2.5 — editor: price (€) field on the class_funnel block"
```

---

## Task 6: `/class-pay/[id]` return page + allowlists

**Files:** Create `src/app/class-pay/[id]/page.js`, `src/components/ClassPayStatus.jsx`; Modify `src/proxy.js`, `src/components/AppShell.jsx`.

- [ ] **Step 1: Status island** — `src/components/ClassPayStatus.jsx`:
```jsx
'use client'
import { useEffect, useState } from 'react'

export default function ClassPayStatus({ paymentId }) {
  const [state, setState] = useState('loading') // loading | paid | pending | failed | notfound
  useEffect(() => {
    let stopped = false
    const tick = async () => {
      if (stopped) return
      try {
        const r = await fetch(`/api/public/class-booking-payments/${paymentId}`, { cache: 'no-store' })
        if (r.status === 404) { if (!stopped) setState('notfound'); return }
        const j = await r.json().catch(() => ({}))
        const d = j?.data
        if (!stopped) {
          if (d?.paid) { setState('paid'); return }
          if (d?.payment_status === 'failed' || d?.payment_status === 'expired' || d?.booking_status === 'payment_failed') { setState('failed'); return }
          setState('pending')
        }
      } catch { if (!stopped) setState('pending') }
      if (!stopped) setTimeout(tick, 3000)
    }
    tick()
    return () => { stopped = true }
  }, [paymentId])

  const wrap = (title, body) => (
    <div className="min-h-screen bg-black text-white flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-3xl border border-white/12 bg-black/45 backdrop-blur-xl px-6 py-10 text-center">
        <p className="font-display font-extrabold uppercase text-3xl mb-3">{title}</p>
        <p className="text-white/70">{body}</p>
      </div>
    </div>
  )

  if (state === 'paid') return wrap("You're being booked in 🎉", "That's your first class — watch for a WhatsApp confirming it. See you soon!")
  if (state === 'failed') return wrap('Payment didn’t go through', 'No charge was taken. Head back to the funnel to try again.')
  if (state === 'notfound') return wrap('Not found', 'We couldn’t find that payment.')
  return wrap('Confirming your payment…', 'One moment — this page updates automatically.')
}
```

- [ ] **Step 2: The page** — `src/app/class-pay/[id]/page.js`:
```js
// /class-pay/[id] — public return page for a PAID class-funnel booking. The
// Revolut returnUrl (set in Phase 1) lands here for 3DS/redirect methods; polls
// the public status route and shows booked / confirming / failed.
import { poppinsBody as poppins } from '@/fonts/poppins'
import ClassPayStatus from '@/components/ClassPayStatus'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const metadata = { robots: { index: false, follow: false } }

export default async function Page(props) {
  const { id } = await props.params
  return (
    <div className={`${poppins.variable} font-body`}>
      <ClassPayStatus paymentId={id} />
    </div>
  )
}
```

- [ ] **Step 3: Allowlist `/class-pay/` — proxy.js** — in `src/proxy.js`, add `'/class-pay/'` to the `publicPaths` array (next to `'/event-pay/'`).

- [ ] **Step 4: Allowlist `/class-pay` — AppShell** — in `src/components/AppShell.jsx`, add `'/class-pay'` to the `PUBLIC_PATHS` array (next to `'/event-pay'`).

- [ ] **Step 5: Build + route-guards + location-scoping** —
```bash
cd ~/code/un1t-crm-payui
npm run build 2>&1 | tail -8
npm run check:route-guards 2>&1 | tail -3
node scripts/check-location-scoping.mjs 2>&1 | tail -3
```
Expected: build succeeds; `/class-pay/[id]` present; route-guards passes (it's a page, not an `/api` route); location-scoping passes (the page does no DB query — the island fetches the already-exempt public poll route). If location-scoping flags anything, it will be the poll route (already EXEMPT from Phase 1) — no new query is added here.

- [ ] **Step 6: Commit**
```bash
cd ~/code/un1t-crm-payui
git add "src/app/class-pay/[id]/page.js" src/components/ClassPayStatus.jsx src/proxy.js src/components/AppShell.jsx
git commit -m "PAID-INTRO-P2.6 — public /class-pay/[id] return page + allowlists"
```

---

## Task 7: Full verification + PR

**Files:** none.

- [ ] **Step 1: Full test suite** — `cd ~/code/un1t-crm-payui && npm test 2>&1 | tail -8`. Expected: all pass incl. new revolut-embed + price-format tests.

- [ ] **Step 2: CI mirror + the extra scoping check**
```bash
cd ~/code/un1t-crm-payui && npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && node scripts/check-location-scoping.mjs
```
Expected: all exit 0. (`check:location-scoping` is NOT in the CLAUDE.md six-mirror — run it explicitly; Phase 1 lesson.)

- [ ] **Step 3: Production build** — `npm run build 2>&1 | tail -15`. Expected: success; `/class-pay/[id]` + the funnel present.

- [ ] **Step 4: Manual smoke (Revolut sandbox, Stillorgan)** — set `price_cents` on the Stillorgan `class_funnel` block (editor Price field). Run the funnel: details → pick class → the embedded checkout mounts in the card → sandbox-pay → advances to "being booked in" and the `class_booking_requests` row goes `awaiting_payment`→`queued`→booked (verify in DB / logs). Cancel returns to class pick; a card decline shows the error. A block with a blank price still books free with NO payment step. Load `/class-pay/<id>` directly → shows the right status. Document what needed live creds.

- [ ] **Step 5: Push + PR**
```bash
cd ~/code/un1t-crm-payui
git push -u origin class-funnel-pay-ui
gh pr create --base main --fill
```
Report the PR URL. Body: Phase 2 of the paid-intro feature; needs `NEXT_PUBLIC_REVOLUT_*` env (already in prod); after merge a paid Stillorgan block is fully live. Vercel preview is the real gate for the embed.

---

## Self-review notes (spec coverage)

- Shared Revolut embed loader + RaceCheckoutPage refactor → Task 1. ✅
- Inline embedded checkout step in the funnel → Tasks 3, 4. ✅
- Status-poll fallback → Task 3 (second effect). ✅
- Editor price field (euros↔cents) + summary → Tasks 2, 5. ✅
- `/class-pay/[id]` return page + BOTH allowlists (proxy + AppShell) → Task 6. ✅
- Money integrity: client only mounts against the Phase-1 order token; no client-derived amount (priceLabel left null rather than invented) → Task 4 note. ✅
- `check:location-scoping` run explicitly (Phase-1 lesson) → Tasks 6, 7. ✅

**Naming/type consistency:** the Phase-1 booking response is `{ requiresPayment, paymentId, checkout:{ provider, token, url, connectedAccountId } }` — consumed identically in `bookClass` (T4) and passed to `ClassFunnelCheckout` (T3) which reads `checkout.provider`/`checkout.token`. The poll route returns `{ data:{ paid, payment_status, booking_status, checkout, class_name } }` — read the same way in `ClassFunnelCheckout` and `ClassPayStatus`. Block field `price_cents` written by the editor (T5) and read server-side in Phase 1. ✅
