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
// SERVER ONLY. This module does not itself import email-html.js — it only
// imports htmlparser2 and runs on email-html.js's OUTPUT (see above) — but
// the whole point is that no HTML parsing happens on the client, so it gets
// the same guard as email-html.js: that module's own test
// (src/lib/email-html.test.js, "no client component anywhere in src/ imports
// this module") scans every 'use client' file in src/, and this path is in
// that scan's regex too.
//
// WHAT IT DELIBERATELY DOES NOT PRESERVE: colour, font, alignment, background
// images, and the geometry of a 600px layout table. A phone column in source
// order is the trade — better than pinch-zooming a desk-width table, and
// honestly worse than a pixel copy. If a real email comes out wrong the escape
// hatch is a "View original" in the in-app browser, not more CSS in here.

import { parseDocument, DomUtils } from 'htmlparser2'
import { stripInvisibleChars } from './mail-entities'

/**
 * Ceilings. No single one of these bounds a monster newsletter on its own —
 * what does is the combination, and they do not all fail the same way:
 *
 *   - `blocks` caps the block count. walk() checks it at the top of every
 *     node, so it stops the whole walk — but a block already being
 *     accumulated when the cap trips is still allowed to finish and push, so
 *     the true ceiling is `blocks + 1`, not `blocks`. That is deliberate: the
 *     alternative is discarding a block the walker already did the work for,
 *     which is how a long forwarded thread used to render as an empty body.
 *   - `runsPerBlock` x `charsPerRun` is the real ceiling on ONE block's text.
 *     `charsPerRun` bounds a single run — one <Text> node — not the content
 *     addText() is handed; once a run is full it opens a NEW run rather than
 *     dropping the rest, up to `runsPerBlock` runs. Hitting either does NOT
 *     stop the walk: it drops what no longer fits in THIS block and moves on
 *     to the next one, reporting `truncated`.
 *   - `charsPerPre` is a `pre` block's own, larger cap — a pasted code block
 *     or stack trace wants more room than one inline run — charged and
 *     reported the same way `charsPerRun` is, separately from it.
 *   - `charsPerMessage` is the actual budget on total accumulated text (every
 *     run plus every `pre`, summed) across the whole message. Hitting it DOES
 *     stop the walk, the same way `blocks` does — this is what keeps one
 *     newsletter off becoming a multi-megabyte JSON payload on somebody's
 *     cellular connection.
 *   - `maxDepth` bounds recursion, not text. walk() recurses once per nesting
 *     level, and an empty `<div>` pushes no block and adds no character, so
 *     nothing above this would ever trip on a tree that is merely deep. Past
 *     the limit, walk() stops descending into THAT branch and reports
 *     `truncated`, but keeps walking siblings at the shallower level — it is
 *     the one cap that does not, by itself, imply lost content.
 *
 * `truncated` therefore means "some of this email did not make it to the
 * screen", not "the walk stopped here": most of the caps above let the walk
 * carry on into the next block once they trip, which is what keeps a
 * pathological block from taking the rest of a normal email down with it.
 */
export const CAPS = Object.freeze({
  blocks: 400,
  runsPerBlock: 64,
  charsPerRun: 400,
  charsPerPre: 4_000,
  charsPerMessage: 20_000,
  maxDepth: 200,
})

const HEADING_LEVEL = Object.freeze({ h1: 1, h2: 2, h3: 3, h4: 4, h5: 5, h6: 6 })
// 'th' looks inert here because 'th' is also in BLOCK_LEVEL below, so nothing
// in THIS file's walk() ever asks styleFor() to bold one. It is not dead:
// Task 4's table handling calls styleFor(cell.name, style) directly for each
// cell, and that is the path that reads it. Leave it.
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
  return STYLE_KEYS.every(k => (a[k] ?? undefined) === (b[k] ?? undefined))
}

function styleFor(name, inherited) {
  const next = { ...inherited }
  if (BOLD.has(name)) next.bold = true
  if (ITALIC.has(name)) next.italic = true
  if (STRIKE.has(name)) next.strike = true
  if (MONO.has(name)) next.mono = true
  return next
}

// Collapse every run of whitespace in a text node — including a literal
// newline left by wrapped HTML source — to a single space. A raw '\n' inside
// a text node is a formatting accident of how the email's markup was
// line-wrapped, not an authored break: the ONLY explicit line break this
// module honours is <br>, and the walker injects that '\n' straight into the
// sink (see the `name === 'br'` branch below), never through this function.
//
// stripInvisibleChars runs FIRST, before the whitespace fold. `\s` and
// String.trim() both leave U+200B/200C/200D/034F alone, and marketing email
// routinely pads a hidden preheader with exactly those characters
// (`&zwnj;&nbsp;` repeated hundreds of times, to break inbox-preview
// scraping). Left in, that padding survives as content: it fills the run cap
// with invisible characters, so the real text after it gets cut and the
// email reports truncated when nothing worth keeping was lost. Stripping
// first means a zero-width character sitting between two spaces collapses
// away with them instead of holding the fold apart.
function collapse(text) {
  return stripInvisibleChars(text).replace(/\s+/g, ' ')
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
    const room = CAPS.charsPerMessage - this.chars
    let slice = text
    if (slice.length > room) {
      slice = slice.slice(0, room)
      this.truncated = true
    }
    if (!slice) return

    // charsPerRun bounds one run (one <Text> node on the phone), not the
    // total text this call is allowed to place. A run that is already at cap
    // gets a NEW run alongside it, up to runsPerBlock, rather than the
    // incoming text being silently dropped — merging must not be how content
    // disappears. runsPerBlock x charsPerRun is what actually ceilings a
    // block.
    while (slice.length) {
      const prev = this.runs[this.runs.length - 1]
      const mergeRoom = prev && sameStyle(prev, style) ? CAPS.charsPerRun - prev.text.length : 0
      if (mergeRoom > 0) {
        const take = Math.min(mergeRoom, slice.length)
        prev.text += slice.slice(0, take)
        this.chars += take
        slice = slice.slice(take)
        continue
      }
      if (this.runs.length >= CAPS.runsPerBlock) { this.truncated = true; return }
      const take = Math.min(CAPS.charsPerRun, slice.length)
      const run = { text: slice.slice(0, take) }
      for (const k of STYLE_KEYS) if (style[k]) run[k] = style[k]
      this.runs.push(run)
      this.chars += take
      slice = slice.slice(take)
    }
  }

  /**
   * Take the open runs, trimmed at the edges; [] when there is nothing.
   *
   * Filters BEFORE it trims. An all-whitespace run — an <i> or <b> that
   * contains only a style-separating space — is dropped first; only then are
   * the (new) first and last SURVIVING runs trimmed. Trimming fixed array
   * positions first got this backwards: `<p><i> </i><b> bold</b></p>` trimmed
   * runs[0] (the italic space, correctly, to '') and runs[last] (the bold
   * run, which had no trailing whitespace to trim), then filtered the empty
   * run away — leaving the bold run's own leading space untouched, so the
   * block read ' bold' with a stray space its neighbour was supposed to have
   * absorbed.
   */
  takeRuns() {
    const runs = this.runs
    this.runs = []
    if (runs.length === 0) return []

    let start = 0
    let end = runs.length - 1
    while (start <= end && runs[start].text.trim() === '') start++
    while (end >= start && runs[end].text.trim() === '') end--
    if (start > end) return []

    const kept = runs.slice(start, end + 1)
    // A line the walker broke with <br> is an authored break; whitespace the
    // source HTML happened to indent the next line with is not. Collapse it
    // away wherever a '\n' left it, not just at the block's own edges.
    for (const run of kept) run.text = run.text.replace(/\n +/g, '\n')
    kept[0].text = kept[0].text.replace(/^[ \n]+/, '')
    kept[kept.length - 1].text = kept[kept.length - 1].text.replace(/[ \n]+$/, '')
    return kept
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
    // Gated on the DEFAULT type, deliberately: flush() is called with a
    // non-'para' type only for a heading today, and Task 3's list items and
    // quotes go through push(), not flush(), once they land. That is what
    // stops a list item or a quote from ever being promoted to a link block
    // by accident.
    if (type === 'para' && runs.length === 1 && runs[0].href) {
      // Carry every style flag across except href — that one is redundant
      // once it is on the block itself, and bold/italic/strike/mono inside a
      // promoted <a> (an email CTA is routinely <a><b><i>Book now</i></b></a>)
      // must survive the promotion rather than being dropped with it.
      const { href, ...run } = runs[0]
      this.blocks.push({ type: 'link', href, runs: [run] })
      return
    }
    this.blocks.push(extra ? { type, ...extra, runs } : { type, runs })
  }

  /**
   * Push a finished block that owns no open runs and carries no text of its
   * own to budget (image, rule, table). A block whose size scales with its
   * content, like `pre`, must charge `this.chars` too — see pushPre.
   */
  push(block) {
    if (this.full()) { this.truncated = true; return }
    this.blocks.push(block)
  }

  /**
   * Push a `pre` block. Unlike push(), this charges `this.chars` — a <pre>
   * with no cap of its own used to sail straight past the message budget,
   * six times over on 300 pasted stack traces, always reporting untruncated.
   * It gets its own, larger cap (a code block wants more room than one
   * inline run) as well as the shared message ceiling.
   */
  pushPre(text) {
    if (this.full()) { this.truncated = true; return }
    let slice = text
    if (slice.length > CAPS.charsPerPre) {
      slice = slice.slice(0, CAPS.charsPerPre)
      this.truncated = true
    }
    const room = CAPS.charsPerMessage - this.chars
    if (slice.length > room) {
      slice = slice.slice(0, room)
      this.truncated = true
    }
    this.chars += slice.length
    this.blocks.push({ type: 'pre', text: slice })
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

// depth counts nesting levels of walk() itself, not markup elements — the
// same thing for anything BLOCK_LEVEL or inline. Real email nests tens of
// levels (a wrapper table, a few rows, a couple of styling spans); a few
// hundred is generous headroom that still stops a pathological tree from
// recursing until the stack blows. sanitizeEmailHtml is iterative and
// survives that input; this walker is the weak link on markup written by an
// unauthenticated stranger, since an empty <div> pushes no block and adds no
// character, so none of the other caps trip on the way down.
function walk(nodes, sink, style, depth = 0) {
  if (depth > CAPS.maxDepth) { sink.truncated = true; return }
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
      if (text.trim()) sink.pushPre(text)
      continue
    }

    const heading = HEADING_LEVEL[name]
    if (heading) {
      sink.flush()
      walk(node.children || [], sink, style, depth + 1)
      sink.flush('heading', { level: heading })
      continue
    }

    if (BLOCK_LEVEL.has(name)) {
      sink.flush()
      walk(node.children || [], sink, style, depth + 1)
      sink.flush()
      continue
    }

    // Inline: an anchor contributes an href to its subtree's style, anything
    // else contributes its emphasis (or nothing at all, for a <span>).
    const next = name === 'a'
      ? { ...style, ...(node.attribs?.href ? { href: node.attribs.href } : {}) }
      : styleFor(name, style)
    walk(node.children || [], sink, next, depth + 1)
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
