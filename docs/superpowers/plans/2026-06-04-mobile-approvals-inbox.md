# Mobile Approvals Inbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A manager-only mobile **Approvals** inbox (More-tab tile → screen) that clears pending time-off, shift-swap, FTE-expense, and contractor-invoice approvals from one place.

**Architecture:** Mobile-only, **no backend changes** — reuses the web `GET /api/approvals/pending` aggregator (uniform `ApprovalItem`) and the existing per-category approve/decline routes (3 of 4 already wrapped in `mobile/lib/`; only contractor-invoice helpers are new). A pure helper filters the aggregator to the four mobile categories. The inbox becomes the single home for approvals, so the schedule **Manage** mode is slimmed back to pure roster editing.

**Tech Stack:** Expo / React Native, expo-router, NativeWind, Vitest (`mobile/lib/**`).

**Spec:** `docs/superpowers/specs/2026-06-04-mobile-approvals-inbox-design.md` · **Branch:** `mobile-approvals-inbox` (checked out, spec committed).

---

## Verified contracts (read 2026-06-04)

```
GET /api/approvals/pending   (no params; scope from getCurrentUser().activeLocation = x-active-location header)
  → { success, data: { providers: [ { key, label, reviewBase, count, items:[ApprovalItem] } ], total } }
  ApprovalItem = { id, title, subtitle, meta, submittedAt, amount, currency, reviewUrl }
  Provider keys for the four mobile categories: 'time_off', 'shift_swaps', 'fte_expenses', 'contractor_invoices'
  (also returns 'issues', 'rosters', 'invoices_queue' etc. — ignored on mobile)

Approve / decline:
  time_off            PUT /api/schedule/time-off/[id] {status:'approved'|'rejected', review_note?}  → respondToTimeOff(id,status,note,locId) ✓
  shift_swaps         PUT /api/schedule/swaps/[id]     {status, review_note?}                        → respondToSwap(id,status,note,locId) ✓
  fte_expenses        POST /api/expenses/[id]/approve  (no body) | /decline {reason REQUIRED}         → approveExpenseClaim(id) / declineExpenseClaim(id,reason) ✓
  contractor_invoices POST /api/invoices/[id]/approve  (no body) | /decline {reason REQUIRED}         → NEW approveInvoice(id) / declineInvoice(id,reason)

mobile/lib/invoices-api.js + expenses-api.js use raw fetch + inline auth headers (NOT the api() wrapper).
mobile/lib/api.js is the wrapper used for GET /api/approvals/pending (sends Bearer + x-active-location + impersonation).
shared/permissions.js: MOBILE_PERMISSIONS = [{key,label,hint,webEquivalent|mobileOnly}]; DEFAULT_MOBILE_PERMISSIONS_BY_ROLE
  has 5 role blocks (master, staff, head_coach, manager, owner) — EVERY key must appear in EVERY block.
```

---

## File Structure

| File | Responsibility |
|---|---|
| `mobile/lib/approvals.js` + `.test.js` | **new** — pure `MOBILE_APPROVAL_KEYS`, `mobileApprovalSections`, `approvalsBadgeCount` |
| `mobile/lib/approvals-api.js` | **new** — `getPendingApprovals({locationId})` |
| `mobile/lib/invoices-api.js` | add `approveInvoice` / `declineInvoice` |
| `mobile/components/approvals/ApprovalCard.jsx` | **new** — uniform-shape card |
| `mobile/components/approvals/DeclineSheet.jsx` | **new** — reason modal |
| `mobile/app/approvals.jsx` | **new** — the inbox screen |
| `mobile/components/schedule/ApprovalCard.jsx` | **delete** — superseded |
| `mobile/components/schedule/ManageMode.jsx` | remove the approvals section |
| `mobile/lib/schedule-api.js` | delete now-unused `getPendingTimeOff` / `getOpenSwaps` |
| `mobile/app/(tabs)/more.jsx` | add the **Approvals** tile + badge |
| `shared/permissions.js` | add `approvals` mobile permission + 5 role defaults |
| `scripts/check-mobile-parity.mjs` | drop `approvals_inbox` from `WEB_ONLY_OK` |

---

## Task 1: Pure `mobile/lib/approvals.js` (TDD)

**Files:** Create `mobile/lib/approvals.js`, `mobile/lib/approvals.test.js`

- [ ] **Step 1: Write the failing tests** — `mobile/lib/approvals.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { mobileApprovalSections, approvalsBadgeCount, MOBILE_APPROVAL_KEYS } from './approvals'

const prov = (key, n) => ({ key, label: key, count: n, items: Array.from({ length: n }, (_, i) => ({ id: `${key}-${i}` })) })

describe('MOBILE_APPROVAL_KEYS', () => {
  it('is the four categories in order', () => {
    expect(MOBILE_APPROVAL_KEYS).toEqual(['time_off', 'shift_swaps', 'fte_expenses', 'contractor_invoices'])
  })
})

describe('mobileApprovalSections', () => {
  it('keeps only the four mobile categories, fixed order, drops empties + unknowns', () => {
    const providers = [
      prov('contractor_invoices', 1),
      prov('issues', 3),       // unknown → excluded
      prov('time_off', 2),
      prov('shift_swaps', 0),  // empty → dropped
      prov('fte_expenses', 1),
    ]
    expect(mobileApprovalSections(providers).map((s) => s.key))
      .toEqual(['time_off', 'fte_expenses', 'contractor_invoices'])
  })
  it('tolerates non-arrays', () => {
    expect(mobileApprovalSections(null)).toEqual([])
    expect(mobileApprovalSections(undefined)).toEqual([])
  })
})

describe('approvalsBadgeCount', () => {
  it('sums only the four mobile categories', () => {
    expect(approvalsBadgeCount([prov('time_off', 2), prov('issues', 5), prov('fte_expenses', 1), prov('rosters', 9)])).toBe(3)
  })
  it('is 0 for none / non-array', () => {
    expect(approvalsBadgeCount([])).toBe(0)
    expect(approvalsBadgeCount(null)).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run mobile/lib/approvals.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — `mobile/lib/approvals.js`:

```js
// Pure helpers for the mobile Approvals inbox. No React/Supabase — operates on
// the /api/approvals/pending `providers` array. Lives in mobile/lib so the root
// vitest picks it up (config includes mobile/lib/**).

// The approval categories the mobile inbox actions, in display order.
export const MOBILE_APPROVAL_KEYS = ['time_off', 'shift_swaps', 'fte_expenses', 'contractor_invoices']

function byKey(providers) {
  const map = {}
  for (const p of Array.isArray(providers) ? providers : []) {
    if (p && p.key) map[p.key] = p
  }
  return map
}

// The non-empty mobile-actionable provider sections, in MOBILE_APPROVAL_KEYS
// order. Each is the provider object ({ key, label, count, items }).
export function mobileApprovalSections(providers) {
  const map = byKey(providers)
  return MOBILE_APPROVAL_KEYS
    .map((k) => map[k])
    .filter((p) => p && Array.isArray(p.items) && p.items.length > 0)
}

// Badge total = pending items across the four mobile categories only.
export function approvalsBadgeCount(providers) {
  const map = byKey(providers)
  return MOBILE_APPROVAL_KEYS.reduce((sum, k) => sum + (map[k]?.count || 0), 0)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run mobile/lib/approvals.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/approvals.js mobile/lib/approvals.test.js
git commit -m "MOBILE-APPROVALS.1 — pure approvals helpers (sections + badge count) + tests"
```

---

## Task 2: Permissions — add the `approvals` mobile permission

**Files:** Modify `shared/permissions.js`, `scripts/check-mobile-parity.mjs`

- [ ] **Step 1: Add the MOBILE_PERMISSIONS entry** — in `shared/permissions.js`, in the `MOBILE_PERMISSIONS` array, immediately after the `policies` entry (`{ key: 'policies', ... mobileOnly: true }`), add:

```js
  // MOBILE-APPROVALS — manager inbox mirroring the web /approvals dashboard.
  // webEquivalent links it to the web approvals_inbox key for the parity
  // linter (which lets us drop approvals_inbox from WEB_ONLY_OK). The tile is
  // gated by this permission; per-category approve rights stay enforced by the
  // routes (managers: time-off/swaps; owners/master: + expenses/invoices).
  { key: 'approvals',  label: 'Approvals inbox', hint: 'Manager queue — approve/decline pending time-off, swaps, FTE expenses and contractor invoices at the active location.', webEquivalent: 'approvals_inbox' },
```

- [ ] **Step 2: Add `approvals` to all five role defaults** — in `DEFAULT_MOBILE_PERMISSIONS_BY_ROLE`, add an `approvals:` key to each block. Place it on the line with `time_off: true,` in each block (so it reads `time_off: true, approvals: <bool>`):

- `master`: `approvals: true`
- `staff`: `approvals: false`
- `head_coach`: `approvals: true`
- `manager`: `approvals: true`
- `owner`: `approvals: true`

Concretely, in each of the five blocks change the line:

```js
    time_off: true,
```

to (master / head_coach / manager / owner):

```js
    time_off: true,
    approvals: true,
```

and for `staff` only:

```js
    time_off: true,
    approvals: false,
```

(Monotonic: staff `false` ⊆ every manager-tier `true`, preserving the role-superset invariant.)

- [ ] **Step 3: Drop `approvals_inbox` from WEB_ONLY_OK** — in `scripts/check-mobile-parity.mjs`, delete the `assistant`-adjacent `approvals_inbox` entry (the multi-line comment block + the `approvals_inbox: '...'` line). It's now satisfied by the mobile `approvals` permission's `webEquivalent`.

Remove this block:

```js
  // APPROVALS.1 — central approvals dashboard aggregating
  // contractor invoices, FTE expenses, time-off, swap requests.
  // Drills into existing per-feature pages — desktop-only because
  // each source page is desktop-only. Mobile reviewers approve
  // individual items via existing push-notification entry points
  // (e.g. notify_time_off, notify_invoice_*).
  approvals_inbox: 'Central approvals dashboard (APPROVALS.1) — aggregates contractor invoices, FTE expenses, time-off and swap requests. Drills into per-feature pages, all of which are desktop-only. Mobile users get per-category push notifications via existing notify_* flags.',
```

- [ ] **Step 4: Verify tests + parity pass**

Run: `npm test && npm run check:mobile-parity`
Expected: vitest green (the permissions completeness/superset tests in `mobile/lib/permissions.test.js` accept the new key because it's in all five blocks); parity prints "Mobile parity: clean" with `approvals_inbox` no longer in the excluded list.

- [ ] **Step 5: Commit**

```bash
git add shared/permissions.js scripts/check-mobile-parity.mjs
git commit -m "MOBILE-APPROVALS.2 — add 'approvals' mobile permission (webEquivalent approvals_inbox)"
```

---

## Task 3: API helpers

**Files:** Create `mobile/lib/approvals-api.js`; Modify `mobile/lib/invoices-api.js`

No unit tests (thin wrappers; validated by `expo export` + the import guard + on-device).

- [ ] **Step 1: Create `mobile/lib/approvals-api.js`**

```js
// Mobile-side approvals API. The web /api/approvals/pending aggregator is
// already mobile-shaped (uniform ApprovalItem). Call it via api() so the
// Bearer + x-active-location (+ impersonation) headers are sent and each
// provider scopes to the active studio server-side.
import { api } from './api'

export function getPendingApprovals({ locationId }) {
  return api('/api/approvals/pending', { locationId })
}
```

- [ ] **Step 2: Add invoice approve/decline to `mobile/lib/invoices-api.js`** — append after `revokeInvoice` (matching this file's raw-fetch + inline-auth style; decline body matches `expenses-api.js declineExpenseClaim`):

```js
// APPROVALS — owner/master approve or decline a submitted contractor invoice.
// Decline requires a reason (the route 400s without it).
export async function approveInvoice(id) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { Accept: 'application/json' }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  const res = await fetch(`${API_BASE}/api/invoices/${id}/approve`, { method: 'POST', headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function declineInvoice(id, reason) {
  const { data: { session } } = await supabase.auth.getSession()
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' }
  if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`
  const res = await fetch(`${API_BASE}/api/invoices/${id}/decline`, {
    method: 'POST', headers, body: JSON.stringify({ reason }),
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}
```

- [ ] **Step 3: Commit**

```bash
git add mobile/lib/approvals-api.js mobile/lib/invoices-api.js
git commit -m "MOBILE-APPROVALS.3 — getPendingApprovals + invoice approve/decline helpers"
```

---

## Task 4: `ApprovalCard` (uniform) + `DeclineSheet`

**Files:** Create `mobile/components/approvals/ApprovalCard.jsx`, `mobile/components/approvals/DeclineSheet.jsx`

- [ ] **Step 1: Create `mobile/components/approvals/ApprovalCard.jsx`**

```jsx
// One pending approval, rendered from the uniform ApprovalItem shape returned
// by /api/approvals/pending — works for every category. Approve = one tap;
// Decline defers to the parent (which opens a reason sheet).
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

function formatAmount(amount, currency) {
  if (amount == null) return null
  const sym = currency === 'EUR' ? '€' : (currency ? `${currency} ` : '')
  return `${sym}${Number(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export default function ApprovalCard({ item, busy, onApprove, onDecline }) {
  const amount = formatAmount(item.amount, item.currency)
  return (
    <View className="bg-un1t-surface border border-un1t-border rounded-2xl p-3.5 mb-2">
      <View className="flex-row items-start justify-between">
        <Text className="text-sm font-semibold text-un1t-text flex-1 mr-2" numberOfLines={1}>{item.title}</Text>
        {amount ? <Text className="text-sm font-semibold text-un1t-text">{amount}</Text> : null}
      </View>
      {item.subtitle ? <Text className="text-[12px] text-un1t-subtle mt-0.5" numberOfLines={2}>{item.subtitle}</Text> : null}
      {item.meta ? (
        <View className="flex-row items-center mt-1">
          <Ionicons name="location-outline" size={11} color="#94A3B8" />
          <Text className="text-[11px] text-un1t-subtle ml-1" numberOfLines={1}>{item.meta}</Text>
        </View>
      ) : null}
      <View className="flex-row gap-2 mt-2.5">
        <Pressable onPress={onApprove} disabled={busy}
          className="flex-1 flex-row items-center justify-center py-2 rounded-xl bg-emerald-600 active:opacity-80 disabled:opacity-50">
          {busy
            ? <ActivityIndicator color="#FFFFFF" />
            : <><Ionicons name="checkmark" size={15} color="#FFFFFF" /><Text className="text-sm font-semibold text-white ml-1">Approve</Text></>}
        </Pressable>
        <Pressable onPress={onDecline} disabled={busy}
          className="flex-1 flex-row items-center justify-center py-2 rounded-xl border border-un1t-border active:opacity-60 disabled:opacity-50">
          <Ionicons name="close" size={15} color="#DC2626" />
          <Text className="text-sm font-semibold text-red-600 ml-1">Decline</Text>
        </Pressable>
      </View>
    </View>
  )
}
```

- [ ] **Step 2: Create `mobile/components/approvals/DeclineSheet.jsx`**

```jsx
// Reason sheet for declining an approval. `requireReason` (expenses + invoices)
// disables Confirm until non-empty; optional for time-off/swaps.
import { useState, useEffect } from 'react'
import { View, Text, Pressable, Modal, TextInput, KeyboardAvoidingView, Platform } from 'react-native'
import { Ionicons } from '@expo/vector-icons'

export default function DeclineSheet({ visible, requireReason, onConfirm, onClose }) {
  const [reason, setReason] = useState('')
  useEffect(() => { if (visible) setReason('') }, [visible])
  const canConfirm = !requireReason || reason.trim().length > 0
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} className="flex-1 justify-end bg-black/50">
        <Pressable className="flex-1" onPress={onClose} />
        <View className="bg-un1t-bg border-t border-un1t-border rounded-t-3xl p-5">
          <View className="flex-row items-center justify-between mb-3">
            <Text className="text-lg font-bold text-un1t-text">Decline</Text>
            <Pressable onPress={onClose} hitSlop={10}><Ionicons name="close" size={22} color="#94A3B8" /></Pressable>
          </View>
          <Text className="text-xs text-un1t-subtle mb-2">
            {requireReason ? 'A reason is required and is sent to the submitter.' : 'Add an optional note for the submitter.'}
          </Text>
          <TextInput
            value={reason}
            onChangeText={setReason}
            placeholder="Reason…"
            placeholderTextColor="#64748B"
            multiline
            maxLength={1000}
            style={{ minHeight: 80 }}
            className="bg-un1t-surface border border-un1t-border rounded-xl px-3 py-3 text-base text-un1t-text mb-4"
          />
          <Pressable onPress={() => onConfirm(reason.trim())} disabled={!canConfirm}
            className="bg-red-600 active:opacity-80 disabled:opacity-40 px-4 py-3.5 rounded-xl items-center flex-row justify-center">
            <Ionicons name="close-circle" size={18} color="#FFFFFF" />
            <Text className="text-base font-semibold text-white ml-2">Confirm decline</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add mobile/components/approvals/ApprovalCard.jsx mobile/components/approvals/DeclineSheet.jsx
git commit -m "MOBILE-APPROVALS.4 — uniform ApprovalCard + DeclineSheet"
```

---

## Task 5: The inbox screen `mobile/app/approvals.jsx`

**Files:** Create `mobile/app/approvals.jsx`

- [ ] **Step 1: Create the file**

```jsx
// Manager Approvals inbox — sections per category (time-off, swaps, expenses,
// invoices), each an ApprovalCard. Approve dispatches to the right helper;
// Decline opens a reason sheet (required for finance items). Reached from the
// More tab. No client-side role logic — the aggregator role-scopes server-side.
import { useState, useCallback } from 'react'
import { View, Text, ScrollView, RefreshControl, ActivityIndicator, Alert } from 'react-native'
import { Stack, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useAuth } from '../lib/auth-context'
import BackHeaderLeft from '../components/BackHeaderLeft'
import { getPendingApprovals } from '../lib/approvals-api'
import { mobileApprovalSections } from '../lib/approvals'
import { respondToTimeOff, respondToSwap } from '../lib/schedule-api'
import { approveExpenseClaim, declineExpenseClaim } from '../lib/expenses-api'
import { approveInvoice, declineInvoice } from '../lib/invoices-api'
import ApprovalCard from '../components/approvals/ApprovalCard'
import DeclineSheet from '../components/approvals/DeclineSheet'

const REASON_REQUIRED = new Set(['fte_expenses', 'contractor_invoices'])

export default function ApprovalsInbox() {
  const { activeLocation } = useAuth()
  const locationId = activeLocation?.id
  const [sections, setSections] = useState([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState(null)
  const [busyId, setBusyId] = useState(null)
  const [declineFor, setDeclineFor] = useState(null) // { key, id }

  const load = useCallback(async () => {
    if (!locationId) return
    setError(null)
    const res = await getPendingApprovals({ locationId })
    if (!res.success) { setError(res.error || 'Failed to load approvals'); setSections([]); return }
    setSections(mobileApprovalSections(res.data?.providers || []))
  }, [locationId])

  useFocusEffect(useCallback(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
  }, [load]))

  async function onRefresh() { setRefreshing(true); await load(); setRefreshing(false) }

  function approveFn(key, id) {
    switch (key) {
      case 'time_off': return respondToTimeOff(id, 'approved', null, locationId)
      case 'shift_swaps': return respondToSwap(id, 'approved', null, locationId)
      case 'fte_expenses': return approveExpenseClaim(id)
      case 'contractor_invoices': return approveInvoice(id)
      default: return Promise.resolve({ success: false, error: 'Unknown category' })
    }
  }
  function declineFn(key, id, reason) {
    switch (key) {
      case 'time_off': return respondToTimeOff(id, 'rejected', reason, locationId)
      case 'shift_swaps': return respondToSwap(id, 'rejected', reason, locationId)
      case 'fte_expenses': return declineExpenseClaim(id, reason)
      case 'contractor_invoices': return declineInvoice(id, reason)
      default: return Promise.resolve({ success: false, error: 'Unknown category' })
    }
  }

  async function onApprove(key, item) {
    setBusyId(item.id)
    const res = await approveFn(key, item.id)
    setBusyId(null)
    if (!res.success) { Alert.alert('Could not approve', res.error || 'Unknown error'); return }
    const warn = res.warning || (Array.isArray(res.warnings) && res.warnings.length ? res.warnings.join('\n') : null)
    if (warn) Alert.alert('Approved — note', warn)
    load()
  }

  async function submitDecline(reason) {
    const target = declineFor
    setDeclineFor(null)
    if (!target) return
    setBusyId(target.id)
    const res = await declineFn(target.key, target.id, reason || null)
    setBusyId(null)
    if (!res.success) { Alert.alert('Could not decline', res.error || 'Unknown error'); return }
    load()
  }

  return (
    <View className="flex-1 bg-un1t-bg">
      <Stack.Screen options={{ title: 'Approvals', headerLeft: () => <BackHeaderLeft label="More" fallbackHref="/(tabs)/more" /> }} />
      <ScrollView
        contentContainerClassName="p-4 pb-10"
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#111827" />}
      >
        {error ? (
          <View className="bg-red-500/10 border border-red-500/30 rounded-xl p-3 mb-3">
            <Text className="text-red-500 text-sm">{error}</Text>
          </View>
        ) : null}

        {loading ? (
          <View className="py-12 items-center"><ActivityIndicator /></View>
        ) : sections.length === 0 ? (
          <View className="py-16 items-center">
            <Ionicons name="checkmark-done-outline" size={30} color="#94A3B8" />
            <Text className="text-sm text-un1t-subtle mt-2">No pending approvals.</Text>
          </View>
        ) : sections.map((sec) => (
          <View key={sec.key} className="mb-5">
            <Text className="text-xs uppercase tracking-wider text-un1t-subtle mb-2 px-1">{sec.label} ({sec.count})</Text>
            {sec.items.map((item) => (
              <ApprovalCard
                key={item.id}
                item={item}
                busy={busyId === item.id}
                onApprove={() => onApprove(sec.key, item)}
                onDecline={() => setDeclineFor({ key: sec.key, id: item.id })}
              />
            ))}
          </View>
        ))}
      </ScrollView>

      <DeclineSheet
        visible={!!declineFor}
        requireReason={declineFor ? REASON_REQUIRED.has(declineFor.key) : false}
        onConfirm={submitDecline}
        onClose={() => setDeclineFor(null)}
      />
    </View>
  )
}
```

- [ ] **Step 2: Verify the bundle compiles**

Run: `cd mobile && rm -rf dist && npx expo export --platform ios 2>&1 | tail -3 && rm -rf dist && cd ..`
Expected: `Exported: dist`, no error (all new imports resolve).

- [ ] **Step 3: Commit**

```bash
git add mobile/app/approvals.jsx
git commit -m "MOBILE-APPROVALS.5 — approvals inbox screen (sectioned, approve/decline dispatch)"
```

---

## Task 6: More-tab Approvals tile + badge

**Files:** Modify `mobile/app/(tabs)/more.jsx`

- [ ] **Step 1: Add imports** — after `import { getOutstandingPolicyCount } from '../../lib/policies-api'`, add:

```jsx
import { canMobile } from '../../lib/permissions'
import { getPendingApprovals } from '../../lib/approvals-api'
import { approvalsBadgeCount } from '../../lib/approvals'
```

- [ ] **Step 2: Add approvals badge state** — next to the existing `const [outstandingPolicies, setOutstandingPolicies] = useState(0)`, add:

```jsx
  const [outstandingApprovals, setOutstandingApprovals] = useState(0)
```

- [ ] **Step 3: Fetch the badge on focus** — immediately after the existing `useFocusEffect(useCallback(() => { ... getOutstandingPolicyCount ... }, []))` block, add (gated so non-managers never call it):

```jsx
  // MOBILE-APPROVALS — pending-approvals badge for the Approvals tile. Gated on
  // the `approvals` permission so non-managers don't fetch. Counts only the four
  // mobile categories so the badge matches the inbox.
  useFocusEffect(useCallback(() => {
    if (!profile || !activeLocation?.id || !canMobile(profile, 'approvals', activeLocation)) return
    let alive = true
    getPendingApprovals({ locationId: activeLocation.id }).then((res) => {
      if (alive && res.success) setOutstandingApprovals(approvalsBadgeCount(res.data?.providers || []))
    })
    return () => { alive = false }
  }, [profile, activeLocation]))
```

- [ ] **Step 4: Add the tile** — in the `tiles` array construction, immediately after the `policies` tile push (`if (inMore.has('policies')) tiles.push({...})`), add:

```jsx
  if (canMobile(profile, 'approvals', activeLocation)) tiles.push({ key: 'approvals', icon: 'checkmark-done-outline', label: 'Approvals', badge: outstandingApprovals > 0 ? String(outstandingApprovals) : null, onPress: () => router.push('/approvals') })
```

- [ ] **Step 5: Verify the bundle compiles**

Run: `cd mobile && rm -rf dist && npx expo export --platform ios 2>&1 | tail -3 && rm -rf dist && cd ..`
Expected: `Exported: dist`, no error.

- [ ] **Step 6: Commit**

```bash
git add mobile/app/\(tabs\)/more.jsx
git commit -m "MOBILE-APPROVALS.6 — Approvals tile + pending badge on the More tab"
```

---

## Task 7: Slim Manage mode + remove the old ApprovalCard

**Files:** Modify `mobile/components/schedule/ManageMode.jsx`; Delete `mobile/components/schedule/ApprovalCard.jsx`; Modify `mobile/lib/schedule-api.js`

- [ ] **Step 1: Remove approvals imports from `ManageMode.jsx`** — change the schedule-api import from:

```jsx
import {
  getScheduleBlocks, getPendingTimeOff, getOpenSwaps, getLocationStaff,
  assignCoachToBlock, removeAssignment, respondToTimeOff, respondToSwap,
} from '../../lib/schedule-api'
```

to:

```jsx
import {
  getScheduleBlocks, getLocationStaff, assignCoachToBlock, removeAssignment,
} from '../../lib/schedule-api'
```

and delete the line `import ApprovalCard from './ApprovalCard'`.

- [ ] **Step 2: Remove approvals state** — delete these three state lines:

```jsx
  const [timeOff, setTimeOff] = useState([])
  const [swaps, setSwaps] = useState([])
  const [approvalsOpen, setApprovalsOpen] = useState(true)
```

- [ ] **Step 3: Slim `load()`** — replace the whole `load` callback with the blocks-only version:

```jsx
  const load = useCallback(async () => {
    if (!locationId) return
    setError(null)
    const b = await getScheduleBlocks({ locationId, startDate: weekStart, endDate: weekEnd })
    if (!b.success) setError(b.error || 'Failed to load roster')
    setBlocks(b.success ? b.data || [] : [])
  }, [locationId, weekStart, weekEnd])
```

- [ ] **Step 4: Remove the approval handlers + count** — delete the `decideTimeOff`, `decideSwap` functions and the `const pendingCount = timeOff.length + swaps.length` line.

- [ ] **Step 5: Remove the approvals section JSX** — delete the entire `{pendingCount > 0 && ( … )}` block (the "Pending approvals" collapsible and its `ApprovalCard` lists), leaving the selected-day label + `dayBlocks` rendering intact.

- [ ] **Step 6: Delete the superseded component**

```bash
git rm mobile/components/schedule/ApprovalCard.jsx
```

- [ ] **Step 7: Drop now-unused schedule-api helpers** — first confirm nothing else imports them:

Run: `grep -rn "getPendingTimeOff\|getOpenSwaps" mobile/ | grep -v node_modules`
Expected: only the *definitions* in `mobile/lib/schedule-api.js` (no importers).

Then delete the `getPendingTimeOff` and `getOpenSwaps` function definitions from `mobile/lib/schedule-api.js`. (Keep `respondToTimeOff`/`respondToSwap` — the inbox uses them.)

- [ ] **Step 8: Verify the bundle compiles + import guard**

Run: `cd mobile && rm -rf dist && npx expo export --platform ios 2>&1 | tail -3 && rm -rf dist && cd .. && npm run check:mobile-imports`
Expected: `Exported: dist`, no error; mobile-imports clean (catches any dangling import of the deleted `ApprovalCard`/helpers).

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "MOBILE-APPROVALS.7 — slim schedule Manage mode (approvals moved to the inbox)"
```

---

## Task 8: Verify + ship

**Files:** none.

- [ ] **Step 1: Full CI mirror**

Run: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports`
Expected: vitest green (incl. new `approvals.test.js`); eslint 0 errors; parity clean (`approvals_inbox` gone from the excluded list, no drift); mobile-imports clean.

- [ ] **Step 2: Final iOS export**

Run: `cd mobile && rm -rf dist && npx expo export --platform ios && rm -rf dist && cd ..`
Expected: `Exported: dist`, no errors.

- [ ] **Step 3: Push**

```bash
git push -u origin mobile-approvals-inbox
```

- [ ] **Step 4: Open the PR** (base `main`, head `mobile-approvals-inbox`) — title `MOBILE-APPROVALS — mobile approvals inbox`, body summarising: a manager More-tab inbox approving time-off/swaps/expenses/contractor-invoices via the existing `/api/approvals/pending` + per-category routes (no backend); schedule Manage slimmed to pure editing; new `approvals` mobile permission. Verification line. Note merging touches `mobile/**` → production OTA.

- [ ] **Step 5: STOP — ask the user before merging.** Merging auto-publishes a production OTA. Report the PR URL + the on-device checklist:
  - A manager sees the **Approvals** tile in More with a badge; opens it → time-off + swap sections.
  - An owner additionally sees Expenses + Contractor-invoice sections (with amounts).
  - Approve removes the item; Decline opens the reason sheet (Confirm disabled until a reason is typed for expenses/invoices).
  - Schedule **Manage** mode no longer shows a "Pending approvals" section — just the day's blocks.
  - A non-manager (plain staff) has no Approvals tile.

---

## Self-Review

**Spec coverage:** sectioned inbox (T5) ✓ · uniform ApprovalCard (T4) ✓ · four categories via `/api/approvals/pending` (T1 filter + T3 fetch) ✓ · approve one-tap + decline reason-sheet, required for finance (T4 DeclineSheet + T5 REASON_REQUIRED) ✓ · dispatch to existing + new helpers (T3 + T5) ✓ · More tile + badge, manager-gated (T6) ✓ · `approvals` permission, `approvals_inbox` out of WEB_ONLY_OK (T2) ✓ · slim Manage + delete old ApprovalCard + drop unused helpers (T7) ✓ · pure helper unit-tested (T1) ✓ · no backend/schema change ✓ · active-location scoping via x-active-location (T3 `api(...,{locationId})`) ✓ · warnings surfaced on finance approve (T5 `onApprove`) ✓.

**Placeholder scan:** none — every code step is complete.

**Type/name consistency:** `mobileApprovalSections`/`approvalsBadgeCount`/`MOBILE_APPROVAL_KEYS` defined T1, used T5/T6; `getPendingApprovals({locationId})` defined T3, called T5/T6; `approveInvoice`/`declineInvoice` defined T3, used T5; `respondToTimeOff`/`respondToSwap` (kept) + `approveExpenseClaim`/`declineExpenseClaim` (existing) used T5; `ApprovalCard` props `{item,busy,onApprove,onDecline}` match the T5 call site; `DeclineSheet` props `{visible,requireReason,onConfirm,onClose}` match; provider keys `time_off`/`shift_swaps`/`fte_expenses`/`contractor_invoices` consistent across T1/T5; the `approvals` permission key consistent across T2/T6.

**Note (intentional):** `getPendingTimeOff`/`getOpenSwaps` are removed only after the grep in T7-step7 confirms no importers; if any third surface still imports them, keep them and note it.
