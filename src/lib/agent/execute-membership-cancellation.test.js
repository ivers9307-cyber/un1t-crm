// CANCEL-FORM.5 — the Glofox execution step behind an approved cancellation.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/glofox', () => ({
  cancelGlofoxMembership: vi.fn(),
  resolveUserMembershipId: vi.fn(),
  glofoxCancellationReason: (code) => ({ price: 'MEMBERSHIP_CANCELLATION_PRICE' }[code] || ''),
  missingGlofoxCredentialsForLocation: (creds) => (creds && creds.apiKey ? [] : ['apiKey']),
}))

import { executeMembershipCancellation } from './execute-membership-cancellation.js'
import { cancelGlofoxMembership, resolveUserMembershipId } from '@/lib/glofox'

const creds = { branchId: 'b', apiKey: 'k', apiToken: 't' }
const MEMBER = '6a0219cee62c0c6c980bc95f'
const UM = '6a0219cfb4764c1cf687d640'
const row = (details = {}) => ({ id: 'r1', kind: 'cancellation', contact_id: 'c1', details: { requested_end_date: '2026-10-05', reason_code: 'price', ...details } })

function makeDb() {
  const updates = []
  return {
    _updates: updates,
    from: (table) => ({ update: (p) => ({ eq: () => ({ select: () => Promise.resolve((updates.push({ table, p }), { data: [{ id: 'c1' }], error: null })) }) }) }),
  }
}

beforeEach(() => { vi.clearAllMocks() })

describe('executeMembershipCancellation', () => {
  it('cancels ON the requested date with the mapped reason and reports the planned end', async () => {
    cancelGlofoxMembership.mockResolvedValue({ ok: true, status: 200, message_code: null, local_planned_end_date: '2026-10-05' })
    const out = await executeMembershipCancellation(makeDb(), row(), { contact: { glofox_member_id: MEMBER, glofox_user_membership_id: UM }, creds })
    expect(out).toMatchObject({ ok: true, message_code: null, local_planned_end_date: '2026-10-05', user_membership_id: UM })
    expect(cancelGlofoxMembership).toHaveBeenCalledWith(creds, { userMembershipId: UM, memberId: MEMBER, localDate: '2026-10-05', reason: 'MEMBERSHIP_CANCELLATION_PRICE' })
    expect(resolveUserMembershipId).not.toHaveBeenCalled()
  })

  it('resolves the membership instance id live when the contact has none stored, and writes it back', async () => {
    resolveUserMembershipId.mockResolvedValue(UM)
    cancelGlofoxMembership.mockResolvedValue({ ok: true, status: 200, message_code: null, local_planned_end_date: '2026-10-05' })
    const db = makeDb()
    const out = await executeMembershipCancellation(db, row(), { contact: { id: 'c1', glofox_member_id: MEMBER, glofox_user_membership_id: null }, creds })
    expect(out.ok).toBe(true)
    expect(resolveUserMembershipId).toHaveBeenCalledWith(creds, MEMBER)
    expect(db._updates[0]).toMatchObject({ table: 'contacts', p: { glofox_user_membership_id: UM } })
  })

  it('honours the elected sibling account over the contact row', async () => {
    cancelGlofoxMembership.mockResolvedValue({ ok: true, local_planned_end_date: '2026-10-05', message_code: null })
    const other = 'aaaaaaaaaaaaaaaaaaaaaaaa'
    await executeMembershipCancellation(makeDb(), row({ elected_glofox_member_id: other }), { contact: { glofox_member_id: MEMBER, glofox_user_membership_id: UM }, creds })
    expect(cancelGlofoxMembership.mock.calls[0][1].memberId).toBe(other)
  })

  it('lands NO_END_DATE / NOT_EXECUTABLE / NO_USER_MEMBERSHIP without calling Glofox', async () => {
    expect(await executeMembershipCancellation(makeDb(), row({ requested_end_date: undefined }), { contact: { glofox_member_id: MEMBER }, creds })).toMatchObject({ ok: false, message_code: 'NO_END_DATE' })
    expect(await executeMembershipCancellation(makeDb(), row({ requested_end_date: 'next month' }), { contact: { glofox_member_id: MEMBER }, creds })).toMatchObject({ ok: false, message_code: 'NO_END_DATE' })
    expect(await executeMembershipCancellation(makeDb(), row(), { contact: { glofox_member_id: null }, creds })).toMatchObject({ ok: false, message_code: 'NOT_EXECUTABLE' })
    expect(await executeMembershipCancellation(makeDb(), row(), { contact: { glofox_member_id: MEMBER }, creds: null })).toMatchObject({ ok: false, message_code: 'NOT_EXECUTABLE' })
    resolveUserMembershipId.mockResolvedValue(null)
    expect(await executeMembershipCancellation(makeDb(), row(), { contact: { glofox_member_id: MEMBER, glofox_user_membership_id: null }, creds })).toMatchObject({ ok: false, message_code: 'NO_USER_MEMBERSHIP' })
    expect(cancelGlofoxMembership).not.toHaveBeenCalled()
  })

  it('passes a Glofox rejection through verbatim', async () => {
    cancelGlofoxMembership.mockResolvedValue({ ok: false, status: 400, message_code: 'MEMBERSHIP_MINIMUM_TERM_NOT_REACHED', local_planned_end_date: null })
    const out = await executeMembershipCancellation(makeDb(), row(), { contact: { glofox_member_id: MEMBER, glofox_user_membership_id: UM }, creds })
    expect(out).toMatchObject({ ok: false, status: 400, message_code: 'MEMBERSHIP_MINIMUM_TERM_NOT_REACHED' })
  })
})
