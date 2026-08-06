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
| Mailboxes | **Many per location**, one location per mailbox | Richard, 2026-08-06. `accounts@` is distinct from `sales@` and `studio@`, across multiple domains. Supersedes the single `locations.email_inbox_reply_to` column. |
| Storage | 5 GB quota **per mailbox** | Richard, 2026-08-05/06. A mailbox is a row in `email_mailboxes`, NOT a location — a studio with three addresses holds 3 × 5 GB. Never rejects inbound mail; see "Storage quota". |

## Non-goals for v1

SLA timers and breach alerts · CSAT surveys · a public help centre or knowledge
base · macros and canned replies · merging tickets · cross-channel tickets ·
automatic pruning of stored mail.

Canned replies are the likeliest v2 addition, but should be built once the team
has worked the queue for a month and the five replies they actually send are
known.

## Surface

New page at `/communications/tickets`, its own nav entry, gated by the
**`email_inbox`** permission key in `WEB_PERMISSION_KEYS`
(`shared/permissions.js`) — deliberately distinct from the existing `email` key,
which gates marketing and campaign email. Access to each individual account
within the inbox is a separate, finer gate: a row in `email_mailbox_access`.
Holding `email_inbox` alone shows nothing.

An earlier draft of this spec called the key `tickets`; `email_inbox` is the
settled name (see Settled #8).

Email is **removed** from the unified inbox at `/communications/inbox`. WA and
IG stay exactly as they are. The existing `?ch=em` deep-link parameter (see
`src/app/communications/inbox/page.js`) redirects to the equivalent ticket.

Rationale for removal rather than duplication: the same email workable from two
places under two different state models is a correctness problem, not a
convenience. One channel, one home.

## Postmark topology — an invariant, not a preference

Two separate axes, often confused. Get both right.

### Axis 1 — stream: ticket replies are TRANSACTIONAL

A ticket reply goes to one person who just wrote to us. It is transactional, not
marketing, so it uses the path that already exists:

| Purpose | Helper | Stream | Consent family |
|---|---|---|---|
| **Ticket replies** | `sendTransactionalEmail()` | `outbound` | `email_administrative` |
| Campaigns, broadcasts | `sendMarketingEmail()` | `broadcast` | `email_marketing` |

**Plan 3 must call `sendTransactionalEmail()`, never `sendMarketingEmail()`**
(Richard, 2026-08-06). `consentFieldForStream()` in `src/lib/postmark.js` already
encodes the mapping, and the repo's standing consent invariant is that
`_administrative` covers transactional while `_marketing` covers broadcasts. A
support reply landing on the broadcast stream would be wrong on three counts —
consent family, reputation pool, and analytics.

One thing Plan 3 must decide rather than inherit: whether a reply to someone who
just emailed us should be gated on `email_administrative` at all. They initiated
contact; a suppression flag silently swallowing the answer to their own question
is worse than the consent risk it avoids. Recommendation: replies within a
ticket are exempt, and only *unsolicited* outbound honours the flag.

### Axis 2 — server: three of them, always

| Server | Carries |
|---|---|
| **Marketing** | Bulk campaigns and broadcasts |
| **Email inbox** | Ticket inbound, and the transactional replies staff send from it |
| **Invoices inbound** | Accounts invoice processing (mig 184) |

**Inbox vs invoices is forced.** A Postmark server has exactly one inbound
stream and one inbound address, so two inbound purposes cannot share a server
whatever anyone prefers.

**Marketing vs the rest is deliberate.** Bulk sending is where reputation damage
happens — a bad list, a spam-trap hit, a complaint spike. If support replies
leave from the same server, one bad campaign starts bouncing the answers members
are waiting for. Separating them makes the worst case a marketing problem rather
than a support outage, and keeps each server's bounce and complaint statistics
readable instead of a broadcast burying every transactional signal.

Note the axes interact: streams live *within* a server, so honouring the server
split means the inbox's transactional sends resolve a token for the **inbox**
server rather than assuming the global one. `resolvePostmarkToken()` returns the
global token today; `src/lib/tenant-email.js` already demonstrates the shape for
resolving a specific server token and falling back safely without ever throwing
in a send path.

**Do not "simplify" this later.** Consolidating servers looks like tidying,
saves nothing, and is discovered only when support mail stops being delivered.

## Data model

Migrations are forward-only; confirm the next free number against the live
project rather than the filesystem before writing (local files lag behind
MCP-applied ones — this caught a real collision on 482). Applied so far:
**482** tickets + attachments, **483** RLS and FK corrections, **484** backfill.
**485** is the mailbox model below.

### `email_mailboxes` — one row per inbound address

Mig 394 put a single address on `locations.email_inbox_reply_to`, uniquely
indexed. That models one mailbox per studio, which is wrong: a studio needs
`accounts@`, `sales@` and `studio@`, potentially on different domains, routed to
different people.

```
id             uuid PRIMARY KEY
location_id    uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE
address        text NOT NULL
label          text NOT NULL         -- 'Accounts', 'Sales', 'Studio'
is_default     boolean NOT NULL DEFAULT false
active         boolean NOT NULL DEFAULT true
created_at     timestamptz NOT NULL DEFAULT now()
updated_at     timestamptz NOT NULL DEFAULT now()
```

`UNIQUE (lower(address))` globally — an address resolves to exactly one mailbox,
so routing is never ambiguous. A partial unique index on
`(location_id) WHERE is_default` keeps one default per studio; that default is
the Reply-To stamped on campaign and marketing sends, preserving today's
behaviour.

**A mailbox belongs to exactly one location** (Richard, 2026-08-06). A
central org-wide `accounts@` was considered and rejected: per-location scoping is
what the existing RLS, staff permissions and location-access checks are entirely
built on, and breaking that alignment for one mailbox would be a large cost for
a small convenience.

`email_tickets` carries `mailbox_id`, so a ticket records which address it
arrived at and replies leave from the same one. Without it, a member who writes
to `accounts@` could be answered from `sales@`.

Backfill: one row from each `locations.email_inbox_reply_to` that is set,
`is_default = true`. That column is then marked DEPRECATED and dropped with
`email_conversations`.

**Postmark shape:** one server per *domain* — inbound domain forwarding routes
every address on a domain to its server — with many addresses per domain. Every
server POSTs to the same webhook URL and token, because resolution is by
recipient address, not by which server delivered it. Adding an address on an
already-configured domain therefore costs nothing but a row.

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
- There is no meaningful CSP — the app has no `script-src` or `default-src` at
  all. (`next.config.js` does set `frame-ancestors *`, but only on `/embed/*` and
  `/book/*`; it is not a page-level policy this feature could lean on.) Worth
  knowing for later: a `srcdoc` iframe **inherits its parent's CSP**, so if a
  global policy ever lands it covers the rendered email for free — a third layer
  behind the sandbox and the sanitiser, at no cost to this design.
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

### Not in scope, but checked — resolved, no action

An earlier draft of this spec flagged `frame-ancestors *` as letting any site
iframe the CRM. **Investigated 2026-08-06: it does not.** `next.config.js` ships
`X-Frame-Options: SAMEORIGIN` on `/(.*)` and grants `frame-ancestors *` to only
two subtrees — `/embed/:path*` and `/book/:path*`, the paste-anywhere signup and
booking widgets. Both were exempted deliberately in AUDIT-JUN10.2 (#409), after a
path-to-regexp negative-lookahead exclusion was tried and found to mis-match.

Verified against production: `/login`, `/tv/*`, `/host` and `/ccf` all return
`X-Frame-Options: SAMEORIGIN` and no CSP; only `/embed/*` and `/book/*` carry the
`frame-ancestors` override. The authenticated CRM is not frameable cross-origin,
so there is no clickjacking exposure here and nothing to narrow.

Do **not** "tidy" the two exemptions away — they are load-bearing for the
external event-signup embed and the booking widget.

## Storage quota

5 GB **per mailbox** — per row in `email_mailboxes`, not per location. A studio
running `accounts@`, `sales@` and `studio@` therefore holds 3 × 5 GB, and a
noisy sales inbox can never starve the accounts one.

This is the finer of the two grains Richard offered ("per mailbox or domain"),
and it is genuinely per-mailbox rather than per-location: an earlier draft keyed
it to `location_id` on the assumption that a location had exactly one address,
which the multi-mailbox decision of 2026-08-06 disproved. A per-domain or
per-location figure is the sum of the relevant mailboxes whenever one is wanted
for display; a ceiling at either level, if ever needed, is an additional cap
over that sum rather than a change to this model.

Supabase Storage's `file_size_limit` is **per file, not per bucket**, so an
aggregate quota is not something the platform enforces. It has to be accounted
for in app code.

### Accounting

```
email_storage_usage
  mailbox_id    uuid PRIMARY KEY REFERENCES email_mailboxes(id) ON DELETE CASCADE
  bytes_used    bigint NOT NULL DEFAULT 0
  quota_bytes   bigint NOT NULL DEFAULT 5368709120   -- 5 GiB, per-mailbox overridable
  updated_at    timestamptz NOT NULL DEFAULT now()
```

`bytes_used` counts attachment bytes plus `text_body` + `html_body` lengths.
Updated through an atomic `increment_email_storage_bytes(p_mailbox_id, p_delta)`
RPC following the mig 314 pattern — `SECURITY INVOKER`, `search_path` pinned to
`''`, `COALESCE` on the counter. Read-modify-write from JS loses increments
under concurrent inbound.

One row per mailbox, created with the mailbox. Deleting a mailbox cascades the
counter away with it.

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
3. Inbound with no threading match → new ticket, on the mailbox the message was
   delivered to. Resolution is `resolveMailboxByRecipient` in
   `src/lib/email-mailboxes.js`, matching against `email_mailboxes` — **not**
   against `locations.email_inbox_reply_to`, which mig 485 deprecates. The
   mailbox carries the location, so location falls out of it rather than being
   resolved separately. Recipient precedence decides when a message names more
   than one estate address; row order must never decide.
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

Those filters apply **within a mailbox**, and the mailbox is the access unit.
Access is two-level:

1. The **`email_inbox`** feature key gates the surface.
2. A row in **`email_mailbox_access`** gates each individual account inside it.

Master and owner-at-location are elevated and need no grant rows. Everyone else
sees only accounts they have been granted — so a coach can hold `studio@`
without ever seeing the billing correspondence in `accounts@`. Holding the
feature key alone shows nothing, and a studio with no mailboxes shows no inbox
at all rather than an empty one.

This supersedes an earlier draft that had a single shared per-location queue
with no row-level scoping and a reserved `queue_id`. The mailbox turned out to
be the access unit operators actually think in — "who can see this address" is
answerable, "which queue is this" is not. `queue_id` remains on `email_tickets`,
still always NULL; if sub-queues are ever wanted they live *within* a mailbox.

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
- **Unresolvable recipient. 🔴 THE EXISTING FALLBACK MUST BE REMOVED.**
  `src/app/api/webhooks/postmark-inbound/[token]/route.js` currently resolves an
  unmatched recipient to *"the oldest active location"* — a deliberate default
  for a single-inbound-address estate, and actively dangerous with several
  addresses across several domains. A near-miss on an `accounts@` address does
  not error; it silently files that studio's mail into whichever location is
  oldest, which today means Stillorgan. Replace it with a dead-letter, consistent
  with `webhook-dead-letter.js`, so a misconfigured mailbox is loud rather than
  quietly wrong. **Any onboarding test must assert on the resolved
  `location_id`, not merely that a row appeared.**
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
  `email_inbox` key present for every role, no orphans. Plus the per-account
  gate: a staff member granted `studio@` must not see `accounts@` tickets at the
  same studio, and an elevated user must see both without any grant rows.
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
7. **Many mailboxes per location, one location per mailbox** — Richard,
   2026-08-06. `accounts@` is a distinct address from `sales@` and `studio@`,
   potentially on different domains. Supersedes the single
   `locations.email_inbox_reply_to` column, and re-keys the storage quota from
   location to mailbox. `accounts@` is the only address wanted on day one.
8. **One inbox per studio, tabbed per account, permissioned at both levels** —
   Richard, 2026-08-06. An `email_inbox` feature key gates the surface; a row in
   `email_mailbox_access` gates each account within it. Mirrors
   `approvals_inbox` + `approvals_*`, except the per-item half is a table
   because mailboxes are rows rather than static keys.
9. **Three separate Postmark servers — marketing, email inbox, invoices
   inbound** — Richard, 2026-08-06. See "Postmark server topology". Inbox vs
   invoices is forced by Postmark; marketing vs the rest is a deliberate
   reputation firebreak.

Nothing open. Plan 1 is merged; the mailbox model lands with Plan 2, which is
the plan that changes recipient resolution anyway.
