import { describe, it, expect } from 'vitest'
import { ORG_NUMBERS_PAGE, orgNumbersHref } from './org-whatsapp-numbers-page'
import { HUB_PATH } from './integrations-hub-links'

describe('org WhatsApp numbers page (INTEGONE.3)', () => {
  it('is the hub\'s whatsapp-numbers drawer, with no organisation named', () => {
    expect(ORG_NUMBERS_PAGE).toBe(`${HUB_PATH}?manage=whatsapp-numbers`)
  })

  it('orgNumbersHref names the organisation, encoded; none gives the bare drawer URL', () => {
    expect(orgNumbersHref('org-1')).toBe(`${ORG_NUMBERS_PAGE}&org=org-1`)
    expect(orgNumbersHref('a b')).toBe(`${ORG_NUMBERS_PAGE}&org=a%20b`)
    expect(orgNumbersHref(null)).toBe(ORG_NUMBERS_PAGE)
  })
})
