# Mail: replies quote the thread, and the ticket vocabulary goes

**Date:** 2026-09-07
**Status:** approved design, awaiting implementation plan
**Task ids:** MAIL-REPLY-QUOTE.1 (behaviour), MAIL-RENAME.1 (vocabulary)

## The problem

A reply sent from the Mail surface arrives as a bare message. Richard's test on
2026-09-07 (conversation `f6e0ddaf`, subject "test"):

- The studio composed "test" to richard@richardivers.com.
- Richard replied from Gmail. Gmail's reply carried its own quoted block of the
  original underneath, as every mail client does.
- The studio replied "test test 3" from the Mail surface. The stored
  `text_body` of that outbound row is the operator's words plus the signature
  and nothing else. Gmail threads it (the In-Reply-To header did go out), but
  the message reads like a fresh email with no history beneath it.

Root cause: `src/app/api/email/tickets/[id]/reply/route.js` builds the body as
`textToHtml(text)` plus the signature. It never quotes anything. It also
threads off the *last inbound* message only, a ticket-queue idea ("thread off
the last thing the member sent us"); a mail client threads off the most recent
message in either direction.

The second problem is vocabulary. The ticket queue was retired on 2026-08-29
(RETIRE-TICKETS.1, PR #1556, sweep PR #1560) and Mail is the only email
surface, but the code still says ticket everywhere: the API paths, the helper
names, the component names, the lib names, and a handful of strings an
operator can read. Richard's call (2026-09-07): "stop treating these like a
ticket, this is an email inbox", full rename in the same PR.

## Decisions (Richard, 2026-09-07)

1. Quote the most recent message **in either direction**, not only the last
   inbound.
2. **Store what was sent.** The outbound row's `text_body` is exactly what the
   recipient received, quoted chain included. The thread collapses quoted text
   on display, the way a mail client does, and the collapsing applies to
   inbound Gmail cascades too (today they render in full).
3. **Full rename in the same PR**: API paths, helpers, components, libs,
   mobile, operator copy, API docs. Old API paths stay as shims until the
   staff app's OTA has adoption.
4. **The database is not renamed in this PR.** `email_tickets`, its
   `ticket_id` foreign key on `email_inbox_messages`, the four
   `email_ticket_*` policies and `increment_email_ticket_unread` keep their
   names. Nobody sees them, and a table rename with dependents is where the
   risk lives. It gets its own forward-only migration later. Queries stay
   honest as `db.from('email_tickets')`; no alias constant hides the name.

## Vocabulary

**Conversation** is the word. It is already what the Mail surface says on
screen ("Pick one from the list", "No other conversations from this sender"),
what the `?c=` deep link means, and what the API docs call a row of
`/api/email/mail`. The retired legacy table `email_conversations` (mig 394,
410 Gone routes) is not a conflict: nothing new is named after a table.

| Old | New |
|---|---|
| ticket (identifier, prose, copy) | conversation |
| `ticketId` | `conversationId` |
| requester (DB columns `requester_email`, `requester_name`) | unchanged in the DB; on screen "sender" |
| `loadTicketForUser`, `ticketNotFound`, `ticketMergedAway` | `loadConversationForUser`, `conversationNotFound`, `conversationMergedAway` |
| `TicketThread`, `TicketReplyBox`, `TicketCompose`, `TicketForward` | `ConversationThread`, `ReplyBox`, `ComposeForm`, `ForwardForm` |
| `src/lib/ticket-display.js` | `src/lib/mail/conversation-display.js` |
| `src/lib/email-tickets.js` | `src/lib/mail/conversation.js` |
| `src/lib/email-ticket-merge.js` | `src/lib/mail/conversation-merge.js` |
| `mobile/lib/email-tickets.js` | `mobile/lib/mail-conversations.js` |
| `mobile/app/(staff)/email/[ticketId].jsx` | `mobile/app/(staff)/email/[conversationId].jsx` (URL stays `/email/<id>`; push deep links in `mobile/lib/notification-nav.js` are unaffected) |
| `/api/cron/purge-spam-tickets` | `/api/cron/purge-spam-mail` (vercel.json updated in the same commit) |

**Left alone, on purpose:**

- Audit action names (`email_ticket.merged`, `email_ticket.unmerged`,
  `email_ticket.recipients_added`) and the Postmark tags (`ticket-reply`,
  and the compose/forward equivalents). They are persisted history and
  reporting keys; a rename would split every report in two.
- `source_type: 'inbox_reply'` on `email_sends`. Already inbox-worded.
- The `TICKET.X` commit-message template in CLAUDE.md. That is task numbering,
  not the product.
- Historical specs under `docs/` and CHANGELOG rows. History stays as written.
- `shared/mail-vocabulary.js`'s explanatory comments that describe the
  ticket-era derivation it replaced. Those are the reason the module exists.

## API rename with shims

New routes under the existing mail namespace. Each is the moved handler, not a
copy:

| Old path | New path |
|---|---|
| `POST /api/email/tickets/compose` | `POST /api/email/mail/compose` |
| `GET /api/email/tickets/[id]` | `GET /api/email/mail/[id]` |
| `POST /api/email/tickets/[id]/reply` | `POST /api/email/mail/[id]/reply` |
| `POST /api/email/tickets/[id]/forward` | `POST /api/email/mail/[id]/forward` |
| `PATCH /api/email/tickets/[id]/participants` | `PATCH /api/email/mail/[id]/participants` |
| `POST/DELETE /api/email/tickets/[id]/merge` | `POST/DELETE /api/email/mail/[id]/merge` |
| `POST /api/email/tickets/[id]/read` | `POST /api/email/mail/[id]/read` |
| `POST /api/email/tickets/[id]/link-contact` | `POST /api/email/mail/[id]/link-contact` |
| `GET /api/email/tickets/[id]/attachments/[attachmentId]` (+ `/preview`) | `GET /api/email/mail/[id]/attachments/[attachmentId]` (+ `/preview`) |

`src/app/api/email/mail/[id]/route.js` does not exist today (the directory
holds archive, seen, spam, related), so the GET thread route slots in without
collision. `src/app/api/email/mail/_helpers.js` already exists (list scoping,
`isArchived`, `stampMailRow`); the ticket helpers move into
`src/app/api/email/mail/_conversation.js` rather than being merged into it, so
neither file has to absorb the other's header.

**Shims.** Every old route file becomes a one-line re-export of the new
handler (`export { POST } from '@/app/api/email/mail/[id]/reply/route'`), with
a header naming the sweep that deletes it. The shipped staff-app bundle calls
the old paths for the thread, reply, compose, forward, merge and attachments
(`mobile/lib/email-api.js`), and an OTA lands on next launch, not on deploy,
so the shims are load-bearing until fleet adoption. Same pattern and same
two-week guidance as RETIRE-TICKETS.1's sweep. A shim test asserts each old
module's exports are the very same functions as the new module's (runtime
identity, the `reexport` mode of `tests/shared-pair-sync.test.js`).

**Mobile** (`mobile/lib/email-api.js`) moves to the new paths in the same PR
and ships as an OTA. Old bundles keep working through the shims; new bundles
never touch a shim. The server-side reply change reaches old bundles
automatically because the body is built on the server.

**API docs** (`src/lib/openapi.js`): the moved paths are documented under the
new paths with their existing descriptions, with the word ticket replaced in
prose. The old paths are listed with `deprecated: true` and a one-line
description pointing at the replacement, the same shape the retired
`/api/email/conversations` routes use.

## Operator copy

Every string an operator can read that says ticket is rewritten. The known
set (the implementation greps for the rest):

| Where | Old | New |
|---|---|---|
| ReplyBox | "This ticket has no requester address, so it cannot be replied to. You can still add an internal note." | "This conversation has no sender address, so it cannot be replied to. You can still add an internal note." |
| ConversationThread | "No mailbox on this ticket" | "No mailbox on this conversation" |
| ConversationThread | "Open the ticket it was merged into to reply." | "Open the conversation it was merged into to reply." |
| ComposeForm From hint | "The reply comes back to this account, and the ticket is filed under it." | "The reply comes back to this account, and the conversation is filed under it." |
| `shared/permissions.js` `email_inbox` hint | "Ticketed inbox for the studio email accounts …" | "Mail inbox for the studio email accounts …" |
| `shared/permissions.js` `notify_email` label | "… Email tickets" | "… Inbound email" |
| mobile thread empty state | "No messages on this ticket yet." | "No messages in this conversation yet." |

Android push channel ids and names (`shared/push-channels.js`) are untouched:
the names already read "Email", and a changed id is a new channel that loses
the user's notification setting. Only their comments mention tickets.

## Reply behaviour (MAIL-REPLY-QUOTE.1)

A new pure module, `src/lib/mail/reply-quote.js`, owns everything below. The
reply route calls it and stays the place that loads, sends and files.

### The anchor

The message the reply is a reply *to*: the most recent message on the
conversation by `created_at` in **either direction**, excluding internal
notes (never on the wire) and including forwards (a forward is the last thing
in the thread and a mail client would quote it). `created_at`, not `sent_at`:
an inbound `sent_at` is the sender's own Date header and can be anything.

Today's route threads off the last inbound only. The comment there says
threading is "explicitly out of scope"; that scope note dates from the ticket
queue and is superseded by this spec.

The anchor is loaded with `id, direction, from_email, subject, text_body,
html_body, rfc_message_id, postmark_message_id, in_reply_to,
references_header, created_at, author_profile_id`. `html_body` is fetched
only for the `hadHtml` note (see Quoting), never quoted.

The recipient derivation (EMAIL-PARTICIPANTS.5: the whole thread's union,
minus own addresses, minus exclusions) is **untouched**. The anchor decides
what is quoted and what is threaded, never who is written to.

### Threading headers

- **In-Reply-To** = the anchor's RFC Message-ID, bracketed.
  - Inbound rows and SMTP-sent rows carry it in `rfc_message_id`.
  - A Postmark-sent outbound row has `rfc_message_id` NULL and
    `postmark_message_id` set. Postmark mints the RFC id as
    `<{postmark_message_id}@mtasv.net>`; the evidence is Richard's Gmail reply
    on 2026-09-07 whose In-Reply-To was exactly
    `<80d4bc38-22a5-4462-b93e-5dd29704d473@mtasv.net>`, the
    `postmark_message_id` of the studio's compose. `anchorMessageId(message)`
    derives it. The inbound webhook already matches candidates with the
    domain stripped (`extractCandidateMessageIds`), so a customer's reply to
    a reply that references our mtasv id files onto the same conversation as
    it does today.
  - Neither id present: no threading headers, the reply still sends and
    starts a fresh thread client-side, unchanged from `buildReplyHeaders`.
- **References** = the anchor's `references_header`, or its `in_reply_to`
  when that is empty (RFC 5322 §3.6.4), plus the anchor's Message-ID.
  `buildReplyHeaders` gains the `in_reply_to` fallback; it keeps its shape.
- The outbound row now stores **both** `in_reply_to` and `references_header`
  as sent. Today it stores `in_reply_to` only, so a chain that passes
  through two studio replies loses its history. The column exists (mig 482);
  no migration.

### Subject

`replySubject(anchor.subject || conversation.subject)`, as today but keyed
on the anchor rather than the last inbound.

### Quoting

Only **plain text** is ever quoted: the anchor's `text_body`, which every
message has (the webhook stores `TextBody || htmlToPlainText(HtmlBody)`;
outbound rows store the sent text). The forward path made this call for a
security reason that applies unchanged: re-sending a stranger's sanitised
HTML, remote images and all, from the studio's own address is not worth a
prettier quote (`src/lib/email-forward.js` header). Reused from that module:
`forwardedBody` (CRLF-normalised, capped at `FORWARD_QUOTE_MAX_CHARS` =
20,000 with the truncation note) and `forwardTimestamp`.

The attribution line, the form Gmail itself writes:

```
On Mon 7 Sep 2026 at 13:34, Richard Ivers <richard@richardivers.com> wrote:
```

- Inbound anchor: `requester_name` when `from_email` equals
  `requester_email` (case-insensitive), else the address alone.
- Outbound anchor: the sending mailbox's label and address
  (`Hatch Street Fitness Accounts <accounts@hatchstreetfitness.com>`), which
  is what Gmail printed for the studio on 2026-09-07. The route has
  `mailbox` loaded; a NULL mailbox (orphan conversation) prints
  `from_email` alone.
- A name is never quoted-string-escaped on the wire; it is plain text in a
  plain-text line, and in the HTML part it is HTML-escaped like everything
  else.

**Text part**, in this order:

```
<operator's words>

-- 
<signature text>

On <stamp>, <who> wrote:
> line 1 of the anchor's text
> line 2
```

Signature above the quote: that is where every top-posting client puts it.
Each quoted line is prefixed `> ` (a line already starting with `>` becomes
`>> …`, the standard cascade). An empty anchor text quotes `(no text
content)` so the attribution line never dangles. The truncation note, when
the cap bites, sits after the last quoted line, unquoted.

**HTML part**: today's `textToHtml(words)` (or `textToHtml(words) + richSig.html`
when a rich signature applies), then:

```html
<div style="margin-top:12px;color:#5f6368;font-size:13px">On …, … wrote:</div>
<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex;color:#5f6368">
  <div style="white-space:pre-wrap">…escaped text…</div>
</blockquote>
```

`type="cite"` is what Apple Mail collapses; Gmail collapses a trailing
blockquote it recognises as the previous message. The quoted text goes
through the same three-replacement escape as the body, **before**
concatenation, so a `<script>` in a member's plain text is inert here
exactly as it is in a forward. The rich signature's HTML is generated by us
and is appended before the quote, unchanged.

### What is stored

- `text_body` = the full text part as sent (words, signature, attribution,
  quote). The row is the record of what the recipient received, the rule the
  forward route already states.
- `html_body` stays NULL on outbound rows, as today; the thread renders
  outbound messages from text.
- `email_tickets.last_message_preview` = `inboundPreview(text)` of the
  operator's **words only**, as today. The list must not preview the quote.
- `in_reply_to` and `references_header` as sent (above).
- `email_sends.body`/history rows: whatever they store today, they store the
  same text part.

### Edge cases

- **Conversation with a single outbound message and no reply yet** (the
  studio wrote first): the anchor is that outbound message. The reply quotes
  the studio's own earlier message and threads onto it. This is what a mail
  client does and was Richard's explicit answer.
- **Anchor is a forward**: quoted like any other message; its text already
  contains the forwarded block.
- **Anchor is an internal note**: never; notes are excluded before selection.
- **Internal note being written** (`internal: true`): unchanged. Nothing is
  sent, nothing is quoted, no headers.
- **Compose** (first message): nothing to quote; the route is renamed only.
- **Forward**: already quotes; renamed only.
- **Anchor lookup fails**: 500 before sending, the same ordering argument as
  EMAIL-TICKET.6 (nothing has been sent, so refusing costs a retry).

## Quote collapsing in the thread

### The splitter

`shared/mail-quote.js`, pure, no DOM, imported as `@/lib/mail-quote` on web
(a re-export, asserted by runtime identity in `tests/shared-pair-sync.test.js`)
and `shared/mail-quote` on mobile.

`splitQuotedText(text) → { body, quoted }`. `quoted` starts at the first of:

- an attribution line ending in `wrote:`, including Gmail's wrapped form
  where the address breaks onto the next line (`On Mon 7 Sep 2026 at 13:33
  Hatch Street Fitness Accounts <\naccounts@…> wrote:`); the match is on
  a line beginning `On ` whose `wrote:` terminator is within the next two
  lines;
- the first run of lines beginning with `>`;
- the forwarded-message separator (`FORWARD_SEPARATOR` from
  `email-forward.js`) and Gmail's `---------- Forwarded message ---------`;
- Outlook's `-----Original Message-----`;
- a horizontal-rule-plus-`From:` block (Outlook desktop's reply header:
  a line of underscores or dashes followed within two lines by `From:`).

Everything before is `body`, trimmed of trailing blank lines. No match:
`{ body: text, quoted: '' }`. The signature delimiter (`-- `) is **not** a
split point; a signature is part of the message. The function never throws
on non-string input (`{ body: '', quoted: '' }`).

### Web thread, text path

`ConversationThread`'s `ThreadMessage` renders `body` in the existing
`<p>`, then, when `quoted` is non-empty, a small pill:

```
[ ··· Show quoted text ]
```

Collapsed by default. Expanding renders `quoted` in a muted, left-bordered
block under the body and flips the pill to "Hide quoted text". State is
per-message and local (`useState`); it does not persist and is not part of
the fold state that `defaultExpandedMessageId` drives (a collapsed *message*
row shows the snippet only; the quote pill lives inside an expanded message).
The collapsed-row snippet (`messageSnippet` in `src/components/mail/mail-vocabulary.js`) uses `body`, so a row never
previews the quote.

### Web thread, HTML path (inbound mail rendered in an iframe)

Inbound mail from Gmail and Apple Mail is HTML, so this is the case that
matters for "inbound cascades too". The split is done **on the server**, in
the thread GET route's `shapeMessages`, after sanitising and inside the same
HTML budget:

`splitQuotedHtml(sanitisedBodyHtml) → { body, quoted }` in
`src/lib/email-html.js`, using `htmlparser2` to find the first quote
container in document order. It is installed today only transitively through
`sanitize-html` (12.0.0); it is added to `package.json` as a direct
dependency at that version, because importing a transitive package breaks on
the next lockfile shuffle:

- Gmail: `div.gmail_quote` (and `div.gmail_quote_container`);
- Apple Mail / Thunderbird: `blockquote[type="cite"]`;
- Outlook web/desktop: `div#divRplyFwdMsg`, `div#appendonsend`, and the
  `hr` + `From:` reply header block;
- Yahoo: `div.yahoo_quoted`;
- our own outbound HTML (should it ever be stored): the `blockquote[type="cite"]`
  above.

The container and everything after it in its parent become `quoted`; the
document with the container removed is `body`. Both are wrapped with
`emailFrameDocument`. The route returns `html_document` (body) and a new
`html_quoted_document` (quoted, or null). `sanitizeEmailHtml` already allows
`class`, `id` and `blockquote`, so the markers survive sanitising; the split
runs on sanitised output so nothing unsanitised is ever split or returned.
The budget is charged for both documents.

`ThreadMessage` renders `html_document` in the existing `EmailFrame` and,
behind the same "Show quoted text" pill, `html_quoted_document` in a
**second** `EmailFrame`. Two frames means no in-frame toggle, no script in
the srcdoc (the sandbox forbids one anyway), and no re-measuring: each frame
sizes itself exactly as today (`frameHeightClass`).

No recognised container: `html_quoted_document` is null and no pill renders.
The text-path splitter is **not** applied to the HTML path's `text_body` as
a fallback, because the HTML is what renders.

### Mobile thread

Plain text only (`html_body` never leaves the server). `FlatMessage` renders
`splitQuotedText(msg.text_body).body`, and the same pill (a `Pressable`
row, "Show quoted text" / "Hide quoted text") reveals `quoted`.
`FlatCollapsedRow`'s snippet uses `body`.

### 🔴 Verification is in a browser

`jsdom-cannot-see-layout` (memory): a green suite once shipped a toggle that
did nothing. The pill's tests in jsdom prove the DOM toggles; whether the
second frame renders and the pill sits where it should is checked on a
Vercel preview against prod data (GET-only), on both today's test
conversation and an older HTML-heavy one.

## Rename mechanics

Order of work, so the tree builds at every step:

1. Move libs and helpers (`git mv`), update every import, run the suite.
2. Move components into `src/components/mail`, rename exports, update
   imports and test file names.
3. Create the new API routes as moves, leave shims behind, add the shim
   identity test.
4. Mobile: rename lib and screen param, switch `email-api.js` paths, update
   tests.
5. Copy rewrite (grep `ticket` across `src/components`, `src/app`, `shared`,
   `mobile/app`, `mobile/components` for user-visible strings; identifiers
   and DB column names are handled by the grep in step 6).
6. Identifier rewrite: `ticket` → `conversation` in function, variable and
   prop names across `src` and `mobile`, excluding DB column/table names
   (`ticket_id`, `email_tickets`, `merged_from_ticket_id`,
   `merged_into_id`), audit action strings, Postmark tags, and anything
   inside `docs/`. This is the largest mechanical step: about 190 non-test
   and 120 test files mention the word today. It is done with targeted
   `sed` per identifier, not a blanket replace, and reviewed by grep
   afterwards for the exclusions above.
7. `src/lib/openapi.js`, `vercel.json`, CHANGELOG row, the
   `inbox-vs-ticketing-trial` memory note.

Then the behaviour change (reply-quote module, route change, storage), then
the collapsing (splitter, thread route, web thread, mobile thread).

## Testing

- `src/lib/mail/reply-quote.test.js`: anchor selection (inbound-last,
  outbound-last, note-last skipped, forward-last included, empty list),
  Message-ID derivation (rfc id, mtasv fallback, neither), References chain
  (references present, in_reply_to fallback, neither), attribution line for
  inbound with and without a matching name and for outbound with and without
  a mailbox, text assembly order, `>` prefixing incl. the `>>` cascade, the
  20k cap and note, HTML escaping of a hostile quoted line.
- `tests/mail-quote.test.js` (shared): each split marker, Gmail's wrapped
  attribution, no marker, non-string input, signature delimiter not a split.
- `tests/shared-pair-sync.test.js`: `mail-quote` added in `reexport` mode.
- Reply route tests (`route.test.js`, moved): the sent `TextBody` and
  `HtmlBody` contain the attribution and quote; `In-Reply-To`/`References`
  for an inbound-last anchor, an outbound Postmark-sent anchor
  (`@mtasv.net`), an SMTP-sent anchor (`rfc_message_id`), and no-id; the
  stored row's `text_body` equals the sent `TextBody` and
  `references_header` equals the sent header; `last_message_preview` holds
  the words only; internal notes unchanged; the existing 93 cases still
  pass under the new names.
- `src/lib/email-html.test.js`: `splitQuotedHtml` for Gmail, Apple, Outlook,
  Yahoo, nested, none; the split runs after sanitising.
- Thread route test: `html_quoted_document` present/null; budget charged.
- Web thread tests: pill hidden without a quote, toggles the quoted block,
  snippet excludes the quote; second `EmailFrame` mounts on expand.
- Mobile tests: `email-api.test.js` paths, screen renders body only until
  the pill is pressed.
- Shim identity test for every old route file.
- `npm run build` (the authoritative gate), `npx expo export` is **not**
  needed (no native change; OTA only).

## Rollout

1. Merge; Vercel deploys the shims and the new behaviour together.
2. Publish the mobile OTA (default 100%, pre-flight per `mobile-ota-paused`).
3. Smoke test, with Richard's go-ahead because it sends real mail: one reply
   from the CRM to richard@richardivers.com on the existing "test"
   conversation. Check in Gmail: quoted block present, threaded into the same
   conversation. Check in the CRM: the sent row shows the words, the pill
   reveals the quote; the earlier Gmail inbound now shows its cascade behind
   a pill too.
4. Shim sweep: a follow-up PR after roughly two weeks of fleet adoption
   deletes `src/app/api/email/tickets/**` and the shim test.
5. Database rename: a later forward-only migration, its own spec.

## Out of scope

- Renaming `email_tickets` or any column (decision 4).
- Quoting HTML (security posture, see Quoting).
- Changing who a reply reaches (EMAIL-PARTICIPANTS.5 stands).
- Reply drafts, signatures, attachments: untouched beyond renames.
- Collapsing quotes in the public host portal or anywhere outside the Mail
  thread (web and mobile).
