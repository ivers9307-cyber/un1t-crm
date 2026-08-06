# Email Ticketing — Plan 3: Webhook cutover (dual-write)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inbound webhook resolve mail to a **mailbox** and file it as a **ticket**, kill the fallback that silently misroutes unmatched mail, and keep the existing inbox working throughout by writing both shapes.

**Architecture:** The webhook's location resolution is replaced by `resolveMailboxByRecipient` — the mailbox carries its location, so location falls out of it. An unmatched recipient **dead-letters** instead of falling back to "the oldest active location". Ticket identity comes from `resolveTicketAction` against the ticket a threading header resolves to. During the transition the route **dual-writes**: every inbound produces a ticket *and* maintains the existing conversation row, and the message row carries both `ticket_id` and `conversation_id`. No new migration.

**Tech Stack:** Next.js route handler, supabase-js service role, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-05-email-ticketing-design.md`

**Plan 3 of 7.** 1 model (merged) · 2 mailboxes (merged) · **3 webhook cutover** · 4 send cutover · 5 quota · 6 HTML rendering · 7 tabbed UI + grant editor.

---

## As built — deltas from this plan

Executed 2026-08-06. Four differences worth carrying forward.

**Added mid-flight: auto-close is gone.** Richard, 2026-08-06 — nothing ever
closes itself; every ticket is responded to or manually closed.
`ticketsDueForAutoClose` and `DEFAULT_AUTO_CLOSE_DAYS` were deleted (dead code,
never wired to anything). A ticket ageing out is indistinguishable from a ticket
being handled, and a silently shrinking queue is how enquiries get lost.

**Three places this plan was wrong**, corrected during implementation:

1. `deadLetterWebhook` has **no `reason` argument** — the sketch below invented
   one, and an `eventId` too. The real signature is
   `(db, { provider, eventType, payload, error, locationId })`; the reason maps
   onto `error`.
2. **Do not dead-letter under `WEBHOOK_PROVIDERS.POSTMARK`.** That provider is
   auto-replayable and its re-driver re-inserts payloads into
   `postmark_webhook_queue` — the *outbound delivery-event* queue. An inbound
   email filed there would be pushed into the wrong pipeline and marked resolved
   while nothing was resolved, hiding it from triage. Uses `postmark_inbound`.
3. **The `.or()` filter sketched below is unsafe.** It builds a raw PostgREST
   filter string out of attacker-controlled `In-Reply-To` headers. Two `.in()`
   queries instead — and the threading lookup is **location-scoped**, because an
   RFC message id is guessable text and unscoped it could thread a stranger's
   mail into another studio's ticket.

Sequencing also changed: the ticket UI moves to **Plan 4**, ahead of quota, HTML
rendering and the grant editor. Building four plans of infrastructure before any
human sees a ticket front-loads risk on an unvalidated model.

---

## THE RISK, AND WHY DUAL-WRITE

**This is the first plan that changes live behaviour**, on a webhook that began working for the first time on 2026-08-06 and is actively being tested against `accounts@hatchstreetfitness.com`.

Nine files still read `email_conversations` — `EmailInbox.jsx`, `UnifiedInbox.jsx`, `inbox-search-server.js`, the unread-count route, the conversations routes and the send route. A clean cutover would make `/communications/inbox` show **no email at all** until the tickets UI lands in Plan 7, which is four plans away.

So this plan dual-writes (Richard, 2026-08-06). Every inbound produces both rows; the operator sees no change; tickets accumulate real data so Plan 7's UI ships against a populated table rather than an empty one. `email_conversations` is dropped only after that UI is live.

**One behaviour DOES change, deliberately:** unmatched recipients no longer land anywhere visible. That is the entire point — see below.

---

## The fallback that dies

`route.js` currently resolves an unmatched recipient like this:

```js
} else {
  // Deterministic default: the oldest active location.
  locationId = locations?.[0]?.id || null
}
```

Written for a single-address estate, and demonstrably wrong now: on 2026-08-05 Postmark's own sample payload (`mailbox+samplehash@inbound.postmarkapp.com`) matched nothing and filed itself into **Stillorgan's** queue. With several addresses across several domains it silently mixes one studio's mail into another's.

It is replaced by a dead-letter. Note the consequence honestly: with Postmark inbound-domain forwarding, **every** address at a configured domain reaches the webhook, so `anything@hatchstreetfitness.com` that is not a configured mailbox now dead-letters rather than appearing in an inbox. That is correct — it is not a mailbox — and `webhook_dead_letter` is a surface someone can look at, unlike a wrong studio's queue. An operator who wants everything captured configures a catch-all mailbox.

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/email-tickets.js` (modify) | Add `pickThreadedTicket` — most-recent-thread-wins |
| `src/lib/email-tickets.test.js` (modify) | Tests for it |
| `src/app/api/webhooks/postmark-inbound/[token]/route.js` (modify) | Mailbox resolution, dead-letter, ticket write, dual-write |
| `src/app/api/webhooks/postmark-inbound/[token]/route.test.js` (create) | Route tests with mocked Supabase |

No migration. Everything this needs exists from migs 482–485.

---

## Task 1: Branch

- [ ] **Step 1: Branch off fresh `origin/main`**

```bash
cd ~/code/un1t-crm && git fetch origin main && git checkout -b email-tickets-p3-webhook-cutover origin/main
```

- [ ] **Step 2: Confirm nothing moved under us**

```bash
cd ~/code/un1t-crm && git log --oneline -3 origin/main
```

Expect the Plan 2 merge (`EMAIL-TICKET.2 — mailboxes and per-account access`) at or near the tip. Two other sessions have been merging to main during this programme, so check rather than assume.

---

## Task 2: `pickThreadedTicket`

**Files:**
- Modify: `src/lib/email-tickets.js`
- Modify: `src/lib/email-tickets.test.js`

The route will look up `email_inbox_messages` rows whose `rfc_message_id` or `postmark_message_id` matches a threading candidate. Several may come back — a long reply chain touches many messages. Choosing among them is a decision, so it belongs here rather than inline in the route.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/email-tickets.test.js`:

```js
describe('pickThreadedTicket', () => {
  const a = { ticket_id: 'T1', created_at: '2026-08-01T10:00:00Z' }
  const b = { ticket_id: 'T2', created_at: '2026-08-05T10:00:00Z' }

  it('picks the most recent message’s ticket', () => {
    expect(pickThreadedTicket([a, b])).toBe('T2')
    expect(pickThreadedTicket([b, a])).toBe('T2')
  })

  it('ignores rows with no ticket_id', () => {
    expect(pickThreadedTicket([{ ticket_id: null, created_at: '2026-08-09T10:00:00Z' }, a]))
      .toBe('T1')
  })

  it('returns null when nothing threads', () => {
    expect(pickThreadedTicket([])).toBeNull()
    expect(pickThreadedTicket(null)).toBeNull()
    expect(pickThreadedTicket([{ ticket_id: null, created_at: '2026-08-01T10:00:00Z' }])).toBeNull()
  })

  it('is deterministic when timestamps tie — lowest id wins', () => {
    const t = '2026-08-05T10:00:00Z'
    expect(pickThreadedTicket([{ ticket_id: 'B', created_at: t }, { ticket_id: 'A', created_at: t }]))
      .toBe('A')
  })

  it('tolerates unparseable timestamps rather than picking them', () => {
    expect(pickThreadedTicket([{ ticket_id: 'X', created_at: 'nonsense' }, b])).toBe('T2')
  })
})
```

Add `pickThreadedTicket` to the file's import list.

- [ ] **Step 2: Run and confirm FAIL**

```bash
cd ~/code/un1t-crm && npx vitest run src/lib/email-tickets.test.js
```

Expected: FAIL — `pickThreadedTicket is not a function`.

- [ ] **Step 3: Implement**

Append to `src/lib/email-tickets.js`:

```js
/**
 * Which ticket a set of threading-matched message rows belongs to.
 *
 * A long reply chain touches many of our messages, so several rows can match
 * one In-Reply-To/References header. The most recent wins: a member replying
 * to an old message in a thread that has since moved on means the live ticket,
 * not the archived one.
 *
 * Ties break on the lowest ticket id so the result is deterministic — two rows
 * written in the same transaction share a timestamp, and a coin-flip there is
 * the same class of bug as routing by DB row order.
 *
 * @param {Array<{ticket_id: string|null, created_at: string}>} rows
 * @returns {string|null} ticket id, or null if nothing threads
 */
export function pickThreadedTicket(rows) {
  if (!Array.isArray(rows)) return null
  let bestId = null
  let bestAt = -Infinity
  for (const r of rows) {
    if (!r?.ticket_id) continue
    const at = Date.parse(r.created_at ?? '')
    if (!Number.isFinite(at)) continue
    if (at > bestAt || (at === bestAt && String(r.ticket_id) < String(bestId))) {
      bestAt = at
      bestId = r.ticket_id
    }
  }
  return bestId
}
```

- [ ] **Step 4: Run and confirm PASS**

```bash
cd ~/code/un1t-crm && npx vitest run src/lib/email-tickets.test.js
```

Expected: PASS, 26 tests (23 existing + 5 new… count them and report the real number).

- [ ] **Step 5: Commit**

```bash
cd ~/code/un1t-crm && git add src/lib/email-tickets.js src/lib/email-tickets.test.js && git commit -F- <<'MSG'
EMAIL-TICKET.3 — pickThreadedTicket

Which ticket a set of threading-matched message rows belongs to. Most recent
wins; ties break on the lowest ticket id so the result is deterministic rather
than depending on row order — the same class of bug that the mailbox routing
fix had to correct in Plan 2.

Pure, no DB. Nothing calls it yet.
MSG
```

---

## Task 3: The webhook cutover

**Files:**
- Modify: `src/app/api/webhooks/postmark-inbound/[token]/route.js`
- Create: `src/app/api/webhooks/postmark-inbound/[token]/route.test.js`

**Read the whole existing route before changing anything.** It is ~310 lines and every branch matters: token auth, JSON parsing, `MessageID` requirement, the `recordWebhookEvent` idempotency gate, `23505` duplicate handling, and the racing-insert re-read. **Preserve all of it.** The only things changing are *how a location is resolved* and *what gets written*.

Note the zsh trap: `[token]` is a glob. Single-quote every path in git and shell commands.

### What changes

**1. Replace location resolution with mailbox resolution.** The block that selects `locations` and calls `matchLocationByRecipient` becomes a select from `email_mailboxes` (`id, location_id, address, active`, filtered `active = true`) passed to `resolveMailboxByRecipient(mailboxes, recipientEmails(body))`.

**2. Dead-letter instead of falling back.** Where the old code assigned `locations?.[0]?.id`, now:

```js
if (!mailbox) {
  await deadLetterWebhook(db, {
    provider: WEBHOOK_PROVIDERS.POSTMARK,
    eventId: `inbound-email:${messageId}`,
    reason: 'no_matching_mailbox',
    payload: body,
  })
  console.warn('[postmark-inbound] no mailbox matched; dead-lettered', {
    messageId, recipients: recipientEmails(body),
  })
  return NextResponse.json({ success: true, dead_lettered: 'no_matching_mailbox' })
}
```

Check `deadLetterWebhook`'s real signature in `src/lib/webhook-dead-letter.js` and match it — do not guess the argument shape. Return **200**: retrying will not conjure a mailbox, and a non-2xx makes Postmark disable the webhook.

`locationId` now comes from `mailbox.location_id`. The `email_sends` threading lookup (path *a*) keeps running, but only to resolve **contact**, never location — the mailbox is authoritative about where mail landed.

**3. Resolve the ticket.** After contact resolution, using the same `candidates` already extracted:

```js
let threadedTicket = null
if (candidates.length) {
  const { data: rows } = await db.from('email_inbox_messages')
    .select('ticket_id, created_at')
    .not('ticket_id', 'is', null)
    .or(`rfc_message_id.in.(${...}),postmark_message_id.in.(${...})`)
  const ticketId = pickThreadedTicket(rows || [])
  if (ticketId) {
    const { data: t } = await db.from('email_tickets')
      .select('id, status, subject, first_response_at')
      .eq('id', ticketId).maybeSingle()
    threadedTicket = t || null
  }
}
const action = resolveTicketAction(threadedTicket)
```

Build the `.or()` filter from the escaped candidate list, and cap it at `MAX_THREAD_CANDIDATES` as the existing code already does.

**4. Create or append.** `action.action === 'create'` inserts an `email_tickets` row with `location_id`, `mailbox_id: mailbox.id`, `contact_id`, `requester_email: fromEmail`, `requester_name`, `subject: ticketSubject(null, subject)`, `status: 'open'`, and `reopened_from: action.reopenedFrom`. `append` updates the existing ticket to `status: 'open'` and refreshes the summary fields. Bump unread via `increment_email_ticket_unread`.

**5. Keep the conversation write.** Everything the route does today with `email_conversations` stays, unchanged, so the live inbox keeps working. The message insert gains `ticket_id` alongside `conversation_id`.

**6. Return both ids** so the response is diagnosable: `{ success: true, ticket_id, conversation_id, mailbox_id, matched_via }`.

### Steps

- [ ] **Step 1: Read the existing route in full**

```bash
cd ~/code/un1t-crm && cat 'src/app/api/webhooks/postmark-inbound/[token]/route.js'
```

- [ ] **Step 2: Read the dead-letter helper's real signature**

```bash
cd ~/code/un1t-crm && sed -n '1,60p' src/lib/webhook-dead-letter.js
```

- [ ] **Step 3: Write route tests FIRST**

Create `route.test.js` beside the route, mocking `@/lib/supabase` in the style of the repo's existing route tests (`src/app/api/settings/email-domain/route.test.js` is a good model — read it before writing). Cover at minimum:

1. **Unmatched recipient dead-letters** — `deadLetterWebhook` called, response 200, and **no** `email_tickets` insert. This is the Postmark-sample-payload case and the reason this plan exists.
2. **Matched recipient files to that mailbox's location** — assert the ticket's `location_id` is the mailbox's, not the oldest location's. Include a second, older mailbox at a different location in the fixture so a fallback regression fails the test.
3. **Dual-write** — one inbound produces both a ticket and a conversation, and the message row carries both ids.
4. **Threading appends** rather than creating a second ticket.
5. **A reply to a `closed` ticket mints a NEW ticket** with `reopened_from` set.
6. **Idempotency preserved** — a duplicate `MessageID` returns `deduped` and writes nothing.
7. **An inactive mailbox does not match** — dead-letters.

- [ ] **Step 4: Run them and confirm they FAIL**

```bash
cd ~/code/un1t-crm && npx vitest run 'src/app/api/webhooks/postmark-inbound/[token]/route.test.js'
```

- [ ] **Step 5: Make the changes**

- [ ] **Step 6: Run until green, then lint**

```bash
cd ~/code/un1t-crm && npx vitest run 'src/app/api/webhooks/postmark-inbound/[token]/route.test.js' && npx eslint 'src/app/api/webhooks/postmark-inbound/[token]/route.js' 'src/app/api/webhooks/postmark-inbound/[token]/route.test.js'
```

- [ ] **Step 7: Commit**

Use `git commit -F-` with a heredoc; the message contains backticks.

---

## Task 4: CI, build, PR

- [ ] **Step 1: Seven-command CI mirror**

```bash
cd ~/code/un1t-crm && npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:route-guards && npm run check:rls-restrictive && npm run check:guardrails
```

`check:route-guards` matters here — the route keeps its `verifyEmailInboundRequest` gate, and removing it would fail.

- [ ] **Step 2: Build**

```bash
cd ~/code/un1t-crm && npm run build
```

- [ ] **Step 3: PR**

Body must state plainly: dual-write, so no operator-visible change; the fallback is dead; unmatched mail now dead-letters, including any non-configured address at a forwarded domain.

- [ ] **Step 4: Watch checks**

```bash
cd ~/code/un1t-crm && gh pr checks --watch
```

---

## After merge — the live test that actually proves it

CI cannot prove this one. Once merged and deployed, **send a real email to `accounts@hatchstreetfitness.com`** and confirm via MCP:

```sql
SELECT t.id, t.status, l.name AS location, m.address AS mailbox, t.requester_email
  FROM public.email_tickets t
  JOIN public.locations l ON l.id = t.location_id
  LEFT JOIN public.email_mailboxes m ON m.id = t.mailbox_id
 ORDER BY t.created_at DESC LIMIT 3;
```

Pass = a ticket exists, `location` is **UN1T Hatch Street**, and `mailbox` is `accounts@hatchstreetfitness.com`. Then confirm the conversation row was also written and the existing inbox still renders it.

Then send a second email **to a non-configured address** at the same domain and confirm it dead-letters rather than appearing anywhere.

---

## Deliberately NOT in this plan

- **The send route.** `/api/email/conversations/[id]/send` already sends on the transactional `outbound` stream with no marketing-consent gate — that requirement is satisfied. What it still needs is to key off tickets, send **From** the mailbox address rather than `POSTMARK_FROM_EMAIL`, and resolve the inbox server's own Postmark token. That is Plan 4, and it depends on the sending domain being DKIM-verified.
- Quota accounting (5), HTML rendering (6), the tabbed UI and grant editor (7).
- Dropping `email_conversations` — only after Plan 7's UI is live.
