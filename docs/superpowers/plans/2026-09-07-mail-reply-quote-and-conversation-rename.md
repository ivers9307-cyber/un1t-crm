# Mail reply quoting + conversation rename — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Read the **Execution model** section first: it fixes which tasks run in parallel, which model runs each, and what an agent may and may not do.

**Goal:** A reply from the Mail surface quotes the most recent message in either direction and threads onto it; the CRM thread collapses quoted text; and every "ticket" in code paths, names and operator copy becomes "conversation", with shims for the phone bundle already in the field.

**Architecture:** Three pure modules carry the behaviour (`shared/mail-quote.js` splits quoted text for both apps, `src/lib/mail/reply-quote.js` builds the outbound quote and threading headers, `splitQuotedHtml` in `src/lib/email-html.js` splits sanitised HTML). The reply route, the thread GET route and the two thread renderers wire them in. The rename is a `git mv` plus import rewrite done in one serial step, then three disjoint parallel steps, then a copy/identifier sweep.

**Tech Stack:** Next.js 16 app router (JS, no TS), Supabase service-role client, vitest (node env, react-dom/server static markup for components, no jsdom), Expo/React Native mobile, `sanitize-html` + `htmlparser2`, Postmark + nodemailer SMTP.

**Spec:** `docs/superpowers/specs/2026-09-07-mail-reply-quote-and-conversation-rename-design.md` (commit `4e2f05f7`). The spec wins on any disagreement with this plan.

---

## Execution model

**Worktree and branch.** All work happens in `~/code/un1t-crm-mailreply` on branch `mail-reply-quote-conversation` (cut from `origin/main` at `367bfc88`). Seed `node_modules` once, before Wave 1:

```bash
cd ~/code/un1t-crm-mailreply && git diff --stat HEAD ../un1t-crm/HEAD -- package-lock.json 2>/dev/null; diff -q package-lock.json ../un1t-crm/package-lock.json && cp -Rc ../un1t-crm/node_modules ./node_modules && ls node_modules | wc -l
```

Expected: `Files … are identical` then a count around 800. If the lockfiles differ, run `npm ci` instead. Task 3 adds a dependency, so after Wave 1 run `npm install --no-audit --no-fund` once.

**Waves.** Tasks inside a wave run in parallel as separate subagents; waves run in order. The orchestrator (this session) runs the gates between waves and does every commit.

| Wave | Tasks | Parallel | Model |
|---|---|---|---|
| 0 | Task 0 Fable audit | no | fable |
| 1 | Tasks 1, 2, 3, 4 | yes, all four | 1 and 4 sonnet; 2 and 3 opus |
| 2a | Task 5 lib move | no | sonnet |
| 2b | Tasks 6, 7, 8 | yes, all three | sonnet |
| 2c | Task 9 copy + identifier sweep + docs | no | sonnet |
| 3 | Tasks 10, 11, 12, 13 | yes, all four | 10, 11, 12 opus; 13 sonnet |
| 4 | Task 14 gates, review, PR, verification, OTA, smoke | no | orchestrator + one code-review pass |

**Why this split.** Wave 1 is pure code that touches no existing file except two small additive edits, so nothing collides. Wave 2a moves libs that every later file imports, so it runs alone. Wave 2b's three tasks touch disjoint trees (`src/components/**` + client fetch paths; `src/app/api/email/**`; `mobile/**`). Wave 3's four tasks each own one file family. Wave 2c runs alone because a regex sweep across 300 files cannot share a tree.

**Rules for every subagent** (paste into every prompt):

1. Work only in `~/code/un1t-crm-mailreply`. Never `cd` elsewhere, never `git checkout`, `git pull`, `git stash`, `git commit` or `git push`. The orchestrator commits.
2. Touch only the files your task lists. If you believe another file must change, stop and say so in your report instead of editing it.
3. Read the spec section your task names, not the whole spec, unless a step tells you to.
4. TDD: write the failing test, run it and see it fail, implement, run it and see it pass. Paste the final test command's summary line in your report.
5. Report in at most 15 lines: files changed, test summary line, anything left undone, anything you noticed but did not touch.
6. Do not run `npm run build`, the full `npm test`, or any `check:*` script. The orchestrator runs those between waves. Run only the test files your task names: `npx vitest run <path>`.
7. No new dependencies except where the task says so. No "while I'm here" edits. No renaming beyond the task's list.

**Token discipline.** Sonnet for anything mechanical (moves, sed, copy). Opus only for the four modules with real logic and the three route/component wirings. Fable only for Task 0 and, if the orchestrator's review after Wave 3 finds a defect it cannot place, one targeted question. Subagent prompts carry the task text verbatim plus the rules above; they do not carry this whole plan.

**Orchestrator loop between waves.**

```bash
cd ~/code/un1t-crm-mailreply && npm test 2>&1 | tail -6 && npm run lint 2>&1 | tail -3
```

Expected after every wave: `Test Files N passed`, `Tests N passed`, and lint with no output beyond the command echo. After Wave 2c and Wave 3 also run `npm run build 2>&1 | tail -15` (expected: the route table and `✓ Compiled` with no red lines) and the full mirror from CLAUDE.md line 91. Then commit that wave with the files named in the task (`git add <paths>`, never `git add -A`).

---

## File structure

**New files**

| File | Responsibility |
|---|---|
| `shared/mail-quote.js` | `splitQuotedText(text)`: where quoted text starts in a plain-text body. Pure. Both apps. |
| `shared/mail-quote.test.js` | Its tests. |
| `src/lib/mail-quote.js` | `export * from '@shared/mail-quote'` (web import path). |
| `src/lib/mail/reply-quote.js` | Anchor selection, Message-ID derivation, References chain, attribution line, text and HTML quote assembly. Pure. |
| `src/lib/mail/reply-quote.test.js` | Its tests. |
| `src/app/api/email/mail/_conversation.js` | The moved ticket helpers (`loadConversationForUser` etc.). |
| `src/app/api/email/mail/compose/route.js`, `src/app/api/email/mail/[id]/route.js`, `.../[id]/reply/route.js`, `.../[id]/forward/route.js`, `.../[id]/participants/route.js`, `.../[id]/merge/route.js`, `.../[id]/read/route.js`, `.../[id]/link-contact/route.js`, `.../[id]/attachments/_helpers.js`, `.../[id]/attachments/[attachmentId]/route.js`, `.../[id]/attachments/[attachmentId]/preview/route.js` | Moved handlers (with their `.test.js` files). |
| `src/app/api/email/tickets/**/route.js` (rewritten) | One-line shims re-exporting the moved handlers. |
| `src/app/api/email/tickets/shims.test.js` | Runtime-identity test for every shim. |
| `src/lib/mail/conversation-display.js`, `src/lib/mail/conversation.js`, `src/lib/mail/conversation-merge.js` | Moved from `src/lib/ticket-display.js`, `src/lib/email-tickets.js`, `src/lib/email-ticket-merge.js`. |
| `src/components/mail/ConversationThread.jsx`, `ReplyBox.jsx`, `ComposeForm.jsx`, `ForwardForm.jsx` (+ `AttachmentPicker.jsx`, `AttachmentPreview.jsx`, `RecipientEditor.jsx`, `SignatureHint.jsx`) | Moved from `src/components/tickets/`. |
| `mobile/lib/mail-conversations.js` | Moved from `mobile/lib/email-tickets.js`. |
| `mobile/app/(staff)/email/[conversationId].jsx` | Moved from `[ticketId].jsx`. |
| `src/app/api/cron/purge-spam-mail/route.js` | Moved from `purge-spam-tickets`. |

**Modified files (behaviour)**

| File | Change |
|---|---|
| `src/lib/email-inbox.js` | `buildReplyHeaders` gains an `inReplyTo` fallback for References. |
| `src/lib/email-html.js` | `splitQuotedHtml(html)` and `emailHtmlDocuments(raw)`. |
| `package.json` | `htmlparser2` as a direct dependency. |
| `tests/shared-pair-sync.test.js` | `mail-quote.js` manifest entry, mode `reexport`. |
| `src/app/api/email/mail/[id]/reply/route.js` | Anchor query, headers, quoted body, stored `references_header`. |
| `src/app/api/email/mail/[id]/route.js` | `html_quoted_document` on each message. |
| `src/components/mail/ConversationThread.jsx` | Quote pill for text and HTML paths. |
| `src/components/mail/mail-vocabulary.js` | `messageSnippet` uses the split body. |
| `mobile/app/(staff)/email/[conversationId].jsx` | Quote pill. |
| `mobile/lib/mail-conversations.js` | `flatMessageMeta` snippet uses the split body. |
| `mobile/lib/email-api.js` | New API paths. |
| `src/lib/openapi.js`, `vercel.json`, `docs/CHANGELOG.md` | Docs, cron path, changelog row. |

---

## Wave 0

### Task 0: Fable audit of spec and plan against the tree

**Model:** fable. **Files:** none modified. Output is a report.

- [ ] **Step 1: Dispatch the audit**

Prompt (verbatim, plus the seven rules):

> You are auditing before implementation. Read `docs/superpowers/specs/2026-09-07-mail-reply-quote-and-conversation-rename-design.md` and `docs/superpowers/plans/2026-09-07-mail-reply-quote-and-conversation-rename.md` in `~/code/un1t-crm-mailreply`. Then verify each of these against the actual code and report every mismatch, with file and line:
> 1. Every import path the plan's `git mv` steps rewrite: run the grep in Task 5 step 1 and Task 6 step 1 and confirm the lists are complete. Name any importer the plan misses.
> 2. Any file that two parallel tasks in the same wave would both modify. List the pairs.
> 3. The identifier exclusion list in Task 9 step 2: grep for `ticket` in `src`, `mobile`, `shared`, `tests` and name any identifier, string or DB name the sweep would wrongly rewrite (audit action strings, Postmark tags, `email_tickets`, `ticket_id`, `merged_from_ticket_id`, `_test-db` state keys, fixture names) that is not already excluded.
> 4. Whether `htmlparser2` 12's `DomUtils` export provides `findOne`, `getOuterHTML`, `getInnerHTML`, `removeElement`, `textContent` (check `node_modules/htmlparser2/package.json` and its `lib/index.js`).
> 5. Whether `src/app/api/email/mail/[id]/route.js` can be a GET thread route while `[id]/archive`, `seen`, `spam`, `related` exist beside it (it can; confirm no `route.js` exists there today).
> 6. The `mobile/app/(staff)/email/[ticketId].jsx` rename: confirm `useLocalSearchParams` is the only reader of the param name, and that `scripts/check-ota-trigger-paths.mjs` and `tests/ota-trigger-paths.test.js` do not pin that filename.
> 7. Whether `check:mobile-imports` needs `shared/mail-quote.js` registered anywhere (read `scripts/check-mobile-imports.mjs`).
> 8. Whether `check:route-guards` or `check:location-scoping` pin route file paths under `src/app/api/email/tickets` (read the scripts; report the exact lines).
> 9. In the reply route, whether anything besides the threading lookup reads `lastInbound` (subject, headers) so the anchor swap in Task 10 is complete.
> 10. Anything in the plan that would fail `next build` (an import of a moved file, a route file that exports nothing, a shim re-export path that Next cannot resolve).
> Report as a numbered list. Do not edit any file.

- [ ] **Step 2: Amend this plan**

Fold every confirmed finding into the task it affects (add the missing importer to the sed list, add the exclusion, split a file conflict). Commit the amended plan:

```bash
git add docs/superpowers/plans/2026-09-07-mail-reply-quote-and-conversation-rename.md && git commit -m "MAIL-REPLY-QUOTE.1 — plan amended after Fable audit"
```

---

## Wave 1 (parallel: Tasks 1, 2, 3, 4)

### Task 1: `shared/mail-quote.js` — split quoted text (sonnet)

**Spec section:** "Quote collapsing in the thread → The splitter".

**Files:**
- Create: `shared/mail-quote.js`, `shared/mail-quote.test.js`, `src/lib/mail-quote.js`
- Modify: `tests/shared-pair-sync.test.js` (one manifest entry, after the `'mail-vocabulary.js'` entry)

- [ ] **Step 1: Write the failing tests**

`shared/mail-quote.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { splitQuotedText } from './mail-quote.js'

describe('splitQuotedText', () => {
  it('returns the whole text as body when nothing is quoted', () => {
    expect(splitQuotedText('Hello\n\nThanks,\nRichard')).toEqual({ body: 'Hello\n\nThanks,\nRichard', quoted: '' })
  })

  it('splits at a one-line attribution', () => {
    const text = 'Sounds good.\n\nOn Mon 7 Sep 2026 at 13:34, Richard Ivers <richard@richardivers.com> wrote:\n> test\n> more'
    expect(splitQuotedText(text)).toEqual({
      body: 'Sounds good.',
      quoted: 'On Mon 7 Sep 2026 at 13:34, Richard Ivers <richard@richardivers.com> wrote:\n> test\n> more',
    })
  })

  it("splits at Gmail's wrapped attribution (address on the next line), with no blank line before it", () => {
    const text = 'Test test 2\nOn Mon 7 Sep 2026 at 13:33 Hatch Street Fitness Accounts <\naccounts@hatchstreetfitness.com> wrote:\n\n> test\n> RI'
    const out = splitQuotedText(text)
    expect(out.body).toBe('Test test 2')
    expect(out.quoted.startsWith('On Mon 7 Sep 2026 at 13:33 Hatch Street Fitness Accounts <\naccounts@')).toBe(true)
  })

  it('does not treat a sentence starting with "On" as an attribution when no "wrote:" follows within two lines', () => {
    const text = 'On Monday we open at 6.\nSee you then.\nCheers'
    expect(splitQuotedText(text)).toEqual({ body: text, quoted: '' })
  })

  it('splits at the first run of > lines when there is no attribution', () => {
    const text = 'Yes.\n\n> can we move to 7?\n> thanks'
    expect(splitQuotedText(text)).toEqual({ body: 'Yes.', quoted: '> can we move to 7?\n> thanks' })
  })

  it('splits at the forwarded-message separator (ours and Gmail\'s)', () => {
    expect(splitQuotedText('FYI\n\n---------- Forwarded message ----------\nFrom: a@b.c').body).toBe('FYI')
    expect(splitQuotedText('FYI\n---------- Forwarded message ---------\nFrom: a@b.c').body).toBe('FYI')
  })

  it("splits at Outlook's Original Message separator", () => {
    expect(splitQuotedText('Ok\n\n-----Original Message-----\nFrom: x').body).toBe('Ok')
  })

  it("splits at Outlook desktop's underscore rule followed by From:", () => {
    const text = 'Ok\n\n________________________________\nFrom: Colm <colm@x.ie>\nSent: Monday'
    expect(splitQuotedText(text).body).toBe('Ok')
    expect(splitQuotedText(text).quoted.startsWith('________________________________\nFrom:')).toBe(true)
  })

  it('does not split at a signature delimiter', () => {
    const text = 'Thanks\n\n-- \nRichard Ivers\nUN1T'
    expect(splitQuotedText(text)).toEqual({ body: text, quoted: '' })
  })

  it('keeps the signature in the body when a quote follows it', () => {
    const text = 'Thanks\n\n-- \nRichard\n\nOn Mon 7 Sep 2026 at 13:34, A <a@b.c> wrote:\n> hi'
    expect(splitQuotedText(text).body).toBe('Thanks\n\n-- \nRichard')
  })

  it('normalises CRLF and trims trailing blank lines off the body', () => {
    expect(splitQuotedText('Hi\r\n\r\n> a\r\n')).toEqual({ body: 'Hi', quoted: '> a' })
  })

  it('never throws on non-string input', () => {
    expect(splitQuotedText(null)).toEqual({ body: '', quoted: '' })
    expect(splitQuotedText(undefined)).toEqual({ body: '', quoted: '' })
    expect(splitQuotedText(42)).toEqual({ body: '', quoted: '' })
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run shared/mail-quote.test.js`
Expected: FAIL, `Failed to resolve import "./mail-quote.js"`.

- [ ] **Step 3: Implement**

`shared/mail-quote.js`:

```js
// MAIL-REPLY-QUOTE.1 — where quoted text starts in a plain-text email body.
//
// One implementation for both apps (mobile cannot import src/lib; web reaches
// it through src/lib/mail-quote.js, a re-export asserted by runtime identity
// in tests/shared-pair-sync.test.js). Pure: no DOM, no clock, no fetch.
//
// The thread shows `body` and folds `quoted` behind "Show quoted text". The
// signature delimiter ("-- ") is NOT a split point: a signature is part of
// the message the person wrote.

const ATTRIBUTION_START = /^On\b/
const WROTE_END = /wrote:\s*$/
const QUOTE_LINE = /^>/
const FORWARD_SEPARATOR = /^-{5,}\s*Forwarded message\s*-{5,}\s*$/i
const ORIGINAL_MESSAGE = /^-{5,}\s*Original Message\s*-{5,}\s*$/i
const RULE_LINE = /^[_-]{10,}\s*$/
const FROM_LINE = /^From:/i

// The attribution may wrap onto a second or third line (Gmail breaks a long
// name+address before the address), so "wrote:" is accepted on this line or
// either of the next two.
function isAttribution(lines, i) {
  if (!ATTRIBUTION_START.test(lines[i])) return false
  for (let k = i; k < Math.min(i + 3, lines.length); k++) {
    if (WROTE_END.test(lines[k])) return true
  }
  return false
}

function isOutlookHeader(lines, i) {
  if (!RULE_LINE.test(lines[i])) return false
  for (let k = i + 1; k < Math.min(i + 3, lines.length); k++) {
    if (FROM_LINE.test(lines[k])) return true
  }
  return false
}

/**
 * @param {unknown} text
 * @returns {{ body: string, quoted: string }}
 */
export function splitQuotedText(text) {
  if (typeof text !== 'string') return { body: '', quoted: '' }
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let at = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (
      isAttribution(lines, i)
      || QUOTE_LINE.test(line)
      || FORWARD_SEPARATOR.test(line)
      || ORIGINAL_MESSAGE.test(line)
      || isOutlookHeader(lines, i)
    ) { at = i; break }
  }
  if (at < 0) return { body: lines.join('\n').replace(/\n+$/, ''), quoted: '' }
  return {
    body: lines.slice(0, at).join('\n').replace(/\n+$/, ''),
    quoted: lines.slice(at).join('\n').replace(/\n+$/, ''),
  }
}
```

Note on the first test: the no-quote case returns the text with trailing newlines trimmed only; `'Hello\n\nThanks,\nRichard'` has none, so it round-trips.

`src/lib/mail-quote.js`:

```js
// MAIL-REPLY-QUOTE.1 — web import path for the shared splitter. See
// shared/mail-quote.js; tests/shared-pair-sync.test.js asserts by runtime
// identity that this binding IS the shared one.
export * from '@shared/mail-quote'
```

- [ ] **Step 4: Register the pair**

In `tests/shared-pair-sync.test.js`, directly after the `'mail-vocabulary.js': { … }` entry, add:

```js
  'mail-quote.js': {
    mode: 'reexport',
    why: 'MAIL-REPLY-QUOTE.1 — the quoted-text splitter serves the web thread and the mobile thread; src/lib re-exports shared.',
  },
```

- [ ] **Step 5: Run to see it pass**

Run: `npx vitest run shared/mail-quote.test.js tests/shared-pair-sync.test.js`
Expected: both files PASS (the pair-sync test now includes `mail-quote.js`).

### Task 2: `src/lib/mail/reply-quote.js` — anchor, threading, quote assembly (opus)

**Spec section:** "Reply behaviour (MAIL-REPLY-QUOTE.1)". Read it in full.

**Files:**
- Create: `src/lib/mail/reply-quote.js`, `src/lib/mail/reply-quote.test.js`

Depends on: `forwardedBody`, `FORWARD_TRUNCATED_NOTE` from `src/lib/email-forward.js` (existing).

- [ ] **Step 1: Write the failing tests**

`src/lib/mail/reply-quote.test.js`:

```js
import { describe, it, expect } from 'vitest'
import {
  selectReplyAnchor, anchorMessageId, replyReferences, replyThreadingHeaders,
  attributionStamp, attributionLine, quotedTextBlock, buildReplyText, buildReplyHtml,
  escapeHtml,
} from './reply-quote'
import { FORWARD_QUOTE_MAX_CHARS, FORWARD_TRUNCATED_NOTE } from '@/lib/email-forward'

const inbound = {
  id: 'in-1', direction: 'inbound', from_email: 'Richard@richardivers.com', subject: 'Re: test',
  text_body: 'Test test 2\n> test', rfc_message_id: 'CANz@mail.gmail.com', postmark_message_id: 'pm-in',
  in_reply_to: '<80d4@mtasv.net>', references_header: '<80d4@mtasv.net>', created_at: '2026-09-07T12:34:15Z',
}
const outboundPostmark = {
  id: 'out-1', direction: 'outbound', from_email: 'accounts@hatchstreetfitness.com', subject: 'test',
  text_body: 'test\n\n-- \nRichard', rfc_message_id: null, postmark_message_id: '80d4bc38-22a5-4462-b93e-5dd29704d473',
  in_reply_to: null, references_header: null, created_at: '2026-09-07T12:33:47Z', is_internal_note: false,
}
const outboundSmtp = { ...outboundPostmark, id: 'out-2', rfc_message_id: 'e6c4@un1t.com', postmark_message_id: null }
const note = { id: 'n-1', direction: 'outbound', is_internal_note: true, text_body: 'staff only', created_at: '2026-09-07T12:40:00Z' }
const conversation = { requester_email: 'richard@richardivers.com', requester_name: 'Richard Ivers' }
const mailbox = { address: 'accounts@hatchstreetfitness.com', label: 'Hatch Street Fitness Accounts' }

describe('selectReplyAnchor', () => {
  it('picks the newest message by created_at in either direction', () => {
    expect(selectReplyAnchor([outboundPostmark, inbound]).id).toBe('in-1')
    expect(selectReplyAnchor([inbound, { ...outboundPostmark, created_at: '2026-09-07T12:50:00Z' }]).id).toBe('out-1')
  })
  it('skips internal notes', () => {
    expect(selectReplyAnchor([inbound, note]).id).toBe('in-1')
  })
  it('includes forwards', () => {
    const fwd = { ...outboundPostmark, id: 'fwd', forwarded_message_id: 'in-1', created_at: '2026-09-07T12:50:00Z' }
    expect(selectReplyAnchor([inbound, fwd]).id).toBe('fwd')
  })
  it('returns null for an empty or note-only list', () => {
    expect(selectReplyAnchor([])).toBeNull()
    expect(selectReplyAnchor([note])).toBeNull()
    expect(selectReplyAnchor(null)).toBeNull()
  })
})

describe('anchorMessageId', () => {
  it('brackets a stored rfc id', () => {
    expect(anchorMessageId(inbound)).toBe('<CANz@mail.gmail.com>')
    expect(anchorMessageId({ rfc_message_id: '<already@x>' })).toBe('<already@x>')
  })
  it('derives the mtasv id for a Postmark-sent outbound row', () => {
    expect(anchorMessageId(outboundPostmark)).toBe('<80d4bc38-22a5-4462-b93e-5dd29704d473@mtasv.net>')
  })
  it('prefers the rfc id on an SMTP-sent row', () => {
    expect(anchorMessageId(outboundSmtp)).toBe('<e6c4@un1t.com>')
  })
  it('is null with neither, and never derives mtasv for an inbound row', () => {
    expect(anchorMessageId({ direction: 'outbound' })).toBeNull()
    expect(anchorMessageId({ direction: 'inbound', postmark_message_id: 'pm' })).toBeNull()
  })
})

describe('replyReferences / replyThreadingHeaders', () => {
  it('appends the anchor id to its References chain', () => {
    expect(replyReferences(inbound)).toBe('<80d4@mtasv.net> <CANz@mail.gmail.com>')
  })
  it('falls back to In-Reply-To when the anchor has no References', () => {
    expect(replyReferences({ ...inbound, references_header: null })).toBe('<80d4@mtasv.net> <CANz@mail.gmail.com>')
    expect(replyReferences({ ...inbound, references_header: '', in_reply_to: '80d4@mtasv.net' })).toBe('<80d4@mtasv.net> <CANz@mail.gmail.com>')
  })
  it('is just the anchor id when it has neither', () => {
    expect(replyReferences(outboundPostmark)).toBe('<80d4bc38-22a5-4462-b93e-5dd29704d473@mtasv.net>')
  })
  it('emits both headers, or none when there is no id', () => {
    expect(replyThreadingHeaders(inbound)).toEqual([
      { Name: 'In-Reply-To', Value: '<CANz@mail.gmail.com>' },
      { Name: 'References', Value: '<80d4@mtasv.net> <CANz@mail.gmail.com>' },
    ])
    expect(replyThreadingHeaders({ direction: 'outbound' })).toEqual([])
    expect(replyThreadingHeaders(null)).toEqual([])
  })
})

describe('attributionStamp', () => {
  it('renders Dublin time as "Mon 7 Sep 2026 at 13:34"', () => {
    expect(attributionStamp('2026-09-07T12:34:15Z')).toBe('Mon 7 Sep 2026 at 13:34')
  })
  it('is empty for a missing or unparseable timestamp', () => {
    expect(attributionStamp(null)).toBe('')
    expect(attributionStamp('nope')).toBe('')
  })
})

describe('attributionLine', () => {
  it('names the sender when the inbound address is the requester', () => {
    expect(attributionLine(inbound, { conversation, mailbox }))
      .toBe('On Mon 7 Sep 2026 at 13:34, Richard Ivers <Richard@richardivers.com> wrote:')
  })
  it('uses the bare address for an inbound from someone else', () => {
    expect(attributionLine({ ...inbound, from_email: 'colm@x.ie' }, { conversation, mailbox }))
      .toBe('On Mon 7 Sep 2026 at 13:34, colm@x.ie wrote:')
  })
  it('uses the mailbox label for an outbound from that mailbox', () => {
    expect(attributionLine(outboundPostmark, { conversation, mailbox }))
      .toBe('On Mon 7 Sep 2026 at 13:33, Hatch Street Fitness Accounts <accounts@hatchstreetfitness.com> wrote:')
  })
  it('falls back to the address alone for an outbound with no matching mailbox', () => {
    expect(attributionLine(outboundPostmark, { conversation, mailbox: null }))
      .toBe('On Mon 7 Sep 2026 at 13:33, accounts@hatchstreetfitness.com wrote:')
  })
  it('drops the stamp when there is none', () => {
    expect(attributionLine({ ...inbound, created_at: null, sent_at: null }, { conversation, mailbox }))
      .toBe('Richard Ivers <Richard@richardivers.com> wrote:')
  })
})

describe('quotedTextBlock', () => {
  it('prefixes every line with "> " and cascades an existing quote', () => {
    expect(quotedTextBlock({ text_body: 'a\n\n> b' })).toEqual({ text: '> a\n> \n>> b', truncated: false })
  })
  it('quotes a placeholder for an empty body', () => {
    expect(quotedTextBlock({ text_body: '' })).toEqual({ text: '> (no text content)', truncated: false })
  })
  it('caps at FORWARD_QUOTE_MAX_CHARS and says so', () => {
    const out = quotedTextBlock({ text_body: 'x'.repeat(FORWARD_QUOTE_MAX_CHARS + 5) })
    expect(out.truncated).toBe(true)
    expect(out.text.length).toBeLessThanOrEqual(FORWARD_QUOTE_MAX_CHARS + 2)
  })
})

describe('buildReplyText', () => {
  it('lays out words, signature, attribution, quote', () => {
    const text = buildReplyText({ signedText: 'test test 3\n\n-- \nRichard', anchor: inbound, conversation, mailbox })
    expect(text).toBe(
      'test test 3\n\n-- \nRichard\n\n'
      + 'On Mon 7 Sep 2026 at 13:34, Richard Ivers <Richard@richardivers.com> wrote:\n'
      + '> Test test 2\n>> test',
    )
  })
  it('appends the truncation note unquoted after the quote', () => {
    const text = buildReplyText({ signedText: 'ok', anchor: { ...inbound, text_body: 'y'.repeat(FORWARD_QUOTE_MAX_CHARS + 1) }, conversation, mailbox })
    expect(text.endsWith(`\n\n${FORWARD_TRUNCATED_NOTE}`)).toBe(true)
  })
  it('returns the signed text alone with no anchor', () => {
    expect(buildReplyText({ signedText: 'ok', anchor: null, conversation, mailbox })).toBe('ok')
  })
})

describe('buildReplyHtml', () => {
  it('appends an attribution div and a cite blockquote with escaped text', () => {
    const html = buildReplyHtml({ bodyHtml: '<div>body</div>', anchor: { ...inbound, text_body: '<script>x</script>\n& more' }, conversation, mailbox })
    expect(html.startsWith('<div>body</div>')).toBe(true)
    expect(html).toContain('On Mon 7 Sep 2026 at 13:34, Richard Ivers &lt;Richard@richardivers.com&gt; wrote:')
    expect(html).toContain('<blockquote type="cite"')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;\n&amp; more')
    expect(html).not.toContain('<script>')
  })
  it('returns the body alone with no anchor', () => {
    expect(buildReplyHtml({ bodyHtml: '<div>b</div>', anchor: null, conversation, mailbox })).toBe('<div>b</div>')
  })
})

describe('escapeHtml', () => {
  it('escapes the three characters textToHtml escapes, and quotes', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/lib/mail/reply-quote.test.js`
Expected: FAIL, `Failed to resolve import "./reply-quote"`.

- [ ] **Step 3: Implement**

`src/lib/mail/reply-quote.js`:

```js
// MAIL-REPLY-QUOTE.1 — what a reply quotes and what it threads onto.
//
// A mail client replies to the MOST RECENT message in the conversation,
// whoever sent it, quotes its text underneath the new words, and threads
// with In-Reply-To/References pointing at it. This module is that, pure.
// The reply route loads the anchor, builds the body and headers here, sends,
// and stores exactly what it sent.
//
// Only plain text is ever quoted (spec, "Quoting"): re-sending a stranger's
// sanitised HTML from the studio's own address is the forward path's refusal
// too, for the same reason.

import { forwardedBody, FORWARD_TRUNCATED_NOTE } from '@/lib/email-forward'

// Postmark mints the RFC Message-ID of everything it sends as
// <{MessageID}@mtasv.net>. Evidence: Richard's Gmail reply of 2026-09-07 had
// In-Reply-To <80d4bc38-…@mtasv.net>, the postmark_message_id of our compose.
export const POSTMARK_MESSAGE_ID_DOMAIN = 'mtasv.net'

const NO_TEXT = '(no text content)'

function bracket(id) {
  const s = String(id || '').trim()
  if (!s) return ''
  return s.startsWith('<') ? s : `<${s}>`
}

/**
 * The message a reply is a reply to: newest by created_at, notes excluded.
 * created_at, not sent_at — an inbound sent_at is the sender's own Date header.
 * @param {object[]|null} messages
 * @returns {object|null}
 */
export function selectReplyAnchor(messages) {
  if (!Array.isArray(messages)) return null
  let best = null
  for (const m of messages) {
    if (!m || m.is_internal_note) continue
    if (!best || String(m.created_at || '') > String(best.created_at || '')) best = m
  }
  return best
}

/**
 * The anchor's RFC Message-ID, bracketed, or null.
 * rfc_message_id wins (inbound rows, SMTP-sent rows). A Postmark-sent OUTBOUND
 * row has only postmark_message_id; derive it. Never for inbound rows: their
 * postmark_message_id is Postmark's inbound record id, not a Message-ID.
 */
export function anchorMessageId(message) {
  if (!message) return null
  if (message.rfc_message_id) return bracket(message.rfc_message_id)
  if (message.direction === 'outbound' && message.postmark_message_id) {
    return `<${String(message.postmark_message_id).trim()}@${POSTMARK_MESSAGE_ID_DOMAIN}>`
  }
  return null
}

/**
 * RFC 5322 §3.6.4: the parent's References (or its In-Reply-To when it has
 * none) followed by the parent's Message-ID.
 * @returns {string} '' when the anchor has no id at all
 */
export function replyReferences(message) {
  const id = anchorMessageId(message)
  if (!id) return ''
  const chain = String(message.references_header || '').trim()
    || bracket(message.in_reply_to)
  return chain ? `${chain} ${id}` : id
}

/** Postmark-shaped header list; [] when nothing can be threaded. */
export function replyThreadingHeaders(message) {
  const id = anchorMessageId(message)
  if (!id) return []
  return [
    { Name: 'In-Reply-To', Value: id },
    { Name: 'References', Value: replyReferences(message) },
  ]
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * "Mon 7 Sep 2026 at 13:34" in Europe/Dublin, the form Gmail writes.
 * Assembled from numeric parts so the month never renders as "Sept" (en-IE
 * and en-GB both do in current ICU) and so the output is the same under any
 * TZ a test runs in.
 */
export function attributionStamp(iso) {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Dublin', weekday: 'short', day: 'numeric', month: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(t))
  const get = (type) => parts.find(p => p.type === type)?.value || ''
  const weekday = get('weekday')
  const month = MONTHS[Number(get('month')) - 1] || get('month')
  const hour = get('hour') === '24' ? '00' : get('hour')
  return `${weekday} ${get('day')} ${month} ${get('year')} at ${hour}:${get('minute')}`
}

function sameAddress(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() && !!String(a || '').trim()
}

function whoWrote(anchor, { conversation, mailbox }) {
  const from = String(anchor?.from_email || '').trim()
  if (anchor?.direction === 'outbound') {
    if (mailbox?.label && sameAddress(mailbox.address, from)) return `${mailbox.label} <${from}>`
    return from || String(mailbox?.address || '').trim() || 'the studio'
  }
  if (from && conversation?.requester_name && sameAddress(conversation.requester_email, from)) {
    return `${conversation.requester_name} <${from}>`
  }
  return from || 'the sender'
}

/**
 * "On Mon 7 Sep 2026 at 13:34, Richard Ivers <richard@…> wrote:"
 * @param {object} anchor
 * @param {{ conversation: object|null, mailbox: object|null }} ctx
 */
export function attributionLine(anchor, ctx) {
  const stamp = attributionStamp(anchor?.sent_at || anchor?.created_at)
  const who = whoWrote(anchor, ctx || {})
  return stamp ? `On ${stamp}, ${who} wrote:` : `${who} wrote:`
}

/**
 * The anchor's text, bounded (forwardedBody: CRLF-normalised, 20k cap),
 * each line prefixed "> " — so a quoted ">" becomes ">>", the standard cascade.
 * @returns {{ text: string, truncated: boolean }}
 */
export function quotedTextBlock(anchor) {
  const { text, truncated } = forwardedBody(anchor)
  const source = text || NO_TEXT
  const lines = source.split('\n').map(line => (line.startsWith('>') ? `>${line}` : `> ${line}`))
  return { text: lines.join('\n'), truncated }
}

/**
 * The whole text part: signed words, blank line, attribution, quote, and the
 * truncation note (unquoted) when the cap bit. No anchor → the signed text.
 */
export function buildReplyText({ signedText, anchor, conversation, mailbox }) {
  const words = typeof signedText === 'string' ? signedText : ''
  if (!anchor) return words
  const { text, truncated } = quotedTextBlock(anchor)
  const parts = [words.replace(/\s+$/, ''), '', attributionLine(anchor, { conversation, mailbox }), text]
  if (truncated) parts.push('', FORWARD_TRUNCATED_NOTE)
  return parts.join('\n')
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The HTML part: the caller's body HTML (already escaped text + our own
 * signature block), then the attribution and a cite blockquote of the
 * escaped plain text. type="cite" is what Apple Mail folds; Gmail folds a
 * trailing blockquote it recognises as the previous message.
 */
export function buildReplyHtml({ bodyHtml, anchor, conversation, mailbox }) {
  const body = typeof bodyHtml === 'string' ? bodyHtml : ''
  if (!anchor) return body
  const { text, truncated } = forwardedBody(anchor)
  const quoted = escapeHtml(text || NO_TEXT) + (truncated ? `\n\n${escapeHtml(FORWARD_TRUNCATED_NOTE)}` : '')
  return body
    + `<div style="margin-top:12px;color:#5f6368;font-size:13px">${escapeHtml(attributionLine(anchor, { conversation, mailbox }))}</div>`
    + '<blockquote type="cite" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex;color:#5f6368">'
    + `<div style="white-space:pre-wrap">${quoted}</div></blockquote>`
}
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run src/lib/mail/reply-quote.test.js`
Expected: PASS, 30 tests. If `attributionStamp` yields `Sept` or a different weekday string, the failing assertion tells you which ICU part to map; fix the mapping, not the test.

### Task 3: `splitQuotedHtml` + `emailHtmlDocuments` in `src/lib/email-html.js` (opus)

**Spec section:** "Quote collapsing in the thread → Web thread, HTML path".

**Files:**
- Modify: `src/lib/email-html.js` (append after `emailHtmlDocument`), `package.json` (dependency), `src/lib/email-html.test.js` (append a describe block)

- [ ] **Step 1: Add the dependency**

```bash
npm install --save-exact --no-audit --no-fund htmlparser2@12.0.0
```

Expected: `package.json` gains `"htmlparser2": "12.0.0"` and `package-lock.json` changes only for that entry (it was already installed transitively at 12.0.0, so no new packages download).

- [ ] **Step 2: Write the failing tests**

Append to `src/lib/email-html.test.js`:

```js
import { splitQuotedHtml, emailHtmlDocuments } from './email-html'

describe('splitQuotedHtml', () => {
  it('splits at Gmail\'s gmail_quote container and keeps everything after it in the quote', () => {
    const html = '<div dir="ltr">Test test 2</div><div class="gmail_quote"><div dir="ltr">On Mon…wrote:</div><blockquote>test</blockquote></div><div>trailer</div>'
    const out = splitQuotedHtml(html)
    expect(out.body).toBe('<div dir="ltr">Test test 2</div>')
    expect(out.quoted).toBe('<div class="gmail_quote"><div dir="ltr">On Mon…wrote:</div><blockquote>test</blockquote></div><div>trailer</div>')
  })
  it('splits at Apple Mail\'s cite blockquote', () => {
    const out = splitQuotedHtml('<div>Yes</div><br><blockquote type="cite"><div>hi</div></blockquote>')
    expect(out.body).toBe('<div>Yes</div><br>')
    expect(out.quoted).toBe('<blockquote type="cite"><div>hi</div></blockquote>')
  })
  it('splits at Outlook\'s reply divider and at appendonsend', () => {
    expect(splitQuotedHtml('<p>Ok</p><div id="divRplyFwdMsg"><b>From:</b> x</div><p>old</p>').body).toBe('<p>Ok</p>')
    expect(splitQuotedHtml('<p>Ok</p><div id="appendonsend"></div><p>old</p>').quoted).toBe('<div id="appendonsend"></div><p>old</p>')
  })
  it('splits at Yahoo\'s yahoo_quoted', () => {
    expect(splitQuotedHtml('<div>a</div><div class="yahoo_quoted">b</div>').quoted).toBe('<div class="yahoo_quoted">b</div>')
  })
  it('matches a nested container and removes only it and its following siblings', () => {
    const out = splitQuotedHtml('<div><p>a</p><div class="gmail_quote">q</div><p>after</p></div><p>outside</p>')
    expect(out.body).toBe('<div><p>a</p></div><p>outside</p>')
    expect(out.quoted).toBe('<div class="gmail_quote">q</div><p>after</p>')
  })
  it('does not split when the whole message is the quote (nothing to show above it)', () => {
    const html = '<div class="gmail_quote">only</div>'
    expect(splitQuotedHtml(html)).toEqual({ body: html, quoted: '' })
  })
  it('does not split when there is no recognised container', () => {
    expect(splitQuotedHtml('<p>plain</p><blockquote>styled but not cite</blockquote>')).toEqual({ body: '<p>plain</p><blockquote>styled but not cite</blockquote>', quoted: '' })
  })
  it('handles empty input', () => {
    expect(splitQuotedHtml('')).toEqual({ body: '', quoted: '' })
    expect(splitQuotedHtml(null)).toEqual({ body: '', quoted: '' })
  })
})

describe('emailHtmlDocuments', () => {
  it('sanitises first, then splits, and wraps both halves', () => {
    const raw = '<div>hi<script>x()</script></div><blockquote type="cite">old</blockquote>'
    const out = emailHtmlDocuments(raw)
    expect(out.failed).toBe(false)
    expect(out.document).toContain('<div>hi</div>')
    expect(out.document).not.toContain('script')
    expect(out.document.startsWith('<!doctype html>')).toBe(true)
    expect(out.quotedDocument).toContain('<blockquote type="cite">old</blockquote>')
    expect(out.quotedDocument.startsWith('<!doctype html>')).toBe(true)
  })
  it('returns a null quotedDocument when nothing is quoted', () => {
    const out = emailHtmlDocuments('<p>just this</p>')
    expect(out.document).toContain('<p>just this</p>')
    expect(out.quotedDocument).toBeNull()
  })
  it('matches emailHtmlDocument on the empty and failed cases', () => {
    expect(emailHtmlDocuments('')).toEqual({ document: null, quotedDocument: null, blockedImages: 0, failed: false })
  })
})
```

- [ ] **Step 3: Run to see it fail**

Run: `npx vitest run src/lib/email-html.test.js`
Expected: FAIL, `splitQuotedHtml is not a function` (or missing export).

- [ ] **Step 4: Implement**

Add the import at the top of `src/lib/email-html.js`, beside the `sanitize-html` import:

```js
import { parseDocument, DomUtils } from 'htmlparser2'
```

Append after `emailHtmlDocument`:

```js
// MAIL-REPLY-QUOTE.1 — where a mail client's quoted chain starts in HTML.
//
// Runs on SANITISED output only (see emailHtmlDocuments): the sanitiser keeps
// `class`, `id` and `blockquote`, so the markers survive, and nothing
// unsanitised is ever split or returned. The first recognised container in
// document order, plus every sibling after it, is the quote; the document
// with those removed is the body.

const QUOTE_CLASSES = ['gmail_quote', 'gmail_quote_container', 'yahoo_quoted']
const QUOTE_IDS = ['divRplyFwdMsg', 'appendonsend']

function isQuoteContainer(el) {
  if (el.type !== 'tag') return false
  const attribs = el.attribs || {}
  if (el.name === 'blockquote' && String(attribs.type || '').toLowerCase() === 'cite') return true
  if (QUOTE_IDS.includes(attribs.id)) return true
  const classes = String(attribs.class || '').split(/\s+/)
  return classes.some(c => QUOTE_CLASSES.includes(c))
}

/**
 * @param {string} html  sanitised body HTML (a fragment, not a document)
 * @returns {{ body: string, quoted: string }}
 */
export function splitQuotedHtml(html) {
  const source = typeof html === 'string' ? html : ''
  if (!source.trim()) return { body: '', quoted: '' }
  const dom = parseDocument(source)
  const match = DomUtils.findOne(isQuoteContainer, dom.children, true)
  if (!match) return { body: source, quoted: '' }

  const tail = []
  for (let node = match; node; node = node.next) tail.push(node)
  const quoted = tail.map(n => DomUtils.getOuterHTML(n)).join('')
  for (const node of tail) DomUtils.removeElement(node)
  const body = DomUtils.getInnerHTML(dom)
  // A message that is ONLY a quote (someone replied with no words) keeps
  // everything as the body: a blank frame above a folded quote is worse than
  // an unfolded one.
  if (!DomUtils.textContent(dom).trim()) return { body: source, quoted: '' }
  return { body, quoted }
}

/**
 * emailHtmlDocument, plus the quoted half as its own document.
 *
 * @returns {{ document: string|null, quotedDocument: string|null, blockedImages: number, failed: boolean }}
 */
export function emailHtmlDocuments(raw) {
  const empty = { document: null, quotedDocument: null, blockedImages: 0, failed: false }
  if (!raw || typeof raw !== 'string' || !raw.trim()) return empty
  try {
    const { html, blockedImages } = sanitizeEmailHtml(raw)
    if (!html.trim()) return empty
    const { body, quoted } = splitQuotedHtml(html)
    return {
      document: emailFrameDocument(body),
      quotedDocument: quoted ? emailFrameDocument(quoted) : null,
      blockedImages,
      failed: false,
    }
  } catch {
    return { document: null, quotedDocument: null, blockedImages: 0, failed: true }
  }
}
```

- [ ] **Step 5: Run to see it pass**

Run: `npx vitest run src/lib/email-html.test.js`
Expected: PASS. If `DomUtils.getOuterHTML` serialises `<br>` as `<br>` vs `<br/>` differently from the test's expectation, adjust the **test string** for the Apple case to what the serialiser emits and note it in the report; do not post-process the HTML.

### Task 4: `buildReplyHeaders` References fallback (sonnet)

**Spec section:** "Threading headers".

**Files:**
- Modify: `src/lib/email-inbox.js:202-210`, `src/lib/email-inbox.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/email-inbox.test.js` (inside its existing top-level scope; add the import of `buildReplyHeaders` to the file's import line if absent):

```js
describe('buildReplyHeaders — References fallback', () => {
  it('uses In-Reply-To as the chain when References is empty', () => {
    expect(buildReplyHeaders({ rfcMessageId: 'a@x', referencesHeader: '', inReplyTo: '<p@x>' })).toEqual([
      { Name: 'In-Reply-To', Value: '<a@x>' },
      { Name: 'References', Value: '<p@x> <a@x>' },
    ])
  })
  it('brackets a bare In-Reply-To', () => {
    expect(buildReplyHeaders({ rfcMessageId: 'a@x', inReplyTo: 'p@x' })[1].Value).toBe('<p@x> <a@x>')
  })
  it('prefers References when both are present', () => {
    expect(buildReplyHeaders({ rfcMessageId: 'a@x', referencesHeader: '<r@x>', inReplyTo: '<p@x>' })[1].Value).toBe('<r@x> <a@x>')
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/lib/email-inbox.test.js`
Expected: FAIL on the first new test (`References` is `<a@x>`).

- [ ] **Step 3: Implement**

Replace the function at `src/lib/email-inbox.js:202-210` with:

```js
export function buildReplyHeaders({ rfcMessageId, referencesHeader, inReplyTo }) {
  if (!rfcMessageId) return []
  const bracket = (id) => (String(id).startsWith('<') ? String(id) : `<${id}>`)
  const bracketed = bracket(rfcMessageId)
  // RFC 5322 §3.6.4: the parent's References, or its In-Reply-To when it has
  // none, then the parent's own id.
  const refs = (referencesHeader || '').trim() || (inReplyTo ? bracket(String(inReplyTo).trim()) : '')
  return [
    { Name: 'In-Reply-To', Value: bracketed },
    { Name: 'References', Value: refs ? `${refs} ${bracketed}` : bracketed },
  ]
}
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run src/lib/email-inbox.test.js`
Expected: PASS, including every pre-existing `buildReplyHeaders` case.

**Orchestrator after Wave 1:** run the loop command, then `npm install --no-audit --no-fund` is not needed (Task 3 already installed). Commit:

```bash
git add shared/mail-quote.js shared/mail-quote.test.js src/lib/mail-quote.js tests/shared-pair-sync.test.js src/lib/mail/reply-quote.js src/lib/mail/reply-quote.test.js src/lib/email-html.js src/lib/email-html.test.js package.json package-lock.json src/lib/email-inbox.js src/lib/email-inbox.test.js
git commit -m "MAIL-REPLY-QUOTE.1 — pure modules: quoted-text splitter (shared), reply quote + threading builder, HTML quote split, References fallback"
```

---

## Wave 2a

### Task 5: Move the three libs and rewrite imports (sonnet, serial)

**Spec section:** "Vocabulary" table, "Rename mechanics" step 1.

**Files:**
- Move: `src/lib/ticket-display.js` → `src/lib/mail/conversation-display.js` (+ `.test.js`), `src/lib/email-tickets.js` → `src/lib/mail/conversation.js` (+ `.test.js`), `src/lib/email-ticket-merge.js` → `src/lib/mail/conversation-merge.js` (+ `.test.js`)
- Modify: every importer (list in step 1)

- [ ] **Step 1: List the importers and confirm**

```bash
grep -rln "@/lib/ticket-display\|@/lib/email-tickets\|@/lib/email-ticket-merge\|\./ticket-display\|\./email-tickets\|\./email-ticket-merge" src tests --include='*.js' --include='*.jsx'
```

Expected (from the tree at `367bfc88`): `src/app/dashboard/today/page.js`, `src/app/api/webhooks/postmark-inbound/[token]/route.js`, `src/app/api/email/tickets/compose/route.js`, `src/app/api/email/tickets/[id]/merge/route.js`, `src/app/api/email/tickets/[id]/reply/route.js`, `src/components/tickets/TicketThread.jsx`, `src/components/mail/MailThread.jsx`, `src/components/tickets/TicketReplyBox.jsx`, `src/components/mail/MailSurface.jsx`, `src/components/tickets/TicketForward.jsx`, `src/components/mail/MailList.jsx`, `src/components/tickets/TicketCompose.jsx`, `src/components/mail/mail-digest.js`, `src/components/mail/mail-relate.js`, plus the three test files and any `vi.mock('@/lib/…')` in tests. If the list differs, use the actual list.

- [ ] **Step 2: Move**

```bash
mkdir -p src/lib/mail
git mv src/lib/ticket-display.js src/lib/mail/conversation-display.js
git mv src/lib/ticket-display.test.js src/lib/mail/conversation-display.test.js
git mv src/lib/email-tickets.js src/lib/mail/conversation.js
git mv src/lib/email-tickets.test.js src/lib/mail/conversation.test.js
git mv src/lib/email-ticket-merge.js src/lib/mail/conversation-merge.js
git mv src/lib/email-ticket-merge.test.js src/lib/mail/conversation-merge.test.js
```

- [ ] **Step 3: Rewrite imports**

```bash
grep -rl "@/lib/ticket-display\|@/lib/email-tickets\|@/lib/email-ticket-merge" src tests --include='*.js' --include='*.jsx' | xargs sed -i '' \
  -e "s#@/lib/ticket-display#@/lib/mail/conversation-display#g" \
  -e "s#@/lib/email-tickets#@/lib/mail/conversation#g" \
  -e "s#@/lib/email-ticket-merge#@/lib/mail/conversation-merge#g"
```

Then inside the three moved test files, fix relative imports: `./ticket-display` → `./conversation-display`, `./email-tickets` → `./conversation`, `./email-ticket-merge` → `./conversation-merge`. The moved modules themselves import siblings by `@/lib/...`; check each with `grep -n "from '\./" src/lib/mail/conversation*.js` and repoint any `./x` that pointed at a `src/lib` sibling to `@/lib/x`.

- [ ] **Step 4: Verify**

```bash
grep -rn "ticket-display\|email-tickets'\|email-ticket-merge" src tests --include='*.js' --include='*.jsx' | grep -v "^docs"
```

Expected: no output. Then `npx vitest run src/lib/mail src/components/mail src/components/tickets 'src/app/api/email/tickets'` → PASS.

**Orchestrator after 2a:** loop command; commit `git add -A src/lib tests src/components src/app` is NOT allowed; use `git add src/lib/mail src/lib tests src/components src/app/dashboard src/app/api` then `git status` to confirm only renames and import edits are staged. Commit: `MAIL-RENAME.1 — libs: ticket-display, email-tickets, email-ticket-merge → src/lib/mail/conversation*`.

---

## Wave 2b (parallel: Tasks 6, 7, 8)

### Task 6: Components move + rename + client fetch paths (sonnet)

**Spec section:** "Vocabulary" table, "Operator copy" table, "Rename mechanics" step 2.

**Files:**
- Move: everything in `src/components/tickets/` into `src/components/mail/` with these renames: `TicketThread.jsx` → `ConversationThread.jsx`, `TicketReplyBox.jsx` → `ReplyBox.jsx`, `TicketCompose.jsx` → `ComposeForm.jsx`, `TicketForward.jsx` → `ForwardForm.jsx`; `AttachmentPicker.jsx`, `AttachmentPreview.jsx`, `RecipientEditor.jsx`, `SignatureHint.jsx` keep their names. Test files move with the same prefix change (`TicketThread.flat.test.jsx` → `ConversationThread.flat.test.jsx`, etc.).
- Modify: importers `src/components/ContactComposer.jsx`, `src/components/EmailSignatureForm.jsx`, `src/components/mail/MailThread.jsx`, `src/components/mail/MailSurface.jsx`, `src/components/account/RichSignatureEditor.jsx`, `src/components/account/RichSignatureEditor.test.jsx`, and any test under `src/components/mail` or `src/components` that mocks `@/components/tickets/*`.
- Modify: client `fetch('/api/email/tickets/...')` calls inside the moved components and inside `src/components/mail/*.jsx`, `src/components/mail/*.js`, `src/components/ContactComposer.jsx` → the new paths (Task 7 creates the server side; shims keep old paths alive so ordering does not matter).

Do NOT touch `src/app/api/**` or `mobile/**` (other tasks own them).

- [ ] **Step 1: Move**

```bash
cd src/components && for f in tickets/*; do b=$(basename "$f"); n="$b"; case "$b" in TicketThread*) n="ConversationThread${b#TicketThread}";; TicketReplyBox*) n="ReplyBox${b#TicketReplyBox}";; TicketCompose*) n="ComposeForm${b#TicketCompose}";; TicketForward*) n="ForwardForm${b#TicketForward}";; esac; git mv "$f" "mail/$n"; done; cd ../..; rmdir src/components/tickets; git status --short | head -30
```

- [ ] **Step 2: Rewrite imports and component identifiers**

```bash
grep -rl "@/components/tickets/\|from './Ticket\|from \"./Ticket" src --include='*.js' --include='*.jsx' | xargs sed -i '' \
  -e "s#@/components/tickets/TicketThread#@/components/mail/ConversationThread#g" \
  -e "s#@/components/tickets/TicketReplyBox#@/components/mail/ReplyBox#g" \
  -e "s#@/components/tickets/TicketCompose#@/components/mail/ComposeForm#g" \
  -e "s#@/components/tickets/TicketForward#@/components/mail/ForwardForm#g" \
  -e "s#@/components/tickets/#@/components/mail/#g" \
  -e "s#'\./TicketThread'#'./ConversationThread'#g" \
  -e "s#'\./TicketReplyBox'#'./ReplyBox'#g" \
  -e "s#'\./TicketCompose'#'./ComposeForm'#g" \
  -e "s#'\./TicketForward'#'./ForwardForm'#g"
grep -rl "\bTicketThread\b\|\bTicketReplyBox\b\|\bTicketCompose\b\|\bTicketForward\b" src --include='*.js' --include='*.jsx' | xargs sed -i '' \
  -e "s/\bTicketThread\b/ConversationThread/g" -e "s/\bTicketReplyBox\b/ReplyBox/g" \
  -e "s/\bTicketCompose\b/ComposeForm/g" -e "s/\bTicketForward\b/ForwardForm/g"
```

Also inside the moved files, relative imports between them (`./AttachmentPicker`, `./RecipientEditor`) are unchanged; imports that pointed at `../mail/x` from the tickets directory become `./x` (`grep -n "from '\.\./mail/" src/components/mail/*.jsx` → replace `../mail/` with `./`).

- [ ] **Step 3: Client API paths**

```bash
grep -rl "/api/email/tickets" src/components --include='*.js' --include='*.jsx' | xargs sed -i '' -e "s#/api/email/tickets/compose#/api/email/mail/compose#g" -e "s#/api/email/tickets/#/api/email/mail/#g" -e "s#/api/email/tickets\`#/api/email/mail\`#g"
grep -rn "/api/email/tickets" src/components
```

Expected: no output.

- [ ] **Step 4: Operator copy in these files**

Apply exactly (`grep -n` first, then edit):
- `src/components/mail/ReplyBox.jsx`: `'This ticket has no requester address, so it cannot be replied to. You can still add an internal note.'` → `'This conversation has no sender address, so it cannot be replied to. You can still add an internal note.'`
- `src/components/mail/ConversationThread.jsx`: `No mailbox on this ticket` → `No mailbox on this conversation`; `'Open the ticket it was merged into to reply.'` → `'Open the conversation it was merged into to reply.'`
- `src/components/mail/ComposeForm.jsx`: `the ticket is filed under it` → `the conversation is filed under it`
- Any test asserting those strings: update to the new text.

- [ ] **Step 5: Verify**

`npx vitest run src/components` → PASS. `grep -rn "components/tickets" src` → no output.

### Task 7: API routes move + shims + `_conversation.js` (sonnet)

**Spec section:** "API rename with shims", "Rename mechanics" step 3.

**Files:**
- Create: `src/app/api/email/mail/_conversation.js` (moved from `src/app/api/email/tickets/_helpers.js`), `src/app/api/email/mail/_conversation.test.js` (from `_helpers.test.js` if it exists), `src/app/api/email/mail/_test-db.js` and `_test-fixtures.js` (moved from tickets), the eleven new route files listed under "File structure", each with its `.test.js`.
- Rewrite: every `src/app/api/email/tickets/**/route.js` as a shim. Create `src/app/api/email/tickets/shims.test.js`.
- Modify: importers of `tickets/_helpers` outside the tickets tree: `src/app/api/email/attachments/upload-sign/route.js`, `src/app/api/email/mail/[id]/archive|related|seen|spam/route.js`, `src/app/api/email/mail/_helpers.js`, `src/app/api/email/mail/count/route.js`, `src/app/api/email/mail/digest/route.js`, `src/app/api/email/mail/route.js`.
- Move: `src/app/api/cron/purge-spam-tickets` → `src/app/api/cron/purge-spam-mail`; edit `vercel.json:214`.

Do NOT touch `src/components/**`, `src/lib/openapi.js` or `mobile/**`.

- [ ] **Step 1: Move helpers and fixtures**

```bash
git mv src/app/api/email/tickets/_helpers.js src/app/api/email/mail/_conversation.js
[ -f src/app/api/email/tickets/_helpers.test.js ] && git mv src/app/api/email/tickets/_helpers.test.js src/app/api/email/mail/_conversation.test.js
git mv src/app/api/email/tickets/_test-db.js src/app/api/email/mail/_test-db.js
git mv src/app/api/email/tickets/_test-fixtures.js src/app/api/email/mail/_test-fixtures.js
```

Rename the three exports inside `_conversation.js`: `loadTicketForUser` → `loadConversationForUser`, `ticketNotFound` → `conversationNotFound`, `ticketMergedAway` → `conversationMergedAway`. Keep every other export name for now (Task 9 sweeps the rest).

- [ ] **Step 2: Move the routes**

```bash
A=src/app/api/email/tickets; B=src/app/api/email/mail
mkdir -p "$B/compose" "$B/[id]/reply" "$B/[id]/forward" "$B/[id]/participants" "$B/[id]/merge" "$B/[id]/read" "$B/[id]/link-contact" "$B/[id]/attachments/[attachmentId]/preview"
git mv "$A/compose/route.js" "$B/compose/route.js"; [ -f "$A/compose/route.test.js" ] && git mv "$A/compose/route.test.js" "$B/compose/route.test.js"
git mv "$A/[id]/route.js" "$B/[id]/route.js"; git mv "$A/[id]/route.test.js" "$B/[id]/route.test.js"
for r in reply forward participants merge read link-contact; do git mv "$A/[id]/$r/route.js" "$B/[id]/$r/route.js"; [ -f "$A/[id]/$r/route.test.js" ] && git mv "$A/[id]/$r/route.test.js" "$B/[id]/$r/route.test.js"; done
git mv "$A/[id]/attachments/_helpers.js" "$B/[id]/attachments/_helpers.js"
git mv "$A/[id]/attachments/[attachmentId]/route.js" "$B/[id]/attachments/[attachmentId]/route.js"
git mv "$A/[id]/attachments/[attachmentId]/preview/route.js" "$B/[id]/attachments/[attachmentId]/preview/route.js"
for t in $(find "$A" -name '*.test.js'); do git mv "$t" "$B/${t#$A/}"; done
git mv src/app/api/cron/purge-spam-tickets src/app/api/cron/purge-spam-mail
sed -i '' 's#/api/cron/purge-spam-tickets#/api/cron/purge-spam-mail#' vercel.json
```

- [ ] **Step 3: Rewrite helper imports**

Inside `src/app/api/email/**` and `src/app/api/email/attachments/**`:

```bash
grep -rl "_helpers'" src/app/api/email --include='*.js' | xargs sed -i '' \
  -e "s#'\.\./\.\./_helpers'#'../_conversation'#g" \
  -e "s#'\.\./_helpers'#'./_conversation'#g" \
  -e "s#'\.\./tickets/_helpers'#'./_conversation'#g" \
  -e "s#'\.\./\.\./tickets/_helpers'#'../_conversation'#g" \
  -e "s#'@/app/api/email/tickets/_helpers'#'@/app/api/email/mail/_conversation'#g"
```

Then inspect each file's import line by hand (`grep -rn "_conversation'\|_helpers'" src/app/api/email`): the mail tree's OWN `_helpers.js` (list scoping) must still be imported as `./_helpers` / `../_helpers` where a route meant it; the ticket helpers become `_conversation`. Where a route used to import both, it now imports from two modules. The moved routes' relative depth changed for `_test-db`/`_test-fixtures` too: tests under `mail/[id]/reply/` import `'../../_test-db'`, tests under `mail/compose/` import `'../_test-db'`. Fix by reading each test's import lines.

Rename the three helper calls everywhere they are used:

```bash
grep -rl "loadTicketForUser\|ticketNotFound\|ticketMergedAway" src --include='*.js' --include='*.jsx' | xargs sed -i '' -e "s/\bloadTicketForUser\b/loadConversationForUser/g" -e "s/\bticketNotFound\b/conversationNotFound/g" -e "s/\bticketMergedAway\b/conversationMergedAway/g"
```

- [ ] **Step 4: Write the shims**

For each old route path, the file becomes exactly this (adjusting the path and the exported verbs — check each new route's `export async function` names first with `grep -n "^export" <new route>`):

`src/app/api/email/tickets/[id]/reply/route.js`:

```js
// MAIL-RENAME.1 — DEPRECATED SHIM. The handler lives at
// /api/email/mail/[id]/reply. This path stays only for the staff-app bundle
// already in the field (mobile/lib/email-api.js before MAIL-RENAME.1); an OTA
// lands on next launch, not on deploy. Delete in the shim sweep (~2 weeks
// after the OTA publishes), with the matching row in shims.test.js.
export { POST } from '@/app/api/email/mail/[id]/reply/route'
```

The set: `compose/route.js` (`POST`), `[id]/route.js` (`GET`, and `PATCH` if the old file exported one), `[id]/forward/route.js` (`POST`), `[id]/participants/route.js` (`PATCH`), `[id]/merge/route.js` (`POST, DELETE`), `[id]/read/route.js` (`POST`), `[id]/link-contact/route.js` (`POST`), `[id]/attachments/[attachmentId]/route.js` (`GET`), `[id]/attachments/[attachmentId]/preview/route.js` (`GET`).

- [ ] **Step 5: Shim identity test**

`src/app/api/email/tickets/shims.test.js`:

```js
// MAIL-RENAME.1 — every old ticket route is the SAME function as its mail
// route, asserted by runtime identity so a shim can never drift into a copy.
import { describe, it, expect } from 'vitest'

const PAIRS = [
  ['compose', ['POST']],
  ['[id]', ['GET']],
  ['[id]/reply', ['POST']],
  ['[id]/forward', ['POST']],
  ['[id]/participants', ['PATCH']],
  ['[id]/merge', ['POST', 'DELETE']],
  ['[id]/read', ['POST']],
  ['[id]/link-contact', ['POST']],
  ['[id]/attachments/[attachmentId]', ['GET']],
  ['[id]/attachments/[attachmentId]/preview', ['GET']],
]

describe('/api/email/tickets shims', () => {
  for (const [sub, verbs] of PAIRS) {
    it(`${sub} re-exports ${verbs.join('/')} from /api/email/mail/${sub}`, async () => {
      const shim = await import(`./${sub}/route.js`)
      const real = await import(`../mail/${sub}/route.js`)
      for (const v of verbs) {
        expect(typeof real[v]).toBe('function')
        expect(shim[v]).toBe(real[v])
      }
    })
  }
})
```

If the old `[id]/route.js` also exported `PATCH`, add it to the `'[id]'` row.

- [ ] **Step 6: Verify**

```bash
npx vitest run src/app/api/email
grep -rn "tickets/_helpers\|from '\.\./_helpers'" src/app/api/email/mail/[id] src/app/api/email/mail/compose
```

Expected: PASS; the grep shows only imports that genuinely mean the mail list helpers (read each hit).

### Task 8: Mobile rename + API paths (sonnet)

**Spec section:** "Vocabulary" table (mobile rows), "API rename with shims → Mobile", "Operator copy" (mobile row).

**Files:**
- Move: `mobile/lib/email-tickets.js` → `mobile/lib/mail-conversations.js` (+ `.test.js`), `mobile/app/(staff)/email/[ticketId].jsx` → `mobile/app/(staff)/email/[conversationId].jsx`
- Modify: `mobile/lib/email-api.js`, `mobile/lib/email-api.test.js`, every importer of `email-tickets` under `mobile/`, the moved screen (`useLocalSearchParams` param name), `mobile/lib/mail-compose.js`, `mail-forward.js`, `mail-relate.js`, `mail-sender.js`, `mobile/components/ContactComposeModal.jsx`, `mobile/app/(staff)/email/compose.jsx` (comment paths only).

Do NOT touch `src/**` or `shared/**`.

- [ ] **Step 1: Move and rewrite imports**

```bash
git mv mobile/lib/email-tickets.js mobile/lib/mail-conversations.js
git mv mobile/lib/email-tickets.test.js mobile/lib/mail-conversations.test.js
git mv 'mobile/app/(staff)/email/[ticketId].jsx' 'mobile/app/(staff)/email/[conversationId].jsx'
grep -rl "email-tickets" mobile --include='*.js' --include='*.jsx' | grep -v node_modules | xargs sed -i '' -e "s#lib/email-tickets#lib/mail-conversations#g" -e "s#'\./email-tickets'#'./mail-conversations'#g"
grep -rn "email-tickets" mobile --include='*.js' --include='*.jsx' | grep -v node_modules
```

Expected: no output.

- [ ] **Step 2: Param name**

In `mobile/app/(staff)/email/[conversationId].jsx`, find `useLocalSearchParams()` and every read of `ticketId` from it; rename the destructured param to `conversationId` and the local variable that the API calls receive. Then check `grep -n "ticketId" 'mobile/app/(staff)/email/[conversationId].jsx' | head` and rename the remaining local identifiers `ticketId` → `conversationId` in that file only (Task 9 sweeps the rest of mobile).

- [ ] **Step 3: API paths and function names in `mobile/lib/email-api.js`**

```bash
sed -i '' -e "s#/api/email/tickets/compose#/api/email/mail/compose#g" -e "s#/api/email/tickets/#/api/email/mail/#g" -e "s#/api/email/tickets\`#/api/email/mail\`#g" mobile/lib/email-api.js mobile/lib/email-api.test.js mobile/lib/mail-compose.js mobile/lib/mail-forward.js mobile/lib/mail-relate.js mobile/lib/mail-sender.js mobile/components/ContactComposeModal.jsx 'mobile/app/(staff)/email/compose.jsx'
grep -rn "/api/email/tickets" mobile | grep -v node_modules
```

Expected: no output. Rename these exports and every caller (`grep -rl` then sed, mobile only): `getTicket` → `getConversation`, `replyToTicket` → `replyToConversation`, `previewTicketAttachment` → `previewConversationAttachment`, `downloadTicketAttachment` → `downloadConversationAttachment`.

- [ ] **Step 4: Copy**

In the moved screen: `No messages on this ticket yet.` → `No messages in this conversation yet.`

- [ ] **Step 5: Verify**

`npx vitest run mobile/lib` → PASS (the test file's path assertions now expect `/api/email/mail/...`; update any assertion strings the sed did not reach).

**Orchestrator after Wave 2b:** loop command; commit with `git add src/components src/app/api vercel.json mobile` then `git status` to confirm nothing else is staged. Commit message: `MAIL-RENAME.1 — components, routes (+shims), mobile: ticket → conversation`.

---

## Wave 2c

### Task 9: Copy and identifier sweep, API docs, changelog (sonnet, serial)

**Spec section:** "Operator copy", "Rename mechanics" steps 5–7, "Left alone, on purpose".

**Files:** any under `src`, `mobile` (not `node_modules`), `shared`, `tests` that the census in step 1 names; `src/lib/openapi.js`; `docs/CHANGELOG.md`.

- [ ] **Step 1: Census**

```bash
grep -rhoE "\b[A-Za-z_]*[Tt]icket[A-Za-z_]*\b" src mobile shared tests --include='*.js' --include='*.jsx' --exclude-dir=node_modules | sort | uniq -c | sort -rn > /tmp/ticket-census.txt; wc -l /tmp/ticket-census.txt; head -60 /tmp/ticket-census.txt
```

- [ ] **Step 2: The exclusion list (never rewritten)**

`email_tickets`, `ticket_id`, `merged_from_ticket_id`, `merged_into_id`, `email_ticket.merged`, `email_ticket.unmerged`, `email_ticket.recipients_added`, `email_ticket/` (audit target resource prefix), `email_ticket_deny_*`, `email_ticket_select`, `increment_email_ticket_unread`, `ticket-reply`, `ticket-compose`, `ticket-forward` (Postmark tags: confirm the exact tag strings with `grep -rn "tag: '" src/app/api/email/mail`), `_state.tickets` (the fake db's table map in `_test-db.js`), `T_STUDIO`/`T_ACCOUNTS`/`T_OTHER_LOCATION` (fixture names; keep), the string `RETIRE-TICKETS.1` and `EMAIL-TICKET*` task ids in comments, anything under `docs/`, and `CLAUDE.md`. Add every extra item Task 0 reported.

- [ ] **Step 3: Rewrite identifiers**

For each identifier in the census that is not excluded, apply the rule `Ticket` → `Conversation`, `ticket` → `conversation`, `tickets` → `conversations` **as a whole-word replace of that exact identifier**, one sed per identifier, over the files that contain it. Build the list once:

```bash
grep -oE "^\s*[0-9]+ (.*)$" /tmp/ticket-census.txt | awk '{print $2}' | grep -vE "^(email_tickets|ticket_id|merged_from_ticket_id|email_ticket_.*|increment_email_ticket_unread|RETIRE_TICKETS|EMAIL_TICKET.*|T_STUDIO)$" > /tmp/ticket-idents.txt
while read id; do new=$(echo "$id" | sed -e 's/Tickets/Conversations/g' -e 's/tickets/conversations/g' -e 's/Ticket/Conversation/g' -e 's/ticket/conversation/g'); [ "$id" = "$new" ] && continue; grep -rlw "$id" src mobile shared tests --include='*.js' --include='*.jsx' --exclude-dir=node_modules | xargs -r sed -i '' "s/\b$id\b/$new/g"; done < /tmp/ticket-idents.txt
```

Then repair the excluded strings the whole-word replace may still have touched inside longer tokens (it will not, because `\b` and the exclusion list, but verify):

```bash
grep -rn "email_conversations\b" src mobile --include='*.js' --include='*.jsx' --exclude-dir=node_modules | grep -v "conversations/_gone\|api/email/conversations\|mig 394\|EMAIL-CONV-STOP" | head
grep -rn "conversation_id" src/app/api/email/mail src/components/mail mobile/lib | head
```

Expected: the first grep shows only the retired-table references that existed before (the legacy `email_conversations` table name must not have been introduced by the sweep — if `db.from('email_conversations')` appears where `email_tickets` was, revert that file's change: `email_tickets` was excluded, so this means an identifier like `TICKETS_TABLE = 'email_tickets'` existed; keep the string). The second grep must show no `conversation_id` that used to be `ticket_id` (DB column; excluded).

- [ ] **Step 4: Prose and copy**

```bash
grep -rniE "ticket" src/components src/app shared/permissions.js mobile/app mobile/components --include='*.js' --include='*.jsx' --exclude-dir=node_modules | grep -vE "email_tickets|ticket_id|EMAIL-TICKET|RETIRE-TICKETS|_test-|\.test\." | grep -E "['\"\`>][^'\"\`<]*[Tt]icket" | head -40
```

Rewrite every user-visible string the grep shows with the "Operator copy" table's wording, and `shared/permissions.js:222` (`Ticketed inbox for the studio email accounts` → `Mail inbox for the studio email accounts`) and `:688` (`… Email tickets` → `… Inbound email`). Comments are rewritten only where the sentence is about the product today (leave sentences describing the retired queue).

- [ ] **Step 5: API docs**

In `src/lib/openapi.js`, for each entry whose `path` starts with `/api/email/tickets`: change `path` to the `/api/email/mail` equivalent; replace the word ticket with conversation in `summary`/`description` prose (not in DB names or task ids); then add, for each, a second entry with the old path, `deprecated: true`, and `description: 'MAIL-RENAME.1 — shim for the staff-app bundle in the field; use <new path>. Removed in the shim sweep.'`. Update the three descriptions that say "Use POST /api/email/tickets/{id}/reply" or "GET /api/email/tickets/{id}" to the new paths. Run `npx vitest run src/lib/openapi.test.js` if it exists.

- [ ] **Step 6: Changelog row**

Append one row to `docs/CHANGELOG.md` following the table's existing format (read the last three rows first). Content: `MAIL-REPLY-QUOTE.1 / MAIL-RENAME.1 — replies quote the most recent message either way and thread onto it (Postmark ids as <id@mtasv.net>, References stored); thread folds quoted text on web + mobile; ticket → conversation across routes (shims for the field bundle), components, libs, mobile, copy, API docs; DB names unchanged.` Never edit an existing row.

- [ ] **Step 7: Verify**

```bash
npx vitest run 2>&1 | tail -6; npm run lint 2>&1 | tail -3; npm run check:mobile-imports 2>&1 | tail -3; npm run check:mobile-lint 2>&1 | tail -3
```

Expected: all green. Report the census line count before and after (`grep -rhoE … | wc -l`).

**Orchestrator after Wave 2c:** full mirror (CLAUDE.md line 91) and `npm run build`. Commit: `MAIL-RENAME.1 — identifier + copy sweep, API docs, cron path, changelog`.

---

## Wave 3 (parallel: Tasks 10, 11, 12, 13)

### Task 10: Reply route — anchor, headers, quoted body, stored chain (opus)

**Spec section:** "Reply behaviour (MAIL-REPLY-QUOTE.1)" in full.

**Files:**
- Modify: `src/app/api/email/mail/[id]/reply/route.js`, `src/app/api/email/mail/[id]/reply/route.test.js`

The route's identifiers are post-sweep (`conversation`, `loadConversationForUser`); the line numbers below refer to the pre-rename file and are landmarks, not exact.

- [ ] **Step 1: Write the failing tests**

Append to `route.test.js` (use the file's existing `db`, `post`, fixtures and `sendEmail` mock; read its `beforeEach` to see how `db._state.messages` is seeded and mirror it):

```js
describe('POST …/reply — quotes and threads off the MOST RECENT message (MAIL-REPLY-QUOTE.1)', () => {
  const inboundRow = (over = {}) => ({
    id: 'm-in', ticket_id: T_STUDIO.id, direction: 'inbound', from_email: T_STUDIO.requester_email,
    subject: 'Re: Booking', text_body: 'Can I move to 7?\n> earlier', rfc_message_id: 'CANz@mail.gmail.com',
    in_reply_to: '<pm-0@mtasv.net>', references_header: '<pm-0@mtasv.net>', created_at: '2026-09-07T12:34:15Z',
    is_internal_note: false, ...over,
  })
  const outboundRow = (over = {}) => ({
    id: 'm-out', ticket_id: T_STUDIO.id, direction: 'outbound', from_email: MB_STUDIO.address,
    subject: 'Booking', text_body: 'We open at 6.', rfc_message_id: null, postmark_message_id: 'pm-1',
    in_reply_to: null, references_header: null, created_at: '2026-09-07T12:40:00Z', is_internal_note: false, ...over,
  })

  it('quotes the last INBOUND message and threads onto it', async () => {
    db._state.messages.push(inboundRow())
    const res = await post(T_STUDIO.id, { text: 'Yes, 7 is fine.' })
    expect(res.status).toBe(200)
    const call = sendEmail.mock.calls[0][0]
    expect(call.textBody).toContain('Yes, 7 is fine.')
    expect(call.textBody).toMatch(/\n\nOn Mon 7 Sep 2026 at 13:34, .*wrote:\n> Can I move to 7\?\n>> earlier$/)
    expect(call.htmlBody).toContain('<blockquote type="cite"')
    expect(call.htmlBody).toContain('&gt; earlier')
    expect(call.headers).toEqual([
      { Name: 'In-Reply-To', Value: '<CANz@mail.gmail.com>' },
      { Name: 'References', Value: '<pm-0@mtasv.net> <CANz@mail.gmail.com>' },
    ])
    expect(call.subject).toBe('Re: Booking')
  })

  it('quotes the last OUTBOUND message when the studio wrote last, deriving its Postmark Message-ID', async () => {
    db._state.messages.push(inboundRow(), outboundRow())
    await post(T_STUDIO.id, { text: 'Following up.' })
    const call = sendEmail.mock.calls[0][0]
    expect(call.textBody).toMatch(/On Mon 7 Sep 2026 at 13:40, .*<accounts@[^>]+> wrote:\n> We open at 6\.$/)
    expect(call.headers).toEqual([
      { Name: 'In-Reply-To', Value: '<pm-1@mtasv.net>' },
      { Name: 'References', Value: '<pm-1@mtasv.net>' },
    ])
  })

  it('uses the rfc id of an SMTP-sent outbound anchor', async () => {
    db._state.messages.push(outboundRow({ rfc_message_id: 'smtp-1@un1t.com', postmark_message_id: null }))
    await post(T_STUDIO.id, { text: 'Hi' })
    expect(sendEmail.mock.calls[0][0].headers[0]).toEqual({ Name: 'In-Reply-To', Value: '<smtp-1@un1t.com>' })
  })

  it('never anchors on an internal note', async () => {
    db._state.messages.push(inboundRow(), outboundRow({ id: 'note', is_internal_note: true, text_body: 'staff', created_at: '2026-09-07T13:00:00Z' }))
    await post(T_STUDIO.id, { text: 'Hi' })
    expect(sendEmail.mock.calls[0][0].textBody).not.toContain('staff')
    expect(sendEmail.mock.calls[0][0].headers[0].Value).toBe('<pm-1@mtasv.net>')
  })

  it('sends no threading headers and no quote when there is nothing to anchor on', async () => {
    const res = await post(T_STUDIO.id, { text: 'Hello' })
    expect(res.status).toBe(200)
    const call = sendEmail.mock.calls[0][0]
    expect(call.headers).toEqual([])
    expect(call.textBody).not.toContain('wrote:')
  })

  it('stores exactly what went out, plus in_reply_to and references_header, and previews only the words', async () => {
    db._state.messages.push(inboundRow())
    await post(T_STUDIO.id, { text: 'Yes, 7 is fine.' })
    const call = sendEmail.mock.calls[0][0]
    const [msg] = insertsInto(db, 'email_inbox_messages')
    expect(msg.payload.text_body).toBe(call.textBody)
    expect(msg.payload.in_reply_to).toBe('CANz@mail.gmail.com')
    expect(msg.payload.references_header).toBe('<pm-0@mtasv.net> <CANz@mail.gmail.com>')
    const [patch] = updatesTo(db, 'email_tickets')
    expect(patch.payload.last_message_preview).toBe('Yes, 7 is fine.')
  })

  it('500s BEFORE sending when the anchor lookup fails', async () => {
    db._state.messages.push(inboundRow())
    failWrites(db) // if the harness has a read-failure helper, use it instead; the point is: sendEmail not called
    // Read `_test-db.js` for the select-failure helper name and use it here.
  })
})
```

Replace the last test's body with the harness's actual read-failure helper (`grep -n "export function" src/app/api/email/mail/_test-db.js`); assert `res.status === 500` and `sendEmail` not called.

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run 'src/app/api/email/mail/[id]/reply/route.test.js'`
Expected: the new describe fails (no quote, `References` missing the chain); every pre-existing test passes.

- [ ] **Step 3: Implement**

In `route.js`:

(a) Imports: replace `import { replySubject, buildReplyHeaders, inboundPreview } from '@/lib/email-inbox'` with `import { replySubject, inboundPreview } from '@/lib/email-inbox'` and add:

```js
import { selectReplyAnchor, replyThreadingHeaders, replyReferences, anchorMessageId, buildReplyText, buildReplyHtml } from '@/lib/mail/reply-quote'
```

(b) The threading lookup (pre-rename lines 270–285): replace the `lastInbound` query with the anchor query. Keep the `Promise.all` shape and the `loadParticipantMessages` half untouched:

```js
  const [
    { data: anchorRows, error: anchorErr },
    { data: recentMessages, error: recentErr },
  ] = await Promise.all([
    // MAIL-REPLY-QUOTE.1 — the message this reply is a reply TO: the most
    // recent in EITHER direction, notes excluded. A mail client threads onto
    // and quotes the last thing in the conversation, whoever wrote it. Two
    // rows, not one, so a newest-is-a-note conversation still finds the real
    // anchor beneath it; selectReplyAnchor drops notes.
    db.from('email_inbox_messages')
      .select('id, direction, from_email, subject, text_body, rfc_message_id, postmark_message_id, in_reply_to, references_header, created_at, sent_at, is_internal_note, forwarded_message_id')
      .eq('ticket_id', conversation.id)
      .order('created_at', { ascending: false })
      .limit(5),
    loadParticipantMessages(db, conversation.id),
  ])
  if (anchorErr) {
    console.error('[mail/reply] anchor lookup failed BEFORE sending:', anchorErr.message)
    return NextResponse.json({ success: false, error: anchorErr.message }, { status: 500 })
  }
  const anchor = selectReplyAnchor(anchorRows || [])
```

(`conversation` is the post-sweep name of `ticket`; if the sweep left it as `ticket`, use that.)

(c) Subject and headers (pre-rename lines 339–343):

```js
  const subject = replySubject(anchor?.subject || conversation.subject)
  const headers = replyThreadingHeaders(anchor)
```

(d) Body (pre-rename line 418 and the `outboundText` above it). After `const outboundText = …` add:

```js
  // MAIL-REPLY-QUOTE.1 — words, signature, then the quoted anchor. The text
  // part is what the row stores (the record of what the recipient received);
  // the HTML part gets the same quote as an escaped cite blockquote.
  const quoteCtx = { anchor, conversation, mailbox: mailbox || null }
  const wireText = buildReplyText({ signedText: outboundText, ...quoteCtx })
  const wireHtml = buildReplyHtml({
    bodyHtml: richSig ? textToHtml(text) + richSig.html : textToHtml(outboundText),
    ...quoteCtx,
  })
```

and in the `sendTicketEmail({...})` call replace `htmlBody: richSig ? … : …,` with `htmlBody: wireHtml,` and `textBody: outboundText,` with `textBody: wireText,`.

(e) The message insert (pre-rename lines 538–545): `text_body: outboundText,` → `text_body: wireText,`; `in_reply_to: lastInbound?.rfc_message_id || null,` →

```js
    // MAIL-REPLY-QUOTE.1 — both anchors as SENT, so the next reply in this
    // conversation (ours or theirs) continues the chain. Bare id in
    // in_reply_to, matching every row before today; References verbatim.
    in_reply_to: anchor ? (anchorMessageId(anchor) || '').replace(/^<|>$/g, '') || null : null,
    references_header: anchor ? (replyReferences(anchor) || null) : null,
```

(f) `const preview = inboundPreview(text)` stays: the words only.

(g) The unfiled-send fallback block (pre-rename ~562–600) also stores `text_body`; change that occurrence to `wireText` as well.

(h) Delete every remaining reference to `lastInbound` (`grep -n lastInbound route.js` → none). Update the header comment block that says "threaded off the last inbound message" to "threaded off, and quoting, the most recent message in either direction (MAIL-REPLY-QUOTE.1)".

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run 'src/app/api/email/mail/[id]/reply/route.test.js'`
Expected: PASS, all pre-existing cases plus 7 new. Some pre-existing tests assert `textBody` or `text_body` **equals** the signed text; with a seeded inbound row they now carry a quote. Update only those assertions to `toContain`/`startsWith` and say which in the report.

### Task 11: Thread GET route — `html_quoted_document` (opus)

**Spec section:** "Web thread, HTML path".

**Files:**
- Modify: `src/app/api/email/mail/[id]/route.js` (`shapeMessages`), `src/app/api/email/mail/[id]/route.test.js`

- [ ] **Step 1: Write the failing test**

Append (mirror the file's existing fixture/`get` helper; find the test that asserts `html_document` and copy its seeding):

```js
describe('GET …/[id] — html_quoted_document (MAIL-REPLY-QUOTE.1)', () => {
  it('splits an inbound Gmail cascade into body and quoted documents', async () => {
    seedMessage({ html_body: '<div dir="ltr">Test test 2</div><div class="gmail_quote">old</div>' })
    const { data } = await getThread(T_STUDIO.id)
    const m = data.messages.at(-1)
    expect(m.html_document).toContain('Test test 2')
    expect(m.html_document).not.toContain('gmail_quote')
    expect(m.html_quoted_document).toContain('gmail_quote')
    expect(m.html_body).toBeUndefined()
  })
  it('is null when nothing is quoted, and for notes and text-only rows', async () => {
    seedMessage({ html_body: '<p>plain</p>' })
    const { data } = await getThread(T_STUDIO.id)
    expect(data.messages.at(-1).html_quoted_document).toBeNull()
  })
  it('charges both halves to the HTML budget', async () => {
    // seed one message whose body + quote together exceed HTML_BUDGET_BYTES,
    // then a second message: the second must report html_omitted: true.
  })
})
```

Replace `seedMessage`/`getThread` with the file's real helpers; write the third test's seeding concretely using the file's conventions (a `'x'.repeat(1_500_001)` html_body on the newer message, then assert the older one has `html_omitted: true`).

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run 'src/app/api/email/mail/[id]/route.test.js'`
Expected: FAIL, `html_quoted_document` undefined.

- [ ] **Step 3: Implement**

In `route.js`: change the import `emailHtmlDocument` → `emailHtmlDocuments` (from `@/lib/email-html`). In `shapeMessages`:

```js
    const base = {
      ...rest,
      author_name: authorNames.get(row.author_profile_id) || null,
      attachments: attachmentsByMessage.get(row.id) || [],
      html_document: null,
      // MAIL-REPLY-QUOTE.1 — the quoted chain as its own srcdoc, folded
      // behind "Show quoted text" in the thread. null when nothing is quoted.
      html_quoted_document: null,
      html_blocked_images: 0,
      html_unsafe: false,
      html_omitted: false,
    }
    if (row.is_internal_note || !raw) return base
    if (budget <= 0) return { ...base, html_omitted: true }
    const { document, quotedDocument, blockedImages, failed } = emailHtmlDocuments(raw)
    budget -= (document ? document.length : 0) + (quotedDocument ? quotedDocument.length : 0)
    return {
      ...base,
      html_document: document,
      html_quoted_document: quotedDocument,
      html_blocked_images: blockedImages,
      html_unsafe: failed,
    }
```

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run 'src/app/api/email/mail/[id]/route.test.js'` → PASS.

### Task 12: Web thread — "Show quoted text" pill (opus)

**Spec section:** "Web thread, text path", "Web thread, HTML path" (render half), "🔴 Verification is in a browser".

**Files:**
- Modify: `src/components/mail/ConversationThread.jsx` (`ThreadMessage`, both outbound and inbound branches), `src/components/mail/mail-vocabulary.js` (`messageSnippet`), `src/components/mail/ConversationThread.flat.test.jsx` (append), `src/components/mail/mail-vocabulary.test.js` (append; create if absent)

Component tests here render to static markup with `react-dom/server` (no jsdom), so they prove what the collapsed state renders and that the pill exists; the click is verified in the browser in Task 14.

- [ ] **Step 1: Write the failing tests**

Append to `mail-vocabulary.test.js`:

```js
import { messageSnippet } from './mail-vocabulary'
describe('messageSnippet — quoted text excluded (MAIL-REPLY-QUOTE.1)', () => {
  it('previews only the words above the quote', () => {
    expect(messageSnippet({ text_body: 'Yes, 7 is fine.\n\nOn Mon 7 Sep 2026 at 13:34, A <a@b.c> wrote:\n> can I move' })).toBe('Yes, 7 is fine.')
  })
})
```

Append to `ConversationThread.flat.test.jsx` (mirror its existing render helper, which produces a markup string):

```js
describe('quoted text is folded (MAIL-REPLY-QUOTE.1)', () => {
  it('renders the words, a "Show quoted text" pill, and NOT the quote, for a text message', () => {
    const html = renderThread({ messages: [outbound({ id: 'o', text_body: 'Yes, 7 is fine.\n\nOn Mon 7 Sep 2026 at 13:34, A <a@b.c> wrote:\n> can I move' })] })
    expect(html).toContain('Yes, 7 is fine.')
    expect(html).toContain('Show quoted text')
    expect(html).not.toContain('can I move')
  })
  it('renders no pill when nothing is quoted', () => {
    const html = renderThread({ messages: [outbound({ id: 'o', text_body: 'Plain.' })] })
    expect(html).not.toContain('Show quoted text')
  })
  it('renders the pill and only the body frame for an HTML message with a quoted document', () => {
    const html = renderThread({ messages: [inbound({ id: 'i', html_document: '<!doctype html><html><body>BODY</body></html>', html_quoted_document: '<!doctype html><html><body>QUOTED</body></html>' })] })
    expect(html).toContain('Show quoted text')
    expect(html).toContain('BODY')
    expect(html).not.toContain('QUOTED')
  })
})
```

Use the file's actual fixture builders (`outbound`, `inbound`, `renderThread` are placeholders for whatever it exports; read the file's top 60 lines).

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run src/components/mail/ConversationThread.flat.test.jsx src/components/mail/mail-vocabulary.test.js`
Expected: FAIL (no pill; snippet includes the quote).

- [ ] **Step 3: Implement**

`mail-vocabulary.js`: import `splitQuotedText` from `'@shared/mail-quote'` and change `messageSnippet`:

```js
export function messageSnippet(message) {
  const text = typeof message?.text_body === 'string' ? message.text_body : ''
  return splitQuotedText(text).body.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX)
}
```

`ConversationThread.jsx`: import `splitQuotedText` from `'@/lib/mail-quote'`. Add one component near `EmailFrame`:

```jsx
/**
 * MAIL-REPLY-QUOTE.1 — the folded chain under a message. A mail client hides
 * the quoted history by default and offers it on demand; this is that pill.
 * `text` is the plain quoted block, `html` a second srcdoc — never both.
 */
function QuotedText({ text, html, frameSize, label }) {
  const [open, setOpen] = useState(false)
  if (!text && !html) return null
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="rounded-full border border-un1t-border bg-un1t-surface px-2 py-0.5 text-[11px] text-un1t-subtle hover:text-un1t-text"
      >
        {open ? 'Hide quoted text' : '··· Show quoted text'}
      </button>
      {open && (html
        ? <EmailFrame html={html} label={`${label}, quoted text`} frameSize={frameSize} />
        : <p className="mt-2 whitespace-pre-wrap break-words border-l-2 border-un1t-border pl-3 text-sm text-un1t-subtle">{text}</p>
      )}
    </div>
  )
}
```

In `ThreadMessage`, after `const body = message.text_body || '(no text content)'`, add:

```js
  const split = splitQuotedText(message.text_body || '')
  const textBody = split.body || body
```

In the **outbound** branch replace `<p className="whitespace-pre-wrap break-words text-sm text-un1t-text">{body}</p>` with `{textBody}` in the same `<p>`, and directly after the `{html ? <EmailFrame …/> : <p …/>}` expression add:

```jsx
            <QuotedText
              text={html ? '' : split.quoted}
              html={html ? message.html_quoted_document : null}
              frameSize={frameSize}
              label={`Reply sent to ${message.to_email || 'the member'}`}
            />
```

Do the same in the **inbound** branch with `label={`Email from ${message.from_email || 'the member'}`}`. The note branch is untouched.

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run src/components/mail` → PASS.

### Task 13: Mobile thread — quote pill (sonnet)

**Spec section:** "Mobile thread".

**Files:**
- Modify: `mobile/app/(staff)/email/[conversationId].jsx` (`FlatMessage`), `mobile/lib/mail-conversations.js` (`flatMessageMeta`), `mobile/lib/mail-conversations.test.js` (append)

- [ ] **Step 1: Write the failing test**

Append to `mobile/lib/mail-conversations.test.js`:

```js
import { flatMessageMeta } from './mail-conversations'
describe('flatMessageMeta — snippet excludes quoted text (MAIL-REPLY-QUOTE.1)', () => {
  it('previews only the words above the quote', () => {
    const meta = flatMessageMeta({ direction: 'outbound', text_body: 'Yes.\n\nOn Mon 7 Sep 2026 at 13:34, A <a@b.c> wrote:\n> old', created_at: '2026-09-07T12:40:00Z' })
    expect(meta.snippet).toBe('Yes.')
  })
})
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run mobile/lib/mail-conversations.test.js` → FAIL (snippet contains `wrote:`).

- [ ] **Step 3: Implement**

`mobile/lib/mail-conversations.js`: add `import { splitQuotedText } from 'shared/mail-quote'` and in `flatMessageMeta` change the snippet line to:

```js
  const snippet = splitQuotedText(String(m.text_body || '')).body.replace(/\s+/g, ' ').trim()
```

`[conversationId].jsx`: add `import { splitQuotedText } from 'shared/mail-quote'`. In `FlatMessage`, after `const body = msg.text_body || '(no text content)'`:

```js
  const split = splitQuotedText(msg.text_body || '')
  const shown = split.body || body
  const [quoteOpen, setQuoteOpen] = useState(false)
```

(`useState` is already imported.) Where the non-note branch renders `{body}` in its `<Text className="text-sm text-un1t-text …">`, render `{shown}` instead, and directly after that `<Text>` add:

```jsx
      {split.quoted ? (
        <View className="mt-2">
          <Pressable
            onPress={() => setQuoteOpen(v => !v)}
            accessibilityRole="button"
            accessibilityLabel={quoteOpen ? 'Hide quoted text' : 'Show quoted text'}
            className="self-start rounded-full border border-un1t-border bg-un1t-surface px-2 py-0.5"
          >
            <Text className="text-[11px] text-un1t-subtle">{quoteOpen ? 'Hide quoted text' : '··· Show quoted text'}</Text>
          </Pressable>
          {quoteOpen ? (
            <Text className="mt-2 border-l-2 border-un1t-border pl-3 text-sm text-un1t-subtle">{split.quoted}</Text>
          ) : null}
        </View>
      ) : null}
```

Hooks order: `useState` must be called before any early `return` in `FlatMessage`; the note branch returns early, so place the `useState` line above `if (kind === 'note')`.

- [ ] **Step 4: Run to see it pass**

Run: `npx vitest run mobile/lib/mail-conversations.test.js` → PASS. Then `npm run check:mobile-imports 2>&1 | tail -3` and `npm run check:mobile-lint 2>&1 | tail -3` → green (the orchestrator repeats these).

**Orchestrator after Wave 3:** full mirror + `npm run build`. Commit: `MAIL-REPLY-QUOTE.1 — reply route quotes + threads off the most recent message; thread folds quoted text (web + mobile)`.

---

## Wave 4

### Task 14: Gates, review, PR, browser verification, OTA, smoke (orchestrator)

- [ ] **Step 1: Gates**

```bash
npm test 2>&1 | tail -6 && npm run lint 2>&1 | tail -3 && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths && npm run build 2>&1 | tail -15
```

Expected: every check exits 0; the build prints the route table including `/api/email/mail/[id]/reply` and `/api/email/tickets/[id]/reply`.

- [ ] **Step 2: Review**

Run the `code-review` skill at `medium` on the branch diff. Fix confirmed findings inline; re-run the affected test files and commit as `MAIL-REPLY-QUOTE.1 — review fixes`.

- [ ] **Step 3: Memory**

Update `~/.claude/projects/-Users-richardivers-code/memory/inbox-vs-ticketing-trial.md` with a dated paragraph: routes moved to `/api/email/mail/*`, shims under `/api/email/tickets/*` awaiting the sweep (date + 2 weeks), reply quoting live, DB names unchanged. Add the shim sweep to MEMORY.md's "Waiting on Richard" line for this program.

- [ ] **Step 4: Push and PR**

```bash
git push -u origin mail-reply-quote-conversation
gh pr create --title "MAIL-REPLY-QUOTE.1 / MAIL-RENAME.1 — replies quote the thread; ticket → conversation" --body-file - <<'EOF'
## What
- A reply from Mail now quotes the most recent message in either direction and threads onto it (In-Reply-To/References; Postmark-sent anchors as `<id@mtasv.net>`; References stored on the outbound row).
- The thread folds quoted text behind "Show quoted text" on web (text and HTML, second sanitised frame) and mobile.
- Ticket → conversation: routes under `/api/email/mail/*` (old paths are one-line shims for the staff bundle in the field), components, libs, mobile, operator copy, API docs, cron path. DB names unchanged by design.

## Why
Replies arrived as bare messages (2026-09-07 test to richard@richardivers.com). Spec: `docs/superpowers/specs/2026-09-07-mail-reply-quote-and-conversation-rename-design.md`.

## Verification
- `npm test`, `npm run lint`, full check mirror, `npm run build` green.
- Vercel preview: thread fold verified in a real browser (see comments).
- Smoke reply after merge (Gmail quote + threading), with Richard's go-ahead.

## Follow-ups
- Shim sweep ~2 weeks after the OTA: delete `src/app/api/email/tickets/**` + `shims.test.js`.
- `email_tickets` table rename: its own migration and spec.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 5: Browser verification on the Vercel preview (GET-only)**

Open the preview URL from the PR checks in the Browser pane, sign in, open `/communications/mail`, select today's "test" conversation (`?c=f6e0ddaf-b7ae-455d-8d69-9a1f318e8287`). Confirm with `read_page` and a screenshot: the Gmail inbound shows "Test test 2" with a "··· Show quoted text" pill; clicking it renders a second frame with the quoted block; the pill flips to "Hide quoted text". Repeat on an older HTML-heavy conversation (any with an Apple Mail sender). Do not send anything from the preview.

- [ ] **Step 6: Merge and OTA**

After Richard's review: `gh pr merge --squash --delete-branch`. The push to `main` touching `mobile/**` publishes the OTA at 100% via `eas-update.yml`; confirm the workflow is green (`gh run list --workflow eas-update.yml -L 1`).

- [ ] **Step 7: Smoke (ask first)**

Ask Richard for the go-ahead, then from production Mail reply "smoke after MAIL-REPLY-QUOTE.1" on the "test" conversation. Confirm in Gmail: the reply sits in the same conversation and carries the quoted "Test test 2" block under the signature. Confirm in the CRM: the sent row shows the words with a folded quote. Record the result in the memory note.

- [ ] **Step 8: Worktree**

`git worktree remove ../un1t-crm-mailreply` from the primary clone once the PR is merged and the smoke is recorded.

---

## Self-review

**Spec coverage.** Anchor rule → Task 2 + 10. Threading and derived ids → 2, 4, 10. Quoting layout, escaping, cap → 2, 10. Storage (`text_body`, `in_reply_to`, `references_header`, preview) → 10. Splitter → 1. HTML split + `html_quoted_document` → 3, 11. Web pill both paths → 12. Mobile pill + snippet → 13. Rename tables (libs, components, routes, helpers, mobile, cron) → 5, 6, 7, 8. Copy table → 6, 8, 9. Left-alone list → 9 exclusions. Shims + identity test → 7. API docs → 9. Changelog, memory, rollout, smoke → 9, 14. Edge cases (no anchor, note, forward, SMTP) → 2 and 10 tests. Browser verification → 14.

**Placeholders.** Task 10 step 1's last test and Task 11 step 1's third test name the harness helper to look up rather than a made-up one; both say exactly what to assert. Task 12's fixture names are flagged as "read the file". Everything else is concrete.

**Consistency.** `splitQuotedText` (Tasks 1, 12, 13), `selectReplyAnchor`/`replyThreadingHeaders`/`replyReferences`/`anchorMessageId`/`buildReplyText`/`buildReplyHtml` (Tasks 2, 10), `splitQuotedHtml`/`emailHtmlDocuments` (Tasks 3, 11), `html_quoted_document` (Tasks 11, 12), `loadConversationForUser`/`conversationNotFound`/`conversationMergedAway` (Tasks 7, 9, 10), `buildReplyHeaders({ rfcMessageId, referencesHeader, inReplyTo })` (Task 4; no longer called by the reply route after Task 10, kept for the compose/other callers).
