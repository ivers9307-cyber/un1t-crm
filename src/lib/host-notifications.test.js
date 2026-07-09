import { describe, it, expect } from 'vitest'
import { assembleHostRecipients, buildReviewedEmail, buildSubmittedEmail } from './host-notifications'

describe('assembleHostRecipients', () => {
  it('dedupes + lowercases host email and linked logins, skipping empties', () => {
    expect(assembleHostRecipients({ email: 'Host@X.ie' }, [{ email: 'host@x.ie' }, { email: 'B@x.ie' }, { email: null }]))
      .toEqual(['host@x.ie', 'b@x.ie'])
  })
  it('handles missing host email and empty links', () => {
    expect(assembleHostRecipients({ email: null }, [])).toEqual([])
  })
})

describe('buildReviewedEmail', () => {
  const event = { name: 'Summer Throwdown', slug: 'summer-throwdown' }
  it('approved: subject says live + body links the public page', () => {
    const m = buildReviewedEmail({ event, action: 'approve', appUrl: 'https://crm.x.com' })
    expect(m.subject).toContain('live')
    expect(m.htmlBody).toContain('https://crm.x.com/event/summer-throwdown')
  })
  it('rejected: subject says needs changes + body carries the escaped reason + portal link', () => {
    const m = buildReviewedEmail({ event, action: 'reject', reason: 'Fix <the> date', appUrl: 'https://crm.x.com' })
    expect(m.subject).toContain('needs changes')
    expect(m.htmlBody).toContain('Fix &lt;the&gt; date')
    expect(m.htmlBody).toContain('https://crm.x.com/host')
  })
})

describe('buildSubmittedEmail', () => {
  it('names the host + event and links the review queue', () => {
    const m = buildSubmittedEmail({ event: { name: 'Gala' }, host: { name: 'Acme' }, appUrl: 'https://crm.x.com' })
    expect(m.subject).toContain('Gala')
    expect(m.htmlBody).toContain('Acme')
    expect(m.htmlBody).toContain('https://crm.x.com/settings/hosts')
  })
})
