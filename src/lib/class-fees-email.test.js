import { describe, it, expect } from 'vitest'
import { buildReviewEmail } from './class-fees-email.js'

const base = {
  studioName: 'UN1T Hatch Street', dayLabel: 'Wednesday 28 October', dryRun: false, chargeLabel: '17:00 tomorrow',
  reviewUrl: 'https://crm.test/class-fees?location=loc-1', contactUrl: (id) => `https://crm.test/contacts/${id}`,
}

describe('buildReviewEmail (FEES.5)', () => {
  it('a live night: subject, tiles, rows and the studio button', () => {
    const { subject, htmlBody } = buildReviewEmail({
      ...base,
      due: [{ member: 'Ann A', contactId: 'c1', classTitle: 'Strength', classTime: 'Wed 28 Oct 18:30', kind: 'no_show', amountCents: 2000 }],
      forgiven: [{ member: 'Bob B', contactId: 'c2', classTitle: 'Mobility', classTime: 'Wed 28 Oct 07:00', kind: 'late_cancel', reason: 'First offence, a warning only (automatic)' }],
      recordedCount: 1,
      undecided: [{ member: null, contactId: null, classTitle: 'HIIT', classTime: 'Wed 28 Oct 19:30' }],
      outstandingCount: 2,
    })
    expect(subject).toBe('UN1T Hatch Street class fees, Wednesday 28 October: 1 to charge at 17:00 tomorrow')
    expect(htmlBody).toContain('To charge')
    expect(htmlBody).toContain('€20')
    expect(htmlBody).toContain('href="https://crm.test/contacts/c1"')
    expect(htmlBody).toContain('First offence, a warning only</span>')
    expect(htmlBody).toContain('Not marked in un1t.online')
    expect(htmlBody).toContain('2 fee(s) are outstanding')
    expect(htmlBody).toContain('href="https://crm.test/class-fees?location=loc-1"')
    expect(htmlBody).toContain('Review UN1T Hatch Street fees')
    expect(htmlBody).not.toContain('DRY RUN')
  })

  it('a dry run with nothing due says so and shows empty states', () => {
    const { subject, htmlBody } = buildReviewEmail({ ...base, dryRun: true })
    expect(subject).toBe('UN1T Hatch Street class fees, Wednesday 28 October (dry run): 0 would be charged')
    expect(htmlBody).toContain('DRY RUN')
    expect(htmlBody).toContain('Would charge')
    expect(htmlBody).toContain('No fees tonight.')
    expect(htmlBody).toContain('Nothing forgiven tonight.')
    expect(htmlBody).not.toContain('Not marked in un1t.online')
  })

  it('escapes every value', () => {
    const { htmlBody } = buildReviewEmail({
      ...base, studioName: '<b>S</b>',
      due: [{ member: '<script>x</script>', contactId: 'c"1', classTitle: '<i>T</i>', classTime: '', kind: 'no_show', amountCents: 100 }],
    })
    expect(htmlBody).not.toContain('<script>x')
    expect(htmlBody).not.toContain('<b>S</b>')
    expect(htmlBody).toContain('&lt;script&gt;')
    expect(htmlBody).toContain('c&quot;1')
  })
})
