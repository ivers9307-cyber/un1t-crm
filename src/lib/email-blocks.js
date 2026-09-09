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

// Collapse every run of whitespace in a text node — including a literal
// newline left by wrapped HTML source — to a single space. A raw '\n' inside
// a text node is a formatting accident of how the email's markup was
// line-wrapped, not an authored break: the ONLY explicit line break this
// module honours is <br>, and the walker injects that '\n' straight into the
// sink (see the `name === 'br'` branch below), never through this function.
function collapse(text) {
  return String(text).replace(/\s+/g, ' ')
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
