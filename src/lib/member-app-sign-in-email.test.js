import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./postmark', () => ({ sendTransactionalEmail: vi.fn() }))
vi.mock('./location-branding', () => ({ getLocationBranding: vi.fn() }))

import {
  MEMBER_APP_SIGN_IN_TEMPLATE,
  defaultMemberAppSignInCopy,
  memberAppSignInTokens,
  renderMemberAppSignInEmail,
  sendMemberAppSignInEmail,
} from './member-app-sign-in-email'
import { sendTransactionalEmail } from './postmark'
import { getLocationBranding } from './location-branding'

const SIGN_IN = 'https://app.example.test/login'
const CONTACT = { id: 'c1', name: 'Sarah Byrne', first_name: 'Sarah', email: 'sarah@example.test', location_id: 'loc-1' }
const BRANDING = { companyName: 'UN1T Dublin', shortName: 'UN1T' }

// A db whose locations + email_templates reads answer from the given rows.
function makeDb({ locationName = 'UN1T Stillorgan', template = null } = {}) {
  const calls = []
  return {
    calls,
    from: vi.fn((table) => {
      const filters = []
      const chain = {
        select: () => chain,
        eq: (col, val) => { filters.push([col, val]); return chain },
        maybeSingle: async () => {
          calls.push({ table, filters })
          if (table === 'locations') return { data: { name: locationName }, error: null }
          if (table === 'email_templates') return { data: template, error: null }
          return { data: null, error: null }
        },
      }
      return chain
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  sendTransactionalEmail.mockResolvedValue({ messageId: 'pm-1' })
  getLocationBranding.mockResolvedValue(BRANDING)
})

describe('memberAppSignInTokens', () => {
  it('names the app by the short brand and signs off with the studio', () => {
    const t = memberAppSignInTokens({ contact: CONTACT, branding: BRANDING, locationName: 'UN1T Stillorgan', signInUrl: SIGN_IN })
    expect(t).toMatchObject({ first_name: 'Sarah', app_name: 'UN1T app', studio: 'UN1T Stillorgan', sign_in_url: SIGN_IN })
  })

  it('falls back to "the app" and "there" rather than another brand or a blank', () => {
    const t = memberAppSignInTokens({ contact: { name: '' }, branding: {}, locationName: null, signInUrl: SIGN_IN })
    expect(t.app_name).toBe('app')
    expect(t.first_name).toBe('there')
  })
})

describe('renderMemberAppSignInEmail', () => {
  it('links the sign-in page and carries no em-dash', () => {
    const tokens = memberAppSignInTokens({ contact: CONTACT, branding: BRANDING, locationName: 'UN1T Stillorgan', signInUrl: SIGN_IN })
    const { subject, htmlBody } = renderMemberAppSignInEmail(defaultMemberAppSignInCopy(), tokens)
    expect(subject).toBe('Sign in to the UN1T app')
    expect(htmlBody).toContain(`href="${SIGN_IN}"`)
    expect(htmlBody).toContain('Hi Sarah,')
    expect(htmlBody).not.toContain('{{')
    expect(`${subject}${htmlBody}`).not.toContain('—')
  })

  it('HTML-escapes token values in the body', () => {
    const { htmlBody } = renderMemberAppSignInEmail(
      { subject: 'x', htmlBody: '<p>{{first_name}}</p>' },
      { first_name: '<img src=x>' },
    )
    expect(htmlBody).toBe('<p>&lt;img src=x&gt;</p>')
  })
})

describe('sendMemberAppSignInEmail', () => {
  it('sends the built-in copy as a logged transactional email at the contact location', async () => {
    const db = makeDb()
    const result = await sendMemberAppSignInEmail(db, { contact: CONTACT, signInUrl: SIGN_IN })
    expect(result).toEqual({ messageId: 'pm-1' })
    expect(getLocationBranding).toHaveBeenCalledWith(db, 'loc-1')
    const args = sendTransactionalEmail.mock.calls[0][0]
    expect(args).toMatchObject({
      to: 'sarah@example.test',
      subject: 'Sign in to the UN1T app',
      contactId: 'c1',
      locationId: 'loc-1',
      tag: 'member-app-sign-in',
    })
    expect(args.htmlBody).toContain(`href="${SIGN_IN}"`)
    expect(args.htmlBody).toContain('UN1T Stillorgan')
  })

  it("uses the location's operator template when one exists", async () => {
    const db = makeDb({ template: { subject: 'Your {{short_name}} login', html_content: '<p>Hey {{first_name}}, go to {{sign_in_url}}</p>' } })
    await sendMemberAppSignInEmail(db, { contact: CONTACT, signInUrl: SIGN_IN })
    const tplRead = db.calls.find((c) => c.table === 'email_templates')
    expect(tplRead.filters).toEqual([['location_id', 'loc-1'], ['name', MEMBER_APP_SIGN_IN_TEMPLATE]])
    const args = sendTransactionalEmail.mock.calls[0][0]
    expect(args.subject).toBe('Your UN1T login')
    expect(args.htmlBody).toBe(`<p>Hey Sarah, go to ${SIGN_IN}</p>`)
  })

  it('propagates a send failure to the caller', async () => {
    sendTransactionalEmail.mockRejectedValue(new Error('Postmark send error'))
    await expect(sendMemberAppSignInEmail(makeDb(), { contact: CONTACT, signInUrl: SIGN_IN })).rejects.toThrow('Postmark send error')
  })
})
