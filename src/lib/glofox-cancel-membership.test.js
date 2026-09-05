// CANCEL-FORM.1 — membership cancellation via Glofox's v3.0 API.
//
// docs/LESSONS.md: POST /v3.0/memberships/{userMembershipId}/cancel is the
// only membership write Glofox documents. ON_DATE is the only `when` that
// works, the call is member-initiated so it REQUIRES the
// x-glofox-impersonated-member-id header, and a malformed 24-hex id makes
// Glofox's router answer WRONG_URL before the route resolves — so the
// client refuses bad ids locally rather than mis-reading that as "no such
// endpoint".

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const creds = { branchId: 'b', apiKey: 'k', apiToken: 't' }
const MEMBER = '6a0219cee62c0c6c980bc95f'
const USER_MEMBERSHIP = '6a0219cfb4764c1cf687d640'

const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
})

describe('glofoxCancellationReason', () => {
  it('maps form reason codes onto the Glofox enum, and unknown/other to the empty string', async () => {
    const { glofoxCancellationReason } = await import('./glofox.js')
    expect(glofoxCancellationReason('price')).toBe('MEMBERSHIP_CANCELLATION_PRICE')
    expect(glofoxCancellationReason('moving')).toBe('MEMBERSHIP_CANCELLATION_MOVED')
    expect(glofoxCancellationReason('not_using')).toBe('MEMBERSHIP_CANCELLATION_NO_USAGE')
    expect(glofoxCancellationReason('service')).toBe('MEMBERSHIP_CANCELLATION_CUSTOMER_SERVICE')
    expect(glofoxCancellationReason('schedule')).toBe('MEMBERSHIP_CANCELLATION_EVENT_SCHEDULE')
    expect(glofoxCancellationReason('change_membership')).toBe('MEMBERSHIP_CANCELLATION_CHANGE_MEMBERSHIP')
    expect(glofoxCancellationReason('injury_health')).toBe('')
    expect(glofoxCancellationReason('other')).toBe('')
    expect(glofoxCancellationReason(undefined)).toBe('')
    expect(glofoxCancellationReason('DROP TABLE')).toBe('')
  })
})

describe('resolveUserMembershipId', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('reads membership.user_membership_id off GET /2.0/members/{id}', async () => {
    const { resolveUserMembershipId } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { data: { _id: MEMBER, membership: { user_membership_id: USER_MEMBERSHIP } } }))
    expect(await resolveUserMembershipId(creds, MEMBER)).toBe(USER_MEMBERSHIP)
    expect(global.fetch.mock.calls[0][0]).toContain(`/2.0/members/${MEMBER}`)
  })

  it('returns null when the member has no membership or the fetch fails', async () => {
    const { resolveUserMembershipId } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { data: { _id: MEMBER, membership: {} } }))
    expect(await resolveUserMembershipId(creds, MEMBER)).toBeNull()
    global.fetch.mockResolvedValueOnce(res(404, {}))
    expect(await resolveUserMembershipId(creds, MEMBER)).toBeNull()
    expect(await resolveUserMembershipId(creds, null)).toBeNull()
  })
})

describe('cancelGlofoxMembership', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()))
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

  it('POSTs an ON_DATE cancellation with the impersonation header and harvests the planned end date', async () => {
    const { cancelGlofoxMembership } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { local_planned_end_date: '2026-10-05' }))
    const out = await cancelGlofoxMembership(creds, {
      userMembershipId: USER_MEMBERSHIP,
      memberId: MEMBER,
      localDate: '2026-10-05',
      reason: 'MEMBERSHIP_CANCELLATION_PRICE',
    })
    expect(out).toMatchObject({ ok: true, status: 200, local_planned_end_date: '2026-10-05', message_code: null })
    const [url, init] = global.fetch.mock.calls[0]
    expect(url).toBe(`https://gf-api.aws.glofox.com/prod/v3.0/memberships/${USER_MEMBERSHIP}/cancel`)
    expect(init.method).toBe('POST')
    expect(init.headers['x-glofox-impersonated-member-id']).toBe(MEMBER)
    expect(init.headers['x-glofox-branch-id']).toBe('b')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ when: 'ON_DATE', local_date: '2026-10-05', reason: 'MEMBERSHIP_CANCELLATION_PRICE' })
  })

  it('sends an empty-string reason when none maps', async () => {
    const { cancelGlofoxMembership } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(200, { local_planned_end_date: '2026-10-05' }))
    await cancelGlofoxMembership(creds, { userMembershipId: USER_MEMBERSHIP, memberId: MEMBER, localDate: '2026-10-05' })
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).reason).toBe('')
  })

  it('refuses a malformed id or date locally, without a network call', async () => {
    const { cancelGlofoxMembership } = await import('./glofox.js')
    const bad = await cancelGlofoxMembership(creds, { userMembershipId: 'nope', memberId: MEMBER, localDate: '2026-10-05' })
    expect(bad.ok).toBe(false)
    expect(bad.message_code).toBe('INVALID_ARGS')
    const badMember = await cancelGlofoxMembership(creds, { userMembershipId: USER_MEMBERSHIP, memberId: '', localDate: '2026-10-05' })
    expect(badMember.ok).toBe(false)
    const badDate = await cancelGlofoxMembership(creds, { userMembershipId: USER_MEMBERSHIP, memberId: MEMBER, localDate: '05/10/2026' })
    expect(badDate.ok).toBe(false)
    const badReason = await cancelGlofoxMembership(creds, { userMembershipId: USER_MEMBERSHIP, memberId: MEMBER, localDate: '2026-10-05', reason: 'price' })
    expect(badReason.ok).toBe(false)
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('keeps Glofox\'s message_code verbatim on a rejected cancellation', async () => {
    const { cancelGlofoxMembership } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(400, { message_code: 'MEMBERSHIP_MINIMUM_TERM_NOT_REACHED' }))
    const out = await cancelGlofoxMembership(creds, { userMembershipId: USER_MEMBERSHIP, memberId: MEMBER, localDate: '2026-10-05' })
    expect(out).toMatchObject({ ok: false, status: 400, message_code: 'MEMBERSHIP_MINIMUM_TERM_NOT_REACHED', local_planned_end_date: null })
  })

  it('falls back to body.message when there is no message_code, and survives a network error', async () => {
    const { cancelGlofoxMembership } = await import('./glofox.js')
    global.fetch.mockResolvedValueOnce(res(403, { message: 'Forbidden' }))
    const out = await cancelGlofoxMembership(creds, { userMembershipId: USER_MEMBERSHIP, memberId: MEMBER, localDate: '2026-10-05' })
    expect(out.message_code).toBe('Forbidden')
    global.fetch.mockRejectedValueOnce(new Error('boom'))
    const net = await cancelGlofoxMembership(creds, { userMembershipId: USER_MEMBERSHIP, memberId: MEMBER, localDate: '2026-10-05' })
    expect(net).toMatchObject({ ok: false, status: 0, message_code: 'NETWORK_ERROR' })
  })
})
