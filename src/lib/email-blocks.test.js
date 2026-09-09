// MAIL-READER.M1 — the block extractor. It runs on the OUTPUT of
// sanitizeEmailHtml, never on raw input, so every test here feeds it sanitised
// markup and asserts shape only.
import { describe, it, expect } from 'vitest'
import { htmlToBlocks, CAPS } from './email-blocks'
import { sanitizeEmailHtml } from './email-html'

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

  it('promotes an anchor alone in its block to a link block, keeping its emphasis', () => {
    const { blocks } = htmlToBlocks('<p><a href="https://x.test/a"><b><i>Book now</i></b></a></p>')
    expect(blocks).toEqual([{
      type: 'link',
      href: 'https://x.test/a',
      runs: [{ text: 'Book now', bold: true, italic: true }],
    }])
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

  it('marks code/tt/kbd/samp as mono', () => {
    const { blocks } = htmlToBlocks('<p><code>x</code> <tt>y</tt> <kbd>z</kbd> <samp>w</samp></p>')
    expect(blocks[0].runs).toEqual([
      { text: 'x', mono: true },
      { text: ' ' },
      { text: 'y', mono: true },
      { text: ' ' },
      { text: 'z', mono: true },
      { text: ' ' },
      { text: 'w', mono: true },
    ])
  })

  it('answers empty input with no blocks', () => {
    expect(htmlToBlocks('').blocks).toEqual([])
    expect(htmlToBlocks(null).blocks).toEqual([])
  })
})

describe('htmlToBlocks — caps and truncation', () => {
  it('never drops a block it already walked when the message budget runs out mid-block', () => {
    // A forwarded thread is written as ONE <div> with <br> separators — br
    // does not flush, so this is a single block. Past the char budget it must
    // still render truncated, never empty: an empty body is the exact
    // failure this feature exists to fix.
    const line = 'x'.repeat(500)
    const html = '<div>' + Array(50).fill(line).join('<br>') + '</div>'
    const { blocks, truncated } = htmlToBlocks(html)
    expect(truncated).toBe(true)
    expect(blocks.length).toBeGreaterThan(0)
  })

  it('bounds a merged run at charsPerRun instead of letting it grow unboundedly', () => {
    // 300 same-styled spans of 50 chars is 15,000 chars total — email is full
    // of pointless spans, and merging must not turn them into one giant
    // <Text> node the phone has to lay out in one go.
    const spans = Array.from({ length: 300 }, () => '<span>' + 'x'.repeat(50) + '</span>').join('')
    const { blocks } = htmlToBlocks(`<p>${spans}</p>`)
    for (const run of blocks[0].runs) {
      expect(run.text.length).toBeLessThanOrEqual(CAPS.charsPerRun)
    }
  })

  it('renders identically whether a run of text arrives as one node or many same-styled spans', () => {
    // The same 1,000 characters, once as a single text node and once spread
    // across three <span>s, must produce the same total content and the same
    // truncated verdict — they render identically in a browser, so they must
    // render identically on the phone.
    const whole = 'y'.repeat(1000)
    const third = 'y'.repeat(334)
    const oneNode = htmlToBlocks(`<p>${whole}</p>`)
    const threeSpans = htmlToBlocks(`<p><span>${third}</span><span>${third}</span><span>${third.slice(0, 332)}</span></p>`)
    const totalChars = blocks => blocks[0].runs.reduce((n, r) => n + r.text.length, 0)
    expect(totalChars(threeSpans.blocks)).toBe(totalChars(oneNode.blocks))
    expect(threeSpans.truncated).toBe(oneNode.truncated)
  })

  it('charges the message budget for <pre> text and flags truncated when it slices', () => {
    // <pre> pushes straight past addText's accounting, so 300 x 2,000-char
    // pre blocks used to produce 120,000 characters of output with
    // truncated: false — six times the message budget, silently.
    const pre = '<pre>' + 'c'.repeat(2000) + '</pre>'
    const html = pre.repeat(300)
    const { blocks, truncated } = htmlToBlocks(html)
    const totalPreChars = blocks
      .filter(b => b.type === 'pre')
      .reduce((n, b) => n + b.text.length, 0)
    expect(totalPreChars).toBeLessThanOrEqual(CAPS.charsPerMessage)
    expect(truncated).toBe(true)
  })

  it('caps one <pre> block at its own, larger, named cap and flags truncated', () => {
    const { blocks, truncated } = htmlToBlocks(`<pre>${'c'.repeat(CAPS.charsPerPre + 500)}</pre>`)
    expect(blocks[0].text.length).toBe(CAPS.charsPerPre)
    expect(truncated).toBe(true)
  })

  it('stops at the block cap and reports truncated', () => {
    const html = '<p>x</p>'.repeat(CAPS.blocks + 20)
    const { blocks, truncated } = htmlToBlocks(html)
    // Not pinned to exactly CAPS.blocks: a block already being walked when
    // the cap trips is allowed to finish (finding 1), so the true ceiling is
    // CAPS.blocks + 1, not CAPS.blocks.
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.length).toBeLessThanOrEqual(CAPS.blocks + 1)
    expect(truncated).toBe(true)
  })

  it('stops at the per-run-count cap and reports truncated', () => {
    // Alternating bold/italic so adjacent runs never merge — the only way to
    // reach runsPerBlock runs in one block.
    const spans = Array.from({ length: CAPS.runsPerBlock + 20 }, (_, i) =>
      (i % 2 === 0 ? '<b>a</b>' : '<i>a</i>')).join('')
    const { blocks, truncated } = htmlToBlocks(`<p>${spans}</p>`)
    expect(blocks[0].runs.length).toBe(CAPS.runsPerBlock)
    expect(truncated).toBe(true)
  })

  it('stops at the per-message character cap and reports truncated', () => {
    const html = `<p>${'a'.repeat(300)}</p>`.repeat(200)
    const { blocks, truncated } = htmlToBlocks(html)
    expect(truncated).toBe(true)
    expect(JSON.stringify(blocks).length).toBeLessThan(CAPS.charsPerMessage * 2)
  })

  it('reports untruncated for ordinary mail', () => {
    expect(htmlToBlocks('<p>Hello there</p>').truncated).toBe(false)
  })

  it('a giant single text node still produces a block, never an empty one', () => {
    // Pinned directly, per the review: on its own this catches finding 1
    // (flush() discarding the block it just walked once the budget trips).
    expect(htmlToBlocks('<p>' + 'x'.repeat(30000) + '</p>').blocks.length).toBeGreaterThan(0)
  })
})

describe('htmlToBlocks — zero-width characters', () => {
  const ZWNJ = '‌'
  const NBSP = ' '

  it('collapses whitespace across a zero-width character once it is stripped', () => {
    const { blocks } = htmlToBlocks(`<p>a ${ZWNJ}${ZWNJ}${ZWNJ} b</p>`)
    expect(blocks).toEqual([{ type: 'para', runs: [{ text: 'a b' }] }])
  })

  it('drops a Mailchimp-style zero-width preheader instead of rendering it as a blank block', () => {
    // &zwnj;&nbsp; x 250 is a real preheader-hiding pattern. \s and
    // String.trim() both leave U+200C alone, so unstripped it fills the run
    // cap with garbage: the phone shows a blank first paragraph AND a false
    // "this was cut short" notice.
    const preheader = (ZWNJ + NBSP).repeat(250)
    const { blocks, truncated } = htmlToBlocks(`<div>${preheader}</div><p>Real content</p>`)
    expect(blocks).toEqual([{ type: 'para', runs: [{ text: 'Real content' }] }])
    expect(truncated).toBe(false)
  })
})

describe('htmlToBlocks — trimming at a style boundary', () => {
  it('trims a run that becomes the new leading edge once an all-whitespace run ahead of it is dropped', () => {
    const { blocks } = htmlToBlocks('<p><i> </i><b> bold</b></p>')
    expect(blocks[0].runs).toEqual([{ text: 'bold', bold: true }])
  })

  it('trims a run that becomes the new trailing edge once an all-whitespace run after it is dropped', () => {
    const { blocks } = htmlToBlocks('<p>text <b> </b></p>')
    expect(blocks[0].runs).toEqual([{ text: 'text' }])
  })

  it('collapses whitespace that directly follows an injected line break', () => {
    const { blocks } = htmlToBlocks('<p>one<br>   two</p>')
    expect(blocks).toEqual([{ type: 'para', runs: [{ text: 'one\ntwo' }] }])
  })
})

describe('htmlToBlocks — nesting depth', () => {
  it('bounds recursion depth so a pathological nesting cannot blow the call stack', () => {
    // sanitizeEmailHtml is iterative and survives this; this walker recurses
    // per nesting level, and empty divs push no blocks and add no
    // characters, so none of the other caps trip on the way down.
    const depth = 5000
    const html = '<div>'.repeat(depth) + 'x' + '</div>'.repeat(depth)
    let result
    expect(() => { result = htmlToBlocks(html) }).not.toThrow()
    expect(result.truncated).toBe(true)
  })
})

describe('htmlToBlocks — the actual contract: real sanitizeEmailHtml output', () => {
  // Every test above feeds htmlToBlocks hand-written markup that merely
  // LOOKS sanitised — that gap is exactly what hid finding 6, whose zero-width
  // preheader only showed up once it went through the real sanitiser. This is
  // the one test that pins the relationship the file header claims as its
  // whole contract: sanitizeEmailHtml() first, htmlToBlocks() second, on
  // input written by a genuinely hostile sender.
  it('walks hostile mail through the real sanitiser without a blank body or a false truncated', () => {
    const ZWNJ = '‌'
    const NBSP = ' '
    const preheader = (ZWNJ + NBSP).repeat(250)
    const raw = `<div>${preheader}</div>`
      + '<p onclick="steal()">Hi <script>alert(1)</script>there</p>'
      + '<img src="https://evil.test/x.png" onerror="steal()" alt="pixel">'
      + '<style>body{background:url(javascript:alert(1))}</style>'
    const { html } = sanitizeEmailHtml(raw)
    const { blocks, truncated } = htmlToBlocks(html)
    expect(blocks).toEqual([{ type: 'para', runs: [{ text: 'Hi there' }] }])
    expect(truncated).toBe(false)
  })
})
