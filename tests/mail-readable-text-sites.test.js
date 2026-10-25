// MAIL-READER.M2 — every place `text_body` is read for a human must read it
// through `readableText`.
//
// WHY THIS TEST EXISTS, and why it is a source scan rather than a behaviour
// test. `htmlToPlainText` runs at INGEST, and until MAIL-READER.M1 it decoded
// a handful of NAMED character references and no numeric ones — so `&#38;` is
// sitting in `email_inbox_messages.text_body` on every row that arrived before
// that fix, estate-wide. Fixing ingest only helps mail arriving from now on.
//
// M1 added the render-time half and wired it into the phone's thread screen
// ONLY. Five other places read the same column and every one of them still
// showed the raw reference: the web thread, both snippet builders, the web
// forward preview — and `forwardedBody`, which is the one that matters most,
// because that text is SENT, to somebody outside this estate, in their own
// mail client, where `&#38;` is wrong and unattributable.
//
// The lesson is not "we missed five sites". It is that a composition spelled
// out inline at one call site is a composition the next site does not know to
// copy. `readableText` is the name; this file is the list of who must use it,
// so a sixth site added later is a failing test rather than a bug report from
// somebody squinting at a screenshot.
//
// 🔴 IT IS A FLOOR, NOT PROOF. A source scan cannot tell whether the call is
// on the right value or reached at the right time — only that the site did
// not silently go back to reading the raw column. The behavioural proof lives
// in ConversationThread.entities.test.jsx (web render), email-forward.test.js
// (what a recipient gets), and the two snippet suites.
//
// ADDING A SITE: if a new file reads `text_body` for presentation or for
// sending, add it here. If it reads it for something that is NOT presentation
// — a hash, a length, an equality check against the stored value — add it to
// RAW_IS_CORRECT with the reason, because decoding there would be a bug.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

// Every site that presents `text_body` to a person, or sends it to one.
const MUST_DECODE = [
  ['src/components/mail/ConversationThread.jsx', 'the web thread body and its quoted chain'],
  ['src/components/mail/mail-vocabulary.js', "web's messageSnippet — list rows and folded thread rows"],
  ['src/components/mail/ForwardForm.jsx', 'the web forward preview'],
  ['src/lib/email-forward.js', 'forwardedBody — this text is SENT to an external recipient'],
  ['mobile/lib/mail-conversations.js', "the phone's folded-row snippet"],
  ['mobile/app/(staff)/email/[conversationId].jsx', "the phone's thread body"],
]

// Sites that read the column deliberately RAW. Listed so the scan below stays
// honest about being a whitelist rather than a claim about the whole repo.
const RAW_IS_CORRECT = [
  [
    'src/app/api/email/mail/[id]/route.js',
    'the route SERVES the stored column; decoding server-side would rewrite what '
    + 'every client believes it received, and the mobile client needs the raw value '
    + 'to decode consistently with the web one',
  ],
]

describe('readableText is used everywhere text_body reaches a person', () => {
  it.each(MUST_DECODE)('%s — %s', (file) => {
    expect(read(file)).toContain('readableText')
  })

  it('and the sites that read it raw are deliberate, not forgotten', () => {
    for (const [file, reason] of RAW_IS_CORRECT) {
      expect(read(file)).toContain('text_body')
      expect(reason.length).toBeGreaterThan(40)
    }
  })

  it('readableText is one composition, defined once, on the shared seam', () => {
    // It lives in shared/ because both platforms need it — the phone cannot
    // import src/lib. If this ever becomes two implementations, the two
    // surfaces can disagree about the same row again, which is the whole bug.
    const shared = read('shared/mail-entities.js')
    expect(shared).toContain('export function readableText')
    expect(shared).toContain('stripInvisibleChars(decodeCharRefs(text))')
    // The web side reaches it through the re-export shim, not a second copy.
    expect(read('src/lib/mail-entities.js')).toContain("export * from '@shared/mail-entities'")
  })
})
