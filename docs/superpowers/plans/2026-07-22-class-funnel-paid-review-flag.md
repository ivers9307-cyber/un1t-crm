# Phase 3a — Staff-Review "Paid" Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Flag a class-booking review item as "Paid €X" when the underlying booking was paid, so staff know money was collected before deciding.

**Architecture:** The processor writes payment fields into the review row's `details`; the `/approvals` provider + the customer-agent requests page surface a "Paid €X" marker via a small shared money formatter.

**Tech Stack:** Next.js/React, Vitest. No migration.

**Worktree:** `~/code/un1t-crm-payp3` (branch `class-funnel-pay-p3`, off `origin/main` — has Phases 1+2).

**Spec:** `docs/superpowers/specs/2026-07-22-class-funnel-paid-review-flag-design.md`

---

## Task 1: `formatMoneyMinor` helper (TDD)

**Files:** Create `src/lib/money-format.js` (+ `.test.js`).

- [ ] **Step 1: Failing test** — `src/lib/money-format.test.js`:
```js
import { describe, it, expect } from 'vitest'
import { formatMoneyMinor } from './money-format'

describe('formatMoneyMinor', () => {
  it('formats EUR with the € symbol, trimming trailing zeros', () => {
    expect(formatMoneyMinor(2900, 'EUR')).toBe('€29')
    expect(formatMoneyMinor(2950, 'EUR')).toBe('€29.50')
  })
  it('defaults to EUR', () => {
    expect(formatMoneyMinor(1000)).toBe('€10')
  })
  it('supports GBP', () => {
    expect(formatMoneyMinor(1000, 'GBP')).toBe('£10')
  })
  it('falls back to a currency code for unknown currencies', () => {
    expect(formatMoneyMinor(1000, 'USD')).toBe('USD 10.00')
  })
  it('handles 0 / invalid as an empty string', () => {
    expect(formatMoneyMinor(0)).toBe('')
    expect(formatMoneyMinor(null)).toBe('')
    expect(formatMoneyMinor('x')).toBe('')
  })
})
```

- [ ] **Step 2: Run — verify fail.** `cd ~/code/un1t-crm-payp3 && npx vitest run src/lib/money-format.test.js`

- [ ] **Step 3: Implement** — `src/lib/money-format.js`:
```js
// Display a minor-unit amount (cents) as money. Used by staff-facing surfaces
// (approvals, review page). Distinct from price-format.js (editor input parsing).
const SYMBOLS = { EUR: '€', GBP: '£' }

export function formatMoneyMinor(amountCents, currency = 'EUR') {
  const n = Number(amountCents)
  if (!Number.isFinite(n) || n <= 0) return ''
  const major = n / 100
  const symbol = SYMBOLS[currency]
  if (symbol) {
    // €29 / €29.50 — trim trailing zeros
    return `${symbol}${String(Number(major.toFixed(2)))}`
  }
  return `${currency} ${major.toFixed(2)}`
}
```

- [ ] **Step 4: Run — verify pass.**

- [ ] **Step 5: Commit**
```bash
cd ~/code/un1t-crm-payp3
git add src/lib/money-format.js src/lib/money-format.test.js
git commit -m "PAID-INTRO-P3A.1 — formatMoneyMinor display helper"
```

---

## Task 2: Processor writes payment fields into the review details

**Files:** Modify `src/lib/class-booking-processor.js`.

- [ ] **Step 1: Edit `routeToReview`'s insert** — find:
```js
        details: { event_id: request.glofox_event_id, class_name: request.class_name, class_time: classLabel(request.starts_at), mode: 'draft', source: 'start_funnel', reason },
```
Replace with:
```js
        details: {
          event_id: request.glofox_event_id, class_name: request.class_name, class_time: classLabel(request.starts_at),
          mode: 'draft', source: 'start_funnel', reason,
          ...(request.payment_status === 'paid'
            ? { paid: true, amount_cents: request.amount_cents, currency: request.currency || 'EUR' }
            : {}),
        },
```
(The `request` row already carries `payment_status`/`amount_cents`/`currency` from Phase 1; free bookings add nothing.)

- [ ] **Step 2: Lint** — `cd ~/code/un1t-crm-payp3 && npm run lint 2>&1 | tail -3`. Expected: 0 errors.

- [ ] **Step 3: Confirm processor tests still pass** — `npx vitest run src/lib/class-booking-processor.test.js 2>&1 | tail -5`. Expected: pass (additive change; existing tests use free/unpaid rows).

- [ ] **Step 4: Commit**
```bash
cd ~/code/un1t-crm-payp3
git add src/lib/class-booking-processor.js
git commit -m "PAID-INTRO-P3A.2 — processor stamps paid/amount on the review item's details"
```

---

## Task 3: Surface "Paid €X" in the approvals provider (TDD)

**Files:** Modify `src/lib/approvals/providers/agent-requests.js` (+ its test file if one exists; else add one).

- [ ] **Step 1: Failing test** — add to the agent-requests test (find `agent-requests.test.js`; if none, create `src/lib/approvals/providers/agent-requests.test.js` importing `agentRequestSubtitle`):
```js
import { describe, it, expect } from 'vitest'
import { agentRequestSubtitle } from './agent-requests'

describe('agentRequestSubtitle — paid class booking', () => {
  it('appends a paid marker when the booking was paid', () => {
    const s = agentRequestSubtitle({ kind: 'class_booking', details: { class_name: 'HIIT', class_time: 'Mon 6pm', paid: true, amount_cents: 2900, currency: 'EUR' } })
    expect(s).toBe('HIIT · Mon 6pm · 💳 Paid €29')
  })
  it('omits the marker for a free booking', () => {
    const s = agentRequestSubtitle({ kind: 'class_booking', details: { class_name: 'HIIT', class_time: 'Mon 6pm' } })
    expect(s).toBe('HIIT · Mon 6pm')
  })
})
```

- [ ] **Step 2: Run — verify fail.**

- [ ] **Step 3: Implement** — in `src/lib/approvals/providers/agent-requests.js`:
  - Import the helper at the top: `import { formatMoneyMinor } from '@/lib/money-format'`.
  - In `agentRequestSubtitle`, replace the `class_booking` branch:
```js
  if (row?.kind === 'class_booking') {
    const parts = [d.class_name, d.class_time].filter(Boolean)
    if (d.paid) parts.push(`💳 Paid ${formatMoneyMinor(d.amount_cents, d.currency)}`)
    return parts.join(' · ') || 'Class booking request'
  }
```
  - In the provider's item mapping (the `.map((r) => ({ ... amount: null, currency: null ... }))`), replace `amount: null, currency: null,` with:
```js
      amount: r.details?.paid ? (r.details.amount_cents ?? null) : null,
      currency: r.details?.paid ? (r.details.currency || 'EUR') : null,
```

- [ ] **Step 4: Run — verify pass** (the two new tests + existing ones).

- [ ] **Step 5: Commit**
```bash
cd ~/code/un1t-crm-payp3
git add src/lib/approvals/providers/agent-requests.js src/lib/approvals/providers/agent-requests.test.js
git commit -m "PAID-INTRO-P3A.3 — approvals: show Paid €X on paid class-booking review items"
```

---

## Task 4: "Paid" badge on the customer-agent requests page

**Files:** Modify `src/app/settings/customer-agent/requests/page.js`.

- [ ] **Step 1: Import the helper** — near the top imports:
```js
import { formatMoneyMinor } from '@/lib/money-format'
```

- [ ] **Step 2: Add the badge in `RequestCard`** — in the top row, after the member-name span:
```jsx
          <span className="text-sm font-medium text-un1t-text">{name}</span>
```
add:
```jsx
          {d.paid && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-700">
              Paid {formatMoneyMinor(d.amount_cents, d.currency)}
            </span>
          )}
```
(Light-theme chip contrast per the invariant: `bg-*-500/10 text-*-700`.)

- [ ] **Step 3: Build + lint** — `cd ~/code/un1t-crm-payp3 && npm run build 2>&1 | tail -6 && npm run lint 2>&1 | tail -3`. Expected: succeeds; 0 errors; guardrails chip check passes (emerald-500/10 + emerald-700 is compliant).

- [ ] **Step 4: Commit**
```bash
cd ~/code/un1t-crm-payp3
git add src/app/settings/customer-agent/requests/page.js
git commit -m "PAID-INTRO-P3A.4 — requests page: Paid €X badge on paid class bookings"
```

---

## Task 5: Full verification + PR

- [ ] **Step 1: Full suite** — `cd ~/code/un1t-crm-payp3 && npm test 2>&1 | tail -6`. Expected: all pass incl. money-format + agent-requests.
- [ ] **Step 2: CI mirror + scoping** — `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && node scripts/check-location-scoping.mjs`. Expected: all exit 0. (guardrails covers the chip-contrast check.)
- [ ] **Step 3: Build** — `npm run build 2>&1 | tail -10`. Expected: success.
- [ ] **Step 4: Push + PR**
```bash
cd ~/code/un1t-crm-payp3
git push -u origin class-funnel-pay-p3
gh pr create --base main --fill
```
Report the PR URL. Body: Phase 3a — staff-review paid flag; additive, no migration; Phase 3b/3c (Stripe rail + settings) deferred.

---

## Self-review notes (spec coverage)
- Processor stamps paid/amount/currency into review details → Task 2. ✅
- `/approvals` subtitle + amount/currency → Task 3. ✅
- Requests-page badge → Task 4. ✅
- Shared money formatter (distinct from price-format) → Task 1. ✅
- Non-goals honoured: no refund button; no change to which bookings route to review; no fulfillment change. ✅
- Chip contrast (light-theme invariant) → Task 4 (`bg-emerald-500/10 text-emerald-700`). ✅

**Naming consistency:** review-detail keys `paid` / `amount_cents` / `currency` written in Task 2, read in Tasks 3 + 4. `formatMoneyMinor(amountCents, currency)` defined Task 1, called Tasks 3 + 4. ✅
