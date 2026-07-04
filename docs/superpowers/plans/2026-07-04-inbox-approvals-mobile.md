# Inbox Approvals Wave 2 — Mobile Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** Mia's approval requests render as decidable cards inline in the mobile CRM app's WA + IG threads, with composer-type next steps, mirroring web Wave 1.

**Architecture:** New `mobile/lib/approvals-api.js` (authHeaders-wrapped fetch/decide against the existing Wave 1 routes) + new `mobile/components/ApprovalCard.jsx` (NativeWind, shared helpers) + timeline merge in both thread screens via `mergeTimeline` from `shared/approval-cards`. Mobile is poll-based: approvals load with the thread and refresh after decisions. Next steps filter to `type === 'composer'` (no booking-create or sequence surface on mobile — plain-degradation decision, revisit if operators ask). JS-only ⇒ ships OTA.

**Branch:** `feat/inbox-approvals-mobile` (current, rebased on main @ 4cac16bd)
**Spec:** Wave 2 section of `docs/superpowers/specs/2026-07-03-inbox-inline-approvals-design.md`

## Read-first invariants
- Mobile CANNOT import `src/lib` — only `shared/` (verify the import style by copying an existing `shared/` import in `mobile/` — e.g. `mobile/lib/mobile-layout.js` uses relative `../../shared/mobile-nav`; use the SAME style, do not invent an alias).
- Every mobile `/api/*` wrapper builds headers via `authHeaders()` from `mobile/lib/api.js` (hand-rolled Bearer drops `x-impersonate-target`). Copy `mobile/lib/issues-api.js` shape incl. the `.catch(() => ({ success:false, ... }))` json guard.
- CI mirror gates: `check:mobile-imports`, `check:mobile-parity` (we add NO new WEB_PERMISSIONS key, so parity should pass untouched — verify), plus tests/lint/route-guards/guardrails and `npm run build`.
- If `mobile/package.json` changes (it should NOT for this work): re-sync the lock.
- Decisions hit `PATCH /api/agent/membership-requests/[id]` — statuses `approved|declined|saved` only; 409 = already decided elsewhere (show "Already decided", then refresh).

### Task W1: `mobile/lib/approvals-api.js`
Create, mirroring `mobile/lib/issues-api.js` (read it first):
```javascript
// mobile/lib/approvals-api.js — INBOX-APPROVALS Wave 2.
// Thread-scoped agent approval requests + decisions. Decisions go
// through the same web PATCH as the web inbox (atomic pending-claim,
// 409 when a colleague got there first).
import { API_BASE } from './config'   // ← verify real import: copy EXACTLY what issues-api.js imports/uses
import { authHeaders } from './api'

export async function listConversationApprovals(conversationId) {
  const headers = await authHeaders()
  const res = await fetch(`${API_BASE}/api/agent/membership-requests?conversation_id=${conversationId}`, { headers })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}

export async function decideApproval(requestId, status, decisionNote = null) {
  const headers = await authHeaders({ json: true })
  const res = await fetch(`${API_BASE}/api/agent/membership-requests/${requestId}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ status, decision_note: decisionNote }),
  })
  return res.json().catch(() => ({ success: false, error: `Bad response (${res.status})` }))
}
```
Adapt the `API_BASE`/import lines to whatever `issues-api.js` actually does (verbatim style). Lint must pass. Commit `INBOX-APPROVALS-M.1`.

### Task W2: `mobile/components/ApprovalCard.jsx`
RN card mirroring the web `src/components/ApprovalActionCard.jsx` semantics (read it + `mobile/app/issues/inbox.jsx` StatusPill + `mobile/components/ui/Button.jsx` first):
- Props: `{ request, contactFirstName, onDecided, onPrefillComposer }` (no book/sequence on mobile).
- Shared imports (relative style): `approvalCardSummary`, `APPROVAL_KIND_LABELS` from `shared/approval-cards`; `getNextSteps`, `buildDeclineDraft`, `DECLINE_REASONS`, `BOOKING_KINDS` from `shared/approvals-next-steps`.
- Pending: kind label + summary + customer_note quote; buttons Approve (primary) / Decline (secondary) / "Saved the member" (only `retention_flagged && kind==='cancellation'`); busy guard `if (busy) return` + disabled states (Button's `loading`).
- Decline flow: reason pills (from `DECLINE_REASONS`, filtered to `not_eligible|other` for non-BOOKING_KINDS, default `class_full` booking / `other` otherwise — mirror web) + optional TextInput note + Confirm decline / Back. decision_note = `[reasonLabel, note].filter(Boolean).join(' — ')`.
- On success: `onDecided(merged)` + if declined `onPrefillComposer(buildDeclineDraft(kind, reason, ctx))`. On `!success`: show error text inline (409 shows "Already decided").
- Decided: status pill (amber/green/blue/red tones per status, issues-inbox StatusPill pattern) + decision_note + next-steps row = `getNextSteps(kind, status, ctx).filter(s => s.type === 'composer')` rendered as small secondary buttons → `onPrefillComposer(step.draft)`.
- Styling: NativeWind + `cardClasses`/`buttonClasses` from `mobile/lib/ui-styles.js` where they fit; Pressable accessibility props per Button.jsx precedent.
Commit `INBOX-APPROVALS-M.2`.

### Task W3: WA thread integration (`mobile/app/whatsapp/[conversationId].jsx`)
Read the screen first. Add: `approvals` state; load via `listConversationApprovals(conversationId)` wherever the thread loads/refreshes (the `refresh()` path) — and clear/reload on conversation change; merge with `mergeTimeline(messages, approvals)` (shared import, relative style) replacing the plain messages iteration — keep the existing message rendering byte-identical, keyed `item.key`; render `<ApprovalCard …/>` for `item.kind === 'approval'` with `onDecided={() => refresh()}` (simplest poll-consistent behaviour: full refresh after decide) and `onPrefillComposer={t => setText(t)}` (verify composer state name). `contactFirstName`: from the conversation/contact object the screen already has (verify fields; fall back to profile name/username as web does). NOTE the list is manually `.reverse()`d — make sure the merged timeline respects the screen's existing ordering approach (merge THEN reverse exactly as messages were). Commit `INBOX-APPROVALS-M.3`.

### Task W4: IG thread integration (`mobile/app/instagram/[conversationId].jsx`)
Mirror W3 exactly, adapted (getThread shape, ig_username fallback). Commit `INBOX-APPROVALS-M.4`.

### Task W5: CI + changelog + PR
Full mirror: `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:guardrails && npm run build`. Append CHANGELOG entry (numbered format): mobile inline approval cards in WA+IG threads, composer-only next steps, OTA-shippable. Push `-u origin HEAD`, `gh pr create --base main` titled "INBOX-APPROVALS-M — inline agent approvals in the mobile inbox" (body: Wave 2 of the program; JS-only OTA; decisions via the same atomic-claim PATCH; book/sequence steps intentionally filtered on mobile; no migration). Do NOT merge.

**Review protocol:** per task spec review then quality review (fresh subagents), fix loops, final whole-branch review before PR. Known Wave 1 lessons: verify anchors by reading, quote `[id]` paths in zsh, no optimistic message inserts assumed.

**Out of scope (deliberate):** mobile booking/sequence surfaces (steps filtered), realtime (poll pattern kept), push notification on new pending approvals (candidate follow-up), the /approvals mobile hub (`MOBILE_APPROVAL_KEYS`) — inline cards only.
