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
