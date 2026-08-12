# Email Ticket Merge Implementation Plan (PR 2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold two tickets that are really one conversation into a single thread, reversibly.

**Architecture:** The source ticket's messages are reparented to the target and stamped with `merged_from_ticket_id`, so unmerge restores exactly those rows. The source stays as a tombstone — `status='closed'` plus `merged_into_id` — rather than gaining a fifth status value, and one shared query helper hides tombstones from every list and count.

**Tech Stack:** Next.js 16 App Router, Supabase (service-role routes, RLS-bypassing), Vitest, React 19. Spec: `docs/superpowers/specs/2026-08-12-email-thread-participants-design.md`.

**Depends on:** nothing in PR 1. Can be built and merged independently.

---

## Background the engineer needs

- **The gate lives inside `loadTicketForUser`** (`src/app/api/email/tickets/_helpers.js:285`), never as a per-route `hasPermission` — that resolves at the caller's *active* location and grants access to another studio's mail (#1266). Merge touches **two** tickets, so it must load **both** through it. Refusals are **404**, not 403.
- **Nothing auto-closes** (Richard, 06 Aug). Merge is not a loophole: the operator closes the source by merging it. Do not add a sweep, cron or timer.
- **`email_ticket_attachments` keys on `message_id`, not `ticket_id`** — reparenting messages carries attachments with them. Nothing to migrate.
- **Quota is untouched.** Bytes were metered against the delivering mailbox at arrival (`add_email_storage_bytes`); merging moves no bytes, so do not adjust `email_storage_usage`.
- **supabase-js has no transactions across statements.** Order the writes so a crash between them leaves a state the next attempt can finish, and make each step idempotent.

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/536_email_ticket_merge.sql` | **Create.** Tombstone columns, the reparent stamp, two indexes. |
| `src/lib/email-ticket-merge.js` | **Create.** Pure rules: what may merge into what, and the merged denormalised fields. |
| `src/lib/email-ticket-merge.test.js` | **Create.** Those rules. |
| `src/app/api/email/tickets/_helpers.js` | **Modify.** Add `scopeToUnmerged(query)` — the single place tombstones are hidden. |
| `src/app/api/email/tickets/[id]/merge/route.js` | **Create.** `POST` merge, `DELETE` unmerge. |
| `src/app/api/email/tickets/route.js` | **Modify.** Apply `scopeToUnmerged` at :109. |
| `src/app/api/email/tickets/count/route.js` | **Modify.** Apply `scopeToUnmerged` at :78. |
| `src/app/api/email/tickets/[id]/route.js` | **Modify.** Return `merged_into_id` so the UI redirects. |
| `src/components/tickets/TicketMerge.jsx` | **Create.** Picker + confirm dialog. |
| `src/components/tickets/TicketThread.jsx` | **Modify.** "Merge into…" action; merged banner with Undo. |

---

## Task 1: Migration

**Files:**
- Create: `supabase/migrations/536_email_ticket_merge.sql`

534 is taken by PR 1; **535 was taken by `535_email_hygiene_release.sql` (HYGREL.1) while PR 1 was in flight**, which is exactly why this number is checked rather than assumed. **Confirm 536 is still free** against the live `supabase_migrations.schema_migrations` before writing the file — another branch may have landed in the meantime.

- [ ] **Step 1: Write the migration**

```sql
-- 536 — EMAIL-MERGE.1
-- Two tickets that are really one conversation, folded reversibly.
--
-- WHY status STAYS 'open|pending|solved|closed'
-- A fifth value would have to be audited through every view filter, the count
-- endpoint, the mobile status picker and the needs-reply badge, and this estate
-- has been bitten by a new enum value leaking past a filter that keyed on the
-- old set. A merged ticket is CLOSED plus a pointer; tombstones are hidden by
-- one shared query helper instead.
--
-- WHY THE STAMP ON THE MESSAGES
-- merged_from_ticket_id records which rows moved, so unmerge restores exactly
-- those and nothing else — including on a ticket that had already absorbed a
-- different merge.
alter table email_tickets
  add column if not exists merged_into_id uuid references email_tickets(id),
  add column if not exists merged_at      timestamptz,
  add column if not exists merged_by      uuid references profiles(id);

alter table email_inbox_messages
  add column if not exists merged_from_ticket_id uuid references email_tickets(id);

-- An FK needs its own column LEADING an index, or get_advisors(performance)
-- reports an unindexed foreign key — the mig 496/497 lesson.
create index if not exists idx_email_tickets_merged_into
  on email_tickets (merged_into_id);
create index if not exists idx_email_msgs_merged_from
  on email_inbox_messages (merged_from_ticket_id);

comment on column email_tickets.merged_into_id is
  'Set when this ticket was folded into another (mig 536). Non-null = tombstone: hidden from lists, opening it redirects to the survivor.';
```

- [ ] **Step 2: Apply via Supabase MCP**

`apply_migration` against `iyvtbjjxdggiadzwwvdj` (un1t-crm — **not** sentinel `tpttqakxmyxrwnqjepfm`). Name: `536_email_ticket_merge`.

- [ ] **Step 3: Verify**

```sql
select column_name from information_schema.columns
where (table_name = 'email_tickets' and column_name like 'merged%')
   or (table_name = 'email_inbox_messages' and column_name = 'merged_from_ticket_id');
```

Expected: four rows.

- [ ] **Step 4: Run both advisors**

`get_advisors` `type=security` then `type=performance`. Expected: **no unindexed-foreign-key finding** on either new FK — that is what the two indexes are for. An INFO-level unused-index note on a brand-new index is expected and fine.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/536_email_ticket_merge.sql
git commit -m "EMAIL-MERGE.1 — mig 536: reversible ticket merge columns"
```

---

## Task 2: The pure rules

**Files:**
- Create: `src/lib/email-ticket-merge.js`, `src/lib/email-ticket-merge.test.js`

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest'
import { canMerge, mergedTicketFields } from './email-ticket-merge'

const T = (over = {}) => ({
  id: 'a', location_id: 'loc-1', merged_into_id: null,
  unread_count: 0, first_response_at: null,
  last_message_at: '2026-08-01T00:00:00Z', last_message_direction: 'inbound',
  last_message_preview: 'hi', ...over,
})

describe('canMerge', () => {
  it('allows two ordinary tickets at the same location', () => {
    expect(canMerge(T({ id: 'a' }), T({ id: 'b' }))).toEqual({ ok: true })
  })

  it('refuses merging a ticket into itself', () => {
    expect(canMerge(T({ id: 'a' }), T({ id: 'a' })).ok).toBe(false)
  })

  it('refuses across locations', () => {
    expect(canMerge(T({ id: 'a' }), T({ id: 'b', location_id: 'loc-2' })).ok).toBe(false)
  })

  // Chains would make unmerge inexact: the second unmerge could not tell which
  // rows belonged to which source.
  it('refuses a source that is already merged', () => {
    expect(canMerge(T({ id: 'a', merged_into_id: 'c' }), T({ id: 'b' })).ok).toBe(false)
  })

  it('refuses merging INTO a tombstone', () => {
    expect(canMerge(T({ id: 'a' }), T({ id: 'b', merged_into_id: 'c' })).ok).toBe(false)
  })

  it('refuses a missing ticket', () => {
    expect(canMerge(null, T()).ok).toBe(false)
    expect(canMerge(T(), null).ok).toBe(false)
  })
})

describe('mergedTicketFields', () => {
  it('sums unread counts', () => {
    const out = mergedTicketFields(T({ id: 'src', unread_count: 2 }), T({ id: 'tgt', unread_count: 3 }))
    expect(out.unread_count).toBe(5)
  })

  it('keeps the EARLIER first response — it is a support metric', () => {
    const out = mergedTicketFields(
      T({ first_response_at: '2026-08-01T00:00:00Z' }),
      T({ first_response_at: '2026-08-05T00:00:00Z' }),
    )
    expect(out.first_response_at).toBe('2026-08-01T00:00:00Z')
  })

  it('takes the earlier value when only the source has one', () => {
    const out = mergedTicketFields(T({ first_response_at: '2026-08-01T00:00:00Z' }), T({ first_response_at: null }))
    expect(out.first_response_at).toBe('2026-08-01T00:00:00Z')
  })

  it('adopts the newer last-message trio wholesale', () => {
    const out = mergedTicketFields(
      T({ last_message_at: '2026-08-09T00:00:00Z', last_message_direction: 'outbound', last_message_preview: 'newer' }),
      T({ last_message_at: '2026-08-02T00:00:00Z', last_message_direction: 'inbound', last_message_preview: 'older' }),
    )
    expect(out.last_message_at).toBe('2026-08-09T00:00:00Z')
    expect(out.last_message_direction).toBe('outbound')
    expect(out.last_message_preview).toBe('newer')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run src/lib/email-ticket-merge.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// EMAIL-MERGE.1 — pure rules for folding one ticket into another.
//
// Pure (no DB, no clock, no env) so the refusals can be tested exhaustively
// rather than inferred from a route's control flow — the same argument
// email-recipients.js is built on.

/**
 * May `source` be folded into `target`?
 *
 * @param {object|null} source
 * @param {object|null} target
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function canMerge(source, target) {
  if (!source?.id || !target?.id) return { ok: false, reason: 'missing_ticket' }
  if (source.id === target.id) return { ok: false, reason: 'same_ticket' }
  // Location scoping is the whole tenancy model here; a cross-studio merge
  // would move one studio's correspondence into another's inbox.
  if (source.location_id !== target.location_id) return { ok: false, reason: 'different_location' }
  // Chains are refused so unmerge stays exact: with A→B→C, unmerging B could
  // not tell A's rows from B's own.
  if (source.merged_into_id) return { ok: false, reason: 'source_already_merged' }
  if (target.merged_into_id) return { ok: false, reason: 'target_is_merged' }
  return { ok: true }
}

/**
 * The target's fields after absorbing the source.
 *
 * first_response_at takes the EARLIER of the two: it measures how long the
 * person waited for a human, and merging two records of one conversation does
 * not make that wait longer.
 */
export function mergedTicketFields(source, target) {
  const at = (v) => (v ? Date.parse(v) : NaN)
  const earlier = (a, b) => {
    if (!a) return b || null
    if (!b) return a
    return at(a) <= at(b) ? a : b
  }
  const sourceIsNewer = (at(source?.last_message_at) || 0) > (at(target?.last_message_at) || 0)
  const newest = sourceIsNewer ? source : target

  return {
    unread_count: (source?.unread_count || 0) + (target?.unread_count || 0),
    first_response_at: earlier(source?.first_response_at, target?.first_response_at),
    last_message_at: newest?.last_message_at ?? null,
    last_message_direction: newest?.last_message_direction ?? null,
    last_message_preview: newest?.last_message_preview ?? null,
  }
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
npx vitest run src/lib/email-ticket-merge.test.js
```

Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/email-ticket-merge.js src/lib/email-ticket-merge.test.js
git commit -m "EMAIL-MERGE.2 — pure merge eligibility and field resolution"
```

---

## Task 3: Hide tombstones in one place

**Files:**
- Modify: `src/app/api/email/tickets/_helpers.js`, `src/app/api/email/tickets/route.js:109`, `src/app/api/email/tickets/count/route.js:78`

- [ ] **Step 1: Write the failing test**

Add to `src/app/api/email/tickets/route.test.js`:

```js
it('omits merged tickets from the list', async () => {
  const db = makeDb()
  seedTicket(db, { ...T_STUDIO, id: 'live', merged_into_id: null })
  seedTicket(db, { ...T_STUDIO, id: 'folded', merged_into_id: 'live' })
  const res = await GET(req('/api/email/tickets'), ctx())
  const ids = (await res.json()).data.tickets.map(t => t.id)
  expect(ids).toContain('live')
  expect(ids).not.toContain('folded')
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/app/api/email/tickets/route.test.js -t "omits merged"
```

Expected: FAIL — `folded` present.

- [ ] **Step 3: Implement**

In `_helpers.js`, beside the existing `scopeToVisibleMailboxes` / `scopeToNeedsReply`:

```js
/**
 * Hide merged-away tickets.
 *
 * ONE definition, applied by every surface that lists or counts tickets. A
 * tombstone missed by a filter shows up as an ordinary closed ticket — which is
 * the duplicate this feature exists to remove, wearing a different hat.
 */
export function scopeToUnmerged(query) {
  return query.is('merged_into_id', null)
}
```

Apply it at `src/app/api/email/tickets/route.js:109` and `src/app/api/email/tickets/count/route.js:78`, alongside the existing scoping calls.

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run src/app/api/email/tickets/route.test.js src/app/api/email/tickets/count/route.test.js
npm run check:location-scoping
```

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/email/tickets/_helpers.js src/app/api/email/tickets/route.js src/app/api/email/tickets/count/route.js src/app/api/email/tickets/route.test.js
git commit -m "EMAIL-MERGE.3 — scopeToUnmerged hides tombstones from lists and counts"
```

---

## Task 4: The merge route

**Files:**
- Create: `src/app/api/email/tickets/[id]/merge/route.js`, `src/app/api/email/tickets/[id]/merge/route.test.js`

Use the **real** permission resolver in the test file — do not mock `hasPermission` (#1266).

- [ ] **Step 1: Write the failing tests**

```js
it('reparents the source messages and tombstones the source', async () => {
  const db = makeDb()
  seedTicket(db, { ...T_STUDIO, id: 'target', unread_count: 1 })
  seedTicket(db, { ...T_STUDIO, id: 'source', unread_count: 2 })
  seedMessages(db, 'source', [{ id: 'm1' }, { id: 'm2' }])
  const res = await POST(req({ into: 'target' }), ctx('source'))
  expect(res.status).toBe(200)
  expect(messageRows(db, 'target').map(m => m.id).sort()).toEqual(['m1', 'm2'])
  expect(messageRows(db, 'target').every(m => m.merged_from_ticket_id === 'source')).toBe(true)
  const src = ticketRow(db, 'source')
  expect(src.merged_into_id).toBe('target')
  expect(src.status).toBe('closed')
  expect(src.unread_count).toBe(0)
  expect(ticketRow(db, 'target').unread_count).toBe(3)
})

it('404s when the caller cannot open the TARGET', async () => {
  const db = makeDb()
  seedTicket(db, { ...T_STUDIO, id: 'source' })
  seedTicket(db, { ...T_OTHER_LOCATION, id: 'target' })
  const res = await POST(req({ into: 'target' }), ctx('source'))
  expect(res.status).toBe(404)
  expect(ticketRow(db, 'source').merged_into_id).toBeNull()
})

it('404s on a self-merge', async () => {
  const db = makeDb(); seedTicket(db, { ...T_STUDIO, id: 'source' })
  expect((await POST(req({ into: 'source' }), ctx('source'))).status).toBe(404)
})

it('404s on merging an already-merged ticket', async () => {
  const db = makeDb()
  seedTicket(db, { ...T_STUDIO, id: 'target' })
  seedTicket(db, { ...T_STUDIO, id: 'source', merged_into_id: 'other' })
  expect((await POST(req({ into: 'target' }), ctx('source'))).status).toBe(404)
})

it('unmerge restores exactly the rows that moved', async () => {
  const db = makeDb()
  seedTicket(db, { ...T_STUDIO, id: 'target' })
  seedTicket(db, { ...T_STUDIO, id: 'source' })
  seedMessages(db, 'target', [{ id: 'native' }])
  seedMessages(db, 'source', [{ id: 'moved' }])
  await POST(req({ into: 'target' }), ctx('source'))
  const res = await DELETE(req({}), ctx('source'))
  expect(res.status).toBe(200)
  expect(messageRows(db, 'source').map(m => m.id)).toEqual(['moved'])
  expect(messageRows(db, 'target').map(m => m.id)).toEqual(['native'])
  expect(ticketRow(db, 'source').merged_into_id).toBeNull()
  expect(messageRows(db, 'source')[0].merged_from_ticket_id).toBeNull()
})
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run "src/app/api/email/tickets/[id]/merge/route.test.js"
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```js
// EMAIL-MERGE.4 — fold one ticket into another, reversibly.
//
// BOTH tickets go through loadTicketForUser. The gate lives there and not in
// this handler because a ticket's location is not knowable until the row is
// read (#1266); checking one ticket and trusting the other would let someone
// move mail out of a studio they cannot see. Every refusal is 404 — a 403 after
// the row is read is an existence oracle.
//
// ORDER IS LOAD-BEARING. There is no cross-statement transaction here, so the
// writes are ordered to leave a finishable state if the process dies:
//   1. reparent the messages (idempotent — re-running matches nothing new)
//   2. update the target's counters
//   3. stamp the source tombstone LAST
// A crash before 3 leaves messages moved and the source still live but empty —
// visibly odd and fixed by re-running the merge. Stamping the tombstone first
// would instead hide a ticket whose messages never moved, which is silent loss.
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getCurrentUser } from '@/lib/auth'
import { createServerClient } from '@/lib/supabase'
import { validateBody, uuidLike } from '@/lib/schemas'
import { canMerge, mergedTicketFields } from '@/lib/email-ticket-merge'
import { loadTicketForUser, ticketNotFound } from '../../_helpers'

// uuidLike, NOT z.string().uuid(): Stillorgan's location id has a version digit
// of 0 and z.string().uuid() rejects it (SEGSAVE.1).
const schema = z.object({ into: uuidLike })

export async function POST(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const parsed = await validateBody(request, schema)
  if (!parsed.success) return parsed.response

  const db = createServerClient()
  const { id } = await params

  const src = await loadTicketForUser(db, user, id)
  if (src.response) return src.response
  const tgt = await loadTicketForUser(db, user, parsed.data.into)
  if (tgt.response) return tgt.response

  const eligible = canMerge(src.ticket, tgt.ticket)
  if (!eligible.ok) return ticketNotFound()

  const now = new Date().toISOString()

  const { error: moveErr } = await db.from('email_inbox_messages')
    .update({ ticket_id: tgt.ticket.id, merged_from_ticket_id: src.ticket.id })
    .eq('ticket_id', src.ticket.id)
  if (moveErr) {
    console.error('[tickets/:id/merge] reparent failed:', moveErr.message)
    return NextResponse.json({ success: false, error: moveErr.message }, { status: 500 })
  }

  const { error: tgtErr } = await db.from('email_tickets')
    .update({ ...mergedTicketFields(src.ticket, tgt.ticket), updated_at: now })
    .eq('id', tgt.ticket.id)
  if (tgtErr) {
    console.error('[tickets/:id/merge] target update failed:', tgtErr.message)
    return NextResponse.json({ success: false, error: tgtErr.message }, { status: 500 })
  }

  const { error: srcErr } = await db.from('email_tickets')
    .update({
      merged_into_id: tgt.ticket.id, merged_at: now, merged_by: user.id,
      status: 'closed', closed_at: src.ticket.closed_at || now,
      unread_count: 0, updated_at: now,
    })
    .eq('id', src.ticket.id)
  if (srcErr) {
    console.error('[tickets/:id/merge] tombstone failed:', srcErr.message)
    return NextResponse.json({ success: false, error: srcErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { merged_into_id: tgt.ticket.id } })
}

export async function DELETE(request, { params }) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  const db = createServerClient()
  const { id } = await params
  const src = await loadTicketForUser(db, user, id)
  if (src.response) return src.response
  if (!src.ticket.merged_into_id) return ticketNotFound()

  const now = new Date().toISOString()

  // Exactly the rows that moved, and no others — including on a target that has
  // absorbed more than one merge.
  const { error: moveErr } = await db.from('email_inbox_messages')
    .update({ ticket_id: src.ticket.id, merged_from_ticket_id: null })
    .eq('merged_from_ticket_id', src.ticket.id)
  if (moveErr) {
    console.error('[tickets/:id/merge] unmerge reparent failed:', moveErr.message)
    return NextResponse.json({ success: false, error: moveErr.message }, { status: 500 })
  }

  const { error: clearErr } = await db.from('email_tickets')
    .update({ merged_into_id: null, merged_at: null, merged_by: null, updated_at: now })
    .eq('id', src.ticket.id)
  if (clearErr) {
    console.error('[tickets/:id/merge] unmerge clear failed:', clearErr.message)
    return NextResponse.json({ success: false, error: clearErr.message }, { status: 500 })
  }

  return NextResponse.json({ success: true, data: { unmerged: true } })
}
```

- [ ] **Step 4: Run to verify they pass**

```bash
npx vitest run "src/app/api/email/tickets/[id]/merge/route.test.js"
npm run check:route-guards
```

Expected: all PASS.

- [ ] **Step 5: Register in openapi**

Add `POST` and `DELETE` to `src/lib/openapi.js` beside the other email-ticket routes.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/email/tickets/[id]/merge" src/lib/openapi.js
git commit -m "EMAIL-MERGE.4 — POST/DELETE merge: reparent, tombstone, undo"
```

---

## Task 5: Redirect a merged ticket

**Files:**
- Modify: `src/app/api/email/tickets/[id]/route.js`
- Test: `src/app/api/email/tickets/[id]/route.test.js`

- [ ] **Step 1: Write the failing test**

```js
it('returns the survivor pointer when the ticket was merged away', async () => {
  const db = makeDb()
  seedTicket(db, { ...T_STUDIO, id: 'folded', merged_into_id: 'live' })
  const res = await GET(req('/api/email/tickets/folded'), ctx('folded'))
  expect(res.status).toBe(200)
  expect((await res.json()).data.ticket.merged_into_id).toBe('live')
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run "src/app/api/email/tickets/[id]/route.test.js" -t "survivor pointer"
```

Expected: FAIL — `merged_into_id` undefined.

- [ ] **Step 3: Implement**

`loadTicketForUser` already selects `*`, so `merged_into_id` rides along in the response. Confirm no explicit column list in the detail route's response shaping drops it; if one does, add the three merge columns.

The ticket stays **readable** — the redirect is the UI's job, and a merged ticket that 404s would strand anyone holding a bookmark or a push notification link.

- [ ] **Step 4: Run to verify it passes**

```bash
npx vitest run "src/app/api/email/tickets/[id]/route.test.js"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/email/tickets/[id]/route.js" "src/app/api/email/tickets/[id]/route.test.js"
git commit -m "EMAIL-MERGE.5 — detail route carries the survivor pointer"
```

---

## Task 6: The merge UI

**Files:**
- Create: `src/components/tickets/TicketMerge.jsx`, `src/components/tickets/TicketMerge.test.jsx`
- Modify: `src/components/tickets/TicketThread.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
it('names both subjects and the message count before merging', async () => {
  const onMerge = vi.fn()
  render(<TicketMerge ticket={{ id: 'src', subject: 'Rates query', message_count: 3 }}
    candidates={[{ id: 'tgt', subject: 'Rates followup', requester_email: 'rates@council.ie' }]}
    onMerge={onMerge} />)
  fireEvent.click(screen.getByRole('button', { name: /rates followup/i }))
  expect(screen.getByText(/3 messages/i)).toBeTruthy()
  expect(screen.getByText(/rates query/i)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /^merge$/i }))
  expect(onMerge).toHaveBeenCalledWith('tgt')
})

it('does not merge when the confirm step is dismissed', () => {
  const onMerge = vi.fn()
  render(<TicketMerge ticket={{ id: 'src', subject: 'Rates query', message_count: 3 }}
    candidates={[{ id: 'tgt', subject: 'Rates followup' }]} onMerge={onMerge} />)
  fireEvent.click(screen.getByRole('button', { name: /rates followup/i }))
  fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
  expect(onMerge).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run src/components/tickets/TicketMerge.test.jsx
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Compose from `@/components/ui` (`Modal`, `Button`, `Field`) — do not re-roll primitives. Candidates come from the existing ticket list endpoint filtered to the same location, excluding the current ticket.

Every `<button>` that is not the submit gets `type="button"` — `check:guardrails` enforces it.

The confirm step states, in words: which ticket disappears, which survives, and how many messages move.

- [ ] **Step 4: Wire into `TicketThread.jsx`**

- A "Merge into…" action in the ticket header opens `TicketMerge`.
- On success, navigate to the survivor.
- When `ticket.merged_into_id` is set, render a banner — *"Merged into &lt;subject&gt;"* with **Open** and **Undo**. Undo calls `DELETE`.

- [ ] **Step 5: Run to verify it passes**

```bash
npx vitest run src/components/tickets/TicketMerge.test.jsx
npm run lint
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/tickets/TicketMerge.jsx src/components/tickets/TicketMerge.test.jsx src/components/tickets/TicketThread.jsx
git commit -m "EMAIL-MERGE.6 — merge picker, confirm and undo"
```

---

## Task 7: Full verification and PR

- [ ] **Step 1: Run the CI mirror — all nine**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails
```

Expected: all PASS. `check:mobile-parity` will demand a decision on the new route — merge is **web-only**; add it to `WEB_ONLY_OK` with the reason "merge is an operator cleanup action, not a queue-working action".

- [ ] **Step 2: Run the build**

```bash
npm run build
```

Expected: PASS. Two new routes and a new component mean new imports, which vitest cannot catch.

- [ ] **Step 3: Update the changelog**

Add an entry to `docs/CHANGELOG.md`.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin HEAD
```

Then `gh pr create --base main --fill`, and **report the PR URL**.

---

## Manual verification after merge

On the live estate, tickets `63dc2d00` (the duplicate) and `46a5cf37` (the live Dublin City Council thread) are the natural test:

1. Merge `63dc2d00` into `46a5cf37`. Both are at Hatch Street, so it is allowed.
2. `46a5cf37` should now carry all messages from both, ordered by `created_at`.
3. `63dc2d00` should be gone from the list, and opening its URL should land on `46a5cf37`.
4. **Undo it and confirm both tickets return to exactly their previous state** before trusting the feature on anything else.

Do not send any live mail to Dublin City Council while testing.
