// CARDLENS.10 — marketing consent per studio (contact_location_preferences),
// read-only, for a person with two or more studios. STOP / START on WhatsApp
// are per studio since WAORGNUMBER.3, so one contact-wide flag hid them.
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import StudioConsentCard from './StudioConsentCard.jsx'

const S = 'a0000000-0000-4000-8000-00000000000a'
const H = 'b0000000-0000-4000-8000-00000000000b'
const STUDIOS = [{ locationId: S, name: 'Stillorgan' }, { locationId: H, name: 'Hatch Street' }]

describe('StudioConsentCard', () => {
  it('a column per studio, On / Off for each channel', () => {
    const html = renderToStaticMarkup(<StudioConsentCard studios={STUDIOS} rows={[
      { location_id: S, email_marketing: true, whatsapp_marketing: true },
      { location_id: H, email_marketing: true, whatsapp_marketing: false },
    ]} />)
    expect(html).toContain('Stillorgan')
    expect(html).toContain('Hatch Street')
    expect(html).toContain('Email marketing')
    expect(html).toContain('WhatsApp marketing')
    expect(html.match(/>On</g)).toHaveLength(3)
    expect(html.match(/>Off</g)).toHaveLength(1)
  })

  it('no row at a studio means not on that list', () => {
    const html = renderToStaticMarkup(<StudioConsentCard studios={STUDIOS} rows={[{ location_id: S, email_marketing: true, whatsapp_marketing: true }]} />)
    expect(html.match(/>Not on list</g)).toHaveLength(2)
  })

  it('a failed read says so, never "Off"', () => {
    const html = renderToStaticMarkup(<StudioConsentCard studios={STUDIOS} rows={null} />)
    expect(html).toContain('Could not load consent by studio')
    expect(html).not.toContain('>Off<')
  })

  it('nothing with fewer than two studios', () => {
    expect(renderToStaticMarkup(<StudioConsentCard studios={[STUDIOS[0]]} rows={[]} />)).toBe('')
  })
})
