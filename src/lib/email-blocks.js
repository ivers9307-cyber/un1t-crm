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
// SERVER ONLY. This module does not itself import email-html.js — it parses
// with htmlparser2 and runs on email-html.js's OUTPUT (see above) — but
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
 * what does is the combination, and they do not all fail the same way. Every
 * counter below is MESSAGE-WIDE: htmlToBlocks() creates one mutable budget
 * object and every Sink — top-level and every nested one a <blockquote> or
 * <ul>/<ol> creates — reads and increments the same counters. Content that a
 * nested Sink flattens back into its parent (or discards, e.g. every <li>
 * past the first line of a block-built list item) was still charged against
 * this shared budget the moment it was walked, whether or not it survives
 * into the final tree.
 *
 *   - `blocks` caps the block count. walk() checks it at the top of every
 *     node, so it stops the whole walk — but a block already being
 *     accumulated when the cap trips is still allowed to finish and push,
 *     rather than being discarded — which is how a long forwarded thread used
 *     to render as an EMPTY BODY, the defect this cap's own handling caused.
 *     A <blockquote>/<ul>/<ol> wrapper gets the same treatment for the same
 *     reason: it closes over content that was already walked (and already
 *     charged against this counter) by the time its own children finish, so
 *     discarding the wrapper at that point would re-create the identical
 *     empty-body failure one level up — a reply chain that quotes each
 *     earlier message in its own nested <blockquote> is ordinary mail, not a
 *     pathological shape. That means a chain of such wrappers still unwinding
 *     when the cap trips can each still push one more block, so the safe
 *     outer bound is `blocks + maxDepth`, not `blocks + 1` — ordinary mail
 *     never nests a <blockquote>/<ul> deep enough for the difference to show.
 *   - `runsPerBlock` x `charsPerRun` is the real ceiling on ONE block's text.
 *     `charsPerRun` bounds a single run — one <Text> node — not the content
 *     addText() is handed; once a run is full it opens a NEW run rather than
 *     dropping the rest, up to `runsPerBlock` runs. Hitting either does NOT
 *     stop the walk: it drops what no longer fits in THIS block and moves on
 *     to the next one, reporting `truncated`.
 *   - `listItems` caps how many `<li>` one `<ul>`/`<ol>` keeps. It is its own
 *     cap, not `runsPerBlock` borrowed for a second job — `runsPerBlock`
 *     means "runs in one block" everywhere else it appears, and tuning it for
 *     text-wrapping used to silently change how many bullets a list shows.
 *     Hitting it does not stop the walk: the list built up so far is pushed
 *     and the walk reports `truncated`.
 *   - `charsPerPre` is a `pre` block's own, larger cap — a pasted code block
 *     or stack trace wants more room than one inline run — charged and
 *     reported the same way `charsPerRun` is, separately from it.
 *   - `charsPerMessage` is the actual budget on total accumulated text (every
 *     run plus every `pre`, summed) across the whole message, no matter how
 *     deep the `<blockquote>`/`<ul>` nesting that produced it. Hitting it DOES
 *     stop the walk, the same way `blocks` does — this is what keeps one
 *     newsletter off becoming a multi-megabyte JSON payload on somebody's
 *     cellular connection. Unlike `blocks`, nothing pushes text past this cap
 *     once it is reached: addText()/pushPre() slice to the exact room left,
 *     so the character total is a hard ceiling, not `+ maxDepth`.
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
  listItems: 64,
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
 *
 * `budget` is a `{ chars, blocks }` object SHARED across every Sink for one
 * call to htmlToBlocks() — the top-level one and every nested one a
 * <blockquote> or <ul>/<ol> creates for its own children. Each Sink still
 * owns its own `blocks` array and its own run-merging state (`runs`) — that
 * is genuinely local, since it is what lets a nested Sink's content be
 * flattened or discarded independently of whatever the caller decides to
 * keep — but it no longer owns the COUNTERS that cap how much of it there
 * can be. A Sink with its own isolated counters is exactly how 8 nested
 * <blockquote>s each holding one 15,000-char paragraph used to emit 120,000
 * characters with `truncated: false`: none of the 8 individual Sinks ever
 * saw more than 15,000 characters of its own.
 */
class Sink {
  constructor(budget) {
    this.budget = budget
    this.blocks = []
    this.runs = []
    this.truncated = false
  }

  full() {
    return this.budget.blocks >= CAPS.blocks || this.budget.chars >= CAPS.charsPerMessage
  }

  addText(text, style) {
    if (!text) return
    if (this.full()) { this.truncated = true; return }
    const room = CAPS.charsPerMessage - this.budget.chars
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
        this.budget.chars += take
        slice = slice.slice(take)
        continue
      }
      if (this.runs.length >= CAPS.runsPerBlock) { this.truncated = true; return }
      const take = Math.min(CAPS.charsPerRun, slice.length)
      const run = { text: slice.slice(0, take) }
      for (const k of STYLE_KEYS) if (style[k]) run[k] = style[k]
      this.runs.push(run)
      this.budget.chars += take
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
   *
   * Deliberately has NO full() check — see pushAlways() below, which exists
   * for the same reason and carries the fuller explanation. takeRuns() has
   * already emptied this Sink's buffer by the time we would check, so
   * checking after the fact is what used to throw the block just walked away
   * instead of emitting it.
   */
  flush(type = 'para', extra = null) {
    const runs = this.takeRuns()
    if (runs.length === 0) return
    this.budget.blocks += 1
    // Gated on the DEFAULT type, deliberately: flush() is called with a
    // non-'para' type only for a heading today, and list items and quotes
    // go through push()/pushAlways(), not flush(), once they land. That is
    // what stops a list item or a quote from ever being promoted to a link
    // block by accident.
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
   * own to budget (image, rule). A block whose size scales with its content,
   * like `pre`, must charge `budget.chars` too — see pushPre. Gated on
   * full(): unlike flush()/pushAlways(), nothing has been walked into a
   * nested Sink and charged against the shared budget before this call, so
   * there is nothing "already done" to lose by refusing it — the walk's own
   * per-node full() check at the top of the loop would have skipped this
   * node entirely on the next iteration anyway.
   */
  push(block) {
    if (this.full()) { this.truncated = true; return }
    this.budget.blocks += 1
    this.blocks.push(block)
  }

  /**
   * Push a block that CLOSES OVER content already walked into a nested Sink
   * — a <blockquote>'s `quote` wrapper or a <ul>/<ol>'s `list` wrapper. No
   * full() check, on purpose, same reasoning as flush(): every run and block
   * inside `block` was walked (and charged against the shared budget) before
   * this call, while the shared budget still had room for this element's own
   * top-of-loop check to pass. Gating this push on full() would mean an
   * ordinary long reply chain — one big <blockquote> whose own content
   * happens to exhaust the message budget — renders as a completely EMPTY
   * body once the wrapper gets discarded at the last step, the identical
   * failure class flush()'s missing full() check exists to prevent, one
   * level up. The cost is a slightly looser bound: a chain of nested
   * <blockquote>/<ul> wrappers still unwinding when the cap trips can each
   * still push one more (empty-of-new-content) wrapper object, so `blocks`
   * can overshoot by up to `maxDepth` in the pathological case rather than
   * by 1 — see the CAPS doc block.
   */
  pushAlways(block) {
    this.budget.blocks += 1
    this.blocks.push(block)
  }

  /**
   * Push a `pre` block. Unlike push(), this charges `budget.chars` — a <pre>
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
    const room = CAPS.charsPerMessage - this.budget.chars
    if (slice.length > room) {
      slice = slice.slice(0, room)
      this.truncated = true
    }
    this.budget.chars += slice.length
    this.budget.blocks += 1
    this.blocks.push({ type: 'pre', text: slice })
  }
}

/** The runs of the first block that has any — for an <li> built of blocks. */
function firstRuns(blocks) {
  for (const block of blocks) {
    // A `link` block is special-cased the same way `quote` is just below: a
    // <p>-wrapped or <div>-wrapped <a href> inside an <li> gets promoted to a
    // link block by that wrapper's own flush(), which hoists `href` onto the
    // BLOCK and drops it from the run (see flush()'s own comment on why).
    // Reattaching it here is what keeps `<li><p><a href>Click</a></p></li>`
    // — an ordinary marketing-email bulleted CTA — from losing its
    // destination the moment the anchor picks up a wrapper.
    if (block.type === 'link') {
      return block.runs.map(run => ({ ...run, href: block.href }))
    }
    if (Array.isArray(block.runs) && block.runs.length) return block.runs
    if (block.type === 'quote') {
      const inner = firstRuns(block.blocks)
      if (inner.length) return inner
    }
  }
  return []
}

// Tag handlers. Every one takes the same (node, sink, style, depth) signature
// as walk() itself, whether or not a given handler needs all four — that
// uniformity is what lets HANDLERS below be a plain name→function lookup
// with one call shape, rather than each entry needing its own bespoke
// invocation. Splitting these out of walk() is a MECHANICAL extraction: each
// body is unchanged from the branch it came from, comments included: only
// the `if (name === ...) { ...; continue }` wrapper is gone, replaced by the
// lookup that walk() does once, below.

function handleBreak(_node, sink, style, _depth) {
  sink.addText('\n', style)
}

function handlePre(node, sink, _style, _depth) {
  sink.flush()
  const text = DomUtils.textContent(node).replace(/^\n/, '')
  if (text.trim()) sink.pushPre(text)
}

function handleHeading(node, sink, style, depth) {
  sink.flush()
  walk(node.children || [], sink, style, depth + 1)
  sink.flush('heading', { level: HEADING_LEVEL[node.name] })
}

function handleRule(_node, sink, _style, _depth) {
  sink.flush()
  sink.push({ type: 'rule' })
}

function handleImage(node, sink, style, _depth) {
  sink.flush()
  // 🔴 The ONLY URL an image block may carry is the one the sanitiser
  // parked. `src` cannot reach here — it is not on email-html.js's img
  // allowlist — so an image without `data-original-src` has no URL at all
  // and is dropped rather than emitted as a box that can never fill.
  const parked = node.attribs?.['data-original-src']
  if (parked) {
    const alt = node.attribs?.alt === SANITISER_ALT ? '' : (node.attribs?.alt || '')
    const block = { type: 'image', blocked: parked, alt }
    // style.href is inherited from an enclosing <a href> (see the inline
    // default branch below) — the direct sibling of link.href, so an
    // image block reads the same way a link block does. Without this, a
    // hero image that IS the call to action — images are blocked by
    // default on this surface — loses its destination entirely: no link
    // block gets produced either, since the anchor's only content was
    // the image and contributed no runs of its own.
    if (style.href) block.href = style.href
    sink.push(block)
  }
}

function handleList(node, sink, style, depth) {
  sink.flush()
  const items = []
  for (const child of node.children || []) {
    if (child.type !== 'tag' || child.name !== 'li') continue
    // Shares sink.budget, not a budget of its own — see the Sink class
    // doc and the CAPS block. An <li>'s content must count against the
    // same message-wide ceiling as everything else, even the lines that
    // firstRuns() below ultimately throws away.
    const inner = new Sink(sink.budget)
    // depth + 1, not the default 0: an <li> starts a fresh Sink but NOT a
    // fresh recursion budget — maxDepth bounds the walk()-calls-walk()
    // JS call stack, which keeps growing through a list nested inside a
    // list regardless of which Sink each level writes into. Passing the
    // default here let a 5,000-deep <ul><li> chain throw
    // RangeError: Maximum call stack size exceeded instead of tripping
    // the cap and reporting truncated, same as any other nesting shape.
    walk(child.children || [], inner, style, depth + 1)
    // Try the open runs first — a plain-text or styled-run <li> leaves
    // its content right there in inner.runs, and taking it via takeRuns()
    // keeps it a plain run (an anchor-only <li> stays a styled run with
    // its href, rather than being promoted to a link block by the flush()
    // below and having firstRuns() hand back a run that lost its href).
    const runs = inner.takeRuns()
    if (inner.truncated) sink.truncated = true
    // An <li> holding block elements (a nested table, a div) contributes
    // its text through those blocks' runs; take the first line so the item
    // is never empty when there was something in it. Only reached when
    // takeRuns() found nothing, so this can never steal a plain-text
    // item's runs out from under it. firstRuns() special-cases a `link`
    // block (a <p>- or <div>-wrapped <a href>) so THAT wrapping doesn't
    // cost the item its href the way a bare block would.
    let flat = runs
    if (flat.length === 0) {
      inner.flush()
      flat = firstRuns(inner.blocks)
    }
    if (flat.length) items.push(flat)
    if (items.length >= CAPS.listItems) { sink.truncated = true; break }
  }
  // pushAlways(), not push(): every item above was already walked (and
  // charged against the shared budget) before we get here — see
  // pushAlways()'s own doc for why discarding the list at this last step
  // would be the empty-body failure one level up.
  if (items.length) sink.pushAlways({ type: 'list', ordered: node.name === 'ol', items })
}

function handleBlockquote(node, sink, style, depth) {
  sink.flush()
  // Shares sink.budget — see the Sink class doc. This is the fix for the
  // finding that gives this doc block its teeth: 8 nested <blockquote>s
  // each holding one 15,000-char paragraph used to emit 120,000
  // characters with `truncated: false`, because each level's Sink here
  // owned its own, isolated `chars` counter.
  const inner = new Sink(sink.budget)
  // depth + 1 for the same reason as the list handler above: a
  // <blockquote> nested inside a <blockquote> inside a <blockquote>...
  // still grows the real JS call stack even though each level flattens
  // into a fresh Sink, so the recursion budget must carry over rather
  // than resetting at every quote boundary.
  walk(node.children || [], inner, style, depth + 1)
  inner.flush()
  if (inner.truncated) sink.truncated = true
  // One level of nesting: a deeper quote's blocks join this one's, in
  // order, rather than indenting again on a 390pt screen.
  const flattened = []
  for (const block of inner.blocks) {
    if (block.type === 'quote') flattened.push(...block.blocks)
    else flattened.push(block)
  }
  // pushAlways(), not push() — see its doc. inner's content is already
  // walked and already charged; refusing the wrapper here once the
  // shared budget is exhausted is what used to turn "one long quoted
  // reply" into a blank body, same failure class as flush()'s.
  if (flattened.length) sink.pushAlways({ type: 'quote', blocks: flattened })
}

// The plain BLOCK_LEVEL shape — <p>, <div>, a table cell, and everything
// else in the BLOCK_LEVEL set with no bespoke handler above: close whatever
// run was open, recurse into the children, close whatever THAT opened. Two
// flush() calls, not one, is what makes `<p>before<hr>after</p>` split
// cleanly into para/rule/para instead of losing "before" or "after" — the
// first flush() closes anything accumulated before this element, the walk
// into children may itself push blocks (the <hr> does), and the second
// flush() closes whatever text followed.
function handleBlockLevel(node, sink, style, depth) {
  sink.flush()
  walk(node.children || [], sink, style, depth + 1)
  sink.flush()
}

// One handler per tag name. Seeded from BLOCK_LEVEL so every plain block tag
// (p, div, table cells, and so on) gets the generic handler without hand
// -listing them again here, then the specific handlers overwrite their own
// entries — pre/hr/img/ul/ol/blockquote/h1-h6 are all themselves members of
// BLOCK_LEVEL, so without the overwrite they would get the generic handler
// too. `br` is added separately: it is deliberately NOT in BLOCK_LEVEL
// (see that Set's own comment) since it breaks the line without ending the
// block. Any tag not in this map — a <span>, an unknown element, or a
// genuinely inline one like <b>/<i>/<a> — falls through to walk()'s own
// inline-default branch below, exactly as before.
const HANDLERS = {}
for (const name of BLOCK_LEVEL) HANDLERS[name] = handleBlockLevel
for (const name of Object.keys(HEADING_LEVEL)) HANDLERS[name] = handleHeading
HANDLERS.pre = handlePre
HANDLERS.hr = handleRule
HANDLERS.img = handleImage
HANDLERS.ul = handleList
HANDLERS.ol = handleList
HANDLERS.blockquote = handleBlockquote
HANDLERS.br = handleBreak

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
    // 🔴 THIS LINE IS WHAT KEEPS CSS OFF THE PHONE, and it is not obvious.
    // email-html.js deliberately KEEPS <style> (stripping it breaks most real
    // marketing email inside the web iframe), so a <style> block is a normal
    // shape of already-sanitised input arriving here. htmlparser2 types those
    // nodes `style`/`script` rather than `tag`, so this one check skips their
    // text content — without it, a stylesheet would render as a paragraph of
    // garbage CSS in the reader. Nothing else in this file guards it.
    if (node.type !== 'tag') continue

    const name = node.name
    const handler = HANDLERS[name]
    if (handler) {
      handler(node, sink, style, depth)
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
  // One mutable budget for the whole message. Every Sink created for this
  // call — this one and every nested one a <blockquote> or <ul>/<ol> makes
  // for its own children — shares it, so nothing walked anywhere in the tree
  // can hide from the message-wide caps. See the Sink class doc and the
  // CAPS block above.
  const budget = { chars: 0, blocks: 0 }
  const sink = new Sink(budget)
  walk(dom.children || [], sink, {})
  sink.flush()
  return { blocks: sink.blocks, truncated: sink.truncated }
}
