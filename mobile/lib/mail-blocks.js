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

// Mirrors src/lib/email-blocks.js's CAPS.maxDepth (200) — the server's own
// "a few hundred is generous headroom for real mail" ceiling. Duplicated,
// not imported: this module has no imports at all (verified by
// `npm run check:mobile-imports`), because pulling in src/lib/email-blocks.js
// would drag htmlparser2 and Node APIs into a React Native bundle. So a
// change to the server's cap does not automatically reach this one. This
// module's whole reason to exist is that the fleet runs BEHIND the server
// for a while after each release, which is exactly the case where relying
// on the server having already bounded depth would fail: an un-updated
// bundle can still be handed a tree built by a newer server.
const MAX_DEPTH = 200

/**
 * Whether a run is worth drawing: real text, not just a truthy `.text`.
 *
 * The one predicate every run/list-item/table-cell check below goes through,
 * so a shape like `{ text: 42 }` cannot count as content in one call site
 * and get dropped in another for being the identical value.
 */
function hasText(run) {
  return !!run && typeof run.text === 'string' && run.text !== ''
}

/**
 * A run array, or a table cell, or a list item, reduced to only the runs
 * that pass `hasText` — never the raw array passed through with whatever
 * else was in it. Run objects themselves are kept as-is (style keys like
 * `bold`/`href` are this module's payload, not something it reconstructs;
 * this module has no imports at all, so it cannot import the server's
 * STYLE_KEYS to know the closed set of style fields to preserve — passing
 * the object through is what lets an unrecognised style key survive too).
 *
 * @param {unknown} runs
 * @returns {object[]}
 */
function validRuns(runs) {
  return Array.isArray(runs) ? runs.filter(hasText) : []
}

/**
 * Drop what cannot be drawn, and clamp what can.
 *
 * An UNKNOWN type is dropped rather than thrown on, deliberately: the server
 * deploys before an OTA reaches phones, and a bundle that crashed on a block
 * type it had not met yet would turn an additive server change into a dead
 * screen in somebody's hand. Every branch below only ever reads a block's own
 * fields with `?.`/`Array.isArray` guards, validates runs/items/cells through
 * `validRuns` rather than passing them through raw, and recurses through this
 * same function bounded by MAX_DEPTH — so a malformed OR a hostilely deep
 * tree is dropped a level (or a leaf) at a time rather than thrown on
 * partway through.
 *
 * That guarantee holds under the one precondition every real caller meets:
 * `blocks` arrived through `JSON.parse`. `KNOWN.has(block.type)` and every
 * other field read here is a plain property access, which is safe only
 * because `JSON.parse` cannot produce a getter/accessor property that could
 * throw on read — a tree assembled by hand with a throwing accessor is not a
 * shape this function claims to defend against.
 *
 * This module has no `truncated` signal of its own, unlike the server's own
 * block tree. A subtree dropped because it crossed MAX_DEPTH is dropped
 * SILENTLY — nothing in the output says a level was cut. That is accepted
 * here (a crash is worse than a quietly short render) but it is a real
 * trade, not a free one, and it must stay written down rather than
 * rediscovered by whoever debugs a mail that renders shorter than it should.
 *
 * @param {unknown} blocks
 * @param {number} [depth] internal recursion counter — callers should not pass this
 * @returns {object[]}
 */
export function normaliseBlocks(blocks, depth = 0) {
  if (!Array.isArray(blocks)) return []
  if (depth > MAX_DEPTH) return []
  const out = []
  for (const block of blocks) {
    if (!block || !KNOWN.has(block.type)) continue
    switch (block.type) {
      case 'heading': {
        const runs = validRuns(block.runs)
        if (!runs.length) break
        const level = Math.min(6, Math.max(1, Number(block.level) || 1))
        out.push({ type: 'heading', level, runs })
        break
      }
      case 'para': {
        const runs = validRuns(block.runs)
        if (runs.length) out.push({ type: 'para', runs })
        break
      }
      case 'link': {
        const runs = validRuns(block.runs)
        if (block.href && runs.length) out.push({ type: 'link', href: block.href, runs })
        break
      }
      case 'list': {
        const items = (Array.isArray(block.items) ? block.items : [])
          .map((item) => validRuns(item))
          .filter((runs) => runs.length)
        if (items.length) out.push({ type: 'list', ordered: !!block.ordered, items })
        break
      }
      case 'quote': {
        const inner = normaliseBlocks(block.blocks, depth + 1)
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
          // Each cell is validated in place, not dropped out of position —
          // dropping a malformed cell would shift every cell after it out
          // from under its header.
          .map((row) => row.map((cell) => validRuns(cell)))
        const head = Array.isArray(block.head) && block.head.length
          ? block.head.map((cell) => validRuns(cell))
          : null
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
 * Bounded by the same MAX_DEPTH as normaliseBlocks, and for the same
 * reason — this file's own guard against a tree built by a server release
 * the fleet has not caught up to yet, not a bound the server is trusted to
 * have already applied. Past the cap the remaining subtree is silently
 * excluded from the count, same trade as normaliseBlocks: undercounting a
 * pathological tree beats crashing on it.
 *
 * @param {object[]} blocks
 * @param {number} [depth] internal recursion counter — callers should not pass this
 * @returns {number}
 */
export function blockedImageCount(blocks, depth = 0) {
  if (!Array.isArray(blocks)) return 0
  if (depth > MAX_DEPTH) return 0
  let n = 0
  for (const block of blocks) {
    if (block?.type === 'image' && block.blocked) n += 1
    else if (block?.type === 'quote') n += blockedImageCount(block.blocks, depth + 1)
  }
  return n
}

// Long enough that a real sentence of link text is never touched, short enough
// that a tracking URL cannot eat three lines of a 390pt screen.
const URL_LABEL_MAX = 48
// Room left for the trailing "/…" once the host itself is capped, so the
// RETURNED label is bounded regardless of where the length came from — a
// long path (the shape every fixture above already covers) or a long host
// (which used to come back whole: a 159-char host-only URL measured a
// 153-char "shortened" label, because URL_LABEL_MAX gated only whether to
// shorten, never what was handed back).
const HOST_LABEL_MAX = URL_LABEL_MAX - 2

/**
 * What a link should SAY.
 *
 * An anchor with real link text keeps it. A label that is its own href — which
 * is every bare URL in a plain-text email, and the reason Richard's screenshot
 * had 180 characters of `utm_` through the middle of it — is shortened to its
 * host. The full address stays on the block for a long-press.
 *
 * The host is captured AFTER a leading `userinfo@`, if any, so
 * `https://trusted-bank.com@evil.test/x` reads as `evil.test/…` — the host a
 * browser or the phone would actually connect to — rather than putting the
 * attacker-chosen `trusted-bank.com` text first, ahead of the truncation a
 * 390pt `<Text>` applies. That is the one thing this function defends
 * against. It does NOT detect a look-alike domain past the `@` (a
 * dot-heavy subdomain built to look like a trusted host, an IDN homograph,
 * a redirect chain) — a shortened label is a courtesy for reading a link
 * before tapping it, not a verdict on where it goes; the full href is still
 * what opens, unchanged, on a long-press.
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
  const match = /^https?:\/\/(?:[^/?#@]*@)?([^/?#]+)/i.exec(url)
  if (!match) return url
  const host = match[1].replace(/^www\./i, '')
  const shortHost = host.length > HOST_LABEL_MAX ? host.slice(0, HOST_LABEL_MAX) : host
  return `${shortHost}/…`
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
 * The open/close count for every bracket character is taken ONCE, in a
 * single pass over `raw`, before the trim loop starts. Trimming then walks
 * backwards updating those running counts by one per character removed,
 * rather than re-deriving them from a fresh `.split()` over the remaining
 * string on every iteration — the earlier version was O(n) work per
 * character trimmed, O(n²) overall, and a sender need only append a run of
 * unmatched `)` after a bare URL to turn that into seconds of blocked JS on
 * a real phone. This version is O(n) total: one counting pass, then O(1)
 * per character trimmed.
 *
 * @param {string} raw  a BARE_URL regex match, always starting `http`
 * @returns {string}
 */
function trimTrailingPunctuation(raw) {
  const counts = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 }
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch in counts) counts[ch] += 1
  }
  let end = raw.length
  while (end > 0) {
    const last = raw[end - 1]
    const opener = CLOSERS[last]
    if (opener) {
      // closes/opens for `last`/`opener` as they stand IN WHAT IS LEFT of
      // the string — `counts` is kept current by decrementing below every
      // time a bracket is actually removed, so this reads the same live
      // tally the old `.split()` recount would have produced, just without
      // re-scanning to get it.
      if (counts[last] <= counts[opener]) break
      counts[last] -= 1
      end -= 1
      continue
    }
    if (!SENTENCE_PUNCT.has(last)) break
    end -= 1
  }
  // BARE_URL always matches at least `http://` or `https://`, none of whose
  // characters are in either removable set, so the loop above cannot ever
  // empty a real match — this is a defensive floor, not a reachable path.
  return raw.slice(0, end) || raw
}

/**
 * Split plain text into plain and link segments.
 *
 * Today `text_body` renders as one unbroken <Text> with no linkification at
 * all, which is the other half of the URL wall: the address is neither tappable
 * nor shortened.
 *
 * This function only closes the "not tappable" half. A link segment's
 * `text` here is always the full, raw URL — shortening is `linkLabel`'s
 * job, not this one's, and the two are meant to compose: a renderer must
 * call `linkLabel(seg.href, seg.text)` on every segment that carries an
 * `href` before drawing it. Skip that call and the "not shortened" half of
 * the same problem ships right back out.
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
