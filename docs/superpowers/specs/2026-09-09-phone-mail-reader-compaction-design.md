# The phone Mail reader shows the email, not the chrome

**Date:** 2026-09-09
**Task id:** MAIL-READER.M1
**Mockup (approved, option A):** https://claude.ai/code/artifact/f351d5a2-1021-4605-babd-a4bf1495a2ca
**Desktop precedent:** `docs/superpowers/specs/2026-09-07-mail-reader-card-compaction-design.md` (MAIL-READER.1, #1640, web only)

## The problem

Richard's phone, 2026-09-09 16:22 — the Docusign thread "Completed: Document
for eSignature" at `accounts@hatchstreetfitness.com`. Measured off that
screenshot, below the status bar:

| Region | Share |
| --- | --- |
| Four header bands (subject / chips / "On this thread:" / nudge banner) | 21% |
| Composer (mode toggle, audience sentence, input, tools) | 24% |
| Signature preview box | 19% |
| Message body | 25% |
| Attachment chips | 11% |

So 64% chrome, and the 25% that *is* the email renders as plain text with a
180-character tracking URL running through the middle of it and `&#38;` printed
literally three times.

MAIL-READER.1 fixed the same disease on the desktop card two days earlier and
named mobile out of scope, on the grounds that "its thread is a different
renderer and already folds messages". Folding older messages is not the
problem; the chrome around the newest one is.

Three separate faults are in play and they need separating:

1. **Chrome the desktop already shed** — the signature box, the audience
   sentence, the four header bands, the always-expanded composer.
2. **HTML is thrown away.** `/api/email/mail/[id]` builds `html_document` (a
   sanitised, iframe-ready document, budget 1.5 MB per thread) and the phone
   discards every byte, by an explicit decision recorded at
   `mobile/app/(staff)/email/[conversationId].jsx:49`: React Native has no
   sandboxed iframe, so the screen renders `text_body` only.
3. **Two defects the screenshot exposed** — numeric character references are
   never decoded, and a bare URL is rendered in full.

And one gap found while auditing: **the phone cannot quarantine anything.**
`POST /api/email/mail/[id]/spam` has existed since MAIL-SPAM.1 and mobile has
no wrapper, no action and no Spam view. `shared/mail-vocabulary.js` lists five
views; `mobile/lib/mail-conversations.js`'s `TICKET_VIEW_TABS` lists four.
`tests/mail-vocabulary-agreement.test.js:265` pins the shared list against the
*server's*, and nothing pins the mobile one — which is exactly why the fifth
view went missing silently.

## Decisions (Richard, 2026-09-09)

1. **A React Native renderer, not a WebView.** `react-native-webview` is not a
   dependency and adding one is a native change: a `runtimeVersion` bump, a new
   binary and App Review before any staff member sees it, on top of the builds
   already queued. So the phone gets no HTML engine. The server — which already
   sanitises the mail and already carries `htmlparser2` as a direct dependency
   since MAIL-REPLY-QUOTE.1 — walks the sanitised document once and hands the
   phone a block tree. **Nothing is parsed on the device.** Ships as an OTA.
2. **Option A, compact at rest** (over option B, desktop's reading mode). One
   meta line, always; `Details ⌄` reveals the rest. Reading mode exists on the
   desktop card because 78vh can afford to be generous at rest and mean while
   the operator writes; a 390pt screen never has that surplus, so the compact
   form is simply the right form. This is a **deliberate divergence** from
   MAIL-READER.1 decision 5 and is recorded as one — desktop keeps its mode.
3. **Scope:** the reader, the three composers, and the spam gap. Not the list
   screen beyond adding the missing view.

## Architecture

Four units, each usable and testable on its own.

### Unit 1 — the block extractor (server)

**New:** `src/lib/email-blocks.js`. Imports `sanitizeEmailHtml` from
`email-html.js` and `htmlparser2`. **No client component may import it**, the
same rule `email-html.js` carries; it is added to that module's existing
client-import scan test rather than getting a second one.

It runs on the **output of Layer 2**, never on raw input, so it inherits every
guarantee the sanitiser makes: no script survives, no `<img src>` carries a
live remote URL, entities are already normalised, and CSS has been scrubbed.
The extractor's own job is only shape.

```js
/**
 * @returns {{
 *   blocks: Block[]|null,        // null → caller falls back to text_body
 *   quotedBlocks: Block[]|null,  // the folded chain, mirroring emailHtmlDocuments
 *   blockedImages: number,
 *   truncated: boolean,          // hit a cap; the phone says so
 *   failed: boolean,             // sanitise or parse threw
 * }}
 */
export function emailBlocks(raw)
```

It swallows its own throw and reports `failed`, exactly as
`emailHtmlDocuments` does. **There is no code path that returns unparsed
input.**

#### The block contract

Deliberately small. Eight block types, one inline run type.

```
Run   = { text, bold?, italic?, strike?, mono?, href? }

Block = { type: 'heading', level: 1..6, runs: Run[] }
      | { type: 'para',    runs: Run[] }
      | { type: 'list',    ordered: boolean, items: Run[][] }
      | { type: 'quote',   blocks: Block[] }        // one level; deeper flattens into it
      | { type: 'image',   blocked: string, alt: string }
      | { type: 'link',    href: string, runs: Run[] }   // an <a> alone in its block
      | { type: 'rule' }
      | { type: 'table',   head: Run[][]|null, rows: Run[][][] }
```

- **`image` is only ever a parked image, because that is the only kind that
  exists.** `src` and `srcset` are not in the sanitiser's attribute allowlist
  at all, so **no `<img>` in sanitised output ever carries a live URL**: a
  remote http(s) image arrives parked under `data-original-src`, and anything
  else — `cid:` for an inline attachment we have not re-hosted, a `data:` URI,
  a relative path, a protocol-relative `//host` — arrives with no URL of any
  kind and can never render. So the block carries `blocked` and nothing else,
  an image with no parked URL is **dropped** rather than emitted as a
  permanently empty placeholder, and the phone never constructs a URL of its
  own. `alt` falls back to a generic label rather than printing the
  sanitiser's own "Blocked image" as though the sender had written it.
- **`link` is the call-to-action case.** A marketing email's button is an `<a>`
  filling a table cell. When an anchor is the only content of its block it
  becomes a `link` block (the phone draws a bordered, tappable row); an anchor
  inside running text stays a run with `href`.
- **Tables flatten, unless the author said otherwise.** A `<table>` becomes its
  cells' blocks in source order — which is what a layout table wants, and
  layout tables are the overwhelming majority. A table emits `type: 'table'`
  **only** when it contains a `<th>` or `<thead>`: an explicit authoring signal
  with near-zero false positives, which is what keeps a receipt's line items
  readable without mistaking a 600px layout wrapper for data. Nested tables
  always flatten.
- **Caps.** 400 blocks per message, 64 runs per block, 400 chars per run,
  20 000 chars of text per message. Exceeding any of them stops the walk and
  sets `truncated`. This is what stops one monster email becoming a 2 MB JSON
  payload on cellular.

#### Route opt-in

`GET /api/email/mail/[id]?body=blocks`. Nothing else changes.

- **Absent, or any value other than `blocks`** → today's response,
  byte-for-byte. The parameter **fails open to the default**, deliberately
  unlike the `view` parameter's 400: a display preference is not worth refusing
  a thread over, and an older shipped bundle must keep working unchanged.
- **`blocks`** → each message carries `html_blocks`, `html_quoted_blocks`,
  `html_blocked_images`, `html_unsafe`, `html_omitted`, `html_truncated`, and
  **`html_document` is omitted entirely.** The phone stops paying for a
  document it never renders, so mobile payloads get *smaller* even as the
  feature lands.
- **Its own budget.** `HTML_BUDGET_BYTES` (1.5 MB) is a document budget on a
  desk browser. Blocks mode gets `BLOCK_BUDGET_BYTES = 300_000`, spent
  newest-first exactly as today, with `html_omitted: true` on messages past it.

### Unit 2 — the renderer (mobile)

**New:** `mobile/lib/mail-blocks.js` (pure, vitest, no React Native imports —
the same rule the rest of `mobile/lib` follows) and
`mobile/components/mail/EmailBody.jsx` (the pixels). Both sit under paths
already in the `eas-update.yml` publish allowlist (`mobile/lib/**`,
`mobile/components/**`), so `check:ota-paths` needs no change.

`mail-blocks.js` owns every decision:

- `normaliseBlocks(blocks)` — drops unknown types rather than crashing on a
  block a future server invents, and drops empty blocks.
- `imageState(block, showImages)` — `'shown' | 'blocked'`. Two states, not
  three: every emitted image block is a parked one.
- `blockedImageCount(blocks)` — **the single reader** behind the Show images
  label, counted from the same tree `imageState` draws from. The route still
  sends `html_blocked_images` for the document path, and the phone does not
  read it in blocks mode: two counters for one fact is how a label ends up
  disagreeing with the screen.
- `linkLabel(href, label)` — the URL-wall fix, used by both paths. When the
  label *is* the href (or there is no label) it returns `host + '/…'`; the full
  address is available on long-press. An anchor with real link text keeps its
  text untouched.
- `splitTextLinks(text)` — the text path's half of the same fix. Today
  `text_body` renders as one unbroken `<Text>` with no linkification at all,
  which is why a 180-character URL is three lines of screen; this splits it
  into plain and link segments so `linkLabel` can shorten the link ones.

`EmailBody.jsx` maps block → `<View>`/`<Text>`, carries the **Show images (N)**
control and desktop's privacy sentence verbatim ("Remote images blocked —
loading them tells the sender you read this"), and renders `quotedBlocks`
behind the "Show quoted text" pill the screen already has for text.

**What the phone gives up, stated so nobody rediscovers it:** a 600px marketing
table becomes a single column in source order; background images, web fonts and
letter-spaced hero type do not survive. If a real email comes out wrong the
escape hatch is a "View original" in the in-app browser — deliberately **not**
built now, because a new public route needs all four allowlists (CLAUDE.md), a
class of bug this repo has hit five times.

#### Security posture

Layer 2 is untouched. Layer 1 changes shape and gets *stronger*: it stops being
a sandboxed iframe and becomes the absence of an engine — no script can run
because nothing on the device can interpret one, and the app's Supabase session
lives in SecureStore, not in a cookie a frame could ever reach. The one thing
the phone must never do is build a URL the server did not prove; `imageState`
is the only reader of `blocked`, and it either passes the parked value through
or renders a placeholder.

### Unit 3 — the screen

`mobile/app/(staff)/email/[conversationId].jsx`, plus the two other composers.

**Header, option A.** One band: the subject (max 2 lines), then one chips row —
status chip, short mailbox chip (`@ Accounts`), the related nudge as a chip
(`🔗 1 other`), and `Details ⌄` at the end. `Details` expands in place to the
facts the bands used to spend a line each on: the full mailbox label,
`threadLines.primary`, `threadLines.opener`, and the linked contact.

The short mailbox chip comes from a new pure helper `shortMailboxLabel` in
`mobile/lib/mail-conversations.js` — the leading segment of `mailboxLabel`
(`Accounts - Hatch Street` → `Accounts`), with the full label in Details.
🔴 The no-mailbox case keeps being said **in words**, not shortened away:
`mailbox_id` is `ON DELETE SET NULL`, so a deleted address orphans its
correspondence rather than hiding it, and "No mailbox on this conversation"
is the sentence that makes that visible.

- The **nudge chip** replaces the blue banner. Tapping it opens a small sheet
  with the banner's two actions — open the newest related conversation, or
  merge. 🔴 `relatedNudge`'s rule is untouched: an unknown count renders
  **nothing**, never `0`, and a failed related read is `null`, never `[]`.
- The **tombstone pointer band is unchanged.** Tombstones are read-only
  everywhere.

**Composer.** Collapsed to a pill by default — "Reply to <name>…", a lock icon
that switches straight to note mode, a disabled send. Tapping expands it.

- A hydrating draft **expands without focusing**, mirroring desktop's rule. On
  a phone stealing focus also raises the keyboard unbidden.
- 🔴 **A typed draft is sacred** (MAIL-DOCK.2's lesson). Collapsing the pill
  keeps the text and shows "Draft saved" in the pill. Nothing discards a draft.
- **Bounded.** Expanded, the composer container is capped at
  `Math.max(168, Math.round(availableHeight * 0.4))`, where `availableHeight`
  is the `KeyboardAvoidingView`'s own measured height — so the cap is of the
  space above the keyboard, and it scrolls inside itself. Today only the
  `TextInput` is capped (`max-h-32`); the attachment chips, the budget line and
  the gate sentences below it are not, so a three-file reply can push Send off
  screen.
- **Audience.** Reply mode: `To Sean Mulcahy & 1 other ⓘ`, with the full
  sentence expanding in place on ⓘ. 🔴 **Note mode keeps its full sentence,
  always.** That sentence is a safety claim, not chrome: this file's own
  invariant is that the composer states its mode three ways — the selected
  segment, the colour of the card, and the sentence naming who receives what.
  Only the reply half compacts. All the copy still comes from the one
  derivation (`conversationReplyAudienceMeta`), so the screen cannot say two
  things about who a reply reaches.
- **The signature box goes**, from `[conversationId].jsx`, `forward.jsx` and
  `compose.jsx`. `resolveSignatureHint` and `fetchSignatureContexts` become
  unused on those screens and their imports go with them. Straight parity with
  MAIL-READER.1 decision 2 — and the reason the box was added on mobile
  (MOBILE-SIGHINT.1: the phone has no signature editor to link to) is also the
  reason deleting it costs nothing.

**Notices.** `html_unsafe` and `html_omitted` currently have no mobile render at
all. Both get one sentence, matching desktop's wording, above the text
fallback; `html_truncated` gets a third ("The rest of this email is not shown").

**Spam.** `setConversationSpam(id, spam, locationId)` in
`mobile/lib/email-api.js` posting `{ spam }`. The ⋮ overflow gains **Mark as
spam** / **Not spam**, labelled off the conversation's current `is_spam`. On
success the screen updates in place and stays put — the same posture archive
already takes, rather than popping the operator back to a list.

### Unit 4 — the two defects

**Numeric character references.** `htmlToPlainText`
(`src/lib/email-content.js:66`) decodes six named entities and no numeric ones,
so `&#38;`, `&#39;` and `&#x27;` pass through. It runs at **ingest** — the
Postmark inbound webhook and `sent-lane.js` both store
`TextBody || htmlToPlainText(HtmlBody)` — so the mangled text is already in
`text_body` on every affected row, and this is a desktop defect too wherever
text is the fallback. Two halves, because fixing the function only helps new
mail:

- **New:** `shared/mail-entities.js` exporting `decodeCharRefs(text)` —
  decimal and hex references plus the named set already handled. It goes in
  `shared/` because both platforms need it at render, with a `src/lib`
  re-export and a `PAIRS` entry in `tests/shared-pair-sync.test.js`
  (`mode: 'reexport'`), the pattern `shared/mail-quote.js` already follows.
- `htmlToPlainText` calls it, so new mail is stored clean; the phone calls it
  when rendering `text_body`, so the rows already stored read correctly. It is
  safe at render because the destination is an RN `<Text>` — decoding cannot
  produce markup there.

**The URL wall.** Solved for HTML mail by `linkLabel` (Unit 2) rendering the
anchor's label. For genuinely text-only mail, a bare URL in `text_body` renders
as a tappable `host/…` with the full address on long-press.

## Safety invariants that must not move

Carried forward verbatim from the files being edited. Each already has a test;
none may be weakened by this change.

1. **An internal note is stored with `direction: 'outbound'`.**
   `conversationMessageKind` tests `is_internal_note` **first**, and only what
   it decides gets painted — collapsed rows included. Nobody may ever think a
   note went to the member, or that a reply stayed private.
2. **The note composer states its mode three times.** Segment, colour,
   sentence. The sentence does not compact.
3. **Blocked images stay blocked until asked.** Show images is the only
   promotion, and the privacy sentence says why in words.
4. **A tombstone is read-only.** Composer hidden, archive/unread/forward
   disabled on `merged_into_id`.
5. **A failed related read is `null`, not `[]`.** The nudge hides; nothing
   claims "no duplicates" off a blip.
6. **The loud delivery panel never folds.** The flat row's calm reads as "we
   answered them", and that belief is exactly what is wrong when a reply
   bounced.
7. **Spam is orthogonal to the lifecycle.** The route touches only the spam
   columns; the phone must not infer a status change from a quarantine.

## Backward compatibility and OTA sequencing

Server first, then the bundle — the normal order, since a push to `main`
touching a bundle path publishes the OTA at 100% to every device on the runtime
lane on next launch.

- **Old bundle, new server:** sends no `body` parameter, gets today's response.
- **New bundle, old server** (a server rollback after the OTA): no
  `html_blocks` on the wire, so `EmailBody` receives nothing and the screen
  renders `text_body` — today's behaviour. **Absence of blocks is never an
  error state**, it is the text path.
- No native change, no `runtimeVersion` bump, no store submission. No new
  dependency in either tree, so neither audit allowlist is touched.
- No migration.

## Testing

**Pure lib, vitest — where the real proof lives.** The parse and every render
decision are pure functions precisely so that a green suite means something
here: 🔴 jsdom cannot see layout, and this repo has already shipped a toggle
that did nothing behind a green suite.

- `email-blocks.js`: real captured emails (the Docusign notification among
  them) → expected trees; a layout table flattens; a `<th>` table survives as
  `table`; a remote image arrives as `blocked`, a `cid:`/`data:`/relative one
  is dropped, and no block ever carries a live URL; an anchor
  alone in a cell becomes `link` and one in a sentence stays a run; each cap
  fires and sets `truncated`; a parser throw reports `failed` and returns no
  blocks. **A test asserting no image block ever carries a URL the sanitiser
  had not parked** — `blocked` is the only URL field an image block has, and
  that is the one property the phone's security rests on.
- Route: `?body=blocks` omits `html_document`; an absent or unknown value
  returns today's shape byte-for-byte; the block budget omits past its limit,
  newest-first.
- `mail-blocks.js`: unknown block types are dropped, not thrown on;
  `blockedImageCount` agrees with what `imageState` would draw over the same
  tree; `linkLabel` shortens a bare URL and leaves real link text alone;
  `splitTextLinks` over the Docusign body — the exact text in the screenshot —
  yields the URL as one link segment.
- `shared/mail-entities.js`: decimal, hex, named, malformed (`&#;`, `&#x;`),
  and a decode that must not run twice (`&amp;#38;` → `&#38;`, not `&`).
- `tests/mail-vocabulary-agreement.test.js` gains the assertion that was
  missing: **mobile's `TICKET_VIEW_TABS` ids equal `shared.MAIL_VIEWS` ids, in
  the same order.** That is the test whose absence let the Spam view go
  missing.
- Screen-level jsdom, for the DOM facts only: the signature box is gone from
  all three composers; the header renders one chips row and `Details` reveals
  the folded facts; the composer starts collapsed and a hydrated draft expands
  it without focusing; note mode still renders its full sentence; the ⋮ carries
  the spam action with the right label in both directions.

**What jsdom cannot answer, and who does:** the 40% cap and how the compact
header actually feels are device checks. Richard, on the OTA, once it lands.

## Out of scope

- **Adding recipients.** Cc/Bcc and the chip input stay web-only — a
  confidentiality control wants real device QA, and a reply from the phone
  already reaches everyone the server derives.
- **"View original" in the in-app browser.** Waits until the renderer proves it
  needs help; the new public route it needs is a four-allowlist change.
- **A native WebView.** Decided against: no new binary for this.
- **The Mail tab list**, beyond adding the Spam view and the agreement
  assertion. Subject-first rows, the Sent split, search and the account filter
  all landed on the phone already.
- **Desktop's reading mode.** Stays on desktop. The divergence is decision 2.
- **The per-message To/Cc/Bcc lines.** They already render only when there is
  something to say, so there is no clutter to fold.
