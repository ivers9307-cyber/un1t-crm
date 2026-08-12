# Email Thread Participants Implementation Plan (PR 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reply reaches everyone who has joined the email conversation — not just whoever sent the newest message — and the ticket shows who those people are.

**Architecture:** One new pure function unions the addresses across a ticket's real correspondence (internal notes and forwards excluded), minus our own mailbox addresses and minus a per-ticket sticky exclusion list stored in one new `text[]` column. The detail route and the reply route both derive through that one function over an identical message window, so the label and the send cannot disagree. The webhook stops taking `contact_id` from a sender-supplied header.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role routes, RLS-bypassing), Vitest, React 19, Tailwind. Spec: `docs/superpowers/specs/2026-08-12-email-thread-participants-design.md`.

---

## Background the engineer needs

- **Service-role routes get NO RLS.** Every `/api` route uses `createServerClient()`, which bypasses RLS. Access control is app code. For email tickets the gate lives **inside `loadTicketForUser`** (`src/app/api/email/tickets/_helpers.js:285`), never as a per-route check — a ticket's location isn't knowable until the row is read, so a per-route `hasPermission` resolves at the caller's *active* location and grants access to another studio's mail. Refusals are **404**, not 403.
- **`bcc_emails` must never reach a recipient list.** `src/lib/email-recipients.js` is the only module that derives recipients from stored correspondence, and the guarantee is enforced by *not naming the column*. Do not add it.
- **supabase-js builders are thenables, not Promises** — no `.catch()`. Use `try/catch`.
- **`.update()`/`.insert()` must be awaited** or the request never fires.
- Run the CI mirror before pushing (nine checks, listed in Task 10).

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/534_email_ticket_excluded_participants.sql` | **Create.** The one new column. |
| `src/lib/email-recipients.js` | **Modify.** Add `ticketParticipants()`. Pure, no DB. |
| `src/lib/email-recipients.test.js` | **Modify.** Union rules + the live-incident regression fixture. |
| `src/app/api/email/tickets/_helpers.js` | **Modify.** Add `loadParticipantMessages()` + `resolveReplyAudience()` so both routes share one window and one derivation. |
| `src/app/api/email/tickets/[id]/route.js` | **Modify.** Detail route derives via the shared helper; emits `over_cap`. |
| `src/app/api/email/tickets/[id]/reply/route.js` | **Modify.** Same helper; refuse empty set; 400 over cap. |
| `src/app/api/email/tickets/[id]/participants/route.js` | **Create.** `PATCH` remove/restore. |
| `src/components/tickets/TicketReplyBox.jsx` | **Modify.** Recipient chips with remove. |
| `src/components/tickets/TicketThread.jsx` | **Modify.** Live participants, per-message envelope, "joined this thread". |
| `mobile/lib/email-api.js` | **Modify.** Stop dropping `reply_recipients`. |
| `mobile/app/email/[ticketId].jsx` | **Modify.** Render the real audience. |
| `src/app/api/webhooks/postmark-inbound/[token]/route.js` | **Modify.** Drop the header-based contact link. |

---

## Task 1: Migration — the sticky exclusion column

**Files:**
- Create: `supabase/migrations/534_email_ticket_excluded_participants.sql`

Migration 533 is the highest on disk and in the live `supabase_migrations.schema_migrations` (verified 2026-08-12), so 534 is free. **Migrations are forward-only and must be applied BEFORE the code that reads the column deploys.**

- [ ] **Step 1: Write the migration**

```sql
-- 534 — EMAIL-PARTICIPANTS.1
-- Addresses an operator has explicitly taken OFF a ticket's audience.
--
-- WHY A COLUMN AND NOT A TABLE: the participant set itself is DERIVED from
-- email_inbox_messages on every read, so it cannot drift from the mail that
-- actually arrived. Only the operator's subtractions need storing, and they are
-- a small, unordered set of addresses per ticket. A participants table would be
-- a second source of truth with five write sites (webhook main path, webhook
-- crash-finish path, reply, compose, forward) — miss one and the audience
-- silently narrows, which is the exact defect this work exists to remove.
--
-- Addresses are stored NORMALISED (lowercased, angle-brackets stripped) by
-- src/lib/email-recipients.js normalizeAddress(), so a case variant cannot
-- dodge an exclusion.
alter table email_tickets
  add column if not exists excluded_participants text[] not null default '{}';

comment on column email_tickets.excluded_participants is
  'Normalised addresses removed from this ticket''s reply audience by an operator (mig 534). Empty = derive the audience from the messages alone.';
```

- [ ] **Step 2: Apply to prod via Supabase MCP**

Use `apply_migration` against project `iyvtbjjxdggiadzwwvdj` (un1t-crm — **not** the sentinel project `tpttqakxmyxrwnqjepfm`). Name: `534_email_ticket_excluded_participants`.

- [ ] **Step 3: Verify the column landed**

Run via MCP `execute_sql`:

```sql
select column_name, data_type, column_default, is_nullable
from information_schema.columns
where table_name = 'email_tickets' and column_name = 'excluded_participants';
```

Expected: one row, `ARRAY`, default `'{}'::text[]`, `is_nullable = NO`.

- [ ] **Step 4: Run both advisors**

`get_advisors` with `type=security`, then `type=performance`. Expected: no NEW findings. Pre-existing estate noise is fine; a new one on `email_tickets` is not.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/534_email_ticket_excluded_participants.sql
git commit -m "EMAIL-PARTICIPANTS.1 — mig 534: per-ticket excluded_participants"
```

---

## Task 2: The pure function

**Files:**
- Modify: `src/lib/email-recipients.js`
- Test: `src/lib/email-recipients.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/email-recipients.test.js`:

```js
describe('ticketParticipants', () => {
  const msg = (over = {}) => ({
    from_email: 'a@x.com', to_emails: [], cc_emails: [],
    is_internal_note: false, forwarded_message_id: null,
    created_at: '2026-08-01T00:00:00Z', ...over,
  })

  it('unions across the whole thread, not just the newest message', () => {
    const out = ticketParticipants([
      msg({ from_email: 'us@ours.com', to_emails: ['rates@council.ie'], created_at: '2026-08-01T00:00:00Z' }),
      msg({ from_email: 'eleanor@council.ie', to_emails: ['us@ours.com'], created_at: '2026-08-02T00:00:00Z' }),
    ], { exclude: ['us@ours.com'] })
    expect(out).toEqual(['eleanor@council.ie', 'rates@council.ie'])
  })

  it('puts the latest correspondent first', () => {
    const out = ticketParticipants([
      msg({ from_email: 'old@x.com', created_at: '2026-08-01T00:00:00Z' }),
      msg({ from_email: 'new@x.com', created_at: '2026-08-05T00:00:00Z' }),
    ])
    expect(out[0]).toBe('new@x.com')
  })

  it('skips internal notes', () => {
    const out = ticketParticipants([
      msg({ from_email: 'member@x.com' }),
      msg({ from_email: 'staff@ours.com', to_emails: ['nobody@x.com'], is_internal_note: true }),
    ])
    expect(out).not.toContain('nobody@x.com')
  })

  it('skips forward rows — a forward shows the thread, it does not add someone', () => {
    const out = ticketParticipants([
      msg({ from_email: 'member@x.com' }),
      msg({ from_email: 'staff@ours.com', to_emails: ['accountant@third.com'], forwarded_message_id: 'm1' }),
    ])
    expect(out).not.toContain('accountant@third.com')
  })

  it('never reads bcc_emails', () => {
    const out = ticketParticipants([msg({ bcc_emails: ['secret@x.com'] })])
    expect(out).not.toContain('secret@x.com')
  })

  it('applies sticky exclusions case-insensitively', () => {
    const out = ticketParticipants(
      [msg({ from_email: 'member@x.com', to_emails: ['Rates@Council.IE'] })],
      { removed: ['rates@council.ie'] },
    )
    expect(out).toEqual(['member@x.com'])
  })

  it('reads the legacy scalar to_email on pre-EMAIL-CC.1 rows', () => {
    const out = ticketParticipants([
      { from_email: 'a@x.com', to_email: 'b@x.com', to_emails: null, cc_emails: null,
        is_internal_note: false, forwarded_message_id: null, created_at: '2026-08-01T00:00:00Z' },
    ])
    expect(out).toEqual(['a@x.com', 'b@x.com'])
  })

  it('dedupes case variants across messages', () => {
    const out = ticketParticipants([
      msg({ from_email: 'Member@X.com', created_at: '2026-08-01T00:00:00Z' }),
      msg({ from_email: 'member@x.com', created_at: '2026-08-02T00:00:00Z' }),
    ])
    expect(out).toEqual(['member@x.com'])
  })

  it('returns [] for no usable input', () => {
    expect(ticketParticipants(null)).toEqual([])
    expect(ticketParticipants([])).toEqual([])
  })

  // THE LIVE INCIDENT, 2026-08-12. Eleanor replied on a chain the rates office
  // forwarded to her; the reply that followed reached her alone and dropped
  // ratesoffice@ off their own thread.
  it('regression: keeps ratesoffice@ on the audience after Eleanor joins', () => {
    const out = ticketParticipants([
      msg({ from_email: 'accounts@hatchstreetfitness.com', to_emails: ['ratesoffice@dublincity.ie'],
            created_at: '2026-08-12T09:10:26Z' }),
      msg({ from_email: 'eleanor.brennan@dublincity.ie', to_emails: ['accounts@hatchstreetfitness.com'],
            created_at: '2026-08-12T10:06:43Z' }),
    ], { exclude: ['accounts@hatchstreetfitness.com'] })
    expect(out).toContain('ratesoffice@dublincity.ie')
    expect(out).toContain('eleanor.brennan@dublincity.ie')
  })
})
```

Add `ticketParticipants` to the existing import at the top of the test file.

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/lib/email-recipients.test.js -t ticketParticipants
```

Expected: FAIL — `ticketParticipants is not a function`.

- [ ] **Step 3: Implement**

Add to `src/lib/email-recipients.js`, directly below `threadParticipants`:

```js
/**
 * Everyone on a ticket's conversation, across the WHOLE thread.
 *
 * WHY THIS EXISTS SEPARATELY FROM threadParticipants()
 * threadParticipants() answers "who was on THIS message" and was, until
 * EMAIL-PARTICIPANTS.1, applied to the latest message alone to build a reply
 * audience. That made whoever wrote last redefine the entire audience: on
 * 2026-08-12 a named officer replied on a chain her office had forwarded her,
 * and the reply that followed reached her alone — silently dropping the shared
 * mailbox that had opened the thread. A conversation accumulates people; the
 * audience has to accumulate with it.
 *
 * WHAT IS DELIBERATELY EXCLUDED
 *   • internal notes — sent to nobody, so they name nobody
 *   • FORWARD rows (forwarded_message_id set) — a forward SHOWS the thread to
 *     someone rather than adding them to it. Without this, forwarding a ticket
 *     to an accountant would copy them on every later reply to the member. It
 *     also closes the inverse defect, where the next reply after a forward went
 *     to the forwarded-to party INSTEAD of the member.
 *   • bcc_emails — not named in this function, same guarantee as everywhere
 *     else in this module. Do not add it.
 *   • `exclude` — our own mailbox addresses, or a reply-all re-enters our own
 *     inbound webhook and files onto this same ticket as INBOUND.
 *   • `removed` — addresses an operator explicitly took off this ticket
 *     (email_tickets.excluded_participants, mig 534).
 *
 * ORDER: the latest correspondent leads, then everyone else by first
 * appearance. Deterministic, because the detail route and the reply route
 * derive this independently and a difference between them is a wrong audience.
 *
 * @param {object[]} messages  email_inbox_messages rows, any order
 * @param {{ exclude?: string[], removed?: string[] }} [opts]
 * @returns {string[]}  normalised, deduped
 */
export function ticketParticipants(messages, { exclude = [], removed = [] } = {}) {
  const at = (m) => Date.parse(m?.created_at || m?.sent_at || 0) || 0
  const real = (Array.isArray(messages) ? messages : [])
    .filter(m => m && !m.is_internal_note && !m.forwarded_message_id)
    .sort((a, b) => at(a) - at(b)) // oldest first — first appearance decides order

  const raw = []
  const newest = real[real.length - 1]
  if (newest) raw.push(newest.from_email) // who you are answering leads
  for (const m of real) {
    raw.push(m.from_email)
    if (Array.isArray(m.to_emails) && m.to_emails.length) raw.push(...m.to_emails)
    else if (m.to_email) raw.push(m.to_email) // pre-EMAIL-CC.1 rows
    if (Array.isArray(m.cc_emails)) raw.push(...m.cc_emails)
  }

  const off = new Set(normalizeAddressList([...exclude, ...removed]).valid)
  return normalizeAddressList(raw).valid.filter(a => !off.has(a))
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run src/lib/email-recipients.test.js
```

Expected: PASS, all tests in the file including the pre-existing bcc mutation checks.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email-recipients.js src/lib/email-recipients.test.js
git commit -m "EMAIL-PARTICIPANTS.2 — ticketParticipants(): union across the thread"
```

---

## Task 3: One shared audience resolution

Both routes must derive from an identical message window. Today the detail route reads 200 rows and the reply route reads 10 (`RECIPIENT_SCAN_LIMIT`) — deriving a union from two different windows would reintroduce exactly the disagreement the existing comments promise cannot happen.

**Files:**
- Modify: `src/app/api/email/tickets/_helpers.js`
- Test: `src/app/api/email/tickets/_helpers.test.js` (create if absent)

- [ ] **Step 1: Write the failing test**

```js
import { describe, it, expect } from 'vitest'
import { resolveReplyAudience, PARTICIPANT_SCAN_LIMIT } from './_helpers'

const M = (over = {}) => ({
  from_email: 'member@x.com', to_emails: ['us@ours.com'], cc_emails: [],
  is_internal_note: false, forwarded_message_id: null,
  created_at: '2026-08-01T00:00:00Z', ...over,
})

describe('resolveReplyAudience', () => {
  it('derives the union and flags nothing when under the cap', () => {
    const out = resolveReplyAudience({
      messages: [M(), M({ from_email: 'colleague@x.com', created_at: '2026-08-02T00:00:00Z' })],
      ticket: { requester_email: 'member@x.com', excluded_participants: [] },
      ownAddresses: ['us@ours.com'],
    })
    expect(out.to).toEqual(['colleague@x.com', 'member@x.com'])
    expect(out.over_cap).toBe(false)
    expect(out.mode).toBe('reply_all')
  })

  it('falls back to the requester when there is no usable correspondence', () => {
    const out = resolveReplyAudience({
      messages: [M({ is_internal_note: true })],
      ticket: { requester_email: 'member@x.com', excluded_participants: [] },
      ownAddresses: ['us@ours.com'],
    })
    expect(out.to).toEqual(['member@x.com'])
  })

  // The fallback must NOT resurrect someone the operator removed, or the
  // removal appears to work and then silently undoes itself on the next send.
  it('does not resurrect an excluded requester through the fallback', () => {
    const out = resolveReplyAudience({
      messages: [M({ is_internal_note: true })],
      ticket: { requester_email: 'member@x.com', excluded_participants: ['member@x.com'] },
      ownAddresses: ['us@ours.com'],
    })
    expect(out.to).toEqual([])
    expect(out.empty).toBe(true)
  })

  it('flags over_cap rather than truncating', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      M({ from_email: `p${i}@x.com`, created_at: `2026-08-01T00:00:${String(i).padStart(2, '0')}Z` }))
    const out = resolveReplyAudience({
      messages: many,
      ticket: { requester_email: 'p0@x.com', excluded_participants: [] },
      ownAddresses: ['us@ours.com'],
    })
    expect(out.over_cap).toBe(true)
    expect(out.to.length).toBe(30)
  })

  it('scans far more than the old 10-row recipient window', () => {
    expect(PARTICIPANT_SCAN_LIMIT).toBeGreaterThanOrEqual(500)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/app/api/email/tickets/_helpers.test.js
```

Expected: FAIL — `resolveReplyAudience` is not exported.

- [ ] **Step 3: Implement**

Add to `src/app/api/email/tickets/_helpers.js`:

```js
import {
  ticketParticipants, normalizeAddressList, replyMode, MAX_RECIPIENTS,
} from '@/lib/email-recipients'

/**
 * How many messages the audience is derived from.
 *
 * The reply route used to scan 10, which on a ticket with 11+ internal notes
 * could push every real correspondent out of the window and silently narrow
 * "Reply All (N)". A union has to see the whole conversation. 500 is far above
 * any real support thread and still bounded — an unbounded select would hit
 * PostgREST's 1,000-row cap and truncate without saying so.
 */
export const PARTICIPANT_SCAN_LIMIT = 500

// bcc_emails IS NOT SELECTED, so no caller can leak it into a recipient list
// even if the derivation changed. forwarded_message_id IS, because a forward
// row must be recognisable in order to be skipped.
const PARTICIPANT_COLUMNS =
  'from_email, to_email, to_emails, cc_emails, is_internal_note, forwarded_message_id, created_at, sent_at'

/**
 * The one message window both the detail route and the reply route derive from.
 * Two windows would be two answers to "who does this reach".
 */
export async function loadParticipantMessages(db, ticketId) {
  return db.from('email_inbox_messages')
    .select(PARTICIPANT_COLUMNS)
    .eq('ticket_id', ticketId)
    .order('created_at', { ascending: false })
    .limit(PARTICIPANT_SCAN_LIMIT)
}

/**
 * Who a reply reaches, and whether it may be sent at all.
 *
 * `empty` is a real answer, not a failure: an operator who removes every
 * participant has said something deliberate, and mailing someone they took off
 * is not an acceptable way to avoid an error message.
 *
 * @returns {{ to: string[], mode: 'reply'|'reply_all', over_cap: boolean, empty: boolean }}
 */
export function resolveReplyAudience({ messages, ticket, ownAddresses }) {
  const removed = ticket?.excluded_participants || []
  const off = new Set(normalizeAddressList(removed).valid)

  const derived = ticketParticipants(messages || [], {
    exclude: ownAddresses || [],
    removed,
  })
  // Exclusions apply to the fallback too — see the test above.
  const fallback = normalizeAddressList([ticket?.requester_email])
    .valid.filter(a => !off.has(a))

  const to = derived.length ? derived : fallback
  return {
    to,
    mode: replyMode(to),
    over_cap: to.length > MAX_RECIPIENTS,
    empty: to.length === 0,
  }
}
```

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run src/app/api/email/tickets/_helpers.test.js
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/email/tickets/_helpers.js src/app/api/email/tickets/_helpers.test.js
git commit -m "EMAIL-PARTICIPANTS.3 — one shared audience window and derivation"
```

---

## Task 4: Detail route uses the shared derivation

**Files:**
- Modify: `src/app/api/email/tickets/[id]/route.js` (the `replyRecipients` block, around :141-155)
- Test: `src/app/api/email/tickets/[id]/route.test.js`

- [ ] **Step 1: Write the failing test**

Add to `src/app/api/email/tickets/[id]/route.test.js`, following the file's existing fixture style:

```js
it('reply_recipients keeps an earlier participant who is not on the newest message', async () => {
  const db = makeDb()
  seedTicket(db, T_STUDIO)
  seedMessages(db, T_STUDIO.id, [
    { from_email: 'accounts@studio.test', to_emails: ['rates@council.ie'],
      created_at: '2026-08-12T09:10:00Z', is_internal_note: false, forwarded_message_id: null },
    { from_email: 'eleanor@council.ie', to_emails: ['accounts@studio.test'],
      created_at: '2026-08-12T10:06:00Z', is_internal_note: false, forwarded_message_id: null },
  ])
  const res = await GET(req(`/api/email/tickets/${T_STUDIO.id}`), ctx(T_STUDIO.id))
  const body = await res.json()
  expect(body.data.reply_recipients.to).toContain('rates@council.ie')
  expect(body.data.reply_recipients.to).toContain('eleanor@council.ie')
  expect(body.data.reply_recipients.over_cap).toBe(false)
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run "src/app/api/email/tickets/[id]/route.test.js" -t "not on the newest message"
```

Expected: FAIL — `to` contains only `eleanor@council.ie`.

- [ ] **Step 3: Replace the derivation**

In `src/app/api/email/tickets/[id]/route.js`, replace the `threadParticipants(latestCorrespondence(...))` block with:

```js
  // EMAIL-PARTICIPANTS.4 — derived through the SAME helper and the SAME window
  // the reply route uses, so "Reply All (4 people)" and the send cannot
  // disagree. Deliberately its own query rather than reusing `messagesDesc`:
  // that list is capped for RENDERING (MESSAGE_LIMIT) and a ticket longer than
  // the render cap would otherwise derive a narrower audience here than at send
  // time — the disagreement this comment has always promised cannot happen.
  const own = await loadOwnAddresses(db)
  let replyRecipients = null
  if (!own.response) {
    const { data: participantRows, error: participantErr } = await loadParticipantMessages(db, ticket.id)
    if (participantErr) {
      console.error('[tickets/:id] participant lookup failed:', participantErr.message)
      return NextResponse.json({ success: false, error: participantErr.message }, { status: 500 })
    }
    replyRecipients = resolveReplyAudience({
      messages: participantRows || [],
      ticket,
      ownAddresses: own.addresses,
    })
  }
```

Update the imports at the top of the file: drop `threadParticipants` and `latestCorrespondence` if they now have no other caller in this file; add `loadParticipantMessages` and `resolveReplyAudience` from `../_helpers`.

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run "src/app/api/email/tickets/[id]/route.test.js"
```

Expected: PASS. If a pre-existing test asserted the old latest-message-only behaviour, **update it and note in the commit that the old expectation encoded the bug** — a test can encode a defect (this repo has hit that before, #1257).

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/email/tickets/[id]/route.js" "src/app/api/email/tickets/[id]/route.test.js"
git commit -m "EMAIL-PARTICIPANTS.4 — detail route derives the thread-wide audience"
```

---

## Task 5: Reply route — same derivation, refuse empty, refuse over cap

**Files:**
- Modify: `src/app/api/email/tickets/[id]/reply/route.js` (:45 `RECIPIENT_SCAN_LIMIT`, :262-291)
- Test: `src/app/api/email/tickets/[id]/reply/route.test.js`

- [ ] **Step 1: Write the failing tests**

```js
it('sends to everyone on the thread, not just the newest correspondent', async () => {
  const db = makeDb()
  seedTicket(db, T_STUDIO)
  seedMessages(db, T_STUDIO.id, [
    { from_email: 'accounts@studio.test', to_emails: ['rates@council.ie'],
      created_at: '2026-08-12T09:10:00Z', is_internal_note: false, forwarded_message_id: null },
    { from_email: 'eleanor@council.ie', to_emails: ['accounts@studio.test'],
      created_at: '2026-08-12T10:06:00Z', is_internal_note: false, forwarded_message_id: null },
  ])
  const res = await POST(req({ body: 'thanks' }), ctx(T_STUDIO.id))
  expect(res.status).toBe(200)
  expect(sentTo(db)).toEqual(expect.arrayContaining(['rates@council.ie', 'eleanor@council.ie']))
})

it('400s rather than sending when every participant has been removed', async () => {
  const db = makeDb()
  seedTicket(db, { ...T_STUDIO, excluded_participants: ['member@x.com'] })
  seedMessages(db, T_STUDIO.id, [
    { from_email: 'member@x.com', to_emails: ['accounts@studio.test'],
      created_at: '2026-08-12T09:00:00Z', is_internal_note: false, forwarded_message_id: null },
  ])
  const res = await POST(req({ body: 'hello' }), ctx(T_STUDIO.id))
  expect(res.status).toBe(400)
  expect((await res.json()).error).toMatch(/no recipients/i)
  expect(sentCount(db)).toBe(0)
})

it('400s rather than truncating when the audience exceeds the cap', async () => {
  const db = makeDb()
  seedTicket(db, T_STUDIO)
  seedMessages(db, T_STUDIO.id, Array.from({ length: 30 }, (_, i) => ({
    from_email: `p${i}@x.com`, to_emails: ['accounts@studio.test'],
    created_at: `2026-08-12T09:00:${String(i).padStart(2, '0')}Z`,
    is_internal_note: false, forwarded_message_id: null,
  })))
  const res = await POST(req({ body: 'hello' }), ctx(T_STUDIO.id))
  expect(res.status).toBe(400)
  expect((await res.json()).error).toMatch(/25/)
  expect(sentCount(db)).toBe(0)
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run "src/app/api/email/tickets/[id]/reply/route.test.js" -t "everyone on the thread"
```

Expected: FAIL — only `eleanor@council.ie` received.

- [ ] **Step 3: Implement**

In `reply/route.js`: delete the `RECIPIENT_SCAN_LIMIT` constant (:45) and replace the second half of the `Promise.all` with `loadParticipantMessages(db, ticket.id)`. Keep the `lastInbound` query exactly as it is — threading still keys on the last inbound and is out of scope.

Then replace the audience block:

```js
  // ── Who this reaches (EMAIL-PARTICIPANTS.5) ───────────────────────
  const audience = resolveReplyAudience({
    messages: recentMessages || [],
    ticket,
    ownAddresses: own.addresses,
  })
  // NOTHING HAS BEEN SENT YET, so both refusals are free — and both exist
  // because the alternative is a send that silently reaches the wrong set.
  if (audience.empty) {
    return NextResponse.json({
      success: false,
      error: 'This ticket has no recipients left — restore one to reply.',
    }, { status: 400 })
  }
  if (audience.over_cap) {
    return NextResponse.json({
      success: false,
      error: `This thread has ${audience.to.length} recipients and the limit is ${MAX_RECIPIENTS}. Remove some before replying.`,
    }, { status: 400 })
  }
  const derivedTo = audience.to

  const recipients = resolveRecipients({
    to: [...derivedTo, ...extraTo],
```

Update imports: drop `threadParticipants` / `latestCorrespondence` if unused here; add `resolveReplyAudience`, `loadParticipantMessages` from `../../_helpers` and `MAX_RECIPIENTS` from `@/lib/email-recipients`.

- [ ] **Step 4: Run to verify they pass**

```bash
npx vitest run "src/app/api/email/tickets/[id]/reply/route.test.js"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/email/tickets/[id]/reply/route.js" "src/app/api/email/tickets/[id]/reply/route.test.js"
git commit -m "EMAIL-PARTICIPANTS.5 — reply sends thread-wide; refuse empty and over-cap"
```

---

## Task 6: The participants route

**Files:**
- Create: `src/app/api/email/tickets/[id]/participants/route.js`
- Test: `src/app/api/email/tickets/[id]/participants/route.test.js`

- [ ] **Step 1: Write the failing tests**

```js
it('removes an address and normalises it on write', async () => {
  const db = makeDb(); seedTicket(db, T_STUDIO)
  const res = await PATCH(req({ remove: ['Rates@Council.IE'] }), ctx(T_STUDIO.id))
  expect(res.status).toBe(200)
  expect(ticketRow(db, T_STUDIO.id).excluded_participants).toEqual(['rates@council.ie'])
})

it('restore removes it from the exclusion list', async () => {
  const db = makeDb(); seedTicket(db, { ...T_STUDIO, excluded_participants: ['rates@council.ie'] })
  const res = await PATCH(req({ restore: ['rates@council.ie'] }), ctx(T_STUDIO.id))
  expect(res.status).toBe(200)
  expect(ticketRow(db, T_STUDIO.id).excluded_participants).toEqual([])
})

it('is idempotent — removing twice does not duplicate', async () => {
  const db = makeDb(); seedTicket(db, { ...T_STUDIO, excluded_participants: ['rates@council.ie'] })
  await PATCH(req({ remove: ['rates@council.ie'] }), ctx(T_STUDIO.id))
  expect(ticketRow(db, T_STUDIO.id).excluded_participants).toEqual(['rates@council.ie'])
})

it('400s on an unusable address', async () => {
  const db = makeDb(); seedTicket(db, T_STUDIO)
  const res = await PATCH(req({ remove: ['not-an-address'] }), ctx(T_STUDIO.id))
  expect(res.status).toBe(400)
})

it('404s for a caller who cannot open the ticket', async () => {
  const db = makeDb(); seedTicket(db, T_OTHER_LOCATION)
  const res = await PATCH(req({ remove: ['a@x.com'] }), ctx(T_OTHER_LOCATION.id))
  expect(res.status).toBe(404)
})
```

Use the **real** permission resolver in this test file — do not mock `hasPermission`. Six email route test files once mocked it and the gate never ran (#1266).

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run "src/app/api/email/tickets/[id]/participants/route.test.js"
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// EMAIL-PARTICIPANTS.6 — take an address off a ticket's reply audience, or put
// it back. The set itself is derived from the messages on every read; this
// route writes only the operator's subtractions (mig 534).
//
// THE GATE IS loadTicketForUser, not a check in this handler. A ticket's
// location is not knowable until the row is read, so a per-route hasPermission
// resolves at the CALLER'S ACTIVE location and lets someone with email_inbox at
// one studio act on another studio's mail (#1266). Refusals are 404, not 403 —
// a 403 after the row is read is an existence oracle.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody } from '@/lib/schemas'
import { normalizeAddressList } from '@/lib/email-recipients'
import { loadTicketForUser } from '../../_helpers'

const schema = z.object({
  remove: z.array(z.string()).max(25).optional(),
  restore: z.array(z.string()).max(25).optional(),
}).refine(v => v.remove?.length || v.restore?.length, {
  message: 'Name at least one address to remove or restore',
})

export async function PATCH(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const parsed = await validateBody(request, schema)
  if (!parsed.success) return parsed.response

  const db = createServerClient()
  const { id } = await params
  const loaded = await loadTicketForUser(db, user, id)
  if (loaded.response) return loaded.response
  const { ticket } = loaded

  const remove = normalizeAddressList(parsed.data.remove || [])
  const restore = normalizeAddressList(parsed.data.restore || [])
  const invalid = [...remove.invalid, ...restore.invalid]
  if (invalid.length) {
    return NextResponse.json({
      success: false,
      error: `Not a valid email address: ${invalid.slice(0, 5).join(', ')}`,
    }, { status: 400 })
  }

  // Normalised on write so a case variant cannot dodge an exclusion later.
  const restoreSet = new Set(restore.valid)
  const next = [
    ...new Set([
      ...(ticket.excluded_participants || []).filter(a => !restoreSet.has(a)),
      ...remove.valid,
    ]),
  ]

  const { error } = await db.from('email_tickets')
    .update({ excluded_participants: next, updated_at: new Date().toISOString() })
    .eq('id', ticket.id)
  if (error) {
    console.error('[tickets/:id/participants] update failed:', error.message)
    return NextResponse.json({ success: false, error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { excluded_participants: next } })
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
npx vitest run "src/app/api/email/tickets/[id]/participants/route.test.js"
npm run check:route-guards
```

Expected: tests PASS; route-guards PASS (the guard is `loadTicketForUser`, already on the script's recognised list).

- [ ] **Step 5: Register in openapi**

Add the route to `src/lib/openapi.js` following the neighbouring email-ticket route entries.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/email/tickets/[id]/participants" src/lib/openapi.js
git commit -m "EMAIL-PARTICIPANTS.6 — PATCH participants: sticky remove/restore"
```

---

## Task 7: Recipient chips in the composer

**Files:**
- Modify: `src/components/tickets/TicketReplyBox.jsx`
- Test: `src/components/tickets/TicketReplyBox.participants.test.jsx` (create)

This repo **does** have a jsdom + testing-library idiom (`Modal.focus.test.jsx`), despite a stale "no jsdom" comment in `RecipientEditor.test.jsx`.

- [ ] **Step 1: Write the failing test**

```jsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import TicketReplyBox from './TicketReplyBox'

const ticket = { id: 't1', requester_email: 'member@x.com', status: 'open' }

describe('TicketReplyBox recipients', () => {
  it('shows every derived recipient as a chip', () => {
    render(<TicketReplyBox ticket={ticket} replyRecipients={{ to: ['a@x.com', 'b@x.com'], mode: 'reply_all', over_cap: false }} onSend={vi.fn()} />)
    expect(screen.getByText('a@x.com')).toBeTruthy()
    expect(screen.getByText('b@x.com')).toBeTruthy()
  })

  it('calls onRemoveRecipient when a chip is dismissed', () => {
    const onRemoveRecipient = vi.fn()
    render(<TicketReplyBox ticket={ticket} replyRecipients={{ to: ['a@x.com'], mode: 'reply', over_cap: false }} onSend={vi.fn()} onRemoveRecipient={onRemoveRecipient} />)
    fireEvent.click(screen.getByRole('button', { name: /remove a@x.com/i }))
    expect(onRemoveRecipient).toHaveBeenCalledWith('a@x.com')
  })

  it('blocks send and explains when over the cap', () => {
    const onSend = vi.fn()
    render(<TicketReplyBox ticket={ticket} replyRecipients={{ to: Array.from({ length: 30 }, (_, i) => `p${i}@x.com`), mode: 'reply_all', over_cap: true }} onSend={onSend} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'hi' } })
    fireEvent.click(screen.getByRole('button', { name: /reply/i }))
    expect(onSend).not.toHaveBeenCalled()
    expect(screen.getByText(/remove some/i)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/components/tickets/TicketReplyBox.participants.test.jsx
```

Expected: FAIL — no chips rendered.

- [ ] **Step 3: Implement**

Add `onRemoveRecipient` to the props destructuring. Add `overCap` beside the existing `filesBlockNote` derivation:

```jsx
  const overCap = !isNote && !!replyRecipients?.over_cap
```

Add `if (overCap) return` to `handleSubmit`, directly below the existing `if (uploading || filesBlockNote) return`.

Render this block immediately above the textarea, inside the `<form>`:

```jsx
      {!isNote && lockedTo.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-un1t-muted">To</span>
          {lockedTo.map(address => (
            <span
              key={address}
              className="inline-flex items-center gap-1 rounded-full bg-un1t-border/40 px-2 py-0.5 text-[11px] text-un1t-subtle"
            >
              {address}
              {/* Removal is the ONLY edit offered. Adding an arbitrary address
                  belongs to compose and forward — keeping the audience derived
                  is what stops a reply quietly reaching someone the thread
                  never included. A one-person thread keeps its × so the last
                  recipient can still be removed deliberately; the reply route
                  then refuses the send rather than mailing them anyway. */}
              {onRemoveRecipient && (
                <button
                  type="button"
                  aria-label={`Remove ${address}`}
                  onClick={() => onRemoveRecipient(address)}
                  className="text-un1t-muted hover:text-un1t-fg"
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {overCap && (
        <p className="mb-2 text-[11px] text-amber-700">
          This thread has {lockedTo.length} recipients and the limit is 25. Remove some before replying.
        </p>
      )}
```

**`type="button"` is mandatory** — every `<button>` inside a `<form>` defaults to `type="submit"`, and this component is a `<form>`. `check:guardrails` (`no-untyped-button-in-form`) enforces it.

The amber text is `-700`, not `-300`/`-400`: `check:guardrails` (`no-low-contrast-accent-text`) rejects low ramps on light surfaces, and the Communications area is on its armed path list.

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run src/components/tickets/TicketReplyBox.participants.test.jsx
npm run lint
```

Expected: both PASS.

- [ ] **Step 5: Wire the handler in `TicketThread.jsx`**

`onRemoveRecipient` PATCHes `/api/email/tickets/<id>/participants` with `{ remove: [address] }` and then refreshes the thread. On failure, surface the error and leave the chip in place — a chip that disappears without the write landing is a lie about who the next reply reaches.

- [ ] **Step 6: Commit**

```bash
git add src/components/tickets/TicketReplyBox.jsx src/components/tickets/TicketReplyBox.participants.test.jsx src/components/tickets/TicketThread.jsx
git commit -m "EMAIL-PARTICIPANTS.7 — recipient chips with sticky remove"
```

---

## Task 8: The ticket reads like a mail thread

**Files:**
- Modify: `src/components/tickets/TicketThread.jsx`
- Test: `src/components/tickets/TicketThread.participants.test.jsx` (create)

- [ ] **Step 1: Write the failing test**

```jsx
it('marks the message where a new participant joined', () => {
  render(<TicketThread ticket={{ id: 't1', requester_email: 'rates@council.ie', status: 'open' }}
    messages={[
      { id: 'm1', direction: 'outbound', from_email: 'accounts@studio.test', to_emails: ['rates@council.ie'], created_at: '2026-08-12T09:10:00Z', text_body: 'hello' },
      { id: 'm2', direction: 'inbound', from_email: 'eleanor@council.ie', to_emails: ['accounts@studio.test'], created_at: '2026-08-12T10:06:00Z', text_body: 'hi' },
    ]} />)
  expect(screen.getByText(/eleanor@council\.ie joined this thread/i)).toBeTruthy()
})

it('names the live correspondent in the header, not only the requester', () => {
  render(<TicketThread ticket={{ id: 't1', requester_email: 'rates@council.ie', status: 'open' }}
    replyRecipients={{ to: ['eleanor@council.ie', 'rates@council.ie'], mode: 'reply_all', over_cap: false }}
    messages={[]} />)
  expect(screen.getByText(/eleanor@council\.ie/)).toBeTruthy()
  expect(screen.getByText(/opened by/i)).toBeTruthy()
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/components/tickets/TicketThread.participants.test.jsx
```

Expected: FAIL — neither string present.

- [ ] **Step 3: Implement**

Add a pure helper in `src/lib/email-tickets.js` (it is the module for pure ticket rules, and this keeps the component logic-free):

```js
/**
 * The message id at which each address first appears on the thread, so the UI
 * can say WHERE someone joined. Derived, never stored — first appearance is a
 * property of the messages that arrived.
 *
 * Internal notes and forwards are skipped for the same reason they are skipped
 * when building the audience: a note names nobody, and a forward shows the
 * thread to someone rather than adding them to it.
 *
 * @param {object[]} messages  ascending by created_at
 * @returns {Map<string, string[]>}  message id → addresses first seen there
 */
export function joinPointsByMessage(messages) {
  const seen = new Set()
  const out = new Map()
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.is_internal_note || m.forwarded_message_id) continue
    const here = []
    for (const raw of [m.from_email, ...(m.to_emails || []), ...(m.cc_emails || [])]) {
      const a = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
      if (!a || seen.has(a)) continue
      seen.add(a)
      here.push(a)
    }
    if (here.length) out.set(m.id, here)
  }
  return out
}
```

Test it in `src/lib/email-tickets.test.js` alongside the existing pure-rule tests.

In `TicketThread.jsx`:
- Header: render the live participant list from `replyRecipients.to`. Show `Opened by <requester_email>` **only** when the requester is not the first entry — otherwise it is noise on every ordinary ticket.
- Per message: a collapsed `From / To / Cc` line, expandable.
- Where `joinPointsByMessage` has entries for a message, render `<address> joined this thread`.

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run src/components/tickets/TicketThread.participants.test.jsx src/lib/email-tickets.test.js
npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/tickets/TicketThread.jsx src/components/tickets/TicketThread.participants.test.jsx src/lib/email-tickets.js src/lib/email-tickets.test.js
git commit -m "EMAIL-PARTICIPANTS.8 — thread shows live participants and join points"
```

---

## Task 9: Mobile stops lying about the audience

The mobile footer says "Sends an email to \<requester\>" while every reply is reply-all. `reply_recipients` is already in the GET payload and `getTicket()` drops it.

**Files:**
- Modify: `mobile/lib/email-api.js`, `mobile/app/email/[ticketId].jsx`
- Test: `mobile/lib/email-api.test.js`

**Mobile cannot import `src/lib`** — `shared/` is the seam. This change needs no shared code; it passes a field through and renders it.

- [ ] **Step 1: Write the failing test**

```js
it('passes reply_recipients through getTicket', async () => {
  mockApi({ data: { ticket: { id: 't1' }, messages: [], reply_recipients: { to: ['a@x.com', 'b@x.com'], mode: 'reply_all', over_cap: false } } })
  const out = await getTicket('t1')
  expect(out.reply_recipients.to).toEqual(['a@x.com', 'b@x.com'])
})
```

Mock `./api` **before** importing the module under test, or the RN runtime loads.

- [ ] **Step 2: Run to verify it fails**

```bash
cd mobile && npx vitest run lib/email-api.test.js -t reply_recipients
```

Expected: FAIL — `reply_recipients` undefined.

- [ ] **Step 3: Implement**

Include `reply_recipients` in the object `getTicket()` returns. In `mobile/app/email/[ticketId].jsx`, replace the hard-coded requester footer with the real list, read-only — no chip editing on mobile. When `over_cap` is true, show the same explanation and disable send.

- [ ] **Step 4: Run to verify it passes**

```bash
cd mobile && npx vitest run lib/email-api.test.js
cd .. && npm run check:mobile-imports && npm run check:mobile-lint
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/email-api.js mobile/lib/email-api.test.js "mobile/app/email/[ticketId].jsx"
git commit -m "EMAIL-PARTICIPANTS.9 — mobile shows the real reply audience"
```

---

## Task 10: Contact attribution — drop the header-based link

**Files:**
- Modify: `src/app/api/webhooks/postmark-inbound/[token]/route.js:596-611` and the `if (!contactId)` guard at :668
- Test: `src/app/api/webhooks/postmark-inbound/[token]/route.test.js`

- [ ] **Step 1: Write the failing test**

```js
it('does not inherit a contact from a threading header the sender supplied', async () => {
  const db = makeDb()
  seedMailbox(db, { address: 'accounts@studio.test', location_id: LOC })
  seedEmailSend(db, { postmark_message_id: 'send-1', contact_id: 'contact-member' })
  const res = await POST(inbound({
    From: 'stranger@third.com',
    To: 'accounts@studio.test',
    Headers: [{ Name: 'References', Value: '<send-1@mtasv.net>' }],
  }), ctx())
  expect(res.status).toBe(200)
  expect(lastMessage(db).contact_id).toBeNull()
})

it('still links when the From address matches a contact', async () => {
  const db = makeDb()
  seedMailbox(db, { address: 'accounts@studio.test', location_id: LOC })
  seedContact(db, { id: 'contact-member', email: 'member@x.com', location_id: LOC })
  const res = await POST(inbound({ From: 'member@x.com', To: 'accounts@studio.test' }), ctx())
  expect(res.status).toBe(200)
  expect(lastMessage(db).contact_id).toBe('contact-member')
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run "src/app/api/webhooks/postmark-inbound/[token]/route.test.js" -t "threading header the sender supplied"
```

Expected: FAIL — `contact_id` is `contact-member`.

- [ ] **Step 3: Implement**

Delete the `email_sends` **contact** lookup at :596-611 and remove the `if (!contactId)` guard at :668 so the `From`-address lookup always runs. Keep `matchedVia = 'in_reply_to'` where the thread matched on a header — the diagnostic is unchanged. Replace the block's comment with:

```js
  // (a) matched_via only. EMAIL-PARTICIPANTS.10 removed the CONTACT link that
  // used to be taken from here.
  //
  // The header is supplied by the sender. "From matches no contact, and a
  // threading header names a send to contact X" describes BOTH a member writing
  // in from a second address AND a stranger who was forwarded our mail — the
  // code cannot tell them apart, and one of those outcomes writes a third
  // party's correspondence onto a member's timeline and into their DSAR export.
  // An unlinked message is honest; a wrongly-linked one is a data-integrity
  // breach. Threading and identity are separate questions; conflating them was
  // the error. Contact linkage is now the From address or nothing.
```

If nothing else in the route reads the `email_sends` row, drop the query entirely so a failed lookup can no longer 500 an inbound email.

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run "src/app/api/webhooks/postmark-inbound/[token]/route.test.js"
```

Expected: PASS. Update any existing test that asserted the old inheritance and say so in the commit.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/webhooks/postmark-inbound/[token]/route.js" "src/app/api/webhooks/postmark-inbound/[token]/route.test.js"
git commit -m "EMAIL-PARTICIPANTS.10 — contact linkage is the From address or nothing"
```

---

## Task 11: Full verification and PR

- [ ] **Step 1: Run the CI mirror — all nine**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails
```

Expected: all PASS.

- [ ] **Step 2: Run the build**

```bash
npm run build
```

Expected: PASS. This is the only check that catches import-resolution and Turbopack failures — vitest runs on mocked imports, and this task added a new route.

- [ ] **Step 3: Update the changelog**

Add an entry to `docs/CHANGELOG.md` in the established numbered style.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin HEAD
```

Then `gh pr create --base main --fill`, and **report the PR URL**. Pushing is not shipping.

---

## Manual verification after merge

The live rates ticket `46a5cf37` is the natural check. Open it and confirm:

1. The header names Eleanor as the live correspondent and shows `Opened by ratesoffice@dublincity.ie`.
2. The 10:06 message carries *"eleanor.brennan@dublincity.ie joined this thread"*.
3. The composer shows **two** chips — Eleanor and `ratesoffice@` — where today a reply would reach Eleanor alone.
4. Removing the `ratesoffice@` chip persists across a reload.

Do not send a live reply to Dublin City Council to test this.
