// FINDTEAM.3 — the confirmation email for a solo who booked "find me a team"
// carries one extra paragraph after the intro; with no paragraph the defaults
// are untouched.
import { describe, it, expect } from 'vitest'
import { buildConfirmationDefaults, buildConfirmationEmailHtml } from './race-confirmations.js'

const CTX = {
  raceName: 'Hatch Relay',
  raceDateLabel: 'Sunday 18 October',
  waveLabel: '11:00',
  waveRowLabel: 'Wave',
  locationName: 'UN1T Hatch',
  teamName: 'Sarah Byrne (looking for a team)',
  teamSize: 1,
  teamMembers: [{ name: 'Sarah Byrne', role: 'captain', is_member: false, qrSrc: '' }],
  captainFirstName: 'Sarah',
  amountLabel: '€20.00',
  memberCount: 0,
  nonMemberCount: 1,
  memberFeeLabel: null,
  nonMemberFeeLabel: null,
  manageUrl: '',
  brand: 'UN1T',
}

describe('buildConfirmationDefaults: findTeamParagraph', () => {
  it('is byte-identical to the pre-existing output when there is no paragraph', () => {
    const base = buildConfirmationDefaults(CTX)
    expect(buildConfirmationDefaults({ ...CTX, findTeamParagraph: undefined })).toEqual(base)
    expect(buildConfirmationDefaults({ ...CTX, findTeamParagraph: '' })).toEqual(base)
    expect(base.introHtml).toBe('Team <strong>Sarah Byrne (looking for a team)</strong> is locked in for <strong>Hatch Relay</strong>.')
  })

  it('appends the paragraph after the intro sentence when set', () => {
    const base = buildConfirmationDefaults(CTX)
    const d = buildConfirmationDefaults({ ...CTX, findTeamParagraph: "You booked a solo place. We'll put you with a team." })
    expect(d.introHtml.startsWith(base.introHtml)).toBe(true)
    expect(d.introHtml).toMatch(/<p style="[^"]+">You booked a solo place\. We&#39;ll put you with a team\.<\/p>$/)
    // every other slot is untouched
    expect({ ...d, introHtml: null }).toEqual({ ...base, introHtml: null })
  })

  it('escapes the paragraph', () => {
    const d = buildConfirmationDefaults({ ...CTX, findTeamParagraph: '<b>x</b> & y' })
    expect(d.introHtml).toContain('&lt;b&gt;x&lt;/b&gt; &amp; y')
    expect(d.introHtml).not.toContain('<b>x</b>')
  })

  it('reaches the rendered email', () => {
    const html = buildConfirmationEmailHtml({ ...CTX, findTeamParagraph: 'We will place you in a team.' })
    expect(html).toContain('We will place you in a team.')
    expect(buildConfirmationEmailHtml(CTX)).not.toContain('We will place you')
  })
})
