# MIAHATCH — Mia at Hatch Street (spec E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mia answers a member from the studio where they hold a membership (Hatch on un1t.online, Stillorgan on Glofox, or both), books and cancels Hatch classes through spec D's write client, and when a Hatch member has nothing to book with, offers staff-chosen products, sends a hosted payment link, and books the class once the payment lands.

**Architecture:** A per-turn member-studio resolver (`member-studios.js`) decides which studios are *answerable* (active membership AND that studio's Mia gate passes for this sender). A pure block selector picks one of five byte-stable cached tool blocks (Glofox, no-booking, un1t read, un1t read + Glofox writes, un1t full), and `refuseToolForTurn` refuses anything outside the selected block before any read or API call. un1t executors live in `un1t-tools.js` (reads), `un1t-booking.js` (book/cancel/refund request) and `purchase-intents.js` (upsell), calling spec D's primitives and spec A's seam reads; pending payment links live in a service-role table settled by one CAS'd function fed by three detectors.

**Tech Stack:** Next.js 16 App Router, Supabase (service role), vitest + PGlite, Anthropic Messages API via `anthropicMessages` (unchanged), `@dnd-kit/sortable` (offer ordering).

**Spec:** `docs/superpowers/specs/2026-10-17-mia-at-hatch-design.md` (spec E). Siblings it consumes, by name only: A `2026-10-17-hatch-pipeline-and-invoices-design.md`, D `2026-10-17-un1t-online-write-back-design.md`. Their plans are `docs/superpowers/plans/2026-10-17-*.md`; read the merged code for exact argument names before calling them (see "Sibling interfaces").

**Execution:** superpowers:subagent-driven-development. Implementer subagents have **no Supabase MCP access**: every migration apply, live read-only probe and advisor run is a **controller** step, marked `[controller]`.

## Global Constraints

- Mia stays on the Anthropic Messages API (`anthropicMessages`), not the Agent SDK; no OpenAI anywhere.
- `enabled=true` + `test_mode=true` = LIVE FOR EVERYONE. A test allowlist is `enabled=false`, `test_mode=true`, `test_phones=[MIA TEST phone]`.
- Never surface class capacity, spaces left or headcount to the model or a customer: the un1t timetable payload carries `full: true|false` only, never `capacity`, `bookings_count` or `limited`.
- A Glofox studio's tool block, prompt and executor output stay byte-identical (`src/lib/agent/__fixtures__/glofox-agent-tools.fixture.json`, `glofox-system-prompt.fixture.json`); the no-booking block and prompt too. The one deliberate Stillorgan change is `membership_at_other_studio` (PR 1).
- Customer-facing copy is operator-editable: a `customer_agent` key in `settings-contract.js` (DEFAULTS null, `SettingsSchema`, `buildCustomerAgentSettings`, `INHERITABLE_SCALAR_KEYS`) with a code default. Defaults contain no em-dash (U+2014) or en-dash (U+2013); test-guarded.
- No code sends `bypassCredit` or `forceRefund`, calls `/purchases/charge`, `/credits/grant` or any refund endpoint (static test, Task 21). Mia reaches the €0 charge only through D's `grantTrial`.
- Every un1t write, purchase and refund tool is WhatsApp-only (R3); Instagram turns keep today's blocks.
- Every send is an in-thread reply or a `sendAgentThreadMessage` confirmation inside the 24h window (G7); E sends no email (R4) and no template.
- Migrations: forward-only; file name `NNN_<name>.sql` with `NNN` = next free number at build time (A-D land first; today's highest is 735). **[controller] applies via Supabase MCP `apply_migration` on project `iyvtbjjxdggiadzwwvdj`, then `get_advisors` (type `security`)**, before the PR that needs it merges. New tables: `ENABLE ROW LEVEL SECURITY`, no policy, `REVOKE ALL ON public.<t> FROM anon, authenticated`, `GRANT SELECT, INSERT, UPDATE, DELETE ON public.<t> TO service_role` (mig 726 pattern; `tests/table-default-acl-guard.test.js`).
- Service-role routes: `getCurrentUser()` → `assertLocationAccess` → `validateBody` → `{ success, data?, error? }`; a foreign id is 404; register in `src/lib/openapi.js`.
- A public page is in all four allowlists: `src/proxy.js` `publicPaths` (`'/pay-done/'`), `AppShell` `PUBLIC_PATHS` (`'/pay-done'`), `src/lib/brands.js` un1t-marketing `allowedPaths` (`'/pay-done/'`), `src/lib/tenant-domains-edge.js` `DB_BRAND_DEFAULTS.allowedPaths` (`'/pay-done/'`); `src/public-compliance-paths.test.jsx`.
- Tests never call the Anthropic API or un1t.online live: fake `anthropicMessages` as the existing `auto-reply-*.test.js` files do; fake the un1t read client and `vi.mock('@/lib/un1t-online-write')` with `src/lib/agent/un1t-fakes.test-helpers.js` (Task 4). Fictional ids only (the repo is public).
- supabase builders are thenables: destructure `error` on every read and write; `.maybeSingle()` where 0 rows is legitimate; every named column must pass `check:select-columns`.
- Logging: module `'mia-un1t'`, `logWarn` / `logError` from `@/lib/log`, every un1t failure with `status`; never a token, email, phone, name or checkout URL.
- Zone maths only through `@/lib/location-time` and the existing `formatClassTime(…, ctx.zone)`.
- Ticket prefix `MIAHATCH.<PR>`. One PR = one fresh worktree and branch off fresh `origin/main`; ship with the Ship steps below; one changelog entry per PR after `gh pr create`.

## Review Focus

1. **Two concurrent "send me the link" requests** (two turns, or a retry) race the partial unique index: the loser's 23505 must read as "a live intent exists" (resend the same link or `purchase_link_open_text`), never a tool error or a second link. Test in Task 19.
2. **`credit_unlimited = true` with `credit_balance = 0`**, or a live subscription with an unreadable ledger: the member is entitled and gets booked, never upsold. Test in Task 16.
3. **Payment after the intent expired, or for a different product than the intent**: an expired intent books nothing and sends nothing; a different product still counts as "paid" (un1t.online arbitrates) and records the product actually bought. Test in Task 21.
4. **Relayed class time across zones and studios**: a dual member says "the 7am" and the model relays a Hatch `un1t:` id with Stillorgan's 7am label, or a label rendered across a DST change; `book_class` refuses a `starts_at` that does not match the event in the studio's own zone. Test in Task 16.
5. **A person group holding two different `un1t_user_id`s at one studio** (a duplicate un1t.online account): the resolver picks one deterministically (active row first, then latest `last_attended_at`), logs `multiple_un1t_users`, and never mixes their bookings or credits. Test in Task 1.

## Ship steps (every PR)

- **S1** (at PR start) `git fetch origin main && git checkout -b <branch> origin/main` in a fresh worktree. Expected: branch at `origin/main`.
- **S2** CI mirror:
  `npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:select-columns && npm run check:rpc-names && npm run check:bundle-sql && npm run check:ota-paths`
  Expected: every command exits 0.
- **S3** `npm run build`. Expected: build completes, no unresolved import.
- **S4** `git push -u origin HEAD && gh pr create --base main --fill`. Expected: PR URL printed; report it.
- **S5** Add `docs/changelog/entries/<PR>.md` (one row keyed `#<PR>`: ticket, summary, migration number if any), commit `MIAHATCH.<n> — changelog`, push. Expected: entry in the PR diff.
- **S6** [controller] watch **Test & lint** and **Next build** go green. Merge only under Richard's standing rules (auto-merge only when he asks; never `gh pr merge`).

## PRs and dependencies

| PR | Branch | Slice | Tasks | Waits for |
|---|---|---|---|---|
| 1 `MIAHATCH.1` | `feat/miahatch-1-member-studios` | 1 | 1-2 | nothing (live Stillorgan change, ships alone) |
| 2 `MIAHATCH.2` | `feat/miahatch-2-un1t-reads` | 1 | 3-9 | PR 1 merged |
| 3 `MIAHATCH.3` | `feat/miahatch-3-payment-reminder` | 1 | 10 | PR 2; **A's PR 2** (seam `pastDue` + the `account-tools.js:609` provider fix) merged |
| — rollout | — | 1 | 11 | PR 2 deployed (PR 3 optional) |
| 4 `MIAHATCH.4` | `feat/miahatch-4-offers-and-tables` | 2 | 12-14 | **D's migration applied** (migration number order; D's `refund_request` kind must be live before PR 5). Code is inert |
| 5 `MIAHATCH.5` | `feat/miahatch-5-book-cancel` | 2 | 15-18 | PR 2, PR 4; **D merged and deployed** (`book`, `cancel`, `executeUn1tApproval`, `fileRefundCard` + the `refund_request` kind and labels, `writes_enabled`) |
| 6 `MIAHATCH.6` | `feat/miahatch-6-upsell` | 2 | 19-25 | PR 5; **D** (`createCheckoutLink`, `grantTrial`, the `un1t-online-trial-used.js` stubs); **A** (`trialEligibility`) |
| — rollout | — | 2 | 26-27 | PR 6 deployed; D's own live test passed |

D's `bookings` flip (D's one-line PR to `sources/un1t-online.js`) waits for PR 5 deployed (anti-goal 3).

**OTA / mobile flags:** No task in this plan touches `mobile/` or `shared/`, so no PR here publishes an OTA. D owns the `refund_request` labels in `shared/approval-cards.js` / `shared/approvals-next-steps.js` (an OTA on D's side). **Settings mobile-parity decision:** the offer list is web only (Mia settings has no phone editor); it uses `canEditMiaSettings`, no new permission key, so `check:mobile-parity` is not triggered and no `WEB_ONLY_OK` entry is needed. If an implementer finds they need a key, it goes in `WEB_ONLY_OK` with reason "Mia settings have no phone editor".

## Sibling interfaces (consumed by name; never re-implemented)

- **A** (on `un1tOnlineReads`, reached through `membershipReadsFor(db, locationId)` + `supportsRead(r, key)`):
  - `trialEligibility(db, locationId, { un1tUserId, contactId })` → `{ success, data: { eligible, reasons: [] } }`, `reasons` drawn from `'trial_used' | 'membership_history' | 'paid_pack'` (possibly several); `{ success: false, error }` on a failed read, which is never eligible. (Not `{ eligible, reason }`.) A D ledger trial row in stage `done`, `sent` or `unknown` counts as `trial_used` inside A's rule (D supplies the ledger reader); E never re-derives any of it.
  - `pastDue(db, locationId, { contactIds })` → `{ success: true, data: [{ contactId, un1tUserId, subscriptionId, productTitle, since, amountCents, currency, openInvoiceIds, cancelAtPeriodEnd, pausedUntil }] } | { success: false, error }`.
- **D** (final plan `docs/superpowers/plans/2026-10-17-un1t-online-write-back.md`; read its Interfaces blocks):
  - From `@/lib/un1t-online-write`: `book`, `cancel`, `grantTrial`, `createCheckoutLink`, `classifyRefusal`, `UN1T_REFUSAL_CODES`, `Un1tWriteRefused`, `Un1tWriteUnknown`. From `@/lib/un1t-online-approval`: `executeUn1tApproval`, `fileRefundCard`.
  - `book(db, { locationId, contactId, un1tUserId, eventId /* bare uuid, no 'un1t:' */, origin: 'mia', originRef, actor })`, `cancel(db, { locationId, contactId, un1tUserId, bookingId /* bare uuid */, origin, originRef, actor })` → `Un1tWriteResult = { verdict: 'done'|'refused'|'unknown', sent, id, code, message, alreadyBooked, recovered, retryable, ledgerId, data }`; dedupe read already run inside; every outcome resolves (rejects only on a settings/ledger DB error before anything was sent). `cancel` of an attended / no-show booking → `refused`, `code 'already_happened'`.
  - `classifyRefusal({ code, message })` → `'no_credits'|'class_full'|'already_booked'|'trial_used'|'email_in_use'|'late_cancel'|null`. E reads refusals only through it, never the raw table. Until D's PR 6 fills `UN1T_REFUSAL_CODES` only `already_booked` and `email_in_use` are matched (by words); `trial_used` is never guessed.
  - `grantTrial(db, { locationId, un1tUserId, contactId, origin: 'mia', originRef, actor })` → `{ outcome: 'granted', method, ledgerId } | { outcome: 'ineligible', reason } | { outcome: 'needs_staff', reason } | { outcome: 'retry', code }`. **It files no card:** E files its own staff card on `needs_staff` (card reason = `needs_staff.reason`) and handles `retry`. Until D's PR 6, a trial-used refusal from un1t.online arrives as `needs_staff` (`un1t_trial_failed:<code>`), so it lands as a staff card.
  - `createCheckoutLink(db, { locationId, userId, productId, successUrl, cancelUrl, idempotencyKey, origin = 'mia', originRef = null, actor = null })` → `{ checkoutUrl, free }`; rejects `Un1tWriteRefused` (incl. `free_product_not_via_checkout`, `not_a_customer_url`, `no_client_at_studio`, `product_not_sellable`, every `UN1T_*` refusal) or `Un1tWriteUnknown`. URL hosts must equal `resolveCustomerBaseUrl(db, locationId)`'s host.
  - `executeUn1tApproval(db, { row: { id, location_id, kind: 'class_booking'|'class_cancellation', status, details /* provider 'un1t_online', reason, event_id|booking_id, un1t_user_id, executing_contact_id, starts_at */, contact_id, channel, conversation_id }, actor, now })` → `{ finalStatus: 'actioned'|'failed', details, executed, customerNotified }`; applies no past-start guard (the route does) and sends no WhatsApp (E does). D's route already sends every `class_booking` row with `details.provider === 'un1t_online'` to it; the `class_cancellation` route branch is E's.
  - `fileRefundCard(db, { locationId, contactId, un1tUserId, reason, bookingId?, transactionIds?, amountCents?, currency?, origin: 'mia', originRef?, conversationId?, channel? })` → `{ approvalId: string|null }`; never throws; dedupes on a pending card with the same `(contact_id, reason, origin_ref)`.
  - Seam stubs E replaces (D ships them as no-ops in `src/lib/un1t-online-trial-used.js`): `trialUsedHandoff(db, { request, contact, locationId }) → Promise<{ handled: boolean }>` and `trialUsedOptionsText(db, locationId) → Promise<string|null>` (Task 25).
  - Refusal codes `UN1T_WRITES_OFF`, `UN1T_PERMISSION_MISSING`, `UN1T_RATE_BUDGET`, `UN1T_ATTEMPT_IN_FLIGHT`. Switch `locations.settings.un1t_online.writes_enabled`; trial product `settings.un1t_online.trial_product_id`. Rate key `un1t-write:<locationId>`, `{ max: 30, windowMs: 60_000 }`.
  - `getOne(path)` on `createUn1tClient` (`src/lib/un1t-online.js`); Task 4 adds it only if D has not.
- Before starting Tasks 16-21 and 25 the implementer reads D's merged exports and A's merged `un1tOnlineReads` and uses their exact argument names; a mismatch with this block is reported to the controller, not papered over.

## Plan decisions where the spec and a sibling disagree (controller's calls, flagged to Richard)

1. **Third detector:** spec E's post-sync hook would have the sync cron reach D's `book`, which D's import fence forbids, so the plan uses spec E's own fallback, a 5-minute mirror-only watcher with a heartbeat row (Task 23).
2. **`createCheckoutLink`:** D's shape (accepted 17 Oct): called with `origin: 'mia'`, `originRef: intent.id`; refusals arrive as thrown `Un1tWriteRefused`/`Un1tWriteUnknown`, not as a returned `code` (Task 19).
3. **Return URLs** use `resolveCustomerBaseUrl(db, locationId)`, not `getAppUrl()`, because D refuses non-customer hosts (Task 19).
4. **`refund_request` is D's** (decided 17 Oct): the kind CHECK, the `shared/` labels and `fileRefundCard` ship in D; E only calls `fileRefundCard` and depends on D for the rest (Tasks 12, 17, 18).
5. **Refund requests in chat** need a tool the spec does not name: `request_refund`, block 3b only (Task 15). **The trial yes** goes through `send_purchase_link({ offer_id: 'trial' })`, no fourth purchase tool (Task 20).
6. **A failed `trialEligibility` read** files a `class_booking` card (`un1t_trial_check_failed`) with the handoff text, per A's "do not grant, staff card" (Task 20).
7. **`MemberStudio`** adds `name` and `answerable` to the spec's shape (Task 1).

## File structure

New (slice 1): `src/lib/agent/member-studios.js` (resolver, pure core + one IO fn), `src/lib/agent/studio-ids.js` (`un1t:` id tagging), `src/lib/agent/tool-blocks.js` (derive un1t blocks), `src/lib/agent/un1t-member-read.js` (live reads through one budgeted client), `src/lib/agent/un1t-tools.js` (un1t read executors + shapers), `src/lib/agent/mia-copy.js` (copy table + `renderMiaCopy`), `src/lib/agent/un1t-fakes.test-helpers.js`.
New (slice 2): `src/lib/agent/un1t-booking.js`, `src/lib/agent/un1t-approval-branch.js`, `src/lib/agent/purchase-intents.js`, `src/lib/agent/purchase-tools.js` (tool definitions), `src/app/pay-done/[token]/page.js`, `src/app/api/locations/[id]/mia-offers/route.js`, `src/app/settings/customer-agent/MiaOffersSection.jsx`, `src/app/api/cron/mia-purchase-intents/route.js`, `src/app/api/contacts/[id]/mia-purchase-intents/route.js`, two migrations.
Modified: `auto-reply.js`, `tool-capability.js`, `booking-tools.js`, `account-tools.js`, `prompt.js`, `settings-contract.js`, `settings-overrides.js`, `default-copy.js`, `decision-log.js`, `approval-suggest.js`, `membership-requests/[id]/route.js`, `sources/un1t-online.js`, `un1t-online.js` (maybe `getOne`), `CustomerAgentClient.jsx`, `api/settings/customer-agent/route.js`, the four allowlists, `vercel.json`, `openapi.js`, and D's stubs in `src/lib/un1t-online-trial-used.js`.

---

# Slice 1: routing + reads

## PR 1 `MIAHATCH.1` — member studios, and `membership_at_other_studio` at Stillorgan

S1 with branch `feat/miahatch-1-member-studios`.

### Task 1: Member-studio resolver

**Files:**
- Create: `src/lib/agent/member-studios.js`, `src/lib/agent/member-studios.test.js`

**Interfaces:**
- Consumes: `linkedAccountsForContact(db, contactId)` → `{ anchorContactId, contacts, accounts, readFailed? }`, `hasBookableMembership(row)` (`src/lib/person-accounts.js`); `MEMBERSHIP_ACTIVE_STATUSES` (`src/lib/un1t-online-map.js`); `resolveAgentSettings(db, locationId, { orgCache })`; `resolveAgentGate`, `phoneMatchesAllowlist` (`core.js`).
- Produces:
  - `type MemberStudio = { locationId, name, providerKey: 'glofox'|'un1t_online'|'none', active: boolean, answerable: boolean, contactIds: string[], un1tUserId?: string, glofoxMemberId?: string }`
  - `isAgentOnForSender(settings, senderPhone): boolean` — `enabled`, or (`!enabled && test_mode` and the phone is in `test_phones`).
  - `glofoxStudioActive(contacts): boolean`, `un1tStudioActive({ subscriptions, client }): boolean`
  - `classifyMemberStudios({ contacts, un1tClients, un1tSubscriptions, locations, agentOnByLocation }): MemberStudio[]` (pure)
  - `answerableStudios(studios, threadLocationId): { answerable: MemberStudio[], basis: 'active'|'fallback'|'thread' }` (pure)
  - `otherStudioOnly(studios, threadLocationId): MemberStudio|null` (pure) — a un1t studio where the person is active but which is not answerable, while the thread studio is not active and nothing is answerable-active.
  - `resolveMemberStudios(db, { anchorContactId, threadLocationId, organizationId, senderPhone }): Promise<{ studios: MemberStudio[], readFailed: boolean }>`

- [ ] **Step 1: Write the failing tests** (`member-studios.test.js`, fictional ids, fake db)

```js
it('glofox active = bookable membership or trial credits', () => {
  expect(glofoxStudioActive([{ glofox_membership_status: 'member', glofox_membership_state: 'ACTIVE' }])).toBe(true) // per hasBookableMembership
  expect(glofoxStudioActive([{ trial_credits_remaining: 2 }])).toBe(true)
  expect(glofoxStudioActive([{ trial_credits_remaining: 0 }])).toBe(false)
})
it('un1t active = live subscription status, unlimited, or balance > 0', () => {
  for (const status of ['active', 'trialing', 'past_due']) expect(un1tStudioActive({ subscriptions: [{ status }] })).toBe(true)
  expect(un1tStudioActive({ subscriptions: [{ status: 'canceled' }], client: { credit_unlimited: true, credit_balance: 0 } })).toBe(true)
  expect(un1tStudioActive({ subscriptions: [], client: { credit_balance: 0 } })).toBe(false)
})
it('isAgentOnForSender: enabled; test_mode only for test_phones; enabled+test_mode is everyone', () => { /* 4 cases */ })
it('four cases (spec 6.1 table), each with Hatch on, off and test mode', () => { /* table-driven: answerable + basis per row */ })
it('fallback: nobody answerable-active -> the one answerable studio with an account, else the thread studio', () => {})
it('otherStudioOnly: Hatch-only member, Stillorgan thread, Hatch off -> Hatch; Hatch on -> null', () => {})
it('two un1t user ids at one studio: active one wins, then latest last_attended_at; logs multiple_un1t_users; contactIds not mixed', () => {}) // Review Focus 5
it('a failed group, un1t or settings read -> { studios: [], readFailed: true }, never a guessed studio', async () => {})
it('only locations of organizationId are considered', async () => {})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/agent/member-studios.test.js` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** in `src/lib/agent/member-studios.js`. IO reads: the group (`linkedAccountsForContact` on the anchor), `un1t_clients` and `un1t_subscriptions` by the group's `un1t_user_id`s (`.in`, location ids of `organizationId`), `locations (id, name, membership_source, organization_id)`, then `resolveAgentSettings` per candidate studio sharing one `orgCache`. Any `error` → `readFailed: true`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `git add src/lib/agent/member-studios*.js && git commit -m "MIAHATCH.1 — member-studio resolver (active + answerable per studio)"`

### Task 2: Wire the resolver into the turn; `membership_at_other_studio`

**Files:**
- Modify: `src/lib/agent/auto-reply.js` (turn start ~l.862, after verify success ~l.1032, executor dispatch ~l.987), `src/lib/agent/tool-capability.js`, `src/lib/agent/decision-log.js` (`compactDecisionMeta`)
- Test: `src/lib/agent/auto-reply-member-studios.test.js` (new), `src/lib/agent/decision-log.test.js`

**Interfaces:**
- Consumes: Task 1.
- Produces: `toolCtx.memberStudios: { studios, readFailed }` (WhatsApp turns only; Instagram leaves it undefined); `MEMBERSHIP_AT_OTHER_STUDIO_ERROR = 'membership_at_other_studio'`; `membershipAtOtherStudio(studioName): { error, studio, message }` in `tool-capability.js`; decision meta key `member_studios: [{ location_id, provider, active, answerable }]`.

- [ ] **Step 1: Write the failing tests** (fake `anthropicMessages` returns a `get_my_membership` tool_use, then text)

```js
it('Hatch-only member on a Stillorgan thread, Hatch off: account and booking tools answer membership_at_other_studio naming Hatch, no Glofox read', async () => {
  // spy on the glofox module: never imported/called
  expect(toolResult('get_my_membership')).toMatchObject({ error: 'membership_at_other_studio', studio: 'UN1T Hatch Street' })
})
it('Stillorgan-only member: tool block and system bytes identical to the fixtures; no membership_at_other_studio', async () => {})
it('readFailed: today\'s thread-studio behaviour exactly', async () => {})
it('re-resolves after a verify_identity success in the same turn', async () => {})
it('Instagram turn: resolver never called', async () => {})
it('decision meta carries member_studios (ids + flags only)', () => {})
```

- [ ] **Step 2: Run** `npx vitest run src/lib/agent/auto-reply-member-studios.test.js src/lib/agent/decision-log.test.js src/lib/agent/no-booking-studio.test.js` — Expected: new tests FAIL, existing PASS.
- [ ] **Step 3: Implement.** Resolve from `resolvedVerifiedContactId || conv.contact_id` at turn start and again after a verify success; before `refuseAtNoBookingStudio` in the dispatch, return `membershipAtOtherStudio(studio.name)` when `otherStudioOnly(...)` is non-null and the tool is in `BOOKING_SYSTEM_TOOL_NAMES`. Message: `"This person's membership is at {studio}, which you cannot answer for yet. Nothing was looked up. Say you can see they train at {studio} and hand off to the team."` Tool block unchanged in this PR.
- [ ] **Step 4: Run** the Step 2 command — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.1 — answer membership_at_other_studio instead of reading Stillorgan columns for a Hatch-only member`
- [ ] **Step 6:** S2-S6.

## PR 2 `MIAHATCH.2` — provider-aware read blocks and un1t reads

S1 with branch `feat/miahatch-2-un1t-reads`.

### Task 3: Tool blocks, block selection, `refuseToolForTurn`, tagged ids

**Files:**
- Create: `src/lib/agent/tool-blocks.js`, `src/lib/agent/studio-ids.js`, `src/lib/agent/tool-blocks.test.js`
- Modify: `src/lib/agent/tool-capability.js`, `src/lib/agent/auto-reply.js:114-141`, `src/lib/agent/no-booking-studio.test.js`, `src/lib/agent/tool-schemas.test.js`

**Interfaces:**
- Produces:
  - `UN1T_ID_PREFIX = 'un1t:'`, `tagUn1tId(un1tId): string`, `parseAgentId(raw): { provider: 'un1t_online', id } | { provider: 'glofox', id } | null` (anything not `un1t:`-prefixed passes through as glofox, so Glofox and `manual-…` ids behave as today).
  - `UN1T_WRITE_TOOL_NAMES = Set(['book_class','cancel_class_booking','request_refund'])`, `UN1T_PURCHASE_TOOL_NAMES = Set(['list_purchase_options','send_purchase_link','check_my_purchase'])`.
  - `selectToolBlock({ answerable, threadProvider, channel, un1tWrites }): 'glofox'|'no_booking'|'un1t_read'|'un1t_read_dual'|'un1t_full'` — rules: non-WhatsApp → today's (`glofox` if thread provider takes bookings else `no_booking`); no answerable → same; all answerable Glofox → `glofox`; a un1t studio answerable: `un1t_full` if `un1tWrites` (always false until Task 15), else `un1t_read_dual` if a Glofox studio is also answerable, else `un1t_read`.
  - `refuseToolForTurn(toolName, ctx): object|null` — `ctx.turn = { block, answerable, channel, un1tWrites }`; a tool outside `ctx.turn.block`'s names → `TOOL_NOT_AT_THIS_STUDIO`; a un1t write or purchase tool unless `block === 'un1t_full' && channel === 'whatsapp' && un1tWrites`; with `ctx.turn` absent, today's `canBook` rule (eval harness compat). Replaces `refuseAtNoBookingStudio` at its three call sites (`auto-reply.js:987`, `account-tools.js:637`, `booking-tools.js:666`).
  - `deriveUn1tReadTools(tools, { dual }): Tool[]` — 3a: same names as the Glofox block minus `book_class`/`cancel_class_booking` unless `dual`; provider-neutral descriptions from `UN1T_TOOL_DESCRIPTIONS` for `get_my_membership`, `get_my_next_class`, `list_my_upcoming_bookings`, `get_my_recent_attendance`, `list_upcoming_classes` (returns `event_id` and `full`, never "limited"); order kept; new objects only for re-described tools.
  - `withCacheBreakpoint(tools): Tool[]` (1h `cache_control` on the last tool only).
  - `auto-reply.js`: `CACHED_UN1T_READ_TOOLS`, `CACHED_UN1T_READ_DUAL_TOOLS` (built once at load); `agentToolsFor({ answerable, threadProvider, channel, un1tWrites })`, keeping `agentToolsFor(boolean)` for `evals/agent/runner.js`.

- [ ] **Step 1: Write the failing tests** (`tool-blocks.test.js`)

```js
it('cache stability: each block is built once; agentToolsFor returns the SAME array object across calls', () => {
  const a = agentToolsFor({ answerable: [hatch], threadProvider: un1t, channel: 'whatsapp', un1tWrites: false })
  expect(agentToolsFor({ answerable: [hatch], threadProvider: un1t, channel: 'whatsapp', un1tWrites: false })).toBe(a)
  expect(JSON.stringify(a)).toBe(JSON.stringify(CACHED_UN1T_READ_TOOLS))
})
it('exactly one cache_control (ttl 1h) per block, on its last tool; Glofox and no-booking blocks still equal the fixtures', () => {})
it('3a has no book_class/cancel_class_booking; 3a dual has both; neither has a purchase or refund tool', () => {})
it('3a list_upcoming_classes description never says limited or spaces; descriptions free of em/en dashes', () => {})
it('selectToolBlock: the decision table (WhatsApp/Instagram x answerable sets x un1tWrites)', () => {})
it('invented tools: send_purchase_link, check_my_purchase, list_purchase_options, request_refund refused in glofox, no_booking, un1t_read and un1t_read_dual, before any db call', () => {
  for (const block of ['glofox','no_booking','un1t_read','un1t_read_dual']) for (const name of [...UN1T_PURCHASE_TOOL_NAMES, 'request_refund'])
    expect(refuseToolForTurn(name, { db: throwingDb, turn: { block, answerable: [hatch], channel: 'whatsapp', un1tWrites: false } })).toMatchObject({ error: 'not_available_at_this_studio' })
})
it('book_class in un1t_read is refused; ctx without turn keeps the canBook rule', () => {})
it('parseAgentId: un1t:<id>, 24-hex, manual-x, empty', () => {})
```
Also in `tool-schemas.test.js`: `it('reports the optional-parameter budget for every block')` over each exported block (tripwire; must not grow beyond today's 29 in the Glofox block).

- [ ] **Step 2: Run** `npx vitest run src/lib/agent/tool-blocks.test.js src/lib/agent/no-booking-studio.test.js src/lib/agent/tool-schemas.test.js` — Expected: FAIL on new tests.
- [ ] **Step 3: Implement** in the files above.
- [ ] **Step 4: Run** the Step 2 command — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.2 — provider-aware read blocks, block selection and refuseToolForTurn`

### Task 4: Live member reads through one budgeted client (+ fakes)

**Files:**
- Create: `src/lib/agent/un1t-member-read.js`, `src/lib/agent/un1t-member-read.test.js`, `src/lib/agent/un1t-fakes.test-helpers.js`
- Modify (only if absent): `src/lib/un1t-online.js` (`getOne`), `src/lib/un1t-online.test.js`

**Interfaces:**
- Consumes: `readConnection(db, locationId, 'un1t_online')`, `createUn1tClient({ token, fetchImpl })`, `checkRateLimit(db, key, { max, windowMs })`.
- Produces:
  - `getOne(path)` on `createUn1tClient` (one non-paginated GET through the existing `get()`; D §6.1). **If `getOne` already exists on `origin/main`, skip it and its test.**
  - `class Un1tBudgetSpent extends Error`
  - `openUn1tMemberReader(db, locationId, { clientFactory } = {}): Promise<{ ok: true, studioId: string, getOne(path): Promise<object> } | { ok: false, reason: 'not_connected'|'read_failed' }>` — every `getOne` first takes one slot of `checkRateLimit(db, \`un1t-write:${locationId}\`, { max: 30, windowMs: 60_000 })` (D-7's key, so the budget is shared once D lands); a spent slot throws `Un1tBudgetSpent`.
  - `fetchLiveUn1tBookings(db, { locationId, un1tUserId }): Promise<{ ok: true, rows: object[] } | { ok: false, reason }>` (`GET /users/{id}/bookings`).
  - Test helpers: `fakeUn1tReader({ bookings, ledger, history, fail })`, `fakeUn1tWrite(overrides)` (returns a `vi.mock` factory for `@/lib/un1t-online-write`: `book`, `cancel`, `grantTrial`, `createCheckoutLink`, `executeUn1tApproval`, `fileRefundCard`, `Un1tWriteRefused`, `Un1tWriteUnknown`, each a `vi.fn` recording calls).

- [ ] **Step 1: Write the failing tests:** `takes one rate slot per request on key un1t-write:<loc>`; `spent slot throws Un1tBudgetSpent and sends nothing`; `inactive or tokenless connection -> not_connected`; `a 5xx after retries -> { ok: false, reason: 'read_failed' }`; `the token never appears in a thrown error or a log call` (spy `logWarn`/`logError`); `getOne` does one GET, no pagination.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/un1t-member-read.test.js src/lib/un1t-online.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; `un1t-online.test.js:280` verb pin unchanged.
- [ ] **Step 5: Commit** `MIAHATCH.2 — budgeted live un1t.online member reads`

### Task 5: un1t read executors

**Live values (read 17 Oct):** `un1t_bookings.status` ∈ {`booked`, `attended`, `cancelled`, `no_show`}; `un1t_products.status` = `'active'` on all 17 rows, `visibility` ∈ {`public`, `private`}, `type` ∈ {`one_time`, `recurring`}; "The UN1T Trial" is `one_time`, `public`, price 0. So `UN1T_BOOKED_STATUS = 'booked'` (this task) and `UN1T_PRODUCT_ACTIVE_STATUS = 'active'`, `UN1T_PRODUCT_PRIVATE_VISIBILITY = 'private'` (Task 14), exported from `un1t-tools.js`.

**[controller] re-check before the task starts (read-only `execute_sql` on `iyvtbjjxdggiadzwwvdj`):** `select status, count(*) from un1t_bookings group by 1;` and `select status, visibility, type, count(*) from un1t_products group by 1,2,3;`. Any value outside the sets above is reported to the implementer before Step 1, and the constants and tests change to match.

**Files:**
- Create: `src/lib/agent/un1t-tools.js`, `src/lib/agent/un1t-tools.test.js`
- Modify: `src/lib/agent/account-tools.js` (`executeAccountTool` provider switch), `src/lib/agent/booking-tools.js` (`executeBookingTool` provider switch for `list_my_upcoming_bookings`)

**Interfaces:**
- Consumes: Tasks 1, 3, 4; `src/lib/membership/sources/*` `capabilities.credits`.
- Produces:
  - `shapeUn1tMembership({ subscriptions, productsById, client, creditsCapable, zone }): { status: 'active'|'paused'|'ending'|'payment_issue'|'none', plan, price_label, renews_on, paused_until?, ends_on?, credits: number|'unlimited'|null }` — latest `current_period_end` among `MEMBERSHIP_ACTIVE_STATUSES`; `paused` when `paused_until` is future; `ending` when `cancel_at_period_end`; `payment_issue` when `past_due_at`; `credits` null unless `creditsCapable`.
  - `shapeUn1tBookingsForAgent(rows, eventsByUn1tId, nowMs, zone): [{ booking_id: 'un1t:<id>', class_name, starts_at }]` — future rows with `status === UN1T_BOOKED_STATUS` only, sorted, max 10.
  - `shapeUn1tAttendance(client, zone): { total_attended_30d, last_attended_on, total_attended_7d: null, note: 'no 7-day count at this studio; never state one' }` (no-shows omitted).
  - `executeUn1tRead(toolName, input, ctx, studios): Promise<object>` for `get_my_membership`, `get_my_next_class`, `list_my_upcoming_bookings`, `get_my_recent_attendance`; one studio → that studio's shape; two answerable studios → `{ studios: [{ studio: name, ...shape }] }` (the Glofox section from today's executor with `ctx.locationId` = the Glofox studio). Live bookings first; on any failure (incl. `Un1tBudgetSpent`) the mirror `un1t_bookings ⨝ un1t_events` with `may_be_stale: true`.
  - Dispatch rule in `executeAccountTool` / `executeBookingTool`: when `ctx.turn?.block` starts with `un1t_`, route the four reads to `executeUn1tRead`; otherwise unchanged.

- [ ] **Step 1: Write the failing tests:** `membership: active / paused until / ending on / payment issue / none`; `credits number, unlimited, and null when creditsCapable is false`; `bookings: future booked only, ids tagged un1t:, at most 10`; `live read fails -> mirror with may_be_stale: true`; `attendance says total_attended_7d null with the exact note, no no-show field`; `with memberships and bookings capabilities false the four reads still answer (E-1)`; `two studios -> one section each, named`; `a Glofox-only turn never imports un1t-tools` (spy).
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/un1t-tools.test.js src/lib/agent/account-tools.test.js src/lib/agent/booking-tools.test.js` — Expected: FAIL on new tests.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.2 — un1t.online sources for membership, next class, bookings, attendance`

### Task 6: un1t timetable with `event_id` and `full`

**Files:**
- Modify: `src/lib/agent/booking-tools.js:300-343`, `src/lib/agent/un1t-tools.js`
- Test: `src/lib/agent/un1t-tools.test.js`, `src/lib/agent/no-booking-studio.test.js`

**Interfaces:**
- Produces: `shapeUn1tTimetableForAgent(rows, zone): [{ event_id: 'un1t:<un1t_id>', name, starts_at, full: boolean }]` with `full = capacity > 0 && bookings_count >= capacity`. `listUn1tOnlineClasses` selects `un1t_id, title, starts_at, capacity, bookings_count` and uses this shaper only in a `un1t_*` block; the no-booking block keeps `shapeUn1tClassesForAgent` (`{ name, starts_at }`) unchanged. With two answerable studios the tool returns `{ studios: [{ studio, classes }] }`, and for a Hatch-only member on a Stillorgan thread it reads Hatch's `un1t_events`.

- [ ] **Step 1: Write the failing tests:** `payload keys are exactly event_id, name, starts_at, full` (`Object.keys` equality on every item; no `capacity`, `bookings_count`, `limited`); `full true at capacity, false below, false when capacity 0 or null`; `no-booking block payload unchanged`; `dispatched to the answerable un1t studio, not the thread studio`.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/un1t-tools.test.js src/lib/agent/no-booking-studio.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.2 — un1t timetable gives event ids and full, never capacity`

### Task 7: Prompt variants and the studio facts block (E-4)

**Files:**
- Modify: `src/lib/agent/prompt.js` (`renderCustomerAgentBasePrompt`, `buildCachedSystem`, `buildCustomerSystemPromptParts`)
- Test: `src/lib/agent/prompt.test.js`, `src/lib/agent/no-booking-studio.test.js`

**Interfaces:**
- Produces:
  - `renderCustomerAgentBasePrompt(source, { bookings, bookingUrl, un1tVariant = null, multiStudio = false })` — `un1tVariant: 'read'|'full'|null`; `'read'`: booking rules without "limited", "you cannot book from chat at {studio}; share the booking link or hand off", account answers from tools only; `multiStudio`: "say which studio each answer is for". `null` returns today's bytes.
  - `buildStudioFactsBlock({ studioName, address, bookingUrl, membershipUrl, offers = [], knowledge = [] }): string`, appended in the **uncached suffix**, ending with the rule line exactly: `Prices and the timetable for {studio} come only from your tools and this block, never from the studio knowledge above.`
  - `buildCachedSystem(opts)` accepts `un1tVariant`, `multiStudio`, `factsBlocks: string[]`.

- [ ] **Step 1: Write the failing tests:** `Glofox and no-booking renders equal the fixtures byte for byte`; `read variant never says limited, spaces or capacity`; `read variant names no tool absent from un1t_read`; `facts block in the uncached suffix only (cache_control placement unchanged)`; `facts block carries name, address, links and the exact rule line`; `every added line free of em/en dashes`; `stable prefix byte-identical across two turns at the same studio and variant`.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/prompt.test.js src/lib/agent/no-booking-studio.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.2 — un1t prompt variants and the other-studio facts block`

### Task 8: Turn wiring, Glofox studio override, slice-1 booking answer, cancellation guard

**Files:**
- Create: `src/lib/agent/mia-copy.js`, `src/lib/agent/mia-copy.test.js`, `src/lib/agent/auto-reply-hatch-reads.test.js`
- Modify: `src/lib/agent/auto-reply.js`, `src/lib/agent/booking-tools.js`, `src/lib/agent/settings-contract.js`, `src/lib/agent/settings-overrides.js` (`INHERITABLE_SCALAR_KEYS`), `src/lib/agent/default-copy.js`, `src/lib/agent/decision-log.js`, `src/app/api/agent/membership-requests/[id]/route.js` (~l.708 `cancellation` branch)
- Test: `src/lib/agent/settings-contract.test.js`, `src/app/api/agent/membership-requests/[id]/route.cancellation.test.js`

**Interfaces:**
- Consumes: Tasks 1-7.
- Produces:
  - `MIA_HATCH_COPY: { [key]: { text: string, without?: { var: string, text: string } } }` and `renderMiaCopy(key, settings, vars): string` — operator value else `text`; when `without.var` is empty in `vars`, the operator value only if it lacks `{var}`, else `without.text`; em/en dashes scrubbed.
  - Copy key `chat_booking_unavailable_text`: text `I can't book classes at {studio} from here just yet. You can book here: {link}`; without `link`: `I can't book classes at {studio} from here just yet. The team will help you book.`
  - `toolCtx.turn = { block, answerable, channel, un1tWrites: false }`, `toolCtx.glofoxLocationId` (the answerable Glofox studio when the thread studio is not Glofox; else `locationId`), `toolCtx.actionStudio(locationId)` (that studio's resolved settings for `booking_mode`, `booking_url`, copy; voice, quiet hours and caps stay the thread's).
  - `book_class` / `cancel_class_booking` with a `un1t:` id (block `un1t_read_dual`) → `{ booked: false, chat_booking_unavailable: true, text: renderMiaCopy('chat_booking_unavailable_text', actionSettings, { studio, link: booking_url }) }`; a tagged id whose studio is not answerable → `not_available_at_this_studio`.
  - Decision meta `tool_block`.
  - `request_pause` / `request_cancellation` in a `un1t_*` block file their `agent_membership_requests` row at the answerable un1t studio's `location_id` (the member's studio), not the thread's.
  - The approval route's `cancellation` execution never runs the Glofox cancel for a row whose `location_id` studio has `membership_source = 'un1t_online'` (row lands `failed` with `message_code: 'NOT_EXECUTABLE_UN1T'`, staff cancel in un1t.online).

- [ ] **Step 1: Write the failing tests** (`auto-reply-hatch-reads.test.js`, fake `anthropicMessages` scripted tool_use sequences):

```js
it('with bookings:true on un1t.online, a Hatch turn never reaches a Glofox executor (anti-goal 3)', async () => { /* stub sources/un1t-online capabilities.bookings = true; glofox module spy never called */ })
it('Hatch thread, Hatch in test mode, MIA TEST phone: un1t_read block, reads answered from un1t', async () => {})
it('Hatch test mode, any other phone: no reply (gate) and no Hatch data', async () => {})
it('Hatch-only member on Stillorgan thread, Hatch on: un1t_read block, Hatch timetable, facts block, rule line', async () => {})
it('Stillorgan member on a Hatch-filed thread: Glofox executors get Stillorgan\'s locationId', async () => {})
it('dual member: un1t_read_dual; book_class with un1t: id answers chat_booking_unavailable_text with the link; without link the no-link line', async () => {})
it('tagged id from a non-answerable studio refused', async () => {})
it('verify mid-turn changes the block on the next iteration', async () => {})
it('request_cancellation for a Hatch member on a Stillorgan thread is filed at Hatch', async () => {})
```
Plus: `mia-copy.test.js` (`renderMiaCopy` both branches; every default free of U+2014/U+2013); `settings-contract.test.js` (`chat_booking_unavailable_text` round-trips through `buildCustomerAgentSettings`, inherits from org); `route.cancellation.test.js` (`un1t.online studio row never calls the Glofox cancel`).
- [ ] **Step 2: Run** `npx vitest run src/lib/agent 'src/app/api/agent/membership-requests/[id]'` — Expected: new tests FAIL.
- [ ] **Step 3: Implement.** `toolCtx.canBook` and `membershipSourceKey` stay set for older readers.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.2 — dispatch Mia's turn by member studio; chat-booking-unavailable copy`

### Task 9: Flip `credits` for un1t.online

**Files:**
- Modify: `src/lib/membership/sources/un1t-online.js:16`, `src/lib/membership/sources/un1t-online.test.js`
- Create: `tests/capability-credits-readers.test.js`

- [ ] **Step 1: Write the failing tests:** `un1t.online capabilities are { memberships: false, bookings: false, credits: true, invoices: false, schedule: false }`; `capability-credits-readers.test.js`: scans non-test `src/`, `shared/` for `capabilities.credits` / `capabilities?.credits` and asserts the reader set equals exactly `['src/lib/agent/un1t-tools.js']`.
- [ ] **Step 2: Run** `npx vitest run src/lib/membership/sources tests/capability-credits-readers.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** the flip.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.2 — un1t.online declares credits`
- [ ] **Step 6:** S2-S6.

## PR 3 `MIAHATCH.3` — `get_my_payment_reminder` from A's `pastDue` (waits for A's PR 2)

S1 with branch `feat/miahatch-3-payment-reminder`.

### Task 10: un1t payment reminder

**Files:**
- Modify: `src/lib/agent/un1t-tools.js`, `src/lib/agent/tool-blocks.js` (add `get_my_payment_reminder` to 3a with a neutral description)
- Test: `src/lib/agent/un1t-tools.test.js`, `src/lib/agent/tool-blocks.test.js`

**Interfaces:**
- Consumes: A's `pastDue(db, locationId, { contactIds })` via `membershipReadsFor` + `supportsRead(r, 'pastDue')`.
- Produces: `executeUn1tRead('get_my_payment_reminder', …)` → `{ has_reminder: false, still_overdue: true|false|'unknown', since?, amount_label? }`; `'unknown'` when `capabilities.invoices` is false, the seam is unsupported, or the read fails; never a pay link.

- [ ] **Step 1: Write the failing tests:** `invoices false -> still_overdue unknown, pastDue not called`; `pastDue row -> still_overdue true with since and amount (null amount -> no amount_label)`; `empty -> false`; `failed read -> unknown`; `contactIds is the person group`; `never a Glofox call at a un1t studio`.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/un1t-tools.test.js src/lib/agent/tool-blocks.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.3 — payment reminder at Hatch from the un1t seam`
- [ ] **Step 6:** S2-S6.

### Task 11: Slice 1 rollout [controller + Richard]

- [ ] **Step 1** [controller] After PR 2 deploys: decision log at Stillorgan over 24h shows `tool_block = 'glofox'` and the fixture hash for every Stillorgan-only turn; replay 10 recent Stillorgan turns through the eval harness: same replies.
- [ ] **Step 2** [Richard, or controller on his word] At Hatch's **studio layer**: `followups.enabled = false`, `first_class_checkin.enabled = false` as explicit overrides, and `booking_url` set. Verify by reading `resolveAgentSettings` output (sources show `studio` for both).
- [ ] **Step 3** [controller] Hatch: `enabled = false`, `test_mode = true`, `test_phones = [MIA TEST phone]` (never enabled + test_mode).
- [ ] **Step 4** [controller + Richard] MIA TEST asks: membership, credits, next class, upcoming bookings, attendance (no 7-day number), timetable (no numbers, full only), "book me in" (link or handoff, never "booked"). Repeat once from a Stillorgan-filed thread for a Hatch-only contact (Hatch facts, no Stillorgan prices). Expected: every answer matches un1t.online; decision log `tool_block = 'un1t_read'`.
- [ ] **Step 5** Richard decides whether to set Hatch `enabled = true` (replies only) now or after slice 2.

---

# Slice 2: writes + upsell (after D)

## PR 4 `MIAHATCH.4` — tables, copy, offer list settings

S1 with branch `feat/miahatch-4-offers-and-tables`.

### Task 12: Migration: `mia_purchase_intents`, `mia_purchase_offers`

The `refund_request` kind is D's migration, not this one.

**Files:**
- Create: `supabase/migrations/NNN_mia_purchase_intents_offers.sql`, `tests/migration-NNN-mia-purchase-intents-offers.test.js`

**Interfaces:**
- Produces:
  - (a) `public.mia_purchase_intents`: columns exactly as spec 6.5.1 (`id uuid pk default gen_random_uuid()`, `location_id uuid not null references locations`, `organization_id uuid not null`, `contact_id uuid references contacts on delete set null`, `conversation_id uuid`, `channel text not null`, `un1t_user_id text not null`, `un1t_product_id text not null`, `product_title text`, `price_cents int`, `event_un1t_id text`, `class_name text`, `class_time text`, `starts_at timestamptz`, `checkout_url text`, `success_token_hash text unique`, `status text not null check in ('link_sent','paid','booked','book_failed','no_class','expired','refused')`, `un1t_write_id uuid` (no FK: D's ledger), `entitlement_snapshot jsonb`, `outcome jsonb`, `created_at timestamptz default now()`, `expires_at timestamptz not null`, `paid_detected_at timestamptz`, `detected_by text`, `updated_at timestamptz default now()`); partial unique index `mia_purchase_intents_one_live (location_id, un1t_user_id) where status = 'link_sent'`; index `(status, expires_at)`.
  - (b) `public.mia_purchase_offers (id uuid pk, location_id uuid not null references locations on delete cascade, un1t_product_row_id uuid not null references un1t_products(id) on delete cascade, sort_order int not null, blurb text check (char_length(blurb) <= 140), created_by uuid, created_at, updated_at, unique (location_id, un1t_product_row_id))`.
  - Grants on (a) and (b) per Global Constraints; a closing `DO` block self-checks the index and both `relrowsecurity` against the catalog.

- [ ] **Step 1: Write the failing test** (PGlite, mig 711 test pattern): `both tables exist with RLS on and no policy`; `anon/authenticated hold nothing; service_role has the four`; `second link_sent row for the same (location, user) fails 23505; a link_sent beside an expired one is fine`; `status check refuses 'pending'`; `blurb of 141 chars refused`; `file does not touch agent_membership_requests_kind_check` (text assertion); `file re-applies cleanly`.
- [ ] **Step 2: Run** `npx vitest run tests/migration-NNN-mia-purchase-intents-offers.test.js tests/table-default-acl-guard.test.js` — Expected: FAIL.
- [ ] **Step 3: Write the migration.**
- [ ] **Step 4: Run** — Expected: PASS; `npm run check:select-columns` exits 0.
- [ ] **Step 5: Commit** `MIAHATCH.4 — mig NNN: mia_purchase_intents, mia_purchase_offers`
- [ ] **Step 6** [controller] `apply_migration` on `iyvtbjjxdggiadzwwvdj`, then `get_advisors` type `security`: no new finding for these tables. Before PR 4 merges.

### Task 13: Slice-2 customer copy keys

**Files:**
- Modify: `src/lib/agent/mia-copy.js`, `src/lib/agent/settings-contract.js`, `src/lib/agent/settings-overrides.js`, `src/lib/agent/default-copy.js`, `src/app/settings/customer-agent/CustomerAgentClient.jsx` (a "Hatch payments and booking" copy group shown at a un1t.online studio)
- Test: `src/lib/agent/mia-copy.test.js`, `src/lib/agent/settings-contract.test.js`, `src/app/settings/customer-agent/CustomerAgentClient.test.jsx`

**Interfaces:**
- Produces: keys and defaults, exact (spec 6.6):
  - `purchase_offer_intro_text`: `You've used all your classes. Here's how to keep training with us:`
  - `purchase_link_text`: `Here's your secure payment link for {product}. Once it goes through I'll book you into {class}.`; without `class`: `Here's your secure payment link for {product}. I'll let you know when it's done.`
  - `trial_used_text`: `It looks like you've had your free trial with us before, so here are the ways to keep training:`
  - `refund_request_text`: `I've passed that to the team, they'll look at it and get back to you.`
  - `purchase_link_open_text`: `You already have a payment link waiting for {product}. Use that one, or I can ask the team if you'd like something different.`
  - `purchase_paid_booked_text`: `Payment received, thank you! You're booked into {class}. See you there.`
  - `purchase_paid_class_gone_text`: `Payment received, thank you! {class} is no longer available, so I haven't booked it. Reply here and I'll find you another class.`
  - `purchase_paid_booking_failed_text`: `Payment received, thank you! I couldn't book {class} just now, so the team will sort it and confirm with you shortly.`
  - `purchase_paid_no_class_text`: `Payment received, thank you! It's on your account now. Would you like me to book you a class?`
  - `pay_done_page_text`: `Thanks! You can go back to WhatsApp now.`; `pay_cancel_page_text`: `No problem, nothing was charged. You can go back to WhatsApp.`

- [ ] **Step 1: Write the failing tests:** `every key round-trips through buildCustomerAgentSettings`; `each is inheritable from the org layer`; `defaults exactly as listed`; `no default contains U+2014 or U+2013`; `renderMiaCopy without class picks the no-class default`; client shows the group only when `membership_source_key === 'un1t_online'`.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/mia-copy.test.js src/lib/agent/settings-contract.test.js src/app/settings/customer-agent` — Expected: FAIL.
- [ ] **Step 3: Implement.** The settings GET (`src/app/api/settings/customer-agent/route.js`) adds `membership_source_key`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.4 — operator-editable copy for Hatch booking and payments`

### Task 14: Offer list API and "What Mia can sell"

**Files:**
- Create: `src/app/api/locations/[id]/mia-offers/route.js`, `…/route.test.js`, `src/app/settings/customer-agent/MiaOffersSection.jsx`, `MiaOffersSection.test.jsx`
- Modify: `src/lib/openapi.js`, `src/lib/schemas.js` (`miaOffersPutSchema`), `src/app/settings/customer-agent/CustomerAgentClient.jsx` (mount the section; keep the booking link fields visible at a un1t.online studio even when `bookings` is true)

**Interfaces:**
- Consumes: `canEditMiaSettings(user, locationId)`, `assertLocationAccess`, `UN1T_PRODUCT_ACTIVE_STATUS = 'active'`, `UN1T_PRODUCT_PRIVATE_VISIBILITY = 'private'` (Task 5; `private: visibility === 'private'`).
- Produces:
  - `GET /api/locations/[id]/mia-offers` (studio member) → `{ success, data: { offers: [{ id, un1t_product_row_id, title, price_cents, interval, visibility, private: boolean, blurb, sort_order, inactive: boolean }], products: [{ id, title, price_cents, interval, private }] } }` (`products` = active, price > 0, at the studio).
  - `PUT` (`canEditMiaSettings`) body `{ offers: [{ un1t_product_row_id: uuidLike, blurb: string ≤ 140 }] }`, order = array order; replaces the studio's rows; 400 `{ error: 'product_not_sellable', product_id }` for a product not at the studio, not active, or `price_cents <= 0`; 404 on a foreign location; 400 at a non-un1t studio.
  - `MiaOffersSection`: picker (Private chip `bg-amber-500/10 text-amber-700`), `@dnd-kit/sortable` order, blurb field with counter, inactive offers flagged, "Suggested starter" pre-fills `1 Class Credit`, `5 Class Pack`, `10 Class Pack`, `The Monthly Foundation Membership` (exact-title matches at the studio) for staff to save.

- [ ] **Step 1: Write the failing tests:** route: `GET 404 for a foreign location`; `PUT 403 for a manager who is not owner (canEditMiaSettings)`; `PUT saves order and blurbs`; `€0 product refused`; `inactive product refused`; `product of another studio refused`; `private product allowed and flagged`; `GET marks an offer inactive after the product goes inactive`; component: `starter button pre-fills the four titles that exist`; `no em-dash in any label`.
- [ ] **Step 2: Run** `npx vitest run 'src/app/api/locations/[id]/mia-offers' src/app/settings/customer-agent` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; `npm run check:route-guards && npm run check:location-scoping` exit 0.
- [ ] **Step 5: Commit** `MIAHATCH.4 — offer list settings for what Mia can sell`
- [ ] **Step 6:** S2-S6.

## PR 5 `MIAHATCH.5` — book, cancel, refund request at Hatch (waits for D deployed)

S1 with branch `feat/miahatch-5-book-cancel`.

### Task 15: Block 3b and its selection

**Files:**
- Modify: `src/lib/agent/tool-blocks.js`, `src/lib/agent/tool-capability.js`, `src/lib/agent/auto-reply.js`, `src/lib/agent/prompt.js` (`un1tVariant: 'full'`: Mia can book and cancel at {studio}; "booked"/"cancelled" only when the tool result says so; never promise a refund; refunds go through `request_refund`)
- Test: `src/lib/agent/tool-blocks.test.js`, `src/lib/agent/prompt.test.js`

**Interfaces:**
- Produces: `deriveUn1tFullTools(tools, { extraTools }): Tool[]` (3a dual + `request_refund`; Task 19 adds the purchase tools through `extraTools`); `CACHED_UN1T_FULL_TOOLS`; `request_refund` definition `{ name: 'request_refund', input_schema: { reason: string (required), booking_id?: string } }`; `toolCtx.turn.un1tWrites = answerable un1t studio's settings.un1t_online.writes_enabled === true && channel === 'whatsapp'`.

- [ ] **Step 1: Write the failing tests:** `un1t_full only on WhatsApp with writes_enabled`; `writes off -> un1t_read(_dual)`; `Instagram -> today's block even with writes on (R3)`; `invented-tool test: request_refund and book_class refused in un1t_read, allowed in un1t_full`; `un1t_full built once, one 1h breakpoint`; optional-parameter tripwire per block.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/tool-blocks.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.5 — the un1t full tool block, WhatsApp and writes_enabled only`

### Task 16: `book_class` at Hatch

**Files:**
- Create: `src/lib/agent/un1t-booking.js`, `src/lib/agent/un1t-booking.test.js`
- Modify: `src/lib/agent/booking-tools.js` (dispatch), `src/lib/agent/un1t-member-read.js` (`fetchLiveEntitlement`), `src/lib/agent/auto-reply.js` (`needs_purchase` handling; `no_credits` handoff kept for "no offers configured")

**Interfaces:**
- Consumes: D's `book`; Task 4 reader; `logBookingRequest` / `finalizeBookingRequest` pattern (`booking-tools.js:501-550`).
- Produces:
  - `fetchLiveEntitlement(db, { locationId, un1tUserId }): Promise<{ ok: true, balance, unlimited, liveSubscriptionIds } | { ok: false }>` (`GET /credits/ledgers/{userId}/{studioId}`).
  - `relayedStartMatches(eventStartsAtIso, relayed, zone): boolean` — compares `formatClassTime` labels in the studio's zone.
  - `un1tBookOutcome(result: Un1tWriteResult): 'booked'|'class_full'|'no_credits'|'card_rejected'|'card_unknown'|'writes_off'|'retry'` (pure) — `done` (incl. `alreadyBooked`, `recovered`) → `booked`; `refused` → `classifyRefusal({ code, message })`: `class_full` → `class_full`, `no_credits` → `no_credits`, `already_booked` → `booked`; `UN1T_WRITES_OFF`/`UN1T_PERMISSION_MISSING` → `writes_off`; `retryable` (`UN1T_RATE_BUDGET`, `UN1T_ATTEMPT_IN_FLIGHT`, rate limited) → `retry` (Mia says to try again shortly; no card); any other refusal → `card_rejected`; `unknown` → `card_unknown`. A class cancelled or started is caught by the pre-flight (event `scheduled`, `starts_at` future) before `book`.
  - `un1tBookClass(ctx, input, studio): Promise<object>` returning one of `{ booked: true, class_name, class_time }`, `{ booked: true, already_booked: true }`, `{ booked: false, needs_purchase: true, offers, trial_available, wording: renderMiaCopy('purchase_offer_intro_text', …) }` (`offers` from Task 19's `listPurchaseOptions`; in PR 5, before Task 19 exists, `needs_purchase` never fires and the no-offers path below applies), `{ booked: false, error: 'class_unavailable', reason }`, `{ booked: false, not_linked: true, booking_url }`, `{ pending_approval: true }`, `{ booked: false, handoff: true, reason: 'booking_rejected'|'un1t_outcome_unknown'|'writes_off' }`.
  - Write-ahead row: `agent_membership_requests` kind `class_booking`, `details = { provider: 'un1t_online', origin: 'mia', reason: 'mia_booking', event_id /* bare uuid */, un1t_user_id, executing_contact_id, starts_at, class_name, stage: 'executing' }` (D's `executeUn1tApproval` row keys), then `book(db, { locationId, contactId, un1tUserId, eventId, origin: 'mia', originRef: row.id, actor: null })`; store `result.ledgerId` as `details.un1t_write_id`.

- [ ] **Step 1: Write the failing tests** (`fakeUn1tWrite`, `fakeUn1tReader`):

```js
it('done -> actioned + booked; alreadyBooked and recovered also booked', async () => {})
it('already in live bookings -> booked, no book() call', async () => {})
it('credit_unlimited true and balance 0 -> books, no upsell', async () => {}) // Review Focus 2
it('ledger unreadable but live subscription in mirror -> books; ledger unreadable and nothing -> proceeds, un1t.online arbitrates', async () => {})
it('confirmed nothing + offers -> needs_purchase with offers; no offers -> no_credits card + deterministic handoff', async () => {})
it('refused class_full (classifyRefusal) -> failed, relayed, offer the next slot; event cancelled or started -> refused by pre-flight, no book()', async () => {})
it('retryable refusal (UN1T_RATE_BUDGET, UN1T_ATTEMPT_IN_FLIGHT) -> try again shortly, no card', async () => {})
it('refused no_credits (classifyRefusal) after pre-flight -> needs_purchase', async () => {})
it('refused unmapped -> card booking_rejected quoting un1t.online words + booking_issue_handoff_text', async () => {})
it('unknown -> card un1t_outcome_unknown + handoff text; result never booked: true', async () => {})
it('UN1T_WRITES_OFF / UN1T_PERMISSION_MISSING -> chat_booking_unavailable_text, no card', async () => {})
it('draft booking_mode at the action studio -> pending class_booking card, no book()', async () => {})
it('passes a bare eventId (prefix stripped), origin mia and originRef = request id; never bypassCredit', async () => {})
it('relayed starts_at mismatch refused, incl. a label across the Oct DST change and a Stillorgan label on a Hatch id', async () => {}) // Review Focus 4
it('no un1t_user_id -> not_linked with booking_url', async () => {})
```
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/un1t-booking.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.5 — book Hatch classes from chat through D's book`

### Task 17: `cancel_class_booking` and `request_refund` at Hatch

**Files:**
- Modify: `src/lib/agent/un1t-booking.js`, `src/lib/agent/booking-tools.js`
- Test: `src/lib/agent/un1t-booking.test.js`

**Interfaces:**
- Consumes: D's `cancel`, D's `fileRefundCard` (D owns the `refund_request` kind and its labels).
- Produces: `un1tCancelBooking(ctx, input, studio)` → `{ cancelled: true, class_name, class_time }`, `{ cancelled: false, error: 'CANCELLATION_UNCERTAIN' }`, `{ cancelled: false, refused: 'late_cancel'|'already_happened', message }`, `{ pending_approval: true }`, `{ cancelled: false, handoff: true }`; write-ahead `class_cancellation` row (`details = { provider 'un1t_online', origin 'mia', reason: 'mia_cancellation', booking_id /* bare */, un1t_user_id, executing_contact_id, starts_at, class_name }`), then `cancel(db, { locationId, contactId, un1tUserId, bookingId, origin: 'mia', originRef: row.id, actor: null })`; `classifyRefusal` → `late_cancel`, and `code 'already_happened'` → `already_happened`. `requestRefund(ctx, input, studio)` → `fileRefundCard(db, { locationId, contactId, un1tUserId, reason: 'member_request', bookingId, origin: 'mia', originRef: <conversation_id>, conversationId, channel: 'whatsapp' })`; `approvalId` null → still answer `refund_request_text` (logged), never a louder failure; returns `{ filed: approvalId !== null, text: renderMiaCopy('refund_request_text', …) }`.

- [ ] **Step 1: Write the failing tests:** `booking id not in live bookings -> CANCELLATION_UNCERTAIN, no cancel()`; `done -> cancelled`; `late-cancel refusal relayed, never promises a credit`; `already happened relayed`; `unknown -> card + handoff text`; `draft -> card`; `cancel body never carries forceRefund`; `refund request files one card, no un1t call, returns refund_request_text`.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/un1t-booking.test.js` — Expected: FAIL on new tests.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.5 — cancel Hatch bookings and file refund requests from chat`

### Task 18: Approval branches, approval-suggest, refund card label

**Files:**
- Create: `src/lib/agent/un1t-approval-branch.js`, `src/lib/agent/un1t-approval-branch.test.js`
- Modify: `src/app/api/agent/membership-requests/[id]/route.js` (`class_booking` ~l.539, `class_cancellation` ~l.367), `src/lib/agent/approval-suggest.js:218`, nothing else: D ships the `refund_request` kind, its web and `shared/` labels and its record-only approve
- Test: `src/app/api/agent/membership-requests/[id]/route.test.js`, `src/lib/agent/approval-suggest.test.js`

**Interfaces:**
- Consumes: D's `executeUn1tApproval`; route's `expiredBeforeExecution`.
- Produces: `executeMiaUn1tCard(db, { row, details, actor, expiredBeforeExecution }): Promise<{ finalStatus, details, executed }>` — runs only for `details.provider === 'un1t_online' && details.origin === 'mia'`, inside D's existing `class_booking` un1t branch and a new `class_cancellation` un1t branch (E's; excluded from the Glofox cancel branch); funnel cards keep D's path unchanged: ACCOUNT_MISMATCH when `details.un1t_user_id` differs from the executing contact's current `un1t_user_id` (→ `failed`, Fix & retry lane); past-start → expired as today; else `executeUn1tApproval`; on success the in-thread confirmation via `sendAgentThreadMessage` (`buildBookingConfirmationText` / `buildCancellationConfirmationText`). `approval-suggest` reads un1t membership and next class (`shapeUn1tMembership`, `shapeUn1tBookingsForAgent`) for a `provider 'un1t_online'` card instead of `glofox_membership_state` / `recent_bookings`. (`refund_request` approval is D's record-only branch.)

- [ ] **Step 1: Write the failing tests:** `Mia un1t card goes to executeUn1tApproval, never the Glofox executor`; `ACCOUNT_MISMATCH refuses and lands failed`; `past start -> expired, no call`; `confirmation sent in-thread once`; `window_closed recorded on the card`; `approval-suggest uses un1t context for un1t cards, Glofox fields for Glofox cards`.
- [ ] **Step 2: Run** `npx vitest run 'src/app/api/agent/membership-requests/[id]' src/lib/agent/un1t-approval-branch.test.js src/lib/agent/approval-suggest.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.5 — Mia's Hatch cards execute through D's executor`
- [ ] **Step 6:** S2-S6. After deploy, tell the D owner the `bookings` flip is unblocked.

## PR 6 `MIAHATCH.6` — upsell, payment link, book after payment (waits for PR 5, D, A)

S1 with branch `feat/miahatch-6-upsell`.

### Task 19: Purchase tools, intents, payment link

**Files:**
- Create: `src/lib/agent/purchase-tools.js`, `src/lib/agent/purchase-intents.js`, `src/lib/agent/purchase-intents.test.js`
- Modify: `src/lib/agent/tool-blocks.js` (3b gains the three purchase tools), `src/lib/agent/auto-reply.js` (dispatch), `src/lib/agent/prompt.js` (3b upsell rules: restate product and price, clear yes before `send_purchase_link`; buttons when 3 or fewer offers, a list otherwise, never more than the configured list; and `buildStudioFactsBlock` now receives the studio's offer titles and price labels), `src/lib/agent/decision-log.js` (`intent_id`)

**Interfaces:**
- Consumes: D's `createCheckoutLink`, `Un1tWriteRefused`, `Un1tWriteUnknown`; `resolveCustomerBaseUrl(db, locationId)` (D requires https customer hosts); Task 16's `fetchLiveEntitlement`.
- Produces:
  - Tools: `list_purchase_options()`, `send_purchase_link({ offer_id, event_id?, class_name?, class_time?, starts_at? })`, `check_my_purchase()`.
  - `formatPriceLabel({ priceCents, interval, currency = 'EUR' }): string` (`'€125'`, `'€189 a month'`).
  - `listPurchaseOptions(db, locationId): Promise<{ offers: [{ offer_id, title, price_label, credits, blurb }], skipped: number }>` (inactive products skipped, order by `sort_order`).
  - `mintPayDoneToken(): { token, hash }` (32 random bytes, base64url; `hash` = sha256 hex), `hashPayDoneToken(token): string`.
  - `sendPurchaseLink(ctx, input, studio)`: live intent same product → `createCheckoutLink` again with `idempotencyKey = intent.id`, resend; different product → `{ link_sent: false, text: purchase_link_open_text }`; none → insert intent (`expires_at = created_at + 23h`, `entitlement_snapshot` from `fetchLiveEntitlement`), then `createCheckoutLink(db, { locationId, userId: intent.un1t_user_id, productId, successUrl: <base>/pay-done/<token>, cancelUrl: <base>/pay-done/<token>?c=1, idempotencyKey: intent.id, origin: 'mia', originRef: intent.id })`; done → store `checkout_url`, return `{ link_sent: true, url, wording: renderMiaCopy('purchase_link_text', …) }`; `free: true` → `settlePurchaseIntent` now; `Un1tWriteRefused`/`Un1tWriteUnknown` → status `refused`, `booking_issue_handoff_text`. `offer_id: 'trial'` is reserved for Task 20.

- [ ] **Step 1: Write the failing tests:** `offers ordered, private allowed, inactive skipped`; `price labels`; `createCheckoutLink called with userId (un1t user id), not a contact id, and idempotencyKey = intent id`; `same product resends with the same key`; `different product -> purchase_link_open_text, no second call`; `concurrent insert 23505 -> treated as live intent, no tool error` (**Review Focus 1**: fake db raises 23505 on the second insert); `refusal -> intent refused + handoff text`; `free true -> settled at once`; `URLs on resolveCustomerBaseUrl host, https`; `checkout URL never in a log call`; `purchase tools refused outside un1t_full (invented-tool test)`.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/purchase-intents.test.js src/lib/agent/tool-blocks.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.6 — purchase options and one live payment link per member`

### Task 20: Trial first, only if eligible (R1)

**Files:**
- Modify: `src/lib/agent/purchase-intents.js`, `src/lib/agent/un1t-booking.js` (`trial_available` on `needs_purchase`)
- Test: `src/lib/agent/purchase-intents.test.js`

**Interfaces:**
- Consumes: A's `trialEligibility`; D's `grantTrial`; `settings.un1t_online.trial_product_id`.
- Produces: `trialAvailable(db, { locationId, un1tUserId, contactId }): Promise<{ available: boolean, reasons: string[], readFailed?: boolean }>` — `available = success && data.eligible === true`; `reasons = data.reasons` (false and empty when no `trial_product_id`); `send_purchase_link({ offer_id: 'trial', … })` → `grantTrial(db, { locationId, un1tUserId, contactId, origin: 'mia', originRef, actor: null })` where `originRef` is the `class_booking` write-ahead row id (written first, `details.stage 'trial'`) when a class is named, else `mia-trial:<conversation_id>`: `granted` → `un1tBookClass` execute step; `ineligible` → `{ trial_used: true, text: trial_used_text, offers }`; `needs_staff` → E files its own `class_booking` card (`details.provider 'un1t_online'`, `origin 'mia'`, `reason = needs_staff.reason`, e.g. `un1t_trial_failed:<code>`, which is where a trial-used refusal lands until D's PR 6) + `booking_issue_handoff_text`; `retry` → no card, Mia says to try again shortly and offers the team (`booking_issue_handoff_text` on a second `retry` in the same turn). An eligibility read failure before the offer → no trial offered, `class_booking` card `reason 'un1t_trial_check_failed'` + handoff text.

- [ ] **Step 1: Write the failing tests:** `trialEligibility called before the trial is offered, with { un1tUserId, contactId }`; `each not-eligible reason (trial_used, membership_history, paid_pack), and reasons holding two at once -> trial_used_text + offers, grantTrial never called`; `success true but data.eligible missing -> not available` (fail closed); `grantTrial ineligible -> same`; `granted -> booked`; `needs_staff -> E files exactly one card with needs_staff.reason, handoff text, never says booked`; `needs_staff un1t_trial_failed:<code> (unmapped trial refusal) -> card, never trial_used_text`; `retry -> no card, try-again wording`; `the trial never goes through createCheckoutLink`; `failed eligibility read -> card + handoff, no grant`; `no trial_product_id -> offers only`.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/purchase-intents.test.js` — Expected: FAIL on new tests.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.6 — offer the trial only to eligible members, through grantTrial`

### Task 21: Settle, `check_my_purchase`, double payment, expiry, static no-refund guard

**Files:**
- Modify: `src/lib/agent/purchase-intents.js`
- Create: `tests/mia-no-charge-no-refund-guard.test.js`
- Modify: `tests/whatsapp-config-callers.test.js` (row for `purchase-intents.js` if the scan lists it: "a `sendAgentThreadMessage` refusal = recorded `window_closed`, no retry")
- Test: `src/lib/agent/purchase-intents.test.js`

**Interfaces:**
- Produces:
  - `paidSinceSnapshot(snapshot, now: { balance, unlimited, liveSubscriptionIds }): boolean` — balance up, unlimited on, or a new live subscription id.
  - `settlePurchaseIntent(db, intentId, { detectedBy: 'pay_done'|'tool'|'watcher', source: 'live'|'mirror' }): Promise<{ outcome: 'not_paid'|'paid_booked'|'paid_class_gone'|'paid_booking_failed'|'paid_no_class'|'already_settled'|'expired', sent: boolean }>` — expired or past `expires_at` → `'expired'`, nothing sent; not paid → `'not_paid'`; paid → CAS `update … set status='paid', paid_detected_at, detected_by where id = ? and status = 'link_sent' returning id`; zero rows → `'already_settled'`; winner: records `un1t_transactions` product match in `outcome`, re-checks the event (scheduled, not started), runs Task 16's execute step, sends via `sendAgentThreadMessage` the matching `purchase_paid_*` copy (follow-ups untouched), final status `booked`/`book_failed`/`no_class`; booking refused/unknown → `class_booking` card `reason 'paid_booking_failed'`; `window_closed` → no send, recorded on the intent and the card.
  - Double payment: on settle, two or more `un1t_transactions` for the same user and product with `remote_created_at >= intent.created_at` → `fileRefundCard` with `details.reason 'double_payment'` and both transaction ids; no amounts in the thread.
  - `checkMyPurchase(ctx, studio)` → `settlePurchaseIntent(…, { detectedBy: 'tool', source: 'live' })` on the member's live intent; none → `{ open_intent: false }`.
  - `expireStaleIntents(db, { now }): Promise<{ expired: number }>` — CAS `link_sent → expired` where `expires_at < now`, silent.

- [ ] **Step 1: Write the failing tests:** `three detectors racing settle once (Promise.all of pay_done, tool, watcher -> exactly one book() and one send)`; `class full / passed / booking failed messages`; `no class -> purchase_paid_no_class_text`; `free: true`; `payment after expiry books nothing, sends nothing` and `different product counts as paid, product recorded` (**Review Focus 3**); `double payment files one refund_request card and no un1t call`; `expiry silent`; `window_closed recorded`. Static guard `mia-no-charge-no-refund-guard.test.js`: non-test `src/` contains no `forceRefund`, `bypassCredit`, `/credits/grant`, `/refund`; `/purchases/charge` appears only in D's `grantTrial` module.
- [ ] **Step 2: Run** `npx vitest run src/lib/agent/purchase-intents.test.js tests/mia-no-charge-no-refund-guard.test.js tests/whatsapp-config-callers.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.6 — settle paid intents once and book the class`

### Task 22: `/pay-done/<token>` return page

**Files:**
- Create: `src/app/pay-done/[token]/page.js`, `page.test.jsx`
- Modify: `src/proxy.js:214`, `src/components/AppShell.jsx:81`, `src/lib/brands.js` (un1t-marketing `allowedPaths`), `src/lib/tenant-domains-edge.js:120`, `src/public-compliance-paths.test.jsx`, `scripts/check-location-scoping` config only if the page needs a registered scoping helper (lookup is by token hash; register `findIntentByTokenHash` in `SCOPING_HELPERS`, not `EXEMPT`)

**Interfaces:**
- Consumes: `hashPayDoneToken`, `settlePurchaseIntent`, `checkRateLimit(db, \`mia-pay-done:${intentId}\`, { max: 1, windowMs: 30_000 })`, `getLocationBranding(db, locationId)`, `renderMiaCopy`.
- Produces: a server page, `export const metadata = { robots: { index: false } }`; renders the studio logo/name and `pay_done_page_text`, or `pay_cancel_page_text` when `?c=1`; an unknown token renders the same generic thanks copy with no branding (no 404 that confirms a token). On a known, `link_sent` intent and a free rate slot it calls `settlePurchaseIntent(…, { detectedBy: 'pay_done', source: 'live' })` and renders nothing about the result.

- [ ] **Step 1: Write the failing tests:** `in all four allowlists` (extend `public-compliance-paths.test.jsx`); `loading never marks paid on its own (settle reports not_paid -> status stays link_sent)`; `second load within 30 s does not call settle`; `no name, phone, email, product or URL rendered`; `cancel variant shows pay_cancel_page_text and never settles as paid`; `noindex`; `unknown token -> generic copy`.
- [ ] **Step 2: Run** `npx vitest run 'src/app/pay-done' src/public-compliance-paths.test.jsx` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; `npm run check:location-scoping` exits 0.
- [ ] **Step 5: Commit** `MIAHATCH.6 — /pay-done return page (a check trigger, never proof of payment)`

### Task 23: Mirror-only watcher cron (replaces the post-sync hook)

D's import fence forbids `un1t-online-sync.js` and its cron route from importing `un1t-online-write`, and settling books through D's `book`, so the third detector runs as the spec's own fallback: a 5-minute watcher, mirror only (zero un1t.online calls), with its own heartbeat.

**Files:**
- Create: `src/app/api/cron/mia-purchase-intents/route.js`, `route.test.js`, `supabase/migrations/NNN_mia_purchase_intents_heartbeat.sql`
- Modify: `vercel.json` (`{ "path": "/api/cron/mia-purchase-intents", "schedule": "*/5 * * * *" }`)

**Interfaces:**
- Produces: `GET` with `Bearer CRON_SECRET`; per live intent `settlePurchaseIntent(…, { detectedBy: 'watcher', source: 'mirror' })`, then `expireStaleIntents`; `stampHeartbeat('mia-purchase-intents')` on success; heartbeat outcome counts only (no ids, no PII). Migration inserts `cron_heartbeats ('mia-purchase-intents', 300, 600, now(), 'MIAHATCH.6 watcher: settles paid Mia payment links from the un1t mirror')` (mig 727 pattern).

- [ ] **Step 1: Write the failing tests:** `401 without the secret`; `settles each live intent from the mirror, never opens a un1t reader`; `one intent throwing does not stop the rest`; `stamps the heartbeat with counts only`; `expires stale intents`.
- [ ] **Step 2: Run** `npx vitest run src/app/api/cron/mia-purchase-intents` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS; `npm run check:route-guards` exits 0; `grep -L stampHeartbeat src/app/api/cron/*/route.js` lists only `health-check` and `ad-insights-backfill`.
- [ ] **Step 5: Commit** `MIAHATCH.6 — watcher cron settles paid intents from the mirror`
- [ ] **Step 6** [controller] apply the heartbeat migration **right after** PR 6 deploys (CLAUDE.md cron rule), then `get_advisors` security.

### Task 24: "Payment link sent" chip on the contact page

**Files:**
- Create: `src/app/api/contacts/[id]/mia-purchase-intents/route.js`, `route.test.js`
- Modify: the contact header component that renders status chips (find via `grep -rn "Payment overdue" src/components/contacts`), `src/lib/openapi.js`

**Interfaces:**
- Produces: `GET /api/contacts/[id]/mia-purchase-intents` → `{ success, data: [{ id, location_id, product_title, status, created_at, expires_at }] }` (no `checkout_url`, no token hash), filtered to locations the viewer can access, 404 for a contact they cannot see; chip `Payment link sent` (`bg-sky-500/10 text-sky-700`) while a `link_sent` intent is live.

- [ ] **Step 1: Write the failing tests:** `404 for a foreign contact`; `never returns checkout_url or success_token_hash`; `only the viewer's studios`; chip shows for `link_sent`, hides for `expired`.
- [ ] **Step 2: Run** `npx vitest run 'src/app/api/contacts/[id]/mia-purchase-intents'` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `MIAHATCH.6 — staff see Mia's open payment link on the contact`

### Task 25: Replace D's trial-used seam stubs

**Files:**
- Modify: `src/lib/un1t-online-trial-used.js` (D's no-op stubs), its test `src/lib/un1t-online-trial-used.test.js`

**Interfaces:**
- Consumes: `listPurchaseOptions` (Task 19), `isAgentOnForSender` (Task 1), `resolveAgentSettings`, `sendAgentThreadMessage`, `renderMiaCopy`.
- Produces (D's signatures, unchanged):
  - `trialUsedOptionsText(db, locationId) → Promise<string|null>` — one line per active offer, `"{title}, {price_label}"`, in `sort_order`; `null` when the list is empty or unreadable (D then renders "a class pack or a membership"). Never capacity, never a link.
  - `trialUsedHandoff(db, { request, contact, locationId }) → Promise<{ handled: boolean }>` — `handled: true` only when all hold: the request came through the WhatsApp Flow, a WhatsApp conversation for `contact` at this studio has an open 24h window, Mia is on for that sender at the studio (`isAgentOnForSender`), `writes_enabled` is on, and at least one offer exists; then it sends `trial_used_text` plus the offer lines in-thread via `sendAgentThreadMessage` and records the requested class on the conversation's decision log so Mia's next turn continues the upsell. Any failed read or a `window_closed` send → `{ handled: false }` (D sends its email instead); never throws.

- [ ] **Step 1: Write the failing tests:** `options text lists active offers in order, title and price only`; `empty or unreadable list -> null`; `handoff handled only for a Flow request with an open window, Mia on, writes on and offers`; `website request -> handled false`; `Mia off or test mode with another phone -> handled false`; `window_closed -> handled false`; `a throwing read -> handled false, no throw`; `no em/en dash in the sent text`.
- [ ] **Step 2: Run** `npx vitest run src/lib/un1t-online-trial-used.test.js` — Expected: FAIL.
- [ ] **Step 3: Implement** both bodies in place of D's stubs.
- [ ] **Step 4: Run** — Expected: PASS; D's processor tests (`npx vitest run src/lib/un1t-online-booking-processor.test.js`) still PASS.
- [ ] **Step 5: Commit** `MIAHATCH.6 — trial-used requests hand off to Mia's upsell; offer list text for D's email`
- [ ] **Step 6:** S2-S6.

### Task 26: MIA TEST script, slice 2 [controller + Richard]

- [ ] **Step 1** [controller] Preconditions: D's own live test passed; Hatch `writes_enabled` on (D's switch); offer list configured and copy reviewed by Richard; Hatch `booking_mode = 'auto'`; Hatch back in test mode (`enabled = false`, `test_mode = true`, `test_phones = [MIA TEST]`).
- [ ] **Step 2** [controller + Richard] Script, up to the link only (G4): book a class with credits (booked); book it again (already booked); cancel it (cancelled); with credits at zero ask to book: MIA TEST already holds D's test trial, so expect `ineligible`: Mia says the trial was used and shows the paid offers; pick 1 Class Credit and receive a link; **do not pay**; ask for the same product (same link); ask for a different product (`purchase_link_open_text`, no second link); open the cancel URL and the success URL (copy only, no "paid"); say "I've paid" (`check_my_purchase` finds nothing and says so); 23h later the intent is `expired`, silently.
- [ ] **Step 3** [controller] Check every `agent_membership_requests`, `un1t_write_events` (`origin 'mia'`) and `mia_purchase_intents` row; un1t.online shows exactly one booking per step and no purchase; `error_events` has no `un1t_write` rows; record whether a repeated `idempotency-key` returned the same hosted session.
- [ ] **Step 4** If MIA TEST shows `verify_identity` failing for a Stillorgan-owned contact on a Hatch thread, open a follow-up to widen its email pool (spec section 9); not built here.

### Task 27: Go-live [Richard]

- [ ] **Step 1** D flips `bookings` (D's PR) only now that PR 5 is deployed.
- [ ] **Step 2** Richard switches Hatch on himself: `enabled = true`, `test_mode = false`. Replies only (follow-ups and check-ins stay off at Hatch's studio layer).
- [ ] **Step 3** Richard tests the paid path by hand (G4): a real small purchase; confirm the booking lands in un1t.online and `purchase_paid_booked_text` arrives in the thread; then a refund request (`request_refund`) files a card, which staff action in un1t.online (R2).
- [ ] **Step 4** [controller] Watch the decision log (`member_studios`, `tool_block`, `intent_id`) and `mia_purchase_intents` daily for a week; report before anyone discusses follow-ups at Hatch.
