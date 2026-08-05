# Email ticketing — design

**Date:** 2026-08-05
**Status:** draft, awaiting Richard's review
**Scope:** email only. WhatsApp and Instagram are explicitly out.

## Why

Mig 394 gave email a home in the unified inbox as the third channel, modelled on
the Instagram twin: **one conversation per `(location_id, counterpart_email)`,
forever**, with a two-state `resolved_at`. That is the right model for a chat
channel and the wrong model for support correspondence. A member who emails
about billing in January and about a class in March lands in the same row, and
there is no way to say "the billing question is done, the class one isn't."

Separately, mig 213 (`issues`) already implements a real ticket lifecycle —
`open → in_progress → resolved → closed`, claim-to-assign, attachments in a
private bucket, handler-level permission gating — but its only channel is an
in-app form for staff.

This design takes the lifecycle model from `issues` and applies it to the email
channel, on its own surface.

## Decisions taken

| Decision | Choice | Rationale |
|---|---|---|
| Channels in a ticket | Email only | Richard, 2026-08-05. WA/IG keep today's resolve model untouched. |
| Where it lives | Its own tab, separate from the unified inbox | Richard, 2026-08-05. |
| Conversations vs tickets | `email_tickets` **replaces** `email_conversations` | Email no longer mirrors the IG twin, so identity can change without touching WA/IG. |
| Views | Saved filters, with `queue_id` reserved | YAGNI. Same trick mig 213 used with its `closed` column. |
| Inbound HTML | **Rendered**, sandboxed + sanitised | Richard, 2026-08-05. Reverses the mig 394 plain-text-only decision; see "Inbound HTML rendering". |
| Storage | 5 GB quota per mailbox (= per location) | Richard, 2026-08-05. Never rejects inbound mail; see "Storage quota". |

## Non-goals for v1

SLA timers and breach alerts · CSAT surveys · a public help centre or knowledge
base · macros and canned replies · merging tickets · cross-channel tickets ·
automatic pruning of stored mail.

Canned replies are the likeliest v2 addition, but should be built once the team
has worked the queue for a month and the five replies they actually send are
known.

## Surface

New page at `/communications/tickets`, its own nav entry, gated by a new
`tickets` permission key in `WEB_PERMISSION_KEYS` (`shared/permissions.js`).

Email is **removed** from the unified inbox at `/communications/inbox`. WA and
IG stay exactly as they are. The existing `?ch=em` deep-link parameter (see
`src/app/communications/inbox/page.js`) redirects to the equivalent ticket.

Rationale for removal rather than duplication: the same email workable from two
places under two different state models is a correctness problem, not a
convenience. One channel, one home.

## Data model

Next free migration number at implementation time (≈481 — confirm against
`supabase/migrations/` before writing, forward-only).

### `email_tickets` — one row per issue

```
id                uuid PK
location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE
contact_id        uuid REFERENCES contacts(id) ON DELETE SET NULL
queue_id          uuid NULL          -- reserved for v2; no FK yet, no table yet
requester_email   text NOT NULL
requester_name    text
subject           text
status            text NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','pending','solved','closed'))
priority          text NOT NULL DEFAULT 'normal'
                    CHECK (priority IN ('low','normal','high'))
assigned_to       uuid
reopened_from     uuid REFERENCES email_tickets(id) ON DELETE SET NULL
first_response_at timestamptz        -- first outbound non-note message
last_message_at   timestamptz
last_message_direction text
last_message_preview   text
unread_count      integer NOT NULL DEFAULT 0
solved_at         timestamptz
closed_at         timestamptz
created_at        timestamptz NOT NULL DEFAULT now()
updated_at        timestamptz NOT NULL DEFAULT now()
```

**No unique index on `(location_id, requester_email)`.** That absence is the
entire point of this design — one person may hold many concurrent tickets.

Indexes: `(location_id, status, last_message_at DESC)` for the default views,
`(location_id, assigned_to)` for "Mine", `(contact_id)` for the contact drawer,
`(requester_email)` for threading fallback.

`status` semantics, following `issues`:

- `open` — needs the studio's attention
- `pending` — replied, waiting on the member
- `solved` — handled; still reopenable by an inbound reply
- `closed` — terminal; an inbound reply mints a **new** ticket

### `email_inbox_messages` — additive columns

```
ticket_id        uuid REFERENCES email_tickets(id) ON DELETE CASCADE
cc_emails        text[] NOT NULL DEFAULT '{}'
bcc_emails       text[] NOT NULL DEFAULT '{}'
is_internal_note boolean NOT NULL DEFAULT false
```

`conversation_id` is retained through the transition and dropped with
`email_conversations`.

`is_internal_note` is the cheapest high-value feature in this design: staff
discuss a ticket in-thread without the member ever seeing it. Notes are never
sent, never carry cc/bcc, and never set `first_response_at`.

`bcc_emails` is stored for audit only and must never be rendered in any
member-visible context. It is written from the compose form, put on the wire to
Postmark, and thereafter read only by staff on the ticket.

### `email_ticket_attachments`

Exactly the mig 213 `issue-photos` pattern: rows record path, mime and size; the
bytes live in a new private `email-attachments` bucket, reached via signed URLs.

```
id            uuid PK
message_id    uuid NOT NULL REFERENCES email_inbox_messages(id) ON DELETE CASCADE
location_id   uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE
storage_path  text NOT NULL
filename      text NOT NULL
mime_type     text NOT NULL
size_bytes    integer NOT NULL
created_at    timestamptz NOT NULL DEFAULT now()
```

Inbound attachments are re-hosted from the Postmark payload into the bucket on
receipt — the same re-host-to-private-bucket approach used for WhatsApp inbound
media. Cap per-attachment size app-side and reject over the cap with a note
appended to the ticket, so a rejected attachment is visible rather than silent.

### RLS

Mirrors mig 394: a single permissive SELECT policy per table scoped `TO
authenticated` for staff assigned to the location plus master, `auth.uid()`
wrapped in `(SELECT ...)` per the initplan advisor, and all
authenticated/anon writes denied. Every write path is a service-role route that
re-imposes location scoping in app code.

## Inbound HTML rendering

This reverses mig 394's deliberate plain-text-only decision, so it has to carry
its own protection. Three facts about the codebase set the bar:

- No sanitiser dependency exists (`dompurify` / `sanitize-html` are absent from
  `package.json`).
- There is no meaningful CSP — `next.config.js` sets only `frame-ancestors *`,
  with no `script-src` or `default-src`.
- React's raw-HTML escape hatch is used **nowhere** in `src/` today. This
  feature does not introduce it either: rendering goes through an iframe
  `srcdoc`, which is stricter, because the untrusted document then lives in its
  own opaque origin rather than in the CRM's DOM.

Email HTML is hostile input from unauthenticated strangers. Defence is in two
independent layers, either of which should hold alone.

### Layer 1 — sandboxed iframe

Render into `<iframe srcdoc sandbox>` with **no `allow-scripts` and no
`allow-same-origin`**. Without `allow-scripts` no JavaScript executes even if
sanitisation is bypassed; without `allow-same-origin` the frame is an opaque
origin that cannot reach the parent DOM, its cookies, or the Supabase session.
Add `allow-popups` only if links must open.

The iframe also solves a mundane problem for free: marketing email ships
aggressive global CSS that would otherwise bleed into the CRM's own layout. A
separate document contains it.

### Layer 2 — server-side sanitisation

Sanitise **at render time, not at ingest**. `html_body` keeps storing the raw
original (capped at 300k as today) so the sanitiser can be improved later
without having destroyed evidence. Add `sanitize-html` (Node-side, no jsdom
requirement) and run it in the route, never in the browser.

Strip: `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`, `<input>`,
`<link>`, all `on*` event attributes, and `javascript:` / `data:` / `vbscript:`
URIs anywhere.

Rewrite: every `<a>` gets `target="_blank" rel="noopener noreferrer nofollow"`.

### Remote images blocked by default

Remote `<img src>` is rewritten to a placeholder with the original preserved in
`data-original-src`, behind a per-message **"Show images"** action.

This is not optional polish. A remote image in a support email is usually a
tracking pixel, and auto-loading it reports the studio's read back to a third
party and leaks the server's IP — for a member's email, on a GDPR footing, with
nobody having consented. Blocked-by-default is what every mail client does.

### Not in scope, but noticed

`frame-ancestors *` lets any site iframe the CRM. That may well be deliberate
(TV displays, embedded events), but it should be confirmed rather than
inherited. Tracked separately; not part of this work.

## Storage quota

5 GB **per mailbox**, where a mailbox is a location's inbound address
(`locations.email_inbox_reply_to`, already uniquely indexed). Stillorgan and
Hatch therefore hold 5 GB each rather than sharing a pool.

Per-mailbox is the finer of the two grains Richard offered ("per mailbox or
domain") and satisfies both readings: a single-location tenant's mailbox *is*
its domain, and a domain-wide figure is the sum of its mailboxes whenever one is
wanted for display. A domain-level ceiling, if it is ever needed, is an
additional cap over that sum rather than a change to this model.

Supabase Storage's `file_size_limit` is **per file, not per bucket**, so an
aggregate quota is not something the platform enforces. It has to be accounted
for in app code.

### Accounting

```
email_storage_usage
  location_id   uuid PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE
  bytes_used    bigint NOT NULL DEFAULT 0
  quota_bytes   bigint NOT NULL DEFAULT 5368709120   -- 5 GiB, per-mailbox overridable
  updated_at    timestamptz NOT NULL DEFAULT now()
```

`bytes_used` counts attachment bytes plus `text_body` + `html_body` lengths.
Updated through an atomic `increment_email_storage_bytes(p_location_id,
p_delta)` RPC following the mig 314 pattern — `SECURITY INVOKER`, `search_path`
pinned to `''`, `COALESCE` on the counter. Read-modify-write from JS loses
increments under concurrent inbound.

A row exists only for locations with `email_inbox_reply_to` set, matching mig
394's "NULL = email channel off for the location".

Counters drift. A nightly cron reconciles `bytes_used` against a real `SUM` and
logs any correction rather than silently fixing it.

### Behaviour at the cap

**Inbound email is never rejected.** Losing a member's message because a disk
quota filled is a business failure, not a technical one.

| Usage | Behaviour |
|---|---|
| ≥ 80% | Banner in the tickets UI; notify operators once per threshold crossing |
| ≥ 95% | Persistent warning; outbound attachments blocked at compose with a clear reason |
| ≥ 100% | Messages still accepted in full. New **attachments** are not stored |

At 100%, a skipped attachment is recorded as a row with `storage_path` NULL and
`skipped_reason = 'quota'`, keeping filename, mime and size. Staff see "3 files
not stored — mailbox full" and can ask the member to resend once space is
cleared. A silent drop would be far worse than a visible one.

`email_ticket_attachments` therefore carries:

```
storage_path    text NULL             -- NULL when skipped
skipped_reason  text NULL CHECK (skipped_reason IN ('quota','too_large','rehost_failed'))
```

### Reclaiming space

5 GB will fill, so there must be a way down. Pruning is **operator-initiated,
never automatic**: a screen listing attachments on `closed` tickets older than a
chosen age, showing how much would be freed, requiring confirmation. Bodies are
never pruned — they are cheap and they are the record.

Automatic deletion of customer correspondence is deliberately excluded. Whether
a retention period is legally required is a question for Richard and the
solicitor, not a default this spec should invent.

### Cost note

5 GB per mailbox is a real Supabase Storage line item, and per-mailbox scales
with locations rather than tenants — a ten-studio customer is a 50 GB ceiling.
`quota_bytes` is per-row and overridable so it can be attached to plan tiers
later, alongside the existing `custom_email_domain` feature key.

## Ticket identity rules

These rules are what make this a ticketing system rather than a renamed inbox.

1. Inbound whose `In-Reply-To` or `References` matches a message on a ticket
   that is **not** `closed` → append to that ticket. If the ticket was `solved`
   or `pending`, flip it back to `open`.
2. Inbound matching a **closed** ticket → open a **new** ticket with
   `reopened_from` set to the closed one.
3. Inbound with no threading match → new ticket. Location resolves by matching
   recipients against `locations.email_inbox_reply_to`, as today.
4. `solved` auto-closes after N days, **default 7**. N is an operator-editable
   setting, not a constant — customer-affecting thresholds must be editable by
   operators.
5. Outbound sets `first_response_at` if unset and `is_internal_note` is false.

Rule 2 is what stops a ticket becoming an immortal per-person thread again.

## Views and permissions

v1 ships saved filters over one shared per-location queue:

- **Unassigned** — `assigned_to IS NULL AND status = 'open'`
- **Mine** — `assigned_to = me AND status IN ('open','pending')`
- **Needs reply** — `status = 'open'` and last message inbound
- **Solved** — `status IN ('solved','closed')`

Anyone with the `tickets` permission sees all tickets at their assigned
locations; master sees all. No row-level scoping in v1.

`queue_id` exists but is always NULL. v2 adds an `email_ticket_queues` table,
routing rules, and per-queue grants modelled on `issue_handler` — additive, no
rewrite, no backfill.

## Migration and backfill

Forward-only, applied via Supabase MCP against un1t-crm, `get_advisors` after
DDL.

1. Create `email_tickets`, `email_ticket_attachments`, the new columns and the
   storage bucket. No behaviour change yet.
2. Backfill one ticket per existing `email_conversations` row, carrying
   `assigned_to`, `unread_count` and timestamps. `resolved_at IS NOT NULL` maps
   to `solved`; NULL maps to `open`. Set `email_inbox_messages.ticket_id` from
   the conversation mapping.
3. Cut the inbound webhook and send route over to ticket semantics.
4. Ship the UI, remove email from the unified inbox, add the redirect.
5. Leave `email_conversations` in place, read-only and unreferenced, for one
   release. Drop in a later migration.

Step 2 must be idempotent — re-running it may not duplicate tickets.

## Failure modes to handle

- **Threading headers absent or forged.** Fall back to `(location_id,
  requester_email)` plus an open ticket within a recency window; never merge
  across locations.
- **Unresolvable location.** Today's behaviour: no `email_inbox_reply_to` match
  means the channel is off. Do not silently drop — dead-letter it, consistent
  with `webhook-dead-letter.js`.
- **Attachment re-host fails.** Persist the message anyway with a visible note.
  Losing the body because a PDF failed is the worse outcome.
- **Send fails.** The message row records `status`; the ticket does not advance
  to `pending` on a failed send.
- **cc/bcc recipient limits.** Postmark caps recipients per message. Validate at
  compose time with a clear error rather than a 4xx at send.
- **Malformed or adversarial HTML.** Sanitisation runs inside a try/catch; a
  throw falls back to rendering `text_body` with a visible "HTML could not be
  displayed safely" notice. Never fall back to unsanitised output.
- **Quota counter drift.** The nightly reconcile logs corrections rather than
  silently overwriting, so a systematic accounting bug is visible rather than
  self-healing into permanent inaccuracy.
- **Quota reached mid-message.** A message whose attachments straddle the cap
  stores what fits and marks the rest `skipped_reason = 'quota'`. Partial is
  acceptable; silent is not.

## Testing

- Threading unit tests: reply-to-open, reply-to-solved, reply-to-closed,
  no-headers, forged headers, cross-location.
- Backfill idempotency: run twice, assert ticket count unchanged.
- `is_internal_note` never reaches Postmark — assert on the payload shaper.
- `bcc_emails` never appears in any client-facing payload.
- Permission tests per the `shared/permissions.test.js` pattern: the new
  `tickets` key present for every role, no orphans.
- Attachment signed-URL scoping: a staff member at location A cannot fetch an
  attachment on a ticket at location B.

Sanitisation gets its own XSS corpus, asserted on the sanitiser's **output
string**, not on a rendered DOM:

- `<script>` bodies, `<img onerror>`, `<svg onload>`, `<body onload>`
- `javascript:` and `data:text/html` in `href`, `src`, and `srcset`
- `<form>` posting to an external host (credential phishing inside a ticket)
- `<style>` containing `expression()` and `@import`
- Mixed-case and entity-encoded evasion (`jAvAsCrIpT&#58;`)
- Remote `<img>` rewritten to placeholder, original preserved in
  `data-original-src`
- The iframe's `sandbox` attribute asserted to contain neither `allow-scripts`
  nor `allow-same-origin` — a regression here silently removes Layer 1

Quota:

- `increment_email_storage_bytes` under concurrent callers — assert no lost
  increments (the failure mode mig 314 exists to prevent)
- Threshold transitions fire an operator notification exactly once per crossing,
  not once per inbound message
- At 100%, the message body still persists and the attachment row is written
  with `storage_path` NULL and `skipped_reason = 'quota'`
- Reconcile sweep converges and logs a correction when counters are wrong
- Pruning frees exactly the bytes it previewed

## Settled

1. **Replace `email_conversations`** rather than layering tickets above it —
   confirmed 2026-08-05.
2. **Email leaves the unified inbox** entirely — confirmed 2026-08-05.
3. **Inbound HTML is rendered** — confirmed 2026-08-05, reversing the mig 394
   plain-text-only decision. Sandboxing and sanitisation per this spec.
4. **5 GB quota per mailbox** — confirmed 2026-08-05, keyed on the location's
   inbound address. Locations do not share a pool.
5. **No retention policy in v1** — Richard, 2026-08-05. Pruning stays
   operator-initiated with no legally-derived defaults. Revisit if a solicitor
   sets a retention maximum.
6. **"Show images" is per-message** — Richard, 2026-08-05, the safe default. No
   per-sender trust list.

Nothing open. Ready for an implementation plan.
