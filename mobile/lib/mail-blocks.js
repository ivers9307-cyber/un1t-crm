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
    && block.runs.some((r) => r && typeof r.text === 'string' && r.text !== '')
}

/**
 * Drop what cannot be drawn, and clamp what can.
 *
 * An UNKNOWN type is dropped rather than thrown on, deliberately: the server
 * deploys before an OTA reaches phones, and a bundle that crashed on a block
 * type it had not met yet would turn an additive server change into a dead
 * screen in somebody's hand. Every branch below only ever reads a block's own
 * fields with `?.`/`Array.isArray` guards and recurses through this same
 * function — there is no path that indexes into a shape it has not checked
 * first, so a malformed or deeply nested tree is dropped a level at a time
 * rather than thrown on partway through.
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
          .filter((item) => Array.isArray(item) && item.some((r) => r?.text))
        if (items.length) out.push({ type: 'list', ordered: !!block.ordered, items })
        break
      }
      case 'quote': {
        const inner = normaliseBlocks(block.blocks)
        if (inner.length) out.push({ type: 'quote', blocks: inner })
        break
      }
      case 'image': {
        // No `blocked`, no image: `blocked` is the only URL the server parks.
        if (!block.blocked) break
        // `href` is present when the image was wrapped in an anchor — a hero
        // image that IS the call to action, which is most of marketing email.
        // Dropping it here would leave a blocked-by-default placeholder with
        // no way to reach what it linked to.
        const image = { type: 'image', blocked: block.blocked, alt: block.alt || '' }
        if (block.href) image.href = block.href
        out.push(image)
        break
      }
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
          .filter((row) => Array.isArray(row) && row.length)
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
 * `html_blocked_images`. That field is counted by sanitizeEmailHtml() over
 * the WHOLE raw message, before htmlToBlocks() ever applies its own
 * message-wide char/block caps — a long message that trips those caps before
 * reaching a later `<img>` reports the same `html_blocked_images` it would
 * have with that image included, while the tree this file counts genuinely
 * has one fewer placeholder to show for it. Two counters for one fact is how
 * a label ends up disagreeing with the screen it sits above.
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
// Sentence punctuation a writer puts AFTER a url, which is never part of one —
// unlike a bracket (below), there is no legitimate URL that ends in one of
// these.
const SENTENCE_PUNCT = new Set(['.', ',', ';', ':', '!', '?', "'", '"'])
// A trailing closer and the opener it must be paired with, so a URL that
// legitimately ENDS on a bracket it opened itself — a Wikipedia disambiguator,
// .../wiki/Dog_(animal) — can be told apart from a bracket the SENTENCE
// opened, as in "(see https://x.test/a)". Paired by COUNT, not by scanning
// for a specific match, because a real tracking URL can legitimately carry
// more than one of either character.
const CLOSERS = { ')': '(', ']': '[', '}': '{' }

/**
 * Trim punctuation a writer put after a URL match, one trailing character at
 * a time, stopping the moment a character is not safely removable.
 *
 * Sentence punctuation is always removable. A closing bracket is removable
 * only while it outnumbers its opener IN WHAT IS LEFT OF THE STRING as the
 * trim proceeds — checked fresh on every iteration, which is what lets
 * "https://x.test/a)." correctly lose the sentence's trailing period AND
 * THEN its unopened closing paren, in that order, rather than only the
 * character actually at the end when the function was first called.
 *
 * @param {string} raw  a BARE_URL regex match, always starting `http`
 * @returns {string}
 */
function trimTrailingPunctuation(raw) {
  let url = raw
  while (url.length) {
    const last = url[url.length - 1]
    const opener = CLOSERS[last]
    if (opener) {
      const closes = url.split(last).length - 1
      const opens = url.split(opener).length - 1
      if (closes <= opens) break
      url = url.slice(0, -1)
      continue
    }
    if (!SENTENCE_PUNCT.has(last)) break
    url = url.slice(0, -1)
  }
  // BARE_URL always matches at least `http://` or `https://`, none of whose
  // characters are in either removable set, so the loop above cannot ever
  // empty a real match — this is a defensive floor, not a reachable path.
  return url || raw
}

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
  // matchAll over a cloned, freshly-lastIndex'd copy of the /g regex — no
  // shared mutable state to reset between calls, unlike a manual exec() loop
  // against the module-level BARE_URL.
  for (const match of source.matchAll(BARE_URL)) {
    const url = trimTrailingPunctuation(match[0])
    const start = match.index
    if (start > cursor) out.push({ text: source.slice(cursor, start) })
    out.push({ text: url, href: url })
    cursor = start + url.length
  }
  if (cursor < source.length) out.push({ text: source.slice(cursor) })
  return out.length ? out : [{ text: source }]
}
