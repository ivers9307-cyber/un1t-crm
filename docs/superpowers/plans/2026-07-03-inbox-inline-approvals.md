# Inbox Inline Agent Approvals (Wave 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Mia's approval requests as decidable cards inside the unified inbox threads (WA + IG), open to all staff with inbox access, with rule-based next steps after each decision.

**Architecture:** Approval rows (`agent_membership_requests`) already carry `conversation_id` + `channel`. We fetch them per-conversation via an extended GET route, merge them into the message timeline with a pure shared helper, and render a new `ApprovalActionCard` that decides via the existing PATCH route. A pure shared playbook maps kind+outcome → next-step buttons (composer prefill / Book tab / SequencePicker). One migration widens the SELECT RLS to location staff (realtime is RLS-bound) and adds the table to the realtime publication.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role routes + browser realtime), Tailwind (`un1t-*` tokens), Vitest, existing `@/components/ui` primitives.

**Spec:** `docs/superpowers/specs/2026-07-03-inbox-inline-approvals-design.md`
**Branch:** `feat/inbox-inline-approvals` (already created off `origin/main`)

---

## Read-first invariants (from CLAUDE.md — violations break prod)

- API routes use `createServerClient()` → **RLS does nothing there**; authorize in app code (`assertLocationAccess`). The RLS change in Task 3 exists for **browser realtime**, which IS RLS-bound.
- One permissive policy per (table, command); wrap `auth.uid()` as `(SELECT auth.uid())`.
- Status chips on light surfaces: `bg-<c>-500/10 text-<c>-700` (lint-enforced `no-low-contrast-chip`).
- Every non-submit `<button>` inside a `<form>` needs `type="button"` — the card renders near the composer form; set `type="button"` on ALL card buttons.
- supabase-js builders: always `await`; no `.catch()` chaining; ≤1000-row selects (ours are ≤100).
- Migrations forward-only; applied via Supabase MCP against project `iyvtbjjxdggiadzwwvdj` **before** the code merges. The orchestrator applies it — executors only commit the file.
- Line numbers below are anchors as of the branch point (`origin/main`, 2026-07-03). **Verify each anchor by reading the file before editing** — content match beats line match.

---

### Task 1: Shared next-steps playbook (`shared/approvals-next-steps.js`)

**Files:**
- Create: `shared/approvals-next-steps.js`
- Test: `shared/approvals-next-steps.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// shared/approvals-next-steps.test.js
import { describe, it, expect } from 'vitest'
import { getNextSteps, buildDeclineDraft, DECLINE_REASONS } from './approvals-next-steps.js'

const ctx = {
  firstName: 'Aoife',
  details: { class_name: 'Core Fusion', class_time: 'Wed 9:30am' },
}

describe('getNextSteps', () => {
  it('declined booking → offer slots (book) + explanation (composer with draft)', () => {
    const steps = getNextSteps('class_booking', 'declined', { ...ctx, reason: 'class_full' })
    expect(steps.map(s => s.type)).toEqual(['book', 'composer'])
    expect(steps[1].draft).toContain('Aoife')
    expect(steps[1].draft).toContain('Core Fusion')
  })

  it('approved cancellation → sequence + book + composer', () => {
    const steps = getNextSteps('cancellation', 'approved', ctx)
    expect(steps.map(s => s.type)).toEqual(['sequence', 'book', 'composer'])
  })

  it('approved pause → single composer step embedding the dates', () => {
    const steps = getNextSteps('pause', 'approved', {
      firstName: 'Dan',
      details: { start_date: '2026-08-01', end_date: '2026-09-01' },
    })
    expect(steps).toHaveLength(1)
    expect(steps[0].type).toBe('composer')
    expect(steps[0].draft).toContain('2026-08-01 to 2026-09-01')
  })

  it('actioned (auto-executed) → no steps (Mia already confirmed)', () => {
    expect(getNextSteps('class_booking', 'actioned', ctx)).toEqual([])
  })

  it('failed booking → book manually + holding message', () => {
    const steps = getNextSteps('class_booking', 'failed', ctx)
    expect(steps.map(s => s.type)).toEqual(['book', 'composer'])
  })

  it('saved cancellation → thank-you composer step', () => {
    const steps = getNextSteps('cancellation', 'saved', ctx)
    expect(steps).toHaveLength(1)
    expect(steps[0].type).toBe('composer')
  })

  it('unknown combinations → empty array, never throws', () => {
    expect(getNextSteps('mystery_kind', 'approved', {})).toEqual([])
    expect(getNextSteps(null, null)).toEqual([])
  })
})

describe('buildDeclineDraft', () => {
  it('mentions the class and reads as Mia-voiced text for class_full', () => {
    const draft = buildDeclineDraft('class_booking', 'class_full', ctx)
    expect(draft).toContain('Aoife')
    expect(draft).toContain('Core Fusion')
    expect(draft.toLowerCase()).toContain('fully booked')
  })
  it('falls back gracefully with no ctx', () => {
    expect(buildDeclineDraft('class_booking', 'other', {})).toContain('there')
  })
})

describe('DECLINE_REASONS', () => {
  it('exposes [key, label] pairs including other', () => {
    expect(DECLINE_REASONS.map(([k]) => k)).toContain('other')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/approvals-next-steps.test.js --pool=threads`
Expected: FAIL — cannot resolve `./approvals-next-steps.js`

- [ ] **Step 3: Write the implementation**

```javascript
// shared/approvals-next-steps.js
//
// Pure next-steps playbook for agent approval decisions. Shared by the
// web inbox (Wave 1) and the mobile inbox (Wave 2) so the recommended
// follow-ups can't drift between platforms. Pure — no DB, no network,
// no platform imports.
//
// getNextSteps(kind, outcome, ctx) → [{ id, label, type, draft? }]
//   type 'composer' — prefill the thread composer with `draft`; staff
//                     edit and send it themselves (nothing auto-sends)
//   type 'book'     — open the Command Centre Book tab (desktop rail)
//   type 'sequence' — open the sequence picker for the contact
//
// Auto-executed approvals ('actioned') get no steps: the agent already
// sent the confirmation into the thread.

export const DECLINE_REASONS = Object.freeze([
  ['class_full', 'Class full'],
  ['already_booked', 'Already booked'],
  ['not_eligible', 'Not eligible'],
  ['other', 'Other'],
])

const BOOKING_KINDS = new Set(['class_booking', 'event_booking', 'consultation'])

function firstName(ctx) {
  return (ctx && ctx.firstName) || 'there'
}

function whatLabel(ctx) {
  const d = (ctx && ctx.details) || {}
  const name = d.class_name || d.event_name || null
  const time = d.class_time || d.event_date || null
  return [name, time].filter(Boolean).join(' at ')
}

export function buildDeclineDraft(kind, reasonKey, ctx = {}) {
  const name = firstName(ctx)
  const what = whatLabel(ctx)
  if (BOOKING_KINDS.has(kind)) {
    const base = `Hi ${name}, unfortunately we couldn't book you into ${what || 'that session'}`
    switch (reasonKey) {
      case 'class_full':
        return `${base} — it's fully booked. Would another time suit? I can send you a few options.`
      case 'already_booked':
        return `${base} — it looks like you're already booked in for it. See you there!`
      case 'not_eligible':
        return `${base} — your current membership doesn't cover it. Reply here and we can look at options.`
      default:
        return `${base}. Reply here and we'll sort something out.`
    }
  }
  if (kind === 'class_cancellation' || kind === 'event_cancellation') {
    return `Hi ${name}, we weren't able to cancel ${what || 'your booking'} this time. Reply here and we'll help.`
  }
  if (kind === 'pause') {
    return `Hi ${name}, we couldn't set up that membership pause just yet — reply here and we'll look at what's possible.`
  }
  if (kind === 'cancellation') {
    return `Hi ${name}, thanks for reaching out — we'd love a quick chat before anything changes with your membership. When suits a call?`
  }
  return `Hi ${name}, we couldn't action that request this time — reply here and we'll sort it out.`
}

export function getNextSteps(kind, outcome, ctx = {}) {
  const name = firstName(ctx)
  const what = whatLabel(ctx)

  if (outcome === 'declined') {
    const steps = []
    if (BOOKING_KINDS.has(kind)) {
      steps.push({ id: 'offer_slots', label: 'Offer alternative slots', type: 'book' })
    }
    steps.push({
      id: 'decline_message',
      label: 'Send explanation',
      type: 'composer',
      draft: buildDeclineDraft(kind, (ctx && ctx.reason) || 'other', ctx),
    })
    return steps
  }

  if (outcome === 'failed') {
    const steps = []
    if (BOOKING_KINDS.has(kind)) {
      steps.push({ id: 'book_manually', label: 'Book manually', type: 'book' })
    }
    steps.push({
      id: 'holding_message',
      label: "Let them know we're on it",
      type: 'composer',
      draft: `Hi ${name}, just picking this up now — I'll confirm ${what || 'your request'} shortly.`,
    })
    return steps
  }

  if (outcome === 'approved') {
    if (kind === 'cancellation') {
      return [
        { id: 'winback', label: 'Enrol in win-back sequence', type: 'sequence' },
        { id: 'farewell_consult', label: 'Book a farewell consult', type: 'book' },
        {
          id: 'farewell_message',
          label: 'Send farewell message',
          type: 'composer',
          draft: `Hi ${name}, we've got your cancellation moving and will confirm once it's done. You'd be welcome back any time.`,
        },
      ]
    }
    if (kind === 'pause') {
      const d = (ctx && ctx.details) || {}
      const span = [d.start_date, d.end_date].filter(Boolean).join(' to ')
      return [{
        id: 'pause_confirm',
        label: 'Confirm pause dates',
        type: 'composer',
        draft: `Hi ${name}, your membership pause${span ? ` from ${span}` : ''} is approved — we're setting it up now and will confirm shortly.`,
      }]
    }
    return []
  }

  if (outcome === 'saved') {
    return [{
      id: 'saved_thanks',
      label: 'Send a thank-you',
      type: 'composer',
      draft: `Hi ${name}, great chatting — really glad you're staying with us! Any questions about what we discussed, just reply here.`,
    }]
  }

  return []
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/approvals-next-steps.test.js --pool=threads`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add shared/approvals-next-steps.js shared/approvals-next-steps.test.js
git commit -m "INBOX-APPROVALS.1 — shared next-steps playbook for agent approval decisions"
```

---

### Task 2: Shared card helpers (`shared/approval-cards.js`)

**Files:**
- Create: `shared/approval-cards.js`
- Test: `shared/approval-cards.test.js`

- [ ] **Step 1: Write the failing test**

```javascript
// shared/approval-cards.test.js
import { describe, it, expect } from 'vitest'
import { approvalCardSummary, mergeTimeline, APPROVAL_KIND_LABELS } from './approval-cards.js'

describe('approvalCardSummary', () => {
  it('class_booking → class name + time', () => {
    expect(approvalCardSummary({
      kind: 'class_booking',
      details: { class_name: 'Core Fusion', class_time: 'Wed 9:30am' },
    })).toBe('Core Fusion · Wed 9:30am')
  })
  it('pause → date span + reason', () => {
    expect(approvalCardSummary({
      kind: 'pause',
      details: { start_date: '2026-08-01', end_date: '2026-09-01', reason: 'travel' },
    })).toBe('2026-08-01 → 2026-09-01 · travel')
  })
  it('event_cancellation → event name + date', () => {
    expect(approvalCardSummary({
      kind: 'event_cancellation',
      details: { event_name: 'Hyrox Sim', event_date: 'Sat 12 Jul' },
    })).toBe('Hyrox Sim · Sat 12 Jul')
  })
  it('falls back to the kind label when details are empty', () => {
    expect(approvalCardSummary({ kind: 'cancellation', details: {} }))
      .toBe(APPROVAL_KIND_LABELS.cancellation + ' request')
  })
  it('never throws on null input', () => {
    expect(() => approvalCardSummary(null)).not.toThrow()
  })
})

describe('mergeTimeline', () => {
  const msg = (id, ts) => ({ id, sent_at: ts, body: 'x' })
  const req = (id, ts) => ({ id, created_at: ts, kind: 'class_booking', status: 'pending' })

  it('interleaves messages and requests chronologically ascending', () => {
    const out = mergeTimeline(
      [msg('m1', '2026-07-01T10:00:00Z'), msg('m2', '2026-07-01T12:00:00Z')],
      [req('r1', '2026-07-01T11:00:00Z')],
    )
    expect(out.map(i => i.key)).toEqual(['m:m1', 'a:r1', 'm:m2'])
  })

  it('same-timestamp: message renders before the approval it triggered', () => {
    const out = mergeTimeline([msg('m1', '2026-07-01T10:00:00Z')], [req('r1', '2026-07-01T10:00:00Z')])
    expect(out.map(i => i.kind)).toEqual(['message', 'approval'])
  })

  it('tags items with kind + stable key and carries the source object', () => {
    const out = mergeTimeline([msg('m1', '2026-07-01T10:00:00Z')], [])
    expect(out[0]).toMatchObject({ kind: 'message', key: 'm:m1' })
    expect(out[0].message.body).toBe('x')
  })

  it('handles empty/undefined inputs', () => {
    expect(mergeTimeline()).toEqual([])
    expect(mergeTimeline([], [])).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run shared/approval-cards.test.js --pool=threads`
Expected: FAIL — cannot resolve `./approval-cards.js`

- [ ] **Step 3: Write the implementation**

```javascript
// shared/approval-cards.js
//
// Pure helpers for rendering agent approval requests as inline thread
// cards in the unified inbox (web Wave 1, mobile Wave 2). Pure — no DB,
// no network, no platform imports.

export const APPROVAL_KIND_LABELS = Object.freeze({
  pause: 'Pause membership',
  cancellation: 'Cancel membership',
  class_booking: 'Class booking',
  class_cancellation: 'Class cancellation',
  consultation: 'Consultation',
  event_booking: 'Event booking',
  event_cancellation: 'Event cancellation',
})

// One-line summary of the request payload per kind. Mirrors (and
// extends to all 7 kinds) the subtitle logic the /approvals provider
// uses — kept separate because mobile can't import src/lib.
export function approvalCardSummary(row) {
  const kind = row && row.kind
  const d = (row && row.details) || {}
  let parts = []
  if (kind === 'class_booking' || kind === 'class_cancellation') {
    parts = [d.class_name, d.class_time]
  } else if (kind === 'event_booking' || kind === 'event_cancellation') {
    parts = [d.event_name, d.event_date]
  } else if (kind === 'consultation') {
    parts = [d.date, d.start_time]
  } else if (kind === 'pause') {
    const span = [d.start_date, d.end_date].filter(Boolean).join(' → ')
    parts = [span || null, d.reason]
  } else if (kind === 'cancellation') {
    parts = [d.reason]
  }
  const line = parts.filter(Boolean).join(' · ')
  if (line) return line
  return `${APPROVAL_KIND_LABELS[kind] || 'Agent'} request`
}

// Merge chat messages and approval requests into one ascending
// timeline. Messages sort before approvals at equal timestamps so a
// request renders under the customer message that triggered it.
// Items: { kind: 'message'|'approval', key, ts, message?|request? }
export function mergeTimeline(messages = [], requests = []) {
  const items = [
    ...messages.map(m => ({ kind: 'message', key: `m:${m.id}`, ts: m.sent_at || m.created_at || null, message: m })),
    ...requests.map(r => ({ kind: 'approval', key: `a:${r.id}`, ts: r.created_at || null, request: r })),
  ]
  return items.sort((a, b) => {
    const ta = a.ts ? new Date(a.ts).getTime() : 0
    const tb = b.ts ? new Date(b.ts).getTime() : 0
    if (ta !== tb) return ta - tb
    if (a.kind === b.kind) return 0
    return a.kind === 'message' ? -1 : 1
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run shared/approval-cards.test.js --pool=threads`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add shared/approval-cards.js shared/approval-cards.test.js
git commit -m "INBOX-APPROVALS.2 — shared summary + timeline-merge helpers for approval cards"
```

---

### Task 3: Migration — staff-wide SELECT + realtime publication

**Files:**
- Create: `supabase/migrations/357_agent_requests_staff_read_realtime.sql` (**verify 357 is still the next free number**: `ls supabase/migrations/ | sort -n | tail -3`; bump if taken)

- [ ] **Step 1: Write the migration file**

```sql
-- 357: Inline inbox approvals — staff-wide read + realtime.
--
-- Approval cards render inside /communications/inbox threads and update
-- live (INBOX-APPROVALS). Two prerequisites:
--   1. SELECT widens from managers to any staff assigned to the
--      location — decision rights follow the comms surface (Richard,
--      2026-07-03). Browser realtime is RLS-bound, so without this
--      non-manager staff would never receive card events. RLS writes
--      stay manager-scoped (mig 320); inbox decisions go through the
--      service-role PATCH route, which enforces location access in
--      app code.
--   2. agent_membership_requests joins the supabase_realtime
--      publication (mig 042 pattern).

DROP POLICY IF EXISTS agent_membership_requests_read ON public.agent_membership_requests;
CREATE POLICY agent_membership_requests_read ON public.agent_membership_requests
  FOR SELECT TO authenticated
  USING (
    (SELECT private.auth_is_master())
    OR private.auth_is_manager_at(location_id)
    OR EXISTS (
      SELECT 1 FROM public.profile_locations pl
      WHERE pl.profile_id = (SELECT auth.uid())
        AND pl.location_id = agent_membership_requests.location_id
    )
  );

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_membership_requests;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
```

- [ ] **Step 2: Commit (file only — do NOT apply)**

The orchestrator applies this via Supabase MCP (`apply_migration` on project `iyvtbjjxdggiadzwwvdj`, then `get_advisors` type=security) at deploy time, before the PR merges. Executors never apply migrations.

```bash
git add supabase/migrations/357_agent_requests_staff_read_realtime.sql
git commit -m "INBOX-APPROVALS.3 — mig 357: staff-wide SELECT + realtime for agent_membership_requests"
```

---

### Task 4: GET route — `conversation_id` filter, staff-level auth, deep-link fields

**Files:**
- Modify: `src/app/api/agent/membership-requests/route.js` (whole file is 40 lines — shown current above the diff)
- Modify: `src/lib/openapi.js` (only if this route is registered — grep first)

- [ ] **Step 1: Rewrite the GET route**

Replace the full body of `src/app/api/agent/membership-requests/route.js` with:

```javascript
import { NextResponse } from 'next/server'
import { getCurrentUser, assertLocationAccess } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { MANAGER_ROLES } from '@/lib/schemas'
import { selectAll } from '@/lib/select-all'

// RADAR-AGENT Phase 2 — operator approval queue for agent-captured
// requests. Two forms:
//
//   GET ?conversation_id=<uuid>  — INBOX-APPROVALS: every request for
//     one conversation (pending + decided) so the unified inbox can
//     render inline cards. Open to any staff at the conversation's
//     location — decision rights follow the comms surface.
//
//   GET (no params) — the full active-location history for the
//     /settings/customer-agent/requests review page. Manager+ (the
//     settings surface keeps its manager gate).

export async function GET(request) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()

  const { searchParams } = new URL(request.url)
  const conversationId = searchParams.get('conversation_id')

  if (conversationId) {
    const { data, error } = await db.from('agent_membership_requests')
      .select('id, kind, channel, conversation_id, location_id, contact_id, status, details, customer_note, retention_flagged, decided_at, decision_note, created_at, contacts(id, name, first_name)')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(100)
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    const rows = data || []
    // All rows share the conversation's location; empty result leaks nothing.
    if (rows.length) {
      const guard = assertLocationAccess(user, rows[0].location_id)
      if (guard) return guard
    }
    return NextResponse.json({ success: true, requests: rows })
  }

  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const locationId = user.activeLocation?.id
  if (!locationId) return NextResponse.json({ success: false, error: 'No active location' }, { status: 400 })

  // AUDIT P1-2 — paginated. The approval queue shows the FULL request history
  // (pending sorts first), which accumulates without bound; an un-paginated
  // select would silently hide every request past row 1000 from staff. id is
  // the deterministic paging tiebreaker under the (status, created_at) sort.
  // selectAll throws on a DB error → map back to the existing 500 path.
  let data
  try {
    data = await selectAll((from, to) => db.from('agent_membership_requests')
      .select('id, kind, channel, conversation_id, status, details, customer_note, retention_flagged, decided_at, decision_note, created_at, contacts(id, name, first_name, glofox_member_id)')
      .eq('location_id', locationId)
      .order('status', { ascending: true })   // pending sorts first alphabetically
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, to))
  } catch (err) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 })
  }
  return NextResponse.json({ success: true, requests: data })
}
```

Changes vs current: added `conversation_id` branch (staff-level via `assertLocationAccess`); no-param branch unchanged except `conversation_id` added to the select (settings-page deep link, Task 10); import of `assertLocationAccess` replaces the now-branch-scoped role gate.

- [ ] **Step 2: Register the query param in openapi.js if the route is registered**

Run: `grep -n "membership-requests" src/lib/openapi.js`
If registered, add the optional `conversation_id` query parameter to the GET entry following the file's existing parameter style. If not registered, skip (do not add a new registration in this task).

- [ ] **Step 3: Lint + guards**

Run: `npm run lint && npm run check:route-guards`
Expected: both pass (route keeps `getCurrentUser` guard).

- [ ] **Step 4: Commit**

```bash
git add src/app/api/agent/membership-requests/route.js src/lib/openapi.js
git commit -m "INBOX-APPROVALS.4 — conversation-scoped GET for approval cards, staff-level access"
```

---

### Task 5: PATCH route — decision rights follow the comms surface

**Files:**
- Modify: `src/app/api/agent/membership-requests/[id]/route.js:27-44`

- [ ] **Step 1: Remove the MANAGER_ROLES gate, keep location membership**

Current (lines 27–44):

```javascript
export async function PATCH(request, { params }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  if (!MANAGER_ROLES.includes(user.role)) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }
  const db = createServerClient()

  // Confirm the request belongs to a location this manager can act on.
  const { data: row } = await db.from('agent_membership_requests')
```

Replace with:

```javascript
export async function PATCH(request, { params }) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
  const db = createServerClient()

  // Confirm the request belongs to a location this user can act on.
  const { data: row } = await db.from('agent_membership_requests')
```

Then remove the now-unused import: in line 6, `MANAGER_ROLES` — check `grep -n "MANAGER_ROLES" src/app/api/agent/membership-requests/\[id\]/route.js` (zsh: quote the bracketed path). If it was only used by the deleted gate, drop it from the import.

Also update the route header comment (lines 8–10) from "manager decides" to:

```javascript
// PATCH /api/agent/membership-requests/[id] — staff decides a queued
// agent request. Decision rights follow the comms surface (any staff
// at the request's location — INBOX-APPROVALS, Richard 2026-07-03).
// 'approved' + 'declined' apply to every kind; 'saved' is the
// retention outcome on a cancellation (member kept).
```

The existing `getUserLocationIds` check (lines ~41–44) stays — it is the location-membership guard.

- [ ] **Step 2: Lint + guards**

Run: `npm run lint && npm run check:route-guards`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add 'src/app/api/agent/membership-requests/[id]/route.js'
git commit -m "INBOX-APPROVALS.5 — approval decisions open to location staff (comms-surface rights)"
```

---

### Task 6: `ApprovalActionCard` component

**Files:**
- Create: `src/components/ApprovalActionCard.jsx`

Consumes Tasks 1–2 helpers + the existing `SequencePicker` (`src/components/SequencePicker.jsx`, props: `contactIds[]`, `locationId`, `variant='popover'`, `onClose`, `onSuccess`). Read `SequencePicker.jsx` and one `@/components/ui` usage (e.g. in `CommandCentre.jsx`) before writing, to match Button/import style.

- [ ] **Step 1: Write the component**

```jsx
// src/components/ApprovalActionCard.jsx
//
// INBOX-APPROVALS — an agent approval request rendered inline in a
// WA/IG thread. Pending: summary + customer note + decide buttons.
// Decided: compact status line + rule-based next steps (playbook in
// shared/approvals-next-steps). Decisions go through the same PATCH
// route as /settings/customer-agent/requests, so behaviour (Glofox
// execution, Mia's in-thread confirmation) is identical everywhere.
'use client'

import { useState } from 'react'
import { getNextSteps, buildDeclineDraft, DECLINE_REASONS } from '@shared/approvals-next-steps'
import { approvalCardSummary, APPROVAL_KIND_LABELS } from '@shared/approval-cards'
import SequencePicker from '@/components/SequencePicker'

const STATUS_CHIP = {
  pending:  'bg-amber-500/10 text-amber-700',
  approved: 'bg-green-500/10 text-green-700',
  actioned: 'bg-green-500/10 text-green-700',
  saved:    'bg-blue-500/10 text-blue-700',
  declined: 'bg-red-500/10 text-red-700',
  failed:   'bg-red-500/10 text-red-700',
}
const STATUS_LABELS = {
  pending: 'Needs approval', approved: 'Approved', actioned: 'Done',
  saved: 'Saved', declined: 'Declined', failed: 'Failed',
}

export default function ApprovalActionCard({
  request, contactId, locationId, contactFirstName,
  onDecided, onPrefillComposer, onOpenBookTab,
}) {
  const [busy, setBusy] = useState(null)          // 'approved' | 'declined' | 'saved' | null
  const [declineOpen, setDeclineOpen] = useState(false)
  const [reason, setReason] = useState('class_full')
  const [note, setNote] = useState('')
  const [error, setError] = useState(null)
  const [showSequencePicker, setShowSequencePicker] = useState(false)

  const ctx = { firstName: contactFirstName, details: request.details, reason }

  async function decide(status) {
    setBusy(status)
    setError(null)
    try {
      const reasonLabel = (DECLINE_REASONS.find(([k]) => k === reason) || [])[1]
      const decision_note = status === 'declined'
        ? [reasonLabel, note.trim() || null].filter(Boolean).join(' — ')
        : (note.trim() || null)
      const res = await fetch(`/api/agent/membership-requests/${request.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, decision_note }),
      })
      const data = await res.json()
      if (!data.success) {
        setError(data.error || 'Decision failed')
        return
      }
      onDecided?.({ ...request, ...data.request })
      if (status === 'declined') {
        onPrefillComposer?.(buildDeclineDraft(request.kind, reason, ctx))
      }
    } catch {
      setError('Network error — try again')
    } finally {
      setBusy(null)
    }
  }

  function runStep(step) {
    if (step.type === 'composer') onPrefillComposer?.(step.draft)
    else if (step.type === 'book') onOpenBookTab?.()
    else if (step.type === 'sequence') setShowSequencePicker(true)
  }

  const status = request.status
  const decided = status !== 'pending'
  const steps = decided ? getNextSteps(request.kind, status, ctx) : []
  const kindLabel = APPROVAL_KIND_LABELS[request.kind] || 'Agent request'

  return (
    <div className="flex justify-center my-2">
      <div className="w-full max-w-md bg-un1t-surface border border-un1t-border rounded-lg px-3 py-2.5 text-sm relative">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-un1t-text">{kindLabel}</span>
          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${STATUS_CHIP[status] || STATUS_CHIP.pending}`}>
            {STATUS_LABELS[status] || status}
          </span>
        </div>
        <p className="text-un1t-text mt-1">{approvalCardSummary(request)}</p>
        {request.customer_note && (
          <p className="text-xs text-un1t-muted mt-1 border-l-2 border-un1t-border pl-2">“{request.customer_note}”</p>
        )}

        {!decided && !declineOpen && (
          <div className="flex items-center gap-2 mt-2.5">
            <button type="button" disabled={!!busy} onClick={() => decide('approved')}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
              {busy === 'approved' ? 'Approving…' : 'Approve'}
            </button>
            <button type="button" disabled={!!busy} onClick={() => setDeclineOpen(true)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-un1t-border text-un1t-text hover:bg-un1t-border/30 disabled:opacity-50">
              Decline
            </button>
            {request.retention_flagged && request.kind === 'cancellation' && (
              <button type="button" disabled={!!busy} onClick={() => decide('saved')}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-blue-500/10 text-blue-700 hover:bg-blue-500/20 disabled:opacity-50">
                {busy === 'saved' ? 'Saving…' : 'Saved the member'}
              </button>
            )}
          </div>
        )}

        {!decided && declineOpen && (
          <div className="mt-2.5 space-y-2">
            <select value={reason} onChange={e => setReason(e.target.value)}
              className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-2 py-1.5 text-xs text-un1t-text">
              {DECLINE_REASONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Note (optional)"
              className="w-full bg-un1t-bg border border-un1t-border rounded-lg px-2 py-1.5 text-xs text-un1t-text placeholder:text-un1t-muted" />
            <div className="flex items-center gap-2">
              <button type="button" disabled={!!busy} onClick={() => decide('declined')}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50">
                {busy === 'declined' ? 'Declining…' : 'Confirm decline'}
              </button>
              <button type="button" onClick={() => setDeclineOpen(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-un1t-muted hover:text-un1t-text">
                Back
              </button>
            </div>
          </div>
        )}

        {decided && (
          <div className="mt-1.5 text-xs text-un1t-muted">
            {request.decision_note && <span>{request.decision_note}</span>}
            {request.details?.result?.message_code && status === 'failed' && (
              <span className="text-red-700"> ({request.details.result.message_code})</span>
            )}
          </div>
        )}

        {steps.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2 pt-2 border-t border-un1t-border/50">
            <span className="text-[10px] uppercase tracking-wide text-un1t-subtle w-full">Next steps</span>
            {steps.map(step => (
              <button key={step.id} type="button" onClick={() => runStep(step)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium bg-un1t-bg border border-un1t-border text-un1t-text hover:bg-un1t-border/30 ${step.type === 'book' ? 'hidden xl:inline-flex' : ''}`}>
                {step.label}
              </button>
            ))}
          </div>
        )}

        {error && <p className="text-xs text-red-700 mt-1.5">{error}</p>}

        {showSequencePicker && contactId && (
          <div className="absolute left-0 right-0 top-full z-10 mt-1">
            <SequencePicker
              contactIds={[contactId]}
              locationId={locationId}
              variant="popover"
              onClose={() => setShowSequencePicker(false)}
              onSuccess={() => setShowSequencePicker(false)}
            />
          </div>
        )}
      </div>
    </div>
  )
}
```

Notes for the executor: `book`-type steps are `hidden xl:inline-flex` because the Command Centre rail only exists at `xl:` (UnifiedInbox.jsx:334). All buttons are `type="button"` (composer form invariant). Chips follow the `bg-*-500/10 text-*-700` rule. If `SequencePicker`'s actual props differ from the above, match the real ones (see its use in `CommandCentre.jsx`).

- [ ] **Step 2: Lint**

Run: `npm run lint && npm run check:guardrails`
Expected: pass (chip rule enforced by guardrails).

- [ ] **Step 3: Commit**

```bash
git add src/components/ApprovalActionCard.jsx
git commit -m "INBOX-APPROVALS.6 — ApprovalActionCard: inline decide + next-steps UI"
```

---

### Task 7: WAInbox integration

**Files:**
- Modify: `src/components/WAInbox.jsx` (anchors: signature :61, `newMessage` state :66, realtime :217-240, fetchMessages :279-300, render loop :734, composer input :804)

- [ ] **Step 1: Add imports, prop, state, fetch, realtime**

1. Imports (top of file):
```javascript
import ApprovalActionCard from '@/components/ApprovalActionCard'
import { mergeTimeline } from '@shared/approval-cards'
```

2. Signature (line 61) — add the callback prop:
```javascript
export default function WAInbox({ locationId, userId, initialConversationId, embedded = false, onOpenBookTab })
```

3. Near the `newMessage` state (line 66), add:
```javascript
const [approvals, setApprovals] = useState([])
```

4. Below `fetchMessages` (after line 300), add:
```javascript
async function fetchApprovals(convId) {
  try {
    const res = await fetch(`/api/agent/membership-requests?conversation_id=${convId}`)
    const data = await res.json()
    if (data.success) setApprovals(data.requests || [])
  } catch {
    /* non-fatal — cards just don't render */
  }
}
```
And wherever the component triggers `fetchMessages(selectedId)` on selection change, also call `fetchApprovals(selectedId)`; when `selectedId` clears, `setApprovals([])`. (Find the call sites: `grep -n "fetchMessages(" src/components/WAInbox.jsx` — mirror each.)

5. Realtime (lines 217–240): add a third `.on` to the existing channel chain, after the `whatsapp_messages` block:
```javascript
.on(
  'postgres_changes',
  { event: '*', schema: 'public', table: 'agent_membership_requests' },
  (payload) => {
    const convId = payload?.new?.conversation_id || payload?.old?.conversation_id
    if (convId && convId === selectedIdRef.current) fetchApprovals(convId)
  }
)
```

- [ ] **Step 2: Render the merged timeline**

Replace the loop opener (line 734) `{messages.map(msg => (` and its closer with:

```jsx
{mergeTimeline(messages, approvals).map(item => {
  if (item.kind === 'approval') {
    return (
      <ApprovalActionCard
        key={item.key}
        request={item.request}
        contactId={conversation?.contact_id || null}
        locationId={locationId}
        contactFirstName={conversation?.contacts?.first_name || conversation?.wa_profile_name?.split(' ')[0] || null}
        onDecided={updated => setApprovals(prev => prev.map(r => (r.id === updated.id ? updated : r)))}
        onPrefillComposer={text => setNewMessage(text)}
        onOpenBookTab={onOpenBookTab}
      />
    )
  }
  const msg = item.message
  return (
    <div
      key={item.key}
      className={`flex ${msg.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
    >
      {/* …existing per-message JSX body UNCHANGED from here… */}
```

The entire existing message JSX body stays identical — only the wrapper `.map` and `key` change. Check whether the detail response embeds the contact (`conversation?.contacts`); if it exposes contact fields differently (e.g. flat `contact_first_name`), adapt the `contactFirstName` expression to what the `/api/whatsapp/conversations/[id]` response actually returns — read that route to confirm.

- [ ] **Step 3: Lint + tests + build**

Run: `npm run lint && npx vitest run shared/ --pool=threads && npm run build`
Expected: all pass (build catches the `@shared` import resolution).

- [ ] **Step 4: Commit**

```bash
git add src/components/WAInbox.jsx
git commit -m "INBOX-APPROVALS.7 — WA thread renders inline approval cards (merge + realtime + prefill)"
```

---

### Task 8: IGInbox integration

**Files:**
- Modify: `src/components/IGInbox.jsx` (anchors: signature :37, `newMessage` :42, loadThread :106-118, realtime :133-156, render loop :335, composer :372)

- [ ] **Step 1: Mirror Task 7 exactly, adapted to IG**

Same imports. Signature becomes:
```javascript
export default function IGInbox({ locationId, initialConversationId, embedded = false, onOpenBookTab })
```
Same `approvals` state + `fetchApprovals` (identical route — it's channel-agnostic). Call it alongside `loadThread(id)` call sites; clear on deselect. Add the same third `.on('postgres_changes', { event: '*', schema: 'public', table: 'agent_membership_requests' }, …)` block to the `ig-inbox-${locationId}` channel using `loadThread`'s `selectedIdRef` equivalent.

Render loop (line 335): wrap with `mergeTimeline(messages, approvals)` as in Task 7; message body JSX unchanged; card props identical except:
```javascript
contactFirstName={conversation?.contacts?.first_name || conversation?.ig_username || null}
```
(verify against the `/api/instagram/conversations/[id]` response shape.)

- [ ] **Step 2: Lint + build**

Run: `npm run lint && npm run build`
Expected: pass.

- [ ] **Step 3: Commit**

```bash
git add src/components/IGInbox.jsx
git commit -m "INBOX-APPROVALS.8 — IG thread renders inline approval cards"
```

---

### Task 9: UnifiedInbox — Book-tab wiring, realtime, queue badge

**Files:**
- Modify: `src/components/UnifiedInbox.jsx` (anchors: realtime :97-111, queue item :241-290, thread mount :313-326, CommandCentre mount :333-349)
- Modify: `src/components/CommandCentre.jsx` (anchors: signature :47, tab state :48)

- [ ] **Step 1: Make CommandCentre's tab optionally controlled**

In `CommandCentre.jsx` (lines 47–48), change:
```javascript
export default function CommandCentre({ contactId, locationId, canEditConsent, channel, conversationId }) {
  const [tab, setTab] = useState('profile')
```
to:
```javascript
export default function CommandCentre({ contactId, locationId, canEditConsent, channel, conversationId, tab: tabProp, onTabChange }) {
  // Optionally controlled: UnifiedInbox drives the tab so inline
  // approval next-steps can open Book. Uncontrolled elsewhere.
  const [tabState, setTabState] = useState('profile')
  const tab = tabProp ?? tabState
  const setTab = onTabChange ?? setTabState
```
All existing `setTab(...)`/`tab` usages keep working unchanged.

- [ ] **Step 2: UnifiedInbox state + wiring**

Add state near the existing `selected` state:
```javascript
const [ccTab, setCcTab] = useState('profile')
```
Reset on conversation change — inside whatever handler sets `selected` (the queue `onClick={() => setSelected({ ch: conv._ch, id: conv.id })}` at ~line 246), extend to:
```javascript
onClick={() => { setSelected({ ch: conv._ch, id: conv.id }); setCcTab('profile') }}
```
Thread mount (lines 313–326): pass `onOpenBookTab={() => setCcTab('book')}` to BOTH `<WAInbox …/>` and `<IGInbox …/>`.
CommandCentre mount (lines 336–343): add `tab={ccTab}` and `onTabChange={setCcTab}`.

- [ ] **Step 3: Realtime + queue badge**

Realtime (lines 97–111): add `'agent_membership_requests'` to the table array:
```javascript
for (const table of [
  'whatsapp_conversations', 'whatsapp_messages',
  'instagram_conversations', 'instagram_messages',
  'agent_membership_requests',
]) {
```
Queue badge — after the "Needs human" span (ends ~line 264), add:
```jsx
{conv.pending_approval && (
  <span className="text-[10px] font-semibold text-purple-700 bg-purple-500/10 px-1.5 py-0.5 rounded-full shrink-0">
    Approval
  </span>
)}
```

- [ ] **Step 4: Lint + build, commit**

Run: `npm run lint && npm run check:guardrails && npm run build`
Expected: pass.

```bash
git add src/components/UnifiedInbox.jsx src/components/CommandCentre.jsx
git commit -m "INBOX-APPROVALS.9 — Book-tab wiring, approvals realtime + queue badge in unified inbox"
```

---

### Task 10: `pending_approval` flag on both conversations list APIs + settings deep link

**Files:**
- Modify: `src/app/api/whatsapp/conversations/route.js` (list handler, lines 16–32)
- Modify: `src/app/api/instagram/conversations/route.js` (list handler, lines 19–36)
- Modify: `src/app/settings/customer-agent/requests/page.js` (request cards — read the file to place the link)

- [ ] **Step 1: Flag in the WA list route**

In `src/app/api/whatsapp/conversations/route.js`, between `const { data, error } = await query` and the success return, replace:
```javascript
  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  return NextResponse.json({ success: true, conversations: data })
```
with:
```javascript
  const { data, error } = await query
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 })

  // INBOX-APPROVALS — flag threads with a pending agent request so the
  // queue can badge them. One batched query over this page's ids (≤50).
  const conversations = data || []
  if (conversations.length) {
    const { data: pend } = await db.from('agent_membership_requests')
      .select('conversation_id')
      .eq('status', 'pending')
      .in('conversation_id', conversations.map(c => c.id))
    const pendingSet = new Set((pend || []).map(r => r.conversation_id))
    for (const c of conversations) c.pending_approval = pendingSet.has(c.id)
  }

  return NextResponse.json({ success: true, conversations })
```

- [ ] **Step 2: Same block in the IG list route**

Apply the identical block to `src/app/api/instagram/conversations/route.js` (same variable names; the final return there is `return NextResponse.json({ success: true, conversations: data })` → same replacement).

- [ ] **Step 3: "Open conversation" deep link on the settings review page**

In `src/app/settings/customer-agent/requests/page.js`, on each request card where actions render, add (adapting to the page's existing markup/link style):
```jsx
{r.conversation_id && (
  <a
    href={`/communications/inbox?c=${r.conversation_id}&ch=${r.channel === 'instagram' ? 'ig' : 'wa'}`}
    className="text-xs text-un1t-muted underline hover:text-un1t-text"
  >
    Open conversation
  </a>
)}
```
Use `<Link>` from `next/link` if the page already imports it (CI enforces `no-html-link-for-pages`). `conversation_id` is now returned by the GET route (Task 4).

- [ ] **Step 4: Lint + build, commit**

Run: `npm run lint && npx next lint && npm run build`
Expected: pass.

```bash
git add src/app/api/whatsapp/conversations/route.js src/app/api/instagram/conversations/route.js src/app/settings/customer-agent/requests/page.js
git commit -m "INBOX-APPROVALS.10 — pending-approval queue flag + settings deep link to conversation"
```

---

### Task 11: Full CI mirror, changelog, PR

- [ ] **Step 1: Run the full CI mirror + build**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && npm run build
```
Expected: all pass (~2950+ tests; new shared tests included).

- [ ] **Step 2: Changelog entry**

Append to `docs/CHANGELOG.md` following its numbered format:
```
INBOX-APPROVALS — Mia approval requests render as decidable cards inline
in /communications/inbox threads (WA + IG): merge into timeline, realtime,
decline reason → Mia-voiced composer prefill, rule-based next steps
(shared/approvals-next-steps), pending-approval queue badges, decisions
opened to location staff (mig 357 + route gates), settings deep link.
```

- [ ] **Step 3: Push + PR**

```bash
git push -u origin HEAD
gh pr create --base main --fill --title "INBOX-APPROVALS — inline agent approvals in the unified inbox" \
  --body "$(cat <<'EOF'
Wave 1 of the inline-approvals program (spec: docs/superpowers/specs/2026-07-03-inbox-inline-approvals-design.md).

- Approval cards inline in WA + IG threads, realtime, decidable in place
- Decision rights follow the comms surface (staff at location; mig 357 widens SELECT for realtime)
- Rule-based next steps: composer prefill / Book tab / SequencePicker
- Decline → staff-reviewed Mia-voiced draft in the composer
- Pending-approval badges on the queue; settings page deep-links to the thread

⚠️ Mig 357 must be applied (Supabase MCP) BEFORE merge.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Report the PR URL. **Do not merge** — the orchestrator applies mig 357 + advisors first, then Richard merges.

---

## Deployment sequence (orchestrator, not executors)

1. All tasks committed + CI mirror green + PR open.
2. Apply `357_agent_requests_staff_read_realtime.sql` via Supabase MCP `apply_migration` on project `iyvtbjjxdggiadzwwvdj` (confirm project ref via `list_projects` first).
3. Run `get_advisors` (security) — expect no new findings beyond the 2 known intentional SECURITY DEFINER warnings.
4. Manual smoke on prod after merge: open `/communications/inbox`, find/create a pending request (test conversation), approve one booking end-to-end, verify Mia's confirmation lands in-thread, verify a decline prefills the composer, verify badge + realtime with a second browser window.

## Known non-goals (Wave 1)

- No retry on `failed` cards (the PATCH route only executes from `pending` — staff use the Book tab).
- Decline `reason` is persisted only inside `decision_note` (label prefix); post-reload next-steps use the generic draft.
- `book`-type steps hidden below `xl:` (no Command Centre rail there).
- Mobile (Wave 2) and AI suggestions (Wave 3) are separate plans.
