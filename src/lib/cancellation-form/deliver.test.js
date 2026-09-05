// CANCEL-FORM.4 — pure halves of link delivery: the texts, the email HTML,
// and the template URL-prefix guard that keeps a token off the wrong host.

import { describe, it, expect } from 'vitest'
import { CANCELLATION_FORM_DEFAULTS } from './defaults.js'
import { renderLinkTexts, buildLinkEmailHtml, templateUrlPrefixOk, linkVars } from './deliver.js'

const copy = { ...CANCELLATION_FORM_DEFAULTS }
const URL = 'https://crm.example/cancel/abc.def'

describe('linkVars / renderLinkTexts', () => {
  it('renders subject, email body, whatsapp text and button from the copy with the link substituted', () => {
    const vars = linkVars({ contact: { first_name: 'Aoife', name: 'Aoife Byrne', glofox_membership_plan: 'Unlimited' }, locationName: 'UN1T Stillorgan', url: URL })
    const t = renderLinkTexts(copy, vars)
    expect(t.emailSubject).toBe('Your membership with UN1T Stillorgan')
    expect(t.emailBody).toContain('Hi Aoife,')
    expect(t.emailBody).toContain(URL)
    expect(t.emailBody).toContain('UN1T Stillorgan')
    expect(t.whatsappText).toBe('Hi Aoife, as requested here is the link to pause or cancel your membership. It takes about a minute and nothing changes until we confirm it with you.')
    expect(t.whatsappButtonText).toBe('Open form')
    expect(t.emailBody).not.toMatch(/—/)
  })

  it('an operator message override replaces the body but still gets the link appended when it forgot {link}', () => {
    const vars = linkVars({ contact: { first_name: 'Aoife' }, locationName: 'X', url: URL })
    const t = renderLinkTexts(copy, vars, { message: 'Hi {first_name}, here you go.' })
    expect(t.emailBody).toBe(`Hi Aoife, here you go.\n\n${URL}`)
    expect(t.whatsappText).toBe('Hi Aoife, here you go.')
    const t2 = renderLinkTexts(copy, vars, { message: 'Link: {link}' })
    expect(t2.emailBody).toBe(`Link: ${URL}`)
  })

  it('falls back to "there" when the contact has no first name', () => {
    const vars = linkVars({ contact: { name: '' }, locationName: 'X', url: URL })
    expect(renderLinkTexts(copy, vars).whatsappText.startsWith('Hi there,')).toBe(true)
  })
})

describe('buildLinkEmailHtml', () => {
  it('escapes the text, turns newlines into <br>, renders the link as a button AND a plain line, no <style>', () => {
    const html = buildLinkEmailHtml('Hi <Aoife>,\n\nhere: https://crm.example/cancel/abc.def\n\nBye', URL, { buttonText: 'Open form' })
    expect(html).toContain('Hi &lt;Aoife&gt;,<br><br>')
    expect(html).toContain(`href="${URL}"`)
    expect(html).toContain('Open form')
    // The raw URL survives as visible text for clients that strip buttons.
    expect((html.match(/https:\/\/crm\.example\/cancel\/abc\.def/g) || []).length).toBeGreaterThanOrEqual(2)
    expect(html).not.toMatch(/<style/i)
  })
})

describe('templateUrlPrefixOk', () => {
  const tpl = (url) => ({ components: [{ type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Open form', url }] }] })
  it('accepts a dynamic URL button rooted on the configured host and refuses any other', () => {
    expect(templateUrlPrefixOk(tpl('https://crm.example/cancel/{{1}}'), 'https://crm.example')).toBe(true)
    expect(templateUrlPrefixOk(tpl('https://crm.example/cancel/{{1}}'), 'https://crm.example/')).toBe(true)
    expect(templateUrlPrefixOk(tpl('https://evil.example/cancel/{{1}}'), 'https://crm.example')).toBe(false)
    expect(templateUrlPrefixOk(tpl('https://crm.example/start?c={{1}}'), 'https://crm.example')).toBe(false)
    expect(templateUrlPrefixOk(tpl('https://crm.example/cancel/fixed'), 'https://crm.example')).toBe(false)
    expect(templateUrlPrefixOk({ components: [] }, 'https://crm.example')).toBe(false)
  })
})
