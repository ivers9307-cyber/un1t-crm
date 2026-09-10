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
      { type: 'image', blocked: 'https://x.test/b.png', alt: 'Hero', href: 'https://x.test/go' },
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

// normaliseBlocks is the phone's guard against a server release that has
// moved ahead of an OTA bundle still on someone's handset — the task this
// file exists for is explicit that a crash here is worse than a wrong
// render, so these go beyond the given fixtures to the shapes the SPEC above
// does not itself exercise: a tree deep enough to worry about the call
// stack, and a block whose nested field is present but the wrong JS type
// (not just missing) at every level normaliseBlocks recurses through.
describe('normaliseBlocks — cannot throw on a hostile or malformed tree', () => {
  it('survives 500 levels of nested quote without throwing', () => {
    // 500, not 5: src/lib/email-blocks.js's own CAPS.maxDepth comment calls
    // "a few hundred" generous headroom for real mail, so this is the
    // shape a legitimate (if extreme) forwarded thread can actually take,
    // not a synthetic worst case.
    let tree = [{ type: 'para', runs: [{ text: 'bottom' }] }]
    for (let i = 0; i < 500; i += 1) {
      tree = [{ type: 'quote', blocks: tree }]
    }
    expect(() => normaliseBlocks(tree)).not.toThrow()
  })

  it('drops a quote whose blocks field is not an array, rather than crashing', () => {
    expect(normaliseBlocks([{ type: 'quote', blocks: { not: 'an array' } }])).toEqual([])
    expect(normaliseBlocks([{ type: 'quote', blocks: 'blocks' }])).toEqual([])
    expect(normaliseBlocks([{ type: 'quote' }])).toEqual([])
  })

  it('never throws on a block list holding every wrong JS shape at once', () => {
    const hostile = [
      null, undefined, 7, 'x', true, [], { type: 7 }, { type: null },
      { type: 'heading', runs: 'not-an-array' },
      { type: 'list', items: 'not-an-array' },
      { type: 'list', items: [null, 7, 'x', [{ text: 'ok' }]] },
      { type: 'table', rows: 'not-an-array', head: 'not-an-array' },
      { type: 'table', rows: [null, 7, [], [[{ text: 'c' }]]] },
      { type: 'image', blocked: 123 },
      { type: 'pre', text: 123 },
      { type: 'link', href: 'https://x.test/a', runs: null },
    ]
    expect(() => normaliseBlocks(hostile)).not.toThrow()
  })
})

describe('blockedImageCount — cannot throw on a hostile or malformed tree', () => {
  it('survives a quote whose blocks field is not an array', () => {
    expect(() => blockedImageCount([{ type: 'quote', blocks: 'nope' }])).not.toThrow()
    expect(blockedImageCount([{ type: 'quote', blocks: 'nope' }])).toBe(0)
  })

  it('never throws on a block list holding every wrong JS shape at once', () => {
    expect(() => blockedImageCount([null, 7, 'x', { type: 'image' }, { blocked: true }]))
      .not.toThrow()
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

  it('strips both a sentence period AND an unopened closing paren, in that order', () => {
    // A single unconditional regex strip of ".,;:!?)]}'\"" from the end would
    // take the period, see ')' newly exposed at the end, and stop there
    // (one pass, one strip) — leaving "https://x.test/a)" with the sentence's
    // own bracket still attached. Catching it needs the two kinds of trailing
    // character told apart and the check re-run after each removal.
    expect(splitTextLinks('(see https://x.test/a).')).toEqual([
      { text: '(see ' },
      { text: 'https://x.test/a', href: 'https://x.test/a' },
      { text: ').' },
    ])
  })

  it('keeps a bracket the URL itself opened, unlike one the sentence opened', () => {
    // The Wikipedia-disambiguator shape: a closing paren the URL's OWN path
    // opened must survive, where the same trailing ')' in "(see ...)" must
    // not — the difference is whether it is balanced WITHIN the matched URL.
    const url = 'https://en.wikipedia.org/wiki/Dog_(animal)'
    expect(splitTextLinks(`see ${url} today`)).toEqual([
      { text: 'see ' },
      { text: url, href: url },
      { text: ' today' },
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
