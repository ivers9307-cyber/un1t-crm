import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import ContractBody from './ContractBody.jsx'

// CONTRACTS-MD.1 — same static-markup pattern as InstagramStrip.test.jsx /
// DraftBanner.test.jsx (node environment, no jsdom/@testing-library). The
// react-markdown default export (`Markdown`, aliased here as ContractBody's
// dependency) is synchronous with no hooks, unlike `MarkdownHooks` — safe to
// render this way.

describe('ContractBody', () => {
  it('renders headings as real heading elements, not literal #/##', () => {
    const html = renderToStaticMarkup(
      <ContractBody markdown={'# Employment Agreement\n\n## 1. Position'} />,
    )
    expect(html).toContain('<h1')
    expect(html).toContain('Employment Agreement')
    expect(html).toContain('<h2')
    expect(html).not.toContain('# Employment Agreement')
    expect(html).not.toContain('## 1. Position')
  })

  it('renders bullet lists as ul/li, not literal dashes', () => {
    const html = renderToStaticMarkup(
      <ContractBody markdown={'- Annual salary: 60000\n- Hourly rate: 28'} />,
    )
    expect(html).toContain('<ul')
    expect(html).toContain('<li')
    expect(html).toContain('Annual salary: 60000')
  })

  it('renders bold/italic emphasis as strong/em, not literal ** _', () => {
    const html = renderToStaticMarkup(
      <ContractBody markdown={'This is **bold** and this is *italic*.'} />,
    )
    expect(html).toContain('<strong')
    expect(html).toContain('bold')
    expect(html).toContain('<em')
    expect(html).toContain('italic')
    expect(html).not.toContain('**bold**')
  })

  it('renders a horizontal rule as <hr>, not literal ---', () => {
    const html = renderToStaticMarkup(
      <ContractBody markdown={'Above\n\n---\n\nBelow'} />,
    )
    expect(html).toContain('<hr')
    expect(html).not.toContain('---')
  })

  it('renders a script tag in the body as inert — never as an executable element', () => {
    const html = renderToStaticMarkup(
      <ContractBody markdown={'Before\n\n<script>alert(1)</script>\n\nAfter'} />,
    )
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
    expect(html).toContain('Before')
    expect(html).toContain('After')
  })

  it('handles an empty/missing markdown string without throwing', () => {
    expect(() => renderToStaticMarkup(<ContractBody markdown={undefined} />)).not.toThrow()
    expect(() => renderToStaticMarkup(<ContractBody markdown="" />)).not.toThrow()
  })
})
