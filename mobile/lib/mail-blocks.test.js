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
  it('survives 500 levels of nested quote without throwing, dropped past this file\'s own depth cap', () => {
    // 500, not 5: src/lib/email-blocks.js's own CAPS.maxDepth comment calls
    // "a few hundred" generous headroom for real mail, so this is the
    // shape a legitimate (if extreme) forwarded thread can actually take,
    // not a synthetic worst case.
    //
    // This file bounds its OWN recursion at MAX_DEPTH (200) rather than
    // trusting the server to have already applied its matching cap — the
    // whole point of this module is guarding a fleet that can be running
    // behind the server. So a 500-deep chain is no longer preserved intact:
    // this only proves it does not throw, with the content past the cap
    // silently dropped (see normaliseBlocks's own doc on that trade).
    let tree = [{ type: 'para', runs: [{ text: 'bottom' }] }]
    for (let i = 0; i < 500; i += 1) {
      tree = [{ type: 'quote', blocks: tree }]
    }
    expect(() => normaliseBlocks(tree)).not.toThrow()
    expect(normaliseBlocks(tree)).toEqual([])
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

describe('normaliseBlocks — validates runs, list items and table cells, not just the block', () => {
  it('filters a runs array instead of passing malformed entries through raw', () => {
    // Validation used to stop at "does SOMETHING in this block look real",
    // then pass the raw array through unfiltered — a null run here crashes
    // a renderer that destructures it.
    expect(normaliseBlocks([
      { type: 'para', runs: [{ text: 'hi' }, { text: 42 }, null, { bogus: true }] },
    ])).toEqual([{ type: 'para', runs: [{ text: 'hi' }] }])
  })

  it('filters a malformed cell out of a table row instead of keeping it intact', () => {
    expect(normaliseBlocks([
      { type: 'table', head: null, rows: [[{ not: 'a cell array' }, [{ text: 'ok' }]]] },
    ])).toEqual([{ type: 'table', head: null, rows: [[[], [{ text: 'ok' }]]] }])
  })

  it('treats the identical run shape the same in a list item as in a paragraph', () => {
    // The list-item filter tested `r?.text` (truthy — 42 counts) while
    // hasRuns tested `typeof r.text === 'string'` (42 does not), so the
    // identical { text: 42 } shape counted as content in a list item and was
    // dropped in a paragraph. One hasText predicate now backs both.
    expect(normaliseBlocks([{ type: 'list', ordered: false, items: [[{ text: 42 }]] }]))
      .toEqual([])
    expect(normaliseBlocks([{ type: 'para', runs: [{ text: 42 }] }])).toEqual([])
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

  it('survives 500 levels of nested quote without throwing, dropped past this file\'s own depth cap', () => {
    // Mirrors normaliseBlocks's identical fixture and identical reasoning
    // (see that test's own comment): 500 is the realistic-if-extreme depth
    // of a real forwarded thread, and this function shares normaliseBlocks's
    // exact recursion shape and exact MAX_DEPTH — a coverage gap here was
    // never a difference in behaviour, only an untested path.
    let tree = [{ type: 'image', blocked: 'https://x.test/a.png' }]
    for (let i = 0; i < 500; i += 1) {
      tree = [{ type: 'quote', blocks: tree }]
    }
    expect(() => blockedImageCount(tree)).not.toThrow()
    // The one real image sits past MAX_DEPTH (200) once wrapped 500 levels
    // deep, so it is silently excluded from the count — same trade
    // normaliseBlocks makes when it drops the equivalent subtree whole.
    expect(blockedImageCount(tree)).toBe(0)
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

  it('caps a long HOST, not just a long path', () => {
    // URL_LABEL_MAX gated whether to shorten but not what came back: every
    // existing fixture above builds its long URL as a short host + a long
    // PATH, which is exactly why a long host slipped through unbounded. A
    // 159-char host-only URL measured a 166-char "shortened" label.
    const url = `https://${'a'.repeat(159)}.test/`
    const result = linkLabel(url, url)
    expect(result.length).toBeLessThanOrEqual(48)
    expect(result.endsWith('/…')).toBe(true)
  })

  it('does not show a userinfo@ prefix as if it were the real host', () => {
    // The host regex did not exclude '@', so everything before the real
    // host — attacker-chosen text designed to read as a trusted domain —
    // was captured as part of the "host" and shown first, with the actual
    // host trailing where a 390pt <Text> truncates it away.
    const url = 'https://secure-login.mybank.com.verify-account@evil-phisher.test/x'
    expect(linkLabel(url, url)).toBe('evil-phisher.test/…')
  })

  it('finds the TRUE host past multiple @, not the first @-terminated segment', () => {
    // The regex-based fix stripped only the FIRST `@`-terminated run; WHATWG
    // (and every real browser) splits userinfo from host on the LAST `@` in
    // the authority. True host, per Node's URL as ground truth, is
    // 'evil-phisher.test' — the regex version never even surfaced it: its
    // capture was truncated by URL_LABEL_MAX before reaching the real host.
    const url = 'https://ignored@secure-login.mybank.com.account.verify.identity.session'
      + '@evil-phisher.test/path'
    expect(new URL(url).hostname).toBe('evil-phisher.test') // ground truth
    expect(linkLabel(url, url)).toBe('evil-phisher.test/…')
  })

  it('treats a backslash as an authority terminator, the way a browser does', () => {
    // Browsers normalise '\' to '/' inside an http(s) authority, so
    // everything after it is PATH, not host — the true host ends at
    // 'evil-phisher.test'. The regex's character class never excluded '\',
    // so it read straight through to the next real '@' and fabricated a
    // host out of attacker-chosen path text that was never part of the
    // authority at all.
    const url = 'https://evil-phisher.test\\@trusted-bank.com/verify/account/session'
    expect(new URL(url).hostname).toBe('evil-phisher.test') // ground truth
    expect(linkLabel(url, url)).toBe('evil-phisher.test/…')
  })

  it('does not treat an encoded %40 in userinfo as an authority terminator', () => {
    // '%40' is three literal characters, never decoded before the authority
    // is split — only an actual '@' byte terminates userinfo.
    const url = 'https://user%40company.test@x.test/verify/account/session/detail'
    expect(new URL(url).hostname).toBe('x.test') // ground truth
    expect(linkLabel(url, url)).toBe('x.test/…')
  })

  it('does not treat an @ in the path as an authority terminator', () => {
    const url = 'https://x.test/account@verify/session/detail/more/path/here'
    expect(new URL(url).hostname).toBe('x.test') // ground truth
    expect(linkLabel(url, url)).toBe('x.test/…')
  })

  it('keeps a bracketed IPv6 host intact, without its port', () => {
    const url = 'https://[2001:db8::1]:8443/verify/account/session/detail/more'
    expect(new URL(url).hostname).toBe('[2001:db8::1]') // ground truth
    expect(linkLabel(url, url)).toBe('[2001:db8::1]/…')
  })

  it('handles an empty userinfo the same as no userinfo at all', () => {
    const url = 'https://@x.test/verify/account/session/detail/more/path'
    expect(new URL(url).hostname).toBe('x.test') // ground truth
    expect(linkLabel(url, url)).toBe('x.test/…')
  })

  it('drops the port, matching what a browser would actually connect to', () => {
    const url = 'https://x.test:8443/verify/account/session/detail/more/path'
    expect(new URL(url).hostname).toBe('x.test') // ground truth
    expect(linkLabel(url, url)).toBe('x.test/…')
  })

  it('returns the full URL, never a fabricated label, when the host cannot be parsed', () => {
    // A host that is itself the string '@' (percent-encoded, so still just
    // three literal characters at this point) is not a valid WHATWG host —
    // new URL() throws. The regex version did not: its character class
    // matched '%40' as if it were a real, if odd-looking, host and printed
    // it with confidence. An unshortened, honest URL beats a short,
    // fabricated one.
    const url = 'https://user@%40/verify/account/session/more/path/here'
    expect(() => new URL(url)).toThrow()
    expect(linkLabel(url, url)).toBe(url)
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

  it('trims a hostile run of trailing brackets without quadratic blowup', () => {
    // trimTrailingPunctuation used to rescan the whole remaining string with
    // .split(char) to recount brackets on EVERY iteration — O(n) work per
    // trailing character, O(n^2) overall. Measured under Node: a bare URL
    // followed by 5,000 stray ')' cost 118ms; 20,000 cost 1.9s; 50,000 cost
    // 12.2s — long enough to hang the single JS thread on real mail. This
    // budget is loose on purpose: it guards against quadratic blow-up, not a
    // performance target, and must not flake on slow CI.
    const url = 'https://x.test/a' + ')'.repeat(50000)
    const start = Date.now()
    const [seg] = splitTextLinks(url)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(3000)
    expect(seg).toEqual({ text: 'https://x.test/a', href: 'https://x.test/a' })
  })

  it('composes with linkLabel: this only makes a URL tappable, never shortens it', () => {
    // This function's own docstring says it closes the "neither tappable nor
    // shortened" problem, but only the tappable half — `text` on a link
    // segment is always the full, raw URL. Shortening is linkLabel's job,
    // and the renderer is specified to call linkLabel(seg.href, seg.text) on
    // every segment; this pins that composition rather than assuming it.
    const url = 'https://support.docusign.com/s/articles/How-do-I-sign-a-DocuSign-document'
      + '-Basic-Signing?language=en_US&utm_campaign=GBL_XX_DBU_UPS_2211'
    const [seg] = splitTextLinks(url)
    expect(seg).toEqual({ text: url, href: url })
    expect(linkLabel(seg.href, seg.text)).toBe('support.docusign.com/…')
  })
})
