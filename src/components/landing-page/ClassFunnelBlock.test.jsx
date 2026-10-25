import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import BlockRenderer from './BlockRenderers.jsx'
import { defaultsFor } from '../ClassFunnel.jsx'

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

// W1.S1b — the funnel's studio-naming defaults are functions of the page's
// location (the DEFAULTS merge used to leak "UN1T Stillorgan" onto every
// tenant's class_funnel block left blank). The consent and done copy only
// render past the class picker, so the defaults are asserted directly.
describe('ClassFunnel defaults name the page\'s studio (W1.S1b)', () => {
  it('consent and both sign-offs read the locationName', () => {
    const d = defaultsFor('Gym A North')
    expect(d.consentLabel).toBe("I'd like to hear from Gym A North by email, SMS and WhatsApp.")
    expect(d.classDoneBody).toBe("That's the first of your 3 free classes. Watch for a WhatsApp confirming it. See you at Gym A North!")
    expect(d.consultDoneBody).toContain('See you at Gym A North!')
  })

  it('with no location they still read as sentences and name nobody; no em-dash in customer copy', () => {
    const d = defaultsFor('')
    expect(d.consentLabel).toBe("I'd like to hear from this studio by email, SMS and WhatsApp.")
    expect(d.classDoneBody).toContain('See you soon!')
    const copy = JSON.stringify([d, defaultsFor('Gym A North')])
    expect(copy).not.toMatch(/UN1T|Stillorgan/)
    expect(copy).not.toContain('—')
  })
})
