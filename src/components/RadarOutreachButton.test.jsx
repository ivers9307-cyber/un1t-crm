// UN1TRADAR.3 — a studio with no WhatsApp number switched on shows a note,
// never a template picker.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import RadarOutreachButton, { RadarOutreachAvailable } from './RadarOutreachButton'

describe('RadarOutreachButton', () => {
  it('outreachAvailable false → the note, no button', () => {
    const html = renderToStaticMarkup(<RadarOutreachButton outreachAvailable={false} contactName="A" onSelect={() => {}} />)
    expect(html).toContain('No WhatsApp number at this studio yet')
    expect(html).not.toContain('<button')
  })
  it('the page context decides when the prop is absent', () => {
    const html = renderToStaticMarkup(
      <RadarOutreachAvailable.Provider value={false}><RadarOutreachButton contactName="A" onSelect={() => {}} /></RadarOutreachAvailable.Provider>,
    )
    expect(html).toContain('No WhatsApp number at this studio yet')
  })
  it('by default the picker button renders as before', () => {
    const html = renderToStaticMarkup(<RadarOutreachButton contactName="A" onSelect={() => {}} />)
    expect(html).toContain('<button')
    expect(html).toContain('WhatsApp')
    expect(html).not.toContain('No WhatsApp number')
  })
})
