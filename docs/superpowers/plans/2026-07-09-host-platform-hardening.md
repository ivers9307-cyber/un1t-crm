# Host Platform Hardening Wave 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three sequential PRs: (1) Stripe dashboard links + review-loop notifications + pending badge, (2) `charge.refunded` webhook sync, (3) org-wide booking-fee report.

**Architecture:** All additive; no migrations. Notifications are fire-and-forget `sendTransactionalEmail` calls after status writes. The refund sync mirrors the staff refund route's absolute-amount semantics so revenue math stays correct. Fee reporting is a paginated org aggregation + an accounting surface.

**Tech Stack:** Next.js 16 App Router, Supabase service-role, Postmark (`sendTransactionalEmail({to, subject, htmlBody, locationId, tag})`), Stripe SDK (`getStripe()` from `@/lib/stripe`), Vitest. Spec: `docs/superpowers/specs/2026-07-09-host-platform-hardening-design.md`.

Branches: PR-1 on `host-platform-hardening` (current); PR-2/PR-3 each branch fresh off `origin/main` after the prior merge (`host-refund-sync`, `org-event-fees`).

---

## PR-1 — HOST-PORTAL.6 (branch `host-platform-hardening`)

### Task 1: Stripe links (UI only)

**Files:** Modify `src/components/settings/HostDetail.jsx`, `src/app/host/(portal)/page.js`

- [ ] In HostDetail's Stripe card (READ the file; find the Stripe Connect card with "Connect with Stripe"/status flags): when `host?.stripe_connected_account_id` is truthy, render an external link styled like the file's muted links:
```jsx
<a
  href={`https://dashboard.stripe.com/connect/accounts/${host.stripe_connected_account_id}`}
  target="_blank" rel="noopener noreferrer"
  className="text-xs text-un1t-subtle hover:text-un1t-text inline-flex items-center gap-1"
>
  View in Stripe <ExternalLink size={10} />
</a>
```
(`ExternalLink` already imported.) Place it beside the status flags / refresh button.
- [ ] In the host portal dashboard (`src/app/host/(portal)/page.js`): for `isStripe && session.host.stripe_connected_account_id`, render under the Revenue section:
```jsx
<a href="https://dashboard.stripe.com" target="_blank" rel="noopener noreferrer"
   className="text-xs text-white/40 hover:text-white">
  Stripe dashboard →
</a>
```
Note: `HOST_PORTAL_COLS` in `src/lib/host-auth.js` already includes `stripe_connected_account_id`.
- [ ] Verify: `npm run lint`, `npm run build`. Commit: `git commit -m "HOST-PORTAL.6 — Stripe dashboard links (admin connect view + host login)"`

### Task 2: host-notifications lib (TDD)

**Files:** Create `src/lib/host-notifications.js` + `src/lib/host-notifications.test.js`

- [ ] Failing tests first:
```js
import { describe, it, expect } from 'vitest'
import { assembleHostRecipients, buildReviewedEmail, buildSubmittedEmail } from './host-notifications'

describe('assembleHostRecipients', () => {
  it('dedupes + lowercases host email and linked logins, skipping empties', () => {
    expect(assembleHostRecipients({ email: 'Host@X.ie' }, [{ email: 'host@x.ie' }, { email: 'B@x.ie' }, { email: null }]))
      .toEqual(['host@x.ie', 'b@x.ie'])
  })
  it('handles missing host email and empty links', () => {
    expect(assembleHostRecipients({ email: null }, [])).toEqual([])
  })
})

describe('buildReviewedEmail', () => {
  const event = { name: 'Summer Throwdown', slug: 'summer-throwdown' }
  it('approved: subject says live + body links the public page', () => {
    const m = buildReviewedEmail({ event, action: 'approve', appUrl: 'https://crm.x.com' })
    expect(m.subject).toContain('live')
    expect(m.htmlBody).toContain('https://crm.x.com/event/summer-throwdown')
  })
  it('rejected: subject says needs changes + body carries the escaped reason + portal link', () => {
    const m = buildReviewedEmail({ event, action: 'reject', reason: 'Fix <the> date', appUrl: 'https://crm.x.com' })
    expect(m.subject).toContain('needs changes')
    expect(m.htmlBody).toContain('Fix &lt;the&gt; date')
    expect(m.htmlBody).toContain('https://crm.x.com/host')
  })
})

describe('buildSubmittedEmail', () => {
  it('names the host + event and links the review queue', () => {
    const m = buildSubmittedEmail({ event: { name: 'Gala' }, host: { name: 'Acme' }, appUrl: 'https://crm.x.com' })
    expect(m.subject).toContain('Gala')
    expect(m.htmlBody).toContain('Acme')
    expect(m.htmlBody).toContain('https://crm.x.com/settings/hosts')
  })
})
```
- [ ] Implement. Pure builders escape interpolated user strings (reuse or copy the `escapeHtml` from `src/lib/event-email.js` — import it if exported, else a local 5-line escaper). Simple HTML paragraphs; no marketing shell needed. Plus two async senders (NOT in the tests — thin IO):
```js
export function assembleHostRecipients(host, links) { /* dedupe/lowercase/skip-empty */ }
export function buildReviewedEmail({ event, action, reason, appUrl }) { /* -> {subject, htmlBody} */ }
export function buildSubmittedEmail({ event, host, appUrl }) { /* -> {subject, htmlBody} */ }

export async function notifyHostEventReviewed({ db, event, host, action, reason }) {
  const { getAppUrl } = await import('./app-url')
  const { sendTransactionalEmail } = await import('./postmark')
  const { data: links } = await db.from('host_users').select('email').eq('host_id', host.id)
  const to = assembleHostRecipients(host, links || [])
  if (!to.length) return
  const msg = buildReviewedEmail({ event, action, reason, appUrl: getAppUrl() })
  for (const rcpt of to) {
    await sendTransactionalEmail({ to: rcpt, subject: msg.subject, htmlBody: msg.htmlBody, locationId: event.location_id, tag: 'host-event-review' })
  }
}

export async function notifyAdminsEventSubmitted({ db, event, host, orgId }) {
  const { getAppUrl } = await import('./app-url')
  const { sendTransactionalEmail } = await import('./postmark')
  const { ADMIN_ROLES } = await import('./schemas')
  // org's locations -> profile_locations with an admin role -> profiles emails
  const { data: locs } = await db.from('locations').select('id').eq('organization_id', orgId)
  const locIds = (locs || []).map((l) => l.id)
  if (!locIds.length) return
  const { data: pls } = await db.from('profile_locations').select('profile_id, role').in('location_id', locIds)
  const adminIds = [...new Set((pls || []).filter((r) => ADMIN_ROLES.includes(r.role)).map((r) => r.profile_id))]
  if (!adminIds.length) return
  const { data: profs } = await db.from('profiles').select('email').in('id', adminIds)
  const to = [...new Set((profs || []).map((p) => (p.email || '').toLowerCase().trim()).filter(Boolean))]
  if (!to.length) return
  const msg = buildSubmittedEmail({ event, host, appUrl: getAppUrl() })
  for (const rcpt of to) {
    await sendTransactionalEmail({ to: rcpt, subject: msg.subject, htmlBody: msg.htmlBody, locationId: event.location_id, tag: 'host-event-submitted' })
  }
}
```
(Static imports at top are fine too — match repo style; the senders swallow nothing themselves — CALLERS wrap in try/catch.)
- [ ] `npx vitest run src/lib/host-notifications.test.js` → PASS. Commit: `git commit -m "HOST-PORTAL.6 — host-notifications lib (recipients + email builders + senders)"`

### Task 3: wire notifications into review + submit routes

**Files:** Modify `src/app/api/events/[id]/review/route.js`, `src/app/api/host/events/[id]/submit/route.js`

- [ ] Review route: after the CAS update succeeds (0-row check passed), re-select what's needed (`name, slug, location_id` are NOT in the route's current select — extend its event select to `id, host_id, status, name, slug, location_id`) and fire:
```js
try {
  const host = await loadHostForOrg(db, event.host_id, orgId) // already loaded above — reuse that variable
  await notifyHostEventReviewed({ db, event, host, action: parsed.data.action, reason: parsed.data.reason?.trim() || null })
} catch (e) { logError('host-event-review', 'notify host failed', { err: e }) }
```
(fire-and-forget: its own try/catch AFTER the success response is prepared; never change the response. Import `notifyHostEventReviewed` + `logError`.)
- [ ] Submit route: extend its select to `id, host_id, status, name, slug, location_id`; after the update succeeds, resolve orgId from the host row (`event_hosts.organization_id` — fetch `id, name, email, organization_id` for the host) and fire `notifyAdminsEventSubmitted({ db, event, host, orgId: host.organization_id })` in the same try/catch+logError pattern.
- [ ] Verify: `npm run check:route-guards`, `npm run build`, `npm test` (green). Commit: `git commit -m "HOST-PORTAL.6 — notify host on approve/reject + notify org admins on submit"`

### Task 4: pending-review count route + Settings badge

**Files:** Create `src/app/api/hosts/pending-events/count/route.js`; Modify `src/components/Sidebar.jsx`

- [ ] Count route (same gate as the pending-events list; count WITHOUT embeds — repo trap):
```js
import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { ADMIN_ROLES } from '@/lib/schemas'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!ADMIN_ROLES.includes(user.role)) return NextResponse.json({ success: true, data: { count: 0 } })
  const orgId = user.activeOrganization?.id || user.activeLocation?.organization_id || null
  if (!orgId) return NextResponse.json({ success: true, data: { count: 0 } })
  const db = createServerClient()
  const { data: hosts } = await db.from('event_hosts').select('id').eq('organization_id', orgId)
  const ids = (hosts || []).map((h) => h.id)
  if (!ids.length) return NextResponse.json({ success: true, data: { count: 0 } })
  const { count } = await db.from('race_events').select('id', { count: 'exact', head: true }).in('host_id', ids).eq('status', 'pending_review')
  return NextResponse.json({ success: true, data: { count: count || 0 } })
}
```
(Note it returns count:0 rather than 403 for non-admins — matches the badge-poll pattern "API short-circuits to 0".) CHECK the response shape the existing count routes return (READ `/api/approvals/count`) and MATCH it exactly so `usePolledCount` parses it (it may expect `{count}` at top level — mirror whatever `/api/approvals/count` returns).
- [ ] Sidebar: add beside the other polled counts:
```js
const hostEventsPendingCount = usePolledCount({
  enabled: ['master','owner','manager'].includes(user?.role),
  url: '/api/hosts/pending-events/count',
})
```
and surface it as the badge on the **Settings** nav entry (READ how existing counts map to nav-item badges — there'll be a badge lookup by nav key; add settings → hostEventsPendingCount, summing with any existing settings badge if present).
- [ ] Verify: `npm run check:route-guards` (session-guarded), `npm run lint`, `npm run build`, `npm test`. Commit: `git commit -m "HOST-PORTAL.6 — pending host-event badge on Settings (polled count)"`

### Task 5: PR-1 ship
- [ ] Full CI mirror + `npm run build`. Push `host-platform-hardening`, open PR "HOST-PORTAL.6 — Stripe links + review-loop notifications + pending badge", wait CI green, squash-merge (user pre-approved the sequence).

---

## PR-2 — HOST-PORTAL.7 (fresh branch `host-refund-sync` off origin/main)

### Task 6: pure refund-patch helper (TDD)

**Files:** Create `src/lib/stripe-refund-sync.js` + `src/lib/stripe-refund-sync.test.js`

- [ ] Failing tests:
```js
import { describe, it, expect } from 'vitest'
import { refundPatchFromCharge } from './stripe-refund-sync'

describe('refundPatchFromCharge', () => {
  const payment = { amount_cents: 5000, refunded_amount_cents: 0, refunded_at: null }
  it('partial refund: absolute amount, status stays completed', () => {
    const p = refundPatchFromCharge({ amount_refunded: 2000 }, payment, '2026-07-09T10:00:00.000Z')
    expect(p).toEqual({ refunded_amount_cents: 2000, refunded_at: '2026-07-09T10:00:00.000Z', status: 'completed' })
  })
  it('full refund flips status to refunded', () => {
    const p = refundPatchFromCharge({ amount_refunded: 5000 }, payment, 'T')
    expect(p.status).toBe('refunded')
  })
  it('re-delivery with same amount is a no-op (returns null)', () => {
    expect(refundPatchFromCharge({ amount_refunded: 2000 }, { ...payment, refunded_amount_cents: 2000, refunded_at: 'X' }, 'T')).toBeNull()
  })
  it('keeps the existing refunded_at when increasing the amount', () => {
    const p = refundPatchFromCharge({ amount_refunded: 5000 }, { ...payment, refunded_amount_cents: 2000, refunded_at: 'X' }, 'T')
    expect(p.refunded_at).toBe('X')
  })
  it('never lowers a recorded refund (stale event) — returns null', () => {
    expect(refundPatchFromCharge({ amount_refunded: 1000 }, { ...payment, refunded_amount_cents: 2000, refunded_at: 'X' }, 'T')).toBeNull()
  })
})
```
- [ ] Implement:
```js
// charge.refunded → race_payments patch (HOST-PORTAL.7). Absolute amounts from
// Stripe (charge.amount_refunded is the cumulative total), so re-delivery is
// idempotent; mirrors /api/orders/[id]/refund semantics: partial stays
// 'completed', full → 'refunded'. Returns null when nothing needs writing.
export function refundPatchFromCharge(charge, payment, nowIso) {
  const refunded = Number(charge?.amount_refunded) || 0
  const current = Number(payment?.refunded_amount_cents) || 0
  if (refunded <= current) return null
  return {
    refunded_amount_cents: refunded,
    refunded_at: payment?.refunded_at || nowIso,
    status: refunded >= (Number(payment?.amount_cents) || 0) ? 'refunded' : 'completed',
  }
}
```
- [ ] PASS + commit: `git commit -m "HOST-PORTAL.7 — refundPatchFromCharge (idempotent absolute refund mapping)"`

### Task 7: `charge.refunded` webhook branch

**Files:** Modify `src/app/api/webhooks/stripe/route.js`

- [ ] READ the file fully first (its event switch, `resolveRacePaymentByProviderRef`, how it builds the Stripe client, how it returns 200 for unhandled). Add a branch:
```js
if (event.type === 'charge.refunded') {
  const charge = event.data.object
  try {
    // Direct charges live on the CONNECTED account (event.account). Resolve the
    // checkout session by payment_intent to get our provider ref (session id).
    const stripe = getStripe()
    const sessions = await stripe.checkout.sessions.list(
      { payment_intent: typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id, limit: 1 },
      event.account ? { stripeAccount: event.account } : undefined,
    )
    const session = sessions?.data?.[0]
    const payment = session ? await resolveRacePaymentByProviderRef(db, session.id) : null
    if (!payment) {
      logError('stripe-webhook', 'charge.refunded: no matching race_payment', { chargeId: charge.id, account: event.account || null })
      return NextResponse.json({ received: true }) // 200 — recognised but unmatched
    }
    const patch = refundPatchFromCharge(charge, payment, new Date().toISOString())
    if (patch) await db.from('race_payments').update(patch).eq('id', payment.id)
  } catch (e) {
    logError('stripe-webhook', 'charge.refunded handling failed', { err: e })
    return NextResponse.json({ received: true }) // never non-2xx for a recognised event
  }
  return NextResponse.json({ received: true })
}
```
ADAPT to the file's actual shape (its response helper/var names, where `db` is created, whether it uses `getStripe()` already, the exact existing 200-return idiom). Also update the line-~88 comment (charge.refunded is no longer deferred; payouts still are).
- [ ] Verify: `npm test` (green), `npm run check:route-guards` (webhook still verify-guarded), `npm run build`. Commit: `git commit -m "HOST-PORTAL.7 — sync Stripe-side refunds into race_payments (charge.refunded)"`

### Task 8: PR-2 ship (money path — adversarial review first)
- [ ] Adversarial review (single strong reviewer): (a) idempotency under re-delivery + out-of-order events (stale lower amount must not clobber — the helper returns null); (b) can a forged/foreign charge event corrupt a payment (webhook signature verify gates entry; unmatched → no-op)? (c) does the status mapping keep `aggregateHostRevenue` correct (partial=completed, full=refunded)? (d) 200-on-unmatched (no provider auto-disable). Fix confirmed findings.
- [ ] Full CI mirror + build → push `host-refund-sync` → PR "HOST-PORTAL.7 — sync Stripe-side refunds" → CI green → squash-merge.

---

## PR-3 — HOST-PORTAL.8 (fresh branch `org-event-fees` off origin/main)

### Task 9: org fee aggregation lib (TDD)

**Files:** Create `src/lib/org-event-fees.js` + `src/lib/org-event-fees.test.js`

- [ ] Failing tests:
```js
import { describe, it, expect } from 'vitest'
import { aggregateOrgEventFees } from './org-event-fees'

describe('aggregateOrgEventFees', () => {
  const hosts = [{ id: 'h1', name: 'Acme' }, { id: 'h2', name: 'Beta' }]
  const events = [{ id: 'e1', host_id: 'h1' }, { id: 'e2', host_id: 'h2' }]
  const pays = [
    { race_event_id: 'e1', application_fee_cents: 200, status: 'completed', created_at: '2026-07-01T10:00:00Z' },
    { race_event_id: 'e1', application_fee_cents: 400, status: 'refunded', created_at: '2026-06-15T10:00:00Z' },
    { race_event_id: 'e2', application_fee_cents: null, status: 'completed', created_at: '2026-07-02T10:00:00Z' },
    { race_event_id: 'e1', application_fee_cents: 999, status: 'pending', created_at: '2026-07-03T10:00:00Z' },
  ]
  it('sums settled fees only (NULL fee = 0, pending excluded)', () => {
    const r = aggregateOrgEventFees(pays, events, hosts)
    expect(r.total_fee_cents).toBe(600)
    expect(r.paidCount).toBe(3)
  })
  it('per-host rollup with names', () => {
    const r = aggregateOrgEventFees(pays, events, hosts)
    expect(r.perHost).toEqual([
      { host_id: 'h1', name: 'Acme', fee_cents: 600, paidCount: 2 },
      { host_id: 'h2', name: 'Beta', fee_cents: 0, paidCount: 1 },
    ])
  })
  it('per-month buckets by created_at (UTC YYYY-MM), newest first', () => {
    const r = aggregateOrgEventFees(pays, events, hosts)
    expect(r.perMonth).toEqual([
      { month: '2026-07', fee_cents: 200 },
      { month: '2026-06', fee_cents: 400 },
    ])
  })
})
```
- [ ] Implement pure `aggregateOrgEventFees(payments, events, hosts)` (settled = completed|refunded; perHost sorted fee desc; perMonth = `created_at.slice(0,7)` buckets sorted desc) + fetch `getOrgEventFees(db, orgId)` (hosts by org → events `.in('host_id')` → payments `.in('race_event_id')` `.in('status', ['completed','refunded'])`, `.range()`-paginated at 1000 with `.order('id')`, selecting `race_event_id, application_fee_cents, status, created_at`).
- [ ] PASS + commit: `git commit -m "HOST-PORTAL.8 — org event-fees aggregation lib"`

### Task 10: route + accounting card

**Files:** Create `src/app/api/accounting/event-fees/route.js`; Modify the accounting surface (`src/components/accounting/AccountingTabs.jsx` or a card on `src/app/accounting/page.js` — READ both, follow the existing pattern; a new card next to `HuntInboxesCard` is acceptable if tabs are heavy).

- [ ] Route: `getCurrentUser` → 401; `ADMIN_ROLES` → 403; session orgId → 400; `getOrgEventFees(db, orgId)` → `{ success, data }`. (READ a sibling `/api/accounting/*` route first and mirror its gate exactly — if the accounting surface uses a permission key instead of ADMIN_ROLES, match it.)
- [ ] UI: an "Event booking fees" card (client component `src/components/accounting/EventFeesCard.jsx`): fetch on mount, show total (fmt €), per-host table (Host / Bookings / Fees), per-month mini-table. Empty state "No event fees yet." Light-theme primitives, chips per repo recipe, buttons `type="button"`.
- [ ] Verify: `npm run check:route-guards`, `npm run lint`, `npm run build`, `npm test`. Commit: `git commit -m "HOST-PORTAL.8 — /accounting event booking fees (org rollup)"`

### Task 11: PR-3 ship
- [ ] Full CI mirror + build → push `org-event-fees` → PR "HOST-PORTAL.8 — org-wide event booking-fee report" → CI green → squash-merge.

---

## Self-Review (at write time)
- **Spec coverage:** links (T1), notifications lib+wiring (T2-3), badge (T4), refund sync (T6-7 + adversarial T8), fee report (T9-10). No migrations anywhere ✓.
- **Placeholders:** the "READ + mirror" notes are live-schema/shape verifications, not deferred logic ✓.
- **Type consistency:** `notifyHostEventReviewed({db,event,host,action,reason})` / `notifyAdminsEventSubmitted({db,event,host,orgId})` consistent T2↔T3; `refundPatchFromCharge(charge,payment,nowIso)` T6↔T7; `aggregateOrgEventFees(payments,events,hosts)` / `getOrgEventFees(db,orgId)` T9↔T10 ✓.
