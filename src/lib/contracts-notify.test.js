// W1.S1a — the contract push copy names a person or the contract location's
// configured brand, never a fixed gym, and carries no em-dash.
import { describe, it, expect, vi } from 'vitest'

vi.mock('./contracts-email.js', () => ({ sendContractIssuedEmail: vi.fn(async () => ({ ok: true })) }))
vi.mock('./push.js', () => ({ sendPush: vi.fn(async () => {}) }))
vi.mock('./location-branding.js', () => ({
  getLocationBranding: vi.fn(async (_db, locationId) => (locationId === 'L1'
    ? { companyName: 'UN1T Hatch Street', shortName: 'UN1T', locationName: 'UN1T Hatch Street' }
    : { companyName: '', shortName: '', locationName: '' })),
}))

import { sendPush } from './push.js'
import { contractPushSender, contractPushBody, notifyContractIssued } from './contracts-notify.js'

describe('contractPushSender', () => {
  it('prefers the person, then the location brand, then nobody', async () => {
    expect(await contractPushSender({}, 'Boss Person', 'L1')).toBe('Boss Person')
    expect(await contractPushSender({}, '  ', 'L1')).toBe('UN1T Hatch Street')
    expect(await contractPushSender({}, null, 'L-unknown')).toBe('')
  })
})

describe('contractPushBody', () => {
  it('issued: names the sender and the template, no em-dash', () => {
    expect(contractPushBody({ sender: 'UN1T Hatch Street', templateName: 'Coach Agreement', kind: 'issued' }))
      .toBe('UN1T Hatch Street issued you "Coach Agreement". Tap to review and sign.')
    expect(contractPushBody({ sender: '', templateName: null, kind: 'issued' }))
      .toBe('You have been issued a contract. Tap to review and sign.')
  })

  it('reminder: names the sender and the template', () => {
    expect(contractPushBody({ sender: 'Boss', templateName: null, kind: 'reminder' }))
      .toBe('Boss sent you a reminder to sign your contract.')
    expect(contractPushBody({ sender: '', templateName: 'FTE', kind: 'reminder' }))
      .toBe('A reminder to sign "FTE".')
  })

  it('never carries an em-dash or a fixed gym name', () => {
    for (const kind of ['issued', 'reminder']) {
      for (const sender of ['', 'X']) {
        for (const templateName of [null, 'T']) {
          const body = contractPushBody({ sender, templateName, kind })
          expect(body).not.toContain('—')
          expect(body).not.toContain('UN1T')
        }
      }
    }
  })
})

describe('notifyContractIssued push', () => {
  it('falls back to the contract location brand when the issuer has no name', async () => {
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { name: 'Coach Agreement' } }) }) }) }) }
    await notifyContractIssued({
      db,
      contract: { id: 'ct1', profile_id: 'p1', template_id: 't1', location_id: 'L1', profile: { full_name: 'R', email: 'r@x.test' } },
      issuer: {},
    })
    expect(sendPush.mock.calls[0][1].body).toBe('UN1T Hatch Street issued you "Coach Agreement". Tap to review and sign.')
  })
})
