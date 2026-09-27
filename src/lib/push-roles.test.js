// C1 RECIPIENTS.1 — "who holds these roles here" must tell a failed read
// from an empty answer. push.test.js's fake db serves profile_locations with
// `.in()` only (sendPush's permission read), so the fan-out's `.eq()` read is
// tested here with its own fake.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ linksResult: { data: [], error: null } }))

vi.mock('./supabase.js', () => ({
  createServerClient: () => ({
    from: (table) => {
      if (table !== 'profile_locations') throw new Error(`unexpected table ${table}`)
      return { select: () => ({ eq: async () => h.linksResult }) }
    },
  }),
}))
vi.mock('./log.js', () => ({ logError: vi.fn(), logWarn: vi.fn(), logInfo: vi.fn() }))

const { logError } = await import('./log.js')
const {
  roleRecipientIdsFromLinks, sendPushToRolesAtLocation,
  readLocationMemberIds, sendPushToInboxStaffAtLocation,
} = await import('./push.js')

const link = (profile_id, role, { profileRole = role, active = true } = {}) => ({
  profile_id, role, profiles: { id: profile_id, role: profileRole, active },
})

beforeEach(() => {
  vi.clearAllMocks()
  h.linksResult = { data: [], error: null }
  global.fetch = vi.fn()
})

describe('roleRecipientIdsFromLinks — the rule, pure (PUSH-ROLES.1)', () => {
  const links = [
    link('richard', 'staff', { profileRole: 'master' }),
    link('garrett', 'owner'),
    link('james', 'staff'),
    link('gone', 'owner', { active: false }),
    link('demoted', 'staff', { profileRole: 'owner' }),
    { profile_id: 'orphan', role: 'owner', profiles: null },
  ]

  it('per-location role, active only, and every active master whatever their role here', () => {
    expect(roleRecipientIdsFromLinks(links, ['owner', 'manager'])).toEqual(['richard', 'garrett'])
  })

  it('no roles, or no links, is nobody', () => {
    expect(roleRecipientIdsFromLinks(links, [])).toEqual([])
    expect(roleRecipientIdsFromLinks(null, ['owner'])).toEqual([])
  })
})

describe('sendPushToRolesAtLocation — a failed read is not "nobody"', () => {
  it('a failed read sends nothing, says so in the result, and logs once', async () => {
    h.linksResult = { data: null, error: { message: 'down' } }
    const r = await sendPushToRolesAtLocation('loc1', ['owner'], { title: 't', body: 'b', data: { type: 'x' } })
    expect(r).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 0, recipients_failed: 1 })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('push', expect.stringContaining('recipients read failed'),
      expect.objectContaining({ locationId: 'loc1', roles: ['owner'], type: 'x', err: 'down' }))
  })

  it('nobody holds the role: plain zeros, no recipients_failed, no log', async () => {
    h.linksResult = { data: [link('james', 'staff')], error: null }
    const r = await sendPushToRolesAtLocation('loc1', ['owner'], { title: 't', body: 'b' })
    expect(r).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 0 })
    expect(logError).not.toHaveBeenCalled()
  })
})

// C1 RECIPIENTS.1 (owner addition) — the old member resolver had the same
// shape: `const { data: links } = …`, the error discarded, [] on a failed
// read. Its one caller is the inbox-staff "Mia is handling a chat" ping.
describe('readLocationMemberIds — every active member, with the read error', () => {
  const db = (result) => ({ from: () => ({ select: () => ({ eq: async () => result }) }) })

  it('returns the active members and no error on a good read', async () => {
    const r = await readLocationMemberIds(db({ data: [link('a', 'staff'), link('b', 'owner', { active: false })], error: null }), 'loc1')
    expect(r).toEqual({ ids: ['a'], error: null })
  })
  it('returns the error on a failed read (never an empty list that reads as "nobody")', async () => {
    expect(await readLocationMemberIds(db({ data: null, error: { message: 'down' } }), 'loc1'))
      .toEqual({ ids: [], error: { message: 'down' } })
  })
  it('no studio is an empty answer, not an error', async () => {
    expect(await readLocationMemberIds(db({ data: [link('a', 'staff')], error: null }), null)).toEqual({ ids: [], error: null })
  })
})

describe('sendPushToInboxStaffAtLocation — a failed read is not "nobody"', () => {
  it('a failed read sends nothing, says so in the result, and logs once', async () => {
    h.linksResult = { data: null, error: { message: 'down' } }
    const r = await sendPushToInboxStaffAtLocation('loc1', { title: 't', body: 'b', category: 'agent_activity', data: { type: 'agent_activity' } })
    expect(r).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 0, recipients_failed: 1 })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('push', expect.stringContaining('recipients read failed'),
      expect.objectContaining({ locationId: 'loc1', type: 'agent_activity', category: 'agent_activity', err: 'down' }))
  })

  it('nobody linked (or nobody active): plain zeros, no recipients_failed, no log', async () => {
    h.linksResult = { data: [link('gone', 'staff', { active: false })], error: null }
    const r = await sendPushToInboxStaffAtLocation('loc1', { title: 't', body: 'b' })
    expect(r).toEqual({ sent: 0, skipped: 0, invalidated: 0, failed: 0 })
    expect(logError).not.toHaveBeenCalled()
  })
})
