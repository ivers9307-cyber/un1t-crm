import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import BlockRenderer from './BlockRenderers.jsx'

// MANUALFUNNEL.1 — a class_funnel block can be kept off the studio's main
// landing page while it still configures the dedicated /start/{path} page.
// Node environment, no jsdom: static markup only (the funnel's effects, and
// so its class fetch, never run).

const block = { id: 'cf', type: 'class_funnel', heading: 'Your first class is free', subhead: 'Pick a time.' }

describe('BlockRenderer — class_funnel visibility on the main landing page', () => {
  it('renders the funnel, anchored at #start, by default', () => {
    const html = renderToStaticMarkup(<BlockRenderer block={block} publicPath="hatch-street" />)
    expect(html).toContain('id="start"')
    expect(html).toContain('Your first class is free')
  })

  it('renders nothing on the public page when switched off', () => {
    const html = renderToStaticMarkup(<BlockRenderer block={{ ...block, show_on_landing: false }} publicPath="hatch-street" />)
    expect(html).toBe('')
  })

  it('still renders its placeholder in the editor when switched off, and says where it shows', () => {
    const html = renderToStaticMarkup(<BlockRenderer block={{ ...block, show_on_landing: false }} publicPath="hatch-street" onEdit={() => {}} />)
    expect(html).toContain('Your first class is free')
    expect(html).toContain('hidden on this page')
  })
})
