// CONTRACTS-PDF.1 — parser tests.
//
// parseContractBlocks is the only part of the PDF pipeline that can
// silently LOSE contract text, so it carries the weight of the testing
// here. The renderer itself is exercised by exactly one smoke test
// (does it produce a real, non-empty PDF Buffer) — we deliberately do
// NOT snapshot the binary: @react-pdf embeds a creation timestamp and
// object ids shift with any layout tweak, so a byte snapshot would be
// a permanently-red test that says nothing about correctness.

import { describe, it, expect } from 'vitest'
import { parseContractBlocks, parseInlineRuns, renderContractPdf } from './contract-pdf.js'

const plain = (text) => [{ text, bold: false }]

describe('parseInlineRuns', () => {
  it('returns a single non-bold run for plain text', () => {
    expect(parseInlineRuns('hello world')).toEqual(plain('hello world'))
  })

  it('splits a bold span out of the middle', () => {
    expect(parseInlineRuns('pay is **€40,000** per year')).toEqual([
      { text: 'pay is ', bold: false },
      { text: '€40,000', bold: true },
      { text: ' per year', bold: false },
    ])
  })

  it('handles a leading and a trailing bold span', () => {
    expect(parseInlineRuns('**Start date:** 1 Sept')).toEqual([
      { text: 'Start date:', bold: true },
      { text: ' 1 Sept', bold: false },
    ])
    expect(parseInlineRuns('signed by **Jane Doe**')).toEqual([
      { text: 'signed by ', bold: false },
      { text: 'Jane Doe', bold: true },
    ])
  })

  it('handles two bold spans in one line', () => {
    expect(parseInlineRuns('**A** and **B**')).toEqual([
      { text: 'A', bold: true },
      { text: ' and ', bold: false },
      { text: 'B', bold: true },
    ])
  })

  it('leaves an unterminated ** as literal text (never swallow content)', () => {
    expect(parseInlineRuns('half **bold only')).toEqual(plain('half **bold only'))
  })

  it('always returns at least one run, even for empty input', () => {
    expect(parseInlineRuns('')).toEqual([{ text: '', bold: false }])
    expect(parseInlineRuns(null)).toEqual([{ text: '', bold: false }])
    expect(parseInlineRuns(undefined)).toEqual([{ text: '', bold: false }])
  })
})

describe('parseContractBlocks — empty input', () => {
  it('returns [] for empty, null, undefined and non-string input', () => {
    expect(parseContractBlocks('')).toEqual([])
    expect(parseContractBlocks(null)).toEqual([])
    expect(parseContractBlocks(undefined)).toEqual([])
    expect(parseContractBlocks(42)).toEqual([])
  })

  it('returns [] for whitespace-only input', () => {
    expect(parseContractBlocks('\n\n   \n\t\n')).toEqual([])
  })
})

describe('parseContractBlocks — headings', () => {
  it('maps #, ## and ### to levels 1, 2 and 3', () => {
    expect(parseContractBlocks('# One\n\n## Two\n\n### Three')).toEqual([
      { type: 'heading', level: 1, text: 'One' },
      { type: 'heading', level: 2, text: 'Two' },
      { type: 'heading', level: 3, text: 'Three' },
    ])
  })

  it('clamps #### and deeper to level 3 rather than dropping to literal text', () => {
    const blocks = parseContractBlocks('#### Four\n\n###### Six')
    expect(blocks).toEqual([
      { type: 'heading', level: 3, text: 'Four' },
      { type: 'heading', level: 3, text: 'Six' },
    ])
  })

  it('does not need a blank line between consecutive headings', () => {
    expect(parseContractBlocks('# One\n## Two')).toEqual([
      { type: 'heading', level: 1, text: 'One' },
      { type: 'heading', level: 2, text: 'Two' },
    ])
  })

  it('trims trailing whitespace from heading text', () => {
    expect(parseContractBlocks('##   Spaced   ')).toEqual([
      { type: 'heading', level: 2, text: 'Spaced' },
    ])
  })

  it('treats a # with no following space as literal paragraph text', () => {
    // `#tag` is not a markdown heading; keep the characters.
    expect(parseContractBlocks('#tag not a heading')).toEqual([
      { type: 'paragraph', runs: plain('#tag not a heading') },
    ])
  })

  it('flushes an open paragraph before a heading', () => {
    expect(parseContractBlocks('intro line\n# Heading')).toEqual([
      { type: 'paragraph', runs: plain('intro line') },
      { type: 'heading', level: 1, text: 'Heading' },
    ])
  })
})

describe('parseContractBlocks — lists', () => {
  it('groups consecutive dash lines into ONE list block', () => {
    expect(parseContractBlocks('- one\n- two\n- three')).toEqual([
      { type: 'list', items: [plain('one'), plain('two'), plain('three')] },
    ])
  })

  it('groups consecutive asterisk lines the same way', () => {
    expect(parseContractBlocks('* alpha\n* beta')).toEqual([
      { type: 'list', items: [plain('alpha'), plain('beta')] },
    ])
  })

  it('starts a NEW list block after a blank line separates two runs', () => {
    const blocks = parseContractBlocks('- a\n- b\n\n- c')
    expect(blocks).toEqual([
      { type: 'list', items: [plain('a'), plain('b')] },
      { type: 'list', items: [plain('c')] },
    ])
  })

  it('parses bold inside list items', () => {
    expect(parseContractBlocks('- **Notice:** four weeks')).toEqual([
      {
        type: 'list',
        items: [[
          { text: 'Notice:', bold: true },
          { text: ' four weeks', bold: false },
        ]],
      },
    ])
  })

  it('tolerates indented bullets', () => {
    expect(parseContractBlocks('  - indented')).toEqual([
      { type: 'list', items: [plain('indented')] },
    ])
  })

  it('closes the list when a paragraph follows without a blank line', () => {
    expect(parseContractBlocks('- item\nback to prose')).toEqual([
      { type: 'list', items: [plain('item')] },
      { type: 'paragraph', runs: plain('back to prose') },
    ])
  })

  it('closes an open paragraph when a list starts without a blank line', () => {
    expect(parseContractBlocks('prose\n- item')).toEqual([
      { type: 'paragraph', runs: plain('prose') },
      { type: 'list', items: [plain('item')] },
    ])
  })
})

describe('parseContractBlocks — horizontal rules', () => {
  it('emits an hr for ---', () => {
    expect(parseContractBlocks('---')).toEqual([{ type: 'hr' }])
  })

  it('accepts longer dash runs and the *** / ___ forms', () => {
    expect(parseContractBlocks('-----\n\n***\n\n___')).toEqual([
      { type: 'hr' }, { type: 'hr' }, { type: 'hr' },
    ])
  })

  it('does NOT treat a two-dash line as a rule', () => {
    expect(parseContractBlocks('--')).toEqual([
      { type: 'paragraph', runs: plain('--') },
    ])
  })

  it('separates the paragraphs either side of it', () => {
    expect(parseContractBlocks('before\n---\nafter')).toEqual([
      { type: 'paragraph', runs: plain('before') },
      { type: 'hr' },
      { type: 'paragraph', runs: plain('after') },
    ])
  })
})

describe('parseContractBlocks — paragraphs', () => {
  it('joins soft-wrapped lines into one paragraph', () => {
    expect(parseContractBlocks('line one\nline two\nline three')).toEqual([
      { type: 'paragraph', runs: plain('line one line two line three') },
    ])
  })

  it('splits paragraphs on a blank line', () => {
    expect(parseContractBlocks('para one\n\npara two')).toEqual([
      { type: 'paragraph', runs: plain('para one') },
      { type: 'paragraph', runs: plain('para two') },
    ])
  })

  it('collapses multiple blank lines without emitting empty paragraphs', () => {
    expect(parseContractBlocks('a\n\n\n\nb')).toEqual([
      { type: 'paragraph', runs: plain('a') },
      { type: 'paragraph', runs: plain('b') },
    ])
  })

  it('normalises CRLF line endings', () => {
    expect(parseContractBlocks('# Title\r\n\r\nbody')).toEqual([
      { type: 'heading', level: 1, text: 'Title' },
      { type: 'paragraph', runs: plain('body') },
    ])
  })

  it('gives each ordered-list line its own paragraph so they do not run together', () => {
    expect(parseContractBlocks('1. First duty\n2. Second duty')).toEqual([
      { type: 'paragraph', runs: plain('1. First duty') },
      { type: 'paragraph', runs: plain('2. Second duty') },
    ])
  })
})

describe('parseContractBlocks — unrecognised syntax falls back to literal text', () => {
  it('keeps blockquote markers verbatim', () => {
    expect(parseContractBlocks('> quoted clause')).toEqual([
      { type: 'paragraph', runs: plain('> quoted clause') },
    ])
  })

  it('keeps table pipes verbatim rather than dropping the row', () => {
    const blocks = parseContractBlocks('| Col A | Col B |\n\n| 1 | 2 |')
    expect(blocks).toEqual([
      { type: 'paragraph', runs: plain('| Col A | Col B |') },
      { type: 'paragraph', runs: plain('| 1 | 2 |') },
    ])
  })

  it('keeps raw HTML and link syntax verbatim (nothing is silently dropped)', () => {
    const blocks = parseContractBlocks('<b>bold?</b>\n\n[terms](https://example.com)')
    expect(blocks).toEqual([
      { type: 'paragraph', runs: plain('<b>bold?</b>') },
      { type: 'paragraph', runs: plain('[terms](https://example.com)') },
    ])
  })

  it('never loses a non-empty source line', () => {
    const src = [
      '# Employment Contract',
      '',
      'This agreement is between **Champ Fitness Ltd** and the Employee.',
      '',
      '## 1. Duties',
      '',
      '- Coach classes',
      '- Maintain the floor',
      '',
      '---',
      '',
      '> Nothing here is legal advice.',
      '',
      '#### Appendix',
      '',
      '| a | b |',
    ].join('\n')

    const blocks = parseContractBlocks(src)
    // Flatten every scrap of text the parser produced.
    const flat = blocks.flatMap((b) => {
      if (b.type === 'heading') return [b.text]
      if (b.type === 'paragraph') return b.runs.map((r) => r.text)
      if (b.type === 'list') return b.items.flatMap((it) => it.map((r) => r.text))
      return []
    }).join(' ')

    for (const needle of [
      'Employment Contract', 'Champ Fitness Ltd', 'Duties', 'Coach classes',
      'Maintain the floor', 'Nothing here is legal advice', 'Appendix', '| a | b |',
    ]) {
      expect(flat).toContain(needle)
    }
    expect(blocks.filter((b) => b.type === 'hr')).toHaveLength(1)
  })
})

// One smoke test for the renderer. It runs @react-pdf under vitest's
// node environment with no DOM shims (react-pdf is pure JS + wasm yoga)
// and asserts only that we get a real PDF back. Given a 5s default
// timeout the explicit 20s guard covers first-run wasm instantiation.
describe('renderContractPdf', () => {
  it('resolves to a non-empty PDF Buffer', async () => {
    const buf = await renderContractPdf({
      bodyRendered: '# Contract\n\nThis is the **body**.\n\n- one\n- two\n\n---\n\nEnd.',
      issuerSignature: 'Richard Ivers',
      issuedAt: '2026-07-01T09:00:00.000Z',
      recipientSignature: 'Jane Doe',
      signedAt: '2026-07-02T14:30:00.000Z',
      signedIp: '192.0.2.10',
      templateName: 'Coach Employment Contract',
      companyName: 'UN1T Dublin',
    })
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(1000)
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  }, 20000)

  it('still renders with an empty body and no signature metadata', async () => {
    const buf = await renderContractPdf({})
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect(buf.length).toBeGreaterThan(0)
  }, 20000)
})
