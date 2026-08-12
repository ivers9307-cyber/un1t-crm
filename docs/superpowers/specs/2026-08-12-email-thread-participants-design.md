# Email tickets — thread-wide participants, mail-thread display, merge, and contact attribution

**Date:** 2026-08-12
**Status:** design approved (Richard, 2026-08-12), not yet implemented
**Ships as:** two PRs — see [Shipping shape](#shipping-shape)

---

## The incident that produced this

On 12 Aug a reply from `eleanor.brennan@dublincity.ie` landed on the ticket whose
requester is `ratesoffice@dublincity.ie` (`46a5cf37`), not on the ticket opened by
composing to Eleanor directly (`63dc2d00`).

Her headers, off the live row:

```
Subject:      Fw: Property Reference - 4810256004 & Account number - 00006438042677
In-Reply-To:  <PAXP193MB1613D37A71656B9FDA87D1DE9EDC2@...EURP193.PROD.OUTLOOK.COM>
References:   <9594f4ae-aa22-419b-bad4-6730d44650fd@mtasv.net>
              <PAXP193MB1613D37A71656B9FDA87D1DE9EDC2@...EURP193.PROD.OUTLOOK.COM>
```

`9594f4ae-aa22-419b-bad4-6730d44650fd` is the `postmark_message_id` of our 09:10
send **to `ratesoffice@`** on ticket `46a5cf37`. The rates office forwarded our mail
to Eleanor internally (the Outlook id in the middle of the chain), she replied on
that copy, and Outlook carried our id in `References`.

### THE MATCHER IS NOT THE BUG — do not "fix" it

`extractCandidateMessageIds` → `.in('postmark_message_id', …)` → `pickThreadedTicket`
did exactly the right thing. Eleanor genuinely is on that RFC chain.

Two facts that kill the obvious wrong fixes:

- **Nothing could have routed her to `63dc2d00`.** That ticket's message id
  (`2abba2f2…`) appears nowhere in her headers. She never replied to it.
- **Subject matching would be worse**, not better: all three tickets carry the
  byte-identical subject `Property Reference - 4810256004 & Account number - …`.
- **"Unknown sender starts a new ticket" would have made a *third* ticket**, and it
  breaks the ordinary shared-mailbox → named-officer handoff that this thread *is*.
  Explicitly rejected (Richard, 2026-08-12).

### What actually went wrong

1. **The reply audience is derived from the newest message only.**
   `threadParticipants(latestCorrespondence(...))` at
   [`[id]/route.js:148`](../../../src/app/api/email/tickets/[id]/route.js) and
   [`reply/route.js:285`](../../../src/app/api/email/tickets/[id]/reply/route.js).
   So the 10:24 reply went to Eleanor alone and **`ratesoffice@` — who opened the
   thread — was silently dropped off their own conversation.** Whoever sent last
   redefines the entire audience.
2. **A ticket's counterparty can change with nothing on screen saying so.**
   `46a5cf37` still reads `ratesoffice@dublincity.ie` though every message since
   10:06 is with Eleanor. That is the "wrong thread" the operator saw.
3. **One conversation, two tickets, no way to join them.** Consequence, live: the
   same reply was sent twice (10:24 on `46a5cf37`, 10:27 on `63dc2d00`) and the
   council received a duplicate.

---

## Decisions locked (Richard, 2026-08-12)

| Decision | Choice |
|---|---|
| Participant set | **Union across the thread, with sticky removal** |
| Forwards | **Never add participants** |
| Merge | **Tombstone, reversible** |
| Merge tombstone shape | **`merged_into_id`, status stays `closed`** — no fifth status value |
| Representation | **Derived from messages + a stored exclusion list** — not a participants table |
| "Email inbox" | **Make the ticket read like a mail thread.** No separate mailbox view |
| Recipient editing | **Remove-only.** No free-form add |
| Contact attribution | **`From` address only. The header-based contact link is dropped** |

---

## Part 1 — Thread-wide participants

### The function

One new pure function in `src/lib/email-recipients.js`, the module that already owns
every leak-prevention rule and mutation-tests them:

```js
ticketParticipants(messages, { exclude = [], removed = [] }) → string[]
```

Rules, in order:

1. Consider only messages where `is_internal_note !== true` **and**
   `forwarded_message_id == null`.
2. Collect `from_email`, `to_emails[]`, `cc_emails[]`.
   **`bcc_emails` is not named in the function** — same guarantee, same mutation test
   as `threadParticipants` today.
3. Normalise and dedupe case-insensitively across all three lists via the existing
   `normalizeAddressList`.
4. Subtract `exclude` (our own mailbox addresses + `POSTMARK_FROM_EMAIL`).
5. Subtract `removed` (the ticket's sticky exclusions), compared normalised so a
   case variant cannot dodge an exclusion.

**Order:** the `from_email` of the latest non-forward correspondence first — that is
who you are answering, and the label and `requester_email` fallback read off the head
— then the remainder by first appearance. Deterministic, so the composer label and the
send cannot disagree across two independent derivations.

### Read the WHOLE thread, not a window

The reply route currently derives from a bounded recent-message scan. A union needs
every non-note message on the ticket, ordered, with an explicit high cap (500) and an
explicit `.order()`. This also closes the 09-Aug medium *"10-row recipient scan can
silently narrow Reply All (N) at 11+ notes"* as a side effect.

### Over the cap — no silent truncation

`MAX_RECIPIENTS` is 25 and stays enforced server-side in `resolveRecipients()`.
A union can exceed it on a long thread. Behaviour:

- detail route returns the **full** set plus `over_cap: true`;
- composer renders them all and **blocks send**, asking the operator to trim;
- reply route **400s** rather than sending to a truncated set.

Quietly dropping recipient 26 is the same defect this work exists to remove.

### The empty set — and why `requester_email` is not a safety net

The reply route falls back to `[ticket.requester_email]` when the derived set is empty
(`reply/route.js:288`). That fallback **must itself respect the exclusions**, or
removing the requester silently re-adds them on the next send — an operator action
that appears to work and then undoes itself.

So: apply exclusions *after* the fallback, and if the result is empty, **refuse the
send** with "this ticket has no recipients left — restore one to reply". An empty
audience is a state the operator created deliberately and can undo deliberately.
Mailing someone they explicitly removed is not an acceptable way to avoid an error
message.

### Sticky removals

```sql
alter table email_tickets
  add column excluded_participants text[] not null default '{}';
```

- `PATCH /api/email/tickets/[id]/participants` with `{ remove: [addr] }` /
  `{ restore: [addr] }`.
- **The permission gate lives inside `loadTicketForUser`**, never as a per-route check
  — the #1266 lesson: a ticket's location is not knowable until the row is read, so a
  per-route gate resolves at the caller's *active* location and drifts. Refusals 404.
- Addresses normalised on write.
- Removal changes *future recipients only*. History still renders everyone; nothing is
  deleted.

### Call sites changed

| Site | From | To |
|---|---|---|
| `[id]/route.js:148` | `threadParticipants(latestCorrespondence(…))` | `ticketParticipants(allMessages, …)` |
| `reply/route.js:285-286` | same | same |

Both continue to derive independently through one shared function — the existing
"the button that says *Reply All (4 people)* and the send that happens cannot
disagree" invariant is preserved, not weakened.

`in_reply_to` is unaffected: it reads `lastInbound?.rfc_message_id`
(`reply/route.js:480,511`), which is a threading concern, not an audience concern.

`threadParticipants` stays for the forward route's "who was on this one message".
If it ends up with no callers, delete it rather than leaving a second way to compute
an audience.

### Forward exclusion closes a known defect

Skipping `forwarded_message_id IS NOT NULL` rows also closes 09-Aug confirmed-serious
finding #2, *"forward-then-reply misdirects the answer"*: the reply audience no longer
derives from a forward row, so the member's answer stops going to the third party.

---

## Part 2 — The ticket reads like a mail thread

- **Thread header** shows the live participant list. `Opened by <requester>` appears
  **only** when the requester is no longer the primary correspondent — otherwise it is
  noise on every ordinary ticket.
- **Each message** exposes its real From / To / Cc, collapsed by default. The envelope
  is currently hidden entirely, which is why a counterparty change was invisible.
- **A "joined this thread" marker** on the message where an address first appears.
  On the rates ticket this renders *"Eleanor Brennan joined this thread"* against the
  10:06 message — the missing signal, and the one that would have prevented the
  duplicate reply. Derived, not stored: first appearance is a function of the message
  rows.
- **`TicketReplyBox`** renders recipients as chips with an `×`. **Remove-only** — no
  free-form add — so *"the mode is derived, never chosen"* (Richard, 07 Aug) survives.
  Label stays `Reply All (N people)`.
- **Mobile** receives `reply_recipients` in the ticket payload and renders it
  read-only (no chip editing, pure JS, OTA-safe). This closes 09-Aug finding #3,
  *"mobile composer lies about the audience"* — the footer says "Sends an email to
  \<requester\>" while every reply is reply-all.

---

## Part 3 — Merge

### Schema

```sql
alter table email_tickets
  add column merged_into_id uuid references email_tickets(id),
  add column merged_at      timestamptz,
  add column merged_by      uuid references profiles(id);

alter table email_inbox_messages
  add column merged_from_ticket_id uuid references email_tickets(id);

create index idx_email_tickets_merged_into on email_tickets (merged_into_id);
create index idx_email_msgs_merged_from    on email_inbox_messages (merged_from_ticket_id);
```

`merged_from_ticket_id` is stamped on the rows that move, so unmerge restores exactly
those and nothing else.

**Each new FK gets its own leading index** — the mig 496/497 lesson: a composite index
whose leading column is something else does not cover the FK, and
`get_advisors(performance)` will say so.

**Status stays `open|pending|solved|closed`.** A fifth value would have to be audited
through every view filter, the count endpoint, the mobile status picker and the
needs-reply badge; this codebase has been bitten by an enum value leaking past a
filter that keyed on the old set.

### Route

`POST /api/email/tickets/[id]/merge` with `{ into: <ticketId> }`.

- Caller must pass `loadTicketForUser` on **both** tickets.
- Both must share a `location_id`.
- Refusals are **404**, not 403 — a 403 after the row is read is an existence oracle.

**Refused:** self-merge · cross-location · merging a ticket that is already merged
(chains would make unmerge inexact) · merging *into* a merged ticket.

### Effects

| | |
|---|---|
| Source messages | `ticket_id = target`, `merged_from_ticket_id = source` |
| Source ticket | `merged_into_id`, `merged_at`, `merged_by`, `status='closed'`, `unread_count=0` |
| Target ticket | `unread_count += source.unread_count`; `last_message_at` / `_direction` / `_preview` recomputed from the union |
| `first_response_at` | target keeps the **earlier** of the two — it is a support metric, and the earliest real outbound response is the truth |
| Attachments | ride along on `message_id`; nothing to migrate |
| Quota | **untouched.** Bytes were metered against the delivering mailbox at arrival; merging moves no bytes |

### Unmerge

`DELETE /api/email/tickets/[id]/merge` — moves back exactly the rows stamped
`merged_from_ticket_id = source`, clears the three columns, recomputes the
denormalised fields on both tickets.

### Visibility

`merged_into_id is null` is applied in **one shared place** in the ticket list query
builder, not per-route, so it cannot drift. Opening a merged ticket returns its
pointer so the UI redirects to the survivor.

### UI

A *Merge into…* action on the ticket. Picker searches tickets at the same location.
The confirm dialog names both subjects and the message count that will move.

---

## Part 4 — Contact attribution

Today, [`webhooks/postmark-inbound/[token]/route.js:596-611`](../../../src/app/api/webhooks/postmark-inbound/[token]/route.js)
resolves `contact_id` from the `email_sends` row named by the **sender-supplied**
`References` header, and only consults the actual `From` address if that missed
(`if (!contactId)` at :668).

**Change: link on `From` only. Drop the header-based contact link.**

Flipping the order is not enough. *"From matches no contact, header names a send to
contact X"* describes both a member replying from a second address **and** a stranger
who received a forward of our mail — the code cannot distinguish them, and one of
those outcomes writes a third party's correspondence onto a member's timeline, which
then flows into their DSAR export.

An unlinked message is honest. A wrongly-linked one is a data-integrity breach.
Threading and identity are separate concerns; conflating them is the underlying error.

`matched_via` still records `in_reply_to` when the thread matched on a header, so the
diagnostic is unchanged. `contact_id` stays null when the sender is unknown.

This did not fire on the live incident (no `email_sends` rows carry those ids), but
the shape is live for any marketing send that a member forwards.

---

## Testing

**Pure (`email-recipients.test.js`)**

- union across messages; forward rows skipped; internal notes skipped
- `bcc_emails` never read — mutation-check, matching the existing guarantee
- sticky exclusions applied case-insensitively
- over-cap flagged, never truncated
- ordering deterministic across two independent derivations

**Regression fixture — the live incident.** Three messages (`ratesoffice@` outbound,
Eleanor inbound, staff outbound); assert the reply set contains **both**
`ratesoffice@dublincity.ie` and `eleanor.brennan@dublincity.ie`. This is the test that
fails today.

**Routes**

- detail route and reply route derive the identical set from identical input
- `PATCH …/participants` gated inside `loadTicketForUser`; wrong-location caller 404s
- merge: reparent then unmerge returns both tickets to their pre-merge state
- merge refusals: cross-location, self, already-merged, into-merged — each 404
- merged tickets absent from list and count

**Webhook**

- a third-party inbound whose `References` names one of our sends does **not** inherit
  that send's `contact_id`
- an inbound whose `From` matches a contact still links

Route tests must run the **real** permission resolver. Six email route test files once
mocked `hasPermission`, so the gate never ran (#1266).

---

## Rollout

1. Migration applied **before** the code deploys, forward-only, via Supabase MCP
   against **un1t-crm** (`iyvtbjjxdggiadzwwvdj` — not the sentinel project).
2. Confirm the migration number is free against the live `schema_migrations` first.
3. Run **both** `get_advisors` types after DDL; the new FK indexes exist precisely to
   keep `performance` clean.
4. Full CI mirror (all nine checks) plus `npm run build` — new routes mean new imports,
   which vitest cannot catch.

## Shipping shape

**PR 1 — the recipient model.** Parts 1, 2 and 4: participants, thread display,
contact attribution. One coherent change to who a reply reaches and what the operator
can see about it.

**PR 2 — merge.** New surface, new routes, a reversible operation over another
ticket's rows. Depends on nothing in PR 1; separated because reviewing them together
is too much.

## Non-goals

- Changing the threading matcher. See the top of this document.
- A separate chronological mailbox view.
- Free-form recipient adding in the composer.
- Auto-detecting duplicate tickets. Merge is operator-driven.
- Backfilling `excluded_participants` — the default `'{}'` is correct for every
  existing ticket.
- Anything auto-closing. **Nothing auto-closes** (Richard, 06 Aug) and merge is not a
  loophole in that: the *operator* closes the source ticket by merging it.
