import { describe, it, expect } from 'vitest'
import {
  visibleText,
  mediaRefs,
  diffLines,
  diffText,
  compare,
} from '../scripts/diff-public-pages.mjs'

const page = (origin, heading = 'Try a free class') => `<!doctype html>
<html><head>
<style>.a { color: red }</style>
<script>window.x = "not visible"</script>
<script src="/_next/static/chunks/app.js"></script>
<link rel="stylesheet" href="/_next/static/css/app.css">
</head><body>
<h1>${heading}</h1>
<p>Train with us &amp; feel great. Book today!</p>
<img src="${origin}/media/hero.jpg" alt="hero">
<video poster="/media/poster.jpg" src="${origin}/media/clip.mp4"></video>
<a href="${origin}/trial?_rsc=abc123">Trial</a>
<a href="/trial?edit=1">Edit</a>
<img src="data:image/png;base64,AAAA">
</body></html>`

describe('visibleText', () => {
  it('strips scripts, styles, noscript, template and tags, and decodes entities', () => {
    const html =
      '<style>p{}</style><script>var a = 1</script><noscript>no js</noscript>' +
      '<template><b>tpl</b></template><p>Fish &amp; chips&nbsp;&lt;3 &quot;yes&quot; it&#39;s   <b>fine</b></p>\n\n<p>Next</p>'
    expect(visibleText(html)).toBe('Fish & chips <3 "yes" it\'s fine Next')
  })
})

describe('visibleText comments', () => {
  it('a <!-- inside a script does not swallow content up to the next -->', () => {
    expect(visibleText('<script>var s = "<!--"</script><p>Keep me</p><!-- gone -->')).toBe('Keep me')
  })
})

describe('mediaRefs', () => {
  it('normalises origin, drops _next, data: and _rsc/edit noise, sorts and dedupes', () => {
    const refs = mediaRefs(page('https://crm.un1tdublin.com'))
    expect(refs).toEqual(['/media/clip.mp4', '/media/hero.jpg', '/media/poster.jpg', '/trial'])
    expect(mediaRefs(page('http://localhost:3000'))).toEqual(refs)
  })
})

describe('mediaRefs extras', () => {
  it('strips caller-supplied origins and unwraps next/image to the real media path', () => {
    const html =
      '<a href="https://preview-abc.vercel.app/corp?edit=1&amp;x=1">a</a>' +
      '<img src="/_next/image?url=%2Fmedia%2Fhero.jpg&amp;w=640&amp;q=75">' +
      '<a href="https://instagram.com/un1t">ig</a>'
    expect(mediaRefs(html, ['https://preview-abc.vercel.app'])).toEqual([
      '/corp?x=1',
      '/media/hero.jpg',
      'https://instagram.com/un1t',
    ])
  })
})

describe('diffLines / diffText', () => {
  it('returns lines unique to each side', () => {
    expect(diffLines(['a', 'b', 'c'], ['b', 'c', 'd'])).toEqual({
      onlyBefore: ['a'],
      onlyAfter: ['d'],
    })
  })
  it('keeps multiplicity: a dropped duplicate is reported', () => {
    expect(diffLines(['A', 'B', 'B'], ['A', 'B'])).toEqual({ onlyBefore: ['B'], onlyAfter: [] })
    expect(diffText('Buy now. Buy now. Done.', 'Buy now. Done.')).toEqual(['- Buy now.'])
  })
  it('reports a reorder, showing the moved lines', () => {
    const r = diffLines(['A', 'B', 'C'], ['B', 'A', 'C'])
    expect(r.onlyBefore.length).toBe(1)
    expect(r.onlyAfter.length).toBe(1)
    // the moved line shows on both sides: removed from its old place, added at the new one
    expect(r.onlyBefore).toEqual(r.onlyAfter)
    expect(['A', 'B']).toContain(r.onlyBefore[0])
  })
  it('prefixes removed and added sentences', () => {
    expect(diffText('One. Two. Three.', 'One. Too. Three.')).toEqual(['- Two.', '+ Too.'])
  })
})

describe('compare', () => {
  const ok = (origin, heading) => ({ status: 200, location: null, html: page(origin, heading) })

  it('is the same for identical html served from different origins', () => {
    const r = compare(ok('https://crm.un1tdublin.com'), ok('http://localhost:3000'))
    expect(r.same).toBe(true)
    expect(r.statusLine).toBe('200 → 200')
    expect(r.textDiff).toEqual([])
    expect(r.media).toEqual({ onlyBefore: [], onlyAfter: [] })
  })

  it('lists the changed sentence when a heading changes', () => {
    const r = compare(
      ok('https://crm.un1tdublin.com'),
      ok('http://localhost:3000', 'Book a free class'),
    )
    expect(r.same).toBe(false)
    expect(r.textDiff.join('\n')).toContain('- Try a free class')
    expect(r.textDiff.join('\n')).toContain('+ Book a free class')
  })

  it('is not the same when a sentence is duplicated away or two sentences swap', () => {
    const side = (html) => ({ status: 200, location: null, html })
    expect(compare(side('<p>A. B. B.</p>'), side('<p>A. B.</p>')).same).toBe(false)
    const swapped = compare(side('<p>A. B.</p>'), side('<p>B. A.</p>'))
    expect(swapped.same).toBe(false)
    expect(swapped.textDiff.length).toBe(2)
  })

  it('treats a 307 with the same location path and query as the same', () => {
    const r = compare(
      { status: 307, location: 'https://crm.un1tdublin.com/trial?studio=stillorgan&utm_campaign=x', html: '' },
      { status: 307, location: 'http://localhost:3000/trial?studio=stillorgan&utm_campaign=x', html: '' },
    )
    expect(r.same).toBe(true)
    expect(r.statusLine).toBe(
      '307 /trial?studio=stillorgan&utm_campaign=x → 307 /trial?studio=stillorgan&utm_campaign=x',
    )
  })

  it('differs when the redirect target or status differs', () => {
    const a = { status: 307, location: '/trial?studio=hatch', html: '' }
    expect(compare(a, { ...a, location: '/trial' }).same).toBe(false)
    expect(compare(a, { status: 200, location: null, html: '' }).same).toBe(false)
  })
})
