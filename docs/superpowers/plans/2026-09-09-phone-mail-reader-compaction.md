# Phone Mail Reader Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mobile Mail thread screen renders the email instead of the chrome around it — HTML mail drawn with React Native components, the header compacted to one line, the composer collapsed and bounded, the signature preview gone, and spam quarantine reachable from a phone for the first time.

**Architecture:** The server walks the **already-sanitised** email HTML once and hands the phone a small JSON block tree (`?body=blocks`), so no HTML is parsed on the device and no HTML engine is added to the app. The phone renders that tree with `<Text>`/`<View>`. Every screen decision — the composer's height cap, the audience summary, the folded header's contents, the spam action's label — is a pure function in `mobile/lib/`, because that is the only place under `mobile/` the test runner reaches.

**Tech Stack:** Next.js 16 App Router (server), `htmlparser2` + `sanitize-html` (already direct dependencies), Expo SDK 57 / React Native 0.86 + NativeWind (phone), vitest (node environment, no jsdom).

**Spec:** `docs/superpowers/specs/2026-09-09-phone-mail-reader-compaction-design.md`

---

## Read this before Task 1

Five facts about this repo that will otherwise cost you a session.

1. **`mobile/` cannot import `src/lib`.** `shared/` is the seam, imported as the bare `shared` file: package — `import { x } from 'shared/mail-quote'`, **never** a relative `../shared`, which Metro will not resolve. Not every name in a `shared/` module is re-exported; a missing one resolves to `undefined` and crashes only at runtime. `npm run check:mobile-imports` guards it.
2. **There is no test runner for mobile components.** `vitest.config.js` includes `mobile/lib/**/*.test.js` and nothing else under `mobile/`; the environment is `node` with no jsdom. So a decision that is not in `mobile/lib/` is a decision no test can see. This is why Tasks 6–8 exist before Tasks 9–11.
3. **`npm run lint` does not cover `mobile/`.** `npm run check:mobile-lint` is the only linter that does, it is error-level with `--max-warnings 0`, and it is what catches a reference left behind by a deletion. Tasks 9–11 delete things. Run it.
4. **A merged push to `main` touching `mobile/app/**`, `mobile/components/**`, `mobile/lib/**` or `shared/**` publishes an OTA to every production phone on the runtime lane on next launch.** That is intended here. No native module is added, so no `runtimeVersion` bump and no store submission.
5. **Never edit an existing `docs/CHANGELOG.md` row.** The file is `merge=union`; editing a pushed row duplicates it. Task 12 adds one new row.

Every task ends green. Run the single-file command shown in each step; run the full mirror only where a task says to.

---

## File Structure

**Create**

| Path | Responsibility |
| --- | --- |
| `shared/mail-entities.js` | `decodeCharRefs` (decimal, hex and named references) and `stripInvisibleChars` (the zero-width set that breaks Postgres FTS tokens). Both platforms, ingest and render. |
| `shared/mail-entities.test.js` | Its tests. |
| `src/lib/mail-entities.js` | `export * from '../../shared/mail-entities.js'` — the web-side re-export the pair-sync test expects. |
| `src/lib/email-blocks.js` | The block extractor. Runs on sanitised output only. Server-only. |
| `src/lib/email-blocks.test.js` | Its tests, including the one security property. |
| `mobile/lib/mail-blocks.js` | Pure render decisions for the block tree and for linkified text. |
| `mobile/lib/mail-blocks.test.js` | Its tests. |
| `mobile/components/mail/EmailBody.jsx` | Draws a block tree. Owns Show images and the blocked-image placeholder. |
| `tests/mail-reader-mobile-literals.test.js` | Source-scan: the literals that must exist, and the imports that must not survive. |

**Modify**

| Path | Change |
| --- | --- |
| `src/lib/email-content.js:66-74` | `htmlToPlainText` decodes through `decodeCharRefs`. |
| `src/app/api/email/mail/[id]/route.js:93,317,342` | `?body=blocks`: blocks instead of `html_document`, own budget. |
| `tests/shared-pair-sync.test.js:115` | `PAIRS` entry for `mail-entities.js`. |
| `tests/mail-vocabulary-agreement.test.js:265` | Pin mobile's view ids against `shared.MAIL_VIEWS`. |
| `mobile/lib/mail-conversations.js:86` | Spam view; `shortMailboxLabel`, `headerDetailLines`, `audienceSummary`, `composerCap`, `spamActionLabel`. |
| `mobile/lib/email-api.js:189` | `?body=blocks`; `setConversationSpam`. |
| `mobile/lib/mail-relate.js` | `relatedNudge` gains a `chip` string. |
| `mobile/app/(staff)/email/[conversationId].jsx` | Body renderer, header compaction, composer, spam action, signature box removal. |
| `mobile/app/(staff)/email/compose.jsx:481,672` | Signature box removal. |
| `mobile/app/(staff)/email/forward.jsx:163,448` | Signature box removal. |
| `docs/CHANGELOG.md` | One new row. |

---

## Task 1: Character references decode everywhere

`&#38;` printed literally in Richard's screenshot. `htmlToPlainText` decodes six named entities and no numeric ones, and it runs at **ingest**, so affected rows are already stored wrong — hence a shared decoder used at ingest *and* at render.

**Files:**
- Create: `shared/mail-entities.js`
- Create: `shared/mail-entities.test.js`
- Create: `src/lib/mail-entities.js`
- Modify: `src/lib/email-content.js:66-74`
- Modify: `tests/shared-pair-sync.test.js` (the `PAIRS` object, from line 115)

- [x] **Step 1: Write the failing test**

Create `shared/mail-entities.test.js`:

```js
// MAIL-READER.M1 — character references, decoded once and the same way on both
// platforms. htmlToPlainText handled six named entities and no numeric ones, so
// `&#38;` reached the stored text_body and printed literally on the phone.
import { describe, it, expect } from 'vitest'
import { decodeCharRefs } from './mail-entities.js'

describe('decodeCharRefs', () => {
  it('decodes decimal references', () => {
    expect(decodeCharRefs('a&#38;b')).toBe('a&b')
    expect(decodeCharRefs('it&#39;s')).toBe("it's")
  })

  it('decodes hex references, either case', () => {
    expect(decodeCharRefs('it&#x27;s')).toBe("it's")
    expect(decodeCharRefs('it&#X27;s')).toBe("it's")
  })

  it('decodes the named set', () => {
    expect(decodeCharRefs('&lt;b&gt; &amp; &quot;x&quot; &apos;y&apos;')).toBe('<b> & "x" \'y\'')
    expect(decodeCharRefs('a&nbsp;b')).toBe('a b')
    expect(decodeCharRefs('a&zwnj;b')).toBe('ab')
  })

  it('runs once, not twice — an escaped reference survives as text', () => {
    // The whole point: `&amp;#38;` means the sender wrote "&#38;", so one pass
    // must yield "&#38;" and not "&". A second pass would eat it.
    expect(decodeCharRefs('&amp;#38;')).toBe('&#38;')
  })

  it('leaves malformed references alone', () => {
    expect(decodeCharRefs('&#;')).toBe('&#;')
    expect(decodeCharRefs('&#x;')).toBe('&#x;')
    expect(decodeCharRefs('&notareference;')).toBe('&notareference;')
    expect(decodeCharRefs('100% & rising')).toBe('100% & rising')
  })

  it('refuses references outside the Unicode range rather than throwing', () => {
    expect(decodeCharRefs('&#1114112;')).toBe('&#1114112;')
    expect(decodeCharRefs('&#x110000;')).toBe('&#x110000;')
  })

  it('handles falsy and non-string input', () => {
    expect(decodeCharRefs('')).toBe('')
    expect(decodeCharRefs(null)).toBe('')
    expect(decodeCharRefs(undefined)).toBe('')
    expect(decodeCharRefs(42)).toBe('42')
  })

  it('decodes astral references', () => {
    expect(decodeCharRefs('&#128512;')).toBe('\u{1F600}')
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run shared/mail-entities.test.js`
Expected: FAIL — `Failed to resolve import "./mail-entities.js"`.

- [x] **Step 3: Write the implementation**

Create `shared/mail-entities.js`:

```js
// MAIL-READER.M1 — one decoder for HTML character references, used on both
// sides of the seam and at both ends of a message's life.
//
// WHY IT IS SHARED. htmlToPlainText (src/lib/email-content.js) decoded
// `&nbsp; &zwnj; &lt; &gt; &quot; &#39; &amp;` and nothing else, and it runs at
// INGEST — the Postmark inbound webhook and sent-lane.js both store
// `TextBody || htmlToPlainText(HtmlBody)`. So every numeric reference in a
// message with no text part is already in the stored `text_body`, and fixing
// the ingest path alone leaves every existing row printing `&#38;` forever.
// The phone therefore decodes at render too, which needs the rule on the
// `shared/` side of the seam.
//
// ONE PASS, DELIBERATELY. `&amp;#38;` means the sender wrote the characters
// "&#38;", so the result of one pass is "&#38;" and a second pass would be
// wrong. The single regex below is what guarantees that: it consumes each
// reference once, left to right, and never re-examines its own output.
//
// SAFE AT RENDER. The phone's destination is a React Native <Text>, which
// renders a string as a string — decoding cannot produce markup there. On the
// web this only ever feeds the plain-text fallback, never innerHTML.

// The named set is deliberately small: the ones that actually appear in this
// estate's mail and templates. An unknown name is left as written rather than
// guessed at — `&notareference;` is far more likely to be prose than markup.
const NAMED = Object.freeze({
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  zwnj: '',
  shy: '',
})

// One alternation, one pass. `&#(\d+);` decimal, `&#[xX]([0-9a-f]+);` hex,
// `&([a-z]+);` named.
const REF = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/g

// Above this, String.fromCodePoint throws. A reference nobody can render is
// left as the characters the sender typed — visible, and never an exception on
// a screen someone is trying to read their mail on.
const MAX_CODE_POINT = 0x10ffff

function fromCodePoint(code) {
  if (!Number.isFinite(code) || code < 0 || code > MAX_CODE_POINT) return null
  // Lone surrogates are legal code points but render as replacement squares
  // and can break string handling downstream; treat them as unrenderable.
  if (code >= 0xd800 && code <= 0xdfff) return null
  try {
    return String.fromCodePoint(code)
  } catch {
    return null
  }
}

/**
 * Decode HTML character references in plain text.
 *
 * @param {string} text
 * @returns {string} '' for falsy input; non-strings are stringified
 */
export function decodeCharRefs(text) {
  if (text === null || text === undefined || text === '') return ''
  const source = String(text)
  if (!source.includes('&')) return source
  return source.replace(REF, (whole, dec, hex, name) => {
    if (dec !== undefined) return fromCodePoint(Number.parseInt(dec, 10)) ?? whole
    if (hex !== undefined) return fromCodePoint(Number.parseInt(hex, 16)) ?? whole
    const named = NAMED[String(name).toLowerCase()]
    return named === undefined ? whole : named
  })
}
```

- [x] **Step 4: Run it to verify it passes**

Run: `npx vitest run shared/mail-entities.test.js`
Expected: PASS, 8 tests.

- [x] **Step 5: Add the web re-export**

Create `src/lib/mail-entities.js`:

```js
// PAIRSYNC — a shim, not a second implementation. See shared/mail-entities.js
// for why the rule lives on the shared side; web imports it through here so
// `@/lib/...` call sites read like every other lib import in src/.
export * from '../../shared/mail-entities.js'
```

- [x] **Step 6: Point `htmlToPlainText` at it**

In `src/lib/email-content.js`, add to the imports at the top of the file:

```js
import { decodeCharRefs } from './mail-entities'
```

Then replace the entity block (currently lines 66–74):

```js
  // Decode the entity set that actually appears in our templates.
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&zwnj;|&#8204;|&#847;/gi, '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
```

with:

```js
  // MAIL-READER.M1 — every reference, named or numeric, in ONE pass. This used
  // to be seven ordered .replace() calls covering the named set plus two
  // hard-coded numeric ones (`&#8204;`, `&#847;`), which is why `&#38;` reached
  // a stored text_body and printed literally on the phone. `&#8204;` and
  // `&#847;` were zero-width joiners deliberately dropped rather than decoded;
  // decodeCharRefs decodes them to the characters they are, and the whitespace
  // collapse below removes them, so the visible result is unchanged.
  s = decodeCharRefs(s)
```

- [x] **Step 7: Run the existing email-content tests**

Run: `npx vitest run src/lib/email-content.test.js`
Expected: PASS. If a test asserted a literal `&#8204;` survived, the correct fix is the expectation: that character is now decoded and then collapsed away. Verify by reading the assertion — do not regex-patch test files, this repo has been burned twice doing that; edit by exact string.

- [x] **Step 8: Register the pair**

In `tests/shared-pair-sync.test.js`, inside the `PAIRS` object (starting line 115), add alongside the existing `'mail-quote.js'` entry:

```js
  'mail-entities.js': {
    mode: 'reexport',
    web: 'src/lib/mail-entities.js',
    reason:
      '`export * from` shim; src/lib/mail-entities.js re-exports it so web call sites read as @/lib, '
      + "and mobile imports 'shared/mail-entities' directly, so ingest and both render paths decode "
      + 'character references with the very same function.',
  },
```

- [x] **Step 9: Run the pair-sync and full suite**

Run: `npx vitest run tests/shared-pair-sync.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS, whole suite.

- [x] **Step 10: Commit**

```bash
git add shared/mail-entities.js shared/mail-entities.test.js src/lib/mail-entities.js src/lib/email-content.js tests/shared-pair-sync.test.js
git commit -m "MAIL-READER.M1 — decode every character reference, at ingest and at render"
```

Extend that message body to say: htmlToPlainText handled seven references and no other numeric ones, and it runs at ingest, so `&#38;` was already stored in text_body and printed literally on the phone; decodeCharRefs lives in shared/ because the fix needs both ends; one pass by construction, so `&amp;#38;` yields `&#38;` and not `&`. End with the `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>` trailer.

---

## Task 2: The extractor — inline runs, paragraphs and headings

**Files:**
- Create: `src/lib/email-blocks.js`
- Create: `src/lib/email-blocks.test.js`

- [x] **Step 1: Write the failing test**

Create `src/lib/email-blocks.test.js`:

```js
// MAIL-READER.M1 — the block extractor. It runs on the OUTPUT of
// sanitizeEmailHtml, never on raw input, so every test here feeds it sanitised
// markup and asserts shape only.
import { describe, it, expect } from 'vitest'
import { htmlToBlocks } from './email-blocks'

describe('htmlToBlocks — inline runs', () => {
  it('turns a paragraph into one para block with one run', () => {
    expect(htmlToBlocks('<p>Hello there</p>').blocks).toEqual([
      { type: 'para', runs: [{ text: 'Hello there' }] },
    ])
  })

  it('marks bold, italic and strike runs', () => {
    const { blocks } = htmlToBlocks('<p>a <b>bold</b> <i>it</i> <s>gone</s></p>')
    expect(blocks[0].runs).toEqual([
      { text: 'a ' },
      { text: 'bold', bold: true },
      { text: ' ' },
      { text: 'it', italic: true },
      { text: ' ' },
      { text: 'gone', strike: true },
    ])
  })

  it('treats strong/em/del as their plain equivalents', () => {
    const { blocks } = htmlToBlocks('<p><strong>s</strong><em>e</em><del>d</del></p>')
    expect(blocks[0].runs).toEqual([
      { text: 's', bold: true },
      { text: 'e', italic: true },
      { text: 'd', strike: true },
    ])
  })

  it('nests styles', () => {
    const { blocks } = htmlToBlocks('<p><b><i>both</i></b></p>')
    expect(blocks[0].runs).toEqual([{ text: 'both', bold: true, italic: true }])
  })

  it('merges adjacent runs of identical style', () => {
    // Email is full of pointless <span>s. One run per style change, not one
    // per element, or a sentence becomes forty <Text> nodes on the phone.
    const { blocks } = htmlToBlocks('<p><span>a</span><span>b</span><span>c</span></p>')
    expect(blocks[0].runs).toEqual([{ text: 'abc' }])
  })

  it('keeps an anchor inside running text as a run with href', () => {
    const { blocks } = htmlToBlocks('<p>see <a href="https://x.test/a">this page</a> now</p>')
    expect(blocks[0].runs).toEqual([
      { text: 'see ' },
      { text: 'this page', href: 'https://x.test/a' },
      { text: ' now' },
    ])
  })

  it('collapses whitespace and drops empty blocks', () => {
    const { blocks } = htmlToBlocks('<p>  a\n   b  </p><p>   </p><p></p>')
    expect(blocks).toEqual([{ type: 'para', runs: [{ text: 'a b' }] }])
  })

  it('breaks a <br> without opening a new block', () => {
    const { blocks } = htmlToBlocks('<p>one<br>two</p>')
    expect(blocks).toEqual([{ type: 'para', runs: [{ text: 'one\ntwo' }] }])
  })

  it('reads headings as their level', () => {
    const { blocks } = htmlToBlocks('<h1>One</h1><h3>Three</h3>')
    expect(blocks).toEqual([
      { type: 'heading', level: 1, runs: [{ text: 'One' }] },
      { type: 'heading', level: 3, runs: [{ text: 'Three' }] },
    ])
  })

  it('flushes bare text between block elements into its own para', () => {
    const { blocks } = htmlToBlocks('<div>first</div>loose<div>last</div>')
    expect(blocks).toEqual([
      { type: 'para', runs: [{ text: 'first' }] },
      { type: 'para', runs: [{ text: 'loose' }] },
      { type: 'para', runs: [{ text: 'last' }] },
    ])
  })

  it('renders <pre> as its own block with whitespace intact', () => {
    const { blocks } = htmlToBlocks('<pre>  keep\n  me</pre>')
    expect(blocks).toEqual([{ type: 'pre', text: '  keep\n  me' }])
  })

  it('answers empty input with no blocks', () => {
    expect(htmlToBlocks('').blocks).toEqual([])
    expect(htmlToBlocks(null).blocks).toEqual([])
  })
})
```

- [x] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/email-blocks.test.js`
Expected: FAIL — cannot resolve `./email-blocks`.

- [x] **Step 3: Write the implementation**

Create `src/lib/email-blocks.js`:

```js
// MAIL-READER.M1 — a phone-shaped block tree for one email.
//
// WHY THIS EXISTS. The web thread renders `html_document` in a sandboxed
// iframe (src/lib/email-html.js, "Layer 1"). React Native has no iframe, and
// react-native-webview is a NATIVE module — a new binary and App Review before
// any staff member sees it. So the phone gets no HTML engine at all: this
// module walks the sanitised document ONCE, here, and the phone renders
// <Text>/<View> from the result. Nothing is parsed on the device.
//
// 🔴 IT RUNS ON SANITISED OUTPUT, NEVER ON RAW INPUT. Every function here
// assumes sanitizeEmailHtml() has already been past: no script survived, no
// <img> carries a live URL (`src`/`srcset` are not on that module's attribute
// allowlist AT ALL — a remote image arrives parked under `data-original-src`
// and everything else arrives with no URL), CSS is scrubbed, and entities are
// normalised. This module's whole job is SHAPE. Feeding it raw email would
// hand the phone a stranger's markup and is the one mistake that matters.
//
// SERVER ONLY. It imports email-html.js, which no client component may import
// (that module's own test scans every 'use client' file in src/ and this one
// is added to the same scan).
//
// WHAT IT DELIBERATELY DOES NOT PRESERVE: colour, font, alignment, background
// images, and the geometry of a 600px layout table. A phone column in source
// order is the trade — better than pinch-zooming a desk-width table, and
// honestly worse than a pixel copy. If a real email comes out wrong the escape
// hatch is a "View original" in the in-app browser, not more CSS in here.

import { parseDocument, DomUtils } from 'htmlparser2'

/**
 * Ceilings. One monster newsletter must not become a multi-megabyte JSON
 * payload on somebody's cellular connection, and a pathological tree must not
 * become an unbounded walk. Exceeding any of them stops the walk and reports
 * `truncated`, which the phone says out loud rather than silently showing a
 * clipped email.
 */
export const CAPS = Object.freeze({
  blocks: 400,
  runsPerBlock: 64,
  charsPerRun: 400,
  charsPerMessage: 20_000,
})

const HEADING_LEVEL = Object.freeze({ h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 })
const BOLD = new Set(['b', 'strong', 'th'])
const ITALIC = new Set(['i', 'em'])
const STRIKE = new Set(['s', 'strike', 'del'])
const MONO = new Set(['code', 'tt', 'kbd', 'samp'])

// email-html.js's own stand-in when a sender gave no alt. Echoing it back as
// though the sender had written it turns our placeholder into their caption.
const SANITISER_ALT = 'Blocked image'

// Elements that end whatever inline run is open. `br` is handled separately —
// it breaks the LINE without ending the block, which is how email writes a
// multi-line paragraph.
const BLOCK_LEVEL = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'center', 'blockquote', 'pre',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
  'hr', 'img', 'figure', 'figcaption', 'address', 'fieldset', 'form',
])

// The style flags a run may carry, in a fixed order so two runs built by
// different paths compare equal and merge.
const STYLE_KEYS = ['bold', 'italic', 'strike', 'mono', 'href']

function sameStyle(a, b) {
  return STYLE_KEYS.every(k => (a[k] || undefined) === (b[k] || undefined))
}

function styleFor(name, inherited) {
  const next = { ...inherited }
  if (BOLD.has(name)) next.bold = true
  if (ITALIC.has(name)) next.italic = true
  if (STRIKE.has(name)) next.strike = true
  if (MONO.has(name)) next.mono = true
  return next
}

/** Collapse runs of whitespace to a single space, keeping explicit newlines. */
function collapse(text) {
  return String(text).replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n')
}

/**
 * The accumulator. It owns every cap, so no walker branch can forget one, and
 * it owns run merging, so the tree the phone gets has one run per style change
 * rather than one per <span>.
 */
class Sink {
  constructor() {
    this.blocks = []
    this.runs = []
    this.chars = 0
    this.truncated = false
  }

  full() {
    return this.blocks.length >= CAPS.blocks || this.chars >= CAPS.charsPerMessage
  }

  addText(text, style) {
    if (!text) return
    if (this.full()) { this.truncated = true; return }
    if (this.runs.length >= CAPS.runsPerBlock) { this.truncated = true; return }
    let slice = text
    if (slice.length > CAPS.charsPerRun) {
      slice = slice.slice(0, CAPS.charsPerRun)
      this.truncated = true
    }
    const room = CAPS.charsPerMessage - this.chars
    if (slice.length > room) {
      slice = slice.slice(0, room)
      this.truncated = true
    }
    if (!slice) return
    this.chars += slice.length
    const prev = this.runs[this.runs.length - 1]
    if (prev && sameStyle(prev, style)) {
      prev.text += slice
      return
    }
    const run = { text: slice }
    for (const k of STYLE_KEYS) if (style[k]) run[k] = style[k]
    this.runs.push(run)
  }

  /** Take the open runs, trimmed at the edges; [] when there is nothing. */
  takeRuns() {
    const runs = this.runs
    this.runs = []
    if (runs.length === 0) return []
    runs[0].text = runs[0].text.replace(/^[ \n]+/, '')
    runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/[ \n]+$/, '')
    const kept = runs.filter(r => r.text !== '')
    return kept.length && kept.some(r => r.text.trim() !== '') ? kept : []
  }

  /**
   * Close the open runs as a block. An anchor ALONE in its block becomes a
   * `link` block instead of a paragraph: a marketing email's call to action is
   * an <a> painted to fill a table cell, and on a phone it wants to be a
   * tappable row rather than a line of blue text.
   */
  flush(type = 'para', extra = null) {
    const runs = this.takeRuns()
    if (runs.length === 0) return
    if (this.full()) { this.truncated = true; return }
    if (type === 'para' && runs.length === 1 && runs[0].href) {
      this.blocks.push({ type: 'link', href: runs[0].href, runs: [{ text: runs[0].text }] })
      return
    }
    this.blocks.push(extra ? { type, ...extra, runs } : { type, runs })
  }

  /** Push a finished block that owns no open runs (image, rule, pre, table). */
  push(block) {
    if (this.full()) { this.truncated = true; return }
    this.blocks.push(block)
  }
}

/** The runs of the first block that has any — for an <li> built of blocks. */
function firstRuns(blocks) {
  for (const block of blocks) {
    if (Array.isArray(block.runs) && block.runs.length) return block.runs
    if (block.type === 'quote') {
      const inner = firstRuns(block.blocks)
      if (inner.length) return inner
    }
  }
  return []
}

function walk(nodes, sink, style) {
  for (const node of nodes) {
    if (sink.full()) { sink.truncated = true; return }

    if (node.type === 'text') {
      sink.addText(collapse(node.data), style)
      continue
    }
    if (node.type !== 'tag') continue

    const name = node.name

    if (name === 'br') {
      sink.addText('\n', style)
      continue
    }
    if (name === 'pre') {
      sink.flush()
      const text = DomUtils.textContent(node).replace(/^\n/, '')
      if (text.trim()) sink.push({ type: 'pre', text: text.slice(0, CAPS.charsPerRun) })
      continue
    }

    const heading = HEADING_LEVEL[name]
    if (heading) {
      sink.flush()
      walk(node.children || [], sink, style)
      sink.flush('heading', { level: heading })
      continue
    }

    if (BLOCK_LEVEL.has(name)) {
      sink.flush()
      walk(node.children || [], sink, style)
      sink.flush()
      continue
    }

    // Inline: an anchor contributes an href to its subtree's style, anything
    // else contributes its emphasis (or nothing at all, for a <span>).
    const next = name === 'a'
      ? { ...style, ...(node.attribs?.href ? { href: node.attribs.href } : {}) }
      : styleFor(name, style)
    walk(node.children || [], sink, next)
  }
}

/**
 * Walk sanitised body HTML into blocks.
 *
 * @param {string} html  SANITISED body HTML — a fragment, not a document
 * @returns {{ blocks: object[], truncated: boolean }}
 */
export function htmlToBlocks(html) {
  const source = typeof html === 'string' ? html : ''
  if (!source.trim()) return { blocks: [], truncated: false }
  const dom = parseDocument(source)
  const sink = new Sink()
  walk(dom.children || [], sink, {})
  sink.flush()
  return { blocks: sink.blocks, truncated: sink.truncated }
}
```

- [x] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/email-blocks.test.js`
Expected: PASS, 12 tests.

- [x] **Step 5: Commit**

```bash
git add src/lib/email-blocks.js src/lib/email-blocks.test.js
git commit -m "MAIL-READER.M1 — block extractor: inline runs, paragraphs, headings"
```

Body: walks SANITISED email HTML into a small block tree the phone can render with Text/View, so no HTML engine is added to the app and nothing is parsed on the device. This commit is the inline layer — runs with bold/italic/strike/mono/href, adjacent same-style runs merged so a sentence is not forty Text nodes, `br` as a line break inside its block, headings, `pre`, and the caps that stop one newsletter becoming a multi-megabyte payload. End with the `Co-Authored-By` trailer.

---

## Task 3: The extractor — lists, quotes, rules, images and link blocks

**Files:**
- Modify: `src/lib/email-blocks.js`
- Modify: `src/lib/email-blocks.test.js`

- [ ] **Step 1: Write the failing test**

Append to `src/lib/email-blocks.test.js`:

```js
describe('htmlToBlocks — structure', () => {
  it('reads an unordered list', () => {
    const { blocks } = htmlToBlocks('<ul><li>one</li><li>two</li></ul>')
    expect(blocks).toEqual([
      { type: 'list', ordered: false, items: [[{ text: 'one' }], [{ text: 'two' }]] },
    ])
  })

  it('marks an ordered list ordered', () => {
    const { blocks } = htmlToBlocks('<ol><li>first</li></ol>')
    expect(blocks[0]).toEqual({ type: 'list', ordered: true, items: [[{ text: 'first' }]] })
  })

  it('keeps styled runs inside list items', () => {
    const { blocks } = htmlToBlocks('<ul><li><b>x</b> y</li></ul>')
    expect(blocks[0].items).toEqual([[{ text: 'x', bold: true }, { text: ' y' }]])
  })

  it('drops an empty list', () => {
    expect(htmlToBlocks('<ul><li> </li></ul>').blocks).toEqual([])
  })

  it('reads a blockquote as a quote holding blocks', () => {
    const { blocks } = htmlToBlocks('<blockquote><p>said</p><p>this</p></blockquote>')
    expect(blocks).toEqual([{
      type: 'quote',
      blocks: [
        { type: 'para', runs: [{ text: 'said' }] },
        { type: 'para', runs: [{ text: 'this' }] },
      ],
    }])
  })

  it('flattens a nested blockquote into the outer one', () => {
    // One level of visual nesting is all a 390pt screen can carry.
    const { blocks } = htmlToBlocks('<blockquote><p>a</p><blockquote><p>b</p></blockquote></blockquote>')
    expect(blocks).toEqual([{
      type: 'quote',
      blocks: [
        { type: 'para', runs: [{ text: 'a' }] },
        { type: 'para', runs: [{ text: 'b' }] },
      ],
    }])
  })

  it('reads a horizontal rule', () => {
    expect(htmlToBlocks('<p>a</p><hr><p>b</p>').blocks).toEqual([
      { type: 'para', runs: [{ text: 'a' }] },
      { type: 'rule' },
      { type: 'para', runs: [{ text: 'b' }] },
    ])
  })

  it('emits a parked remote image as a blocked image block', () => {
    const { blocks } = htmlToBlocks(
      '<img data-original-src="https://cdn.test/logo.png" alt="Acme">',
    )
    expect(blocks).toEqual([
      { type: 'image', blocked: 'https://cdn.test/logo.png', alt: 'Acme' },
    ])
  })

  it('drops an image with no parked URL, because it can never render', () => {
    // The sanitiser allows no `src` on img at all, so a cid:/data:/relative
    // image arrives with no URL of any kind. A placeholder for it would be a
    // permanently empty box.
    expect(htmlToBlocks('<img alt="inline">').blocks).toEqual([])
    expect(htmlToBlocks('<img>').blocks).toEqual([])
  })

  it("does not repeat the sanitiser's own placeholder alt as sender text", () => {
    // email-html.js sets alt="Blocked image" when the sender supplied none.
    const { blocks } = htmlToBlocks(
      '<img data-original-src="https://cdn.test/x.png" alt="Blocked image">',
    )
    expect(blocks).toEqual([{ type: 'image', blocked: 'https://cdn.test/x.png', alt: '' }])
  })

  it('turns an anchor alone in a table cell into a link block', () => {
    const { blocks } = htmlToBlocks(
      '<table><tr><td><a href="https://x.test/go">View document</a></td></tr></table>',
    )
    expect(blocks).toEqual([
      { type: 'link', href: 'https://x.test/go', runs: [{ text: 'View document' }] },
    ])
  })

  it('leaves an anchor with no href as plain text', () => {
    const { blocks } = htmlToBlocks('<p><a>no destination</a></p>')
    expect(blocks).toEqual([{ type: 'para', runs: [{ text: 'no destination' }] }])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/email-blocks.test.js`
Expected: FAIL — the list, quote, rule and image cases; lists currently flush as separate paras.

- [ ] **Step 3: Write the implementation**

In `src/lib/email-blocks.js`'s `walk`, insert these branches **before** the `if (BLOCK_LEVEL.has(name))` branch:

```js
    if (name === 'hr') {
      sink.flush()
      sink.push({ type: 'rule' })
      continue
    }

    if (name === 'img') {
      sink.flush()
      // 🔴 The ONLY URL an image block may carry is the one the sanitiser
      // parked. `src` cannot reach here — it is not on email-html.js's img
      // allowlist — so an image without `data-original-src` has no URL at all
      // and is dropped rather than emitted as a box that can never fill.
      const parked = node.attribs?.['data-original-src']
      if (parked) {
        const alt = node.attribs?.alt === SANITISER_ALT ? '' : (node.attribs?.alt || '')
        sink.push({ type: 'image', blocked: parked, alt })
      }
      continue
    }

    if (name === 'ul' || name === 'ol') {
      sink.flush()
      const items = []
      for (const child of node.children || []) {
        if (child.type !== 'tag' || child.name !== 'li') continue
        const inner = new Sink()
        walk(child.children || [], inner, style)
        const runs = inner.takeRuns()
        if (inner.truncated) sink.truncated = true
        // An <li> holding block elements (a nested table, a div) contributes
        // its text through those blocks' runs; take the first line so the item
        // is never empty when there was something in it.
        const flat = runs.length ? runs : firstRuns(inner.blocks)
        if (flat.length) items.push(flat)
        if (items.length >= CAPS.runsPerBlock) { sink.truncated = true; break }
      }
      if (items.length) sink.push({ type: 'list', ordered: name === 'ol', items })
      continue
    }

    if (name === 'blockquote') {
      sink.flush()
      const inner = new Sink()
      walk(node.children || [], inner, style)
      inner.flush()
      if (inner.truncated) sink.truncated = true
      // One level of nesting: a deeper quote's blocks join this one's, in
      // order, rather than indenting again on a 390pt screen.
      const flattened = []
      for (const block of inner.blocks) {
        if (block.type === 'quote') flattened.push(...block.blocks)
        else flattened.push(block)
      }
      if (flattened.length) sink.push({ type: 'quote', blocks: flattened })
      continue
    }
```

Note: an `<li>` built of block elements needs `inner.flush()` before `firstRuns` sees anything. Call `inner.flush()` after the `walk` in the list branch, before `takeRuns` — read the two together and order them so a list item of plain text still produces runs and one of `<div>`s still produces a first line.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/email-blocks.test.js`
Expected: PASS, 24 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/email-blocks.js src/lib/email-blocks.test.js
git commit -m "MAIL-READER.M1 — block extractor: lists, quotes, rules, images, link blocks"
```

Body: a parked remote image becomes `{ blocked, alt }`; an image with no parked URL is DROPPED, because the sanitiser allows no `src` on `img` at all, so a `cid:`, `data:` or relative image arrives with no URL and a placeholder for it could never fill. The sanitiser's own "Blocked image" alt is not echoed back as though the sender had written it. An anchor alone in its block becomes a tappable link block, which is what a marketing email's call to action actually is. A nested blockquote flattens into its parent: one level of indent is all a 390pt screen carries. End with the trailer.

---

## Task 4: The extractor — tables, and the `emailBlocks` entry point

**Files:**
- Modify: `src/lib/email-blocks.js`
- Modify: `src/lib/email-blocks.test.js`
- Modify: `src/lib/email-html.test.js` (the client-import scan)

- [ ] **Step 1: Write the failing test**

Append to `src/lib/email-blocks.test.js`, and add `emailBlocks` and `CAPS` to the file's import:

```js
describe('htmlToBlocks — tables', () => {
  it('flattens a layout table to its cells in source order', () => {
    // A 600px marketing wrapper. No <th>, so it is layout, and layout wants to
    // become a phone column.
    const { blocks } = htmlToBlocks(
      '<table><tr><td><h2>Title</h2></td></tr><tr><td><p>Body copy</p></td></tr></table>',
    )
    expect(blocks).toEqual([
      { type: 'heading', level: 2, runs: [{ text: 'Title' }] },
      { type: 'para', runs: [{ text: 'Body copy' }] },
    ])
  })

  it('keeps a table with a <th> as a table', () => {
    const { blocks } = htmlToBlocks(
      '<table><tr><th>Item</th><th>Total</th></tr>'
      + '<tr><td>Membership</td><td>€189.00</td></tr></table>',
    )
    expect(blocks).toEqual([{
      type: 'table',
      head: [[{ text: 'Item', bold: true }], [{ text: 'Total', bold: true }]],
      rows: [[[{ text: 'Membership' }], [{ text: '€189.00' }]]],
    }])
  })

  it('keeps a table with a <thead> as a table', () => {
    const { blocks } = htmlToBlocks(
      '<table><thead><tr><td>A</td></tr></thead><tbody><tr><td>1</td></tr></tbody></table>',
    )
    expect(blocks[0].type).toBe('table')
    expect(blocks[0].head).toEqual([[{ text: 'A' }]])
    expect(blocks[0].rows).toEqual([[[{ text: '1' }]]])
  })

  it('flattens a table nested inside a data table', () => {
    const { blocks } = htmlToBlocks(
      '<table><tr><th>H</th></tr><tr><td><table><tr><td>deep</td></tr></table></td></tr></table>',
    )
    expect(blocks[0].type).toBe('table')
    expect(blocks[0].rows).toEqual([[[{ text: 'deep' }]]])
  })
})

describe('htmlToBlocks — caps', () => {
  it('stops at the block cap and reports truncated', () => {
    const html = '<p>x</p>'.repeat(CAPS.blocks + 20)
    const { blocks, truncated } = htmlToBlocks(html)
    expect(blocks.length).toBe(CAPS.blocks)
    expect(truncated).toBe(true)
  })

  it('stops at the per-message character cap', () => {
    const html = `<p>${'a'.repeat(300)}</p>`.repeat(200)
    const { blocks, truncated } = htmlToBlocks(html)
    expect(truncated).toBe(true)
    expect(JSON.stringify(blocks).length).toBeLessThan(CAPS.charsPerMessage * 2)
  })

  it('truncates one very long run', () => {
    const { blocks, truncated } = htmlToBlocks(`<p>${'b'.repeat(CAPS.charsPerRun + 50)}</p>`)
    expect(blocks[0].runs[0].text.length).toBe(CAPS.charsPerRun)
    expect(truncated).toBe(true)
  })

  it('reports untruncated for ordinary mail', () => {
    expect(htmlToBlocks('<p>short</p>').truncated).toBe(false)
  })
})

describe('emailBlocks', () => {
  it('sanitises, walks and reports the blocked count', () => {
    const result = emailBlocks(
      '<p onclick="steal()">Hi <script>bad()</script></p>'
      + '<img src="https://cdn.test/pixel.gif">',
    )
    expect(result.failed).toBe(false)
    expect(result.blocks).toEqual([
      { type: 'para', runs: [{ text: 'Hi' }] },
      { type: 'image', blocked: 'https://cdn.test/pixel.gif', alt: '' },
    ])
    expect(result.blockedImages).toBe(1)
    expect(result.quotedBlocks).toBe(null)
  })

  it('splits the quoted chain out, like emailHtmlDocuments does', () => {
    const result = emailBlocks(
      '<p>My answer</p><blockquote type="cite"><p>Their question</p></blockquote>',
    )
    expect(result.blocks).toEqual([{ type: 'para', runs: [{ text: 'My answer' }] }])
    expect(result.quotedBlocks).toEqual([{
      type: 'quote',
      blocks: [{ type: 'para', runs: [{ text: 'Their question' }] }],
    }])
  })

  it('answers empty for falsy or blank input', () => {
    for (const input of ['', '   ', null, undefined, 42]) {
      expect(emailBlocks(input)).toEqual({
        blocks: null, quotedBlocks: null, blockedImages: 0, truncated: false, failed: false,
      })
    }
  })

  it('returns no blocks for a body that sanitises to nothing', () => {
    expect(emailBlocks('<script>only()</script>').blocks).toBe(null)
  })

  it('🔴 no image block ever carries a URL the sanitiser did not park', () => {
    // THE property the phone's security rests on. Every shape that could smuggle
    // a live URL into the tree: a real src, a srcset, a pre-set
    // data-original-src, a non-http scheme, a protocol-relative host, a table
    // cell background and a CSS background-image.
    const hostile = [
      '<img src="https://evil.test/track.gif">',
      '<img srcset="https://evil.test/a.gif 1x">',
      '<img data-original-src="javascript:alert(1)">',
      '<img src="cid:inline-part">',
      '<img src="data:image/gif;base64,R0lGOD">',
      '<img src="//evil.test/x.gif">',
      '<img src="/relative.gif">',
      '<table><tr><td background="https://evil.test/bg.png">cell</td></tr></table>',
      '<div style="background-image:url(https://evil.test/bg.png)">styled</div>',
    ].join('')
    const { blocks } = emailBlocks(hostile)
    const urls = []
    const collect = (list) => {
      for (const b of list || []) {
        if (b.type === 'image') urls.push(b.blocked)
        if (b.type === 'quote') collect(b.blocks)
      }
    }
    collect(blocks)
    for (const url of urls) expect(url).toMatch(/^https?:\/\//)
    expect(urls).not.toContain('javascript:alert(1)')
    expect(urls).not.toContain('//evil.test/x.gif')
    expect(JSON.stringify(blocks)).not.toContain('evil.test')
  })
})
```

⚠️ The last assertion is the strongest one in this plan and it may need a small adjustment once you see the sanitiser's real output: if `<img src="https://evil.test/track.gif">` is parked (it is a remote http URL, so it will be), `evil.test` legitimately appears in `blocked`. Change the final assertion to name only the URLs that must be absent — the `javascript:`, `cid:`, `data:`, protocol-relative, relative, `background` and `background-image` ones — and keep the `toMatch(/^https?:\/\//)` loop, which is the real guarantee. Do not weaken the loop.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/email-blocks.test.js`
Expected: FAIL — `emailBlocks` is not exported; the `<th>` table flattens.

- [ ] **Step 3: Write the implementation**

Extend the import at the top of `src/lib/email-blocks.js`:

```js
import { parseDocument, DomUtils } from 'htmlparser2'
import { sanitizeEmailHtml, splitQuotedHtml } from './email-html'
```

Add above `walk`:

```js
/**
 * Is this table DATA, or is it layout?
 *
 * Email is built out of tables, and almost all of them are layout: a 600px
 * wrapper, a row per band, a cell per column. Flattening those to a phone
 * column is exactly right. But a receipt's line items are a real table, and
 * flattening THOSE reads as a jumble of numbers.
 *
 * The signal is `<th>` or `<thead>` — something a human authored deliberately.
 * That is a near-zero-false-positive test, which matters far more here than
 * catching every data table: mistaking a layout wrapper for data would put a
 * horizontally scrolling grid around an entire newsletter.
 */
function isDataTable(node) {
  return !!DomUtils.findOne(
    el => el.type === 'tag' && (el.name === 'th' || el.name === 'thead'),
    node.children || [],
    true,
  )
}

/** Every <tr> under a table, in document order, skipping nested tables. */
function rowsOf(node) {
  const rows = []
  const visit = (children) => {
    for (const child of children || []) {
      if (child.type !== 'tag') continue
      if (child.name === 'table') continue
      if (child.name === 'tr') rows.push(child)
      else visit(child.children)
    }
  }
  visit(node.children)
  return rows
}

/** One row's cells as run arrays. */
function cellsOf(row, style, sink) {
  const cells = []
  for (const cell of row.children || []) {
    if (cell.type !== 'tag' || (cell.name !== 'td' && cell.name !== 'th')) continue
    const inner = new Sink()
    walk(cell.children || [], inner, styleFor(cell.name, style))
    if (inner.truncated) sink.truncated = true
    const runs = inner.takeRuns()
    if (runs.length) { cells.push(runs); continue }
    inner.flush()
    cells.push(firstRuns(inner.blocks))
  }
  return cells
}
```

Then in `walk`, insert this branch **before** the `if (BLOCK_LEVEL.has(name))` branch:

```js
    if (name === 'table') {
      sink.flush()
      if (!isDataTable(node)) {
        // Layout. Walk straight through it — the cells' own blocks are the
        // phone's column, in source order.
        walk(node.children || [], sink, style)
        sink.flush()
        continue
      }
      const rows = rowsOf(node)
      const parsed = rows.map(row => cellsOf(row, style, sink)).filter(cells => cells.length)
      if (parsed.length) {
        const headed = !!DomUtils.findOne(
          el => el.type === 'tag' && el.name === 'th',
          rows[0]?.children || [],
          false,
        ) || !!DomUtils.findOne(
          el => el.type === 'tag' && el.name === 'thead',
          node.children || [],
          true,
        )
        sink.push(headed
          ? { type: 'table', head: parsed[0], rows: parsed.slice(1) }
          : { type: 'table', head: null, rows: parsed })
      }
      continue
    }
```

Finally append the entry point to the end of the file:

```js
/**
 * The whole render decision for one message's HTML, as the route reports it.
 *
 * Mirrors emailHtmlDocuments() deliberately — same inputs, same failure
 * posture, same quote split — so the two body shapes the route can serve
 * cannot drift in what they consider a renderable message.
 *
 * @param {string} raw  the stored html_body, hostile input
 * @returns {{
 *   blocks: object[]|null, quotedBlocks: object[]|null,
 *   blockedImages: number, truncated: boolean, failed: boolean,
 * }}
 *   `blocks` null → the caller falls back to text_body.
 *   `failed` true → sanitising or parsing threw. The caller shows the text with
 *   a visible notice. It NEVER falls back to the raw input.
 */
export function emailBlocks(raw) {
  const empty = {
    blocks: null, quotedBlocks: null, blockedImages: 0, truncated: false, failed: false,
  }
  if (!raw || typeof raw !== 'string' || !raw.trim()) return empty
  try {
    const { html, blockedImages } = sanitizeEmailHtml(raw)
    if (!html.trim()) return empty
    const { body, quoted } = splitQuotedHtml(html)
    const main = htmlToBlocks(body)
    const chain = quoted ? htmlToBlocks(quoted) : { blocks: [], truncated: false }
    if (main.blocks.length === 0 && chain.blocks.length === 0) return empty
    return {
      blocks: main.blocks.length ? main.blocks : null,
      quotedBlocks: chain.blocks.length ? chain.blocks : null,
      blockedImages,
      truncated: main.truncated || chain.truncated,
      failed: false,
    }
  } catch {
    return { ...empty, failed: true }
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/email-blocks.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Add the module to the client-import scan**

`src/lib/email-html.js` carries "NO CLIENT COMPONENT MAY IMPORT THIS MODULE", enforced by a test in `src/lib/email-html.test.js` that scans every `'use client'` file in `src/`. `email-blocks.js` imports it and inherits the rule.

Find that test (search `use client` in `src/lib/email-html.test.js`), read it, and extend the specifiers it forbids so it covers `email-blocks` as well as `email-html`. Match its existing shape exactly — do not add a second scan.

Run: `npx vitest run src/lib/email-html.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/email-blocks.js src/lib/email-blocks.test.js src/lib/email-html.test.js
git commit -m "MAIL-READER.M1 — block extractor: tables, caps, and the emailBlocks entry point"
```

Body: a table flattens to a phone column unless it carries a `<th>` or `<thead>` — an authored signal with near-zero false positives, which matters more than catching every data table, because mistaking a 600px layout wrapper for data would wrap a whole newsletter in a scrolling grid. Nested tables always flatten. `emailBlocks` mirrors `emailHtmlDocuments`: same failure posture, same quote split, so the two body shapes the route can serve cannot disagree about what counts as a renderable message. The security property is pinned as its own test — no image block ever carries a URL the sanitiser did not park, over every shape that could smuggle one. End with the trailer.

---

## Task 5: The route serves blocks on request

**Files:**
- Modify: `src/app/api/email/mail/[id]/route.js` (imports; `GET` at line 93; `shapeMessages` at line 317; the budget at line 342)
- Modify: `src/app/api/email/mail/[id]/route.test.js`

- [ ] **Step 1: Write the failing test**

Read the existing file's fixture and request helpers first and reuse them — do not build a second harness. Then append:

```js
describe('GET ?body=blocks', () => {
  it('serves blocks and omits html_document', async () => {
    const res = await getConversation({ html_body: '<p>Hello <b>there</b></p>', body: 'blocks' })
    const message = res.data.messages[0]
    expect(message.html_blocks).toEqual([
      { type: 'para', runs: [{ text: 'Hello ' }, { text: 'there', bold: true }] },
    ])
    expect(message.html_document).toBeUndefined()
    expect(message.html_truncated).toBe(false)
  })

  it('serves the document when no body parameter is given', async () => {
    const res = await getConversation({ html_body: '<p>Hi</p>' })
    const message = res.data.messages[0]
    expect(typeof message.html_document).toBe('string')
    expect(message.html_blocks).toBeUndefined()
  })

  it('fails OPEN to the document on an unknown body value', async () => {
    // Deliberately unlike ?view=, which 400s: a display preference is not worth
    // refusing a thread over, and an older shipped bundle must keep working.
    const res = await getConversation({ html_body: '<p>Hi</p>', body: 'nonsense' })
    expect(res.status).toBe(200)
    expect(typeof res.data.messages[0].html_document).toBe('string')
  })

  it('never sends html_blocks for an internal note', async () => {
    const res = await getConversation({
      is_internal_note: true, html_body: '<p>staff</p>', body: 'blocks',
    })
    expect(res.data.messages[0].html_blocks).toBe(null)
  })

  it('omits messages past the block budget, newest first', async () => {
    const big = `<p>${'x'.repeat(9000)}</p>`
    const res = await getConversation({ messages: 60, html_body: big, body: 'blocks' })
    const shaped = res.data.messages
    // Messages are returned OLDEST first; the budget is spent NEWEST first, so
    // the oldest are the ones omitted.
    expect(shaped[shaped.length - 1].html_omitted).toBe(false)
    expect(shaped[0].html_omitted).toBe(true)
    expect(shaped[0].html_blocks).toBe(null)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run "src/app/api/email/mail/[id]/route.test.js"`
Expected: FAIL — `html_blocks` is undefined; `html_document` is present.

- [ ] **Step 3: Write the implementation**

Extend the import on line 4:

```js
import { emailHtmlDocuments } from '@/lib/email-html'
import { emailBlocks } from '@/lib/email-blocks'
```

Beside `HTML_BUDGET_BYTES` (line 91) add:

```js
// MAIL-READER.M1 — blocks mode has its own, much smaller budget. 1.5 MB is a
// sane document budget for a desk browser on a LAN; the phone is on cellular,
// and a block tree is far denser per rendered pixel than a document is. Spent
// newest-first, exactly like the document budget: the most recent
// correspondence is the part anyone reads.
const BLOCK_BUDGET_BYTES = 300_000

// The one value of ?body= that changes anything. Any other value — a typo, or a
// value a FUTURE bundle invents — falls through to the document, deliberately
// unlike ?view=, which 400s an unknown value. A display preference is not worth
// refusing a thread over, and it is what lets an older shipped bundle keep
// working unchanged.
const BODY_BLOCKS = 'blocks'
```

In `GET` (line 93):

```js
export async function GET(request, props) {
  const params = await props.params
  const wantsBlocks = new URL(request.url).searchParams.get('body') === BODY_BLOCKS
```

and at line 135:

```js
  const { messages, attachmentsUnavailable } = await shapeMessages(db, messagesDesc || [], wantsBlocks)
```

Change `shapeMessages`'s signature (line 317):

```js
async function shapeMessages(db, rows, wantsBlocks = false) {
```

Replace the budget line (342):

```js
  let budget = wantsBlocks ? BLOCK_BUDGET_BYTES : HTML_BUDGET_BYTES
```

⚠️ **Read lines 342–385 of the current file before editing.** The document branch must stay byte-identical apart from moving inside the `else`, and it returns fields this snippet does not name (`html_quoted_document` among them). Preserve every one. The shape below shows only what this change touches:

```js
    const { html_body: raw, ...rest } = row
    // The two shapes differ in exactly one thing: what carries the HTML. Every
    // flag the thread reads to decide which NOTICE to show is identical, so a
    // screen written against one shape reads the other's flags correctly.
    const base = {
      ...rest,
      author_name: authorNames.get(row.author_profile_id) || null,
      attachments: attachmentsByMessage.get(row.id) || [],
      ...(wantsBlocks
        ? { html_blocks: null, html_quoted_blocks: null, html_truncated: false }
        : { html_document: null, html_quoted_document: null }),
      html_blocked_images: 0,
      html_unsafe: false,
      html_omitted: false,
    }

    if (row.is_internal_note || !raw) return base
    if (budget <= 0) return { ...base, html_omitted: true }

    if (wantsBlocks) {
      // emailBlocks() swallows its own throw and reports `failed`; there is no
      // branch anywhere that returns `raw`.
      const { blocks, quotedBlocks, blockedImages, truncated, failed } = emailBlocks(raw)
      // Measured on the SERIALISED tree, because that is what crosses the wire.
      budget -= blocks ? JSON.stringify(blocks).length : 0
      return {
        ...base,
        html_blocks: blocks,
        html_quoted_blocks: quotedBlocks,
        html_blocked_images: blockedImages,
        html_truncated: truncated,
        html_unsafe: failed,
      }
    }

    // …the existing document branch, unchanged…
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run "src/app/api/email/mail/[id]/route.test.js"`
Expected: PASS, including the pre-existing document tests unchanged.

- [ ] **Step 5: Run the whole mail API surface**

Run: `npx vitest run src/app/api/email src/lib/email-blocks.test.js src/lib/email-html.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/email/mail/[id]/route.js" "src/app/api/email/mail/[id]/route.test.js"
git commit -m "MAIL-READER.M1 — GET /api/email/mail/[id]?body=blocks"
```

Body: serves the block tree instead of `html_document`, on its own 300KB budget spent newest-first — 1.5MB is a document budget for a desk browser on a LAN, and the phone is on cellular. `html_document` is omitted entirely in blocks mode, so the phone stops paying for a document it never rendered and mobile payloads get smaller as the feature lands. An absent or unknown `?body=` value returns today's response byte-for-byte; that is deliberately unlike `?view=`, which 400s, and it is what lets an older shipped bundle keep working. Every flag the thread reads to choose a notice is identical in both shapes. End with the trailer.

---

## Task 6: Mobile render decisions

Every decision the body renderer makes, as pure functions — because `mobile/lib/` is the only place under `mobile/` the test runner reaches.

**Files:**
- Create: `mobile/lib/mail-blocks.js`
- Create: `mobile/lib/mail-blocks.test.js`

- [ ] **Step 1: Write the failing test**

Create `mobile/lib/mail-blocks.test.js`:

```js
// MAIL-READER.M1 — the phone's render decisions for a block tree. The component
// that draws them cannot be tested (no runner reaches mobile/components), so
// every decision lives here.
import { describe, it, expect } from 'vitest'
import {
  normaliseBlocks, imageState, blockedImageCount, linkLabel, splitTextLinks,
} from './mail-blocks.js'

describe('normaliseBlocks', () => {
  it('keeps every known block type', () => {
    const blocks = [
      { type: 'heading', level: 2, runs: [{ text: 'h' }] },
      { type: 'para', runs: [{ text: 'p' }] },
      { type: 'list', ordered: false, items: [[{ text: 'i' }]] },
      { type: 'quote', blocks: [{ type: 'para', runs: [{ text: 'q' }] }] },
      { type: 'image', blocked: 'https://x.test/a.png', alt: '' },
      { type: 'link', href: 'https://x.test/go', runs: [{ text: 'Go' }] },
      { type: 'rule' },
      { type: 'pre', text: 'code' },
      { type: 'table', head: null, rows: [[[{ text: 'c' }]]] },
    ]
    expect(normaliseBlocks(blocks)).toEqual(blocks)
  })

  it('drops a block type it does not know, rather than crashing', () => {
    // A future server may invent one, and an OTA fleet runs behind the server.
    expect(normaliseBlocks([
      { type: 'para', runs: [{ text: 'keep' }] },
      { type: 'carousel', slides: 3 },
    ])).toEqual([{ type: 'para', runs: [{ text: 'keep' }] }])
  })

  it('drops blocks with nothing to draw', () => {
    expect(normaliseBlocks([
      { type: 'para', runs: [] },
      { type: 'para' },
      { type: 'list', items: [] },
      { type: 'image' },
      { type: 'link', runs: [{ text: 'x' }] },
      { type: 'pre', text: '' },
    ])).toEqual([])
  })

  it('normalises a heading level into range', () => {
    expect(normaliseBlocks([{ type: 'heading', level: 99, runs: [{ text: 'h' }] }]))
      .toEqual([{ type: 'heading', level: 6, runs: [{ text: 'h' }] }])
    expect(normaliseBlocks([{ type: 'heading', runs: [{ text: 'h' }] }]))
      .toEqual([{ type: 'heading', level: 1, runs: [{ text: 'h' }] }])
  })

  it('recurses into a quote and drops it when nothing survives', () => {
    expect(normaliseBlocks([{ type: 'quote', blocks: [{ type: 'nope' }] }])).toEqual([])
  })

  it('answers [] for anything that is not an array', () => {
    for (const input of [null, undefined, 'blocks', 7, {}]) {
      expect(normaliseBlocks(input)).toEqual([])
    }
  })
})

describe('imageState', () => {
  it('is blocked until the operator asks', () => {
    const block = { type: 'image', blocked: 'https://x.test/a.png', alt: '' }
    expect(imageState(block, false)).toBe('blocked')
    expect(imageState(block, true)).toBe('shown')
  })
})

describe('blockedImageCount', () => {
  it('counts every image, including inside a quote', () => {
    expect(blockedImageCount([
      { type: 'image', blocked: 'https://x.test/1.png' },
      { type: 'para', runs: [{ text: 'a' }] },
      { type: 'quote', blocks: [{ type: 'image', blocked: 'https://x.test/2.png' }] },
    ])).toBe(2)
  })

  it('is 0 for no images and for a bad tree', () => {
    expect(blockedImageCount([{ type: 'para', runs: [{ text: 'a' }] }])).toBe(0)
    expect(blockedImageCount(null)).toBe(0)
  })
})

describe('linkLabel', () => {
  it('leaves real link text alone', () => {
    expect(linkLabel('https://support.docusign.com/s/articles/x', 'How to sign a document'))
      .toBe('How to sign a document')
  })

  it('shortens a label that IS its href', () => {
    const url = 'https://support.docusign.com/s/articles/How-do-I-sign-a-DocuSign-document'
      + '-Basic-Signing?language=en_US&utm_campaign=GBL_XX_DBU_UPS_2211'
    expect(linkLabel(url, url)).toBe('support.docusign.com/…')
  })

  it('shortens when there is no label at all', () => {
    expect(linkLabel('https://x.test/' + 'a'.repeat(80), '')).toBe('x.test/…')
    expect(linkLabel('https://x.test/' + 'a'.repeat(80), null)).toBe('x.test/…')
  })

  it('shows a short URL in full', () => {
    expect(linkLabel('https://x.test/a', 'https://x.test/a')).toBe('https://x.test/a')
  })

  it('strips a leading www', () => {
    const url = 'https://www.docusign.com/' + 'a'.repeat(80)
    expect(linkLabel(url, url)).toBe('docusign.com/…')
  })

  it('falls back to the raw href when it cannot be parsed', () => {
    const long = 'mailto:' + 'a'.repeat(60) + '@x.test'
    expect(linkLabel(long, long)).toBe(long)
  })
})

describe('splitTextLinks', () => {
  it('splits a bare URL out of running text', () => {
    expect(splitTextLinks('see https://x.test/a now')).toEqual([
      { text: 'see ' },
      { text: 'https://x.test/a', href: 'https://x.test/a' },
      { text: ' now' },
    ])
  })

  it('handles the Docusign footer from the screenshot', () => {
    const url = 'https://support.docusign.com/s/articles/How-do-I-sign-a-DocuSign-document'
      + '-Basic-Signing?language=en_US&utm_campaign=GBL_XX_DBU_UPS_2211'
      + '_SignNotificationEmailFooter&utm_medium=product&utm_source=postsend'
    const parts = splitTextLinks(`Support Centre.\n${url}`)
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ text: 'Support Centre.\n' })
    expect(parts[1]).toEqual({ text: url, href: url })
  })

  it('does not swallow trailing sentence punctuation into the href', () => {
    expect(splitTextLinks('go to https://x.test/a.')).toEqual([
      { text: 'go to ' },
      { text: 'https://x.test/a', href: 'https://x.test/a' },
      { text: '.' },
    ])
  })

  it('does not keep a closing bracket that was never opened', () => {
    expect(splitTextLinks('(see https://x.test/a)')).toEqual([
      { text: '(see ' },
      { text: 'https://x.test/a', href: 'https://x.test/a' },
      { text: ')' },
    ])
  })

  it('linkifies nothing when there is no URL', () => {
    expect(splitTextLinks('plain words')).toEqual([{ text: 'plain words' }])
  })

  it('ignores a non-http scheme', () => {
    expect(splitTextLinks('ftp://x.test/a')).toEqual([{ text: 'ftp://x.test/a' }])
  })

  it('answers one empty segment for empty input', () => {
    expect(splitTextLinks('')).toEqual([{ text: '' }])
    expect(splitTextLinks(null)).toEqual([{ text: '' }])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run mobile/lib/mail-blocks.test.js`
Expected: FAIL — cannot resolve `./mail-blocks.js`.

- [ ] **Step 3: Write the implementation**

Create `mobile/lib/mail-blocks.js`:

```js
// MAIL-READER.M1 — every decision the phone's email body makes, as pure
// functions.
//
// WHY IT IS A LIB AND NOT PART OF THE COMPONENT. vitest.config.js reaches
// `mobile/lib/**/*.test.js` and nothing else under mobile/: there is no runner
// for mobile/components and no jsdom in this project. A decision written inline
// in JSX is a decision no test can see, and this repo has already shipped a
// toggle that did nothing behind a green suite. So the component draws; this
// file decides.
//
// No React-Native imports anywhere in this file — it runs under vitest's node
// environment, like the rest of mobile/lib.
//
// THE TREE IS THE SERVER'S. src/lib/email-blocks.js builds it from ALREADY
// SANITISED html; nothing is parsed here. The one security-relevant rule on
// this side is that `blocked` is the only URL an image block has, and the only
// thing that ever promotes it to a live fetch is the operator pressing Show
// images.

const KNOWN = new Set(['heading', 'para', 'list', 'quote', 'image', 'link', 'rule', 'pre', 'table'])

function hasRuns(block) {
  return Array.isArray(block?.runs)
    && block.runs.some(r => r && typeof r.text === 'string' && r.text !== '')
}

/**
 * Drop what cannot be drawn, and clamp what can.
 *
 * An UNKNOWN type is dropped rather than thrown on, deliberately: the server
 * deploys before an OTA reaches phones, and a bundle that crashed on a block
 * type it had not met yet would turn an additive server change into a dead
 * screen in somebody's hand.
 *
 * @param {unknown} blocks
 * @returns {object[]}
 */
export function normaliseBlocks(blocks) {
  if (!Array.isArray(blocks)) return []
  const out = []
  for (const block of blocks) {
    if (!block || !KNOWN.has(block.type)) continue
    switch (block.type) {
      case 'heading': {
        if (!hasRuns(block)) break
        const level = Math.min(6, Math.max(1, Number(block.level) || 1))
        out.push({ type: 'heading', level, runs: block.runs })
        break
      }
      case 'para':
        if (hasRuns(block)) out.push({ type: 'para', runs: block.runs })
        break
      case 'link':
        if (block.href && hasRuns(block)) {
          out.push({ type: 'link', href: block.href, runs: block.runs })
        }
        break
      case 'list': {
        const items = (Array.isArray(block.items) ? block.items : [])
          .filter(item => Array.isArray(item) && item.some(r => r?.text))
        if (items.length) out.push({ type: 'list', ordered: !!block.ordered, items })
        break
      }
      case 'quote': {
        const inner = normaliseBlocks(block.blocks)
        if (inner.length) out.push({ type: 'quote', blocks: inner })
        break
      }
      case 'image':
        // No `blocked`, no image: there is no other URL field, by design.
        if (block.blocked) {
          out.push({ type: 'image', blocked: block.blocked, alt: block.alt || '' })
        }
        break
      case 'rule':
        out.push({ type: 'rule' })
        break
      case 'pre':
        if (typeof block.text === 'string' && block.text.trim()) {
          out.push({ type: 'pre', text: block.text })
        }
        break
      case 'table': {
        const rows = (Array.isArray(block.rows) ? block.rows : [])
          .filter(row => Array.isArray(row) && row.length)
        const head = Array.isArray(block.head) && block.head.length ? block.head : null
        if (rows.length || head) out.push({ type: 'table', head, rows })
        break
      }
      default:
        break
    }
  }
  return out
}

/**
 * Blocked, or shown because the operator asked.
 *
 * Two states, not three: every image block the server emits is a parked one.
 *
 * @returns {'blocked'|'shown'}
 */
export function imageState(_block, showImages) {
  return showImages ? 'shown' : 'blocked'
}

/**
 * How many images this message is holding back.
 *
 * 🔴 Counted from the SAME tree the renderer draws, never from the route's
 * `html_blocked_images`. Two counters for one fact is how a label ends up
 * disagreeing with the screen it sits above.
 *
 * @param {object[]} blocks
 * @returns {number}
 */
export function blockedImageCount(blocks) {
  if (!Array.isArray(blocks)) return 0
  let n = 0
  for (const block of blocks) {
    if (block?.type === 'image' && block.blocked) n += 1
    else if (block?.type === 'quote') n += blockedImageCount(block.blocks)
  }
  return n
}

// Long enough that a real sentence of link text is never touched, short enough
// that a tracking URL cannot eat three lines of a 390pt screen.
const URL_LABEL_MAX = 48

/**
 * What a link should SAY.
 *
 * An anchor with real link text keeps it. A label that is its own href — which
 * is every bare URL in a plain-text email, and the reason Richard's screenshot
 * had 180 characters of `utm_` through the middle of it — is shortened to its
 * host. The full address stays on the block for a long-press.
 *
 * @param {string} href
 * @param {string} label
 * @returns {string}
 */
export function linkLabel(href, label) {
  const text = String(label || '')
  const url = String(href || '')
  const bare = text === '' || text === url
  if (!bare) return text
  if (url.length <= URL_LABEL_MAX) return url
  const match = /^https?:\/\/([^/?#]+)/i.exec(url)
  if (!match) return url
  return `${match[1].replace(/^www\./i, '')}/…`
}

// http(s) only, and deliberately not a general URL grammar: this runs over a
// stranger's plain text, and the cost of missing a link is a link that reads as
// text, while the cost of over-matching is text that reads as a link.
const BARE_URL = /https?:\/\/[^\s<>"']+/gi
// Sentence punctuation a writer puts AFTER a URL, which is not part of it.
const TRAILING = /[.,;:!?)\]}'"]+$/

/**
 * Split plain text into plain and link segments.
 *
 * Today `text_body` renders as one unbroken <Text> with no linkification at
 * all, which is the other half of the URL wall: the address is neither tappable
 * nor shortened.
 *
 * @param {string} text
 * @returns {{text: string, href?: string}[]}  always at least one segment
 */
export function splitTextLinks(text) {
  const source = text === null || text === undefined ? '' : String(text)
  if (!source) return [{ text: '' }]
  const out = []
  let cursor = 0
  BARE_URL.lastIndex = 0
  let match = BARE_URL.exec(source)
  while (match) {
    const raw = match[0]
    // Trim trailing punctuation, and a closing bracket with no opener inside
    // the URL itself — "(see https://x.test/a)" ends a sentence, not a path.
    let url = raw.replace(TRAILING, '')
    if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1)
    if (!url) url = raw
    const start = match.index
    if (start > cursor) out.push({ text: source.slice(cursor, start) })
    out.push({ text: url, href: url })
    cursor = start + url.length
    BARE_URL.lastIndex = cursor
    match = BARE_URL.exec(source)
  }
  if (cursor < source.length) out.push({ text: source.slice(cursor) })
  return out.length ? out : [{ text: source }]
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run mobile/lib/mail-blocks.test.js`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/mail-blocks.js mobile/lib/mail-blocks.test.js
git commit -m "MAIL-READER.M1 — mobile render decisions for the block tree"
```

Body: vitest reaches `mobile/lib` and nothing else under `mobile/`, so every decision the body renderer makes lives here and the component only draws — `normaliseBlocks` (an unknown type is DROPPED, never thrown on, because the server deploys ahead of the OTA fleet), `imageState`, `blockedImageCount` counted from the same tree the renderer draws so a label cannot disagree with its screen, and the two halves of the URL-wall fix: `linkLabel` shortens a label that is its own href, `splitTextLinks` linkifies plain text that today renders as one unbroken `Text`. End with the trailer.

---

## Task 7: Mobile screen decisions, and the Spam view

**Files:**
- Modify: `mobile/lib/mail-conversations.js` (`TICKET_VIEW_TABS` at line 86; new helpers appended)
- Modify: `mobile/lib/mail-conversations.test.js`
- Modify: `tests/mail-vocabulary-agreement.test.js` (the view-id test at line 265)

- [ ] **Step 1: Write the failing test**

Append to `mobile/lib/mail-conversations.test.js`, adding the new names to the file's existing import:

```js
describe('TICKET_VIEW_TABS — the Spam view', () => {
  it('carries all five views in the shared order', () => {
    expect(TICKET_VIEW_TABS.map(v => v.id))
      .toEqual(['inbox', 'needs_reply', 'sent', 'archived', 'spam'])
  })

  it('sends spam as its own ?view= value', () => {
    expect(ticketViewWire('spam')).toBe('spam')
  })

  it('gives the spam view its own empty copy', () => {
    const spam = ticketViewTab('spam')
    expect(spam.emptyTitle).toBe('No spam')
    expect(spam.emptyBody).toMatch(/30 days/)
  })
})

describe('spamActionLabel', () => {
  it('offers to quarantine a live conversation', () => {
    expect(spamActionLabel({ is_spam: false })).toEqual({
      label: 'Mark as spam', next: true, icon: 'alert-circle-outline',
    })
  })

  it('offers to release a quarantined one', () => {
    expect(spamActionLabel({ is_spam: true })).toEqual({
      label: 'Not spam', next: false, icon: 'shield-checkmark-outline',
    })
  })

  it('treats a missing flag as live, like every other reader of it', () => {
    expect(spamActionLabel({}).next).toBe(true)
    expect(spamActionLabel(null).next).toBe(true)
  })
})

describe('shortMailboxLabel', () => {
  it('takes the leading segment of the full label', () => {
    expect(shortMailboxLabel({ name: 'Accounts - Hatch Street' })).toBe('Accounts')
  })

  it('leaves a label with no separator alone', () => {
    expect(shortMailboxLabel({ name: 'Accounts' })).toBe('Accounts')
  })

  it('is null when there is no mailbox, so the caller says it in words', () => {
    // 🔴 mailbox_id is ON DELETE SET NULL: a deleted address ORPHANS its
    // correspondence rather than hiding it, and "No mailbox on this
    // conversation" is the sentence that keeps that visible. Never a chip
    // shortened to nothing.
    expect(shortMailboxLabel(null)).toBe(null)
    expect(shortMailboxLabel({})).toBe(null)
  })
})

describe('headerDetailLines', () => {
  it('names the mailbox in full, the live audience and the opener', () => {
    const lines = headerDetailLines(
      { mailbox: { name: 'Accounts - Hatch Street', address: 'accounts@hatchstreetfitness.com' } },
      { primary: 'On this thread: Sean Mulcahy <dse@docusign.net>', opener: 'Opened by Sean Mulcahy' },
    )
    expect(lines).toEqual([
      { key: 'mailbox', label: 'Account', value: 'Accounts - Hatch Street' },
      { key: 'thread', label: null, value: 'On this thread: Sean Mulcahy <dse@docusign.net>' },
      { key: 'opener', label: null, value: 'Opened by Sean Mulcahy' },
    ])
  })

  it('omits the opener when the server did not diverge them', () => {
    const lines = headerDetailLines({ mailbox: { name: 'A' } }, { primary: 'On this thread: x' })
    expect(lines.map(l => l.key)).toEqual(['mailbox', 'thread'])
  })

  it('says the no-mailbox case in words', () => {
    const lines = headerDetailLines({}, { primary: 'On this thread: x' })
    expect(lines[0]).toEqual({
      key: 'mailbox', label: 'Account', value: 'No mailbox on this conversation',
    })
  })
})

describe('audienceSummary', () => {
  const mailbox = { address: 'accounts@hatchstreetfitness.com' }

  it('is short on the face and full behind the info tap', () => {
    const summary = audienceSummary(
      { requester_email: 'dse@docusign.net', mailbox },
      { to: ['dse@docusign.net', 'sean@x.test'] },
    )
    expect(summary.short).toBe('To dse@docusign.net & 1 other')
    expect(summary.full).toBe(
      'Sends an email to dse@docusign.net and 1 other · replies come back to accounts@hatchstreetfitness.com',
    )
    expect(summary.disabled).toBe(false)
  })

  it('names one recipient without a count', () => {
    const summary = audienceSummary({ requester_email: 'a@x.test', mailbox }, { to: ['a@x.test'] })
    expect(summary.short).toBe('To a@x.test')
  })

  it('pluralises past two', () => {
    const summary = audienceSummary(
      { requester_email: 'a@x.test', mailbox },
      { to: ['a@x.test', 'b@x.test', 'c@x.test'] },
    )
    expect(summary.short).toBe('To a@x.test & 2 others')
  })

  it('short and full come from ONE derivation, so they cannot disagree', () => {
    // The bug this shape exists to prevent (EMAIL-PARTICIPANTS.12): the
    // placeholder naming one person and the footer naming another, on the
    // screen where a wrong name is most expensive. Both read
    // conversationReplyAudience.
    const conversation = { requester_email: 'requester@x.test', mailbox }
    const summary = audienceSummary(conversation, { to: ['live@x.test'] })
    expect(summary.short).toContain('live@x.test')
    expect(summary.full).toContain('live@x.test')
    expect(summary.short).not.toContain('requester@x.test')
  })

  it('a disabled audience shows the reason on the face, never a summary', () => {
    // There is no ⓘ to hide a refusal behind: the operator needs the sentence.
    const summary = audienceSummary({ requester_email: 'a@x.test', mailbox }, { empty: true })
    expect(summary.disabled).toBe(true)
    expect(summary.short).toBe(summary.full)
    expect(summary.full).toMatch(/nobody to reply to/)
  })
})

describe('composerCap', () => {
  it('is 40% of the space above the keyboard', () => {
    expect(composerCap(800)).toBe(320)
  })

  it('never goes below a usable floor', () => {
    // A short landscape window or a big keyboard must not shrink the composer
    // to a slot nothing fits in.
    expect(composerCap(300)).toBe(168)
    expect(composerCap(0)).toBe(168)
  })

  it('answers the floor for a height it cannot read', () => {
    for (const input of [null, undefined, NaN, -10, 'tall']) {
      expect(composerCap(input)).toBe(168)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run mobile/lib/mail-conversations.test.js`
Expected: FAIL — the new names are not exported and the view list has four entries.

- [ ] **Step 3: Add the Spam view**

In `mobile/lib/mail-conversations.js`, add a fifth entry to `TICKET_VIEW_TABS` after `archived`:

```js
  {
    // MAIL-SPAM.1 — the quarantine, and the phone's first sight of it. Rows
    // flagged at ingest (Postmark's SpamScore at or above the studio's
    // threshold) or by an operator. The ONLY view that shows them, and nothing
    // here counts towards the badge.
    id: 'spam', label: 'Spam', wire: 'spam',
    emptyTitle: 'No spam',
    emptyBody: 'Mail the filter catches waits here for 30 days in case it was real, then it is '
      + 'deleted. Nothing here counts towards the badge or pings anyone.',
  },
```

- [ ] **Step 4: Add the five helpers**

Append to `mobile/lib/mail-conversations.js`:

```js
// ── The compact reader (MAIL-READER.M1) ──────────────────────────────
//
// Option A, "compact at rest": the header is ONE meta line and `Details`
// reveals the rest, all the time. Desktop chose a reading mode that folds only
// while the operator writes (MAIL-READER.1 decision 5) because a 78vh card can
// afford to be generous at rest and mean while writing. A 390pt screen never
// has that surplus, so the compact form is simply the right form — a deliberate
// divergence, Richard 2026-09-09.
//
// These are functions rather than JSX because nothing under mobile/components
// or mobile/app is reachable by any test runner in this project.

/**
 * Which spam verb this conversation offers, and what it would set.
 *
 * A missing flag reads as LIVE, the same way every other reader of `is_spam`
 * treats it — a conversation is not quarantined until something says so.
 *
 * @param {{is_spam?: boolean}|null} conversation
 * @returns {{label: string, next: boolean, icon: string}}
 */
export function spamActionLabel(conversation) {
  const spam = !!conversation?.is_spam
  return spam
    ? { label: 'Not spam', next: false, icon: 'shield-checkmark-outline' }
    : { label: 'Mark as spam', next: true, icon: 'alert-circle-outline' }
}

/** The sentence for a conversation whose mailbox row is gone. */
export const NO_MAILBOX_LINE = 'No mailbox on this conversation'

/**
 * The account chip's short form — the leading segment of the full label.
 *
 * 🔴 NULL when there is no mailbox, so the caller says it in WORDS. `mailbox_id`
 * is ON DELETE SET NULL: a deleted address orphans its correspondence rather
 * than hiding it, and a chip shortened to nothing would hide exactly that.
 *
 * @param {{name?: string, address?: string}|null} mailbox
 * @returns {string|null}
 */
export function shortMailboxLabel(mailbox) {
  const full = mailboxLabel(mailbox)
  if (!full) return null
  const head = String(full).split(/\s+[-–—]\s+/)[0].trim()
  return head || full
}

/**
 * What `Details ⌄` reveals — the facts the four header bands used to spend a
 * line each on, in the order they were read in.
 *
 * @param {object|null} conversation
 * @param {{primary?: string, opener?: string}|null} threadLines
 * @returns {{key: string, label: string|null, value: string}[]}
 */
export function headerDetailLines(conversation, threadLines) {
  const lines = [{
    key: 'mailbox',
    label: 'Account',
    value: mailboxLabel(conversation?.mailbox) || NO_MAILBOX_LINE,
  }]
  if (threadLines?.primary) {
    lines.push({ key: 'thread', label: null, value: threadLines.primary })
  }
  if (threadLines?.opener) {
    lines.push({ key: 'opener', label: null, value: threadLines.opener })
  }
  return lines
}

/**
 * The audience, twice: short enough for the composer's face, and in full behind
 * the ⓘ.
 *
 * 🔴 BOTH STRINGS READ conversationReplyAudience. That is the whole point of
 * the shape: the placeholder naming one person while the footer named another
 * is a bug this screen has actually shipped (EMAIL-PARTICIPANTS.12), on the
 * screen where a wrong name is most expensive.
 *
 * A DISABLED audience returns the same sentence for both, because there is
 * nothing to compact — a refusal the operator has to read must not hide behind
 * a tap.
 *
 * @param {object|null} conversation
 * @param {{to?: string[], empty?: boolean, over_cap?: boolean}|null} replyRecipients
 * @returns {{short: string, full: string, disabled: boolean}}
 */
export function audienceSummary(conversation, replyRecipients) {
  const meta = conversationReplyAudienceMeta(conversation, replyRecipients)
  if (meta.disabled) return { short: meta.text, full: meta.text, disabled: true }
  const to = conversationReplyAudience(conversation, replyRecipients)
  // Names only the first, then a count — the idiom the footer and the
  // placeholder already use, off the same array.
  const extra = to.length - 1
  const short = extra <= 0
    ? `To ${to[0]}`
    : `To ${to[0]} & ${extra} ${extra === 1 ? 'other' : 'others'}`
  return { short, full: meta.text, disabled: false }
}

// 40% of the space above the keyboard (MAIL-READER.1 decision 1 capped the
// desktop card's composer at the same fraction). The FLOOR matters as much as
// the fraction: a short window or a tall keyboard must not shrink the composer
// to a slot nothing fits in.
const COMPOSER_FRACTION = 0.4
const COMPOSER_FLOOR = 168

/**
 * How tall the expanded composer may be.
 *
 * Today only the TextInput is capped (`max-h-32`); the attachment chips, the
 * budget line and the send-gate sentences below it are not, so a three-file
 * reply can push Send off the screen.
 *
 * @param {number} availableHeight  the measured height ABOVE the keyboard
 * @returns {number} pixels
 */
export function composerCap(availableHeight) {
  const h = Number(availableHeight)
  if (!Number.isFinite(h) || h <= 0) return COMPOSER_FLOOR
  return Math.max(COMPOSER_FLOOR, Math.round(h * COMPOSER_FRACTION))
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run mobile/lib/mail-conversations.test.js`
Expected: PASS.

- [ ] **Step 6: Pin the view lists against each other**

In `tests/mail-vocabulary-agreement.test.js`, beside the existing test at line 265, add:

```js
  it('the view ids are the same list on the phone as on the wire, in the same order', () => {
    // THE MISSING ASSERTION. The test above pins shared against the SERVER's
    // list; nothing pinned MOBILE's, and that is exactly how the Spam view came
    // to be absent from the phone from MAIL-SPAM.1 until MAIL-READER.M1 — five
    // views on the wire, four on the tab bar, and no test that could tell.
    expect(mobile.TICKET_VIEW_TABS.map(v => v.id)).toEqual(shared.MAIL_VIEWS.map(v => v.id))
  })

  it('every mobile view sends a wire value the server whitelists', () => {
    for (const tab of mobile.TICKET_VIEW_TABS) {
      // `wire: null` means "send no param", which the route reads as the inbox.
      if (tab.wire === null) expect(tab.id).toBe('inbox')
      else expect([...SERVER_MAIL_VIEWS]).toContain(tab.wire)
    }
  })
```

- [ ] **Step 7: Run the agreement test and the suite**

Run: `npx vitest run tests/mail-vocabulary-agreement.test.js`
Expected: PASS.

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add mobile/lib/mail-conversations.js mobile/lib/mail-conversations.test.js tests/mail-vocabulary-agreement.test.js
git commit -m "MAIL-READER.M1 — the phone's Spam view, and the screen decisions as pure functions"
```

Body: adds the fifth view the phone never had, and the assertion whose absence let it go missing — the agreement test pinned shared's view ids against the SERVER's and nothing pinned mobile's, so five views on the wire and four on the tab bar was invisible from MAIL-SPAM.1 until now. The compact reader's decisions land here rather than in JSX because no test runner in this project reaches `mobile/components` or `mobile/app`: `spamActionLabel`, `shortMailboxLabel` (null for no mailbox, so the caller says it in words — a deleted address ORPHANS its mail rather than hiding it), `headerDetailLines`, `audienceSummary` (short and full off ONE derivation, the shape that stops the placeholder and the footer naming different people), and `composerCap`. End with the trailer.

---

## Task 8: The mobile API surface

**Files:**
- Modify: `mobile/lib/email-api.js` (`getConversation` at line 189; new `setConversationSpam`)
- Modify: `mobile/lib/email-api.test.js`

- [ ] **Step 1: Write the failing test**

Read the file's existing `api` mock first and reuse it, then append:

```js
describe('getConversation — blocks mode', () => {
  it('asks for the block tree', async () => {
    await getConversation('c-1', 'loc-1')
    expect(lastCall().path).toBe('/api/email/mail/c-1?body=blocks')
  })

  it('passes the block fields through', async () => {
    mockOk({
      ticket: { id: 'c-1' },
      messages: [{
        id: 'm-1',
        html_blocks: [{ type: 'para', runs: [{ text: 'hi' }] }],
        html_quoted_blocks: null,
        html_truncated: false,
      }],
    })
    const res = await getConversation('c-1', 'loc-1')
    expect(res.messages[0].html_blocks).toEqual([{ type: 'para', runs: [{ text: 'hi' }] }])
  })

  it('survives a server that sends no block fields at all', async () => {
    // A server rollback after the OTA shipped. Absence of blocks is the TEXT
    // path, never an error state.
    mockOk({ ticket: { id: 'c-1' }, messages: [{ id: 'm-1', text_body: 'plain' }] })
    const res = await getConversation('c-1', 'loc-1')
    expect(res.success).toBe(true)
    expect(res.messages[0].html_blocks).toBeUndefined()
  })
})

describe('setConversationSpam', () => {
  it('posts the flag', async () => {
    await setConversationSpam('c-1', true, 'loc-1')
    expect(lastCall()).toMatchObject({
      path: '/api/email/mail/c-1/spam',
      options: { method: 'POST', body: { spam: true }, locationId: 'loc-1' },
    })
  })

  it('posts a release', async () => {
    await setConversationSpam('c-1', false, 'loc-1')
    expect(lastCall().options.body).toEqual({ spam: false })
  })

  it('coerces the flag, so a truthy value cannot post a non-boolean', async () => {
    await setConversationSpam('c-1', 1, 'loc-1')
    expect(lastCall().options.body).toEqual({ spam: true })
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run mobile/lib/email-api.test.js`
Expected: FAIL — the path has no `?body=blocks`; `setConversationSpam` is not exported.

- [ ] **Step 3: Write the implementation**

In `mobile/lib/email-api.js`, change the first line of `getConversation` (line 190):

```js
export async function getConversation(conversationId, locationId) {
  // MAIL-READER.M1 — ?body=blocks asks for a pre-parsed block tree instead of
  // `html_document`, the iframe-ready document this screen has never been able
  // to render and was downloading anyway (a 1.5MB budget per thread, discarded
  // on arrival). Blocks mode omits the document, so this makes the phone's
  // payload SMALLER as it gains the feature.
  //
  // 🔴 ABSENCE OF BLOCKS IS THE TEXT PATH, NOT AN ERROR. The server deploys
  // ahead of the OTA and could be rolled back behind it; a build that treated a
  // missing html_blocks as a failure would blank the thread instead of falling
  // back to text_body, which is what this screen did for its whole life.
  const res = await api(`/api/email/mail/${conversationId}?body=blocks`, { locationId })
```

The `return` below it (lines 191–214) spreads `res.data?.messages` wholesale, so the new fields arrive for free. Add no mapping.

Then append after `archiveConversation` (lines 160–173):

```js
/**
 * Quarantine a conversation, or release it (MAIL-SPAM.1).
 *
 * `true` quarantines, `false` releases — two states, like archive, and the flag
 * is ORTHOGONAL TO THE LIFECYCLE: the route touches only the spam columns, so
 * no caller may infer a status change from a quarantine.
 *
 * Releasing fires what ingest suppressed (the unread mirror and the staff
 * push). That is the route's job, not this caller's.
 *
 * This is the phone's first sight of the quarantine: the endpoint has existed
 * since MAIL-SPAM.1 and mobile had no wrapper, no action and no Spam view.
 */
export function setConversationSpam(conversationId, spam, locationId) {
  return api(`/api/email/mail/${conversationId}/spam`, {
    method: 'POST',
    body: { spam: !!spam },
    locationId,
  })
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run mobile/lib/email-api.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mobile/lib/email-api.js mobile/lib/email-api.test.js
git commit -m "MAIL-READER.M1 — the phone asks for blocks, and can quarantine"
```

Body: `getConversation` requests `?body=blocks`, which also drops the `html_document` this screen has never rendered and was downloading anyway — the payload gets smaller as the feature lands. Absence of blocks is pinned as the TEXT path, not an error state: the server deploys ahead of the OTA and could be rolled back behind it. `setConversationSpam` is the phone's first wrapper for an endpoint that has existed since MAIL-SPAM.1. End with the trailer.

---

## Task 9: The body renderer, on screen

**Files:**
- Create: `mobile/components/mail/EmailBody.jsx`
- Modify: `mobile/app/(staff)/email/[conversationId].jsx` (`FlatMessage` at line 410; the file header at lines 49–55)

- [ ] **Step 1: Write the component**

No runner reaches this file, so it is written to hold no decisions — every branch reads a function from Task 6.

Create `mobile/components/mail/EmailBody.jsx`:

```jsx
// MAIL-READER.M1 — a stranger's email, drawn with React Native primitives.
//
// 🔴 THIS COMPONENT HOLDS NO DECISIONS. Every one of them is a pure function in
// mobile/lib/mail-blocks.js, because vitest reaches mobile/lib and nothing else
// under mobile/ — there is no runner for this directory and no jsdom in this
// project. If you are about to write an `if` here that is not "which element
// draws this block", it belongs in the lib.
//
// WHERE THE TREE COMES FROM. src/lib/email-blocks.js walks the ALREADY
// SANITISED html server-side and the route serves it under ?body=blocks.
// Nothing is parsed on this device and there is no HTML engine in this app:
// react-native-webview is a native module, which would mean a new binary and
// App Review. So Layer 1 is not a sandboxed iframe here — it is the ABSENCE of
// an engine. No script can run because nothing can interpret one, and the
// Supabase session lives in SecureStore rather than a cookie a frame could
// reach.
//
// IMAGES. `blocked` is the only URL an image block carries — the value
// email-html.js parked, already proven there to be an absolute http(s) URL. The
// operator pressing "Show images" is the ONLY thing that turns it into a fetch,
// and the sentence beside it says why that is a decision and not a setting: a
// remote image in an email is usually a tracking pixel, and loading it reports
// the read to a stranger.

import React, { useState } from 'react'
import { View, Text, Image, Pressable, ScrollView, Linking, Alert } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { normaliseBlocks, imageState, blockedImageCount, linkLabel } from '../../lib/mail-blocks'

const HEADING_SIZE = {
  1: 'text-[19px]', 2: 'text-[17px]', 3: 'text-[16px]',
  4: 'text-[15px]', 5: 'text-[14px]', 6: 'text-[13px]',
}

function openHref(href) {
  Linking.openURL(href).catch(() => Alert.alert('Could not open that link', href))
}

/** One run of inline text. */
function Run({ run }) {
  const classes = [
    run.bold ? 'font-bold' : '',
    run.italic ? 'italic' : '',
    run.strike ? 'line-through' : '',
    run.mono ? 'font-mono' : '',
    run.href ? 'text-blue-700 underline' : 'text-un1t-text',
  ].filter(Boolean).join(' ')
  if (!run.href) return <Text className={classes}>{run.text}</Text>
  return (
    <Text
      className={classes}
      accessibilityRole="link"
      onPress={() => openHref(run.href)}
      onLongPress={() => Alert.alert('Link', run.href)}
    >
      {linkLabel(run.href, run.text)}
    </Text>
  )
}

function Runs({ runs }) {
  return <>{runs.map((run, i) => <Run key={i} run={run} />)}</>
}

function BlockedImage({ block }) {
  return (
    <View className="flex-row items-center rounded-lg border border-dashed border-un1t-border bg-un1t-surface px-2.5 py-2 mb-2">
      <Ionicons name="image-outline" size={13} color="#94A3B8" style={{ marginRight: 6 }} />
      <Text className="text-[11px] text-un1t-muted flex-1" numberOfLines={1}>
        {block.alt || 'Image not loaded'}
      </Text>
    </View>
  )
}

function Block({ block, showImages }) {
  switch (block.type) {
    case 'heading':
      return (
        <Text className={`${HEADING_SIZE[block.level]} font-extrabold text-un1t-text mb-2`}>
          <Runs runs={block.runs} />
        </Text>
      )
    case 'para':
      return <Text className="text-[15px] leading-[21px] mb-2.5"><Runs runs={block.runs} /></Text>
    case 'list':
      return (
        <View className="mb-2.5">
          {block.items.map((item, i) => (
            <View key={i} className="flex-row mb-1">
              <Text className="text-[15px] text-un1t-subtle mr-2">
                {block.ordered ? `${i + 1}.` : '•'}
              </Text>
              <Text className="text-[15px] leading-[21px] flex-1"><Runs runs={item} /></Text>
            </View>
          ))}
        </View>
      )
    case 'quote':
      return (
        <View className="border-l-2 border-un1t-border pl-3 mb-2.5">
          {block.blocks.map((inner, i) => (
            <Block key={i} block={inner} showImages={showImages} />
          ))}
        </View>
      )
    case 'link': {
      const label = linkLabel(block.href, block.runs.map(r => r.text).join(''))
      return (
        <Pressable
          onPress={() => openHref(block.href)}
          onLongPress={() => Alert.alert('Link', block.href)}
          accessibilityRole="link"
          accessibilityLabel={label}
          className="flex-row items-center justify-between rounded-xl border border-un1t-text px-3 py-2.5 mb-2.5 active:opacity-70"
        >
          <Text className="text-[13px] font-bold text-un1t-text flex-1" numberOfLines={2}>
            {label}
          </Text>
          <Ionicons name="open-outline" size={14} color="#111827" style={{ marginLeft: 8 }} />
        </Pressable>
      )
    }
    case 'image':
      return imageState(block, showImages) === 'shown'
        ? (
          <Image
            source={{ uri: block.blocked }}
            accessibilityLabel={block.alt || 'Image from this email'}
            resizeMode="contain"
            className="w-full h-40 mb-2.5"
          />
        )
        : <BlockedImage block={block} />
    case 'rule':
      return <View className="h-px bg-un1t-border my-2.5" />
    case 'pre':
      return (
        <ScrollView horizontal className="mb-2.5" showsHorizontalScrollIndicator={false}>
          <Text className="font-mono text-[12px] text-un1t-text">{block.text}</Text>
        </ScrollView>
      )
    case 'table':
      // A data table — it carried a <th> or <thead>, so it is worth its own
      // scroll rather than being flattened into the column.
      return (
        <ScrollView horizontal className="mb-2.5" showsHorizontalScrollIndicator={false}>
          <View>
            {block.head ? (
              <View className="flex-row border-b border-un1t-border">
                {block.head.map((cell, i) => (
                  <Text key={i} className="text-[12px] font-bold text-un1t-text px-2 py-1.5 min-w-[92px]">
                    <Runs runs={cell} />
                  </Text>
                ))}
              </View>
            ) : null}
            {block.rows.map((row, r) => (
              <View key={r} className="flex-row border-b border-un1t-border">
                {row.map((cell, c) => (
                  <Text key={c} className="text-[12px] text-un1t-text px-2 py-1.5 min-w-[92px]">
                    <Runs runs={cell} />
                  </Text>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      )
    default:
      // normaliseBlocks already dropped unknown types; this is the belt.
      return null
  }
}

/**
 * @param {object[]} blocks  the tree from html_blocks
 * @param {boolean} truncated  the server hit a cap
 */
export default function EmailBody({ blocks, truncated = false }) {
  const [showImages, setShowImages] = useState(false)
  const safe = normaliseBlocks(blocks)
  if (safe.length === 0) return null
  const blockedCount = blockedImageCount(safe)

  return (
    <View className="mt-2">
      {blockedCount > 0 ? (
        <View className="mb-2">
          <Pressable
            onPress={() => setShowImages(v => !v)}
            accessibilityRole="button"
            accessibilityLabel={showImages ? 'Hide images' : `Show ${blockedCount} images`}
            className="self-start flex-row items-center"
          >
            <Ionicons name="image-outline" size={12} color="#1E293B" style={{ marginRight: 5 }} />
            <Text className="text-[11px] font-semibold text-un1t-accent underline">
              {showImages ? 'Hide images' : `Show images (${blockedCount})`}
            </Text>
          </Pressable>
          {!showImages ? (
            // Said plainly, because it is a privacy decision made on the
            // member's behalf. Desktop's wording, verbatim.
            <Text className="text-[10px] text-un1t-muted mt-1">
              Remote images blocked — loading them tells the sender you read this
            </Text>
          ) : null}
        </View>
      ) : null}

      {safe.map((block, i) => <Block key={i} block={block} showImages={showImages} />)}

      {truncated ? (
        <Text className="text-[11px] text-un1t-muted">
          This email is very long — the rest of it is not shown here.
        </Text>
      ) : null}
    </View>
  )
}
```

- [ ] **Step 2: Wire it into the message body**

In `mobile/app/(staff)/email/[conversationId].jsx`, add to the imports:

```js
import EmailBody from '../../../components/mail/EmailBody'
import { splitTextLinks, linkLabel } from '../../../lib/mail-blocks'
import { decodeCharRefs, stripInvisibleChars } from 'shared/mail-entities'
```

In `FlatMessage` (line 410), beside the existing `const split = …`, add:

```js
  // MAIL-READER.M1 — the HTML path, when the server sent a tree. It falls back
  // to the text for a note (plain text by construction), a message with no
  // HTML, one past the block budget, one whose HTML would not sanitise, and a
  // server that sent no blocks at all.
  const blocks = msg.html_blocks || null
  const quotedBlocks = msg.html_quoted_blocks || null
```

Replace this line:

```jsx
      <Text className="text-base text-un1t-text">{shown}</Text>
```

with:

```jsx
      {blocks ? (
        <EmailBody blocks={blocks} truncated={!!msg.html_truncated} />
      ) : (
        // 🔴 decodeCharRefs at RENDER, not only at ingest: every row stored
        // before MAIL-READER.M1 still holds `&#38;` in its text_body, and
        // fixing htmlToPlainText only helps new mail. splitTextLinks is the
        // other half of the URL wall — this used to be one unbroken <Text>, so
        // a 180-character tracking URL was three lines of screen and not even
        // tappable.
        <Text className="text-base text-un1t-text">
          {splitTextLinks(stripInvisibleChars(decodeCharRefs(shown))).map((seg, i) => (
            seg.href ? (
              <Text
                key={i}
                className="text-blue-700 underline"
                accessibilityRole="link"
                onPress={() => Linking.openURL(seg.href).catch(() => {})}
                onLongPress={() => Alert.alert('Link', seg.href)}
              >
                {linkLabel(seg.href, seg.text)}
              </Text>
            ) : <Text key={i}>{seg.text}</Text>
          ))}
        </Text>
      )}

      {/* The notices the phone never had. Desktop shows both; this screen
          showed neither, so an email whose HTML would not sanitise looked
          exactly like an email that simply had none. */}
      {msg.html_unsafe ? (
        <Text className="text-[11px] text-amber-700 mt-1.5">
          This email’s formatting could not be displayed safely, so the plain text is shown instead.
        </Text>
      ) : null}
      {msg.html_omitted ? (
        <Text className="text-[11px] text-un1t-muted mt-1.5">
          Formatting is not shown for older messages in a long conversation.
        </Text>
      ) : null}
```

Then change the quote branch's condition so the HTML chain takes precedence. The existing block begins:

```jsx
      {split.quoted ? (
```

Make it:

```jsx
      {quotedBlocks ? (
        <View className="mt-2">
          <Pressable
            onPress={() => setQuoteOpen(v => !v)}
            accessibilityRole="button"
            accessibilityLabel={quoteOpen ? 'Hide quoted text' : 'Show quoted text'}
            className="self-start rounded-full border border-un1t-border bg-un1t-surface px-2 py-0.5"
          >
            <Text className="text-[11px] text-un1t-subtle">
              {quoteOpen ? 'Hide quoted text' : '··· Show quoted text'}
            </Text>
          </Pressable>
          {quoteOpen ? (
            <View className="mt-2 border-l-2 border-un1t-border pl-3">
              <EmailBody blocks={quotedBlocks} />
            </View>
          ) : null}
        </View>
      ) : split.quoted ? (
```

and leave the existing text-quote JSX as that ternary's middle arm, unchanged, with its existing `) : null}` closing the chain.

- [ ] **Step 3: Rewrite the file header's PLAIN TEXT ONLY paragraph**

Lines 49–55 now state the opposite of what the file does. Replace that paragraph with:

```js
// HTML IS RENDERED, WITHOUT AN HTML ENGINE (MAIL-READER.M1). The route serves
// `html_blocks` under ?body=blocks — a block tree src/lib/email-blocks.js walks
// out of the ALREADY SANITISED document, server-side. components/mail/EmailBody
// draws it with Text/View. `html_body` still never leaves the server, nothing
// is parsed on this device, and react-native-webview is still not a dependency:
// Layer 1 here is the ABSENCE of an HTML engine rather than a sandboxed iframe,
// which is why no script can run even in principle.
//
// The text path remains, and is not a legacy: an internal note (plain text by
// construction), a message with no HTML, one past the block budget, one whose
// HTML would not sanitise, and a server that sent no blocks at all — a rollback
// behind a shipped OTA — all render `text_body`. Absence of blocks is the text
// path, never an error.
```

- [ ] **Step 4: Lint**

Run: `npm run check:mobile-lint`
Expected: PASS. This is the step that catches a stale reference — read every error, each is real.

Run: `npm run check:mobile-imports`
Expected: PASS. If it flags `shared/mail-entities`, `decodeCharRefs` or `stripInvisibleChars` is not exported from that module — fix the export, not the import.

- [ ] **Step 5: Commit**

```bash
git add mobile/components/mail/EmailBody.jsx "mobile/app/(staff)/email/[conversationId].jsx"
git commit -m "MAIL-READER.M1 — the phone renders HTML email"
```

Body: `EmailBody` draws the server's block tree with Text/View and holds NO decisions — every branch reads `mobile/lib/mail-blocks`, because no runner reaches `mobile/components`. Show images and desktop's privacy sentence come across verbatim; `blocked` is the only URL an image block has and the operator's tap is the only thing that fetches it. The text path stays and is not legacy: a note, a message with no HTML, one past the budget, one that would not sanitise, and a server rolled back behind a shipped OTA all render `text_body`. It now decodes character references at render (every row stored before today still holds `&#38;`) and linkifies bare URLs, which used to be one unbroken `Text` — three lines of screen and not even tappable. Adds the two notices the phone never had, so an email whose HTML would not sanitise no longer looks like one that had none. End with the trailer.

---

## Task 10: The compact header, and the spam action

**Files:**
- Modify: `mobile/app/(staff)/email/[conversationId].jsx` (`headerRight` at line 1164; the header band at line 1218; the nudge banner at line 1268)
- Modify: `mobile/lib/mail-relate.js`
- Modify: `mobile/lib/mail-relate.test.js`

- [ ] **Step 1: Give `relatedNudge` its chip string**

`nudge.chip` does not exist yet, and Step 2 uses it. Do this first.

Append to `mobile/lib/mail-relate.test.js`:

```js
  it('carries a chip string for the compact header', () => {
    // MAIL-READER.M1 — the banner became a chip, and a chip has no room for the
    // sentence. Same verdict, two lengths, ONE derivation: a count this
    // function would not assert in words is not asserted in a chip either.
    expect(relatedNudge({ related: [{ id: 'a' }], open_count: 2 }).chip).toBe('1 other')
    expect(relatedNudge({ related: [{ id: 'a' }, { id: 'b' }], open_count: 3 }).chip).toBe('2 others')
  })

  it('has no chip when it has no nudge', () => {
    expect(relatedNudge(null)).toBe(null)
  })
```

⚠️ Read the existing `relatedNudge` before implementing. Derive `chip` from the **same count** its `text` already uses — never a second count, and never a count the function would have refused to state in words. Its rule stands: an unknown count returns `null` and renders nothing, and a failed related read is `null`, never `[]`.

Run: `npx vitest run mobile/lib/mail-relate.test.js`
Expected: PASS.

- [ ] **Step 2: Replace the four bands with one**

Add to the screen's `mail-conversations` import:

```js
  shortMailboxLabel, headerDetailLines, spamActionLabel, audienceSummary, composerCap,
  NO_MAILBOX_LINE,
```

Add state beside the screen's other `useState` calls:

```js
  // Option A, compact at rest: Details is the operator's tap, and it stays
  // where they put it for as long as they are on this conversation.
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [nudgeSheetOpen, setNudgeSheetOpen] = useState(false)
```

Replace the header band (lines 1218–1246, the `<View className="border-b border-un1t-border bg-un1t-surface px-4 pt-2.5 pb-3">` element and its contents) with:

```jsx
          {/* ONE band (MAIL-READER.M1, option A). Subject, then one meta row,
              then Details on demand. It was four bands — subject, chips, the
              audience line and the opener — which with the nudge banner below
              spent 21% of an 844pt screen before a word of email. */}
          <View className="border-b border-un1t-border bg-un1t-surface px-4 pt-2.5 pb-2.5">
            {conversation?.subject ? (
              <Text className="text-[16px] font-extrabold text-un1t-text leading-snug" numberOfLines={2}>
                {conversation.subject}
              </Text>
            ) : (
              <Text className="text-[16px] font-extrabold text-un1t-subtle leading-snug">
                (no subject)
              </Text>
            )}
            <View className="flex-row items-center flex-wrap mt-1.5">
              {chip ? (
                <View className={`px-1.5 py-0.5 rounded mr-1.5 ${chip.cls}`}>
                  <Text className={`text-[10px] font-semibold ${chip.text}`}>{chip.label}</Text>
                </View>
              ) : null}
              {/* 🔴 The no-mailbox case is said in WORDS, never shortened to a
                  chip: mailbox_id is ON DELETE SET NULL, so a deleted address
                  orphans its correspondence rather than hiding it. */}
              <View className="px-1.5 py-0.5 rounded bg-slate-500/10 mr-1.5">
                <Text className="text-[10px] font-semibold text-slate-700" numberOfLines={1}>
                  {shortMailboxLabel(conversation?.mailbox)
                    ? `@ ${shortMailboxLabel(conversation.mailbox)}`
                    : NO_MAILBOX_LINE}
                </Text>
              </View>
              {/* The nudge, as a chip rather than a full-width banner. Its two
                  actions live in the sheet it opens. */}
              {nudge && !conversation?.merged_into_id ? (
                <Pressable
                  onPress={() => setNudgeSheetOpen(true)}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={nudge.text}
                  className="flex-row items-center px-1.5 py-0.5 rounded bg-blue-500/10 mr-1.5"
                >
                  <Ionicons name="link-outline" size={10} color="#1D4ED8" style={{ marginRight: 3 }} />
                  <Text className="text-[10px] font-semibold text-blue-700">{nudge.chip}</Text>
                </Pressable>
              ) : null}
              <View className="flex-1" />
              <Pressable
                onPress={() => setDetailsOpen(v => !v)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityState={{ expanded: detailsOpen }}
                accessibilityLabel={detailsOpen ? 'Hide conversation details' : 'Show conversation details'}
                className="flex-row items-center"
              >
                <Text className="text-[11px] text-un1t-subtle mr-1">Details</Text>
                <Ionicons name={detailsOpen ? 'chevron-up' : 'chevron-down'} size={12} color="#64748B" />
              </Pressable>
            </View>
            {detailsOpen ? (
              <View className="mt-2 pt-2 border-t border-un1t-border">
                {headerDetailLines(conversation, threadLines).map(line => (
                  <Text key={line.key} className="text-[11px] text-un1t-subtle mb-0.5">
                    {line.label ? <Text className="text-un1t-muted">{line.label}: </Text> : null}
                    {line.value}
                  </Text>
                ))}
              </View>
            ) : null}
          </View>
```

- [ ] **Step 3: Delete the nudge banner**

Remove the whole `{nudge && !conversation?.merged_into_id ? (…) : null}` banner block (lines 1268–1297). The tombstone pointer band immediately above it stays exactly as it is — a tombstone is read-only everywhere.

- [ ] **Step 4: Add the nudge sheet**

Beside the merge-picker `Modal` at the end of the screen, add:

```jsx
      {/* The nudge chip's two actions — the banner's View and Merge, now that
          the banner is a chip. 🔴 The chip only exists when relatedNudge said
          so: an unknown count renders NOTHING, never 0, and a failed related
          read is null rather than []. */}
      <Modal
        visible={nudgeSheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setNudgeSheetOpen(false)}
      >
        <View className="flex-1 justify-end bg-black/40">
          <Pressable
            className="flex-1"
            accessibilityLabel="Close related conversations"
            onPress={() => setNudgeSheetOpen(false)}
          />
          <View
            className="bg-un1t-bg rounded-t-2xl px-4 pt-4"
            style={{ paddingBottom: Math.max(insets.bottom, 16) }}
          >
            <Text className="text-[13px] text-un1t-subtle mb-3">{nudge?.text}</Text>
            {nudge?.viewId ? (
              <Pressable
                onPress={() => { setNudgeSheetOpen(false); router.push(`/email/${nudge.viewId}`) }}
                accessibilityRole="button"
                className="flex-row items-center border-t border-un1t-border py-3"
              >
                <Ionicons name="open-outline" size={16} color="#111827" style={{ marginRight: 10 }} />
                <Text className="text-[14px] text-un1t-text">Open the newest related conversation</Text>
              </Pressable>
            ) : null}
            <Pressable
              onPress={() => { setNudgeSheetOpen(false); setMergeOpen(true) }}
              accessibilityRole="button"
              className="flex-row items-center border-t border-un1t-border py-3"
            >
              <Ionicons name="git-merge-outline" size={16} color="#111827" style={{ marginRight: 10 }} />
              <Text className="text-[14px] text-un1t-text">Merge related conversations…</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
```

- [ ] **Step 5: Add the spam action to the overflow**

Add the handler beside `toggleArchive` (line 988):

```js
  async function toggleSpam() {
    if (savingAction) return
    const { label, next } = spamActionLabel(conversation)
    setSavingAction(true)
    const res = await setConversationSpam(conversationId, next, activeLocation?.id)
    setSavingAction(false)
    if (!res.success) {
      Alert.alert(`Couldn’t ${label.toLowerCase()}`, res.error || 'Unknown error')
      return
    }
    // 🔴 The flag is ORTHOGONAL to the lifecycle — the route touches only the
    // spam columns. Take the row the route returns and infer nothing else from
    // it; in particular, never derive a status change from a quarantine.
    if (res.data?.conversation) {
      setConversation(prev => (prev ? { ...prev, ...res.data.conversation } : prev))
    } else {
      refresh({ quiet: true })
    }
  }
```

Add `setConversationSpam` to the `email-api` import. Then find `openOverflow` — whose one action is currently Forward — and add a second row using `spamActionLabel(conversation).label` as the title and `.icon` as the icon, disabled under `savingAction || tombstone` exactly as the Forward row is. The screen stays put on success, the posture `toggleArchive` already takes.

- [ ] **Step 6: Lint**

Run: `npm run check:mobile-lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add "mobile/app/(staff)/email/[conversationId].jsx" mobile/lib/mail-relate.js mobile/lib/mail-relate.test.js
git commit -m "MAIL-READER.M1 — one header band, and spam reaches the phone"
```

Body: four bands become one — subject, a meta row carrying the status chip, the short account chip and the nudge as a chip, then Details on demand for the full account label, the live audience line and the opener. The full-width blue nudge banner is gone; its View and Merge live in the sheet the chip opens. `relatedNudge` gains a chip string off the SAME count its sentence uses: a count it would not assert in words is not asserted in a chip either, and an unknown count still renders nothing. Mark as spam / Not spam joins the overflow; the screen stays put on success, the posture archive already takes, and infers nothing else from the row, because the flag is orthogonal to the lifecycle. The no-mailbox case is still said in words. End with the trailer.

---

## Task 11: The composer — collapsed, bounded, and no signature box

**Files:**
- Modify: `mobile/app/(staff)/email/[conversationId].jsx` (the composer, lines ~1360–1600)
- Modify: `mobile/app/(staff)/email/compose.jsx:69,481,672`
- Modify: `mobile/app/(staff)/email/forward.jsx:61,163,448`
- Create: `tests/mail-reader-mobile-literals.test.js`

- [ ] **Step 1: Write the failing source-scan test**

Create `tests/mail-reader-mobile-literals.test.js`. It goes under `tests/` rather than beside the screens because `vitest.config.js` covers `tests/**` and nothing under `mobile/app`.

```js
// MAIL-READER.M1 — the mobile reader's load-bearing literals, pinned as source.
//
// WHY A SOURCE SCAN. vitest reaches mobile/lib/**/*.test.js and nothing else
// under mobile/: no jsdom, no runner for mobile/app or mobile/components. Every
// DECISION therefore lives in mobile/lib and is tested properly there. What is
// left is a handful of facts about the JSX itself — an import that must be gone,
// a helper that must be called rather than reimplemented inline — and this file
// holds those. It is a floor, not proof; the device is the rest.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

const THREAD = 'mobile/app/(staff)/email/[conversationId].jsx'
const COMPOSE = 'mobile/app/(staff)/email/compose.jsx'
const FORWARD = 'mobile/app/(staff)/email/forward.jsx'
const COMPOSERS = [THREAD, COMPOSE, FORWARD]

describe('the signature preview box is gone from every composer', () => {
  // MAIL-READER.1 decision 2, and the reason it costs nothing here: the box was
  // added (MOBILE-SIGHINT.1) because the phone has no signature editor to link
  // to, which is also why deleting it removes nothing an operator can act on.
  it.each(COMPOSERS)('%s does not render it', (file) => {
    const source = read(file)
    expect(source).not.toContain('resolveSignatureHint')
    expect(source).not.toContain('signature-hint')
    expect(source).not.toContain('Added automatically')
  })

  it.each(COMPOSERS)('%s no longer fetches signature contexts for a preview', (file) => {
    expect(read(file)).not.toContain('fetchSignatureContexts')
  })
})

describe('the composer cap comes from the lib', () => {
  it('the thread screen calls composerCap and hand-writes no fraction', () => {
    const source = read(THREAD)
    expect(source).toContain('composerCap(')
    // The fraction and the floor are the lib's, pinned by its own tests. A
    // second copy here is a second thing to change when Richard moves it.
    expect(source).not.toMatch(/\*\s*0\.4\b/)
  })
})

describe('the note composer still states its mode in words', () => {
  it('keeps the staff-only sentence, uncompacted', () => {
    // 🔴 The invariant this screen is built around: the composer says which
    // mode it is in three ways — the selected segment, the colour of the card,
    // and the sentence naming exactly who receives what. Only the REPLY half of
    // MAIL-READER.1 decision 3 compacts; this sentence does not.
    expect(read(THREAD)).toContain('NOT sent to')
  })
})

describe('the header and the verbs read the lib', () => {
  it.each(['headerDetailLines(', 'shortMailboxLabel(', 'spamActionLabel(', 'audienceSummary('])(
    'the thread screen calls %s',
    (call) => { expect(read(THREAD)).toContain(call) },
  )
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/mail-reader-mobile-literals.test.js`
Expected: FAIL — `resolveSignatureHint` is still imported by all three composers.

- [ ] **Step 3: Delete the signature box from the thread composer**

In `mobile/app/(staff)/email/[conversationId].jsx`:
- Remove `import { resolveSignatureHint } from '../../../lib/signature-hint'` (line 99).
- Remove `fetchSignatureContexts` from the `email-api` import list (line 97).
- Remove the `signatureContexts` state, the effect that fetches it, and `const signatureHint = …` (line 847).
- Remove the whole `{!isNote && signatureHint ? (…) : null}` block (lines 1578–1596), including its `MOBILE-SIGHINT.1` comment.

- [ ] **Step 4: Delete it from the other two composers**

`compose.jsx`: remove the import (line 69), `const signatureHint = …` (lines 481–483), the `fetchSignatureContexts` call and its state, and the `{signatureHint ? (…) : null}` block (lines 672–690).

`forward.jsx`: the same at lines 61, 163, and 448–466.

- [ ] **Step 5: Collapse and bound the thread composer**

Add state beside the other composer state:

```js
  // MAIL-READER.1's pill, on the phone. 🔴 A TYPED DRAFT IS SACRED: collapsing
  // keeps every character (MAIL-DOCK.2's lesson — the pin types a draft,
  // collapses the tree, finds the words intact). Only ✕ with a confirm may
  // discard, and this screen has no ✕.
  const [composerOpen, setComposerOpen] = useState(false)
  // The height above the keyboard, measured. KeyboardAvoidingView's own layout
  // already excludes the keyboard, so this is the number composerCap wants.
  const [availableHeight, setAvailableHeight] = useState(0)
```

In the draft-hydration effect, after the text is set:

```js
    // Desktop's rule, and it matters more here: taking focus would raise the
    // keyboard nobody asked for. The words are there; the cursor is not.
    if (hydrated.text) setComposerOpen(true)
```

On the `KeyboardAvoidingView` (line ~1150):

```jsx
      onLayout={e => setAvailableHeight(e.nativeEvent.layout.height)}
```

Then wrap the composer region. Keep the existing tombstone and empty-state guards exactly where they are — ⚠️ **do not introduce a new early return around the composer.** MAIL-DOCK.2's blocker was precisely this: React remounts a subtree across return paths unless the element holds the same fragment child slot and a stable key, and it silently discarded a dirty compose. Reuse the existing guard.

```jsx
          {composerOpen ? (
            <View
              className="border-t border-un1t-border bg-un1t-bg px-4 pt-2"
              style={{ maxHeight: composerCap(availableHeight), paddingBottom: Math.max(insets.bottom, 8) }}
            >
              {/* Everything below scrolls INSIDE the cap. It was the TextInput
                  alone that was bounded (max-h-32); the chips, the budget line
                  and the gate sentences were not, so a three-file reply could
                  push Send off the screen. */}
              <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
                {/* …the existing segmented toggle, card, files, tools and gate
                    sentences, unchanged apart from Step 6's audience line… */}
              </ScrollView>
            </View>
          ) : (
            <Pressable
              onPress={() => setComposerOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={text.trim() ? 'Continue your draft reply' : replyPlaceholder}
              className="flex-row items-center border-t border-un1t-border bg-un1t-bg px-4 py-2.5"
              style={{ paddingBottom: Math.max(insets.bottom, 10) }}
            >
              <View className="flex-1 flex-row items-center rounded-full border-[1.5px] border-un1t-border px-3.5 py-2">
                <Text
                  className={`flex-1 text-[14px] ${text.trim() ? 'text-un1t-text' : 'text-un1t-muted'}`}
                  numberOfLines={1}
                >
                  {text.trim() || replyPlaceholder}
                </Text>
                {text.trim() && draftSaved ? (
                  <Text className="text-[10px] text-un1t-muted ml-2">Draft saved</Text>
                ) : null}
              </View>
              <Pressable
                onPress={() => { setIsNote(true); setComposerOpen(true) }}
                hitSlop={8}
                accessibilityLabel="Add an internal note"
                className="ml-3"
              >
                <Ionicons name="lock-closed-outline" size={18} color="#64748B" />
              </Pressable>
            </Pressable>
          )}
```

- [ ] **Step 6: Compact the reply audience only**

Add beside the other derivations:

```js
  const [audienceOpen, setAudienceOpen] = useState(false)
  const audienceSummaryValue = audienceSummary(conversation, replyRecipients)
```

Replace the audience line inside the card (lines 1405–1421) with:

```jsx
              {/* 🔴 NOTE MODE KEEPS ITS SENTENCE, IN FULL, ALWAYS. The composer
                  states its mode three ways — the selected segment, the colour
                  of the card, and the sentence naming exactly who receives
                  what — and this is the third. Only the REPLY half compacts
                  (MAIL-READER.1 decision 3); on the phone there is no tooltip
                  to move it to, so it goes behind an ⓘ that expands in place.
                  A DISABLED reply audience does not compact either: a refusal
                  the operator has to read must not hide behind a tap. */}
              <View className="flex-row items-center mb-1">
                {isNote ? (
                  <Text className="text-[11px] text-amber-700 flex-1">
                    Staff only — written to the conversation and NOT sent to{' '}
                    {conversation?.requester_email || 'the member'}.
                  </Text>
                ) : (
                  <Pressable
                    onPress={() => setAudienceOpen(v => !v)}
                    disabled={audienceSummaryValue.disabled}
                    hitSlop={6}
                    accessibilityRole="button"
                    accessibilityLabel={audienceSummaryValue.full}
                    className="flex-1 flex-row items-center"
                  >
                    <Text className="text-[11px] text-un1t-subtle flex-1" numberOfLines={2}>
                      {audienceOpen || audienceSummaryValue.disabled
                        ? audienceSummaryValue.full
                        : audienceSummaryValue.short}
                    </Text>
                    {!audienceSummaryValue.disabled ? (
                      <Ionicons
                        name="information-circle-outline"
                        size={13}
                        color="#94A3B8"
                        style={{ marginLeft: 4 }}
                      />
                    ) : null}
                  </Pressable>
                )}
                {draftSaved && text.trim() ? (
                  <Text className="text-[11px] text-un1t-muted ml-2">Draft saved</Text>
                ) : null}
              </View>
```

If the old `audience` binding is now unread, remove it; if something else reads it, leave it — `audienceSummary` calls the same derivation, so the two cannot disagree.

- [ ] **Step 7: Run the literal scan and the linters**

Run: `npx vitest run tests/mail-reader-mobile-literals.test.js`
Expected: PASS.

Run: `npm run check:mobile-lint`
Expected: PASS. Expect real errors here from Steps 3–4 — an unused import, a setter with no reader. Fix each; silence none with a disable comment.

Run: `npm run check:mobile-imports`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add "mobile/app/(staff)/email/[conversationId].jsx" "mobile/app/(staff)/email/compose.jsx" "mobile/app/(staff)/email/forward.jsx" tests/mail-reader-mobile-literals.test.js
git commit -m "MAIL-READER.M1 — the composer collapses, bounds itself, and stops printing the signature"
```

Body: the signature preview box goes from all three composers (MAIL-READER.1 decision 2). It was added because the phone has no signature editor to link to, which is also why deleting it removes nothing anyone can act on — and it was 19% of Richard's screen. The composer is a pill until tapped and capped at `composerCap(availableHeight)` with its contents scrolling inside: only the `TextInput` was bounded before, so a three-file reply could push Send off the screen. A hydrated draft expands it WITHOUT taking focus — on a phone that would raise the keyboard nobody asked for — and collapsing keeps every character, because a typed draft is sacred. Reply mode's audience compacts to "To <first> & N others" behind an ⓘ; note mode's sentence does NOT, and a disabled audience does not either. Literals pinned as a source scan, since no runner reaches `mobile/app`. End with the trailer.

---

## Task 12: Gates, changelog, PR

**Files:**
- Modify: `docs/CHANGELOG.md`
- Create: `.git/pr-body.md` (scratch, not committed)

- [ ] **Step 1: Run the full local CI mirror**

```bash
npm test && npm run lint && npm run check:mobile-parity && npm run check:mobile-imports && npm run check:mobile-lint && npm run check:route-guards && npm run check:location-scoping && npm run check:rls-restrictive && npm run check:guardrails && npm run check:bundle-sql && npm run check:ota-paths
```

Expected: every one green. `check:ota-paths` must pass with no edits — `mobile/lib/**` and `mobile/components/**` are already in the publish allowlist, so the new files publish and no classification is missing.

- [ ] **Step 2: Run the build**

```bash
npm run build
```

Expected: PASS. This is the gate for the new imports (`@/lib/email-blocks`, `@/lib/mail-entities`) — vitest runs on mocked imports, so a missing or renamed export sails straight through it.

- [ ] **Step 3: Add ONE changelog row**

🔴 Append a **new** row. **Never edit an existing one** — `docs/CHANGELOG.md` is `merge=union`, and editing a pushed row duplicates it.

Read the highest row number in the file and use the next. The row should cover: four header bands to one; the block renderer and why there is no WebView; the composer pill and cap; the signature box removal from three composers; the phone's first spam quarantine and the missing agreement assertion; the character-reference fix at ingest and at render; and the URL wall.

- [ ] **Step 4: Write the PR body to a file**

```bash
cat > .git/pr-body.md <<'PRBODY'
Ports the desktop reader compaction (#1640, web-only) to the phone, adds HTML
email rendering without a WebView, and closes the spam gap.

Richard's screenshot measured 64% chrome. Four header bands become one; the
composer is a pill until tapped and then capped at 40% of the space above the
keyboard with its contents scrolling inside; the signature preview box is gone
from all three composers.

HTML renders with no HTML engine on the device: the server walks the ALREADY
SANITISED document into a block tree (`?body=blocks`) and the phone draws it
with Text/View. react-native-webview would have been a native module — a new
binary and App Review — so Layer 1 here is the absence of an engine rather than
a sandboxed iframe. Blocks mode omits `html_document`, which the phone was
downloading against a 1.5MB budget and discarding, so mobile payloads get
smaller as the feature lands.

Two defects from that screenshot: numeric character references were never
decoded (at ingest, so existing rows are already wrong — fixed at both ends),
and a bare URL rendered in full inside one unbroken Text.

Spam reaches the phone for the first time: the endpoint has existed since
MAIL-SPAM.1 with no wrapper, no action and no view. The assertion whose absence
hid that — the agreement test pinned shared's view ids against the server's and
never against mobile's — is added.

Ships as an OTA. No native change, no runtimeVersion bump, no migration, no new
dependency in either tree.

Spec: docs/superpowers/specs/2026-09-09-phone-mail-reader-compaction-design.md
Mockup: https://claude.ai/code/artifact/f351d5a2-1021-4605-babd-a4bf1495a2ca

## What Richard checks on the device

Nothing here can stand in for these — there is no runner for mobile components,
and jsdom cannot see layout.

- The 40% cap and the pill, with a three-file reply attached.
- The compact header on a multi-party thread: is Details one tap too many?
- Real mail through the renderer — a Docusign notification, a Xero receipt, a
  newsletter. A table with a `<th>` should stay a table; everything else
  becomes a column.
- Mark as spam, then Not spam from the Spam view, and confirm the badge did not
  move.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
PRBODY
```

- [ ] **Step 5: Commit, push, open the PR**

```bash
git add docs/CHANGELOG.md
git commit -m "MAIL-READER.M1 — changelog"
git push -u origin HEAD
gh pr create --title "MAIL-READER.M1 — the phone Mail reader shows the email, not the chrome" --body-file .git/pr-body.md
```

- [ ] **Step 6: Watch CI**

```bash
gh pr checks --watch
```

Expected: **Test & lint** and **Next build** green. Both are required; the branch must also be up to date with `main` before merging.

---

## Self-review

**Spec coverage.** Unit 1 → Tasks 2–5. Unit 2 → Tasks 6, 9. Unit 3 → Tasks 7, 8, 10, 11. Unit 4 → Tasks 1, 6, 9. The seven safety invariants: note-first rendering is untouched by every task (nothing edits `conversationMessageKind`); the states-its-mode-three-ways rule is pinned in Task 11 Steps 1 and 6; blocked images in Tasks 3, 6, 9; tombstone read-only in Task 10 Step 3 and Task 11 Step 5; `null`-not-`[]` related reads in Task 10 Step 1; the loud delivery panel is outside every edit; spam orthogonality in Task 8 Step 3 and Task 10 Step 5. Backward compatibility → Task 5 Step 3 and Task 8 Step 3. Testing → each task's own steps plus Task 12.

**Known deviation from the plan skill's default.** Tasks 9–11 have no red-green cycle for the JSX itself, because this project has no runner that can render a React Native tree. Every decision those tasks touch got a red-green cycle in Tasks 6–8, where it is testable; what remains is pinned by the source scan in Task 11 and by `check:mobile-lint`. This is stated rather than papered over — adding an RN test harness is a bigger change than the feature and was ruled out in the spec.

**Ordering dependencies.** Task 5 needs Tasks 2–4. Task 9 needs Tasks 5, 6 and 8. Task 10's Step 1 (`nudge.chip`) must precede its Step 2, which uses it. Task 11 needs Task 7's `composerCap` and `audienceSummary`. Task 7 is otherwise independent and can run alongside Tasks 2–5.

**Type consistency.** `emailBlocks` → `{ blocks, quotedBlocks, blockedImages, truncated, failed }` (Task 4) → route fields `html_blocks`, `html_quoted_blocks`, `html_blocked_images`, `html_truncated`, `html_unsafe`, `html_omitted` (Task 5) → read under those names in Tasks 8 and 9. `htmlToBlocks` → `{ blocks, truncated }`, used only inside `email-blocks.js` and its tests. `normaliseBlocks` / `imageState` / `blockedImageCount` / `linkLabel` / `splitTextLinks` defined in Task 6, called in Task 9. `spamActionLabel` / `shortMailboxLabel` / `headerDetailLines` / `audienceSummary` / `composerCap` / `NO_MAILBOX_LINE` defined in Task 7, called in Tasks 10 and 11. `decodeCharRefs` and `stripInvisibleChars` defined in Task 1, composed in that order at both call sites (Tasks 1 and 9). `nudge.chip` added in Task 10 Step 1, used in Step 2.
