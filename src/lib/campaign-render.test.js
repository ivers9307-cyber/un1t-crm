// CAMPAIGNRENDER.1 — the one render behind the real send and both test sends.
import { describe, it, expect } from 'vitest'
import { renderCampaignEmail } from './campaign-render.js'

const contact = { id: 'c1', first_name: 'Ann', name: 'Ann Example', email: 'ann@example.test' }
const extras = {
  location_name: 'Studio One', company_name: 'UN1T',
  unsubscribe_url: 'https://crm.test/unsubscribe/tok', preference_url: 'https://crm.test/preferences/tok', zone: 'Europe/Dublin',
}
const campaign = {
  html_content: '<html><body><p>Hi {{first_name}}, news from {{location_name}}.</p></body></html>',
  preview_text: 'For {{first_name}}',
}
const render = (over = {}) => renderCampaignEmail({ campaign, subject: 'News from {{location_name}}', contact, extras, broadcast: true, viewUrl: 'https://crm.test/view-email/v1', ...over })

describe('renderCampaignEmail', () => {
  it('merges the body and the subject with the same extras', () => {
    const r = render()
    expect(r.html).toContain('Hi Ann, news from Studio One.')
    expect(r.subject).toBe('News from Studio One')
  })

  it('a broadcast carries the footer, the view-in-browser link and the preheader, preheader first', () => {
    const { html } = render()
    expect(html).toContain(extras.unsubscribe_url)
    expect(html).toContain('https://crm.test/view-email/v1')
    expect(html).toContain('For Ann')
    expect(html.indexOf('For Ann')).toBeLessThan(html.indexOf('https://crm.test/view-email/v1'))
  })

  it('the plain-text part has the footer but not the inbox chrome', () => {
    const { text } = render()
    expect(text).toContain('Hi Ann')
    expect(text).toContain(extras.unsubscribe_url)
    expect(text).not.toContain('view-email')
    expect(text).not.toContain('For Ann')
  })

  it('a utility email gets no footer and no view-in-browser link', () => {
    const { html } = render({ broadcast: false, extras: { ...extras, unsubscribe_url: null } })
    expect(html).not.toContain('/unsubscribe/')
    expect(html).not.toContain('view-email')
    expect(html).toContain('For Ann')
  })

  it('no preview text means no preheader', () => {
    const { html } = render({ campaign: { ...campaign, preview_text: null } })
    expect(html).not.toContain('For Ann')
  })
})
