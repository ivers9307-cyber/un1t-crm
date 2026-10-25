// mobile/lib/offer-cards.test.js
// REPLACE.1b — what the phone's offer surfaces say and decide (no RN runner).
import { describe, it, expect } from 'vitest'
import { offerCardLines, offerClaimAlert, offerPostAlert, blockOfferControl } from './offer-cards'

const ROW = { id: 'o1', block_date: '2026-09-29', start_time: '06:00:00', end_time: '07:00:00', shift_name: 'Morning', studio_name: 'Studio North' }
const BLOCK = { id: 'b1', block_date: '2026-09-29', min_coaches: 1, max_coaches: 3, rosters: { status: 'published' }, shift_templates: { kind: 'class' }, shift_assignments: [] }

describe('offerCardLines', () => {
  it('title and when-line', () => {
    expect(offerCardLines(ROW)).toEqual({ title: 'Morning · Studio North', when: 'Tue 29 Sep · 06:00-07:00' })
    expect(offerCardLines({ ...ROW, shift_name: null, studio_name: null }).title).toBe('Shift')
  })
})

describe('offerClaimAlert', () => {
  it('won, lost, offline', () => {
    expect(offerClaimAlert({ success: true })).toEqual({ title: 'Shift claimed', message: "It's yours. It is on your roster now." })
    expect(offerClaimAlert({ success: false, status: 409, error: 'Someone else has just taken this shift.' })).toEqual({ title: "Couldn't claim", message: 'Someone else has just taken this shift.' })
    expect(offerClaimAlert({ success: false, transport: true, error: 'Network error: x' }).message).toBe("Couldn't reach the server. Check your connection and try again.")
    expect(offerClaimAlert({ success: false, status: 500 }).message).toBe('Could not claim the shift.')
  })
})

describe('offerPostAlert', () => {
  it('now, morning, refused, offline', () => {
    expect(offerPostAlert({ success: true, data: { notice: 'now' } })).toEqual({ title: 'Offered to the team', message: 'Offered to the team. Coaches who are free are being told now.' })
    expect(offerPostAlert({ success: true, data: { notice: 'morning' } })).toEqual({ title: 'Offered to the team', message: 'Offered to the team. Coaches see it on Today now and get a notification from 7am.' })
    expect(offerPostAlert({ success: false, status: 409, error: 'This shift is already offered to the team.' })).toEqual({ title: "Couldn't offer", message: 'This shift is already offered to the team.' })
    expect(offerPostAlert({ success: false, transport: true }).title).toBe("Couldn't offer")
  })
})

describe('blockOfferControl (Manage card)', () => {
  it('offer / offered / nothing, by the shared rule', () => {
    expect(blockOfferControl(BLOCK, null, '2026-09-28')).toEqual({ kind: 'offer' })
    expect(blockOfferControl(BLOCK, { id: 'o1', notice_state: 'morning' }, '2026-09-28')).toEqual({ kind: 'offered', label: 'Offered to the team · coaches are told from 7am' })
    expect(blockOfferControl({ ...BLOCK, shift_assignments: [{ profile_id: 'x', status: 'scheduled' }] }, null, '2026-09-28')).toBeNull()
    expect(blockOfferControl({ ...BLOCK, rosters: { status: 'draft' } }, null, '2026-09-28')).toBeNull()
    expect(blockOfferControl({ ...BLOCK, block_date: '2026-09-27' }, null, '2026-09-28')).toBeNull()
  })
})
