# Approvals Customer Queue (APPROVALSQ.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the web, put Mia requests, paid trials, corporate promos and offer sales in one list on `/approvals` with one card layout, and let staff clear a waiting or failed Mia request without the customer being messaged.

**Architecture:** No migration and no registry change. Two routes gain one optional body field each. A pure module merges the four customer providers' items from the existing `/api/approvals/pending` response into one ordered list. A shared card shell gives the four card components one layout and one button order; `ApprovalsInbox` gains a Customers view above the existing tabs.

**Tech Stack:** Next.js 16 App Router, React client components, Supabase service-role routes, Zod, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-14-approvals-customer-queue-design.md`

**Scope:** this plan is the WEB PR only. The phone's quiet clear is a second plan, written after this one is live.

## Global Constraints

- Work in the worktree `~/code/un1t-crm-approvals-queue`, branch `approvals-customer-queue`. Check `git branch --show-current` before every commit.
- A quiet clear sends nothing: no WhatsApp, no email, no push, nothing to Glofox or un1t.online.
- The existing decline (status `declined`, no `silent`) must behave exactly as before.
- No new status, no migration, no new permission key.
- `silent` is accepted only on the staff PATCH route. Nothing under `src/lib/agent/` or `src/lib/agent-tools/` may send it.
- Every Supabase write destructures `error` and handles it. Every `<button>` inside a `<form>` has a `type`. Chips use `bg-<c>-500/10 text-<c>-700`. Colours use `un1t-*` tokens.
- Detail routes answer 404, not 403, for an id outside the caller's reach (already true; keep it).
- User-facing copy: plain words, no em dashes.
- Commit trailer on every commit: `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`
- On an 8 GB machine never run the full suite beside `npm run build`. Run focused test files per task; run the CI mirror once in Task 8.
- Paths with `[id]` are zsh globs: single-quote them.

## Review Focus

1. `silent: true` sent with `status: 'approved'` or `'saved'`: must be refused 400, never approve quietly. (Task 1)
2. Quiet clear on an email-delivered pause or cancellation: `sendMembershipOutcomeMessage` must not be called. (Task 1)
3. Two people clear or decide the same request at once: the loser gets 409 and writes nothing. (Task 1)
4. A viewer who holds `approvals_agent_requests` but not `approvals_offer_purchases` (or the reverse): the list shows only what the API returned, chips for absent providers are not rendered, and nothing crashes on a missing provider. (Tasks 3, 6)
5. A double click on "Clear, don't notify" or "Mark granted, no email": one request goes out. (Tasks 4, 5)

---

### Task 1: Quiet clear on the Mia request route

**Files:**
- Modify: `src/app/api/agent/membership-requests/[id]/route.js` (schema at ~56; new branch after `validateBody`, before the `isMembershipKind` location read)
- Create: `src/app/api/agent/membership-requests/[id]/route.silent.test.js` (copy the mock header from `route.test.js`; also mock `@/lib/cancellation-form/confirm`)

**Interfaces:**
- Produces: `PATCH /api/agent/membership-requests/[id]` accepts `{ status: 'declined', silent: true, decision_note?: string|null }`.
  Success: `{ success: true, request: { id, status: 'declined', decided_at, decision_note, details }, executed: null, customer_notified: { sent: false, channel: null, reason: 'cleared' }, planned_end_date: null }`.
  `details.cleared = { silent: true, from_status: 'pending' | 'failed' }`.

- [ ] **Step 1: Write the failing tests** in `route.silent.test.js`:

```js
it('clears a pending request and sends nothing')
// row { status:'pending', kind:'class_booking', conversation_id:'c1', channel:'whatsapp' }
// body { status:'declined', silent:true, decision_note:'duplicate' }
// expect 200; update patch: status 'declined', decided_by 'staff-1', decision_note 'duplicate',
//   details.cleared toEqual { silent:true, from_status:'pending' }
// expect the update was filtered .eq('status','pending')
// expect sendAgentThreadMessage, createBooking, cancelBooking, sendMembershipOutcomeMessage not called
// expect json.customer_notified toEqual { sent:false, channel:null, reason:'cleared' }

it('clears a failed request (any failed row, retry window not consulted)')
// row { status:'failed', kind:'class_booking', decided_at: 40 days ago }
// expect 200, details.cleared.from_status 'failed', update filtered .eq('status','failed')

it('sends no email for an email-delivered cancellation')
// row { status:'pending', kind:'cancellation', channel:'email', conversation_id:null }
// expect 200 and sendMembershipOutcomeMessage not called

it('refuses silent with approved or saved')   // each → 400, no update
it('refuses a stuck approved row')            // row status 'approved' + details.execution.stage 'executing', stale → 409 'Already decided'
it('refuses an already decided row')          // status 'declined' | 'actioned' → 409, no update
it('answers 409 when the claim matches no row') // update returns data null → 409
it('answers 500 when the claim write errors')   // update returns { error } → 500
it('a plain decline still sends the in-thread notice') // no silent → sendAgentThreadMessage called once
```

- [ ] **Step 2: Run** `npx vitest run 'src/app/api/agent/membership-requests/[id]/route.silent.test.js'` — expect FAIL (silent ignored / validation).

- [ ] **Step 3: Implement.**
  - `DecisionSchema`: add `silent: z.boolean().optional()` and a `.refine` that rejects `silent === true` unless `status === 'declined'` (message `silent applies to a decline only`).
  - Immediately after `validateBody`: `if (v.data.silent) return clearSilently(db, user, row, v.data)`.
  - `async function clearSilently(db, user, row, body)` in the same file: 409 `Already decided` unless `row.status` is `'pending'` or `'failed'`; one update `{ status: 'declined', decision_note, decided_by: user.id, decided_at, updated_at, details: { ...(row.details || {}), cleared: { silent: true, from_status: row.status } } }` filtered `.eq('id', row.id).eq('status', row.status)`, `.select('id, status, decided_at, decision_note, details').maybeSingle()`; `error` → 500; no row → 409; else the success shape above. It imports no send helper.

- [ ] **Step 4: Run** the new file plus `route.test.js`, `route.cancellation.test.js`, `route.refund.test.js`, `route.event-move.test.js`, `route.un1t.test.js` — expect PASS.

- [ ] **Step 5: Commit** `APPROVALSQ.1 — quiet clear on agent requests (declined, silent)`.

---

### Task 2: "Mark granted, no email" on the paid trial review route

**Files:**
- Modify: `src/app/api/trial-purchases/[id]/review/route.js` (schema line 33; the email block at ~116)
- Modify: `src/app/api/trial-purchases/[id]/review/route.test.js`
- Modify: `src/lib/openapi.js` (the `/api/trial-purchases/{id}/review` entry, ~842)

**Interfaces:**
- Produces: body `{ action: 'retry' | 'resolve' | 'handled', notify?: boolean }`. `notify: false` is honoured only with `resolve`; response `data: { status: 'granted', emailed: false }`.

- [ ] **Step 1: Failing tests** (add to the existing file):

```js
it('resolve with notify:false grants and sends no email')
// expect update patch status 'granted', granted_at set; sendTrialPurchaseEmail not called;
// json.data toEqual { status:'granted', emailed:false }
it('resolve without notify still emails')            // existing behaviour pinned
it('notify:false with retry or handled is refused')  // 400, no write
```

- [ ] **Step 2: Run** `npx vitest run 'src/app/api/trial-purchases/[id]/review/route.test.js'` — expect the new ones FAIL.
- [ ] **Step 3: Implement.** Schema gains `notify: z.boolean().optional()` with a refine: `notify === false` only when `action === 'resolve'`. Skip `sendTrialPurchaseEmail` when `notify === false`. Update the openapi body schema and description ("resolve with notify:false marks it granted without the confirmation email").
- [ ] **Step 4: Run** the file — PASS.
- [ ] **Step 5: Commit** `APPROVALSQ.1 — trial review: resolve without the confirmation email`.

---

### Task 3: The merged customer list (pure)

**Files:**
- Create: `src/lib/approvals/customer-queue.js`
- Create: `src/lib/approvals/customer-queue.test.js`

**Interfaces:**
- Produces:
  - `CUSTOMER_PROVIDER_KEYS = ['agent_requests', 'trial_purchases', 'corp_promo_claims', 'offer_purchases']`
  - `CUSTOMER_FILTER_LABELS = { agent_requests: 'Mia requests', trial_purchases: 'Paid trials', corp_promo_claims: 'Corporate promos', offer_purchases: 'Offer sales' }`
  - `buildCustomerQueue(providers: Array, nowMs = Date.now()) → { needsFixing: Item[], waiting: Item[], chips: Array<{ key, label, count }>, total: number }` where every `Item` is the provider's item plus `providerKey`.
  - `teamProviders(providers) → Array` (providers whose key is not in `CUSTOMER_PROVIDER_KEYS`, order kept).
  - `filterQueue(queue, key | 'all') → { needsFixing, waiting }`.

Rules: `needsFixing` = `agent_requests.failedItems`. `waiting` = every other item of the four providers. Order inside each group: items with a parseable `details.starts_at`, soonest first; then the rest by `submittedAt` ascending (oldest first); a missing `submittedAt` sorts last. `chips` holds one entry per customer provider PRESENT in `providers` (count = that provider's `count`), in `CUSTOMER_PROVIDER_KEYS` order. `total` = sum of those counts.

- [ ] **Step 1: Failing tests:**

```js
it('puts failed Mia items in needsFixing and everything else in waiting, each tagged with providerKey')
it('orders by class start soonest, then oldest submitted')
// waiting input: A {submittedAt:'2026-11-10'} , B {details:{starts_at:'2026-11-15T09:00Z'}, submittedAt:'2026-11-13'},
//                C {details:{starts_at:'2026-11-14T18:00Z'}, submittedAt:'2026-11-13'}, D {submittedAt:'2026-11-12'}
// expect ids ['C','B','A','D']
it('builds chips only for providers present, in fixed order, with their counts')
it('tolerates a missing provider, missing failedItems and a missing items array') // providers [] → all empty, total 0
it('teamProviders drops the four customer keys and keeps order')
it('filterQueue narrows both groups to one providerKey; "all" returns both unchanged')
```

- [ ] **Step 2: Run** `npx vitest run src/lib/approvals/customer-queue.test.js` — FAIL.
- [ ] **Step 3: Implement** the four exports.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `APPROVALSQ.1 — merged customer queue (pure)`.

---

### Task 4: One card shell; trial, promo and offer cards on it

**Files:**
- Create: `src/components/approvals/CustomerCardShell.jsx`
- Create: `src/components/approvals/OfferPurchaseCard.jsx`
- Create: `src/components/approvals/customer-cards.test.jsx`
- Modify: `src/components/TrialPurchaseReviewCard.jsx`, `src/components/CorpPromoClaimCard.jsx`

**Interfaces:**
- Produces `CustomerCardShell` props:
  `{ source: string, kind?: string, state?: { label: string, tone: 'red' | 'amber' | 'neutral' }, name: string, meta?: string, when: string, amount?: string, summary?: ReactNode, children?: ReactNode (the why line, warnings, lists), contact?: ReactNode, links?: ReactNode, outcome?: { tone: 'ok' | 'bad' | 'neutral', text: string } | null, actions?: ReactNode, quietAction?: ReactNode, error?: string | null }`.
  Layout, top to bottom: header row (source chip, kind chip, state chip, name, meta chip; right side: amount, when), summary, children, contact, links, outcome, then one button row: `actions` on the left, `quietAction` pushed to the right end (`ml-auto`). Root is the existing card frame `border border-un1t-border rounded-lg p-4 bg-un1t-surface`. No `<form>`.
- Produces `OfferPurchaseCard({ item, onDecided })`: source "OFFER SALE", state `{ label: 'Paid, not set up', tone: 'amber' }`, main button "Mark fulfilled (emails buyer)" → `POST /api/offer-purchases/${item.id}/fulfil`; link "Open offer sales" → `item.reviewUrl`. Read the route's response in `src/app/api/offer-purchases/[id]/fulfil/route.js` for whether the email went and word the outcome from it.
- `TrialPurchaseReviewCard`: grant kind gets a third button in `quietAction`: "Mark granted, no email" → body `{ action: 'resolve', notify: false }`; outcome "Marked granted. No email was sent." Buttons stay disabled while any request is in flight.

- [ ] **Step 1: Failing tests** in `customer-cards.test.jsx` (mock `fetch`):

```js
it('trial grant card shows Retry grant, Mark granted in Glofox, Mark granted, no email, in that order')
it('Mark granted, no email posts { action:"resolve", notify:false } and shows "Marked granted. No email was sent."')
it('a double click on Mark granted, no email sends one request')
it('trial help card shows only Mark handled')
it('corp promo card shows only Mark handled and keeps its why line and contact details')
it('offer card posts to /api/offer-purchases/<id>/fulfil and calls onDecided once')
it('every card keeps the facts it showed before') // trial: attempts, mayHaveLanded warning, glofox member id; corp: un1t user id
```

- [ ] **Step 2: Run** `npx vitest run src/components/approvals/customer-cards.test.jsx` — FAIL.
- [ ] **Step 3: Implement** the shell and the offer card; rebuild the two existing cards on the shell without dropping any field they render today.
- [ ] **Step 4: Run** the file — PASS.
- [ ] **Step 5: Commit** `APPROVALSQ.1 — shared customer card shell; trial, promo and offer cards`.

---

### Task 5: Mia request card on the shell, with "Clear, don't notify"

**Files:**
- Modify: `src/components/AgentRequestDecideCard.jsx`
- Modify: `src/components/AgentRequestDecideCard.outcome.test.jsx`
- Create: `src/components/AgentRequestDecideCard.clear.test.jsx`

**Interfaces:**
- Consumes: `CustomerCardShell` (Task 4); the PATCH body and response from Task 1.
- Produces: `outcomeLine(status, item, executed, notified, plannedEndDate)` returns `{ tone: 'neutral', text: 'Cleared. The customer was not told.' }` when `status === 'declined' && notified?.reason === 'cleared'` (checked before every other declined branch).

Behaviour:
- Button labels: "Approve" / "Fixed it, retry" stay; "Decline" becomes "Decline and tell them"; new "Clear, don't notify" in the shell's `quietAction`, shown when there is no outcome, on waiting AND failed cards.
- Pressing it opens a confirm panel in place of the button row: optional note input, a red-outline "Clear, don't notify" confirm button and "Back". When `item.kind` is in `BOOKING_KINDS` or is `'consultation'`, and the card is not a failed item, the panel shows: "Mia told this customer the team would confirm. Clearing sends them nothing."
- Confirm sends `{ status: 'declined', silent: true, decision_note: note || null }`. On a failed card this is the only decision besides retry.
- 409 keeps the existing "Already decided elsewhere" message.

- [ ] **Step 1: Failing tests:**

```js
// outcome test file
it('outcomeLine says cleared and not told for a silent decline')
// clear test file
it('a waiting card offers Approve, Decline and tell them, Clear, don\'t notify')
it('a failed card offers Fixed it, retry and Clear, don\'t notify, and no Decline and tell them')
it('the confirm warns on a waiting class booking and not on a pause')
it('confirming sends { status:"declined", silent:true, decision_note:"dup" } and shows "Cleared. The customer was not told."')
it('a double click on confirm sends one request')
it('calls onDecided once')
```

- [ ] **Step 2: Run** both files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both files — PASS.
- [ ] **Step 5: Commit** `APPROVALSQ.1 — agent request card: shared shell, clear without notifying`.

---

### Task 6: The Customers view on `/approvals`

**Files:**
- Modify: `src/components/ApprovalsInbox.jsx`
- Create: `src/components/ApprovalsInbox.test.jsx`
- Modify: `src/app/approvals/page.js` (intro sentence only: "Everything waiting on you. Customer items are decided right here; team and money items open their own page.")

**Interfaces:**
- Consumes: `buildCustomerQueue`, `filterQueue`, `teamProviders`, `CUSTOMER_FILTER_LABELS` (Task 3); the four cards (Tasks 4, 5).

Behaviour:
- Two view buttons at the top: "Customers" (badge `queue.total`) and "Team and money" (badge = sum of `teamProviders` counts). A view with no providers at all is not rendered. First load opens Customers when `queue.total > 0` or there are no team providers, else Team and money.
- Customers view: chip row `All <total>` plus one chip per `queue.chips` entry; then, when non-empty, the heading "Needs fixing" and its cards, then "Waiting" and its cards (the Waiting heading only when both groups have items). Card by `providerKey`: `agent_requests` → `AgentRequestDecideCard`, `trial_purchases` → `TrialPurchaseReviewCard`, `corp_promo_claims` → `CorpPromoClaimCard`, `offer_purchases` → `OfferPurchaseCard`. Empty: "Nothing waiting on customers."
- Team and money view: the existing tab strip and link list, fed `teamProviders(providers)`, behaviour unchanged.
- `onItemDecided(providerKey)` keeps decrementing that provider's count and the total; cards stay until the next load.
- Refresh button, focus refresh and error box unchanged.

- [ ] **Step 1: Failing tests** (mock `fetch` for `/api/approvals/pending`):

```js
it('shows one list mixing Mia, trial, promo and offer cards, failed Mia first under "Needs fixing"')
it('a chip narrows the list and All restores it')
it('renders no chip for a provider the API did not return')        // only agent_requests present
it('opens on Team and money when no customer item is waiting')
it('hides the Customers view when the API returns no customer provider')
it('Team and money shows the old tabs without the four customer keys')
it('deciding a card drops the Customers badge by one')
it('one provider with count 0 and no items does not break the list')
```

- [ ] **Step 2: Run** `npx vitest run src/components/ApprovalsInbox.test.jsx` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the file — PASS.
- [ ] **Step 5: Commit** `APPROVALSQ.1 — /approvals: Customers view with one list`.

---

### Task 7: The other two places a Mia request is decided

**Files:**
- Modify: `src/components/ApprovalActionCard.jsx` (inbox card) and add `src/components/ApprovalActionCard.clear.test.jsx`
- Modify: `src/app/settings/customer-agent/requests/AgentRequestsClient.jsx` and its test file if one exists (else create `AgentRequestsClient.clear.test.jsx` beside it)

**Interfaces:**
- Consumes: the Task 1 PATCH contract.

Behaviour:
- Inbox card: a "Clear, don't notify" button beside the decline controls on a pending request; it sends `silent: true`, then does NOT call the `/suggest` fetch and does NOT call `onPrefillComposer`. Status line reads "Cleared, customer not told".
- Requests page: `RequestCard` gets "Clear, don't notify" on pending rows and on `retryMode` (failed) rows. It is not offered on stuck rows. In the decided list a row with `details.cleared?.silent` shows the label "Cleared, customer not told" in place of "Declined". `decide(id, status, { silent })` passes the flag through.

- [ ] **Step 1: Failing tests:**

```js
// ApprovalActionCard.clear.test.jsx
it('Clear, don\'t notify sends silent:true, fetches no suggestion and prefills nothing')
it('a plain decline still fetches the suggestion') // existing behaviour pinned
// AgentRequestsClient
it('offers the clear on pending and failed rows, not on a stuck row')
it('labels a silently cleared row "Cleared, customer not told"')
```

- [ ] **Step 2: Run** both files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** both files plus `ApprovalActionCard.failure.test.jsx` and `ApprovalActionCard.refund.test.jsx` — PASS.
- [ ] **Step 5: Commit** `APPROVALSQ.1 — inbox card and requests page: clear without notifying`.

---

### Task 8: Guards, docs, checks, PR

**Files:**
- Create: `tests/agent-silent-clear-guard.test.js`
- Modify: `docs/architecture/REFERENCE.md` (the approvals section: the Customers view, the quiet clear, `details.cleared`)
- Create after the PR exists: `docs/changelog/entries/<PR>.md`

- [ ] **Step 1: Write the guard test:** scan every non-test file under `src/lib/agent/` and `src/lib/agent-tools/` and fail if any contains `silent: true` or `silent:true` next to a `membership-requests` path or an `agent_membership_requests` write of `cleared`. (Mia and MCP tools must never clear quietly.) Run it — PASS.
- [ ] **Step 2: Run `npm run build`** alone. Expected: success.
- [ ] **Step 3: Run the CI mirror once**, alone:
  `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:bundle-sql && npm run check:ota-paths`
  Expected: all green. Fix what fails; do not re-run the full suite beside anything else.
- [ ] **Step 4: Walk it in the browser** with the `preview_start` dev server: open `/approvals`, confirm the Customers view, the chips, the card order, and the confirm panel on a Mia card. Do NOT press a clear or decline on a real customer's request; stop at the confirm panel. Take one screenshot.
- [ ] **Step 5: Update `REFERENCE.md`, commit, push** `git push -u origin approvals-customer-queue:approvals-customer-queue`, open the PR (`gh pr create --base main`), no customer names in the body, ending with the Claude Code line. Add `docs/changelog/entries/<PR>.md`, commit, check the PR is still open, push.
- [ ] **Step 6: Report** the PR URL and what was and was not verified live. Do not merge.
